import fs from "fs";

const file = "src/server.js";
let s = fs.readFileSync(file, "utf8");

if (s.includes("PRINT_PADRON_VOTE_STATUS_BY_TOKEN")) {
  console.log("[OK] print padron vote status ya estaba aplicado");
  process.exit(0);
}

const marker = 'app.get("/admin/print/padron"';
const start = s.indexOf(marker);
if (start < 0) throw new Error("No encontre ruta /admin/print/padron");

const openBrace = s.indexOf("{", start);
if (openBrace < 0) throw new Error("No encontre apertura de ruta /admin/print/padron");

let depth = 0;
let end = -1;
let inStr = null;
let escape = false;
let inLineComment = false;
let inBlockComment = false;

for (let i = openBrace; i < s.length; i++) {
  const ch = s[i];
  const next = s[i + 1];

  if (inLineComment) {
    if (ch === "\n") inLineComment = false;
    continue;
  }
  if (inBlockComment) {
    if (ch === "*" && next === "/") {
      inBlockComment = false;
      i++;
    }
    continue;
  }
  if (inStr) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === inStr) inStr = null;
    continue;
  }

  if (ch === "/" && next === "/") {
    inLineComment = true;
    i++;
    continue;
  }
  if (ch === "/" && next === "*") {
    inBlockComment = true;
    i++;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === "`") {
    inStr = ch;
    continue;
  }
  if (ch === "{") depth++;
  if (ch === "}") {
    depth--;
    if (depth === 0) {
      const closeCall = s.indexOf(");", i);
      if (closeCall < 0) throw new Error("No encontre cierre de ruta /admin/print/padron");
      end = closeCall + 2;
      break;
    }
  }
}

if (end < 0) throw new Error("No pude determinar fin de ruta /admin/print/padron");

const route = `app.get("/admin/print/padron", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(400).send("No hay campaña activa.");

  // PRINT_PADRON_VOTE_STATUS_BY_TOKEN
  // El estado de voto debe salir del voto real ligado al token usado.
  // En campañas VOTACION el voto vive en referendum_votes, no en votes.
  const rows = (await q(\`
    SELECT
      u.label AS unidad,
      r.status AS registro_estado,
      COALESCE(vt.status, '-') AS token_estado,
      CASE
        WHEN rv.id IS NOT NULL OR cv.id IS NOT NULL OR fv.id IS NOT NULL THEN 'SI'
        ELSE 'NO'
      END AS voto_emitido
    FROM registrations r
    JOIN units u ON u.id = r.unit_id
    LEFT JOIN LATERAL (
      SELECT id, status
      FROM vote_tokens
      WHERE registration_id = r.id
      ORDER BY id DESC
      LIMIT 1
    ) vt ON true
    LEFT JOIN referendum_votes rv ON rv.token_id = vt.id AND rv.election_id = r.election_id
    LEFT JOIN votes cv ON cv.token_id = vt.id AND cv.election_id = r.election_id
    LEFT JOIN fiscal_votes fv ON fv.token_id = vt.id AND fv.election_id = r.election_id
    WHERE r.election_id = $1
      AND r.status = 'APPROVED'
    ORDER BY u.label ASC, r.id ASC
  \`, [election.id])).rows;

  res.render("admin_print_padron", { election, rows });
});`;

s = s.slice(0, start) + route + s.slice(end);
fs.writeFileSync(file, s);
console.log("[OK] /admin/print/padron ahora calcula voto_emitido por token_id en referendum_votes/votes/fiscal_votes");
