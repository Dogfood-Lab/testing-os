/**
 * f-ff624c2e-readme-too-new-retryable-drift.test.js
 *
 * F-ff624c2e (LOW) — CONFIRMING AUDIT of F-51780da9 (wave 22).
 *
 * Wave 22's F-51780da9 fix made packages/ingest/persist.js's
 * isRetryableRejection() conditionally re-derive retryability for a stored
 * CONTRACT_SCHEMA_TOO_NEW: rejection against the CURRENT build's
 * SUPPORTED_SCHEMA_VERSIONS ceiling, instead of trusting a frozen
 * `retryable: false`. The same wave's own sweep found and corrected two
 * stale comments describing the OLD (pre-fix) always-false behavior —
 * packages/verify/index.js's inline comment and
 * packages/verify/parse-rejection.test.js's describe-block comment — but
 * missed a third instance of the identical stale claim: this package's own
 * README.md, whose "Prefix taxonomy" table CONTRACT_SCHEMA_TOO_NEW row
 * still read "...it just always evaluates retryable: false there." That
 * sentence was true before wave 22 and false after it.
 *
 * This test pins the doc fix: the stale claim must not reappear, and the
 * corrected claim — naming the re-derivation mechanism and its trigger —
 * must be present. The behavioral proof that isRetryableRejection() really
 * does conditionally unblock (7 cases, every edge: resolved, still-too-new,
 * malformed, unrecognized-contract, mixed-reasons, sibling prefixes) already
 * lives in
 * packages/ingest/f-51780da9-contract-schema-too-new-upgrade-unblocks.test.js;
 * this file does not re-derive that proof, only holds the README's own
 * words to it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const README = readFileSync(new URL('./README.md', import.meta.url), 'utf-8');

// No @pins tag by design: F-ff624c2e's fix is entirely inside a Markdown doc
// (verify/README.md), which the Class #14 gate does not scan for source-side
// pins — so a declared @pins tag here would be dangling by construction. This
// is a genuine doc-drift regression test (it runs and asserts), it just does
// not participate in the source-code-pin ↔ test-pin invariant, exactly as
// wave 22's F-7d4ac5ce did for a fix that lived entirely in a test file.
describe("F-ff624c2e: verify/README.md's CONTRACT_SCHEMA_TOO_NEW row must not claim isRetryableRejection() is permanently false", () => {
  it('does NOT contain the stale claim that persist.js "just always evaluates retryable: false" for this prefix', () => {
    assert.ok(
      !README.includes('it just always evaluates `retryable: false` there'),
      'F-51780da9 (wave 22) made isRetryableRejection() conditionally re-derive retryability for CONTRACT_SCHEMA_TOO_NEW: — this exact claim describes the OLD, pre-fix behavior and must not appear in the README'
    );
  });

  it('DOES describe the corrected, conditional re-derivation, naming both the mechanism and its trigger', () => {
    // Anchor on the table ROW (starts with the backtick-wrapped prefix as its
    // first cell) — a plain `.includes('CONTRACT_SCHEMA_TOO_NEW:')` search
    // would instead match the CONTRACT_SCHEMA_TOO_OLD: row above it, which
    // mentions this prefix in its own "NOT symmetric with..." cross-reference.
    const row = README.split('\n').find((line) => line.startsWith('| `CONTRACT_SCHEMA_TOO_NEW:`'));
    assert.ok(row, 'expected a CONTRACT_SCHEMA_TOO_NEW: row in the Prefix taxonomy table');
    assert.match(row, /re-derives?/i,
      "the row should describe isRetryableRejection() re-deriving retryability, not a frozen always-false value");
    assert.match(row, /SUPPORTED_SCHEMA_VERSIONS/,
      "the row should name the ceiling isRetryableRejection() re-checks against");
    assert.match(row, /upgrades? testing-os/i,
      "the row should say what actually flips this prefix's retryability: an operator upgrade past the declared major");
  });
});
