import fs from "fs";

const file = "src/server.js";
let s = fs.readFileSync(file, "utf8");
let changed = false;

function patch(label, fn) {
  const before = s;
  s = fn(s);
  if (s !== before) {
    changed = true;
    console.log("[OK] " + label);
  } else {
    console.log("[OK] " + label + " ya estaba aplicado o no matcheo");
  }
}

patch("middleware import fiscal", txt => txt.replace(
  'import { requireAdmin, requireViewerOrAdmin } from "./middleware.js";',
  'import { requireAdmin, requireFiscalOrAdmin, requireViewerOrAdmin } from "./middleware.js";'
));

patch("approval email campaign title and dates", txt => txt
  .replace(
    'send: () => sendVoteLink({ to: email, link })',
    'send: () => sendVoteLink({ to: email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at })'
  )
  .replace(
    'send: () => sendVoteLink({ to: reg.email, link, electionTitle: active.title })',
    'send: () => sendVoteLink({ to: reg.email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at })'
  )
  .replace(
    'const sent = await sendVoteLink({ to: email, link });',
    'const sent = await sendVoteLink({ to: email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at });'
  )
  .replace(
    'const sent = await sendVoteLink({ to: reg.email, link, electionTitle: active.title });',
    'const sent = await sendVoteLink({ to: reg.email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at });'
  )
);

const helperBlock = [
  "function newReceiptCode() {",
  "  return crypto.randomBytes(32).toString(\"hex\");",
  "}",
  "",
  "async function createVoteReceipt(client, { election_id, registration_id, unit_id, vote_kind, vote_table, vote_id, vote_hash }) {",
  "  const receiptCode = newReceiptCode();",
  "  const receiptHash = sha256Hex(receiptCode);",
  "  await client.query(",
  "    `INSERT INTO vote_receipts(election_id, registration_id, unit_id, vote_kind, vote_table, vote_id, vote_hash, receipt_hash)",
  "     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
  "     ON CONFLICT (vote_table, vote_id) DO UPDATE SET receipt_hash=EXCLUDED.receipt_hash",
  "     RETURNING id`,",
  "    [election_id, registration_id, unit_id, vote_kind, vote_table, vote_id, vote_hash, receiptHash]",
  "  );",
  "  return receiptCode;",
  "}",
  "",
  "async function lookupVoteReceipt({ receiptCode, identity }) {",
  "  const code = String(receiptCode || \"\").trim();",
  "  const ident = String(identity || \"\").trim().toLowerCase();",
  "  if (!code || !ident) return null;",
  "  const receiptHash = sha256Hex(code);",
  "",
  "  return (await q(",
  "    `SELECT",
  "       vr.id AS receipt_id,",
  "       vr.vote_kind,",
  "       vr.vote_hash,",
  "       e.id AS election_id,",
  "       e.title AS election_title,",
  "       e.kind AS election_kind,",
  "       r.id AS registration_id,",
  "       r.name,",
  "       r.dni,",
  "       r.email,",
  "       u.label AS unit_label,",
  "       rv.cast_at,",
  "       rv.chain_position,",
  "       rv.previous_hash,",
  "       ro.option_label,",
  "       ro.option_text",
  "     FROM vote_receipts vr",
  "     JOIN elections e ON e.id=vr.election_id",
  "     JOIN registrations r ON r.id=vr.registration_id",
  "     JOIN units u ON u.id=vr.unit_id",
  "     LEFT JOIN referendum_votes rv ON vr.vote_table='referendum_votes' AND rv.id=vr.vote_id",
  "     LEFT JOIN referendum_options ro ON ro.id=rv.option_id",
  "     WHERE vr.receipt_hash=$1",
  "       AND (lower(COALESCE(r.email,''))=$2 OR lower(COALESCE(r.dni,''))=$2)",
  "     LIMIT 1`,",
  "    [receiptHash, ident]",
  "  )).rows[0] || null;",
  "}",
  ""
].join("\n");

