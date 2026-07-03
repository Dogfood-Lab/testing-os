/**
 * wave8-resume-next-verb.test.js — Stage C (humanization) pins for the two
 * `swarm resume` surfaces that stated a wall without naming the recovery verb.
 *
 * Neither is a bug — both gates were already SAFE. They close the gap between
 * "the operator sees a terminal line" and "the operator is handed the exact
 * next command", the discipline `swarm dispatch` ("When done, run: swarm
 * collect") and `swarm collect` ("Next: swarm status") already uphold.
 *
 *   F-1a094f15 (error_message_quality, formatResume) — the `unknown` action is
 *     the one genuinely "I don't know what state this wave is in" terminal case
 *     (cmdResume exits 1 on it), yet formatResume printed only the header line
 *     and NO recovery guidance, while its `blocked` sibling names `swarm
 *     revalidate`. formatResume now prints an `unknown`-action diagnostic chain
 *     naming the load-bearing verbs: `swarm status`, `swarm history`, `swarm
 *     receipt`, interpolated with the run/wave ids so the line is paste-ready.
 *
 *   F-3c489002 (error_message_quality, cmdResume) — the SUCCESS paths
 *     (`redispatched`, `all_complete`) never named the next verb, so an
 *     operator who just redispatched agents was not told to run them and then
 *     `swarm collect`. cmdResume now prints an action-specific `Next:` line
 *     after formatResume for both success actions.
 *
 * Strategy: F-1a094f15 is a pure-function pin on formatResume (the report shape
 * it consumes is trivially constructible). F-3c489002 is asserted against the
 * cmdResume source text, because the branch is wired at the CLI seam and the
 * two success actions are seeded far more cheaply as a structural pin on the
 * emitted `Next:` strings than by driving a full dispatch→interrupt fixture.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatResume } from './commands/resume.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function unknownReport() {
  return {
    runId: 'run-abc',
    waveNumber: 4,
    waveId: 42,
    phase: 'health-amend-c',
    timeoutPolicy: 'default',
    action: 'unknown',
    reason: 'Unexpected state — inspect manually',
    complete: [],
    still_running: [],
    timed_out: [],
    redispatch: [],
    manual_fix: [],
    prompts: [],
  };
}

describe('formatResume — unknown action recovery chain (F-1a094f15)', () => {
  it('names the diagnostic verbs swarm status / history / receipt', () => {
    const out = formatResume(unknownReport());
    assert.match(out, /swarm status/, 'must name `swarm status` (assessment + next verb)');
    assert.match(out, /swarm history/, 'must name `swarm history` (transition chain)');
    assert.match(out, /swarm receipt/, 'must name `swarm receipt`');
  });

  it('interpolates the run id and wave id so the chain is paste-ready', () => {
    const out = formatResume(unknownReport());
    assert.match(out, /run-abc/, 'run id must be interpolated into the status/receipt verbs');
    // `swarm history` takes the DB wave id (report.waveId), not the wave number,
    // so the emitted command is copy-pasteable against the real verb signature.
    assert.match(out, /swarm history 42\b/, 'wave id must be interpolated into the history verb');
  });

  it('keeps the blocked branch untouched (still names swarm revalidate)', () => {
    const blocked = { ...unknownReport(), action: 'blocked', reason: '1 agents blocked', manual_fix: [{ domain: 'backend', status: 'invalid_output', error: 'x' }] };
    const out = formatResume(blocked);
    assert.match(out, /swarm revalidate/, 'blocked recovery verb must survive the unknown-branch addition');
  });
});

describe('cmdResume — success-path next verb (F-3c489002)', () => {
  const src = readFileSync(join(__dirname, 'cli.js'), 'utf-8');
  const cmdResume = src.slice(src.indexOf('function cmdResume('), src.indexOf('function cmdRewind('));

  it('hands the operator swarm collect on the redispatched success path', () => {
    assert.match(cmdResume, /redispatched/, 'must branch on the redispatched action');
    assert.match(cmdResume, /Next:[^\n]*swarm collect/, 'redispatched must print a `Next: ... swarm collect` line');
  });

  it('hands the operator swarm collect on the all_complete success path', () => {
    assert.match(cmdResume, /all_complete/, 'must branch on the all_complete action');
    // Both success actions must route to `swarm collect`; require two Next lines.
    const nextLines = cmdResume.match(/Next:[^\n]*swarm collect/g) || [];
    assert.ok(nextLines.length >= 2, `expected a Next: swarm collect line for both success actions, found ${nextLines.length}`);
  });
});
