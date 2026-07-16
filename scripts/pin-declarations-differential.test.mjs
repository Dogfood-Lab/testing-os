/**
 * pin-declarations-differential.test.mjs — the C9 differential-testing rig
 * (dispatch finding 23: McKeeman).
 *
 * Runs pin-declarations.mjs (AST-based, `@babel/parser`) and
 * pin-declarations-reference.mjs (hand-rolled character scanner +
 * regex-adjacency) over the SAME inputs and asserts they agree on the
 * credited-id SET. Disagreement is the bug signal — this file does not
 * decide which matcher is "right" when they diverge; it fails loud so a
 * human investigates, exactly per finding 23's "no hand-authored oracle"
 * framing. The two inputs diffed:
 *
 *   1. The full adversarial corpus (pin-declarations-corpus.mjs) — both its
 *      evasionCode (both matchers must agree: nothing credited) and its
 *      declaredCode (both matchers must agree: targetId credited).
 *   2. The LIVE repo tree — every real *.test.* file in this repo, scanned
 *      by both matchers, asserting an identical credited-id-set. This is
 *      also this suite's "live testing-os tree" load-bearing test, mirroring
 *      the retired module's own "live tree passes the gate" test.
 *
 * Known, DISCLOSED divergence points are documented in
 * pin-declarations-reference.mjs's own module docstring — this suite's
 * corpus fixtures deliberately stay inside the region both matchers agree is
 * supported, so any disagreement observed here is a genuine bug signal, not
 * a rediscovery of an already-disclosed gap.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanFileForDeclaredPins, defaultWalkTestFiles } from './pin-declarations.mjs';
import { scanFileForDeclaredPinsReference } from './pin-declarations-reference.mjs';
import { PIN_DECLARATION_CORPUS } from './pin-declarations-corpus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function creditedIds(pins) {
  return [...new Set(pins.map((p) => p.id))].sort();
}

test('differential: adversarial corpus — both matchers agree on every evasionCode/declaredCode fixture', () => {
  const mismatches = [];
  for (const entry of PIN_DECLARATION_CORPUS) {
    for (const [variant, code] of [['evasionCode', entry.evasionCode], ['declaredCode', entry.declaredCode]]) {
      const primary = creditedIds(scanFileForDeclaredPins(`${entry.name}.test.js`, code).pins);
      const reference = creditedIds(scanFileForDeclaredPinsReference(`${entry.name}.test.js`, code).pins);
      if (JSON.stringify(primary) !== JSON.stringify(reference)) {
        mismatches.push({ entry: entry.name, variant, primary, reference });
      }
    }
  }
  assert.deepEqual(mismatches, [], `primary and reference matchers disagree on: ${JSON.stringify(mismatches, null, 2)}`);
});

test('differential: metamorphic-mutated corpus fixtures also agree (extends coverage past the un-mutated baseline)', () => {
  const mutators = [
    (code) => `// unrelated note, mentions assert and F-999999-999\n${code}`,
    (code) => `${code}\n/* trailing unrelated note about F-888888-888 */\n`,
  ];
  const mismatches = [];
  for (const entry of PIN_DECLARATION_CORPUS) {
    for (const mutate of mutators) {
      const code = mutate(entry.declaredCode);
      const primary = creditedIds(scanFileForDeclaredPins(`${entry.name}.test.js`, code).pins);
      const reference = creditedIds(scanFileForDeclaredPinsReference(`${entry.name}.test.js`, code).pins);
      if (JSON.stringify(primary) !== JSON.stringify(reference)) {
        mismatches.push({ entry: entry.name, primary, reference });
      }
    }
  }
  assert.deepEqual(mismatches, []);
});

test('differential: live testing-os tree — both matchers compute the same declared-id set across every real test file', () => {
  const files = defaultWalkTestFiles(repoRoot);
  assert.ok(files.length > 100, `expected the real repo to have a substantial test-file corpus, got ${files.length}`);

  const mismatches = [];
  const primaryParseErrors = [];
  for (const file of files) {
    const primary = scanFileForDeclaredPins(file);
    if (primary.parseError) {
      primaryParseErrors.push({ file, error: primary.parseError });
      continue;
    }
    const reference = scanFileForDeclaredPinsReference(file);
    const primaryIds = creditedIds(primary.pins);
    const referenceIds = creditedIds(reference.pins);
    if (JSON.stringify(primaryIds) !== JSON.stringify(referenceIds)) {
      mismatches.push({ file, primaryIds, referenceIds });
    }
  }

  assert.deepEqual(primaryParseErrors, [], `the live tree must parse cleanly under the primary matcher (C7) — see docs/pin-matcher-rewrite.dispatch.md`);
  assert.deepEqual(mismatches, [], `primary/reference disagreement on the live tree: ${JSON.stringify(mismatches, null, 2)}`);
});
