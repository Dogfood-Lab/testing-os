/**
 * scaffold-cp-path.test.js — the templated build step must reference the path
 * dogfood-init actually writes.
 *
 * The scaffold writes scenario-results.example.json to the consumer repo ROOT
 * (init.js: writeFileMakingDirs(join(targetDir, 'scenario-results.example.json'))).
 * But the bundled dogfood.yml's "Build scenario results" step copied from
 * `examples/scenario-results.example.json` — a path that does NOT exist in a
 * freshly scaffolded consumer repo, so the very first run of the copy-pasted
 * workflow fails on a missing file. This test pins the two in agreement: the cp
 * SOURCE in the template is the path init writes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const INIT_JS = resolve(__dirname, 'init.js');
const TEMPLATES_DIR = resolve(__dirname, 'templates');

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'report-cppath-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Extract the `cp <src> <dst>` source path from the workflow's build step. */
function cpSourceFromWorkflow(yml) {
  const m = yml.match(/cp\s+(\S+)\s+scenario-results\.json/);
  return m ? m[1] : null;
}

describe('scaffold ↔ template cp-path agreement (FT-cppath)', () => {
  it('the template cp source is the file init writes to the repo root', () => {
    const template = readFileSync(join(TEMPLATES_DIR, 'dogfood.yml'), 'utf-8');
    const cpSrc = cpSourceFromWorkflow(template);
    assert.ok(cpSrc, 'the dogfood.yml build step must contain a `cp <src> scenario-results.json` line');
    assert.equal(
      cpSrc,
      'scenario-results.example.json',
      'the cp source must be the repo-root scenario-results.example.json that dogfood-init writes — ' +
        `not an examples/ path that does not exist in a scaffolded repo (got "${cpSrc}")`
    );
  });

  it('a freshly scaffolded repo actually contains the path the template copies from', () => {
    withTempDir((root) => {
      const { status } = spawnInit(['--dir', root]);
      assert.equal(status, 0, 'init must scaffold cleanly');

      const template = readFileSync(join(TEMPLATES_DIR, 'dogfood.yml'), 'utf-8');
      const cpSrc = cpSourceFromWorkflow(template);

      const present = listFilesRecursive(root);
      assert.ok(
        present.includes(cpSrc),
        `the workflow copies from "${cpSrc}" but the scaffold did not write it. ` +
          `Scaffolded files: ${present.join(', ')}`
      );
    });
  });
});

function spawnInit(args) {
  try {
    execFileSync(process.execPath, [INIT_JS, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH },
    });
    return { status: 0 };
  } catch (err) {
    return { status: err.status ?? 1 };
  }
}

/** Repo-relative file list (forward-slash) for a scaffolded dir. */
function listFilesRecursive(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(root, rel));
    else out.push(rel);
  }
  return out;
}
