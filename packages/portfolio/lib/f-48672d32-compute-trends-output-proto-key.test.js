/**
 * f-48672d32-compute-trends-output-proto-key.test.js
 *
 * F-48672d32 (LOW) — the follow-up F-a853fcaa's own scope note called out, and
 * the "worth a follow-up grep for a third sibling" its finding text asked for.
 *
 * F-a853fcaa fixed computeTrends' AGGREGATION step (`bySurface`), which was
 * real, global, process-wide Object.prototype pollution. It did NOT touch the
 * SEPARATE, later output-construction step that re-keys the aggregate into the
 * function's return value:
 *
 *   const trends = {};
 *   for (const [repo, surfaces] of Object.entries(bySurface)) {
 *     trends[repo] = {};
 *     ...
 *     trends[repo][surface] = {...};
 *   }
 *
 * For a repo or product_surface literally named `__proto__`, `trends[repo] = {}`
 * and `trends[repo][surface] = {...}` hit the INHERITED `Object.prototype.__proto__`
 * accessor and set the target's own internal prototype instead of creating a
 * literal own-enumerable key. The entry then silently vanishes from
 * `Object.keys` / `Object.entries` / `JSON.stringify` — while still reading back
 * correctly by accident through the prototype-chain getter, which is precisely
 * what makes it easy to miss.
 *
 * THIS IS NOT A SECURITY BUG, and the distinction is load-bearing enough to pin
 * rather than assert: each `trends[repo]` is a fresh throwaway object scoped to
 * one repo, so unlike F-a853fcaa's `bySurface` this can never reach the shared,
 * process-wide Object.prototype. `assertObjectPrototypeClean` below holds both
 * before and after the fix — it is here as a REGRESSION guard on F-a853fcaa, not
 * as the proof of this one. The proof of this one is `Object.hasOwn`.
 *
 * The real damage is output correctness: every consumer that iterates
 * `Object.entries(trends)` (generate.js's regressed-count rollup, its
 * sortKeysDeep serializer, any future report renderer) silently skips that
 * repo's trend data.
 *
 * THIRD SIBLING, found by the follow-up grep and fixed alongside: generate.js's
 * `sortKeysDeep` rebuilt every map as a plain `{}` and copied keys in with
 * `out[key] = ...` — reopening the identical hole at the LAST hop before
 * `indexes/trends.json` is written. Fixing computeTrends alone would not have
 * delivered the outcome: the `__proto__` repo would survive computeTrends and
 * then vanish again during serialization of the committed served artifact. The
 * final test below pins the end-to-end path through the real generate.js rather
 * than trusting the in-memory shape.
 *
 * Reachability is the same bound as F-a853fcaa (hence LOW): writeRecord's
 * validateRecord() gate enforces the record schema's one-slash repo pattern, so
 * `repo: '__proto__'` cannot reach records/ via a normal submission — it takes a
 * hand-committed or out-of-band record file, a maintainer/CI error rather than a
 * live attacker vector.
 *
 * Deletion/emptiness proof: revert `Object.create(null)` to `{}` at either
 * compute-trends.js's `trends`/`trends[repo]` or generate.js's `sortKeysDeep`
 * `out`, and the matching test below goes red.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { computeTrends } from './compute-trends.js';

const GENERATE = resolve(import.meta.dirname, '..', 'generate.js');

function makeTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'compute-trends-output-proto-'));
  mkdirSync(join(root, 'records', 'safe-org', 'safe-repo', '2026', '01', '01'), { recursive: true });
  return root;
}

/** The FILE lives at a legitimate path — only the JSON content is poisoned. */
function seedRecord(repoRoot, filename, overrides) {
  const record = {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'proto-001',
    repo: 'safe-org/safe-repo',
    timing: { finished_at: '2026-01-01T00:00:00Z' },
    scenario_results: [{ scenario_id: 's1', product_surface: 'cli', verdict: 'pass' }],
    overall_verdict: { verified: 'pass' },
    verification: { status: 'accepted' },
    ...overrides
  };
  const path = join(repoRoot, 'records', 'safe-org', 'safe-repo', '2026', '01', '01', filename);
  writeFileSync(path, JSON.stringify(record), 'utf-8');
}

