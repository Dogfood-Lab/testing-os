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
 * Description is intentionally NOT in the fingerprint FOR FILE-BEARING
 * FINDINGS. The wave 8 self-inspection (B-BACK-002) caught the original code
 * folding a SHA hash of the description into every fingerprint, which meant
 * that any wave-to-wave rewording of the same defect produced a brand-new
 * fingerprint and double-counted it as both `fixed` (old fp) and `new` (new
 * fp) in the next wave's classifyFindings output. The context-hash is the
 * opposite of that mistake: it folds in EDIT-STABLE surrounding SOURCE (which
 * a rewording does not touch), never the volatile description prose.
 *
 * Spec contract (file-bearing): two findings at the same (category, rule_id,
 * path, symbol) AND the same surrounding source are the same finding — even
 * if their description prose differs. When source is unavailable the
 * contract degrades to the historical (…, line-bucket) key.
 *
 * FILE-LESS EXCEPTION (fingerprint-fusion rider, wave 41 — deliberately
 * narrower than a B-BACK-002 regression, not a silent reintroduction of it).
 * A file-less finding has NO structural anchor at all — no file to hash
 * surrounding source from, no line to bucket. Every part of the base
 * fingerprint besides category collapses to empty, so EVERY file-less
 * finding sharing a category collided on ONE base fingerprint — proven live
 * at wave-40 scale (three separate fusion incidents silently merging
 * unrelated findings, one wrongly reopening an already-closed prior as
 * recurring). computeFingerprint therefore folds in a normalized-description
 * component ONLY when `finding.file` is falsy. This KNOWINGLY reopens
 * B-BACK-002's shape for that one case — an undeclared, reworded re-report of
 * the SAME file-less finding across waves now usually lands as a new row
 * instead of auto-recurring — but only for file-less findings, and the
 * sanctioned fix for THAT is already load-bearing elsewhere in this file
 * (honorReusedFindingIds' declared-id-reuse path, the CONFIRM-queue
 * mechanism: an agent re-reporting a still-open finding declares its known
 * id, which matches by id, never by content). A silent, structurally
 * unavoidable cross-finding fusion is worse than an occasional visible
 * duplicate row an operator can merge, so this trade is made deliberately,
 * not by accident. computeFingerprint's own inline comment carries the full
 * reasoning and the live proof. File-bearing findings are completely
 * unaffected — this branch is dead code for any finding that has a file.
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
import { matchesAnyGlob } from './findings-filter.js';
// F-d656acc4 / F-swarmcpcore-008: this was a private, unexported function
// here, byte-identical to commands/collect.js's own private
// normalizeFilePathForGlobMatch() — confirmed duplicated debt, now extracted
// to the shared leaf helper. Aliased back to the local name `normalizePath`
// so every call site below (chooseBareKeeper, stableContentSort,
// saltByContent, rawFileIdentityDiffers, classifyFindings,
// honorReusedFindingIds) is unchanged — this is a pure extraction, not a
// behavior change. See lib/normalize-path.js's header for why the shared
// export is named after collect.js's local name rather than the finding's
// literal `normalizePathForMatch` suggestion (that name is already taken by
// a differently-scoped function in commands/rewind.js).
import { normalizeFilePathForGlobMatch as normalizePath } from './normalize-path.js';

