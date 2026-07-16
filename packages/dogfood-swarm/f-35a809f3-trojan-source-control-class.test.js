/**
 * f-35a809f3-trojan-source-control-class.test.js — F-35a809f3 (HIGH, wave 20):
 * escapeReasonForDisplay's CONTROL_CLASS (commands/lib/escape-reason.js)
 * covered every codepoint that changes WHERE text appears (C0/C1 controls,
 * the Unicode line/paragraph separators) but missed codepoints that change
 * HOW already-placed text is DISPLAYED — the "Trojan Source" class
 * (Boucher & Anderson, CVE-2021-42574): Unicode bidi embedding/override
 * controls (U+202A-U+202E), bidi isolates (U+2066-U+2069), bidi marks
 * (U+200E-U+200F) and the Arabic Letter Mark (U+061C); the zero-width/
 * invisible block (U+200B-U+200D) and BOM/ZWNBSP (U+FEFF); and the Combining
 * Diacritical Marks block (U+0300-U+036F, unbounded "zalgo" stacking). Fixed
 * by widening CONTROL_CLASS to cover each as a codepoint RANGE.
 *
 * Two obligations pinned here, both against the REAL exported
 * escapeReasonForDisplay (never a reimplementation):
 *   1. A representative codepoint from EACH newly-covered class is neutralized.
 *   2. A boundary probe proves the widened ranges are exact, not over-broad:
 *      the codepoint immediately OUTSIDE each new range must pass through
 *      untouched, and ordinary ASCII / precomposed-accented / CJK / emoji
 *      text must survive completely intact.
 * Plus the module's own documented invariant — --format=json stays lossless
 * — driven through the real production data path: a real wave_state_events
 * row (the same shape `swarm rewind`/`swarm revalidate` write) read back by
 * BOTH history() (the exact object cli.js's --format=json branch
 * JSON.stringifies with zero escaping) and formatHistory() (the text table,
 * which must escape), so the same payload is proven both ways from one seed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { escapeReasonForDisplay } from './commands/lib/escape-reason.js';
import { openDb, closeDb } from './db/connection.js';
import { history, formatHistory } from './commands/history.js';

// One representative codepoint per newly-covered class (dispatch F-35a809f3).
const NEUTRALIZED_CLASS_REPRESENTATIVES = [
  { label: 'RLO — bidi override (U+202E)', cp: 0x202e },
  { label: 'LRI — bidi isolate (U+2066)', cp: 0x2066 },
  { label: 'LRM — bidi mark (U+200E)', cp: 0x200e },
  { label: 'ALM — Arabic Letter Mark (U+061C)', cp: 0x061c },
  { label: 'ZWSP — zero-width space (U+200B)', cp: 0x200b },
  { label: 'BOM/ZWNBSP (U+FEFF)', cp: 0xfeff },
  { label: 'combining acute accent (U+0301, zalgo stacking)', cp: 0x0301 },
];

// [codepoint, expectEscaped] pairs bracketing every widened range's edges —
// proves the range boundaries themselves, not just "some character in the
// neighborhood works". `false` entries are the over-broad check: a
// widening bug that accidentally shifted a range by one codepoint would flip
// one of these from pass-through to escaped (or vice-versa) and this table
// would catch it.
const BOUNDARY_CODEPOINTS = [
  [0x061b, false], [0x061c, true], [0x061d, false], // ALM, single codepoint
  [0x200a, false], [0x200b, true], [0x200f, true], [0x2010, false], // ZW block + bidi marks
  [0x2029, true], [0x202a, true], [0x202e, true], [0x202f, false], // paragraph-sep (wave 18) + bidi embedding block
  [0x2065, false], [0x2066, true], [0x2069, true], [0x206a, false], // bidi isolates
  [0xfefe, false], [0xfeff, true], [0xff00, false], // BOM/ZWNBSP
  [0x02ff, false], [0x0300, true], [0x036f, true], [0x0370, false], // combining diacritical marks
];

/** @pins F-35a809f3 */
describe('F-35a809f3 — CONTROL_CLASS widened to cover Trojan Source + zero-width + combining marks', () => {
  it('neutralizes a representative codepoint from each newly-covered class', () => {
    for (const { label, cp } of NEUTRALIZED_CLASS_REPRESENTATIVES) {
      const ch = String.fromCodePoint(cp);
      const out = escapeReasonForDisplay(`before${ch}after`);
      const hex = cp.toString(16).padStart(4, '0');
      assert.ok(!out.includes(ch), `${label} must not survive unescaped — got "${out}"`);
      assert.ok(out.includes(`\\u${hex}`), `${label} must render as its literal \\u${hex} escape — got "${out}"`);
    }
  });

  it('boundary probe: every new range edge is exact — the codepoint just outside is untouched, just inside is escaped', () => {
    for (const [cp, shouldEscape] of BOUNDARY_CODEPOINTS) {
      const ch = String.fromCodePoint(cp);
      const hex = cp.toString(16);
      const out = escapeReasonForDisplay(`x${ch}y`);
      if (shouldEscape) {
        assert.ok(!out.includes(ch), `U+${hex} must be escaped (inside a widened range) — found unescaped in "${out}"`);
      } else {
        assert.equal(out, `x${ch}y`, `U+${hex} must pass through UNTOUCHED (just outside a widened range) — the range must not be over-broad`);
      }
    }
  });

  it('boundary probe: ordinary ASCII, precomposed-accented Latin, CJK, and emoji all survive completely intact', () => {
    assert.equal(escapeReasonForDisplay('rollback completed cleanly'), 'rollback completed cleanly');
    // café/résumé/naïve use PRECOMPOSED codepoints (U+00E9, U+00EF) — a single
    // codepoint OUTSIDE the combining-marks range (U+0300-U+036F), not a
    // base letter plus a combining accent. Confirms the range does not
    // over-reach into ordinary accented text.
    assert.equal(escapeReasonForDisplay('café résumé naïve'), 'café résumé naïve');
    assert.equal(escapeReasonForDisplay('日本語のテキストです'), '日本語のテキストです');
    assert.equal(escapeReasonForDisplay('deploy succeeded 🎉🚀'), 'deploy succeeded 🎉🚀');
  });
});

