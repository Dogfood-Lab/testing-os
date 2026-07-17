/**
 * drain.js — T6 drain-queue compilation (F-6c807f60,
 * docs/trajectory-and-closure.dispatch.md).
 *
 * TWO HALVES, explicitly scoped per F-6c807f60's own recommendation
 * ("leaving it unstated is not [fine], per this run's own honesty-is-a-
 * feature ethos"):
 *
 *   1. GRANDFATHERED-MANIFEST DRAIN (compileGrandfatheredManifestDrain).
 *      scripts/regression-pin-allowlist.json ALREADY carries exactly the
 *      { reason, file, owner, revalidate_by } shape T6 asks for, enforced by
 *      scripts/check-finding-regression-pins.mjs#loadAllowlist in CI. This
 *      function reads the JSON file directly — git-alone, per T1's own "from
 *      the control-plane DB and git alone" constraint — and projects entries
 *      whose revalidate_by has passed. It duplicates only the minimal
 *      parse+filter needed here rather than importing loadAllowlist: that
 *      script lives at the repo root, outside the npm workspace package
 *      graph, with no stable export contract to depend on, and the CI gate
 *      (not this advisory reader) remains the authority on allowlist
 *      validity — a malformed file here degrades to `available: false`
 *      rather than throwing or duplicating the gate's own strict validation.
 *
 *   2. DEFERRED-FINDINGS DRAIN (compileDeferredFindingsDrain),
 *      DISCLOSED-WEAKER. C3's v10 migration does NOT add owner/
 *      revalidate_by columns to `findings` in this pass (a disclosed scope
 *      decision made THIS wave, not an oversight — see this domain's wave-39
 *      output notes). Deferred findings therefore get ONLY last_seen_wave-
 *      based staleness: an entry is "stale" once its last_seen_wave is
 *      `staleWaveThreshold` or more waves behind the run's most recent wave.
 *      This is weaker than the allowlist's owner+date cadence (no named
 *      owner, no explicit re-review date) but HONEST about being weaker.
 *
 * BOUNDARY CONVENTIONS ARE DELIBERATE AND DIFFER BY HALF (F-1cd5de59 pins
 * exactly this ambiguity as the interesting bug surface — "an entry exactly
 * AT its cadence... is ambiguous between 'due now' and 'due next time'
 * unless the comparison operator is pinned by a test"):
 *
 *   - GRANDFATHERED-MANIFEST (date deadline): INCLUSIVE. `revalidate_by`
 *     reads as "no later than this date" — an entry whose date is TODAY is
 *     already due, not due tomorrow. `dueAt <= now` fires.
 *   - DEFERRED-FINDINGS (run/wave-count interval): EXCLUSIVE, matching
 *     F-1cd5de59's own pinned example verbatim ("reviewed 5 runs ago,
 *     cadence=5" -> "at exactly cadence (not yet overdue) and one at
 *     cadence+1 (overdue)"). `wavesBehind > staleWaveThreshold` fires — a
 *     finding exactly AT the threshold gets one more wave before it
 *     surfaces, matching the swarm-cp-tests brief's explicit test-shape
 *     recommendation for this exact function, so the pinning test that
 *     lane writes this same wave (fixture-level, in their own worktree)
 *     agrees with this implementation at merge rather than disagreeing on
 *     an unstated boundary choice.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// H5 discipline: this file lives under an audited repo's `repoRoot` — which
// for dogfood-swarm is not necessarily THIS repo, it is whatever target the
// swarm is running against (the same "untrusted target-repo file" class as
// lib/verify/adapters/node.js reading the audited repo's package.json) — so
// the read goes through the bounded reader rather than a bare parse of a
// raw synchronous file read.
import { readBoundedJson } from '../bounded-json-read.js';

const ALLOWLIST_RELATIVE_PATH = 'scripts/regression-pin-allowlist.json';

/** Deferred findings default to "stale" at 3+ waves behind the run's newest wave. */
export const DEFAULT_STALE_WAVE_THRESHOLD = 3;

