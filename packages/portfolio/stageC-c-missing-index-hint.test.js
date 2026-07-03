/**
 * F-2130e264 (Stage C humanization) — the portfolio generator's missing-index
 * branch is the ONE index-fault path with no recovery hint, while its two
 * immediate siblings (corrupt-index and wrong-shape) both print a second
 * `Recovery:` line. The missing-index case is the MOST common first-run state:
 * `indexes/latest-by-repo.json` is a generated runtime dir, not committed, so a
 * fresh checkout / a repo where no submission has ever been ingested hits this
 * branch first — and it is precisely the branch that left the operator with a
 * bare path and no next step.
 *
 * Fix: give the missing-index branch the same second line — name that the
 * portfolio reads `indexes/latest-by-repo.json` which ingest generates, and the
 * command to run an ingest first.
 *
 * Exercised against the REAL generate.js via a subprocess with
 * PORTFOLIO_REPO_ROOT pointed at a sandbox (never the real indexes/ tree),
 * matching stageC-ingest-portfolio-guards.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const GENERATE_JS = resolve(__dirname, 'generate.js');

function runCli(repoRoot) {
  try {
    const stdout = execFileSync(process.execPath, [GENERATE_JS], {
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

describe('F-2130e264: missing-index branch names the recovery action', () => {
  it('POSITIVE: a fresh checkout (no index) exits 1 with "Index not found" + a recovery hint naming ingest', () => {
    // Sandbox with NO indexes/latest-by-repo.json — the fresh-checkout state.
    const root = mkdtempSync(join(tmpdir(), 'stageC-c-missing-'));
    mkdirSync(join(root, 'policies', 'repos'), { recursive: true });
    try {
      const { code, stderr } = runCli(root);
      assert.equal(code, 1, `missing index must exit 1; stderr=${stderr}`);
      // Existing message preserved.
      assert.match(stderr, /Index not found/i,
        `must keep the existing "Index not found" message; got: ${stderr}`);
      // The new second line: name the file + that ingest generates it + run an
      // ingest first. Load-bearing tokens, not full prose.
      assert.match(stderr, /latest-by-repo\.json/,
        `recovery hint must name the index file ingest generates; got: ${stderr}`);
      assert.match(stderr, /ingest/i,
        `recovery hint must point at running an ingest; got: ${stderr}`);
      assert.match(stderr, /run\.js|run an ingest|ingest first/i,
        `recovery hint must name the concrete next command; got: ${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
