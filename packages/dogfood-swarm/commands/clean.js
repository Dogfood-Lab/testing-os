/**
 * clean.js — `swarm clean <run-id> [--apply] [--format=json]`
 *
 * The worktree-lifecycle recovery verb. Under --isolate, dispatch.js creates a
 * per-agent git worktree (.swarm/worktrees/w<N>-<domain>/) on a
 * swarm/<run-short>/w<N>-<domain> branch (lib/worktree.js). recordPromotion()
 * tears them down on the run's terminal `complete` transition — but a run that
 * is abandoned, rewound, or interrupted before `complete` strands those
 * worktrees + branches on disk forever. `swarm clean` is the operator-facing
 * reclaim for exactly that residue.
 *
 * Recovery-verb contract (mirrors revalidate / rewind / redrive):
 *   - Dry-run by default; --apply required to actually remove. The dry-run
 *     enumerates the survivors so the operator previews the blast radius before
 *     any worktree leaves disk.
 *   - dbPath required, no implicit default — keeps tests from ever touching the
 *     live control plane.
 *   - Run-scoped, NOT repo-wide. lib/worktree.js#cleanupAllWorktrees sweeps
 *     EVERY swarm/* worktree in the repo; a single repo can host more than one
 *     run's worktrees concurrently, so clean filters to the branches whose
 *     run-short slug matches THIS run. The slug derivation matches
 *     createWorktree byte-for-byte (runId minus the `swarm-` prefix, first 12
 *     chars) so the filter is exact, not heuristic.
 *   - Returns a structured { removed, stranded, total } rollup — the same shape
 *     cleanupAllWorktrees returns — so the CLI text + JSON surfaces and any
 *     downstream caller see one contract. A `stranded` worktree is one whose
 *     `git worktree remove --force` silently failed (occupied path, lock, no
 *     longer git-tracked); removeWorktree already emits a worktree_cleanup_failed
 *     breadcrumb per survivor (PH-DS-01).
 *
 *   - F-d2025a4d: TWO additional gates make clean's blast radius match the
 *     rest of the recovery-verb family (previously it was materially
 *     weaker — every sibling refuses in-flight work by default; clean did
 *     not):
 *       (a) --apply refuses while the run's latest wave is 'dispatched' or
 *           'collecting' (mirrors dispatch.js's DISPATCH_WAVE_IN_FLIGHT
 *           precondition), naming the recovery verbs (`swarm collect` /
 *           `swarm redrive` / `swarm rewind`) instead of silently reclaiming
 *           worktrees live agents may still be editing.
 *       (b) --apply skips (does not remove) any DIRTY or UNMERGED worktree
 *           unless --force is also passed — matching rewind's
 *           --force-on-top-of---apply contract for the identical
 *           uncommitted-work risk. Clean (non-dirty, merged) worktrees stay
 *           a one-step `--apply` reclaim; only the at-risk subset needs the
 *           extra flag. worktreeDisposition already computed both flags for
 *           the dry-run preview (below) — (b) is the missing "and act on
 *           it" half.
 *
 *   - F-78a13f53 (wave 29): this file called logStage() zero times anywhere,
 *     unlike every sibling recovery verb (clean-claims/collect/dispatch/
 *     redrive/resume/revalidate/rewind/verify*) — a successful --force
 *     removal of a DIRTY/UNMERGED worktree (permanent, unrecoverable once it
 *     happens; no compensator can undo it after the fact) left no durable
 *     trace anywhere once the operator's terminal scrollback was gone. The
 *     --apply loop now emits `worktree_force_cleaned` (component, runId,
 *     worktreePath, branch, dirty, unmerged, force) for every entry actually
 *     removed, so "did anyone force-clean this run, which worktrees, and did
 *     it override a dirty/unmerged guard" is answerable by grep.
 */

import { openDb } from '../db/connection.js';
import { listWorktrees, removeWorktree, runShortOf, worktreeDisposition } from '../lib/worktree.js';
import { logStage } from '../lib/log-stage.js';

/**
 * @param {object} opts
 * @param {string} opts.runId — required
 * @param {string} opts.dbPath — control-plane DB path (required, no default)
 * @param {boolean} [opts.apply] — without this, dry-run only (no removal)
 * @param {boolean} [opts.force] — F-d2025a4d: required (in addition to
 *   --apply) to remove a DIRTY or UNMERGED worktree. Without it, --apply
 *   still removes clean/merged worktrees but SKIPS at-risk ones (reported
 *   in `worktrees[].skipped_at_risk`, rolled up in `report.skippedAtRisk`).
 * @returns {object} — report with { removed, stranded, total, worktrees, ... }
 */
