/**
 * f-f50e779b-retry-warn-fallback-guard.test.js
 *
 * F-f50e779b (wave 31, backend amend) — a defect INSIDE the wave-29 fix for
 * F-2a5ddafa, found by this same lane's own wave-30 audit of its own prior
 * work. defaultOnRetryWarn's doc comment states the invariant "the logger
 * must never throw and mask a real retry" and wraps its primary
 * `console.error(JSON.stringify(line))` call in try/catch — but the catch
 * block's OWN recovery action, a second `console.error(...)` call, was not
 * itself guarded. If console.error throws on BOTH calls (a broken stderr fd
 * — EPIPE/ENOSPC, realistic on a CI runner), the second throw escaped
 * defaultOnRetryWarn uncaught, out of the retry loop, out of confirm() —
 * turning a retry that was about to SUCCEED into a rejected promise. Blast
 * radius is bounded by an unrelated, pre-existing mechanism (verify/index.js
 * reclassifies any confirm() throw as a structured PROVENANCE_FAULT, exit 2,
 * nothing persisted) — so this was never a crash, but a submission whose
 * provenance check would have succeeded after a retry was discarded solely
 * because the NEW observability line could not be written: the opposite of
 * what an observability feature should do to reliability.
 *
 * Fix: give the fallback console.error (provenance.js ~line 153-162) its own
 * try/catch, mirroring the two-level guard `dogfood-swarm/lib/log-stage.js`
 * already uses for the identical shape (`catch { try { ... } catch {} }`) —
 * that file was independently swept and confirmed already-hardened; nothing
 * else in this domain shares defaultOnRetryWarn (grepped for
 * onRetryWarn/defaultOnRetryWarn/onWarn/onLog across every owned package —
 * only provenance.js and its two test files match).
 *
 * RED proof — ACTUALLY EXECUTED, not just reasoned (per this wave's brief:
 * "a verification that cannot fail is not a verification"). This exact
 * fixture was run via `node --test` against a byte-identical scratch copy of
 * the PRE-FIX provenance.js in an isolated temp dir (this file has zero
 * imports, so a bare copy is fully self-contained — no workspace needed).
 * Both cases below FAILED against the pre-fix copy, each stack trace pinned
 * to `defaultOnRetryWarn (provenance.js:153)`:
 *   - the "resolves true" case rejected with the raw 'EPIPE: simulated
 *     broken stderr' error instead of resolving `true`.
 *   - the "scope" case rejected with that SAME raw EPIPE error instead of
 *     the expected 'provenance: GitHub API timeout' operational error —
 *     proving the pre-fix bug also clobbers a genuine exhausted-retry error
 *     with the logger's own unrelated failure.
 * The identical fixture was then re-run against a fixed copy (the nested
 * try/catch added, nothing else changed) and both cases passed. Only that
 * one nested try/catch differed between the RED run and the GREEN run.
 *
 * Care taken against the "vacuous test" shape (this wave's own named lesson,
 * re: F-2a5ddafa's original test asserting a fix fired without ever proving
 * it fired ONLY where it should): `opts.onRetryWarn` is deliberately NEVER
 * overridden below — overriding it would bypass defaultOnRetryWarn entirely
 * and the test would pass whether or not this fix exists, regardless of the
 * production code. The global `console.error` (not `process.stderr.write`,
 * which the F-2a5ddafa suite already uses for a *different* assertion) is
 * the monkey-patch target because that is exactly what defaultOnRetryWarn
 * calls. The second test below additionally proves the guard is scoped
 * correctly: it swallows ONLY the logger's own failure and does not mask a
 * real, unrelated operational error the caller is entitled to see.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { githubProvenance } from './provenance.js';

const RUN_HEAD = 'c5d6c4e0000000000000000000000000deadbeef';

const GH_SOURCE = {
  provider: 'github',
  workflow: 'dogfood.yml',
  provider_run_id: '9123456789',
  run_url: 'https://github.com/acme/widget/actions/runs/9123456789'
};

function abortError() {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

const noSleep = async () => {};

function okGithubResp() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 9123456789,
      status: 'completed',
      head_sha: RUN_HEAD,
      repository: { full_name: 'acme/widget' }
    })
  };
}

/**
 * Monkey-patch the GLOBAL console.error for the duration of `fn` so every
 * call throws, simulating a broken stderr fd (EPIPE/ENOSPC) — the exact
 * mechanism the finding proved live. Always restores the original in
 * `finally` so a failing assertion cannot leak the patch into a sibling
 * test (node:test runs this file's cases sequentially, but a leaked patch
 * would still poison any later suite in the same process).
 *
 * @param {(getCallCount: () => number) => Promise<void>} fn
 */
async function withThrowingConsoleError(fn) {
  const orig = console.error;
  let calls = 0;
  console.error = () => {
    calls++;
    throw new Error('EPIPE: simulated broken stderr');
  };
  try {
    await fn(() => calls);
  } finally {
    console.error = orig;
  }
}

/** @pins F-f50e779b */
describe('F-f50e779b — defaultOnRetryWarn fallback is itself guarded', () => {
  it('a retry that would succeed still resolves true when console.error throws on every call', async () => {
    await withThrowingConsoleError(async (getCalls) => {
      let fetchCalls = 0;
      const adapter = githubProvenance('token', {
        timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
        // Deliberately NOT overriding onRetryWarn — must exercise the real
        // defaultOnRetryWarn, or this test never reaches the guarded code
        // (the exact vacuous-test shape this suite's header warns against).
        fetchImpl: async () => {
          fetchCalls++;
          if (fetchCalls === 1) throw abortError();
          return okGithubResp();
        }
      });
      const ok = await adapter.confirm(GH_SOURCE, { refCommitSha: RUN_HEAD });
      assert.equal(ok, true, 'a retry that succeeds must resolve true, not reject');
      assert.equal(getCalls(), 2, 'expected exactly 2 console.error attempts: primary (line ~149) + fallback (line ~153)');
    });
  });

  it('scope: a genuinely exhausted retry budget still throws the real operational error, not the logger error', async () => {
    await withThrowingConsoleError(async () => {
      const adapter = githubProvenance('token', {
        timeoutMs: 1000, retries: 2, sleepImpl: noSleep,
        fetchImpl: async () => { throw abortError(); } // never succeeds — budget exhausts
      });
      await assert.rejects(
        () => adapter.confirm(GH_SOURCE, { refCommitSha: RUN_HEAD }),
        /provenance: GitHub API timeout/,
        'the fallback guard must swallow ONLY the logger failure — it must never mask the real exhausted-retry error behind it'
      );
    });
  });
});
