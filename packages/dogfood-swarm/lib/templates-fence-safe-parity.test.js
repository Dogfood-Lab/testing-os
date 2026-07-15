/**
 * templates-fence-safe-parity.test.js — F-01458fdb: fenceSafe's docstring
 * claimed its zero-width-space interleave leaves interpolated text "unchanged
 * ... for a human or an LLM reading it" while neutralizing fence-parity
 * attacks — but it transformed EVERY run of 3+ backticks unconditionally,
 * regardless of whether the run count in the text was odd (the real hazard)
 * or even (already self-closes under CommonMark). Rendering both directions
 * against a real CommonMark+GFM engine showed they are ASYMMETRIC:
 *
 *   NEUTRALIZATION (odd count) held, but LEGITIMATE CONTENT (even count) was
 *   PROVABLY MANGLED — a well-formed fenced code example inside a finding's
 *   recommendation (an unconstrained free-form string, no length cap, no
 *   content restriction — agent-output.schema.json) rendered correctly as
 *   `<pre><code>` BEFORE fenceSafe and as garbled inline `<code>` spans with
 *   the language tag leaking into visible text AFTER fenceSafe. This is a
 *   NEW cost fenceSafe introduced, not a pre-existing gap it merely failed to
 *   fix — an LLM-authored recommendation naturally suggests multi-line code
 *   fixes, exactly the shape that got mangled.
 *
 * THE FIX. fenceSafe now checks the text's total backtick-run parity FIRST:
 * an EVEN count (the common legitimate shape — one opening fence, one
 * closing fence) is left completely untouched; only an ODD count (a stray,
 * unpaired run — the actual fence-parity hazard) is transformed, exactly as
 * before. Not the same finding as the already-approved F-019d40b2 (which
 * covers only the attack-neutralization direction and never claimed the
 * legitimate-content direction was safe) — this file pins the direction
 * F-019d40b2's own coverage (templates-fence-safe-interpolation.test.js)
 * never exercised: a single interpolated FIELD containing an evenly-paired
 * fenced example.
 *
 * Both directions pinned per this package's gate non-vacuity convention:
 *   1. a well-formed, evenly-paired fenced code example survives byte-
 *      identical (no longer mangled).
 *   2. a stray, unpaired (odd-count) fence is still neutralized — the
 *      attack-neutralization direction F-019d40b2 already proved is
 *      unchanged by this narrowing.
 *
 * PROOF METHOD. Tested through the public builders (buildAuditPrompt /
 * buildAmendPrompt) exactly like templates-fence-safe-interpolation.test.js
 * — fenceSafe itself is module-private by design (every interpolation site
 * must route through the SAME function; exporting it would invite a second,
 * undisciplined call site). endsInsideOpenFence mirrors that sibling file's
 * own top-to-bottom fence-toggle walker rather than a fixed extraction
 * regex, so this test cannot be fooled by a fix that satisfies only one
 * specific reader without satisfying the underlying fence-toggle contract.
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

// Shape-equivalent to the finding's own worked example: ONE well-formed
// fenced JS snippet inside a recommendation — the overwhelmingly common
// legitimate case (2 backtick runs: one opener, one closer — EVEN).
const LEGITIMATE_CODE_EXAMPLE =
  'Guard the lookup:\n```js\nif (!row) return null;\n```\nThen re-run the suite.';

// A stray, UNPAIRED run (1 occurrence — ODD) — the actual fence-parity
// hazard, shape-equivalent to F-de02ea22's real 1-occurrence proof.
const ODD_STRAY_FENCE = 'a lone ``` mid-sentence, never closed, unlike a real fence';

describe('fenceSafe — an evenly-paired fenced code example survives readable (F-01458fdb)', () => {
  it('a well-formed fenced JS example in a RECOMMENDATION is byte-identical after buildAmendPrompt — no longer mangled', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{
        finding_id: 'F-1', severity: 'MEDIUM',
        description: 'missing null check',
        file_path: 'src/lookup.js', line_number: 10,
        recommendation: LEGITIMATE_CODE_EXAMPLE,
      }],
    });
    assert.ok(prompt.includes(LEGITIMATE_CODE_EXAMPLE),
      'an evenly-paired fenced code example must survive byte-identical — fenceSafe must not fire on an EVEN backtick-run count');
  });

  it('a well-formed fenced JS example in a DESCRIPTION is byte-identical after buildAmendPrompt', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{
        finding_id: 'F-1', severity: 'MEDIUM',
        description: LEGITIMATE_CODE_EXAMPLE,
        file_path: 'src/lookup.js', line_number: 10,
      }],
    });
    assert.ok(prompt.includes(LEGITIMATE_CODE_EXAMPLE),
      'description gets the identical fence-safety treatment as recommendation — both must preserve a legitimate paired example');
  });

  it('a well-formed fenced example in priorContext is byte-identical after buildAuditPrompt', () => {
    const prompt = buildAuditPrompt({
      ...BASE_OPTS, phase: 'health-audit-a',
      priorContext: `- [MEDIUM] F-1: ${LEGITIMATE_CODE_EXAMPLE} (src/lookup.js)`,
    });
    assert.ok(prompt.includes(LEGITIMATE_CODE_EXAMPLE));
  });

  it('the document still ends outside any open fence — an even count from the finding PLUS the worked-example fence stays even overall', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{
        finding_id: 'F-1', severity: 'MEDIUM', description: 'x',
        recommendation: LEGITIMATE_CODE_EXAMPLE,
      }],
    });
    assert.equal(endsInsideOpenFence(prompt), false);
  });

  it('the worked-example JSON block is still literally present and parses alongside an untouched legitimate example', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{ finding_id: 'F-1', severity: 'MEDIUM', description: 'x', recommendation: LEGITIMATE_CODE_EXAMPLE }],
    });
    const m = /```json\n([\s\S]*?)\n```/.exec(prompt);
    assert.ok(m, 'the real ```json worked-example fence must still be literally present and matchable');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.domain, 'backend');
  });
});

describe('fenceSafe — an odd (unpaired) stray fence is still neutralized (F-01458fdb narrowing does not weaken F-019d40b2)', () => {
  it('an ODD-count stray fence in a recommendation no longer survives literally — still neutralized', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{
        finding_id: 'F-1', severity: 'MEDIUM', description: 'ok',
        recommendation: ODD_STRAY_FENCE,
      }],
    });
    assert.ok(!prompt.includes(ODD_STRAY_FENCE),
      'an odd (unpaired) run is the actual hazard and must still be transformed — narrowing to parity must not weaken the existing attack protection');
    assert.equal(endsInsideOpenFence(prompt), false,
      'a stray odd fence must not corrupt the worked-example fence later in the same prompt');
  });

  it('an ODD-count stray fence in priorContext is still neutralized via buildAuditPrompt', () => {
    const prompt = buildAuditPrompt({
      ...BASE_OPTS, phase: 'health-audit-a',
      priorContext: `- [MEDIUM] F-1: ${ODD_STRAY_FENCE} (scripts/check-doc-drift.mjs)`,
    });
    assert.equal(endsInsideOpenFence(prompt), false);
  });

  it('an ODD total (3 runs: one legitimate pair PLUS one stray extra) is still transformed — a mixed hazard is not silently trusted', () => {
    const mixed = `${LEGITIMATE_CODE_EXAMPLE}\nand also a stray \`\`\` for good measure`;
    // Fixture sanity: 3 runs total (odd) in the raw text.
    assert.equal((mixed.match(/`{3,}/g) || []).length, 3);

    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{ finding_id: 'F-1', severity: 'MEDIUM', description: 'ok', recommendation: mixed }],
    });
    assert.equal(endsInsideOpenFence(prompt), false,
      'an odd TOTAL run count in one field is a genuine hazard (the pair cannot be trusted in isolation) and must still be neutralized');
  });
});
