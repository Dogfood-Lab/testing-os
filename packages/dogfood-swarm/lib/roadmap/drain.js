/**
 * drain.js — T6 drain-queue compilation (F-6c807f60,
 * docs/trajectory-and-closure.dispatch.md).
 *
 * TWO SUPPRESSION-REGISTRY FILES, NOT INTERCHANGEABLE (Amendment 3's own
 * "correction record", wave 42 — read this before touching either half
 * below; conflating the two "produced two wrong rulings before this one,
 * both caught by adversarial review, not by the author"):
 *
 *   - scripts/regression-pin-allowlist.json — the ALLOWLIST. 36 entries,
 *     `{ reason, file, owner, revalidate_by }` PER ENTRY (a distinct human
 *     disposition each). Read by compileGrandfatheredManifestDrain, below.
 *   - scripts/grandfathered-pins.json — the (frozen) MANIFEST. 256 entries,
 *     `{ owner, revalidate_by }` per entry ONLY — no per-entry `reason`; the
 *     ONE shared reason for all 256 (grandfathered under the pre-vintage-
 *     boundary heuristic at freeze commit `132dc18`) lives once in the
 *     manifest's own header `$comment`, not duplicated 256 times. Read by
 *     compileGrandfatherManifestDrainState, below (A3.2b) — note the
 *     spelling: "Grandfather" (no -ed), matching
 *     scripts/check-finding-regression-pins.mjs's OWN naming
 *     (loadGrandfatherManifest / grandfatherManifestFingerprint /
 *     EXPECTED_GRANDFATHER_MANIFEST_HASH) precisely so the name itself flags
 *     "this is the OTHER file" at a glance.
 *
 * THREE PIECES, explicitly scoped per F-6c807f60's own recommendation
 * ("leaving it unstated is not [fine], per this run's own honesty-is-a-
 * feature ethos") plus Amendment 3's A3.2b addition:
 *
 *   1. GRANDFATHERED-MANIFEST DRAIN (compileGrandfatheredManifestDrain) —
 *      reads the 36-entry ALLOWLIST (see above), which ALREADY carries
 *      exactly the { reason, file, owner, revalidate_by } shape T6 asks for,
 *      enforced by scripts/check-finding-regression-pins.mjs#loadAllowlist
 *      in CI. This function reads the JSON file directly — git-alone, per
 *      T1's own "from the control-plane DB and git alone" constraint — and
 *      projects entries whose revalidate_by has passed. It duplicates only
 *      the minimal parse+filter needed here rather than importing
 *      loadAllowlist: that script lives at the repo root, outside the npm
 *      workspace package graph, with no stable export contract to depend on,
 *      and the CI gate (not this advisory reader) remains the authority on
 *      allowlist validity — a malformed file here degrades to
 *      `available: false` rather than throwing or duplicating the gate's own
 *      strict validation. Per Amendment 3's A3.5 disposition, this half's
 *      output is advisory-only (`swarm roadmap show` + the T4 digest) and is
 *      NOT persisted into the compiled roadmap artifact.
 *
 *   2. DEFERRED-FINDINGS DRAIN (compileDeferredFindingsDrain),
 *      DISCLOSED-WEAKER. C3's v10 migration does NOT add owner/
 *      revalidate_by columns to `findings` in this pass (a disclosed scope
 *      decision made THIS wave, not an oversight — see this domain's wave-39
 *      output notes). Deferred findings therefore get ONLY last_seen_wave-
 *      based staleness: an entry is "stale" once its last_seen_wave is
 *      `staleWaveThreshold` or more waves behind the run's most recent wave.
 *      This is weaker than the allowlist's owner+date cadence (no named
 *      owner, no explicit re-review date) but HONEST about being weaker. Per
 *      A3.5, also NOT persisted into the artifact (findings rows carry no
 *      owner, and owners are never invented).
 *
 *   3. GRANDFATHER-MANIFEST DRAIN STATE (compileGrandfatherManifestDrainState,
 *      A3.2b) — reads the 256-entry frozen MANIFEST (see above) and IS
 *      persisted into the artifact's `grandfathered_drain` section. See that
 *      function's own doc comment for the frozen_total constant and the
 *      EXPECTED_GRANDFATHER_MANIFEST_HASH coverage this design depends on.
 *
 * BOUNDARY CONVENTIONS ARE DELIBERATE AND DIFFER BY HALF (F-1cd5de59 pins
 * exactly this ambiguity as the interesting bug surface — "an entry exactly
 * AT its cadence... is ambiguous between 'due now' and 'due next time'
 * unless the comparison operator is pinned by a test"):
 *
 *   - GRANDFATHERED-MANIFEST / ALLOWLIST (date deadline): EXCLUSIVE.
 *     `revalidate_by` reads as "due starting the day AFTER this date" — an
 *     entry whose date is TODAY is not yet due (matches
 *     scripts/lib/revalidation-cadence.mjs's shared convention, F-780490da).
 *     `revalidate_by < today` (string comparison) fires. F-2f7dd0ce
 *     (wave 43): this paragraph previously described the boundary as
 *     INCLUSIVE ("`dueAt <= now` fires") — that was wrong, and had been wrong
 *     since the wave-41 merge reconciliation (commit 7737fa0) flipped the
 *     REAL comparison below to exclusive without updating this header to
 *     match; PROVEN LIVE this wave (direct execution against the real
 *     comparison, zero repo writes: a revalidate_by-dated-today entry
 *     reports NOT overdue). The inline comment at the actual comparison site
 *     (below) was always correct; only this header drifted.
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
 *
 *   Both halves are EXCLUSIVE as of wave 43 — they were never meant to
 *   "differ by half" going forward; that framing described a real, now-fixed
 *   documentation drift, not a deliberate design split. Kept as its own
 *   sentence rather than deleted so a future reader who recalls the old
 *   "differ by half" framing finds the correction, not silence.
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
import { logStage } from '../log-stage.js';

const ALLOWLIST_RELATIVE_PATH = 'scripts/regression-pin-allowlist.json';
const GRANDFATHER_MANIFEST_RELATIVE_PATH = 'scripts/grandfathered-pins.json';

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
    // Boundary matches scripts/lib/revalidation-cadence.mjs's exclusive
    // `revalidate_by < today` convention exactly (F-780490da: two
    // independently-evolving definitions of "overdue" disagreed by a day at
    // the boundary; the shared-helper convention is canonical, pinned by
    // scripts/revalidation-cadence-drain-parity.test.mjs).
    if (entry.revalidate_by < now.toISOString().slice(0, 10)) {
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
 * last_reviewed_run_ordinal, cadence_runs, reason? } ] }`. Absent file
 * degrades to available:false, matching every other drain-queue degradation
 * contract in this module — a fresh repo compiling its first roadmap has no
 * authored drain state, and that is not an error.
 *
 * A3.2a (docs/trajectory-and-closure.dispatch.md Amendment 3, wave 43):
 * `reason` is OPTIONAL on both the seed format above and this function's own
 * output entries — a producer extension, not a schema-breaking rename. When
 * present it must be a non-empty string (minLength 1, matching
 * $defs/drainEntry's sibling `reason` field this section's artifact-level
 * shape shares); a present-but-empty `reason` is treated as absent (omitted
 * from the output entry) rather than passed through as a misleading empty
 * string — never invented when the seed entry did not supply one.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, repo: string, local_path: string }} run — the run
 *   being compiled. `run.local_path` locates the drain-state file;
 *   `run.repo` + `run.id` locate this run's ordinal among ALL runs recorded
 *   for that repo (ordered by created_at ASC, 1-indexed).
 * @returns {{
 *   available: boolean,
 *   entries: Array<{ id: string, owner: string, cadence_runs: number, runs_since_review: number, overdue: boolean, reason?: string }>,
 *   overdue_ids: string[],
 * }}
 */
