import fs from "fs";

const file = "src/server.js";
let s = fs.readFileSync(file, "utf8");
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

// El patch anterior de alertas duplicadas uso LEFT JOIN + COUNT FILTER.
// En algunas rutas reemplazo el SELECT pero no quedo GROUP BY compatible, generando:
// column "r.id" must appear in the GROUP BY clause.
// Usamos subqueries escalares: no requieren GROUP BY y son mas seguras para r.*.
apply("replace aggregate duplicate counters with scalar subqueries", txt => {
  let out = txt;

  out = out.replaceAll(
    `SELECT r.*, u.label AS unit_label,
            COUNT(*) FILTER (WHERE r2.status IN ('PENDING','APPROVED'))::int AS duplicate_open_count,
            COUNT(*) FILTER (WHERE r2.status='PENDING')::int AS duplicate_pending_count,
            COUNT(*) FILTER (WHERE r2.status='APPROVED')::int AS duplicate_approved_count
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     LEFT JOIN registrations r2 ON r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id`,
    `SELECT r.*, u.label AS unit_label,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status IN ('PENDING','APPROVED')) AS duplicate_open_count,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status='PENDING') AS duplicate_pending_count,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status='APPROVED') AS duplicate_approved_count
     FROM registrations r
     JOIN units u ON u.id=r.unit_id`
  );

  out = out.replaceAll(
    `SELECT r.*, u.label AS unit_label,
            COUNT(*) FILTER (WHERE r2.status IN ('PENDING','APPROVED'))::int AS detail_duplicate_open_count,
            COUNT(*) FILTER (WHERE r2.status='PENDING')::int AS detail_duplicate_pending_count,
            COUNT(*) FILTER (WHERE r2.status='APPROVED')::int AS detail_duplicate_approved_count
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     LEFT JOIN registrations r2 ON r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id`,
    `SELECT r.*, u.label AS unit_label,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status IN ('PENDING','APPROVED')) AS detail_duplicate_open_count,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status='PENDING') AS detail_duplicate_pending_count,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status='APPROVED') AS detail_duplicate_approved_count
     FROM registrations r
     JOIN units u ON u.id=r.unit_id`
  );

  // Si quedo algun GROUP BY agregado por el patch anterior, quitarlo.
  out = out.replaceAll(
    `GROUP BY r.id, u.label
     ORDER BY r.created_at DESC`,
    `ORDER BY r.created_at DESC`
  );
  out = out.replaceAll(
    `GROUP BY r.id, u.label`,
    ``
  );

  return out;
});

fs.writeFileSync(file, s);
console.log(changed ? "[OK] duplicate warning query fix aplicado" : "[OK] nada para aplicar");
