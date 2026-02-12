import "dotenv/config";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import bcrypt from "bcrypt";
import PDFDocument from "pdfkit";

import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { q, pool } from "./db.js";
import { newToken, hashToken } from "./crypto.js";
import { canMail, sendVoteLink } from "./mailer.js";
import { requireAdmin, requireViewerOrAdmin } from "./middleware.js";

import { createAudit } from "./audit.js";
const auditEvent = createAudit({ q });

const app = express();
app.set("view engine", "ejs");
app.set("views", new URL("./views", import.meta.url).pathname);

// Cloudflare/Nginx proxy
app.set("trust proxy", 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "dev_secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: "auto"
  }
}));

app.use(rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

const STREETS = [
  "Jr. El Visitador",
  "Calle El Pacificado",
  "Calle El Inquisidor"
];

function now() { return new Date(); }

async function audit(event, meta = {}) {
  await q(
    `INSERT INTO audit_log(event, actor_admin_id, unit_id, registration_id, token_id, election_id, meta_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      event,
      meta.actor_admin_id ?? null,
      meta.unit_id ?? null,
      meta.registration_id ?? null,
      meta.token_id ?? null,
      meta.election_id ?? null,
      meta.meta_json ?? {}
    ]
  );
}

async function getActiveElection() {
  const r = await q(`SELECT * FROM elections WHERE is_active=true LIMIT 1`);
  return r.rows[0] || null;
}

function inWindow(n, start, end) {
  const t = n.getTime();
  return t >= new Date(start).getTime() && t <= new Date(end).getTime();
}

function unitLabel(street, number, unit_extra) {
  const extra = unit_extra ? ` - ${unit_extra.trim()}` : "";
  return `${street.trim()} - ${String(number).trim()}${extra}`;
}

async function findOrCreateUnit({ street, number, unit_extra }) {
  const streetN = street.trim();
  const numberN = String(number).trim();
  const extraN = (unit_extra || "").trim() || null;

  const existing = await q(
    `SELECT id, label FROM units WHERE street=$1 AND number=$2 AND (unit_extra IS NOT DISTINCT FROM $3::text) LIMIT 1`,
    [streetN, numberN, extraN]
  );
  if (existing.rows.length) return existing.rows[0];

  const label = unitLabel(streetN, numberN, extraN);
  const created = await q(
    `INSERT INTO units(label, street, number, unit_extra, enabled)
     VALUES ($1,$2,$3,$4,true)
     RETURNING id, label`,
    [label, streetN, numberN, extraN]
  );
  return created.rows[0];
}

function toLimaOffset(dtLocal) {
  // dtLocal = "YYYY-MM-DDTHH:MM" (sin zona)
  // lo guardamos explícito en Lima: "-05:00"
  if (!dtLocal || typeof dtLocal !== "string") return null;
  return dtLocal.replace("T", " ") + ":00-05:00";
}

const UPLOAD_DIR = path.resolve("uploads/plans");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function randName(ext = ".pdf") {
  return crypto.randomBytes(24).toString("hex") + ext;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, randName(".pdf"))
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === "application/pdf";
    cb(ok ? null : new Error("Solo PDF"), ok);
  }
});

async function getCouncilListsWithMembers(electionId) {
  const lists = (await q(
    `SELECT id, name, plan_pdf_path, sort_order
     FROM candidates
     WHERE election_id=$1
     ORDER BY sort_order ASC, id ASC`,
    [electionId]
  )).rows;

  const members = (await q(
    `SELECT slate_id, role, full_name, dni_ce
     FROM slate_members
     WHERE election_id=$1`,
    [electionId]
  )).rows;

  const bySlate = new Map();
  for (const m of members) {
    if (!bySlate.has(m.slate_id)) bySlate.set(m.slate_id, []);
    bySlate.get(m.slate_id).push(m);
  }

  return lists.map(l => ({ ...l, members: bySlate.get(l.id) || [] }));
}

function toDatetimeLocalForInput(dateObj) {
  // Convierte Date -> "YYYY-MM-DDTHH:MM" en hora Lima (forzamos -05)
  const d = new Date(dateObj);
  // truco: formatear a partes en es-PE no da ISO; hacemos manual usando UTC y offset fijo
  // como estamos guardando "-05:00", lo mejor es sacar string con toISOString y ajustar:
  // Para simplicidad en UI: usamos Intl con America/Lima y armamos manual.
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Lima",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
  // sv-SE devuelve "YYYY-MM-DD HH:MM"
  const s = fmt.format(d).replace(" ", "T");
  return s;
}

app.get("/admin/election/edit", requireAdmin, async (req, res) => {
  const election = await getActiveElectionOrLatest(); // ver nota abajo
  if (!election) return res.status(500).send("No hay campañas.");

  const vals = {
    reg_open_at: toDatetimeLocalForInput(election.reg_open_at),
    reg_close_at: toDatetimeLocalForInput(election.reg_close_at),
    vote_open_at: toDatetimeLocalForInput(election.vote_open_at),
    vote_close_at: toDatetimeLocalForInput(election.vote_close_at)
  };

  res.render("admin_election_edit", { admin: req.session.admin, election, vals });
});

app.post("/admin/election/edit", requireAdmin, async (req, res) => {
  const election = await getActiveElectionOrLatest();
  if (!election) return res.status(500).send("No hay campañas.");

  const { title, reg_open_at, reg_close_at, vote_open_at, vote_close_at, is_active } = req.body;

  const regOpen  = toLimaOffset(reg_open_at);
  const regClose = toLimaOffset(reg_close_at);
  const voteOpen = toLimaOffset(vote_open_at);
  const voteClose= toLimaOffset(vote_close_at);

  const activeFlag = is_active === "1";

  // si vas a mantener “solo 1 activa”, apaga las demás al activar esta
  if (activeFlag) {
    await q(`UPDATE elections SET is_active=false WHERE id<>$1`, [election.id]);
  }

  await q(
    `UPDATE elections
     SET title=$1, reg_open_at=$2, reg_close_at=$3, vote_open_at=$4, vote_close_at=$5, is_active=$6
     WHERE id=$7`,
    [title.trim(), regOpen, regClose, voteOpen, voteClose, activeFlag, election.id]
  );

  await audit("ELECTION_UPDATED", { actor_admin_id: req.session.admin.id, election_id: election.id });

  res.redirect("/admin");
});

async function getActiveElectionOrLatest() {
  const a = await getActiveElection();
  if (a) return a;
  return (await q(`SELECT * FROM elections ORDER BY id DESC LIMIT 1`)).rows[0] || null;
}

/* =========================
   LANDING
========================= */
app.get("/", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa configurada.");

  const n = now();
  const regOpen = inWindow(n, election.reg_open_at, election.reg_close_at);
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);

  const metrics = {
    pending_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='PENDING'`, [election.id])).rows[0].n,
    approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [election.id])).rows[0].n,
    votes: (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [election.id])).rows[0].n
  };

  const previous = (await q(
    `SELECT id, title, reg_open_at, reg_close_at, vote_open_at, vote_close_at, is_active, closed_at
     FROM elections
     WHERE is_active=false
     ORDER BY id DESC
     LIMIT 10`
  )).rows;

  res.render("index", { election, regOpen, voteOpen, metrics, previous });
});