export function compileAuthoredDrainState(db, run) {
  // F-00c2b7fd: same absent-vs-degraded split as
  // compileGrandfatherManifestDrainState above (see that function's own
  // comment for the full rationale) — a missing `run.local_path` or a
  // missing drain-state file is the NORMAL unfed state (this repo's own
  // dogfood/roadmap-drain-state.json does not exist on disk today, per this
  // function's own doc comment above: "a fresh repo compiling its first
  // roadmap has no authored drain state, and that is not an error"); only a
  // PRESENT-but-unreadable-or-malformed file earns `degraded_reason`, read
  // by compile.js's warnIfDrainStateDegraded and dropped before the artifact
  // is assembled.
  if (!run || typeof run.local_path !== 'string' || run.local_path.length === 0) {
    return { available: false, entries: [], overdue_ids: [] };
  }
  const path = join(run.local_path, ROADMAP_DRAIN_STATE_RELATIVE_PATH);
  if (!existsSync(path)) return { available: false, entries: [], overdue_ids: [] };

  let parsed;
  try {
    parsed = readBoundedJson(path);
  } catch {
    return { available: false, entries: [], overdue_ids: [], degraded_reason: 'unreadable' };
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    return { available: false, entries: [], overdue_ids: [], degraded_reason: 'invalid_shape' };
  }

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
      // Amendment 3 seam (coordinator relay, wave 43): $defs/drainEntry's
      // (and the amended $defs/drainQueueEntry's) `owner` is
      // `minLength: 1` — an ownerless seed entry emitting `owner: ''` would
      // write a schema-invalid artifact. FAIL CLOSED on the entry, not the
      // whole compile: skip it (matching this loop's existing posture for
      // a malformed id or a non-numeric cadence/lastReviewed, three lines
      // below) rather than throw and abort every OTHER, well-formed entry —
      // but loudly, via logStage, so a silently-dropped entry is
      // discoverable in the swarm's own log stream instead of just quietly
      // absent from `entries`/`overdue_ids` (PROTOCOL.md: "a sweep you
      // didn't run is a finding waiting to be filed against you" — the same
      // discipline applied to a producer's own silent drops).
      if (typeof raw.owner !== 'string' || raw.owner.trim().length === 0) {
        logStage('roadmap_drain_state_entry_missing_owner', {
          component: 'dogfood-swarm',
          entry_id: raw.id,
          drain_state_path: path,
        });
        continue;
      }
      const lastReviewed = Number(raw.last_reviewed_run_ordinal);
      const cadence = Number(raw.cadence_runs);
      if (!Number.isFinite(lastReviewed) || !Number.isFinite(cadence)) continue;

      const runsSinceReview = currentOrdinal - lastReviewed;
      // STRICT boundary (F-1cd5de59, pinned verbatim): exactly AT cadence is
      // NOT YET overdue; cadence+1 IS — the same exclusive convention
      // compileDeferredFindingsDrain uses above, extended to run-ordinals.
      const overdue = runsSinceReview > cadence;

      const entry = {
        id: raw.id,
        owner: raw.owner,
        cadence_runs: cadence,
        runs_since_review: runsSinceReview,
        overdue,
      };
      // A3.2a: `reason` is optional on the seed AND the output entry —
      // present-but-empty is treated as absent, never invented, never
      // passed through as a misleading empty string.
      if (typeof raw.reason === 'string' && raw.reason.trim().length > 0) entry.reason = raw.reason;

      entries.push(entry);
      if (overdue) overdue_ids.push(raw.id);
    }
  }

  return { available: true, entries, overdue_ids };
}

