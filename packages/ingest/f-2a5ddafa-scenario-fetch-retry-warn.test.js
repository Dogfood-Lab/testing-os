/**
 * f-2a5ddafa-scenario-fetch-retry-warn.test.js
 *
 * F-2a5ddafa (Stage C humanization) — the scenario fetcher's INGEST-PROACT-003
 * retry loop (`fetchWithReason`'s `for` loop in load-context.js) was completely
 * silent on every retry but the last: `await sleep(...)` fired with no logStage
 * call anywhere in the loop (confirmed by reading load-context.js end to end —
 * the only two `logStage('warn', ...)` calls in the file, at loadRepoPolicy,
 * are for the unrelated `repo_policy_unreadable` event). An operator tailing
 * NDJSON stderr had zero early-warning signal that the source repo's GitHub API
 * was degrading until the retry budget fully exhausted and threw.
 *
 * Fix: one `logStage('warn', { kind: 'scenario_fetch_retry', scenario_id,
 * attempt, status_or_reason, next_backoff_ms })` call at the point the loop
 * decides to retry — the sibling of the fix in
 * packages/verify/validators/provenance.js's confirm() loops (same finding).
 *
 * RED proof (reasoned): pre-fix, `fetchWithReason`'s loop body between
 * `attemptOnce` and `sleep` contained no logStage call at all — every
 * assertion below that looks for a `scenario_fetch_retry` event would find
 * zero matching lines (the `events` array would be empty). Independently
 * re-derived by reading the pre-fix loop body directly, not carried over
 * from the finding's own prose.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { githubScenarioFetcher } from './load-context.js';

const VALID_SHA = 'deadbeef';

function resp(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

const GOOD_YAML = [
  'scenario_id: sanity',
  'scenario_name: Sanity smoke',
  'scenario_version: 1.0.0',
  'product_surface: cli',
  'execution_mode: bot',
  'description: Smoke-checks the CLI happy path.',
  'steps:',
  '  - id: one',
  '    action: run the CLI once',
  'success_criteria:',
  '  required_steps:',
  '    - one',
  ''
].join('\n');

/** Parse NDJSON logStage lines out of a captured stderr stream. */
function parseStageEvents(lines) {
  const events = [];
  for (const chunk of lines) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.stage) events.push(parsed);
      } catch {
        // tolerate the human-readable companion banner / partial chunks
      }
    }
  }
  return events;
}

/** Run `fn` while capturing everything written to stderr. */
async function captureStderr(fn) {
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { captured.push(chunk.toString()); return true; };
  try {
    const result = await fn();
    return { result, captured };
  } finally {
    process.stderr.write = origWrite;
  }
}

/** @pins F-2a5ddafa */
describe('F-2a5ddafa — scenario fetcher emits a structured warn event before each retry', () => {
  it('a transient 503 then a 200: exactly one scenario_fetch_retry warn event fires', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      return n === 1 ? resp(503) : resp(200, GOOD_YAML);
    };
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    const { result, captured } = await captureStderr(() => fetcher.fetchWithReason('sanity'));
    assert.ok(result.scenario, 'the retry must still succeed');

    const events = parseStageEvents(captured).filter((e) => e.kind === 'scenario_fetch_retry');
    assert.equal(events.length, 1, `expected exactly one scenario_fetch_retry event; got ${JSON.stringify(events)}`);
    assert.equal(events[0].component, 'ingest');
    assert.equal(events[0].stage, 'warn');
    assert.equal(events[0].scenario_id, 'sanity');
    assert.equal(events[0].attempt, 1);
    assert.equal(typeof events[0].next_backoff_ms, 'number');
    assert.match(String(events[0].status_or_reason), /503/,
      `status_or_reason must name the actual HTTP status that triggered the retry; got ${JSON.stringify(events[0].status_or_reason)}`);
  });

  it('a 404 (not_found) is never retried and never emits a scenario_fetch_retry event', async () => {
    const fetchImpl = async () => resp(404);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });
    const { captured } = await captureStderr(() => fetcher.fetchWithReason('sanity'));
    const events = parseStageEvents(captured).filter((e) => e.kind === 'scenario_fetch_retry');
    assert.equal(events.length, 0, 'a definitive not_found answer must never warn about a retry');
  });

  it('persistent 5xx exhausting the retry budget emits one warn event per retry, before the eventual throw', async () => {
    const fetchImpl = async () => resp(500);
    const fetcher = githubScenarioFetcher('tok', 'org/repo', VALID_SHA, {
      fetchImpl, attempts: 3, sleepImpl: () => {},
    });

    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(chunk.toString()); return true; };
    try {
      await assert.rejects(fetcher.fetchWithReason('sanity'), /scenario-fetch-fault/);
    } finally {
      process.stderr.write = origWrite;
    }

    const events = parseStageEvents(captured).filter((e) => e.kind === 'scenario_fetch_retry');
    // attempts=3 means 2 retries happen (between attempt 1->2 and 2->3); the
    // 3rd attempt's failure throws without a further retry warning.
    assert.equal(events.length, 2, `expected 2 retry warnings before the throw; got ${JSON.stringify(events)}`);
    assert.deepEqual(events.map((e) => e.attempt), [1, 2]);
    for (const e of events) {
      assert.match(String(e.status_or_reason), /500/,
        `each warning must name the actual HTTP status; got ${JSON.stringify(e.status_or_reason)}`);
    }
  });
});
