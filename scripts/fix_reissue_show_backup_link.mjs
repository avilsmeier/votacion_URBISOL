import fs from "fs";

const file = "src/server.js";
let s = fs.readFileSync(file, "utf8");
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

apply("replace reissue route with backup link render", txt => {
  if (txt.includes("REISSUE_SHOW_BACKUP_LINK_ROUTE")) return txt;

  const marker = 'app.post("/admin/solicitudes/:id/reemitir"';
  const start = txt.indexOf(marker);
  if (start < 0) throw new Error("No encontre ruta /admin/solicitudes/:id/reemitir");
  const end = findRouteEnd(txt, start);
  if (end < 0) throw new Error("No pude encontrar fin de ruta reemitir");

  const route = `// REISSUE_SHOW_BACKUP_LINK_ROUTE
app.post("/admin/solicitudes/:id/reemitir", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay campaña activa.");
  if (await isElectionSealed(active.id)) return res.status(403).send("La campaña ya fue sellada. No se pueden reemitir enlaces.");

  const id = Number(req.params.id);
  const reg = (await q(
    \`SELECT r.*, u.id AS unit_id, u.label AS unit_label
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     WHERE r.id=$1 AND r.election_id=$2\`,
    [id, active.id]
  )).rows[0];

  if (!reg) return res.status(404).send("Solicitud no encontrada.");
  if (reg.status !== "APPROVED") return res.status(400).send("Solo se puede reemitir enlace a solicitudes aprobadas.");
  if (!reg.email) return res.status(400).send("La solicitud no tiene correo electrónico.");

  const alreadyVoted = active.kind === "VOTACION"
    ? (await q(\`SELECT 1 FROM referendum_votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1\`, [active.id, reg.unit_id])).rows.length > 0
    : (await q(\`SELECT 1 FROM votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1\`, [active.id, reg.unit_id])).rows.length > 0;
  if (alreadyVoted) return res.status(400).send("Esta unidad ya emitió su voto. No se puede reemitir enlace.");

  const raw = newToken();
  const tokenHash = hashToken(raw);
  let tokenId;

  await withTx(pool, async (client) => {
    await client.query(\`UPDATE vote_tokens SET status='REVOKED' WHERE election_id=$1 AND registration_id=$2 AND status='ACTIVE'\`, [active.id, reg.id]);
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
    template: "vote_link_reissued",
    recipient: reg.email,
    election_id: active.id,
    registration_id: reg.id,
    meta_json: { token_id: tokenId, reissue: true, unit_label: reg.unit_label },
    send: () => sendVoteLink({
      to: reg.email,
      link,
      electionTitle: active.title,
      voteOpenAt: active.vote_open_at,
      voteCloseAt: active.vote_close_at,
      unitLabel: reg.unit_label
    })
  });

  await audit("TOKEN_REISSUED", {
    actor_admin_id: req.session.admin.id,
    election_id: active.id,
    registration_id: reg.id,
    unit_id: reg.unit_id,
    token_id: tokenId,
    meta_json: { sent }
  });

  const tokenRow = { id: tokenId, status: "ACTIVE", issued_at: new Date(), used_at: null };
  return res.render("admin_request_detail", { admin: req.session.admin, r: reg, tokenRow, link, sent });
});`;

  return txt.slice(0, start) + route + txt.slice(end + (txt[end] === "\n" ? 1 : 0));
});

fs.writeFileSync(file, s);
console.log(changed ? "[OK] reissue backup link fix aplicado" : "[OK] nada para aplicar");
