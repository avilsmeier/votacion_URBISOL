import fs from 'fs';

const file = 'src/server.js';
let s = fs.readFileSync(file, 'utf8');
let changed = false;

function replaceOnce(label, from, to) {
  if (s.includes(to)) return;
  if (!s.includes(from)) throw new Error(`No encontre bloque: ${label}`);
  s = s.replace(from, to);
  changed = true;
}

function insertBefore(label, marker, block) {
  if (s.includes(block.trim().slice(0, 80))) return;
  if (!s.includes(marker)) throw new Error(`No encontre marker: ${label}`);
  s = s.replace(marker, `${block}\n\n${marker}`);
  changed = true;
}

// Landing y registro sin campaña activa deben mostrar pantalla útil
s = s.replaceAll(
  'return res.status(500).send("No hay elección activa configurada.");',
  'return res.render("no_active");'
);
s = s.replaceAll(
  'return res.status(500).send("No hay elección activa.");',
  'return res.render("no_active");'
);
changed = true;

// Login: usuarios desactivados no entran
replaceOnce(
  'login disabled check',
  `  const user = u.rows[0];\n  const ok = await bcrypt.compare(password, user.password_hash);`,
  `  const user = u.rows[0];\n  if (user.enabled === false) return res.render("admin_login", { error: "Credenciales inválidas." });\n  const ok = await bcrypt.compare(password, user.password_hash);`
);

// Helper padrón maestro
replaceOnce(
  'resident registry helper',
  `async function getReferendumForElection(electionId) {
  const question = (await q(
    \`SELECT * FROM referendum_questions WHERE election_id=$1 ORDER BY sort_order ASC, id ASC LIMIT 1\`,
    [electionId]
  )).rows[0] || null;
  if (!question) return { question: null, options: [] };
  const options = (await q(
    \`SELECT * FROM referendum_options WHERE election_id=$1 AND question_id=$2 ORDER BY sort_order ASC, id ASC\`,
    [electionId, question.id]
  )).rows;
  return { question, options };
}`,
  `async function getReferendumForElection(electionId) {
  const question = (await q(
    \`SELECT * FROM referendum_questions WHERE election_id=$1 ORDER BY sort_order ASC, id ASC LIMIT 1\`,
    [electionId]
  )).rows[0] || null;
  if (!question) return { question: null, options: [] };
  const options = (await q(
    \`SELECT * FROM referendum_options WHERE election_id=$1 AND question_id=$2 ORDER BY sort_order ASC, id ASC\`,
    [electionId, question.id]
  )).rows;
  return { question, options };
}

function cleanText(v) {
  const s = String(v || "").trim();
  return s || null;
}

async function upsertResidentRegistry({ unit_id, name, dni, phone, email, status = "ACTIVE", notes = null }) {
  const dniN = cleanText(dni);
  const phoneN = cleanText(phone);
  const emailN = cleanText(email)?.toLowerCase() || null;
  const nameN = String(name || "").trim();
  if (!unit_id || !nameN) return null;

  const found = (await q(
    \`SELECT id FROM resident_registry
     WHERE ($1::text IS NOT NULL AND lower(dni)=lower($1))
        OR ($2::text IS NOT NULL AND lower(email)=lower($2))
        OR ($3::text IS NOT NULL AND phone=$3)
     ORDER BY id ASC
     LIMIT 1\`,
    [dniN, emailN, phoneN]
  )).rows[0];

  if (found) {
    return (await q(
      \`UPDATE resident_registry
       SET unit_id=$1, name=$2, dni=$3, phone=$4, email=$5, status=$6, notes=COALESCE($7, notes), updated_at=now()
       WHERE id=$8
       RETURNING id\`,
      [unit_id, nameN, dniN, phoneN, emailN, status, notes, found.id]
    )).rows[0];
  }

  return (await q(
    \`INSERT INTO resident_registry(unit_id, name, dni, phone, email, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id\`,
    [unit_id, nameN, dniN, phoneN, emailN, status, notes]
  )).rows[0];
}`
);

