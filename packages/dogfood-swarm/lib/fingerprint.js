/**
 * fingerprint.js — Stable finding dedup across waves.
 *
 * A fingerprint is: category + rule_id + normalized_path + symbol + normalized_span
 *
 * Description is intentionally NOT in the fingerprint. The wave 8 self-inspection
 * (B-BACK-002) caught the original code folding a SHA hash of the description
 * into every fingerprint, which meant that any wave-to-wave rewording of the
 * same defect produced a brand-new fingerprint and double-counted it as both
 * `fixed` (old fp) and `new` (new fp) in the next wave's classifyFindings output.
 *
 * Spec contract: two findings at the same (category, rule_id, path, symbol,
 * line-bucket) are the same finding — even if their description prose differs.
 *
 * Classification states:
 *   new        — first time this fingerprint appears
 *   recurring  — same fingerprint seen in a prior wave AND in current
 *   fixed      — fingerprint was in prior, NOT in current, AND current wave's
 *                scope covered the finding's path. Requires positive evidence
 *                that the agent actually looked.
 *   unverified — fingerprint was in prior, NOT in current, but current wave's
 *                scope did NOT cover the finding's path. We do not know whether
 *                the defect was fixed or simply not looked at. Carried into
 *                the next wave's prior map for re-evaluation. (Wave 8 B-BACK-003.)
 *   deferred   — coordinator chose to defer this finding
 *   rejected   — coordinator chose to reject this finding
 */

import { createHash } from 'node:crypto';

import { logStage } from './log-stage.js';

/**
 * Normalize a file path for fingerprinting.
 * Strips leading ./ and normalizes separators.
 */
