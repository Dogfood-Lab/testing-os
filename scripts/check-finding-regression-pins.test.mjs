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
 *   2. classifyCoverage — pure-function bucketing (declared > allowlist >
 *      grandfather > orphan precedence)
 *   3. Blocking conditions — parse errors and malformed/dangling tags both
 *      fail the gate even when zero orphans exist
 *   4. loadAllowlist / applyAllowlist — the C8 provenance schema (reason +
 *      owner + revalidate_by, all required) and dueForRevalidation
 *   5. --write-index, formatHuman, CLI --help/--json
 *   6. F-3ec5b54f / F-5eafee44 META — id-shape/extension non-vacuity
 *      (unchanged: this gate still consumes the same parse-regression-pins.js
 *      for source-side pins)
 *   7. Live-tree assertion — the load-bearing test
 *   8. F-W1-CI-006 / F-c59bb518 — main-entry guard and --help contract
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
  };
}

function allowEntry(reason, file) {
  return { reason, file, owner: 'test-fixture', revalidate_by: '2099-01-01' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Declared-tag coverage — the Tier-1 mechanism, end to end through the CLI
// ─────────────────────────────────────────────────────────────────────────────

test('clean tree: a declared @pins tag resolves the source pin → ok=true', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-001 — defensive guard\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-100000-001 */\ntest('guard holds', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, true, `expected ok=true; orphans=${JSON.stringify(result.orphans)} tagIssues=${JSON.stringify(result.tagIssues)}`);
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.declaredIds, ['F-100000-001']);
  assert.equal(result.json.summary.source_ids, 1);
});

test('orphan: a source pin with no declared tag, no allowlist entry, no legacy signal → ok=false', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-200000-001 — a fix with genuinely nothing pointing at it\n');
  fx.write('packages/foo/index.test.js', "test('unrelated', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, false);
  assert.deepEqual(result.orphans, ['F-200000-001']);
});

test('grandfather: a source pin with no declared tag but a legacy structural hit is EXEMPT (ok=true) yet DISCLOSED, not silently equivalent to declared', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-300000-001 — a fix\n');
  fx.write('packages/foo/index.test.js', "describe('guard (F-300000-001)', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, true, 'a legacy-only hit must not block — this is what makes the rewrite safe to land');
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.grandfatheredIds, ['F-300000-001']);
  assert.deepEqual(result.declaredIds, [], 'a legacy hit is NOT a declared tag — never silently promoted to Tier-1 verified');
});

test('declared beats grandfather: an id with BOTH a declared tag and legacy-shaped text is reported as declared, not grandfathered', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-400000-001 — a fix\n');
  fx.write(
    'packages/foo/index.test.js',
    "/** @pins F-400000-001 */\ndescribe('guard (F-400000-001)', () => { assert.ok(true); });\n",
  );

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, true);
  assert.deepEqual(result.declaredIds, ['F-400000-001']);
  assert.deepEqual(result.grandfatheredIds, []);
});

test('allowlist beats grandfather: an allowlisted id is reported as allowlisted even if it also has legacy-shaped text elsewhere', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-500000-001 — cross-reference, not a fix pin\n');
  fx.write('packages/foo/index.test.js', "describe('mentions (F-500000-001)', () => { assert.ok(true); });\n");
  const allowlistPath = fx.writeAllowlist({ allow: { 'F-500000-001': allowEntry('cross-reference, not a real pin', 'packages/foo/index.js') } });

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath });

  assert.equal(result.ok, true);
  assert.deepEqual(result.allowlistApplied, ['F-500000-001']);
  assert.deepEqual(result.grandfatheredIds, []);
});

test('orphan from one file does not mask a clean id elsewhere', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/a/index.js', '// F-600000-001\n');
  fx.write('packages/a/index.test.js', "/** @pins F-600000-001 */\ntest('a', () => { assert.ok(true); });\n");
  fx.write('packages/b/index.js', '// F-600000-002 — nothing covers this one\n');
  fx.write('packages/b/index.test.js', "test('unrelated', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

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

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, false, 'an unparseable test file must block, per C7 — never a silent skip');
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0].file.endsWith('broken.test.js'), true);
});

test('C3: a malformed @pins tag (bad-shape) blocks the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-800000-001\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-800000-001 */\ntest('a', () => { assert.ok(true); });\n/** @pins NOT-AN-ID */\ntest('b', () => {});\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, false, 'a malformed tag anywhere in the scanned tree must block, even though F-800000-001 itself resolves cleanly');
  assert.equal(result.tagIssues.some((i) => i.kind === 'bad-shape'), true);
});

