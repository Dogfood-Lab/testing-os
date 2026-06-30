/**
 * feat: findings-list-show-json — uniform --json on the per-finding READ verbs.
 *
 * list / show / history / queue and the synthesis list/show blocks
 * (patterns / recommendations / doctrine) gain a --json flag that emits pure
 * structured JSON on stdout — the underlying object(s) or a clean projection —
 * mirroring how advise --json / sync-export --json already behave (see
 * advise/advise-json-cli.test.js). The default human text output must stay
 * byte-identical, so each verb is also exercised WITHOUT --json to guard
 * against the flag silently inverting.
 *
 * The CLI hardcodes ROOT from $FINDINGS_REPO_ROOT when set, so these tests
 * stand up a real data root in a temp dir (the setupTestRoot copy-to-disk
 * pattern) and run cli.js as a subprocess against it — no mocks, real load
 * paths.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, 'cli.js');

let TEST_ROOT;

function writeFinding(id, overrides = {}) {
  const finding = {
    schema_version: '1.0.0',
    finding_id: id,
    title: 'CLI entrypoint flags must match the real argparse contract',
    status: 'candidate',
    repo: 'mcp-tool-shop-org/widget',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'docs_code_drift',
    remediation_kind: 'scenario_change',
    transfer_scope: 'surface_archetype',
    summary: 'A scenario assumed a flag the CLI does not accept, so it exited 2.',
    source_record_ids: ['widget-run-1'],
    evidence: [{ evidence_kind: 'record', record_id: 'widget-run-1' }],
    ...overrides
  };
  const [org, repo] = finding.repo.split('/');
  const d = resolve(TEST_ROOT, 'findings', org, repo);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(finding, { lineWidth: 120, noRefs: true }), 'utf-8');
  return finding;
}

function writePattern(id, overrides = {}) {
  const pattern = {
    schema_version: '1.0.0',
    pattern_id: id,
    title: 'Recurring entrypoint truth gap across CLI repos',
    status: 'candidate',
    pattern_kind: 'recurring_failure',
    summary: 'Entrypoint truth drifts from docs repeatedly across CLI repos.',
    source_finding_ids: ['dfind-json-a'],
    support: { finding_count: 1, repo_count: 1, surface_count: 1 },
    dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'] },
    transfer_scope: 'surface_archetype',
    pattern_strength: 'strong',
    ...overrides
  };
  const d = resolve(TEST_ROOT, 'patterns');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(pattern, { lineWidth: 120, noRefs: true }), 'utf-8');
  return pattern;
}

function writeRecommendation(id, overrides = {}) {
  const rec = {
    schema_version: '1.0.0',
    recommendation_id: id,
    title: 'Run the entrypoint-truth scenario before rollout',
    status: 'candidate',
    recommendation_kind: 'add_scenario',
    summary: 'New CLI repos should run the entrypoint-truth scenario first.',
    applies_to: { product_surfaces: ['cli'], transfer_scope: 'surface_archetype' },
    based_on_pattern_ids: ['dpat-json-1'],
    action: { type: 'add_scenario', target: 'entrypoint-truth-check', details: 'Run the scenario.' },
    confidence: 'strong',
    ...overrides
  };
  const d = resolve(TEST_ROOT, 'recommendations');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(rec, { lineWidth: 120, noRefs: true }), 'utf-8');
  return rec;
}

function writeDoctrine(id, overrides = {}) {
  const doctrine = {
    schema_version: '1.0.0',
    doctrine_id: id,
    title: 'Verify the entrypoint contract before authoring scenarios',
    status: 'candidate',
    doctrine_kind: 'rollout_law',
    statement: 'Read --help or the CLI source before writing any scenario step.',
    rationale: 'A wrong flag produces exit code 2, an honest fail not worth papering over.',
    based_on_pattern_ids: ['dpat-json-1'],
    transfer_scope: 'org_wide',
    strength: 'strong',
    ...overrides
  };
  const d = resolve(TEST_ROOT, 'doctrine');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(doctrine, { lineWidth: 120, noRefs: true }), 'utf-8');
  return doctrine;
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, FINDINGS_REPO_ROOT: TEST_ROOT }
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
  }
}

before(() => {
  TEST_ROOT = mkdtempSync(resolve(tmpdir(), 'findings-json-'));
  writeFinding('dfind-json-a', { status: 'candidate' });
  writeFinding('dfind-json-b', { status: 'accepted', title: 'Accepted finding for json projection' });
  writePattern('dpat-json-1');
  writeRecommendation('drec-json-1');
  writeDoctrine('ddoc-json-1');
});

after(() => {
  if (TEST_ROOT && existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

describe('feat findings --json: list', () => {
  it('emits a JSON array of finding projections, parseable from stdout alone', () => {
    const r = run(['list', '--json']);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed), 'list --json is an array');
    assert.equal(parsed.length, 2);
    const ids = parsed.map(p => p.finding.finding_id).sort();
    assert.deepEqual(ids, ['dfind-json-a', 'dfind-json-b']);
    for (const p of parsed) {
      assert.equal(typeof p.valid, 'boolean');
      assert.ok(p.finding.summary, 'underlying finding object is present');
    }
  });

  it('stdout is a single JSON document (no human preamble or footer leaked)', () => {
    const r = run(['list', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.stdout.trim(), JSON.stringify(parsed, null, 2));
  });

  it('default output is human text, not JSON (regression: default unchanged)', () => {
    const r = run(['list']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /finding\(s\)/);
    assert.throws(() => JSON.parse(r.stdout));
  });
});

describe('feat findings --json: show', () => {
  it('emits the loaded finding object matching the on-disk record', () => {
    const r = run(['show', 'dfind-json-a', '--json']);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.finding.finding_id, 'dfind-json-a');
    assert.equal(parsed.finding.summary, 'A scenario assumed a flag the CLI does not accept, so it exited 2.');
    assert.equal(parsed.valid, true);
  });

  it('default output is human detail text, not JSON', () => {
    const r = run(['show', 'dfind-json-a']);
    assert.match(r.stdout, /Finding: dfind-json-a/);
    assert.throws(() => JSON.parse(r.stdout));
  });
});

describe('feat findings --json: queue', () => {
  it('emits the unreviewed candidate set as JSON', () => {
    const r = run(['queue', '--json']);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed));
    const ids = parsed.map(q => q.finding.finding_id);
    assert.ok(ids.includes('dfind-json-a'), 'candidate appears in queue');
    assert.ok(!ids.includes('dfind-json-b'), 'accepted finding is NOT in the review queue');
    assert.equal(parsed.find(q => q.finding.finding_id === 'dfind-json-a').queue_reason, 'Unreviewed candidate');
  });
});

describe('feat findings --json: history', () => {
  it('emits a JSON array (empty when no review events recorded)', () => {
    const r = run(['history', 'dfind-json-a', '--json']);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed));
  });
});

describe('feat findings --json: synthesis list/show', () => {
  it('patterns list --json emits the pattern objects', () => {
    const r = run(['patterns', 'list', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].pattern_id, 'dpat-json-1');
  });

  it('patterns show --json emits a single pattern object', () => {
    const r = run(['patterns', 'show', 'dpat-json-1', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.pattern_id, 'dpat-json-1');
    assert.equal(parsed.pattern_strength, 'strong');
  });

  it('recommendations list --json emits the recommendation objects', () => {
    const r = run(['recommendations', 'list', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].recommendation_id, 'drec-json-1');
  });

  it('recommendations show --json emits a single recommendation object', () => {
    const r = run(['recommendations', 'show', 'drec-json-1', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.recommendation_id, 'drec-json-1');
  });

  it('doctrine list --json emits the doctrine objects', () => {
    const r = run(['doctrine', 'list', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].doctrine_id, 'ddoc-json-1');
  });

  it('doctrine show --json emits a single doctrine object', () => {
    const r = run(['doctrine', 'show', 'ddoc-json-1', '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.doctrine_id, 'ddoc-json-1');
    assert.equal(parsed.statement, 'Read --help or the CLI source before writing any scenario step.');
  });

  it('synthesis default output stays human text, not JSON', () => {
    assert.throws(() => JSON.parse(run(['patterns', 'list']).stdout));
    assert.throws(() => JSON.parse(run(['recommendations', 'list']).stdout));
    assert.throws(() => JSON.parse(run(['doctrine', 'list']).stdout));
  });
});
