/**
 * clean-claims.js — `swarm clean-claims <run-id> [--wave=N] [--agent-run=ID]
 *                    [--apply --reason "<text>"] [--format=text|json]`
 *
 * The phantom-claims recovery verb. Deletes `violation=1` file_claims rows
 * stranded on TERMINAL waves — rows no lawful verb can revisit.
 *
 * The gap this closes (proven live, run swarm-1784091637-5127, 2026-07-15):
 * 346 phantom violation=1 rows accumulated on terminal (`advanced`) waves
 * 2+4. Wave 2's rows: revalidate flipped the agent_runs
 * ownership_violation → complete under a corrected domain map but (pre-
 * F-67ddcd02) never cleared their claim rows. Wave 4's rows: the
 * F-COORD-DIFFBASE broken diff base charged "402 phantom violations; zero
 * real". No verb could reach them once the waves advanced:
 *
 *   - collect()    only runs on a 'dispatched' wave;
 *   - revalidate() only repairs BLOCKED agent_runs on the run's LATEST wave
 *                  (and reconciles only the repaired agent's claims);
 *   - redrive()    refuses terminal waves outright (WAVE_TERMINAL — promotion
 *                  is immutable).
 *
 * The reconcileFileClaims() fix (collect.js, shared with revalidate.js)
 * prevents NEW stale rows but cannot retroactively clean data that predates
 * it. That repair was performed as manual out-of-verb DB surgery (HANDOFF.md,
 * "Wave-6 corners"); this verb is the lawful CLI surface for the same repair
 * class.
 *
 * Doctrine (reconcileFileClaims, collect.js): file_claims rows are a CLAIM
 * about what a pass observed, not an audit event — deleting a superseded
 * claim is the lawful write, not data loss. The audit trail for WHY an
 * agent_run reached its status lives in agent_state_events and is NEVER
 * touched by this verb.
 *
 * Jurisdiction taxonomy — each refusal names the verb that still owns the row
 * (mirrors redrive.js's eligibility table):
 *
 *   wave dispatched/collecting  → REFUSED (collect's jurisdiction — its
 *                                 reconcile supersedes stale claims when the
 *                                 wave lands)
 *   wave failed                 → REFUSED (revalidate repairs blocked agents
 *                                 + reconciles; redrive re-opens the tail)
 *   wave pending/collected/verified
 *                               → REFUSED (non-terminal — redrive can re-open
 *                                 it; the next collect reconciles)
 *   wave TERMINAL (advanced / aborted_for_rewind):
 *     agent BLOCKED + wave is the run's latest + agent_run is latest-per-
 *     (wave, domain)            → REFUSED (still within revalidate's reach)
 *     agent running             → REFUSED (in-flight by the timeout policy —
 *                                 let it land first; mirrors redrive)
 *     anything else             → ELIGIBLE
 *
 * Recovery-verb contract (revalidate / rewind / redrive / clean):
 *
 *   - Dry-run by default; --apply required to mutate. The dry-run lists every
 *     eligible row group with wave/domain/file_path and the
 *     agent_state_events evidence that supersedes the claims (the last
 *     transition + event count), so --apply is informed consent.
 *   - --reason required WITH --apply (recorded with the `clean-claims:`
 *     prefix). Design call: unlike revalidate/redrive — whose dry-runs
 *     preview a specific planned mutation the operator already intends —
 *     this verb's dry-run is a pure read-only survey (the closest sibling,
 *     `swarm clean`, has the same posture). The listing is how the operator
 *     DISCOVERS what the reason should say; requiring one just to look would
 *     invert that.
 *   - dbPath required, no implicit default — tests never touch the live
 *     control plane.
 *   - Run-scoped with runtime-enforced isolation: the mutation is a
 *     count-guarded transactional DELETE by explicit row id (the same shape
 *     as the 2026-07-15 manual surgery), and the tx re-checks two
 *     independent watch-sets after the delete — this run's violation=0 row
 *     count and the whole-DB other-run row count. Either moving throws and
 *     rolls back (CLEAN_CLAIMS_SCOPE_VIOLATION), so "never touch
 *     violation=0 / never touch other runs" is enforced at runtime, not just
 *     by query construction (the F-a5f6b585 independent-watch-set posture).
 *   - Named compensator: one domain_events row per affected domain
 *     (event_type 'file_claims_cleaned', reason-prefixed). old_value carries
 *     the FULL deleted row set ({agent_run_id, file_path, claim_type,
 *     domain_id, violation}) so a mistaken --apply is restorable by
 *     re-inserting from the audit payload; new_value records the domain's
 *     remaining violation-claim count. Rows land in the same tx as the
 *     DELETE. (`swarm domains <run-id> --history` surfaces them.)
 */

