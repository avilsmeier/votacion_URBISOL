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
import { canMail, sendVoteLink, sendAdminInvite, sendRegistrationReceived, sendRegistrationRejected, sendVoteReceipt, sendElectionSealed, sendVotePendingReminder } from "./mailer.js";
import { requireAdmin, requireFiscalOrAdmin, requireViewerOrAdmin } from "./middleware.js";
import { createActaPdfHandler } from "./actaPdf.js";
import { createAudit } from "./audit.js";
const auditEvent = createAudit({ q });

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET_REQUIRED_PRODUCTION");
}

const app = express();
app.set("view engine", "ejs");
app.set("views", new URL("./views", import.meta.url).pathname);

// SHA256 hex
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// IP real (Cloudflare + proxies)
function getReqIp(req) {
  const raw =
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.ip ||
    "";
  return String(raw).split(",")[0].trim() || null;
}

function getUserAgent(req) {
  return String(req.headers["user-agent"] || "") || null;
}

// Ejecuta una función dentro de una transacción
async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Lock transaccional por campaña + tipo.
 * Usamos advisory locks: no requieren filas “lockeables”
 * y funcionan perfecto para serializar inserts.
 */
async function lockElectionChain(client, electionId, kind /* 'COUNCIL'|'FISCAL'|'REFERENDUM' */) {
  const ns = kind === "FISCAL" ? 2 : (kind === "REFERENDUM" ? 3 : 1);
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [ns, electionId]);
}

async function insertCouncilVoteChained(client, {
  election_id,
  unit_id,
  candidate_id,
  token_id,
  ip,
  user_agent
}) {
  await lockElectionChain(client, election_id, "COUNCIL");

  // último bloque de la cadena (por campaña)
  const last = (await client.query(
    `SELECT chain_position, vote_hash
     FROM votes
     WHERE election_id=$1
     ORDER BY chain_position DESC NULLS LAST, cast_at DESC, id DESC
     LIMIT 1`,
    [election_id]
  )).rows[0];

  const nextPos = Number(last?.chain_position ?? 0) + 1;
  const previous_hash = last?.vote_hash ?? "GENESIS";

  // fijamos cast_at desde DB (misma fuente de tiempo)
  const cast_at = (await client.query("SELECT now() AS t")).rows[0].t;

  const payload = {
    election_id,
    unit_id,
    candidate_id,
    token_id,
    cast_at,
    previous_hash,
    chain_position: nextPos
  };

  const vote_hash = sha256Hex(JSON.stringify(payload));

  const ins = await client.query(
    `INSERT INTO votes (
       unit_id, candidate_id, token_id, cast_at, ip, user_agent, election_id,
       chain_position, previous_hash, vote_hash
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      unit_id, candidate_id, token_id, cast_at, ip, user_agent, election_id,
      nextPos, previous_hash, vote_hash
    ]
  );

  return { id: ins.rows[0].id, chain_position: nextPos, previous_hash, vote_hash, cast_at };
}

async function insertFiscalVoteChained(client, {
  election_id,
  unit_id,
  fiscal_list_id,
  token_id,
  ip,
  user_agent
}) {
  await lockElectionChain(client, election_id, "FISCAL");

  const last = (await client.query(
    `SELECT chain_position, vote_hash
     FROM fiscal_votes
     WHERE election_id=$1
     ORDER BY chain_position DESC NULLS LAST, cast_at DESC, id DESC
     LIMIT 1`,
    [election_id]
  )).rows[0];

  const nextPos = Number(last?.chain_position ?? 0) + 1;
  const previous_hash = last?.vote_hash ?? "GENESIS";
  const cast_at = (await client.query("SELECT now() AS t")).rows[0].t;

  const payload = {
    election_id,
    unit_id,
    fiscal_list_id,
    token_id,
    cast_at,
    previous_hash,
    chain_position: nextPos
  };

  const vote_hash = sha256Hex(JSON.stringify(payload));

  const ins = await client.query(
    `INSERT INTO fiscal_votes (
       election_id, unit_id, fiscal_list_id, token_id, cast_at, ip, user_agent,
       chain_position, previous_hash, vote_hash
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      election_id, unit_id, fiscal_list_id, token_id, cast_at, ip, user_agent,
      nextPos, previous_hash, vote_hash
    ]
  );

  return { id: ins.rows[0].id, chain_position: nextPos, previous_hash, vote_hash, cast_at };
}

