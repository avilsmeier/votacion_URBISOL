import fs from "fs";

const p = "src/server.js";
let s = fs.readFileSync(p, "utf8");
let changed = false;

function save(label, before) {
  if (s !== before) {
    changed = true;
    console.log("[OK] " + label);
  } else {
    console.log("[OK] " + label + " ya estaba aplicado o no matcheo");
  }
}

let before = s;
if (!s.includes("sendRegistrationRejected")) {
  s = s.replace(
    'sendRegistrationReceived, sendVoteReceipt',
    'sendRegistrationReceived, sendRegistrationRejected, sendVoteReceipt'
  );
}
save("mailer import", before);

before = s;
const routeStart = s.indexOf('app.post("/admin/solicitudes/:id/rechazar"');
if (routeStart < 0) throw new Error("No encontre ruta rechazar");
const bodyStart = s.indexOf("{", routeStart);
let i = bodyStart;
let depth = 0;
let quote = null;
let escape = false;
for (; i < s.length; i++) {
  const ch = s[i];
  if (escape) { escape = false; continue; }
  if (ch === "\\") { escape = true; continue; }
  if (quote) { if (ch === quote) quote = null; continue; }
  if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
  if (ch === "{") depth++;
  if (ch === "}") {
    depth--;
    if (depth === 0) break;
  }
}
const routeEnd = s.indexOf(");", i) + 2;
if (routeEnd < 2) throw new Error("No pude ubicar fin ruta rechazar");

const route = `app.post("/admin/solicitudes/:id/rechazar", requireAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay campaña activa.");
  if (await isElectionSealed(active.id)) return res.status(403).send("La campaña ya fue sellada. No se pueden rechazar solicitudes.");

  const id = Number(req.params.id);
  const notes = String(req.body.notes || "").trim();
  const reg = (await q(
    \`SELECT r.*, u.label AS unit_label
     FROM registrations r
     JOIN units u ON u.id=r.unit_id
     WHERE r.id=$1 AND r.election_id=$2\`,
    [id, active.id]
  )).rows[0];

  if (!reg) return res.status(404).send("Solicitud no encontrada.");
  if (reg.status !== "PENDING") return res.status(400).send("Solo se pueden rechazar solicitudes pendientes.");

  await q(
    \`UPDATE registrations
     SET status='REJECTED', reviewed_at=NOW(), reviewed_by=$1, notes=$2
     WHERE id=$3\`,
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
});`;

s = s.slice(0, routeStart) + route + s.slice(routeEnd);
save("route", before);

fs.writeFileSync(p, s);
console.log(changed ? "[OK] decline email wired" : "[OK] nada para aplicar");
