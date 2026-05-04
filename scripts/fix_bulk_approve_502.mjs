import fs from "fs";

const serverFile = "src/server.js";
const requestsViewFile = "src/views/admin_requests.ejs";
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

// El 502 del bulk suele venir de la vista: admin/bulkResult no siempre se pasan al render.
apply("pass admin and bulkResult to admin_requests", txt => {
  return txt
    .replaceAll(
      'res.render("admin_requests", { election, rows, filter });',
      'res.render("admin_requests", { admin: req.session.admin, election, rows, filter, bulkResult: { bulk: req.query.bulk, approved: req.query.approved, sent: req.query.sent, failed: req.query.failed, skipped: req.query.skipped } });'
    )
    .replaceAll(
      'res.render("admin_requests", { election, rows, filter, active });',
      'res.render("admin_requests", { admin: req.session.admin, election, rows, filter, active, bulkResult: { bulk: req.query.bulk, approved: req.query.approved, sent: req.query.sent, failed: req.query.failed, skipped: req.query.skipped } });'
    );
});

// Hacer el bulk approve tolerante: si un correo falla, no debe tumbar la app ni devolver 502.
apply("bulk approve route catch", txt => {
  if (txt.includes("BULK_APPROVE_SAFE_ROUTE")) return txt;
  const marker = 'app.post("/admin/solicitudes/bulk-approve", requireAdmin, async (req, res) => {';
  const idx = txt.indexOf(marker);
  if (idx < 0) return txt;
  const insertAt = idx + marker.length;
  return txt.slice(0, insertAt) + '\n  // BULK_APPROVE_SAFE_ROUTE\n  try {' + txt.slice(insertAt);
});

apply("bulk approve route catch close", txt => {
  if (!txt.includes("BULK_APPROVE_SAFE_ROUTE")) return txt;
  if (txt.includes("BULK_APPROVE_SAFE_ROUTE_END")) return txt;
  const needle = '  res.redirect(`/admin/solicitudes?filter=pending&bulk=1&approved=${approved}&sent=${sent}&failed=${failed}&skipped=${skipped}`);\n});';
  const replacement = '  res.redirect(`/admin/solicitudes?filter=pending&bulk=1&approved=${approved}&sent=${sent}&failed=${failed}&skipped=${skipped}`);\n  } catch (e) {\n    console.error("bulk approve failed", e);\n    await audit("REGISTRATION_BULK_APPROVE_FAILED", { actor_admin_id: req.session.admin.id, election_id: active?.id ?? null, meta_json: { error: String(e?.message || e) } });\n    return res.status(500).send("Error aprobando solicitudes en bloque. Revisa los logs del servidor.");\n  }\n  // BULK_APPROVE_SAFE_ROUTE_END\n});';
  return txt.replace(needle, replacement);
});

fs.writeFileSync(serverFile, s);

if (fs.existsSync(requestsViewFile)) {
  const view = `<%- include('layout', { title: "Solicitudes", body: \`
  <div class="card">
    <div class="topbar">
      <h2>Solicitudes - \${election.title}</h2>
      <a href="/admin">Volver</a>
    </div>

    <div class="row" style="margin-top:10px">
      <a href="/admin/solicitudes?filter=pending"><button class="\${filter==='pending'?'ok':''}">Pendientes</button></a>
      <a href="/admin/solicitudes?filter=approved"><button class="\${filter==='approved'?'ok':''}">Aprobadas</button></a>
      <a href="/admin/solicitudes?filter=rejected"><button class="\${filter==='rejected'?'ok':''}">Rechazadas</button></a>
      <a href="/admin/solicitudes?filter=all"><button class="\${filter==='all'?'ok':''}">Todas</button></a>
    </div>

    <p class="muted" style="margin-top:10px">Tip: normalmente el Consejo Directivo trabaja solo con “Pendientes”.</p>

    \${bulkResult && bulkResult.bulk ? \`
      <div style="padding:10px; border:1px solid #eee; border-radius:10px; margin:10px 0">
        Resultado bulk: \${bulkResult.approved || 0} aprobada(s), \${bulkResult.sent || 0} email(s) enviados, \${bulkResult.failed || 0} fallido(s), \${bulkResult.skipped || 0} omitida(s).
      </div>
    \` : \`\`}

    \${filter === "pending" && admin && admin.role === "admin" ? \`
      <form method="POST" action="/admin/solicitudes/bulk-approve" onsubmit="return confirm('Se aprobarán las solicitudes seleccionadas y se enviarán los enlaces por email. ¿Continuar?')">
        <button class="ok" type="submit" style="margin:12px 0">Aprobar seleccionadas y enviar email</button>
    \` : \`\`}

    <table style="width:100%; border-collapse:collapse">
      <tr>
        \${filter === "pending" && admin && admin.role === "admin" ? \`<th align="left">Sel.</th>\` : \`\`}
        <th align="left">Fecha</th>
        <th align="left">Unidad</th>
        <th align="left">Nombre</th>
        <th align="left">Email</th>
        <th align="left">Estado</th>
      </tr>
      \${rows.map(r => \`
        <tr style="border-top:1px solid #eee">
          \${filter === "pending" && admin && admin.role === "admin" ? \`<td><input type="checkbox" name="registration_ids" value="\${r.id}" style="width:auto" checked /></td>\` : \`\`}
          <td>\${new Date(r.created_at).toLocaleString("es-PE")}</td>
          <td><a href="/admin/solicitudes/\${r.id}">\${r.unit_label}</a></td>
          <td>\${r.name}</td>
          <td>\${r.email || "-"}</td>
          <td><b>\${r.status}</b></td>
        </tr>
      \`).join("")}
    </table>

    \${filter === "pending" && admin && admin.role === "admin" ? \`</form>\` : \`\`}
  </div>
\` }) %>
`;
  const before = fs.readFileSync(requestsViewFile, "utf8");
  if (before !== view) {
    fs.writeFileSync(requestsViewFile, view);
    changed = true;
    console.log("[OK] rewrite admin_requests view safely");
  } else {
    console.log("[OK] admin_requests view ya estaba igual");
  }
}

console.log(changed ? "[OK] bulk approve 502 fix aplicado" : "[OK] nada para aplicar");
