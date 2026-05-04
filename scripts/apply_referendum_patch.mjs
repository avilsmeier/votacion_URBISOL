import fs from 'fs';

const file = 'src/server.js';
let s = fs.readFileSync(file, 'utf8');

function mustReplace(label, search, replacement) {
  if (!s.includes(search)) throw new Error(`No encontre bloque: ${label}`);
  s = s.replace(search, replacement);
}

function mustReplaceRegex(label, regex, replacement) {
  if (!regex.test(s)) throw new Error(`No encontre bloque regex: ${label}`);
  s = s.replace(regex, replacement);
}

mustReplace(
  'lockElectionChain REFERENDUM namespace',
`async function lockElectionChain(client, electionId, kind /* 'COUNCIL'|'FISCAL' */) {
  // 1 y 2 son "namespaces" simples para separar cadenas
  const ns = kind === "FISCAL" ? 2 : 1;
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [ns, electionId]);
}`,
`async function lockElectionChain(client, electionId, kind /* 'COUNCIL'|'FISCAL'|'REFERENDUM' */) {
  const ns = kind === "FISCAL" ? 2 : (kind === "REFERENDUM" ? 3 : 1);
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [ns, electionId]);
}`
);

mustReplace(
  'insert referendum chained helper',
`async function insertFiscalVoteChained(client, {
  election_id,
  unit_id,
  fiscal_list_id,
  token_id,
  ip,
  user_agent
}) {
  await lockElectionChain(client, election_id, "FISCAL");

  const last = (await client.query(
    \`SELECT chain_position, vote_hash
     FROM fiscal_votes
     WHERE election_id=$1
     ORDER BY chain_position DESC NULLS LAST, cast_at DESC, id DESC
     LIMIT 1\`,
    [election_id]
  )).rows[0];

  const nextPos = (last?.chain_position ?? 0) + 1;
  const previous_hash = last?.vote_hash ?? "GENESIS";
  const cast_at = (await client.query("SELECT now() AS t")).rows[0].t;

  const payload = {
    election_id,
    unit_id,
    fiscal_list_id,
    token_id,
    cast_at,
    previous_hash,
    chain_position: nextPos
  };

  const vote_hash = sha256Hex(JSON.stringify(payload));

  const ins = await client.query(
    \`INSERT INTO fiscal_votes (
       election_id, unit_id, fiscal_list_id, token_id, cast_at, ip, user_agent,
       chain_position, previous_hash, vote_hash
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id\`,
    [
      election_id, unit_id, fiscal_list_id, token_id, cast_at, ip, user_agent,
      nextPos, previous_hash, vote_hash
    ]
  );

  return { id: ins.rows[0].id, chain_position: nextPos, previous_hash, vote_hash, cast_at };
}`,
`async function insertFiscalVoteChained(client, {
  election_id,
  unit_id,
  fiscal_list_id,
  token_id,
  ip,
  user_agent
}) {
  await lockElectionChain(client, election_id, "FISCAL");

  const last = (await client.query(
    \`SELECT chain_position, vote_hash
     FROM fiscal_votes
     WHERE election_id=$1
     ORDER BY chain_position DESC NULLS LAST, cast_at DESC, id DESC
     LIMIT 1\`,
    [election_id]
  )).rows[0];

  const nextPos = (last?.chain_position ?? 0) + 1;
  const previous_hash = last?.vote_hash ?? "GENESIS";
  const cast_at = (await client.query("SELECT now() AS t")).rows[0].t;

  const payload = {
    election_id,
    unit_id,
    fiscal_list_id,
    token_id,
    cast_at,
    previous_hash,
    chain_position: nextPos
  };

  const vote_hash = sha256Hex(JSON.stringify(payload));

  const ins = await client.query(
    \`INSERT INTO fiscal_votes (
       election_id, unit_id, fiscal_list_id, token_id, cast_at, ip, user_agent,
       chain_position, previous_hash, vote_hash
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id\`,
    [
      election_id, unit_id, fiscal_list_id, token_id, cast_at, ip, user_agent,
      nextPos, previous_hash, vote_hash
    ]
  );

  return { id: ins.rows[0].id, chain_position: nextPos, previous_hash, vote_hash, cast_at };
}

async function insertReferendumVoteChained(client, {
  election_id,
  unit_id,
  question_id,
  option_id,
  token_id,
  ip,
  user_agent
}) {
  await lockElectionChain(client, election_id, "REFERENDUM");

  const last = (await client.query(
    \`SELECT chain_position, vote_hash
     FROM referendum_votes
     WHERE election_id=$1
     ORDER BY chain_position DESC NULLS LAST, cast_at DESC, id DESC
     LIMIT 1\`,
    [election_id]
  )).rows[0];

  const nextPos = (last?.chain_position ?? 0) + 1;
  const previous_hash = last?.vote_hash ?? "GENESIS";
  const cast_at = (await client.query("SELECT now() AS t")).rows[0].t;

  const payload = { election_id, unit_id, question_id, option_id, token_id, cast_at, previous_hash, chain_position: nextPos };
  const vote_hash = sha256Hex(JSON.stringify(payload));

  const ins = await client.query(
    \`INSERT INTO referendum_votes (
       election_id, question_id, option_id, unit_id, token_id, cast_at, ip, user_agent,
       chain_position, previous_hash, vote_hash
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id\`,
    [election_id, question_id, option_id, unit_id, token_id, cast_at, ip, user_agent, nextPos, previous_hash, vote_hash]
  );

  return { id: ins.rows[0].id, chain_position: nextPos, previous_hash, vote_hash, cast_at };
}`
);

