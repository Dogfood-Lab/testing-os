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
 *
 * F-fa047531 — compensators table (workflow-standards NAMED_COMPENSATORS; no
 * skip allowed for an irreversible action):
 *
 *   Irreversible action: runAdjudicate() dispatches the jury (billed under
 *   --cloud), writes the receipt artifact to disk, and INSERTs the
 *   adjudications row — all before this fix, with NO dry-run and no CLI
 *   surface for the undo lib/adjudication-store.js#deleteAdjudication
 *   already defined (it was wired to nothing; the only way to invoke it was
 *   raw SQL surgery, exactly what its own docstring says it exists to
 *   prevent).
 *
 *   Command-to-undo: `swarm adjudicate <run-id> --undo <adjudication-id>
 *   --apply` (undoAdjudication below, calling deleteAdjudication). Dry-run
 *   by default like every other recovery verb in this package.
 *
 *   Post-rollback state: the adjudications row is gone; checkAdjudication
 *   (lib/advance.js) falls back to getLatestAdjudication, i.e. the prior
 *   row for the wave (or none, if this was the only one). The full receipt
 *   artifact on disk is left in place (it is the durable forensic record of
 *   what the jury actually said; only the gate-readable summary row is
 *   removed) — an operator who wants it gone deletes the file directly.
 *
 *   Owner: the operator invoking --undo, naming the specific adjudication
 *   id from `swarm advance --check-only` or the receipt path printed by the
 *   original run.
 *
 *   Preview: `--dry-run` (previewAdjudicate below) resolves the wave, runs
 *   the SAME fail-closed neutrality gate the apply path runs first, and
 *   prints the seats/tier/billing WITHOUT dispatching the jury or
 *   persisting — the highest-value preview in the verb set, because
 *   adjudicate is the only verb that spends real money.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { adjudicate, buildJurySpec } from '../lib/case-file/adjudicate.js';
import { toJuryRequest } from '../lib/case-file/handoff.js';
import { persistAdjudication, deleteAdjudication, getLatestAdjudication } from '../lib/adjudication-store.js';
import { escapeReasonForDisplay } from './lib/escape-reason.js';

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
 * F-fa047531: `--dry-run` preview. Resolves the run/wave and runs the SAME
 * fail-closed neutrality gate runAdjudicate() runs first (a biasing
 * case-file is refused here too — CaseFileNeutralityError propagates
 * unchanged), then reports the seats/tier/billing the apply path WOULD
 * dispatch. Never calls the jury boundary, never writes a receipt, never
 * touches the adjudications table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.runId
 * @param {object} opts.caseFile — parsed case-file JSON
 * @param {Array<{family: string, model: string}>} [opts.seats]
 * @param {string} [opts.tier] — 'local' | 'prism', for the report only (not re-derived here)
 * @param {boolean} [opts.cloud] — for the report only
 * @returns {{ dryRun: true, runId: string, waveId: number, waveNumber: number, tier: string, cloud: boolean, billed: boolean, seats: Array<{family:string,model:string}>, criteriaCount: number }}
 * @throws {import('../lib/case-file/handoff.js').CaseFileNeutralityError} if the case-file fails the neutrality gate
 */
export function previewAdjudicate(db, opts) {
  const { runId, caseFile, seats, tier, cloud } = opts;

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const wave = db.prepare(
    'SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1',
  ).get(runId);
  if (!wave) throw new Error(`No waves found for run ${runId}`);

  const juryRequest = toJuryRequest(caseFile); // fail-closed on a biasing case-file
  const spec = buildJurySpec(juryRequest, { seats });

  return {
    dryRun: true,
    runId,
    waveId: wave.id,
    waveNumber: wave.wave_number,
    tier: tier || 'local',
    cloud: !!cloud,
    billed: !!cloud,
    seats: spec.seats,
    criteriaCount: juryRequest.rubric.acceptance_criteria.length,
  };
}

