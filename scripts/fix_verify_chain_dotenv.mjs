import fs from "fs";

const file = "scripts/verify_chain.mjs";
let s = fs.readFileSync(file, "utf8");

if (!s.startsWith('import "dotenv/config";')) {
  s = 'import "dotenv/config";\n' + s;
  fs.writeFileSync(file, s);
  console.log("[OK] verify_chain loads .env");
} else {
  console.log("[OK] verify_chain already loads .env");
}