export function clean(opts) {
  const { dbPath, apply, force } = opts;

  if (!opts.runId || typeof opts.runId !== 'string') {
    throw new Error('clean: <run-id> is required');
  }
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('clean: dbPath is required (no implicit default)');
  }

  const db = openDb(dbPath);

  const run = db.prepare('SELECT id, repo, local_path, branch FROM runs WHERE id = ?').get(opts.runId);
  if (!run) {
    const err = new Error(`clean: run not found: ${opts.runId}`);
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }
  if (!run.local_path) {
    const err = new Error(`clean: run ${opts.runId} has no local_path — cannot resolve its worktrees`);
    err.code = 'RUN_NO_LOCAL_PATH';
    throw err;
  }

  // F-d2025a4d(a): refuse --apply while THIS run's latest wave is still in
  // flight ('dispatched'/'collecting') — mirrors dispatch.js's
  // DISPATCH_WAVE_IN_FLIGHT precondition (checked before any mutation, same
  // status pair). Without this, clean --apply force-destroys worktrees a
  // live agent may still be editing, with no gate at all — every sibling
  // destructive verb in this package already refuses in-flight work
  // (dispatch refuses a new wave in flight; redrive refuses a `running`
  // agent; rewind requires --force on top of --apply). Checked only on
  // --apply — the dry-run preview stays informative even for an in-flight
  // run, since seeing what --apply WOULD do is exactly how an operator
  // decides whether to collect/redrive/rewind first.
  if (apply) {
    const inFlightWave = db.prepare(`
      SELECT id, wave_number, phase, status FROM waves
      WHERE run_id = ? AND status IN ('dispatched', 'collecting')
      ORDER BY wave_number DESC LIMIT 1
    `).get(opts.runId);
    if (inFlightWave) {
      const err = new Error(
        `clean: run ${opts.runId} has wave ${inFlightWave.wave_number} (${inFlightWave.phase}) still ` +
        `'${inFlightWave.status}' — --apply would reclaim worktrees a live agent may still be editing. ` +
        `Finish the in-flight wave first: \`swarm collect ${opts.runId}\` (or \`swarm redrive ${inFlightWave.id}\` ` +
        `/ \`swarm rewind\` if it is unrecoverable).`
      );
      err.code = 'CLEAN_WAVE_IN_FLIGHT';
      err.runId = opts.runId;
      err.waveId = inFlightWave.id;
      throw err;
    }
  }

  // Run-scoped filter: createWorktree namespaces branches under
  // swarm/<run-short>/... so the branch prefix is the run boundary. A sibling
  // run's worktrees in the same repo carry a different short slug and are left
  // untouched.
  const runShort = runShortOf(opts.runId);
  const branchPrefix = `swarm/${runShort}/`;
  const all = listWorktrees(run.local_path);
  const mine = all.filter(w => {
    const branch = (w.branch || '').replace(/^refs\/heads\//, '');
    return branch.includes(branchPrefix);
  });

  const report = {
    runId: opts.runId,
    repo: run.repo,
    localPath: run.local_path,
    dbPath,
    dryRun: !apply,
    apply: !!apply,
    force: !!force,
    total: mine.length,
    removed: 0,
    stranded: 0,
    // F-d2025a4d(b): worktrees skipped because they were DIRTY or UNMERGED
    // and --force was not passed. Distinct from `stranded` (a REMOVAL
    // attempt that failed) — a skipped-at-risk entry was never attempted.
    skippedAtRisk: 0,
    // F-1ab3fd1f sibling: annotate each worktree with its preserved-work
    // disposition so the DRY-RUN preview shows what --apply would DESTROY.
    // clean remains the deliberate force-disposal verb (the terminal-
    // promotion cleanup skips dirty/unmerged worktrees; clean does not) —
    // but the operator sees the blast radius before consenting.
    worktrees: mine.map(w => {
      const branch = (w.branch || '').replace(/^refs\/heads\//, '');
      const disposition = worktreeDisposition(
        run.local_path, w.path, branch, run.branch || 'HEAD'
      );
      return {
        path: w.path,
        branch,
        dirty: disposition.dirty,
        unmerged: disposition.unmerged,
        removed: false,
        stranded: false,
        skipped_at_risk: false,
      };
    }),
    summary: null,
  };

  if (apply) {
    for (const entry of report.worktrees) {
      // F-d2025a4d(b): a DIRTY or UNMERGED worktree needs --force in
      // addition to --apply — matching rewind's contract for the identical
      // uncommitted-work risk. worktreeDisposition already computed both
      // flags above (for the preview); this is the missing "and act on it"
      // half. Clean (non-dirty, merged) worktrees are unaffected — --apply
      // alone still reclaims them in one step.
      if ((entry.dirty || entry.unmerged) && !force) {
        entry.skipped_at_risk = true;
        report.skippedAtRisk++;
        continue;
      }
      const outcome = removeWorktree(run.local_path, entry.path, entry.branch);
      entry.removed = outcome.removed;
      entry.stranded = outcome.stranded;
      if (outcome.stranded) {
        report.stranded++;
      } else {
        report.removed++;
        // F-78a13f53 (Stage C): clean is the single most destructive verb in
        // this package (module header above) — a --force removal of a DIRTY
        // or UNMERGED worktree is permanent, unrecoverable loss of real
        // work, and no compensator can exist after the fact (unlike
        // defer/reject, which can undo a disposition). Yet this file called
        // logStage() zero times anywhere (confirmed by grep), unlike every
        // sibling recovery verb (clean-claims/collect/dispatch/redrive/
        // resume/revalidate/rewind/verify*). The dry-run preview above does
        // warn the operator before the fact — this is a forensic-trail gap
        // AFTER informed consent, not a silent-corruption defect — but a
        // durable record of the act itself is the only mitigation available
        // once a worktree is gone. One line per entry actually removed, so
        // "did anyone force-clean this run's worktrees, which ones, and did
        // it override a dirty/unmerged guard" has a greppable answer.
        logStage('worktree_force_cleaned', {
          component: 'dogfood-swarm',
          runId: opts.runId,
          worktreePath: entry.path,
          branch: entry.branch,
          dirty: entry.dirty,
          unmerged: entry.unmerged,
          force: !!force,
        });
      }
    }
  }
  // Dry-run: nothing is touched; per-entry removed/stranded stay false and
  // the rollup counters stay 0 so the JSON output is internally consistent
  // (F-54cb35f4 — the old code marked every entry stranded:true as a
  // rendering convenience while the top-level rollup said stranded:0).
  // formatClean branches on report.apply for the '[would remove]' tag and
  // does not need a per-entry flag.

  report.summary = formatPlanSummary(report);
  return report;
}

function formatPlanSummary(report) {
  const verb = report.apply ? 'Clean (APPLIED)' : 'Clean (DRY-RUN)';
  const lines = [];
  lines.push(`${verb} — run ${report.runId} (${report.repo})`);
  lines.push(`  Worktrees for this run: ${report.total}`);
  if (report.apply) {
    lines.push(`  Removed:  ${report.removed}`);
    lines.push(`  Stranded: ${report.stranded} (see worktree_cleanup_failed breadcrumbs)`);
    // F-d2025a4d(b): named on its own line so a --force-less apply that
    // skipped at-risk worktrees is never mistaken for "nothing was there".
    if (report.skippedAtRisk > 0) {
      lines.push(`  Skipped (dirty/unmerged, needs --force): ${report.skippedAtRisk}`);
    }
  } else {
    lines.push('  Re-run with --apply to remove them.');
  }
  return lines.join('\n');
}

/**
 * Human-readable formatter for the clean report. Plain-ASCII, no ANSI —
 * renders identically under CI logs (matches the formatHistory / formatRedrive
 * discipline).
 */
export function formatClean(report) {
  let out = report.summary + '\n';

  if (report.worktrees.length === 0) {
    out += '\nNo stranded worktrees for this run.\n';
    return out;
  }

  out += '\nWorktrees:\n';
  for (const w of report.worktrees) {
    let tag;
    if (!report.apply) {
      tag = (w.dirty || w.unmerged) ? '[would SKIP]' : '[would remove]';
    } else if (w.skipped_at_risk) {
      tag = '[SKIPPED]';
    } else if (w.removed) {
      tag = '[REMOVED]';
    } else {
      tag = '[STRANDED]';
    }
    // F-1ab3fd1f sibling: name the at-risk state inline so `--apply` is
    // informed consent, not a surprise. F-d2025a4d(b): the note now reflects
    // the --force gate — a dirty/unmerged worktree is no longer destroyed by
    // --apply alone.
    const risk = [];
    if (w.dirty) risk.push('DIRTY: uncommitted edits');
    if (w.unmerged) risk.push('UNMERGED commits');
    let riskNote = '';
    if (risk.length > 0) {
      if (!report.apply) {
        riskNote = `  [!] ${risk.join(' + ')} — --apply alone will SKIP this; add --force to destroy it`;
      } else if (w.skipped_at_risk) {
        riskNote = `  [!] ${risk.join(' + ')} — skipped; re-run with --apply --force to destroy it`;
      } else {
        riskNote = `  [!] ${risk.join(' + ')} — destroyed (--force was set)`;
      }
    }
    out += `  ${tag} ${w.path}  (branch ${w.branch})${riskNote}\n`;
  }
  return out;
}
