/**
 * rewind.js — `swarm rewind <save-point-tag> --reason "<text>" [--apply]`
 *
 * Phase 5B-1 — the lawful Rewind verb. Rewinding is not a `git reset --hard`
 * shortcut. It is `git reset --hard <tag>` PLUS
 * `transitionAgent(... 'aborted_for_rewind', reason, override=true)` on every
 * in-flight agent_run PLUS
 * `transitionWave(... 'aborted_for_rewind', reason, override=true)` on every
 * non-terminal wave PLUS audit-event emission — all atomic relative to the
 * operator's --reason text.
 *
 * Architectural grounding:
 *
 *   - Save-points are git tags (created at `swarm init`). The session's
 *     existing save-point tags only capture git tree state; they do NOT
 *     snapshot SQLite control-plane state. Rewind therefore restores the
 *     tree and lawfully *aborts* (not deletes) any orphaned in-flight rows.
 *     DB-snapshot/restore in save-points is OUT OF SCOPE for 5B-1.
 *
 *   - Lawful abort uses the same override-with-reason primitive that
 *     `swarm revalidate --apply` ships in Phase 5A. The reason text is
 *     prefixed with `rewind: ` (mirror of `revalidate: ` at
 *     commands/revalidate.js:326) so the wave_state_events /
 *     agent_state_events audit trail is greppable for the verb that wrote
 *     the row.
 *
 *   - Order of operations: validate → git reset → DB transaction. Git
 *     cannot roll back inside a SQL transaction; the reverse (DB tx around
 *     git reset) would leave the tree at the target tag if SQL succeeded
 *     and git failed. Per better-sqlite3 semantics we wrap the DB writes
 *     in a single transaction so partial DB-side failures surface as a
 *     loud "split state" error (tree was reset; DB tx failed) — the
 *     operator must inspect manually rather than silently lose audit
 *     visibility.
 *
 *   - Dry-run by default. The operator previews the planned effects (tag
 *     resolution, list of affected waves + agent_runs, planned target
 *     statuses) before any mutation. `--apply` is the explicit opt-in to
 *     mutate. Same shape as `swarm revalidate`.
 *
 *   - DB rows survive the tree reset. The append-only audit trail
 *     (wave_state_events / agent_state_events) is the canonical record of
 *     what was lawfully torn down; deleting rows would erase forensic
 *     visibility. Completed (terminal) waves/agents are preserved as
 *     immutable history regardless of whether their files now match the
 *     rewound tree.
 *
 *   - Uncommitted-changes guard: refuse without --force. A rewind silently
 *     discarding uncommitted work would be the worst kind of operator
 *     surprise; `git reset --hard` is documented as destructive and this
 *     verb honors that documentation.
 *
 * Design calls surfaced at the dispatch level (returned in the report):
 *
 *   1. Save-point tag scope: only tags matching `swarm-save-*` by default.
 *      `--force-arbitrary-ref` opts into arbitrary refs (tags / branches /
 *      commits). Destructive verb; conservative defaults belong to the
 *      safer surface.
 *
 *   2. DB state in save-points: (a) tree reset + lawful abort of orphaned
 *      in-flight rows. NOT (b) DB snapshot/restore — that would require
 *      changes to save-point creation, out of 5B-1 scope.
 *
 *   3. Wave status target on rewind: new `aborted_for_rewind` wave status
 *      (parallel to the agent status). Reusing `failed` would be
 *      semantically misleading (the wave wasn't a logic failure); a
 *      same-status no-op write would lose the lifecycle signal entirely.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { openDb } from '../db/connection.js';
import { transitionAgent, TERMINAL_STATUSES as AGENT_TERMINAL_STATUSES } from '../lib/state-machine.js';
import { transitionWave, TERMINAL_STATUSES as WAVE_TERMINAL_STATUSES } from '../lib/wave-state-machine.js';
import { logStage } from '../lib/log-stage.js';

const REWIND_TARGET_STATUS = 'aborted_for_rewind';

/**
 * @param {object} opts
 * @param {string} opts.savePointTag — required, e.g. 'swarm-save-1778729230'
 * @param {string} opts.reason — required, non-empty audit text
 * @param {string} opts.cwd — working tree to operate on (required — never default to process.cwd())
 * @param {string} opts.dbPath — control-plane DB path (required)
 * @param {boolean} [opts.apply] — without this, dry-run only (no mutation)
 * @param {boolean} [opts.force] — allow rewind despite uncommitted changes (mirrors `git reset --hard`'s opt-in danger surface)
 * @param {boolean} [opts.forceArbitraryRef] — allow tags outside the `swarm-save-*` glob
 * @returns {object} — report
 */
