/**
 * latest-agent-runs.js — Wave-9 latest-per-(wave, domain) filter helper.
 *
 * Background. After `swarm resume` runs, the wave gains a new agent_run row
 * per redispatched domain (resume.js INSERTs at status='pending', then
 * transitions to 'dispatched'); the OLD failed/timed_out row remains in
 * agent_runs by design (the audit trail must survive recovery). Read-side
 * queries that iterate ALL agent_runs for a wave then over-report agent
 * counts, count findings twice, and most importantly mark a wave as
 * non-passing because the stale failed row is still visible — even when
 * every redispatched agent succeeded.
 *
 * The fix is a single SQL fragment:
 *
 *     AND ar.id = (
 *       SELECT MAX(ar2.id) FROM agent_runs ar2
 *       WHERE ar2.wave_id = ar.wave_id AND ar2.domain_id = ar.domain_id
 *     )
 *
 * Mutation-side callers (collect.js, resume.js, revalidate.js, advance.js)
 * already had this inlined. Read-side callers (receipt.js, status.js,
 * lib/persist/export.js — TWO sites at :37-41 and :47-53) did NOT — they
 * surfaced the stale row to the receipt, audit-DB export, and operator
 * display, flipping recovered waves to non-pass against the durable
 * audit-DB ground truth (H6 / H7 / H8 family, Wave A1 D3).
 *
 * This module is the single source of truth for the fragment so the family
 * cannot re-divide. The mechanical guard in
 * `amend1-wave9-filter-discipline.test.js` scans every `FROM agent_runs`
 * site under `packages/dogfood-swarm/**` and fails on any read site that
 * isn't either using `LATEST_AGENT_RUN_PER_DOMAIN` or in the allowlist of
 * shapes (single-row-by-id lookups, aggregate diagnostics in tests, etc.).
 *
 * Naming. The fragment is named after its semantic ("latest agent_run per
 * domain in a wave"), not the columns it selects, so the same fragment can
 * be glued into queries that JOIN domains for the display layer (status.js,
 * receipt.js) or queries that pull `ar.*` for downstream consumers
 * (collect.js, resume.js).
 *
 * ISOLATION-MODE ASSUMPTION (F-4220149f — read before trusting a superseded
 * row's discarded state is safe to ignore). Every consumer of this fragment
 * implicitly treats a superseded (non-latest) agent_run's data as safe to
 * drop — the ownership-violation gate (lib/advance.js#checkViolations) is the
 * sharpest example: a `violation=1` file_claims row on a superseded agent_run
 * is invisible to the gate. That is PROVEN safe for a `swarm resume`
 * redispatch under `--isolate` dispatch, because worktree.js#createWorktree
 * always force-removes and recreates a fresh worktree from HEAD before the
 * redispatch — the surviving row's clean file_claims genuinely reflects a
 * wiped tree. It is UNVERIFIED for non-isolated dispatch (a real, supported
 * mode — see `waves.dispatch_sha` / `waves.ownership_probe_degraded` in
 * db/schema.js): a failed first attempt's stray out-of-domain edit is not
 * guaranteed to be reverted or re-examined by the resumed attempt's own
 * collect() pass, so a superseded row's discarded violation could, in that
 * mode, be a real ownership violation this fragment silently hides from every
 * consumer. Nothing in this module enforces, checks, or records which mode a
 * given wave ran under — it can only trust the caller. checkViolations
 * partially closes the blind spot by surfacing an informational note (not a
 * block — this module still cannot prove which mode applied) whenever a
 * superseded agent_run carries a violation the latest row does not.
 */

