#!/usr/bin/env node
/**
 * check-finding-regression-pins.mjs — Tier-1 CI gate for Class #14
 * (claimed-fixed without verification).
 *
 * REWRITTEN wave 18 (Option C — see docs/pin-matcher-rewrite.dispatch.md).
 * The retired text-heuristic mechanism (860ed73, waves 6-16: leading-
 * comment / test-title / self-header / same-line-assert-argument credit
 * rules over lexer-masked text) false-granted on SEVEN consecutive
 * adversarial audits — most recently F-6573391e, a template-literal
 * continuation line satisfying a bare `startsWith(id)` fallback with zero
 * comment syntax at all. This file now grants Tier-1 credit ONLY via a
 * declared `@pins <id>` tag read from a real AST
 * (pin-declarations.mjs) — never from text proximity. See that file's
 * module docstring for the full mechanism and its C9 assurance rig:
 * pin-declarations-corpus.mjs (append-only adversarial fixtures, seeded
 * from the seven real historical leaks), pin-declarations.test.mjs
 * (metamorphic relations + a pin-syntax-space generator),
 * pin-declarations-reference.mjs + pin-declarations-differential.test.mjs
 * (a second, independently-coded matcher, diffed against the primary and
 * against the live tree), and pin-declarations-mutation.test.mjs (proves
 * this module's own test suite would catch a regression in itself).
 *
 * COVERAGE BUCKETS, in decision-precedence order:
 *   1. DECLARED      — a well-formed, correctly-attached `@pins <id>` tag
 *                      exists. Tier-1 VERIFIED.
 *   2. ALLOWLISTED   — the source mention is a prose cross-reference, not a
 *                      fix pin (regression-pin-allowlist.json — C8: every
 *                      entry now carries reason + owner + revalidate_by).
 *   3. GRANDFATHERED — no declared tag, but the id is a member of the
 *                      FROZEN migration-debt snapshot
 *                      (scripts/grandfathered-pins.json — C8: every entry
 *                      carries owner + revalidate_by). EXEMPT from
 *                      blocking, but DISCLOSED as unverified migration
 *                      debt — never silently treated as equivalent to a
 *                      declared pin. This bucket is what makes landing the
 *                      wave-18 rewrite safe: without it, EVERY pre-existing
 *                      pin in the repo (migrated by no domain yet) would go
 *                      red on that wave's own commit.
 *   4. ORPHAN        — none of the above. BLOCKS the gate.
 *
 * F-ca8e7b44 (wave 20 fix): the grandfather bucket IS a static list,
 * frozen at commit 132dc18 (the wave-18 cutover) into
 * scripts/grandfathered-pins.json — membership in THAT file is the only
 * question asked. The retired heuristic (suggest-pins.mjs's
 * hasLegacyStructuralHit) is NEVER invoked live by this gate any more, for
 * ANY id. Before this fix the bucket was "recomputed fresh every run from
 * whatever legacy evidence still exists" — which meant a finding minted
 * TODAY, decorated with any of the seven historical leak shapes, earned the
 * exact same exemption as a genuine pre-wave-18 pin: migration debt with no
 * vintage boundary is not migration debt, it is a standing bypass. A closed,
 * finite set can only shrink: as domains land real `@pins` tags
 * (scripts/suggest-pins.mjs still proposes candidates from the same legacy
 * evidence, unchanged in that one candidate-generator role), ids drain out
 * of the live grandfathered bucket and the gate reports the shrinking count
 * on every run (C6) — see formatHuman's "N of M frozen id(s) still
 * outstanding" line. An id with no entry in the frozen manifest can never
 * enter this bucket after the fact; there is no live path in, only a fixed
 * set to drain. (Do not add ids to grandfathered-pins.json to "fix" a new
 * orphan — see that file's own `$comment` for why.)
 *
 * ALSO BLOCKING (Tier-1, provably-exact — dispatch finding 18: only the
 * provably-exact part of a gate may block):
 *   - parseErrors — a test file `@babel/parser` could not parse (C7,
 *     finding 32: "skipped" and "clean" are indistinguishable to a gate —
 *     an unparseable file is a loud defect, never a silent pass-through).
 *   - tagIssues   — a malformed, dangling, or misattached `@pins` tag
 *     anywhere in the scanned test-file set (C3): empty-tag, bad-shape,
 *     wrong-node, not-attached (from pin-declarations.mjs), plus
 *     dangling-id (computed here — a well-formed, correctly-attached tag
 *     whose id matches no source-side pin at all; "resolvable against the
 *     findings corpus" per C3, interpreted against this gate's OWN computed
 *     source_pins set — the cheapest honest resolution, not a separate
 *     findings database lookup).
 *
 * DISCLOSED GAPS (C6 — stated here AND surfaced in this gate's own runtime
 * output every run, never only in a docstring that can drift; this
 * paragraph is kept word-for-word in sync with the DISCLOSED_GAPS array
 * below it — two descriptions of the same gap disagreeing is exactly the
 * self-contradiction class F-a544c1c4 found elsewhere in this wave, and
 * this file does not get to repeat it):
 *   - Tier 2 (mutation proof that a pinned test actually fails without its
 *     fix — dispatch C4) is NOT implemented here; it is wave 19 per the
 *     dispatch's explicit scope decision. A well-formed, correctly-
 *     attached, but semantically vacuous pin currently PASSES Tier 1 —
 *     including the worst case (F-21dc98e0): an empty `describe()` with
 *     zero test children, a `describe()` whose only children are all
 *     `.skip()`-ed, or a directly `.skip()`-ed test all qualify exactly as
 *     if they executed a real assertion. "Vacuous" tops out at ZERO test
 *     registration, not merely a trivial `assert.ok(true)`. This is real
 *     and disclosed — and strictly smaller than the retired gate's gap
 *     (there, a bare comment satisfied credit with no test at all).
 *   - The differential cross-check against the independently-coded
 *     reference matcher (dispatch finding 23) runs in
 *     pin-declarations-differential.test.mjs, part of `npm test`/
 *     `npm run verify` — deliberately NOT inside this CLI's own live
 *     execution, so a reference-matcher-only divergence cannot become a
 *     new live-blocking failure mode on every push. See that test file's
 *     own docstring for the rationale.
 *   - `@pins` tags are only scanned in files `classifyFile()` (the parser
 *     this file still uses for source-side pins) buckets as "test" — a tag
 *     placed in a source file is not evaluated.
 *   - The grandfather bucket (scripts/grandfathered-pins.json) is a static
 *     snapshot frozen at commit 132dc18 — membership only, never a live
 *     heuristic re-check (F-ca8e7b44). It can still be WRONG at the id
 *     level (the retired heuristic that produced the original 132dc18
 *     classification could itself have over- or under-counted), but that
 *     imprecision is now bounded to a fixed, auditable, shrinking set
 *     rather than a live, unboundedly-growing surface. Grandfathered
 *     status is exemption-with-disclosure, never verified credit.
 *
 * Exit codes:
 *   0 — clean (orphans/parseErrors/tagIssues all empty)
 *   1 — at least one orphan, parse error, or tag issue
 *   2 — internal error (parser threw, allowlist malformed, etc.)
 *
 * Usage:
 *   node scripts/check-finding-regression-pins.mjs
 *   node scripts/check-finding-regression-pins.mjs --json
 *   node scripts/check-finding-regression-pins.mjs --write-index docs/regression-pin-index.json
 *   node scripts/check-finding-regression-pins.mjs --root <dir>     # alternate scan root (tests)
 *   node scripts/check-finding-regression-pins.mjs --allowlist <path>
 *   node scripts/check-finding-regression-pins.mjs --grandfather-manifest <path>
 *
 * Declaring a pin, in a test file:
 *   ```js
 *   /** @pins F-e003b1fb *\/
 *   test('title', () => { ... });
 *   ```
 * Migrating an existing pre-tag pin: `node scripts/suggest-pins.mjs`
 * proposes insertions from the retired heuristic's remaining candidate-
 * generation role (grants nothing) — vet each one, then land it by hand.
 *
 * Programmatic API:
 *   import { runRegressionPinGate } from './check-finding-regression-pins.mjs';
 *   const result = await runRegressionPinGate({ repoRoot, allowlistPath, grandfatherManifestPath, writeIndexPath });
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseRegressionPins, toJSON } from '../packages/portfolio/lib/parse-regression-pins.js';
import { scanRepoForDeclaredPins } from './pin-declarations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, '..');
const defaultAllowlistPath = resolve(here, 'regression-pin-allowlist.json');
const defaultGrandfatherManifestPath = resolve(here, 'grandfathered-pins.json');

const DISCLOSED_GAPS = [
  'Tier 2 (mutation proof that a pinned test fails without its fix) is not implemented — see docs/pin-matcher-rewrite.dispatch.md for its design; the sequencing lives there, not here. A well-formed, correctly-attached, but semantically vacuous pin currently passes Tier 1 — including the worst case: an empty describe() with zero test children, a describe() whose only children are all .skip()-ed, or a directly test.skip()-ed call all qualify for a declared tag exactly as if they executed a real assertion (F-21dc98e0). "Vacuous" tops out at zero test registration, not merely a trivial assert.ok(true).',
  "The differential cross-check against the independently-coded reference matcher runs in the test suite (npm test / pin-declarations-differential.test.mjs), not inside this CLI's own live execution.",
  '@pins tags are only scanned in files classifyFile() buckets as "test" — a tag placed in a source file is not evaluated.',
  'The grandfather bucket (scripts/grandfathered-pins.json) is a static snapshot frozen at commit 132dc18 — membership only, never a live heuristic re-check (F-ca8e7b44). It can still be WRONG at the id level (the retired heuristic that produced the original 132dc18 classification could itself have over- or under-counted), but that imprecision is now bounded to a fixed, auditable, shrinking set rather than a live, unboundedly-growing surface. Grandfathered status is exemption-with-disclosure, never verified credit.',
];

/**
 * C8: every allowlist entry requires reason + file + owner + revalidate_by.
 * Throws (never silently defaults) on any malformed or incomplete entry —
 * an override without an evidence trail is exactly what finding 22 warns
 * against ("no trust-the-human bypass").
 *
 * @param {string} path
 * @returns {{ allow: Record<string, { reason: string, file?: string, owner: string, revalidate_by: string }> }}
 */
