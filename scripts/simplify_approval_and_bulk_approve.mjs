import fs from "fs";

const serverFile = "src/server.js";
const requestsViewFile = "src/views/admin_requests.ejs";
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

apply("approval ignores via and always emails", txt => {
  let out = txt;
  out = out.replaceAll("const via = String(req.body.via || \"COPY\");", "const via = \"EMAIL\";");
  out = out.replaceAll("issued_via)\n       VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6)", "issued_via)\n       VALUES ($1,$2,$3,$4,'ACTIVE',$5,'EMAIL')");
  out = out.replaceAll("[active.id, r.id, r.unit_id, tokenHash, req.session.admin.id, via]", "[active.id, r.id, r.unit_id, tokenHash, req.session.admin.id]");
  out = out.replaceAll("[active.id, reg.id, reg.unit_id, tokenHash, req.session.admin.id, via]", "[active.id, reg.id, reg.unit_id, tokenHash, req.session.admin.id]");
  return out;
});

const bulkRoute = [
  "app.post(\"/admin/solicitudes/bulk-approve\", requireAdmin, async (req, res) => {",
  "  const active = await getActiveElection();",
  "  if (!active) return res.status(500).send(\"No hay campaña activa.\");",
  "  if (await isElectionSealed(active.id)) return res.status(403).send(\"La campaña ya fue sellada. No se pueden aprobar solicitudes.\");",
  "",
  "  const idsRaw = Array.isArray(req.body.registration_ids) ? req.body.registration_ids : [req.body.registration_ids];",
  "  const ids = idsRaw.map(x => Number(x)).filter(Boolean);",
  "  if (!ids.length) return res.redirect(\"/admin/solicitudes?filter=pending\");",
  "",
  "  let approved = 0;",
  "  let sent = 0;",
  "  let failed = 0;",
  "  let skipped = 0;",
  "",
  "  for (const id of ids) {",
  "    const reg = (await q(",
  "      `SELECT r.*, u.id AS unit_id, u.label AS unit_label",
  "       FROM registrations r",
  "       JOIN units u ON u.id=r.unit_id",
  "       WHERE r.id=$1 AND r.election_id=$2`,",
  "      [id, active.id]",
  "    )).rows[0];",
  "",
  "    if (!reg || reg.status !== \"PENDING\" || !reg.email) { skipped++; continue; }",
  "",
  "    const raw = newToken();",
  "    const tokenHash = hashToken(raw);",
  "    let tokenId;",
  "",
  "    await withTx(pool, async (client) => {",
  "      await client.query(",
  "        `UPDATE registrations",
  "         SET status='APPROVED', reviewed_at=NOW(), reviewed_by=$1, notes=COALESCE(notes,'')",
  "         WHERE id=$2 AND status='PENDING'`,",
  "        [req.session.admin.id, reg.id]",
  "      );",
  "      const tr = await client.query(",
  "        `INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, created_by_admin_id, issued_via)",
  "         VALUES ($1,$2,$3,$4,'ACTIVE',$5,'EMAIL')",
  "         RETURNING id`,",
  "        [active.id, reg.id, reg.unit_id, tokenHash, req.session.admin.id]",
  "      );",
  "      tokenId = tr.rows[0].id;",
  "    });",
  "",
  "    approved++;",
  "    const link = absoluteUrl(`/votar/${raw}`);",
  "    const ok = await sendEmailNotification({",
  "      template: \"registration_approved\",",
  "      recipient: reg.email,",
  "      election_id: active.id,",
  "      registration_id: reg.id,",
  "      meta_json: { token_id: tokenId, bulk: true },",
  "      send: () => sendVoteLink({ to: reg.email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at })",
  "    });",
  "    if (ok) sent++; else failed++;",
  "",
  "    await audit(\"REGISTRATION_APPROVED\", { actor_admin_id: req.session.admin.id, election_id: active.id, registration_id: reg.id, unit_id: reg.unit_id, token_id: tokenId, meta_json: { via: \"EMAIL\", bulk: true, sent: ok } });",
  "  }",
  "",
  "  await audit(\"REGISTRATION_BULK_APPROVED\", { actor_admin_id: req.session.admin.id, election_id: active.id, meta_json: { requested: ids.length, approved, sent, failed, skipped } });",
  "  res.redirect(`/admin/solicitudes?filter=pending&bulk=1&approved=${approved}&sent=${sent}&failed=${failed}&skipped=${skipped}`);",
  "});",
  ""
].join("\n");

apply("bulk approve route", txt => {
  if (txt.includes('app.post("/admin/solicitudes/bulk-approve"')) return txt;
  const marker = 'app.get("/admin/solicitudes"';
  const idx = txt.indexOf(marker);
  if (idx < 0) throw new Error('No encontre ruta /admin/solicitudes');
  return txt.slice(0, idx) + bulkRoute + txt.slice(idx);
});

fs.writeFileSync(serverFile, s);

if (fs.existsSync(requestsViewFile)) {
  let v = fs.readFileSync(requestsViewFile, "utf8");
  const before = v;

  if (!v.includes('bulk-approve')) {
    v = v.replace(
      '<table style="width:100%; border-collapse:collapse">',
      '${filter === "pending" && admin.role === "admin" ? `\n      <form method="POST" action="/admin/solicitudes/bulk-approve" onsubmit="return confirm(\'Se aprobarán las solicitudes seleccionadas y se enviarán los enlaces por email. ¿Continuar?\')">\n        <button class="ok" type="submit" style="margin:12px 0">Aprobar seleccionadas y enviar email</button>\n    ` : ``}\n\n    ${new URLSearchParams(globalThis.location?.search || "").get("bulk") ? `\n      <div style="padding:10px; border:1px solid #eee; border-radius:10px; margin:10px 0">\n        Resultado bulk: ${new URLSearchParams(globalThis.location?.search || "").get("approved") || 0} aprobada(s), ${new URLSearchParams(globalThis.location?.search || "").get("sent") || 0} email(s) enviados, ${new URLSearchParams(globalThis.location?.search || "").get("failed") || 0} fallido(s), ${new URLSearchParams(globalThis.location?.search || "").get("skipped") || 0} omitida(s).\n      </div>\n    ` : ``}\n\n    <table style="width:100%; border-collapse:collapse">'
    );

    v = v.replace(
      '<tr>\n        <th align="left">Fecha</th>',
      '<tr>\n        ${filter === "pending" && admin.role === "admin" ? `<th align="left">Sel.</th>` : ``}\n        <th align="left">Fecha</th>'
    );

    v = v.replace(
      '<tr style="border-top:1px solid #eee">\n          <td>${new Date(r.created_at).toLocaleString("es-PE")}</td>',
      '<tr style="border-top:1px solid #eee">\n          ${filter === "pending" && admin.role === "admin" ? `<td><input type="checkbox" name="registration_ids" value="${r.id}" style="width:auto" checked /></td>` : ``}\n          <td>${new Date(r.created_at).toLocaleString("es-PE")}</td>'
    );

    v = v.replace('</table>\n  </div>', '</table>\n    ${filter === "pending" && admin.role === "admin" ? `</form>` : ``}\n  </div>');
  }

  if (v !== before) {
    fs.writeFileSync(requestsViewFile, v);
    changed = true;
    console.log("[OK] admin requests bulk approve UI");
  } else {
    console.log("[OK] admin requests UI ya estaba aplicado o no matcheo");
  }
}

console.log(changed ? "[OK] approval simplification + bulk approve aplicado" : "[OK] nada para aplicar");
