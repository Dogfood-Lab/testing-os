/**
 * d1b-005-006-rebuild-and-policy-warns.test.js
 *
 * Two related humanization fixes for ingest-side silent skips:
 *
 *   D1B-005 (rebuild-indexes corrupted/missing-run_id skips) —
 *     `packages/ingest/rebuild-indexes.js:106,111` used unstructured
 *     `console.error('[rebuild-indexes] ...')` prefix strings to surface
 *     skipped records. Grep parity with the NDJSON-tagged ingest
 *     pipeline was broken: `grep '"stage":"warn"'` MISSED them. Fix:
 *     emit `logStage('warn', { kind: 'record_skipped', reason, path, ... })`.
 *
 *   D1B-006 (torn repo-policy sentinel) — `packages/ingest/load-context.js:75`
 *     swallowed YAML parse failures with `console.warn` and returned `null`.
 *     The verifier then saw a null `repoPolicy` and treated the submission
 *     as policy-conformant (`policy_valid=true`) — a CRITICAL sentinel
 *     inversion: a corrupt policy SHOULD reject, not accept. Fix:
 *
 *       1. `loadRepoPolicy` distinguishes "no file" (returns null,
 *          defaults apply — unchanged behaviour) from "file unreadable"
 *          (returns `{ __torn: true, reason }` — a sentinel the caller
 *          recognises).
 *       2. `verify()` surfaces the torn sentinel as a `policy: <reason>`
 *          rejection so `policy_valid=false` AND the operator sees the
 *          rejection in `rejection_reasons`.
 *       3. `logStage('warn', { kind: 'repo_policy_unreadable', repo, path, error })`
 *          fires at load time so the NDJSON stream carries the warn event.
 *
 *     Counter-test: a MISSING repo-policy file preserves the existing
 *     defaults-only behaviour (no rejection, no warn event). Only TORN
 *     files trip the sentinel.
 *
 * Lens: every failure or degradation path emits a structured, coded,
 * greppable signal; sentinels never invert (broken policy != trusted policy).
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdirSync, rmSync, mkdtempSync, writeFileSync,
  readdirSync, copyFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rebuildIndexes } from './rebuild-indexes.js';
import { loadRepoPolicy } from './load-context.js';
import { ingest } from './run.js';
import { stubProvenance } from '@dogfood-lab/verify/validators/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(__dirname, '../verify/fixtures');

let pilot0;
before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

function copyDirSync(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * Capture stderr while running an async function. Mirrors the helper in
 * `verify-only-and-correlation.test.js`. We restore in `finally` so a
 * failed assertion doesn't leak the stub into sibling tests.
 */
async function captureStderr(fn) {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(chunk.toString());
    return true;
  };
  try {
    return { result: await fn(), captured };
  } finally {
    process.stderr.write = orig;
  }
}

function parseStageEvents(captured) {
  const events = [];
  for (const chunk of captured) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.stage) events.push(parsed);
      } catch { /* skip non-JSON */ }
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────
// D1B-005 — rebuild-indexes corrupted/missing-run_id structured warn events
// ─────────────────────────────────────────────────────────────────