mustReplace(
  'computeGlobalHash table',
`async function computeGlobalHash(client, electionId, kind /* 'COUNCIL' | 'FISCAL' */) {
  const table = kind === "FISCAL" ? "fiscal_votes" : "votes";`,
`async function computeGlobalHash(client, electionId, kind /* 'COUNCIL' | 'FISCAL' | 'REFERENDUM' */) {
  const table = kind === "FISCAL" ? "fiscal_votes" : (kind === "REFERENDUM" ? "referendum_votes" : "votes");`
);

mustReplaceRegex(
  'seal route',
/app\.post\("\/admin\/seal", requireAdmin, async \(req, res\) => \{[\s\S]*?\n\}\);\n\napp\.get\("\/admin\/verify"/,
`app.post("/admin/seal", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(400).send("No hay elección activa.");

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1, $2)", [99, election.id]);

    let council = null;
    let fiscal = null;
    let referendum = null;

    if (election.kind === "VOTACION") {
      referendum = await computeGlobalHash(c, election.id, "REFERENDUM");
      await c.query(
        \`INSERT INTO election_seals (election_id, kind, global_hash, total_votes, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (election_id, kind) DO NOTHING\`,
        [election.id, "REFERENDUM", referendum.globalHash, referendum.totalVotes, req.session.admin.id]
      );
    } else {
      council = await computeGlobalHash(c, election.id, "COUNCIL");
      await c.query(
        \`INSERT INTO election_seals (election_id, kind, global_hash, total_votes, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (election_id, kind) DO NOTHING\`,
        [election.id, "COUNCIL", council.globalHash, council.totalVotes, req.session.admin.id]
      );

      fiscal = await computeGlobalHash(c, election.id, "FISCAL");
      await c.query(
        \`INSERT INTO election_seals (election_id, kind, global_hash, total_votes, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (election_id, kind) DO NOTHING\`,
        [election.id, "FISCAL", fiscal.globalHash, fiscal.totalVotes, req.session.admin.id]
      );
    }

    await c.query("COMMIT");

    await audit("ELECTION_SEALED", {
      actor_admin_id: req.session.admin.id,
      election_id: election.id,
      meta_json: { council, fiscal, referendum }
    });

    return res.render("seal_result", { election, council, fiscal, referendum });
  } catch (e) {
    await c.query("ROLLBACK");
    console.error(e);
    return res.status(500).send("Error sellando elección.");
  } finally {
    c.release();
  }
});

app.get("/admin/verify"`
);

mustReplaceRegex(
  'verify post route',
/app\.post\("\/admin\/verify", requireViewerOrAdmin, async \(req, res\) => \{[\s\S]*?\n\}\);\n\n\nconst STREETS/,
`app.post("/admin/verify", requireViewerOrAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");

  const external = String(req.body?.external_hash || "").trim() || null;
  const c = await pool.connect();
  try {
    const seals = (await c.query(
      \`SELECT kind, global_hash FROM election_seals WHERE election_id=$1\`,
      [election.id]
    )).rows;

    let computed = "";
    let match = false;

    if (election.kind === "VOTACION") {
      const referendum = await computeGlobalHash(c, election.id, "REFERENDUM");
      const seal = seals.find(s => s.kind === "REFERENDUM")?.global_hash || null;
      computed = \`REFERENDUM: \${referendum.globalHash}\`;
      match = external ? external === referendum.globalHash : !!seal && seal === referendum.globalHash;
      await audit("VERIFY_RUN", { actor_admin_id: req.session.admin?.id ?? null, election_id: election.id, meta_json: { external_hash: external, referendum_hash: referendum.globalHash, seal_referendum: seal, match }});
    } else {
      const council = await computeGlobalHash(c, election.id, "COUNCIL");
      const fiscal  = await computeGlobalHash(c, election.id, "FISCAL");
      const sealCouncil = seals.find(s => s.kind === "COUNCIL")?.global_hash || null;
      const sealFiscal  = seals.find(s => s.kind === "FISCAL")?.global_hash || null;
      computed = \`COUNCIL: \${council.globalHash}\\nFISCAL: \${fiscal.globalHash}\`;
      match = external ? (external === council.globalHash || external === fiscal.globalHash) : (!!sealCouncil && sealCouncil === council.globalHash && !!sealFiscal && sealFiscal === fiscal.globalHash);
      await audit("VERIFY_RUN", { actor_admin_id: req.session.admin?.id ?? null, election_id: election.id, meta_json: { external_hash: external, council_hash: council.globalHash, fiscal_hash: fiscal.globalHash, seal_council: sealCouncil, seal_fiscal: sealFiscal, match }});
    }

    res.render("verify", { result: { computed, match } });
  } catch (e) {
    console.error(e);
    res.status(500).send("Error verificando.");
  } finally {
    c.release();
  }
});


const STREETS`
);

mustReplace(
  'referendum helper after council lists',
`  return lists.map(l => ({ ...l, members: bySlate.get(l.id) || [] }));
}`,
`  return lists.map(l => ({ ...l, members: bySlate.get(l.id) || [] }));
}

async function getReferendumForElection(electionId) {
  const question = (await q(
    \`SELECT * FROM referendum_questions WHERE election_id=$1 ORDER BY sort_order ASC, id ASC LIMIT 1\`,
    [electionId]
  )).rows[0] || null;
  if (!question) return { question: null, options: [] };
  const options = (await q(
    \`SELECT * FROM referendum_options WHERE election_id=$1 AND question_id=$2 ORDER BY sort_order ASC, id ASC\`,
    [electionId, question.id]
  )).rows;
  return { question, options };
}`
);

mustReplace(
  'landing vote metrics',
`    votes: (await q(\`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1\`, [election.id])).rows[0].n`,
`    votes: (await q(election.kind === "VOTACION" ? \`SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1\` : \`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1\`, [election.id])).rows[0].n`
);

mustReplaceRegex(
  'get votar token route',
/app\.get\("\/votar\/:token", async \(req, res\) => \{[\s\S]*?\n\}\);\n\n\napp\.post\("\/votar\/:token"/,
`app.get("/votar/:token", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");

  const tokenHash = hashToken(req.params.token);
  const t = await q(
    \`SELECT vt.*, r.name AS registrant_name
     FROM vote_tokens vt
     JOIN registrations r ON r.id = vt.registration_id
     WHERE vt.token_hash=$1 AND vt.election_id=$2\`,
    [tokenHash, election.id]
  );
  if (!t.rows.length) return res.status(404).send("Enlace inválido.");
  const vt = t.rows[0];

  const n = now();
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);

  if (election.kind === "VOTACION") {
    const { question, options } = await getReferendumForElection(election.id);
    if (!question || !options.length) return res.status(400).send("Votación interna sin pregunta/opciones configuradas.");

    if (!voteOpen) return res.render("vote_referendum", { election, token: req.params.token, question, options });

    const hasVote = (await q(
      \`SELECT 1 FROM referendum_votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1\`,
      [election.id, vt.unit_id]
    )).rows.length > 0;

    if (vt.status !== "ACTIVE" || hasVote) {
      if (vt.status === "ACTIVE") await q(\`UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1\`, [vt.id]);
      return res.render("vote_used", { election });
    }

    return res.render("vote_referendum", { election, token: req.params.token, question, options });
  }

  const councilLists = await getCouncilListsWithMembers(election.id);
  const fiscalLists = (await q(
    \`SELECT id, name, titular_name, titular_dni, suplente_name, suplente_dni
     FROM fiscal_lists
     WHERE election_id=$1
     ORDER BY sort_order ASC, id ASC\`,
    [election.id]
  )).rows;

  if (!voteOpen) return res.render("vote_preview", { election, token: req.params.token, councilLists, fiscalLists });

  const hasCouncil = (await q(\`SELECT 1 FROM votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1\`, [election.id, vt.unit_id])).rows.length > 0;
  const hasFiscal = (await q(\`SELECT 1 FROM fiscal_votes WHERE election_id=$1 AND unit_id=$2 LIMIT 1\`, [election.id, vt.unit_id])).rows.length > 0;

  if (hasCouncil && hasFiscal) {
    if (vt.status === "ACTIVE") await q(\`UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1\`, [vt.id]);
    return res.render("vote_used", { election });
  }

  if (!hasCouncil) return res.render("vote_council", { election, token: req.params.token, councilLists });
  return res.render("vote_fiscal", { election, token: req.params.token, fiscalLists });
});


app.post("/votar/:token"`
);

mustReplaceRegex(
  'post referendum before resultados',
/\/\* =========================\n   RESULTADOS PÚBLICOS \(histórico\)\n========================= \*\//,
`app.post("/votar/:token/referendum", async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay elección activa.");
  if (election.kind !== "VOTACION") return res.status(400).send("Esta campaña no es una votación interna.");

  const n = now();
  const voteOpen = inWindow(n, election.vote_open_at, election.vote_close_at);
  if (!voteOpen) return res.render("closed", { election });

  const option_id = Number(req.body.option_id);
  if (!option_id) return res.status(400).send("Elige una opción.");

  const { question, options } = await getReferendumForElection(election.id);
  if (!question || !options.some(o => Number(o.id) === option_id)) return res.status(400).send("Opción inválida.");

  const tokenHash = hashToken(req.params.token);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const t = await c.query(\`SELECT * FROM vote_tokens WHERE token_hash=$1 AND election_id=$2 FOR UPDATE\`, [tokenHash, election.id]);
    if (!t.rows.length) { await c.query("ROLLBACK"); return res.status(404).send("Enlace inválido."); }
    const vt = t.rows[0];
    if (vt.status !== "ACTIVE") { await c.query("ROLLBACK"); return res.render("vote_used", { election }); }

    await insertReferendumVoteChained(c, {
      election_id: election.id,
      unit_id: vt.unit_id,
      question_id: question.id,
      option_id,
      token_id: vt.id,
      ip: getReqIp(req),
      user_agent: getUserAgent(req)
    });

    await c.query(\`UPDATE vote_tokens SET status='USED', used_at=NOW() WHERE id=$1\`, [vt.id]);
    await c.query("COMMIT");

    await audit("REFERENDUM_VOTE_CAST", { election_id: election.id, unit_id: vt.unit_id, token_id: vt.id, meta_json: { question_id: question.id, option_id }});
    return res.render("vote_done", { election });
  } catch (e) {
    await c.query("ROLLBACK");
    if (String(e?.code) === "23505") return res.render("vote_used", { election });
    console.error(e);
    return res.status(500).send("Error registrando voto.");
  } finally {
    c.release();
  }
});

/* =========================
   RESULTADOS PÚBLICOS (histórico)
========================= */`
);

mustReplaceRegex(
  'public results route',
/app\.get\("\/resultados\/:electionId", async \(req, res\) => \{[\s\S]*?\n\}\);\n\n\/\* =========================\n   ADMIN: LOGIN/,
`app.get("/resultados/:electionId", async (req, res) => {
  const electionId = Number(req.params.electionId);
  const election = (await q(\`SELECT * FROM elections WHERE id=$1\`, [electionId])).rows[0];
  if (!election) return res.status(404).send("Campaña no existe.");

  let totals;
  let metrics;
  if (election.kind === "VOTACION") {
    totals = (await q(
      \`SELECT ro.option_label AS list_code, ro.option_text AS name, COUNT(rv.id)::int AS votes
       FROM referendum_options ro
       LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
       WHERE ro.election_id=$1
       GROUP BY ro.id
       ORDER BY ro.sort_order ASC, ro.id ASC\`,
      [electionId]
    )).rows;
    metrics = {
      votes: (await q(\`SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1\`, [electionId])).rows[0].n,
      approved_regs: (await q(\`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'\`, [electionId])).rows[0].n
    };
  } else {
    totals = (await q(
      \`SELECT c.name, c.list_code, COUNT(v.id)::int AS votes
       FROM candidates c
       LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
       WHERE c.election_id=$1
       GROUP BY c.id
       ORDER BY c.sort_order ASC\`,
      [electionId]
    )).rows;
    metrics = {
      votes: (await q(\`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1\`, [electionId])).rows[0].n,
      approved_regs: (await q(\`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'\`, [electionId])).rows[0].n
    };
  }

  res.render("public_results", { election, totals, metrics });
});

/* =========================
   ADMIN: LOGIN`
);

mustReplace(
  'new election body kind',
`  const { title, reg_open_at, reg_close_at, vote_open_at, vote_close_at } = req.body;`,
`  const { title, reg_open_at, reg_close_at, vote_open_at, vote_close_at } = req.body;
  const kind = String(req.body.kind || "ELECTION").trim().toUpperCase() === "VOTACION" ? "VOTACION" : "ELECTION";`
);

mustReplace(
  'insert election with kind',
`    \`INSERT INTO elections(title, reg_open_at, reg_close_at, vote_open_at, vote_close_at, is_active)
     VALUES ($1,$2,$3,$4,$5,false)
     RETURNING id\`,
    [title.trim(), regOpen, regClose, voteOpen, voteClose]`,
`    \`INSERT INTO elections(title, reg_open_at, reg_close_at, vote_open_at, vote_close_at, is_active, kind)
     VALUES ($1,$2,$3,$4,$5,false,$6)
     RETURNING id\`,
    [title.trim(), regOpen, regClose, voteOpen, voteClose, kind]`
);

mustReplace(
  'candidate defaults only election',
`  // crea candidatos para esa elección (2 listas)
  await q(
    \`INSERT INTO candidates(election_id, name, list_code, sort_order)
     VALUES ($1,'Lista 1','LISTA_1',1), ($1,'Lista 2','LISTA_2',2)\`,
    [e.id]
  );`,
`  // crea candidatos default solo para campañas tipo elección
  if (kind === "ELECTION") {
    await q(
      \`INSERT INTO candidates(election_id, name, list_code, sort_order)
       VALUES ($1,'Lista 1','LISTA_1',1), ($1,'Lista 2','LISTA_2',2)\`,
      [e.id]
    );
  }`
);

mustReplaceRegex(
  'admin referendum routes before solicitudes',
/\/\* =========================\n   ADMIN: Solicitudes \+ aprobación \(email por defecto\)\n========================= \*\//,
`app.get("/admin/votacion", requireViewerOrAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay campaña activa.");
  if (election.kind !== "VOTACION") return res.status(400).send("La campaña activa no es una votación interna.");
  const data = await getReferendumForElection(election.id);
  res.render("admin_referendum", { admin: req.session.admin, election, question: data.question, options: data.options });
});

app.post("/admin/votacion", requireAdmin, async (req, res) => {
  const election = await getActiveElection();
  if (!election) return res.status(500).send("No hay campaña activa.");
  if (election.kind !== "VOTACION") return res.status(400).send("La campaña activa no es una votación interna.");

  const questionText = String(req.body.question_text || "").trim();
  const labels = Array.isArray(req.body.option_label) ? req.body.option_label : [req.body.option_label];
  const texts = Array.isArray(req.body.option_text) ? req.body.option_text : [req.body.option_text];
  const opts = texts.map((t, i) => ({ label: String(labels[i] || "").trim(), text: String(t || "").trim() })).filter(o => o.text);

  if (!questionText || opts.length < 2) return res.status(400).send("Carga una pregunta y al menos dos opciones.");

  await q(\`DELETE FROM referendum_questions WHERE election_id=$1\`, [election.id]);
  const question = (await q(
    \`INSERT INTO referendum_questions(election_id, question_text, sort_order) VALUES ($1,$2,1) RETURNING id\`,
    [election.id, questionText]
  )).rows[0];

  for (let i = 0; i < opts.length; i++) {
    await q(
      \`INSERT INTO referendum_options(election_id, question_id, option_label, option_text, sort_order) VALUES ($1,$2,$3,$4,$5)\`,
      [election.id, question.id, opts[i].label || String.fromCharCode(65 + i), opts[i].text, i + 1]
    );
  }

  await audit("REFERENDUM_CONFIG_UPDATED", { actor_admin_id: req.session.admin.id, election_id: election.id, meta_json: { options: opts.length }});
  res.redirect("/admin/votacion");
});

/* =========================
   ADMIN: Solicitudes + aprobación (email por defecto)
========================= */`
);

mustReplace(
  'admin dashboard stats',
`    votes: (await q(\`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1\`, [active.id])).rows[0].n`,
`    votes: (await q(active.kind === "VOTACION" ? \`SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1\` : \`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1\`, [active.id])).rows[0].n`
);

mustReplaceRegex(
  'admin resultados route',
/app\.get\("\/admin\/resultados", requireViewerOrAdmin, async \(req, res\) => \{[\s\S]*?\n\}\);\n\nfunction toCSV/,
`app.get("/admin/resultados", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  if (!active) return res.status(500).send("No hay elección activa.");

  let totals;
  let votesSql = \`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1\`;
  if (active.kind === "VOTACION") {
    votesSql = \`SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1\`;
    totals = (await q(
      \`SELECT ro.option_label AS list_code, ro.option_text AS name, COUNT(rv.id)::int AS votes
       FROM referendum_options ro
       LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
       WHERE ro.election_id=$1
       GROUP BY ro.id
       ORDER BY ro.sort_order ASC, ro.id ASC\`,
      [active.id]
    )).rows;
  } else {
    totals = (await q(
      \`SELECT c.name, c.list_code, COUNT(v.id)::int AS votes
       FROM candidates c
       LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
       WHERE c.election_id=$1
       GROUP BY c.id
       ORDER BY c.sort_order ASC\`,
      [active.id]
    )).rows;
  }

  const metrics = {
    votes: (await q(votesSql, [active.id])).rows[0].n,
    pending_regs: (await q(\`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='PENDING'\`, [active.id])).rows[0].n,
    approved_regs: (await q(\`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'\`, [active.id])).rows[0].n
  };

  res.render("admin_result", { admin: req.session.admin, election: active, totals, metrics });
});

function toCSV`
);

mustReplaceRegex(
  'export resultados route',
/app\.get\("\/admin\/export\/resultados\.csv", requireViewerOrAdmin, async \(req, res\) => \{[\s\S]*?\n\}\);/,
`app.get("/admin/export/resultados.csv", requireViewerOrAdmin, async (req, res) => {
  const active = await getActiveElection();
  const rows = active.kind === "VOTACION" ? (await q(
    \`SELECT ro.option_label AS opcion, ro.option_text AS descripcion, COUNT(rv.id)::int AS votos
     FROM referendum_options ro
     LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
     WHERE ro.election_id=$1
     GROUP BY ro.id
     ORDER BY ro.sort_order ASC, ro.id ASC\`,
    [active.id]
  )).rows : (await q(
    \`SELECT c.name AS lista, COUNT(v.id)::int AS votos
     FROM candidates c
     LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
     WHERE c.election_id=$1
     GROUP BY c.id
     ORDER BY c.sort_order ASC\`,
    [active.id]
  )).rows;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", \`attachment; filename="resultados_election_\${active.id}.csv"\`);
  res.send(toCSV(rows));
});`
);

mustReplace(
  'fiscal vote chained insert',
`    // inserta voto fiscal (si ya votó fiscal, unique index lo evita)
    await c.query(
      \`INSERT INTO fiscal_votes(election_id, unit_id, fiscal_list_id, token_id, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)\`,
      [election.id, vt.unit_id, Number(fiscal_list_id), vt.id, req.ip, req.headers["user-agent"] || ""]
    );`,
`    await insertFiscalVoteChained(c, {
      election_id: election.id,
      unit_id: vt.unit_id,
      fiscal_list_id: Number(fiscal_list_id),
      token_id: vt.id,
      ip: getReqIp(req),
      user_agent: getUserAgent(req)
    });`
);

fs.writeFileSync(file, s);
console.log('OK referendum patch applied to src/server.js');
