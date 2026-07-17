/**
 * f-755d0f3f-canonicalize-proto-digest-collision.test.js
 *
 * F-755d0f3f — `sortDeep()` in lib/integrity.js rebuilt every object as a plain
 * `{}` and copied keys with `sorted[key] = sortDeep(value[key])`. For an OWN
 * `__proto__` key that assignment hits the inherited `Object.prototype.__proto__`
 * SETTER and mutates `sorted`'s internal prototype instead of creating an own
 * key. `JSON.stringify` then walks own keys only, so the field — and everything
 * under it — silently vanished from the canonical string `canonicalize()`
 * returns and `submissionDigest()` hashes.
 *
 * The consequence is a DIGEST COLLISION in the trust-critical path: two
 * materially different records hash identically. `JSON.parse` creates a REAL own
 * `__proto__` data property (CreateDataProperty, not Set — unlike an object
 * literal), so any record FILE on disk can carry one.
 *
 * WHY THIS IS NOT THE SAME SEVERITY AS ITS SIBLINGS (F-a853fcaa / F-48672d32),
 * which were LOW output-correctness bugs in the portfolio surface:
 *
 * `verify-chain.js` — the module whose whole reason to exist is detecting
 * post-persist tampering — does NOT validate. It does `JSON.parse(readFileSync(
 * recordPath))` (verify-chain.js:160) then `submissionDigest(parsed)`
 * (verify-chain.js:168). The record schema's `additionalProperties: false` IS
 * enforced, but only by `validateRecord()` on the persist WRITE path, which the
 * verifier never calls. So the schema gate keeps a `__proto__` record from being
 * INGESTED, and provides exactly zero protection against one appearing on disk
 * afterwards — which is the only threat the chain exists to catch.
 *
 * The XRPL anchor does not close it either: anchor/compute-root.js Merkle-roots
 * `entry.submission_digest` straight from the ledger (compute-root.js:146), so a
 * mutation invisible to the digest is equally invisible to the anchored root.
 * The anchor closes TAIL TRUNCATION, a different gap.
 *
 * This falsifies a published claim. README.md:61 states the chain "validates
 * fully offline — detecting out-of-band tampering, disk corruption, and partial
 * restores," and integrity-chain.test.js:9-10 pins "verify-chain DETECTS
 * tampering: mutate a record on disk → the gate goes RED" as *the load-bearing
 * test*. That existing test only ever mutates an ordinary key. The end-to-end
 * test below is the same scenario with a `__proto__` key, and pre-fix the gate
 * stayed GREEN on a record file carrying attacker-authored content.
 *
 * NOT a prototype-pollution bug, and the distinction is worth pinning rather
 * than asserting: `sorted` is a fresh throwaway that is stringified immediately,
 * so the setter retargets ITS prototype and never reaches the shared
 * Object.prototype. `assertObjectPrototypeClean` below holds both before and
 * after the fix — it guards F-a853fcaa against regression, it is not the proof
 * of this one. The proof of this one is the digest inequality.
 *
 * The fix: `const sorted = Object.create(null)` — no inherited `__proto__`
 * accessor, so the assignment creates a real own key. `JSON.stringify`
 * serializes a null-prototype object identically to a plain one, so every record
 * WITHOUT a `__proto__` key keeps its exact pre-fix digest and the committed
 * chain does not break. The back-compat describe below pins that claim against
 * hardcoded digests rather than trusting it.
 *
 * Deletion/emptiness proof: revert `Object.create(null)` to `{}` in
 * lib/integrity.js's sortDeep and every test in the first two describes goes red.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalize, submissionDigest } from './lib/integrity.js';
import { writeRecord } from './persist.js';
import { verifyChain } from './verify-chain.js';

/**
 * Build a record carrying an own `__proto__` key at `path`, via JSON.parse so the
 * key is a real own data property — the exact shape a record file on disk has.
 * An object literal would NOT reproduce this: `{__proto__: x}` invokes the setter
 * at construction and never creates an own key.
 */
function parseWithProto(json) {
  const parsed = JSON.parse(json);
  assert.ok(Object.hasOwn(parsed, '__proto__') || Object.hasOwn(parsed.verification ?? {}, '__proto__'),
    'test precondition: JSON.parse must create a REAL own __proto__ key');
  return parsed;
}