export function rewind(opts) {
  const { savePointTag, reason, cwd, dbPath, apply, force, forceArbitraryRef } = opts;

  if (!savePointTag || typeof savePointTag !== 'string' || !savePointTag.trim()) {
    throw new Error('rewind: <save-point-tag> is required (non-empty string)');
  }
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    throw new Error('rewind: --reason "<text>" is required (non-empty string)');
  }
  if (!cwd || typeof cwd !== 'string') {
    throw new Error('rewind: cwd is required (no implicit process.cwd() default)');
  }
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('rewind: dbPath is required (no implicit default)');
  }

  // Tag-scope guard. Conservative default: only `swarm-save-*` tags. The
  // override is a separate flag, not bundled into --apply, so an operator
  // who *intends* to rewind to an arbitrary ref has to type that intent.
  if (!forceArbitraryRef && !/^swarm-save-/.test(savePointTag)) {
    throw new Error(
      `rewind: '${savePointTag}' does not match the swarm-save-* glob. ` +
      `Re-run with --force-arbitrary-ref to opt into arbitrary refs ` +
      `(destructive verb; conservative defaults).`,
    );
  }

  // Resolve the tag to a commit SHA. `git rev-parse --verify` exits 1 if the
  // ref does not resolve; we surface a clean error instead of the bare git
  // stderr noise.
  let targetSha;
  try {
    targetSha = execFileSync('git', ['rev-parse', '--verify', `${savePointTag}^{commit}`], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`rewind: save-point tag '${savePointTag}' not found in repo at ${cwd}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(targetSha)) {
    throw new Error(`rewind: tag '${savePointTag}' did not resolve to a commit SHA (got '${targetSha}')`);
  }

  // Current HEAD for diff context and the no-op short-circuit.
  let headSha;
  try {
    headSha = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`rewind: cwd '${cwd}' does not appear to be a git repository (no HEAD)`);
  }

  // Uncommitted-changes guard. Honour `git status --porcelain`: empty output
  // means clean. Without --force we refuse so the operator does not silently
  // lose work to a hard reset. --force matches the danger-opt-in posture of
  // git itself (`git reset --hard` is documented as destructive).
  let dirty = false;
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    dirty = porcelain.length > 0;
  } catch {
    dirty = false;
  }
  if (dirty && !force) {
    throw new Error(
      `rewind: working tree at ${cwd} has uncommitted changes. ` +
      `Re-run with --force to discard them, or commit/stash first ` +
      `(mirrors \`git reset --hard\`'s destructive opt-in surface).`,
    );
  }

  // No-op short-circuit. If HEAD already points at the target commit, we
  // skip the git reset entirely AND skip the DB writes. The audit trail
  // would otherwise pick up a same-status write for every wave, which
  // would erode the signal-to-noise of the breadcrumb in `swarm status`.
  const alreadyAtTag = headSha === targetSha;

  const db = openDb(dbPath);

  // cli-001 fix: resolve the run(s) that own THIS working tree before
  // collecting anything to abort. A single control-plane.db holds every run
  // across every repo (proved by `swarm runs`), so an unscoped abort drives
  // OTHER runs' live waves/agent_runs to the terminal `aborted_for_rewind`
  // status while the git reset only touches `cwd`. We match `runs.local_path`
  // against the rewind cwd (normalized for symlinks / trailing separators /
  // Windows casing) and scope every query below to those run ids. If no run
  // matches (e.g. an arbitrary-ref rewind in a tree with no registered run),
  // the abort set is empty by construction — the git reset still runs, but no
  // DB rows are touched, which is the correct conservative behavior.
  const cwdKey = normalizePathForMatch(cwd);
  const targetRunIds = db.prepare('SELECT id, local_path FROM runs').all()
    .filter(r => normalizePathForMatch(r.local_path) === cwdKey)
    .map(r => r.id);

  // Empty-set guard: `WHERE run_id IN ()` is a SQL syntax error and an empty
  // placeholder list would match nothing anyway. Short-circuit to empty
  // result sets so the dry-run plan + preserved counts reflect "no run owns
  // this tree" without issuing a malformed query.
  const runScope = targetRunIds.length > 0;
  const runPlaceholders = targetRunIds.map(() => '?').join(',');

  // Collect every wave + agent_run we would touch. Filter out terminal rows
  // (advanced waves, complete agents, prior aborted_for_rewind entries) AND
  // scope to the run(s) owning this working tree. The dry-run pass shows the
  // operator exactly what --apply would change.
  const waves = runScope ? db.prepare(
    'SELECT id, run_id, phase, wave_number, status FROM waves WHERE run_id IN (' +
    runPlaceholders + ') AND status NOT IN (' +
    [...WAVE_TERMINAL_STATUSES].map(() => '?').join(',') +
    ')'
  ).all(...targetRunIds, ...WAVE_TERMINAL_STATUSES) : [];

  // agent_runs has no run_id column — scope through waves.run_id via the join.
  const agentRuns = runScope ? db.prepare(`
    SELECT ar.id, ar.wave_id, ar.status, d.name AS domain_name
    FROM agent_runs ar
    JOIN domains d ON ar.domain_id = d.id
    JOIN waves w ON ar.wave_id = w.id
    WHERE w.run_id IN (${runPlaceholders})
      AND ar.status NOT IN (${[...AGENT_TERMINAL_STATUSES].map(() => '?').join(',')})
  `).all(...targetRunIds, ...AGENT_TERMINAL_STATUSES) : [];

  // 5B-1 fold-in (T4): preserved-count surface. The plan summary names what
  // rewind LEFT ALONE (terminal rows survive byte-identical) alongside what
  // it tore down. The operator's mental model is "rewind erases the failure
  // tail but preserves history" — the surface should reflect that, not just
  // the affected count. cli-001: these counts are also scoped to the target
  // run(s) so the preserved surface describes THIS tree's run, not the whole
  // shared DB.
  const preservedWaveCount = runScope ? db.prepare(
    'SELECT COUNT(*) AS n FROM waves WHERE run_id IN (' + runPlaceholders +
    ') AND status IN (' +
    [...WAVE_TERMINAL_STATUSES].map(() => '?').join(',') + ')'
  ).get(...targetRunIds, ...WAVE_TERMINAL_STATUSES).n : 0;

  const preservedAgentRunCount = runScope ? db.prepare(
    'SELECT COUNT(*) AS n FROM agent_runs ar JOIN waves w ON ar.wave_id = w.id ' +
    'WHERE w.run_id IN (' + runPlaceholders + ') AND ar.status IN (' +
    [...AGENT_TERMINAL_STATUSES].map(() => '?').join(',') + ')'
  ).get(...targetRunIds, ...AGENT_TERMINAL_STATUSES).n : 0;

  // Build the plan. Each entry carries the planned transition so the
  // operator can audit before --apply.
  const planned_waves = waves.map(w => ({
    wave_id: w.id,
    run_id: w.run_id,
    phase: w.phase,
    wave_number: w.wave_number,
    from_status: w.status,
    to_status: REWIND_TARGET_STATUS,
    applied: false,
  }));
  const planned_agent_runs = agentRuns.map(a => ({
    agent_run_id: a.id,
    wave_id: a.wave_id,
    domain: a.domain_name,
    from_status: a.status,
    to_status: REWIND_TARGET_STATUS,
    applied: false,
  }));

  const reasonPrefixed = `rewind: ${reason}`;

  const report = {
    savePointTag,
    targetSha,
    targetShaShort: targetSha.slice(0, 8),
    headShaBefore: headSha,
    headShaBeforeShort: headSha.slice(0, 8),
    cwd,
    dbPath,
    scopedRunIds: targetRunIds,
    dryRun: !apply,
    apply: !!apply,
    force: !!force,
    forceArbitraryRef: !!forceArbitraryRef,
    alreadyAtTag,
    workingTreeWasDirty: dirty,
    reason,
    reasonRecorded: reasonPrefixed,
    planned_waves,
    planned_agent_runs,
    preserved_wave_count: preservedWaveCount,
    preserved_agent_run_count: preservedAgentRunCount,
    git_reset_done: false,
    db_transaction_done: false,
    headShaAfter: null,
    state_split: false,
    summary: null,
    design_calls_surfaced: [
      {
        name: 'save_point_tag_scope',
        choice_made: 'glob_only:swarm-save-*',
        alternatives_considered: ['any_git_tag', 'any_git_ref_tags_branches_commits'],
        reasoning:
          'Destructive verb; conservative defaults belong on the safer surface. ' +
          'Operators rewinding outside the swarm-save-* lineage must explicitly opt in via ' +
          '--force-arbitrary-ref so the intent is recorded in shell history.',
      },
      {
        name: 'db_state_in_save_points',
        choice_made: 'tree_reset_plus_lawful_abort',
        alternatives_considered: ['tree_reset_plus_db_snapshot_restore'],
        reasoning:
          'Save-points today only capture git tree state — they do not snapshot SQLite. ' +
          'Adding DB snapshot/restore at rewind time would require corresponding changes to ' +
          'save-point CREATION (which is out of 5B-1 scope). Lawful abort via the existing ' +
          'transitionAgent/transitionWave override path keeps 5B-1 in its lane and preserves ' +
          'the append-only audit trail that makes the rewind inspectable.',
      },
      {
        name: 'wave_status_target_on_rewind',
        choice_made: 'new_aborted_for_rewind_status',
        alternatives_considered: ['reuse_failed', 'same_status_audit_only'],
        reasoning:
          'Reusing failed would be semantically misleading: the wave was not a logic failure, ' +
          'it was lawfully torn down by the operator. A same-status no-op write would erase ' +
          'the lifecycle signal entirely (an inspector cannot tell whether a dispatched wave ' +
          'is alive or aborted). Introducing aborted_for_rewind as a NEW terminal status ' +
          'parallel to the new agent status preserves both signal and audit trail.',
      },
    ],
  };

  // ── Dry-run early exit ──
  if (!apply) {
    report.summary = formatPlanSummary(report);
    return report;
  }

  // ── Apply: git reset BEFORE the DB transaction ──
  if (!alreadyAtTag) {
    try {
      execFileSync('git', ['reset', '--hard', savePointTag], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      report.git_reset_done = true;
    } catch (e) {
      const correlationId = mintCorrelationId();
      logStage('rewind_git_reset_failed', {
        component: 'dogfood-swarm',
        correlation_id: correlationId,
        savePointTag,
        targetSha,
        cwd,
        err: e?.message,
      });
      throw new Error(
        `rewind: git reset --hard ${savePointTag} failed in ${cwd} ` +
        `(correlation_id=${correlationId}): ${e?.message || e}`,
      );
    }

    // Verify the HEAD landed where we expect. A successful git reset that
    // somehow lands at a different commit would be a load-bearing surprise
    // — fail loud rather than write a misleading audit row.
    try {
      report.headShaAfter = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      report.headShaAfter = null;
    }
    if (report.headShaAfter !== targetSha) {
      throw new Error(
        `rewind: git reset claimed success but HEAD is at '${report.headShaAfter}' ` +
        `(expected '${targetSha}'). State split — inspect manually.`,
      );
    }
  } else {
    report.headShaAfter = headSha;
  }

  // ── Apply: DB transaction ──
  // Single tx — if any wave or agent transition fails, every prior write
  // in this batch rolls back. The git reset already landed; a failure here
  // surfaces loudly so the operator knows the tree and DB are out of sync.
  if (planned_waves.length > 0 || planned_agent_runs.length > 0) {
    const tx = db.transaction(() => {
      for (const ar of planned_agent_runs) {
        // override=true is required for blocked sources (invalid_output /
        // ownership_violation); harmless for non-blocked sources because the
        // override branch in transitionAgent only fires when the source is
        // in BLOCKED_STATUSES. Either way the agent_state_events audit row
        // lands with the rewind: reason prefix.
        transitionAgent(
          db,
          ar.agent_run_id,
          REWIND_TARGET_STATUS,
          reasonPrefixed,
          /* override */ true,
        );
        ar.applied = true;
      }
      for (const w of planned_waves) {
        // Same shape for waves. transitionWave's override branch fires for
        // BLOCKED_STATUSES (failed); the normal path covers everything else
        // because TRANSITIONS now contains an aborted_for_rewind edge from
        // every non-terminal wave status.
        transitionWave(
          db,
          w.wave_id,
          REWIND_TARGET_STATUS,
          reasonPrefixed,
          /* override */ true,
        );
        w.applied = true;
      }
    });

    try {
      tx();
      report.db_transaction_done = true;
    } catch (e) {
      const correlationId = mintCorrelationId();
      report.state_split = report.git_reset_done;
      logStage('rewind_db_tx_failed', {
        component: 'dogfood-swarm',
        correlation_id: correlationId,
        savePointTag,
        targetSha,
        cwd,
        dbPath,
        gitResetDone: report.git_reset_done,
        wavesPlanned: planned_waves.length,
        agentRunsPlanned: planned_agent_runs.length,
        err: e?.message,
      });
      const splitNote = report.state_split
        ? ' STATE SPLIT: git reset landed but DB transaction failed; inspect manually before retrying rewind.'
        : '';
      throw new Error(
        `rewind: DB transaction failed (correlation_id=${correlationId}): ${e?.message || e}.${splitNote}`,
      );
    }
  } else {
    // Nothing in flight — DB writes were a no-op. Still mark the tx as done
    // for report-shape consistency.
    report.db_transaction_done = true;
  }

  report.summary = formatPlanSummary(report);
  return report;
}

/**
 * Human-readable plan summary. Used both for the dry-run preview and the
 * post-apply confirmation. Keeps the operator's reading shape constant
 * across dry-run and apply.
 */
function formatPlanSummary(report) {
  const verb = report.apply ? 'Rewind (APPLIED)' : 'Rewind (DRY-RUN)';
  const lines = [];
  lines.push(`${verb} — save point: ${report.savePointTag}`);
  lines.push(`  Target commit: ${report.targetShaShort}`);
  lines.push(`  HEAD before:   ${report.headShaBeforeShort}`);
  if (report.alreadyAtTag) {
    lines.push('  Already at this tag — git reset will be a no-op.');
  }
  if (report.workingTreeWasDirty) {
    lines.push(`  Working tree was dirty${report.force ? ' (--force discarded uncommitted changes)' : ' (refused without --force)'}.`);
  }
  if (report.forceArbitraryRef) {
    lines.push('  --force-arbitrary-ref: bypassing the swarm-save-* glob.');
  }
  lines.push(`  Affected waves:      ${report.planned_waves.length}`);
  lines.push(`  Affected agent_runs: ${report.planned_agent_runs.length}`);
  // 5B-1 fold-in (T4): name preserved counts so the operator sees what
  // survives the rewind alongside what is torn down. Terminal rows (advanced
  // waves, complete agent_runs, prior aborted_for_rewind entries) survive
  // byte-identical; the surface here makes that explicit.
  lines.push(`  Preserved: ${report.preserved_wave_count} terminal waves, ${report.preserved_agent_run_count} terminal agent_runs (unchanged)`);
  if (report.apply) {
    lines.push(`  Reason recorded: "${report.reasonRecorded}"`);
  } else {
    lines.push(`  Reason would be: "rewind: ${report.reason}"`);
    lines.push('  Re-run with --apply to mutate.');
  }
  return lines.join('\n');
}

/**
 * Human-readable formatter for the rewind report. Mirrors formatRevalidate.
 */
export function formatRewind(report) {
  let out = report.summary + '\n';

  if (report.planned_waves.length > 0) {
    out += '\nWaves:\n';
    for (const w of report.planned_waves) {
      const tag = w.applied ? '[APPLIED]' : '[would]';
      out += `  ${tag} wave_id=${w.wave_id} (run=${w.run_id}, ${w.phase}, #${w.wave_number}): ${w.from_status} -> ${w.to_status}\n`;
    }
  }

  if (report.planned_agent_runs.length > 0) {
    out += '\nAgent runs:\n';
    for (const a of report.planned_agent_runs) {
      const tag = a.applied ? '[APPLIED]' : '[would]';
      out += `  ${tag} agent_run=${a.agent_run_id} (wave=${a.wave_id}, domain=${a.domain}): ${a.from_status} -> ${a.to_status}\n`;
    }
  }

  if (report.state_split) {
    out += '\n[!] STATE SPLIT: git reset succeeded but DB transaction failed. ' +
           'The working tree is at the rewind target but the control plane was NOT updated. ' +
           'Inspect manually before re-running rewind.\n';
  }

  return out;
}

function mintCorrelationId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `coord-${ts}-${rand}`;
}

/**
 * cli-001 fix: normalize a filesystem path for run-scoping comparison.
 *
 * The git reset is scoped to one working tree (the rewind `cwd`), but the
 * DB abort must be scoped to the SAME tree's run(s) — otherwise rewinding
 * run A in repo X drives run B's in-flight rows (possibly in repo Y, sharing
 * the single control-plane.db) to the terminal `aborted_for_rewind` status.
 *
 * `runs.local_path` is written via `resolve(repoPath)` at init time, but the
 * operator's `process.cwd()` at rewind time can differ by symlink resolution,
 * a trailing separator, or (on Windows) drive-letter / separator casing. We
 * compare on realpath when the path exists (collapses symlinks + casing on
 * case-insensitive filesystems), falling back to `resolve()` for paths that
 * no longer exist on disk. Returns a lowercased string so Windows
 * case-insensitive trees still match.
 */
function normalizePathForMatch(p) {
  if (!p || typeof p !== 'string') return '';
  let out;
  try {
    out = realpathSync(p);
  } catch {
    out = resolvePath(p);
  }
  return out.replace(/[\\/]+$/, '').toLowerCase();
}