/* =========================
   REGISTRO (email obligatorio + ventana)
========================= */
app.get("/registro", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");

  const n = now();
  const regOpen = inWindow(n, election.reg_open_at, election.reg_close_at);

  res.render("register", { election, regOpen, streets: STREETS });
});

app.post("/registro", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");

  const n = now();
  const regOpen = inWindow(n, election.reg_open_at, election.reg_close_at);
  if (!regOpen) return res.status(403).send("Registro cerrado.");

  const { street, number, unit_extra, name, dni, phone, email } = req.body;

  if (!street || !STREETS.includes(street)) return res.status(400).send("Calle inválida.");
  if (!number || !String(number).trim()) return res.status(400).send("Número obligatorio.");
  if (!name || !dni || !phone || !email) return res.status(400).send("Nombre, DNI, teléfono y correo son obligatorios.");

  const unit = await findOrCreateUnit({ street, number, unit_extra });

  const r = await q(
    `INSERT INTO registrations(election_id, unit_id, name, dni, phone, email)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, unit_id`,
    [election.id, unit.id, name.trim(), dni.trim(), phone.trim(), email.trim().toLowerCase()]
  );

  await audit("REGISTRATION_CREATED", {
    election_id: election.id,
    registration_id: r.rows[0].id,
    unit_id: unit.id,
    meta_json: { email: email.trim().toLowerCase(), phone: phone.trim() }
  });

  res.render("register_done", { election });
});

/* =========================
   VOTAR (ventana + token 1 uso)
========================= */
app.get("/votar/:token", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");

  const tokenHash = hashToken(req.params.token);

  const t = await q(
    `SELECT vt.*, r.name AS registrant_name
     FROM vote_tokens vt
     JOIN registrations r ON r.id = vt.registration_id
     WHERE vt.token_hash=$1 AND vt.election_id=$2`,
    [tokenHash, election.id]
  );
  if (!t.rows.length) return res.status(404).send("Enlace inválido.");
  const vt = t.rows[0];

  // si token ya USED, mostramos igual info + "ya usado"
  const councilLists = await getCouncilListsWithMembers(election.id);
  const fiscalLists = (await q(
    `SELECT id, name, titular_name, titular_dni, suplente_name, suplente_dni
     FROM fiscal_lists
     WHERE election_id=$1
     ORDER BY sort_order ASC, id ASC`,
    [election.id]
  )).rows;

  const n = now();
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);

  // si no está abierta, render preview con countdown e info
  if (!voteOpen) {
    return res.render("vote_preview", {
      election,
      token: req.params.token,
      councilLists,
      fiscalLists
    });
  }

  // Estado por unidad: ya votó directiva / fiscales?
  const hasCouncil = (await q(
    `SELECT 1 FROM votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`,
    [election.id, vt.unit_id]
  )).rows.length > 0;

  const hasFiscal = (await q(
    `SELECT 1 FROM fiscal_votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`,
    [election.id, vt.unit_id]
  )).rows.length > 0;

  if (hasCouncil && hasFiscal) {
    // si quedó ACTIVE por alguna razón, lo cerramos
    if (vt.status === "ACTIVE") {
      await q(`UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1`, [vt.id]);
    }
    return res.render("vote_used", { election });
  }

  if (!hasCouncil) {
    return res.render("vote_council", { election, token: req.params.token, councilLists });
  }

  // ya votó directiva, falta fiscales
  return res.render("vote_fiscal", { election, token: req.params.token, fiscalLists });
});


