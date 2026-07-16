/**
 * Tests for scripts/check-finding-regression-pins.mjs — REWRITTEN wave 18
 * (Option C, docs/pin-matcher-rewrite.dispatch.md). Most of the retired
 * text-heuristic mechanism's own tests (findStructuralPinHits,
 * computeStructuralOrphans, isLeadingCommentPin, etc.) moved with that code
 * to suggest-pins.mjs / suggest-pins.test.mjs, since this file no longer
 * defines or grants credit through that mechanism — it consumes
 * pin-declarations.mjs (the new Tier-1 matcher, tested in
 * pin-declarations.test.mjs / pin-declarations-differential.test.mjs /
 * pin-declarations-mutation.test.mjs) and suggest-pins.mjs (the demoted
 * candidate generator, now used ONLY for the grandfather bucket).
 *
 * Coverage:
 *   1. Declared-tag coverage — clean tree, orphan, allowlist, grandfather
 *   2. classifyCoverage / applyGrandfatherManifest — pure-function bucketing
 *      (declared > allowlist > grandfather > orphan precedence)
 *   3. Blocking conditions — parse errors and malformed/dangling tags both
 *      fail the gate even when zero orphans exist
 *   4. loadAllowlist / applyAllowlist — the C8 provenance schema (reason +
 *      owner + revalidate_by, all required) and dueForRevalidation
 *   5. loadGrandfatherManifest — same C8 discipline, frozen membership only
 *      (F-W19-CI-001) — every fixture test below passes an EMPTY manifest
 *      via fx.writeGrandfatherManifest({}) unless it is specifically
 *      exercising the grandfather bucket, mirroring the existing allowlist
 *      discipline: the DEFAULT manifest path resolves to the REAL repo's
 *      scripts/grandfathered-pins.json regardless of --root, so a fixture
 *      test that forgot to override it would silently inherit 256 real
 *      frozen ids (this bit F-42e57a77's fixture test for real — see the
 *      F-3ec5b54f META block below).
 *   6. --write-index, formatHuman, CLI --help/--json
 *   7. F-3ec5b54f / F-5eafee44 META — id-shape/extension non-vacuity
 *      (unchanged: this gate still consumes the same parse-regression-pins.js
 *      for source-side pins)
 *   8. Live-tree assertion — the load-bearing test
 *   9. F-W1-CI-006 / F-c59bb518 — main-entry guard and --help contract
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  runRegressionPinGate,
  loadAllowlist,
  applyAllowlist,
  loadGrandfatherManifest,
  applyGrandfatherManifest,
  classifyCoverage,
  formatHuman,
} from './check-finding-regression-pins.mjs';
import { scanRepoForDeclaredPins } from './pin-declarations.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'check-regression-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    writeAllowlist(obj) {
      const abs = join(dir, 'allowlist.json');
      writeFileSync(abs, JSON.stringify(obj, null, 2));
      return abs;
    },
    // F-W19-CI-001: mirrors writeAllowlist exactly — every fixture test
    // must explicitly point at its OWN manifest (usually empty) or it
    // silently inherits the real repo's 256-entry frozen manifest, since
    // runRegressionPinGate's default grandfatherManifestPath (like
    // allowlistPath) resolves next to this source file, not inside repoRoot.
    writeGrandfatherManifest(obj) {
      const abs = join(dir, 'grandfathered-pins.json');
      writeFileSync(abs, JSON.stringify(obj, null, 2));
      return abs;
    },
  };
}

function allowEntry(reason, file) {
  return { reason, file, owner: 'test-fixture', revalidate_by: '2099-01-01' };
}

function grandfatherEntry(owner = 'test-fixture', revalidate_by = '2099-01-01') {
  return { owner, revalidate_by };
}

const EMPTY_GRANDFATHER = { grandfathered: {} };

// ─────────────────────────────────────────────────────────────────────────────
// Declared-tag coverage — the Tier-1 mechanism, end to end through the CLI
// ─────────────────────────────────────────────────────────────────────────────

test('clean tree: a declared @pins tag resolves the source pin → ok=true', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-001 — defensive guard\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-100000-001 */\ntest('guard holds', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.ok, true, `expected ok=true; orphans=${JSON.stringify(result.orphans)} tagIssues=${JSON.stringify(result.tagIssues)}`);
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.declaredIds, ['F-100000-001']);
  assert.equal(result.json.summary.source_ids, 1);
});

test('orphan: a source pin with no declared tag, no allowlist entry, no grandfather-manifest entry → ok=false', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-200000-001 — a fix with genuinely nothing pointing at it\n');
  fx.write('packages/foo/index.test.js', "test('unrelated', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.orphans, ['F-200000-001']);
});

test('grandfather: a source pin with no declared tag but present in the FROZEN manifest is EXEMPT (ok=true) yet DISCLOSED, not silently equivalent to declared', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-300000-001 — a fix\n');
  // Deliberately NOT legacy-heuristic-shaped text (no title match, no leading
  // comment, no assert-line) — proving grandfather status now depends SOLELY
  // on frozen-manifest membership (F-W19-CI-001), never on what the test
  // file's text looks like.
  fx.write('packages/foo/index.test.js', "test('unrelated title, no legacy signal of any kind', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest({ grandfathered: { 'F-300000-001': grandfatherEntry() } }),
  });

  assert.equal(result.ok, true, 'membership in the frozen manifest must not block — this is what makes the migration debt bucket safe to keep');
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.grandfatheredIds, ['F-300000-001']);
  assert.deepEqual(result.declaredIds, [], 'frozen-manifest membership is NOT a declared tag — never silently promoted to Tier-1 verified');
  assert.equal(result.grandfatherFrozenTotal, 1);
  assert.equal(result.grandfatherDrainedCount, 0, 'nothing has drained yet — the one frozen id is still outstanding');
});

