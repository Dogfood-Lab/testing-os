/**
 * status.js — `swarm status`
 *
 * Query the control plane and produce a structured status report.
 * Shows: run state, current wave, domain snapshot, agent states,
 * finding counts (new/recurring/fixed), manual intervention needs,
 * wave resumability, and a "next action" recommendation.
 */

import { openDb } from '../db/connection.js';
import { isBlocked, isInFlight, getTimeoutPolicy } from '../lib/state-machine.js';
import { getWaveTransitionHistory, BLOCKED_STATUSES } from '../lib/wave-state-machine.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import { FINDING_GATED_PHASES, PHASE_MAP } from '../lib/advance.js';
import { isOpenFinding } from '../lib/finding-status.js';
import { formatDomainRow } from '../lib/domain-row.js';

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @returns {object} — structured status
 */
export function status(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  // Domains
  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ?').all(opts.runId);

  // All waves
  const waves = db.prepare(
    'SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number'
  ).all(opts.runId);

  // Current wave (latest)
  const currentWave = waves[waves.length - 1] || null;

  // Agent runs for current wave — F-H7 (Wave A1 D3): wave-9 latest-per-
  // (wave, domain) filter via the shared helper. Without the filter the
  // operator-display chrome showed the stale failed row alongside the
  // recovered complete row. Lower impact than the receipt/export sites but
  // same fix shape; sealed via the shared helper so it can't re-divide.
  let currentAgents = [];
  if (currentWave) {
    currentAgents = db.prepare(`
      SELECT ar.*, d.name as domain_name
      FROM agent_runs ar
      JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ?
        ${LATEST_AGENT_RUN_PER_DOMAIN}
    `).all(currentWave.id);
  }

  // Finding totals
  const allFindings = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(opts.runId);

  const findingsBySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const findingsByStatus = {};
  const openBySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

  for (const f of allFindings) {
    findingsBySeverity[f.severity] = (findingsBySeverity[f.severity] || 0) + 1;
    findingsByStatus[f.status] = (findingsByStatus[f.status] || 0) + 1;
    if (isOpenFinding(f.status)) {
      openBySeverity[f.severity] = (openBySeverity[f.severity] || 0) + 1;
    }
  }

  // Wave-specific finding counts
  let waveFindingCounts = { new: 0, recurring: 0, fixed: 0 };
  if (currentWave) {
    waveFindingCounts = {
      new: allFindings.filter(f => f.first_seen_wave === currentWave.id && f.status === 'new').length,
      recurring: allFindings.filter(f => f.last_seen_wave === currentWave.id && f.status === 'recurring').length,
      fixed: allFindings.filter(f => f.last_seen_wave === currentWave.id && f.status === 'fixed').length,
    };
  }

  // Half-state detection (collect-crash-during-upsert). collect.js persists
  // artifacts + flips agents to `complete` BEFORE the findings upsert and the
  // wave-status UPDATE (see commands/collect.js:503-507). If the upsert throws
  // (CollectUpsertError), the wave is left `dispatched` with every agent
  // `complete` and artifacts on disk, but ZERO findings referencing it — yet
  // `swarm status` would print *** READY TO COLLECT *** with no hint a collect
  // already failed. We measure both halves of that signature here (artifacts
  // present, findings absent) so computeAssessment can surface a
  // non-destructive breadcrumb. Counts are scoped to the current wave: an
  // artifact belongs to a wave through its agent_run; a finding through
  // first_seen_wave / last_seen_wave.
  let currentWaveArtifactCount = 0;
  let currentWaveFindingCount = 0;
  if (currentWave) {
    currentWaveArtifactCount = db.prepare(`
      SELECT COUNT(*) AS n FROM artifacts a
      JOIN agent_runs ar ON a.agent_run_id = ar.id
      WHERE ar.wave_id = ?
    `).get(currentWave.id).n;
    currentWaveFindingCount = allFindings.filter(
      f => f.first_seen_wave === currentWave.id || f.last_seen_wave === currentWave.id
    ).length;
  }

  // Violations across all waves — F-L1-001 (Wave A1 D3 fix-up): the
  // wave-9 family's same-file unlisted sibling. The `currentAgents` query
  // above adopted the helper; this violations subquery (advisor verifier
  // Lens-1 surfaced) inlined `agent_run_id IN (SELECT ar.id …)` with no
  // wave-9 filter, so stale file_claims rows from a redispatched failed
  // agent_run still inflated `cnt` after `swarm resume`. Apply the same
  // helper inside the subquery — `ar` is the agent_runs alias here, so the
  // fragment slots in directly.
  const violations = db.prepare(`
    SELECT COUNT(*) as cnt FROM file_claims
    WHERE violation = 1 AND agent_run_id IN (
      SELECT ar.id FROM agent_runs ar
      JOIN waves w ON ar.wave_id = w.id
      WHERE w.run_id = ?
        ${LATEST_AGENT_RUN_PER_DOMAIN}
    )
  `).get(opts.runId);

  // Verification receipt — scoped to the CURRENT wave (F-b22182da). The
  // TRUTH-001 serial-verify refusal keys on this row; a run-wide "latest
  // receipt anywhere" query let a stale passing receipt from an EARLIER wave
  // satisfy the check for a later --skip-verify wave that was never verified,
  // producing the exact false 'READY TO ADVANCE' claim TRUTH-001 exists to
  // prevent. The display block below reads the same row — wave-latest is the
  // honest display. Ordering mirrors lib/advance.js#checkVerification.
  const lastReceipt = currentWave
    ? db.prepare(`
        SELECT * FROM verification_receipts
        WHERE wave_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1
      `).get(currentWave.id)
    : null;

  // Wave receipt
  const waveReceipt = currentWave
    ? db.prepare('SELECT * FROM wave_receipts WHERE wave_id = ?').get(currentWave.id)
    : null;

  // Phase 5B-0: wave transition-history breadcrumb. Read wave_state_events
  // for the current wave so the audit row written by `swarm revalidate
  // --apply` (and any future override-bearing transition) is reachable from
  // the operator's natural scan-mode path. The breadcrumb only renders when
  // the wave has "interesting history" — any override transition out of a
  // BLOCKED source, OR more than one transition row. Common-case waves
  // (single dispatched->collected) do not get the breadcrumb so steady-state
  // status output stays uncluttered.
  const waveHistorySummary = currentWave
    ? summarizeWaveHistory(getWaveTransitionHistory(db, currentWave.id))
    : { count: 0, interesting: false, lastReason: null };

  // Agents needing manual intervention
  const blockedAgents = currentAgents.filter(a => isBlocked(a.status));
  const inFlightAgents = currentAgents.filter(a => isInFlight(a.status));
  const completeAgents = currentAgents.filter(a => a.status === 'complete');

  // Timeout policy
  const timeoutPolicy = getTimeoutPolicy(db, opts.runId);

  // COORD-003: read-only staleness detection. `applyTimeoutPolicy` (lib/
  // state-machine.js) is the ONE non-test caller of the timeout policy —
  // and it is resume.js's, which MUTATES (transitions a stale agent_run to
  // `timed_out`). status must stay a pure read (it is the operator's
  // inspect-only verb), so this recomputes the IDENTICAL predicate
  // (now - started_at > timeoutMs) without calling transitionAgent — a dead
  // agent should not have to wait for `swarm resume` to be told it is dead,
  // and status already holds both inputs (timeoutPolicy above, started_at
  // on every agent row) without ever doing the subtraction pre-fix.
  // nowMs is overridable for deterministic tests, mirroring resume's own
  // opts.nowMs. A NULL started_at is never stale — same defensive posture
  // as applyTimeoutPolicy's own NULL-started_at skip: we cannot prove
  // timing we do not have, so we do not guess.
  const nowMs = opts.nowMs || Date.now();
  const isStaleAgent = (a) => isInFlight(a.status) && !!a.started_at &&
    (nowMs - new Date(a.started_at).getTime()) > timeoutPolicy;
  const staleAgentCount = inFlightAgents.filter(isStaleAgent).length;

  // Compute advanceability + next action
  const assessment = computeAssessment(
    currentWave, currentAgents, openBySeverity, blockedAgents, inFlightAgents,
    {
      runId: opts.runId,
      savePointTag: run.save_point_tag,
      lastVerificationPassed: lastReceipt ? !!lastReceipt.passed : null,
      currentWaveArtifactCount,
      currentWaveFindingCount,
      staleAgentCount,
    }
  );

  return {
    run: {
      id: run.id,
      repo: run.repo,
      status: run.status,
      branch: run.branch,
      commitSha: run.commit_sha,
      savePointTag: run.save_point_tag,
      created: run.created_at,
      timeoutPolicy: `${Math.round(timeoutPolicy / 1000)}s`,
    },
    domains: domains.map(d => ({
      name: d.name,
      ownership: d.ownership_class,
      frozen: !!d.frozen,
      description: d.description,
    })),
    waves: {
      total: waves.length,
      current: currentWave ? {
        id: currentWave.id,
        number: currentWave.wave_number,
        phase: currentWave.phase,
        status: currentWave.status,
        domainSnapshotId: currentWave.domain_snapshot_id,
        serialVerifyRequired: !!currentWave.serial_verify_required,
        // F-f3c729eb: mirror serialVerifyRequired's dual-surface treatment. The
        // persisted wave-level degraded-attribution signal (set by collect.js
        // for a non-isolated amend wave) reached the receipt but not this
        // at-a-glance surface, so an operator whose ownership check rested on
        // agent self-report alone got no signal here. Observability only.
        ownershipProbeDegraded: !!currentWave.ownership_probe_degraded,
        history: waveHistorySummary,
      } : null,
    },
    agents: currentAgents.map(a => ({
      domain: a.domain_name,
      status: a.status,
      started: a.started_at,
      completed: a.completed_at,
      error: a.error_message,
      // COORD-003: computed here (not stored) — a read-only projection of
      // the same timeout-policy subtraction resume.js's applyTimeoutPolicy
      // performs mutably. Always `false` for a non-in-flight status.
      stale: isStaleAgent(a),
    })),
    agentSummary: {
      total: currentAgents.length,
      complete: completeAgents.length,
      inFlight: inFlightAgents.length,
      blocked: blockedAgents.length,
      stalePastTimeout: staleAgentCount,
    },
    findings: {
      total: allFindings.length,
      bySeverity: findingsBySeverity,
      byStatus: findingsByStatus,
      open: openBySeverity,
      thisWave: waveFindingCounts,
    },
    violations: violations?.cnt || 0,
    lastVerification: lastReceipt ? {
      passed: !!lastReceipt.passed,
      repoType: lastReceipt.repo_type,
      testCount: lastReceipt.test_count,
    } : null,
    waveReceipt: waveReceipt ? { json: waveReceipt.json_path, md: waveReceipt.md_path } : null,
    assessment,
  };
}

