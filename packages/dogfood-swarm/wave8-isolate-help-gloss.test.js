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

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

// SWARM_DB pin (task_6026249b): help-surface spawns exit before touching the
// DB today, but that ordering is not contractual — never let a CLI child
// inherit the repo-default control-plane.db. Enforced package-wide by
// meta-wal-sidecar-teardown-guard.test.js.
const SAFE_DB_DIR = mkdtempSync(join(tmpdir(), 'w8-gloss-safe-db-'));
after(() => { try { rmSync(SAFE_DB_DIR, { recursive: true, force: true }); } catch { /* Windows lock lag */ } });

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: join(SAFE_DB_DIR, 'control-plane.db') },
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
    // F-2b8e1797: the block end used to be a fixed `dispatchIdx + 1400`
    // window — the same magic-number-slice shape F-3e449453 (wave 12, this
    // same package) fixed in wave8-4091637-5127-swarm-cp-pins.test.js, for
    // the identical reason: a fixed window can fail for the WRONG reason (an
    // unrelated, benign edit growing the preceding content past the window)
    // while staying silent about the real defect it exists to catch.
    // Anchored on the next command entry's own opening token instead — the
    // slice now grows and shrinks with the dispatch block's real content.
    // Mutation-probed both directions against a captured copy of real `node
    // cli.js` stdout (not the repo's cli.js): (a) splicing ~1000 benign
    // filler chars into the gloss preamble pushes OWNERSHIP PROBE DEGRADED
    // from offset 532 to ~1500 — past the old fixed-1400 budget (868 chars
    // of headroom today), false-failing the old version while this anchor
    // stays green; (b) deleting the OWNERSHIP PROBE DEGRADED sentence still
    // flips this pin red, same as before.
    const nextEntryIdx = help.indexOf('\n  collect <run-id> [opts]', dispatchIdx);
    assert.ok(nextEntryIdx > dispatchIdx,
      'the next command entry (collect) must still exist to bound the dispatch block — extraction is broken if this fails');
    const block = help.slice(dispatchIdx, nextEntryIdx);
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