export function loadAllowlist(path) {
  if (!existsSync(path)) return { allow: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`regression-pin-allowlist at ${path} is not valid JSON: ${err.message}`);
  }
  if (parsed.allow === undefined) {
    throw new Error(
      `regression-pin-allowlist at ${path} missing required "allow" field. Shape: { "allow": { "F-id": { "reason": "...", "file": "...", "owner": "...", "revalidate_by": "YYYY-MM-DD" } } }`,
    );
  }
  if (parsed.allow === null || typeof parsed.allow !== 'object' || Array.isArray(parsed.allow)) {
    throw new Error(
      `regression-pin-allowlist at ${path} "allow" must be an object map (got ${Array.isArray(parsed.allow) ? 'array' : typeof parsed.allow}).`,
    );
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (const [id, entry] of Object.entries(parsed.allow)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`regression-pin-allowlist entry for ${id} must be an object with { reason, file, owner, revalidate_by }.`);
    }
    if (!entry.reason || typeof entry.reason !== 'string') {
      throw new Error(`regression-pin-allowlist entry for ${id} missing "reason" string.`);
    }
    if (!entry.owner || typeof entry.owner !== 'string') {
      throw new Error(`regression-pin-allowlist entry for ${id} missing "owner" string (dispatch C8 — every override needs a named owner).`);
    }
    if (!entry.revalidate_by || typeof entry.revalidate_by !== 'string' || !dateRe.test(entry.revalidate_by)) {
      throw new Error(`regression-pin-allowlist entry for ${id} missing or malformed "revalidate_by" (expected "YYYY-MM-DD").`);
    }
  }
  return parsed;
}