import { openDb } from '../db/connection.js';
import { TERMINAL_STATUSES as WAVE_TERMINAL_STATUSES } from '../lib/wave-state-machine.js';
import { BLOCKED_STATUSES as AGENT_BLOCKED_STATUSES } from '../lib/state-machine.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import { logStage } from '../lib/log-stage.js';
import { mintCorrelationId } from '../lib/correlation-id.js';
import { escapeReasonForDisplay } from './lib/escape-reason.js';

// SQLite bind-parameter ceiling is host-dependent (999 on older builds);
// batching the id-list DELETE keeps the verb safe at any row count.
const DELETE_BATCH_SIZE = 500;

/**
 * @param {object} opts
 * @param {string} opts.runId — required
 * @param {string} opts.dbPath — control-plane DB path (required, no default)
 * @param {number|string} [opts.wave] — optional wave_number filter (this run)
 * @param {number|string} [opts.agentRun] — optional agent_runs.id filter
 * @param {string} [opts.reason] — required with --apply; recorded in
 *   domain_events with the `clean-claims:` prefix
 * @param {boolean} [opts.apply] — without this, dry-run only (no mutation)
 * @returns {object} — report
 */
export function cleanClaims(opts) {
  const { dbPath, reason, apply } = opts;

  if (!opts.runId || typeof opts.runId !== 'string') {
    throw new Error('clean-claims: <run-id> is required');
  }
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('clean-claims: dbPath is required (no implicit default)');
  }
  if (apply && (!reason || typeof reason !== 'string' || !reason.trim())) {
    throw new Error('clean-claims: --reason "<text>" is required with --apply (non-empty)');
  }

  let waveFilter = null;
  if (opts.wave !== undefined && opts.wave !== null && opts.wave !== '') {
    waveFilter = Number(opts.wave);
    if (!Number.isInteger(waveFilter) || waveFilter <= 0) {
      throw new Error(`clean-claims: --wave must be a positive integer wave number (got ${JSON.stringify(opts.wave)})`);
    }
  }
  let agentRunFilter = null;
  if (opts.agentRun !== undefined && opts.agentRun !== null && opts.agentRun !== '') {
    agentRunFilter = Number(opts.agentRun);
    if (!Number.isInteger(agentRunFilter) || agentRunFilter <= 0) {
      throw new Error(`clean-claims: --agent-run must be a positive integer agent_runs.id (got ${JSON.stringify(opts.agentRun)})`);
    }
  }

  const db = openDb(dbPath);

  const run = db.prepare('SELECT id, repo FROM runs WHERE id = ?').get(opts.runId);
  if (!run) {
    const err = new Error(`clean-claims: run not found: ${opts.runId}`);
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }

  if (waveFilter !== null) {
    const w = db.prepare('SELECT id FROM waves WHERE run_id = ? AND wave_number = ?')
      .get(opts.runId, waveFilter);
    if (!w) {
      const err = new Error(`clean-claims: wave ${waveFilter} not found in run ${opts.runId}`);
      err.code = 'WAVE_NOT_FOUND';
      throw err;
    }
  }

  if (agentRunFilter !== null) {
    // Other-run isolation is LOUD at the addressing layer: an --agent-run id
    // that belongs to a sibling run is an operator addressing mistake, not a
    // row to silently skip.
    const owner = db.prepare(`
      SELECT ar.id, w.run_id FROM agent_runs ar
      JOIN waves w ON ar.wave_id = w.id
      WHERE ar.id = ?
    `).get(agentRunFilter);
    if (!owner) {
      const err = new Error(`clean-claims: agent_run not found: ${agentRunFilter}`);
      err.code = 'AGENT_RUN_NOT_FOUND';
      throw err;
    }
    if (owner.run_id !== opts.runId) {
      const err = new Error(
        `clean-claims: agent_run ${agentRunFilter} belongs to run ${owner.run_id}, not ${opts.runId} — ` +
        `this verb never touches another run's rows`
      );
      err.code = 'AGENT_RUN_NOT_IN_RUN';
      throw err;
    }
  }

  // ── Sweep: every violation=1 claim in this run (optionally narrowed) ──
  // Deliberately NOT filtered to the latest agent_run per domain: superseded
  // agent_runs' stale claims are exactly what this verb exists to reach.
  // (The query anchors on file_claims and joins agent_runs, so the wave-9
  // latest-per-domain discipline deliberately does not apply here — see this
  // file's allowlist entry in amend1-wave9-filter-discipline.test.js.)
  const rows = db.prepare(`
    SELECT fc.id AS claim_id, fc.file_path, fc.claim_type, fc.domain_id AS claim_domain_id,
           ar.id AS agent_run_id, ar.status AS agent_status,
           w.id AS wave_id, w.wave_number, w.status AS wave_status, w.phase,
           d.name AS domain_name, d.id AS domain_id
    FROM file_claims fc
    JOIN agent_runs ar ON fc.agent_run_id = ar.id
    JOIN waves w ON ar.wave_id = w.id
    JOIN domains d ON ar.domain_id = d.id
    WHERE w.run_id = ?
      AND fc.violation = 1
      ${waveFilter !== null ? 'AND w.wave_number = ?' : ''}
      ${agentRunFilter !== null ? 'AND ar.id = ?' : ''}
    ORDER BY w.wave_number, ar.id, fc.file_path
  `).all(
    opts.runId,
    ...(waveFilter !== null ? [waveFilter] : []),
    ...(agentRunFilter !== null ? [agentRunFilter] : []),
  );

  // Revalidate's remaining jurisdiction on a terminal wave: it targets the
  // run's LATEST wave regardless of status and repairs only BLOCKED
  // agent_runs that are the latest per (wave, domain) — its repair path runs
  // reconcileFileClaims, which clears these claims lawfully.
  const latestWave = db.prepare(
    'SELECT id FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1'
  ).get(opts.runId);
  const latestPerDomainOnLatestWave = new Set(
    latestWave
      ? db.prepare(`
          SELECT ar.id FROM agent_runs ar
          WHERE ar.wave_id = ?
            ${LATEST_AGENT_RUN_PER_DOMAIN}
        `).all(latestWave.id).map(r => r.id)
      : []
  );

  // ── Classify per agent_run (rows group naturally under the ORDER BY) ──
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.agent_run_id)) {
      groups.set(r.agent_run_id, {
        agent_run_id: r.agent_run_id,
        domain: r.domain_name,
        domain_id: r.domain_id,
        wave_id: r.wave_id,
        wave_number: r.wave_number,
        wave_status: r.wave_status,
        phase: r.phase,
        agent_status: r.agent_status,
        claims: [],
      });
    }
    groups.get(r.agent_run_id).claims.push({
      id: r.claim_id,
      file_path: r.file_path,
      claim_type: r.claim_type,
      domain_id: r.claim_domain_id,
    });
  }

  const eligible = [];
  const refused = [];

  for (const g of groups.values()) {
    const refusal = classifyRefusal(g, opts.runId, latestWave, latestPerDomainOnLatestWave);
    if (refusal) {
      refused.push({
        agent_run_id: g.agent_run_id,
        domain: g.domain,
        wave_number: g.wave_number,
        wave_status: g.wave_status,
        agent_status: g.agent_status,
        claim_count: g.claims.length,
        reason: refusal.reason,
        correct_verb: refusal.correct_verb,
      });
      continue;
    }

    // The agent_state_events evidence that supersedes the claims: the chain
    // is untouched by this verb, and its tail explains why the rows are
    // phantom (e.g. the revalidate override that flipped the agent complete,
    // or the broken-diff-base violation message a corrected pass superseded).
    const eventCount = db.prepare(
      'SELECT COUNT(*) AS n FROM agent_state_events WHERE agent_run_id = ?'
    ).get(g.agent_run_id).n;
    const lastEvent = db.prepare(
      'SELECT from_status, to_status, reason, created_at FROM agent_state_events ' +
      'WHERE agent_run_id = ? ORDER BY id DESC LIMIT 1'
    ).get(g.agent_run_id) || null;

    eligible.push({
      agent_run_id: g.agent_run_id,
      domain: g.domain,
      domain_id: g.domain_id,
      wave_id: g.wave_id,
      wave_number: g.wave_number,
      wave_status: g.wave_status,
      phase: g.phase,
      agent_status: g.agent_status,
      claim_count: g.claims.length,
      claims: g.claims,
      evidence: { event_count: eventCount, last_event: lastEvent },
      applied: false,
    });
  }

  const claimsEligible = eligible.reduce((n, g) => n + g.claim_count, 0);
  const claimsRefused = refused.reduce((n, g) => n + g.claim_count, 0);

  const report = {
    runId: opts.runId,
    repo: run.repo,
    dbPath,
    dryRun: !apply,
    apply: !!apply,
    reason: reason || null,
    reasonRecorded: apply ? `clean-claims: ${reason}` : null,
    filters: { wave: waveFilter, agentRun: agentRunFilter },
    eligible,
    refused,
    totals: {
      agent_runs_eligible: eligible.length,
      agent_runs_refused: refused.length,
      claims_eligible: claimsEligible,
      claims_refused: claimsRefused,
      deleted: 0,
    },
    audit_events: [],
    // False until the apply tx's post-delete watch-set re-check passes —
    // dry-run and nothing-eligible applies stay false, never a vacuous claim.
    scope_invariants_verified: false,
    summary: null,
  };

  if (apply && eligible.length > 0) {
    const claimIds = eligible.flatMap(g => g.claims.map(c => c.id));

    const countViolationZero = db.prepare(`
      SELECT COUNT(*) AS n FROM file_claims fc
      JOIN agent_runs ar ON fc.agent_run_id = ar.id
      JOIN waves w ON ar.wave_id = w.id
      WHERE w.run_id = ? AND fc.violation = 0
    `);
    const countOtherRuns = db.prepare(`
      SELECT COUNT(*) AS n FROM file_claims fc
      JOIN agent_runs ar ON fc.agent_run_id = ar.id
      JOIN waves w ON ar.wave_id = w.id
      WHERE w.run_id != ?
    `);

    const tx = db.transaction(() => {
      const violationZeroBefore = countViolationZero.get(opts.runId).n;
      const otherRunsBefore = countOtherRuns.get(opts.runId).n;

      let deleted = 0;
      for (let i = 0; i < claimIds.length; i += DELETE_BATCH_SIZE) {
        const batch = claimIds.slice(i, i + DELETE_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        deleted += db.prepare(
          `DELETE FROM file_claims WHERE id IN (${placeholders})`
        ).run(...batch).changes;
      }

      // Count-guarded, same as the manual surgery this verb replaces: a
      // mismatch means a concurrent writer moved the rows between the
      // planning pass and this tx — refuse and roll back rather than record
      // an audit payload that no longer matches what was deleted.
      if (deleted !== claimIds.length) {
        const err = new Error(
          `clean-claims: expected to delete ${claimIds.length} row(s), deleted ${deleted} — ` +
          `rows changed under us; transaction rolled back, nothing was mutated`
        );
        err.code = 'CLEAN_CLAIMS_COUNT_MISMATCH';
        throw err;
      }

      const violationZeroAfter = countViolationZero.get(opts.runId).n;
      const otherRunsAfter = countOtherRuns.get(opts.runId).n;
      if (violationZeroAfter !== violationZeroBefore || otherRunsAfter !== otherRunsBefore) {
        const err = new Error(
          `clean-claims: scope invariant violated — violation=0 rows ${violationZeroBefore} → ${violationZeroAfter}, ` +
          `other-run rows ${otherRunsBefore} → ${otherRunsAfter}. Transaction rolled back, nothing was mutated.`
        );
        err.code = 'CLEAN_CLAIMS_SCOPE_VIOLATION';
        throw err;
      }

      // Audit rows: one per affected domain, restorable payload (see header).
      const byDomain = new Map();
      for (const g of eligible) {
        if (!byDomain.has(g.domain_id)) {
          byDomain.set(g.domain_id, { domain: g.domain, groups: [] });
        }
        byDomain.get(g.domain_id).groups.push(g);
      }
      for (const [domainId, entry] of byDomain) {
        const deletedRows = entry.groups.flatMap(g =>
          g.claims.map(c => ({
            agent_run_id: g.agent_run_id,
            file_path: c.file_path,
            claim_type: c.claim_type,
            domain_id: c.domain_id,
            violation: 1,
          }))
        );
        const remaining = db.prepare(`
          SELECT COUNT(*) AS n FROM file_claims fc
          JOIN agent_runs ar ON fc.agent_run_id = ar.id
          JOIN waves w ON ar.wave_id = w.id
          WHERE w.run_id = ? AND fc.violation = 1 AND ar.domain_id = ?
        `).get(opts.runId, domainId).n;

        db.prepare(`
          INSERT INTO domain_events (domain_id, event_type, old_value, new_value, reason)
          VALUES (?, 'file_claims_cleaned', ?, ?, ?)
        `).run(
          domainId,
          JSON.stringify({
            deleted_count: deletedRows.length,
            agent_runs: entry.groups.map(g => g.agent_run_id),
            waves: [...new Set(entry.groups.map(g => g.wave_number))],
            rows: deletedRows,
          }),
          JSON.stringify({ violation_claims_remaining: remaining }),
          `clean-claims: ${reason}`,
        );
        report.audit_events.push({
          domain: entry.domain,
          domain_id: domainId,
          deleted: deletedRows.length,
        });
      }

      for (const g of eligible) g.applied = true;
      report.totals.deleted = deleted;
      report.scope_invariants_verified = true;
    });

    try {
      tx();
    } catch (e) {
      // The DB rolled back; reset the in-tx report writes so a caller that
      // catches the thrown error never sees applied-state that didn't land.
      report.audit_events = [];
      report.totals.deleted = 0;
      report.scope_invariants_verified = false;
      for (const g of eligible) g.applied = false;

      const correlationId = mintCorrelationId();
      logStage('clean_claims_db_tx_failed', {
        component: 'dogfood-swarm',
        correlation_id: correlationId,
        runId: opts.runId,
        dbPath,
        claimsPlanned: claimIds.length,
        err: e?.message,
      });
      if (e?.code === 'CLEAN_CLAIMS_COUNT_MISMATCH' || e?.code === 'CLEAN_CLAIMS_SCOPE_VIOLATION') {
        const wrapped = new Error(`${e.message} (correlation_id=${correlationId})`);
        wrapped.code = e.code;
        wrapped.runId = opts.runId;
        wrapped.hint = 'a concurrent writer touched this run\'s file_claims between planning and apply — ' +
          're-run the dry-run and inspect `swarm status` before retrying --apply';
        throw wrapped;
      }
      throw new Error(`clean-claims: DB transaction failed (correlation_id=${correlationId}): ${e?.message || e}`);
    }
  }

  report.summary = formatPlanSummary(report);
  return report;
}

