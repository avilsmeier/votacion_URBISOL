import fs from "fs";
import path from "path";

const serverFile = "src/server.js";
const registerViewFile = "src/views/register.ejs";
const jsFile = "public/js/register-submit-guard.js";

fs.mkdirSync(path.dirname(jsFile), { recursive: true });
fs.writeFileSync(jsFile, `document.addEventListener("DOMContentLoaded", function () {
  var form = document.querySelector('form[action="/registro"]');
  if (!form) return;

  form.addEventListener("submit", function (event) {
    if (form.dataset.submitting === "true") {
      event.preventDefault();
      return false;
    }

    form.dataset.submitting = "true";

    var button = form.querySelector('button[type="submit"], button:not([type])');
    if (button) {
      button.disabled = true;
      button.textContent = "Enviando...";
      button.setAttribute("aria-busy", "true");
    }
  });
});
`);

let server = fs.readFileSync(serverFile, "utf8");
if (!server.includes("REGISTER_SUBMIT_GUARD_STATIC")) {
  const marker = "app.use(express.json());";
  const idx = server.indexOf(marker);
  if (idx < 0) throw new Error("No encontre app.use(express.json())");
  const insertAt = idx + marker.length;
  server = server.slice(0, insertAt) + `\n\n// REGISTER_SUBMIT_GUARD_STATIC\napp.use("/public", express.static(path.resolve("public"), { etag: true, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));` + server.slice(insertAt);
  fs.writeFileSync(serverFile, server);
  console.log("[OK] /public static habilitado");
} else {
  console.log("[OK] /public static ya estaba habilitado");
}

let view = fs.readFileSync(registerViewFile, "utf8");
if (!view.includes('/public/js/register-submit-guard.js')) {
  view = view.replace(
    "      </form>",
    "      </form>\n      <script src=\"/public/js/register-submit-guard.js\" defer></script>"
  );
  fs.writeFileSync(registerViewFile, view);
  console.log("[OK] guard cargado solo en /registro");
} else {
  console.log("[OK] guard ya estaba cargado en /registro");
}

console.log("[OK] patch aplicado: boton de registro se desactiva al enviar");