/**
 * Format status as human-readable text.
 */
export function formatStatus(s) {
  const lines = [];

  lines.push(`+------------------------------------------+`);
  lines.push(`|  SWARM CONTROL PLANE                     |`);
  lines.push(`+------------------------------------------+`);
  lines.push('');
  lines.push(`Run:     ${s.run.id}`);
  lines.push(`Repo:    ${s.run.repo}`);
  lines.push(`Status:  ${s.run.status}`);
  lines.push(`Branch:  ${s.run.branch} @ ${s.run.commitSha?.slice(0, 8)}`);
  if (s.run.savePointTag) {
    lines.push(`Save point: ${s.run.savePointTag}  (rollback: git reset --hard ${s.run.savePointTag})`);
  }
  lines.push(`Timeout: ${s.run.timeoutPolicy}`);
  lines.push('');

  // Domains
  const allFrozen = s.domains.every(d => d.frozen);
  lines.push(`Domains [${allFrozen ? 'FROZEN' : 'DRAFT'}]:`);
  for (const d of s.domains) {
    // F-a35340ef: render ownership_class as a trailing parenthetical via the
    // shared formatDomainRow, so the class sits in the same position here as on
    // `swarm domains`. Frozen state stays hoisted to the section header above,
    // so no per-row bracket (frozen omitted).
    lines.push(formatDomainRow({ name: d.name, ownership: d.ownership, description: d.description }));
  }
  lines.push('');

  // Current wave
  if (s.waves.current) {
    const w = s.waves.current;
    lines.push(`Wave ${w.number}/${s.waves.total} — ${w.phase} [${w.status}]`);
    if (w.domainSnapshotId) lines.push(`  Snapshot: ${w.domainSnapshotId}`);
    // F-f3c729eb: render the degraded-attribution breadcrumb at the same
    // surface where the operator reads gate state — using the `[!]` content
    // sigil the assessment frames use for obligation states, and the same
    // re-dispatch remediation the receipt renders (receipt.js:287).
    if (w.ownershipProbeDegraded) {
      lines.push('  [!] ownership probe DEGRADED — re-dispatch with --isolate for full attribution');
    }
    if (w.history && w.history.interesting) {
      lines.push(`  History: ${w.history.count} ${w.history.count === 1 ? 'transition' : 'transitions'}${w.history.lastReason ? ` (last reason: "${w.history.lastReason}")` : ''} — see \`swarm history ${w.id}\``);
    }
    lines.push('');

    // Agent table
    lines.push('Agents:');
    for (const a of s.agents) {
      const icon = STATUS_ICONS[a.status] || a.status;
      const detail = a.error ? ` — ${a.error}` : '';
      // COORD-003: the ONE line an operator scanning `swarm status` reads
      // per agent — a stale in-flight agent must be visibly distinguishable
      // from one that is genuinely still working, not indistinguishable
      // until `swarm resume` (a mutating verb) is run to find out.
      const staleTag = a.stale ? ' [STALE — past timeout policy]' : '';
      lines.push(`  [${icon}] ${a.domain}${detail}${staleTag}`);
    }
    const staleSuffix = s.agentSummary.stalePastTimeout > 0
      ? `, ${s.agentSummary.stalePastTimeout} stale (past timeout)`
      : '';
    lines.push(`  (${s.agentSummary.complete} complete, ${s.agentSummary.inFlight} in-flight, ${s.agentSummary.blocked} blocked${staleSuffix})`);
    lines.push('');
  }

  // Findings
  const f = s.findings;
  lines.push('Findings:');
  lines.push(`  Open:  CRIT ${f.open.CRITICAL}  HIGH ${f.open.HIGH}  MED ${f.open.MEDIUM}  LOW ${f.open.LOW}  (${f.total} total)`);
  lines.push(`  Wave:  ${f.thisWave.new} new  ${f.thisWave.recurring} recurring  ${f.thisWave.fixed} fixed`);
  if (Object.keys(f.byStatus).length > 0) {
    lines.push(`  All:   ${Object.entries(f.byStatus).map(([k, v]) => `${k}: ${v}`).join('  ')}`);
  }
  lines.push('');

  if (s.violations > 0) {
    lines.push(`Ownership violations: ${s.violations}`);
    lines.push('');
  }

  if (s.lastVerification) {
    const v = s.lastVerification;
    lines.push(`Verify: ${v.passed ? 'PASS' : 'FAIL'} (${v.repoType}${v.testCount ? `, ${v.testCount} tests` : ''})`);
    lines.push('');
  }

  if (s.waveReceipt) {
    lines.push(`Receipt: ${s.waveReceipt.md}`);
    lines.push('');
  }

  // D-STRUCT-001: three-tier visual treatment by assessment class so the
  // shape of the frame carries the same information as the LABEL text.
  // Operators scanning past status output cannot pre-attentively distinguish
  // a green state from a red state when every state renders inside the same
  // `--- LABEL ---` frame. The chosen markers (`=====`, `***`, `---`) and
  // the `[!]` content sigil are pure-ASCII so they render identically under
  // CI plaintext logs, screen-readers, and Markdown.
  //   FAILED-class  →  `===== [!] LABEL [!] =====`  (heavy + obligation sigil)
  //   READY-class   →  `*** LABEL ***`              (light, distinct)
  //   neutral       →  `--- LABEL ---`              (current)
  lines.push(frameAssessment(s.assessment.state));
  if (s.assessment.blockers.length > 0) {
    for (const b of s.assessment.blockers) lines.push(`  BLOCKER: ${b}`);
  }
  lines.push(`Next: ${s.assessment.nextAction}`);

  return lines.join('\n');
}