/**
 * F-ca8e7b44: load the FROZEN grandfather manifest (scripts/grandfathered-
 * pins.json) — a closed, enumerated set of ids, snapshotted once at commit
 * 132dc18, that the gate checks by MEMBERSHIP ONLY. Same C8 discipline as
 * loadAllowlist: every entry requires { owner, revalidate_by }, and this
 * throws (never silently defaults) on any malformed or incomplete entry —
 * a frozen exemption without an evidence trail is exactly what finding 22
 * warns against. Unlike the allowlist, "reason" is not required per entry:
 * every entry in this file shares the SAME reason (grandfathered under the
 * pre-vintage-boundary heuristic at the freeze commit), stated once in the
 * manifest's own `$comment` rather than duplicated 256 times.
 *
 * @param {string} path
 * @returns {{ grandfathered: Record<string, { owner: string, revalidate_by: string }> }}
 */
export function loadGrandfatherManifest(path) {
  if (!existsSync(path)) return { grandfathered: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`grandfathered-pins manifest at ${path} is not valid JSON: ${err.message}`);
  }
  if (parsed.grandfathered === undefined) {
    throw new Error(
      `grandfathered-pins manifest at ${path} missing required "grandfathered" field. Shape: { "grandfathered": { "F-id": { "owner": "...", "revalidate_by": "YYYY-MM-DD" } } }`,
    );
  }
  if (parsed.grandfathered === null || typeof parsed.grandfathered !== 'object' || Array.isArray(parsed.grandfathered)) {
    throw new Error(
      `grandfathered-pins manifest at ${path} "grandfathered" must be an object map (got ${Array.isArray(parsed.grandfathered) ? 'array' : typeof parsed.grandfathered}).`,
    );
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (const [id, entry] of Object.entries(parsed.grandfathered)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`grandfathered-pins manifest entry for ${id} must be an object with { owner, revalidate_by }.`);
    }
    if (!entry.owner || typeof entry.owner !== 'string') {
      throw new Error(`grandfathered-pins manifest entry for ${id} missing "owner" string (dispatch C8 — every frozen entry needs a named owner).`);
    }
    if (!entry.revalidate_by || typeof entry.revalidate_by !== 'string' || !dateRe.test(entry.revalidate_by)) {
      throw new Error(`grandfathered-pins manifest entry for ${id} missing or malformed "revalidate_by" (expected "YYYY-MM-DD").`);
    }
  }
  return parsed;
}

