/**
 * f-d231b91e-formatprobe-score-clamp.test.js — F-d231b91e (LOW, wave 37):
 * formatProbe() (commands/verify.js, reachable via the shipped
 * `swarm verify --probe-only` verb) rendered a proportional score meter —
 * `const bar = '#'.repeat(Math.round(p.score / 5));` — with no validation of
 * the adapter-contract score (lib/verify/registry.js's own JSDoc promises
 * `probe(repoPath) -> { score: 0-100, ... }`, but nothing enforced it before
 * reaching here).
 *
 * This is the LEAD wave-35's own test work flagged but did not fix:
 * f-4773fb77-probe-reason-escaping.test.js's "F-a16e53ce" describe block
 * added three boundary-value tests explicitly titled "DEFENSIVE (disclosed,
 * not fixed here — commands/verify.js is outside this test-only domain's
 * owned glob)" and flagged them to swarm-cp-verbs (owner of commands/verify.js)
 * by name. This finding is that flag, reproduced and fixed:
 *
 *   (1) score=-10: CRASHES — `formatProbe([{name:'node',score:-10,reason:'ok'}])`
 *       throws an uncaught RangeError ("Invalid count value: -2" —
 *       Math.round(-10/5)=-2 is the ROUNDED loop count String.prototype.repeat
 *       rejects, not the input score; String.prototype.repeat's own spec
 *       throws on a negative count). Confirmed this crashes past cli.js's own
 *       top-level catch (renderTopLevelError, lib/error-render.js:33-37): a
 *       plain RangeError with no `.code` renders as a bare, contextless
 *       "ERROR: Invalid count value: -2" — a full command failure instead
 *       of one degraded-but-visible row. CORRECTION, checked live before
 *       writing this test: this wave's own dispatch text paraphrased the
 *       reproduction as "score=-2", but score=-2 never actually crashes —
 *       Math.round(-2/5) is -0, and -0 does not satisfy repeat's "n < 0"
 *       check. The dispatch text conflated the finding's crash-MESSAGE
 *       value (-2, the rounded count for score=-10) with a standalone input
 *       score. The real shallow boundary is score=-3 (Math.round(-3/5)=-1,
 *       the smallest magnitude that throws); -2 is pinned below as a
 *       (harmless, unaffected) control, not a crash reproduction.
 *   (2) score=200 (also proven at 150, per this wave's dispatch): renders a
 *       bar TWICE the 20-character max the "/100" label promises (40 '#'s
 *       for 200, 30 '#'s for 150) — no clamp between an adapter's return and
 *       the render.
 *   (3) score=NaN: `Math.round(NaN/5)` is NaN, `'#'.repeat(NaN)` coerces to
 *       zero repetitions per spec (ToIntegerOrInfinity: NaN -> +0) — renders
 *       an EMPTY bar with no thrown error, silently indistinguishable from a
 *       legitimately-scored zero.
 *
 * Fixed by clamping the bar's input to [0, 100] and falling back to 0 for a
 * non-finite score, while the printed score LABEL keeps the raw, unclamped
 * `p.score` so an out-of-contract adapter value stays visible to the
 * operator instead of being silently normalized away.
 *
 * Test invariants (RED->GREEN against the pre-fix code, verified by
 * temporarily reverting commands/verify.js's clamp during authoring):
 *   1. A negative score that actually crosses the pre-fix crash boundary
 *      (-3 and -10) no longer throws — renders an empty bar with the raw
 *      negative score still shown in the label. score=-2 is pinned
 *      separately as a control (it never crashed, before or after).
 *   2. A >100 score (150 and 200) renders a bar clamped to the 20-character
 *      max, with the raw out-of-range score still shown in the label.
 *   3. A NaN score still renders an empty bar with no thrown error (same
 *      visible output as before the fix — the fix's guard, not a visual
 *      change, is what's pinned here) and the raw "NaN/100" label.
 *   4. CONTROL: in-contract scores (0, 50, 100) are unaffected — bar length
 *      stays exactly proportional (0, 10, 20 characters).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatProbe } from './commands/verify.js';

function scoreLineFor(score) {
  const out = formatProbe([{ name: 'node', score, reason: 'ok' }]);
  const line = out.split('\n').find((l) => l.includes('/100'));
  if (!line) throw new Error(`formatProbe output had no score line:\n${out}`);
  return line;
}

function barOf(line) {
  return (line.match(/#+/) || [''])[0];
}

/** @pins F-d231b91e */
describe('F-d231b91e — formatProbe() clamps an out-of-contract adapter score instead of crashing or misrendering', () => {
  it('CORRECTION (verified live, not assumed): score=-2 never actually crashed -- Math.round(-2/5) is -0, and String.prototype.repeat does not treat -0 as negative, so this shallow value was always harmless. This wave\'s own dispatch text named "-2" as a reproduction value, but that is the ROUNDED loop-count from the finding\'s real -10 case ("Invalid count value: -2" is Math.round(-10/5), not the input score) -- confirmed by direct execution before writing this assertion, not carried over from the dispatch prose.', () => {
    assert.doesNotThrow(() => scoreLineFor(-2), 'score=-2 does not throw, before or after this fix — it was never the crashing case');
    const line = scoreLineFor(-2);
    assert.match(line, /-2\/100/, `raw negative score must still be visible in the label; got: ${JSON.stringify(line)}`);
    assert.equal(barOf(line), '', 'a shallow negative renders an empty bar (Math.round(-2/5)=-0, unaffected by the clamp either way)');
  });

  it('the actual shallow crash boundary (-3, the smallest magnitude that rounds to -1 and throws pre-fix) no longer throws', () => {
    assert.doesNotThrow(() => scoreLineFor(-3),
      'score=-3 (Math.round(-3/5)=-1, the smallest magnitude that crossed the RangeError boundary pre-fix) must no longer throw');
    const line = scoreLineFor(-3);
    assert.match(line, /-3\/100/);
    assert.equal(barOf(line), '');
  });

  it('a deeply negative score (-10, the finding\'s own reproduction value — Math.round(-10/5)=-2, "Invalid count value: -2") no longer throws', () => {
    assert.doesNotThrow(() => scoreLineFor(-10),
      'score=-10 (Math.round(-10/5)=-2, the exact pre-fix crash reproduction) must no longer throw');
    const line = scoreLineFor(-10);
    assert.match(line, /-10\/100/);
    assert.equal(barOf(line), '');
  });

  it('an over-range score (150) renders a bar clamped to the 20-character max, with the raw score still labeled', () => {
    const line = scoreLineFor(150);
    assert.match(line, /150\/100/, `raw out-of-range score must still be visible; got: ${JSON.stringify(line)}`);
    assert.equal(barOf(line).length, 20,
      `score=150 must render a bar clamped to the 20-character ('#'.repeat(Math.round(100/5))) max, not 30; got ${barOf(line).length} in: ${JSON.stringify(line)}`);
  });

  it('an over-range score (200, the finding\'s own reproduction value) renders the same clamped 20-character max, not 40', () => {
    const line = scoreLineFor(200);
    assert.match(line, /200\/100/);
    assert.equal(barOf(line).length, 20,
      `score=200 must render a bar clamped to 20 characters, not the pre-fix unclamped 40; got ${barOf(line).length} in: ${JSON.stringify(line)}`);
  });

  it('a NaN score still renders an empty bar with no thrown error, and the raw "NaN/100" label', () => {
    assert.doesNotThrow(() => scoreLineFor(NaN));
    const line = scoreLineFor(NaN);
    assert.match(line, /NaN\/100/);
    assert.equal(barOf(line), '', 'NaN must fall back to a 0-length bar via the Number.isFinite guard, matching the pre-fix visual (this pins the GUARD, not a visual change)');
  });

  it('control: in-contract scores are unaffected — bar length stays exactly proportional', () => {
    assert.equal(barOf(scoreLineFor(0)).length, 0);
    assert.equal(barOf(scoreLineFor(50)).length, 10);
    assert.equal(barOf(scoreLineFor(100)).length, 20);
  });
});
