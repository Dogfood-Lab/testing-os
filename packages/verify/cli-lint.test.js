/**
 * cli-lint.test.js (VERIFY-F3) — the `dogfood-verify lint <policy-file>` subcommand.
 *
 * The lint verb is a separate parse/render path from the verify `run` (different
 * input — a policy YAML, not a submission JSON — and a different notion of "pass").
 * The bin's `main` dispatcher routes `lint` here and leaves the verify path
 * untouched. Exit contract mirrors the verify path: 0 clean/warn-only, 1 errors,
 * 2 operator/IO. See docs/policy-lint.md.
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
const LINT = resolve(__dirname, '../../fixtures/policies/lint');
const INVALID = resolve(__dirname, '../../fixtures/policies/invalid');
const VERIFY_FIXTURES = resolve(__dirname, 'fixtures');
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
  tmpDir = mkdtempSync(join(tmpdir(), 'verify-lint-'));
  brokenYaml = join(tmpDir, 'broken.yaml');
  writeFileSync(brokenYaml, 'policy_version: "1.0.0"\n  : : not valid yaml :\n', 'utf-8');
});

// ── clean / warn-only → exit 0 ──────────────────────────────────────

describe('lint a clean policy', () => {
  it('reports a clean verdict and exits 0', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint([resolve(LINT, 'clean.yaml')], io);
    assert.equal(code, 0, stdout());
    assert.match(stdout(), /VERDICT: (CLEAN|OK|PASS)/);
  });
});

describe('lint a footgun policy (warn-only)', () => {
  it('warns, suggests the fail-closed rewrite, and still exits 0 (advisory)', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint([resolve(LINT, 'footgun-negative-over-array.yaml')], io);
    assert.equal(code, 0, `footgun is advisory → exit 0\n${stdout()}`);
    assert.match(stdout(), /WARNING|footgun/i);
    assert.match(stdout(), /evidence\[\]\.kind/);
    assert.match(stdout(), /not.*any/s);
  });
});

// ── static / structural errors → exit 1 ─────────────────────────────

describe('lint an unknown-field policy', () => {
  it('reports an error and exits 1', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint([resolve(LINT, 'unknown-field.yaml')], io);
    assert.equal(code, 1, stdout());
    assert.match(stdout(), /ERROR|unknown_field/);
    assert.match(stdout(), /nonexistent_field/);
  });
});

describe('lint a structurally-invalid policy', () => {
  it('reports a schema error and exits 1', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint([resolve(INVALID, 'predicate-unknown-op.yaml')], io);
    assert.equal(code, 1, stdout());
    assert.match(stdout(), /policy-schema|ERROR/);
  });
});

describe('lint a malformed-YAML file', () => {
  it('reports the parse failure as a lint error (exit 1), not an operator crash', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint([brokenYaml], io);
    assert.equal(code, 1, stdout());
  });
});

// ── --json ──────────────────────────────────────────────────────────

describe('lint --json', () => {
  it('emits a parseable object with ok + warnings on the footgun policy', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint([resolve(LINT, 'footgun-negative-over-array.yaml'), '--json'], io);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.warnings.length, 1);
    assert.equal(parsed.warnings[0].code, 'footgun-empty-array');
    assert.ok(typeof parsed.coverageNote === 'string');
  });

  it('emits ok:false with errors on the unknown-field policy', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint([resolve(LINT, 'unknown-field.yaml'), '--json'], io);
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.some(e => e.code === 'unknown_field'));
  });
});

// ── operator-error paths → exit 2 ───────────────────────────────────

describe('lint operator-error paths exit 2', () => {
  it('exits 2 when no file is given', async () => {
    const { io, stderr } = makeIo();
    const code = await runLint([], io);
    assert.equal(code, 2);
    assert.match(stderr(), /policy file|no .*file/i);
  });

  it('exits 2 on a missing file', async () => {
    const { io, stderr } = makeIo();
    const code = await runLint([join(tmpDir, 'does-not-exist.yaml')], io);
    assert.equal(code, 2);
    assert.match(stderr(), /could not read|ENOENT|not found/i);
  });

  it('exits 2 on an unknown flag', async () => {
    const { io, stderr } = makeIo();
    const code = await runLint([resolve(LINT, 'clean.yaml'), '--bogus'], io);
    assert.equal(code, 2);
    assert.match(stderr(), /unknown/i);
  });
});

// ── help ────────────────────────────────────────────────────────────

describe('lint --help', () => {
  it('prints usage and exits 0', async () => {
    const { io, stdout } = makeIo();
    const code = await runLint(['--help'], io);
    assert.equal(code, 0);
    assert.match(stdout(), /lint/i);
  });
});

// ── main() dispatch — lint routes here, verify path untouched ───────

describe('main() dispatch', () => {
  it('routes `lint <file>` to the lint path', async () => {
    const { io, stdout } = makeIo();
    const code = await main(['lint', resolve(LINT, 'clean.yaml')], io);
    assert.equal(code, 0, stdout());
    assert.match(stdout(), /VERDICT: (CLEAN|OK|PASS)/);
  });

  it('still routes a submission through the verify path unchanged', async () => {
    const { io, stdout } = makeIo();
    const code = await main(['--file', join(VERIFY_FIXTURES, 'pilot-0-submission.json')], io);
    assert.equal(code, 0, stdout());
    assert.match(stdout(), /VERDICT: ACCEPTED/);
  });
});
