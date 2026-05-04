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

// 1) Si el guard manual quedo incrustado dentro de otra funcion, lo removemos por sentinel.
apply("remove broken VOTE_GET_WINDOW_GUARD", txt => {
  const marker = "// VOTE_GET_WINDOW_GUARD";
  const start = txt.indexOf(marker);
  if (start < 0) return txt;
  const nextRoute = txt.indexOf('app.get("/votar/:token", async (req, res) => {', start + marker.length);
  if (nextRoute < 0) return txt;
  return txt.slice(0, start) + txt.slice(nextRoute);
});

// 2) Agregamos guard seguro justo antes de la ruta GET original.
apply("insert safe GET vote guard", txt => {
  if (txt.includes("SAFE_VOTE_GET_WINDOW_GUARD")) return txt;
  const marker = 'app.get("/votar/:token", async (req, res) => {';
  const idx = txt.indexOf(marker);
  if (idx < 0) throw new Error('No encontre ruta GET /votar/:token');

  const guard = [
    "// SAFE_VOTE_GET_WINDOW_GUARD",
    "app.get(\"/votar/:token\", async (req, res, next) => {",
    "  const election = await getActiveElection();",
    "  if (!election) return res.render(\"no_active\");",
    "",
    "  const tokenHash = hashToken(req.params.token);",
    "  const t = (await q(",
    "    `SELECT id, status FROM vote_tokens WHERE token_hash=$1 AND election_id=$2 LIMIT 1`,",
    "    [tokenHash, election.id]",
    "  )).rows[0];",
    "",
    "  if (!t) return res.status(404).send(\"Enlace inválido.\");",
    "  if (t.status !== \"ACTIVE\") return res.render(\"vote_used\", { election });",
    "",
    "  const n = now();",
    "  if (n < new Date(election.vote_open_at)) {",
    "    return res.render(\"closed\", { election, state: \"pending\" });",
    "  }",
    "  if (n > new Date(election.vote_close_at)) {",
    "    return res.render(\"closed\", { election, state: \"closed\" });",
    "  }",
    "  return next();",
    "});",
    ""
  ].join("\n");

  return txt.slice(0, idx) + guard + txt.slice(idx);
});

// 3) Padrón PDF: nomenclatura Consejo Directivo y firmas para encuesta.
apply("padron pdf text labels", txt => txt
  .replaceAll("APROBADOS por el Comité Electoral", "APROBADOS por el Consejo Directivo")
  .replaceAll("Comité Electoral", "Consejo Directivo")
);

// 4) Intento quirurgico para firmas del padron si aun tiene labels genericos.
apply("padron pdf survey signature labels", txt => {
  const oldBlock = [
    'signLine(x1, sy, "Presidente(a) Consejo Directivo");',
    'signLine(x2, sy, "Miembro Consejo Directivo");',
    '',
    'sy += 46;',
    'signLine(x1, sy, "Miembro Consejo Directivo");',
    'signLine(x2, sy, "Fiscal");'
  ].join("\n");
  const newBlock = [
    'const signatureLabels = active.kind === "VOTACION"',
    '  ? ["Presidente", "Vicepresidente", "Secretario", "Tesorero (opcional)", "Fiscal"]',
    '  : ["Presidente", "Vicepresidente", "Secretario", "Fiscal", "Personero(a) 1", "Personero(a) 2"];',
    '',
    'for (let i = 0; i < signatureLabels.length; i += 2) {',
    '  signLine(x1, sy, signatureLabels[i]);',
    '  if (signatureLabels[i + 1]) signLine(x2, sy, signatureLabels[i + 1]);',
    '  sy += 46;',
    '}'
  ].join("\n");
  if (!txt.includes(oldBlock) || txt.includes("signatureLabels = active.kind")) return txt;
  return txt.replace(oldBlock, newBlock);
});

fs.writeFileSync(serverFile, s);
console.log(changed ? "[OK] fix aplicado" : "[OK] nada para aplicar");
