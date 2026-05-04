export function createActaPdfHandler({ q, PDFDocument, getActiveElection, getReferendumForElection, audit }) {
  return async function actaPdfHandler(req, res) {
    const active = await getActiveElection();
    if (!active) return res.render("no_active");

    const seals = (await q(
      `SELECT kind, global_hash, total_votes, created_at
       FROM election_seals
       WHERE election_id=$1
       ORDER BY kind ASC`,
      [active.id]
    )).rows;

    let totals = [];
    let question = null;
    let metrics;

    if (active.kind === "VOTACION") {
      const data = await getReferendumForElection(active.id);
      question = data.question;

      totals = (await q(
        `SELECT ro.option_label AS code, ro.option_text AS name, COUNT(rv.id)::int AS votes
         FROM referendum_options ro
         LEFT JOIN referendum_votes rv ON rv.option_id=ro.id AND rv.election_id=$1
         WHERE ro.election_id=$1
         GROUP BY ro.id
         ORDER BY ro.sort_order ASC, ro.id ASC`,
        [active.id]
      )).rows;

      metrics = {
        votes: (await q(`SELECT COUNT(*)::int AS n FROM referendum_votes WHERE election_id=$1`, [active.id])).rows[0].n,
        approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [active.id])).rows[0].n,
        pending_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='PENDING'`, [active.id])).rows[0].n
      };
    } else {
      totals = (await q(
        `SELECT c.name, c.list_code AS code, COUNT(v.id)::int AS votes
         FROM candidates c
         LEFT JOIN votes v ON v.candidate_id=c.id AND v.election_id=$1
         WHERE c.election_id=$1
         GROUP BY c.id
         ORDER BY c.sort_order ASC`,
        [active.id]
      )).rows;

      metrics = {
        votes: (await q(`SELECT COUNT(*)::int AS n FROM votes WHERE election_id=$1`, [active.id])).rows[0].n,
        fiscal_votes: (await q(`SELECT COUNT(*)::int AS n FROM fiscal_votes WHERE election_id=$1`, [active.id])).rows[0].n,
        approved_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='APPROVED'`, [active.id])).rows[0].n,
        pending_regs: (await q(`SELECT COUNT(*)::int AS n FROM registrations WHERE election_id=$1 AND status='PENDING'`, [active.id])).rows[0].n
      };
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Content-Disposition", `inline; filename="acta_election_${active.id}_${Date.now()}.pdf"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const usableW = right - left;

    doc.fontSize(16).text(active.kind === "VOTACION" ? "ACTA DE VOTACIÓN INTERNA" : "ACTA DE VOTACIÓN DIGITAL", { align: "center" });
    doc.moveDown(0.5);

    doc.fontSize(12).text(`Campaña: ${active.title}`);
    doc.text(`Tipo: ${active.kind === "VOTACION" ? "Votación interna / Referéndum" : "Elección"}`);
    doc.text(`Fecha/Hora generación (Lima): ${new Date().toLocaleString("es-PE", { timeZone: "America/Lima" })}`);
    doc.moveDown(0.8);

    if (active.kind === "VOTACION" && question) {
      doc.fontSize(11).text("Pregunta:", { underline: true });
      doc.fontSize(10).text(question.question_text, { width: usableW });
      doc.moveDown(0.8);
    }

    doc.fontSize(11).text(`Total votos emitidos: ${metrics.votes}`);
    if (active.kind !== "VOTACION") doc.text(`Total votos fiscales: ${metrics.fiscal_votes}`);
    doc.text(`Registros aprobados: ${metrics.approved_regs}`);
    doc.text(`Registros pendientes: ${metrics.pending_regs}`);
    doc.moveDown(1);

    doc.fontSize(13).text(active.kind === "VOTACION" ? "Resultados - Votación interna" : "Resultados - Consejo Directivo", { underline: true });
    doc.moveDown(0.6);

    const colX = { item: left, votes: right - 120 };
    doc.fontSize(11).text(active.kind === "VOTACION" ? "Opción" : "Lista", colX.item, doc.y, { continued: true });
    doc.text("Votos", colX.votes, doc.y);
    doc.moveDown(0.3);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown(0.4);

    for (const t of totals) {
      if (doc.y > doc.page.height - 180) doc.addPage();
      const label = active.kind === "VOTACION"
        ? `${t.code ? t.code + ". " : ""}${t.name ?? ""}`
        : String(t.name ?? "");
      doc.fontSize(10).text(label, colX.item, doc.y, { width: colX.votes - colX.item - 10, continued: true });
      doc.text(String(t.votes ?? 0), colX.votes, doc.y);
      doc.moveDown(0.35);
    }

    doc.moveDown(1);
    doc.fontSize(13).text("Sellos de integridad", { underline: true });
    doc.moveDown(0.5);
    if (!seals.length) {
      doc.fontSize(10).text("Campaña todavía no sellada.");
    } else {
      for (const seal of seals) {
        if (doc.y > doc.page.height - 180) doc.addPage();
        doc.fontSize(10).text(`${seal.kind} (${seal.total_votes} votos):`);
        doc.fontSize(8).text(seal.global_hash, { width: usableW });
        doc.moveDown(0.35);
      }
    }

    doc.moveDown(1.2);
    if (doc.y > doc.page.height - 190) doc.addPage();

    const gap = 24;
    const colW = (right - left - gap) / 2;
    const x1 = left;
    const x2 = left + colW + gap;
    let sy = doc.y;

    function signLine(x, y, label) {
      doc.fontSize(10).text("______________________________", x, y, { width: colW });
      doc.fontSize(9).text(label, x, y + 14, { width: colW });
    }

    signLine(x1, sy, "Presidente(a) Consejo Directivo");
    signLine(x2, sy, "Miembro Consejo Directivo");

    sy += 46;
    signLine(x1, sy, "Miembro Consejo Directivo");
    signLine(x2, sy, "Fiscal");

    sy += 46;
    signLine(x1, sy, "Personero(a) 1");
    signLine(x2, sy, "Personero(a) 2");

    doc.fontSize(8)
      .fillColor("gray")
      .text("Sistema de votación URBISOL 1.0", 0, doc.page.height - 30, { align: "center" });
    doc.fillColor("black");

    doc.end();

    await audit("ACTA_PDF_GENERATED", {
      election_id: active.id,
      meta_json: { kind: active.kind, votes: metrics.votes, approved_regs: metrics.approved_regs, seals: seals.length }
    });
  };
}