/**
 * @param {string[]} candidateIds - ids not yet resolved by a declared tag.
 * @param {{ allow: Record<string, unknown> }} allowlist
 * @returns {{ remaining: string[], applied: string[], unused: string[] }}
 */
export function applyAllowlist(candidateIds, allowlist) {
  const allowed = new Set(Object.keys(allowlist.allow));
  const remaining = [];
  const applied = [];
  for (const id of candidateIds) {
    if (allowed.has(id)) applied.push(id);
    else remaining.push(id);
  }
  const unused = [...allowed].filter((id) => !applied.includes(id));
  return { remaining, applied, unused };
}

function explainUnusedAllowEntry(id, sourceIds, declared) {
  if (!sourceIds.includes(id)) return 'no longer appears as a source pin at all — safe to delete';
  if (declared.byId.has(id)) return 'now has a genuine declared @pins tag — safe to delete';
  return 'reason undetermined — investigate before deleting';
}

/**
 * F-ca8e7b44: partition `candidateIds` by membership in the FROZEN
 * grandfather manifest — no file reads, no heuristic evaluation. A pure
 * function (mirrors applyAllowlist) so the precedence rule ("is this id in
 * the closed set snapshotted at 132dc18") is directly unit-testable without
 * standing up a full repo tree.
 *
 * @param {string[]} candidateIds - ids not yet resolved by declared tag or allowlist.
 * @param {{ grandfathered: Record<string, unknown> }} manifest
 * @returns {{ grandfathered: string[], orphans: string[] }}
 */
export function applyGrandfatherManifest(candidateIds, manifest) {
  const frozen = new Set(Object.keys(manifest.grandfathered));
  const grandfathered = [];
  const orphans = [];
  for (const id of candidateIds) {
    if (frozen.has(id)) grandfathered.push(id);
    else orphans.push(id);
  }
  return { grandfathered, orphans };
}

