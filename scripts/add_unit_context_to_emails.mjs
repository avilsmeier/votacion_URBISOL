import fs from "fs";

const serverFile = "src/server.js";
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

apply("registration received includes unit", txt => txt.replace(
  "send: () => sendRegistrationReceived({ to: email, name, electionTitle: active.title })",
  "send: () => sendRegistrationReceived({ to: email, name, electionTitle: active.title, unitLabel: unit.label })"
));

apply("approval email includes unit", txt => {
  let out = txt;
  out = out.replaceAll(
    "sendVoteLink({ to: email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at })",
    "sendVoteLink({ to: email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at, unitLabel: r.unit_label })"
  );
  out = out.replaceAll(
    "sendVoteLink({ to: reg.email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at })",
    "sendVoteLink({ to: reg.email, link, electionTitle: active.title, voteOpenAt: active.vote_open_at, voteCloseAt: active.vote_close_at, unitLabel: reg.unit_label })"
  );
  return out;
});

apply("pending reminder includes unit", txt => txt.replaceAll(
  "sendVotePendingReminder({ to: r.email, electionTitle: election.title, voteOpenAt: election.vote_open_at, voteCloseAt: election.vote_close_at })",
  "sendVotePendingReminder({ to: r.email, electionTitle: election.title, voteOpenAt: election.vote_open_at, voteCloseAt: election.vote_close_at, unitLabel: r.unit_label })"
));

apply("vote receipt query includes unit label", txt => txt.replace(
  "const regForReceipt = (await q(`SELECT id, email FROM registrations WHERE id=$1`, [vt.registration_id])).rows[0];",
  "const regForReceipt = (await q(`SELECT r.id, r.email, u.label AS unit_label FROM registrations r JOIN units u ON u.id=r.unit_id WHERE r.id=$1`, [vt.registration_id])).rows[0];"
));

apply("vote receipt send includes unit label", txt => txt.replace(
  "electionTitle: election.title,\n        castAt:",
  "electionTitle: election.title,\n        unitLabel: regForReceipt?.unit_label,\n        castAt:"
));

fs.writeFileSync(serverFile, s);
console.log(changed ? "[OK] unit context email wiring aplicado" : "[OK] nada para aplicar");