/**
 * F-fa047531: the compensator CLI surface for
 * lib/adjudication-store.js#deleteAdjudication. Dry-run by default (mirrors
 * every other recovery verb — redrive/rewind/revalidate/clean).
 *
 * F-482629a9: `runId` is REQUIRED and enforced — adjudication ids are one
 * global auto-increment sequence (db/schema.js's `adjudications` table has
 * no per-run namespacing), so a bare `WHERE id = ?` lookup with no run-scope
 * check let the CLI's `<run-id>` positional argument (cli.js requires it
 * before reaching --undo) name a completely different run than the
 * adjudication actually belongs to — the argument READ as scoping ("undo
 * THIS run's adjudication") but enforced nothing, silently deleting an
 * unrelated run's row on --apply. Enforced BEFORE the `if (apply)` branch
 * below so both the dry-run preview and --apply refuse identically, mirroring
 * how every other targeted verb in this file (revalidate's --domain,
 * defer/reject's --ids) scopes its target to the named run before mutating.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {number} opts.adjudicationId
 * @param {string} opts.runId — the run this undo must be scoped to
 * @param {boolean} [opts.apply]
 * @returns {object} report
 */
export function undoAdjudication(db, opts) {
  const { adjudicationId, apply, runId } = opts;

  const row = db.prepare('SELECT * FROM adjudications WHERE id = ?').get(adjudicationId);
  if (!row) {
    const err = new Error(`adjudicate --undo: adjudication ${adjudicationId} not found`);
    err.code = 'ADJUDICATION_NOT_FOUND';
    throw err;
  }

  // F-482629a9: row.run_id is NOT NULL (db/schema.js), so an absent/undefined
  // opts.runId fails this comparison too — the same refusal covers both "no
  // run id supplied" and "wrong run id supplied" with one consistent error.
  if (row.run_id !== runId) {
    const err = new Error(
      `adjudicate --undo: adjudication ${adjudicationId} belongs to run "${row.run_id}", ` +
      `not "${runId}" — refusing a cross-run undo. Re-run naming the correct run id.`
    );
    err.code = 'ADJUDICATION_RUN_MISMATCH';
    err.runId = runId;
    err.adjudicationId = adjudicationId;
    throw err;
  }

  const report = {
    dryRun: !apply,
    apply: !!apply,
    target: {
      id: row.id,
      waveId: row.wave_id,
      runId: row.run_id,
      overall: row.overall,
      createdAt: row.created_at,
    },
    removed: false,
    newLatest: null,
  };

  if (apply) {
    const removedCount = deleteAdjudication(db, adjudicationId);
    report.removed = removedCount > 0;
    const latest = getLatestAdjudication(db, row.wave_id);
    report.newLatest = latest
      ? { id: latest.id, overall: latest.overall, createdAt: latest.created_at }
      : null;
  }

  return report;
}

/**
 * Human-readable preview text for `swarm adjudicate --dry-run`.
 */
export function formatAdjudicationPreview(preview) {
  const lines = [];
  lines.push(`Adjudicate (DRY-RUN) — run ${preview.runId}, wave ${preview.waveNumber}`);
  lines.push(`  Jury tier: ${preview.tier}${preview.cloud ? ' (--cloud: PAID seats — this run would be billed)' : ' (free seats)'}`);
  lines.push(`  Panel (${preview.seats.length}): ${preview.seats.map(s => `${s.family}:${s.model}`).join(', ') || '(none)'}`);
  lines.push(`  Criteria to judge: ${preview.criteriaCount}`);
  lines.push('  Case-file passed the neutrality gate. Nothing was dispatched, written, or persisted.');
  lines.push('  Re-run without --dry-run to actually adjudicate.');
  return lines.join('\n');
}

/**
 * Human-readable report for `swarm adjudicate --undo`.
 */
export function formatAdjudicationUndo(report) {
  const verb = report.apply ? 'Undo (APPLIED)' : 'Undo (DRY-RUN)';
  const t = report.target;
  const lines = [];
  lines.push(`${verb} — adjudication #${t.id} (wave ${t.waveId}, run ${t.runId})`);
  lines.push(`  Verdict recorded: ${t.overall} @ ${t.createdAt}`);
  if (report.apply) {
    lines.push(`  Removed: ${report.removed ? 'yes' : 'no (already gone)'}`);
    lines.push(report.newLatest
      ? `  Gate now reads: adjudication #${report.newLatest.id} (${report.newLatest.overall})`
      : '  Gate now reads: no adjudication for this wave');
  } else {
    lines.push('  Re-run with --apply to remove this row.');
  }
  return lines.join('\n');
}

/**
 * Format an adjudication result for the CLI. Verdict-first, then per-criterion,
 * then the advisory framing + the next-step hint.
 */
