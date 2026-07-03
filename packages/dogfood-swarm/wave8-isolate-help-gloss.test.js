/**
 * wave8-isolate-help-gloss.test.js — Stage C (humanization) pin for F-d045e2fc.
 *
 * `--isolate` is the single most consequence-bearing dispatch flag: it switches
 * every agent into a per-agent git worktree, and its ABSENCE on a multi-domain
 * amend wave triggers the OWNERSHIP PROBE DEGRADED banner. Yet the top-level
 * help listed it by name only, while its siblings `--dry-run` and
 * `--skip-verify` each got a full multi-line gloss — so an operator reading
 * `swarm --help` could not learn that `--isolate` is what restores full
 * cross-domain ownership attribution (the remediation the degraded banner
 * recommends). Separately, cmdDispatch's own bare-invocation Usage line listed
 * NO flags at all.
 *
 * Pins (operator's real surface — spawned `node cli.js`):
 *   1. the top-level help gives `--isolate` a gloss naming the per-agent
 *      worktree, per-agent attribution, and the ownership-probe-degraded
 *      remediation link;
 *   2. cmdDispatch's Usage line (bare `swarm dispatch <run>`) surfaces the flag
 *      family so a bare invocation is not flag-blind.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env },
  });
}

describe('--isolate help gloss (F-d045e2fc)', () => {
  it('top-level help glosses --isolate with the worktree + attribution semantics', () => {
    const r = runCli([]);
    assert.equal(r.status, 0, 'no-args help should exit 0');
    // Isolate the dispatch command block so the gloss is asserted where it belongs.
    const help = r.stdout;
    const dispatchIdx = help.indexOf('dispatch <run-id> <phase>');
    assert.ok(dispatchIdx >= 0, 'dispatch command block must be present in help');
    const block = help.slice(dispatchIdx, dispatchIdx + 1400);
    assert.match(block, /--isolate/, '--isolate must be named in the dispatch help block');
    assert.match(block, /worktree/, '--isolate gloss must name the per-agent git worktree');
    assert.match(block, /attribut/i, '--isolate gloss must name the per-agent attribution it restores');
    assert.match(block, /OWNERSHIP PROBE DEGRADED|ownership.probe.degraded/i,
      '--isolate gloss must name the ownership-probe-degraded banner it remediates');
  });

  it('cmdDispatch bare Usage line surfaces the flag family', () => {
    const r = runCli(['dispatch']);
    assert.equal(r.status, 1, 'bare dispatch should exit 1');
    const usage = r.stderr;
    assert.match(usage, /--isolate/, 'bare-dispatch Usage must list --isolate');
    assert.match(usage, /--auto-freeze/, 'bare-dispatch Usage must list --auto-freeze');
    assert.match(usage, /--skip-verify/, 'bare-dispatch Usage must list --skip-verify');
    assert.match(usage, /--dry-run/, 'bare-dispatch Usage must list --dry-run');
  });
});
