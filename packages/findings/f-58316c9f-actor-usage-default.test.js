/**
 * F-58316c9f — review-verb Usage strings presented `--actor <name>` as
 * required (no brackets), but every call site defaults with
 * `flags.actor || 'operator'`. Omitting --actor therefore succeeded and
 * wrote audit-trail events as actor 'operator' while Usage claimed actor
 * was mandatory. Combined with F-720be224, a typo'd `--acter` was doubly
 * silent: absorbed, then attributed to the undocumented default.
 *
 * Contract chosen: document the default. Usage / --help show
 * `[--actor <name>]` (default: operator) so help matches runtime. The
 * `flags.actor || 'operator'` default is preserved.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, 'cli.js');

let TEST_ROOT;
const FINDING_ID = 'dfind-f58316c9f-actor';

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, FINDINGS_REPO_ROOT: TEST_ROOT },
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

before(() => {
  TEST_ROOT = mkdtempSync(join(tmpdir(), 'f-58316c9f-'));
  const finding = {
    schema_version: '1.0.0',
    finding_id: FINDING_ID,
    title: 'Actor Usage/runtime parity pin seed',
    status: 'candidate',
    repo: 'org/widget',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'docs_code_drift',
    remediation_kind: 'scenario_change',
    transfer_scope: 'repo_local',
    summary: 'Seed for F-58316c9f actor default pin.',
    source_record_ids: ['widget-run-1'],
    evidence: [{ evidence_kind: 'record', record_id: 'widget-run-1' }],
  };
  const dir = join(TEST_ROOT, 'findings', 'org', 'widget');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${FINDING_ID}.yaml`), yaml.dump(finding, { lineWidth: 120, noRefs: true }));
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** @pins F-58316c9f */
describe('F-58316c9f: --actor Usage documents the runtime default', () => {
  it('Usage for mutating verbs shows [--actor <name>] (default: operator), not required --actor', () => {
    for (const verb of ['accept', 'reject', 'review', 'reopen', 'invalidate', 'edit']) {
      const { code, stderr } = runCli([verb]);
      assert.equal(code, 2, `${verb} without id must exit 2; stderr=${stderr}`);
      assert.match(stderr, /\[--actor <name>\]/,
        `${verb} Usage must bracket actor as optional; stderr=${stderr}`);
      assert.match(stderr, /default:\s*operator/,
        `${verb} Usage must document default: operator; stderr=${stderr}`);
      // Must NOT present bare required form without brackets.
      assert.doesNotMatch(stderr, /<finding_id> --actor <name>/,
        `${verb} Usage must not present --actor as required; stderr=${stderr}`);
    }

    const merge = runCli(['merge', 'a']);
    assert.equal(merge.code, 2);
    assert.match(merge.stderr, /\[--actor <name>\]/);
    assert.match(merge.stderr, /default:\s*operator/);
  });

  it('--help documents [--actor <name>] default: operator for mutating verbs', () => {
    const { code, stdout } = runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /accept <id>.*\[--actor <name>\] default: operator/s);
    assert.match(stdout, /edit <id>.*\[--actor <name>\] default: operator/s);
    assert.match(stdout, /merge <ids\.\.\.>.*\[--actor <name>\] default: operator/s);
  });

  it('runtime: omitting --actor succeeds and attributes the event to operator', () => {
    const { code, stdout, stderr } = runCli(['accept', FINDING_ID]);
    assert.equal(code, 0, `omitting --actor must still succeed; stderr=${stderr}`);
    assert.match(stdout, new RegExp(`accept: ${FINDING_ID} → accepted`));

    // Audit trail must record the documented default actor, not fail loud.
    // Scrape via history --json so we pin the operator-visible contract.
    const hist = runCli(['history', FINDING_ID, '--json']);
    assert.equal(hist.code, 0, `history --json must work; stderr=${hist.stderr}`);
    const events = JSON.parse(hist.stdout);
    assert.ok(Array.isArray(events) && events.length >= 1, 'accept must emit a review event');
    const acceptEvent = events.find((e) => e.action === 'accept') || events[events.length - 1];
    assert.equal(acceptEvent.actor, 'operator',
      `omitted --actor must attribute to 'operator'; got ${JSON.stringify(acceptEvent)}`);
  });
});