/**
 * F-W19-CI-001 — THE HIGH FIX'S OWN REPRODUCTION, now asserted closed. Before
 * this fix: a fixture tree with src/fix.js containing only
 * `// F-fac00001: fixed a totally fake, brand-new bug` (a source pin, zero
 * test coverage anywhere) and test/fix.test.js containing only
 * `// F-fac00001 is mentioned here in a leading comment, decorating an
 * unrelated no-op statement` above `const decoy = 1;` (the classic
 * isLeadingCommentPin/self-header shape) made `node
 * scripts/check-finding-regression-pins.mjs --root <fixture>` print
 * `grandfathered ... 1: F-fac00001` and exit 0 — a finding minted TODAY,
 * decorated with a historical leak shape, routed around blocking. F-fac00001
 * is NOT a member of the frozen manifest (it did not exist at commit
 * 132dc18), so it must now orphan regardless of how legacy-shaped its decoy
 * text is.
 */
/** @pins F-W19-CI-001 */
test('F-W19-CI-001: a brand-new id decorated with a classic legacy-leak decoy comment is an ORPHAN, not grandfathered — the frozen list has no live path in', async (t) => {
  const fx = makeFixture(t);
  fx.write('src/fix.js', '// F-fac00001: fixed a totally fake, brand-new bug\n');
  fx.write(
    'test/fix.test.js',
    '// F-fac00001 is mentioned here in a leading comment, decorating an unrelated no-op statement\nconst decoy = 1;\n',
  );

  // Sanity: the retired heuristic itself WOULD still flag this shape as a
  // legacy structural hit — proving the fix is the frozen-membership check,
  // not a change to hasLegacyStructuralHit's own behavior.
  const { hasLegacyStructuralHit } = await import('./suggest-pins.mjs');
  assert.equal(
    hasLegacyStructuralHit('// F-fac00001 is mentioned here in a leading comment, decorating an unrelated no-op statement\nconst decoy = 1;\n', 'F-fac00001', 'fix.test.js'),
    true,
    'sanity: this IS the classic leading-comment decoy shape the retired heuristic recognizes',
  );

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    // Deliberately empty — F-fac00001 must not exist in ANY real or fixture
    // frozen manifest for this reproduction to be honest.
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.ok, false, 'a decoy comment on a brand-new id must no longer buy grandfather exemption');
  assert.deepEqual(result.orphans, ['F-fac00001']);
  assert.deepEqual(result.grandfatheredIds, [], 'legacy-shaped text alone, with no frozen-manifest entry, must never land in the grandfathered bucket');
});

test('declared beats grandfather: an id with BOTH a declared tag AND a frozen-manifest entry is reported as declared, not grandfathered', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-400000-001 — a fix\n');
  fx.write(
    'packages/foo/index.test.js',
    "/** @pins F-400000-001 */\ntest('guard', () => { assert.ok(true); });\n",
  );

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest({ grandfathered: { 'F-400000-001': grandfatherEntry() } }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.declaredIds, ['F-400000-001']);
  assert.deepEqual(result.grandfatheredIds, []);
  assert.equal(result.grandfatherDrainedCount, 1, 'the frozen id drained because it now has a real declared tag');
});

test('allowlist beats grandfather: an allowlisted id is reported as allowlisted even if it ALSO has a frozen-manifest entry', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-500000-001 — cross-reference, not a fix pin\n');
  fx.write('packages/foo/index.test.js', "test('mentions the id in an unrelated title', () => { assert.ok(true); });\n");
  const allowlistPath = fx.writeAllowlist({ allow: { 'F-500000-001': allowEntry('cross-reference, not a real pin', 'packages/foo/index.js') } });

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath,
    grandfatherManifestPath: fx.writeGrandfatherManifest({ grandfathered: { 'F-500000-001': grandfatherEntry() } }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.allowlistApplied, ['F-500000-001']);
  assert.deepEqual(result.grandfatheredIds, []);
  assert.equal(result.grandfatherDrainedCount, 1, 'the frozen id drained because it now has a real allowlist entry');
});

// ─────────────────────────────────────────────────────────────────────────────
// F-21dc98e0 — the disclosure's own floor was understated (C6 audit
// instruction: check whether a disclosed residual is itself accurate).
// ─────────────────────────────────────────────────────────────────────────────

/** @pins F-21dc98e0 */
test('F-21dc98e0: the Tier-2 disclosure names the TRUE worst case (zero test registration), not merely a trivial-but-executing assertion', async (t) => {
  const fx = makeFixture(t);
  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });
  const tier2Gap = result.disclosedGaps[0];
  assert.match(tier2Gap, /empty describe\(\)/i, 'the disclosure must name the empty-describe() shape explicitly');
  assert.match(tier2Gap, /\.skip\(\)/, 'the disclosure must name the .skip()-ed shape explicitly');
  assert.match(tier2Gap, /zero test registration/i, 'the disclosure must state the TRUE floor (zero test registration), not stop at "assert.ok(true)"');
});

/**
 * Companion behavioral proof (not a NEW mechanism — pin-declarations.mjs's
 * own test suite already documents describe()/`.skip()` as designed-
 * qualifying shapes; this test exists so F-21dc98e0's disclosure fix has
 * real, current-behavior evidence backing its claim, not just updated
 * prose). Mirrors the finding's own three verified reproductions.
 */