const FAILED_CLASS_STATES = new Set([
  'WAVE FAILED',
  'BLOCKED',
  'VERIFY REQUIRED',
  'AMEND NEEDED',
]);

const READY_CLASS_STATES = new Set([
  'READY TO COLLECT',
  'READY TO ADVANCE',
]);

function frameAssessment(state) {
  if (FAILED_CLASS_STATES.has(state)) {
    return `===== [!] ${state} [!] =====`;
  }
  if (READY_CLASS_STATES.has(state)) {
    return `*** ${state} ***`;
  }
  return `--- ${state} ---`;
}

/**
 * Phase 5B-0: classify a wave's transition history for the status-output
 * breadcrumb. "Interesting" means the operator's deep-audit verb (`swarm
 * history`) has something worth showing beyond the common-case
 * single-transition record.
 *
 * Triggers:
 *   1. Any override transition out of a BLOCKED source status (currently
 *      'failed' → anything; this is the canonical `swarm revalidate --apply`
 *      audit row).
 *   2. Phase 5B-1: any rewind transition (to_status === 'aborted_for_rewind').
 *      A rewind is always operator-initiated through a destructive verb and
 *      should never blend into the steady-state status output — surfacing it
 *      via the breadcrumb routes the operator to `swarm history` for the
 *      reason text.
 *   3. More than one transition row recorded (legitimate happy path
 *      dispatched→collected→advanced is fine but worth a hint that the
 *      audit chain has multiple steps).
 *
 * Common case (a fresh wave with a single dispatched→collected/failed
 * transition) gets NO breadcrumb so steady-state `swarm status` output
 * does not gain a per-wave line.
 *
 * @param {Array<{from_status:string,to_status:string,reason:string|null}>} events
 * @returns {{ count:number, interesting:boolean, lastReason:(string|null) }}
 */
