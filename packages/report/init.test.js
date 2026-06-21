/**
 * init.js — dogfood-init scaffolding bin contract suite.
 *
 * The audit found the #1 adoption barrier was "no copy-pasteable workflow
 * exists" and the #1 trip-up was the silent DOGFOOD_TOKEN failure. `dogfood-init`
 * automates the copy. These tests pin its operator contract by spawning the real
 * bin (no mocks): it scaffolds the canonical templates into a target dir, never
 * clobbers an existing workflow without --force, and prints a next-steps block
 * that ends on the DOGFOOD_TOKEN setup so the silent failure is impossible to miss.
 *
 * Run as a child process (not by importing `run`) because the contract under test
 * is exit codes + stdout/stderr separation + files-on-disk — what a consumer who
 * runs `npx @dogfood-lab/report` (init) actually depends on.
 *
 * The anti-drift seal lives here too: a test that reads templates/ AND examples/
 * and asserts byte-equality, so the bundled-into-npm copy can never silently drift
 * from the canonical examples/ starter kit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const INIT_JS = resolve(__dirname, 'init.js');
const TEMPLATES_DIR = resolve(__dirname, 'templates');
const EXAMPLES_DIR = resolve(__dirname, '..', '..', 'examples');

const WORKFLOW_REL = join('.github', 'workflows', 'dogfood.yml');

function runInit(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [INIT_JS, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Strip the GitHub Actions env so git-remote / env fallbacks can't be
      // satisfied by the test runner's own environment.
      env: { PATH: process.env.PATH, ...opts.env },
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

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'report-init-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('dogfood-init bundled templates (anti-drift seal)', () => {
  const files = [
    'dogfood.yml',
    'scenario-results.example.json',
    'policy.example.yaml',
  ];

  for (const name of files) {
    it(`templates/${name} is byte-identical to examples/${name}`, () => {
      const bundled = readFileSync(join(TEMPLATES_DIR, name));
      const canonical = readFileSync(join(EXAMPLES_DIR, name));
      assert.ok(
        bundled.equals(canonical),
        `packages/report/templates/${name} drifted from examples/${name}. ` +
          'Re-copy the canonical example into the bundled templates dir — ' +
          'they MUST stay byte-identical so npm consumers get the same starter kit.'
      );
    });
  }
});

describe('dogfood-init scaffolding (FT-init)', () => {
  it('scaffolds the three artifacts into a target dir and exits 0', () => {
    withTempDir((root) => {
      const { code, stdout, stderr } = runInit(['--dir', root]);
      assert.equal(code, 0, `expected exit 0; stderr=${stderr}`);

      assert.ok(existsSync(join(root, WORKFLOW_REL)),
        'must write .github/workflows/dogfood.yml');
      assert.ok(existsSync(join(root, 'scenario-results.example.json')),
        'must write scenario-results.example.json');
      assert.ok(existsSync(join(root, 'policy.example.yaml')),
        'must write a local policy.example.yaml for the consumer to PR upstream');

      // The workflow is the deliverable; success must name it on stdout/stderr.
      assert.match(stdout + stderr, /dogfood\.yml/);
    });
  });

  it('writes a workflow byte-identical to the template when no git slug is detected', () => {
    withTempDir((root) => {
      // No --slug, no git remote, GITHUB_REPOSITORY stripped → placeholders stay.
      const { code } = runInit(['--dir', root]);
      assert.equal(code, 0);

      const written = readFileSync(join(root, WORKFLOW_REL));
      const template = readFileSync(join(TEMPLATES_DIR, 'dogfood.yml'));
      assert.ok(
        written.equals(template),
        'with no detectable slug, the scaffolded dogfood.yml must equal the template byte-for-byte'
      );
    });
  });

  it('substitutes the repo slug into scenario-results when --slug is supplied', () => {
    withTempDir((root) => {
      const { code, stdout } = runInit(['--dir', root, '--slug', 'acme/widgets']);
      assert.equal(code, 0);

      const scenarios = readFileSync(
        join(root, 'scenario-results.example.json'),
        'utf-8'
      );
      assert.match(scenarios, /acme\/widgets/,
        'the detected/declared slug must replace the your-org/your-repo placeholder');
      assert.doesNotMatch(scenarios, /your-org\/your-repo/,
        'no your-org/your-repo placeholder should remain after slug substitution');
      // The output must SAY it substituted so the operator knows it happened.
      assert.match(stdout, /acme\/widgets/);
    });
  });

  it('leaves the placeholder AND says so when no slug can be detected', () => {
    withTempDir((root) => {
      const { code, stdout } = runInit(['--dir', root]);
      assert.equal(code, 0);

      const scenarios = readFileSync(
        join(root, 'scenario-results.example.json'),
        'utf-8'
      );
      assert.match(scenarios, /your-org\/your-repo/,
        'with no slug, the placeholder must be left intact');
      assert.match(stdout, /your-org\/your-repo/,
        'output must tell the operator the placeholder was left in place');
    });
  });

  it('refuses to overwrite an existing dogfood.yml and exits 2 (structured)', () => {
    withTempDir((root) => {
      const dest = join(root, WORKFLOW_REL);
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      writeFileSync(dest, 'name: my-precious-existing-workflow\n', 'utf-8');

      const { code, stdout, stderr } = runInit(['--dir', root]);
      assert.equal(code, 2, `existing workflow without --force must exit 2; stderr=${stderr}`);
      assert.match(stderr, /^ERROR \[TARGET_EXISTS\]:/m,
        `stderr must carry the structured envelope; got: ${stderr}`);

      // The consumer's file must be untouched — never clobber silently.
      const after = readFileSync(dest, 'utf-8');
      assert.equal(after, 'name: my-precious-existing-workflow\n',
        'the existing workflow must be left exactly as it was');
      assert.equal(stdout, '', 'no JSON/output leaks to stdout on the refuse path');
    });
  });

  it('--force overwrites an existing dogfood.yml', () => {
    withTempDir((root) => {
      const dest = join(root, WORKFLOW_REL);
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      writeFileSync(dest, 'name: stale\n', 'utf-8');

      const { code, stderr } = runInit(['--dir', root, '--force']);
      assert.equal(code, 0, `--force must overwrite and exit 0; stderr=${stderr}`);

      const written = readFileSync(dest);
      const template = readFileSync(join(TEMPLATES_DIR, 'dogfood.yml'));
      assert.ok(written.equals(template),
        '--force must replace the existing workflow with the template');
    });
  });

  it('prints a LOUD next-steps block ending on DOGFOOD_TOKEN setup', () => {
    withTempDir((root) => {
      const { code, stdout } = runInit(['--dir', root]);
      assert.equal(code, 0);

      assert.match(stdout, /DOGFOOD_TOKEN/,
        'the #1 silent-failure (missing DOGFOOD_TOKEN) must be in the output');
      assert.match(stdout, /contents:\s*write/i,
        'next steps must spell out the fine-grained PAT scope (contents:write)');
      assert.match(stdout, /dogfood-lab\/testing-os/,
        'next steps must name the receiver repo the PAT is scoped to');
      // DOGFOOD_TOKEN must be the LAST/most-prominent step, not buried mid-list.
      const lastTokenIdx = stdout.lastIndexOf('DOGFOOD_TOKEN');
      const tail = stdout.slice(lastTokenIdx);
      assert.ok(tail.length < stdout.length / 2,
        'the DOGFOOD_TOKEN step must be near the END of the next-steps block');
    });
  });

  it('says where the policy belongs (upstream PR, not the consumer repo)', () => {
    withTempDir((root) => {
      const { code, stdout } = runInit(['--dir', root]);
      assert.equal(code, 0);
      // The policy lives in testing-os, not the consumer's repo — init must say so.
      assert.match(stdout, /policies\/repos\//,
        'output must point at policies/repos/<org>/<repo>.yaml in testing-os');
    });
  });

  it('exits 2 on an unknown flag with a structured error', () => {
    const { code, stderr } = runInit(['--bogus']);
    assert.equal(code, 2);
    assert.match(stderr, /^ERROR \[/m, 'unknown flag must produce the structured envelope');
  });

  it('--help prints usage and exits 0', () => {
    const { code, stdout } = runInit(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /dogfood-init/);
    assert.match(stdout, /--force/);
  });
});
