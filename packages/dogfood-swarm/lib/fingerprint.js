/**
 * fingerprint.js — Stable finding dedup across waves.
 *
 * A fingerprint is: category + rule_id + normalized_path + symbol + LOCATION,
 * where LOCATION is one of two interchangeable encodings chosen at compute time:
 *
 *   - context-hash (fp-p-005, preferred): when the finding's source file is
 *     available, LOCATION is a hash of the EDIT-STABLE surrounding source — the
 *     ~7 lines around finding.line, whitespace-collapsed and line-ending
 *     normalized. This is the CodeQL `primaryLocationLineHash` design: it
 *     survives reflow (re-indentation, line-wrapping, code inserted ELSEWHERE in
 *     the file that shifts the finding's line number) because it hashes the
 *     surrounding CONTENT, not the line number. Two genuinely-distinct findings
 *     at different points in the same file see different surrounding source, so
 *     they get different base fingerprints with NO occurrence-salting needed —
 *     the base fp is a pure, injective function of the finding's own stable
 *     content. (Coverity's enclosing-function key is the same idea at function
 *     granularity; the finding.symbol component already carries the function
 *     name when the auditor reports one.)
 *
 *   - line-bucket (fallback): when no source is available (synthetic finding,
 *     unresolvable/deleted file, file-level finding with no line), LOCATION
 *     degrades to the pre-fp-p-005 10-line bucket. This path is BYTE-FOR-BYTE
 *     identical to the historical fingerprint, so cross-wave dedup of findings
 *     that lack readable source is unchanged. The occurrence-salting net
 *     (disambiguateFingerprints) still covers the residual collisions on this
 *     path and the rare identical-surrounding-source collision on the other.
 *
 * Description is intentionally NOT in the fingerprint. The wave 8 self-inspection
 * (B-BACK-002) caught the original code folding a SHA hash of the description
 * into every fingerprint, which meant that any wave-to-wave rewording of the
 * same defect produced a brand-new fingerprint and double-counted it as both
 * `fixed` (old fp) and `new` (new fp) in the next wave's classifyFindings output.
 * The context-hash is the opposite of that mistake: it folds in EDIT-STABLE
 * surrounding SOURCE (which a rewording does not touch), never the volatile
 * description prose.
 *
 * Spec contract: two findings at the same (category, rule_id, path, symbol) AND
 * the same surrounding source are the same finding — even if their description
 * prose differs. When source is unavailable the contract degrades to the
 * historical (…, line-bucket) key.
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
 * Number of source lines to include on EACH side of the finding's line when
 * building the context snippet. 3 → a 7-line window. Big enough that two
 * findings even one line apart get different windows (the window edges differ),
 * small enough that the window is meaningfully "around" the finding and that a
 * single nearby edit only perturbs a fraction of it. Findings <2 lines apart in
 * a file shorter than the window can still share a window — that residual is
 * caught by the occurrence-salting net, same as the no-source path.
 */
export const CONTEXT_RADIUS_LINES = 3;

/**
 * Upper bound on the normalized snippet fed to the hash. A pure DoS guard
 * against a minified/generated file whose 7-line window is megabytes of one
 * line; it does not affect distinctiveness for human-readable source (adjacent
 * findings' windows start at different lines, so their leading chars already
 * differ). Not a "~100 char" semantic cap — the CONTEXT_RADIUS window is what
 * defines the meaningful surrounding-source amount.
 */
const CONTEXT_SNIPPET_MAX_CHARS = 4096;

/**
 * Extract the EDIT-STABLE context snippet around a finding's line.
 *
 * Returns a normalized string (whitespace collapsed, line endings folded) of the
 * CONTEXT_RADIUS_LINES window centered on `line`, or null when no meaningful
 * snippet can be built (no source, non-positive/out-of-range line, all-blank
 * window) — null signals computeFingerprint to fall back to the line bucket.
 *
 * The normalization is what buys reflow-survival: collapsing every run of
 * whitespace to a single space and trimming means re-indentation and
 * line-rewrapping leave the snippet (and therefore the fingerprint) unchanged.
 * Anchoring on the source CONTENT rather than the line number is what buys
 * stability when code inserted elsewhere shifts the finding down the file — the
 * surrounding lines move with it, so the same window text is read at the new
 * line number.
 *
 * @param {string} [sourceText] — full text of the finding's file
 * @param {number} [line] — 1-based line number of the finding
 * @returns {string|null}
 */
