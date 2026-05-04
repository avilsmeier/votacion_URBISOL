import fs from 'fs';

const file = 'src/server.js';
let s = fs.readFileSync(file, 'utf8');

let changed = false;

const replacements = [
  [
    'landing no active',
    'if (!election) return res.status(500).send("No hay elección activa configurada.");',
    'if (!election) return res.render("no_active");'
  ],
  [
    'registro no active',
    'if (!election) return res.status(500).send("No hay elección activa.");',
    'if (!election) return res.render("no_active");'
  ]
];

for (const [label, from, to] of replacements) {
  if (s.includes(to)) continue;
  if (!s.includes(from)) {
    console.warn(`[WARN] No encontre bloque para ${label}.`);
    continue;
  }
  s = s.replace(from, to);
  changed = true;
}

if (changed) {
  fs.writeFileSync(file, s);
  console.log('[OK] no_active landing patch aplicado');
} else {
  console.log('[OK] no_active landing patch ya estaba aplicado');
}
