/**
 * f-9b53dc33-load-policies-proto-repo-key.test.js
 *
 * F-9b53dc33 (LOW) — the fourth sibling in the `__proto__`-as-a-map-key family
 * (after F-a853fcaa, F-48672d32, F-89b7dcd5), found by the same follow-up grep.
 *
 * `loadPolicies()` keys its map by a policy YAML's `repo:` STRING field:
 *
 *   const policies = {};                       // generate.js:173 (multi-org accumulator)
 *   Object.assign(policies, loadPoliciesFromOrgDir(orgDir));   // :187
 *   ...
 *   const policies = {};                       // :197 (per-org map)
 *   policies[repo] = parsePolicy(text);        // :233
 *
 * For a policy whose `repo:` is exactly `__proto__`, `policies[repo] = ...` hits
 * the inherited `Object.prototype.__proto__` setter and retargets the map's
 * prototype instead of creating an own key. The policy then silently vanishes
 * from `Object.entries(policies)`.
 *
 * THE OBSERVABLE IMPACT is the coverage gap detector at generate.js:361-370
 * ("Find missing: repos with policies but no index entry"), which enumerates the
 * map to report declared-but-unevidenced repos. A vanished policy is never
 * enumerated, so it is never reported as `missing` — the portfolio reads healthy
 * while a declared policy is BOTH unenforced and invisible. That silent-clean is
 * worse than a loud error: the whole point of `missing` is to catch a repo that
 * promised evidence and produced none.
 *
 * A second, quieter effect: pre-fix `policies['__proto__']` at generate.js:328
 * returned `Object.prototype` itself — truthy garbage — rather than undefined.
 * The null-prototype map makes that lookup honest too.
 *
 * TWO HOPS, and fixing either alone is insufficient — the same lesson
 * F-48672d32 recorded when generate.js's `sortKeysDeep` reopened the hole at the
 * last serialization hop. `Object.assign(plainTarget, source)` uses [[Set]], so
 * it re-invokes the setter and drops the key even when the SOURCE map is already
 * null-prototype. Both the per-org map (:197) and the multi-org accumulator
 * (:173) must be `Object.create(null)`; then `Object.assign` onto a
 * null-prototype target creates a real own key. The multi-org test below is what
 * pins that — it fails if only :197 is fixed.
 *
 * WHY LOW: reaching it takes a policy file whose `repo:` is the bare string
 * `__proto__`. An ordinary `org/__proto__` is harmless (only the exact string
 * hits the accessor), and a RECORD can never carry `repo: '__proto__'` — the
 * record schema's one-slash pattern forbids it — so the :328 lookup never fires
 * for it in practice. This is a hand-authored/maintainer error, not a live
 * attacker vector. Unlike its integrity-path cousin F-755d0f3f, no security
 * property rests on it.
 *
 * NOT prototype pollution: each map is a fresh local, so the setter retargets
 * ITS prototype and never reaches the shared Object.prototype. The hygiene
 * assertion below holds before and after the fix — it guards F-a853fcaa, it is
 * not the proof of this one. The proof is `Object.hasOwn` + the `missing` row.
 *
 * Deletion/emptiness proof: revert either `Object.create(null)` in generate.js's
 * loadPolicies/loadPoliciesFromOrgDir and the matching test below goes red.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPolicies, generatePortfolio } from './generate.js';

function policyYaml(repo, surface = 'cli') {
  return [
    `repo: ${repo}`,
    'policy_version: "1.0.0"',
    '',
    'enforcement:',
    '  mode: required',
    '',
    'surfaces:',
    `  ${surface}:`,
    '    required_scenarios:',
    '      - smoke',
    '    freshness:',
    '      max_age_days: 30',
    '',
  ].join('\n');
}

function assertObjectPrototypeClean(label) {
  const polluted = Object.getOwnPropertyNames(Object.prototype)
    .filter((k) => !['constructor', '__proto__', 'toString', 'toLocaleString', 'valueOf',
      'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__',
      '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(k));
  assert.deepEqual(polluted, [], `${label}: Object.prototype must carry no extra own properties; found ${JSON.stringify(polluted)}`);
}

describe('F-9b53dc33: loadPolicies keeps a "__proto__" repo as a literal own key', () => {
  let root;
  beforeEach(() => {
    assertObjectPrototypeClean('precondition');
    root = mkdtempSync(join(tmpdir(), 'f-9b53dc33-policies-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    assertObjectPrototypeClean('postcondition');
  });

  it('single-org dir: a "__proto__" policy is an OWN key of the map', () => {
    // The legacy single-org shape returns loadPoliciesFromOrgDir directly, so
    // this isolates the :197 hop.
    writeFileSync(join(root, 'evil.yaml'), policyYaml('__proto__'), 'utf-8');
    writeFileSync(join(root, 'ok.yaml'), policyYaml('safe-org/safe-repo'), 'utf-8');

    const policies = loadPolicies(root);

    assert.ok(Object.hasOwn(policies, '__proto__'),
      `expected an own "__proto__" policy key; Object.keys=${JSON.stringify(Object.keys(policies))}`);
    assert.ok(Object.keys(policies).includes('__proto__'),
      'the policy must be enumerable — the coverage detector reaches it via Object.entries');
    assert.equal(policies['__proto__'].enforcement.mode, 'required');
  });

  it('multi-org root: the Object.assign hop preserves it (:173 + :187)', () => {
    // THE hop that a :197-only fix would miss. Object.assign uses [[Set]], so a
    // plain-object accumulator re-invokes the setter and drops the key even
    // though loadPoliciesFromOrgDir already handed back a clean own key.
    const orgDir = join(root, 'some-org');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'evil.yaml'), policyYaml('__proto__'), 'utf-8');
    writeFileSync(join(orgDir, 'ok.yaml'), policyYaml('safe-org/safe-repo'), 'utf-8');

    const policies = loadPolicies(root);

    assert.ok(Object.hasOwn(policies, '__proto__'),
      `expected the __proto__ policy to survive the multi-org Object.assign; Object.keys=${JSON.stringify(Object.keys(policies))}`);
    assert.equal(policies['__proto__'].enforcement.mode, 'required');
  });

  it('the vanished policy is reported as MISSING coverage (the real damage)', () => {
    // generate.js:361-370 enumerates the policy map to flag declared-but-
    // unevidenced repos. Pre-fix the __proto__ policy never enumerated, so a
    // repo that promised evidence and produced none silently never surfaced.
    writeFileSync(join(root, 'evil.yaml'), policyYaml('__proto__'), 'utf-8');

    const policies = loadPolicies(root);
    const portfolio = generatePortfolio({}, policies); // empty index === no evidence at all

    const missingRepos = portfolio.missing.map((m) => m.repo);
    assert.ok(missingRepos.includes('__proto__'),
      `a declared policy with no evidence must be reported missing; got ${JSON.stringify(portfolio.missing)}`);
  });

  it('an ordinary repo policy is unaffected (no false positive)', () => {
    writeFileSync(join(root, 'ok.yaml'), policyYaml('safe-org/safe-repo'), 'utf-8');

    const policies = loadPolicies(root);

    assert.deepEqual(Object.keys(policies), ['safe-org/safe-repo']);
    assert.equal(policies['safe-org/safe-repo'].enforcement.mode, 'required');
  });

  it('a repo merely CONTAINING __proto__ was never affected (scope pin)', () => {
    // Only the exact string hits the accessor. Pinned so a future reader does not
    // over-widen the finding into "any repo name mentioning __proto__".
    writeFileSync(join(root, 'ok.yaml'), policyYaml('some-org/__proto__'), 'utf-8');

    const policies = loadPolicies(root);

    assert.deepEqual(Object.keys(policies), ['some-org/__proto__']);
  });
});
