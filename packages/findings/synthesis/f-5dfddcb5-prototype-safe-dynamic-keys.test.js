/**
 * f-5dfddcb5-prototype-safe-dynamic-keys.test.js
 *
 * F-5dfddcb5 (LOW) — apply-recommendation.js wrote two dynamic keys onto
 * plain `{}` containers:
 *
 *   if (!policy.surfaces) policy.surfaces = {};
 *   policy.surfaces[surface] = {};                          // line ~216
 *   ...
 *   if (!policy.applied_recommendations) policy.applied_recommendations = {};
 *   policy.applied_recommendations[action.target] = provenance;  // line ~238
 *
 * `action.target` is FREE TEXT (≤100 chars, no enum constraint — this file's
 * own header docstring), so `action.target === '__proto__'` reaching the
 * second write is the reachable case; `surface` comes from
 * `rec.applies_to.product_surfaces`, which IS schema-enum-constrained
 * (dogfood-recommendation.schema.json), so the first write is defense in
 * depth for the identical pattern, matching the sibling fixes already
 * shipped in this domain (F-89b7dcd5, F-a853fcaa) rather than a live gap.
 *
 * Mechanism (standalone probe, matching how the finding itself proved it):
 * on a plain `{}`, `container['__proto__'] = value` does not create an own
 * '__proto__' data property — it invokes Object.prototype's inherited
 * `__proto__` SETTER, which reassigns the CONTAINER's own [[Prototype]] to
 * `value` instead. The write silently vanishes (Object.keys() stays empty)
 * and the container starts inheriting `value`'s own properties. This is
 * scoped to the one container object — NOT a write onto the shared, global
 * Object.prototype (that stronger form needs a read-THEN-write through an
 * unguarded lookup, e.g. rebuild-indexes.js's pre-fix `latestByRepo[repo]`
 * pattern — a different shape from this file's direct single assignment).
 * Object.create(null) removes the [[Prototype]] chain entirely, so
 * '__proto__' behaves like any other string key.
 *
 * Testing-honesty note: neither `applyRecommendation()`'s return value nor
 * the persisted policy YAML exposes `policy.applied_recommendations` /
 * `policy.surfaces` themselves — `provenance` is a fresh object literal
 * returned independently of the (possibly-hijacked) container, and the
 * container is deliberately stripped from the persisted YAML before it is
 * ever written (see apply-recommendation.js's "NOTE: provenance is
 * intentionally written under a NON-schema key" comment). EMPIRICALLY
 * CONFIRMED by temporarily reverting the fix and re-running this file: the
 * "applyRecommendation() write path" describe block below stays 100% GREEN
 * either way — it is real regression coverage for adversarial-target data
 * flow (no crash, correct `required_scenarios` entry, no *global*
 * Object.prototype pollution) but it does NOT discriminate pre/post fix for
 * THIS mechanism, because the mechanism's only effect (the container's own,
 * local [[Prototype]]) is provably unobservable through this function's
 * current public contract. The standalone probe describe block above is
 * therefore the ONLY test in this file that actually goes red against the
 * vulnerable `{}` pattern — it is intentionally a mirror of the pattern
 * apply-recommendation.js uses, not a call into the real file, because no
 * real-pipeline call can observe the difference. (The sibling fixes,
 * F-89b7dcd5/F-a853fcaa, achieved a true end-to-end pin only because THEIR
 * functions happen to return the internal container directly;
 * applyRecommendation() does not, by design — the container is scoped to
 * DELETE-before-persist, which is what makes this finding LOW/unreachable
 * rather than a live data-integrity bug.)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { applyRecommendation } from './apply-recommendation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_proto_safe__');

/** @pins F-5dfddcb5 */
describe('F-5dfddcb5: standalone probe — the vulnerable {} pattern vs. the Object.create(null) fix', () => {
  it('PRE-FIX MECHANISM: a plain {} container silently drops a "__proto__" bracket-assignment and hijacks its own prototype instead', () => {
    const container = {};
    const provenance = { recommendation_id: 'drec-x', target: '__proto__' };
    container['__proto__'] = provenance;

    assert.deepEqual(Object.keys(container), [],
      'the write must not appear as an own enumerable key on the vulnerable pattern');
    assert.equal(Object.getPrototypeOf(container), provenance,
      'the container\'s own [[Prototype]] silently became the provenance object');
  });

  it('FIX: Object.create(null) makes "__proto__" behave like any other string key', () => {
    const container = Object.create(null);
    const provenance = { recommendation_id: 'drec-x', target: '__proto__' };
    container['__proto__'] = provenance;

    assert.ok(Object.hasOwn(container, '__proto__'),
      'expected an own "__proto__" key on a null-prototype container');
    assert.equal(container['__proto__'], provenance);
    assert.equal(Object.keys(container).length, 1);
  });
});

