import crypto from "crypto";

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  const secret = process.env.TOKEN_SECRET || "";
  return crypto.createHash("sha256").update(token + secret).digest("hex");
}