async function insertReferendumVoteChained(client, {
  election_id,
  unit_id,
  question_id,
  option_id,
  token_id,
  ip,
  user_agent
}) {
  await lockElectionChain(client, election_id, "REFERENDUM");

  const last = (await client.query(
    `SELECT chain_position, vote_hash
     FROM referendum_votes
     WHERE election_id=$1
     ORDER BY chain_position DESC NULLS LAST, cast_at DESC, id DESC
     LIMIT 1`,
    [election_id]
  )).rows[0];

  const nextPos = Number(last?.chain_position ?? 0) + 1;
  const previous_hash = last?.vote_hash ?? "GENESIS";
  const cast_at = (await client.query("SELECT now() AS t")).rows[0].t;

  const payload = { election_id, unit_id, question_id, option_id, token_id, cast_at, previous_hash, chain_position: nextPos };
  const vote_hash = sha256Hex(JSON.stringify(payload));

  const ins = await client.query(
    `INSERT INTO referendum_votes (
       election_id, question_id, option_id, unit_id, token_id, cast_at, ip, user_agent,
       chain_position, previous_hash, vote_hash
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [election_id, question_id, option_id, unit_id, token_id, cast_at, ip, user_agent, nextPos, previous_hash, vote_hash]
  );

  return { id: ins.rows[0].id, chain_position: nextPos, previous_hash, vote_hash, cast_at };
}


// Cloudflare/Nginx proxy
app.set("trust proxy", 1);

// SECURITY_HEADERS_PROD_GUARD
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'"
    ].join("; ")
  );
  next();
});

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

// Bloqueo global post-sellado: una campaña sellada queda congelada.
app.use(async (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();

  const allowedEvenWhenSealed =
    req.path === "/admin/logout" ||
    req.path === "/admin/verify" ||
    req.path === "/admin/notifications/sealed" ||
    req.path === "/admin/recordatorios-voto" ||
    req.path === "/admin/elections/new" ||
    req.path.startsWith("/admin/users") ||
    req.path.startsWith("/admin/residentes") ||
    new RegExp("^/admin/elections/\\d+/close$").test(req.path);

  if (allowedEvenWhenSealed) return next();

  const sealedCampaignMutation =
    req.path.startsWith("/votar/") ||
    req.path.startsWith("/admin/solicitudes") ||
    req.path.startsWith("/admin/votacion") ||
    req.path.startsWith("/admin/directiva") ||
    req.path.startsWith("/admin/fiscales") ||
    req.path === "/admin/election/edit" ||
    req.path === "/admin/importar-campana" ||
    req.path === "/admin/seal";

  if (!sealedCampaignMutation) return next();

  try {
    const election = await getActiveElection();
    if (election && await isElectionSealed(election.id)) {
      return res.status(403).send("La campaña ya fue sellada. No se permiten cambios ni nuevos votos. Puedes desactivarla desde el panel para cerrar la publicación activa.");
    }
  } catch (e) {
    console.error("sealed lockdown check failed", e);
    return res.status(500).send("Error validando estado de campaña.");
  }

  return next();
});

async function computeGlobalHash(client, electionId, kind /* 'COUNCIL' | 'FISCAL' | 'REFERENDUM' */) {
  const table = kind === "FISCAL" ? "fiscal_votes" : (kind === "REFERENDUM" ? "referendum_votes" : "votes");

  const rows = (await client.query(
    `SELECT vote_hash
     FROM ${table}
     WHERE election_id=$1
     ORDER BY chain_position ASC`,
    [electionId]
  )).rows;

  const concatenated = rows.map(r => String(r.vote_hash || "")).join("");
  const globalHash = crypto.createHash("sha256").update(concatenated, "utf8").digest("hex");

  return { globalHash, totalVotes: rows.length };
}

app.post("/admin/seal", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(400).send("No hay elección activa.");

  // SEAL_IDEMPOTENT_ALREADY_SEALED
  const existingSeals = (await q(`SELECT kind, global_hash AS "globalHash", total_votes AS "totalVotes" FROM election_seals WHERE election_id=$1 ORDER BY kind ASC`, [election.id])).rows;
  if (existingSeals.length) {
    const council = existingSeals.find(s => s.kind === "COUNCIL") || null;
    const fiscal = existingSeals.find(s => s.kind === "FISCAL") || null;
    const referendum = existingSeals.find(s => s.kind === "REFERENDUM") || null;
    return res.render("seal_result", { election, council, fiscal, referendum });
  }

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1, $2)", [99, election.id]);

    let council = null;
    let fiscal = null;
    let referendum = null;

    if (election.kind === "VOTACION") {
      referendum = await computeGlobalHash(c, election.id, "REFERENDUM");
      await c.query(
        `INSERT INTO election_seals (election_id, kind, global_hash, total_votes, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (election_id, kind) DO NOTHING`,
        [election.id, "REFERENDUM", referendum.globalHash, referendum.totalVotes, req.session.admin.id]
      );
    } else {
      council = await computeGlobalHash(c, election.id, "COUNCIL");
      await c.query(
        `INSERT INTO election_seals (election_id, kind, global_hash, total_votes, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (election_id, kind) DO NOTHING`,
        [election.id, "COUNCIL", council.globalHash, council.totalVotes, req.session.admin.id]
      );

      fiscal = await computeGlobalHash(c, election.id, "FISCAL");
      await c.query(
        `INSERT INTO election_seals (election_id, kind, global_hash, total_votes, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (election_id, kind) DO NOTHING`,
        [election.id, "FISCAL", fiscal.globalHash, fiscal.totalVotes, req.session.admin.id]
      );
    }

    await c.query("COMMIT");

    await audit("ELECTION_SEALED", {
      actor_admin_id: req.session.admin.id,
      election_id: election.id,
      meta_json: { council, fiscal, referendum }
    });

    return res.render("seal_result", { election, council, fiscal, referendum });
  } catch (e) {
    await c.query("ROLLBACK");
    console.error(e);
    return res.status(500).send("Error sellando elección.");
  } finally {
    c.release();
  }
});

app.post("/admin/notifications/sealed", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay campaña activa.");

  const seals = (await q(
    `SELECT kind, global_hash, total_votes, created_at
     FROM election_seals
     WHERE election_id=$1
     ORDER BY kind ASC`,
    [election.id]
  )).rows;

  if (!seals.length) return res.status(400).send("La campaña todavía no tiene sellos. Primero usa Cerrar y Sellar Campaña.");

  const recipients = (await q(
    `SELECT id, email
     FROM registrations
     WHERE election_id=$1 AND status='APPROVED' AND email IS NOT NULL AND email <> ''
     ORDER BY id ASC`,
    [election.id]
  )).rows;

  const hashesText = seals.map(s => `${s.kind}: ${s.global_hash} (votos: ${s.total_votes})`).join("\n");
  const resultsUrl = absoluteUrl(`/resultados/${election.id}`);

  let resultRows = [];
  if (election.kind === "VOTACION") {
    resultRows = (await q(
      `SELECT ro.option_label AS code, ro.option_text AS name, COUNT(rv.id)::int AS votes
       FROM referendum_options ro
       LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
       WHERE ro.election_id=$1
       GROUP BY ro.id
       ORDER BY ro.sort_order ASC, ro.id ASC`,
      [election.id]
    )).rows;
  } else {
    resultRows = (await q(
      `SELECT c.list_code AS code, c.name, COUNT(v.id)::int AS votes
       FROM candidates c
       LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
       WHERE c.election_id=$1
       GROUP BY c.id
       ORDER BY c.sort_order ASC, c.id ASC`,
      [election.id]
    )).rows;
  }
  const resultsText = resultRows.map(r => `${r.code ? r.code + ". " : ""}${r.name}: ${r.votes} voto(s)`).join("\n");

  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    const ok = await sendEmailNotification({
      template: "election_sealed",
      recipient: r.email,
      election_id: election.id,
      registration_id: r.id,
      meta_json: { hashes: seals.map(s => ({ kind: s.kind, global_hash: s.global_hash, total_votes: s.total_votes })) },
      send: () => sendElectionSealed({ to: r.email, electionTitle: election.title, resultsUrl, hashesText, resultsText })
    });
    if (ok) sent++; else failed++;
  }

  await audit("SEALED_RESULTS_NOTIFIED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { sent, failed, total: recipients.length }});
  res.redirect("/admin");
});

app.get("/admin/verify", requireViewerOrAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) {
    const latestFinished = await getLatestFinishedElection();
    return res.render("no_active", { latestFinished });
  }
  res.render("verify", { result: null });
});

app.post("/admin/verify", requireViewerOrAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) {
    const latestFinished = await getLatestFinishedElection();
    return res.render("no_active", { latestFinished });
  }

  const external = String(req.body?.external_hash || "").trim() || null;
  const c = await pool.connect();
  try {
    const seals = (await c.query(
      `SELECT kind, global_hash FROM election_seals WHERE election_id=$1`,
      [election.id]
    )).rows;

    let computed = "";
    let match = false;

    if (election.kind === "VOTACION") {
      const referendum = await computeGlobalHash(c, election.id, "REFERENDUM");
      const seal = seals.find(s => s.kind === "REFERENDUM")?.global_hash || null;
      computed = `REFERENDUM: ${referendum.globalHash}`;
      match = external ? external === referendum.globalHash : !!seal && seal === referendum.globalHash;
      await audit("VERIFY_RUN", { actor_admin_id: req.session.admin?.id ?? null, election_id: election.id, meta_json: { external_hash: external, referendum_hash: referendum.globalHash, seal_referendum: seal, match }});
    } else {
      const council = await computeGlobalHash(c, election.id, "COUNCIL");
      const fiscal  = await computeGlobalHash(c, election.id, "FISCAL");
      const sealCouncil = seals.find(s => s.kind === "COUNCIL")?.global_hash || null;
      const sealFiscal  = seals.find(s => s.kind === "FISCAL")?.global_hash || null;
      computed = `COUNCIL: ${council.globalHash}\nFISCAL: ${fiscal.globalHash}`;
      match = external ? (external === council.globalHash || external === fiscal.globalHash) : (!!sealCouncil && sealCouncil === council.globalHash && !!sealFiscal && sealFiscal === fiscal.globalHash);
      await audit("VERIFY_RUN", { actor_admin_id: req.session.admin?.id ?? null, election_id: election.id, meta_json: { external_hash: external, council_hash: council.globalHash, fiscal_hash: fiscal.globalHash, seal_council: sealCouncil, seal_fiscal: sealFiscal, match }});
    }

    res.render("verify", { result: { computed, match } });
  } catch (e) {
    console.error(e);
    res.status(500).send("Error verificando.");
  } finally {
    c.release();
  }
});


const STREETS = [
  "Jr. El Visitador",
  "Calle El Pacificador",
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

function baseUrl() {
  return String(process.env.BASE_URL || "").replace(/\/$/, "");
}

function absoluteUrl(path) {
  const b = baseUrl();
  if (!b) return path;
  return b + path;
}

async function logNotification({ election_id = null, registration_id = null, admin_user_id = null, template, recipient, status, error = null, meta_json = {} }) {
  try {
    await q(
      `INSERT INTO notification_log(election_id, registration_id, admin_user_id, channel, template, recipient, status, error, meta_json)
       VALUES ($1,$2,$3,'EMAIL',$4,$5,$6,$7,$8)`,
      [election_id, registration_id, admin_user_id, template, recipient, status, error, meta_json]
    );
  } catch (e) {
    console.error("notification_log failed", e);
  }
}

async function sendEmailNotification({ template, recipient, election_id = null, registration_id = null, admin_user_id = null, meta_json = {}, send }) {
  if (!recipient) {
    await logNotification({ election_id, registration_id, admin_user_id, template, recipient: "", status: "SKIPPED", error: "missing recipient", meta_json });
    return false;
  }

  if (!canMail()) {
    await logNotification({ election_id, registration_id, admin_user_id, template, recipient, status: "SKIPPED", error: "SMTP not configured", meta_json });
    return false;
  }

  try {
    await send();
    await logNotification({ election_id, registration_id, admin_user_id, template, recipient, status: "SENT", meta_json });
    return true;
  } catch (e) {
    await logNotification({ election_id, registration_id, admin_user_id, template, recipient, status: "FAILED", error: String(e?.message || e), meta_json });
    console.error("email " + template + " failed", e);
    return false;
  }
}

async function getActiveElection() {
  const r = await q(`SELECT * FROM elections WHERE is_active=true LIMIT 1`);
  return r.rows[0] || null;
}

async function isElectionSealed(electionId) {
  const r = await q(`SELECT 1 FROM election_seals WHERE election_id=$1 LIMIT 1`, [electionId]);
  return r.rows.length > 0;
}

async function getLatestFinishedElection() {
  return (await q(`SELECT * FROM elections WHERE is_active=false ORDER BY id DESC LIMIT 1`)).rows[0] || null;
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

async function getReferendumForElection(electionId) {
  const question = (await q(
    `SELECT * FROM referendum_questions WHERE election_id=$1 ORDER BY sort_order ASC, id ASC LIMIT 1`,
    [electionId]
  )).rows[0] || null;
  if (!question) return { question: null, options: [] };
  const options = (await q(
    `SELECT * FROM referendum_options WHERE election_id=$1 AND question_id=$2 ORDER BY sort_order ASC, id ASC`,
    [electionId, question.id]
  )).rows;
  return { question, options };
}

function newReceiptCode() {
  return crypto.randomBytes(32).toString("hex");
}

async function createVoteReceipt(client, { election_id, registration_id, unit_id, vote_kind, vote_table, vote_id, vote_hash }) {
  const receiptCode = newReceiptCode();
  const receiptHash = sha256Hex(receiptCode);
  await client.query(
    `INSERT INTO vote_receipts(election_id, registration_id, unit_id, vote_kind, vote_table, vote_id, vote_hash, receipt_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (vote_table, vote_id) DO UPDATE SET receipt_hash=EXCLUDED.receipt_hash
     RETURNING id`,
    [election_id, registration_id, unit_id, vote_kind, vote_table, vote_id, vote_hash, receiptHash]
  );
  return receiptCode;
}

async function lookupVoteReceipt({ receiptCode, identity }) {
  const code = String(receiptCode || "").trim();
  const ident = String(identity || "").trim().toLowerCase();
  if (!code || !ident) return null;
  const receiptHash = sha256Hex(code);

  return (await q(
    `SELECT
       vr.id AS receipt_id,
       vr.vote_kind,
       vr.vote_hash,
       e.id AS election_id,
       e.title AS election_title,
       e.kind AS election_kind,
       r.id AS registration_id,
       r.name,
       r.dni,
       r.email,
       u.label AS unit_label,
       rv.cast_at,
       rv.chain_position,
       rv.previous_hash,
       ro.option_label,
       ro.option_text
     FROM vote_receipts vr
     JOIN elections e ON e.id=vr.election_id
     JOIN registrations r ON r.id=vr.registration_id
     JOIN units u ON u.id=vr.unit_id
     LEFT JOIN referendum_votes rv ON vr.vote_table='referendum_votes' AND rv.id=vr.vote_id
     LEFT JOIN referendum_options ro ON ro.id=rv.option_id
     WHERE vr.receipt_hash=$1
       AND (lower(COALESCE(r.email,''))=$2 OR lower(COALESCE(r.dni,''))=$2)
     LIMIT 1`,
    [receiptHash, ident]
  )).rows[0] || null;
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

  // Una persona puede tener mas de una propiedad. Por eso el match es por unidad
  // y luego por algun dato de identidad/contacto. No usamos DNI/email globalmente.
  const found = (await q(
    `SELECT id FROM resident_registry
     WHERE unit_id=$1
       AND (
         ($2::text IS NOT NULL AND lower(COALESCE(dni,''))=lower($2))
         OR ($3::text IS NOT NULL AND lower(COALESCE(email,''))=lower($3))
         OR ($4::text IS NOT NULL AND phone=$4)
       )
     ORDER BY id ASC
     LIMIT 1`,
    [unit_id, dniN, emailN, phoneN]
  )).rows[0];

  if (found) {
    return (await q(
      `UPDATE resident_registry
       SET name=$1, dni=$2, phone=$3, email=$4, status=$5, notes=COALESCE($6, notes), updated_at=now()
       WHERE id=$7
       RETURNING id`,
      [nameN, dniN, phoneN, emailN, status, notes, found.id]
    )).rows[0];
  }

  return (await q(
    `INSERT INTO resident_registry(unit_id, name, dni, phone, email, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [unit_id, nameN, dniN, phoneN, emailN, status, notes]
  )).rows[0];
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
  if (await isElectionSealed(election.id)) {
    await audit("ELECTION_EDIT_BLOCKED_SEALED", { actor_admin_id: req.session.admin.id, election_id: election.id });
    return res.status(403).send("Esta campaña ya fue sellada y no puede editarse.");
  }

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
  if (!election) {
    const latestFinished = await getLatestFinishedElection();
    return res.render("no_active", { latestFinished });
  }

  const n = now();
  const regOpen = inWindow(n, election.reg_open_at, election.reg_close_at);
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);

  const metrics = {
    pending_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='PENDING'`, [election.id])).rows[0].n,
    approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [election.id])).rows[0].n,
    votes: (await q(election.kind === "VOTACION" ? `SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1` : `SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [election.id])).rows[0].n
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

app.get("/verificar-voto", async (req, res) => {
  res.render("verify_vote", { receipt: String(req.query.receipt || ""), identity: "", result: null, error: null });
});

app.post("/verificar-voto", async (req, res) => {
  const receipt = String(req.body.receipt || "").trim();
  const identity = String(req.body.identity || "").trim();
  const result = await lookupVoteReceipt({ receiptCode: receipt, identity });
  if (!result) {
    await audit("VOTE_RECEIPT_VERIFY_FAILED", { meta_json: { has_receipt: !!receipt, has_identity: !!identity }});
    return res.render("verify_vote", { receipt, identity, result: null, error: "No encontramos un voto con esos datos. Revisa el código y el DNI/correo." });
  }

  await audit("VOTE_RECEIPT_VERIFY_OK", { election_id: result.election_id, registration_id: result.registration_id, meta_json: { receipt_id: result.receipt_id, vote_kind: result.vote_kind }});
  res.render("verify_vote", { receipt, identity, result, error: null });
});

/* =========================
   REGISTRO (email obligatorio + ventana)
========================= */
app.get("/registro", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.render("no_active");

  const n = now();
  const regOpen = inWindow(n, election.reg_open_at, election.reg_close_at);

  res.render("register", { election, regOpen, streets: STREETS });
});

app.post("/registro", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.render("no_active");

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

  await sendEmailNotification({
    template: "registration_received",
    recipient: email.trim().toLowerCase(),
    election_id: election.id,
    registration_id: r.rows[0].id,
    meta_json: { name: name.trim() },
    send: () => sendRegistrationReceived({ to: email.trim().toLowerCase(), name: name.trim(), electionTitle: election.title, unitLabel: unit.label })
  });

  res.render("register_done", { election });
});

/* =========================
   VOTAR (ventana + token 1 uso)
========================= */
// SAFE_VOTE_GET_WINDOW_GUARD
app.get("/votar/:token", async (req, res, next) => {
  const election = await getActiveElection();
  if (!election) return res.render("no_active");

  const tokenHash = hashToken(req.params.token);
  const t = (await q(
    `SELECT id, status FROM vote_tokens WHERE token_hash=$1 AND election_id=$2 LIMIT 1`,
    [tokenHash, election.id]
  )).rows[0];

  if (!t) return res.status(404).send("Enlace inválido.");
  if (t.status !== "ACTIVE") return res.render("vote_used", { election });

  const n = now();
  if (n < new Date(election.vote_open_at)) {
    return res.render("closed", { election, state: "pending" });
  }
  if (n > new Date(election.vote_close_at)) {
    return res.render("closed", { election, state: "closed" });
  }
  return next();
});
app.get("/votar/:token", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.render("no_active");

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

  const n = now();
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);

  if (election.kind === "VOTACION") {
    const { question, options } = await getReferendumForElection(election.id);
    if (!question || !options.length) return res.status(400).send("Votación interna sin pregunta/opciones configuradas.");

    if (!voteOpen) return res.render("vote_referendum", { election, token: req.params.token, question, options });

    const hasVote = (await q(
      `SELECT 1 FROM referendum_votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`,
      [election.id, vt.unit_id]
    )).rows.length > 0;

    if (vt.status !== "ACTIVE" || hasVote) {
      if (vt.status === "ACTIVE") await q(`UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1`, [vt.id]);
      return res.render("vote_used", { election });
    }

    return res.render("vote_referendum", { election, token: req.params.token, question, options });
  }

  const councilLists = await getCouncilListsWithMembers(election.id);
  const fiscalLists = (await q(
    `SELECT id, name, titular_name, titular_dni, suplente_name, suplente_dni
     FROM fiscal_lists
     WHERE election_id=$1
     ORDER BY sort_order ASC, id ASC`,
    [election.id]
  )).rows;

  if (!voteOpen) return res.render("vote_preview", { election, token: req.params.token, councilLists, fiscalLists });

  const hasCouncil = (await q(`SELECT 1 FROM votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`, [election.id, vt.unit_id])).rows.length > 0;
  const hasFiscal = (await q(`SELECT 1 FROM fiscal_votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`, [election.id, vt.unit_id])).rows.length > 0;

  if (hasCouncil && hasFiscal) {
    if (vt.status === "ACTIVE") await q(`UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1`, [vt.id]);
    return res.render("vote_used", { election });
  }

  if (!hasCouncil) return res.render("vote_council", { election, token: req.params.token, councilLists });
  return res.render("vote_fiscal", { election, token: req.params.token, fiscalLists });
});