test('F-21dc98e0: verifies the disclosed floor against real scanFileForDeclaredPins behavior — empty describe(), all-.skip() children, and a direct .skip() all credit with zero issues', async () => {
  const { scanFileForDeclaredPins } = await import('./pin-declarations.mjs');

  const emptyDescribe = scanFileForDeclaredPins('x.test.js', "/** @pins F-100000-091 */\ndescribe('placeholder suite, no children at all', () => {});\n");
  assert.equal(emptyDescribe.issues.length, 0);
  assert.deepEqual(emptyDescribe.pins.map((p) => p.id), ['F-100000-091']);

  const allSkippedChildren = scanFileForDeclaredPins(
    'x.test.js',
    "/** @pins F-100000-092 */\ndescribe('all children skipped', () => { test.skip('a', () => {}); it.skip('b', () => {}); });\n",
  );
  assert.equal(allSkippedChildren.issues.length, 0);
  assert.deepEqual(allSkippedChildren.pins.map((p) => p.id), ['F-100000-092']);

  const directSkip = scanFileForDeclaredPins('x.test.js', "/** @pins F-100000-093 */\ntest.skip('this test never executes', () => { assert.ok(true); });\n");
  assert.equal(directSkip.issues.length, 0);
  assert.deepEqual(directSkip.pins.map((p) => p.id), ['F-100000-093']);
});

test('orphan from one file does not mask a clean id elsewhere', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/a/index.js', '// F-600000-001\n');
  fx.write('packages/a/index.test.js', "/** @pins F-600000-001 */\ntest('a', () => { assert.ok(true); });\n");
  fx.write('packages/b/index.js', '// F-600000-002 — nothing covers this one\n');
  fx.write('packages/b/index.test.js', "test('unrelated', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.orphans, ['F-600000-002']);
  assert.deepEqual(result.declaredIds, ['F-600000-001']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocking on parse errors and tag issues (C7 / C3) — both fail the gate
// even with zero orphans, matching finding 18's "provably-exact blocks"
// ─────────────────────────────────────────────────────────────────────────────

test('C7: an unparseable test file blocks the gate even when every source pin would otherwise resolve', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-700000-001\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-700000-001 */\ntest('a', () => { assert.ok(true); });\n");
  fx.write('packages/foo/broken.test.js', 'function( { [ ] } (');

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.ok, false, 'an unparseable test file must block, per C7 — never a silent skip');
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0].file.endsWith('broken.test.js'), true);
});

test('C3: a malformed @pins tag (bad-shape) blocks the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-800000-001\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-800000-001 */\ntest('a', () => { assert.ok(true); });\n/** @pins NOT-AN-ID */\ntest('b', () => {});\n");

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.ok, false, 'a malformed tag anywhere in the scanned tree must block, even though F-800000-001 itself resolves cleanly');
  assert.equal(result.tagIssues.some((i) => i.kind === 'bad-shape'), true);
});

