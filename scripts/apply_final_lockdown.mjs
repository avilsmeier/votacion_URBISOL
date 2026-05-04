import fs from "fs";

const serverFile = "src/server.js";
const noActiveFile = "src/views/no_active.ejs";
let s = fs.readFileSync(serverFile, "utf8");
let changed = false;

function patch(label, fn) {
  const before = s;
  s = fn(s);
  if (s !== before) {
    changed = true;
    console.log("[OK] " + label);
  } else {
    console.log("[OK] " + label + " ya estaba aplicado o no matcheo");
  }
}

// Hotfix por si una corrida previa dejo el regex sin escapes.
patch("fix malformed close regex", txt => txt.replace(
  '/^/admin/elections/d+/close$/.test(req.path)',
  'new RegExp("^/admin/elections/\\\\d+/close$").test(req.path)'
));

// 1) Importar handler modular de acta.
patch("import actaPdf modular", txt => {
  if (txt.includes('import { createActaPdfHandler } from "./actaPdf.js";')) return txt;
  return txt.replace(
    'import { requireAdmin, requireViewerOrAdmin } from "./middleware.js";',
    'import { requireAdmin, requireViewerOrAdmin } from "./middleware.js";\nimport { createActaPdfHandler } from "./actaPdf.js";'
  );
});

// 2) Helpers de sellado, si aun no existen.
patch("sealed helpers", txt => {
  if (txt.includes("async function isElectionSealed")) return txt;
  return txt.replace(
    'async function getActiveElection() {\n  const r = await q(`SELECT * FROM elections WHERE is_active=true LIMIT 1`);\n  return r.rows[0] || null;\n}',
    'async function getActiveElection() {\n  const r = await q(`SELECT * FROM elections WHERE is_active=true LIMIT 1`);\n  return r.rows[0] || null;\n}\n\nasync function isElectionSealed(electionId) {\n  const r = await q(`SELECT 1 FROM election_seals WHERE election_id=$1 LIMIT 1`, [electionId]);\n  return r.rows.length > 0;\n}\n\nasync function getLatestFinishedElection() {\n  return (await q(`SELECT * FROM elections WHERE is_active=false ORDER BY id DESC LIMIT 1`)).rows[0] || null;\n}'
  );
});

// 3) Middleware global: si campaña activa está sellada, no se permite ningún POST mutante salvo logout, desactivar, verificar/notificar sellos.
const lockdownBlock = `// Bloqueo global post-sellado: una campaña sellada queda congelada.
app.use(async (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();

  const allow =
    req.path === "/admin/logout" ||
    req.path === "/admin/verify" ||
    req.path === "/admin/notifications/sealed" ||
    new RegExp("^/admin/elections/\\\\d+/close$").test(req.path);

  if (allow) return next();

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
});`;

patch("global sealed lockdown middleware", txt => {
  if (txt.includes("Bloqueo global post-sellado")) return txt;
  return txt.replace(
    'app.use(rateLimit({\n  windowMs: 60_000,\n  limit: 180,\n  standardHeaders: "draft-7",\n  legacyHeaders: false\n}));',
    'app.use(rateLimit({\n  windowMs: 60_000,\n  limit: 180,\n  standardHeaders: "draft-7",\n  legacyHeaders: false\n}));\n\n' + lockdownBlock
  );
});

// 4) Reemplazar handler /admin/acta.pdf por el modular robusto.
patch("modular acta handler", txt => {
  if (txt.includes("createActaPdfHandler({") && txt.includes('app.get(\n  "/admin/acta.pdf"')) return txt;
  const re = /app\.get\("\/admin\/acta\.pdf", requireViewerOrAdmin, async \(req, res\) => \{[\s\S]*?\n\}\);\n\napp\.get\("\/admin\/padron_v2\.pdf"/;
  const replacement = `app.get(
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

app.get("/admin/padron_v2.pdf"`;
  if (!re.test(txt)) return txt;
  return txt.replace(re, replacement);
});

// 5) Home sin campaña activa: publicar enlace a última campaña cerrada si existe.
patch("home latest inactive results", txt => {
  if (txt.includes("latestFinished")) return txt;
  return txt.replace(
    '  const election = await getActiveElection();\n  if (!election) return res.render("no_active");',
    '  const election = await getActiveElection();\n  if (!election) {\n    const latestFinished = await getLatestFinishedElection();\n    return res.render("no_active", { latestFinished });\n  }'
  );
});

fs.writeFileSync(serverFile, s);

// 6) Vista no_active con resultados históricos si hay última campaña.
if (fs.existsSync(noActiveFile)) {
  const newView = `<%- include('layout', { title: "Sistema de Votación", body: \`
  <div class="card">
    <h2>Sistema de Votación Isla del Sol</h2>
    <p>No hay una campaña activa en este momento.</p>

    \${typeof latestFinished !== "undefined" && latestFinished ? \`
      <p class="muted">La última campaña cerrada fue:</p>
      <p><b>\${latestFinished.title}</b></p>
      <div class="row" style="margin-top:14px">
        <a href="/resultados/\${latestFinished.id}"><button class="ok">Ver resultados publicados</button></a>
        <a href="/admin/login"><button>Ingresar como administrador</button></a>
      </div>
    \` : \`
      <p class="muted">Puedes ingresar al panel administrativo para crear o activar una campaña.</p>
      <div class="row" style="margin-top:14px">
        <a href="/admin/login"><button class="ok">Ingresar como administrador</button></a>
      </div>
    \`}
  </div>
\` }) %>
`;
  const oldView = fs.readFileSync(noActiveFile, "utf8");
  if (oldView !== newView) {
    fs.writeFileSync(noActiveFile, newView);
    changed = true;
    console.log("[OK] no_active muestra última campaña cerrada");
  }
}

console.log(changed ? "[OK] lockdown final aplicado" : "[OK] lockdown final ya estaba aplicado");
