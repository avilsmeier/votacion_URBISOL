import fs from "fs";

const serverFile = "src/server.js";
const usersViewFile = "src/views/admin_users.ejs";
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

// 1) Arreglar el duplicate const id que pudo dejar fix_no_reactivate_sealed.mjs.
apply("fix duplicate id in activate route", txt => {
  return txt.replace(
    /(app\.post\("\/admin\/elections\/:id\/activate", requireAdmin, async \(req, res\) => \{\s*const id = Number\(req\.params\.id\);\s*if \(await isElectionSealed\(id\)\) \{[\s\S]*?return res\.status\(403\)\.send\("Esta campaña ya fue sellada y no puede reactivarse\. Los resultados permanecen disponibles en el histórico\."\);\s*\}\s*)const id = Number\(req\.params\.id\);/,
    "$1"
  );
});

// 2) Si no existe todavía el bloqueo de reactivación, insertarlo sin redeclarar id.
apply("ensure sealed campaigns cannot reactivate", txt => {
  if (txt.includes("ELECTION_ACTIVATE_BLOCKED_SEALED")) return txt;
  const marker = 'app.post("/admin/elections/:id/activate", requireAdmin, async (req, res) => {';
  const idx = txt.indexOf(marker);
  if (idx < 0) throw new Error('No encontre ruta POST /admin/elections/:id/activate');

  const routeStart = idx + marker.length;
  const rest = txt.slice(routeStart);
  const idLine = '  const id = Number(req.params.id);';
  const idIdx = rest.indexOf(idLine);
  if (idIdx < 0) throw new Error('No encontre const id en activate route');
  const insertAt = routeStart + idIdx + idLine.length;

  const guard = [
    "",
    "  if (await isElectionSealed(id)) {",
    "    await audit(\"ELECTION_ACTIVATE_BLOCKED_SEALED\", { actor_admin_id: req.session.admin.id, election_id: id });",
    "    return res.status(403).send(\"Esta campaña ya fue sellada y no puede reactivarse. Los resultados permanecen disponibles en el histórico.\");",
    "  }"
  ].join("\n");

  return txt.slice(0, insertAt) + guard + txt.slice(insertAt);
});

// 3) Agregar endpoint para eliminar usuarios admin/fiscal/viewer. No permite eliminarse a si mismo.
apply("add delete admin user route", txt => {
  if (txt.includes('app.post("/admin/users/:id/delete"')) return txt;

  const anchor = 'app.post("/admin/users/:id/toggle", requireAdmin, async (req, res) => {';
  const idx = txt.indexOf(anchor);
  if (idx < 0) throw new Error('No encontre ruta toggle de admin users');

  // Insertamos antes de toggle para no depender del final exacto de la ruta.
  const route = [
    'app.post("/admin/users/:id/delete", requireAdmin, async (req, res) => {',
    '  const id = Number(req.params.id);',
    '  if (!id) return res.status(400).send("Usuario inválido.");',
    '  if (id === Number(req.session.admin.id)) return res.status(400).send("No puedes eliminar tu propio usuario mientras estás logueado.");',
    '',
    '  const target = (await q(`SELECT id, email, role FROM admin_users WHERE id=$1`, [id])).rows[0];',
    '  if (!target) return res.status(404).send("Usuario no existe.");',
    '',
    '  await q(`DELETE FROM admin_users WHERE id=$1`, [id]);',
    '  await audit("ADMIN_USER_DELETED", {',
    '    actor_admin_id: req.session.admin.id,',
    '    meta_json: { deleted_admin_user_id: id, email: target.email, role: target.role }',
    '  });',
    '',
    '  res.redirect("/admin/users");',
    '});',
    ''
  ].join("\n");

  return txt.slice(0, idx) + route + txt.slice(idx);
});

fs.writeFileSync(serverFile, s);

// 4) Agregar botón Eliminar en vista de usuarios.
if (fs.existsSync(usersViewFile)) {
  let v = fs.readFileSync(usersViewFile, "utf8");
  const before = v;

  if (!v.includes('/delete"')) {
    v = v.replace(
      '${u.id === admin.id ? `<span class="muted">Actual</span>` : `<form method="POST" action="/admin/users/${u.id}/toggle" style="display:inline"><button type="submit">${u.enabled ? "Desactivar" : "Activar"}</button></form>`}',
      '${u.id === admin.id ? `<span class="muted">Actual</span>` : `<form method="POST" action="/admin/users/${u.id}/toggle" style="display:inline"><button type="submit">${u.enabled ? "Desactivar" : "Activar"}</button></form> <form method="POST" action="/admin/users/${u.id}/delete" style="display:inline" onsubmit="return confirm(\'¿Eliminar este usuario? Esta acción no se puede deshacer.\')"><button type="submit" class="bad">Eliminar</button></form>`}'
    );
  }

  if (v !== before) {
    fs.writeFileSync(usersViewFile, v);
    changed = true;
    console.log("[OK] add delete button to admin users view");
  } else {
    console.log("[OK] delete button ya estaba aplicado o no matcheo");
  }
}

console.log(changed ? "[OK] no reactivate + delete users aplicado" : "[OK] nada para aplicar");