test('C3: a dangling-id tag (well-formed, correctly attached, but matches no source pin) blocks the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.test.js', "/** @pins F-900000-999 */\ntest('a', () => { assert.ok(true); });\n");
  // No source pin anywhere for F-900000-999.

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.ok, false);
  assert.equal(result.tagIssues.some((i) => i.kind === 'dangling-id' && i.token === 'F-900000-999'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyCoverage — pure-function bucketing
// ─────────────────────────────────────────────────────────────────────────────

test('classifyCoverage: precedence is declared > allowlisted > grandfathered > orphan', () => {
  const declared = { byId: new Map([['F-1', [{ id: 'F-1', file: 'a.test.js', line: 1, title: 't' }]]]) };
  const allowlist = { allow: { 'F-2': allowEntry('cross-ref', 'x.js') } };
  // F-W19-CI-001: grandfather status is FROZEN-MANIFEST membership only —
  // F-3 is a member (so it grandfathers with zero text/file evidence needed
  // at all), F-4 is not (so it orphans even though nothing else about it
  // differs from F-3).
  const grandfatherManifest = { grandfathered: { 'F-3': grandfatherEntry() } };
  const out = classifyCoverage({
    sourceIds: ['F-1', 'F-2', 'F-3', 'F-4'],
    declared,
    allowlist,
    grandfatherManifest,
  });
  assert.deepEqual(out.declaredIds, ['F-1']);
  assert.deepEqual(out.allowlistApplied, ['F-2']);
  assert.deepEqual(out.grandfatheredIds, ['F-3']);
  assert.deepEqual(out.orphans, ['F-4']);
});

test('classifyCoverage: omitting grandfatherManifest defaults to empty (no ambient frozen-list dependency for callers who don\'t care)', () => {
  const declared = { byId: new Map() };
  const allowlist = { allow: {} };
  const out = classifyCoverage({ sourceIds: ['F-5'], declared, allowlist });
  assert.deepEqual(out.orphans, ['F-5']);
  assert.deepEqual(out.grandfatheredIds, []);
});

test('classifyCoverage: dangling-id tags are reported once per occurrence, with file/line', () => {
  const declared = {
    byId: new Map([
      ['F-9', [{ id: 'F-9', file: 'a.test.js', line: 3, title: null }, { id: 'F-9', file: 'b.test.js', line: 7, title: null }]],
    ]),
  };
  const out = classifyCoverage({ sourceIds: [], declared, allowlist: { allow: {} } });
  assert.equal(out.danglingIdTags.length, 2);
  assert.deepEqual(out.danglingIdTags.map((d) => d.file).sort(), ['a.test.js', 'b.test.js']);
  assert.ok(out.danglingIdTags.every((d) => d.kind === 'dangling-id'));
});

// ─────────────────────────────────────────────────────────────────────────────
// applyGrandfatherManifest — the pure partition function (F-W19-CI-001)
// ─────────────────────────────────────────────────────────────────────────────

test('applyGrandfatherManifest: partitions by membership only, no file reads', () => {
  const manifest = { grandfathered: { 'F-100000-010': grandfatherEntry(), 'F-100000-011': grandfatherEntry() } };
  const out = applyGrandfatherManifest(['F-100000-010', 'F-100000-011', 'F-100000-012'], manifest);
  assert.deepEqual(out.grandfathered, ['F-100000-010', 'F-100000-011']);
  assert.deepEqual(out.orphans, ['F-100000-012']);
});

test('applyGrandfatherManifest: empty manifest orphans everything', () => {
  const out = applyGrandfatherManifest(['F-100000-020'], { grandfathered: {} });
  assert.deepEqual(out.grandfathered, []);
  assert.deepEqual(out.orphans, ['F-100000-020']);
});

test('applyGrandfatherManifest: empty candidate list produces empty buckets even against a non-empty manifest', () => {
  const out = applyGrandfatherManifest([], { grandfathered: { 'F-100000-030': grandfatherEntry() } });
  assert.deepEqual(out.grandfathered, []);
  assert.deepEqual(out.orphans, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// loadGrandfatherManifest — the C8 provenance schema (F-W19-CI-001)
// ─────────────────────────────────────────────────────────────────────────────

test('loadGrandfatherManifest: missing file returns empty grandfathered map', () => {
  const empty = loadGrandfatherManifest(join(tmpdir(), `does-not-exist-${Date.now()}.json`));
  assert.deepEqual(empty, { grandfathered: {} });
});

test('loadGrandfatherManifest: malformed JSON throws a helpful error', (t) => {
  const fx = makeFixture(t);
  fx.write('bad.json', '{ not valid json');
  assert.throws(() => loadGrandfatherManifest(join(fx.dir, 'bad.json')), /not valid JSON/);
});

test('loadGrandfatherManifest: missing "grandfathered" field throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-key.json', JSON.stringify({ description: 'I forgot the grandfathered key' }));
  assert.throws(() => loadGrandfatherManifest(join(fx.dir, 'no-key.json')), /missing required "grandfathered" field/);
});

test('loadGrandfatherManifest: entry without owner throws (C8 — every frozen entry needs a named owner)', (t) => {
  const fx = makeFixture(t);
  fx.write('no-owner.json', JSON.stringify({ grandfathered: { 'F-100000-001': { revalidate_by: '2099-01-01' } } }));
  assert.throws(() => loadGrandfatherManifest(join(fx.dir, 'no-owner.json')), /missing "owner"/);
});

test('loadGrandfatherManifest: entry without revalidate_by throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-date.json', JSON.stringify({ grandfathered: { 'F-100000-001': { owner: 'a' } } }));
  assert.throws(() => loadGrandfatherManifest(join(fx.dir, 'no-date.json')), /revalidate_by/);
});

test('loadGrandfatherManifest: malformed revalidate_by (not YYYY-MM-DD) throws', (t) => {
  const fx = makeFixture(t);
  fx.write('bad-date.json', JSON.stringify({ grandfathered: { 'F-100000-001': { owner: 'a', revalidate_by: 'next tuesday' } } }));
  assert.throws(() => loadGrandfatherManifest(join(fx.dir, 'bad-date.json')), /revalidate_by/);
});

test('loadGrandfatherManifest: a well-formed manifest loads cleanly', (t) => {
  const fx = makeFixture(t);
  const path = fx.writeGrandfatherManifest({ grandfathered: { 'F-100000-001': grandfatherEntry('coordinator', '2026-10-14') } });
  const loaded = loadGrandfatherManifest(path);
  assert.deepEqual(loaded.grandfathered, { 'F-100000-001': { owner: 'coordinator', revalidate_by: '2026-10-14' } });
});

test('the real repo grandfathered-pins.json loads cleanly under the same C8 validation', () => {
  const manifestPath = resolve(repoRoot, 'scripts/grandfathered-pins.json');
  const loaded = loadGrandfatherManifest(manifestPath);
  assert.ok(Object.keys(loaded.grandfathered).length > 0, 'expected the real frozen manifest to carry at least one entry');
  assert.equal(loaded.frozen_at_commit, '132dc18');
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAllowlist / applyAllowlist — the C8 provenance schema
// ─────────────────────────────────────────────────────────────────────────────

test('loadAllowlist: missing file returns empty allow', () => {
  const empty = loadAllowlist(join(tmpdir(), `does-not-exist-${Date.now()}.json`));
  assert.deepEqual(empty, { allow: {} });
});

test('loadAllowlist: malformed JSON throws a helpful error', (t) => {
  const fx = makeFixture(t);
  fx.write('bad.json', '{ not valid json');
  assert.throws(() => loadAllowlist(join(fx.dir, 'bad.json')), /not valid JSON/);
});

test('loadAllowlist: missing "allow" field throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-allow.json', JSON.stringify({ description: 'I forgot the allow key' }));
  assert.throws(() => loadAllowlist(join(fx.dir, 'no-allow.json')), /missing required "allow" field/);
});

test('loadAllowlist: entry without reason throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-reason.json', JSON.stringify({ allow: { 'F-100000-001': { file: 'x.js', owner: 'a', revalidate_by: '2099-01-01' } } }));
  assert.throws(() => loadAllowlist(join(fx.dir, 'no-reason.json')), /missing "reason"/);
});

test('C8: entry without owner throws (every override needs a named owner)', (t) => {
  const fx = makeFixture(t);
  fx.write('no-owner.json', JSON.stringify({ allow: { 'F-100000-001': { reason: 'ok', file: 'x.js', revalidate_by: '2099-01-01' } } }));
  assert.throws(() => loadAllowlist(join(fx.dir, 'no-owner.json')), /missing "owner"/);
});

