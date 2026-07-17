/**
 * f-89b7dcd5-rebuild-indexes-proto-pollution.test.js
 *
 * F-89b7dcd5 (LOW) — rebuildIndexes consumes on-disk records via loadRecord()
 * (JSON.parse only, no schema gate — see its JSDoc) and used plain-object
 * writes (`{}`) keyed by `record.repo` and `sr.product_surface` to build
 * latest-by-repo.json:
 *
 *   if (!latestByRepo[repo]) latestByRepo[repo] = {};
 *   latestByRepo[repo][surface] = {...};
 *
 * A record with `repo: '__proto__'` made `latestByRepo['__proto__']`
 * resolve Object.prototype itself (truthy on a plain `{}`, since bracket
 * access to the `__proto__` key hits the inherited accessor), so the init
 * branch was skipped and the surface write landed ON Object.prototype —
 * REAL global prototype pollution for the rest of this process, corrupting
 * every plain object created afterward. Separately, `product_surface:
 * '__proto__'` set the PROTOTYPE of latestByRepo[repo] instead of an own
 * property, silently vanishing the entry from Object.entries() and never
 * reaching the served index.
 *
 * Not reachable from the ingest write path (writeRecord's validateRecord()
 * gate constrains repo's shape — `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`, no bare
 * `__proto__` — before persist.js ever writes a file); reaching it requires
 * a record file committed directly into records/ bypassing ingest, a
 * maintainer/CI error rather than a live attacker vector. Still worth a
 * hard regression proof: Object.prototype pollution is process-wide and
 * process-lifetime, so even a "mostly trusted corpus" defect here is worth
 * sealing shut.
 *
 * The fix: Object.create(null) for both the outer latestByRepo map and each
 * per-repo surfaces map (rebuild-indexes.js). Deletion/emptiness proof:
 * revert both to `{}` and the tests below go red — `checkCleanProto` catches
 * the pollution directly.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rebuildIndexes } from './rebuild-indexes.js';

function makeTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'rebuild-proto-'));
  mkdirSync(join(root, 'records', 'safe-org', 'safe-repo', '2026', '01', '01'), { recursive: true });
  return root;
}

function seedRecord(repoRoot, filename, overrides) {
  const record = {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'proto-001',
    repo: 'safe-org/safe-repo', // the FILE lives at a legitimate path — only the JSON content is poisoned
    timing: { finished_at: '2026-01-01T00:00:00Z' },
    scenario_results: [{ scenario_id: 's1', product_surface: 'cli', verdict: 'pass' }],
    overall_verdict: { verified: 'pass' },
    verification: { status: 'accepted' },
    ...overrides,
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

describe('F-89b7dcd5: rebuildIndexes never writes onto Object.prototype', () => {
  let repoRoot;
  beforeEach(() => {
    assertObjectPrototypeClean('precondition');
    repoRoot = makeTmpRepo();
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    assertObjectPrototypeClean('postcondition');
  });

  it('repo: "__proto__" does not pollute Object.prototype, and lands as a literal own key instead', () => {
    seedRecord(repoRoot, 'run-a.json', { run_id: 'a', repo: '__proto__' });

    const result = rebuildIndexes(repoRoot);

    assertObjectPrototypeClean('after rebuildIndexes with repo="__proto__"');
    // The literal key must survive as an OWN property of latestByRepo — the
    // whole point of Object.create(null) is that '__proto__' behaves like
    // any other string key, not like the special accessor.
    assert.ok(Object.hasOwn(result.latestByRepo, '__proto__'),
      `expected latestByRepo to carry an own "__proto__" key; got ${JSON.stringify(result.latestByRepo)}`);
    assert.equal(result.latestByRepo['__proto__'].cli.run_id, 'a');
  });

  it('product_surface: "__proto__" does not set the prototype of the per-repo map — it lands as a literal own key', () => {
    seedRecord(repoRoot, 'run-b.json', {
      run_id: 'b',
      scenario_results: [{ scenario_id: 's1', product_surface: '__proto__', verdict: 'pass' }],
    });

    const result = rebuildIndexes(repoRoot);

    assertObjectPrototypeClean('after rebuildIndexes with product_surface="__proto__"');
    const perRepo = result.latestByRepo['safe-org/safe-repo'];
    assert.ok(perRepo, `expected an entry for safe-org/safe-repo; got ${JSON.stringify(result.latestByRepo)}`);
    // Pre-fix this write silently vanished (it set perRepo's PROTOTYPE
    // instead of an own property) and Object.entries(perRepo) never saw it.
    assert.ok(Object.hasOwn(perRepo, '__proto__'),
      `expected the surface entry to survive as an own "__proto__" key; got ${JSON.stringify(perRepo)}`);
    assert.equal(perRepo['__proto__'].run_id, 'b');
  });

  it('a normal record with an ordinary repo/surface is unaffected (no false positive)', () => {
    seedRecord(repoRoot, 'run-c.json', { run_id: 'c' });
    const result = rebuildIndexes(repoRoot);
    assertObjectPrototypeClean('after rebuildIndexes with an ordinary record');
    assert.equal(result.latestByRepo['safe-org/safe-repo'].cli.run_id, 'c');
  });
});
