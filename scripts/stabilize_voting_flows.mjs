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

// 1) Produccion no debe arrancar con secreto de sesion por defecto.
apply("require SESSION_SECRET in production", txt => {
  let out = txt;
  if (!out.includes("SESSION_SECRET_REQUIRED_PRODUCTION")) {
    const marker = "const app = express();";
    out = out.replace(marker, `if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {\n  throw new Error("SESSION_SECRET_REQUIRED_PRODUCTION");\n}\n\n${marker}`);
  }
  out = out.replace('secret: process.env.SESSION_SECRET || "dev_secret",', 'secret: process.env.SESSION_SECRET || "dev_secret",');
  // Dejamos fallback solo para desarrollo, pero en production ya aborta antes.
  return out;
});

// 2) vote_tokens no tiene created_by_admin_id en el schema real.
apply("remove created_by_admin_id from vote_tokens inserts", txt => {
  let out = txt;
  out = out.replaceAll(
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, created_by_admin_id, issued_via)",
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
  return out;
});

// 3) Padron maestro: mismo DNI/email puede existir en distintas propiedades.
apply("resident registry upsert is unit scoped", txt => {
  if (txt.includes("Una persona puede tener mas de una propiedad")) return txt;
  const start = txt.indexOf("async function upsertResidentRegistry(");
  if (start < 0) return txt;
  const endMarker = "function toDatetimeLocalForInput";
  const end = txt.indexOf(endMarker, start);
  if (end < 0) return txt;

  const replacement = `async function upsertResidentRegistry({ unit_id, name, dni, phone, email, status = "ACTIVE", notes = null }) {
  const dniN = cleanText(dni);
  const phoneN = cleanText(phone);
  const emailN = cleanText(email)?.toLowerCase() || null;
  const nameN = String(name || "").trim();
  if (!unit_id || !nameN) return null;

  // Una persona puede tener mas de una propiedad. Por eso el match es por unidad
  // y luego por algun dato de identidad/contacto. No usamos DNI/email globalmente.
  const found = (await q(
    \`SELECT id FROM resident_registry
     WHERE unit_id=$1
       AND (
         ($2::text IS NOT NULL AND lower(COALESCE(dni,''))=lower($2))
         OR ($3::text IS NOT NULL AND lower(COALESCE(email,''))=lower($3))
         OR ($4::text IS NOT NULL AND phone=$4)
       )
     ORDER BY id ASC
     LIMIT 1\`,
    [unit_id, dniN, emailN, phoneN]
  )).rows[0];

  if (found) {
    return (await q(
      \`UPDATE resident_registry
       SET name=$1, dni=$2, phone=$3, email=$4, status=$5, notes=COALESCE($6, notes), updated_at=now()
       WHERE id=$7
       RETURNING id\`,
      [nameN, dniN, phoneN, emailN, status, notes, found.id]
    )).rows[0];
  }

  return (await q(
    \`INSERT INTO resident_registry(unit_id, name, dni, phone, email, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id\`,
    [unit_id, nameN, dniN, phoneN, emailN, status, notes]
  )).rows[0];
}

`;
  return txt.slice(0, start) + replacement + txt.slice(end);
});

// 4) Dejar una sola ruta POST /votar/:token/referendum. La primera es la ruta nueva con recibo.
apply("remove duplicate old referendum vote route", txt => {
  const marker = 'app.post("/votar/:token/referendum"';
  const first = txt.indexOf(marker);
  if (first < 0) return txt;
  const second = txt.indexOf(marker, first + marker.length);
  if (second < 0) return txt;
  const end = findRouteEnd(txt, second);
  if (end < 0) throw new Error("No pude encontrar fin de la segunda ruta referendum");
  return txt.slice(0, second) + txt.slice(end + (txt[end] === "\n" ? 1 : 0));
});

// 5) Resultados publicos: no mostrar resultados directos de una campaña activa antes del cierre.
apply("guard public results until vote close", txt => {
  if (txt.includes("PUBLIC_RESULTS_UNTIL_CLOSE_GUARD")) return txt;
  const marker = 'app.get("/resultados/:electionId"';
  const idx = txt.indexOf(marker);
  if (idx < 0) return txt;
  const guard = [
    "// PUBLIC_RESULTS_UNTIL_CLOSE_GUARD",
    "app.get(\"/resultados/:electionId\", async (req, res, next) => {",
    "  const electionId = Number(req.params.electionId);",
    "  if (!electionId) return next();",
    "  const election = (await q(`SELECT * FROM elections WHERE id=$1`, [electionId])).rows[0];",
    "  if (!election) return next();",
    "  const active = await getActiveElection();",
    "  if (active && Number(active.id) === electionId && now() < new Date(election.vote_close_at)) {",
    "    return res.render(\"results_pending\", { election });",
    "  }",
    "  return next();",
    "});",
    ""
  ].join("\n");
  return txt.slice(0, idx) + guard + txt.slice(idx);
});

// 6) /resultados sin id: si no hay activa, redirigir a ultima cerrada.
apply("redirect resultados to latest finished when no active", txt => txt.replace(
  'app.get("/resultados", async (req, res) => {\n  const active = await getActiveElection();\n  if (!active) return res.render("no_active");\n  res.redirect(`/resultados/${active.id}`);\n});',
  'app.get("/resultados", async (req, res) => {\n  const active = await getActiveElection();\n  if (active) return res.redirect(`/resultados/${active.id}`);\n  const latestFinished = await getLatestFinishedElection();\n  if (latestFinished) return res.redirect(`/resultados/${latestFinished.id}`);\n  return res.render("no_active", { latestFinished: null });\n});'
));

// 7) No editar campañas selladas, aunque sean inactivas y getActiveElectionOrLatest las encuentre.
apply("block editing sealed campaign", txt => {
  if (txt.includes("ELECTION_EDIT_BLOCKED_SEALED")) return txt;
  const route = 'app.post("/admin/election/edit", requireAdmin, async (req, res) => {';
  const idx = txt.indexOf(route);
  if (idx < 0) return txt;
  const after = txt.indexOf('if (!election) return res.status(500).send("No hay campañas.");', idx);
  if (after < 0) return txt;
  const insertAt = after + 'if (!election) return res.status(500).send("No hay campañas.");'.length;
  const guard = '\n  if (await isElectionSealed(election.id)) {\n    await audit("ELECTION_EDIT_BLOCKED_SEALED", { actor_admin_id: req.session.admin.id, election_id: election.id });\n    return res.status(403).send("Esta campaña ya fue sellada y no puede editarse.");\n  }';
  return txt.slice(0, insertAt) + guard + txt.slice(insertAt);
});

// 8) Email de registro recibido debe incluir unidad.
apply("registration received email includes unit", txt => txt.replaceAll(
  "send: () => sendRegistrationReceived({ to: email, name, electionTitle: active.title })",
  "send: () => sendRegistrationReceived({ to: email, name, electionTitle: active.title, unitLabel: unit.label })"
));

fs.writeFileSync(serverFile, s);
console.log(changed ? "[OK] stabilization patch aplicado" : "[OK] nada para aplicar");