test('C8: entry without revalidate_by throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-date.json', JSON.stringify({ allow: { 'F-100000-001': { reason: 'ok', file: 'x.js', owner: 'a' } } }));
  assert.throws(() => loadAllowlist(join(fx.dir, 'no-date.json')), /revalidate_by/);
});

test('C8: malformed revalidate_by (not YYYY-MM-DD) throws', (t) => {
  const fx = makeFixture(t);
  fx.write('bad-date.json', JSON.stringify({ allow: { 'F-100000-001': { reason: 'ok', file: 'x.js', owner: 'a', revalidate_by: 'next tuesday' } } }));
  assert.throws(() => loadAllowlist(join(fx.dir, 'bad-date.json')), /revalidate_by/);
});

test('applyAllowlist: pure function over a candidate id array', () => {
  const allowlist = { allow: { 'F-100000-001': allowEntry('ok', '/x/a.js') } };
  const out = applyAllowlist(['F-100000-001', 'F-200000-002'], allowlist);
  assert.deepEqual(out.remaining, ['F-200000-002']);
  assert.deepEqual(out.applied, ['F-100000-001']);
  assert.deepEqual(out.unused, []);
});

test('applyAllowlist: an allowlist entry whose id is not among the candidates is unused', () => {
  const allowlist = { allow: { 'F-999999-999': allowEntry('stale', '/x/a.js') } };
  const out = applyAllowlist(['F-100000-001'], allowlist);
  assert.deepEqual(out.remaining, ['F-100000-001']);
  assert.deepEqual(out.unused, ['F-999999-999']);
});

test('dueForRevalidation: an allowlist entry with a past revalidate_by is reported, but still applied (advisory, not blocking — finding 21)', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-050 — cross-ref\n');
  const allowlistPath = fx.writeAllowlist({
    allow: { 'F-100000-050': { reason: 'cross-ref', file: 'packages/foo/index.js', owner: 'someone', revalidate_by: '2000-01-01' } },
  });

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath,
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.ok, true, 'a stale-but-still-applied entry must not block');
  assert.deepEqual(result.allowlistApplied, ['F-100000-050']);
  assert.equal(result.dueForRevalidation.length, 1);
  assert.equal(result.dueForRevalidation[0].id, 'F-100000-050');
  assert.equal(result.dueForRevalidation[0].owner, 'someone');
});

test('grandfatherDueForRevalidation: a frozen entry with a past revalidate_by is reported, but still exempt (advisory, not blocking — finding 21)', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-051 — pre-existing pin\n');
  const grandfatherManifestPath = fx.writeGrandfatherManifest({
    grandfathered: { 'F-100000-051': { owner: 'someone', revalidate_by: '2000-01-01' } },
  });

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath,
  });

  assert.equal(result.ok, true, 'a stale-but-still-frozen entry must not block');
  assert.deepEqual(result.grandfatheredIds, ['F-100000-051']);
  assert.equal(result.grandfatherDueForRevalidation.length, 1);
  assert.equal(result.grandfatherDueForRevalidation[0].id, 'F-100000-051');
  assert.equal(result.grandfatherDueForRevalidation[0].owner, 'someone');
});

// ─────────────────────────────────────────────────────────────────────────────
// --write-index flag
// ─────────────────────────────────────────────────────────────────────────────

test('--write-index path: writes JSON with the declared/grandfathered/orphan summary', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-500000-001\n// F-500000-002 — pre-existing, still undeclared\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-500000-001 */\ntest('a', () => { assert.ok(true); });\n");
  const indexPath = 'docs/regression-pin-index.json';

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest({ grandfathered: { 'F-500000-002': grandfatherEntry() } }),
    writeIndexPath: indexPath,
  });

  assert.equal(result.ok, true);
  assert.ok(result.indexWritten);
  assert.ok(existsSync(result.indexWritten));
  const contents = JSON.parse(readFileSync(result.indexWritten, 'utf-8'));
  assert.ok(contents.source_pins['F-500000-001']);
  assert.equal(contents.summary.declared_ids, 1);
  assert.deepEqual(contents.summary.orphan_source_ids, []);
  assert.deepEqual(contents.summary.grandfathered_ids, ['F-500000-002']);
  assert.equal(contents.summary.grandfathered_frozen_total, 1);
  assert.equal(contents.summary.grandfathered_drained_count, 0, 'F-500000-002 still has no declared tag or allowlist entry — nothing has drained yet');
});