// Registro público: guardar/actualizar padrón maestro sin romper registro si falla el sync
replaceOnce(
  'sync resident registry on registration',
  `  await audit("REGISTRATION_CREATED", {
    election_id: election.id,
    registration_id: r.rows[0].id,
    unit_id: unit.id,
    meta_json: { email: email.trim().toLowerCase(), phone: phone.trim() }
  });

  res.render("register_done", { election });`,
  `  await audit("REGISTRATION_CREATED", {
    election_id: election.id,
    registration_id: r.rows[0].id,
    unit_id: unit.id,
    meta_json: { email: email.trim().toLowerCase(), phone: phone.trim() }
  });

  try {
    await upsertResidentRegistry({
      unit_id: unit.id,
      name: name.trim(),
      dni: dni.trim(),
      phone: phone.trim(),
      email: email.trim().toLowerCase()
    });
  } catch (e) {
    console.error("resident_registry sync failed", e);
  }

  res.render("register_done", { election });`
);

const routesBlock = `/* =========================
   ADMIN: usuarios y padrón maestro
========================= */
app.get("/admin/users", requireAdmin, async (req, res) => {
  const users = (await q(
    \`SELECT id, email, role, COALESCE(enabled,true) AS enabled, created_at, updated_at
     FROM admin_users
     ORDER BY email ASC\`
  )).rows;
  res.render("admin_users", { admin: req.session.admin, users });
});

app.post("/admin/users/new", requireAdmin, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const secret = String(req.body.secret || "");
  const role = String(req.body.role || "viewer") === "admin" ? "admin" : "viewer";
  if (!email || !secret) return res.status(400).send("Email y clave son obligatorios.");

  const hash = await bcrypt.hash(secret, 12);
  const user = (await q(
    \`INSERT INTO admin_users(email, password_hash, role, enabled)
     VALUES ($1,$2,$3,true)
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role, enabled=true, updated_at=now()
     RETURNING id\`,
    [email, hash, role]
  )).rows[0];

  await audit("ADMIN_USER_UPSERTED", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: user.id, email, role }});
  res.redirect("/admin/users");
});

app.post("/admin/users/:id/role", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const role = String(req.body.role || "viewer") === "admin" ? "admin" : "viewer";
  if (id === req.session.admin.id && role !== "admin") return res.status(400).send("No puedes quitarte tu propio rol admin.");

  await q(\`UPDATE admin_users SET role=$1, updated_at=now() WHERE id=$2\`, [role, id]);
  await audit("ADMIN_USER_ROLE_UPDATED", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: id, role }});
  res.redirect("/admin/users");
});

app.post("/admin/users/:id/secret", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const secret = String(req.body.secret || "");
  if (!secret) return res.status(400).send("Clave obligatoria.");

  const hash = await bcrypt.hash(secret, 12);
  await q(\`UPDATE admin_users SET password_hash=$1, updated_at=now() WHERE id=$2\`, [hash, id]);
  await audit("ADMIN_USER_SECRET_RESET", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: id }});
  res.redirect("/admin/users");
});

app.post("/admin/users/:id/toggle", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.admin.id) return res.status(400).send("No puedes desactivar tu propio usuario.");

  await q(\`UPDATE admin_users SET enabled=NOT COALESCE(enabled,true), updated_at=now() WHERE id=$1\`, [id]);
  await audit("ADMIN_USER_TOGGLED", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: id }});
  res.redirect("/admin/users");
});

app.get("/admin/residentes", requireAdmin, async (req, res) => {
  const search = String(req.query.q || "").trim();
  const params = [];
  let where = "";
  if (search) {
    params.push("%" + search.toLowerCase() + "%");
    where = \`WHERE lower(rr.name) LIKE $1 OR lower(COALESCE(rr.dni,'')) LIKE $1 OR lower(COALESCE(rr.email,'')) LIKE $1 OR lower(COALESCE(rr.phone,'')) LIKE $1 OR lower(u.label) LIKE $1\`;
  }

  const rows = (await q(
    \`SELECT rr.*, u.label AS unit_label
     FROM resident_registry rr
     JOIN units u ON u.id=rr.unit_id
     \${where}
     ORDER BY u.label ASC, rr.name ASC
     LIMIT 500\`,
    params
  )).rows;

  res.render("residents", { admin: req.session.admin, rows, search });
});

app.get("/admin/residentes/new", requireAdmin, async (req, res) => {
  res.render("resident_form", { admin: req.session.admin, resident: null, streets: STREETS });
});

app.post("/admin/residentes/new", requireAdmin, async (req, res) => {
  const { street, number, unit_extra, name, dni, phone, email, status, notes } = req.body;
  if (!street || !STREETS.includes(street) || !number || !name) return res.status(400).send("Calle, número y nombre son obligatorios.");
  const unit = await findOrCreateUnit({ street, number, unit_extra });
  const row = await upsertResidentRegistry({ unit_id: unit.id, name, dni, phone, email, status: status || "ACTIVE", notes });
  await audit("RESIDENT_UPSERTED", { actor_admin_id: req.session.admin.id, unit_id: unit.id, meta_json: { resident_id: row?.id }});
  res.redirect("/admin/residentes");
});

app.get("/admin/residentes/:id/edit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const resident = (await q(
    \`SELECT rr.*, u.label AS unit_label, u.street, u.number, u.unit_extra
     FROM resident_registry rr
     JOIN units u ON u.id=rr.unit_id
     WHERE rr.id=$1\`,
    [id]
  )).rows[0];
  if (!resident) return res.status(404).send("Residente no existe.");
  res.render("resident_form", { admin: req.session.admin, resident, streets: STREETS });
});

app.post("/admin/residentes/:id/edit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { street, number, unit_extra, name, dni, phone, email, status, notes } = req.body;
  if (!street || !STREETS.includes(street) || !number || !name) return res.status(400).send("Calle, número y nombre son obligatorios.");
  const unit = await findOrCreateUnit({ street, number, unit_extra });

  await q(
    \`UPDATE resident_registry
     SET unit_id=$1, name=$2, dni=$3, phone=$4, email=$5, status=$6, notes=$7, updated_at=now()
     WHERE id=$8\`,
    [unit.id, String(name).trim(), cleanText(dni), cleanText(phone), cleanText(email)?.toLowerCase() || null, status || "ACTIVE", cleanText(notes), id]
  );
  await audit("RESIDENT_UPDATED", { actor_admin_id: req.session.admin.id, unit_id: unit.id, meta_json: { resident_id: id }});
  res.redirect("/admin/residentes");
});

app.post("/admin/residentes/importar-campana", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay campaña activa.");

  const rows = (await q(
    \`INSERT INTO registrations(election_id, unit_id, name, dni, phone, email, status)
     SELECT $1, rr.unit_id, rr.name, COALESCE(rr.dni,''), COALESCE(rr.phone,''), COALESCE(rr.email,''), 'PENDING'
     FROM resident_registry rr
     WHERE rr.status='ACTIVE'
       AND NOT EXISTS (
         SELECT 1 FROM registrations r WHERE r.election_id=$1 AND r.unit_id=rr.unit_id
       )
     RETURNING id, unit_id\`,
    [active.id]
  )).rows;

  await audit("RESIDENT_REGISTRY_IMPORTED", { actor_admin_id: req.session.admin.id, election_id: active.id, meta_json: { imported: rows.length }});
  res.redirect("/admin/solicitudes?filter=pending");
});`;

insertBefore(
  'admin users resident routes',
  `/* =========================
   ADMIN: Solicitudes + aprobación (email por defecto)
========================= */`,
  routesBlock
);

fs.writeFileSync(file, s);
console.log(changed ? '[OK] admin/resident routes patch aplicado' : '[OK] patch ya aplicado');