/**
 * Normalize a file path for fingerprinting.
 * Strips leading ./, collapses repeated/trailing slashes, and normalizes
 * separators and case.
 *
 * F-c63da27b: a trailing slash ('foo.js/') and a doubled internal slash
 * ('packages//dogfood-swarm/...' — a common path-join artifact, e.g.
 * `${prefix}/${file}` where prefix already ends in '/') used to fingerprint
 * DIFFERENTLY from the clean spelling, even though they name the identical
 * file. Two audit passes reporting the same real defect, where one happens
 * to compute a doubled- or trailing-slash path, would silently fail
 * cross-wave dedup — the same double-count risk (fixed + new) the
 * description-exclusion in this file's header was written to prevent.
 * Collapsing repeated slashes BEFORE stripping the leading './' also
 * normalizes a leading './/', which a strict single-slash leading-dot strip
 * alone would otherwise leave as a stray '/'. Implementation now lives in
 * ./normalize-path.js (imported above as `normalizePath`) — see that file's
 * header for the extraction rationale.
 */

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
    // F-a8c0cf04: symbol case is NOT folded, unlike the path component above.
    // A file path's case-folding absorbs LLM-transcription slips for the SAME
    // real file (F-c63da27b) — but two identifiers differing only by case are
    // almost always two DIFFERENT things in JS/TS (a `Runner` class vs. a
    // `runner` instance, a `Component` vs. a `component` helper), not
    // spelling variants of one identifier. Folding it let an unrelated new
    // finding about `runner` silently collide with an already-closed finding
    // about `Runner` and get discarded — proven live, two independent probes.
    finding.symbol || '',
    location,
  ];

  // Fingerprint-fusion rider (wave 41, coordinator forensics on wave-40's
  // collect()), retroactively canonicalized as F-52e61f49 (wave 43 coordinator
  // instruction — no filed F-id existed until then; see
  // lib/fingerprint-fileless-discrimination.test.js's own @pins tag, this
  // fix's declared regression pin): a file-less finding leaves normalizePath(finding.file) === ''
  // and, for the common case (no rule_id/symbol/line), every OTHER part above
  // empty too — the whole fingerprint degenerates to ~category-only, so EVERY
  // file-less finding sharing a category collides on ONE base fingerprint.
  // PROVEN LIVE at wave-40 scale (three fusion incidents: a 4-, a 22-, and a
  // 2-occurrence collision group, each merging unrelated findings into one
  // base fp — see this rider's own write-up for the finding ids) and
  // reproduced minimally in a throwaway worktree at this repo's pre-fix HEAD
  // (a7399b7): two unrelated file-less 'integration' findings both hashed to
  // f86e42eb6b8c1f33fc182757 — the EXACT base fp the wave-40 forensics named.
  //
  // Fold in a normalized-description component ONLY on this branch — a
  // file-bearing finding's fingerprint (the vast majority of this module's
  // history and every existing cross-wave dedup guarantee) is COMPLETELY
  // UNTOUCHED: `parts` above is not read again once this branch is entered,
  // and for `finding.file` truthy this branch never runs at all, so the raw
  // input to the hash for a file-bearing finding is byte-identical to before
  // this change.
  //
  // DOMAIN ATTRIBUTION DELIBERATELY EXCLUDED, discovered the hard way: an
  // earlier draft of this fix also folded in `finding._declaringDomain`, and
  // running the FULL fingerprint test suite (not just this fix's own new
  // file) caught it breaking fingerprint-filed-by-domain-stamp.test.js's own
  // pre-existing, deliberately-designed invariant — "the SAME finding
  // recurring under a DIFFERENT declaring domain must still be recognized as
  // the same finding" (F-874c0683: filed_by_domain is a first-filed fact
  // precisely BECAUSE a second wave's re-reporter is expected to differ from
  // the first). Folding domain into the fingerprint would have silently
  // reclassified that legitimate cross-domain recurrence as `new`. Content
  // (category + description) is the correct axis; who is reporting it this
  // wave is not — a real fusion is proven by two UNRELATED findings sharing
  // no real content, not by the same finding changing hands.
  //
  // TRADE-OFF, DESIGNED CONSCIOUSLY (documented, not silently accepted):
  // stronger file-less discrimination weakens cross-wave dedup of a
  // LEGITIMATE re-report of the same file-less finding worded even slightly
  // differently wave to wave — the content-fingerprint match that would have
  // caught it before this fix now usually misses. This is the right trade:
  // honorReusedFindingIds' declared-id-reuse path is the SANCTIONED
  // cross-wave re-report mechanism for exactly this reason (content alone was
  // never reliable for prose that legitimately varies), and leaning
  // discrimination-heavy closes a proven, live data-corruption bug (an
  // unrelated finding silently reopening/absorbing someone else's closed or
  // deferred row) in exchange for a bounded, visible cost (an honest
  // re-report without a declared id occasionally lands as `new` instead of
  // `recurring` — a duplicate row an operator can see and merge, not a silent
  // loss).
  if (!finding.file) {
    parts.push(normalizeDescription(finding.description));
  }

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
      const only = members[0];
      // F-a8c0cf04 (widened by F-20bde286): the collision-safety-net below
      // only ever runs for a same-WAVE group of size > 1 — but the
      // cross-wave collision this guards against never produces one. A
      // finding whose prior row is absent from `findings` this wave (it was
      // not re-reported) can never sit alongside a colliding new finding as
      // a same-wave sibling; the group here is a singleton even though a
      // real collision exists one wave away. This is the cross-wave analogue
      // of a same-wave collision group — one member just lives in
      // `priorFingerprints` instead of `findings` — so salt it exactly like
      // an ordinary non-keeper UNLESS the raw (pre-normalizePath) file
      // spelling genuinely agrees with the prior's. A spelling MATCH is
      // either an exact regression (new information — let it reopen via the
      // ordinary `recurring` path below) or a same-file rediscovery under
      // different casing — the case-fold's intended job (F-c63da27b) —
      // which must keep collapsing, regardless of the prior's status.
      //
      // F-20bde286: a spelling MISMATCH was originally salted ONLY when
      // priorRow.status === 'fixed'. Every OTHER status (new, recurring,
      // unverified, deferred) fell straight through to `resolved.set(only,
      // base)` below with no check at all — so a genuinely different,
      // higher-severity finding that happened to share the coarse key with
      // an OPEN or deferred prior silently merged into that prior's row via
      // classifyFindings' ordinary matching, discarding the new finding's
      // real severity/description. shouldSaltCrossWaveCollision (below)
      // makes the same raw-mismatch check fire for every prior status, using
      // SEVERITY as the discriminator for non-'fixed' priors: a re-audit
      // that rediscovers the SAME still-open bug under a different spelling
      // reports it at the same-or-a-lower severity essentially always, so
      // only a STRICTLY HIGHER incoming severity is treated as proof this is
      // a different defect. See shouldSaltCrossWaveCollision's own header
      // for the full case-by-case breakdown of why 'fixed' stays
      // unconditional while the open/deferred statuses are severity-gated.
      const priorRow = priorFingerprints.get(base);
      if (priorRow && shouldSaltCrossWaveCollision(only, priorRow)) {
        const salted = saltByContent(base, only, 0);
        logStage('fingerprint_disambiguated_cross_wave', {
          component: 'dogfood-swarm',
          base_fingerprint: base,
          salted_fingerprint: salted,
          prior_status: priorRow.status,
          prior_severity: priorRow.severity || null,
          incoming_severity: only.severity || null,
          file: only.file || only.file_path || null,
          prior_file: priorRow.file_path || priorRow.file || null,
          category: only.category || null,
        });
        resolved.set(only, salted);
        continue;
      }
      resolved.set(only, base);
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
 * True when a finding's RAW (pre-normalizePath) file spelling differs from a
 * prior row's raw spelling, even though their NORMALIZED identity (and
 * therefore base fingerprint) already matches. normalizePath's case/slash
 * folding exists to absorb LLM-transcription slips for the SAME real file
 * (F-c63da27b's header) — a raw mismatch means the fingerprint match is
 * coincidental: two differently-spelled files (which, on this repo's
 * case-sensitive ubuntu-latest CI, really are two different files) rather
 * than two spellings of the one file the fold was designed to unify.
 *
 * Requires POSITIVE evidence on BOTH sides: a prior row with no file info at
 * all (e.g. a hand-built fixture, or a genuinely file-less finding) must NOT
 * be treated as "differs" just because the current finding has a file — that
 * would fire the cross-wave safety net on missing data rather than a proven
 * mismatch, wrongly salting an ordinary regression whose prior row simply
 * never carried file_path.
 */
function rawFileIdentityDiffers(finding, priorRow) {
  const findingFile = finding.file || '';
  const priorFile = priorRow.file_path || priorRow.file || '';
  if (!findingFile || !priorFile) return false;
  return findingFile !== priorFile;
}

/**
 * Severity rank — LOWER number is MORE severe. Mirrors findings-digest.js's
 * module-private `SEV_ORDER` (also used by findings-render.js's inline sort
 * map) rather than importing it: that constant is not exported, and a
 * four-entry rank table is cheap enough to hold to the same convention here
 * without wiring a new cross-file dependency for it. (lib/queries/cross-
 * run-analytics.js's SQL CASE statement ranks the OPPOSITE direction —
 * CRITICAL=4 down to LOW=1 — because SQLite's MAX() aggregate needs "larger
 * wins"; that inversion is intrinsic to doing the reduction in SQL, not a
 * second, driftable JS convention.) An unrecognized/missing severity ranks
 * as the LEAST severe (never wins a "more severe than" comparison) — the
 * safe default used throughout this module for absent data.
 */
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? 4;
}