/**
 * FROZEN CONSTANT — the grandfather manifest's size AT FREEZE (commit
 * `132dc18`, per scripts/grandfathered-pins.json's own `frozen_at_commit`
 * header field), never derived from `Object.keys(manifest.grandfathered)
 * .length` at read time. PROTOCOL.md sub-law 5: "a count is not integrity" —
 * a live-read count only ever reports the CURRENT size, which cannot
 * distinguish a genuine drain (an id migrated to a declared @pins tag or an
 * allowlist entry, per the manifest's own lawful-drain procedure) from
 * tampering (an id evicted and a fresh, never-frozen id inserted in its
 * place, holding the count constant) — that distinction is
 * scripts/check-finding-regression-pins.mjs#EXPECTED_GRANDFATHER_MANIFEST_HASH's
 * job, not this advisory reader's.
 *
 * WHY A CONSTANT AND NOT A MANIFEST HEADER FIELD (A3.2b's own "IF adding it
 * is hash-safe... else a documented constant" conditional) — VERIFIED LIVE
 * this wave, not assumed, by direct execution against the real manifest
 * (zero repo writes; confirmed independently by both this domain and
 * ci-tooling's read of the same source): `loadGrandfatherManifest` returns
 * the manifest's FULL parsed object ($comment + frozen_at_commit +
 * frozen_at_date + grandfathered together), and
 * `grandfatherManifestFingerprint` hashes `canonicalize()` of THAT WHOLE
 * OBJECT — so EXPECTED_GRANDFATHER_MANIFEST_HASH covers the header exactly
 * as much as it covers `.grandfathered`. Cloning the real manifest and
 * adding a `frozen_total` key (touching NOTHING under `.grandfathered`)
 * changes the computed digest. Reading an existing header field is
 * therefore unavailable (no such field exists in the manifest today) and
 * adding one is unavailable (would break the pinned hash, and
 * scripts/grandfathered-pins.json sits outside this domain's globs
 * regardless — packages/dogfood-swarm/lib/**\, db/**\,
 * persist-results.js only). This constant is the documented-else branch
 * A3.2b itself names, provenanced by the manifest's own frozen_at_commit/
 * frozen_at_date header fields. May only change alongside a FRESH freeze
 * commit AND a fresh EXPECTED_GRANDFATHER_MANIFEST_HASH (a scripts/**
 * -domain edit), never independently — this constant drifting silently out
 * of sync with a re-frozen manifest is exactly the kind of undisclosed
 * unsoundness this repo's own ethos treats as the defect, not the gap
 * itself; a future re-freeze MUST update both in the same commit.
 */