export function extractContextSnippet(sourceText, line) {
  if (typeof sourceText !== 'string' || sourceText.length === 0) return null;
  if (!Number.isInteger(line) || line < 1) return null;

  const lines = sourceText.replace(/\r\n?/g, '\n').split('\n');
  const idx = line - 1;
  if (idx >= lines.length) return null;

  const start = Math.max(0, idx - CONTEXT_RADIUS_LINES);
  const end = Math.min(lines.length, idx + CONTEXT_RADIUS_LINES + 1);
  const normalized = lines.slice(start, end).join('\n').replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;

  return normalized.slice(0, CONTEXT_SNIPPET_MAX_CHARS);
}

/**
 * Compute a stable fingerprint for a finding.
 *
 * Description is NOT folded in — see file header for the contract and the
 * B-BACK-002 incident that drove this change. When `options.sourceText` is the
 * finding's file content, an edit-stable context-snippet hash replaces the line
 * bucket as the LOCATION component (fp-p-005); otherwise LOCATION is the
 * historical 10-line bucket and the output is byte-for-byte what it was before.
 *
 * Pure function: it reads no filesystem. The caller (collect.js) reads the
 * source once per file and threads it in via sourceText, which keeps this
 * trivially testable and lets the read be cached at the fingerprint step.
 *
 * @param {object} finding
 * @param {string} finding.category — bug, security, quality, ux, etc.
 * @param {string} [finding.rule_id] — optional rule identifier
 * @param {string} [finding.file] — file path
 * @param {string} [finding.symbol] — function/class/variable name
 * @param {number} [finding.line] — line number
 * @param {object} [options]
 * @param {string} [options.sourceText] — full text of finding.file, when available
 * @returns {string} — hex fingerprint
 */
