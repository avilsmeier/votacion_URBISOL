// src/audit.js
export function getReqIp(req) {
  const raw =
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.ip ||
    "";
  return String(raw).split(",")[0].trim() || null;
}

export function createAudit({ q }) {
  return async function auditEvent(req, action, payload = {}) {
    const election_id = payload.election_id ?? null;
    const actor_admin_id = payload.actor_admin_id ?? (req?.session?.admin?.id ?? null);
    const unit_id = payload.unit_id ?? null;
    const token_id = payload.token_id ?? null;

    const ip = getReqIp(req);
    const user_agent = String(req.headers["user-agent"] || "") || null;

    const actor_type = actor_admin_id
      ? "admin"
      : (unit_id || token_id ? "voter" : "system");

    const meta_json = payload.meta_json ?? payload ?? {};

    await q(
      `INSERT INTO audit_log(ts, election_id, actor_type, actor_admin_id, unit_id, token_id, action, ip, user_agent, meta_json)
       VALUES (NOW(), $1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [election_id, actor_type, actor_admin_id, unit_id, token_id, action, ip, user_agent, meta_json]
    );
  };
}