export const FROZEN_GRANDFATHER_MANIFEST_TOTAL = 256;

/**
 * A3.2b (docs/trajectory-and-closure.dispatch.md Amendment 3, wave 43) —
 * `grandfathered_drain` artifact-section producer over the FROZEN 256-entry
 * scripts/grandfathered-pins.json manifest. See this file's own module
 * header ("TWO SUPPRESSION-REGISTRY FILES, NOT INTERCHANGEABLE") for why
 * this is NOT compileGrandfatheredManifestDrain above — that function reads
 * the DIFFERENT, 36-entry scripts/regression-pin-allowlist.json file, and
 * conflating the two produced two wrong Amendment-3 rulings before this one
 * (both caught by adversarial review).
 *
 * ALL remaining entries are emitted (not merely overdue ones, unlike
 * compileGrandfatheredManifestDrain's `overdue` list above) — A3.2b's own
 * text: "emit ALL remaining entries." Each carries `{id, owner,
 * revalidate_by}` plus an OPTIONAL `reason` — the manifest's per-entry shape
 * is `{owner, revalidate_by}` only (no per-entry reason: the ONE shared
 * reason for all 256 lives once in the manifest's own header `$comment`, per
 * this file's module header), so `reason` on an outstanding entry is never
 * invented here; it is emitted only if a future manifest generation
 * genuinely carries one per-entry (Q5's lesson, cited directly in A3.2:
 * "per-entry provenance is never invented").
 *
 * ADVISORY, degrade-not-throw (matching this file's existing posture for
 * compileGrandfatheredManifestDrain/compileAuthoredDrainState): a missing or
 * malformed manifest degrades to `available: false` with an honest all-zero/
 * empty shape rather than throwing — a legitimate state for any audited repo
 * OTHER than dogfood-lab/testing-os itself (this file's own header already
 * notes `repoRoot` is "whatever target the swarm is running against," not
 * necessarily this repo; a foreign repo genuinely has no grandfathered-
 * manifest concept, and `frozen_total: 0` is the honest "not applicable"
 * answer for it — the schema's own top-level header disclaims exactly this:
 * "an absent key can only ever mean 'the compiler did not run this query,'
 * never 'ran it and found nothing'"). Individual malformed entries are
 * skipped, not thrown on — this is an ADVISORY reader; the CI gate
 * (scripts/check-finding-regression-pins.mjs, which validates the SAME file
 * strictly via loadGrandfatherManifest, throwing on any malformed entry)
 * remains the authority on manifest validity, mirroring
 * compileGrandfatheredManifestDrain's own established "does not duplicate
 * the gate's strict validation" precedent. Does NOT re-verify
 * EXPECTED_GRANDFATHER_MANIFEST_HASH itself (importing from
 * scripts/check-finding-regression-pins.mjs would repeat the exact
 * "outside the npm workspace package graph, no stable export contract"
 * objection this file's header already gives for not importing
 * loadAllowlist) — a manifest present at the expected path with a
 * valid-shaped `.grandfathered` object is trusted to be the canonical one,
 * same trust boundary the allowlist half already accepts.
 *
 * RESIDUAL, DISCLOSED: a manifest whose INDIVIDUAL entries are malformed in
 * a way CI would reject (and therefore could never actually reach `main`)
 * would have those entries silently excluded from `outstanding`, which
 * would inflate `drained` (frozen_total minus a smaller-than-true live
 * count) — a real gap in a hypothetical adversarial-tampering scenario, not
 * a live one: CI's own strict `loadGrandfatherManifest` + the
 * EXPECTED_GRANDFATHER_MANIFEST_HASH content-address gate are what actually
 * keep the on-disk file well-formed; this advisory reader inherits that
 * guarantee rather than re-proving it.
 *
 * @param {string} repoRoot
 * @returns {{
 *   available: boolean,
 *   frozen_total: number,
 *   drained: number,
 *   outstanding: Array<{ id: string, owner: string, revalidate_by: string, reason?: string }>,
 * }} — `outstanding` ordered id ASC (deterministic).
 */
