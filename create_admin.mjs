import "dotenv/config";
import bcrypt from "bcrypt";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const email = process.argv[2];
const pass = process.argv[3];
const role = process.argv[4] || "admin";

if (!email || !pass) {
  console.log("Uso: node create_admin.mjs email password [admin|viewer]");
  process.exit(1);
}

const hash = await bcrypt.hash(pass, 12);
await pool.query(
  `INSERT INTO admin_users(email, password_hash, role)
   VALUES ($1,$2,$3)
   ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role`,
  [email.toLowerCase(), hash, role]
);

console.log("OK");
await pool.end();
