/**
 * f-c3d8fd7e-findings-render-control-escaping.test.js — F-c3d8fd7e (MEDIUM,
 * wave 22): lib/findings-render.js's shared `truncate(s, n)` helper — the
 * renderer behind `swarm findings <run>` (renderMarkdown/renderText, the
 * description column and the clean-domain summary) AND `swarm verify-fixed`
 * / verify-approved / verify-recurring / verify-unverified's delta renderers
 * (renderVerifyFixedMarkdown/renderVerifyFixedText, the evidence column) —
 * only did `String(s).replace(/\s+/g, ' ').trim()`. `\s` matches a raw
 * embedded newline (incidentally closing fake-line-injection), but ESC
 * (0x1B, the ANSI cursor-erase primitive), the C1 control range, and the
 * Trojan Source class (bidi override/isolate controls, zero-width block,
 * combining marks — Boucher & Anderson, CVE-2021-42574) all pass through
 * completely untouched.
 *
 * A finding's `description`/`recommendation`/evidence text is written by an
 * AUDIT AGENT auditing an arbitrary (sometimes adversarial) target repo and
 * can echo attacker-chosen substrings from it (a crafted filename, commit
 * message, or quoted string a description references verbatim) — a less
 * direct control path than the `--reason` CLI-flag family waves 16-20
 * hardened, which is why this is rated MEDIUM rather than HIGH, consistent
 * with this package's own severity calibration for the fixed instances of
 * this same class.
 *
 * THE FIX: truncate() now escapes through commands/lib/escape-reason.js's
 * escapeReasonForDisplay (the ONE canonical control-byte/bidi escaper this
 * package already ships) BEFORE flattening whitespace and slicing to length
 * — mirroring commands/history.js's own documented "escape BEFORE truncate"
 * ordering. Both renderer families share the one truncate() helper, so
 * fixing it once closes both call-site groups; see findings-render.js's
 * updated header for the layering-seam disclosure (this is the first lib/
 * file to import from commands/).
 *
 * Payloads built via \u{} escapes only (never a raw glyph in this file's own
 * source bytes) — mirrors f-35a809f3-trojan-source-control-class.test.js's
 * own documented rule for the identical reason: a source file in THIS repo
 * should not itself carry a hidden bidi-override/zero-width payload.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderMarkdown,
  renderText,
  renderJson,
  renderVerifyFixedMarkdown,
  renderVerifyFixedText,
  renderVerifyFixedJson,
} from './lib/findings-render.js';
import { buildDigestModel } from './lib/findings-digest.js';

const ESC = '\u{1B}';
const RLO = '\u{202E}'; // RIGHT-TO-LEFT OVERRIDE — bidi embedding class
const PDF = '\u{202C}'; // POP DIRECTIONAL FORMATTING — closes the RLO scope

/** Mirrors the finding's own live reproduction against truncate(). */
function ansiForgedLinePayload() {
  const forgedRow = '| CRIT | F-666 | evil-domain | pwn.js:1 | totally legit forged row |';
  return `legit text ${ESC}[1A${ESC}[2K\r${forgedRow}`;
}

function bidiReversedPayload() {
  return `before${RLO}reversed-visually${PDF}after`;
}

function findingsModel(description) {
  return buildDigestModel('r-esc', 1, [
    {
      domain: 'backend',
      parsed: {
        findings: [
          { id: 'F-001', severity: 'HIGH', file: 'src/a.js', line: 12, description },
        ],
      },
    },
  ]);
}

function cleanDomainModel(summary) {
  return buildDigestModel('r-esc-clean', 1, [
    { domain: 'docs', parsed: { findings: [], summary } },
  ]);
}

