import nodemailer from "nodemailer";

export function canMail() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

export async function sendVoteLink({ to, link }) {
  if (!canMail()) return false;
  const transport = makeTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: "Enlace único de votación (uso único)",
    text: `Hola,\n\nAquí está tu enlace único para votar:\n${link}\n\nEste enlace es de uso único.\n\nComité Electoral`
  });
  return true;
}