/** @pins F-35a809f3 */
describe('F-35a809f3 — --format=json stays lossless while the text render escapes (real DB write + read)', () => {
  let tempDir, dbPath, waveId;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'f-35a809f3-'));
    dbPath = join(tempDir, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', tempDir, 'a'.repeat(40));
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES ('r1', 'health-audit-a', 1, 'collected')",
    ).run();
    waveId = Number(wave.lastInsertRowid);
    // Direct insert into wave_state_events — the exact durable shape `swarm
    // rewind`/`swarm revalidate`/transitionWave() write, and the exact shape
    // history()/formatHistory() read. Bypassing the state-machine's own
    // transition-legality checks is deliberate here: this test's concern is
    // the RENDER path, not transition legality (already covered elsewhere).
    //
    // Built via \u{} escapes only (never a raw glyph in this file's own
    // source bytes) — mirroring scratchpad probe-bidi-cli.mjs's own rule, so
    // this test file does not itself carry hidden bidi/zero-width control
    // bytes.
    db.prepare(
      'INSERT INTO wave_state_events (wave_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)',
    ).run(waveId, 'dispatched', 'collected', buildMaliciousReason());
    closeDb(dbPath);
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  });

  it('history() (the --format=json data source) carries the RAW reason byte-for-byte; formatHistory() (text) neutralizes it', () => {
    const maliciousReason = buildMaliciousReason();
    const report = history({ waveId, dbPath });

    // JSON path: cli.js's cmdHistory --format=json branch does
    // `console.log(JSON.stringify(report, null, 2))` on this EXACT object,
    // never touching escapeReasonForDisplay — so proving history()'s own
    // return value is lossless IS proving the JSON path, without needing a
    // subprocess.
    assert.equal(report.events[0].reason, maliciousReason,
      'the JSON-serializable report must carry the RAW reason byte-for-byte — --format=json must stay lossless');
    const roundTripped = JSON.parse(JSON.stringify(report));
    assert.equal(roundTripped.events[0].reason, maliciousReason,
      'a JSON.stringify/JSON.parse round trip (what --format=json plus a real consumer does) must not lose or mutate a single byte');

    // Text path: formatHistory() on the SAME report object must neutralize it.
    const textOut = formatHistory(report);
    assert.ok(!textOut.includes(maliciousReason), 'the text table must not contain the raw malicious substring');
    assert.ok(!textOut.includes('\u{202E}'), 'no raw bidi-override byte may reach the rendered table');
    assert.ok(!textOut.includes('\u{200B}'), 'no raw zero-width byte may reach the rendered table');
    assert.ok(textOut.includes('evil\\u202ereversed\\u200bhidden'),
      `the bytes must render as their literal \\uXXXX escapes — got:\n${textOut}`);
  });
});

/**
 * Built via \u{} escapes only (never a raw glyph anywhere in this file's own
 * source bytes) — mirrors scratchpad probe-bidi-cli.mjs's own documented
 * rule for the identical reason: a source file in THIS repo should not
 * itself carry a hidden bidi-override/zero-width payload, ironic given what
 * this finding fixes. RLO = U+202E RIGHT-TO-LEFT OVERRIDE (bidi embedding
 * class); ZWSP = U+200B ZERO WIDTH SPACE (zero-width class) — one
 * representative from each of the two newly-covered classes this specific
 * payload targets (the combining-marks class is covered separately above).
 */
function buildMaliciousReason() {
  const RLO = '\u{202E}';
  const ZWSP = '\u{200B}';
  return `evil${RLO}reversed${ZWSP}hidden`;
}