app.post("/votar/:token", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");

  const n = now();
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);
  if (!voteOpen) return res.render("closed", { election });

  const { candidate_id } = req.body;
  if (!candidate_id) return res.status(400).send("Elige una lista.");

  const tokenHash = hashToken(req.params.token);

  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const t = await c.query(
      `SELECT * FROM vote_tokens WHERE token_hash=$1 AND election_id=$2 FOR UPDATE`,
      [tokenHash, election.id]
    );
    if (!t.rows.length) { await c.query("ROLLBACK"); return res.status(404).send("Enlace inválido."); }

    const vt = t.rows[0];
    if (vt.status !== "ACTIVE") { await c.query("ROLLBACK"); return res.render("vote_used", { election }); }

    await c.query(
      `INSERT INTO votes(election_id, unit_id, candidate_id, token_id, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [election.id, vt.unit_id, Number(candidate_id), vt.id, req.ip, req.headers["user-agent"] || ""]
    );

//    await c.query(
//      `UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1`,
//      [vt.id]
//    );

    await c.query("COMMIT");

    await audit("VOTE_CAST", {
      election_id: election.id,
      unit_id: vt.unit_id,
      token_id: vt.id,
      meta_json: { candidate_id: Number(candidate_id) }
    });

    return res.redirect(`/votar/${req.params.token}`);
    //res.render("vote_done", { election });
  } catch (e) {
    await c.query("ROLLBACK");
    if (String(e?.code) === "23505") return res.render("vote_used", { election });
    console.error(e);
    res.status(500).send("Error registrando voto.");
  } finally {
    c.release();
  }
});

/* =========================
   RESULTADOS PÚBLICOS (histórico)
========================= */
app.get("/resultados", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");
  return res.redirect(`/resultados/${election.id}`);
});

app.get("/resultados/:electionId", async (req, res) => {
  const electionId = Number(req.params.electionId);
  const election = (await q(`SELECT * FROM elections WHERE id=$1`, [electionId])).rows[0];
  if (!election) return res.status(404).send("Elección no existe.");

  const totals = (await q(
    `SELECT c.name, c.list_code, COUNT(v.id)::int AS votes
     FROM candidates c
     LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
     WHERE c.election_id=$1
     GROUP BY c.id
     ORDER BY c.sort_order ASC`,
    [electionId]
  )).rows;

  const metrics = {
    votes: (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [electionId])).rows[0].n,
    approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [electionId])).rows[0].n
  };

  res.render("public_results", { election, totals, metrics });
});

/* =========================
   ADMIN: LOGIN
========================= */
app.get("/admin/login", (req, res) => res.render("admin_login", { error: null }));

app.post("/admin/login", async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");

  const u = await q(`SELECT * FROM admin_users WHERE email=$1`, [email]);
  if (!u.rows.length) return res.render("admin_login", { error: "Credenciales inválidas." });

  const user = u.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render("admin_login", { error: "Credenciales inválidas." });

  req.session.admin = { id: user.id, email: user.email, role: user.role };
  await audit("ADMIN_LOGIN", { actor_admin_id: user.id });
  res.redirect("/admin");
});

app.post("/admin/logout", requireViewerOrAdmin, async (req, res) => {
  await audit("ADMIN_LOGOUT", { actor_admin_id: req.session.admin.id });
  req.session.destroy(() => res.redirect("/admin/login"));
});

/* =========================
   ADMIN: DASHBOARD + campañas
========================= */
app.get("/admin", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  const elections = (await q(`SELECT * FROM elections ORDER BY id DESC LIMIT 30`)).rows;

  const stats = active ? {
    pending_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='PENDING'`, [active.id])).rows[0].n,
    approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [active.id])).rows[0].n,
    votes: (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [active.id])).rows[0].n
  } : null;

  res.render("admin_dashboard", { admin: req.session.admin, active, elections, stats, canMail: canMail() });
});

app.get("/admin/elections/new", requireAdmin, async (req, res) => {
  res.render("admin_election_new", { admin: req.session.admin });
});

app.post("/admin/elections/new", requireAdmin, async (req, res) => {
  const { title, reg_open_at, reg_close_at, vote_open_at, vote_close_at } = req.body;
  if (!title || !reg_open_at || !reg_close_at || !vote_open_at || !vote_close_at) {
    return res.status(400).send("Completa todos los campos.");
  }
  const regOpen  = toLimaOffset(reg_open_at);
  const regClose = toLimaOffset(reg_close_at);
  const voteOpen = toLimaOffset(vote_open_at);
  const voteClose= toLimaOffset(vote_close_at);

  if (!regOpen || !regClose || !voteOpen || !voteClose) {
    return res.status(400).send("Completa todas las fechas.");
  }


  const e = (await q(
    `INSERT INTO elections(title, reg_open_at, reg_close_at, vote_open_at, vote_close_at, is_active)
     VALUES ($1,$2,$3,$4,$5,false)
     RETURNING id`,
    [title.trim(), regOpen, regClose, voteOpen, voteClose]
  )).rows[0];

  // crea candidatos para esa elección (2 listas)
  await q(
    `INSERT INTO candidates(election_id, name, list_code, sort_order)
     VALUES ($1,'Lista 1','LISTA_1',1), ($1,'Lista 2','LISTA_2',2)`,
    [e.id]
  );

  await audit("ELECTION_CREATED", { actor_admin_id: req.session.admin.id, election_id: e.id });

  res.redirect("/admin");
});

app.post("/admin/elections/:id/activate", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  await q(`UPDATE elections SET is_active=false WHERE is_active=true`);
  await q(`UPDATE elections SET is_active=true WHERE id=$1`, [id]);

  await audit("ELECTION_ACTIVATED", { actor_admin_id: req.session.admin.id, election_id: id });
  res.redirect("/admin");
});