export function formatAdjudication({ result, adjudicationId, receiptPath }) {
  const lines = [];
  lines.push(`Adjudication: ${result.overall.toUpperCase()}  (advisory — the deterministic floor is law)`);
  lines.push(`Panel: ${result.seats.join(', ') || '(none)'}`);
  // F-9acd2df3: normalizeAdjudication (F-993df146, wave 29) attaches a
  // panel-level seats_errored array whenever a juror's seat died
  // (ECONNREFUSED, an unpulled-model 404, VERIFIER_UNAVAILABLE, ...) — this
  // renderer, the DEFAULT (non --format=json) `swarm adjudicate` surface,
  // never read the field: a dead seat's name still appeared in the Panel
  // line above indistinguishable from a healthy panelist, and the text
  // contained zero occurrences of "error"/"ECONNREFUSED" anywhere. The
  // --format=json path (cli.js) and the receipt file on disk already carry
  // this — only the primary human-facing surface was blind. Guarded with
  // `|| []` because historical result payloads recorded before F-993df146
  // (and this file's own pre-fix unit-test fixtures) carry no seats_errored
  // key at all. escapeReasonForDisplay because jv.error is jury-supplied
  // text with the same zero-privilege provenance as the out_of_brief loop
  // below — seat names themselves are left unescaped, matching the Panel
  // line's own existing (pre-fix) convention.
  const seatsErrored = result.seats_errored || [];
  if (seatsErrored.length > 0) {
    lines.push(`Seats errored (${seatsErrored.length}): ${
      seatsErrored.map(s => `${s.seat || '(unknown seat)'} — ${escapeReasonForDisplay(s.error)}`).join('; ')
    }`);
  }
  // Brief size on the human surface too (the F-9acd2df3 lesson: a receipt
  // field the default render is blind to might as well not exist). Absent
  // brief_size = a tier/jury that does not measure (prism, pre-guard) — say
  // nothing rather than fake a number. all_fit:false means an oversize
  // dispatch was explicitly allowed past the guard; render it loudly.
  if (result.brief_size) {
    const bs = result.brief_size;
    const overCount = bs.seats.filter(s => !s.fits).length;
    lines.push(`Brief: ${bs.chars} chars (~${bs.estimated_tokens} tokens, ${bs.estimator}; reserve ${bs.output_reserve_tokens}) — ${
      bs.all_fit
        ? `read whole by all ${bs.seats.length} seats`
        : `OVERFLOWED ${overCount} of ${bs.seats.length} seats — dispatched under --allow-oversize; verdicts came from truncated reads`
    }`);
  }
  lines.push('');
  lines.push('Criteria:');
  for (const c of result.criteria) {
    // F-9acd2df3: a non-empty c.errors means one or more seats abstained on
    // THIS criterion specifically (a whole-juror error attributes to every
    // criterion that seat was asked to judge; a per-criterion prism error
    // attributes to just this one) — annotate inline so "pass 1 / fail 0 /
    // insufficient 1" cannot read as an ordinary split when it is actually
    // one live vote and one dead seat.
    const erroredNote = c.errors && c.errors.length > 0 ? ` [${c.errors.length} seat(s) errored]` : '';
    lines.push(`  [${c.verdict}] ${c.id} — pass ${c.counts.pass} / fail ${c.counts.fail} / insufficient ${c.counts.insufficient_context}${erroredNote}`);
  }
  if (result.out_of_brief.length) {
    lines.push('');
    lines.push('Out-of-brief (rubric is a floor, not a ceiling):');
    // F-0b7ba713 (wave 24): o.finding is free-form natural-language text
    // parsed directly from a local Ollama juror's own JSON response
    // (lib/case-file/ollama-jury.js's parseJurorResponse), with zero
    // character constraint. Jurors judge a case-file built from this run's
    // own audit findings -- descriptions/paths this package already treats
    // as attacker-adjacent (commands/collect.js) -- so a juror's free-text
    // commentary could echo a hostile substring one hop further removed.
    // This file previously imported neither escape helper at all. o.jurors
    // is a plain aggregation COUNT (lib/case-file/adjudicate.js's
    // normalizeAdjudication increments a numeric `jurors` tally), not free
    // text, so it does not need escaping.
    for (const o of result.out_of_brief) lines.push(`  (${o.jurors}) ${escapeReasonForDisplay(o.finding)}`);
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