function normalizePath(filePath) {
  if (!filePath) return '';
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

/**
 * Normalize a span (line range or single line) to a stable bucket.
 * Lines shift as code is edited, so we bucket to nearest 10-line block.
 * This prevents the same finding from appearing "new" after minor edits nearby.
 */
function normalizeSpan(lineNumber) {
  if (!lineNumber && lineNumber !== 0) return '';
  return String(Math.floor(lineNumber / 10) * 10);
}

/**
 * Compute a stable fingerprint for a finding.
 *
 * Description is NOT folded in — see file header for the contract and the
 * B-BACK-002 incident that drove this change.
 *
 * @param {object} finding
 * @param {string} finding.category — bug, security, quality, ux, etc.
 * @param {string} [finding.rule_id] — optional rule identifier
 * @param {string} [finding.file] — file path
 * @param {string} [finding.symbol] — function/class/variable name
 * @param {number} [finding.line] — line number
 * @returns {string} — hex fingerprint
 */
export function computeFingerprint(finding) {
  const parts = [
    finding.category || 'unknown',
    finding.rule_id || '',
    normalizePath(finding.file),
    (finding.symbol || '').toLowerCase(),
    normalizeSpan(finding.line),
  ];

  const raw = parts.join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * Disambiguate within-wave fingerprint collisions by occurrence index.
 *
 * fp-002 (the marquee fix). The base fingerprint deliberately excludes the
 * description (B-BACK-002 contract), so two genuinely-distinct findings that
 * share a coarse key — same (category, rule_id, path, symbol, 10-line bucket)
 * but different prose — collapse to the SAME base fingerprint. That is correct
 * for cross-wave dedup, but WITHIN a single wave both land in `result.new` and
 * upsertFindings then tries to INSERT two rows under one fingerprint AND one
 * derived finding_id, violating UNIQUE(run_id, fingerprint) /
 * UNIQUE(run_id, finding_id) and aborting the whole collect (0 rows persisted).
 * Reproduced live: two README findings 6 lines apart, no symbol, same bucket.
 *
 * Design (grounded in CodeQL primaryLocationLineHash, Semgrep match_based_id's
 * occurrence index, and the WER/Sentry "default-expand, fold-never-drop"
 * principle): for each group of findings sharing an identical base fingerprint,
 * assign a deterministic occurrence index by stable input order. The FIRST
 * member (index 0) and every singleton keep their base fingerprint UNCHANGED —
 * this preserves byte-for-byte backward-compat for the common case and the
 * cross-wave dedup invariant (a re-reported singleton next wave is still a
 * singleton, so it keeps the bare fingerprint and classifies `recurring`, not
 * `new`). The 2nd..Nth members are salted as sha256(baseFp + '|occ' + index)
 * (index ≥ 1, sliced to the same 24-hex width). Genuinely-distinct findings
 * that share a coarse key thus get distinct fingerprints + finding_ids without
 * folding in the volatile description.
 *
 * @param {Array} findings — current-wave findings; each may already carry a
 *   `fingerprint` (set by collect.js via computeFingerprint). When absent it is
 *   computed here. Input order is the occurrence-index authority.
 * @returns {Array} new array of findings with a disambiguated `fingerprint`.
 *   Inputs are not mutated.
 */
export function disambiguateFingerprints(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const base = finding.fingerprint || computeFingerprint(finding);
    counts.set(base, (counts.get(base) || 0) + 1);
  }

  const seen = new Map();
  return findings.map((finding) => {
    const base = finding.fingerprint || computeFingerprint(finding);
    const index = seen.get(base) || 0;
    seen.set(base, index + 1);

    // First occurrence (and every singleton) keeps the bare fingerprint.
    if (index === 0) {
      return finding.fingerprint === base ? finding : { ...finding, fingerprint: base };
    }

    const salted = createHash('sha256')
      .update(`${base}|occ${index}`)
      .digest('hex')
      .slice(0, 24);
    logStage('fingerprint_disambiguated', {
      component: 'dogfood-swarm',
      base_fingerprint: base,
      occurrence_index: index,
      total_occurrences: counts.get(base),
      salted_fingerprint: salted,
      file: finding.file || finding.file_path || null,
      category: finding.category || null,
    });
    return { ...finding, fingerprint: salted };
  });
}

/**
 * Classify findings against prior wave state.
 *
 * "Fixed" requires positive evidence — the current wave must have actually
 * looked at the prior finding's path. If the prior finding's path is outside
 * the current wave's scope (different domain, different lens, narrower glob),
 * the finding is classified `unverified` instead of `fixed`. See B-BACK-003.
 *
 * Safe default: when no `scope` is supplied, ALL not-rediscovered prior
 * findings are classified `unverified`. We do not silently invent `fixed`
 * verdicts the caller did not authorize.
 *
 * @param {Array} currentFindings — findings from the current wave (with fingerprints)
 * @param {Map<string, object>} priorFingerprints — fingerprint → finding from prior waves
 * @param {object} [scope] — what the current wave actually examined
 * @param {string[]} [scope.scopePaths] — path prefixes covered by the current wave.
 *   A prior finding's path is "in scope" iff it starts with one of these prefixes.
 *   Path comparison is normalized via normalizePath() (forward slashes, lowercase).
 * @returns {{ new: Array, recurring: Array, fixed: Array, unverified: Array }}
 */
export function classifyFindings(currentFindings, priorFingerprints, scope = null) {
  const currentSet = new Set();
  const result = { new: [], recurring: [], fixed: [], unverified: [] };

  // fp-002 Part 1: salt the 2nd..Nth members of any within-wave base-fingerprint
  // collision so two genuinely-distinct findings sharing a coarse key get
  // distinct fingerprints (and distinct derived finding_ids in upsertFindings)
  // instead of colliding on UNIQUE(run_id, fingerprint). Singletons + the first
  // member of each group keep the bare fingerprint, so cross-wave dedup and
  // backward-compat are untouched. See disambiguateFingerprints for the contract.
  const disambiguated = disambiguateFingerprints(currentFindings);

  for (const finding of disambiguated) {
    const fp = finding.fingerprint || computeFingerprint(finding);
    currentSet.add(fp);

    if (priorFingerprints.has(fp)) {
      result.recurring.push({ ...finding, fingerprint: fp, prior: priorFingerprints.get(fp) });
    } else {
      result.new.push({ ...finding, fingerprint: fp });
    }
  }

  const scopePaths = Array.isArray(scope?.scopePaths)
    ? scope.scopePaths.map(normalizePath).filter(Boolean)
    : null;

  for (const [fp, prior] of priorFingerprints) {
    if (currentSet.has(fp)) continue;
    // Terminal statuses are not re-classified — once fixed/deferred/rejected,
    // a finding stays out of the new/recurring/fixed/unverified buckets.
    if (prior.status === 'deferred' || prior.status === 'rejected' || prior.status === 'fixed') continue;

    const priorPath = normalizePath(prior.file_path || prior.file || '');
    const inScope = isPathInScope(priorPath, scopePaths);

    if (inScope) {
      result.fixed.push({ ...prior, fingerprint: fp });
    } else {
      result.unverified.push({ ...prior, fingerprint: fp });
    }
  }

  return result;
}

/**
 * Decide whether a prior finding's path was covered by the current wave's scope.
 *
 * - scopePaths === null  → no scope info supplied; safe default = NOT in scope.
 *                          (We refuse to invent a `fixed` verdict the caller did
 *                          not authorize. See B-BACK-003.)
 * - scopePaths === []    → caller explicitly examined nothing; same answer.
 * - priorPath === ''     → finding has no file; cannot prove it was looked at.
 *                          Treat as out-of-scope unless scopePaths includes ''
 *                          or '/' (the explicit "everything" sentinel).
 * - otherwise            → in scope iff priorPath starts with any scope prefix.
 *                          Both sides are pre-normalized (forward slashes, lowercased).
 */
function isPathInScope(priorPath, scopePaths) {
  if (scopePaths === null) return false;
  if (scopePaths.length === 0) return false;
  if (scopePaths.includes('') || scopePaths.includes('/')) return true;
  if (!priorPath) return false;
  return scopePaths.some((prefix) => priorPath.startsWith(prefix));
}

/**
 * Build a prior fingerprint map from database findings.
 *
 * @param {Database} db
 * @param {string} runId
 * @returns {Map<string, object>}
 */
export function buildPriorMap(db, runId) {
  const rows = db.prepare(
    `SELECT * FROM findings WHERE run_id = ? AND status NOT IN ('rejected')`
  ).all(runId);

  const map = new Map();
  for (const row of rows) {
    map.set(row.fingerprint, row);
  }
  return map;
}

/**
 * Upsert findings into the database with dedup.
 * New findings get inserted, recurring get their last_seen_wave updated.
 *
 * @param {Database} db
 * @param {string} runId
 * @param {number} waveId
 * @param {object} classified — output of classifyFindings
 * @returns {{ inserted: number, updated: number, fixed: number, unverified: number }}
 */
export function upsertFindings(db, runId, waveId, classified) {
  // fp-002 Part 2 (safety net): INSERT OR IGNORE so a residual within-wave
  // collision on EITHER unique index — UNIQUE(run_id, finding_id) or
  // UNIQUE(run_id, fingerprint) — skips the offending row instead of throwing
  // and aborting the whole collect transaction (which rolled back ALL findings
  // for the wave, 0 rows persisted). Part 1 (disambiguateFingerprints) already
  // splits coarse-key collisions into distinct fingerprints/ids, so in practice
  // a skip here only fires for a TRUE distinct-fingerprint / same-8-hex-prefix
  // collision (astronomically rare, the D3B-006 case). We choose log+skip over
  // abort: a never-abort collect is the invariant (an operator can re-report a
  // dropped finding next wave; a fully-rolled-back wave loses everything). The
  // skip is emitted as a structured logStage event below so it is observable,
  // not silent — preserving the loud-not-silent spirit of D3B-006 without its
  // collect-aborting blast radius.
  const insertFinding = db.prepare(`
    INSERT OR IGNORE INTO findings (run_id, finding_id, fingerprint, severity, category,
      file_path, line_number, symbol, description, recommendation,
      status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO finding_events (finding_id, event_type, wave_id, notes)
    VALUES (?, ?, ?, ?)
  `);

  const updateRecurring = db.prepare(`
    UPDATE findings SET status = 'recurring', last_seen_wave = ? WHERE id = ?
  `);

  const updateFixed = db.prepare(`
    UPDATE findings SET status = 'fixed', last_seen_wave = ? WHERE id = ?
  `);

  // Note: unverified does NOT bump last_seen_wave — the agent did not see
  // this finding, so claiming it was last seen now would be a lie. We update
  // status only, so the next wave can still re-evaluate against the original
  // last_seen_wave for staleness reasoning.
  const updateUnverified = db.prepare(`
    UPDATE findings SET status = 'unverified' WHERE id = ?
  `);

  let inserted = 0, updated = 0, fixed = 0, unverified = 0;

  const tx = db.transaction(() => {
    // Insert new findings.
    //
    // D3B-006: finding_id is content-addressed from the fingerprint
    // (F-<first 8 hex chars>) so that:
    //   - it is deterministic across `swarm collect` invocations — two
    //     sub-second collect calls cannot mint identical finding_ids for
    //     different findings the way the prior `F-<6 ts digits>-<counter>`
    //     scheme could;
    //   - downstream readers keyed on finding_id (notably `swarm approve
    //     --ids`) get a stable handle that survives wave-to-wave reruns;
    //   - a fingerprint-prefix collision (≤2.3e-4 at 1000 findings/run)
    //     fails LOUD via the (run_id, finding_id) UNIQUE index instead of
    //     silently double-inserting under the same id.
    for (const f of classified.new) {
      const fid = `F-${String(f.fingerprint).slice(0, 8)}`;
      const result = insertFinding.run(
        runId, fid, f.fingerprint, f.severity, f.category,
        f.file || null, f.line || null, f.symbol || null,
        f.description, f.recommendation || null, waveId, waveId
      );
      if (result.changes === 0) {
        // INSERT OR IGNORE skipped this row on a unique-index conflict. With
        // Part 1's disambiguation this should be unreachable for coarse-key
        // collisions; a skip here is the rare true (run_id, finding_id) /
        // (run_id, fingerprint) collision. Log it loud (operator can re-report
        // next wave) rather than aborting the wave.
        logStage('finding_insert_skipped', {
          component: 'dogfood-swarm',
          run_id: runId,
          wave_id: waveId,
          finding_id: fid,
          fingerprint: f.fingerprint,
          file: f.file || null,
          reason: 'unique_conflict_on_insert_or_ignore',
        });
        continue;
      }
      insertEvent.run(result.lastInsertRowid, 'reported', waveId, null);
      inserted++;
    }

    // Update recurring findings
    for (const f of classified.recurring) {
      if (f.prior?.id) {
        updateRecurring.run(waveId, f.prior.id);
        insertEvent.run(f.prior.id, 'recurred', waveId, null);
        updated++;
      }
    }

    // Mark fixed findings
    for (const f of classified.fixed) {
      if (f.id) {
        updateFixed.run(waveId, f.id);
        insertEvent.run(f.id, 'fixed', waveId, null);
        fixed++;
      }
    }

    // Mark unverified findings — prior findings the current wave did not look at
    for (const f of (classified.unverified || [])) {
      if (f.id) {
        updateUnverified.run(f.id);
        insertEvent.run(f.id, 'unverified', waveId, 'Out of current wave scope');
        unverified++;
      }
    }
  });

  tx();
  return { inserted, updated, fixed, unverified };
}
