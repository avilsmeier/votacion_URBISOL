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
  return process.env.SUPPORT_EMAIL || process.env.SMTP_FROM || "Comité Electoral";
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

export async function sendVoteLink({ to, link, electionTitle = "la campaña activa" }) {
  return sendRegistrationApproved({ to, link, electionTitle });
}

export async function sendAdminInvite({ to, role, secret, loginUrl }) {
  return sendPlain({
    to,
    subject: `Acceso al panel - ${systemName()}`,
    text: `Hola,\n\nSe creó un acceso para el panel administrativo de ${systemName()}.\n\nRol: ${role}\nURL: ${loginUrl}\nUsuario: ${to}\nClave temporal: ${secret}\n\nPor seguridad, guarda estos datos y cambia la clave si corresponde.\n\n${supportEmail()}`
  });
}

export async function sendRegistrationReceived({ to, name, electionTitle }) {
  return sendPlain({
    to,
    subject: `Solicitud recibida - ${electionTitle}`,
    text: `Hola${name ? " " + name : ""},\n\nRecibimos tu solicitud de registro para:\n${electionTitle}\n\nTu solicitud queda pendiente de revisión por el comité. La aprobación no es automática.\n\nCuando sea aprobada, recibirás un enlace único de votación en este correo.\n\n${supportEmail()}`
  });
}

export async function sendRegistrationApproved({ to, link, electionTitle }) {
  return sendPlain({
    to,
    subject: `Enlace único de votación - ${electionTitle}`,
    text: `Hola,\n\nTu solicitud fue aprobada para:\n${electionTitle}\n\nEnlace único de votación:\n${link}\n\nEste enlace es personal y de uso único. Guárdalo y verifica que puedes abrirlo antes de la ventana de votación.\n\n${supportEmail()}`
  });
}

export async function sendRegistrationRejected({ to, electionTitle, reason }) {
  return sendPlain({
    to,
    subject: `Solicitud revisada - ${electionTitle}`,
    text: `Hola,\n\nTu solicitud de registro para:\n${electionTitle}\n\nNo fue aprobada por el comité.\n${reason ? "\nMotivo/nota: " + reason + "\n" : ""}\nPara consultas, comunícate con el comité.\n\n${supportEmail()}`
  });
}

export async function sendVoteReceipt({ to, electionTitle, castAt }) {
  return sendPlain({
    to,
    subject: `Voto registrado - ${electionTitle}`,
    text: `Hola,\n\nTu voto fue registrado correctamente para:\n${electionTitle}\n\nFecha/hora: ${castAt || new Date().toLocaleString("es-PE", { timeZone: "America/Lima" })}\n\nEste mensaje confirma la recepción del voto. No incluye ni revela la opción elegida.\n\n${supportEmail()}`
  });
}

export async function sendElectionSealed({ to, electionTitle, resultsUrl, hashesText }) {
  return sendPlain({
    to,
    subject: `Resultados sellados - ${electionTitle}`,
    text: `Hola,\n\nLa campaña fue cerrada y sellada:\n${electionTitle}\n\nResultados:\n${resultsUrl}\n\nSellos/hash de integridad:\n${hashesText}\n\nEstos hashes permiten verificar que los resultados no fueron modificados luego del sellado.\n\n${supportEmail()}`
  });
}
