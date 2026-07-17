/**
 * f-418f507c-unknown-arg-rejection.test.js
 *
 * F-418f507c (Stage C humanization) — main()'s arg loop checked four exact
 * flags via if/else-if with NO trailing `else` to catch an unrecognized
 * token, unlike its two siblings in this same domain (packages/verify/cli.js,
 * packages/findings/cli.js), which both reject an unknown argument with a
 * structured error. Pre-fix, ANY unrecognized token — a typo, a flag copied
 * from a different subcommand, or literally `--version` — was silently
 * ignored and the tool proceeded to run its FULL default action, including
 * writing the portfolio report + indexes/trends.json + indexes/badges/*.json
 * to disk. Live-proven trigger: `--no-trend` (missing the trailing 's')
 * printed "Trends written: ..." with zero warning that the operator's
 * explicitly-stated intent to skip the write was silently overridden.
 *
 * Fix: a trailing `else` that names the unrecognized token, points at
 * --help, and exits 2 — matching the sibling pattern already correct in
 * verify/cli.js and findings/cli.js.
 *
 * Exercised against the REAL generate.js via a subprocess with
 * PORTFOLIO_REPO_ROOT pointed at an EMPTY sandbox (never the real repo),
 * matching stageC-c-missing-index-hint.test.js's own convention — this
 * means even a broken fix can, at worst, write into a throwaway temp dir
 * that gets deleted in `finally`, never the real tracked
 * reports/dogfood-portfolio.json or indexes/*.
 *
 * RED proof (reasoned): pre-fix, an unrecognized token fell through the
 * whole if/else-if chain with no matching branch and no trailing else —
 * confirmed by reading the loop body directly (four `if`/`else if` arms,
 * no further clause). The loop iteration would complete silently and
 * `main()` would proceed past the loop into its default action. This is
 * NOT re-executed against the pre-fix code because doing so against a
 * REAL index would risk exactly the accidental-overwrite hazard the
 * finding's own reachability proof already fell into once (and reverted).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const GENERATE_JS = resolve(__dirname, 'generate.js');

function emptySandbox(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'policies', 'repos'), { recursive: true });
  return root;
}

function runCli(repoRoot, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [GENERATE_JS, ...args], {
      env: { ...process.env, PORTFOLIO_REPO_ROOT: repoRoot },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

/** @pins F-418f507c */
describe('F-418f507c: unrecognized CLI argument is rejected, not silently absorbed', () => {
  it('a bogus flag exits 2 naming the unknown argument, before ever reaching the index read', () => {
    const root = emptySandbox('f-418f507c-bogus-');
    try {
      const { code, stderr } = runCli(root, ['--bogus-flag']);
      assert.equal(code, 2, `must exit 2; stderr=${stderr}`);
      assert.match(stderr, /Unknown argument: --bogus-flag/,
        `must name the actual unrecognized token; stderr=${stderr}`);
      assert.match(stderr, /--help/i, `must point at --help; stderr=${stderr}`);
      // Load-bearing: the rejection must happen in the arg loop, BEFORE the
      // existsSync(INDEX_PATH) branch — proven by the absence of the
      // missing-index message this sandbox would otherwise trigger.
      assert.doesNotMatch(stderr, /Index not found/,
        `rejection must happen before the index is ever read; stderr=${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the exact reachability repro (--no-trend, missing the trailing "s") is now rejected instead of silently running the default action', () => {
    const root = emptySandbox('f-418f507c-notrend-');
    try {
      const { code, stderr } = runCli(root, ['--no-trend']);
      assert.equal(code, 2, `must exit 2; stderr=${stderr}`);
      assert.match(stderr, /Unknown argument: --no-trend\b/);
      // Nothing should have been written into the sandbox at all.
      assert.equal(existsSync(join(root, 'reports')), false,
        'no report should be written when the CLI rejects at parse time');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a plausible copy-paste-from-another-CLI flag (--version) is rejected the same way', () => {
    const root = emptySandbox('f-418f507c-version-');
    try {
      const { code, stderr } = runCli(root, ['--version']);
      assert.equal(code, 2);
      assert.match(stderr, /Unknown argument: --version/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: recognized flags (--no-trends --no-badges) are NOT rejected — still fall through to the (empty-sandbox) missing-index branch', () => {
    const root = emptySandbox('f-418f507c-control-');
    try {
      const { code, stderr } = runCli(root, ['--no-trends', '--no-badges']);
      assert.doesNotMatch(stderr, /Unknown argument/,
        `recognized flags must not trip the new rejection; stderr=${stderr}`);
      // No index in this empty sandbox, so it still exits 1 for THAT reason —
      // proving the flags themselves were accepted and parsing proceeded.
      assert.equal(code, 1);
      assert.match(stderr, /Index not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: --help still works and exits 0, unaffected by the new trailing else', () => {
    const root = emptySandbox('f-418f507c-help-');
    try {
      const { code, stdout, stderr } = runCli(root, ['--help']);
      assert.equal(code, 0, `stdout=${stdout} stderr=${stderr}`);
      assert.match(stdout, /Usage: portfolio/);
      assert.doesNotMatch(stderr, /Unknown argument/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