/**
 * @param {string} repoRoot
 * @param {Date} [now]
 * @returns {{
 *   available: boolean,
 *   overdue: Array<{ finding_id: string, reason: string, file: string, owner: string, revalidate_by: string }>,
 * }} — `overdue` ordered revalidate_by ASC (most overdue first), then
 *   finding_id ASC (deterministic tiebreak).
 */
export function compileGrandfatheredManifestDrain(repoRoot, now = new Date()) {
  // F-874c0683 (self-caught, compile.js's own test suite): repoRoot is
  // documented as OPTIONAL at the compileRoadmap level ("omitted -> degrades
  // to unavailable/zero-signal rather than throwing"), but join(undefined,
  // ...) throws a raw TypeError instead of the documented degraded shape —
  // guard BEFORE calling join, matching getChurnStats' own never-throws
  // contract for the identical "optional repo path" shape.
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return { available: false, overdue: [] };
  const path = join(repoRoot, ALLOWLIST_RELATIVE_PATH);
  if (!existsSync(path)) return { available: false, overdue: [] };

  let parsed;
  try {
    parsed = readBoundedJson(path);
  } catch {
    return { available: false, overdue: [] };
  }
  if (!parsed || typeof parsed.allow !== 'object' || parsed.allow === null || Array.isArray(parsed.allow)) {
    return { available: false, overdue: [] };
  }

  const overdue = [];
  for (const [findingId, entry] of Object.entries(parsed.allow)) {
    if (!entry || typeof entry.revalidate_by !== 'string') continue;
    const dueAt = new Date(`${entry.revalidate_by}T00:00:00Z`);
    if (Number.isNaN(dueAt.getTime())) continue;
    if (dueAt.getTime() <= now.getTime()) {
      overdue.push({
        finding_id: findingId,
        reason: entry.reason || '',
        file: entry.file || '',
        owner: entry.owner || '',
        revalidate_by: entry.revalidate_by,
      });
    }
  }

  overdue.sort((a, b) =>
    a.revalidate_by < b.revalidate_by ? -1
    : a.revalidate_by > b.revalidate_by ? 1
    : (a.finding_id < b.finding_id ? -1 : a.finding_id > b.finding_id ? 1 : 0));

  return { available: true, overdue };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} [opts]
 * @param {number} [opts.staleWaveThreshold=DEFAULT_STALE_WAVE_THRESHOLD]
 * @returns {{ stale: Array<{ finding_id: string, file_path: string|null, last_seen_wave: number, waves_behind: number }> }}
 *   — `stale` ordered waves_behind DESC (most stale first), then finding_id ASC.
 */
export function compileDeferredFindingsDrain(db, runId, opts = {}) {
  const { staleWaveThreshold = DEFAULT_STALE_WAVE_THRESHOLD } = opts;

  const maxWaveRow = db.prepare(`SELECT MAX(wave_number) AS max_wave FROM waves WHERE run_id = ?`).get(runId);
  const maxWave = maxWaveRow?.max_wave ?? 0;

  const deferred = db.prepare(`
    SELECT f.finding_id AS finding_id, f.file_path AS file_path, w.wave_number AS last_seen_wave_number
    FROM findings f
    LEFT JOIN waves w ON w.id = f.last_seen_wave
    WHERE f.run_id = ? AND f.status = 'deferred'
    ORDER BY f.finding_id ASC
  `).all(runId);

  const stale = [];
  for (const row of deferred) {
    const lastSeenWaveNumber = row.last_seen_wave_number ?? 0;
    const wavesBehind = maxWave - lastSeenWaveNumber;
    // EXCLUSIVE boundary (F-1cd5de59, pinned verbatim — see this module's
    // header): exactly AT staleWaveThreshold is NOT yet stale; the entry
    // needs to be STRICTLY past it.
    if (wavesBehind > staleWaveThreshold) {
      stale.push({
        finding_id: row.finding_id,
        file_path: row.file_path,
        last_seen_wave: lastSeenWaveNumber,
        waves_behind: wavesBehind,
      });
    }
  }

  stale.sort((a, b) => b.waves_behind - a.waves_behind || (a.finding_id < b.finding_id ? -1 : 1));

  return { stale };
}

