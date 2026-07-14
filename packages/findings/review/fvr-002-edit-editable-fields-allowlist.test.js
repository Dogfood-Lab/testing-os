/**
 * fvr-002-edit-editable-fields-allowlist.test.js — the review engine's `edit`
 * action must ENFORCE the EDITABLE_FIELDS allowlist, not merely rely on the
 * write-side schema gate.
 *
 * AT HEAD: performAction's edit loop guards only the three prototype-pollution
 * keys; any other operator-supplied `--set field=value` is applied as long as
 * the mutated finding still passes schema validation. Because `finding_id` is
 * a VALID schema field (pattern ^dfind-[a-z0-9][a-z0-9-]*$), an
 * `edit --set finding_id=<other-valid-id>` mutates the IDENTITY field, passes
 * validateFinding, and is written back to the finding's ORIGINAL path — breaking
 * the finding_id <-> file-path invariant. A finding lives at
 * findings/<org>/<repo>/<finding_id>.yaml and findById() matches on the id
 * INSIDE the file, so a file whose on-disk id no longer matches its path is
 * unreachable by its old id and mis-addressed by its new one. The schema gate
 * cannot catch this: the mutated finding is schema-valid, just mis-identified.
 * The CLI (cli.js) compounds it by collecting arbitrary `--set` field names with
 * no allowlist.
 *
 * AFTER FIX: the edit loop rejects any field not in EDITABLE_FIELDS with a
 * structured `{ success:false, error }` (mirroring the prototype-key guard), so
 * identity / lineage / provenance fields (finding_id at minimum) can never be
 * edited. The on-disk finding is byte-for-byte unchanged after a refused edit,
 * and the CLI surfaces the structured error with a non-zero exit.
 *
 * Counter-test (load-bearing): a legit edit on an allowed field — an enum field
 * (root_cause_kind) and a prose field (summary) — still applies. The allowlist
 * cannot regress real edits.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

import { performAction, EDITABLE_FIELDS } from './review-engine.js';
import { findById } from '../reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_fvr_002__');
const CLI = resolve(__dirname, '..', 'cli.js');

function makeTestFinding(overrides = {}) {
  return {
    schema_version: '1.0.0',
    finding_id: 'dfind-fvr002-identity',
    title: 'Test finding for the fvr-002 editable-fields allowlist regression',
    status: 'reviewed',
    repo: 'mcp-tool-shop-org/test-repo',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'contract_drift',
    remediation_kind: 'docs_change',
    transfer_scope: 'repo_local',
    summary: 'Seed finding exercising the identity-field edit guard for fvr-002 coverage.',
    source_record_ids: ['test-record-001'],
    evidence: [{ evidence_kind: 'record', record_id: 'test-record-001', note: 'Test evidence.' }],
    created_at: '2026-03-29T12:00:00Z',
    updated_at: '2026-03-29T12:00:00Z',
    ...overrides
  };
}

function findingPath(findingId, repo = 'mcp-tool-shop-org/test-repo') {
  const [org, repoName] = repo.split('/');
  return resolve(TEST_ROOT, 'findings', org, repoName, `${findingId}.yaml`);
}

function writeFindingToTestRoot(finding) {
  const path = findingPath(finding.finding_id, finding.repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump(finding, { lineWidth: 120, noRefs: true }), 'utf-8');
  return path;
}

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'findings'), { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

describe('fvr-002: performAction edit refuses fields outside EDITABLE_FIELDS', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('refuses edit --set finding_id (identity field) and leaves the file unchanged', () => {
    const path = writeFindingToTestRoot(makeTestFinding());
    const before = readFileSync(path, 'utf-8');

    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-fvr002-identity',
      action: 'edit',
      actor: 'mike',
      // A schema-VALID target id: the write-side schema gate cannot catch this,
      // only the allowlist can. Pre-fix this edit succeeded and re-homed the
      // identity onto the wrong file path.
      fieldChanges: { finding_id: 'dfind-fvr002-hijacked' }
    });

    assert.equal(result.success, false, 'editing the identity field finding_id must be refused');
    assert.ok(result.error, 'a structured error must be returned');
    assert.match(result.error, /finding_id/, 'the error must name the refused field');

    const after = readFileSync(path, 'utf-8');
    assert.equal(after, before, 'on-disk YAML must be byte-for-byte unchanged after a refused edit');

    // Invariant intact: the finding is still addressable by its ORIGINAL id and
    // still lives at its original path.
    const found = findById(TEST_ROOT, 'dfind-fvr002-identity');
    assert.ok(found, 'the finding must still be reachable by its original id');
    assert.equal(found.data.finding_id, 'dfind-fvr002-identity');
    assert.equal(found.path, path, 'the finding must still live at its original path');
    assert.equal(
      findById(TEST_ROOT, 'dfind-fvr002-hijacked'),
      null,
      'the hijack id must NOT resolve to any file'
    );
  });

  // Each value below is SCHEMA-VALID for its field, so the write-side schema
  // gate would happily persist the mutation — only the allowlist can refuse it.
  // Pre-fix every one of these succeeded (identity/lineage/provenance drift);
  // post-fix the allowlist refuses each.
  const nonEditableCases = [
    ['source_record_ids', ['other-rec']],
    ['schema_version', '2.0.0'],
    ['status', 'accepted'],
    ['repo', 'other-org/other-repo']
  ];
  for (const [field, value] of nonEditableCases) {
    it(`refuses edit of the non-editable field "${field}" and leaves the file unchanged`, () => {
      const path = writeFindingToTestRoot(makeTestFinding());
      const before = readFileSync(path, 'utf-8');

      const result = performAction(TEST_ROOT, {
        findingId: 'dfind-fvr002-identity',
        action: 'edit',
        actor: 'mike',
        fieldChanges: { [field]: value }
      });

      assert.equal(result.success, false, `editing "${field}" must be refused`);
      assert.match(result.error, new RegExp(field), 'the error must name the refused field');
      assert.equal(readFileSync(path, 'utf-8'), before, 'file must be unchanged after a refused edit');
    });
  }

  it('the prototype-key guard still fires first with its own message', () => {
    // `constructor` reliably becomes an own enumerable property (unlike the
    // object-literal `__proto__:` setter syntax), so it exercises the dedicated
    // reserved-key guard rather than the general allowlist branch.
    writeFindingToTestRoot(makeTestFinding());
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-fvr002-identity',
      action: 'edit',
      actor: 'mike',
      fieldChanges: { constructor: 'x' }
    });
    assert.equal(result.success, false);
    assert.match(result.error, /reserved|unsafe/i, 'proto keys keep their dedicated guard message');
  });
});

describe('fvr-002: legit edits on allowed fields still apply (counter-test)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('edit --set root_cause_kind (allowed enum field) still succeeds', () => {
    writeFindingToTestRoot(makeTestFinding());
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-fvr002-identity',
      action: 'edit',
      actor: 'mike',
      fieldChanges: { root_cause_kind: 'interface_assumption_error' }
    });
    assert.ok(result.success, result.error);
    const onDisk = yaml.load(readFileSync(findingPath('dfind-fvr002-identity'), 'utf-8'));
    assert.equal(onDisk.root_cause_kind, 'interface_assumption_error');
    assert.equal(onDisk.finding_id, 'dfind-fvr002-identity', 'identity untouched by a legit edit');
  });

  it('edit --set summary (allowed prose field) still succeeds', () => {
    writeFindingToTestRoot(makeTestFinding());
    const newSummary = 'Revised operator prose for the fvr-002 counter-test, well over the schema minimum length.';
    const result = performAction(TEST_ROOT, {
      findingId: 'dfind-fvr002-identity',
      action: 'edit',
      actor: 'mike',
      fieldChanges: { summary: newSummary }
    });
    assert.ok(result.success, result.error);
    const onDisk = yaml.load(readFileSync(findingPath('dfind-fvr002-identity'), 'utf-8'));
    assert.equal(onDisk.summary, newSummary);
  });

  it('every EDITABLE_FIELDS entry is accepted by the allowlist guard', () => {
    // The allowlist and the help/enforcement source must not drift: each field
    // the package advertises as editable must pass the guard (schema validity
    // aside — here we only assert the guard does not refuse an advertised field).
    for (const field of EDITABLE_FIELDS) {
      setup();
      writeFindingToTestRoot(makeTestFinding());
      const result = performAction(TEST_ROOT, {
        findingId: 'dfind-fvr002-identity',
        action: 'edit',
        actor: 'mike',
        fieldChanges: { [field]: sampleValueFor(field) }
      });
      assert.ok(
        result.success,
        `advertised editable field "${field}" must not be refused by the allowlist: ${result.error}`
      );
      teardown();
    }
  });
});

describe('fvr-002: CLI edit surfaces the allowlist refusal end-to-end', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('cli edit --set finding_id exits non-zero and leaves the file unchanged', () => {
    const path = writeFindingToTestRoot(makeTestFinding());
    const before = readFileSync(path, 'utf-8');

    let code = 0;
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [CLI, 'edit', 'dfind-fvr002-identity', '--actor', 'mike', '--set', 'finding_id=dfind-fvr002-hijacked'],
        { encoding: 'utf-8', env: { ...process.env, FINDINGS_REPO_ROOT: TEST_ROOT } }
      );
    } catch (err) {
      code = err.status ?? 1;
      stderr = err.stderr?.toString() || '';
    }

    assert.equal(code, 1, 'the CLI must exit 1 when the edit is refused');
    assert.match(stderr, /finding_id/, 'the CLI must surface the structured refusal naming the field');
    assert.equal(readFileSync(path, 'utf-8'), before, 'the CLI must not mutate the file on a refused edit');
  });
});

/** A schema-valid sample value per advertised editable field. */
function sampleValueFor(field) {
  switch (field) {
    case 'title': return 'A revised finding title that clears the schema minimum length';
    case 'summary': return 'Revised summary prose for the allowlist coverage test, over the schema minimum length.';
    case 'doctrine_statement': return 'A revised doctrine statement long enough to satisfy the finding schema constraints.';
    case 'notes': return 'Operator note added via a legit edit.';
    case 'issue_kind': return 'interface_assumption';
    case 'root_cause_kind': return 'interface_assumption_error';
    case 'remediation_kind': return 'entrypoint_fix';
    case 'transfer_scope': return 'surface_archetype';
    default: return 'x';
  }
}