patch("vote receipt helpers", txt => {
  if (txt.includes("function newReceiptCode()")) return txt;
  return txt.replace("function cleanText(v) {", helperBlock + "\nfunction cleanText(v) {");
});

const verifyRoutes = [
  "app.get(\"/verificar-voto\", async (req, res) => {",
  "  res.render(\"verify_vote\", { receipt: String(req.query.receipt || \"\"), identity: \"\", result: null, error: null });",
  "});",
  "",
  "app.post(\"/verificar-voto\", async (req, res) => {",
  "  const receipt = String(req.body.receipt || \"\").trim();",
  "  const identity = String(req.body.identity || \"\").trim();",
  "  const result = await lookupVoteReceipt({ receiptCode: receipt, identity });",
  "  if (!result) {",
  "    await audit(\"VOTE_RECEIPT_VERIFY_FAILED\", { meta_json: { has_receipt: !!receipt, has_identity: !!identity }});",
  "    return res.render(\"verify_vote\", { receipt, identity, result: null, error: \"No encontramos un voto con esos datos. Revisa el código y el DNI/correo.\" });",
  "  }",
  "",
  "  await audit(\"VOTE_RECEIPT_VERIFY_OK\", { election_id: result.election_id, registration_id: result.registration_id, meta_json: { receipt_id: result.receipt_id, vote_kind: result.vote_kind }});",
  "  res.render(\"verify_vote\", { receipt, identity, result, error: null });",
  "});",
  ""
].join("\n");

patch("public vote verification routes", txt => {
  if (txt.includes('app.get("/verificar-voto"')) return txt;
  return txt.replace("/* =========================\n   REGISTRO (email obligatorio + ventana)\n========================= */", verifyRoutes + "\n/* =========================\n   REGISTRO (email obligatorio + ventana)\n========================= */");
});

const referendumRoute = [
  "app.post(\"/votar/:token/referendum\", async (req, res) => {",
  "  const election = await getActiveElection();",
  "  if (!election) return res.render(\"no_active\");",
  "  if (election.kind !== \"VOTACION\") return res.status(400).send(\"Esta campaña no es una votación interna.\");",
  "",
  "  const n = now();",
  "  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);",
  "  if (!voteOpen) return res.render(\"closed\", { election });",
  "",
  "  const option_id = Number(req.body.option_id);",
  "  if (!option_id) return res.status(400).send(\"Elige una opción.\");",
  "",
  "  const { question, options } = await getReferendumForElection(election.id);",
  "  const selectedOption = options.find(o => Number(o.id) === option_id);",
  "  if (!question || !selectedOption) return res.status(400).send(\"Opción inválida.\");",
  "",
  "  const tokenHash = hashToken(req.params.token);",
  "  const c = await pool.connect();",
  "  let vote;",
  "  let vt;",
  "  let receiptCode;",
  "  try {",
  "    await c.query(\"BEGIN\");",
  "    const t = await c.query(`SELECT * FROM vote_tokens WHERE token_hash=$1 AND election_id=$2 FOR UPDATE`, [tokenHash, election.id]);",
  "    if (!t.rows.length) { await c.query(\"ROLLBACK\"); return res.status(404).send(\"Enlace inválido.\"); }",
  "    vt = t.rows[0];",
  "    if (vt.status !== \"ACTIVE\") { await c.query(\"ROLLBACK\"); return res.render(\"vote_used\", { election }); }",
  "",
  "    vote = await insertReferendumVoteChained(c, { election_id: election.id, unit_id: vt.unit_id, question_id: question.id, option_id, token_id: vt.id, ip: getReqIp(req), user_agent: getUserAgent(req) });",
  "",
  "    receiptCode = await createVoteReceipt(c, { election_id: election.id, registration_id: vt.registration_id, unit_id: vt.unit_id, vote_kind: \"REFERENDUM\", vote_table: \"referendum_votes\", vote_id: vote.id, vote_hash: vote.vote_hash });",
  "",
  "    await c.query(`UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1`, [vt.id]);",
  "    await c.query(\"COMMIT\");",
  "",
  "    await audit(\"REFERENDUM_VOTE_CAST\", { election_id: election.id, unit_id: vt.unit_id, token_id: vt.id, meta_json: { question_id: question.id, option_id, vote_hash: vote.vote_hash, chain_position: vote.chain_position }});",
  "",
  "    const regForReceipt = (await q(`SELECT id, email FROM registrations WHERE id=$1`, [vt.registration_id])).rows[0];",
  "    const optionText = `${selectedOption.option_label ? selectedOption.option_label + \". \" : \"\"}${selectedOption.option_text}`;",
  "    await sendEmailNotification({",
  "      template: \"vote_receipt\",",
  "      recipient: regForReceipt?.email,",
  "      election_id: election.id,",
  "      registration_id: regForReceipt?.id,",
  "      meta_json: { token_id: vt.id, kind: \"REFERENDUM\", vote_hash: vote.vote_hash, chain_position: vote.chain_position },",
  "      send: () => sendVoteReceipt({",
  "        to: regForReceipt.email,",
  "        electionTitle: election.title,",
  "        castAt: new Date(vote.cast_at).toLocaleString(\"es-PE\", { timeZone: \"America/Lima\" }),",
  "        optionText,",
  "        voteHash: vote.vote_hash,",
  "        chainPosition: vote.chain_position,",
  "        receiptCode,",
  "        verifyUrl: absoluteUrl(`/verificar-voto?receipt=${encodeURIComponent(receiptCode)}`)",
  "      })",
  "    });",
  "",
  "    return res.render(\"vote_done\", { election });",
  "  } catch (e) {",
  "    await c.query(\"ROLLBACK\");",
  "    if (String(e?.code) === \"23505\") return res.render(\"vote_used\", { election });",
  "    console.error(e);",
  "    return res.status(500).send(\"Error registrando voto.\");",
  "  } finally {",
  "    c.release();",
  "  }",
  "});"
].join("\n");