/**
 * Classify every source-pinned id into exactly one bucket (declared >
 * allowlisted > grandfathered > orphan), and separately compute
 * dangling-id tag issues — a declared tag whose id has no source pin at
 * all. This cross-reference needs both `sourceIds` and `declared`, so it
 * cannot live inside pin-declarations.mjs, which is deliberately unaware of
 * source-side pins (see that file's module docstring).
 *
 * @param {object} opts
 * @param {string[]} opts.sourceIds
 * @param {ReturnType<typeof scanRepoForDeclaredPins>} opts.declared
 * @param {{ allow: Record<string, unknown> }} opts.allowlist
 * @param {{ grandfathered: Record<string, unknown> }} [opts.grandfatherManifest] -
 *   F-ca8e7b44: the FROZEN membership set (scripts/grandfathered-pins.json).
 *   Defaults to empty so a caller that doesn't care about the grandfather
 *   bucket (most classifyCoverage unit tests) doesn't have to construct one.
 * @returns {{
 *   declaredIds: string[], allowlistApplied: string[], unusedAllowEntries: string[],
 *   grandfatheredIds: string[], orphans: string[], danglingIdTags: object[],
 * }}
 */
export function classifyCoverage({ sourceIds, declared, allowlist, grandfatherManifest = { grandfathered: {} } }) {
  const declaredIds = sourceIds.filter((id) => declared.byId.has(id));
  const remainingAfterDeclared = sourceIds.filter((id) => !declared.byId.has(id));

  const { remaining: remainingAfterAllowlist, applied: allowlistApplied, unused: unusedAllowEntries } =
    applyAllowlist(remainingAfterDeclared, allowlist);

  // F-ca8e7b44: membership in the FROZEN manifest only — the retired
  // heuristic (suggest-pins.mjs's hasLegacyStructuralHit) is never invoked
  // live here. See scripts/grandfathered-pins.json and this file's module
  // docstring's GRANDFATHERED bucket paragraph.
  const { grandfathered: grandfatheredIds, orphans } = applyGrandfatherManifest(remainingAfterAllowlist, grandfatherManifest);

  const sourceIdSet = new Set(sourceIds);
  const danglingIdTags = [];
  for (const [id, pins] of declared.byId) {
    if (sourceIdSet.has(id)) continue;
    for (const pin of pins) {
      danglingIdTags.push({
        file: pin.file,
        line: pin.line,
        kind: 'dangling-id',
        token: id,
        detail: `@pins ${id} does not match any source-side pin — fix the id, or delete this tag if the source fix was refactored away`,
      });
    }
  }

  return {
    declaredIds: declaredIds.sort(),
    allowlistApplied: allowlistApplied.sort(),
    unusedAllowEntries: unusedAllowEntries.sort(),
    grandfatheredIds: grandfatheredIds.sort(),
    orphans: orphans.sort(),
    danglingIdTags,
  };
}

/**
 * Run the gate.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.allowlistPath]
 * @param {string} [opts.grandfatherManifestPath] - F-ca8e7b44: the frozen
 *   membership snapshot (default scripts/grandfathered-pins.json).
 * @param {string} [opts.writeIndexPath]
 * @returns {Promise<{
 *   ok: boolean, json: ReturnType<typeof toJSON>,
 *   orphans: string[], declaredIds: string[], grandfatheredIds: string[],
 *   grandfatherFrozenTotal: number, grandfatherDrainedCount: number,
 *   grandfatherDueForRevalidation: { id: string, revalidate_by: string, owner: string }[],
 *   allowlistApplied: string[], unusedAllowEntries: string[], unusedAllowEntryReasons: Record<string,string>,
 *   dueForRevalidation: { id: string, revalidate_by: string, owner: string }[],
 *   parseErrors: object[], tagIssues: object[], disclosedGaps: string[],
 *   indexWritten: string | null,
 * }>}
 */