/**
 * F-32e2ed6f: findings that are `approved` (queued for an amend wave) but
 * structurally UNROUTABLE by any mechanism this pass ships —
 * findingsForDomain's file_path glob match cannot select them (no
 * file_path), and its filed_by_domain fallback cannot either (either
 * filed_by_domain is NULL — pre-this-attribution-feature history, F-ad2d6318
 * — or it names a domain that is not live in this run's CURRENT frozen map,
 * e.g. a domain renamed or dropped since the finding was filed). Proven live
 * against this run's own data: 40 approved feature findings with
 * file_path/filed_by_domain both NULL, permanently stuck in `approved` with
 * no lawful path to `fixed` (see F-e71f9e7a's backfill mechanism, this same
 * domain, for the remediation these ids need).
 *
 * ADVISORY ONLY, matching this module's existing posture (compileGrandfathered
 * ManifestDrain/compileDeferredFindingsDrain never gate — they surface a
 * count and a list so an operator can act, via `swarm close` or a
 * filed_by_domain backfill). This section does the same: it does not fail a
 * wave, it does not block anything — it makes a fact that was already true
 * and already provable from this run's own data visible in the artifact an
 * operator actually reads (`swarm roadmap show`), instead of requiring a
 * hand-written SQL query to discover.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @returns {{ count: number, findings: Array<{ finding_id: string, filed_by_domain: string|null }> }}
 *   — `findings` ordered finding_id ASC (deterministic, matching every other
 *   array this compiler emits).
 */
export function compileUnroutableApprovedDrain(db, runId) {
  const liveDomainNames = new Set(
    db.prepare(`SELECT name FROM domains WHERE run_id = ?`).all(runId).map((r) => r.name),
  );

  const approvedFileless = db.prepare(`
    SELECT finding_id, filed_by_domain
    FROM findings
    WHERE run_id = ? AND status = 'approved' AND file_path IS NULL
    ORDER BY finding_id ASC
  `).all(runId);

  const findings = approvedFileless.filter(
    (row) => row.filed_by_domain == null || !liveDomainNames.has(row.filed_by_domain),
  );

  return { count: findings.length, findings };
}

/**
 * Compose both drain-queue halves plus the unroutable-approved advisory.
 * Pure orchestration — no new logic beyond the functions above.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} opts.repoRoot
 * @param {Date} [opts.now]
 * @param {number} [opts.staleWaveThreshold]
 * @returns {{
 *   grandfathered_manifest: ReturnType<typeof compileGrandfatheredManifestDrain>,
 *   deferred_findings: ReturnType<typeof compileDeferredFindingsDrain>,
 *   deferred_findings_scope_note: string,
 *   unroutable_approved: ReturnType<typeof compileUnroutableApprovedDrain>,
 * }}
 */
export function compileDrainQueue(db, runId, opts = {}) {
  const { repoRoot, now, staleWaveThreshold } = opts;
  return {
    grandfathered_manifest: compileGrandfatheredManifestDrain(repoRoot, now),
    deferred_findings: compileDeferredFindingsDrain(db, runId, { staleWaveThreshold }),
    deferred_findings_scope_note:
      "deferred findings get last_seen_wave-based staleness only in this pass — no owner/revalidate_by "
      + "columns were added to findings (a disclosed scope decision, not the allowlist's richer schema; "
      + 'see F-6c807f60)',
    unroutable_approved: compileUnroutableApprovedDrain(db, runId),
  };
}

const ROADMAP_DRAIN_STATE_RELATIVE_PATH = 'dogfood/roadmap-drain-state.json';

