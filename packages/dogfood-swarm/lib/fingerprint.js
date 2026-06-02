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
 * Disambiguate within-wave fingerprint collisions — PRIOR-AWARE and
 * ORDER-INDEPENDENT.
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
 * fp-r-001 (the regression this revision repairs). The original fp-002 fix
 * assigned the occurrence index purely from within-wave ARRAY ORDER and was
 * blind to prior-wave state. collect.js iterates agents/domains in a
 * non-deterministic order, so when a wave-1 SINGLETON gained a new coarse-key
 * sibling in wave 2, the bare-fp slot was awarded by this-wave sort order — not
 * to the member that already owned the bare fp in prior state. The genuinely-NEW
 * sibling could be handed the bare fp, dedupe against the prior finding's row →
 * classified `recurring` and SILENTLY SWALLOWED, while the original finding's
 * stable finding_id (the `swarm approve --ids` / D3B-006 handle) was hijacked.
 * Order-dependent corruption with silent data loss.
 *
 * Design (grounded in CodeQL primaryLocationLineHash, Semgrep match_based_id's
 * occurrence index, and the WER/Sentry "default-expand, fold-never-drop"
 * principle): group findings by base fingerprint.
 *
 *   - SINGLETONS (group size 1) keep the bare fingerprint UNCHANGED — byte-for-
 *     byte backward-compat for the common case and the cross-wave dedup
 *     invariant (B-BACK-002).
 *   - For each COLLISION group (size > 1) the bare-fp keeper is chosen
 *     DETERMINISTICALLY, never by array order:
 *       · If the group's base fp EXISTS in `priorFingerprints`, the keeper is
 *         the member whose content best matches the prior row (description
 *         first, then file/line). That member keeps the BARE fp so it dedupes
 *         to its own prior row as `recurring` and KEEPS its finding_id — this
 *         eliminates the fp-r-001 id hijack.
 *       · If the base fp is NOT in prior, the keeper is the deterministically-
 *         FIRST member under a STABLE content sort (description, then file, then
 *         line) — not array order.
 *   - Every NON-keeper is salted by a PURE function of its OWN content
 *     (sha256(base + '|d:' + sha256(normalizedDescription))), NOT an array
 *     index. Order-independent and stable across waves while the member stays a
 *     non-keeper; two distinct members get distinct salts (eliminates the
 *     fp-r-001 swallow). Genuinely-distinct findings sharing a coarse key thus
 *     get distinct fingerprints + finding_ids without folding the volatile
 *     description into the BASE fingerprint.
 *
 * Residual (honest): a member that transitions between keeper(bare) and
 * non-keeper(salted) across waves — when a collision group grows or shrinks —
 * can show a ONE-TIME new/recurring churn for that member. This is bounded,
 * never data loss, never a crash. The fully-stable fix (a CodeQL-style edit-
 * stable context-snippet hash folded into the BASE fingerprint, so distinct
 * findings never share a base fp at all) is the noted deeper follow-up; it
 * changes every fingerprint and is deliberately out of scope here.
 *
 * @param {Array} findings — current-wave findings; each may already carry a
 *   `fingerprint` (set by collect.js via computeFingerprint). When absent it is
 *   computed here. Array order is NOT consulted for keeper/salt selection.
 * @param {Map<string, object>} [priorFingerprints] — fingerprint → prior-wave
 *   row (from buildPriorMap). Used only to pick the bare-fp keeper for a
 *   collision group whose base fp already exists in prior state. Defaults to an
 *   empty Map so direct callers/tests need not pass it.
 * @returns {Array} new array of findings with a disambiguated `fingerprint`,
 *   in the SAME order as the input. Inputs are not mutated.
 */