app.post("/votar/:token", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.render("no_active");

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

  await insertCouncilVoteChained(c, {
    election_id: election.id,
    unit_id: vt.unit_id,
    candidate_id: Number(candidate_id),
    token_id: vt.id,
    ip: req.headers["cf-connecting-ip"] || req.ip,
    user_agent: req.headers["user-agent"] || ""
  });

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

// FORCED_REFERENDUM_RECEIPT_ROUTE
app.post("/votar/:token/referendum", async (req, res, next) => {
  const election = await getActiveElection();
  if (!election) return res.render("no_active");
  if (election.kind !== "VOTACION") return next();

  const n = now();
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);
  if (!voteOpen) return res.render("closed", { election });

  const option_id = Number(req.body.option_id);
  if (!option_id) return res.status(400).send("Elige una opción.");

  const { question, options } = await getReferendumForElection(election.id);
  const selectedOption = options.find(o => Number(o.id) === option_id);
  if (!question || !selectedOption) return res.status(400).send("Opción inválida.");

  const tokenHash = hashToken(req.params.token);
  const c = await pool.connect();
  let vote;
  let vt;
  let receiptCode;

  try {
    await c.query("BEGIN");

    const t = await c.query(
      `SELECT * FROM vote_tokens WHERE token_hash=$1 AND election_id=$2 FOR UPDATE`,
      [tokenHash, election.id]
    );

    if (!t.rows.length) {
      await c.query("ROLLBACK");
      return res.status(404).send("Enlace inválido.");
    }

    vt = t.rows[0];
    if (vt.status !== "ACTIVE") {
      await c.query("ROLLBACK");
      return res.render("vote_used", { election });
    }

    vote = await insertReferendumVoteChained(c, {
      election_id: election.id,
      unit_id: vt.unit_id,
      question_id: question.id,
      option_id,
      token_id: vt.id,
      ip: getReqIp(req),
      user_agent: getUserAgent(req)
    });

    receiptCode = await createVoteReceipt(c, {
      election_id: election.id,
      registration_id: vt.registration_id,
      unit_id: vt.unit_id,
      vote_kind: "REFERENDUM",
      vote_table: "referendum_votes",
      vote_id: vote.id,
      vote_hash: vote.vote_hash
    });

    await c.query(`UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1`, [vt.id]);
    await c.query("COMMIT");

    await audit("REFERENDUM_VOTE_CAST", {
      election_id: election.id,
      unit_id: vt.unit_id,
      token_id: vt.id,
      meta_json: { question_id: question.id, option_id, vote_hash: vote.vote_hash, chain_position: vote.chain_position }
    });

    const regForReceipt = (await q(`SELECT r.id, r.email, u.label AS unit_label FROM registrations r JOIN units u ON u.id=r.unit_id WHERE r.id=$1`, [vt.registration_id])).rows[0];
    const optionText = `${selectedOption.option_label ? selectedOption.option_label + ". " : ""}${selectedOption.option_text}`;

    await sendEmailNotification({
      template: "vote_receipt",
      recipient: regForReceipt?.email,
      election_id: election.id,
      registration_id: regForReceipt?.id,
      meta_json: { token_id: vt.id, kind: "REFERENDUM", vote_hash: vote.vote_hash, chain_position: vote.chain_position },
      send: () => sendVoteReceipt({
        to: regForReceipt.email,
        electionTitle: election.title,
        unitLabel: regForReceipt?.unit_label,
        castAt: new Date(vote.cast_at).toLocaleString("es-PE", { timeZone: "America/Lima" }),
        optionText,
        voteHash: vote.vote_hash,
        chainPosition: vote.chain_position,
        receiptCode,
        verifyUrl: absoluteUrl(`/verificar-voto?receipt=${encodeURIComponent(receiptCode)}`)
      })
    });

    return res.render("vote_done", { election });
  } catch (e) {
    await c.query("ROLLBACK");
    if (String(e?.code) === "23505") return res.render("vote_used", { election });
    console.error(e);
    return res.status(500).send("Error registrando voto.");
  } finally {
    c.release();
  }
});

