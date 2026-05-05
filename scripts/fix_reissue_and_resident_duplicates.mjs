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

// 1) Reemitir token: la tabla vote_tokens real no tiene created_by_admin_id.
apply("fix reissue vote_tokens insert schema", txt => {
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

// 2) Resident registry: una misma persona puede tener varias propiedades.
// El upsert debe preferir match por unidad + DNI/email/telefono, no match global.
apply("make resident registry upsert unit-scoped", txt => {
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

// 3) Texto viejo en padron PDF.
apply("padron committee wording", txt => txt.replaceAll("Comité Electoral", "Consejo Directivo"));

fs.writeFileSync(serverFile, s);
console.log(changed ? "[OK] reissue + resident duplicates fix aplicado" : "[OK] nada para aplicar");