/**
 * F-1cd5de59's own drain-state mechanism, ADDITIVE to (not a replacement
 * for) the two halves above: an authored, target-repo-local file naming
 * per-entry review cadence in RUNS. T6's literal text is "a re-review
 * cadence in runs" — a genuinely different axis from
 * compileDeferredFindingsDrain's wave-scoped cadence above (waves are scoped
 * WITHIN one run; "the next run's digest" per T4 is inherently a CROSS-RUN
 * comparison, which needs an ordinal over `runs` rows, not `waves` rows).
 * Kept as its own top-level export — never folded into compileDrainQueue's
 * composition — so compileDrainQueue's existing, independently-tested
 * shape (lib/roadmap-drain.test.js) is untouched by this addition; callers
 * that want both call each explicitly (commands/roadmap.js does, for the
 * CLI-facing artifact's flat `drain` section).
 *
 * Source shape: `{ entries: [ { id, kind: 'grandfathered'|'deferred', owner,
 * last_reviewed_run_ordinal, cadence_runs } ] }`. Absent file degrades to
 * available:false, matching every other drain-queue degradation contract in
 * this module — a fresh repo compiling its first roadmap has no authored
 * drain state, and that is not an error.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, repo: string, local_path: string }} run — the run
 *   being compiled. `run.local_path` locates the drain-state file;
 *   `run.repo` + `run.id` locate this run's ordinal among ALL runs recorded
 *   for that repo (ordered by created_at ASC, 1-indexed).
 * @returns {{
 *   available: boolean,
 *   entries: Array<{ id: string, owner: string, cadence_runs: number, runs_since_review: number, overdue: boolean }>,
 *   overdue_ids: string[],
 * }}
 */
export function compileAuthoredDrainState(db, run) {
  if (!run || typeof run.local_path !== 'string' || run.local_path.length === 0) {
    return { available: false, entries: [], overdue_ids: [] };
  }
  const path = join(run.local_path, ROADMAP_DRAIN_STATE_RELATIVE_PATH);
  if (!existsSync(path)) return { available: false, entries: [], overdue_ids: [] };

  let parsed;
  try {
    parsed = readBoundedJson(path);
  } catch {
    return { available: false, entries: [], overdue_ids: [] };
  }
  if (!parsed || !Array.isArray(parsed.entries)) return { available: false, entries: [], overdue_ids: [] };

  // "Runs ago" needs a cross-run ordinal — `waves` is scoped to a single
  // run and cannot supply this; `runs` rows sharing the same repo, ordered
  // by created_at, can. A run with no repo match (or not found among its
  // own repo's rows — should not happen for a real run, but degrade rather
  // than throw) yields ordinal 0, which every entry below treats as
  // "cannot compute cadence" rather than a divide-by-zero/negative result.
  const repoRuns = db.prepare(`SELECT id FROM runs WHERE repo = ? ORDER BY created_at ASC, id ASC`).all(run.repo);
  const currentOrdinal = repoRuns.findIndex((r) => r.id === run.id) + 1;

  const entries = [];
  const overdue_ids = [];
  if (currentOrdinal > 0) {
    for (const raw of parsed.entries) {
      if (!raw || typeof raw.id !== 'string') continue;
      const lastReviewed = Number(raw.last_reviewed_run_ordinal);
      const cadence = Number(raw.cadence_runs);
      if (!Number.isFinite(lastReviewed) || !Number.isFinite(cadence)) continue;

      const runsSinceReview = currentOrdinal - lastReviewed;
      // STRICT boundary (F-1cd5de59, pinned verbatim): exactly AT cadence is
      // NOT YET overdue; cadence+1 IS — the same exclusive convention
      // compileDeferredFindingsDrain uses above, extended to run-ordinals.
      const overdue = runsSinceReview > cadence;

      entries.push({
        id: raw.id,
        owner: raw.owner || '',
        cadence_runs: cadence,
        runs_since_review: runsSinceReview,
        overdue,
      });
      if (overdue) overdue_ids.push(raw.id);
    }
  }

  return { available: true, entries, overdue_ids };
}
