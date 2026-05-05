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

// La tabla vote_tokens real no tiene created_by_admin_id.
// Quitamos esa columna de cualquier INSERT agregado por patches recientes.
apply("remove created_by_admin_id from vote_tokens inserts", txt => {
  let out = txt;
  out = out.replaceAll(
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, created_by_admin_id, issued_via)",
    "INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, issued_via)"
  );
  out = out.replaceAll(
    "VALUES ($1,$2,$3,$4,'ACTIVE',$5,'EMAIL')",
    "VALUES ($1,$2,$3,$4,'ACTIVE','EMAIL')"
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

// Por si quedó alguna ruta renderizando sin bulkResult/admin.
apply("default bulkResult in admin_requests renders", txt => {
  return txt.replaceAll(
    'res.render("admin_requests", { election, rows, filter });',
    'res.render("admin_requests", { admin: req.session.admin, election, rows, filter, bulkResult: null });'
  );
});

fs.writeFileSync(serverFile, s);
console.log(changed ? "[OK] bulk schema/view fix aplicado" : "[OK] nada para aplicar");
