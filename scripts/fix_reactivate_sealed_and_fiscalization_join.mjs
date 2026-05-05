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

// Permitimos reactivar una campaña sellada para consultar acta/fiscalizacion desde panel,
// pero el lockdown post-sellado sigue bloqueando votos, edicion, preguntas, solicitudes, sellado, etc.
apply("remove sealed activation hard block", txt => {
  return txt.replace(
    /\s*if \(await isElectionSealed\(id\)\) \{\s*await audit\("ELECTION_ACTIVATE_BLOCKED_SEALED", \{ actor_admin_id: req\.session\.admin\.id, election_id: id \}\);\s*return res\.status\(403\)\.send\("Esta campaña ya fue sellada y no puede reactivarse\. Los resultados permanecen disponibles en el histórico\."\);\s*\}/,
    ""
  );
});

// Fiscalizacion: NO unir voto por election_id + unit_id contra registrations, porque si hay
// solicitudes duplicadas/rechazadas de la misma unidad duplica filas. El voto tiene token_id,
// y el token tiene registration_id: esa es la solicitud real que voto.
apply("fix fiscalization referendum registration join", txt => {
  let out = txt;
  out = out.replaceAll(
    "JOIN registrations r ON r.election_id=rv.election_id AND r.unit_id=rv.unit_id",
    "JOIN vote_tokens vt ON vt.id=rv.token_id\n     JOIN registrations r ON r.id=vt.registration_id"
  );
  out = out.replaceAll(
    "JOIN registrations r ON r.election_id=v.election_id AND r.unit_id=v.unit_id",
    "JOIN vote_tokens vt ON vt.id=v.token_id\n     JOIN registrations r ON r.id=vt.registration_id"
  );
  return out;
});

// Sellar debe ser idempotente: si ya estaba sellada por un intento anterior, muestra el resultado
// en vez de tirar error funcional. Esto ayuda si el POST sello pero la respuesta fallo.
apply("make seal route idempotent", txt => {
  if (txt.includes("SEAL_IDEMPOTENT_ALREADY_SEALED")) return txt;
  const needle = '  if (!election) return res.status(400).send("No hay elección activa.");';
  const idx = txt.indexOf(needle, txt.indexOf('app.post("/admin/seal"'));
  if (idx < 0) return txt;
  const insertAt = idx + needle.length;
  const guard = `

  // SEAL_IDEMPOTENT_ALREADY_SEALED
  const existingSeals = (await q(\`SELECT kind, global_hash AS \"globalHash\", total_votes AS \"totalVotes\" FROM election_seals WHERE election_id=$1 ORDER BY kind ASC\`, [election.id])).rows;
  if (existingSeals.length) {
    const council = existingSeals.find(s => s.kind === "COUNCIL") || null;
    const fiscal = existingSeals.find(s => s.kind === "FISCAL") || null;
    const referendum = existingSeals.find(s => s.kind === "REFERENDUM") || null;
    return res.render("seal_result", { election, council, fiscal, referendum });
  }`;
  return txt.slice(0, insertAt) + guard + txt.slice(insertAt);
});

fs.writeFileSync(serverFile, s);

if (fs.existsSync(dashboardFile)) {
  let d = fs.readFileSync(dashboardFile, "utf8");
  const before = d;
  d = d.replace(
    '${Number(e.seals_count || 0) > 0 ? ` | <span class="muted">Sellada</span>` : ` | <form style="display:inline" method="POST" action="/admin/elections/${e.id}/activate"><button type="submit">Activar</button></form>`}',
    '` | <form style="display:inline" method="POST" action="/admin/elections/${e.id}/activate"><button type="submit">Activar</button></form>${Number(e.seals_count || 0) > 0 ? ` <span class="muted">(sellada)</span>` : ``}`'
  );
  if (d !== before) {
    fs.writeFileSync(dashboardFile, d);
    changed = true;
    console.log("[OK] dashboard allows activating sealed campaigns for viewing");
  } else {
    console.log("[OK] dashboard activation UI ya estaba aplicado o no matcheo");
  }
}

console.log(changed ? "[OK] reactivate sealed + fiscalization join fix aplicado" : "[OK] nada para aplicar");