export function summarizeWaveHistory(events) {
  const count = events.length;
  if (count === 0) {
    return { count: 0, interesting: false, lastReason: null };
  }

  const hasOverride = events.some(e => BLOCKED_STATUSES.has(e.from_status));
  const hasRewind = events.some(e => e.to_status === 'aborted_for_rewind');
  const interesting = hasOverride || hasRewind || count > 1;

  let lastReason = null;
  if (interesting) {
    const last = events[events.length - 1];
    if (last && last.reason) {
      lastReason = truncateReason(last.reason, 60);
    }
  }

  return { count, interesting, lastReason };
}

function truncateReason(s, w) {
  const str = String(s);
  if (str.length <= w) return str;
  if (w <= 3) return str.slice(0, w);
  return str.slice(0, w - 3) + '...';
}

const STATUS_ICONS = {
  complete: 'OK  ',
  dispatched: '..  ',
  running: 'RUN ',
  pending: 'WAIT',
  failed: 'FAIL',
  timed_out: 'TIME',
  invalid_output: 'BAD ',
  ownership_violation: 'VIOL',
};

/**
 * F-091578-010 (wave-17): build a status-specific actionable hint when a
 * blocked agent has no `error_message`. The bare 'needs manual fix' fallback
 * was Mike's textbook "wrong shape" anti-pattern — this surfaces what's
 * known (status, domain, run, wave) and a copy-pasteable next step.
 *
 * Exported for direct unit testing without spinning up an entire wave.
 */
