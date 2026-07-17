/**
 * f-36d8b03d-next-steps-spacing.test.js
 *
 * F-36d8b03d — the dogfood-init NEXT STEPS block rendered two lines with
 * unmarked double-space runs ("PAT with  contents: write  on  <repo>",
 * "name it  DOGFOOD_TOKEN") in a block that is otherwise single-spaced on
 * every one of its ~50 lines, with no backtick/bold convention anywhere in
 * this package's renderers to justify the spacing as deliberate emphasis.
 * It read as formatting residue, visibly uneven in the live terminal output.
 *
 * The fix collapses them to single spaces. This test spawns the real CLI
 * (no mocks — the finding was live-verified against real terminal output),
 * slices the rendered NEXT STEPS block out of stdout, and asserts no line
 * carries an interior multi-space run. Leading indentation is exempt: the
 * block indents numbered items and sub-items by design, so the assertion
 * requires a NON-space character before the run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const INIT_JS = resolve(__dirname, 'init.js');

function runInit(args) {
  try {
    const stdout = execFileSync(process.execPath, [INIT_JS, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH },
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

/** @pins F-36d8b03d */
describe('F-36d8b03d: the rendered NEXT STEPS block is uniformly single-spaced', () => {
  it('no line in the live-rendered block has an interior multi-space run', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-init-spacing-'));
    try {
      const { code, stdout, stderr } = runInit(['--dir', root]);
      assert.equal(code, 0, `scaffold must succeed; stderr=${stderr}`);

      const start = stdout.indexOf('NEXT STEPS');
      assert.ok(start >= 0, 'stdout must contain the NEXT STEPS block');
      const block = stdout.slice(start);

      const offenders = block
        .split('\n')
        .filter((line) => /\S {2,}\S/.test(line));
      assert.deepEqual(offenders, [],
        'every line must be single-spaced after its leading indentation — ' +
        'unmarked double-space emphasis reads as formatting residue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: the de-emphasized terms are still present, verbatim', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-init-spacing-ctl-'));
    try {
      const { stdout } = runInit(['--dir', root]);
      // Collapsing spacing must not have dropped or reworded the two values
      // the operator actually has to type.
      assert.match(stdout, /contents: write/);
      assert.match(stdout, /DOGFOOD_TOKEN/);
      assert.match(stdout, /Mint a fine-grained PAT with contents: write on /);
      assert.match(stdout, /name it DOGFOOD_TOKEN/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
