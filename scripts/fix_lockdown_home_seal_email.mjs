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

// 1) Lockdown post-sellado: bloquear solo mutaciones de la campaña/votos/solicitudes,
// NO bloquear administración general, padrón maestro, usuarios ni creación de nuevas campañas.
apply("relax sealed lockdown allowlist", txt => {
  const oldBlock = `  const allow =
    req.path === "/admin/logout" ||
    req.path === "/admin/verify" ||
    req.path === "/admin/notifications/sealed" ||
    new RegExp("^/admin/elections/\\\\d+/close$").test(req.path);

  if (allow) return next();`;

  const newBlock = `  const allowedEvenWhenSealed =
    req.path === "/admin/logout" ||
    req.path === "/admin/verify" ||
    req.path === "/admin/notifications/sealed" ||
    req.path === "/admin/elections/new" ||
    req.path.startsWith("/admin/users") ||
    req.path.startsWith("/admin/residentes") ||
    new RegExp("^/admin/elections/\\\\d+/close$").test(req.path);

  if (allowedEvenWhenSealed) return next();

  const sealedCampaignMutation =
    req.path.startsWith("/votar/") ||
    req.path.startsWith("/admin/solicitudes") ||
    req.path.startsWith("/admin/votacion") ||
    req.path.startsWith("/admin/directiva") ||
    req.path.startsWith("/admin/fiscales") ||
    req.path === "/admin/election/edit" ||
    req.path === "/admin/importar-campana" ||
    req.path === "/admin/seal";

  if (!sealedCampaignMutation) return next();`;

  if (txt.includes("const allowedEvenWhenSealed")) return txt;
  return txt.replace(oldBlock, newBlock);
});

// Fallback por si el regex del bloque anterior no matchea por escapes distintos.
apply("relax sealed lockdown fallback", txt => {
  if (txt.includes("const allowedEvenWhenSealed")) return txt;
  return txt.replace(
    `  const allow =\n    req.path === "/admin/logout" ||\n    req.path === "/admin/verify" ||\n    req.path === "/admin/notifications/sealed" ||\n    new RegExp("^/admin/elections/\\\\d+/close$").test(req.path);\n\n  if (allow) return next();`,
    `  const allowedEvenWhenSealed =\n    req.path === "/admin/logout" ||\n    req.path === "/admin/verify" ||\n    req.path === "/admin/notifications/sealed" ||\n    req.path === "/admin/elections/new" ||\n    req.path.startsWith("/admin/users") ||\n    req.path.startsWith("/admin/residentes") ||\n    new RegExp("^/admin/elections/\\\\d+/close$").test(req.path);\n\n  if (allowedEvenWhenSealed) return next();\n\n  const sealedCampaignMutation =\n    req.path.startsWith("/votar/") ||\n    req.path.startsWith("/admin/solicitudes") ||\n    req.path.startsWith("/admin/votacion") ||\n    req.path.startsWith("/admin/directiva") ||\n    req.path.startsWith("/admin/fiscales") ||\n    req.path === "/admin/election/edit" ||\n    req.path === "/admin/importar-campana" ||\n    req.path === "/admin/seal";\n\n  if (!sealedCampaignMutation) return next();`
  );
});

// 2) Home sin campaña activa debe pasar latestFinished a no_active.
apply("home latest finished when no active", txt => txt.replace(
  '  const election = await getActiveElection();\n  if (!election) return res.render("no_active");',
  '  const election = await getActiveElection();\n  if (!election) {\n    const latestFinished = await getLatestFinishedElection();\n    return res.render("no_active", { latestFinished });\n  }'
));

// 3) Email de resultados sellados: incluir resumen de resultados.
apply("sealed notification includes results", txt => {
  if (txt.includes("resultsText") && txt.includes("sendElectionSealed({ to: r.email, electionTitle: election.title, resultsUrl, hashesText, resultsText })")) return txt;

  const marker = '  const hashesText = seals.map(s => `${s.kind}: ${s.global_hash} (votos: ${s.total_votes})`).join("\\n");\n  const resultsUrl = absoluteUrl(`/resultados/${election.id}`);';
  const replacement = `  const hashesText = seals.map(s => \`${'${s.kind}'}: ${'${s.global_hash}'} (votos: ${'${s.total_votes}'})\`).join("\\n");
  const resultsUrl = absoluteUrl(\`/resultados/${'${election.id}'}\`);

  let resultRows = [];
  if (election.kind === "VOTACION") {
    resultRows = (await q(
      \`SELECT ro.option_label AS code, ro.option_text AS name, COUNT(rv.id)::int AS votes
       FROM referendum_options ro
       LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
       WHERE ro.election_id=$1
       GROUP BY ro.id
       ORDER BY ro.sort_order ASC, ro.id ASC\`,
      [election.id]
    )).rows;
  } else {
    resultRows = (await q(
      \`SELECT c.list_code AS code, c.name, COUNT(v.id)::int AS votes
       FROM candidates c
       LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
       WHERE c.election_id=$1
       GROUP BY c.id
       ORDER BY c.sort_order ASC, c.id ASC\`,
      [election.id]
    )).rows;
  }
  const resultsText = resultRows.map(r => \`${'${r.code ? r.code + ". " : ""}'}${'${r.name}'}: ${'${r.votes}'} voto(s)\`).join("\\n");`;

  let out = txt.replace(marker, replacement);
  out = out.replace(
    'send: () => sendElectionSealed({ to: r.email, electionTitle: election.title, resultsUrl, hashesText })',
    'send: () => sendElectionSealed({ to: r.email, electionTitle: election.title, resultsUrl, hashesText, resultsText })'
  );
  return out;
});

fs.writeFileSync(file, s);
console.log(changed ? "[OK] lockdown/home/sealed email fix aplicado" : "[OK] nada para aplicar");
