import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const electionId = Number(process.argv[2]);
const allowLegacyStoredHash = process.argv.includes("--allow-legacy-stored-hash");

if (!electionId) {
  console.error("Uso: node scripts/verify_chain.mjs <election_id> [--allow-legacy-stored-hash]");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

async function tableExists(table) {
  const r = await pool.query(`SELECT to_regclass($1) AS name`, [`public.${table}`]);
  return !!r.rows[0]?.name;
}

function castAtVariants(r) {
  const vals = [];
  if (r.cast_at !== undefined && r.cast_at !== null) vals.push(r.cast_at);
  if (r.cast_at instanceof Date) vals.push(r.cast_at.toISOString());
  if (r.cast_at_text) vals.push(r.cast_at_text);
  if (r.cast_at instanceof Date) vals.push(r.cast_at.toISOString().replace("T", " ").replace("Z", "+00"));

  const out = [];
  const seen = new Set();
  for (const v of vals) {
    const key = v instanceof Date ? `date:${v.toISOString()}` : `${typeof v}:${String(v)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out.length ? out : [r.cast_at];
}

function variantsForPayloads(payloads) {
  return Array.isArray(payloads) ? payloads : [{ name: "canonical", payload: payloads }];
}

async function verifyTable(table, payloadBuilder, kind) {
  if (!(await tableExists(table))) {
    console.log(`\n⚠️ Tabla ${table} no existe. Omitiendo ${kind}.`);
    return null;
  }

  console.log(`\n🔎 Verificando ${kind}...`);

  const rows = (await pool.query(
    `SELECT *, cast_at::text AS cast_at_text
     FROM ${table}
     WHERE election_id=$1
     ORDER BY chain_position ASC`,
    [electionId]
  )).rows;

  let prevHash = "GENESIS";
  let concatenated = "";
  let expectedPosition = 1;
  const formatsUsed = new Set();
  let legacyStoredHashCount = 0;

  for (const r of rows) {
    if (Number(r.chain_position) !== expectedPosition) {
      throw new Error(`❌ Posición inválida en ${kind}: esperado ${expectedPosition}, encontrado ${r.chain_position}`);
    }

    if (r.previous_hash !== prevHash) {
      throw new Error(`❌ Cadena rota en ${kind}, posición ${r.chain_position}: previous_hash no coincide`);
    }

    const candidates = variantsForPayloads(payloadBuilder(r, prevHash));
    let match = candidates.find(c => sha256Hex(JSON.stringify(c.payload)) === r.vote_hash);

    if (!match && allowLegacyStoredHash) {
      // Modo explícito para votos de prueba emitidos durante parches intermedios.
      // No valida recomputación del payload; solo valida posición, previous_hash y sello global.
      match = { name: "legacy_stored_hash_only", payload: null };
      legacyStoredHashCount++;
    }

    if (!match) {
      const debug = candidates.slice(0, 12).map(c => {
        const h = sha256Hex(JSON.stringify(c.payload));
        return `${c.name}: ${h}`;
      }).join("\n  ");
      throw new Error(`❌ Hash inválido en ${kind}, posición ${r.chain_position}. Hash guardado: ${r.vote_hash}\n  Probados:\n  ${debug}\n\nNota: si este voto fue emitido durante los parches de prueba previos a estabilización, puedes inspeccionarlo con:\n  node scripts/verify_chain.mjs ${electionId} --allow-legacy-stored-hash\nPara producción real, crea una campaña limpia y verifica sin ese flag.`);
    }

    formatsUsed.add(match.name);
    prevHash = r.vote_hash;
    concatenated += r.vote_hash;
    expectedPosition++;
  }

  const globalHash = sha256Hex(concatenated);

  const seal = (await pool.query(
    `SELECT global_hash
     FROM election_seals
     WHERE election_id=$1 AND kind=$2`,
    [electionId, kind]
  )).rows[0];

  if (!seal) {
    console.log("⚠️ No hay sello guardado para esta campaña/tipo.");
  } else if (seal.global_hash !== globalHash) {
    throw new Error(`❌ Hash global NO coincide con el sello para ${kind}.`);
  } else {
    console.log("✅ Hash global coincide con el sello.");
  }

  console.log("✔ Cadena íntegra.");
  console.log("Total votos:", rows.length);
  console.log("Formato hash:", Array.from(formatsUsed).join(", ") || "sin votos");
  if (legacyStoredHashCount) {
    console.log(`⚠️ ${legacyStoredHashCount} voto(s) verificado(s) en modo legacy_stored_hash_only.`);
    console.log("⚠️ Este modo NO recompone el payload del voto; solo sirve para campañas de prueba/transición.");
  }
  console.log("Global hash:", globalHash);
  return { kind, totalVotes: rows.length, globalHash, sealed: !!seal, formatsUsed: Array.from(formatsUsed), legacyStoredHashCount };
}

function councilPayloads(r, previous_hash) {
  return castAtVariants(r).map((cast_at, idx) => ({
    name: idx === 0 ? "canonical" : `canonical_cast_variant_${idx}`,
    payload: {
      election_id: r.election_id,
      unit_id: r.unit_id,
      candidate_id: r.candidate_id,
      token_id: r.token_id,
      cast_at,
      previous_hash,
      chain_position: r.chain_position
    }
  }));
}

function fiscalPayloads(r, previous_hash) {
  return castAtVariants(r).map((cast_at, idx) => ({
    name: idx === 0 ? "canonical" : `canonical_cast_variant_${idx}`,
    payload: {
      election_id: r.election_id,
      unit_id: r.unit_id,
      fiscal_list_id: r.fiscal_list_id,
      token_id: r.token_id,
      cast_at,
      previous_hash,
      chain_position: r.chain_position
    }
  }));
}

function referendumPayloads(r, previous_hash) {
  const out = [];
  for (const [idx, cast_at] of castAtVariants(r).entries()) {
    const suffix = idx === 0 ? "" : `_cast_variant_${idx}`;

    out.push({
      name: `canonical${suffix}`,
      payload: {
        election_id: r.election_id,
        unit_id: r.unit_id,
        question_id: r.question_id,
        option_id: r.option_id,
        token_id: r.token_id,
        cast_at,
        previous_hash,
        chain_position: r.chain_position
      }
    });

    out.push({
      name: `legacy_no_question_id${suffix}`,
      payload: {
        election_id: r.election_id,
        unit_id: r.unit_id,
        option_id: r.option_id,
        token_id: r.token_id,
        cast_at,
        previous_hash,
        chain_position: r.chain_position
      }
    });

    out.push({
      name: `legacy_sql_column_order${suffix}`,
      payload: {
        election_id: r.election_id,
        question_id: r.question_id,
        option_id: r.option_id,
        unit_id: r.unit_id,
        token_id: r.token_id,
        cast_at,
        previous_hash,
        chain_position: r.chain_position
      }
    });

    out.push({
      name: `legacy_no_cast_at${suffix}`,
      payload: {
        election_id: r.election_id,
        unit_id: r.unit_id,
        question_id: r.question_id,
        option_id: r.option_id,
        token_id: r.token_id,
        previous_hash,
        chain_position: r.chain_position
      }
    });

    out.push({
      name: `legacy_no_question_no_cast_at${suffix}`,
      payload: {
        election_id: r.election_id,
        unit_id: r.unit_id,
        option_id: r.option_id,
        token_id: r.token_id,
        previous_hash,
        chain_position: r.chain_position
      }
    });
  }
  return out;
}

(async () => {
  try {
    const election = (await pool.query(`SELECT id, title, kind FROM elections WHERE id=$1`, [electionId])).rows[0];
    if (!election) throw new Error(`No existe campaña/election_id=${electionId}`);

    console.log(`Campaña: ${election.title}`);
    console.log(`Tipo: ${election.kind || "ELECCION"}`);

    if (allowLegacyStoredHash) {
      console.log("⚠️ Modo legacy habilitado. Usar solo para campañas de prueba/transición.");
    }

    if (election.kind === "VOTACION") {
      await verifyTable("referendum_votes", referendumPayloads, "REFERENDUM");
    } else {
      await verifyTable("votes", councilPayloads, "COUNCIL");
      await verifyTable("fiscal_votes", fiscalPayloads, "FISCAL");
    }

    console.log("\n🎉 Verificación completa. Todo consistente.");
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
