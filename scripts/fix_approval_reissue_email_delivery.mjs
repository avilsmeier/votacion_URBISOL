import fs from "fs";

const serverFile = "src/server.js";
let s = fs.readFileSync(serverFile, "utf8");
let changed = false;

function apply(label, fn) {
  const before = s;
  s = fn(s);
  if (s !== before) {
    changed = true;
    console.log("[OK] " + label);
  } else {
    console.log("[OK] " + label + " ya estaba aplicado o no matcheo");
  }
}

function findRouteEnd(txt, start) {
  let i = txt.indexOf("{", start);
  if (i < 0) return -1;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escape = false;
  for (; i < txt.length; i++) {
    const ch = txt[i];
    const prev = txt[i - 1];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (!inDouble && !inTemplate && ch === "'" && prev !== "\\") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"' && prev !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`" && prev !== "\\") inTemplate = !inTemplate;
    if (inSingle || inDouble || inTemplate) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const semi = txt.indexOf(");", i);
        return semi >= 0 ? semi + 2 : i + 1;
      }
    }
  }
  return -1;
}

// La tabla real vote_tokens no tiene created_by_admin_id. Todas las emisiones quedan auditadas
// en audit_log con actor_admin_id + token_id, y en registrations.reviewed_by para aprobaciones.
apply("fix vote_tokens insert schema everywhere", txt => {
  let out = txt;

  out = out.replaceAll(
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, created_by_admin_id, issued_via)",
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, issued_via)"
  );
  out = out.replaceAll(
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, created_by_admin_id)",
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, issued_via)"
  );
  out = out.replaceAll(
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, created_by_admin_id, issued_via)",
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, issued_via)"
  );

  out = out.replaceAll(
    "VALUES ($1,$2,$3,$4,'ACTIVE',$5,'EMAIL')",
    "VALUES ($1,$2,$3,$4,'ACTIVE','EMAIL')"
  );
  out = out.replaceAll(
    "VALUES ($1,$2,$3,$4,'ACTIVE',$5)",
    "VALUES ($1,$2,$3,$4,'ACTIVE','EMAIL')"
  );
  out = out.replaceAll(
    "VALUES ($1,$2,$3,$4,$5,'EMAIL')",
    "VALUES ($1,$2,$3,$4,'EMAIL')"
  );

  out = out.replaceAll(
    "[active.id, reg.id, reg.unit_id, tokenHash, req.session.admin.id]",
    "[active.id, reg.id, reg.unit_id, tokenHash]"
  );
  out = out.replaceAll(
    "[active.id, r.id, r.unit_id, tokenHash, req.session.admin.id]",
    "[active.id, r.id, r.unit_id, tokenHash]"
  );
  out = out.replaceAll(
    "[active.id, reg.id, reg.unit_id, tokenHash, req.session.admin.id, via]",
    "[active.id, reg.id, reg.unit_id, tokenHash]"
  );
  out = out.replaceAll(
    "[active.id, r.id, r.unit_id, tokenHash, req.session.admin.id, via]",
    "[active.id, r.id, r.unit_id, tokenHash]"
  );

  return out;
});

// Reemplaza aprobación individual por un flujo único y auditable:
// aprobar + generar token + enviar email + mostrar link de respaldo.
apply("replace individual approval route", txt => {
  if (txt.includes("APPROVAL_EMAIL_DELIVERY_STABLE_ROUTE")) return txt;

  const marker = 'app.post("/admin/solicitudes/:id/aprobar"';
  const start = txt.indexOf(marker);
  if (start < 0) {
    console.warn("[WARN] No encontre ruta /admin/solicitudes/:id/aprobar");
    return txt;
  }
  const end = findRouteEnd(txt, start);
  if (end < 0) throw new Error("No pude encontrar fin de ruta aprobar");

  const route = `// APPROVAL_EMAIL_DELIVERY_STABLE_ROUTE
app.post("/admin/solicitudes/:id/aprobar", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay campaña activa.");
  if (await isElectionSealed(active.id)) return res.status(403).send("La campaña ya fue sellada. No se pueden aprobar solicitudes.");

  const id = Number(req.params.id);
  const reg = (await q(
    \`SELECT r.*, u.label AS unit_label
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     WHERE r.id=$1 AND r.election_id=$2\`,
    [id, active.id]
  )).rows[0];

  if (!reg) return res.status(404).send("Solicitud no encontrada.");
  if (reg.status !== "PENDING") return res.status(400).send("Solo se pueden aprobar solicitudes pendientes.");
  if (!reg.email) return res.status(400).send("La solicitud no tiene correo electrónico.");

  const raw = newToken();
  const tokenHash = hashToken(raw);
  let tokenId;

  await withTx(pool, async (client) => {
    await client.query(
      \`UPDATE registrations
       SET status='APPROVED', reviewed_at=NOW(), reviewed_by=$1, notes=COALESCE(notes,'')
       WHERE id=$2 AND status='PENDING'\`,
      [req.session.admin.id, reg.id]
    );

    const tr = await client.query(
      \`INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, issued_via)
       VALUES ($1,$2,$3,$4,'ACTIVE','EMAIL')
       RETURNING id\`,
      [active.id, reg.id, reg.unit_id, tokenHash]
    );
    tokenId = tr.rows[0].id;
  });

  const link = absoluteUrl(\`/votar/\${raw}\`);
  const sent = await sendEmailNotification({
    template: "registration_approved",
    recipient: reg.email,
    election_id: active.id,
    registration_id: reg.id,
    meta_json: { token_id: tokenId, unit_label: reg.unit_label },
    send: () => sendVoteLink({
      to: reg.email,
      link,
      electionTitle: active.title,
      voteOpenAt: active.vote_open_at,
      voteCloseAt: active.vote_close_at,
      unitLabel: reg.unit_label
    })
  });

  await audit("REGISTRATION_APPROVED", {
    actor_admin_id: req.session.admin.id,
    election_id: active.id,
    registration_id: reg.id,
    unit_id: reg.unit_id,
    token_id: tokenId,
    meta_json: { via: "EMAIL", sent }
  });

  const tokenRow = { id: tokenId, status: "ACTIVE", issued_at: new Date(), used_at: null };
  res.render("admin_request_detail", { admin: req.session.admin, r: { ...reg, status: "APPROVED" }, tokenRow, link, sent });
});`;

  return txt.slice(0, start) + route + txt.slice(end + (txt[end] === "\n" ? 1 : 0));
});

// Asegura unidad en email de registro recibido si el bloque todavia no lo llevaba.
apply("registration received email includes unit label", txt => txt.replaceAll(
  "send: () => sendRegistrationReceived({ to: email.trim().toLowerCase(), name: name.trim(), electionTitle: election.title })",
  "send: () => sendRegistrationReceived({ to: email.trim().toLowerCase(), name: name.trim(), electionTitle: election.title, unitLabel: unit.label })"
));

fs.writeFileSync(serverFile, s);
console.log(changed ? "[OK] approval/reissue email delivery fix aplicado" : "[OK] nada para aplicar");
