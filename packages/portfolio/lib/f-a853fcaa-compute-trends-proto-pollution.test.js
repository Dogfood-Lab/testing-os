/**
 * f-a853fcaa-compute-trends-proto-pollution.test.js
 *
 * F-a853fcaa (LOW) — computeTrends() reads on-disk record files via
 * JSON.parse only (no schema gate — the same pre-check shape as
 * rebuild-indexes.js's loadRecord()) and built its per-repo/per-surface
 * buckets with plain-object writes:
 *
 *   const bySurface = {};
 *   ...
 *   ((bySurface[repo] ??= {})[surface] ??= []).push(...)
 *
 * — the exact prototype-pollution shape already found and fixed this
 * session in the sibling file rebuild-indexes.js (F-89b7dcd5, fixed via
 * Object.create(null)), but compute-trends.js was not included in that fix.
 * A record with repo: '__proto__' makes `bySurface['__proto__']` resolve
 * Object.prototype itself (truthy on a plain `{}`), so `??=` never
 * initializes a fresh bucket and the surface-array write lands ON
 * Object.prototype — real global prototype pollution for the rest of the
 * process (a brand-new, completely unrelated `{}` created afterward would
 * return the pushed array from its `.cli` property). Separately,
 * product_surface: '__proto__' sets the PROTOTYPE of the per-repo bucket
 * instead of an own property, silently vanishing the entry from
 * Object.entries().
 *
 * Not reachable from the live ingest write path (writeRecord's
 * validateRecord() gate enforces the record schema's one-slash repo pattern
 * before any record is ever persisted — repo: '__proto__' cannot reach
 * records/ via a normal submission); reaching this requires a
 * hand-committed or out-of-band record file, a maintainer/CI error rather
 * than a live attacker vector. computeTrends() has exactly one caller, the
 * offline portfolio-report CLI (packages/portfolio/generate.js) — same
 * reachability bound as F-89b7dcd5, hence LOW.
 *
 * The fix: Object.create(null) for both the outer bySurface map and each
 * per-repo surfaces bucket (compute-trends.js), mirroring rebuild-indexes.js
 * exactly. Deletion/emptiness proof: revert both to `{}` / `??= {}` and the
 * tests below go red — assertObjectPrototypeClean catches the pollution
 * directly.
 *
 * SCOPE NOTE, found while writing this test: computeTrends() has a SEPARATE,
 * later re-keying step (`const trends = {}; ... trends[repo] = {}; ...
 * trends[repo][surface] = {...}`, lines ~224-286) that copies bySurface's
 * (now-safe) contents into the function's return value using plain objects
 * again. Proven by probe: for repo/surface literally named "__proto__" this
 * makes `trends`/`trends[repo]` set their OWN internal prototype instead of
 * an own-enumerable key (so `Object.hasOwn(trends, '__proto__')` is false
 * and `Object.keys/entries` never see the entry) — a real output-shape bug,
 * but NOT a security-severity one: each `trends[repo]` is a throwaway object
 * scoped to one repo, so this cannot leak onto the shared, process-wide
 * Object.prototype the way bySurface's bug did (confirmed —
 * assertObjectPrototypeClean holds through both tests below even before
 * this note existed). Out of scope for F-a853fcaa, which is specifically
 * the bySurface aggregation step; matches the finding's own "worth a
 * follow-up grep" framing. Flagged separately rather than silently folded
 * in here.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeTrends } from './compute-trends.js';

function makeTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'compute-trends-proto-'));
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
  // Belt-and-suspenders: a fresh unrelated object must never inherit a
  // surface-shaped key the way the pollution would have injected one.
  assert.equal(({}).cli, undefined, `${label}: a fresh {} must not inherit a "cli" property from Object.prototype`);
}

describe('F-a853fcaa: computeTrends never writes onto Object.prototype', () => {
  let repoRoot;
  beforeEach(() => {
    assertObjectPrototypeClean('precondition');
    repoRoot = makeTmpRepo();
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    assertObjectPrototypeClean('postcondition');
  });

  it('repo: "__proto__" does not pollute Object.prototype', () => {
    seedRecord(repoRoot, 'run-a.json', { run_id: 'a', repo: '__proto__' });

    const trends = computeTrends(repoRoot);

    // The load-bearing assertion: bySurface (the aggregation step that reads
    // raw repo/surface strings straight off disk) must never leak a write
    // onto Object.prototype. Confirmed via a standalone probe: pre-fix, this
    // one record poisons Object.prototype globally for the rest of the
    // process — a brand-new, unrelated `{}` created afterward would inherit
    // a `.cli` property. Post-fix Object.prototype stays clean regardless of
    // what the FINAL `trends` object below looks like.
    assertObjectPrototypeClean('after computeTrends with repo="__proto__"');
    // Readback still works via bracket access — NOT because `trends` itself
    // is null-prototype (it isn't; `trends[repo] = {}` at the very end of
    // computeTrends is a separate, later re-keying step this finding does
    // not cover — a repo literally named "__proto__" reads back through the
    // accessor rather than as an Object.hasOwn key, confirmed by probe) but
    // because bySurface handed it a correct, unpolluted value to re-key.
    assert.equal(trends['__proto__'].cli.current.run_id, 'a');
  });

  it('product_surface: "__proto__" does not pollute Object.prototype', () => {
    seedRecord(repoRoot, 'run-b.json', {
      run_id: 'b',
      scenario_results: [{ scenario_id: 's1', product_surface: '__proto__', verdict: 'pass' }]
    });

    const trends = computeTrends(repoRoot);

    assertObjectPrototypeClean('after computeTrends with product_surface="__proto__"');
    const perRepo = trends['safe-org/safe-repo'];
    assert.ok(perRepo, `expected an entry for safe-org/safe-repo; got ${JSON.stringify(trends)}`);
    assert.equal(perRepo['__proto__'].current.run_id, 'b');
  });

  it('a normal record with an ordinary repo/surface is unaffected (no false positive)', () => {
    seedRecord(repoRoot, 'run-c.json', { run_id: 'c' });
    const trends = computeTrends(repoRoot);
    assertObjectPrototypeClean('after computeTrends with an ordinary record');
    assert.equal(trends['safe-org/safe-repo'].cli.current.run_id, 'c');
  });
});
