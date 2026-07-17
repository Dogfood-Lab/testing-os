/**
 * templates-fence-safe-concatenation.test.js — F-62e467be: fenceSafe's
 * odd/even backtick-run PARITY check (F-01458fdb) is trustworthy for ONE
 * contiguous piece of authored prose, where an even total really does mean
 * "one legitimate opening fence, one legitimate closing fence." But
 * buildAuditPrompt never hands fenceSafe one finding's text — its only
 * caller, commands/dispatch.js, joins EVERY prior finding's raw description
 * into a single multi-line blob (one bullet line per finding,
 * `- [status] finding_id: description (file)`) BEFORE templates.js ever
 * sees it (dispatch.js:488-496). Two INDEPENDENT findings can each carry
 * their own odd (individually-hazardous) backtick-run count that happens to
 * SUM to an even total, and the old single fenceSafe(wholeBlob) call would
 * then trust the region between them as "closed" — even though a real
 * top-to-bottom CommonMark reader renders every OTHER finding sandwiched
 * between the two stray runs as if it were inside an open code fence.
 *
 * THE FIX. templates.js#fenceSafeBlock recovers the per-finding boundary
 * dispatch.js's own bullet format already encodes (a chunk starts at every
 * line beginning with `- [`) and applies the EXISTING fenceSafe parity check
 * to EACH CHUNK independently — the same unit buildAmendPrompt already uses
 * without this problem (it never concatenates findings before calling
 * fenceSafe). buildAuditPrompt's priorSection now calls fenceSafeBlock
 * instead of fenceSafe directly.
 *
 * PROOF METHOD. Mirrors the finding's own method and the sibling fence-safe
 * test files: a top-to-bottom fence-toggle walk over the REAL generated
 * prompt (via buildAuditPrompt, never fenceSafe/fenceSafeBlock directly —
 * both are module-private by design). isInsideFenceAt goes one step further
 * than the sibling files' endsInsideOpenFence: it proves the SANDWICHED
 * finding's own text is never "inside" a fence AT ITS OWN POSITION, not just
 * that the document eventually ends outside one — the old bug's signature
 * was an even TOTAL (document ends closed) while the MIDDLE content was
 * still provably swallowed.
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

/** Mirrors templates-fence-safe-parity.test.js's own top-to-bottom toggle walker. */
function endsInsideOpenFence(text) {
  const markers = text.match(/`{3,}/g) || [];
  return markers.length % 2 === 1;
}

/**
 * Whether the toggle is "inside a fence" at the given character index — a
 * walk that stops partway through the document rather than running to the
 * end. Used to prove a specific finding's own text was never swallowed by an
 * unrelated pair of stray markers straddling it, which endsInsideOpenFence
 * alone cannot show (an even TOTAL can still hide an open span in the
 * middle).
 */
function isInsideFenceAt(text, index) {
  const markersBefore = (text.slice(0, index).match(/`{3,}/g) || []).length;
  return markersBefore % 2 === 1;
}

/** Builds a dispatch.js-shaped priorContext blob: one `- [status] id: desc (file)` bullet per line, exactly like commands/dispatch.js:488-496. */
function buildPriorContext(findings) {
  return findings
    .map((f) => `- [${f.status}] ${f.finding_id}: ${f.description} (${f.file || '?'})`)
    .join('\n');
}