test('without --write-index: no index file is written and indexWritten is null', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-600000-001\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-600000-001 */\ntest('a', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });

  assert.equal(result.indexWritten, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatHuman — sanity-check the user-facing output
// ─────────────────────────────────────────────────────────────────────────────

test('formatHuman: includes orphan list, disclosed gaps, and "How to fix" when there are orphans', () => {
  const result = {
    ok: false,
    json: {
      source_pins: { 'F-700000-001': ['/repo/packages/foo/index.js'] },
      files_scanned: 1,
      summary: { source_ids: 1, test_ids: 0 },
    },
    orphans: ['F-700000-001'],
    declaredIds: [],
    grandfatheredIds: [],
    allowlistApplied: [],
    unusedAllowEntries: [],
    unusedAllowEntryReasons: {},
    dueForRevalidation: [],
    parseErrors: [],
    tagIssues: [],
    disclosedGaps: ['gap one', 'gap two'],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /FAIL/);
  assert.match(text, /F-700000-001/);
  assert.match(text, /How to fix/);
  assert.match(text, /gap one/);
});

test('formatHuman: a clean result with NO grandfather debt claims the invariant holds', () => {
  const result = {
    ok: true,
    json: { source_pins: {}, files_scanned: 0, summary: { source_ids: 0, test_ids: 0 } },
    orphans: [],
    declaredIds: ['F-1'],
    grandfatheredIds: [],
    grandfatherFrozenTotal: 0,
    grandfatherDrainedCount: 0,
    grandfatherDueForRevalidation: [],
    allowlistApplied: [],
    unusedAllowEntries: [],
    unusedAllowEntryReasons: {},
    dueForRevalidation: [],
    parseErrors: [],
    tagIssues: [],
    disclosedGaps: [],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /OK/);
  assert.match(text, /Class #14 invariant holds/);
});

/**
 * F-W19-CI-001: the finding's own required reword — "reword the OK line so
 * it does not say the invariant 'holds' when the majority of coverage is
 * admittedly unverified... with no unqualified 'invariant holds' claim
 * until the grandfathered count reaches zero." This is the test that would
 * have failed against the PRE-fix wording, which claimed the invariant
 * "holds" unconditionally even with outstanding grandfathered debt.
 */
test('formatHuman: a clean result WITH outstanding grandfather debt reports counts, never claims the unqualified invariant holds', () => {
  const result = {
    ok: true,
    json: { source_pins: {}, files_scanned: 0, summary: { source_ids: 0, test_ids: 0 } },
    orphans: [],
    declaredIds: ['F-1'],
    grandfatheredIds: ['F-2'],
    grandfatherFrozenTotal: 256,
    grandfatherDrainedCount: 30,
    grandfatherDueForRevalidation: [],
    allowlistApplied: ['F-3'],
    unusedAllowEntries: [],
    unusedAllowEntryReasons: {},
    dueForRevalidation: [],
    parseErrors: [],
    tagIssues: [],
    disclosedGaps: [],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /OK/);
  assert.doesNotMatch(text, /Class #14 invariant holds/, 'must not claim the unqualified invariant while grandfathered debt is outstanding');
  assert.match(text, /gate is green/);
  assert.match(text, /1 declared-verified/);
  assert.match(text, /1 grandfathered-unverified/);
  assert.match(text, /1 allowlisted/);
  assert.match(text, /0 orphans/);
  assert.match(text, /grandfathered \(frozen manifest @ commit 132dc18/);
  assert.match(text, /1 of 256 frozen id\(s\) still outstanding/);
  assert.match(text, /30 drained/);
  assert.match(text, /F-2/);
});

test('formatHuman: grandfatherDueForRevalidation entries produce a distinct WARN block from allowlist dueForRevalidation', () => {
  const result = {
    ok: true,
    json: { source_pins: {}, files_scanned: 0, summary: { source_ids: 0, test_ids: 0 } },
    orphans: [],
    declaredIds: [],
    grandfatheredIds: ['F-9'],
    grandfatherFrozenTotal: 1,
    grandfatherDrainedCount: 0,
    grandfatherDueForRevalidation: [{ id: 'F-9', revalidate_by: '2000-01-01', owner: 'coordinator' }],
    allowlistApplied: [],
    unusedAllowEntries: [],
    unusedAllowEntryReasons: {},
    dueForRevalidation: [],
    parseErrors: [],
    tagIssues: [],
    disclosedGaps: [],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /WARN — grandfathered entries past their revalidate_by date/);
  assert.match(text, /F-9 — was due 2000-01-01 \(owner: coordinator\)/);
});

test('formatHuman: FAIL section lists parseErrors and tagIssues distinctly from orphans', () => {
  const result = {
    ok: false,
    json: { source_pins: {}, files_scanned: 2, summary: { source_ids: 0, test_ids: 0 } },
    orphans: [],
    declaredIds: [],
    grandfatheredIds: [],
    allowlistApplied: [],
    unusedAllowEntries: [],
    unusedAllowEntryReasons: {},
    dueForRevalidation: [],
    parseErrors: [{ file: '/repo/broken.test.js', line: 3, column: 1, message: 'Unexpected token' }],
    tagIssues: [{ file: '/repo/a.test.js', line: 2, kind: 'bad-shape', token: 'X', detail: 'not well-formed' }],
    disclosedGaps: [],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /could not be parsed/);
  assert.match(text, /broken\.test\.js/);
  assert.match(text, /malformed\/dangling/);
  assert.match(text, /bad-shape/);
});

// ─────────────────────────────────────────────────────────────────────────────
// F-3ec5b54f / F-5eafee44 META — non-vacuity across ID format and file
// extension. These pin the CORRECT gate behavior for every id shape this
// repo mints (hash F-xxxxxxxx, prefixed F-AAA-NNN, workflow-YAML source
// pins) against parse-regression-pins.js's ALREADY-WIDENED F_ID_PATTERN /
// DEFAULT_SOURCE_EXTENSIONS (packages/portfolio — backend domain, out of
// scope here). This gate's rewrite did not touch source-side pin
// extraction, so the underlying behavior these tests pin is unchanged by
// wave 18 — an id with zero test-side evidence of any kind must still
// orphan, regardless of which id-format vehicle carries the pin.
// ─────────────────────────────────────────────────────────────────────────────

test('F-3ec5b54f META: a HASH-style source pin (F-xxxxxxxx) with no coverage still fails the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-42e57a77 — defer the red run past the commit step\n');
  // F-W19-CI-001: F-42e57a77 is a REAL id in the live repo's frozen
  // manifest (grandfathered at 132dc18) — this fixture's whole point is
  // that a FRESH tree with genuinely zero coverage must orphan, so it must
  // explicitly use an EMPTY grandfather manifest or it would silently
  // inherit the real one via the default path and this test would assert
  // the wrong thing (this is the exact cross-contamination the module
  // docstring above warns about, caught for real while writing this fix).
  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });
  assert.equal(result.json.summary.source_ids, 1, 'hash-style id must be visible as a source pin (F_ID_PATTERN already widened)');
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphans, ['F-42e57a77']);
});

