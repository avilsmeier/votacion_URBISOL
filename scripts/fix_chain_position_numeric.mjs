import fs from "fs";

const serverFile = "src/server.js";
const verifyFile = "scripts/verify_chain.mjs";
let changed = false;

function patchFile(path, fn) {
  const before = fs.readFileSync(path, "utf8");
  const after = fn(before);
  if (after !== before) {
    fs.writeFileSync(path, after);
    changed = true;
    console.log("[OK] " + path);
  } else {
    console.log("[OK] " + path + " ya estaba aplicado o no matcheo");
  }
}

// pg devuelve int8/bigint como string. Si chain_position es bigint,
// "1" + 1 produce "11". Eso rompia la cadena despues del primer voto.
patchFile(serverFile, s => s.replaceAll(
  "const nextPos = (last?.chain_position ?? 0) + 1;",
  "const nextPos = Number(last?.chain_position ?? 0) + 1;"
));

// El verificador debe recomponer el payload con chain_position numerico,
// igual que lo genera el servidor.
patchFile(verifyFile, s => {
  let out = s;
  out = out.replaceAll(
    "chain_position: r.chain_position",
    "chain_position: Number(r.chain_position)"
  );
  return out;
});

console.log(changed ? "[OK] chain_position numeric fix aplicado" : "[OK] nada para aplicar");
