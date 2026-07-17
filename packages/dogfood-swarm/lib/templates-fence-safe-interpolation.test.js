/**
 * templates-fence-safe-interpolation.test.js — F-019d40b2: a finding's own
 * description/recommendation text can contain literal ``` sequences (real
 * historical example the finding proved this against: F-de02ea22 [1
 * occurrence] and F-1c99c064 [5 occurrences], both about
 * scripts/check-doc-drift.mjs's own fence-parity logic, from an earlier run).
 *
 * THE BUG. buildAuditPrompt interpolates opts.priorContext, and
 * buildAmendPrompt interpolates each finding's description/recommendation,
 * VERBATIM into a generated markdown prompt with zero escaping. Both sections
 * sit BEFORE the prompt's own worked-example ```json ... ``` fence. A run of
 * 3+ literal backticks is a CommonMark fence marker; an ODD count of them in
 * interpolated prose flips the fence-toggle parity for the REST of the
 * document — the real ```json opener meant to start the worked example gets
 * consumed as the CLOSER for the wrongly-opened fence instead, the
 * worked-example content renders unfenced, and the document ends still
 * "inside" an open fence.
 *
 * THE FIX. templates.js#fenceSafe breaks every run of 3+ backticks in
 * interpolated finding text by interleaving a zero-width space (U+200B)
 * between each backtick. No run of 3+ CONSECUTIVE backtick characters
 * survives, so nothing in the interpolated text can open or close a fence —
 * while the visible text (a zero-width space renders as nothing) is
 * unchanged for a human or an LLM reading it.
 *
 * PROOF METHOD. Mirrors the finding's own method (a top-to-bottom
 * fence-toggle walk over the real generated prompt) rather than relying on
 * one particular extraction regex — endsInsideOpenFence() below counts every
 * contiguous run of 3+ backticks in the whole rendered prompt and checks
 * parity, so this test cannot be fooled by a fix that satisfies only one
 * specific extractor without satisfying the underlying fence-toggle
 * contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuditPrompt, buildAmendPrompt } from './templates.js';

const BASE_OPTS = {
  repoPath: '/tmp/repo',
  repo: 'org/repo',
  domainName: 'backend',
  globs: ['packages/**'],
  ownershipClass: 'owned',
  domainSnapshotId: 'deadbeef',
  waveNumber: 1,
};

/**
 * Every contiguous run of 3+ backticks flips whether the document is
 * "inside" a fence, walking top to bottom. A well-formed document always has
 * an EVEN total (every real fence opens once and closes once); an odd total
 * means the document ends inside an unclosed fence.
 */