/**
 * The MORE severe of two severities (lower SEVERITY_RANK wins). Missing/
 * unrecognized input never outranks a real value on either side.
 */
function maxSeverity(a, b) {
  return severityRank(b) < severityRank(a) ? b : a;
}

/**
 * F-20bde286: decide whether a cross-wave singleton collision — the current
 * wave's finding is the ONLY member of its base-fingerprint group, and a
 * PRIOR row already occupies that exact base fingerprint — must be salted
 * (kept as its own distinct row) rather than left to fall through to
 * classifyFindings' ordinary prior-match handling.
 *
 * Both scenarios this function must tell apart have rawFileIdentityDiffers()
 * === true (that guard runs first, unconditionally); the discriminator below
 * is what separates them:
 *
 *   (1) TRUE COLLISION — an unrelated, materially different finding happens
 *       to share the coarse key (category/rule_id/symbol/line-bucket) with a
 *       prior row, purely because the file paths differ only by the
 *       normalize-away casing F-c63da27b folds. MUST be salted: merging it
 *       hides its real severity/description inside the older row and — for
 *       an OPEN prior — can defeat lib/advance.js#checkFindingSeverity,
 *       which reads the merged row's stale `severity` column.
 *   (2) INTENDED CASE-FOLD JOB — the SAME still-live bug, re-audited by a
 *       pass that happened to re-case the path differently. MUST keep
 *       collapsing (NOT be salted): this is F-c63da27b's entire reason for
 *       existing, pinned by this file's own "cross-wave PATH case-fold
 *       stability is preserved for a still-open prior" tests.
 *
 * TWO discriminators tell these apart for every status except 'fixed' — a
 * severity check FIRST, a description-content check SECOND (F-f0c537bf,
 * this class's 4th pass; see git log for fp-002 / F-a8c0cf04 / F-20bde286,
 * the three passes before it):
 *
 *   - SEVERITY: a re-audit re-describing the SAME open bug does not
 *     spontaneously invent a jump to a STRICTLY higher severity tier — LLM
 *     severity assessment has noise, but noise moves a rating by one notch
 *     or leaves it level far more often than it manufactures a new, more
 *     alarming defect out of an old one. A strictly higher incoming
 *     severity is, on its own, sufficient positive evidence of scenario (1)
 *     — checked FIRST, independent of description content.
 *   - DESCRIPTION (F-f0c537bf): severity alone left a gap. Two
 *     INDEPENDENTLY-authored, genuinely different bugs at the SAME (or a
 *     lower) severity tier, sharing the coarse key by coincidence, used to
 *     fall all the way through to scenario (2) unconditionally — silently
 *     merging into the prior's row and discarding the incoming finding's
 *     real description/recommendation with no separate finding_id to
 *     recover it from. This does not defeat checkFindingSeverity's numeric
 *     gate the way scenario (1) can (the companion maxSeverity fix in
 *     upsertFindings still bumps the surviving row to the more severe of
 *     the two), but it still permanently hides that a second, distinct bug
 *     exists. For the equal-or-lower case, this function now ALSO compares
 *     the incoming finding's description against the prior row's — the
 *     SAME normalizeDescription()-based exact-match chooseBareKeeper
 *     already uses to identify a same-wave collision's rightful keeper. A
 *     description that does NOT match (post-normalization: lowercased,
 *     whitespace-collapsed, trimmed) is treated as proof this is scenario
 *     (1) after all, even though severity alone did not give it away. A
 *     MATCHING description is scenario (2) — the same re-audited bug,
 *     case-respelled — and collapses exactly as it did before F-f0c537bf.
 *
 *     Why exact equality, not fuzzy similarity: this file has no
 *     fuzzy-match dependency anywhere, and exact equality (after the SAME
 *     normalization chooseBareKeeper already trusts for same-wave keeper
 *     selection) is sufficient for every "must still collapse" fixture in
 *     this package's pin suite — a genuine re-audit of the SAME bug reports
 *     the SAME prose far more often than not. The asymmetry of harm also
 *     favors erring toward a false split over a false collapse: a false
 *     split is a small, visible, operator-correctable duplicate row; a
 *     false collapse is a silent, permanent loss of a distinct bug's
 *     description/recommendation with no separate finding_id to recover it
 *     from.
 *
 *   - status === 'fixed': UNCONDITIONAL salt on raw-mismatch, no severity OR
 *     description check — F-a8c0cf04's original, already-proven behavior,
 *     unchanged. A raw-mismatch against CLOSED material has no "just
 *     re-cased, still the same open bug" reading available in the first
 *     place (there is no "still open" for a fixed row); treating it with
 *     LESS suspicion than an open prior would be backwards, not more
 *     lenient.
 *   - status in {new, recurring, unverified, deferred}: salted iff the
 *     incoming severity is STRICTLY more severe than priorRow.severity, OR
 *     (F-f0c537bf) the incoming description does not match priorRow's
 *     description post-normalization. 'deferred' rides this same rule
 *     rather than being excluded: a coordinator's decision to defer one
 *     specific, understood bug must not silently absorb an unrelated
 *     defect — same severity tier or not — under that same deferred banner
 *     (the harm F-20bde286 rates worse in kind than the open-status gate
 *     defeat, even though deferred findings are already excluded from the
 *     gate's count) — but a matching-description, equal-or-lower-severity
 *     rediscovery while deferred is still exactly scenario (2) and must
 *     still reach classifyFindings' `recurred_while_closed` handling
 *     (F-130dee59/F-833dff6f) untouched.
 *   - 'rejected': buildPriorMap excludes 'rejected' rows from the map this
 *     function's `priorRow` argument is drawn from (F-6a8a98d6's comment on
 *     classifyFindings), so this function never observes that status today.
 *     Left un-special-cased rather than silently folded into the open-status
 *     branch, so a future change to that exclusion does not inherit an
 *     untested behavior by accident.
 *
 * @param {object} finding — the current-wave singleton (only member of its group)
 * @param {object} priorRow — the prior-wave row occupying the same base fingerprint
 * @returns {boolean}
 */
