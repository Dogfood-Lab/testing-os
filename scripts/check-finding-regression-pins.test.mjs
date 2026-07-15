/**
 * Regression tests for scripts/check-finding-regression-pins.mjs.
 *
 * Why this lives at the root scripts/ tree: same reason as sync-version.test.mjs
 * and check-doc-drift.test.mjs — the gate isn't owned by any workspace package
 * and we don't want to grow a pseudo-workspace just to host it. Run via
 * `npm run test:scripts`.
 *
 * Coverage:
 *   1. Clean tree — no orphans → ok=true, exit 0 path
 *   2. Drift tree — synthetic source F-id with no test pin → ok=false
 *   3. Allowlist — orphan covered by allowlist → ok=true, allowlistApplied non-empty
 *   4. Unused allowlist entry — surfaced in unusedAllowEntries (not a hard failure)
 *   5. --write-index flag — writes a JSON file at the requested path
 *   6. Allowlist loader — malformed JSON, missing "allow", non-string reason all error
 *   7. Live-tree assertion: the actual repo passes the gate (load-bearing test —
 *      this is the contract that says "the gate is wired and current")
 *
 * Cleanup: every makeFixture() registers `t.after(() => rmSync(dir, ...))`
 * mirroring the check-doc-drift pattern that closed F-651020-007.
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
  formatHuman,
} from './check-finding-regression-pins.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * Allocate a temp fixture root, register cleanup, return helpers.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Positive cases — clean tree, allowlist coverage
// ─────────────────────────────────────────────────────────────────────────────

test('clean tree: every source pin has a matching test pin → ok=true', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-001 — defensive guard\n');
  fx.write('packages/foo/index.test.js', "describe('guard (F-100000-001)', () => {});\n");

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, true, `expected ok=true on clean tree; orphans=${JSON.stringify(result.orphans)}`);
  assert.equal(result.orphans.length, 0);
  assert.equal(result.json.summary.source_ids, 1);
  assert.equal(result.json.summary.test_ids, 1);
});

test('orphan covered by allowlist → ok=true, allowlistApplied includes the id', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-200000-001 — cross-ref to sibling fix elsewhere\n');
  // No test pin for F-200000-001.
  const allowlistPath = fx.writeAllowlist({
    allow: {
      'F-200000-001': { reason: 'cross-reference to sibling fix; pin lives in another file', file: 'packages/foo/index.js' },
    },
  });

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath });

  assert.equal(result.ok, true);
  assert.deepEqual(result.allowlistApplied, ['F-200000-001']);
  assert.deepEqual(result.orphans, []);
});

test('unused allowlist entry surfaces as warning but does not fail the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-100000-001\n');
  fx.write('packages/foo/index.test.js', '// F-100000-001\n');
  const allowlistPath = fx.writeAllowlist({
    allow: {
      'F-999999-999': { reason: 'never resolved' },
    },
  });

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath });

  assert.equal(result.ok, true, 'unused allowlist entries are advisory, not failure');
  assert.deepEqual(result.unusedAllowEntries, ['F-999999-999']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative cases — orphan source pin
// ─────────────────────────────────────────────────────────────────────────────

test('synthetic source F-id with no matching test pin → ok=false, orphans listed', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-300000-001 — fix that nobody tested\n');
  // Deliberately no test file pinning F-300000-001.

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, false, 'orphan source pin should fail the gate');
  assert.deepEqual(result.orphans, ['F-300000-001']);
  assert.equal(result.allowlistApplied.length, 0);
});

test('orphan from one file does not mask a clean orphan elsewhere', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/a/x.js', '// F-400000-001 — orphan a\n');
  fx.write('packages/b/y.js', '// F-400000-002 — orphan b\n');
  fx.write('packages/c/z.js', '// F-400000-003 — has test\n');
  fx.write('packages/c/z.test.js', '// F-400000-003 — regression\n');

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.ok, false);
  assert.deepEqual([...result.orphans].sort(), ['F-400000-001', 'F-400000-002']);
});

// ─────────────────────────────────────────────────────────────────────────────
// F-3ec5b54f / F-5eafee44 META — non-vacuity across ID format and file
// extension. CROSS-DOMAIN: F_ID_PATTERN and DEFAULT_SOURCE_EXTENSIONS are
// defined in packages/portfolio/lib/parse-regression-pins.js, which this
// gate CONSUMES (see the import at the top of check-finding-regression-pins.mjs)
// but does not define. That file matches packages/portfolio/**, owned
// exclusively by the backend domain per the frozen wave-2 domain map — out
// of scope for this domain (.github/**, scripts/**, tsconfig*.json).
//
// The three tests immediately below assert the CORRECT, desired gate
// behavior for every finding-id shape this repo actually mints (hash
// F-xxxxxxxx, prefixed F-AAA-NNN, and workflow-YAML source pins) — matching
// the standard this file's own legacy-format tests already hold the gate
// to. THEY ARE EXPECTED TO FAIL (RED) until packages/portfolio/lib/
// parse-regression-pins.js is fixed. That is not a bug in the tests; it is
// the honest, non-vacuous signal F-3ec5b54f exists to surface, in the style
// scripts/check-doc-drift.test.mjs already uses for its own META tests
// ("error-codes META: removing any enforced code from the handbook MUST
// trigger drift"). Confirmed empirically against the live tree via a
// read-only diagnostic (reusing the real walkSourceFiles/classifyFile
// exports with the finding's proposed widened pattern substituted in — no
// repo file was edited to measure this): of 133 source-side F-id pins that
// exist under the widened pattern (40 legacy already visible today + 77
// hash-style + 16 prefixed, both currently invisible), 13 are true orphans
// — 3 legacy already known and allowlisted in scripts/regression-pin-allowlist.json,
// plus 10 newly-discovered (3 hash-style, 7 prefixed) that would need a
// regression-test pin or an allowlist entry once the pattern lands. See the
// ci-tooling wave-2 output for the full accounting and the exact 10 ids.
//
// DO NOT mark these `todo`, weaken the assertions, or delete them to reach
// a green — that is exactly the "narrow the pattern to get a green"
// anti-pattern the finding's fix explicitly forbids. Once the backend-domain
// fix lands, these three tests go green with no further edit needed here.
// ─────────────────────────────────────────────────────────────────────────────

test('F-3ec5b54f META: a HASH-style source pin (F-xxxxxxxx) with no test pin must fail the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-42e57a77 — defer the red run past the commit step\n');
  // Deliberately no test pin for F-42e57a77.

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'CROSS-DOMAIN BLOCKED (F-3ec5b54f): F_ID_PATTERN in packages/portfolio/lib/parse-regression-pins.js ' +
      '(backend domain, out of scope for scripts/**) does not match hash-style ids, so this pin is currently ' +
      `INVISIBLE to the gate (got source_ids=${result.json.summary.source_ids}, expected 1) and result.ok is wrongly true. ` +
      'This assertion documents the desired behavior and will pass once the pattern is widened per F-3ec5b54f\'s fix — do not soften it to get a green.',
  );
});

test('F-3ec5b54f META: a PREFIXED-style source pin (F-AAA-NNN) with no test pin must fail the gate', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-W1-CI-999 — orphaned prefixed-format pin for this test\n');

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'CROSS-DOMAIN BLOCKED (F-3ec5b54f): the prefixed format (F-AAA-NNN, e.g. F-W1-CI-008 / F-CI-001) is also ' +
      `invisible to the unwidened F_ID_PATTERN (got source_ids=${result.json.summary.source_ids}, expected 1). Same cross-domain blocker as the hash-style test above.`,
  );
});

test('F-5eafee44 META: a workflow YAML source pin with no test pin must fail the gate (extension not scanned today)', async (t) => {
  const fx = makeFixture(t);
  fx.write('.github/workflows/example.yml', '# F-999999-002 — a fix pinned in a workflow file, no test coverage\n');

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(
    result.ok,
    false,
    'CROSS-DOMAIN BLOCKED (F-5eafee44): DEFAULT_SOURCE_EXTENSIONS in packages/portfolio/lib/parse-regression-pins.js ' +
      `(backend domain) does not include .yml/.yaml, so this file is never scanned (got files_scanned=${result.json.files_scanned}, expected 1) ` +
      'and result.ok is wrongly true. Land together with F-3ec5b54f\'s regex widening — the next test guards the ' +
      'specific live claim that 12 real F-ids already rely on this extension being scanned.',
  );
});

test('F-5eafee44: the 12 workflow-pinned F-ids named in the finding are still present in .github/workflows/*.yml (guards the claim, not the gate)', () => {
  // Independently verifies the finding's own factual claim about today's
  // live tree, using a LOCAL regex over the real repo — not the (out-of-
  // domain) parser and not a fixture — so the claim can't silently go stale
  // if a future edit drops one of these pins without updating this list.
  // Genuinely load-bearing pins per F-5eafee44: the deferred-fault
  // evidence-preservation ordering in ingest.yml, the release
  // concurrency-group normalization, and the pa11y permission isolation.
  const ids = [
    'F-362d4131', 'F-42e57a77', 'F-50558cb2', 'F-60f0c4f5', 'F-68818085',
    'F-a52776d5', 'F-bc123f41', 'F-caeeacc3', 'F-d31dfc55', 'F-e4a24655',
    'F-ef512e21', 'F-f05363e2',
  ];
  const workflowsDir = resolve(repoRoot, '.github/workflows');
  const text = readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => readFileSync(resolve(workflowsDir, f), 'utf-8'))
    .join('\n');

  const missing = ids.filter((id) => !text.includes(id));
  assert.deepEqual(missing, [], `expected every listed F-id to still be pinned somewhere in .github/workflows/*.yml; missing: ${missing.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// --write-index flag
// ─────────────────────────────────────────────────────────────────────────────

test('--write-index path: writes JSON to the requested path with parser shape', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-500000-001\n');
  fx.write('packages/foo/index.test.js', '// F-500000-001\n');
  const indexPath = 'docs/regression-pin-index.json';

  const result = await runRegressionPinGate({
    repoRoot: fx.dir,
    allowlistPath: fx.writeAllowlist({ allow: {} }),
    writeIndexPath: indexPath,
  });

  assert.equal(result.ok, true);
  assert.ok(result.indexWritten, 'indexWritten should be set when --write-index is used');
  assert.ok(existsSync(result.indexWritten), `index file should exist at ${result.indexWritten}`);

  const contents = JSON.parse(readFileSync(result.indexWritten, 'utf-8'));
  assert.ok(contents.source_pins['F-500000-001']);
  assert.ok(contents.test_pins['F-500000-001']);
  assert.equal(contents.summary.source_ids, 1);
  assert.equal(contents.summary.test_ids, 1);
  assert.deepEqual(contents.summary.orphan_source_ids, []);
});

test('without --write-index: no index file is written and indexWritten is null', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/index.js', '// F-600000-001\n');
  fx.write('packages/foo/index.test.js', '// F-600000-001\n');

  const result = await runRegressionPinGate({ repoRoot: fx.dir, allowlistPath: fx.writeAllowlist({ allow: {} }) });

  assert.equal(result.indexWritten, null, '--write-index is opt-in; default must NOT write a file');
});

// ─────────────────────────────────────────────────────────────────────────────
// loadAllowlist / applyAllowlist — defensive contract
// ─────────────────────────────────────────────────────────────────────────────

test('loadAllowlist: missing file returns empty allow', () => {
  const empty = loadAllowlist(join(tmpdir(), `does-not-exist-${Date.now()}.json`));
  assert.deepEqual(empty, { allow: {} });
});

test('loadAllowlist: malformed JSON throws a helpful error', (t) => {
  const fx = makeFixture(t);
  fx.write('bad.json', '{ not valid json');
  assert.throws(
    () => loadAllowlist(join(fx.dir, 'bad.json')),
    /not valid JSON/,
  );
});

test('loadAllowlist: missing "allow" field throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-allow.json', JSON.stringify({ description: 'I forgot the allow key' }));
  assert.throws(
    () => loadAllowlist(join(fx.dir, 'no-allow.json')),
    /missing required "allow" field/,
  );
});

test('loadAllowlist: entry without reason throws', (t) => {
  const fx = makeFixture(t);
  fx.write('no-reason.json', JSON.stringify({ allow: { 'F-100000-001': {} } }));
  assert.throws(
    () => loadAllowlist(join(fx.dir, 'no-reason.json')),
    /missing "reason"/,
  );
});

test('applyAllowlist: pure function over a parsed json shape', () => {
  const json = {
    source_pins: { 'F-100000-001': ['/x/a.js'], 'F-200000-002': ['/x/b.js'] },
    test_pins: {},
    files_scanned: 2,
    summary: {
      source_ids: 2,
      test_ids: 0,
      orphan_source_ids: ['F-100000-001', 'F-200000-002'],
    },
  };
  const allowlist = { allow: { 'F-100000-001': { reason: 'ok' } } };
  const out = applyAllowlist(json, allowlist);
  assert.deepEqual(out.orphansAfterAllowlist, ['F-200000-002']);
  assert.deepEqual(out.applied, ['F-100000-001']);
  assert.deepEqual(out.unusedAllowEntries, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// formatHuman — sanity-check the user-facing output
// ─────────────────────────────────────────────────────────────────────────────

test('formatHuman: includes orphan list when there are orphans', () => {
  const result = {
    ok: false,
    json: {
      source_pins: { 'F-700000-001': ['/repo/packages/foo/index.js'] },
      test_pins: {},
      files_scanned: 1,
      summary: { source_ids: 1, test_ids: 0, orphan_source_ids: ['F-700000-001'] },
    },
    orphans: ['F-700000-001'],
    allowlistApplied: [],
    unusedAllowEntries: [],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /FAIL/);
  assert.match(text, /F-700000-001/);
  assert.match(text, /How to fix/);
});

test('formatHuman: marks the live tree as OK when there are no orphans', () => {
  const result = {
    ok: true,
    json: { source_pins: {}, test_pins: {}, files_scanned: 0, summary: { source_ids: 0, test_ids: 0, orphan_source_ids: [] } },
    orphans: [],
    allowlistApplied: [],
    unusedAllowEntries: [],
    indexWritten: null,
  };
  const text = formatHuman(result, '/repo');
  assert.match(text, /OK/);
  assert.match(text, /Class #14 invariant holds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Live-tree assertion — the load-bearing test
// ─────────────────────────────────────────────────────────────────────────────

test('live testing-os tree passes the regression-pin gate', async () => {
  const result = await runRegressionPinGate({ repoRoot });
  if (!result.ok) {
    const detail = result.orphans
      .map((id) => {
        const files = result.json.source_pins[id] ?? [];
        return `  ${id}\n    ${files.join('\n    ')}`;
      })
      .join('\n');
    assert.fail(
      `regression-pin gate FAIL on live tree: ${result.orphans.length} orphan(s):\n${detail}\n\nFix: add a test pin (preferred) OR add an allowlist entry in scripts/regression-pin-allowlist.json with a reason.`,
    );
  }
  assert.equal(result.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// F-W1-CI-006 — ESM main-entry guard: only run main() when invoked as a
// script, not when imported by tests. Previous heuristic used a hand-built
// `file://${process.argv[1]}` plus an `endsWith` fallback; both fail on
// Windows because process.argv[1] uses backslashes while import.meta.url is
// always POSIX/URL form. `pathToFileURL(process.argv[1]).href` is the
// canonical Node cross-platform pattern (matches apply-finding-migration.mjs's
// W31-BACK-001 fix).
// ─────────────────────────────────────────────────────────────────────────────

test('F-W1-CI-006: main-entry guard uses pathToFileURL(process.argv[1]).href === import.meta.url, not a file://+endsWith fallback', () => {
  const src = readFileSync(resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs'), 'utf8');
  const stripped = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const guardLine = stripped
    .split(/\r?\n/)
    .find((l) => /^\s*const isMain\s*=/.test(l));
  assert.ok(guardLine, 'expected a `const isMain = ...` line in check-finding-regression-pins.mjs — pin is stale');
  assert.match(
    guardLine,
    /process\.argv\[1\]\s*&&/,
    'main-entry guard must short-circuit on `process.argv[1] &&`',
  );
  assert.match(
    guardLine,
    /pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href\s*===\s*import\.meta\.url/,
    'main-entry guard must compare pathToFileURL(process.argv[1]).href against import.meta.url, not a hand-built file:// string or an endsWith fallback (F-W1-CI-006)',
  );
  assert.doesNotMatch(
    guardLine,
    /endsWith|`file:\/\/\$\{/,
    'main-entry guard must not revert to the file://${process.argv[1]} + endsWith fallback — process.argv[1] uses backslashes on Windows while import.meta.url is always POSIX/URL form (F-W1-CI-006)',
  );
});

test('F-W1-CI-006: --help invokes the main-entry block (proves isMain fires on a real script invocation), prints Usage, exits 0', () => {
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const result = spawnSync(process.execPath, [targetScript, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `--help must exit 0 (proves the main-entry block ran).\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`);
  assert.match(result.stdout, /Usage:/, '--help must print the Usage block, proving isMain fired');
});

// ─────────────────────────────────────────────────────────────────────────────
// F-c59bb518: F-893adcd1 (wave 4) fixed the module docstring to stop
// re-describing the id-shape contract and point at parse-regression-pins.js's
// F_ID_PATTERN instead — but printHelp() is a second, independently-live
// surface that still claimed (verbatim) the gate only recognizes the legacy
// 'F-NNNNNN-NNN' shape. Same narrower-than-reality claim F-893adcd1 was filed
// to eliminate, one surface over — verified live via `--help` below, the
// same subprocess pattern the F-W1-CI-006 test above already uses.
// ─────────────────────────────────────────────────────────────────────────────

test('F-c59bb518: --help describes the F_ID_PATTERN contract (legacy + hash-style), not just the legacy F-NNNNNN-NNN shape', () => {
  const targetScript = resolve(repoRoot, 'scripts/check-finding-regression-pins.mjs');
  const result = spawnSync(process.execPath, [targetScript, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `--help must exit 0.\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`);
  assert.match(result.stdout, /F-NNNNNN-NNN/, '--help must still mention the legacy id shape');
  assert.match(
    result.stdout,
    /F-xxxxxxxx/,
    '--help must also mention the hash-style id shape — F-3ec5b54f widened F_ID_PATTERN to include it, but ' +
      '--help previously described only the legacy shape as if it were the whole contract',
  );
  assert.match(
    result.stdout,
    /F_ID_PATTERN/,
    '--help should point at F_ID_PATTERN by name (like the module docstring already does) so the two ' +
      'descriptions cannot independently go stale again the next time the pattern is widened',
  );
});