app.post("/admin/elections/:id/close", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await q(`UPDATE elections SET is_active=false, closed_at=NOW() WHERE id=$1`, [id]);
  await audit("ELECTION_CLOSED", { actor_admin_id: req.session.admin.id, election_id: id });
  res.redirect("/admin");
});

/* =========================
   ADMIN: Solicitudes + aprobación (email por defecto)
========================= */
app.get("/admin/solicitudes", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay elección activa.");

  const filter = String(req.query.filter || "pending").toLowerCase();
  let where = "";
  let params = [active.id];

  if (filter === "pending") where = "AND r.status='PENDING'";
  if (filter === "approved") where = "AND r.status='APPROVED'";
  if (filter === "rejected") where = "AND r.status='REJECTED'";
  if (filter === "all") where = "";

  const rows = (await q(
    `SELECT r.*, u.label AS unit_label
     FROM registrations r
     JOIN units u ON u.id = r.unit_id
     WHERE r.election_id=$1 ${where}
     ORDER BY r.created_at DESC`,
    params
  )).rows;

  res.render("admin_requests", { admin: req.session.admin, election: active, rows, filter });
});

app.get("/admin/solicitudes/:id", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay elección activa.");

  const id = Number(req.params.id);
  const r = (await q(
    `SELECT r.*, u.label AS unit_label, u.street, u.number, u.unit_extra
     FROM registrations r JOIN units u ON u.id=r.unit_id
     WHERE r.id=$1 AND r.election_id=$2`,
    [id, active.id]
  )).rows[0];

  if (!r) return res.status(404).send("No existe.");

  const tokenRow = (await q(
    `SELECT id, status, issued_at, used_at
     FROM vote_tokens
     WHERE registration_id=$1 AND election_id=$2
     ORDER BY id DESC LIMIT 1`,
    [id, active.id]
  )).rows[0] || null;

  res.render("admin_request_detail", {
    admin: req.session.admin,
    election: active,
    r,
    tokenRow,
    baseUrl: process.env.BASE_URL
  });
});

app.post("/admin/solicitudes/:id/aprobar", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay elección activa.");

  const id = Number(req.params.id);

  const rr = await q(
    `UPDATE registrations
     SET status='APPROVED', reviewed_at=NOW(), reviewed_by=$2
     WHERE id=$1 AND election_id=$3 AND status='PENDING'
     RETURNING id, unit_id, email`,
    [id, req.session.admin.id, active.id]
  );

  if (!rr.rows.length) return res.redirect(`/admin/solicitudes/${id}`);

  const { unit_id, email } = rr.rows[0];

  // revoca tokens activos previos de la unidad
  await q(`UPDATE vote_tokens SET status='REVOKED' WHERE election_id=$1 AND unit_id=$2 AND status='ACTIVE'`, [active.id, unit_id]);

  const token = newToken();
  const tokenHash = hashToken(token);

  const tr = await q(
    `INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, issued_via)
     VALUES ($1,$2,$3,$4,'EMAIL')
     RETURNING id`,
    [active.id, id, unit_id, tokenHash]
  );

  const tokenId = tr.rows[0].id;
  const link = `${process.env.BASE_URL}/votar/${token}`;

  await audit("REGISTRATION_APPROVED_TOKEN_ISSUED", {
    actor_admin_id: req.session.admin.id,
    election_id: active.id,
    registration_id: id,
    unit_id,
    token_id: tokenId,
    meta_json: { issued_via: "EMAIL" }
  });

  // Siempre intentamos enviar por correo
  try {
    const sent = await sendVoteLink({ to: email, link });
    await audit("TOKEN_EMAIL_SENT", {
      actor_admin_id: req.session.admin.id,
      election_id: active.id,
      registration_id: id,
      unit_id,
      token_id: tokenId,
      meta_json: { sent }
    });
  } catch (e) {
    await audit("TOKEN_EMAIL_FAILED", {
      actor_admin_id: req.session.admin.id,
      election_id: active.id,
      registration_id: id,
      unit_id,
      token_id: tokenId,
      meta_json: { error: String(e?.message || e) }
    });
  }

  // Mostrar link para respaldo (si email falla o el vecino lo pide)
  res.render("admin_link_issued", { admin: req.session.admin, election: active, link, registrationId: id });
});

app.post("/admin/solicitudes/:id/reemitir", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay elección activa.");

  const id = Number(req.params.id);

  const reg = (await q(
    `SELECT id, unit_id, email FROM registrations WHERE id=$1 AND election_id=$2 AND status='APPROVED'`,
    [id, active.id]
  )).rows[0];

  if (!reg) return res.status(400).send("Solo se reemite si está aprobado.");

  await q(`UPDATE vote_tokens SET status='REVOKED' WHERE election_id=$1 AND unit_id=$2 AND status='ACTIVE'`, [active.id, reg.unit_id]);

  const token = newToken();
  const tokenHash = hashToken(token);
  const tr = (await q(
    `INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, issued_via)
     VALUES ($1,$2,$3,$4,'EMAIL')
     RETURNING id`,
    [active.id, reg.id, reg.unit_id, tokenHash]
  )).rows[0];

  const link = `${process.env.BASE_URL}/votar/${token}`;

  await audit("TOKEN_REISSUED", {
    actor_admin_id: req.session.admin.id,
    election_id: active.id,
    registration_id: reg.id,
    unit_id: reg.unit_id,
    token_id: tr.id
  });

  try {
    const sent = await sendVoteLink({ to: reg.email, link });
    await audit("TOKEN_EMAIL_SENT", {
      actor_admin_id: req.session.admin.id,
      election_id: active.id,
      registration_id: reg.id,
      unit_id: reg.unit_id,
      token_id: tr.id,
      meta_json: { sent, reissue: true }
    });
  } catch (e) {
    await audit("TOKEN_EMAIL_FAILED", {
      actor_admin_id: req.session.admin.id,
      election_id: active.id,
      registration_id: reg.id,
      unit_id: reg.unit_id,
      token_id: tr.id,
      meta_json: { error: String(e?.message || e), reissue: true }
    });
  }

  res.render("admin_link_issued", { admin: req.session.admin, election: active, link, registrationId: reg.id });
});

