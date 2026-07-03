/**
 * cli-lint-scenario.test.js (F-BACKEND-003) — the `dogfood-verify lint --scenario
 * <file>` mode.
 *
 * The scenario mode reuses the whole lint parse/render/exit machinery (renderLintText,
 * buildLintJson, the exit contract) and only swaps which linter runs. These tests drive
 * the EXPORTED runLint(argv, io) with injected stdout/stderr — no subprocess — exactly
 * like cli-lint.test.js. Exit contract: 0 clean/warn-only, 1 errors, 2 operator/IO.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runLint } from './cli-lint.js';
import { main } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVALID = resolve(__dirname, 'fixtures/scenarios/invalid');
const VALID = resolve(__dirname, 'fixtures/scenarios/valid');
const DOGFOOD = resolve(__dirname, '../../dogfood/scenarios');
const EXAMPLES = resolve(__dirname, '../../examples');
const REPO_ROOT = resolve(__dirname, '../..');

function makeIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), repoRoot: REPO_ROOT },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

let tmpDir;
let brokenYaml;
before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'verify-lint-scenario-'));
  brokenYaml = join(tmpDir, 'broken.yaml');
  writeFileSync(brokenYaml, 'scenario_id: broken\n  : : not valid yaml :\n', 'utf-8');
});

// ── clean → exit 0 ──────────────────────────────────────────────────

describe('lint --scenario a clean scenario', () => {
  it('reports a clean verdict, prints origin: scenario, and exits 0', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', resolve(VALID, 'clean.yaml')], io);
    assert.equal(code, 0, stdout());
    assert.match(stdout(), /VERDICT: (CLEAN|OK|PASS)/);
    assert.match(stdout(), /origin: scenario/);
  });
});

// ── value-check errors → exit 1 ─────────────────────────────────────

describe('lint --scenario a required-step-undeclared scenario', () => {
  it('renders the error and exits 1', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', resolve(INVALID, 'required-step-undeclared.yaml')], io);
    assert.equal(code, 1, stdout());
    assert.match(stdout(), /ERRORS|required_step_undeclared/);
    assert.match(stdout(), /verify-output/);
  });
});

describe('lint --scenario a duplicate-step-id scenario', () => {
  it('renders the error and exits 1', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', resolve(INVALID, 'duplicate-step-id.yaml')], io);
    assert.equal(code, 1, stdout());
    assert.match(stdout(), /duplicate_step_id|ERRORS/);
  });
});

describe('lint --scenario a malformed-YAML scenario', () => {
  it('reports the parse failure as a lint error (exit 1), not an operator crash', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', brokenYaml], io);
    assert.equal(code, 1, stdout());
    assert.match(stdout(), /scenario-schema|yaml/i);
  });
});

// ── --json ──────────────────────────────────────────────────────────

describe('lint --scenario --json', () => {
  it('emits a parseable object with ok:false + the value-check error', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', resolve(INVALID, 'required-step-undeclared.yaml'), '--json'], io);
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.origin, 'scenario');
    assert.ok(parsed.errors.some(e => e.code === 'required_step_undeclared'));
    assert.ok(typeof parsed.coverageNote === 'string');
  });

  it('emits ok:true on a clean scenario', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', resolve(VALID, 'clean.yaml'), '--json'], io);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.origin, 'scenario');
  });
});

// ── operator-error paths → exit 2 ───────────────────────────────────

describe('lint --scenario operator-error paths exit 2', () => {
  it('exits 2 when no file is given', async () => {
    const { io, stderr } = makeIo();
    const code = await runLint(['--scenario'], io);
    assert.equal(code, 2);
    assert.match(stderr(), /scenario file|no .*file/i);
  });

  it('exits 2 on a missing file', async () => {
    const { io, stderr } = makeIo();
    const code = await runLint(['--scenario', join(tmpDir, 'does-not-exist.yaml')], io);
    assert.equal(code, 2);
    assert.match(stderr(), /could not read|ENOENT|not found/i);
  });
});

// ── --help documents --scenario ─────────────────────────────────────

describe('lint --help documents --scenario', () => {
  it('prints the --scenario mode', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--help'], io);
    assert.equal(code, 0);
    assert.match(stdout(), /--scenario/);
  });
});

// ── main() dispatch — `lint --scenario <file>` routes here ──────────

describe('main() dispatch to scenario lint', () => {
  it('routes `lint --scenario <file>` to the scenario lint path', async () => {
    const { io, stdout } = makeIo();
    const code = await main(['lint', '--scenario', resolve(VALID, 'clean.yaml')], io);
    assert.equal(code, 0, stdout());
    assert.match(stdout(), /origin: scenario/);
  });
});

// ── golden pin: committed scenario definitions + the example ────────
//    All committed scenario definitions + the example are schema-clean and lint
//    clean (exit 0). swarm-audit.yaml previously carried an undocumented
//    all_steps_pass field the scenario schema rejected (a long-known deferred
//    sibling); task_321f8a44 dropped the redundant field, so it now lints clean
//    like the rest. If a committed scenario ever regains an undeclared field, its
//    assertion here flips back to exit 1.

describe('lint --scenario committed definitions (golden pin)', () => {
  it('record-ingest-roundtrip.yaml lints clean → exit 0', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', resolve(DOGFOOD, 'record-ingest-roundtrip.yaml')], io);
    assert.equal(code, 0, stdout());
  });

  it('examples/scenario.example.yaml lints clean → exit 0', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', resolve(EXAMPLES, 'scenario.example.yaml')], io);
    assert.equal(code, 0, stdout());
  });

  it('swarm-audit.yaml lints clean → exit 0 (all_steps_pass dropped, task_321f8a44)', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--scenario', resolve(DOGFOOD, 'swarm-audit.yaml'), '--json'], io);
    assert.equal(code, 0, stdout());
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.ok, true, stdout());
    assert.equal(parsed.origin, 'scenario');
  });
});
