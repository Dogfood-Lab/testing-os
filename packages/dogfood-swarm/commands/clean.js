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
 */

import { openDb } from '../db/connection.js';
import { listWorktrees, removeWorktree } from '../lib/worktree.js';

/**
 * Derive the run-short slug createWorktree uses for the branch namespace.
 * Kept identical to lib/worktree.js#createWorktree so the run-scope filter is
 * exact. A change there must change here.
 */
function runShortOf(runId) {
  return runId.replace(/^swarm-/, '').slice(0, 12);
}

/**
 * @param {object} opts
 * @param {string} opts.runId — required
 * @param {string} opts.dbPath — control-plane DB path (required, no default)
 * @param {boolean} [opts.apply] — without this, dry-run only (no removal)
 * @returns {object} — report with { removed, stranded, total, worktrees, ... }
 */
export function clean(opts) {
  const { dbPath, apply } = opts;

  if (!opts.runId || typeof opts.runId !== 'string') {
    throw new Error('clean: <run-id> is required');
  }
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('clean: dbPath is required (no implicit default)');
  }

  const db = openDb(dbPath);

  const run = db.prepare('SELECT id, repo, local_path FROM runs WHERE id = ?').get(opts.runId);
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
    total: mine.length,
    removed: 0,
    stranded: 0,
    worktrees: mine.map(w => ({
      path: w.path,
      branch: (w.branch || '').replace(/^refs\/heads\//, ''),
      removed: false,
      stranded: false,
    })),
    summary: null,
  };

  if (apply) {
    for (const entry of report.worktrees) {
      const outcome = removeWorktree(run.local_path, entry.path, entry.branch);
      entry.removed = outcome.removed;
      entry.stranded = outcome.stranded;
      if (outcome.stranded) report.stranded++;
      else report.removed++;
    }
  } else {
    // Dry-run: every listed worktree is a "would-remove" survivor; nothing is
    // touched. removed/stranded stay 0 so the rollup reads honestly as "no
    // mutation happened" — the operator reads `total` for the blast radius.
    for (const entry of report.worktrees) entry.stranded = true;
  }

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
    if (!report.apply) tag = '[would remove]';
    else tag = w.removed ? '[REMOVED]' : '[STRANDED]';
    out += `  ${tag} ${w.path}  (branch ${w.branch})\n`;
  }
  return out;
}