app.post("/admin/solicitudes/:id/rechazar", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay elección activa.");

  const id = Number(req.params.id);
  const notes = String(req.body.notes || "").trim() || null;

  const rr = await q(
    `UPDATE registrations
     SET status='REJECTED', reviewed_at=NOW(), reviewed_by=$2, notes=$3
     WHERE id=$1 AND election_id=$4 AND status='PENDING'
     RETURNING id, unit_id`,
    [id, req.session.admin.id, notes, active.id]
  );

  if (rr.rows.length) {
    await audit("REGISTRATION_REJECTED", {
      actor_admin_id: req.session.admin.id,
      election_id: active.id,
      registration_id: id,
      unit_id: rr.rows[0].unit_id,
      meta_json: { notes }
    });
  }

  res.redirect(`/admin/solicitudes/${id}`);
});

/* =========================
   ADMIN: Resultados + exports
========================= */
app.get("/admin/resultados", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay elección activa.");

  const totals = (await q(
    `SELECT c.name, c.list_code, COUNT(v.id)::int AS votes
     FROM candidates c
     LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
     WHERE c.election_id=$1
     GROUP BY c.id
     ORDER BY c.sort_order ASC`,
    [active.id]
  )).rows;

  const metrics = {
    votes: (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [active.id])).rows[0].n,
    pending_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='PENDING'`, [active.id])).rows[0].n,
    approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [active.id])).rows[0].n
  };

  res.render("admin_result", { admin: req.session.admin, election: active, totals, metrics });
});

function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = String(v ?? "");
    if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  return [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\n");
}

app.get("/admin/export/resultados.csv", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  const rows = (await q(
    `SELECT c.name AS lista, COUNT(v.id)::int AS votos
     FROM candidates c
     LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
     WHERE c.election_id=$1
     GROUP BY c.id
     ORDER BY c.sort_order ASC`,
    [active.id]
  )).rows;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="resultados_election_${active.id}.csv"`);
  res.send(toCSV(rows));
});

app.get("/admin/export/padron_estado.csv", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  const rows = (await q(
  `SELECT
     u.label AS unidad,
     r.status::text AS registro_estado,
     r.name AS representante,
     r.dni,
     r.email,
     r.phone,
     COALESCE(vt.status::text, '-') AS token_estado,
     COALESCE(vt.issued_at::text, '-') AS token_emitido,
     COALESCE(vt.used_at::text, '-') AS token_usado
   FROM registrations r
   JOIN units u ON u.id=r.unit_id
   LEFT JOIN LATERAL (
     SELECT * FROM vote_tokens
     WHERE election_id=$1 AND registration_id=r.id
     ORDER BY id DESC LIMIT 1
   ) vt ON true
   WHERE r.election_id=$1
   ORDER BY u.label ASC`,
  [active.id]
)).rows;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="padron_estado_election_${active.id}.csv"`);
  res.send(toCSV(rows));
});

app.get("/admin/export/auditoria.csv", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  const rows = (await q(
    `SELECT created_at, event, actor_admin_id, unit_id, registration_id, token_id, meta_json
     FROM audit_log
     WHERE election_id=$1
     ORDER BY created_at ASC`,
    [active.id]
  )).rows;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="auditoria_election_${active.id}.csv"`);
  res.send(toCSV(rows));
});

/* =========================
   ADMIN: vista impresión
========================= */
app.get("/admin/print/padron", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  const rows = (await q(
  `SELECT
     u.label AS unidad,
     r.status::text AS registro_estado,
     COALESCE(vt.status::text, '-') AS token_estado,
     CASE WHEN v.id IS NULL THEN 'NO' ELSE 'SI' END AS voto_emitido
   FROM registrations r
   JOIN units u ON u.id=r.unit_id
   LEFT JOIN LATERAL (
     SELECT * FROM vote_tokens
     WHERE election_id=$1 AND registration_id=r.id
     ORDER BY id DESC LIMIT 1
   ) vt ON true
   LEFT JOIN votes v ON v.election_id=$1 AND v.unit_id=u.id
   WHERE r.election_id=$1
   ORDER BY u.label ASC`,
  [active.id]
)).rows;

  res.render("admin_print_padron", { election: active, rows });
});

