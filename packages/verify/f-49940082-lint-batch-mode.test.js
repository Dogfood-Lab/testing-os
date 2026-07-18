/**
 * F-49940082: `dogfood-verify lint <file>` accepted exactly one positional file path —
 * no directory or glob mode. The only batch-lint capability in the repo was
 * scripts/lint-policies.test.mjs's private policyFiles() walker, which called
 * lintPolicy() + originForPath() directly and completely bypassed this CLI's real
 * entrypoint: its argument parser, its LintOperatorError handling, its renderLintText
 * output formatting, and its documented exit-code contract were never exercised by
 * that gate.
 *
 * This file proves the fix: a directory-or-multi-path batch mode that reuses the exact
 * single-file render/exit machinery per discovered file, aggregates a summary, and
 * leaves the single-positional-file invocation on its own unchanged code path (see
 * "single-file invocation is unchanged" below). The byte-identical claim for that path
 * is additionally proven outside this suite by a pre/post output capture-diff over the
 * package's existing single-file fixtures (clean/error/warning/parse-failure, policy
 * and scenario mode, text and --json) — reported alongside this file in the swarm
 * finding's return, not repeated here as a test since it compares two versions of the
 * source, not behavior a single checkout can assert.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runLint, walkYamlFiles, renderBatchSummary, buildBatchLintJson } from './cli-lint.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LINT = resolve(__dirname, '../../fixtures/policies/lint');
const SCENARIO_INVALID = resolve(__dirname, 'fixtures/scenarios/invalid');
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
let validFile, errorFile, warnFile, nestedValidFile, emptyDir, notesFile;
let onlyEmptyRoot, onlyEmptyLeaf;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'verify-lint-batch-'));

  // Seed from the SAME fixtures cli-lint.test.js already pins individually (clean,
  // unknown-field, footgun) — batch mode's correctness for any ONE file is inherited
  // from those already-proven single-file assertions; what these tests add is
  // aggregation, discovery, and the exit/summary contract across several files.
  const cleanRaw = readFileSync(resolve(LINT, 'clean.yaml'), 'utf-8');
  const errorRaw = readFileSync(resolve(LINT, 'unknown-field.yaml'), 'utf-8');
  const warnRaw = readFileSync(resolve(LINT, 'footgun-negative-over-array.yaml'), 'utf-8');

  validFile = join(tmpDir, 'valid.yaml');
  errorFile = join(tmpDir, 'error.yaml');
  warnFile = join(tmpDir, 'warn.yaml');
  notesFile = join(tmpDir, 'notes.txt');
  writeFileSync(validFile, cleanRaw, 'utf-8');
  writeFileSync(errorFile, errorRaw, 'utf-8');
  writeFileSync(warnFile, warnRaw, 'utf-8');
  writeFileSync(notesFile, 'plain text, not YAML, and not a .yaml/.yml extension', 'utf-8');

  const nestedDir = join(tmpDir, 'nested');
  mkdirSync(nestedDir);
  nestedValidFile = join(nestedDir, 'nested-valid.yaml');
  writeFileSync(nestedValidFile, cleanRaw, 'utf-8');

  emptyDir = join(tmpDir, 'empty');
  mkdirSync(emptyDir);

  // A wholly separate root whose only content is an empty subdirectory — isolates the
  // "nothing to lint" aggregate-empty case from tmpDir's other, real files.
  onlyEmptyRoot = mkdtempSync(join(tmpdir(), 'verify-lint-batch-empty-'));
  onlyEmptyLeaf = join(onlyEmptyRoot, 'leaf');
  mkdirSync(onlyEmptyLeaf);
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(onlyEmptyRoot, { recursive: true, force: true });
});

/** @pins F-49940082 */
describe('F-49940082: dogfood-verify lint accepts a directory or multiple paths', () => {
  describe('directory mode', () => {
    it('walks recursively for yaml/yml files, skips non-yaml, and aggregates a batch summary', async () => {
      const { io, stdout } = makeIo();
      const code = await runLint([tmpDir], io);
      assert.equal(code, 1, stdout()); // error.yaml has an error -> batch exit 1

      // One rendered block per discovered file (including the nested one)...
      assert.match(stdout(), /file:\s+.*valid\.yaml/);
      assert.match(stdout(), /file:\s+.*error\.yaml/);
      assert.match(stdout(), /file:\s+.*warn\.yaml/);
      assert.match(stdout(), /file:\s+.*nested-valid\.yaml/);
      // ...and notes.txt (no yaml/yml extension) was never discovered by the walk.
      assert.doesNotMatch(stdout(), /notes\.txt/);

      assert.match(stdout(), /BATCH SUMMARY: 4 file\(s\) linted -- 2 clean, 1 with warnings, 1 with errors/);
    });
  });

  describe('multi-path mode', () => {
    it('lints multiple explicit files as one batch', async () => {
      const { io, stdout } = makeIo();
      const code = await runLint([validFile, errorFile], io);
      assert.equal(code, 1, stdout());
      assert.match(stdout(), /BATCH SUMMARY: 2 file\(s\) linted -- 1 clean, 0 with warnings, 1 with errors/);
    });

    it('an all-clean multi-path batch exits 0', async () => {
      const { io, stdout } = makeIo();
      const code = await runLint([validFile, nestedValidFile], io);
      assert.equal(code, 0, stdout());
      assert.match(stdout(), /BATCH SUMMARY: 2 file\(s\) linted -- 2 clean, 0 with warnings, 0 with errors/);
    });

    it('an explicit file positional is linted directly, bypassing the extension filter used for directory discovery', async () => {
      // notes.txt would be SKIPPED if only reachable via a directory walk (it has
      // neither a .yaml nor .yml extension), but here it is a NAMED positional, so it
      // is trusted as authored intent and linted -- it is not a valid policy document,
      // which is exactly the expected, informative outcome (an error entry, not silent
      // exclusion).
      const { io, stdout } = makeIo();
      const code = await runLint([validFile, notesFile], io);
      assert.equal(code, 1, stdout());
      assert.match(stdout(), /notes\.txt/);
      assert.match(stdout(), /BATCH SUMMARY: 2 file\(s\) linted -- 1 clean, 0 with warnings, 1 with errors/);
    });

    it('a missing explicit path in a multi-path batch is a per-file error, not an operator abort', async () => {
      const missing = join(tmpDir, 'does-not-exist.yaml');
      const { io, stdout } = makeIo();
      const code = await runLint([validFile, missing], io);
      assert.equal(code, 1, stdout()); // batch mode, not the legacy exit-2 operator path
      assert.match(stdout(), /VERDICT: CLEAN/); // valid.yaml is still linted and reported
      assert.match(stdout(), /path_unreadable/);
      assert.match(stdout(), /could not read policy file/);
    });
  });

  describe('empty directory fails loud (never a silent exit 0)', () => {
    it('a lone empty directory exits 2 with a clear message', async () => {
      const { io, stderr } = makeIo();
      const code = await runLint([onlyEmptyRoot], io);
      assert.equal(code, 2);
      assert.match(stderr(), /no policy files found|nothing to lint/i);
    });

    it('multiple positionals that are all empty of yaml also exit 2, not a vacuous pass', async () => {
      const { io, stderr } = makeIo();
      const code = await runLint([onlyEmptyRoot, onlyEmptyLeaf], io);
      assert.equal(code, 2);
      assert.match(stderr(), /no policy files found|nothing to lint/i);
    });
  });

  describe('--json batch shape', () => {
    it('emits { mode: "batch", ok, summary, files } -- one entry per file, same shape as the single-file result', async () => {
      const { io, stdout } = makeIo();
      const code = await runLint([tmpDir, '--json'], io);
      assert.equal(code, 1);
      const parsed = JSON.parse(stdout());
      assert.equal(parsed.mode, 'batch');
      assert.equal(parsed.ok, false);
      assert.deepEqual(parsed.summary, { total: 4, clean: 2, withErrors: 1, withWarnings: 1 });
      assert.equal(parsed.files.length, 4);
      for (const f of parsed.files) {
        assert.ok(
          'file' in f && 'origin' in f && 'ok' in f && 'errors' in f && 'warnings' in f && 'coverageNote' in f,
          `batch file entry missing a single-file-shape key: ${JSON.stringify(f)}`
        );
      }
    });

    it('ok:true and exit 0 when the whole batch is clean or warnings-only', async () => {
      const { io, stdout } = makeIo();
      const code = await runLint([validFile, warnFile, '--json'], io);
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.summary.withErrors, 0);
    });
  });

  describe('--scenario batch mode (uniform with policy mode)', () => {
    it('walks a directory of scenario fixtures and lints each with lintScenario, not lintPolicy', async () => {
      const { io, stdout } = makeIo();
      const code = await runLint(['--scenario', SCENARIO_INVALID], io);
      assert.equal(code, 1, stdout());
      // Both fixtures under fixtures/scenarios/invalid/ are known-invalid (already
      // pinned individually by cli-lint-scenario.test.js), so both land in withErrors
      // regardless of any incidental footgun warning either might also carry -- the
      // errors-first verdict precedence (see renderLintText) makes this deterministic.
      assert.match(stdout(), /BATCH SUMMARY: 2 file\(s\) linted -- 0 clean, 0 with warnings, 2 with errors/);
      const originCount = (stdout().match(/origin: scenario/g) || []).length;
      assert.equal(originCount, 2, 'both discovered scenario files should report origin: scenario');
    });
  });

  describe('single-file invocation is unchanged (legacy path, not batch)', () => {
    it('a lone file positional never prints a batch summary', async () => {
      const { io, stdout } = makeIo();
      const code = await runLint([validFile], io);
      assert.equal(code, 0, stdout());
      assert.doesNotMatch(stdout(), /BATCH SUMMARY/);
    });

    it('a lone file positional --json output is a bare result object, not { mode: "batch" }', async () => {
      const { io, stdout } = makeIo();
      const code = await runLint([validFile, '--json'], io);
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout());
      assert.equal(parsed.mode, undefined);
      assert.equal(parsed.file, validFile);
      assert.equal(parsed.ok, true);
    });

    it('the old "more than one file" operator error is gone by design -- two files now batch instead of exit 2', async () => {
      const { io } = makeIo();
      const code = await runLint([validFile, errorFile], io);
      assert.notEqual(code, 2, 'F-49940082 intentionally replaces this restriction with batch mode');
    });
  });

  describe('walkYamlFiles (the directory-discovery primitive) mirrors policyFiles() semantics', () => {
    it('finds every yaml/yml file recursively and excludes non-yaml siblings', () => {
      const found = walkYamlFiles(tmpDir).sort();
      const expected = [errorFile, nestedValidFile, validFile, warnFile].sort();
      assert.deepEqual(found, expected);
    });

    it('returns an empty array for a directory with nothing to walk', () => {
      assert.deepEqual(walkYamlFiles(emptyDir), []);
    });
  });

  describe('renderBatchSummary / buildBatchLintJson (pure render helpers)', () => {
    it('renderBatchSummary prints the four counts in the documented order', () => {
      const text = renderBatchSummary({ total: 5, clean: 2, withErrors: 1, withWarnings: 2 });
      assert.match(text, /BATCH SUMMARY: 5 file\(s\) linted -- 2 clean, 2 with warnings, 1 with errors/);
    });

    it('buildBatchLintJson derives ok from summary.withErrors, independent of caller intent', () => {
      const clean = buildBatchLintJson([], { total: 0, clean: 0, withErrors: 0, withWarnings: 0 });
      assert.equal(clean.ok, true);
      const dirty = buildBatchLintJson([], { total: 1, clean: 0, withErrors: 1, withWarnings: 0 });
      assert.equal(dirty.ok, false);
    });
  });
});
