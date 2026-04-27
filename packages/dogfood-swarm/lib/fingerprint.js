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

  for (const finding of currentFindings) {
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
  const insertFinding = db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category,
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
    // Insert new findings
    for (const f of classified.new) {
      const fid = `F-${String(Date.now()).slice(-6)}-${String(inserted + 1).padStart(3, '0')}`;
      const result = insertFinding.run(
        runId, fid, f.fingerprint, f.severity, f.category,
        f.file || null, f.line || null, f.symbol || null,
        f.description, f.recommendation || null, waveId, waveId
      );
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