function endsInsideOpenFence(text) {
  const markers = text.match(/`{3,}/g) || [];
  return markers.length % 2 === 1;
}

// Shape-equivalent to the two REAL findings (F-de02ea22: 1 occurrence;
// F-1c99c064: 5 occurrences) this defect was proven against — both odd, both
// about check-doc-drift.mjs's own fence-parity logic. Reproduced by shape
// (a stray ``` embedded in ordinary prose), not read from any run's live
// control-plane.db.
const ONE_STRAY_FENCE =
  'check-doc-drift.mjs treats a lone ``` at end of file as still-open and never flags it';
const FIVE_STRAY_FENCES =
  "the drift checker's own fence scan (```/```/```/```/```) never anchors on line start";

describe('buildAuditPrompt — priorContext interpolation is fence-safe (F-019d40b2)', () => {
  it('BASELINE: a clean priorContext ends the prompt outside any open fence', () => {
    const prompt = buildAuditPrompt({
      ...BASE_OPTS, phase: 'health-audit-a',
      priorContext: '- [MEDIUM] F-1: an ordinary finding with no backticks (some/file.js)',
    });
    assert.equal(endsInsideOpenFence(prompt), false, 'a well-formed prompt must end outside any fence');
  });

  it('an ODD count (1) of literal ``` in priorContext no longer flips the document into an unclosed fence', () => {
    const prompt = buildAuditPrompt({
      ...BASE_OPTS, phase: 'health-audit-a',
      priorContext: `- [MEDIUM] F-1: ${ONE_STRAY_FENCE} (scripts/check-doc-drift.mjs)`,
    });
    assert.equal(endsInsideOpenFence(prompt), false,
      'a single stray ``` in prior-findings prose must not corrupt the worked-example fence later in the same prompt');
  });

  it('an ODD count (5) of literal ``` in priorContext no longer flips the document into an unclosed fence', () => {
    const prompt = buildAuditPrompt({
      ...BASE_OPTS, phase: 'health-audit-a',
      priorContext: `- [MEDIUM] F-2: ${FIVE_STRAY_FENCES} (scripts/check-doc-drift.mjs)`,
    });
    assert.equal(endsInsideOpenFence(prompt), false,
      '5 stray ``` sequences (odd) in prior-findings prose must not corrupt the worked-example fence later in the same prompt');
  });

  it('the worked-example JSON block is still literally present and parses after a poisoned priorContext', () => {
    const prompt = buildAuditPrompt({
      ...BASE_OPTS, phase: 'health-audit-a',
      priorContext: `- [MEDIUM] F-1: ${ONE_STRAY_FENCE} (scripts/check-doc-drift.mjs)`,
    });
    const m = /```json\n([\s\S]*?)\n```/.exec(prompt);
    assert.ok(m, 'the real ```json worked-example fence must still be literally present and matchable');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.domain, 'backend');
  });

  it('preserves the readable content of priorContext — only backtick RUNS are touched', () => {
    const prompt = buildAuditPrompt({
      ...BASE_OPTS, phase: 'health-audit-a',
      priorContext: `- [MEDIUM] F-1: ${ONE_STRAY_FENCE} (scripts/check-doc-drift.mjs)`,
    });
    // Strip zero-width spaces before comparing — the escaped text must still
    // read identically to a human/LLM once the invisible marker is ignored.
    // Built from a numeric code point (U+200B), never a pasted literal, so
    // this assertion stays legible and diffable in source control.
    const zeroWidthSpace = String.fromCharCode(8203);
    const visiblyStripped = prompt.split(zeroWidthSpace).join('');
    assert.ok(visiblyStripped.includes(ONE_STRAY_FENCE),
      'the finding text itself must survive verbatim (minus invisible zero-width spaces)');
  });
});

describe('buildAmendPrompt — findings[].description/recommendation interpolation is fence-safe (F-019d40b2)', () => {
  const findingWithStrayFence = {
    finding_id: 'F-1',
    severity: 'MEDIUM',
    description: ONE_STRAY_FENCE,
    file_path: 'scripts/check-doc-drift.mjs',
    line_number: 47,
    recommendation: 'anchor the fence scan on line start',
  };

  it('BASELINE: an ordinary finding list ends the prompt outside any open fence', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{ ...findingWithStrayFence, description: 'an ordinary finding with no backticks' }],
    });
    assert.equal(endsInsideOpenFence(prompt), false);
  });

  it('a finding DESCRIPTION with an ODD count of literal ``` no longer flips the document into an unclosed fence', () => {
    const prompt = buildAmendPrompt({ ...BASE_OPTS, phase: 'health-amend-a', findings: [findingWithStrayFence] });
    assert.equal(endsInsideOpenFence(prompt), false,
      'a single stray ``` in a finding description must not corrupt the worked-example fence later in the same amend prompt');
  });

  it('a finding RECOMMENDATION with an ODD count of literal ``` is also neutralized (the sibling field the finding names)', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{ ...findingWithStrayFence, description: 'clean description', recommendation: FIVE_STRAY_FENCES }],
    });
    assert.equal(endsInsideOpenFence(prompt), false,
      'recommendation is interpolated the same way description is and must get the same fence-safety treatment');
  });

  it('multiple findings in one wave compound correctly — an even TOTAL of stray runs across findings still ends outside any fence', () => {
    // 1 (finding A) + 1 (finding B) = 2 stray runs, already even — this must
    // stay closed both before AND after the fix; it is the fix's own
    // baseline-preservation case, not a new corruption vector.
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [
        { ...findingWithStrayFence, finding_id: 'F-1', description: ONE_STRAY_FENCE },
        { ...findingWithStrayFence, finding_id: 'F-2', description: ONE_STRAY_FENCE },
      ],
    });
    assert.equal(endsInsideOpenFence(prompt), false);
  });

  it('the worked-example JSON block is still literally present and parses after a poisoned finding description', () => {
    const prompt = buildAmendPrompt({ ...BASE_OPTS, phase: 'health-amend-a', findings: [findingWithStrayFence] });
    const m = /```json\n([\s\S]*?)\n```/.exec(prompt);
    assert.ok(m, 'the real ```json worked-example fence must still be literally present and matchable');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.domain, 'backend');
  });
});