/**
 * Single SQL fragment, intended to be concatenated INSIDE the WHERE clause
 * of a query that already has `agent_runs ar` aliased and has bound `wave_id`
 * upstream (see usage below).
 *
 * Usage shape:
 *   const sql = `
 *     SELECT ar.* FROM agent_runs ar
 *     WHERE ar.wave_id = ?
 *       ${LATEST_AGENT_RUN_PER_DOMAIN}
 *   `;
 *   db.prepare(sql).all(waveId);
 *
 * The fragment LEADS with `AND` so callers can chain it into any WHERE
 * predicate without thinking about whether they need to invert it. If your
 * query has no prior predicate, replace the leading `AND` with `WHERE`.
 */
export const LATEST_AGENT_RUN_PER_DOMAIN = `
  AND ar.id = (
    SELECT MAX(ar2.id) FROM agent_runs ar2
    WHERE ar2.wave_id = ar.wave_id AND ar2.domain_id = ar.domain_id
  )
`;

/**
 * Default-shape read-side helper. Returns the latest agent_run row per
 * domain for a wave, joined to `domains` so callers get the human-readable
 * domain name + ownership_class without re-issuing a second query.
 *
 * For callers that need a different column set or shape (e.g. collect.js
 * wants ar.* + d.globs, receipt.js wants ar.* + d.ownership_class), prefer
 * inlining the fragment via {@link LATEST_AGENT_RUN_PER_DOMAIN} so the
 * caller's query shape stays explicit at the call site. This helper exists
 * for the common case (status.js display + the audit-DB export ground truth
 * in lib/persist/export.js).
 *
 * @param {Database} db — better-sqlite3 connection
 * @param {number} waveId
 * @returns {Array<{ id, wave_id, domain_id, status, started_at, completed_at,
 *                   output_path, error_message, worktree_path, worktree_branch,
 *                   domain_name, ownership_class }>}
 */
export function latestAgentRunsForWave(db, waveId) {
  return db.prepare(`
    SELECT ar.*, d.name as domain_name, d.ownership_class
    FROM agent_runs ar
    JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ?
      ${LATEST_AGENT_RUN_PER_DOMAIN}
    ORDER BY d.name
  `).all(waveId);
}

/**
 * Registry of every call site under `packages/dogfood-swarm/**` that
 * intentionally goes through the wave-9 family (either by importing
 * {@link LATEST_AGENT_RUN_PER_DOMAIN}, calling {@link latestAgentRunsForWave},
 * or — for queries with shape requirements that don't fit the helper —
 * inlining the EXACT fragment text).
 *
 * The mechanical guard (`amend1-wave9-filter-discipline.test.js`) consults
 * this registry when it scans `FROM agent_runs` sites. A new site appearing
 * in source that isn't either:
 *   1. listed here (legitimate latest-per-domain consumer), OR
 *   2. matched by an allowlist pattern in the guard itself (single-row
 *      lookup by id, aggregate diagnostics, etc.)
 *
 * fails the guard. This forces a thinking step on the next maintainer who
 * touches a wave-9 site: either adopt the helper, or extend the allowlist
 * with a reason.
 */
export const WAVE9_FAMILY_CALL_SITES = Object.freeze([
  // Read-side (the H6/H7/H8 sites this wave fixed)
  { file: 'commands/receipt.js', purpose: 'agent_runs surface for receipt JSON+md' },
  { file: 'commands/status.js', purpose: 'agent_runs for current-wave display' },
  { file: 'lib/persist/export.js', purpose: 'audit-DB ground truth (agents + violations)' },
  // Mutation-side (already correct pre-wave; switched to the helper for lockstep)
  { file: 'commands/collect.js', purpose: 'iterate agent_runs for collect/upsert' },
  { file: 'commands/resume.js', purpose: 'redispatch eligibility loop' },
  { file: 'commands/revalidate.js', purpose: 'validation pass + post-repair recheck (3 sites)' },
  { file: 'lib/advance.js', purpose: 'agent completion + violation gates' },
  // F-7970a30b: dispatch's superseded-failed-wave warning counts the LATEST
  // blocked agent_runs of the prior failed wave.
  { file: 'commands/dispatch.js', purpose: 'blocked-agent count for the revalidate-window-closing warning' },
]);