function assertObjectPrototypeClean(label) {
  const polluted = Object.getOwnPropertyNames(Object.prototype)
    .filter((k) => !['constructor', '__proto__', 'toString', 'toLocaleString', 'valueOf',
      'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__defineGetter__',
      '__defineSetter__', '__lookupGetter__', '__lookupSetter__'].includes(k));
  assert.deepEqual(polluted, [], `${label}: Object.prototype must carry no extra own properties; found ${JSON.stringify(polluted)}`);
  assert.equal(({}).injected, undefined, `${label}: a fresh {} must not inherit an "injected" property`);
}

function buildRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'proto-collision-001',
    repo: 'dogfood-lab/testing-os',
    ref: { commit_sha: 'a'.repeat(40) },
    source: {
      provider: 'github',
      workflow: 'dogfood.yml',
      provider_run_id: '12345',
      run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/12345',
    },
    timing: { started_at: '2026-03-19T15:45:00Z', finished_at: '2026-03-19T15:45:12Z' },
    scenario_results: [{
      scenario_id: 'sanity',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [{ step_id: 'one', status: 'pass' }],
    }],
    overall_verdict: { proposed: 'pass', verified: 'pass' },
    verification: {
      status: 'accepted',
      verified_at: '2026-03-19T15:45:13Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
    },
    ...overrides,
  };
}

describe('F-755d0f3f: canonicalize() does not drop an own "__proto__" key', () => {
  beforeEach(() => assertObjectPrototypeClean('precondition'));
  afterEach(() => assertObjectPrototypeClean('postcondition'));

  it('a root "__proto__" key survives into the canonical string', () => {
    const withProto = parseWithProto('{"run_id":"a","__proto__":{"injected":true}}');

    // THE assertion. Pre-fix: `sorted['__proto__'] = ...` retargeted `sorted`'s
    // prototype, so the key never became own and JSON.stringify dropped it —
    // canonicalize returned '{"run_id":"a"}', erasing the field entirely.
    assert.ok(canonicalize(withProto).includes('"__proto__"'),
      `expected the __proto__ key in the canonical string; got ${canonicalize(withProto)}`);
  });

  it('two materially different records do NOT share a canonical form', () => {
    const withProto = parseWithProto('{"run_id":"a","__proto__":{"injected":true}}');
    const withoutProto = JSON.parse('{"run_id":"a"}');

    assert.notEqual(canonicalize(withProto), canonicalize(withoutProto),
      'a record carrying attacker-authored content must not canonicalize identically to one without it');
  });

  it('the collision is a DIGEST collision — submissionDigest must distinguish them', () => {
    const withProto = parseWithProto('{"run_id":"a","repo":"o/r","__proto__":{"injected":true}}');
    const withoutProto = JSON.parse('{"run_id":"a","repo":"o/r"}');

    assert.notEqual(submissionDigest(withProto), submissionDigest(withoutProto),
      'submissionDigest is the record digest — two different records sharing one is a hash collision');
  });

  it('the collision works at ANY depth, not just the record root', () => {
    // Every nested object goes through the same sortDeep branch, so a free-form
    // or open bag nested anywhere is the same hole. Pinned because the record
    // root's `additionalProperties: false` is easy to mistake for full coverage.
    const nestedProto = parseWithProto('{"verification":{"status":"accepted","__proto__":{"injected":true}}}');
    const nestedClean = JSON.parse('{"verification":{"status":"accepted"}}');

    assert.notEqual(canonicalize(nestedProto), canonicalize(nestedClean),
      'a __proto__ key nested inside an object must also survive canonicalization');
  });

  it('Object.prototype stays clean — a content-dropping bug, not a pollution one', () => {
    // Passes both before and after the fix. Pins the claim that this finding is
    // NOT the F-a853fcaa pollution family, and guards that fix at the same time.
    canonicalize(parseWithProto('{"run_id":"a","__proto__":{"injected":true}}'));
    assertObjectPrototypeClean('after canonicalize with a __proto__ key');
  });
});

