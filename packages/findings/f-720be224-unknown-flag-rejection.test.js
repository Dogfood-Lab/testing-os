/**
 * F-720be224 — findings CLI parseArgs had no known-flag allowlist: every
 * `--*`-shaped token was absorbed into `flags`, so typos silently changed
 * verb behaviour. Live proofs against the pre-fix parser:
 *   - `derive --all --writ` → flags.write undefined → dry-run with zero
 *     warning that write intent was lost
 *   - `list --repso org/repo` → flags.repo undefined → unfiltered list
 *   - `accept F-abc --acter mike` → flags.acter='mike', then
 *     `flags.actor || 'operator'` silently attributed the mutation to
 *     'operator'
 *
 * Fix: valueFlags+booleans allowlist (mirrors report/cli.js); unrecognized
 * `--*` exits 2 with ERROR [BAD_ARGS] + Next → `dogfood findings --help`.
 * Equals-form and boolean flags stay working.
 *
 * Exercised against the REAL cli.js via subprocess with FINDINGS_REPO_ROOT
 * pointed at an empty sandbox — rejection must happen at parse time, before
 * any verb body runs (no dry-run banner, no list output, no accept path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, 'cli.js');

function emptySandbox(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'findings'), { recursive: true });
  mkdirSync(join(root, 'records'), { recursive: true });
  return root;
}

function runCli(repoRoot, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, FINDINGS_REPO_ROOT: repoRoot },
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

function assertBadArgs(stderr, flag) {
  assert.match(stderr, /^ERROR \[BAD_ARGS\]:/m, `must use ERROR [BAD_ARGS] envelope; got: ${stderr}`);
  assert.match(stderr, new RegExp(`unknown flag "${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    `must name the unrecognized token; got: ${stderr}`);
  assert.match(stderr, /Next:.*dogfood findings --help/,
    `Next must point at dogfood findings --help; got: ${stderr}`);
}

/** @pins F-720be224 */
describe('F-720be224: findings CLI rejects unrecognized --flags at parse time', () => {
  it('--writ on derive exits 2 and does NOT dry-run', () => {
    const root = emptySandbox('f-720be224-writ-');
    try {
      const { code, stdout, stderr } = runCli(root, ['derive', '--all', '--writ']);
      assert.equal(code, 2, `must exit 2; stderr=${stderr}`);
      assertBadArgs(stderr, '--writ');
      assert.doesNotMatch(stdout, /dry-run/,
        `must not reach the derive dry-run path; stdout=${stdout}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--repso on list exits 2 and does NOT emit an unfiltered list', () => {
    const root = emptySandbox('f-720be224-repso-');
    try {
      const { code, stdout, stderr } = runCli(root, ['list', '--repso', 'org/repo']);
      assert.equal(code, 2, `must exit 2; stderr=${stderr}`);
      assertBadArgs(stderr, '--repso');
      assert.doesNotMatch(stdout, /finding\(s\)|No findings found/,
        `must not reach the list verb body; stdout=${stdout}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--acter on accept exits 2 and does NOT attribute to operator', () => {
    const root = emptySandbox('f-720be224-acter-');
    try {
      // Seed a candidate so a silent-absorption regression would actually
      // reach performAction and mis-attribute — the pin must refuse first.
      const finding = {
        schema_version: '1.0.0',
        finding_id: 'dfind-f720be224-acter',
        title: 'Unknown-flag pin seed',
        status: 'candidate',
        repo: 'org/widget',
        product_surface: 'cli',
        journey_stage: 'first_run',
        issue_kind: 'entrypoint_truth',
        root_cause_kind: 'docs_code_drift',
        remediation_kind: 'scenario_change',
        transfer_scope: 'repo_local',
        summary: 'Seed for --acter rejection pin.',
        source_record_ids: ['widget-run-1'],
        evidence: [{ evidence_kind: 'record', record_id: 'widget-run-1' }],
      };
      const dir = join(root, 'findings', 'org', 'widget');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${finding.finding_id}.yaml`), yaml.dump(finding, { lineWidth: 120, noRefs: true }));

      const { code, stdout, stderr } = runCli(root, [
        'accept', finding.finding_id, '--acter', 'mike',
      ]);
      assert.equal(code, 2, `must exit 2; stderr=${stderr}`);
      assertBadArgs(stderr, '--acter');
      assert.doesNotMatch(stdout, /accept:|→ accepted|by operator/,
        `must not reach accept / attribute to operator; stdout=${stdout}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: equals-form and boolean known flags still parse (--write, --actor=mike)', () => {
    const root = emptySandbox('f-720be224-control-');
    try {
      // --write is boolean; --all is boolean. Empty records → "No records found"
      // after parse succeeds, proving the allowlist accepted both flags.
      const { code, stderr } = runCli(root, ['derive', '--all', '--write']);
      assert.doesNotMatch(stderr, /unknown flag/,
        `known flags must not trip BAD_ARGS; stderr=${stderr}`);
      assert.equal(code, 1, `empty sandbox should fail at records, not at parse; stderr=${stderr}`);
      assert.match(stderr, /No records found/);

      // Equals-form value flag on a read verb: --repo=… is accepted; empty
      // findings tree yields the human "No findings found" path (exit 0).
      const list = runCli(root, ['list', '--repo=org/widget']);
      assert.doesNotMatch(list.stderr, /unknown flag/);
      assert.equal(list.code, 0);
      assert.match(list.stdout, /No findings found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