function verifyFixedModel(evidence) {
  return {
    schema: 'verify-fixed-delta/v1',
    runId: 'r-esc-vf',
    waveNumber: 1,
    checkedAt: '2026-07-16T00:00:00.000Z',
    summary: { total: 1, verified: 1, regressed: 0, claimedButStillPresent: 0, unverifiable: 0 },
    threshold: 0,
    thresholdExceeded: false,
    exitCode: 0,
    findings: [{
      finding_id: 'F-1', fingerprint: 'fp', classification: 'verified',
      file: 'src/a.js', line: 42, symbol: 'doThing',
      severity: 'HIGH', description: 'leak', recommendation: 'free',
      evidence,
      originalFixedWave: 3,
    }],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. ANSI cursor-erase forged-line proof — description column
// ═══════════════════════════════════════════════════════════════════════

/** @pins F-c3d8fd7e */
describe('F-c3d8fd7e — ANSI cursor-erase (ESC[1A ESC[2K) cannot forge/erase a line via description', () => {
  it('renderMarkdown neutralizes the raw ESC bytes', () => {
    const md = renderMarkdown(findingsModel(ansiForgedLinePayload()));
    assert.ok(!md.includes(ESC), `raw ESC byte must not survive into markdown output:\n${JSON.stringify(md)}`);
    assert.ok(md.includes('\\x1b'), `escaped \\x1b marker must be present — proves the value reached truncate():\n${md}`);
  });

  it('renderText neutralizes the raw ESC bytes and does not emit a forged row', () => {
    const txt = renderText(findingsModel(ansiForgedLinePayload()));
    assert.ok(!txt.includes(ESC), `raw ESC byte must not survive into text output:\n${JSON.stringify(txt)}`);
    assert.ok(txt.includes('\\x1b'), `escaped \\x1b marker must be present:\n${txt}`);
    // The forged row must not become its own genuine-looking table line —
    // it must appear only inline, escaped, as part of the ONE real finding row.
    const forgedLine = '| CRIT | F-666 | evil-domain | pwn.js:1 | totally legit forged row |';
    assert.ok(!txt.split('\n').some((l) => l.trim() === forgedLine),
      `the injected payload must not become its own real output line:\n${txt}`);
  });

  it('--format=json stays lossless (truncate() is never on the json path)', () => {
    const json = renderJson(findingsModel(ansiForgedLinePayload()));
    const parsed = JSON.parse(json);
    assert.equal(parsed.findings[0].description, ansiForgedLinePayload(),
      'json must carry the raw, unescaped, untruncated description byte-for-byte');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Trojan Source (bidi override) proof — description column
// ═══════════════════════════════════════════════════════════════════════

describe('F-c3d8fd7e — bidi RLO override cannot visually reverse rendered description text', () => {
  it('renderMarkdown neutralizes the raw bidi override bytes', () => {
    const md = renderMarkdown(findingsModel(bidiReversedPayload()));
    assert.ok(!md.includes(RLO), `raw RLO byte must not survive into markdown output:\n${JSON.stringify(md)}`);
    assert.ok(md.includes('\\u202e'), `escaped \\u202e marker must be present:\n${md}`);
  });

  it('renderText neutralizes the raw bidi override bytes', () => {
    const txt = renderText(findingsModel(bidiReversedPayload()));
    assert.ok(!txt.includes(RLO), `raw RLO byte must not survive into text output:\n${JSON.stringify(txt)}`);
    assert.ok(!txt.includes(PDF), `raw PDF byte must not survive into text output:\n${JSON.stringify(txt)}`);
    assert.ok(txt.includes('\\u202e'), `escaped \\u202e marker must be present:\n${txt}`);
  });

  it('--format=json stays lossless', () => {
    const json = renderJson(findingsModel(bidiReversedPayload()));
    const parsed = JSON.parse(json);
    assert.equal(parsed.findings[0].description, bidiReversedPayload());
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Clean-domain summary column shares the same truncate() call site
// ═══════════════════════════════════════════════════════════════════════

describe('F-c3d8fd7e — clean-domain summary text is escaped the same way', () => {
  it('renderMarkdown neutralizes a malicious clean-domain summary', () => {
    const md = renderMarkdown(cleanDomainModel(`all good${ESC}[2Kbut not really`));
    assert.ok(!md.includes(ESC), `raw ESC byte must not survive in the clean-domains section:\n${JSON.stringify(md)}`);
    assert.ok(md.includes('\\x1b'), `escaped marker must be present:\n${md}`);
  });

  it('renderText neutralizes a malicious clean-domain summary', () => {
    const txt = renderText(cleanDomainModel(`all good${RLO}reversed${PDF}`));
    assert.ok(!txt.includes(RLO), `raw RLO byte must not survive in the clean-domains section:\n${JSON.stringify(txt)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. verify-fixed / verify-approved delta renderers share the SAME
//    truncate() helper via the evidence column — proving the class fix,
//    not just the one call site the finding named directly.
// ═══════════════════════════════════════════════════════════════════════

describe('F-c3d8fd7e — the verify-fixed delta renderers (evidence column) share the fixed truncate()', () => {
  it('renderVerifyFixedMarkdown neutralizes raw ESC bytes in evidence', () => {
    const md = renderVerifyFixedMarkdown(verifyFixedModel(ansiForgedLinePayload()));
    assert.ok(!md.includes(ESC), `raw ESC byte must not survive into verify-fixed markdown:\n${JSON.stringify(md)}`);
    assert.ok(md.includes('\\x1b'), `escaped marker must be present:\n${md}`);
  });

  it('renderVerifyFixedText neutralizes raw bidi bytes in evidence', () => {
    const txt = renderVerifyFixedText(verifyFixedModel(bidiReversedPayload()));
    assert.ok(!txt.includes(RLO), `raw RLO byte must not survive into verify-fixed text:\n${JSON.stringify(txt)}`);
    assert.ok(txt.includes('\\u202e'), `escaped marker must be present:\n${txt}`);
  });

  it('renderVerifyFixedJson stays lossless (the delta model IS the json contract, verbatim)', () => {
    const json = renderVerifyFixedJson(verifyFixedModel(ansiForgedLinePayload()));
    const parsed = JSON.parse(json);
    assert.equal(parsed.findings[0].evidence, ansiForgedLinePayload());
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Non-regression — ordinary text is untouched by the fix
// ═══════════════════════════════════════════════════════════════════════

describe('F-c3d8fd7e — non-regression: ordinary description text renders exactly as before', () => {
  it('plain ASCII prose survives verbatim through markdown and text', () => {
    const md = renderMarkdown(findingsModel('a critical thing exploded in the parser'));
    const txt = renderText(findingsModel('a critical thing exploded in the parser'));
    assert.match(md, /a critical thing exploded in the parser/);
    assert.match(txt, /a critical thing exploded in the parser/);
  });

  it('multiple internal spaces still collapse to one (whitespace-flatten behaviour preserved)', () => {
    const md = renderMarkdown(findingsModel('too    many     spaces'));
    assert.match(md, /too many spaces/);
    assert.doesNotMatch(md, /too    many/);
  });

  it('long descriptions still truncate with an ellipsis at the same visible budget', () => {
    const long = 'x'.repeat(200);
    const md = renderMarkdown(findingsModel(long));
    assert.ok(md.includes('…'), 'a 200-char description must still be truncated with an ellipsis');
    assert.ok(!md.includes('x'.repeat(200)), 'the full 200-char run must not survive untruncated');
  });
});