/* =========================
   RESULTADOS PÚBLICOS (histórico)
========================= */
app.get("/resultados", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.render("no_active");
  return res.redirect(`/resultados/${election.id}`);
});

// PUBLIC_RESULTS_UNTIL_CLOSE_GUARD
app.get("/resultados/:electionId", async (req, res, next) => {
  const electionId = Number(req.params.electionId);
  if (!electionId) return next();
  const election = (await q(`SELECT * FROM elections WHERE id=$1`, [electionId])).rows[0];
  if (!election) return next();
  const active = await getActiveElection();
  if (active && Number(active.id) === electionId && now() < new Date(election.vote_close_at)) {
    return res.render("results_pending", { election });
  }
  return next();
});
app.get("/resultados/:electionId", async (req, res) => {
  const electionId = Number(req.params.electionId);
  const election = (await q(`SELECT * FROM elections WHERE id=$1`, [electionId])).rows[0];
  if (!election) return res.status(404).send("Campaña no existe.");

  let totals;
  let metrics;
  if (election.kind === "VOTACION") {
    totals = (await q(
      `SELECT ro.option_label AS list_code, ro.option_text AS name, COUNT(rv.id)::int AS votes
       FROM referendum_options ro
       LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
       WHERE ro.election_id=$1
       GROUP BY ro.id
       ORDER BY ro.sort_order ASC, ro.id ASC`,
      [electionId]
    )).rows;
    metrics = {
      votes: (await q(`SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1`, [electionId])).rows[0].n,
      approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [electionId])).rows[0].n
    };
  } else {
    totals = (await q(
      `SELECT c.name, c.list_code, COUNT(v.id)::int AS votes
       FROM candidates c
       LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
       WHERE c.election_id=$1
       GROUP BY c.id
       ORDER BY c.sort_order ASC`,
      [electionId]
    )).rows;
    metrics = {
      votes: (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [electionId])).rows[0].n,
      approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [electionId])).rows[0].n
    };
  }

  res.render("public_results", { election, totals, metrics });
});

