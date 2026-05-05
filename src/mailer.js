import nodemailer from "nodemailer";

export function canMail() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function systemName() {
  return process.env.SYSTEM_NAME || "Sistema de Votación Isla del Sol";
}

function supportEmail() {
  return process.env.SUPPORT_EMAIL || process.env.SMTP_FROM || "Consejo Directivo";
}

function formatLima(dt) {
  if (!dt) return null;
  return new Date(dt).toLocaleString("es-PE", { timeZone: "America/Lima" });
}

function header() {
  return `${systemName()}\nConsejo Directivo\n`;
}

function footer() {
  return `Atentamente,\nConsejo Directivo\nIsla del Sol`;
}

function block(title, body) {
  if (!body) return "";
  return `${title}:\n${body}`;
}

function unitBlock(unitLabel) {
  return unitLabel ? block("Unidad / propiedad", unitLabel) + "\n\n" : "";
}

function safeSenderNote() {
  const from = process.env.SMTP_FROM || "votacion@isladelsol.org";
  return `Para no perder notificaciones importantes, agrega este remitente a tus contactos o lista segura:\n${from}\n\nSi no ves un correo esperado, revisa también la bandeja de Spam o Correo no deseado.`;
}

async function sendPlain({ to, subject, text }) {
  if (!canMail()) return false;
  const transport = makeTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text
  });
  return true;
}

export async function sendVoteLink({ to, link, electionTitle = "la campaña activa", voteOpenAt = null, voteCloseAt = null, unitLabel = null }) {
  return sendRegistrationApproved({ to, link, electionTitle, voteOpenAt, voteCloseAt, unitLabel });
}

export async function sendAdminInvite({ to, role, secret, loginUrl }) {
  return sendPlain({
    to,
    subject: `Acceso al panel - ${systemName()}`,
    text: `${header()}\nHola,\n\nSe creó un acceso para el panel administrativo.\n\n${block("Rol", role)}\n\n${block("Página de ingreso", loginUrl)}\n\n${block("Usuario", to)}\n\n${block("Clave temporal", secret)}\n\nGuarda estos datos en un lugar seguro.\n\n${footer()}`
  });
}

export async function sendRegistrationReceived({ to, name, electionTitle, unitLabel = null }) {
  return sendPlain({
    to,
    subject: `Solicitud recibida - ${electionTitle}`,
    text: `${header()}\nHola${name ? " " + name : ""},\n\nRecibimos tu solicitud de registro.\n\n${block("Campaña", electionTitle)}\n\n${unitBlock(unitLabel)}Tu solicitud queda pendiente de revisión por el Consejo Directivo. La aprobación no es automática.\n\nCuando sea aprobada, recibirás en este correo tu enlace personal de votación.\n\nCada enlace corresponde únicamente a la unidad indicada. Si representas más de una propiedad, debes registrar cada unidad por separado.\n\n${safeSenderNote()}\n\n${footer()}`
  });
}

export async function sendRegistrationApproved({ to, link, electionTitle, voteOpenAt = null, voteCloseAt = null, unitLabel = null }) {
  const openText = formatLima(voteOpenAt);
  const closeText = formatLima(voteCloseAt);
  const dates = [
    openText ? `Inicio: ${openText}` : null,
    closeText ? `Cierre: ${closeText}` : null
  ].filter(Boolean).join("\n");

  return sendPlain({
    to,
    subject: `Solicitud aprobada - ${electionTitle}`,
    text: `${header()}\nHola,\n\nTu solicitud fue aprobada.\n\n${block("Campaña", electionTitle)}\n\n${unitBlock(unitLabel)}${dates ? block("Horario de votación", dates) + "\n\n" : ""}Tu enlace personal de votación es:\n${link}\n\nGuarda este correo. El enlace es personal, único y solo puede usarse una vez.\n\nEste enlace corresponde únicamente a la unidad indicada.\n\nSi abres el enlace antes de la hora de inicio, el sistema te indicará que la votación todavía no empezó.\n\n${safeSenderNote()}\n\n${footer()}`
  });
}

