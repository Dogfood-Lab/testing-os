/**
 * case-file-prism-seat-encoding.test.js — the shim must decode its stdin as
 * UTF-8 regardless of the platform's locale encoding.
 *
 * ROOT CAUSE (measured on-rig, not theorized): `json.load(sys.stdin)` decodes
 * using `sys.stdin.encoding`. On Linux that is UTF-8; on Windows it is cp1252.
 * Every multi-byte UTF-8 character in the request therefore arrived mojibake'd:
 *
 *     JS   request.intent.length                   = 3997
 *     py   len(json.loads(open(p,'rb').read()))    = 3997   <- bytes, correct
 *     py   len(json.load(open(p)))                 = 4001   <- cp1252, WRONG
 *
 * An em-dash (U+2014) is 3 UTF-8 bytes; read as cp1252 it becomes 3 CHARACTERS,
 * so each one inflates the string by 2. Two em-dashes = +4 = 3997 -> 4001 ->
 * past pydantic's max_length=4000 -> INVALID_ARTIFACT -> the seat abstains.
 * That was the live `pass 0 / fail 0 / insufficient 4` on all four seats.
 *
 * The length overflow was the LESSER half: only one criterion crossed 4000, but
 * every intent AND the artifact content went through the same decode, so all 40
 * prism calls judged garbled text and the panel's verdict was meaningless.
 *
 * WHY THIS SHIPPED — and why these tests are shaped the way they are:
 *
 *   1. CI runs ubuntu-latest, where stdin is already UTF-8, so the bug is
 *      invisible to CI BY CONSTRUCTION. These tests therefore FORCE the child's
 *      encoding via PYTHONIOENCODING=cp1252, which reproduces the Windows
 *      condition on ANY platform. That is what keeps them non-vacuous in CI
 *      rather than merely green there. The byte-read fix ignores
 *      PYTHONIOENCODING entirely, which is exactly the property being pinned.
 *
 *   2. An ASCII-only fixture CANNOT fail — that is precisely why this shipped.
 *      Every fixture below deliberately carries multi-byte characters.
 *
 *   3. The shim has no echo mode and, without prism installed, never reaches
 *      the length validation — so the inflation itself is not observable
 *      through the shim's contract in CI. The probe instead uses U+0081, whose
 *      UTF-8 encoding (C2 81) contains byte 0x81, which is UNDEFINED in cp1252.
 *      A locale-decoding shim raises UnicodeDecodeError and reports
 *      INVALID_ARTIFACT / "not valid JSON"; a byte-decoding shim reads it
 *      cleanly and proceeds. That turns a silent corruption into an assertion
 *      the shim's real, existing error contract can carry — no new surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHIM = fileURLToPath(new URL('./lib/case-file/prism_seat.py', import.meta.url));
const PYTHON = process.env.PRISM_PYTHON || 'python';

/** Run the real shim with a forced stdin encoding; return its parsed response. */
function runShim(request, { ioEncoding } = {}) {
  const env = { ...process.env };
  if (ioEncoding) env.PYTHONIOENCODING = ioEncoding;
  else delete env.PYTHONIOENCODING;

  const stdout = execFileSync(PYTHON, [SHIM], {
    input: Buffer.from(JSON.stringify(request), 'utf-8'),
    env,
    encoding: 'buffer',
    windowsHide: true,
  });
  return JSON.parse(stdout.toString('utf-8'));
}

/**
 * Whether prism is importable. The shim exits at its ImportError guard before
 * ever constructing a VerifyRequest, so without prism the length cap is
 * unreachable and any assertion about it would pass for the wrong reason.
 */