app.get("/admin/fiscalizacion", requireFiscalOrAdmin, async (req, res) => {
  const rows = (await q(
    `SELECT e.id, e.title, e.kind, e.is_active,
            COALESCE(rv.n,0) + COALESCE(v.n,0) + COALESCE(fv.n,0) AS total_votes,
            COALESCE(es.n,0) AS seals
     FROM elections e
     LEFT JOIN (SELECT election_id, COUNT(*)::int n FROM referendum_votes GROUP BY election_id) rv ON rv.election_id=e.id
     LEFT JOIN (SELECT election_id, COUNT(*)::int n FROM votes GROUP BY election_id) v ON v.election_id=e.id
     LEFT JOIN (SELECT election_id, COUNT(*)::int n FROM fiscal_votes GROUP BY election_id) fv ON fv.election_id=e.id
     LEFT JOIN (SELECT election_id, COUNT(*)::int n FROM election_seals GROUP BY election_id) es ON es.election_id=e.id
     ORDER BY e.id DESC`
  )).rows;
  res.render("fiscalization", { admin: req.session.admin, rows });
});

async function getFiscalizationRows(electionId) {
  const election = (await q(`SELECT * FROM elections WHERE id=$1`, [electionId])).rows[0];
  if (!election) return { election: null, rows: [] };

  const rows = election.kind === "VOTACION" ? (await q(
    `SELECT u.label AS unit_label, r.name, r.dni, r.email,
            ro.option_label, ro.option_text,
            rv.cast_at, rv.chain_position, rv.previous_hash, rv.vote_hash
     FROM referendum_votes rv
     JOIN units u ON u.id=rv.unit_id
     JOIN vote_tokens vt ON vt.id=rv.token_id
     JOIN registrations r ON r.id=vt.registration_id
     JOIN referendum_options ro ON ro.id=rv.option_id
     WHERE rv.election_id=$1
     ORDER BY rv.chain_position ASC`,
    [electionId]
  )).rows : (await q(
    `SELECT u.label AS unit_label, r.name, r.dni, r.email,
            c.list_code AS option_label, c.name AS option_text,
            v.cast_at, v.chain_position, v.previous_hash, v.vote_hash
     FROM votes v
     JOIN units u ON u.id=v.unit_id
     JOIN vote_tokens vt ON vt.id=v.token_id
     JOIN registrations r ON r.id=vt.registration_id
     JOIN candidates c ON c.id=v.candidate_id
     WHERE v.election_id=$1
     ORDER BY v.chain_position ASC`,
    [electionId]
  )).rows;

  return { election, rows };
}

app.get("/admin/fiscalizacion/:electionId/votos", requireFiscalOrAdmin, async (req, res) => {
  const { election, rows } = await getFiscalizationRows(Number(req.params.electionId));
  if (!election) return res.status(404).send("Campaña no existe.");
  await audit("FISCALIZATION_VIEWED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { rows: rows.length }});
  res.render("fiscalization_votes", { admin: req.session.admin, election, rows });
});

app.get("/admin/fiscalizacion/:electionId/votos.csv", requireFiscalOrAdmin, async (req, res) => {
  const { election, rows } = await getFiscalizationRows(Number(req.params.electionId));
  if (!election) return res.status(404).send("Campaña no existe.");
  await audit("FISCALIZATION_EXPORTED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { rows: rows.length }});
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="fiscalizacion_${election.id}.csv"`);
  res.send(toCSV(rows));
});

async function getPendingVoteRows(electionId) {
  const election = (await q(`SELECT * FROM elections WHERE id=$1`, [electionId])).rows[0];
  if (!election) return { election: null, rows: [], stats: { approved: 0, voted: 0 } };

  const voteJoin = election.kind === "VOTACION"
    ? "LEFT JOIN referendum_votes vv ON vv.election_id=r.election_id AND vv.unit_id=r.unit_id"
    : "LEFT JOIN votes vv ON vv.election_id=r.election_id AND vv.unit_id=r.unit_id";

  const rows = (await q(
    `SELECT r.id AS registration_id, r.name, r.dni, r.email, u.label AS unit_label, vt.status AS token_status
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     LEFT JOIN LATERAL (
       SELECT status FROM vote_tokens
       WHERE election_id=r.election_id AND registration_id=r.id
       ORDER BY id DESC LIMIT 1
     ) vt ON true
     ${voteJoin}
     WHERE r.election_id=$1 AND r.status='APPROVED' AND vv.id IS NULL
     ORDER BY u.label ASC, r.name ASC`,
    [electionId]
  )).rows;

  const stats = {
    approved: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [electionId])).rows[0].n,
    voted: election.kind === "VOTACION"
      ? (await q(`SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1`, [electionId])).rows[0].n
      : (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [electionId])).rows[0].n
  };

  return { election, rows, stats };
}

app.get("/admin/recordatorios-voto", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.render("no_active", { latestFinished: await getLatestFinishedElection() });
  const { election, rows, stats } = await getPendingVoteRows(active.id);
  res.render("vote_pending_reminders", { admin: req.session.admin, election, rows, stats, lastResult: null });
});

app.post("/admin/recordatorios-voto", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.render("no_active", { latestFinished: await getLatestFinishedElection() });
  const { election, rows, stats } = await getPendingVoteRows(active.id);

  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const ok = await sendEmailNotification({
      template: "vote_pending_reminder",
      recipient: r.email,
      election_id: election.id,
      registration_id: r.registration_id,
      meta_json: { no_link: true, unit_label: r.unit_label },
      send: () => sendVotePendingReminder({ to: r.email, electionTitle: election.title, voteOpenAt: election.vote_open_at, voteCloseAt: election.vote_close_at, unitLabel: r.unit_label })
    });
    if (ok) sent++; else failed++;
  }

  await audit("VOTE_PENDING_REMINDERS_SENT", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { sent, failed, total: rows.length }});
  res.render("vote_pending_reminders", { admin: req.session.admin, election, rows, stats, lastResult: { sent, failed, total: rows.length } });
});

// REISSUE_SHOW_BACKUP_LINK_ROUTE
app.post("/admin/solicitudes/:id/reemitir", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay campaña activa.");
  if (await isElectionSealed(active.id)) return res.status(403).send("La campaña ya fue sellada. No se pueden reemitir enlaces.");

  const id = Number(req.params.id);
  const reg = (await q(
    `SELECT r.*, u.id AS unit_id, u.label AS unit_label
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     WHERE r.id=$1 AND r.election_id=$2`,
    [id, active.id]
  )).rows[0];

  if (!reg) return res.status(404).send("Solicitud no encontrada.");
  if (reg.status !== "APPROVED") return res.status(400).send("Solo se puede reemitir enlace a solicitudes aprobadas.");
  if (!reg.email) return res.status(400).send("La solicitud no tiene correo electrónico.");

  const alreadyVoted = active.kind === "VOTACION"
    ? (await q(`SELECT 1 FROM referendum_votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`, [active.id, reg.unit_id])).rows.length > 0
    : (await q(`SELECT 1 FROM votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1`, [active.id, reg.unit_id])).rows.length > 0;
  if (alreadyVoted) return res.status(400).send("Esta unidad ya emitió su voto. No se puede reemitir enlace.");

  const raw = newToken();
  const tokenHash = hashToken(raw);
  let tokenId;

  await withTx(pool, async (client) => {
    await client.query(`UPDATE vote_tokens SET status='REVOKED' WHERE election_id=$1 AND registration_id=$2 AND status='ACTIVE'`, [active.id, reg.id]);
    const tr = await client.query(
      `INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, issued_via)
       VALUES ($1,$2,$3,$4,'ACTIVE','EMAIL')
       RETURNING id`,
      [active.id, reg.id, reg.unit_id, tokenHash]
    );
    tokenId = tr.rows[0].id;
  });

  const link = absoluteUrl(`/votar/${raw}`);
  const sent = await sendEmailNotification({
    template: "vote_link_reissued",
    recipient: reg.email,
    election_id: active.id,
    registration_id: reg.id,
    meta_json: { token_id: tokenId, reissue: true, unit_label: reg.unit_label },
    send: () => sendVoteLink({
      to: reg.email,
      link,
      electionTitle: active.title,
      voteOpenAt: active.vote_open_at,
      voteCloseAt: active.vote_close_at,
      unitLabel: reg.unit_label
    })
  });

  await audit("TOKEN_REISSUED", {
    actor_admin_id: req.session.admin.id,
    election_id: active.id,
    registration_id: reg.id,
    unit_id: reg.unit_id,
    token_id: tokenId,
    meta_json: { sent }
  });

  const tokenRow = { id: tokenId, status: "ACTIVE", issued_at: new Date(), used_at: null };
  return res.render("admin_request_detail", { admin: req.session.admin, r: reg, tokenRow, link, sent });
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
  if (user.enabled === false) return res.render("admin_login", { error: "Credenciales inválidas." });
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
    votes: (await q(active.kind === "VOTACION" ? `SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1` : `SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [active.id])).rows[0].n
  } : null;

  res.render("admin_dashboard", { admin: req.session.admin, active, elections, stats, canMail: canMail() });
});