test('F-3ec5b54f META: a PREFIXED-style source pin (F-AAA-NNN) with no coverage still fails the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-W1-CI-999 — orphaned prefixed-format pin for this test\n');
  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphans, ['F-W1-CI-999']);
});

test('F-5eafee44 META: a workflow YAML source pin with no coverage still fails the gate (.yml is scanned)', async (t) => {
  const fx = makeFixture(t);
  fx.write('.github/workflows/example.yml', '# F-999999-002 — a fix pinned in a workflow file, no test coverage\n');
  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    grandfatherManifestPath: fx.writeGrandfatherManifest(EMPTY_GRANDFATHER),
  });
  assert.equal(result.json.files_scanned, 1, '.github/workflows/*.yml must be scanned');
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphans, ['F-999999-002']);
});

/**
 * @pins F-d31dfc55, F-ef512e21
 *
 * These two of the twelve ids below have NO other test-side evidence
 * anywhere in the repo (verified via the live gate: dropping this tag
 * orphans exactly these two, wave 18) — this loop genuinely IS their sole
 * regression coverage, so it earns a real declared tag rather than relying
 * on the (now demoted, and in this exact array+loop shape never structurally
 * credited in the first place — see below) legacy heuristic. The other ten
 * ids in the loop have independent coverage elsewhere and don't need this
 * tag to stay resolved, but including only the two that need it keeps this
 * tag's claim precise rather than padded.
 */