patch("referendum vote receipt route", txt => {
  if (txt.includes("createVoteReceipt(c") && txt.includes('app.post("/votar/:token/referendum"')) return txt;
  const re = /app\.post\("\/votar\/:token\/referendum", async \(req, res\) => \{[\s\S]*?\n\}\);\n\n\/\* =========================\n   RESULTADOS PÚBLICOS/;
  if (!re.test(txt)) return txt;
  return txt.replace(re, referendumRoute + "\n\n/* =========================\n   RESULTADOS PÚBLICOS");
});

const fiscalRoutes = [
  "app.get(\"/admin/fiscalizacion\", requireFiscalOrAdmin, async (req, res) => {",
  "  const rows = (await q(",
  "    `SELECT e.id, e.title, e.kind, e.is_active,",
  "            COALESCE(rv.n,0) + COALESCE(v.n,0) + COALESCE(fv.n,0) AS total_votes,",
  "            COALESCE(es.n,0) AS seals",
  "     FROM elections e",
  "     LEFT JOIN (SELECT election_id, COUNT(*)::int n FROM referendum_votes GROUP BY election_id) rv ON rv.election_id=e.id",
  "     LEFT JOIN (SELECT election_id, COUNT(*)::int n FROM votes GROUP BY election_id) v ON v.election_id=e.id",
  "     LEFT JOIN (SELECT election_id, COUNT(*)::int n FROM fiscal_votes GROUP BY election_id) fv ON fv.election_id=e.id",
  "     LEFT JOIN (SELECT election_id, COUNT(*)::int n FROM election_seals GROUP BY election_id) es ON es.election_id=e.id",
  "     ORDER BY e.id DESC`",
  "  )).rows;",
  "  res.render(\"fiscalization\", { admin: req.session.admin, rows });",
  "});",
  "",
  "async function getFiscalizationRows(electionId) {",
  "  const election = (await q(`SELECT * FROM elections WHERE id=$1`, [electionId])).rows[0];",
  "  if (!election) return { election: null, rows: [] };",
  "",
  "  const rows = election.kind === \"VOTACION\" ? (await q(",
  "    `SELECT u.label AS unit_label, r.name, r.dni, r.email,",
  "            ro.option_label, ro.option_text,",
  "            rv.cast_at, rv.chain_position, rv.previous_hash, rv.vote_hash",
  "     FROM referendum_votes rv",
  "     JOIN units u ON u.id=rv.unit_id",
  "     JOIN registrations r ON r.election_id=rv.election_id AND r.unit_id=rv.unit_id",
  "     JOIN referendum_options ro ON ro.id=rv.option_id",
  "     WHERE rv.election_id=$1",
  "     ORDER BY rv.chain_position ASC`,",
  "    [electionId]",
  "  )).rows : (await q(",
  "    `SELECT u.label AS unit_label, r.name, r.dni, r.email,",
  "            c.list_code AS option_label, c.name AS option_text,",
  "            v.cast_at, v.chain_position, v.previous_hash, v.vote_hash",
  "     FROM votes v",
  "     JOIN units u ON u.id=v.unit_id",
  "     JOIN registrations r ON r.election_id=v.election_id AND r.unit_id=v.unit_id",
  "     JOIN candidates c ON c.id=v.candidate_id",
  "     WHERE v.election_id=$1",
  "     ORDER BY v.chain_position ASC`,",
  "    [electionId]",
  "  )).rows;",
  "",
  "  return { election, rows };",
  "}",
  "",
  "app.get(\"/admin/fiscalizacion/:electionId/votos\", requireFiscalOrAdmin, async (req, res) => {",
  "  const { election, rows } = await getFiscalizationRows(Number(req.params.electionId));",
  "  if (!election) return res.status(404).send(\"Campaña no existe.\");",
  "  await audit(\"FISCALIZATION_VIEWED\", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { rows: rows.length }});",
  "  res.render(\"fiscalization_votes\", { admin: req.session.admin, election, rows });",
  "});",
  "",
  "app.get(\"/admin/fiscalizacion/:electionId/votos.csv\", requireFiscalOrAdmin, async (req, res) => {",
  "  const { election, rows } = await getFiscalizationRows(Number(req.params.electionId));",
  "  if (!election) return res.status(404).send(\"Campaña no existe.\");",
  "  await audit(\"FISCALIZATION_EXPORTED\", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { rows: rows.length }});",
  "  res.setHeader(\"Content-Type\", \"text/csv; charset=utf-8\");",
  "  res.setHeader(\"Content-Disposition\", `attachment; filename=\"fiscalizacion_${election.id}.csv\"`);",
  "  res.send(toCSV(rows));",
  "});",
  ""
].join("\n");

patch("fiscalization routes", txt => {
  if (txt.includes('app.get("/admin/fiscalizacion"')) return txt;
  return txt.replace("/* =========================\n   ADMIN: LOGIN\n========================= */", fiscalRoutes + "\n/* =========================\n   ADMIN: LOGIN\n========================= */");
});

patch("admin role parser create", txt => txt.replace(
  'const role = String(req.body.role || "viewer") === "admin" ? "admin" : "viewer";',
  'const rawRole = String(req.body.role || "viewer");\n  const role = ["admin", "fiscal", "viewer"].includes(rawRole) ? rawRole : "viewer";'
));

patch("admin role parser update", txt => txt.replace(
  'const role = String(req.body.role || "viewer") === "admin" ? "admin" : "viewer";',
  'const rawRole = String(req.body.role || "viewer");\n  const role = ["admin", "fiscal", "viewer"].includes(rawRole) ? rawRole : "viewer";'
));

fs.writeFileSync(file, s);
console.log(changed ? "[OK] vote receipts + fiscalization patch aplicado" : "[OK] patch ya estaba aplicado");
