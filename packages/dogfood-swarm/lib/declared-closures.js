/**
 * declared-closures.js — an amend agent's fixes[] declaration closes the
 * findings it names. One definition, two callers: commands/collect.js (the
 * ordinary amend collect) and commands/revalidate.js (the corrected-envelope
 * repair of one), the same one-definition seam reconcileFileClaims and
 * scopeConfirmedToOwningDomain already established for that pair.
 *
 * WHY (observed in run swarm-1784601601-bd4a). The amend output schema has
 * always required fixes[] ({ finding_id, description }), the dispatch prompt
 * has always demanded it, the README lifecycle table has always promised
 * "the amend's fix is what marks it fixed" — and nothing ever read it.
 * collect() on an amend wave contributed zero findings to the lifecycle
 * pipeline, so the wave's approved findings stayed 'approved' forever. In the
 * live run, wave 3 (health-amend-a) collected clean with fixes[] naming 9 of
 * 10 approved findings; none closed; the next audit-class wave's classify
 * sweep (feature-audit — a lens that cannot rediscover health findings)
 * demoted them approved -> unverified, twice, and the coordinator closed them
 * by raw SQL with zero finding_events. This module is the missing consumer.
 *
 * Closure bookkeeping (the v10 C3 contract, docs/trajectory-and-closure.
 * dispatch.md): status='fixed', closure_kind='declared' (the enum value C3
 * shipped for exactly this closure — previously never written by anything),
 * verified_how='self_attested' (the declaring agent is also the verifier —
 * `swarm verify-fixed`'s independent v2 classifier is what AUDITS these rows
 * afterwards; loadFixedFindings reads status='fixed', so a declared closure
 * enters its anchor/cross_ref/allowlist scrutiny automatically).
 *
 * Authority rules, all fail-closed:
 *   - Only 'approved' rows are closable by declaration: approved is the one
 *     status findingsForDomain routes to amend agents, so a declaration
 *     against anything else is an agent exceeding its routing. A terminal row
 *     ('fixed'/'deferred'/'rejected') is the benign idempotent case — the
 *     `swarm redrive` re-collect re-processes the same output.json, and the
 *     second pass must not double-close or double-event.
 *   - The DECLARING domain must own the finding: glob match on a real
 *     file_path, exact filed_by_domain equality for a file-less row, nobody
 *     when filed_by_domain is itself NULL — the identical rule ROUTING
 *     (findingsForDomain), VOUCHING (collect.js#isVouchableByDomain,
 *     F-8a15be4c) and ID-REUSE (fingerprint.js#honorReusedFindingIds,
 *     F-ec18bc02) already answer to. Closing is the fourth call site of that
 *     one rule; without it any domain could close any other domain's finding
 *     by echoing an id from its own brief (the F-18d0ef6d shape, on the
 *     close-by-fix path).
 *   - An unknown id declares nothing (typo'd/hallucinated ids must never
 *     vacuously close anything).
 *
 * Every skip is returned AND logged as a structured event — the live run's
 * lesson is that silent non-consumption of fixes[] cost a hand-edited DB.
 */

import { matchesAnyGlob } from './findings-filter.js';
import { normalizeFilePathForGlobMatch } from './normalize-path.js';
import { logStage } from './log-stage.js';

/** Cap on the fixes[] description carried into the finding_events note. */
const MAX_NOTE_DESCRIPTION_CHARS = 160;

/**
 * Apply one complete amend agent's fixes[] declarations.
 *
 * Caller contract: only invoke for an agent that reached 'complete' — an
 * agent blocked on invalid_output/ownership_violation must not close
 * anything (its declarations are exactly as untrusted as its diff).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.runId
 * @param {number} opts.waveId — the amend wave doing the closing
 * @param {number} opts.agentRunId — the declaring agent_run (event provenance)
 * @param {string} opts.domainName — the declaring domain
 * @param {string[]} opts.domainGlobs — the frozen map's globs for that domain
 * @param {Array<{finding_id: string, description?: string}>} opts.fixes
 * @returns {{ closed: Array<{finding_id: string}>,
 *             skipped: Array<{finding_id: string, reason:
 *               'unknown_id'|'not_approved'|'already_closed'|'unowned',
 *               status?: string}> }}
 */
export function applyDeclaredFixes(db, opts) {
  const { runId, waveId, agentRunId, domainName, domainGlobs, fixes } = opts;
  const closed = [];
  const skipped = [];
  if (!Array.isArray(fixes) || fixes.length === 0) return { closed, skipped };

  const selectFinding = db.prepare(
    'SELECT id, finding_id, status, file_path, filed_by_domain FROM findings WHERE run_id = ? AND UPPER(finding_id) = ?'
  );
  // last_seen_wave bumps to the closing wave — the same convention
  // upsertFindings' updateFixed (the absence-closure path) already follows.
  const close = db.prepare(`
    UPDATE findings SET status = 'fixed', last_seen_wave = ?,
      closure_kind = 'declared', verified_how = 'self_attested'
    WHERE id = ?
  `);
  const insertEvent = db.prepare(`
    INSERT INTO finding_events (finding_id, event_type, wave_id, agent_run_id, notes, actor)
    VALUES (?, 'fixed', ?, ?, ?, ?)
  `);

  const skip = (findingId, reason, status) => {
    skipped.push({ finding_id: findingId, reason, ...(status ? { status } : {}) });
    logStage('declared_fix_skipped', {
      component: 'dogfood-swarm',
      run_id: runId,
      wave_id: waveId,
      agent_run_id: agentRunId,
      domain: domainName,
      finding_id: findingId,
      reason,
      ...(status ? { finding_status: status } : {}),
    });
  };

  for (const fix of fixes) {
    const declaredId = fix && fix.finding_id ? String(fix.finding_id) : '';
    if (!declaredId) continue; // schema-invalid entry; the validators own that refusal
    const row = selectFinding.get(runId, declaredId.toUpperCase());
    if (!row) {
      skip(declaredId, 'unknown_id');
      continue;
    }
    if (row.status === 'fixed' || row.status === 'deferred' || row.status === 'rejected') {
      skip(declaredId, 'already_closed', row.status);
      continue;
    }
    if (row.status !== 'approved') {
      skip(declaredId, 'not_approved', row.status);
      continue;
    }
    const owned = row.file_path != null
      ? matchesAnyGlob(normalizeFilePathForGlobMatch(row.file_path), domainGlobs)
      : row.filed_by_domain != null && row.filed_by_domain === domainName;
    if (!owned) {
      skip(declaredId, 'unowned');
      continue;
    }

    const desc = String(fix.description || '').slice(0, MAX_NOTE_DESCRIPTION_CHARS);
    close.run(waveId, row.id);
    insertEvent.run(
      row.id, waveId, agentRunId,
      `declared fixed by amend agent${desc ? ` — ${desc}` : ''}`,
      domainName,
    );
    closed.push({ finding_id: row.finding_id });
  }

  return { closed, skipped };
}