test('F-5eafee44: the workflow-pinned F-ids named in the finding are still present in .github/workflows/*.yml (guards the claim, not the gate)', () => {
  // F-f0339e12 (wave-8 coordinator disposition): an array-collected id list
  // consumed by a shared assert (this loop) is the exact "arrange-then-
  // assert" shape the structural filter's own docstring names as a blind
  // spot — a prior wave unrolled this into one assert-per-id specifically so
  // the legacy heuristic could still see each id as structurally credited.
  // This wave's rewrite re-rolled it back into a loop for brevity WITHOUT
  // remembering why it had been unrolled, which silently orphaned
  // F-d31dfc55/F-ef512e21 the moment the old per-id asserts were replaced —
  // caught by this file's own live-tree test before it ever reached a
  // confirming audit. Fixed here with a real declared tag (the mechanism
  // this whole wave exists to establish) rather than re-unrolling, since a
  // declared tag makes the loop shape irrelevant to credit either way.
  const workflowsDir = resolve(repoRoot, '.github/workflows');
  const text = readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => readFileSync(resolve(workflowsDir, f), 'utf-8'))
    .join('\n');

  for (const id of ['F-362d4131', 'F-42e57a77', 'F-50558cb2', 'F-60f0c4f5', 'F-68818085', 'F-a52776d5', 'F-bc123f41', 'F-caeeacc3', 'F-d31dfc55', 'F-e4a24655', 'F-ef512e21', 'F-f05363e2']) {
    assert.ok(text.includes(id), `${id} must stay pinned somewhere in .github/workflows/*.yml (F-5eafee44 claim)`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Live-tree assertion — the load-bearing test. If this fails, the gate
// itself (not a fixture) is red against the real repo.
// ─────────────────────────────────────────────────────────────────────────────

test('live testing-os tree passes the regression-pin gate', async () => {
  const result = await runRegressionPinGate({ repoRoot });
  if (!result.ok) {
    const orphanDetail = result.orphans
      .map((id) => `  ${id}\n    ${(result.json.source_pins[id] ?? []).join('\n    ')}`)
      .join('\n');
    const parseErrorDetail = result.parseErrors.map((e) => `  ${e.file}:${e.line ?? '?'} — ${e.message}`).join('\n');
    const tagIssueDetail = result.tagIssues.map((i) => `  ${i.file}:${i.line ?? '?'} [${i.kind}] ${i.detail}`).join('\n');
    assert.fail(
      `regression-pin gate FAIL on live tree:\n` +
      `orphans (${result.orphans.length}):\n${orphanDetail}\n` +
      `parseErrors (${result.parseErrors.length}):\n${parseErrorDetail}\n` +
      `tagIssues (${result.tagIssues.length}):\n${tagIssueDetail}\n\n` +
      `Fix: add a declared /** @pins F-id */ tag (preferred), an allowlist entry, or resolve the parse/tag defect.`,
    );
  }
  assert.equal(result.ok, true);
});

test('live tree sanity: scanRepoForDeclaredPins runs cleanly (zero parse errors) over the real corpus', () => {
  const declared = scanRepoForDeclaredPins(repoRoot);
  assert.deepEqual(declared.parseErrors, [], 'every real test file must parse under @babel/parser (C7)');
});

/**
 * F-W19-CI-001: the frozen manifest is a SNAPSHOT, not a live computation —
 * this test pins that scripts/grandfathered-pins.json continues to load
 * validly and stays internally consistent with the live gate's own
 * accounting (every currently-grandfathered id must be a member of the
 * frozen set; the frozen total must never silently drift out of sync with
 * what the file on disk actually contains). It does NOT assert an exact
 * grandfathered COUNT, deliberately — that count is expected to shrink over
 * future waves as domains land declared tags, and a brittle exact-count
 * assertion here would force an unrelated edit to this test on every such
 * migration. What must stay true regardless of how much has drained: the
 * live outstanding count can never exceed the frozen total, and the frozen
 * total itself is fixed at exactly what commit 132dc18 produced (256, per
 * that commit's own message and the module docstring's worked example).
 */
test('live tree: the frozen grandfather manifest stays internally consistent with the live gate accounting', async () => {
  const manifestPath = resolve(repoRoot, 'scripts/grandfathered-pins.json');
  const manifest = loadGrandfatherManifest(manifestPath);
  assert.equal(Object.keys(manifest.grandfathered).length, 256, 'the frozen manifest is a fixed snapshot — its own SIZE must never change (only how much of it is still live-outstanding does)');

  const result = await runRegressionPinGate({ repoRoot });
  assert.equal(result.grandfatherFrozenTotal, 256);
  assert.ok(result.grandfatheredIds.length <= result.grandfatherFrozenTotal, 'live-outstanding grandfathered count can never exceed the frozen total');
  assert.ok(result.grandfatheredIds.every((id) => id in manifest.grandfathered), 'every id the live gate reports as grandfathered must be a member of the frozen manifest — no live path in');
  assert.equal(result.grandfatherFrozenTotal - result.grandfatheredIds.length, result.grandfatherDrainedCount, 'drained count must reconcile exactly with frozen total minus live-outstanding');
});

// ─────────────────────────────────────────────────────────────────────────────
// F-W1-CI-006 — ESM main-entry guard (unchanged idiom, preserved verbatim)
// ─────────────────────────────────────────────────────────────────────────────

test('F-W1-CI-006: main-entry guard uses pathToFileURL(process.argv[1]).href === import.meta.url, not a file://+endsWith fallback', () => {
  const src = readFileSync(resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs'), 'utf8');
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const guardLine = stripped.split(/\r?\n/).find((l) => /^\s*const isMain\s*=/.test(l));
  assert.ok(guardLine, 'expected a `const isMain = ...` line in check-finding-regression-pins.mjs — pin is stale');
  assert.match(guardLine, /process\.argv\[1\]\s*&&/, 'main-entry guard must short-circuit on `process.argv[1] &&`');
  assert.match(
    guardLine,
    /pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href\s*===\s*import\.meta\.url/,
    'main-entry guard must compare pathToFileURL(process.argv[1]).href against import.meta.url (F-W1-CI-006)',
  );
  assert.doesNotMatch(guardLine, /endsWith|`file:\/\/\$\{/, 'main-entry guard must not revert to the file://${process.argv[1]} + endsWith fallback (F-W1-CI-006)');
});

test('F-W1-CI-006: --help invokes the main-entry block, prints Usage, exits 0', () => {
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const result = spawnSync(process.execPath, [targetScript, '--help'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `--help must exit 0.\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`);
  assert.match(result.stdout, /Usage:/, '--help must print the Usage block, proving isMain fired');
});

test('F-c59bb518: --help describes the F_ID_PATTERN contract (legacy + hash-style), not just the legacy F-NNNNNN-NNN shape', () => {
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const result = spawnSync(process.execPath, [targetScript, '--help'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /F-NNNNNN-NNN/, '--help must still mention the legacy id shape');
  assert.match(result.stdout, /F-xxxxxxxx/, '--help must also mention the hash-style id shape');
  assert.match(result.stdout, /F_ID_PATTERN/, '--help should point at F_ID_PATTERN by name so the description cannot independently go stale');
});

test('CLI: --json prints the new bucket fields (declared_ids, grandfathered_ids, tag_issues, disclosed_gaps)', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-060\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-100000-060 */\ntest('a', () => { assert.ok(true); });\n");
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const allowlistPath = fx.writeAllowlist({ allow: {} });
  const grandfatherManifestPath = fx.writeGrandfatherManifest(EMPTY_GRANDFATHER);

  const result = spawnSync(
    process.execPath,
    [targetScript, '--json', '--root', fx.dir, '--allowlist', allowlistPath, '--grandfather-manifest', grandfatherManifestPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.declared_ids, ['F-100000-060']);
  assert.ok(Array.isArray(parsed.grandfathered_ids));
  assert.equal(parsed.grandfathered_frozen_total, 0);
  assert.equal(parsed.grandfathered_drained_count, 0);
  assert.ok(Array.isArray(parsed.grandfathered_due_for_revalidation));
  assert.ok(Array.isArray(parsed.tag_issues));
  assert.ok(Array.isArray(parsed.disclosed_gaps) && parsed.disclosed_gaps.length > 0);
});

test('CLI: --grandfather-manifest wires a populated frozen manifest end-to-end (exempts an id that would otherwise orphan)', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-065 — pre-existing pin\n');
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const allowlistPath = fx.writeAllowlist({ allow: {} });
  const grandfatherManifestPath = fx.writeGrandfatherManifest({ grandfathered: { 'F-100000-065': { owner: 'coordinator', revalidate_by: '2099-01-01' } } });

  const result = spawnSync(
    process.execPath,
    [targetScript, '--json', '--root', fx.dir, '--allowlist', allowlistPath, '--grandfather-manifest', grandfatherManifestPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.grandfathered_ids, ['F-100000-065']);
  assert.equal(parsed.grandfathered_frozen_total, 1);
});

test('CLI: exits 1 (not 0, not 2) on a real orphan', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-070 — nothing covers this\n');
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const result = spawnSync(
    process.execPath,
    [targetScript, '--root', fx.dir, '--allowlist', fx.writeAllowlist({ allow: {} }), '--grandfather-manifest', fx.writeGrandfatherManifest(EMPTY_GRANDFATHER)],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
});
