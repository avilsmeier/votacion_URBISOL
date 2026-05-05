import fs from "fs";

const file = "src/server.js";
let s = fs.readFileSync(file, "utf8");

if (s.includes("SECURITY_HEADERS_PROD_GUARD")) {
  console.log("[OK] security headers ya estaban aplicados");
  process.exit(0);
}

const marker = '// Cloudflare/Nginx proxy\napp.set("trust proxy", 1);';
const idx = s.indexOf(marker);
if (idx < 0) throw new Error("No encontre bloque trust proxy para insertar security headers");

const insertAt = idx + marker.length;
const block = `

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
});`;

s = s.slice(0, insertAt) + block + s.slice(insertAt);
fs.writeFileSync(file, s);
console.log("[OK] security headers aplicados");
