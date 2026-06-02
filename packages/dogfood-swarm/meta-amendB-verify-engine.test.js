/**
 * meta-amendB-verify-engine.test.js — Amend wave B, verify-engine domain.
 *
 * Regression tests for the Stage-C hardening / operator-UX findings on the
 * verify engine (lib/verify/** runner + registry + adapters). Each block names
 * the finding id and pins the *post-fix* behaviour so a future regression
 * points straight at the defect that returned.
 *
 * These are diagnosability findings, not correctness bugs in the Stage-A sense:
 * the wave gate stays SAFE (no false ADVANCE) in every case. What changes is
 * the operator's ability to tell apart honest "cannot verify here" outcomes
 * from real failures. The contract with the display layer (cli.js +
 * commands/verify.js, owned by the operator-output agent) is that verdicts come
 * from the set { pass, fail, skip, no_tests, tool_missing }, each carrying a
 * `reason` string when non-pass, plus per-step `tool_missing` / `timed_out` /
 * `truncated` flags. The assertions below pin that contract.
 *
 *   ve-p-001 (MED, degradation) — a MISSING build tool on PATH (ENOENT /
 *     "not recognized" / "command not found") is a DISTINCT `tool_missing`
 *     verdict, NOT an ordinary `fail`, so a host lacking the toolchain does not
 *     look like "the fix broke the build".
 *   ve-p-005 (LOW, observability) — a step that hit its timeout is tagged
 *     `timed_out: true` (+ reason) so a 5-min hang is distinguishable from a
 *     fast exit-1 failure.
 *   ve-p-006 (LOW, future-proofing) — probeAll() has a deterministic,
 *     documented tie-break on equal score (rust > python > node) instead of
 *     incidental Map-insertion order.
 *   ve-p-007 (LOW, observability) — an output truncation sets `truncated: true`
 *     on the StepResult (and aggregates to the run) so the operator knows the
 *     captured log is partial.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

import { runStep, runSteps } from './lib/verify/runner.js';
import { probeAll } from './lib/verify/registry.js';
import { rustAdapter } from './lib/verify/adapters/rust.js';

// A binary name that cannot exist on PATH on any host.
const MISSING = 'definitely-not-a-real-binary-xyz';

// ═══════════════════════════════════════════════════════════════════════
// ve-p-001 — missing tool on PATH → `tool_missing`, never a misleading FAIL
// ═══════════════════════════════════════════════════════════════════════

describe('ve-p-001 — a missing build tool degrades to tool_missing, not fail', () => {
  it('runStep tags a nonexistent cmd with tool_missing + a reason naming it', () => {
    // Pre-fix: this returned exit_code:1, passed:false with the raw shell
    // "not recognized" / "command not found" text and NO way to tell it apart
    // from a real compile failure. Post-fix the StepResult is self-identifying.
    const r = runStep('.', { name: 'check', cmd: MISSING, args: ['--version'] });
    assert.equal(r.passed, false);
    assert.equal(r.tool_missing, true, 'the missing-tool case must be flagged');
    assert.notEqual(r.timed_out, true, 'a missing tool is not a timeout');
    assert.match(r.reason, new RegExp(MISSING));
    assert.match(r.reason, /not found on PATH/i);
  });

  it('runSteps maps a REQUIRED missing-tool step to verdict tool_missing (not fail)', () => {
    // The central gap: a required step whose tool is absent must NOT read as a
    // FAIL ("my fix broke the build"). It degrades to a distinct verdict and
    // the wave correctly stays un-advanced (the gate advances only on `pass`).
    const result = runSteps('.', [
      { name: 'check', cmd: MISSING, args: ['build'] },
    ]);
    assert.notEqual(result.verdict, 'fail', 'a missing toolchain must not look like a real failure');
    assert.equal(result.verdict, 'tool_missing');
    assert.match(result.reason, /not found on PATH/i);
    assert.match(result.reason, new RegExp(MISSING));
  });

  it('a REAL required failure dominates a co-occurring missing tool → fail', () => {
    // If one required step genuinely fails (real non-zero exit) while another
    // is merely tool-missing, the honest, actionable signal is `fail` — the
    // real failure must not be masked as `tool_missing`.
    const result = runSteps('.', [
      { name: 'check', cmd: 'node', args: ['-e', '"process.exit(2)"'] }, // real fail
      { name: 'test', cmd: MISSING, args: ['run'] },                     // tool missing
    ], { continueOnError: true });
    assert.equal(result.verdict, 'fail');
  });

  it('through the rust adapter: a host without cargo reports tool_missing', () => {
    // The motivating scenario from the finding: auditing a Rust repo on a host
    // that lacks `cargo`. The required `check`/`test` steps are tool-missing,
    // so the adapter result is `tool_missing`, not a FAIL that reads as a
    // broken build. (Skips on the rare host that actually has cargo installed.)
    const dir = mkdtempSync(join(tmpdir(), 'vep001-rust-'));
    writeFileSync(
      join(dir, 'Cargo.toml'),
      '[package]\nname = "probe-fixture"\nversion = "0.0.0"\n',
      'utf-8'
    );
    try {
      const result = rustAdapter.run(dir);
      if (result.steps.some(s => s.tool_missing)) {
        assert.equal(result.verdict, 'tool_missing');
        assert.match(result.reason, /cargo/);
      } else {
        // cargo is installed here — the engine ran for real; nothing to assert
        // about tool_missing. The verdict is then a real pass/fail/no-op.
        assert.ok(['pass', 'fail', 'skip', 'no_tests'].includes(result.verdict));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ve-p-005 — a timed-out step is distinguishable from a fast failure
// ═══════════════════════════════════════════════════════════════════════

describe('ve-p-005 — a step that hit its timeout is tagged timed_out', () => {
  it('runStep flags timed_out (+ reason) when the per-step budget is exceeded', () => {
    // Use a tiny per-step timeoutMs so the test does not wait the real 5 min.
    // The child keeps the event loop alive ~3s; the 120ms budget kills it.
    // Pre-fix this looked identical to a fast exit-1 failure; post-fix the
    // hang is self-identifying so an operator reads "TIMED OUT", not "failed".
    const r = runStep('.', {
      name: 'test',
      cmd: 'node',
      args: ['-e', '"setTimeout(function(){}, 3000)"'],
      timeoutMs: 120,
    });
    assert.equal(r.passed, false);
    assert.equal(r.timed_out, true, 'a killed-on-timeout step must be flagged');
    assert.notEqual(r.tool_missing, true, 'a hang is not a missing tool');
    assert.match(r.reason, /timed out/i);
    assert.match(r.reason, /120ms/);
  });

  it('the timeout signal aggregates to the runSteps result', () => {
    const result = runSteps('.', [
      { name: 'test', cmd: 'node', args: ['-e', '"setTimeout(function(){}, 3000)"'], timeoutMs: 120 },
    ]);
    assert.equal(result.timed_out, true);
    // A timed-out required step is still a (real) failure at the gate — safe
    // direction — but the run carries the hang signal + reason for the operator.
    assert.equal(result.verdict, 'fail');
    assert.match(result.reason, /timed out/i);
  });

  it('a fast clean pass is NOT flagged as timed_out', () => {
    const r = runStep('.', { name: 'ok', cmd: 'node', args: ['-e', '"process.exit(0)"'] });
    assert.equal(r.passed, true);
    assert.notEqual(r.timed_out, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ve-p-006 — deterministic tie-break for equal-confidence probes
// ═══════════════════════════════════════════════════════════════════════

describe('ve-p-006 — probeAll has a deterministic tie-break on equal score', () => {
  function mkPolyglotRepo() {
    // A repo that scores 50 under BOTH node (package.json, no test script) and
    // python (pyproject.toml, no pytest marker) — a genuine equal-score tie.
    const dir = mkdtempSync(join(tmpdir(), 'vep006-poly-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'poly', version: '0.0.0' }, null, 2),
      'utf-8'
    );
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "poly"\n', 'utf-8');
    return dir;
  }

  it('breaks an equal score by documented priority (python > node), not Map order', () => {
    const dir = mkPolyglotRepo();
    try {
      const ranked = probeAll(dir);
      const node = ranked.find(p => p.name === 'node');
      const python = ranked.find(p => p.name === 'python');
      // Precondition: the fixture really is a tie at this score.
      assert.equal(node.score, 50);
      assert.equal(python.score, 50);
      // The tie-break must put the more marker-exclusive adapter first
      // deterministically. python (pyproject.toml) outranks node (package.json).
      assert.equal(ranked[0].name, 'python');
      assert.ok(
        ranked.findIndex(p => p.name === 'python') < ranked.findIndex(p => p.name === 'node'),
        'python must rank ahead of node on a score tie'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is stable: repeated probes of the same tie yield the same winner', () => {
    const dir = mkPolyglotRepo();
    try {
      const a = probeAll(dir).map(p => p.name);
      const b = probeAll(dir).map(p => p.name);
      assert.deepEqual(a, b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a strictly higher score still wins regardless of the tie-break', () => {
    // node here also has a `test` script (+20 → 70) and beats a bare pyproject
    // (50). The tie-break must only break TIES, never override a real lead.
    const dir = mkdtempSync(join(tmpdir(), 'vep006-lead-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'lead', version: '0.0.0', scripts: { test: 'node --test' } }, null, 2),
      'utf-8'
    );
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "lead"\n', 'utf-8');
    try {
      const ranked = probeAll(dir);
      assert.equal(ranked[0].name, 'node');
      assert.ok(ranked[0].score > 50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ve-p-007 — output truncation is signaled to the operator
// ═══════════════════════════════════════════════════════════════════════

describe('ve-p-007 — a truncated step output sets truncated: true', () => {
  it('flags truncated on a step whose stdout exceeds the cap', () => {
    // Emit ~20k chars to stdout; the cap is 8000. Pre-fix the truncation was
    // only visible in-band ("... (truncated)"); post-fix the StepResult carries
    // a top-level `truncated` flag the display layer can surface.
    const r = runStep('.', {
      name: 'test',
      cmd: 'node',
      args: ['-e', '"process.stdout.write(\'x\'.repeat(20000))"'],
    });
    assert.equal(r.passed, true);
    assert.equal(r.truncated, true, 'an over-cap stdout must set truncated');
    assert.ok(r.stdout.length < 20000, 'stdout must actually be bounded');
    assert.match(r.stdout, /truncated/);
  });

  it('does NOT flag truncated on small output', () => {
    const r = runStep('.', { name: 'ok', cmd: 'node', args: ['-e', '"console.log(\'small\')"'] });
    assert.equal(r.passed, true);
    assert.notEqual(r.truncated, true);
  });

  it('the truncation signal aggregates to the runSteps result', () => {
    const result = runSteps('.', [
      { name: 'test', cmd: 'node', args: ['-e', '"process.stdout.write(\'x\'.repeat(20000)); console.log(\'\\n# tests 1\')"'] },
    ]);
    assert.equal(result.truncated, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Contract — the verdict vocabulary exposed to the display layer
// ═══════════════════════════════════════════════════════════════════════

describe('contract — runSteps exposes verdicts in { pass, fail, skip, no_tests, tool_missing }', () => {
  it('every runSteps verdict is in the agreed set, with a reason on non-pass', () => {
    const allowed = new Set(['pass', 'fail', 'skip', 'no_tests', 'tool_missing']);

    const pass = runSteps('.', [
      { name: 'test', cmd: 'node', args: ['-e', '"console.log(\'# tests 1\')"'] },
    ]);
    const fail = runSteps('.', [
      { name: 'test', cmd: 'node', args: ['-e', '"process.exit(1)"'] },
    ]);
    const skip = runSteps('.', []); // no required steps
    const toolMissing = runSteps('.', [
      { name: 'test', cmd: MISSING, args: ['run'] },
    ]);

    for (const r of [pass, fail, skip, toolMissing]) {
      assert.ok(allowed.has(r.verdict), `verdict "${r.verdict}" must be in the contract set`);
    }
    assert.equal(pass.verdict, 'pass');
    assert.equal(fail.verdict, 'fail');
    assert.equal(skip.verdict, 'skip');
    assert.equal(toolMissing.verdict, 'tool_missing');

    // Non-pass verdicts the engine originates here carry a reason string.
    assert.equal(typeof skip.reason, 'string');
    assert.equal(typeof toolMissing.reason, 'string');
    // A plain `pass` adds no reason (keeps the existing shape unchanged).
    assert.equal(pass.reason, undefined);
  });
});