/* =========================
   ADMIN: ACTA PDF
========================= */
app.get("/admin/acta.pdf", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();

  const totals = (await q(
    `SELECT c.name, COUNT(v.id)::int AS votes
     FROM candidates c
     LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
     WHERE c.election_id=$1
     GROUP BY c.id
     ORDER BY c.sort_order ASC`,
    [active.id]
  )).rows;

  const metrics = {
    votes: (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [active.id])).rows[0].n,
    approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [active.id])).rows[0].n,
    pending_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='PENDING'`, [active.id])).rows[0].n
  };

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="acta_election_${active.id}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(16).text("ACTA DE VOTACIÓN DIGITAL", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Elección: ${active.title}`);
  doc.text(`Fecha/Hora generación: ${new Date().toLocaleString("es-PE")}`);
  doc.moveDown();

  doc.fontSize(12).text("Ventanas del proceso (hora Lima):");
  doc.fontSize(11).text(`Registro: ${new Date(active.reg_open_at).toLocaleString("es-PE")}  →  ${new Date(active.reg_close_at).toLocaleString("es-PE")}`);
  doc.fontSize(11).text(`Votación: ${new Date(active.vote_open_at).toLocaleString("es-PE")}  →  ${new Date(active.vote_close_at).toLocaleString("es-PE")}`);
  doc.moveDown();

  doc.fontSize(12).text("Resultados (votación digital):");
  doc.moveDown(0.5);
  totals.forEach(t => doc.fontSize(11).text(`• ${t.name}: ${t.votes} votos`));
  doc.moveDown();

  doc.fontSize(12).text("Métricas:");
  doc.fontSize(11).text(`• Registros aprobados: ${metrics.approved_regs}`);
  doc.fontSize(11).text(`• Registros pendientes: ${metrics.pending_regs}`);
  doc.fontSize(11).text(`• Votos digitales emitidos: ${metrics.votes}`);
  doc.moveDown(2);

  doc.fontSize(12).text("Firmas:", { underline: true });
  doc.moveDown(2);
  doc.text("______________________________      ______________________________");
  doc.text("Presidente(a) Comité Electoral            Fiscal / Veedor");
  doc.moveDown(1.5);
  doc.text("______________________________      ______________________________");
  doc.text("Miembro Comité Electoral                  Miembro Comité Electoral");

  doc.end();

  await audit("ACTA_PDF_GENERATED", { actor_admin_id: req.session.admin.id, election_id: active.id });
});

app.get("/admin/padron_v2.pdf", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay elección activa.");

  const rows = (await q(
    `SELECT u.label AS unidad, r.name AS representante
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     WHERE r.election_id=$1 AND r.status='APPROVED'
     ORDER BY u.label ASC`,
    [active.id]
  )).rows;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="padron_${active.id}_${Date.now()}.pdf"`
  );

  const doc = new PDFDocument({ margin: 40 }); // Portrait
  doc.pipe(res);

  // -------- Header --------
  doc.fontSize(15).text("PADRÓN HABILITADOS PARA VOTO ELECTRÓNICO", { align: "center" });
  doc.moveDown(0.4);

  doc.fontSize(11).text(`Elección: ${active.title}`);
  doc.text(`Generado: ${new Date().toLocaleString("es-PE", { timeZone: "America/Lima" })}`);
  doc.moveDown(0.8);

  doc.fontSize(11).text("Criterio: Habilitados = registros APROBADOS por el Comité Electoral.");
  doc.moveDown(1);

  // -------- Tabla --------
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;

  const col = {
    unidadX: pageLeft,
    unidadW: 260,
    repX: pageLeft + 270,
    repW: pageRight - (pageLeft + 270)
  };

  function drawHeader(y) {
    doc.fontSize(10);
    doc.text("Unidad", col.unidadX, y, { width: col.unidadW });
    doc.text("Representante", col.repX, y, { width: col.repW });

    const lineY = y + 16;
    doc.moveTo(pageLeft, lineY).lineTo(pageRight, lineY).stroke();

    return lineY + 8;
  }

  function rowHeightFor(r) {
    doc.fontSize(9);
    const h1 = doc.heightOfString(r.unidad ?? "", { width: col.unidadW });
    const h2 = doc.heightOfString(r.representante ?? "", { width: col.repW });
    return Math.max(h1, h2, 12) + 6;
  }

  let y = drawHeader(doc.y);

  for (const r of rows) {
    const rowH = rowHeightFor(r);

    // reserva espacio para total + firmas al final (por eso -170)
    if (y + rowH > doc.page.height - 170) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }

    doc.fontSize(9);
    doc.text(r.unidad ?? "", col.unidadX, y, { width: col.unidadW });
    doc.text(r.representante ?? "", col.repX, y, { width: col.repW });

    doc
      .moveTo(pageLeft, y + rowH - 2)
      .lineTo(pageRight, y + rowH - 2)
      .strokeOpacity(0.2)
      .stroke()
      .strokeOpacity(1);

    y += rowH;
  }

  // posiciona cursor debajo de la tabla
  doc.y = y + 18;

  // -------- Total --------
  doc.moveDown(0.6);
  doc.fontSize(11).text(`Total de habilitados: ${rows.length}`, { align: "right" });
  doc.moveDown(1.2);

  // -------- Firmas (sin título) --------
  function ensureSpace(needed) {
    if (doc.y + needed > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
  }

  ensureSpace(210);

  const gap = 24;
  const signColW = (pageRight - pageLeft - gap) / 2;
  const x1 = pageLeft;
  const x2 = pageLeft + signColW + gap;
  let sy = doc.y;

  function signLine(x, y, label) {
    doc.fontSize(10).text("______________________________", x, y, { width: signColW });
    doc.fontSize(9).text(label, x, y + 14, { width: signColW });
  }

  // Fila 1
  signLine(x1, sy, "Presidente(a) Comité Electoral");
  signLine(x2, sy, "Miembro Comité Electoral");

  // Fila 2
  sy += 46;
  signLine(x1, sy, "Miembro Comité Electoral");
  signLine(x2, sy, "Fiscal");

  // Fila 3
  sy += 46;
  signLine(x1, sy, "Personero(a) 1");
  signLine(x2, sy, "Personero(a) 2");

  // -------- Sello digital (footer) --------
  doc.fontSize(8)
    .fillColor("gray")
    .text(
      "Sistema de votación URBISOL 1.0",
      0,
      doc.page.height - 30,
      { align: "center" }
    );

  doc.fillColor("black");

  doc.end();

  await audit("PADRON_PDF_GENERATED", {
    actor_admin_id: req.session.admin.id,
    election_id: active.id
  });
});

app.get("/plan/:filename", async (req, res) => {
  const fn = String(req.params.filename || "");
  if (!/^[a-f0-9]{48}\.pdf$/.test(fn)) return res.status(404).send("No encontrado.");

  const full = path.join(UPLOAD_DIR, fn);
  if (!fs.existsSync(full)) return res.status(404).send("No encontrado.");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(full);
});

app.get("/admin/directiva", requireViewerOrAdmin, async (req, res) => {
  const election = await getActiveElection();
  const lists = (await q(
    `SELECT id, name, plan_pdf_path, sort_order
     FROM candidates
     WHERE election_id=$1
     ORDER BY sort_order ASC, id ASC`,
    [election.id]
  )).rows;

  res.render("admin_directiva_list", { admin: req.session.admin, election, lists });
});

app.get("/admin/directiva/new", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  res.render("admin_directiva_edit", {
    admin: req.session.admin,
    election,
    mode: "new",
    list: null,
    members: []
  });
});

app.post("/admin/directiva/new", requireAdmin, upload.single("plan_pdf"), async (req, res) => {
  const election = await getActiveElection();
  const { name, sort_order } = req.body;

  if (!name) return res.status(400).send("Nombre obligatorio.");

  const planPath = req.file ? `/plan/${req.file.filename}` : null;

  const created = (await q(
    `INSERT INTO candidates(election_id, name, list_code, sort_order, plan_pdf_path)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [election.id, name.trim(), "SLATE_" + crypto.randomBytes(6).toString("hex"), Number(sort_order || 0), planPath]
  )).rows[0];

  // roles fijos
  const roles = ["Presidente", "Vicepresidente", "Secretario", "Tesorero", "Personero"];
  for (const role of roles) {
    const full = String(req.body[`role_${role}_name`] || "").trim();
    const dni = String(req.body[`role_${role}_dni`] || "").trim() || null;
    if (!full) {
      if (role === "Personero") continue; // opcional
      return res.status(400).send(`Falta ${role}.`);
    }
    await q(
      `INSERT INTO slate_members(election_id, slate_id, role, full_name, dni_ce)
       VALUES ($1,$2,$3,$4,$5)`,
      [election.id, created.id, role, full, dni]
    );
  }

  await audit("DIRECTIVA_LIST_CREATED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { slate_id: created.id }});
  res.redirect("/admin/directiva");
});