export function computeFingerprint(finding, options = {}) {
  const snippet = extractContextSnippet(options.sourceText, finding.line);
  // The context component carries a short prefix so it can never alias a bare
  // bucket string; the fallback is left bare so its raw input — and therefore
  // the fingerprint of a no-source finding — is byte-identical to the
  // pre-fp-p-005 scheme (the cross-wave-dedup backward-compat guarantee).
  const location = snippet !== null
    ? `ctx:${createHash('sha256').update(snippet).digest('hex').slice(0, 16)}`
    : normalizeSpan(finding.line);

  const parts = [
    finding.category || 'unknown',
    finding.rule_id || '',
    normalizePath(finding.file),
    (finding.symbol || '').toLowerCase(),
    location,
  ];

  const raw = parts.join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * Disambiguate within-wave fingerprint collisions — PRIOR-AWARE and
 * ORDER-INDEPENDENT.
 *
 * Post-fp-p-005 this is a SAFETY NET (see the closing "Status" note): with the
 * source available, computeFingerprint's context-snippet hash already makes
 * distinct findings carry distinct base fps, so no collision groups form and
 * nothing below runs. It still fires on the no-source fallback path and on the
 * rare identical-surrounding-source case. The history below is why it exists and
 * what it does WHEN it fires.
 *
 * fp-002 (the original marquee fix). The base fingerprint deliberately excludes
 * the description (B-BACK-002 contract), so before fp-p-005 two genuinely-
 * distinct findings that shared a coarse key — same (category, rule_id, path,
 * symbol, 10-line bucket) but different prose — collapsed to the SAME base
 * fingerprint. That is correct for cross-wave dedup, but WITHIN a single wave
 * both land in `result.new` and
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
 *     (normalized description + normalized file + line) AND a within-group
 *     ordinal from a DETERMINISTIC sort (stableContentSort) over the group's
 *     non-keepers — NOT an array index. Order-independent and stable across
 *     waves while the member stays a non-keeper. Two non-keepers get distinct
 *     salts even when their descriptions are EQUAL or both EMPTY (fp-p-001): the
 *     deterministic ordinal breaks the tie that description-only salting left
 *     open (where the second member collided on the same salted fingerprint /
 *     finding_id and was silently dropped by upsertFindings' INSERT OR IGNORE).
 *     Genuinely-distinct findings sharing a coarse key thus get distinct
 *     fingerprints + finding_ids without folding the volatile description into
 *     the BASE fingerprint.
 *
 * Status after fp-p-005: the deeper fix this caveat once deferred is now in
 * computeFingerprint — when the source is available, the edit-stable
 * context-snippet hash makes the BASE fingerprint injective, so genuinely-
 * distinct findings no longer share a base fp and this function sees only
 * size-1 groups (every member is its own keeper, nothing is salted). It is now
 * a SAFETY NET, not the primary mechanism, and still earns its keep for the two
 * cases the context hash cannot cover: (1) the no-source fallback path, where
 * LOCATION is still the coarse 10-line bucket and distinct findings can collide;
 * (2) the rare case of two distinct findings whose surrounding source is
 * byte-identical (e.g. duplicated boilerplate), which hash to the same context.
 *
 * Residual (honest): in those net-firing cases, a member that transitions
 * between keeper(bare) and non-keeper(salted) across waves — when a collision
 * group grows or shrinks — can still show a ONE-TIME new/recurring churn. This
 * is bounded, never data loss, never a crash. In the common (source-available)
 * path it no longer occurs at all, because no collision groups form.
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

    // Assign each non-keeper a within-group ordinal from a DETERMINISTIC sort
    // (stableContentSort: description, then file, then line) rather than array
    // order. Folding this ordinal into the salt makes two non-keepers with
    // equal-or-empty descriptions still get distinct salts (fp-p-001), while
    // staying order-independent and stable across waves: the same group always
    // sorts the same way regardless of wave-mate iteration order.
    const nonKeepers = members.filter((m) => m !== keeper);
    const ordinalOf = new Map();
    stableContentSort(nonKeepers).forEach((m, i) => ordinalOf.set(m, i));

    for (const member of members) {
      if (member === keeper) {
        resolved.set(member, base);
        continue;
      }
      const salted = saltByContent(base, member, ordinalOf.get(member));
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
 * Salt a non-keeper member by a PURE function of its own content + a
 * DETERMINISTIC within-group ordinal — NOT an array index.
 *
 * fp-p-001: the description alone is NOT a sufficient discriminator. Two
 * non-keeper members of the same coarse-key group with equal or both-empty
 * descriptions (normalizeDescription('') === normalizeDescription(null) === '')
 * hashed to the SAME salt → the same salted fingerprint → the same derived
 * finding_id → upsertFindings' INSERT OR IGNORE silently dropped the second
 * genuinely-distinct finding. The fix folds three more discriminators into the
 * salt source so equal/empty-description members still diverge:
 *   - the member's normalized file,
 *   - the member's line,
 *   - a within-group `ordinal` assigned by stableContentSort (description, then
 *     file, then line) over the group's non-keepers.
 *
 * The ordinal is order-INDEPENDENT (it is the index under the deterministic
 * sort, not the input array order), so the salt stays stable across waves while
 * the member remains a non-keeper, and two members that tie on description AND
 * file AND line still receive distinct salts via their distinct sort positions.
 * Singletons and the bare-fp keeper never reach here, so their fingerprints are
 * untouched.
 */
function saltByContent(base, member, ordinal) {
  const discriminator = [
    normalizeDescription(member.description),
    normalizePath(member.file),
    member.line ?? '',
    ordinal,
  ].join('|');
  const contentHash = createHash('sha256').update(discriminator).digest('hex');
  return createHash('sha256')
    .update(`${base}|d:${contentHash}`)
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
 * @param {boolean} [scope.full] — CP4-SCOPE-WIRING: the wave's agent set
 *   covered EVERY agent-bearing domain in the frozen map, so everything —
 *   including file-less repo-level priors — is in scope and an absent prior
 *   is positive evidence of `fixed`. The caller asserts coverage; this flag
 *   is never inferred here.
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

  // CP4-SCOPE-WIRING: an explicit full-coverage assertion covers everything,
  // including priors with no file path (isPathInScope can never prove those).
  const fullScope = scope?.full === true;
  const scopePaths = Array.isArray(scope?.scopePaths)
    ? scope.scopePaths.map(normalizePath).filter(Boolean)
    : null;

  for (const [fp, prior] of priorFingerprints) {
    if (currentSet.has(fp)) continue;
    // Terminal statuses are not re-classified — once fixed/deferred/rejected,
    // a finding stays out of the new/recurring/fixed/unverified buckets.
    if (prior.status === 'deferred' || prior.status === 'rejected' || prior.status === 'fixed') continue;

    const priorPath = normalizePath(prior.file_path || prior.file || '');
    const inScope = fullScope || isPathInScope(priorPath, scopePaths);

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
        // (run_id, fingerprint) collision — OR the deliberate rejected-row
        // case below. Log it loud (operator can re-report next wave) rather
        // than aborting the wave.
        //
        // F-6a8a98d6: buildPriorMap excludes 'rejected' rows, so a rejected
        // finding that is REDISCOVERED classifies as 'new' and lands exactly
        // here (conflict with the existing rejected row). That recurrence was
        // previously invisible in the DB — only an NDJSON breadcrumb. Record
        // an explicit finding_event so triage can see "this keeps coming
        // back" WITHOUT reopening the rejected row (rejection is a
        // coordinator decision; recurrence alone does not overturn it).
        const existing = db.prepare(
          'SELECT id, status FROM findings WHERE run_id = ? AND (fingerprint = ? OR finding_id = ?)'
        ).get(runId, f.fingerprint, fid);
        if (existing && existing.status === 'rejected') {
          insertEvent.run(
            existing.id, 'recurred', waveId,
            'recurred-while-rejected: rediscovered by this wave; rejected status preserved'
          );
        }
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
