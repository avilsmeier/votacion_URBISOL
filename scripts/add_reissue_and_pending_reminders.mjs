import fs from "fs";

const serverFile = "src/server.js";
const dashboardFile = "src/views/admin_dashboard.ejs";
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

apply("import pending reminder mailer", txt => {
  if (txt.includes("sendVotePendingReminder")) return txt;
  return txt.replace(
    'import { canMail, sendVoteLink, sendAdminInvite, sendRegistrationReceived, sendVoteReceipt, sendElectionSealed } from "./mailer.js";',
    'import { canMail, sendVoteLink, sendAdminInvite, sendRegistrationReceived, sendVoteReceipt, sendElectionSealed, sendVotePendingReminder } from "./mailer.js";'
  );
});

apply("allow reminder endpoint after seal", txt => txt.replace(
  'req.path === "/admin/notifications/sealed" ||',
  'req.path === "/admin/notifications/sealed" ||\n    req.path === "/admin/recordatorios-voto" ||'
));

const routes = [
  "async function getPendingVoteRows(electionId) {",
  "  const election = (await q(`SELECT * FROM elections WHERE id=$1`, [electionId])).rows[0];",
  "  if (!election) return { election: null, rows: [], stats: { approved: 0, voted: 0 } };",
  "",
  "  const voteJoin = election.kind === \"VOTACION\"",
  "    ? \"LEFT JOIN referendum_votes vv ON vv.election_id=r.election_id AND vv.unit_id=r.unit_id\"",
  "    : \"LEFT JOIN votes vv ON vv.election_id=r.election_id AND vv.unit_id=r.unit_id\";",
  "",
  "  const rows = (await q(",
  "    `SELECT r.id AS registration_id, r.name, r.dni, r.email, u.label AS unit_label, vt.status AS token_status",
  "     FROM registrations r",
  "     JOIN units u ON u.id=r.unit_id",
  "     LEFT JOIN LATERAL (",
  "       SELECT status FROM vote_tokens",
  "       WHERE election_id=r.election_id AND registration_id=r.id",
  "       ORDER BY id DESC LIMIT 1",
  "     ) vt ON true",
  "     ${voteJoin}",
  "     WHERE r.election_id=$1 AND r.status='APPROVED' AND vv.id IS NULL",
  "     ORDER BY u.label ASC, r.name ASC`,",
  "    [electionId]",
  "  )).rows;",
  "",
  "  const stats = {",
  "    approved: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [electionId])).rows[0].n,",
  "    voted: election.kind === \"VOTACION\"",
  "      ? (await q(`SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1`, [electionId])).rows[0].n",
  "      : (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [electionId])).rows[0].n",
  "  };",
  "",
  "  return { election, rows, stats };",
  "}",
  "",
  "app.get(\"/admin/recordatorios-voto\", requireAdmin, async (req, res) => {",
  "  const active = await getActiveElection();",
  "  if (!active) return res.render(\"no_active\", { latestFinished: await getLatestFinishedElection() });",
  "  const { election, rows, stats } = await getPendingVoteRows(active.id);",
  "  res.render(\"vote_pending_reminders\", { admin: req.session.admin, election, rows, stats, lastResult: null });",
  "});",
  "",
  "app.post(\"/admin/recordatorios-voto\", requireAdmin, async (req, res) => {",
  "  const active = await getActiveElection();",
  "  if (!active) return res.render(\"no_active\", { latestFinished: await getLatestFinishedElection() });",
  "  const { election, rows, stats } = await getPendingVoteRows(active.id);",
  "",
  "  let sent = 0;",
  "  let failed = 0;",
  "  for (const r of rows) {",
  "    const ok = await sendEmailNotification({",
  "      template: \"vote_pending_reminder\",",
  "      recipient: r.email,",
  "      election_id: election.id,",
  "      registration_id: r.registration_id,",
  "      meta_json: { no_link: true, unit_label: r.unit_label },",
  "      send: () => sendVotePendingReminder({ to: r.email, electionTitle: election.title, voteOpenAt: election.vote_open_at, voteCloseAt: election.vote_close_at })",
  "    });",
  "    if (ok) sent++; else failed++;",
  "  }",
  "",
  "  await audit(\"VOTE_PENDING_REMINDERS_SENT\", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { sent, failed, total: rows.length }});",
  "  res.render(\"vote_pending_reminders\", { admin: req.session.admin, election, rows, stats, lastResult: { sent, failed, total: rows.length } });",
  "});",
  "",
  "app.post(\"/admin/solicitudes/:id/reemitir\", requireAdmin, async (req, res) => {",
  "  const active = await getActiveElection();",
  "  if (!active) return res.status(500).send(\"No hay campaña activa.\");",
  "  if (await isElectionSealed(active.id)) return res.status(403).send(\"La campaña ya fue sellada. No se pueden reemitir enlaces.\");",
  "",
  "  const id = Number(req.params.id);",
  "  const reg = (await q(",
  "    `SELECT r.*, u.id AS unit_id, u.label AS unit_label",
  "     FROM registrations r",
  "     JOIN units u ON u.id=r.unit_id",
  "     WHERE r.id=$1 AND r.election_id=$2`,",
  "    [id, active.id]",
  "  )).rows[0];",
  "",
  "  if (!reg) return res.status(404).send(\"Solicitud no encontrada.\");",
  "  if (reg.status !== \"APPROVED\") return res.status(400).send(\"Solo se puede reemitir enlace a solicitudes aprobadas.\");",
  "",
  "  const alreadyVoted = active.kind === \"VOTACION\"",
  "    ? (await q(`SELECT 1 FROM referendum_votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`, [active.id, reg.unit_id])).rows.length > 0",
  "    : (await q(`SELECT 1 FROM votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`, [active.id, reg.unit_id])).rows.length > 0;",
  "  if (alreadyVoted) return res.status(400).send(\"Esta unidad ya emitió su voto. No se puede reemitir enlace.\");",
  "",
  "  const raw = newToken();",
  "  const tokenHash = hashToken(raw);",
  "  let tokenId;",
  "",
  "  await withTx(pool, async (client) => {",
  "    await client.query(`UPDATE vote_tokens SET status='REVOKED' WHERE election_id=$1 AND registration_id=$2 AND status='ACTIVE'`, [active.id, reg.id]);",
  "    const tr = await client.query(",
  "      `INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, created_by_admin_id)",
  "       VALUES ($1,$2,$3,$4,'ACTIVE',$5)",
  "       RETURNING id`,",
  "      [active.id, reg.id, reg.unit_id, tokenHash, req.session.admin.id]",
  "    );",
  "    tokenId = tr.rows[0].id;",
  "  });",
  "",
  "  const link = absoluteUrl(`/votar/${raw}`);",
  "  const sent = await sendEmailNotification({",
  "    template: \"vote_link_reissued\",",
  "    recipient: reg.email,",
  "    election_id: active.id,",
  "    registration_id: reg.id,",
  "    meta_json: { token_id: tokenId, reissue: true },",
  "    send: () => sendVoteLink({ to: reg.email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at })",
  "  });",
  "",
  "  await audit(\"TOKEN_REISSUED\", { actor_admin_id: req.session.admin.id, election_id: active.id, registration_id: reg.id, unit_id: reg.unit_id, token_id: tokenId, meta_json: { sent } });",
  "  res.redirect(req.headers.referer || \"/admin/recordatorios-voto\");",
  "});",
  ""
].join("\n");

apply("add pending reminder and reissue routes", txt => {
  if (txt.includes('app.get("/admin/recordatorios-voto"')) return txt;
  return txt.replace("/* =========================\n   ADMIN: LOGIN\n========================= */", routes + "\n/* =========================\n   ADMIN: LOGIN\n========================= */");
});

fs.writeFileSync(serverFile, s);

if (fs.existsSync(dashboardFile)) {
  let d = fs.readFileSync(dashboardFile, "utf8");
  const before = d;
  if (!d.includes('/admin/recordatorios-voto')) {
    d = d.replace(
      '<a href="/admin/fiscalizacion"><button class="ok">Fiscalización</button></a>',
      '<a href="/admin/fiscalizacion"><button class="ok">Fiscalización</button></a>\n        <a href="/admin/recordatorios-voto"><button class="ok">Recordar pendientes</button></a>'
    );
  }
  if (d !== before) {
    fs.writeFileSync(dashboardFile, d);
    changed = true;
    console.log("[OK] dashboard reminder button");
  } else {
    console.log("[OK] dashboard reminder button ya estaba aplicado o no matcheo");
  }
}

console.log(changed ? "[OK] reissue + pending reminders aplicado" : "[OK] nada para aplicar");