/**
 * Refusal classification for one agent_run's claim group. Returns null when
 * the group is ELIGIBLE (no lawful verb can revisit its rows).
 */
function classifyRefusal(g, runId, latestWave, latestPerDomainOnLatestWave) {
  if (!WAVE_TERMINAL_STATUSES.has(g.wave_status)) {
    if (g.wave_status === 'dispatched' || g.wave_status === 'collecting') {
      return {
        correct_verb: 'collect',
        reason: `wave ${g.wave_number} is '${g.wave_status}' — collect's jurisdiction; ` +
          `\`swarm collect ${runId}\` reconciles this agent's claims when the wave lands`,
      };
    }
    if (g.wave_status === 'failed') {
      return {
        correct_verb: 'revalidate-or-redrive',
        reason: `wave ${g.wave_number} is 'failed' — \`swarm revalidate\` repairs its blocked agents ` +
          `(and reconciles their claims); \`swarm redrive\` re-opens the failure tail. ` +
          `clean-claims only touches terminal waves no lawful verb can revisit`,
      };
    }
    return {
      correct_verb: 'redrive',
      reason: `wave ${g.wave_number} is '${g.wave_status}' (non-terminal) — ` +
        `\`swarm redrive <wave-id> --reason "<text>" --apply\` can lawfully re-open it, ` +
        `and the next collect reconciles claims. clean-claims only touches terminal waves`,
    };
  }

  if (
    AGENT_BLOCKED_STATUSES.has(g.agent_status) &&
    latestWave && g.wave_id === latestWave.id &&
    latestPerDomainOnLatestWave.has(g.agent_run_id)
  ) {
    return {
      correct_verb: 'revalidate',
      reason: `agent_run is '${g.agent_status}' on the run's latest wave — still within ` +
        `\`swarm revalidate\`'s reach; its repair reconciles these claims lawfully`,
    };
  }

  if (g.agent_status === 'running') {
    return {
      correct_verb: 'wait-or-timeout',
      reason: `agent_run is 'running' — in-flight by the timeout policy; let it land ` +
        `(or time out) before cleaning its claims`,
    };
  }

  return null;
}

