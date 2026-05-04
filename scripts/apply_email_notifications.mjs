import fs from 'fs';

const serverFile = 'src/server.js';
const dashboardFile = 'src/views/admin_dashboard.ejs';
let s = fs.readFileSync(serverFile, 'utf8');
let changed = false;

function replaceOnce(label, from, to) {
  if (s.includes(to)) return;
  if (!s.includes(from)) {
    console.warn('[WARN] No encontre bloque: ' + label);
    return;
  }
  s = s.replace(from, to);
  changed = true;
}

function insertBefore(label, marker, block) {
  if (s.includes(block.trim().slice(0, 80))) return;
  if (!s.includes(marker)) {
    console.warn('[WARN] No encontre marker: ' + label);
    return;
  }
  s = s.replace(marker, block + '\n\n' + marker);
  changed = true;
}

function insertAfter(label, marker, block) {
  if (s.includes(block.trim().slice(0, 80))) return;
  if (!s.includes(marker)) {
    console.warn('[WARN] No encontre marker: ' + label);
    return;
  }
  s = s.replace(marker, marker + '\n\n' + block);
  changed = true;
}

replaceOnce(
  'mailer imports',
  'import { canMail, sendVoteLink } from "./mailer.js";',
  'import { canMail, sendVoteLink, sendAdminInvite, sendRegistrationReceived, sendVoteReceipt, sendElectionSealed } from "./mailer.js";'
);

const auditMarker = [
  'async function audit(event, meta = {}) {',
  '  await q(',
  '    `INSERT INTO audit_log(event, actor_admin_id, unit_id, registration_id, token_id, election_id, meta_json)',
  '     VALUES ($1,$2,$3,$4,$5,$6,$7)`,',
  '    [',
  '      event,',
  '      meta.actor_admin_id ?? null,',
  '      meta.unit_id ?? null,',
  '      meta.registration_id ?? null,',
  '      meta.token_id ?? null,',
  '      meta.election_id ?? null,',
  '      meta.meta_json ?? {}',
  '    ]',
  '  );',
  '}'
].join('\n');

const notificationHelpers = [
  'function baseUrl() {',
  '  return String(process.env.BASE_URL || "").replace(/\\/$/, "");',
  '}',
  '',
  'function absoluteUrl(path) {',
  '  const b = baseUrl();',
  '  if (!b) return path;',
  '  return b + path;',
  '}',
  '',
  'async function logNotification({ election_id = null, registration_id = null, admin_user_id = null, template, recipient, status, error = null, meta_json = {} }) {',
  '  try {',
  '    await q(',
  '      `INSERT INTO notification_log(election_id, registration_id, admin_user_id, channel, template, recipient, status, error, meta_json)',
  "       VALUES ($1,$2,$3,'EMAIL',$4,$5,$6,$7,$8)`,",
  '      [election_id, registration_id, admin_user_id, template, recipient, status, error, meta_json]',
  '    );',
  '  } catch (e) {',
  '    console.error("notification_log failed", e);',
  '  }',
  '}',
  '',
  'async function sendEmailNotification({ template, recipient, election_id = null, registration_id = null, admin_user_id = null, meta_json = {}, send }) {',
  '  if (!recipient) {',
  '    await logNotification({ election_id, registration_id, admin_user_id, template, recipient: "", status: "SKIPPED", error: "missing recipient", meta_json });',
  '    return false;',
  '  }',
  '',
  '  if (!canMail()) {',
  '    await logNotification({ election_id, registration_id, admin_user_id, template, recipient, status: "SKIPPED", error: "SMTP not configured", meta_json });',
  '    return false;',
  '  }',
  '',
  '  try {',
  '    await send();',
  '    await logNotification({ election_id, registration_id, admin_user_id, template, recipient, status: "SENT", meta_json });',
  '    return true;',
  '  } catch (e) {',
  '    await logNotification({ election_id, registration_id, admin_user_id, template, recipient, status: "FAILED", error: String(e?.message || e), meta_json });',
  '    console.error("email " + template + " failed", e);',
  '    return false;',
  '  }',
  '}'
].join('\n');

insertAfter('notification helpers after audit function', auditMarker, notificationHelpers);

replaceOnce(
  'registration received email',
  '  res.render("register_done", { election });',
  [
    '  await sendEmailNotification({',
    '    template: "registration_received",',
    '    recipient: email.trim().toLowerCase(),',
    '    election_id: election.id,',
    '    registration_id: r.rows[0].id,',
    '    meta_json: { name: name.trim() },',
    '    send: () => sendRegistrationReceived({ to: email.trim().toLowerCase(), name: name.trim(), electionTitle: election.title })',
    '  });',
    '',
    '  res.render("register_done", { election });'
  ].join('\n')
);

replaceOnce(
  'admin invite email',
  '  await audit("ADMIN_USER_UPSERTED", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: user.id, email, role }});\n  res.redirect("/admin/users");',
  [
    '  await audit("ADMIN_USER_UPSERTED", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: user.id, email, role }});',
    '  await sendEmailNotification({',
    '    template: "admin_invite",',
    '    recipient: email,',
    '    admin_user_id: user.id,',
    '    meta_json: { role },',
    '    send: () => sendAdminInvite({ to: email, role, secret, loginUrl: absoluteUrl("/admin/login") })',
    '  });',
    '  res.redirect("/admin/users");'
  ].join('\n')
);

replaceOnce(
  'approved token email title',
  'const sent = await sendVoteLink({ to: reg.email, link });',
  'const sent = await sendVoteLink({ to: reg.email, link, electionTitle: active.title });'
);