export async function runRegressionPinGate({
  repoRoot = defaultRepoRoot,
  allowlistPath = defaultAllowlistPath,
  grandfatherManifestPath = defaultGrandfatherManifestPath,
  writeIndexPath = null,
} = {}) {
  const parsed = parseRegressionPins(repoRoot);
  const json = toJSON(parsed);
  const sourceIds = Object.keys(json.source_pins);

  const declared = scanRepoForDeclaredPins(repoRoot);
  const allowlist = loadAllowlist(allowlistPath);
  const grandfatherManifest = loadGrandfatherManifest(grandfatherManifestPath);

  const coverage = classifyCoverage({ sourceIds, declared, allowlist, grandfatherManifest });

  const unusedAllowEntryReasons = Object.fromEntries(
    coverage.unusedAllowEntries.map((id) => [id, explainUnusedAllowEntry(id, sourceIds, declared)]),
  );

  const today = new Date().toISOString().slice(0, 10);
  const dueForRevalidation = coverage.allowlistApplied
    .map((id) => ({ id, entry: allowlist.allow[id] }))
    .filter(({ entry }) => entry.revalidate_by < today)
    .map(({ id, entry }) => ({ id, revalidate_by: entry.revalidate_by, owner: entry.owner }));

  // F-ca8e7b44: the "is the debt draining" signal (C6) — how many of the
  // ids frozen at 132dc18 have left the live grandfathered bucket (declared,
  // allowlisted, or their source pin removed) since the freeze, without ever
  // editing the frozen manifest itself.
  const grandfatherFrozenIds = Object.keys(grandfatherManifest.grandfathered);
  const grandfatherDrainedCount = grandfatherFrozenIds.filter((id) => !coverage.grandfatheredIds.includes(id)).length;
  const grandfatherDueForRevalidation = coverage.grandfatheredIds
    .map((id) => ({ id, entry: grandfatherManifest.grandfathered[id] }))
    .filter(({ entry }) => entry.revalidate_by < today)
    .map(({ id, entry }) => ({ id, revalidate_by: entry.revalidate_by, owner: entry.owner }));

  const tagIssues = [...declared.issues, ...coverage.danglingIdTags];

  const ok = coverage.orphans.length === 0 && declared.parseErrors.length === 0 && tagIssues.length === 0;

  let indexWritten = null;
  if (writeIndexPath) {
    const absPath = resolve(repoRoot, writeIndexPath);
    mkdirSync(dirname(absPath), { recursive: true });
    const indexPayload = {
      ...json,
      summary: {
        ...json.summary,
        declared_ids: coverage.declaredIds.length,
        grandfathered_ids: coverage.grandfatheredIds,
        grandfathered_frozen_total: grandfatherFrozenIds.length,
        grandfathered_drained_count: grandfatherDrainedCount,
        orphan_source_ids: coverage.orphans,
      },
    };
    writeFileSync(absPath, `${JSON.stringify(indexPayload, null, 2)}\n`, 'utf-8');
    indexWritten = absPath;
  }

  return {
    ok,
    json,
    orphans: coverage.orphans,
    declaredIds: coverage.declaredIds,
    grandfatheredIds: coverage.grandfatheredIds,
    grandfatherFrozenTotal: grandfatherFrozenIds.length,
    grandfatherDrainedCount,
    grandfatherDueForRevalidation,
    allowlistApplied: coverage.allowlistApplied,
    unusedAllowEntries: coverage.unusedAllowEntries,
    unusedAllowEntryReasons,
    dueForRevalidation,
    parseErrors: declared.parseErrors,
    tagIssues,
    disclosedGaps: DISCLOSED_GAPS,
    indexWritten,
  };
}

/**
 * Pretty-print a gate result for terminal consumption.
 */