export function blockerHintForStatus(status, ctx = {}) {
  const { runId, waveNumber, domain } = ctx;
  switch (status) {
    case 'invalid_output':
      return [
        `output JSON failed schema validation`,
        `correct the output JSON on disk, then \`swarm revalidate ${runId ?? '<run-id>'} --reason "<text>" --domain=${domain ?? '<domain>'}:<corrected.json> --apply\` (dry-run without --apply)`,
        `inspect parse errors with \`swarm receipt ${runId ?? '<run>'} ${waveNumber ?? '<wave>'}\``,
      ].join('; ');
    case 'ownership_violation':
      return [
        `agent edited files outside its domain`,
        `either revert out-of-domain edits and re-collect, OR fix files_changed in the output JSON and \`swarm revalidate ${runId ?? '<run-id>'} --reason "<text>" --domain=${domain ?? '<domain>'}:<corrected.json> --apply\``,
      ].join('; ');
    default:
      return `agent in '${status}' with no recoverable error — inspect with \`swarm receipt ${runId ?? '<run>'} ${waveNumber ?? '<wave>'}\``;
  }
}

export function computeAssessment(wave, agents, openBySeverity, blocked, inFlight, ctx = {}) {
  if (!wave) {
    return { state: 'NO WAVE', blockers: [], nextAction: 'Run `swarm dispatch <run-id> <phase>`' };
  }

  const blockers = [];
  const hintCtx = { runId: ctx.runId, waveNumber: wave.wave_number };

  // Blocked agents
  if (blocked.length > 0) {
    for (const a of blocked) {
      const reason = a.error_message
        ? a.error_message
        : blockerHintForStatus(a.status, { ...hintCtx, domain: a.domain_name });
      blockers.push(`${a.domain_name}: ${a.status} — ${reason}`);
    }
  }

  // In-flight agents
  if (inFlight.length > 0) {
    // COORD-002(c) + COORD-003: this hint previously told the operator to
    // "run `swarm resume` to check timeouts" — but resume is a MUTATING
    // redispatch verb (and, pre-COORD-002, could force-destroy uncommitted
    // worktree work with no gate at all), not a check. status now computes
    // staleness itself (ctx.staleAgentCount, from the read-only timeout
    // subtraction above), so the hint can point at resume for what it
    // actually is — redispatching agents the operator has decided are
    // dead — instead of framing it as a safe inspection step.
    const staleCount = ctx.staleAgentCount || 0;
    const nextAction = staleCount > 0
      ? `Waiting on ${inFlight.length} agent(s), ${staleCount} past the timeout policy (see [STALE] above). ` +
        `Dead agents don't report their own death; \`swarm resume\` will redispatch them, but it force-recreates ` +
        `each isolated worktree — uncommitted work there is destroyed unless the worktree is clean (refuses by ` +
        `default; --force overrides). See \`swarm resume --help\`.`
      : `Waiting on ${inFlight.length} agent(s). Run \`swarm resume\` once you believe they have finished or exceeded the timeout policy.`;
    return {
      state: 'IN PROGRESS',
      blockers,
      nextAction,
    };
  }

  // All done but blocked
  if (blocked.length > 0) {
    return {
      state: 'BLOCKED',
      blockers,
      nextAction: 'Fix blocked agents, then run `swarm collect` again.',
    };
  }

  // F-15fc601e: a wave failed for missing outputs (F-aba6fa9d) leaves its
  // agents in 'failed'/'timed_out' — redispatchable, NOT blocked — so the
  // allComplete check below would render INCOMPLETE and recommend `swarm
  // resume`. That was a three-verb dead-end: resume redispatches the failed
  // agents but never flips the wave out of 'failed', so collect then refuses
  // ('No dispatched wave found') and revalidate refuses too (the agents are
  // not blocked). The lawful verb that flips BOTH the wave and the agents
  // back to dispatched is `swarm redrive <wave-id>` — route there BEFORE the
  // INCOMPLETE branch.
  const failedTail = agents.filter(a => a.status === 'failed' || a.status === 'timed_out');
  if (wave.status === 'failed' && failedTail.length > 0) {
    return {
      state: 'WAVE FAILED',
      blockers,
      nextAction:
        `${failedTail.length} agent(s) in '${[...new Set(failedTail.map(a => a.status))].join("'/'")}' on a failed wave. ` +
        `Recover with \`swarm redrive ${wave.id} --reason "<text>" --apply\` (flips the wave AND the failure tail back to dispatched), ` +
        `re-run the agent(s), then \`swarm collect\`.`,
    };
  }

  // Check if all complete
  const allComplete = agents.every(a => a.status === 'complete');
  if (!allComplete) {
    const incomplete = agents.filter(a => a.status !== 'complete');
    return {
      state: 'INCOMPLETE',
      blockers,
      nextAction: `Run \`swarm resume\` — ${incomplete.length} agent(s) not complete.`,
    };
  }

  // All complete — wave status check
  if (wave.status === 'dispatched') {
    // Half-state breadcrumb (collect-crash-during-upsert). When the wave is
    // still `dispatched` with every agent `complete` AND artifacts were
    // persisted but ZERO findings reference this wave, a prior `swarm collect`
    // most likely threw during the findings upsert (CollectUpsertError) after
    // committing artifacts + agent transitions but before the wave-status
    // UPDATE. The bare "READY TO COLLECT / Run `swarm collect`" output hid
    // that a collect already ran and failed — even though the collect error
    // itself told the operator to "inspect with swarm status". Surface a
    // non-destructive hint; the recovery (re-run collect) is the same, so the
    // happy path (no artifacts yet → collect never ran) is unchanged.
    const collectMayHaveFailed =
      ctx.currentWaveArtifactCount > 0 && ctx.currentWaveFindingCount === 0;
    if (collectMayHaveFailed) {
      return {
        state: 'READY TO COLLECT',
        blockers,
        nextAction:
          'Agents reported complete and artifacts were persisted, but no findings were ' +
          'persisted for this wave — a prior `swarm collect` may have failed during the ' +
          'findings upsert. Re-run `swarm collect`, or check logs / `swarm receipt` for the ' +
          'collect error.',
      };
    }
    return {
      state: 'READY TO COLLECT',
      blockers,
      nextAction: 'Run `swarm collect` to merge outputs.',
    };
  }

  if (wave.status === 'collected' || wave.status === 'verified') {
    // TRUTH-001: serial-verify discipline — if the wave was dispatched with
    // --skip-verify and the coordinator's authoritative cumulative-tree verify
    // has not landed (no passing verification_receipts row), refuse to claim
    // READY TO ADVANCE. The wave is `collected`, not verified. The literal
    // string "Wave complete" was false in this state (PROTOCOL.md §Serial
    // final verification names the coordinator's verify as the authoritative
    // pass). State distinguishes "collected but serial-verify pending" from
    // "collected and verified".
    if (wave.serial_verify_required && ctx.lastVerificationPassed !== true) {
      return {
        state: 'VERIFY REQUIRED',
        blockers,
        nextAction: 'Run `npm run verify` against the cumulative tree (one serial pass — see PROTOCOL.md §Serial final verification). Advancing without it skips the authoritative verification for this wave.',
      };
    }
    // Check severity gates. The set of finding-gated phases is owned by
    // lib/advance.js (FINDING_GATED_PHASES) — `swarm advance` rejects an
    // open CRITICAL/HIGH in ANY of health-audit-a/b/c and stage-d-audit.
    // Keying only on health-audit-a here would tell the operator "READY TO
    // ADVANCE" in health-audit-b/c or stage-d-audit while advance blocks.
    if (FINDING_GATED_PHASES.has(wave.phase) && (openBySeverity.CRITICAL > 0 || openBySeverity.HIGH > 0)) {
      const amendPhase = PHASE_MAP[wave.phase]?.amend ?? '<amend-phase>';
      return {
        state: 'AMEND NEEDED',
        blockers,
        nextAction: `${openBySeverity.CRITICAL} CRITICAL + ${openBySeverity.HIGH} HIGH open. Run \`swarm approve\` then \`swarm dispatch <run-id> ${amendPhase}\`.`,
      };
    }
    return {
      state: 'READY TO ADVANCE',
      blockers,
      nextAction: 'Wave complete. Export receipt, then dispatch next phase.',
    };
  }

  if (wave.status === 'failed') {
    // OPF-1: when any agent_run is in a BLOCKED status (invalid_output /
    // ownership_violation), the lawful repair primitive is `swarm revalidate`
    // (commit 80a22d5). The wave-rollback path stays available for
    // unsalvageable waves but is the heavyweight option.
    if (blocked.length > 0) {
      return {
        state: 'WAVE FAILED',
        blockers,
        nextAction: `If the agent outputs are correctable in place: \`swarm revalidate ${ctx.runId ?? '<run-id>'} --reason "<text>" --domain=<name>:<corrected.json> --apply\` (wave flips back to collected when every agent reaches complete). If unsalvageable: \`git reset --hard ${ctx.savePointTag ?? '<save-point-tag>'}\` and re-dispatch.`,
      };
    }
    return {
      state: 'WAVE FAILED',
      blockers,
      nextAction: `Inspect failures. \`git reset --hard ${ctx.savePointTag ?? '<save-point-tag>'}\` and re-dispatch, or salvage with explicit justification.`,
    };
  }

  return {
    state: wave.status.toUpperCase(),
    blockers,
    nextAction: 'Inspect wave state.',
  };
}
