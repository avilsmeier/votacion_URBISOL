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

apply("block activation of sealed elections", txt => {
  if (txt.includes("ELECTION_ACTIVATE_BLOCKED_SEALED")) return txt;

  const marker = 'app.post("/admin/elections/:id/activate", requireAdmin, async (req, res) => {';
  const idx = txt.indexOf(marker);
  if (idx < 0) throw new Error('No encontre ruta POST /admin/elections/:id/activate');

  const openBraceEnd = idx + marker.length;
  const guard = [
    "",
    "  const id = Number(req.params.id);",
    "  if (await isElectionSealed(id)) {",
    "    await audit(\"ELECTION_ACTIVATE_BLOCKED_SEALED\", { actor_admin_id: req.session.admin.id, election_id: id });",
    "    return res.status(403).send(\"Esta campaña ya fue sellada y no puede reactivarse. Los resultados permanecen disponibles en el histórico.\");",
    "  }"
  ].join("\n");

  return txt.slice(0, openBraceEnd) + guard + txt.slice(openBraceEnd);
});

fs.writeFileSync(serverFile, s);

if (fs.existsSync(dashboardFile)) {
  let d = fs.readFileSync(dashboardFile, "utf8");
  const before = d;

  // Oculta/deshabilita la acción Activar en histórico si la campaña ya vino marcada con seals_count.
  // Si el dashboard todavía no trae seals_count desde SQL, queda el bloqueo server-side como protección real.
  d = d.replace(
    '${admin.role==="admin" && !e.is_active ? `\n              | <form style="display:inline" method="POST" action="/admin/elections/${e.id}/activate"><button type="submit">Activar</button></form>\n            ` : ``}',
    '${admin.role==="admin" && !e.is_active ? `\n              ${Number(e.seals_count || 0) > 0 ? ` | <span class="muted">Sellada</span>` : ` | <form style="display:inline" method="POST" action="/admin/elections/${e.id}/activate"><button type="submit">Activar</button></form>`}\n            ` : ``}'
  );

  if (d !== before) {
    fs.writeFileSync(dashboardFile, d);
    changed = true;
    console.log("[OK] dashboard hides sealed activation when data exists");
  } else {
    console.log("[OK] dashboard hide sealed activation ya estaba aplicado o no matcheo");
  }
}

console.log(changed ? "[OK] no-reactivate-sealed aplicado" : "[OK] nada para aplicar");