app.get("/admin/directiva/:id/edit", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  const id = Number(req.params.id);

  const list = (await q(
    `SELECT id, name, plan_pdf_path, sort_order
     FROM candidates
     WHERE id=$1 AND election_id=$2`,
    [id, election.id]
  )).rows[0];

  if (!list) return res.status(404).send("No existe.");

  const members = (await q(
    `SELECT role, full_name, dni_ce
     FROM slate_members
     WHERE election_id=$1 AND slate_id=$2
     ORDER BY id ASC`,
    [election.id, id]
  )).rows;

  res.render("admin_directiva_edit", { admin: req.session.admin, election, mode: "edit", list, members });
});

app.post("/admin/directiva/:id/edit", requireAdmin, upload.single("plan_pdf"), async (req, res) => {
  const election = await getActiveElection();
  const id = Number(req.params.id);

  const { name, sort_order, remove_pdf } = req.body;
  if (!name) return res.status(400).send("Nombre obligatorio.");

  let planPath = null;
  if (req.file) planPath = `/plan/${req.file.filename}`;

  const current = (await q(
    `SELECT plan_pdf_path FROM candidates WHERE id=$1 AND election_id=$2`,
    [id, election.id]
  )).rows[0];
  if (!current) return res.status(404).send("No existe.");

  let newPlan = current.plan_pdf_path;
  if (remove_pdf === "1") newPlan = null;
  if (planPath) newPlan = planPath;

  await q(
    `UPDATE candidates
     SET name=$1, sort_order=$2, plan_pdf_path=$3
     WHERE id=$4 AND election_id=$5`,
    [name.trim(), Number(sort_order || 0), newPlan, id, election.id]
  );

  // reescribe miembros (simple y robusto)
  await q(`DELETE FROM slate_members WHERE election_id=$1 AND slate_id=$2`, [election.id, id]);

  const roles = ["Presidente", "Vicepresidente", "Secretario", "Tesorero", "Personero"];
  for (const role of roles) {
    const full = String(req.body[`role_${role}_name`] || "").trim();
    const dni = String(req.body[`role_${role}_dni`] || "").trim() || null;
    if (!full) {
      if (role === "Personero") continue;
      return res.status(400).send(`Falta ${role}.`);
    }
    await q(
      `INSERT INTO slate_members(election_id, slate_id, role, full_name, dni_ce)
       VALUES ($1,$2,$3,$4,$5)`,
      [election.id, id, role, full, dni]
    );
  }

  await audit("DIRECTIVA_LIST_UPDATED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { slate_id: id }});
  res.redirect("/admin/directiva");
});

app.post("/admin/directiva/:id/delete", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  const id = Number(req.params.id);
  await q(`DELETE FROM candidates WHERE id=$1 AND election_id=$2`, [id, election.id]);
  await audit("DIRECTIVA_LIST_DELETED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { slate_id: id }});
  res.redirect("/admin/directiva");
});

app.get("/admin/fiscales", requireViewerOrAdmin, async (req, res) => {
  const election = await getActiveElection();
  const lists = (await q(
    `SELECT * FROM fiscal_lists WHERE election_id=$1 ORDER BY sort_order ASC, id ASC`,
    [election.id]
  )).rows;

  res.render("admin_fiscales_list", { admin: req.session.admin, election, lists });
});

app.get("/admin/fiscales/new", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  res.render("admin_fiscales_edit", { admin: req.session.admin, election, mode: "new", item: null });
});