function formatPlanSummary(report) {
  const verb = report.apply ? 'Clean-claims (APPLIED)' : 'Clean-claims (DRY-RUN)';
  const t = report.totals;
  const waves = [...new Set(report.eligible.map(g => g.wave_number))].sort((a, b) => a - b);
  const waveNote = waves.length > 0 ? ` [wave${waves.length > 1 ? 's' : ''} ${waves.join(', ')}]` : '';
  const filterBits = [];
  if (report.filters.wave !== null) filterBits.push(`--wave=${report.filters.wave}`);
  if (report.filters.agentRun !== null) filterBits.push(`--agent-run=${report.filters.agentRun}`);
  const filterNote = filterBits.length > 0 ? ` (filtered: ${filterBits.join(' ')})` : '';

  const lines = [];
  lines.push(`${verb} — run ${report.runId} (${report.repo})${filterNote}`);
  if (report.apply) {
    lines.push(`  Deleted:  ${t.deleted} violation=1 file_claims row(s) across ${t.agent_runs_eligible} agent_run(s)${waveNote}`);
    lines.push(`  Refused:  ${t.agent_runs_refused} agent_run(s) / ${t.claims_refused} row(s) (named jurisdiction per row)`);
    lines.push(`  Audit:    ${report.audit_events.length} domain_events row(s) written (event_type file_claims_cleaned; restorable old_value)`);
    lines.push(`  Scope invariants: ${report.scope_invariants_verified ? 'VERIFIED (violation=0 rows + other-run rows untouched)' : 'not verified (nothing was deleted)'}`);
    // F-7c3e91a4 class (wave 18): immediate echo of the operator's own
    // just-typed --reason. See commands/lib/escape-reason.js.
    lines.push(`  Reason recorded: "${escapeReasonForDisplay(report.reasonRecorded)}"`);
  } else {
    lines.push(`  Eligible: ${t.claims_eligible} violation=1 file_claims row(s) across ${t.agent_runs_eligible} agent_run(s)${waveNote}`);
    lines.push(`  Refused:  ${t.agent_runs_refused} agent_run(s) / ${t.claims_refused} row(s) (named jurisdiction per row)`);
    lines.push('  Re-run with --apply --reason "<text>" to delete the eligible rows.');
  }
  return lines.join('\n');
}

