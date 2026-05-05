import fs from "fs";

const serverFile = "src/server.js";
const requestsViewFile = "src/views/admin_requests.ejs";
const detailViewFile = "src/views/admin_request_detail.ejs";
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

apply("add duplicate counters to solicitudes query", txt => {
  if (txt.includes("duplicate_open_count")) return txt;
  return txt.replace(
    `SELECT r.*, u.label AS unit_label
     FROM registrations r
     JOIN units u ON u.id=r.unit_id`,
    `SELECT r.*, u.label AS unit_label,
            COUNT(*) FILTER (WHERE r2.status IN ('PENDING','APPROVED'))::int AS duplicate_open_count,
            COUNT(*) FILTER (WHERE r2.status='PENDING')::int AS duplicate_pending_count,
            COUNT(*) FILTER (WHERE r2.status='APPROVED')::int AS duplicate_approved_count
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     LEFT JOIN registrations r2 ON r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id`
  ).replace(
    `ORDER BY r.created_at DESC`,
    `GROUP BY r.id, u.label
     ORDER BY r.created_at DESC`
  );
});

apply("add duplicate counters to solicitud detail query", txt => {
  if (txt.includes("detail_duplicate_open_count")) return txt;
  return txt.replace(
    `SELECT r.*, u.label AS unit_label
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     WHERE r.id=$1 AND r.election_id=$2`,
    `SELECT r.*, u.label AS unit_label,
            COUNT(*) FILTER (WHERE r2.status IN ('PENDING','APPROVED'))::int AS detail_duplicate_open_count,
            COUNT(*) FILTER (WHERE r2.status='PENDING')::int AS detail_duplicate_pending_count,
            COUNT(*) FILTER (WHERE r2.status='APPROVED')::int AS detail_duplicate_approved_count
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     LEFT JOIN registrations r2 ON r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id
     WHERE r.id=$1 AND r.election_id=$2
     GROUP BY r.id, u.label`
  );
});

apply("bulk approve skips duplicate approved unit", txt => {
  if (txt.includes("BULK_DUPLICATE_APPROVED_UNIT_GUARD")) return txt;
  return txt.replace(
    `if (!reg || reg.status !== "PENDING" || !reg.email) { skipped++; continue; }

    const raw = newToken();`,
    `if (!reg || reg.status !== "PENDING" || !reg.email) { skipped++; continue; }

    // BULK_DUPLICATE_APPROVED_UNIT_GUARD
    const unitAlreadyApproved = (await q(
      \`SELECT 1 FROM registrations
       WHERE election_id=$1 AND unit_id=$2 AND status='APPROVED' AND id<>$3
       LIMIT 1\`,
      [active.id, reg.unit_id, reg.id]
    )).rows.length > 0;
    if (unitAlreadyApproved) { skipped++; continue; }

    const raw = newToken();`
  );
});

apply("individual approval blocks duplicate approved unit", txt => {
  if (txt.includes("APPROVE_DUPLICATE_APPROVED_UNIT_GUARD")) return txt;
  return txt.replace(
    `if (!reg.email) return res.status(400).send("La solicitud no tiene correo electrónico.");

  const raw = newToken();`,
    `if (!reg.email) return res.status(400).send("La solicitud no tiene correo electrónico.");

  // APPROVE_DUPLICATE_APPROVED_UNIT_GUARD
  const unitAlreadyApproved = (await q(
    \`SELECT id, name, email FROM registrations
     WHERE election_id=$1 AND unit_id=$2 AND status='APPROVED' AND id<>$3
     ORDER BY reviewed_at DESC NULLS LAST, id DESC
     LIMIT 1\`,
    [active.id, reg.unit_id, reg.id]
  )).rows[0];
  if (unitAlreadyApproved) {
    return res.status(400).send(\`Esta unidad ya tiene una solicitud aprobada (ID \${unitAlreadyApproved.id}). Rechaza o revisa el duplicado antes de aprobar otra.\`);
  }

  const raw = newToken();`
  );
});

fs.writeFileSync(serverFile, s);

if (fs.existsSync(requestsViewFile)) {
  let v = fs.readFileSync(requestsViewFile, "utf8");
  const before = v;
  if (!v.includes("duplicate_open_count")) {
    v = v.replace(
      '<th align="left">Unidad</th>',
      '<th align="left">Unidad</th>\n        <th align="left">Alerta</th>'
    );
    v = v.replace(
      '<td><a href="/admin/solicitudes/${r.id}">${r.unit_label}</a></td>',
      '<td><a href="/admin/solicitudes/${r.id}">${r.unit_label}</a></td>\n          <td>${Number(r.duplicate_open_count || 0) > 0 ? `<span title="Hay otra solicitud pendiente/aprobada para esta misma unidad" style="font-weight:bold; color:#b45309">⚠️ Duplicado</span>` : ``}</td>'
    );
  }
  if (v !== before) {
    fs.writeFileSync(requestsViewFile, v);
    changed = true;
    console.log("[OK] admin_requests duplicate warnings");
  } else {
    console.log("[OK] admin_requests duplicate warnings ya estaba aplicado o no matcheo");
  }
}

if (fs.existsSync(detailViewFile)) {
  let v = fs.readFileSync(detailViewFile, "utf8");
  const before = v;
  if (!v.includes("detail_duplicate_open_count")) {
    v = v.replace(
      '<p><b>Estado:</b> ${r.status}</p>',
      '<p><b>Estado:</b> ${r.status}</p>\n\n    ${Number(r.detail_duplicate_open_count || 0) > 0 ? `\n      <div style="padding:12px; border:1px solid #f59e0b; background:#fffbeb; border-radius:10px; margin:14px 0">\n        <b>⚠️ Posible duplicado de unidad</b>\n        <p class="muted" style="margin-bottom:0">Hay ${r.detail_duplicate_open_count} otra(s) solicitud(es) pendiente(s) o aprobada(s) para esta misma unidad. Antes de aprobar, verifica cuál corresponde conservar.</p>\n      </div>\n    ` : ``}'
    );
  }
  if (v !== before) {
    fs.writeFileSync(detailViewFile, v);
    changed = true;
    console.log("[OK] admin_request_detail duplicate warning");
  } else {
    console.log("[OK] admin_request_detail duplicate warning ya estaba aplicado o no matcheo");
  }
}

console.log(changed ? "[OK] duplicate unit warnings aplicado" : "[OK] nada para aplicar");