function shouldSaltCrossWaveCollision(finding, priorRow) {
  if (!rawFileIdentityDiffers(finding, priorRow)) return false;
  if (priorRow.status === 'fixed') return true;
  if (priorRow.status === 'new' || priorRow.status === 'recurring'
    || priorRow.status === 'unverified' || priorRow.status === 'deferred') {
    if (severityRank(finding.severity) < severityRank(priorRow.severity)) return true;
    // F-f0c537bf: severity alone cannot tell a genuinely different,
    // same-or-lower-severity bug apart from the SAME bug re-audited under
    // different path casing — both look identical to the check above. A
    // description that does not match the prior row's (post-normalization)
    // is the second, content-based signal: two independently-authored
    // findings essentially never share prose verbatim, while a re-audit of
    // the SAME defect overwhelmingly does.
    return normalizeDescription(finding.description) !== normalizeDescription(priorRow.description);
  }
  return false;
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
  // A DECLARED id reuse (honorReusedFindingIds) is authoritative over content
  // heuristics: without this, a same-wave sibling that coincidentally shares
  // the prior's base fingerprint could win the keeper slot on description
  // sort, merging the UNRELATED sibling into the prior (stale description,
  // severity bumped) while the true re-report gets salted into a duplicate —
  // proven live pre-ship, and strictly worse than the pre-helper baseline.
  // Two honored members (two agents declaring one id) is degenerate input;
  // fall through to the deterministic content heuristics for that.
  const honored = members.filter((m) => m._idReuseHonored === true);
  if (honored.length === 1) return honored[0];

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
 * @param {string[]} [scope.confirmed] — finding_ids the wave's agents EXPLICITLY
 *   declared they checked (their `confirmed` output field). This is the caller's
 *   finest coverage assertion and the only one that survives a lens change:
 *   `full`/`scopePaths` say the wave looked at the PATH, never that it looked for
 *   THIS defect. When supplied, an absent prior closes ONLY if its id appears
 *   here; otherwise it is `unverified` (open, re-evaluated next wave). Omit it and
 *   the coarser reading stands unchanged — every pre-existing caller and this
 *   package's own scope pins (CP4-SCOPE-WIRING, B-BACK-003) keep their contract,
 *   because a caller that asserts nothing finer is not silently held to it.
 * @returns {{ new: Array, recurring: Array, fixed: Array, unverified: Array, recurred_while_closed: Array }}
 *   recurred_while_closed holds priors rediscovered this wave while
 *   deferred/rejected (F-130dee59) — NOT reclassified into `recurring`, so
 *   their status is untouched; upsertFindings logs an observability event for
 *   each without overwriting status.
 */
export function classifyFindings(currentFindings, priorFingerprints, scope = null) {
  const currentSet = new Set();
  const result = { new: [], recurring: [], fixed: [], unverified: [], recurred_while_closed: [] };

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

    const prior = priorFingerprints.get(fp);
    if (prior) {
      // F-130dee59: a coordinator's deferred/rejected verdict is a decision
      // NOT to act — the operator has seen the defect and chosen to accept or
      // reject it, not claimed it is gone. Rediscovery is not new information
      // that should silently overturn that decision; it is exactly what the
      // not-rediscovered branch below already protects via the identical
      // terminal-status check, but this branch previously had no check at
      // all, so `upsertFindings`' updateRecurring blindly overwrote
      // status='deferred' -> 'recurring' with no log line — unlike
      // 'rejected', which the (fp not in priorFingerprints) INSERT-OR-IGNORE
      // path already protects explicitly (see upsertFindings). `rejected` is
      // checked here too, defensively: buildPriorMap excludes it today so
      // this branch cannot currently observe it, but a future change to that
      // exclusion should not silently reopen this exact gap.
      //
      // `fixed` is deliberately NOT covered here: a fixed finding recurring
      // IS new information — a regression — so it flows through the ordinary
      // recurring path below and reopens, mirroring the asymmetry the
      // not-rediscovered branch documents for its own terminal check.
      if (prior.status === 'deferred' || prior.status === 'rejected') {
        result.recurred_while_closed.push({ ...finding, fingerprint: fp, prior, priorStatus: prior.status });
        continue;
      }
      result.recurring.push({ ...finding, fingerprint: fp, prior });
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
  // The caller's FINEST coverage assertion: the ids agents explicitly declared
  // they checked. `null` = the caller made no such assertion and the coarser
  // full/scopePaths reading stands (every pre-existing caller, incl. this
  // package's own scope pins). See the `scope.confirmed` @param for why.
  const confirmed = Array.isArray(scope?.confirmed)
    ? new Set(scope.confirmed.map((id) => String(id).toUpperCase()))
    : null;

  for (const [fp, prior] of priorFingerprints) {
    if (currentSet.has(fp)) continue;
    // Terminal-WHEN-ABSENT statuses: once fixed/deferred/rejected and NOT
    // seen again this wave, a finding stays put — absence never invents a
    // new verdict for a closed finding. `fixed` is NOT also
    // terminal-when-REDISCOVERED (see the disambiguated loop above): a fixed
    // finding reappearing is a regression, which reopens via the ordinary
    // recurring path. `deferred`/`rejected` ARE terminal-when-rediscovered
    // too (same loop, `recurred_while_closed`) — an operator's decision not
    // to act is not overturned by the defect still being there; only an
    // operator can reopen it.
    if (prior.status === 'deferred' || prior.status === 'rejected' || prior.status === 'fixed') continue;

    const priorPath = normalizePath(prior.file_path || prior.file || '');
    const inScope = fullScope || isPathInScope(priorPath, scopePaths);

    // Coverage says the wave looked at the PATH. It cannot say the wave looked
    // for THIS DEFECT — the lens decides that, and the lens changes between
    // stages. A stage-d-audit agent hunting typography covers every file a
    // health finding lives in while having no way to see it, so its silence is
    // guaranteed by the lens, not earned by the defect being gone. That is the
    // wave-28 shape (where the silence was guaranteed by the brief's own
    // "do NOT re-report" order) wearing different clothes: absence
    // manufactured by something other than a fix.
    //
    // So when the caller supplies `confirmed`, an id NOT in it was never
    // declared checked and cannot close. It becomes `unverified` — the state
    // B-BACK-003 built for exactly this ("we do not know whether the defect was
    // fixed or simply not looked at"), which stays OPEN and re-enters the next
    // wave's prior map. This is what makes the brief's "Did not check it? Say
    // so" instruction mechanical rather than decorative: before this, an agent
    // could honestly disclose it never looked and the finding closed anyway,
    // because nothing read the disclosure.
    const declaredChecked = confirmed === null
      || confirmed.has(String(prior.finding_id || '').toUpperCase());

    if (inScope && declaredChecked) {
      result.fixed.push({ ...prior, fingerprint: fp });
    } else {
      result.unverified.push({ ...prior, fingerprint: fp });
    }
  }

  return result;
}

/**
 * Honor a CONFIRM-queue re-report's declared finding id.
 *
 * The audit brief's confirmation queue tells an agent: "Still present? Report
 * it again, reusing its id from below. That records it as recurring, not as a
 * duplicate." Before this helper, that promise was not mechanical: the
 * agent-supplied `id` was never read — matching ran purely on the content
 * fingerprint, whose inputs (category, rule_id, symbol, line-context) the
 * queue does not even show the agent. A faithful re-report with a rewritten
 * description and a re-derived line landed as a NEW row, duplicating a
 * still-open prior (10 of 14 intended re-reports did exactly that in one
 * wave), while the prior stayed open as unverified — a state no lawful verb
 * can route to an amend. Content matching also cannot be made reliable here
 * even in principle: the context-hash LOCATION component is computed from the
 * CURRENT source at each collect, so any edit near the finding between waves
 * shifts the window and breaks the match.
 *
 * The declared id is the stable handle built for exactly this (D3B-006), so:
 * when a current finding's `id` exactly matches an OPEN prior's finding_id
 * (case-insensitive, same UPPER() convention as `swarm approve --ids`) AND
 * the finding names the SAME file as that prior (normalizePath equality —
 * an id typo'd onto an unrelated file must not inherit the prior's identity),
 * the finding takes the prior's fingerprint and the prior's RAW file spelling.
 *
 * The raw-spelling alignment matters: shouldSaltCrossWaveCollision treats a
 * raw-file mismatch + rewritten description as evidence of a coincidental
 * collision and would salt the re-report right back into a new row. A
 * deliberate, declared id reuse is the opposite of coincidence, so the
 * mapping removes the mismatch instead of fighting the salt logic.
 *
 * Deliberately NOT new policy: this changes only HOW a prior is matched
 * (declared id instead of content luck). WHAT happens on the match stays with
 * classifyFindings' existing branches — recurring for open priors, regression
 * reopen for fixed ones, recurred_while_closed for deferred (rejected rows
 * are not in the prior map at all, so a reused rejected id falls through to
 * the INSERT-conflict path unchanged). A mismatched or unknown id changes
 * nothing and is logged, never guessed.
 *
 * Two authority rules, both adversarially earned pre-ship (the first review
 * of this helper returned DO-NOT-SHIP with live PoCs for each):
 *
 *   - OWNERSHIP. The CONFIRM queue is run-wide: every domain's brief shows
 *     every open finding, so "the agent knew the id and the file" proves it
 *     can read its own prompt, nothing more. Without an ownership gate, any
 *     domain could recur / severity-escalate / regression-reopen a finding it
 *     never read — proven live through the real collect(): a packages/b/**
 *     domain flipped a packages/a/** finding to recurring and LOW→CRITICAL by
 *     echoing its own prompt. That is F-18d0ef6d's cross-domain-vouching
 *     shape on the recur path, so it takes the same rule the confirmed[]
 *     close path takes: the DECLARING domain's globs must cover the prior's
 *     file (matchesAnyGlob — routing, closing, and now recurring answer to
 *     one authority). A finding with no domain attribution fails closed.
 *     FILE-LESS PRIORS (F-ec18bc02): a prior with no file_path has no glob
 *     to match at all — ownership falls back to an EXACT `filed_by_domain`
 *     equality check instead (never a wildcard, fail-closed when
 *     filed_by_domain is itself null), the same rule
 *     lib/findings-filter.js#findingsForDomain already applies for ROUTING
 *     and commands/collect.js#isVouchableByDomain already applies for
 *     CONFIRM-queue VOUCHING (F-8a15be4c) — three call sites, one rule.
 *
 *   - THE APPROVED WINDOW. `approved` means "queued for amend": between
 *     `swarm approve` and the amend landing, the defect is KNOWN present, so
 *     an honest re-confirmation proves nothing new — but updateRecurring
 *     would flip approved → recurring, silently dropping the finding out of
 *     findingsForDomain's amend routing and undoing the coordinator's verb.
 *     Proven live through collect(). An approved prior is therefore never
 *     honored (logged, so the re-confirmation is visible, not swallowed).
 *     The content-fingerprint path's pre-existing behavior for approved rows
 *     is deliberately not widened by this helper.
 *
 * @param {Array} findings — current-wave findings (before classifyFindings);
 *   each entry may carry `_declaringDomain` (stamped by the collecting
 *   caller from the agent that reported it)
 * @param {Map<string, object>} priorFingerprints — buildPriorMap output
 * @param {Array<{name: string, globs: string[]}>} [domains] — the frozen map
 *   (the same rows scopeConfirmedToOwningDomain takes). Omitted/empty →
 *   nothing can be honored (fail closed).
 * @returns {Array} new array; entries are replaced (not mutated) only when a
 *   declared id reuse is honored. Honored entries carry
 *   `_idReuseHonored: true`, which chooseBareKeeper treats as authoritative
 *   over content heuristics in a same-wave collision group.
 */
export function honorReusedFindingIds(findings, priorFingerprints, domains = []) {
  if (!(priorFingerprints instanceof Map) || priorFingerprints.size === 0) {
    return findings;
  }
  const byId = new Map();
  for (const row of priorFingerprints.values()) {
    if (row && row.finding_id) byId.set(String(row.finding_id).toUpperCase(), row);
  }
  if (byId.size === 0) return findings;
  const domainByName = new Map(
    (Array.isArray(domains) ? domains : []).map((d) => [d.name, d]),
  );

  return findings.map((raw) => {
    // `_idReuseHonored` is trust metadata only this helper may mint: the
    // agent-output schema leaves findings additionalProperties-open, so an
    // agent can ship the flag in its own JSON, and chooseBareKeeper consumes
    // it DOWNSTREAM of the ownership gate — a forged copy hijacks collision-
    // group keeper selection and re-opens the exact cross-domain escalation
    // the gate closed (proven live by the pre-ship review's PoC). Stripping
    // it here, before any logic, is what makes the flag mean "this helper
    // honored a declared reuse" and nothing else. `_declaringDomain` is the
    // opposite case — INPUT metadata whose integrity the callers own by
    // assigning it unconditionally AFTER their spread of the agent object
    // (forge attempt proven squashed through the real collect()).
    let finding = raw;
    if (raw && Object.hasOwn(raw, '_idReuseHonored')) {
      const { _idReuseHonored, ...rest } = raw;
      finding = rest;
    }
    const declaredId = finding && finding.id ? String(finding.id).toUpperCase() : '';
    if (!declaredId) return finding;
    const prior = byId.get(declaredId);
    if (!prior) return finding;

    if (prior.status === 'approved') {
      logStage('confirm_id_reuse_skipped_approved', {
        component: 'dogfood-swarm',
        declared_id: finding.id,
        declaring_domain: finding._declaringDomain || null,
        file: prior.file_path || prior.file || null,
      });
      return finding;
    }

    const priorFile = prior.file_path || prior.file || '';
    if (normalizePath(finding.file) !== normalizePath(priorFile)) {
      logStage('confirm_id_reuse_file_mismatch', {
        component: 'dogfood-swarm',
        declared_id: finding.id,
        declaring_domain: finding._declaringDomain || null,
        finding_file: finding.file || null,
        prior_file: priorFile || null,
        prior_status: prior.status || null,
      });
      return finding;
    }

    // F-00d67cb6: normalize priorFile through normalizePath() — the SAME
    // normalize-then-match shape the file-mismatch check three lines above
    // already uses — before the ownership glob match. Without this, a prior
    // row whose file_path carries a capitalized directory segment (a
    // realistic LLM-transcription variant of the real, all-lowercase file
    // on disk) fails the file-mismatch check's normalized comparison the
    // SAME way as any other spelling variant (i.e. it still MATCHES, since
    // normalizePath folds case on both sides there), but then hits this raw,
    // un-normalized matchesAnyGlob call — minimatch is case-sensitive, so
    // the same capitalized path that just proved identity three lines up
    // wrongly fails ownership here, and a faithful same-id re-report of an
    // OWNED file is refused as confirm_id_reuse_unowned. The identical class
    // is open as F-f347d858 against commands/collect.js's
    // scopeConfirmedToOwningDomain (a different domain's file, not edited
    // here) — both call sites converge on the same normalize-then-match
    // shape independently.
    //
    // F-ec18bc02: a FILE-LESS prior (priorFile === '') has no glob to match
    // against — matchesAnyGlob('', globs) can never be true for any real
    // glob pattern (findings-filter.js#matchesAnyGlob's own guard:
    // `if (!filePath) return false`), so EVERY file-less id-reuse was
    // refused as unowned unconditionally, regardless of which domain
    // declared it. Mirrors the identical fix already shipped for the
    // sibling CONFIRM-queue vouching path (F-8a15be4c,
    // commands/collect.js#isVouchableByDomain) and this file's own C3-era
    // ROUTING fallback (lib/findings-filter.js#findingsForDomain,
    // `f.filed_by_domain != null && f.filed_by_domain === domain.name`,
    // byte-identical rule): when the prior has a real file, ownership
    // answers to the glob match, unchanged; when the prior is file-less,
    // ownership answers to `filed_by_domain` instead — an EXACT match,
    // never a wildcard, and fail-closed (false) when `filed_by_domain`
    // is itself null (a pre-v10 row, or any finding upserted before a
    // caller threaded `_declaringDomain` through — no recorded filer to
    // vouch through, so "nobody" is the honest answer, never a guess).
    const declaringDomain = domainByName.get(finding._declaringDomain);
    const normalizedPriorFile = normalizePath(priorFile);
    const owned = normalizedPriorFile
      ? !!declaringDomain && matchesAnyGlob(normalizedPriorFile, declaringDomain.globs)
      : prior.filed_by_domain != null && finding._declaringDomain === prior.filed_by_domain;
    if (!owned) {
      logStage('confirm_id_reuse_unowned', {
        component: 'dogfood-swarm',
        declared_id: finding.id,
        declaring_domain: finding._declaringDomain || null,
        prior_file: priorFile || null,
        prior_filed_by_domain: prior.filed_by_domain || null,
        prior_status: prior.status || null,
      });
      return finding;
    }

    if (finding.fingerprint === prior.fingerprint && (finding.file || '') === priorFile) {
      return { ...finding, _idReuseHonored: true };
    }
    logStage('confirm_id_reuse_applied', {
      component: 'dogfood-swarm',
      declared_id: finding.id,
      declaring_domain: finding._declaringDomain || null,
      prior_status: prior.status || null,
      prior_fingerprint: prior.fingerprint,
      replaced_fingerprint: finding.fingerprint || null,
      file: priorFile || null,
    });
    return { ...finding, fingerprint: prior.fingerprint, file: priorFile || finding.file, _idReuseHonored: true };
  });
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
 * @returns {{ inserted: number, updated: number, fixed: number, unverified: number, preserved: number }}
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
      status, first_seen_wave, last_seen_wave, filed_by_domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO finding_events (finding_id, event_type, wave_id, notes)
    VALUES (?, ?, ?, ?)
  `);

  // F-e71f9e7a: filed_by_domain was stamped ONLY on the classified.new INSERT
  // path below — every other write path left a NULL filed_by_domain (pre-v10
  // history, or any row inserted by a caller that had not yet threaded
  // _declaringDomain through) permanently NULL, even when THIS wave's own
  // classifyFindings output carries positive attribution for the SAME row via
  // a recurrence. COALESCE(filed_by_domain, ?) backfills ONLY the null case —
  // it deliberately does NOT touch a row that already has a value, preserving
  // the documented "first-filed fact, never overwritten on recurrence" contract
  // this column has always had (see the classified.new loop below, and
  // fingerprint-filed-by-domain-stamp.test.js's own "does NOT overwrite...
  // under a different declaring domain" pin, which stays green under COALESCE
  // because that test's row already has a non-null value by the time it
  // recurs). updateFixed/updateUnverified are DELIBERATELY excluded from this
  // backfill: both operate on a PRIOR row that was NOT re-reported this wave
  // (classifyFindings spreads `prior`, never the current-wave finding, into
  // those two buckets — see classifyFindings' own result.fixed/result.unverified
  // pushes), so there is no current-wave `_declaringDomain` to backfill from
  // in either case; forcing a value there would be guessing, not backfilling.
  const updateRecurring = db.prepare(`
    UPDATE findings SET status = 'recurring', last_seen_wave = ?, severity = ?, filed_by_domain = COALESCE(filed_by_domain, ?) WHERE id = ?
  `);

  const updateFixed = db.prepare(`
    UPDATE findings SET status = 'fixed', last_seen_wave = ? WHERE id = ?
  `);

  // F-833dff6f: recurred-while-closed findings need last_seen_wave bumped
  // WITHOUT touching status — the opposite split from updateRecurring/
  // updateFixed above, which bump both together. Status must stay untouched
  // (that is F-130dee59's whole point: a coordinator's deferred/rejected
  // call is not overturned by mere recurrence); last_seen_wave must NOT stay
  // untouched, because the finding genuinely WAS observed again this wave,
  // and every per-wave operator surface that reasons about "what did this
  // wave touch" keys off last_seen_wave (commands/status.js's
  // currentWaveFindingCount half-state check; commands/revalidate.js's
  // full-coverage reclassification query `WHERE last_seen_wave = ?`) — not
  // off finding_events, which none of them join against today.
  //
  // F-e71f9e7a: also used for the 'rejected' insert-conflict recurrence path
  // below (classified.new loop), which — like recurred_while_closed — has a
  // real current-wave finding (not just a prior row) in scope, so the same
  // COALESCE backfill applies there too.
  const updateLastSeenPreserveStatus = db.prepare(`
    UPDATE findings SET last_seen_wave = ?, filed_by_domain = COALESCE(filed_by_domain, ?) WHERE id = ?
  `);

  // Note: unverified does NOT bump last_seen_wave — the agent did not see
  // this finding, so claiming it was last seen now would be a lie. We update
  // status only, so the next wave can still re-evaluate against the original
  // last_seen_wave for staleness reasoning.
  const updateUnverified = db.prepare(`
    UPDATE findings SET status = 'unverified' WHERE id = ?
  `);

  let inserted = 0, updated = 0, fixed = 0, unverified = 0, preserved = 0;

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
      // v10 (C3 amendment): filed_by_domain is a FIRST-FILED fact, stamped
      // once at insert like first_seen_wave (never updated on recurrence,
      // unlike last_seen_wave) — it answers "who filed this," not "who last
      // touched it." Sourced from `_declaringDomain`, which collect.js
      // (stored._declaringDomain = domain.name) and revalidate.js
      // (f._declaringDomain = r.domain) both stamp onto every finding object
      // before it reaches classifyFindings/upsertFindings; absent here only
      // for a caller that has not threaded that attribution through, in
      // which case this stays NULL rather than guessing.
      const result = insertFinding.run(
        runId, fid, f.fingerprint, f.severity, f.category,
        f.file || null, f.line || null, f.symbol || null,
        f.description, f.recommendation || null, waveId, waveId,
        f._declaringDomain || null,
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
        //
        // The last_seen_wave bump mirrors F-833dff6f's fix in the
        // recurred_while_closed loop below — this is that finding's sibling
        // gap, on the path 'rejected' actually takes. The two closed statuses
        // are one class in intent (F-130dee59) but reach upsert through
        // different branches: 'deferred' via that loop, 'rejected' via this
        // insert-conflict. The event row alone left last_seen_wave-keyed
        // operator surfaces blind to the recurrence — notably status.js's
        // currentWaveFindingCount, where a wave rediscovering ONLY rejected
        // findings counted 0 and tripped the half-state "artifacts present,
        // findings absent" breadcrumb. Status stays untouched: that is
        // F-130dee59's point and this does not re-litigate it.
        const existing = db.prepare(
          'SELECT id, status FROM findings WHERE run_id = ? AND (fingerprint = ? OR finding_id = ?)'
        ).get(runId, f.fingerprint, fid);
        if (existing && existing.status === 'rejected') {
          updateLastSeenPreserveStatus.run(waveId, f._declaringDomain || null, existing.id);
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

    // Update recurring findings.
    //
    // F-20bde286 (part 2, defense-in-depth): bump the stored severity to the
    // MORE severe of (prior, incoming) — see maxSeverity's header. This
    // closes the checkFindingSeverity gate-defeat consequence even for a
    // merge shouldSaltCrossWaveCollision's own identity logic decided IS the
    // same finding (an equal-or-lower-severity case-variant rediscovery, or
    // an ordinary same-spelling regression): the stored severity a wave-gate
    // reads must never stay pinned to a STALE, less-severe value just
    // because an earlier wave happened to create the row. When a bump
    // actually happens, the finding_event note names it so the escalation is
    // visible in the audit trail, not just the resulting column value.
    for (const f of classified.recurring) {
      if (f.prior?.id) {
        const bumpedSeverity = maxSeverity(f.prior.severity, f.severity);
        updateRecurring.run(waveId, bumpedSeverity, f._declaringDomain || null, f.prior.id);
        insertEvent.run(
          f.prior.id, 'recurred', waveId,
          bumpedSeverity !== f.prior.severity
            ? `severity escalated ${f.prior.severity} -> ${bumpedSeverity} on recurrence`
            : null,
        );
        updated++;
      }
    }

    // F-130dee59: findings rediscovered while deferred/rejected. classifyFindings
    // already kept their status untouched (see recurred_while_closed's header
    // comment) — this loop only adds the same observability 'rejected' already
    // had via the INSERT-OR-IGNORE conflict path above, generalized to
    // whichever closed status applied, so an operator can see "this keeps
    // coming back" without the recurrence overturning their decision. Callers
    // that hand-build a partial classified-shaped object (revalidate.js) simply
    // omit this bucket — status-preservation itself does not depend on it,
    // since classifyFindings already never routed these into `recurring`.
    for (const f of (classified.recurred_while_closed || [])) {
      if (f.prior?.id) {
        updateLastSeenPreserveStatus.run(waveId, f._declaringDomain || null, f.prior.id);
        insertEvent.run(
          f.prior.id, 'recurred', waveId,
          `recurred-while-${f.priorStatus}: rediscovered by this wave; ${f.priorStatus} status preserved`
        );
        preserved++;
      }
    }

    // Mark fixed findings.
    // F-2c6d825d: classified.fixed holds priors that were IN a full-coverage
    // wave's scope but NOT re-reported — closed by absence, not by a
    // rediscovered-then-fixed event. Stamp the closure with a distinguishing
    // note so an operator reading finding_events can tell a by-absence closure
    // from a by-fix one. Observability only: status is still 'fixed', the
    // bucketing and the gate are unchanged.
    for (const f of classified.fixed) {
      if (f.id) {
        updateFixed.run(waveId, f.id);
        insertEvent.run(f.id, 'fixed', waveId, 'closed by absence — not rediscovered in full-coverage re-audit');
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
  return { inserted, updated, fixed, unverified, preserved };
}