app.get("/admin/elections/new", requireAdmin, async (req, res) => {
  res.render("admin_election_new", { admin: req.session.admin });
});

app.post("/admin/elections/new", requireAdmin, async (req, res) => {
  const { title, reg_open_at, reg_close_at, vote_open_at, vote_close_at } = req.body;
  const kind = String(req.body.kind || "ELECTION").trim().toUpperCase() === "VOTACION" ? "VOTACION" : "ELECTION";
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
    `INSERT INTO elections(title, reg_open_at, reg_close_at, vote_open_at, vote_close_at, is_active, kind)
     VALUES ($1,$2,$3,$4,$5,false,$6)
     RETURNING id`,
    [title.trim(), regOpen, regClose, voteOpen, voteClose, kind]
  )).rows[0];

  // crea candidatos default solo para campañas tipo elección
  if (kind === "ELECTION") {
    await q(
      `INSERT INTO candidates(election_id, name, list_code, sort_order)
       VALUES ($1,'Lista 1','LISTA_1',1), ($1,'Lista 2','LISTA_2',2)`,
      [e.id]
    );
  }

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

app.get("/admin/votacion", requireViewerOrAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay campaña activa.");
  if (election.kind !== "VOTACION") return res.status(400).send("La campaña activa no es una votación interna.");
  const data = await getReferendumForElection(election.id);
  res.render("admin_referendum", { admin: req.session.admin, election, question: data.question, options: data.options });
});

app.post("/admin/votacion", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay campaña activa.");
  if (election.kind !== "VOTACION") return res.status(400).send("La campaña activa no es una votación interna.");

  const questionText = String(req.body.question_text || "").trim();
  const labels = Array.isArray(req.body.option_label) ? req.body.option_label : [req.body.option_label];
  const texts = Array.isArray(req.body.option_text) ? req.body.option_text : [req.body.option_text];
  const opts = texts.map((t, i) => ({ label: String(labels[i] || "").trim(), text: String(t || "").trim() })).filter(o => o.text);

  if (!questionText || opts.length < 2) return res.status(400).send("Carga una pregunta y al menos dos opciones.");

  await q(`DELETE FROM referendum_questions WHERE election_id=$1`, [election.id]);
  const question = (await q(
    `INSERT INTO referendum_questions(election_id, question_text, sort_order) VALUES ($1,$2,1) RETURNING id`,
    [election.id, questionText]
  )).rows[0];

  for (let i = 0; i < opts.length; i++) {
    await q(
      `INSERT INTO referendum_options(election_id, question_id, option_label, option_text, sort_order) VALUES ($1,$2,$3,$4,$5)`,
      [election.id, question.id, opts[i].label || String.fromCharCode(65 + i), opts[i].text, i + 1]
    );
  }

  await audit("REFERENDUM_CONFIG_UPDATED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { options: opts.length }});
  res.redirect("/admin/votacion");
});

/* =========================
   ADMIN: usuarios y padrón maestro
========================= */
app.get("/admin/users", requireAdmin, async (req, res) => {
  const users = (await q(
    `SELECT id, email, role, COALESCE(enabled,true) AS enabled, created_at, updated_at
     FROM admin_users
     ORDER BY email ASC`
  )).rows;
  res.render("admin_users", { admin: req.session.admin, users });
});

app.post("/admin/users/new", requireAdmin, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const secret = String(req.body.secret || "");
  const rawRole = String(req.body.role || "viewer");
  const role = ["admin", "fiscal", "viewer"].includes(rawRole) ? rawRole : "viewer";
  if (!email || !secret) return res.status(400).send("Email y clave son obligatorios.");

  const hash = await bcrypt.hash(secret, 12);
  const user = (await q(
    `INSERT INTO admin_users(email, password_hash, role, enabled)
     VALUES ($1,$2,$3,true)
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role, enabled=true, updated_at=now()
     RETURNING id`,
    [email, hash, role]
  )).rows[0];

  await audit("ADMIN_USER_UPSERTED", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: user.id, email, role }});
  await sendEmailNotification({
    template: "admin_invite",
    recipient: email,
    admin_user_id: user.id,
    meta_json: { role },
    send: () => sendAdminInvite({ to: email, role, secret, loginUrl: absoluteUrl("/admin/login") })
  });
  res.redirect("/admin/users");
});

app.post("/admin/users/:id/role", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const rawRole = String(req.body.role || "viewer");
  const role = ["admin", "fiscal", "viewer"].includes(rawRole) ? rawRole : "viewer";
  if (id === req.session.admin.id && role !== "admin") return res.status(400).send("No puedes quitarte tu propio rol admin.");

  await q(`UPDATE admin_users SET role=$1, updated_at=now() WHERE id=$2`, [role, id]);
  await audit("ADMIN_USER_ROLE_UPDATED", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: id, role }});
  res.redirect("/admin/users");
});

app.post("/admin/users/:id/secret", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const secret = String(req.body.secret || "");
  if (!secret) return res.status(400).send("Clave obligatoria.");

  const hash = await bcrypt.hash(secret, 12);
  await q(`UPDATE admin_users SET password_hash=$1, updated_at=now() WHERE id=$2`, [hash, id]);
  await audit("ADMIN_USER_SECRET_RESET", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: id }});
  res.redirect("/admin/users");
});

