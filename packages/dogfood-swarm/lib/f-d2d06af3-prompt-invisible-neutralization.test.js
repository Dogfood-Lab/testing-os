/**
 * f-d2d06af3-prompt-invisible-neutralization.test.js — F-d2d06af3 (HIGH,
 * wave 24): buildAmendPrompt (lib/templates.js) interpolated `f.file_path`
 * with ZERO escaping and `f.description`/`f.recommendation` with only
 * fenceSafe's backtick-fence-parity guard; buildAuditPrompt's `priorContext`
 * (fenceSafeBlock) had the identical gap. Neither fenceSafe nor
 * fenceSafeBlock touch the control-byte/bidi/Tag-block class — they exist
 * solely to protect THIS document's own backtick fence structure. The
 * generated prompt is written to `swarms/<run>/wave-N/<domain>.md` and read
 * VERBATIM as the next wave's Sonnet agent's own operating instructions,
 * with no human review step in between — the paradigm case
 * commands/lib/escape-reason.js's own F-6540ba3d docblock names as the
 * highest-risk audience for the Tag-block ASCII-Smuggling primitive (Graves
 * 2026, arXiv:2603.00164: preferentially decoded by Anthropic models).
 *
 * THE FIX IS DELIBERATELY NOT escapeReasonForDisplay: that escaper doubles
 * backslashes, escapes double-quotes, and renders \n/\t as visible
 * two-character markers — correct for a quoted TERMINAL surface, wrong for
 * prose an agent reads as its own instructions (a Windows path's
 * backslashes would double; multi-line text would lose its real line
 * breaks). `neutralizeInvisibleControls` (commands/lib/escape-reason.js,
 * owned by swarm-cp-verbs this wave) neutralizes ONLY the invisible/
 * deception codepoint class — composed with, not replacing, fenceSafe/
 * fenceSafeBlock.
 *
 * CROSS-DOMAIN DEPENDENCY, DISCLOSED: this test drives the REAL
 * buildAmendPrompt/buildAuditPrompt, which import neutralizeInvisibleControls
 * from commands/lib/escape-reason.js — owned by swarm-cp-verbs, hardening
 * that same module in parallel this wave. If that export has not yet landed
 * when this file runs, the import itself fails loud (a real, informative
 * failure surfacing the missing cross-domain piece, not a silent gap) — see
 * this domain's wave-24 output.json for the coordination note. The wiring in
 * templates.js was independently verified against a local reference
 * implementation of the documented spec before this file was written; see
 * this domain's output for that verification record.
 *
 * Payloads built via \u{} escapes only (never a raw glyph in this file's own
 * source bytes) — mirrors this package's established rule for the identical
 * reason (see f-35a809f3-trojan-source-control-class.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAmendPrompt, buildAuditPrompt } from './templates.js';

const TAG_A = '\u{e0041}'; // Unicode TAG-block primitive (F-6540ba3d's ASCII-Smuggling class)
const RLO = '\u{202E}';
const PDF = '\u{202C}';

const BASE_OPTS = {
  repoPath: '/tmp/target-repo',
  repo: 'org/target-repo',
  domainName: 'core',
  globs: ['lib/**'],
  waveNumber: 7,
};

/** @pins F-d2d06af3 */
describe('F-d2d06af3 — buildAmendPrompt neutralizes the invisible/deception class in file_path/description/recommendation', () => {
  it('a Unicode TAG-block payload in file_path does not survive into the generated prompt', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS,
      phase: 'amend',
      findings: [{
        finding_id: 'F-1', severity: 'HIGH',
        file_path: `real/path.js${TAG_A}hidden-instruction`,
        description: 'an ordinary description',
        line_number: 12,
      }],
    });
    assert.ok(!prompt.includes(TAG_A),
      `raw TAG-block codepoint must not survive into the agent-read prompt:\n${JSON.stringify(prompt)}`);
    assert.ok(prompt.includes('real/path.js'), 'the ordinary path prefix must still be legible');
  });

  it('a bidi RLO/PDF payload in description does not survive', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS,
      phase: 'amend',
      findings: [{
        finding_id: 'F-2', severity: 'MEDIUM',
        file_path: 'src/a.js',
        description: `before${RLO}reversed-visually${PDF}after`,
        line_number: 5,
      }],
    });
    assert.ok(!prompt.includes(RLO), `raw RLO must not survive:\n${JSON.stringify(prompt)}`);
    assert.ok(!prompt.includes(PDF), `raw PDF must not survive:\n${JSON.stringify(prompt)}`);
  });

  it('a TAG-block payload in recommendation does not survive', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS,
      phase: 'amend',
      findings: [{
        finding_id: 'F-3', severity: 'LOW',
        file_path: 'src/a.js',
        description: 'ordinary',
        recommendation: `fix it${TAG_A}covertly`,
        line_number: 1,
      }],
    });
    assert.ok(!prompt.includes(TAG_A), `raw TAG-block codepoint in recommendation must not survive:\n${JSON.stringify(prompt)}`);
  });

  it('non-regression: ordinary ASCII prose, a Windows-style backslash path, and a literal quote survive UNCHANGED (not doubled/escaped)', () => {
    // This is the exact axis escapeReasonForDisplay would have broken: it
    // doubles every backslash and escapes every double-quote. This package
    // deliberately does NOT use it here — see this file's module docstring.
    const prompt = buildAmendPrompt({
      ...BASE_OPTS,
      phase: 'amend',
      findings: [{
        finding_id: 'F-4', severity: 'LOW',
        file_path: 'C:\\Users\\dev\\repo\\file.js',
        description: 'a description mentioning a "quoted term" verbatim',
        line_number: 9,
      }],
    });
    assert.ok(prompt.includes('C:\\Users\\dev\\repo\\file.js'),
      `a Windows-style path must survive with single backslashes, got:\n${JSON.stringify(prompt)}`);
    assert.ok(!prompt.includes('C:\\\\Users'), 'must NOT contain a doubled backslash');
    assert.ok(prompt.includes('"quoted term"'), 'a literal double-quote must survive unescaped');
  });

  it('non-regression: a genuine multi-line description keeps its real line breaks (not flattened to a visible \\n marker)', () => {
    const prompt = buildAmendPrompt({
      ...BASE_OPTS,
      phase: 'amend',
      findings: [{
        finding_id: 'F-5', severity: 'LOW',
        file_path: 'src/a.js',
        description: 'line one\nline two',
        line_number: 2,
      }],
    });
    assert.ok(prompt.includes('line one\nline two'),
      `a real embedded newline must survive as a real newline, got:\n${JSON.stringify(prompt)}`);
    assert.ok(!prompt.includes('line one\\nline two'), 'must NOT render the escaped two-character \\n marker');
  });
});