describe('fenceSafeBlock via buildAuditPrompt — two independently-odd findings no longer cancel out (F-62e467be)', () => {
  it('a plain finding sandwiched between two individually-odd-backtick findings is never rendered inside a fake open fence', () => {
    const findings = [
      { status: 'new', finding_id: 'F-aaaaaaaa', file: 'src/a.js', description: 'a lone ``` stray marker, never closed within this finding' },
      { status: 'recurring', finding_id: 'F-bbbbbbbb', file: 'src/b.js', description: 'an entirely unrelated, ordinary finding with no backticks at all' },
      { status: 'new', finding_id: 'F-cccccccc', file: 'src/c.js', description: 'another lone ``` stray marker, also never closed within this finding' },
    ];
    const priorContext = buildPriorContext(findings);

    // Fixture sanity: exactly 2 backtick runs total in the raw blob (even) —
    // this is precisely the shape that fooled the old whole-blob parity
    // check (F-aaaaaaaa contributes 1, F-cccccccc contributes 1, F-bbbbbbbb
    // contributes 0; 1+0+1 = 2, even).
    assert.equal((priorContext.match(/`{3,}/g) || []).length, 2,
      'fixture sanity: the raw blob has an EVEN total run count from two INDEPENDENT odd contributors');

    const prompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a', priorContext });

    const bIndex = prompt.indexOf('F-bbbbbbbb');
    assert.ok(bIndex > -1, 'the sandwiched finding must be present in the generated prompt');
    assert.equal(isInsideFenceAt(prompt, bIndex), false,
      'the sandwiched finding must NOT be rendered inside an open fence — this is the exact defect the old aggregate-parity check missed');

    assert.equal(endsInsideOpenFence(prompt), false, 'the document must still end outside any open fence');
  });

  it('the worked-example JSON block still parses after the two-odd-findings blob', () => {
    const findings = [
      { status: 'new', finding_id: 'F-aaaaaaaa', file: 'src/a.js', description: 'a lone ``` stray marker' },
      { status: 'recurring', finding_id: 'F-bbbbbbbb', file: 'src/b.js', description: 'ordinary, no backticks' },
      { status: 'new', finding_id: 'F-cccccccc', file: 'src/c.js', description: 'another lone ``` stray marker' },
    ];
    const prompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a', priorContext: buildPriorContext(findings) });

    const m = /```json\n([\s\S]*?)\n```/.exec(prompt);
    assert.ok(m, 'the real ```json worked-example fence must still be literally present and matchable');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.domain, 'backend');
  });

  it('generalizes beyond exactly two: FOUR independently-odd findings (even total) sandwiching two plain findings', () => {
    const findings = [
      { status: 'new', finding_id: 'F-11111111', file: 'src/1.js', description: 'stray ``` one' },
      { status: 'recurring', finding_id: 'F-22222222', file: 'src/2.js', description: 'plain finding, no backticks, sandwiched between hazards one and two' },
      { status: 'new', finding_id: 'F-33333333', file: 'src/3.js', description: 'stray ``` two' },
      { status: 'unverified', finding_id: 'F-44444444', file: 'src/4.js', description: 'stray ``` three' },
      { status: 'recurring', finding_id: 'F-55555555', file: 'src/5.js', description: 'another plain finding, sandwiched between hazards three and four' },
      { status: 'new', finding_id: 'F-66666666', file: 'src/6.js', description: 'stray ``` four' },
    ];
    const priorContext = buildPriorContext(findings);
    assert.equal((priorContext.match(/`{3,}/g) || []).length, 4, 'fixture sanity: 4 independent odd contributors sum to an even total');

    const prompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a', priorContext });

    for (const id of ['F-22222222', 'F-55555555']) {
      const idx = prompt.indexOf(id);
      assert.ok(idx > -1);
      assert.equal(isInsideFenceAt(prompt, idx), false, `${id} must not be swallowed by any neighboring pair of stray markers`);
    }
    assert.equal(endsInsideOpenFence(prompt), false);
  });

  it('a genuinely well-formed, evenly-paired fenced example WITHIN one finding still survives byte-identical among other findings (F-01458fdb protection preserved at the chunk level)', () => {
    const LEGITIMATE_CODE_EXAMPLE =
      'Guard the lookup:\n```js\nif (!row) return null;\n```\nThen re-run the suite.';
    const findings = [
      { status: 'new', finding_id: 'F-aaaaaaaa', file: 'src/a.js', description: 'an ordinary finding with no backticks' },
      { status: 'recurring', finding_id: 'F-bbbbbbbb', file: 'src/lookup.js', description: LEGITIMATE_CODE_EXAMPLE },
      { status: 'new', finding_id: 'F-cccccccc', file: 'src/c.js', description: 'another ordinary finding with no backticks' },
    ];
    const prompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a', priorContext: buildPriorContext(findings) });

    assert.ok(prompt.includes(LEGITIMATE_CODE_EXAMPLE),
      'a legitimate paired fenced example inside ONE finding, among several findings in the same blob, must survive byte-identical — chunking must not re-break what F-01458fdb already fixed');
    assert.equal(endsInsideOpenFence(prompt), false);
  });

  it('BASELINE: multiple entirely clean findings (no backticks anywhere) render unchanged', () => {
    const findings = [
      { status: 'new', finding_id: 'F-aaaaaaaa', file: 'src/a.js', description: 'clean finding one' },
      { status: 'recurring', finding_id: 'F-bbbbbbbb', file: 'src/b.js', description: 'clean finding two' },
      { status: 'fixed', finding_id: 'F-cccccccc', file: 'src/c.js', description: 'clean finding three' },
    ];
    const priorContext = buildPriorContext(findings);
    const prompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a', priorContext });
    assert.ok(prompt.includes(priorContext), 'a hazard-free multi-finding blob must pass through fenceSafeBlock byte-identical');
  });

  it('a single-finding priorContext (no `- [` boundary beyond the first) behaves exactly as before — regression guard on buildAmendPrompt-style single-field calls elsewhere in this module', () => {
    // buildAmendPrompt's findingsList mapping calls fenceSafe per-field
    // directly (never fenceSafeBlock) — unaffected by this fix. This test
    // only guards that fenceSafeBlock's single-chunk path (no interior `- [`
    // boundary) is behaviorally identical to a bare fenceSafe call, which is
    // what buildAuditPrompt now always goes through.
    const prompt = buildAmendPrompt({
      ...BASE_OPTS, phase: 'health-amend-a',
      findings: [{ finding_id: 'F-1', severity: 'MEDIUM', description: 'ok', recommendation: 'a lone ``` stray marker' }],
    });
    assert.equal(endsInsideOpenFence(prompt), false);
  });
});