export async function sendRegistrationRejected({ to, electionTitle, reason, unitLabel = null }) {
  return sendPlain({
    to,
    subject: `Solicitud revisada - ${electionTitle}`,
    text: `${header()}\nHola,\n\nTu solicitud de registro fue revisada y no fue aprobada.\n\n${block("Campaña", electionTitle)}\n\n${unitBlock(unitLabel)}${reason ? block("Motivo o nota", reason) + "\n\n" : ""}Para consultas, comunícate con el Consejo Directivo.\n\n${footer()}`
  });
}

export async function sendVotePendingReminder({ to, electionTitle, voteOpenAt = null, voteCloseAt = null, unitLabel = null }) {
  const openText = formatLima(voteOpenAt);
  const closeText = formatLima(voteCloseAt);
  const dates = [
    openText ? `Inicio: ${openText}` : null,
    closeText ? `Cierre: ${closeText}` : null
  ].filter(Boolean).join("\n");

  return sendPlain({
    to,
    subject: `Recordatorio de votación pendiente - ${electionTitle}`,
    text: `${header()}\nHola,\n\nTe recordamos que tienes una votación pendiente.\n\n${block("Campaña", electionTitle)}\n\n${unitBlock(unitLabel)}${dates ? block("Horario de votación", dates) + "\n\n" : ""}Para votar, usa el enlace personal que recibiste cuando tu solicitud fue aprobada.\n\nSi ya votaste hace pocos minutos, puedes ignorar este mensaje.\n\nSi no encuentras tu enlace personal, comunícate con el Consejo Directivo para que sea reemitido.\n\n${safeSenderNote()}\n\n${footer()}`
  });
}

export async function sendVoteReceipt({
  to,
  electionTitle,
  unitLabel,
  castAt,
  optionText,
  voteHash,
  receiptCode,
  verifyUrl,
  chainPosition
}) {
  const technical = [
    receiptCode ? block("Código de verificación", receiptCode) : null,
    verifyUrl ? block("Enlace para validar tu voto", verifyUrl) : null,
    voteHash ? block("Hash del voto", voteHash) : null,
    chainPosition ? block("Posición en cadena", String(chainPosition)) : null
  ].filter(Boolean).join("\n\n");

  return sendPlain({
    to,
    subject: `Recibo de voto registrado - ${electionTitle}`,
    text: `${header()}\nHola,\n\nTu voto fue registrado correctamente.\n\n${block("Campaña", electionTitle)}\n\n${unitBlock(unitLabel)}${block("Fecha y hora", castAt || new Date().toLocaleString("es-PE", { timeZone: "America/Lima" }))}\n\n${optionText ? block("Opción registrada", optionText) + "\n\n" : ""}Este es tu recibo de verificación.\n\n${technical}\n\nImportante:\nEste recibo no permite votar nuevamente ni modificar tu voto. Solo sirve para consultar el voto registrado en el sistema.\n\nPara validar tu voto, entra al enlace anterior e ingresa tu DNI/CE o correo electrónico.\n\n${footer()}`
  });
}

export async function sendElectionSealed({ to, electionTitle, resultsUrl, hashesText, resultsText = "" }) {
  const resultsBlock = resultsText ? block("Resultados", resultsText) + "\n\n" : "";
  return sendPlain({
    to,
    subject: `Resultados sellados - ${electionTitle}`,
    text: `${header()}\nHola,\n\nLa campaña fue cerrada y sellada correctamente.\n\n${block("Campaña", electionTitle)}\n\n${resultsBlock}${block("Resultados publicados", resultsUrl)}\n\n${block("Sello de integridad", hashesText)}\n\nEste sello permite verificar que los resultados no fueron modificados luego del cierre.\n\n${footer()}`
  });
}