export function disambiguateFingerprints(findings, priorFingerprints = new Map()) {
  const groups = new Map();
  for (const finding of findings) {
    const base = finding.fingerprint || computeFingerprint(finding);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(finding);
  }

  // Resolve the disambiguated fingerprint for each (base, member) pair up
  // front, keyed by object identity, so the final map() can preserve input
  // order without re-deriving the keeper per element.
  const resolved = new Map();
  for (const [base, members] of groups) {
    if (members.length === 1) {
      resolved.set(members[0], base);
      continue;
    }

    const keeper = chooseBareKeeper(base, members, priorFingerprints.get(base));
    for (const member of members) {
      if (member === keeper) {
        resolved.set(member, base);
        continue;
      }
      const salted = saltByContent(base, member);
      logStage('fingerprint_disambiguated', {
        component: 'dogfood-swarm',
        base_fingerprint: base,
        total_occurrences: members.length,
        salted_fingerprint: salted,
        keeper_is_prior_match: priorFingerprints.has(base),
        file: member.file || member.file_path || null,
        category: member.category || null,
      });
      resolved.set(member, salted);
    }
  }

  return findings.map((finding) => {
    const fp = resolved.get(finding);
    return finding.fingerprint === fp ? finding : { ...finding, fingerprint: fp };
  });
}

/**
 * Collapse a description to a stable discriminator: lowercase + whitespace
 * collapsed + trimmed. Used both to match a collision member against its prior
 * row and to derive a member's content salt. Order-independent by construction.
 */
function normalizeDescription(description) {
  return String(description || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Choose the member of a collision group that keeps the BARE fingerprint.
 *
 * - With a prior row: prefer the member whose normalized description equals the
 *   prior row's, else whose (file,line) matches; ties and no-match fall through
 *   to the stable content sort so the choice is always deterministic.
 * - Without a prior row: the first member under the stable content sort.
 */
function chooseBareKeeper(base, members, priorRow) {
  if (priorRow) {
    const priorDesc = normalizeDescription(priorRow.description);
    const descMatches = members.filter((m) => normalizeDescription(m.description) === priorDesc);
    if (descMatches.length === 1) return descMatches[0];
    const pool = descMatches.length > 1 ? descMatches : members;

    const priorPath = normalizePath(priorRow.file_path || priorRow.file || '');
    const priorLine = priorRow.line_number ?? priorRow.line ?? null;
    const locMatches = pool.filter((m) =>
      normalizePath(m.file) === priorPath
      && (m.line ?? null) === priorLine);
    if (locMatches.length === 1) return locMatches[0];

    return stableContentSort(locMatches.length > 0 ? locMatches : pool)[0];
  }
  return stableContentSort(members)[0];
}

/**
 * Deterministic content order for a collision group: normalized description,
 * then normalized path, then line. Independent of input array order, so the
 * same group yields the same keeper regardless of wave-mate iteration order.
 */
function stableContentSort(members) {
  return [...members].sort((a, b) => {
    const da = normalizeDescription(a.description);
    const db = normalizeDescription(b.description);
    if (da !== db) return da < db ? -1 : 1;
    const pa = normalizePath(a.file);
    const pb = normalizePath(b.file);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return (a.line ?? -1) - (b.line ?? -1);
  });
}

/**
 * Salt a non-keeper member by a PURE function of its own content — NOT an array
 * index. Stable across waves while the member stays a non-keeper; two distinct
 * descriptions in the same group yield two distinct salts.
 */
function saltByContent(base, member) {
  const descHash = createHash('sha256')
    .update(normalizeDescription(member.description))
    .digest('hex');
  return createHash('sha256')
    .update(`${base}|d:${descHash}`)
    .digest('hex')
    .slice(0, 24);
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

  // fp-002 Part 1 (fp-r-001 repair): salt the NON-keeper members of any
  // within-wave base-fingerprint collision so two genuinely-distinct findings
  // sharing a coarse key get distinct fingerprints (and distinct derived
  // finding_ids in upsertFindings) instead of colliding on UNIQUE(run_id,
  // fingerprint). The prior map is passed through so the bare-fp keeper for a
  // collision group whose base fp already exists in prior state is the member
  // that MATCHES the prior row — not whoever sorts first in this wave's array.
  // That keeps the original finding on its original finding_id (no D3B-006
  // handle hijack) and inserts the genuinely-new sibling as its own row (no
  // silent swallow). Singletons keep the bare fingerprint, so cross-wave dedup
  // and backward-compat are untouched. See disambiguateFingerprints.
  const disambiguated = disambiguateFingerprints(currentFindings, priorFingerprints);

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