describe('D1B-005 — rebuild-indexes emits structured warn events for skipped records', () => {
  function makeTmpRepo() {
    const root = mkdtempSync(join(tmpdir(), 'd1b005-'));
    mkdirSync(join(root, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19'), { recursive: true });
    return root;
  }

  it('POSITIVE: a corrupted record file triggers a logStage warn with kind="record_skipped"', async () => {
    const repoRoot = makeTmpRepo();
    try {
      // Seed one corrupted record file (invalid JSON).
      const corruptPath = join(
        repoRoot, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19',
        'run-corrupt-001.json'
      );
      writeFileSync(corruptPath, '{ this is not valid json', 'utf-8');

      const { result, captured } = await captureStderr(() =>
        Promise.resolve(rebuildIndexes(repoRoot))
      );

      // The corrupted record must still surface via the return value
      // (operators reading the result object); behavior preserved.
      assert.equal(result.corrupted.length, 1,
        'corrupted record must still appear in result.corrupted');

      // AND a structured warn event must fire — this is the new
      // discipline. `grep '"kind":"record_skipped"'` recovers it.
      const events = parseStageEvents(captured);
      const skip = events.find(e =>
        e.stage === 'warn' && e.kind === 'record_skipped' && e.reason === 'corrupted'
      );
      assert.ok(skip,
        `expected a stage:warn event with kind=record_skipped reason=corrupted; ` +
        `got events=${JSON.stringify(events.map(e => ({ stage: e.stage, kind: e.kind, reason: e.reason })))}`);
      assert.ok(typeof skip.path === 'string' && skip.path.length > 0,
        'warn event must carry the offending record path');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('POSITIVE: a record missing run_id triggers a logStage warn with reason="missing_run_id"', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const noRunIdPath = join(
        repoRoot, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19',
        'run-no-runid-001.json'
      );
      writeFileSync(noRunIdPath, JSON.stringify({ repo: 'x', verification: { status: 'accepted' } }), 'utf-8');

      const { captured } = await captureStderr(() =>
        Promise.resolve(rebuildIndexes(repoRoot))
      );
      const events = parseStageEvents(captured);
      const skip = events.find(e =>
        e.stage === 'warn' && e.kind === 'record_skipped' && e.reason === 'missing_run_id'
      );
      assert.ok(skip,
        `expected a stage:warn event with kind=record_skipped reason=missing_run_id; ` +
        `got events=${JSON.stringify(events.map(e => ({ stage: e.stage, kind: e.kind, reason: e.reason })))}`);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a healthy record set emits no record_skipped warn events', async () => {
    const repoRoot = makeTmpRepo();
    try {
      const goodPath = join(
        repoRoot, 'records', 'mcp-tool-shop-org', 'demo', '2026', '03', '19',
        'run-ok-001.json'
      );
      writeFileSync(goodPath, JSON.stringify({
        run_id: 'ok-001',
        repo: 'mcp-tool-shop-org/demo',
        timing: { finished_at: '2026-03-19T15:45:12Z' },
        scenario_results: [{ scenario_id: 's', product_surface: 'cli', verdict: 'pass' }],
        overall_verdict: { verified: 'pass' },
        verification: { status: 'accepted' }
      }), 'utf-8');

      const { captured } = await captureStderr(() =>
        Promise.resolve(rebuildIndexes(repoRoot))
      );
      const events = parseStageEvents(captured);
      const skips = events.filter(e =>
        e.stage === 'warn' && e.kind === 'record_skipped'
      );
      assert.equal(skips.length, 0,
        `healthy record set must produce no record_skipped warns; got ${JSON.stringify(skips)}`);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// D1B-006 — torn repo-policy sentinel: corrupt YAML must reject, not accept
// ─────────────────────────────────────────────────────────────────

describe('D1B-006 — torn repo-policy sentinel inverts to REJECT, not silently accept', () => {
  const TEST_ROOT = resolve(__dirname, '__test_root_d1b006__');

  function setupTestRoot({ tornPolicy = false, missingPolicy = false } = {}) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    copyDirSync(resolve(REPO_ROOT, 'policies'), resolve(TEST_ROOT, 'policies'));
    copyDirSync(resolve(REPO_ROOT, 'packages/schemas/src/json'), resolve(TEST_ROOT, 'schemas'));
    mkdirSync(resolve(TEST_ROOT, 'records'), { recursive: true });
    mkdirSync(resolve(TEST_ROOT, 'records', '_rejected'), { recursive: true });
    mkdirSync(resolve(TEST_ROOT, 'indexes'), { recursive: true });

    if (tornPolicy) {
      const tornPath = join(
        TEST_ROOT, 'policies', 'repos', 'mcp-tool-shop-org', 'dogfood-labs.yaml'
      );
      writeFileSync(tornPath, '%%% not yaml — torn file %%%\n  : bad: [ {\n', 'utf-8');
    } else if (missingPolicy) {
      const policyPath = join(
        TEST_ROOT, 'policies', 'repos', 'mcp-tool-shop-org', 'dogfood-labs.yaml'
      );
      rmSync(policyPath, { force: true });
    }
  }

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('POSITIVE: torn repo-policy YAML surfaces as policy_valid=false + policy: rejection reason', async () => {
    setupTestRoot({ tornPolicy: true });

    const { result } = await captureStderr(() =>
      ingest(pilot0, { repoRoot: TEST_ROOT, provenance: stubProvenance })
    );

    // Sentinel must INVERT: torn policy => REJECT, not accept.
    assert.equal(result.record.verification.policy_valid, false,
      `torn policy must produce policy_valid=false; got record=${JSON.stringify(result.record.verification)}`);
    assert.equal(result.record.verification.status, 'rejected',
      'torn policy must reject the submission');
    const policyReason = result.record.verification.rejection_reasons
      .find(r => r.startsWith('policy:'));
    assert.ok(policyReason,
      `expected a 'policy:' rejection reason; got ` +
      `${JSON.stringify(result.record.verification.rejection_reasons)}`);
  });

  it('POSITIVE: torn repo-policy emits a logStage warn with kind=repo_policy_unreadable', async () => {
    setupTestRoot({ tornPolicy: true });
    const { captured } = await captureStderr(() =>
      ingest(pilot0, { repoRoot: TEST_ROOT, provenance: stubProvenance })
    );
    const events = parseStageEvents(captured);
    const warn = events.find(e =>
      e.stage === 'warn' && e.kind === 'repo_policy_unreadable'
    );
    assert.ok(warn,
      `expected a stage:warn event with kind=repo_policy_unreadable; ` +
      `got events=${JSON.stringify(events.map(e => ({ stage: e.stage, kind: e.kind })))}`);
    assert.ok(typeof warn.repo === 'string',
      'warn event must carry the repo slug');
    assert.ok(typeof warn.path === 'string',
      'warn event must carry the policy file path');
  });

  it('NEGATIVE: missing repo-policy file preserves existing defaults (no rejection, no warn)', async () => {
    // Counter-test: the documented design is "no repo-policy → defaults
    // apply silently". Only TORN policies trip the sentinel. Mixing the
    // two would over-rotate to a stricter contract than the user docs
    // promise.
    setupTestRoot({ missingPolicy: true });
    const { result, captured } = await captureStderr(() =>
      ingest(pilot0, { repoRoot: TEST_ROOT, provenance: stubProvenance })
    );

    // Submission still accepted because:
    //   - schema OK
    //   - provenance stub OK
    //   - policy: defaults apply, no rejection added
    assert.equal(result.record.verification.policy_valid, true,
      'missing repo-policy must NOT trip the torn-policy sentinel');
    assert.equal(result.record.verification.status, 'accepted');

    const events = parseStageEvents(captured);
    const wrongWarn = events.find(e =>
      e.stage === 'warn' && e.kind === 'repo_policy_unreadable'
    );
    assert.ok(!wrongWarn,
      `missing repo-policy must NOT emit a repo_policy_unreadable warn; ` +
      `got events=${JSON.stringify(events.map(e => ({ stage: e.stage, kind: e.kind })))}`);
  });

  it('contract: loadRepoPolicy surfaces a discriminable torn sentinel', () => {
    setupTestRoot({ tornPolicy: true });
    const result = loadRepoPolicy('mcp-tool-shop-org/dogfood-labs', TEST_ROOT);
    // The loader returns a SENTINEL that the caller can pattern-match on
    // without parsing YAML twice. Two shapes acceptable:
    //   - { __torn: true, reason }    → typed-sentinel object
    //   - any object with a `__torn: true` property
    // Pre-fix the loader returned null; if it returns null again the
    // verifier cannot distinguish torn-from-missing.
    assert.ok(result, 'torn loadRepoPolicy must return a truthy sentinel');
    assert.equal(result.__torn, true,
      `torn loader must surface { __torn: true, ... }; got ${JSON.stringify(result)}`);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0,
      'torn sentinel must carry a human-readable reason field');
  });
});