export function formatHuman(result, repoRoot) {
  const lines = [];
  const {
    json, orphans, declaredIds, grandfatheredIds, allowlistApplied,
    unusedAllowEntries, unusedAllowEntryReasons = {}, dueForRevalidation = [],
    grandfatherFrozenTotal = grandfatheredIds.length, grandfatherDrainedCount = 0,
    grandfatherDueForRevalidation = [],
    parseErrors = [], tagIssues = [], disclosedGaps = [], indexWritten,
  } = result;

  lines.push(`[check-finding-regression-pins] ${json.summary.source_ids} source-pinned F-id(s) across ${json.files_scanned} scanned file(s)`);
  lines.push(`  declared (Tier-1 verified, AST-checked @pins tag): ${declaredIds.length}`);
  if (grandfatheredIds.length > 0 || grandfatherFrozenTotal > 0) {
    // F-ca8e7b44: report the frozen total alongside the live outstanding
    // count so the debt visibly DRAINS across waves (C6) rather than reading
    // as a static, unchanging number.
    lines.push(
      `  grandfathered (frozen manifest @ commit 132dc18, UNVERIFIED — migration debt): ` +
      `${grandfatheredIds.length} of ${grandfatherFrozenTotal} frozen id(s) still outstanding ` +
      `(${grandfatherDrainedCount} drained — declared, allowlisted, or removed since the freeze): ${grandfatheredIds.join(', ')}`,
    );
  }
  if (grandfatherDueForRevalidation.length > 0) {
    lines.push('  WARN — grandfathered entries past their revalidate_by date (still exempt; not a block):');
    for (const e of grandfatherDueForRevalidation) lines.push(`    ${e.id} — was due ${e.revalidate_by} (owner: ${e.owner})`);
  }
  if (allowlistApplied.length > 0) {
    lines.push(`  allowlist applied: ${allowlistApplied.length} (${allowlistApplied.join(', ')})`);
  }
  if (unusedAllowEntries.length > 0) {
    lines.push('  WARN — stale allowlist entries (no longer match any candidate):');
    for (const id of unusedAllowEntries) lines.push(`    ${id} — ${unusedAllowEntryReasons[id] ?? 'reason unavailable'}`);
  }
  if (dueForRevalidation.length > 0) {
    lines.push('  WARN — allowlist entries past their revalidate_by date (still applied; not a block):');
    for (const e of dueForRevalidation) lines.push(`    ${e.id} — was due ${e.revalidate_by} (owner: ${e.owner})`);
  }
  if (parseErrors.length > 0) {
    lines.push(`  FAIL — ${parseErrors.length} test file(s) could not be parsed (C7 fail-closed, never silently skipped):`);
    for (const e of parseErrors) lines.push(`    ${relative(repoRoot, e.file) || e.file}:${e.line ?? '?'} — ${e.message}`);
  }
  if (tagIssues.length > 0) {
    lines.push(`  FAIL — ${tagIssues.length} malformed/dangling @pins tag(s):`);
    for (const i of tagIssues) lines.push(`    ${relative(repoRoot, i.file) || i.file}:${i.line ?? '?'} [${i.kind}] ${i.detail}`);
  }
  if (orphans.length === 0 && parseErrors.length === 0 && tagIssues.length === 0) {
    // F-ca8e7b44: the invariant, as this file's own header defines it,
    // does NOT hold for a grandfathered id — only a declared or allowlisted
    // one is actually verified. Never claim "invariant holds" while any
    // grandfathered debt remains outstanding.
    if (grandfatheredIds.length === 0) {
      lines.push('  OK — every source-pinned F-id is declared or allowlisted (Class #14 invariant holds).');
    } else {
      lines.push(
        `  OK — Class #14 gate is green: ${declaredIds.length} declared-verified, ` +
        `${grandfatheredIds.length} grandfathered-unverified (frozen migration debt), ` +
        `${allowlistApplied.length} allowlisted, 0 orphans.`,
      );
    }
  } else if (orphans.length > 0) {
    lines.push(`  FAIL — ${orphans.length} orphan source pin(s): no declared tag, no allowlist entry, no legacy signal at all:`);
    for (const id of orphans) {
      const files = json.source_pins[id] ?? [];
      lines.push(`    ${id}`);
      for (const f of files) lines.push(`      in ${relative(repoRoot, f) || f}`);
    }
    lines.push('');
    lines.push('  How to fix: add /** @pins F-id */ immediately above the covering test()/it()/describe() call,');
    lines.push('  OR run `node scripts/suggest-pins.mjs` for a candidate insertion point,');
    lines.push('  OR — if the source mention is a cross-reference, not a fix pin — add an entry to scripts/regression-pin-allowlist.json.');
  }
  lines.push('  Disclosed gaps (dispatch C6 — see docs/pin-matcher-rewrite.dispatch.md):');
  for (const gap of disclosedGaps) lines.push(`    - ${gap}`);
  if (indexWritten) lines.push(`  Wrote index to ${relative(repoRoot, indexWritten) || indexWritten}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { json: false, writeIndexPath: null, root: null, allowlistPath: null, grandfatherManifestPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--write-index') {
      out.writeIndexPath = argv[++i] ?? null;
      if (!out.writeIndexPath) throw new Error('--write-index requires a path argument');
    } else if (a === '--root') {
      out.root = argv[++i] ?? null;
      if (!out.root) throw new Error('--root requires a path argument');
    } else if (a === '--allowlist') {
      out.allowlistPath = argv[++i] ?? null;
      if (!out.allowlistPath) throw new Error('--allowlist requires a path argument');
    } else if (a === '--grandfather-manifest') {
      out.grandfatherManifestPath = argv[++i] ?? null;
      if (!out.grandfatherManifestPath) throw new Error('--grandfather-manifest requires a path argument');
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/check-finding-regression-pins.mjs [options]

Always-on CI gate for Class #14 (claimed-fixed without verification).
Grants credit ONLY via a declared, AST-verified /** @pins F-id */ tag
immediately above a test()/it()/describe() call — see
docs/pin-matcher-rewrite.dispatch.md and pin-declarations.mjs. Ids with no
declared tag but present in the FROZEN grandfathered-pins.json manifest
(snapshotted once at the wave-18 cutover commit, membership-only — never a
live heuristic re-check) are GRANDFATHERED (exempt, disclosed, unverified)
during migration; run \`node scripts/suggest-pins.mjs\` to propose insertion
points for landing real tags. An id with no entry in that frozen manifest
cannot become grandfathered, no matter what its source text looks like.

The <F-id> inside an @pins tag must match F_ID_PATTERN (from
packages/portfolio/lib/parse-regression-pins.js — the single source of
truth for the id-shape contract, not re-described here so this text cannot
independently go stale the next time that pattern is widened): legacy
F-NNNNNN-NNN (six digits, dash, three digits), hash F-xxxxxxxx (8 lowercase
hex chars), or prefixed F-AAA[-AAA...]-NNN (uppercase-alnum segments, dash,
three digits).

Options:
  --json                         machine-readable JSON output (parser result + gate)
  --write-index <path>           after parsing, write the JSON index to <path>
                                  (recommended canonical location: docs/regression-pin-index.json)
  --root <dir>                   scan a directory other than the repo root (tests use this)
  --allowlist <path>              use a different allowlist file
  --grandfather-manifest <path>   use a different frozen grandfather manifest file
  -h, --help                      this message

Exit codes: 0 (clean) | 1 (orphan/parse-error/tag-issue present) | 2 (internal error)
`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const repoRoot = args.root ? resolve(args.root) : defaultRepoRoot;
  const allowlistPath = args.allowlistPath ? resolve(args.allowlistPath) : defaultAllowlistPath;
  const grandfatherManifestPath = args.grandfatherManifestPath ? resolve(args.grandfatherManifestPath) : defaultGrandfatherManifestPath;

  let result;
  try {
    result = await runRegressionPinGate({ repoRoot, allowlistPath, grandfatherManifestPath, writeIndexPath: args.writeIndexPath });
  } catch (err) {
    process.stderr.write(`[check-finding-regression-pins] internal error: ${err.message}\n`);
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      orphans: result.orphans,
      declared_ids: result.declaredIds,
      grandfathered_ids: result.grandfatheredIds,
      grandfathered_frozen_total: result.grandfatherFrozenTotal,
      grandfathered_drained_count: result.grandfatherDrainedCount,
      grandfathered_due_for_revalidation: result.grandfatherDueForRevalidation,
      allowlist_applied: result.allowlistApplied,
      unused_allow_entries: result.unusedAllowEntries,
      unused_allow_entry_reasons: result.unusedAllowEntryReasons,
      due_for_revalidation: result.dueForRevalidation,
      parse_errors: result.parseErrors,
      tag_issues: result.tagIssues,
      disclosed_gaps: result.disclosedGaps,
      index_written: result.indexWritten,
      parser: result.json,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result, repoRoot)}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

// F-W1-CI-006: ESM main detection — pathToFileURL(process.argv[1]).href is
// the canonical Node cross-platform pattern (matches
// apply-finding-migration.mjs's W31-BACK-001 fix); process.argv[1] uses
// backslashes on Windows while import.meta.url is always POSIX/URL form.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main();
}