app.post("/admin/users/:id/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).send("Usuario inválido.");
  if (id === Number(req.session.admin.id)) return res.status(400).send("No puedes eliminar tu propio usuario mientras estás logueado.");

  const target = (await q(`SELECT id, email, role FROM admin_users WHERE id=$1`, [id])).rows[0];
  if (!target) return res.status(404).send("Usuario no existe.");

  await q(`DELETE FROM admin_users WHERE id=$1`, [id]);
  await audit("ADMIN_USER_DELETED", {
    actor_admin_id: req.session.admin.id,
    meta_json: { deleted_admin_user_id: id, email: target.email, role: target.role }
  });

  res.redirect("/admin/users");
});
app.post("/admin/users/:id/toggle", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.admin.id) return res.status(400).send("No puedes desactivar tu propio usuario.");

  await q(`UPDATE admin_users SET enabled=NOT COALESCE(enabled,true), updated_at=now() WHERE id=$1`, [id]);
  await audit("ADMIN_USER_TOGGLED", { actor_admin_id: req.session.admin.id, meta_json: { target_admin_id: id }});
  res.redirect("/admin/users");
});

app.get("/admin/residentes", requireAdmin, async (req, res) => {
  const search = String(req.query.q || "").trim();
  const params = [];
  let where = "";
  if (search) {
    params.push("%" + search.toLowerCase() + "%");
    where = `WHERE lower(rr.name) LIKE $1 OR lower(COALESCE(rr.dni,'')) LIKE $1 OR lower(COALESCE(rr.email,'')) LIKE $1 OR lower(COALESCE(rr.phone,'')) LIKE $1 OR lower(u.label) LIKE $1`;
  }

  const rows = (await q(
    `SELECT rr.*, u.label AS unit_label
     FROM resident_registry rr
     JOIN units u ON u.id=rr.unit_id
     ${where}
     ORDER BY u.label ASC, rr.name ASC
     LIMIT 500`,
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
    `SELECT rr.*, u.label AS unit_label, u.street, u.number, u.unit_extra
     FROM resident_registry rr
     JOIN units u ON u.id=rr.unit_id
     WHERE rr.id=$1`,
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
    `UPDATE resident_registry
     SET unit_id=$1, name=$2, dni=$3, phone=$4, email=$5, status=$6, notes=$7, updated_at=now()
     WHERE id=$8`,
    [unit.id, String(name).trim(), cleanText(dni), cleanText(phone), cleanText(email)?.toLowerCase() || null, status || "ACTIVE", cleanText(notes), id]
  );
  await audit("RESIDENT_UPDATED", { actor_admin_id: req.session.admin.id, unit_id: unit.id, meta_json: { resident_id: id }});
  res.redirect("/admin/residentes");
});

app.post("/admin/residentes/importar-campana", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay campaña activa.");

  const rows = (await q(
    `INSERT INTO registrations(election_id, unit_id, name, dni, phone, email, status)
     SELECT $1, rr.unit_id, rr.name, COALESCE(rr.dni,''), COALESCE(rr.phone,''), COALESCE(rr.email,''), 'PENDING'
     FROM resident_registry rr
     WHERE rr.status='ACTIVE'
       AND NOT EXISTS (
         SELECT 1 FROM registrations r WHERE r.election_id=$1 AND r.unit_id=rr.unit_id
       )
     RETURNING id, unit_id`,
    [active.id]
  )).rows;

  await audit("RESIDENT_REGISTRY_IMPORTED", { actor_admin_id: req.session.admin.id, election_id: active.id, meta_json: { imported: rows.length }});
  res.redirect("/admin/solicitudes?filter=pending");
});