test('C3: a dangling-id tag (well-formed, correctly attached, but matches no source pin) blocks the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.test.js', "/** @pins F-900000-999 */\ntest('a', () => { assert.ok(true); });\n");
  // No source pin anywhere for F-900000-999.

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, false);
  assert.equal(result.tagIssues.some((i) => i.kind === 'dangling-id' && i.token === 'F-900000-999'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyCoverage — pure-function bucketing
// ─────────────────────────────────────────────────────────────────────────────

test('classifyCoverage: precedence is declared > allowlisted > grandfathered > orphan', () => {
  const declared = { byId: new Map([['F-1', [{ id: 'F-1', file: 'a.test.js', line: 1, title: 't' }]]]) };
  const allowlist = { allow: { 'F-2': allowEntry('cross-ref', 'x.js') } };
  const testPinsIndex = {
    'F-3': ['/repo/x.test.js'],
    'F-4': ['/repo/y.test.js'],
  };
  const out = classifyCoverage({
    sourceIds: ['F-1', 'F-2', 'F-3', 'F-4'],
    declared,
    allowlist,
    testPinsIndex,
  });
  assert.deepEqual(out.declaredIds, ['F-1']);
  assert.deepEqual(out.allowlistApplied, ['F-2']);
  // F-3/F-4 have no readable files backing testPinsIndex (nonexistent paths),
  // so neither can produce a legacy hit — both land as orphans, proving
  // "no evidence of any kind" still blocks even post-rewrite.
  assert.deepEqual(out.orphans, ['F-3', 'F-4']);
  assert.deepEqual(out.grandfatheredIds, []);
});

test('classifyCoverage: dangling-id tags are reported once per occurrence, with file/line', () => {
  const declared = {
    byId: new Map([
      ['F-9', [{ id: 'F-9', file: 'a.test.js', line: 3, title: null }, { id: 'F-9', file: 'b.test.js', line: 7, title: null }]],
    ]),
  };
  const out = classifyCoverage({ sourceIds: [], declared, allowlist: { allow: {} }, testPinsIndex: {} });
  assert.equal(out.danglingIdTags.length, 2);
  assert.deepEqual(out.danglingIdTags.map((d) => d.file).sort(), ['a.test.js', 'b.test.js']);
  assert.ok(out.danglingIdTags.every((d) => d.kind === 'dangling-id'));
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

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath });

  assert.equal(result.ok, true, 'a stale-but-still-applied entry must not block');
  assert.deepEqual(result.allowlistApplied, ['F-100000-050']);
  assert.equal(result.dueForRevalidation.length, 1);
  assert.equal(result.dueForRevalidation[0].id, 'F-100000-050');
  assert.equal(result.dueForRevalidation[0].owner, 'someone');
});

// ─────────────────────────────────────────────────────────────────────────────
// --write-index flag
// ─────────────────────────────────────────────────────────────────────────────

test('--write-index path: writes JSON with the declared/grandfathered/orphan summary', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-500000-001\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-500000-001 */\ntest('a', () => { assert.ok(true); });\n");
  const indexPath = 'docs/regression-pin-index.json';

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    writeIndexPath: indexPath,
  });

  assert.equal(result.ok, true);
  assert.ok(result.indexWritten);
  assert.ok(existsSync(result.indexWritten));
  const contents = JSON.parse(readFileSync(result.indexWritten, 'utf-8'));
  assert.ok(contents.source_pins['F-500000-001']);
  assert.equal(contents.summary.declared_ids, 1);
  assert.deepEqual(contents.summary.orphan_source_ids, []);
});

test('without --write-index: no index file is written and indexWritten is null', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-600000-001\n');
  fx.write('packages/foo/index.test.js', "/** @pins F-600000-001 */\ntest('a', () => { assert.ok(true); });\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

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

test('formatHuman: marks a clean result as OK and mentions the grandfather bucket when non-empty', () => {
  const result = {
    ok: true,
    json: { source_pins: {}, files_scanned: 0, summary: { source_ids: 0, test_ids: 0 } },
    orphans: [],
    declaredIds: ['F-1'],
    grandfatheredIds: ['F-2'],
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
  assert.match(text, /grandfathered/);
  assert.match(text, /F-2/);
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
  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });
  assert.equal(result.json.summary.source_ids, 1, 'hash-style id must be visible as a source pin (F_ID_PATTERN already widened)');
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphans, ['F-42e57a77']);
});

test('F-3ec5b54f META: a PREFIXED-style source pin (F-AAA-NNN) with no coverage still fails the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-W1-CI-999 — orphaned prefixed-format pin for this test\n');
  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.orphans, ['F-W1-CI-999']);
});

test('F-5eafee44 META: a workflow YAML source pin with no coverage still fails the gate (.yml is scanned)', async (t) => {
  const fx = makeFixture(t);
  fx.write('.github/workflows/example.yml', '# F-999999-002 — a fix pinned in a workflow file, no test coverage\n');
  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });
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

  const result = spawnSync(process.execPath, [targetScript, '--json', '--root', fx.dir, '--allowlist', allowlistPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.declared_ids, ['F-100000-060']);
  assert.ok(Array.isArray(parsed.grandfathered_ids));
  assert.ok(Array.isArray(parsed.tag_issues));
  assert.ok(Array.isArray(parsed.disclosed_gaps) && parsed.disclosed_gaps.length > 0);
});

test('CLI: exits 1 (not 0, not 2) on a real orphan', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-070 — nothing covers this\n');
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const result = spawnSync(process.execPath, [targetScript, '--root', fx.dir, '--allowlist', fx.writeAllowlist({ allow: {} })], { encoding: 'utf8' });
  assert.equal(result.status, 1);
});
