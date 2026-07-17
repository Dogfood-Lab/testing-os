/**
 * f-8e414a2b-findings-loc-symbol-escaping.test.js — F-8e414a2b (HIGH,
 * wave 24): F-c3d8fd7e (wave 22) routed the description/evidence/summary
 * columns of lib/findings-render.js's four table renderers through
 * escapeReasonForDisplay via truncate(), but the FILE:LINE column (`loc`,
 * built directly from `finding.file`/`finding.line`) and the `symbol`
 * column were constructed independently in each of the four functions and
 * never passed through any escaper at all — the identical zero-privilege
 * origin (an audit agent quoting a possibly-adversarial target repo's own
 * filename/symbol verbatim) F-f1dae277 already established for
 * `file_claims.file_path` across commands/*.js.
 *
 * This file drives the REAL, unmutated renderMarkdown / renderText /
 * renderVerifyFixedMarkdown / renderVerifyFixedText — never a
 * reimplementation — with a finding whose `file`/`symbol` carries a raw ANSI
 * cursor-erase sequence (the proven blank-and-overwrite primitive) or a
 * Unicode TAG-block payload (the proven ASCII-Smuggling primitive,
 * F-6540ba3d), and asserts the raw bytes never survive into any of the four
 * text-surface renders while `--format=json` stays byte-for-byte lossless.
 *
 * Payloads built via \u{} escapes only (never a raw glyph in this file's own
 * source bytes) — mirrors f-35a809f3-trojan-source-control-class.test.js's
 * and f-c3d8fd7e's own documented rule for the identical reason.
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
} from './findings-render.js';
import { buildDigestModel } from './findings-digest.js';

const ESC = '\u{1B}';
const RLO = '\u{202E}';
const PDF = '\u{202C}';
const TAG_A = '\u{e0041}'; // Unicode TAG-block "TAG LATIN CAPITAL LETTER A" — F-6540ba3d's ASCII-Smuggling primitive

function ansiForgedFilePayload() {
  return `real/path.js${ESC}[1A${ESC}[2K\rFORGED FILE LINE`;
}

function bidiReversedFilePayload() {
  return `before${RLO}reversed-visually${PDF}after.js`;
}

function tagBlockSymbolPayload() {
  return `doThing${TAG_A}hidden`;
}

function findingsModel(file, symbol) {
  return buildDigestModel('r-loc-esc', 1, [
    {
      domain: 'backend',
      parsed: {
        findings: [
          { id: 'F-001', severity: 'HIGH', file, line: 12, symbol, description: 'ordinary description' },
        ],
      },
    },
  ]);
}

function verifyFixedModel(file, symbol) {
  return {
    schema: 'verify-fixed-delta/v1',
    runId: 'r-loc-esc-vf',
    waveNumber: 1,
    checkedAt: '2026-07-16T00:00:00.000Z',
    summary: { total: 1, verified: 1, regressed: 0, claimedButStillPresent: 0, unverifiable: 0 },
    threshold: 0,
    thresholdExceeded: false,
    exitCode: 0,
    findings: [{
      finding_id: 'F-1', fingerprint: 'fp', classification: 'verified',
      file, line: 42, symbol,
      severity: 'HIGH', description: 'leak', recommendation: 'free',
      evidence: 'ordinary evidence',
      originalFixedWave: 3,
    }],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. ANSI cursor-erase in `file` — the File:Line column
// ═══════════════════════════════════════════════════════════════════════

/** @pins F-8e414a2b */
describe('F-8e414a2b — the File:Line column escapes a raw ANSI cursor-erase sequence in `file`', () => {
  it('renderMarkdown neutralizes the raw ESC bytes in loc', () => {
    const md = renderMarkdown(findingsModel(ansiForgedFilePayload(), undefined));
    assert.ok(!md.includes(ESC), `raw ESC byte must not survive into markdown loc column:\n${JSON.stringify(md)}`);
    assert.ok(md.includes('\\x1b'), `escaped \\x1b marker must be present — proves file reached the escaper:\n${md}`);
  });

  it('renderText neutralizes the raw ESC bytes in loc and does not emit a forged row', () => {
    const txt = renderText(findingsModel(ansiForgedFilePayload(), undefined));
    assert.ok(!txt.includes(ESC), `raw ESC byte must not survive into text loc column:\n${JSON.stringify(txt)}`);
    assert.ok(txt.includes('\\x1b'), `escaped \\x1b marker must be present:\n${txt}`);
  });

  it('renderVerifyFixedMarkdown neutralizes the raw ESC bytes in loc', () => {
    const md = renderVerifyFixedMarkdown(verifyFixedModel(ansiForgedFilePayload(), 'doThing'));
    assert.ok(!md.includes(ESC), `raw ESC byte must not survive into verify-fixed markdown loc column:\n${JSON.stringify(md)}`);
    assert.ok(md.includes('\\x1b'), `escaped marker must be present:\n${md}`);
  });

  it('renderVerifyFixedText neutralizes the raw ESC bytes in loc', () => {
    const txt = renderVerifyFixedText(verifyFixedModel(ansiForgedFilePayload(), 'doThing'));
    assert.ok(!txt.includes(ESC), `raw ESC byte must not survive into verify-fixed text loc column:\n${JSON.stringify(txt)}`);
    assert.ok(txt.includes('\\x1b'), `escaped marker must be present:\n${txt}`);
  });

  it('--format=json stays lossless for findings digest (file/line untouched)', () => {
    const json = renderJson(findingsModel(ansiForgedFilePayload(), undefined));
    const parsed = JSON.parse(json);
    assert.equal(parsed.findings[0].file, ansiForgedFilePayload(),
      'json must carry the raw, unescaped file byte-for-byte');
  });

  it('--format=json stays lossless for verify-fixed delta (the delta model IS the json contract, verbatim)', () => {
    const json = renderVerifyFixedJson(verifyFixedModel(ansiForgedFilePayload(), 'doThing'));
    const parsed = JSON.parse(json);
    assert.equal(parsed.findings[0].file, ansiForgedFilePayload());
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Bidi override in `file` — cannot visually reverse the loc column
// ═══════════════════════════════════════════════════════════════════════

describe('F-8e414a2b — the File:Line column escapes a bidi RLO override in `file`', () => {
  it('renderMarkdown neutralizes the raw bidi override bytes', () => {
    const md = renderMarkdown(findingsModel(bidiReversedFilePayload(), undefined));
    assert.ok(!md.includes(RLO), `raw RLO byte must not survive into markdown loc column:\n${JSON.stringify(md)}`);
    assert.ok(md.includes('\\u202e'), `escaped \\u202e marker must be present:\n${md}`);
  });

  it('renderText neutralizes the raw bidi override bytes', () => {
    const txt = renderText(findingsModel(bidiReversedFilePayload(), undefined));
    assert.ok(!txt.includes(RLO), `raw RLO byte must not survive into text loc column:\n${JSON.stringify(txt)}`);
    assert.ok(!txt.includes(PDF), `raw PDF byte must not survive into text loc column:\n${JSON.stringify(txt)}`);
  });

  it('renderVerifyFixedText neutralizes the raw bidi override bytes in loc', () => {
    const txt = renderVerifyFixedText(verifyFixedModel(bidiReversedFilePayload(), 'doThing'));
    assert.ok(!txt.includes(RLO), `raw RLO byte must not survive into verify-fixed text loc column:\n${JSON.stringify(txt)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Unicode TAG-block (ASCII Smuggling) in `symbol` — verify-fixed renderers only
//    (renderMarkdown/renderText have no symbol column)
// ═══════════════════════════════════════════════════════════════════════

describe('F-8e414a2b — the Symbol column escapes a Unicode TAG-block ASCII-Smuggling payload', () => {
  it('renderVerifyFixedMarkdown neutralizes the raw TAG-block codepoint in symbol', () => {
    const md = renderVerifyFixedMarkdown(verifyFixedModel('src/a.js', tagBlockSymbolPayload()));
    assert.ok(!md.includes(TAG_A), `raw TAG-block codepoint must not survive into markdown symbol column:\n${JSON.stringify(md)}`);
    assert.ok(md.includes('\\u{e0041}'), `escaped \\u{e0041} marker must be present:\n${md}`);
  });

  it('renderVerifyFixedText neutralizes the raw TAG-block codepoint in symbol', () => {
    const txt = renderVerifyFixedText(verifyFixedModel('src/a.js', tagBlockSymbolPayload()));
    assert.ok(!txt.includes(TAG_A), `raw TAG-block codepoint must not survive into text symbol column:\n${JSON.stringify(txt)}`);
    assert.ok(txt.includes('\\u{e0041}'), `escaped marker must be present:\n${txt}`);
  });

  it('--format=json keeps symbol raw and lossless', () => {
    const json = renderVerifyFixedJson(verifyFixedModel('src/a.js', tagBlockSymbolPayload()));
    const parsed = JSON.parse(json);
    assert.equal(parsed.findings[0].symbol, tagBlockSymbolPayload());
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Non-regression — ordinary file/symbol values render exactly as before
// ═══════════════════════════════════════════════════════════════════════

describe('F-8e414a2b — non-regression: ordinary file/symbol text renders unchanged', () => {
  it('an ordinary forward-slash path and line number render as before', () => {
    const md = renderMarkdown(findingsModel('packages/dogfood-swarm/lib/findings-render.js', undefined));
    assert.match(md, /packages\/dogfood-swarm\/lib\/findings-render\.js:12/);
  });

  it('a missing file still renders the em-dash placeholder', () => {
    const md = renderMarkdown(findingsModel(undefined, undefined));
    assert.match(md, /\| — \|/);
  });

  it('an ordinary symbol renders unchanged in verify-fixed tables', () => {
    const md = renderVerifyFixedMarkdown(verifyFixedModel('src/a.js', 'doThing'));
    assert.match(md, /doThing/);
    const missing = renderVerifyFixedMarkdown(verifyFixedModel('src/a.js', undefined));
    assert.match(missing, /\| — \|/);
  });
});