function prismImportable() {
  try {
    execFileSync(PYTHON, ['-c', 'import prism.core.types'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function requestWithIntent(intent) {
  return {
    artifact_type: 'code',
    content: 'GUARD_CODE_HERE',
    intent,
    caller_family: 'anthropic',
    caller_model: 'claude-sonnet-4-6',
    max_latency_ms: 30_000,
  };
}

/** A JSON-decode failure is the shim's observable for "stdin was misdecoded". */
function isDecodeFailure(res) {
  return res?.error?.reason === 'INVALID_ARTIFACT'
    && /not valid JSON/.test(res?.error?.detail || '');
}

describe('prism_seat.py — stdin is decoded as UTF-8 regardless of locale', () => {
  it('a request carrying a cp1252-undecodable char survives a cp1252 stdin (the deletion-proof)', () => {
    // U+0081 -> UTF-8 bytes C2 81. Byte 0x81 is UNDEFINED in cp1252, so a
    // locale-decoding shim raises UnicodeDecodeError here. Forcing
    // PYTHONIOENCODING=cp1252 reproduces the Windows rig on any platform, so
    // this test is non-vacuous in Linux CI too. RED against `json.load(sys.stdin)`.
    const res = runShim(requestWithIntent('boundary  probe'), { ioEncoding: 'cp1252' });
    assert.equal(
      isDecodeFailure(res), false,
      `shim must not misdecode stdin under a cp1252 locale; got: ${JSON.stringify(res)}`,
    );
  });

  it('a 3997-char intent with em-dashes is NOT inflated past prism\'s 4000 cap (the live failure)', function () {
    // THE ACTUAL WAVE-2 JURY FAILURE, reproduced end-to-end through the real
    // shim. A plain "em-dash survives" assertion would be VACUOUS: a locale
    // decode does not RAISE on an em-dash, it silently mojibakes, so such a
    // test passes against the broken shim. It only becomes observable once the
    // inflated string hits pydantic's max_length=4000 — which requires prism
    // installed, so this probe self-skips where it cannot fire rather than
    // pretending to guard.
    //
    // Verified RED on-rig against `json.load(sys.stdin)`:
    //   reason = INVALID_ARTIFACT
    //   detail = ValidationError: ... String should have at most 4000 characters
    // for a JS string measuring exactly 3997.
    if (!prismImportable()) {
      this.skip('prism not importable — the length cap cannot be reached here');
      return;
    }
    let intent = 'OBJECTIVE: the endpoint rejects an expired token — really — yes';
    intent += 'x'.repeat(3997 - intent.length);
    assert.equal(intent.length, 3997, 'fixture must sit just under the cap');

    const res = runShim(requestWithIntent(intent), { ioEncoding: 'cp1252' });
    const tooLong = res?.error?.reason === 'INVALID_ARTIFACT'
      && /at most 4000 characters|string_too_long/.test(res?.error?.detail || '');
    assert.equal(
      tooLong, false,
      `a 3997-char intent must not be inflated past 4000 by the shim's decode; got: ${JSON.stringify(res).slice(0, 300)}`,
    );
  });

  it('is not merely relying on an ambient PYTHONIOENCODING being set', () => {
    // The env var is explicitly REMOVED here. The primary fix must be the
    // shim's own byte-read, not the buildSeatEnv defense-in-depth: a shim that
    // only works because the caller sets an env var is one env change away
    // from silently regressing.
    const res = runShim(requestWithIntent('no ambient encoding  — set'), {});
    assert.equal(isDecodeFailure(res), false, `got: ${JSON.stringify(res)}`);
  });

  it('still reports a genuine malformed-JSON error (the gate did not become vacuous)', () => {
    // POSITIVE CONTROL — a fix that swallows every decode error is the
    // opposite failure. Truly broken JSON must still be reported as such.
    const stdout = execFileSync(PYTHON, [SHIM], {
      input: Buffer.from('{not json at all', 'utf-8'),
      env: { ...process.env },
      encoding: 'buffer',
      windowsHide: true,
    });
    const res = JSON.parse(stdout.toString('utf-8'));
    assert.equal(isDecodeFailure(res), true, `got: ${JSON.stringify(res)}`);
  });
});

describe('prism_seat.py — stdout is emitted as UTF-8 regardless of locale', () => {
  it('emits parseable UTF-8 under a cp1252 locale', () => {
    // Honest note: stdout was NOT a live bug — json.dumps defaults to
    // ensure_ascii=True, so the payload was already pure ASCII and a cp1252
    // stdout encoded it fine. This pins the property so it stays true if
    // anyone ever passes ensure_ascii=False, rather than leaving it resting on
    // an unstated default.
    const res = runShim(requestWithIntent('emit — probe'), { ioEncoding: 'cp1252' });
    assert.ok(res && typeof res === 'object', 'stdout must be parseable JSON');
    assert.ok(res.error || res.verdict, 'shim must emit a response envelope');
  });
});
