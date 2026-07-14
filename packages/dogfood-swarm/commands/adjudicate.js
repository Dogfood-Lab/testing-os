/**
 * adjudicate.js — `swarm adjudicate <run-id> --case-file <path>`
 *
 * Dispatches a Fable-prepared case-file to the cross-family jury and persists the
 * ADVISORY verdict onto the run's current wave, where the checkAdjudication gate
 * (lib/advance.js) reads it. The jury is evidence, not law: this verb never
 * changes wave status itself — it records the verdict, and `swarm advance` gates
 * on it (a non-corroborate verdict needs Director disposition to promote).
 *
 * This module is the testable CORE (runAdjudicate); the CLI wrapper (cmdAdjudicate
 * in cli.js) parses args, builds the live local-Ollama jury, and handles I/O. The
 * jury boundary is INJECTED so the core is unit-tested with a mock jury (CI has no
 * Ollama); the live path is the manual on-rig smoke.
 *
 * The receipt artifact (full per-criterion detail) is written under
 * swarms/<run-id>/adjudications/ via the atomic-write helper, and the durable
 * gate-readable summary row is persisted through lib/adjudication-store.js.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { adjudicate } from '../lib/case-file/adjudicate.js';
import { persistAdjudication } from '../lib/adjudication-store.js';

/** Default receipt writer — atomic (helper-adoption discipline), parent-dir safe. */
function defaultWriteReceipt(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, content);
}

/**
 * Adjudicate a case-file against a run's current wave and persist the verdict.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.runId
 * @param {object} opts.caseFile — parsed case-file JSON
 * @param {(spec: object) => Promise<Array<object>>} opts.runJury — the injected jury boundary
 * @param {Array<{family: string, model: string}>} [opts.seats] — passed through to buildJurySpec
 * @param {string} [opts.swarmDir] — where the receipt artifact is written (its dirname/adjudications/)
 * @param {(path: string, content: string) => void} [opts.writeReceipt] — injectable for tests
 * @returns {Promise<{ result: object, adjudicationId: number, receiptPath: string|null, wave: object }>}
 * @throws {import('../lib/case-file/handoff.js').CaseFileNeutralityError} if the case-file fails the neutrality gate (nothing is persisted)
 */
export async function runAdjudicate(db, opts) {
  const { runId, caseFile, runJury, seats, swarmDir, writeReceipt = defaultWriteReceipt } = opts;

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const wave = db.prepare(
    'SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1',
  ).get(runId);
  if (!wave) throw new Error(`No waves found for run ${runId}`);

  // Fail-closed on a biasing case-file: adjudicate() runs the neutrality gate
  // (toJuryRequest) before the jury is ever called; a CaseFileNeutralityError
  // propagates and nothing below runs — no jury dispatch, no persistence.
  const result = await adjudicate(caseFile, { runJury, seats });

  const caseFileRef = caseFile?.artifact_under_test?.ref ?? null;
  const receiptContent = JSON.stringify(
    { run_id: runId, wave: wave.wave_number, case_file_ref: caseFileRef, result },
    null,
    2,
  );

  let receiptPath = null;
  if (swarmDir) {
    const shortHash = createHash('sha256').update(receiptContent).digest('hex').slice(0, 8);
    receiptPath = join(swarmDir, 'adjudications', `wave-${wave.wave_number}-${shortHash}.json`);
    writeReceipt(receiptPath, receiptContent);
  }

  const adjudicationId = persistAdjudication(db, {
    waveId: wave.id,
    runId,
    result,
    caseFileRef,
    receiptPath,
    receiptContent,
  });

  return { result, adjudicationId, receiptPath, wave };
}

/**
 * Format an adjudication result for the CLI. Verdict-first, then per-criterion,
 * then the advisory framing + the next-step hint.
 */
export function formatAdjudication({ result, adjudicationId, receiptPath }) {
  const lines = [];
  lines.push(`Adjudication: ${result.overall.toUpperCase()}  (advisory — the deterministic floor is law)`);
  lines.push(`Panel: ${result.seats.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('Criteria:');
  for (const c of result.criteria) {
    lines.push(`  [${c.verdict}] ${c.id} — pass ${c.counts.pass} / fail ${c.counts.fail} / insufficient ${c.counts.insufficient_context}`);
  }
  if (result.out_of_brief.length) {
    lines.push('');
    lines.push('Out-of-brief (rubric is a floor, not a ceiling):');
    for (const o of result.out_of_brief) lines.push(`  (${o.jurors}) ${o.finding}`);
  }
  lines.push('');
  lines.push(`Recorded adjudication #${adjudicationId}${receiptPath ? ` — receipt ${receiptPath}` : ''}`);
  if (result.overall === 'corroborate') {
    lines.push('Next: swarm advance <run-id>  (the adjudication gate clears)');
  } else {
    lines.push(`Next: address the flagged criteria, or dispose with \`swarm advance <run-id> --override --reason "..."\``);
  }
  return lines.join('\n');
}