replaceOnce(
  'referendum vote receipt',
  '    await audit("REFERENDUM_VOTE_CAST", { election_id: election.id, unit_id: vt.unit_id, token_id: vt.id, meta_json: { question_id: question.id, option_id }});\n    return res.render("vote_done", { election });',
  [
    '    await audit("REFERENDUM_VOTE_CAST", { election_id: election.id, unit_id: vt.unit_id, token_id: vt.id, meta_json: { question_id: question.id, option_id }});',
    '    const regForReceipt = (await q(`SELECT id, email FROM registrations WHERE id=$1`, [vt.registration_id])).rows[0];',
    '    await sendEmailNotification({',
    '      template: "vote_receipt",',
    '      recipient: regForReceipt?.email,',
    '      election_id: election.id,',
    '      registration_id: regForReceipt?.id,',
    '      meta_json: { token_id: vt.id, kind: "REFERENDUM" },',
    '      send: () => sendVoteReceipt({ to: regForReceipt.email, electionTitle: election.title, castAt: new Date().toLocaleString("es-PE", { timeZone: "America/Lima" }) })',
    '    });',
    '    return res.render("vote_done", { election });'
  ].join('\n')
);

replaceOnce(
  'fiscal vote receipt',
  '    await audit("FISCAL_VOTE_CAST", {\n      election_id: election.id,\n      unit_id: vt.unit_id,\n      token_id: vt.id,\n      meta_json: { fiscal_list_id: Number(fiscal_list_id) }\n    });\n\n    res.render("vote_done", { election });',
  [
    '    await audit("FISCAL_VOTE_CAST", {',
    '      election_id: election.id,',
    '      unit_id: vt.unit_id,',
    '      token_id: vt.id,',
    '      meta_json: { fiscal_list_id: Number(fiscal_list_id) }',
    '    });',
    '',
    '    const regForReceipt = (await q(`SELECT id, email FROM registrations WHERE id=$1`, [vt.registration_id])).rows[0];',
    '    await sendEmailNotification({',
    '      template: "vote_receipt",',
    '      recipient: regForReceipt?.email,',
    '      election_id: election.id,',
    '      registration_id: regForReceipt?.id,',
    '      meta_json: { token_id: vt.id, kind: "ELECTION" },',
    '      send: () => sendVoteReceipt({ to: regForReceipt.email, electionTitle: election.title, castAt: new Date().toLocaleString("es-PE", { timeZone: "America/Lima" }) })',
    '    });',
    '',
    '    res.render("vote_done", { election });'
  ].join('\n')
);

const sealedRoute = [
  'app.post("/admin/notifications/sealed", requireAdmin, async (req, res) => {',
  '  const election = await getActiveElection();',
  '  if (!election) return res.status(500).send("No hay campaña activa.");',
  '',
  '  const seals = (await q(',
  '    `SELECT kind, global_hash, total_votes, created_at',
  '     FROM election_seals',
  '     WHERE election_id=$1',
  '     ORDER BY kind ASC`,',
  '    [election.id]',
  '  )).rows;',
  '',
  '  if (!seals.length) return res.status(400).send("La campaña todavía no tiene sellos. Primero usa Cerrar y Sellar Campaña.");',
  '',
  '  const recipients = (await q(',
  '    `SELECT id, email',
  '     FROM registrations',
  "     WHERE election_id=$1 AND status='APPROVED' AND email IS NOT NULL AND email <> ''",
  '     ORDER BY id ASC`,',
  '    [election.id]',
  '  )).rows;',
  '',
  '  const hashesText = seals.map(s => `${s.kind}: ${s.global_hash} (votos: ${s.total_votes})`).join("\\n");',
  '  const resultsUrl = absoluteUrl(`/resultados/${election.id}`);',
  '',
  '  let sent = 0;',
  '  let failed = 0;',
  '  for (const r of recipients) {',
  '    const ok = await sendEmailNotification({',
  '      template: "election_sealed",',
  '      recipient: r.email,',
  '      election_id: election.id,',
  '      registration_id: r.id,',
  '      meta_json: { hashes: seals.map(s => ({ kind: s.kind, global_hash: s.global_hash, total_votes: s.total_votes })) },',
  '      send: () => sendElectionSealed({ to: r.email, electionTitle: election.title, resultsUrl, hashesText })',
  '    });',
  '    if (ok) sent++; else failed++;',
  '  }',
  '',
  '  await audit("SEALED_RESULTS_NOTIFIED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { sent, failed, total: recipients.length }});',
  '  res.redirect("/admin");',
  '});'
].join('\n');

insertBefore('sealed notification route', 'app.get("/admin/verify", requireViewerOrAdmin, async (req, res) => {', sealedRoute);

if (fs.existsSync(dashboardFile)) {
  let d = fs.readFileSync(dashboardFile, 'utf8');
  if (!d.includes('/admin/notifications/sealed')) {
    const from = '<a href="/admin/verify"><button>Verificar Integridad</button></a>';
    const to = [
      '<a href="/admin/verify"><button>Verificar Integridad</button></a>',
      '        <form method="POST" action="/admin/notifications/sealed" style="display:inline">',
      '          <button type="submit">Notificar resultados sellados</button>',
      '        </form>'
    ].join('\n');
    if (d.includes(from)) {
      d = d.replace(from, to);
      fs.writeFileSync(dashboardFile, d);
      changed = true;
    } else {
      console.warn('[WARN] No encontre boton verify en dashboard');
    }
  }
}

fs.writeFileSync(serverFile, s);
console.log(changed ? '[OK] email notifications patch aplicado' : '[OK] patch ya estaba aplicado');
