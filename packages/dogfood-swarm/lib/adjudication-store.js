/**
 * adjudication-store.js — persistence for the wave-gated cross-family jury
 * verdict (the v9 `adjudications` table).
 *
 * The adjudication is the ADVISORY verdict a Fable-prepared case-file earns from
 * the family-different jury (lib/case-file/adjudicate.js). It is persisted per
 * wave so the checkAdjudication gate in lib/advance.js can read it at advance
 * time. This store is the single seam that writes/reads the table; the row is a
 * durable, gate-readable SUMMARY (overall verdict + panel size + seats + a
 * pointer to the full receipt artifact), not the full per-criterion detail.
 *
 * The jury is EVIDENCE, not law: nothing here forces an outcome. A row simply
 * makes the verdict visible to the gate, which lets a non-corroborate verdict
 * require Director disposition (an --override --reason on advance) while a
 * corroborate clears cleanly. Only the deterministic verification floor is
 * non-overridable.
 */

import { createHash } from 'node:crypto';

/** The four overall verdicts. Mirrors STATUS.adjudication in db/schema.js and
 * the CRITERION_TO_OVERALL image in lib/case-file/adjudicate.js. */
export const ADJUDICATION_VERDICTS = ['corroborate', 'refute', 'contested', 'insufficient_context'];

/**
 * Persist an adjudication result for a wave.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} args
 * @param {number} args.waveId
 * @param {string} args.runId
 * @param {object} args.result — the normalizeAdjudication() output (overall, authority, panel_size, seats)
 * @param {string} [args.caseFileRef] — the artifact_under_test.ref the case-file judged
 * @param {string} [args.receiptPath] — path to the full receipt artifact on disk
 * @param {string} [args.receiptContent] — the receipt bytes, hashed into receipt_hash for tamper-evidence
 * @returns {number} the new adjudication id
 */
export function persistAdjudication(db, args) {
  const { waveId, runId, result, caseFileRef, receiptPath, receiptContent } = args;

  // SQLite has no enum enforcement; refuse an out-of-vocabulary verdict here so
  // a malformed result can never write a value the gate cannot reason about
  // (mirrors the wave-state-machine's canonical-target validation).
  if (!ADJUDICATION_VERDICTS.includes(result?.overall)) {
    throw new Error(
      `persistAdjudication: invalid overall verdict ${JSON.stringify(result?.overall)} — ` +
      `must be one of ${ADJUDICATION_VERDICTS.join(' | ')}.`,
    );
  }

  const receiptHash = receiptContent
    ? createHash('sha256').update(receiptContent).digest('hex')
    : null;

  const r = db.prepare(`
    INSERT INTO adjudications
      (wave_id, run_id, overall, authority, panel_size, seats, case_file_ref, receipt_path, receipt_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    waveId,
    runId,
    result.overall,
    result.authority || 'advisory',
    result.panel_size ?? (Array.isArray(result.seats) ? result.seats.length : 0),
    JSON.stringify(Array.isArray(result.seats) ? result.seats : []),
    caseFileRef ?? null,
    receiptPath ?? null,
    receiptHash,
  );
  return Number(r.lastInsertRowid);
}

/**
 * Get the latest adjudication for a wave (the one the gate reads), or undefined.
 * @param {import('better-sqlite3').Database} db
 * @param {number} waveId
 * @returns {object|undefined}
 */
export function getLatestAdjudication(db, waveId) {
  return db.prepare(
    'SELECT * FROM adjudications WHERE wave_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  ).get(waveId);
}

/**
 * The NAMED COMPENSATOR for a persisted adjudication (workflow-standards
 * NAMED_COMPENSATORS): remove an adjudication row so a mis-run or superseded
 * adjudication can be rolled back without raw SQL surgery at the call site. The
 * gate then reads the prior latest row (or none). Returns the number of rows
 * removed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {number}
 */
export function deleteAdjudication(db, id) {
  const r = db.prepare('DELETE FROM adjudications WHERE id = ?').run(id);
  return r.changes;
}