export function compileGrandfatherManifestDrainState(repoRoot) {
  const unavailable = { available: false, frozen_total: 0, drained: 0, outstanding: [] };

  // F-00c2b7fd: `unavailable` used to mean two different things — a MISSING
  // repoRoot/manifest (the normal, unfed state: this file's own doc comment
  // above already calls a missing manifest "a legitimate state for any
  // audited repo OTHER than dogfood-lab/testing-os itself") versus a
  // PRESENT-but-broken one (malformed JSON, or parsed JSON with the wrong
  // top-level shape — a genuine degradation compile.js's caller should be
  // warned about). Only the two `return` sites below that follow a
  // successful `existsSync` now attach `degraded_reason` — the missing-input
  // and missing-file returns stay the exact pre-existing `unavailable`
  // object on purpose, so roadmap-drain.test.js's existing
  // `assert.deepEqual(result, { available: false, frozen_total: 0, drained: 0,
  // outstanding: [] })` absent-manifest pin (outside this domain's globs)
  // keeps passing unchanged. `degraded_reason` is consumed by
  // compile.js's own warnIfDrainStateDegraded and never reaches the
  // schema-narrowed persisted artifact.
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return unavailable;
  const path = join(repoRoot, GRANDFATHER_MANIFEST_RELATIVE_PATH);
  if (!existsSync(path)) return unavailable;

  let parsed;
  try {
    parsed = readBoundedJson(path);
  } catch {
    return { ...unavailable, degraded_reason: 'unreadable' };
  }
  if (!parsed || typeof parsed.grandfathered !== 'object' || parsed.grandfathered === null || Array.isArray(parsed.grandfathered)) {
    return { ...unavailable, degraded_reason: 'invalid_shape' };
  }

  const outstanding = [];
  for (const [id, entry] of Object.entries(parsed.grandfathered)) {
    if (!entry || typeof entry.owner !== 'string' || entry.owner.length === 0 || typeof entry.revalidate_by !== 'string') continue;
    const item = { id, owner: entry.owner, revalidate_by: entry.revalidate_by };
    if (typeof entry.reason === 'string' && entry.reason.length > 0) item.reason = entry.reason;
    outstanding.push(item);
  }
  outstanding.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    available: true,
    frozen_total: FROZEN_GRANDFATHER_MANIFEST_TOTAL,
    drained: FROZEN_GRANDFATHER_MANIFEST_TOTAL - outstanding.length,
    outstanding,
  };
}