/** Fails the assertion if Object.prototype carries any own property it should not. */
function assertObjectPrototypeClean(label) {
  const polluted = Object.getOwnPropertyNames(Object.prototype)
    .filter((k) => !['constructor', '__proto__', 'toString', 'toLocaleString', 'valueOf',
      'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__',
      '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(k));
  assert.deepEqual(polluted, [], `${label}: Object.prototype must carry no extra own properties; found ${JSON.stringify(polluted)}`);
  assert.equal(({}).cli, undefined, `${label}: a fresh {} must not inherit a "cli" property from Object.prototype`);
}

describe('F-48672d32: computeTrends output map keeps "__proto__" as a literal own key', () => {
  let repoRoot;
  beforeEach(() => {
    assertObjectPrototypeClean('precondition');
    repoRoot = makeTmpRepo();
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    assertObjectPrototypeClean('postcondition');
  });

  it('repo: "__proto__" is an OWN key of the returned map, not its prototype', () => {
    seedRecord(repoRoot, 'run-a.json', { run_id: 'a', repo: '__proto__' });

    const trends = computeTrends(repoRoot);

    // THE assertion. Pre-fix this is false: `trends['__proto__'] = {}` set the
    // map's internal prototype via the inherited accessor, so the repo existed
    // only on the prototype chain and never as an own key.
    assert.ok(Object.hasOwn(trends, '__proto__'),
      `expected trends to carry an own "__proto__" key; Object.keys=${JSON.stringify(Object.keys(trends))}`);
    assert.ok(Object.keys(trends).includes('__proto__'),
      'the __proto__ repo must be enumerable — every consumer reaches it via Object.keys/entries');
    assert.equal(trends['__proto__'].cli.current.run_id, 'a');
  });

  it('product_surface: "__proto__" is an OWN key of the per-repo map, not its prototype', () => {
    seedRecord(repoRoot, 'run-b.json', {
      run_id: 'b',
      scenario_results: [{ scenario_id: 's1', product_surface: '__proto__', verdict: 'pass' }]
    });

    const trends = computeTrends(repoRoot);
    const perRepo = trends['safe-org/safe-repo'];

    assert.ok(perRepo, `expected an entry for safe-org/safe-repo; got ${JSON.stringify(trends)}`);
    assert.ok(Object.hasOwn(perRepo, '__proto__'),
      `expected the surface entry to survive as an own "__proto__" key; Object.keys=${JSON.stringify(Object.keys(perRepo))}`);
    assert.equal(perRepo['__proto__'].current.run_id, 'b');
  });

  it('a "__proto__" repo survives JSON.stringify — the report serialization boundary', () => {
    seedRecord(repoRoot, 'run-c.json', { run_id: 'c', repo: '__proto__' });

    const trends = computeTrends(repoRoot);

    // reports/dogfood-portfolio.json carries `trends` verbatim through
    // JSON.stringify. JSON.stringify walks OWN keys only and does NOT serialize
    // the prototype chain, so pre-fix the repo vanished from the report
    // entirely while `trends['__proto__']` still read back fine in memory.
    const roundTripped = JSON.parse(JSON.stringify(trends));
    assert.ok(Object.hasOwn(roundTripped, '__proto__'),
      `expected the __proto__ repo to survive serialization; got ${JSON.stringify(roundTripped)}`);
    assert.equal(roundTripped['__proto__'].cli.current.run_id, 'c');
  });

  it('Object.prototype stays clean — an output-shape bug, not a pollution one (F-a853fcaa guard)', () => {
    seedRecord(repoRoot, 'run-d.json', { run_id: 'd', repo: '__proto__' });
    seedRecord(repoRoot, 'run-e.json', {
      run_id: 'e',
      scenario_results: [{ scenario_id: 's1', product_surface: '__proto__', verdict: 'pass' }]
    });

    computeTrends(repoRoot);

    // Passes both before and after F-48672d32's fix — it pins the claim that
    // this finding is NOT security-severity, and guards F-a853fcaa's fix
    // against regression at the same time.
    assertObjectPrototypeClean('after computeTrends with both __proto__ keys');
  });

  it('an ordinary repo/surface is unaffected (no false positive)', () => {
    seedRecord(repoRoot, 'run-f.json', { run_id: 'f' });

    const trends = computeTrends(repoRoot);

    assert.deepEqual(Object.keys(trends), ['safe-org/safe-repo']);
    assert.equal(trends['safe-org/safe-repo'].cli.current.run_id, 'f');
  });
});

describe('F-48672d32: the served indexes/trends.json keeps a "__proto__" repo (sortKeysDeep)', () => {
  let repoRoot;
  beforeEach(() => { repoRoot = makeTmpRepo(); });
  afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

  it('generate.js writes the __proto__ repo into the committed served artifact', () => {
    seedRecord(repoRoot, 'run-g.json', { run_id: 'g', repo: '__proto__' });
    seedRecord(repoRoot, 'run-h.json', { run_id: 'h' });

    // generate.js reads indexes/latest-by-repo.json for the report/badges; the
    // trend surface is computed from records/ independently. A benign index
    // keeps the run realistic without steering this assertion.
    const indexesDir = join(repoRoot, 'indexes');
    mkdirSync(indexesDir, { recursive: true });
    writeFileSync(join(indexesDir, 'latest-by-repo.json'), JSON.stringify({
      'safe-org/safe-repo': {
        cli: {
          run_id: 'h',
          verified: 'pass',
          verification_status: 'accepted',
          finished_at: '2026-01-01T00:00:00Z',
          path: 'records/safe-org/safe-repo/2026/01/01/run-h.json',
        },
      },
    }, null, 2) + '\n', 'utf-8');

    execFileSync('node', [GENERATE], {
      env: { ...process.env, PORTFOLIO_REPO_ROOT: repoRoot },
      stdio: 'pipe',
    });

    // The end-to-end proof. sortKeysDeep is the last hop before these bytes are
    // written, and it rebuilt every map as a plain {} — so pre-fix the repo was
    // dropped HERE even with computeTrends fixed. Asserting on the file's raw
    // text (rather than only a JSON.parse round-trip, which resurrects
    // "__proto__" as an own key and would mask the bug) is deliberate.
    const raw = readFileSync(join(repoRoot, 'indexes', 'trends.json'), 'utf-8');
    assert.ok(raw.includes('"__proto__"'),
      `expected the __proto__ repo in the served trends.json; got:\n${raw}`);

    const served = JSON.parse(raw);
    assert.ok(Object.hasOwn(served, '__proto__'),
      `expected an own "__proto__" repo key in the served artifact; got ${JSON.stringify(served)}`);
    assert.equal(served['__proto__'].cli.current.run_id, 'g');
  });
});