// Text-format cap per agent_run: the wave-4 incident held 335 rows across six
// agents; dumping every path would bury the summary. --format=json carries
// the full list.
const MAX_FILES_SHOWN = 10;

/**
 * Human-readable formatter. Plain-ASCII, no ANSI — renders identically under
 * CI logs (matches formatClean / formatRedrive).
 */
export function formatCleanClaims(report) {
  let out = report.summary + '\n';

  if (report.eligible.length > 0) {
    out += report.apply ? '\nDeleted:\n' : '\nEligible (no lawful verb can revisit these):\n';
    for (const g of report.eligible) {
      const tag = g.applied ? '[DELETED]' : '[would delete]';
      out += `  ${tag} agent_run=${g.agent_run_id} (domain=${g.domain}, wave ${g.wave_number} '${g.wave_status}', ` +
        `phase ${g.phase}, agent '${g.agent_status}'): ${g.claim_count} violation row(s)\n`;
      const ev = g.evidence;
      if (ev.last_event) {
        // F-7c3e91a4 class (wave 18): a STORED agent_state_events.reason,
        // the agent-level twin of wave_state_events (fed by the same
        // revalidate.js override path via transitionAgent) — same
        // read-later hazard as `swarm history`. See commands/lib/escape-reason.js.
        const evReason = ev.last_event.reason ? ` — "${escapeReasonForDisplay(ev.last_event.reason)}"` : '';
        out += `    evidence: ${ev.event_count} agent_state_events row(s) (untouched); last: ` +
          `${ev.last_event.from_status} -> ${ev.last_event.to_status}` +
          `${evReason} (${ev.last_event.created_at})\n`;
      } else {
        out += '    evidence: no agent_state_events rows for this agent_run\n';
      }
      for (const c of g.claims.slice(0, MAX_FILES_SHOWN)) {
        out += `      ${c.file_path}\n`;
      }
      if (g.claims.length > MAX_FILES_SHOWN) {
        out += `      ... +${g.claims.length - MAX_FILES_SHOWN} more (see --format=json)\n`;
      }
    }
  }

  if (report.refused.length > 0) {
    out += '\nRefused:\n';
    for (const r of report.refused) {
      out += `  agent_run=${r.agent_run_id} (domain=${r.domain}, wave ${r.wave_number} '${r.wave_status}', ` +
        `agent '${r.agent_status}'): ${r.claim_count} row(s) — ${r.reason}\n`;
    }
  }

  if (report.eligible.length === 0 && report.refused.length === 0) {
    out += '\nNo violation=1 file_claims rows found for this scope.\n';
  }

  return out;
}