/* =========================
   ADMIN: Solicitudes + aprobación (email por defecto)
========================= */
app.post("/admin/solicitudes/bulk-approve", requireAdmin, async (req, res) => {
  // BULK_APPROVE_SAFE_ROUTE
  try {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay campaña activa.");
  if (await isElectionSealed(active.id)) return res.status(403).send("La campaña ya fue sellada. No se pueden aprobar solicitudes.");

  const idsRaw = Array.isArray(req.body.registration_ids) ? req.body.registration_ids : [req.body.registration_ids];
  const ids = idsRaw.map(x => Number(x)).filter(Boolean);
  if (!ids.length) return res.redirect("/admin/solicitudes?filter=pending");

  let approved = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const id of ids) {
    const reg = (await q(
      `SELECT r.*, u.id AS unit_id, u.label AS unit_label
       FROM registrations r
       JOIN units u ON u.id=r.unit_id
       WHERE r.id=$1 AND r.election_id=$2`,
      [id, active.id]
    )).rows[0];

    if (!reg || reg.status !== "PENDING" || !reg.email) { skipped++; continue; }

    // BULK_DUPLICATE_APPROVED_UNIT_GUARD
    const unitAlreadyApproved = (await q(
      `SELECT 1 FROM registrations
       WHERE election_id=$1 AND unit_id=$2 AND status='APPROVED' AND id<>$3
       LIMIT 1`,
      [active.id, reg.unit_id, reg.id]
    )).rows.length > 0;
    if (unitAlreadyApproved) { skipped++; continue; }

    const raw = newToken();
    const tokenHash = hashToken(raw);
    let tokenId;

    await withTx(pool, async (client) => {
      await client.query(
        `UPDATE registrations
         SET status='APPROVED', reviewed_at=NOW(), reviewed_by=$1, notes=COALESCE(notes,'')
         WHERE id=$2 AND status='PENDING'`,
        [req.session.admin.id, reg.id]
      );
      const tr = await client.query(
        `INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, issued_via)
         VALUES ($1,$2,$3,$4,'ACTIVE','EMAIL')
         RETURNING id`,
        [active.id, reg.id, reg.unit_id, tokenHash]
      );
      tokenId = tr.rows[0].id;
    });

    approved++;
    const link = absoluteUrl(`/votar/${raw}`);
    const ok = await sendEmailNotification({
      template: "registration_approved",
      recipient: reg.email,
      election_id: active.id,
      registration_id: reg.id,
      meta_json: { token_id: tokenId, bulk: true },
      send: () => sendVoteLink({ to: reg.email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at, unitLabel: reg.unit_label })
    });
    if (ok) sent++; else failed++;

    await audit("REGISTRATION_APPROVED", { actor_admin_id: req.session.admin.id, election_id: active.id, registration_id: reg.id, unit_id: reg.unit_id, token_id: tokenId, meta_json: { via: "EMAIL", bulk: true, sent: ok } });
  }

  await audit("REGISTRATION_BULK_APPROVED", { actor_admin_id: req.session.admin.id, election_id: active.id, meta_json: { requested: ids.length, approved, sent, failed, skipped } });
  res.redirect(`/admin/solicitudes?filter=pending&bulk=1&approved=${approved}&sent=${sent}&failed=${failed}&skipped=${skipped}`);
  } catch (e) {
    console.error("bulk approve failed", e);
    await audit("REGISTRATION_BULK_APPROVE_FAILED", { actor_admin_id: req.session.admin.id, election_id: active?.id ?? null, meta_json: { error: String(e?.message || e) } });
    return res.status(500).send("Error aprobando solicitudes en bloque. Revisa los logs del servidor.");
  }
  // BULK_APPROVE_SAFE_ROUTE_END
});
app.get("/admin/solicitudes", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.render("no_active");

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
  if (!active) return res.render("no_active");

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

// APPROVAL_EMAIL_DELIVERY_STABLE_ROUTE
app.post("/admin/solicitudes/:id/aprobar", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay campaña activa.");
  if (await isElectionSealed(active.id)) return res.status(403).send("La campaña ya fue sellada. No se pueden aprobar solicitudes.");

  const id = Number(req.params.id);
  const reg = (await q(
    `SELECT r.*, u.label AS unit_label,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status IN ('PENDING','APPROVED')) AS duplicate_open_count,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status='PENDING') AS duplicate_pending_count,
            (SELECT COUNT(*)::int FROM registrations r2 WHERE r2.election_id=r.election_id AND r2.unit_id=r.unit_id AND r2.id<>r.id AND r2.status='APPROVED') AS duplicate_approved_count
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     WHERE r.id=$1 AND r.election_id=$2`,
    [id, active.id]
  )).rows[0];

  if (!reg) return res.status(404).send("Solicitud no encontrada.");
  if (reg.status !== "PENDING") return res.status(400).send("Solo se pueden aprobar solicitudes pendientes.");
  if (!reg.email) return res.status(400).send("La solicitud no tiene correo electrónico.");

  // APPROVE_DUPLICATE_APPROVED_UNIT_GUARD
  const unitAlreadyApproved = (await q(
    `SELECT id, name, email FROM registrations
     WHERE election_id=$1 AND unit_id=$2 AND status='APPROVED' AND id<>$3
     ORDER BY reviewed_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [active.id, reg.unit_id, reg.id]
  )).rows[0];
  if (unitAlreadyApproved) {
    return res.status(400).send(`Esta unidad ya tiene una solicitud aprobada (ID ${unitAlreadyApproved.id}). Rechaza o revisa el duplicado antes de aprobar otra.`);
  }

  const raw = newToken();
  const tokenHash = hashToken(raw);
  let tokenId;

  await withTx(pool, async (client) => {
    await client.query(
      `UPDATE registrations
       SET status='APPROVED', reviewed_at=NOW(), reviewed_by=$1, notes=COALESCE(notes,'')
       WHERE id=$2 AND status='PENDING'`,
      [req.session.admin.id, reg.id]
    );

    const tr = await client.query(
      `INSERT INTO vote_tokens(election_id, registration_id, unit_id, token_hash, status, issued_via)
       VALUES ($1,$2,$3,$4,'ACTIVE','EMAIL')
       RETURNING id`,
      [active.id, reg.id, reg.unit_id, tokenHash]
    );
    tokenId = tr.rows[0].id;
  });

  const link = absoluteUrl(`/votar/${raw}`);
  const sent = await sendEmailNotification({
    template: "registration_approved",
    recipient: reg.email,
    election_id: active.id,
    registration_id: reg.id,
    meta_json: { token_id: tokenId, unit_label: reg.unit_label },
    send: () => sendVoteLink({
      to: reg.email,
      link,
      electionTitle: active.title,
      voteOpenAt: active.vote_open_at,
      voteCloseAt: active.vote_close_at,
      unitLabel: reg.unit_label
    })
  });

  await audit("REGISTRATION_APPROVED", {
    actor_admin_id: req.session.admin.id,
    election_id: active.id,
    registration_id: reg.id,
    unit_id: reg.unit_id,
    token_id: tokenId,
    meta_json: { via: "EMAIL", sent }
  });

  const tokenRow = { id: tokenId, status: "ACTIVE", issued_at: new Date(), used_at: null };
  res.render("admin_request_detail", { admin: req.session.admin, r: { ...reg, status: "APPROVED" }, tokenRow, link, sent });
});
app.post("/admin/solicitudes/:id/reemitir", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.render("no_active");

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
    const sent = await sendVoteLink({ to: reg.email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at, unitLabel: reg.unit_label });
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
  if (!active) return res.status(500).send("No hay campaña activa.");
  if (await isElectionSealed(active.id)) return res.status(403).send("La campaña ya fue sellada. No se pueden rechazar solicitudes.");

  const id = Number(req.params.id);
  const notes = String(req.body.notes || "").trim();
  const reg = (await q(
    `SELECT r.*, u.label AS unit_label
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     WHERE r.id=$1 AND r.election_id=$2`,
    [id, active.id]
  )).rows[0];

  if (!reg) return res.status(404).send("Solicitud no encontrada.");
  if (reg.status !== "PENDING") return res.status(400).send("Solo se pueden rechazar solicitudes pendientes.");

  await q(
    `UPDATE registrations
     SET status='REJECTED', reviewed_at=NOW(), reviewed_by=$1, notes=$2
     WHERE id=$3`,
    [req.session.admin.id, notes, id]
  );

  let sent = false;
  if (reg.email) {
    sent = await sendEmailNotification({
      template: "registration_rejected",
      recipient: reg.email,
      election_id: active.id,
      registration_id: reg.id,
      meta_json: { unit_label: reg.unit_label, has_reason: !!notes },
      send: () => sendRegistrationRejected({
        to: reg.email,
        electionTitle: active.title,
        reason: notes,
        unitLabel: reg.unit_label
      })
    });
  } else {
    await logNotification({
      election_id: active.id,
      registration_id: reg.id,
      template: "registration_rejected",
      recipient: "",
      status: "SKIPPED",
      error: "missing recipient",
      meta_json: { unit_label: reg.unit_label }
    });
  }

  await audit("REGISTRATION_REJECTED", {
    actor_admin_id: req.session.admin.id,
    election_id: active.id,
    registration_id: reg.id,
    unit_id: reg.unit_id,
    meta_json: { notes, sent }
  });

  res.redirect("/admin/solicitudes?filter=pending");
});

/* =========================
   ADMIN: Resultados + exports
========================= */
app.get("/admin/resultados", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.render("no_active");

  let totals;
  let votesSql = `SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`;
  if (active.kind === "VOTACION") {
    votesSql = `SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1`;
    totals = (await q(
      `SELECT ro.option_label AS list_code, ro.option_text AS name, COUNT(rv.id)::int AS votes
       FROM referendum_options ro
       LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
       WHERE ro.election_id=$1
       GROUP BY ro.id
       ORDER BY ro.sort_order ASC, ro.id ASC`,
      [active.id]
    )).rows;
  } else {
    totals = (await q(
      `SELECT c.name, c.list_code, COUNT(v.id)::int AS votes
       FROM candidates c
       LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
       WHERE c.election_id=$1
       GROUP BY c.id
       ORDER BY c.sort_order ASC`,
      [active.id]
    )).rows;
  }

  const metrics = {
    votes: (await q(votesSql, [active.id])).rows[0].n,
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
  const rows = active.kind === "VOTACION" ? (await q(
    `SELECT ro.option_label AS opcion, ro.option_text AS descripcion, COUNT(rv.id)::int AS votos
     FROM referendum_options ro
     LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
     WHERE ro.election_id=$1
     GROUP BY ro.id
     ORDER BY ro.sort_order ASC, ro.id ASC`,
    [active.id]
  )).rows : (await q(
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
app.get("/admin/print/padron", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(400).send("No hay campaña activa.");

  // PRINT_PADRON_VOTE_STATUS_BY_TOKEN
  // El estado de voto debe salir del voto real ligado al token usado.
  // En campañas VOTACION el voto vive en referendum_votes, no en votes.
  const rows = (await q(`
    SELECT
      u.label AS unidad,
      r.status AS registro_estado,
      COALESCE(vt.status::text, '-') AS token_estado,
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
  `, [election.id])).rows;

  res.render("admin_print_padron", { election, rows });
});

/* =========================
   ADMIN: ACTA PDF
========================= */
app.get(
  "/admin/acta.pdf",
  requireViewerOrAdmin,
  createActaPdfHandler({
    q,
    PDFDocument,
    getActiveElection,
    getReferendumForElection,
    audit
  })
);

app.get("/admin/padron_v2.pdf", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.render("no_active");

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

  doc.fontSize(11).text("Criterio: Habilitados = registros APROBADOS por el Consejo Directivo.");
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
  signLine(x1, sy, "Presidente(a) Consejo Directivo");
  signLine(x2, sy, "Miembro Consejo Directivo");

  // Fila 2
  sy += 46;
  signLine(x1, sy, "Miembro Consejo Directivo");
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
  if (!election) return res.render("no_active");

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

    await insertFiscalVoteChained(c, {
      election_id: election.id,
      unit_id: vt.unit_id,
      fiscal_list_id: Number(fiscal_list_id),
      token_id: vt.id,
      ip: getReqIp(req),
      user_agent: getUserAgent(req)
    });

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
