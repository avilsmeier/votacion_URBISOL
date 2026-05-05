import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const electionId = Number(process.argv[2]);
if (!electionId) {
  console.error("Uso: node scripts/verify_chain.mjs <election_id>");
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

async function verifyTable(table, payloadBuilder, kind) {
  if (!(await tableExists(table))) {
    console.log(`\n⚠️ Tabla ${table} no existe. Omitiendo ${kind}.`);
    return null;
  }

  console.log(`\n🔎 Verificando ${kind}...`);

  const rows = (await pool.query(
    `SELECT *
     FROM ${table}
     WHERE election_id=$1
     ORDER BY chain_position ASC`,
    [electionId]
  )).rows;

  let prevHash = "GENESIS";
  let concatenated = "";
  let expectedPosition = 1;

  for (const r of rows) {
    if (Number(r.chain_position) !== expectedPosition) {
      throw new Error(`❌ Posición inválida en ${kind}: esperado ${expectedPosition}, encontrado ${r.chain_position}`);
    }

    if (r.previous_hash !== prevHash) {
      throw new Error(`❌ Cadena rota en ${kind}, posición ${r.chain_position}: previous_hash no coincide`);
    }

    const payload = payloadBuilder(r, prevHash);
    const expectedHash = sha256Hex(JSON.stringify(payload));

    if (expectedHash !== r.vote_hash) {
      throw new Error(`❌ Hash inválido en ${kind}, posición ${r.chain_position}`);
    }

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
  console.log("Global hash:", globalHash);
  return { kind, totalVotes: rows.length, globalHash, sealed: !!seal };
}

(async () => {
  try {
    const election = (await pool.query(`SELECT id, title, kind FROM elections WHERE id=$1`, [electionId])).rows[0];
    if (!election) throw new Error(`No existe campaña/election_id=${electionId}`);

    console.log(`Campaña: ${election.title}`);
    console.log(`Tipo: ${election.kind || "ELECCION"}`);

    if (election.kind === "VOTACION") {
      await verifyTable(
        "referendum_votes",
        (r, previous_hash) => ({
          election_id: r.election_id,
          unit_id: r.unit_id,
          question_id: r.question_id,
          option_id: r.option_id,
          token_id: r.token_id,
          cast_at: r.cast_at,
          previous_hash,
          chain_position: r.chain_position
        }),
        "REFERENDUM"
      );
    } else {
      await verifyTable(
        "votes",
        (r, previous_hash) => ({
          election_id: r.election_id,
          unit_id: r.unit_id,
          candidate_id: r.candidate_id,
          token_id: r.token_id,
          cast_at: r.cast_at,
          previous_hash,
          chain_position: r.chain_position
        }),
        "COUNCIL"
      );

      await verifyTable(
        "fiscal_votes",
        (r, previous_hash) => ({
          election_id: r.election_id,
          unit_id: r.unit_id,
          fiscal_list_id: r.fiscal_list_id,
          token_id: r.token_id,
          cast_at: r.cast_at,
          previous_hash,
          chain_position: r.chain_position
        }),
        "FISCAL"
      );
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
