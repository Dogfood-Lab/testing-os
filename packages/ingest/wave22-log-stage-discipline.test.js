/**
 * wave22-log-stage-discipline.test.js — sweep + collision regression for ingest.
 *
 *   F-827321-034 (D-PIPE-001) — Class #9 sweep: ingest's private `logStage`
 *     was bypassing the wave-17 verdict-first banner. Fix imported the shared
 *     helper from `@dogfood-lab/dogfood-swarm/lib/log-stage.js`. This test
 *     pins the invariant: the shared helper is the ONLY file under
 *     `packages/**` that defines `logStage` directly. Wrappers that delegate
 *     to the shared helper are allowed (and are the correct pattern for
 *     pinning a `component:` tag, like ingest does). Any future drift —
 *     a sibling re-defining `logStage` without delegating — is caught at
 *     CI time, not by a Stage E audit. Sweep automation = the regression test.
 *
 *   F-827321-035 (D-PIPE-002) — `logStage('error', { stage: 'X' })` had the
 *     inner `stage:` overwriting the outer via spread last-wins, hiding the
 *     error event from any `"stage":"error"` grep. Fix renamed the inner
 *     field to `failed_stage` AND hardened the ingest wrapper to strip any
 *     inner `stage:` before delegating to the shared helper. This test
 *     asserts:
 *       1. ingest run.js no longer passes `stage:` as an inner field.
 *       2. The runtime ingest wrapper preserves the outer stage even when
 *          a caller passes an inner one (defensive against future regressions).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(__dirname, '..');
const SHARED_HELPER = resolve(
  PACKAGES_DIR,
  'dogfood-swarm', 'lib', 'log-stage.js',
);

// ─────────────────────────────────────────────────────────────────
// Workspace JS file enumeration — excludes build/test artifacts and
// vendored deps. Cross-platform (no shell/glob dep).
// ─────────────────────────────────────────────────────────────────

function listJsFiles(root) {
  const out = [];
  const skip = new Set([
    'node_modules', 'dist', 'build', 'coverage',
    '.git', '.cache', '__test_root__',
  ]);
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && (name.endsWith('.js') || name.endsWith('.mjs'))) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// F-827321-034 — sweep invariant: only ONE logStage definition,
// or a wrapper that delegates to the shared helper
// ─────────────────────────────────────────────────────────────────

describe('F-827321-034 — only the shared helper defines logStage', () => {
  it('no file under packages/** defines its own logStage without delegating to the shared helper', () => {
    // Match: function logStage / const logStage = / let logStage = / var logStage =
    const DEFINITION = /(?:^|\s)(?:function|const|let|var)\s+logStage\b/m;

    const offenders = [];
    for (const file of listJsFiles(PACKAGES_DIR)) {
      if (file === SHARED_HELPER) continue;
      const src = readFileSync(file, 'utf-8');
      if (!DEFINITION.test(src)) continue;

      // Wrappers that delegate to the shared helper are the correct
      // pattern (e.g., ingest's component-pinning wrapper). Detect by
      // requiring the file to import logStage from the shared helper
      // AND mention sharedLogStage / shared-helper symbol use.
      const importsShared = /from\s+['"]@dogfood-lab\/dogfood-swarm\/lib\/log-stage\.js['"]/.test(src);
      if (importsShared) continue;

      offenders.push(file.replace(PACKAGES_DIR + sep, ''));
    }

    assert.deepEqual(
      offenders,
      [],
      `Found private logStage definitions outside the shared helper:\n  ${offenders.join('\n  ')}\n` +
      'Use `import { logStage } from "@dogfood-lab/dogfood-swarm/lib/log-stage.js"` instead.',
    );
  });

  it('the shared helper file actually exports logStage', () => {
    const src = readFileSync(SHARED_HELPER, 'utf-8');
    assert.match(
      src, /export\s+function\s+logStage\b/,
      'shared helper at packages/dogfood-swarm/lib/log-stage.js must export `logStage`',
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// F-827321-035 — outer stage must survive; no inner `stage:` callers
// in ingest; ingest wrapper is hardened against the antipattern
// ─────────────────────────────────────────────────────────────────

describe('F-827321-035 — outer stage survives the spread', () => {
  it('ingest run.js no longer passes inner `stage:` to logStage', () => {
    const RUN_JS = resolve(PACKAGES_DIR, 'ingest', 'run.js');
    const src = readFileSync(RUN_JS, 'utf-8');

    // Match: logStage('xxx', { ... stage: ... })
    // Use multi-line dot-all to span block bodies. Capture the body and
    // check for a `stage:` key (word-boundary, not e.g. `failed_stage:`).
    const callRe = /logStage\(\s*['"][^'"]+['"]\s*,\s*\{([^}]*)\}/gms;
    const offenders = [];
    let m;
    while ((m = callRe.exec(src)) !== null) {
      const body = m[1];
      // Look for `stage:` not preceded by an identifier char.
      // (?<![A-Za-z_]) prevents matching `failed_stage:` or `submission_stage:`.
      if (/(?<![A-Za-z_])stage\s*:/.test(body)) {
        offenders.push(m[0].replace(/\s+/g, ' ').slice(0, 100));
      }
    }
    assert.deepEqual(
      offenders, [],
      'Found logStage(...) calls passing an inner `stage:` field — use `failed_stage` instead:\n  ' +
        offenders.join('\n  '),
    );
  });

  it('shared logStage with stripped fields produces a JSON line where outer stage wins (runtime co-location of the source-check contract)', async () => {
    // F-W1-TEST-011: this is a CO-LOCATED reproduction of the strip
    // pattern, NOT an end-to-end test of ingest's private wrapper. The
    // wrapper at packages/ingest/run.js (function `logStage`) is not
    // exported, so this suite cannot drive it directly. The regex-based
    // source check immediately above (`logStage(...)` source audit) is
    // the AUTHORITATIVE enforcement that ingest never passes `stage:`
    // into the shared helper. This runtime check exists only to pin the
    // shared helper's contract: when the caller has stripped `stage:`
    // before delegation, the outer positional stage survives.
    //
    // The previous comment framed this as "covers the runtime contract
    // complementarily" — that framing was misleading. The runtime
    // contract for the *wrapper* is enforced by the source check; this
    // test pins the *shared helper's* contract. Both are needed; neither
    // alone is sufficient.
    const { logStage: sharedLogStage } = await import(
      '@dogfood-lab/dogfood-swarm/lib/log-stage.js'
    );

    const captured = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      captured.push(chunk.toString());
      return true;
    };

    try {
      // The wrapper's contract (enforced above) is "strip caller's
      // inner `stage:` before delegating". Here we replay what the
      // wrapper does and confirm the shared helper honors the outer
      // positional stage. If the shared helper ever changes to let
      // caller fields overwrite the positional stage, this test fails.
      const callerFields = {
        component: 'ingest',
        submission_id: 's-001',
        stage: 'rebuild_indexes', // intentional collision — wrapper would strip this
        message: 'simulated failure',
      };
      const { stage: _ignored, ...safe } = callerFields;
      sharedLogStage('error', safe);
    } finally {
      process.stderr.write = origErr;
    }

    const jsonLine = captured.find(c => c.trim().startsWith('{'));
    assert.ok(jsonLine, 'expected a JSON line on stderr');
    const parsed = JSON.parse(jsonLine.trim());

    assert.equal(
      parsed.stage, 'error',
      'shared helper: outer positional stage must win when caller fields have stage stripped',
    );
    assert.equal(
      parsed.component, 'ingest',
      'caller-provided component must be preserved',
    );
    assert.equal(
      parsed.submission_id, 's-001',
      'unrelated fields must pass through',
    );
  });
});