describe('F-755d0f3f: verify-chain detects a "__proto__" tamper (the reachable path)', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'f-755d0f3f-chain-'));
    mkdirSync(join(root, 'records'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a record file mutated on disk with a "__proto__" key turns the gate RED', () => {
    const { path } = writeRecord(buildRecord({ run_id: 'chain-a' }), root);
    assert.equal(verifyChain(root).ok, true, 'precondition: the freshly persisted chain must verify clean');

    // The out-of-band edit README.md:61 promises to detect: the record FILE gains
    // attacker-authored content; the ledger line is untouched. verify-chain never
    // calls validateRecord, so the schema's additionalProperties:false — which
    // does reject this shape on the ingest path — is not in play here at all.
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace(/^\{/, '{"__proto__":{"injected_by_attacker":"arbitrary content"},'), 'utf-8');

    const reparsed = JSON.parse(readFileSync(path, 'utf-8'));
    assert.ok(Object.hasOwn(reparsed, '__proto__'),
      'test precondition: the tampered file must parse back with a real own __proto__ key');
    assert.equal(reparsed['__proto__'].injected_by_attacker, 'arbitrary content',
      'test precondition: the injected payload must be readable from the parsed record');

    // THE assertion — the whole finding in one line. Pre-fix this returned
    // ok:true, so the tamper-evidence property README.md:61 publishes was false
    // for this entire class of mutation.
    const result = verifyChain(root);
    assert.equal(result.ok, false,
      'verify-chain must detect a record file that gained content after persist');
    assert.match(result.break.reason, /digest mismatch/,
      `expected a digest-mismatch break; got ${JSON.stringify(result.break)}`);
  });

  it('a nested "__proto__" tamper is detected too', () => {
    const { path } = writeRecord(buildRecord({ run_id: 'chain-b' }), root);

    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace(/"verification": \{/, '"verification": {"__proto__":{"injected":true},'), 'utf-8');
    assert.ok(Object.hasOwn(JSON.parse(readFileSync(path, 'utf-8')).verification, '__proto__'),
      'test precondition: the nested tamper must parse back as a real own key');

    assert.equal(verifyChain(root).ok, false,
      'verify-chain must detect a __proto__ key injected into a nested object');
  });

  it('an untampered chain still verifies clean (no false positive)', () => {
    writeRecord(buildRecord({ run_id: 'chain-c' }), root);
    writeRecord(buildRecord({ run_id: 'chain-d' }), root);

    const result = verifyChain(root, { collectOrphans: true });
    assert.equal(result.ok, true, `expected a clean chain; got ${JSON.stringify(result.break)}`);
    assert.equal(result.count, 2);
  });
});

describe('F-755d0f3f: the fix is byte-identical for records without a "__proto__" key', () => {
  // The load-bearing back-compat claim: Object.create(null) must not change the
  // digest of any already-persisted record, or the committed chain in records/
  // breaks and every historical integrity block becomes unverifiable. Pinned
  // against hardcoded expected values so a future serialization change to
  // sortDeep cannot silently rewrite history and still pass.

  it('canonicalize output is unchanged for ordinary nested records', () => {
    assert.equal(canonicalize({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
    assert.equal(canonicalize({ xs: [{ b: 1, a: 2 }] }), '{"xs":[{"a":2,"b":1}]}');
    assert.equal(canonicalize({ n: null, s: 'x', t: true, i: 1 }), '{"i":1,"n":null,"s":"x","t":true}');
  });

  it('submissionDigest is unchanged for a fixed known record', () => {
    const record = buildRecord({ run_id: 'fixed-digest-probe' });
    const { integrity: _omit, ...withoutIntegrity } = record;
    const expected = createHash('sha256')
      .update(JSON.stringify(sortDeepReference(withoutIntegrity)), 'utf-8')
      .digest('hex');

    assert.equal(submissionDigest(record), expected,
      'the fix must not alter the digest of a record with no __proto__ key');
  });
});

/**
 * The PRE-FIX sortDeep, verbatim, as an independent oracle. For any input with no
 * own `__proto__` key it must agree with the fixed implementation exactly — that
 * agreement is what proves the committed chain survives the fix. It is duplicated
 * here rather than imported precisely so it does not track future edits to the
 * real one.
 */
function sortDeepReference(value) {
  if (Array.isArray(value)) return value.map(sortDeepReference);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortDeepReference(value[key]);
    return sorted;
  }
  return value;
}