function makeRec(overrides = {}) {
  return {
    schema_version: '1.0.0',
    recommendation_id: 'drec-proto-001',
    title: 'Add a scenario',
    status: 'accepted',
    recommendation_kind: 'starter_scenario',
    summary: 'Adversarial target probe.',
    applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
    based_on_pattern_ids: ['dpat-proto-001'],
    action: { type: 'add_scenario', target: '__proto__', details: 'Adversarial target.' },
    confidence: 'strong',
    review: { reviewed_by: 'mike', reviewed_at: '2026-07-16T00:00:00Z', last_action: 'accept' },
    ...overrides
  };
}

function writeRecFile(id, rec) {
  const d = resolve(TEST_ROOT, 'recommendations');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(rec, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function writePolicy(orgRepo, policy) {
  const [org, repo] = orgRepo.split('/');
  const d = resolve(TEST_ROOT, 'policies', 'repos', org);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${repo}.yaml`), yaml.dump(policy, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function readPolicy(orgRepo) {
  const [org, repo] = orgRepo.split('/');
  return yaml.load(readFileSync(resolve(TEST_ROOT, 'policies', 'repos', org, `${repo}.yaml`), 'utf-8'));
}

function basePolicy() {
  return {
    repo: 'mcp-tool-shop-org/widget',
    policy_version: '1.0.0',
    enforcement: { mode: 'required' },
    surfaces: { cli: { required_scenarios: ['install-and-run'] } }
  };
}

/** Fails if Object.prototype carries any own property beyond its built-ins. */
function assertObjectPrototypeClean(label) {
  const polluted = Object.getOwnPropertyNames(Object.prototype)
    .filter((k) => !['constructor', '__proto__', 'toString', 'toLocaleString', 'valueOf',
      'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__',
      '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(k));
  assert.deepEqual(polluted, [], `${label}: Object.prototype must carry no extra own properties; found ${JSON.stringify(polluted)}`);
  assert.equal(({}).recommendation_id, undefined,
    `${label}: a fresh {} must not inherit a "recommendation_id" property from Object.prototype`);
}

describe('F-5dfddcb5: applyRecommendation() write path is prototype-safe end-to-end', () => {
  beforeEach(() => {
    assertObjectPrototypeClean('precondition');
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
    mkdirSync(resolve(TEST_ROOT, 'recommendations'), { recursive: true });
    mkdirSync(resolve(TEST_ROOT, 'policies', 'repos'), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
    assertObjectPrototypeClean('postcondition');
  });

  it('action.target: "__proto__" applies cleanly — correct provenance returned, required_scenarios still gains the literal target string', () => {
    writeRecFile('drec-proto-001', makeRec());
    writePolicy('mcp-tool-shop-org/widget', basePolicy());

    const res = applyRecommendation(TEST_ROOT, { id: 'drec-proto-001', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });

    assert.equal(res.success, true, JSON.stringify(res.error));
    assert.equal(res.applied, true);
    assert.equal(res.provenance.target, '__proto__');
    assert.equal(res.provenance.recommendation_id, 'drec-proto-001');

    const policy = readPolicy('mcp-tool-shop-org/widget');
    assert.ok(policy.surfaces.cli.required_scenarios.includes('__proto__'),
      `the literal target string must be added, not interpreted; got: ${JSON.stringify(policy.surfaces.cli.required_scenarios)}`);
    // The provenance map is deliberately stripped before persisting (see the
    // source's own "NOTE: provenance is intentionally written under a
    // NON-schema key" comment) — this must remain true regardless of target.
    assert.equal(policy.applied_recommendations, undefined);

    assertObjectPrototypeClean('immediately after a "__proto__"-target write');
  });

  it('a normal apply still works correctly AFTER a "__proto__"-target apply ran in this process (no cross-contamination)', () => {
    writeRecFile('drec-proto-001', makeRec());
    writePolicy('mcp-tool-shop-org/widget', basePolicy());
    applyRecommendation(TEST_ROOT, { id: 'drec-proto-001', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });

    writeRecFile('drec-proto-002', makeRec({
      recommendation_id: 'drec-proto-002',
      action: { type: 'add_scenario', target: 'entrypoint-truth-check', details: 'Normal target.' }
    }));
    const res2 = applyRecommendation(TEST_ROOT, { id: 'drec-proto-002', mode: 'write', actor: 'mike', policyRepo: 'mcp-tool-shop-org/widget' });

    assert.equal(res2.success, true, JSON.stringify(res2.error));
    assert.equal(res2.provenance.target, 'entrypoint-truth-check');
    const policy = readPolicy('mcp-tool-shop-org/widget');
    assert.ok(policy.surfaces.cli.required_scenarios.includes('entrypoint-truth-check'));
    assert.ok(policy.surfaces.cli.required_scenarios.includes('__proto__'));
  });

  it('dry-run preview with a "__proto__" target does not touch Object.prototype either', () => {
    writeRecFile('drec-proto-001', makeRec());
    writePolicy('mcp-tool-shop-org/widget', basePolicy());

    const res = applyRecommendation(TEST_ROOT, { id: 'drec-proto-001', mode: 'dry-run', policyRepo: 'mcp-tool-shop-org/widget' });

    assert.equal(res.success, true, JSON.stringify(res.error));
    assert.equal(res.preview.target, '__proto__');
    assertObjectPrototypeClean('after a "__proto__"-target dry-run');
  });
});