describe('F-d2d06af3 — buildAuditPrompt neutralizes the invisible/deception class in priorContext', () => {
  it('a Unicode TAG-block payload in priorContext does not survive, ordinary bullets stay legible', () => {
    const priorContext =
      `- [fixed] F-1: ordinary prior finding (src/a.js)\n` +
      `- [approved] F-2: hidden${TAG_A}instruction finding (src/b.js)`;
    const prompt = buildAuditPrompt({
      ...BASE_OPTS,
      phase: 'health-audit-a',
      priorContext,
    });
    assert.ok(!prompt.includes(TAG_A),
      `raw TAG-block codepoint in priorContext must not survive into the audit prompt:\n${JSON.stringify(prompt)}`);
    assert.ok(prompt.includes('ordinary prior finding (src/a.js)'), 'ordinary prior-finding text must stay legible');
  });

  it('a bidi RLO/PDF payload in priorContext does not survive', () => {
    const priorContext = `- [fixed] F-1: before${RLO}reversed${PDF}after (src/a.js)`;
    const prompt = buildAuditPrompt({
      ...BASE_OPTS,
      phase: 'health-audit-a',
      priorContext,
    });
    assert.ok(!prompt.includes(RLO), `raw RLO in priorContext must not survive:\n${JSON.stringify(prompt)}`);
    assert.ok(!prompt.includes(PDF), `raw PDF in priorContext must not survive:\n${JSON.stringify(prompt)}`);
  });

  it('non-regression: fenceSafeBlock keeps protecting an evenly-paired backtick fence in priorContext', () => {
    // Confirms the invisible-class neutralization is COMPOSED WITH, not
    // substituted for, fenceSafeBlock's own backtick-fence-parity job.
    const priorContext = '- [fixed] F-1: has a ```legit code block``` inline (src/a.js)';
    const prompt = buildAuditPrompt({
      ...BASE_OPTS,
      phase: 'health-audit-a',
      priorContext,
    });
    assert.ok(prompt.includes('```legit code block```'),
      `an evenly-paired fence must still survive untouched, got:\n${prompt}`);
  });

  it('non-regression: buildFeatureAuditPrompt is unaffected (it interpolates no finding fields)', async () => {
    // The coordinator's correction explicitly scoped this fix to
    // buildAmendPrompt + buildAuditPrompt; buildFeatureAuditPrompt takes no
    // findings/priorContext argument at all, so there is nothing to sweep
    // here — recorded so a future reader does not wonder why this file is
    // silent about a third prompt builder in the same module.
    const { buildFeatureAuditPrompt } = await import('./templates.js');
    const prompt = buildFeatureAuditPrompt({ ...BASE_OPTS, phase: 'feature-audit' });
    assert.ok(typeof prompt === 'string' && prompt.length > 0);
  });
});