app.post("/admin/fiscales/new", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  const { name, sort_order, titular_name, titular_dni, suplente_name, suplente_dni } = req.body;
  const code = "FISC_" + crypto.randomBytes(6).toString("hex");

  if (!name || !titular_name || !suplente_name) return res.status(400).send("Completa nombre y titulares/suplentes.");

  await q(
     `INSERT INTO fiscal_lists(election_id, name, code, sort_order, titular_name, titular_dni, suplente_name, suplente_dni)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
     [election.id, name.trim(), code, Number(sort_order||0), titular_name.trim(), (titular_dni||"").trim()||null, suplente_name.trim(), (suplente_dni||"").trim()||null]
  );

  await audit("FISCAL_LIST_CREATED", { actor_admin_id: req.session.admin.id, election_id: election.id });
  res.redirect("/admin/fiscales");
});

app.get("/admin/fiscales/:id/edit", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  const id = Number(req.params.id);

  const item = (await q(
    `SELECT * FROM fiscal_lists WHERE id=$1 AND election_id=$2`,
    [id, election.id]
  )).rows[0];

  if (!item) return res.status(404).send("No existe.");
  res.render("admin_fiscales_edit", { admin: req.session.admin, election, mode: "edit", item });
});

app.post("/admin/fiscales/:id/edit", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  const id = Number(req.params.id);
  const { name, sort_order, titular_name, titular_dni, suplente_name, suplente_dni } = req.body;
  if (!name || !titular_name || !suplente_name) return res.status(400).send("Completa nombre y titulares/suplentes.");

  await q(
    `UPDATE fiscal_lists
     SET name=$1, sort_order=$2, titular_name=$3, titular_dni=$4, suplente_name=$5, suplente_dni=$6
     WHERE id=$7 AND election_id=$8`,
    [name.trim(), Number(sort_order||0), titular_name.trim(), (titular_dni||"").trim()||null, suplente_name.trim(), (suplente_dni||"").trim()||null, id, election.id]
  );

  await audit("FISCAL_LIST_UPDATED", { actor_admin_id: req.session.admin.id, election_id: election.id });
  res.redirect("/admin/fiscales");
});

app.post("/admin/fiscales/:id/delete", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  const id = Number(req.params.id);
  await q(`DELETE FROM fiscal_lists WHERE id=$1 AND election_id=$2`, [id, election.id]);
  await audit("FISCAL_LIST_DELETED", { actor_admin_id: req.session.admin.id, election_id: election.id });
  res.redirect("/admin/fiscales");
});

app.post("/votar/:token/fiscales", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");

  const n = now();
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);
  if (!voteOpen) return res.render("vote_preview", { election });

  const { fiscal_list_id } = req.body;
  if (!fiscal_list_id) return res.status(400).send("Elige una lista de fiscales.");

  const tokenHash = hashToken(req.params.token);

  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const t = await c.query(
      `SELECT * FROM vote_tokens WHERE token_hash=$1 AND election_id=$2 FOR UPDATE`,
      [tokenHash, election.id]
    );
    if (!t.rows.length) { await c.query("ROLLBACK"); return res.status(404).send("Enlace inválido."); }

    const vt = t.rows[0];
    if (vt.status !== "ACTIVE") { await c.query("ROLLBACK"); return res.render("vote_used", { election }); }

    // inserta voto fiscal (si ya votó fiscal, unique index lo evita)
    await c.query(
      `INSERT INTO fiscal_votes(election_id, unit_id, fiscal_list_id, token_id, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [election.id, vt.unit_id, Number(fiscal_list_id), vt.id, req.ip, req.headers["user-agent"] || ""]
    );

    // si ya existe voto de directiva, ahora sí cerramos token
    const hasCouncil = await c.query(
      `SELECT 1 FROM votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`,
      [election.id, vt.unit_id]
    );

    if (hasCouncil.rows.length) {
      await c.query(
        `UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1`,
        [vt.id]
      );
    }

    await c.query("COMMIT");

    await audit("FISCAL_VOTE_CAST", { election_id: election.id, unit_id: vt.unit_id, token_id: vt.id, meta_json: { fiscal_list_id: Number(fiscal_list_id) }});

    // si por algún caso raro no hay voto directiva, lo mandamos a completar
    if (!hasCouncil.rows.length) return res.redirect(`/votar/${req.params.token}`);

    return res.render("vote_done", { election });

  } catch (e) {
    await c.query("ROLLBACK");
    if (String(e?.code) === "23505") return res.redirect(`/votar/${req.params.token}`); // ya votó fiscal o ya completó
    console.error(e);
    return res.status(500).send("Error registrando voto fiscal.");
  } finally {
    c.release();
  }
});

/* =========================
   START
========================= */
app.listen(Number(process.env.PORT || 3000), () => {
  console.log(`Running on :${process.env.PORT || 3000}`);
});
