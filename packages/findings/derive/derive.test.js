import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { deriveFromRecord, deriveFromRecords, getRuleInventory, RULES } from './derive-findings.js';
import { getRuleById } from './rules.js';
import { generateFindingId, computeDedupeKey } from './ids.js';
import { dedupeWithinBatch, dedupeAgainstExisting } from './dedupe.js';
import { loadRecordById, loadAllRecords } from './load-records.js';
import { writeFinding, writeFindings } from './write-findings.js';
import { validateFinding } from '../validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

// ─── Fixture records ────────────────────────────────────────

/** Minimal valid accepted record with passing scenario. */
function makePassingRecord(overrides = {}) {
  return {
    schema_version: '1.0.0',
    policy_version: '1.0.0',
    run_id: 'test-pass-001',
    repo: 'mcp-tool-shop-org/test-repo',
    ref: { commit_sha: 'a'.repeat(40) },
    source: { provider: 'github', workflow: 'dogfood.yml', provider_run_id: '1', run_url: 'https://example.com' },
    timing: { started_at: '2026-03-29T00:00:00Z', finished_at: '2026-03-29T00:01:00Z' },
    ci_checks: [],
    scenario_results: [{
      scenario_id: 'basic-test',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [{ step_id: 'run-test', status: 'pass' }],
      evidence: [{ kind: 'log', url: 'https://example.com/log' }]
    }],
    overall_verdict: { proposed: 'pass', verified: 'pass', downgraded: false },
    verification: {
      status: 'accepted',
      verified_at: '2026-03-29T00:01:00Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: true,
      rejection_reasons: []
    },
    ...overrides
  };
}

/** Record with surface misclassification (rejected). */
function makeSurfaceMisclassRecord() {
  return makePassingRecord({
    run_id: 'test-surface-001',
    repo: 'mcp-tool-shop-org/test-mcp-server',
    scenario_results: [{
      scenario_id: 'mcp-handshake',
      product_surface: 'mcp', // BAD: should be mcp-server
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [{ step_id: 'run-init', status: 'pass' }],
      evidence: [{ kind: 'log', url: 'https://example.com/log' }]
    }],
    overall_verdict: { proposed: 'pass', verified: 'fail', downgraded: true, downgrade_reasons: ['schema or provenance validation failed'] },
    verification: {
      status: 'rejected',
      verified_at: '2026-03-29T00:01:00Z',
      provenance_confirmed: false,
      schema_valid: false,
      policy_valid: false,
      rejection_reasons: ['schema: /scenario_results/0/product_surface must be equal to one of the allowed values']
    }
  });
}

/** Record with evidence policy mismatch (rejected). */
function makeEvidencePolicyRecord() {
  return makePassingRecord({
    run_id: 'test-evidence-001',
    repo: 'mcp-tool-shop-org/test-cli',
    scenario_results: [{
      scenario_id: 'cli-test',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'fail',
      step_results: [{ step_id: 'run-help', status: 'pass' }, { step_id: 'verify-output', status: 'fail' }],
      evidence: [{ kind: 'log', url: 'https://example.com/log' }]
    }],
    overall_verdict: { proposed: 'fail', verified: 'fail', downgraded: false, downgrade_reasons: ['policy validation failed'] },
    verification: {
      status: 'rejected',
      verified_at: '2026-03-29T00:01:00Z',
      provenance_confirmed: true,
      schema_valid: true,
      policy_valid: false,
      rejection_reasons: [
        'policy: surface[cli]: requires 2 evidence items, got 1',
        'policy: surface[cli]: required evidence kind "artifact" is missing'
      ]
    }
  });
}

/** Record with verdict downgrade. */
function makeDowngradeRecord() {
  return makePassingRecord({
    run_id: 'test-downgrade-001',
    repo: 'mcp-tool-shop-org/test-tool',
    overall_verdict: { proposed: 'pass', verified: 'fail', downgraded: true, downgrade_reasons: ['schema or provenance validation failed'] },
    verification: {
      status: 'rejected',
      verified_at: '2026-03-29T00:01:00Z',
      provenance_confirmed: true,
      schema_valid: false,
      policy_valid: false,
      rejection_reasons: ['schema: /some/path invalid']
    }
  });
}

/** Record with step failure. */
function makeStepFailureRecord() {
  return makePassingRecord({
    run_id: 'test-stepfail-001',
    repo: 'mcp-tool-shop-org/test-cli-tool',
    scenario_results: [{
      scenario_id: 'cli-full-test',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'fail',
      step_results: [
        { step_id: 'run-help', status: 'pass' },
        { step_id: 'run-init', status: 'pass' },
        { step_id: 'verify-output', status: 'fail' }
      ],
      evidence: [{ kind: 'log', url: 'https://example.com/log' }]
    }],
    overall_verdict: { proposed: 'fail', verified: 'fail', downgraded: false }
  });
}

/** Record with blocked scenario. */
function makeBlockedRecord() {
  return makePassingRecord({
    run_id: 'test-blocked-001',
    repo: 'mcp-tool-shop-org/test-api',
    scenario_results: [{
      scenario_id: 'api-health',
      product_surface: 'api',
      execution_mode: 'bot',
      verdict: 'blocked',
      blocking_reason: 'Server failed to start on port 4321',
      step_results: [{ step_id: 'start-server', status: 'blocked' }],
      evidence: []
    }]
  });
}

/** Record with mixed mode missing attestation. */
function makeMissingAttestationRecord() {
  return makePassingRecord({
    run_id: 'test-attest-001',
    repo: 'mcp-tool-shop-org/test-desktop',
    scenario_results: [{
      scenario_id: 'desktop-launch',
      product_surface: 'desktop',
      execution_mode: 'mixed',
      // attested_by missing!
      verdict: 'pass',
      step_results: [{ step_id: 'launch-app', status: 'pass' }],
      evidence: [{ kind: 'screenshot', url: 'https://example.com/ss.png' }]
    }]
  });
}

// ============================================================
// Rule trigger tests
// ============================================================

describe('Rule: surface misclassification', () => {
  it('fires on product_surface enum rejection', () => {
    const candidates = deriveFromRecord(makeSurfaceMisclassRecord(), { rejected: true });
    const match = candidates.find(c => c.derived.rule_id === 'rule-surface-misclassification');
    assert.ok(match, 'Should emit surface misclassification finding');
    assert.equal(match.issue_kind, 'surface_misclassification');
    assert.equal(match.product_surface, 'mcp-server'); // sanitized
  });

  it('does not fire on passing record', () => {
    const candidates = deriveFromRecord(makePassingRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-surface-misclassification');
    assert.equal(match, undefined);
  });
});

describe('Rule: evidence policy mismatch', () => {
  it('fires on evidence requirement rejection', () => {
    const candidates = deriveFromRecord(makeEvidencePolicyRecord(), { rejected: true });
    const match = candidates.find(c => c.derived.rule_id === 'rule-evidence-policy-mismatch');
    assert.ok(match, 'Should emit evidence policy mismatch finding');
    assert.equal(match.issue_kind, 'evidence_overconstraint');
  });

  it('does not fire on passing record', () => {
    const candidates = deriveFromRecord(makePassingRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-evidence-policy-mismatch');
    assert.equal(match, undefined);
  });
});

describe('Rule: verdict downgrade', () => {
  it('fires when proposed pass is downgraded', () => {
    const candidates = deriveFromRecord(makeDowngradeRecord(), { rejected: true });
    const match = candidates.find(c => c.derived.rule_id === 'rule-verdict-downgrade');
    assert.ok(match, 'Should emit verdict downgrade finding');
    assert.equal(match.issue_kind, 'schema_mismatch'); // because schema_valid is false
  });

  it('does not fire when verdict is not downgraded', () => {
    const candidates = deriveFromRecord(makePassingRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-verdict-downgrade');
    assert.equal(match, undefined);
  });

  it('does not fire when proposed is already fail', () => {
    const record = makePassingRecord({
      overall_verdict: { proposed: 'fail', verified: 'fail', downgraded: false }
    });
    const candidates = deriveFromRecord(record);
    const match = candidates.find(c => c.derived.rule_id === 'rule-verdict-downgrade');
    assert.equal(match, undefined);
  });
});

describe('Rule: scenario step failure', () => {
  it('fires on step failure with fail verdict', () => {
    const candidates = deriveFromRecord(makeStepFailureRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-scenario-step-failure');
    assert.ok(match, 'Should emit step failure finding');
    assert.equal(match.issue_kind, 'build_output_mismatch'); // verify-output triggers this
  });

  it('classifies verify-output as build_output_mismatch', () => {
    const candidates = deriveFromRecord(makeStepFailureRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-scenario-step-failure');
    assert.equal(match.root_cause_kind, 'build_config_error');
    assert.equal(match.remediation_kind, 'build_config_fix');
  });

  it('does not fire when all steps pass', () => {
    const candidates = deriveFromRecord(makePassingRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-scenario-step-failure');
    assert.equal(match, undefined);
  });
});

describe('Rule: blocked scenario', () => {
  it('fires on blocked verdict', () => {
    const candidates = deriveFromRecord(makeBlockedRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.ok(match, 'Should emit blocked scenario finding');
    assert.ok(match.summary.includes('Server failed to start'));
  });

  it('does not fire on passing scenario', () => {
    const candidates = deriveFromRecord(makePassingRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-blocked-scenario');
    assert.equal(match, undefined);
  });
});

// ============================================================
// Rule: partial scenario evidence (F-cc198701 regression)
// ============================================================
//
// Confirming audit of F-88fb37ff/F-e42e8f80 (steps.js) found the identical
// blind spot one layer up: ruleBlockedScenario checks only verdict==='blocked'
// and ruleScenarioStepFailure checks only verdict==='fail' — 'partial' (the
// third of the four legal scenario_results[].verdict enum values) was
// invisible to EVERY rule in this file regardless of its step evidence, so a
// self-contradictory record (verdict:'partial', every step actively 'fail')
// generated zero corrective/diagnostic finding anywhere in the intelligence
// layer. Fix: rulePartialScenarioEvidence, a dedicated sibling rule (not a
// widened ruleBlockedScenario — that rule's "was blocked: <reason>" wording
// would misdescribe a 'partial' scenario, since blocking_reason is only ever
// populated for a genuinely 'blocked' one).

/** Record with a partial scenario corroborated by non-pass step evidence. */
function makePartialWithEvidenceRecord() {
  return makePassingRecord({
    run_id: 'test-partial-001',
    repo: 'mcp-tool-shop-org/test-cli',
    scenario_results: [{
      scenario_id: 'partial-evidence-scenario',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'partial',
      step_results: [
        { step_id: 'run-help', status: 'fail' },
        { step_id: 'run-init', status: 'fail' }
      ],
      evidence: [{ kind: 'log', url: 'https://example.com/log' }]
    }],
    overall_verdict: { proposed: 'partial', verified: 'partial', downgraded: false }
  });
}

describe('Rule: partial scenario evidence (F-cc198701)', () => {
  /** @pins F-cc198701 */
  it('fires on a "partial" verdict corroborated by non-pass step evidence (pre-fix: zero rules fired for this shape)', () => {
    const candidates = deriveFromRecord(makePartialWithEvidenceRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-partial-scenario-evidence');
    assert.ok(match, 'Should emit a partial-scenario-evidence finding');
    assert.ok(match.summary.includes('run-help'), `expected the non-pass step ids in the summary, got: ${match.summary}`);
    assert.equal(match.issue_kind, 'verification_gap');
  });

  it('does NOT fire on a passing record (verdict "pass", no partial scenario at all)', () => {
    const candidates = deriveFromRecord(makePassingRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-partial-scenario-evidence');
    assert.equal(match, undefined);
  });

  it('does NOT fire on "partial" backed by ZERO non-pass evidence (every step actively pass) — that shape is steps.js\'s job to reject at ingest, not this rule\'s job to diagnose post-hoc', () => {
    const record = makePassingRecord({
      run_id: 'test-partial-allpass-001',
      scenario_results: [{
        scenario_id: 'partial-allpass-scenario',
        product_surface: 'cli',
        execution_mode: 'bot',
        verdict: 'partial',
        step_results: [{ step_id: 'run-help', status: 'pass' }],
        evidence: [{ kind: 'log', url: 'https://example.com/log' }]
      }]
    });
    const candidates = deriveFromRecord(record);
    const match = candidates.find(c => c.derived.rule_id === 'rule-partial-scenario-evidence');
    assert.equal(match, undefined,
      'a partial verdict with zero non-pass step evidence has no non-pass step ids to diagnose — hasNonPassStepEvidence must be false for this shape');
  });

  it('does NOT fire on "blocked"/"fail" verdicts — those stay owned by their own sibling rules', () => {
    const candidates = [
      ...deriveFromRecord(makeBlockedRecord()),
      ...deriveFromRecord(makeStepFailureRecord())
    ];
    const match = candidates.find(c => c.derived.rule_id === 'rule-partial-scenario-evidence');
    assert.equal(match, undefined);
  });
});

describe('Rule: execution mode attestation gap', () => {
  it('fires on mixed mode without attested_by', () => {
    const candidates = deriveFromRecord(makeMissingAttestationRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-execution-mode-gap');
    assert.ok(match, 'Should emit attestation gap finding');
    assert.equal(match.issue_kind, 'execution_mode_mismatch');
  });

  it('does not fire on bot mode', () => {
    const candidates = deriveFromRecord(makePassingRecord());
    const match = candidates.find(c => c.derived.rule_id === 'rule-execution-mode-gap');
    assert.equal(match, undefined);
  });

  it('does not fire on mixed with attested_by present', () => {
    const record = makePassingRecord({
      scenario_results: [{
        scenario_id: 'desktop-launch',
        product_surface: 'desktop',
        execution_mode: 'mixed',
        attested_by: 'mike',
        verdict: 'pass',
        step_results: [{ step_id: 'launch', status: 'pass' }],
        evidence: [{ kind: 'screenshot', url: 'https://example.com/ss.png' }]
      }]
    });
    const candidates = deriveFromRecord(record);
    const match = candidates.find(c => c.derived.rule_id === 'rule-execution-mode-gap');
    assert.equal(match, undefined);
  });
});

// ============================================================
// Determinism tests
// ============================================================

describe('Determinism', () => {
  it('same input yields same candidate IDs', () => {
    const record = makeSurfaceMisclassRecord();
    const a = deriveFromRecord(record, { rejected: true });
    const b = deriveFromRecord(record, { rejected: true });
    const idsA = a.map(c => c.finding_id).sort();
    const idsB = b.map(c => c.finding_id).sort();
    assert.deepEqual(idsA, idsB);
  });

  it('same input yields same classification', () => {
    const record = makeStepFailureRecord();
    const a = deriveFromRecord(record);
    const b = deriveFromRecord(record);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].issue_kind, b[i].issue_kind);
      assert.equal(a[i].root_cause_kind, b[i].root_cause_kind);
      assert.equal(a[i].remediation_kind, b[i].remediation_kind);
    }
  });

  it('rule evaluation order does not change findings', () => {
    const record = makeSurfaceMisclassRecord();
    const results1 = deriveFromRecord(record, { rejected: true });
    const results2 = deriveFromRecord(record, { rejected: true });
    assert.equal(results1.length, results2.length);
    for (let i = 0; i < results1.length; i++) {
      assert.equal(results1[i].finding_id, results2[i].finding_id);
    }
  });
});

// ============================================================
// Dedupe tests
// ============================================================

describe('Dedupe: within batch', () => {
  it('removes duplicate candidates with same dedupe key', () => {
    const candidates = [
      { finding_id: 'dfind-a', repo: 'org/a', issue_kind: 'x', root_cause_kind: 'y', journey_stage: 'z', title: 't', summary: 's' },
      { finding_id: 'dfind-a', repo: 'org/a', issue_kind: 'x', root_cause_kind: 'y', journey_stage: 'z', title: 't', summary: 's' }
    ];
    const { unique, skipped } = dedupeWithinBatch(candidates);
    assert.equal(unique.length, 1);
    assert.equal(skipped, 1);
  });

  it('keeps different candidates', () => {
    const candidates = [
      { finding_id: 'dfind-a', repo: 'org/a', issue_kind: 'x', root_cause_kind: 'y', journey_stage: 'z' },
      { finding_id: 'dfind-b', repo: 'org/b', issue_kind: 'x', root_cause_kind: 'y', journey_stage: 'z' }
    ];
    const { unique, skipped } = dedupeWithinBatch(candidates);
    assert.equal(unique.length, 2);
    assert.equal(skipped, 0);
  });
});

describe('Dedupe: against existing', () => {
  it('skips unchanged candidate', () => {
    const candidates = [{
      finding_id: 'dfind-test',
      issue_kind: 'x', root_cause_kind: 'y', remediation_kind: 'z',
      transfer_scope: 'a', summary: 's', title: 't'
    }];
    const existing = [{ data: {
      finding_id: 'dfind-test', status: 'candidate',
      issue_kind: 'x', root_cause_kind: 'y', remediation_kind: 'z',
      transfer_scope: 'a', summary: 's', title: 't'
    }}];
    const { toWrite, skippedUnchanged, collisions } = dedupeAgainstExisting(candidates, existing);
    assert.equal(toWrite.length, 0);
    assert.equal(skippedUnchanged, 1);
    assert.equal(collisions.length, 0);
  });

  it('reports collision for non-candidate existing', () => {
    const candidates = [{ finding_id: 'dfind-test' }];
    const existing = [{ data: { finding_id: 'dfind-test', status: 'accepted' } }];
    const { toWrite, collisions } = dedupeAgainstExisting(candidates, existing);
    assert.equal(toWrite.length, 0);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].existingStatus, 'accepted');
  });

  it('writes new candidates not on disk', () => {
    const candidates = [{ finding_id: 'dfind-new' }];
    const existing = [];
    const { toWrite } = dedupeAgainstExisting(candidates, existing);
    assert.equal(toWrite.length, 1);
  });
});

// ============================================================
// Evidence binding tests
// ============================================================

describe('Evidence binding', () => {
  it('every emitted candidate includes source_record_ids', () => {
    const records = [
      makeSurfaceMisclassRecord(),
      makeStepFailureRecord(),
      makeEvidencePolicyRecord(),
      makeBlockedRecord()
    ];
    for (const record of records) {
      const candidates = deriveFromRecord(record, { rejected: true });
      for (const c of candidates) {
        assert.ok(c.source_record_ids.length >= 1, `${c.finding_id} missing source_record_ids`);
      }
    }
  });

  it('every emitted candidate includes structured evidence', () => {
    const records = [
      makeSurfaceMisclassRecord(),
      makeStepFailureRecord(),
      makeEvidencePolicyRecord(),
      makeMissingAttestationRecord()
    ];
    for (const record of records) {
      const candidates = deriveFromRecord(record, { rejected: true });
      for (const c of candidates) {
        assert.ok(c.evidence.length >= 1, `${c.finding_id} missing evidence`);
        for (const e of c.evidence) {
          assert.ok(e.evidence_kind, `Evidence in ${c.finding_id} missing evidence_kind`);
        }
      }
    }
  });

  it('evidence points back to the triggering record', () => {
    const record = makeSurfaceMisclassRecord();
    const candidates = deriveFromRecord(record, { rejected: true });
    for (const c of candidates) {
      const hasRecordRef = c.evidence.some(e => e.record_id === record.run_id);
      assert.ok(hasRecordRef, `${c.finding_id} evidence does not reference source record`);
    }
  });
});

// ============================================================
// Explainability tests
// ============================================================

describe('Explainability', () => {
  it('every emitted candidate has derivation metadata', () => {
    const record = makeSurfaceMisclassRecord();
    const candidates = deriveFromRecord(record, { rejected: true });
    for (const c of candidates) {
      assert.ok(c.derived, `${c.finding_id} missing derived metadata`);
      assert.equal(c.derived.method, 'deterministic_rule');
      assert.ok(c.derived.rule_id, `${c.finding_id} missing rule_id`);
      assert.ok(c.derived.derived_at, `${c.finding_id} missing derived_at`);
      assert.ok(c.derived.rationale.length >= 10, `${c.finding_id} rationale too short`);
    }
  });

  it('dry-run and write mode produce the same candidate set', () => {
    const record = makeStepFailureRecord();
    const a = deriveFromRecord(record);
    const b = deriveFromRecord(record);
    assert.deepEqual(
      a.map(c => c.finding_id),
      b.map(c => c.finding_id)
    );
  });
});

// ============================================================
// Schema validity tests
// ============================================================

describe('Schema validity of derived candidates', () => {
  const testRecords = [
    { name: 'surface-misclass', factory: makeSurfaceMisclassRecord, opts: { rejected: true } },
    { name: 'evidence-policy', factory: makeEvidencePolicyRecord, opts: { rejected: true } },
    { name: 'verdict-downgrade', factory: makeDowngradeRecord, opts: { rejected: true } },
    { name: 'step-failure', factory: makeStepFailureRecord, opts: {} },
    { name: 'blocked', factory: makeBlockedRecord, opts: {} },
    { name: 'attestation-gap', factory: makeMissingAttestationRecord, opts: {} },
    // F-cc198701: partial-scenario-evidence's candidate output goes through
    // the same schema-validity floor as every other rule's.
    { name: 'partial-evidence', factory: makePartialWithEvidenceRecord, opts: {} }
  ];

  for (const { name, factory, opts } of testRecords) {
    it(`candidates from ${name} are schema-valid`, () => {
      const candidates = deriveFromRecord(factory(), opts);
      for (const c of candidates) {
        const result = validateFinding(c);
        assert.equal(result.valid, true, `${c.finding_id} invalid: ${JSON.stringify(result.errors)}`);
      }
    });
  }
});

// ============================================================
// ID generation tests
// ============================================================

describe('ID generation', () => {
  it('produces dfind- prefixed IDs', () => {
    const id = generateFindingId('repo-crawler-mcp', 'surface-misclassification');
    assert.ok(id.startsWith('dfind-'));
  });

  it('sanitizes special characters', () => {
    const id = generateFindingId('my_repo.name', 'weird/slug!');
    assert.match(id, /^dfind-[a-z0-9-]+$/);
  });

  it('is stable for same inputs', () => {
    const a = generateFindingId('repo', 'slug');
    const b = generateFindingId('repo', 'slug');
    assert.equal(a, b);
  });
});

describe('Dedupe key computation', () => {
  it('produces deterministic keys', () => {
    const fields = { repo: 'org/repo', issue_kind: 'x', root_cause_kind: 'y', journey_stage: 'z', slug: 'dfind-a' };
    const a = computeDedupeKey(fields);
    const b = computeDedupeKey(fields);
    assert.equal(a, b);
  });

  it('different fields produce different keys', () => {
    const a = computeDedupeKey({ repo: 'org/a', issue_kind: 'x', root_cause_kind: 'y', journey_stage: 'z', slug: 's' });
    const b = computeDedupeKey({ repo: 'org/b', issue_kind: 'x', root_cause_kind: 'y', journey_stage: 'z', slug: 's' });
    assert.notEqual(a, b);
  });

  it('a "::" inside a field value cannot forge a false boundary between two different tuples (F-112c88a4)', () => {
    // Sibling of generateFindingId's own boundary-collision fix
    // (findings-A-002, see ids.js): a naive '::'-joined key lets a
    // delimiter-shaped VALUE in one field masquerade as the join between two
    // DIFFERENT fields. These two tuples disagree on issue_kind/
    // root_cause_kind but both flatten to the identical string
    // 'org/repo::x::y::z::w::s' under a plain '::'.join() — the exact class
    // generateFindingId's boundaryHash() was built to close.
    const a = computeDedupeKey({
      repo: 'org/repo', issue_kind: 'x::y', root_cause_kind: 'z', journey_stage: 'w', slug: 's'
    });
    const b = computeDedupeKey({
      repo: 'org/repo', issue_kind: 'x', root_cause_kind: 'y::z', journey_stage: 'w', slug: 's'
    });
    assert.notEqual(a, b,
      'a "::" inside a field value must not be able to forge a false component boundary');
  });
});

// ============================================================
// Multi-record batch tests
// ============================================================

describe('Batch derivation', () => {
  it('processes multiple records', () => {
    const entries = [
      { record: makeSurfaceMisclassRecord(), rejected: true },
      { record: makeStepFailureRecord(), rejected: false },
      { record: makePassingRecord(), rejected: false }
    ];
    const { candidates, stats } = deriveFromRecords(entries);
    assert.equal(stats.recordsProcessed, 3);
    assert.equal(stats.rulesEvaluated, 3 * RULES.length);
    assert.ok(candidates.length >= 2, 'Should emit at least 2 candidates from non-passing records');
  });

  it('passing records produce zero candidates', () => {
    const entries = [{ record: makePassingRecord(), rejected: false }];
    const { candidates } = deriveFromRecords(entries);
    assert.equal(candidates.length, 0);
  });
});

// ============================================================
// Write tests
// ============================================================

describe('Write findings', () => {
  const testDir = resolve(__dirname, '__test_write__');

  after(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it('writes a candidate to correct path', () => {
    // Set up minimal directory structure
    mkdirSync(resolve(testDir, 'findings'), { recursive: true });

    const finding = {
      schema_version: '1.0.0',
      finding_id: 'dfind-test-write',
      title: 'Test write finding for disk materialization',
      status: 'candidate',
      repo: 'mcp-tool-shop-org/test-repo',
      product_surface: 'cli',
      journey_stage: 'first_run',
      issue_kind: 'entrypoint_truth',
      root_cause_kind: 'contract_drift',
      remediation_kind: 'docs_change',
      transfer_scope: 'repo_local',
      summary: 'Test finding written by write test to verify disk materialization works correctly.',
      source_record_ids: ['test-001'],
      evidence: [{ evidence_kind: 'record', record_id: 'test-001' }]
    };

    const path = writeFinding(testDir, finding);
    assert.ok(existsSync(path), 'File should exist on disk');
    assert.ok(path.includes('dfind-test-write.yaml'));

    // Verify it's valid YAML that can be parsed back
    const raw = readFileSync(path, 'utf-8');
    const parsed = yaml.load(raw);
    assert.equal(parsed.finding_id, 'dfind-test-write');
  });
});

// ============================================================
// Rule inventory
// ============================================================

describe('Rule inventory', () => {
  it('has at least 8 rules', () => {
    assert.ok(RULES.length >= 8, `Expected at least 8 rules, got ${RULES.length}`);
  });

  it('all rules have unique IDs', () => {
    const ids = RULES.map(r => r.ruleId);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, 'Duplicate rule IDs found');
  });

  it('all rules have required interface', () => {
    for (const rule of RULES) {
      assert.ok(rule.ruleId, 'Rule missing ruleId');
      assert.ok(rule.description, 'Rule missing description');
      assert.equal(typeof rule.applies, 'function', `Rule ${rule.ruleId} missing applies()`);
      assert.equal(typeof rule.derive, 'function', `Rule ${rule.ruleId} missing derive()`);
    }
  });

  it('getRuleInventory returns all rules', () => {
    const inventory = getRuleInventory();
    assert.equal(inventory.length, RULES.length);
  });
});

// ============================================================
// Regression: F-742442-039 — ruleSchemaRejection.applies precedence
// ============================================================
//
// Original bug on rules.js:329 read `if (!ctx.record.verification?.schema_valid === false)`
// which JS parses as `(!schema_valid) === false`. For a boolean schema_valid this happens
// to behave correctly, but for `undefined` it returns false on the negation step then
// compares `false === false` → true → does NOT short-circuit, so the rule continues to
// check rejection_reasons. Sister rule on line 368 uses the correct idiom:
// `if (ctx.record.verification?.policy_valid !== false) return false;`
//
// Fix is the one-character semantic change `!x === false` → `x !== false`.

describe('Regression: ruleSchemaRejection.applies operator precedence (F-742442-039)', () => {
  const rule = getRuleById('rule-schema-rejection');

  it('does NOT fire when schema_valid is undefined (latent landmine pre-fix)', () => {
    const ctx = {
      record: {
        verification: {
          schema_valid: undefined,
          rejection_reasons: ['schema:foo']
        }
      },
      rejected: false,
      repoSlug: 'test-repo'
    };
    assert.equal(rule.applies(ctx), false,
      'Rule must NOT fire when schema_valid is undefined; only fire when explicitly false.');
  });

  it('does NOT fire when schema_valid is null', () => {
    const ctx = {
      record: {
        verification: {
          schema_valid: null,
          rejection_reasons: ['schema:foo']
        }
      },
      rejected: false,
      repoSlug: 'test-repo'
    };
    assert.equal(rule.applies(ctx), false);
  });

  it('does NOT fire when schema_valid is true', () => {
    const ctx = {
      record: {
        verification: {
          schema_valid: true,
          rejection_reasons: ['schema:foo']
        }
      },
      rejected: false,
      repoSlug: 'test-repo'
    };
    assert.equal(rule.applies(ctx), false);
  });

  it('DOES fire when schema_valid is explicitly false with schema rejection reason', () => {
    const ctx = {
      record: {
        verification: {
          schema_valid: false,
          rejection_reasons: ['schema:foo']
        }
      },
      rejected: false,
      repoSlug: 'test-repo'
    };
    assert.equal(rule.applies(ctx), true);
  });

  // Baseline reference: same shape against rulePolicyRejection (already correct on line 368)
  it('baseline: rulePolicyRejection.applies behaves the same way on undefined policy_valid', () => {
    const policyRule = getRuleById('rule-policy-rejection');
    const ctx = {
      record: {
        verification: {
          policy_valid: undefined,
          rejection_reasons: ['policy:foo']
        }
      },
      rejected: false,
      repoSlug: 'test-repo'
    };
    assert.equal(policyRule.applies(ctx), false);
  });
});

// ============================================================
// Real record integration tests
// ============================================================

describe('Integration: real records', () => {
  it('derives from real rejected claude-guardian record', () => {
    const entry = loadRecordById(ROOT, 'claude-guardian-23326439671-1');
    if (!entry) return; // Skip if record not available
    const candidates = deriveFromRecord(entry.record, { rejected: entry.rejected });
    assert.ok(candidates.length >= 1, 'Should emit at least 1 candidate');
    const surfaceMatch = candidates.find(c => c.issue_kind === 'surface_misclassification');
    assert.ok(surfaceMatch, 'Should detect surface misclassification');
  });

  it('derives from real rejected shipcheck record', () => {
    const entry = loadRecordById(ROOT, 'shipcheck-23319886946-1');
    if (!entry) return;
    const candidates = deriveFromRecord(entry.record, { rejected: entry.rejected });
    const evidenceMatch = candidates.find(c => c.derived.rule_id === 'rule-evidence-policy-mismatch');
    assert.ok(evidenceMatch, 'Should detect evidence policy mismatch');
  });

  it('all candidates from real records are schema-valid', () => {
    const allEntries = loadAllRecords(ROOT);
    const { candidates } = deriveFromRecords(allEntries);
    for (const c of candidates) {
      const result = validateFinding(c);
      assert.equal(result.valid, true, `${c.finding_id} invalid: ${JSON.stringify(result.errors)}`);
    }
  });
});

// ============================================================
// Rule-error surfacing (F-246817-013 regression)
// ============================================================
//
// Bug: deriveFromRecord wrapped each rule in `try { ... } catch {}` with an
// empty body. A throwing rule produced ZERO candidates and ZERO operator
// signal. The comment in the source admitted "in a real system this would
// be logged."
//
// Fix: collect per-rule errors into a return value, log to stderr, and surface
// non-empty ruleErrors via the CLI as a non-zero exit. A derive operation
// that ate 8 thrown rules MUST NOT report success.

import { deriveFromRecordWithErrors } from './derive-findings.js';

describe('rule-error surfacing (F-246817-013)', () => {
  // Replace one rule with a throwing stub for the duration of a test.
  function withThrowingRule(ruleId, fn) {
    const idx = RULES.findIndex(r => r.ruleId === ruleId);
    if (idx === -1) throw new Error(`rule not found: ${ruleId}`);
    const original = RULES[idx];
    RULES[idx] = {
      ruleId,
      description: original.description,
      applies: () => true,
      derive: () => { throw new Error('boom from test'); }
    };
    try {
      return fn();
    } finally {
      RULES[idx] = original;
    }
  }

  it('deriveFromRecordWithErrors returns ruleErrors with ruleId+runId+message', () => {
    const record = makePassingRecord({ run_id: 'rule-err-001' });
    const result = withThrowingRule('rule-scenario-step-failure', () => {
      return deriveFromRecordWithErrors(record);
    });
    assert.ok(Array.isArray(result.ruleErrors), 'ruleErrors must be an array');
    const err = result.ruleErrors.find(e => e.ruleId === 'rule-scenario-step-failure');
    assert.ok(err, 'ruleErrors must include the throwing rule');
    assert.equal(err.runId, 'rule-err-001');
    assert.match(err.message, /boom from test/);
  });

  it('deriveFromRecord stays back-compat (returns array, does not throw)', () => {
    const record = makePassingRecord({ run_id: 'rule-err-002' });
    const candidates = withThrowingRule('rule-scenario-step-failure', () => {
      // Suppress stderr noise during this assertion.
      const origErr = console.error;
      console.error = () => {};
      try {
        return deriveFromRecord(record);
      } finally {
        console.error = origErr;
      }
    });
    assert.ok(Array.isArray(candidates), 'deriveFromRecord must still return an array');
  });

  it('deriveFromRecords aggregates ruleErrors across all entries and exposes count in stats', () => {
    const a = makePassingRecord({ run_id: 'rule-err-a' });
    const b = makeStepFailureRecord();
    b.run_id = 'rule-err-b';
    const result = withThrowingRule('rule-scenario-step-failure', () => {
      const origErr = console.error;
      console.error = () => {};
      try {
        return deriveFromRecords([
          { record: a, rejected: false },
          { record: b, rejected: false }
        ]);
      } finally {
        console.error = origErr;
      }
    });
    assert.ok(Array.isArray(result.ruleErrors));
    assert.ok(result.ruleErrors.length >= 2, 'at least one error per record');
    assert.equal(result.stats.ruleErrors, result.ruleErrors.length);
    const runIds = new Set(result.ruleErrors.map(e => e.runId));
    assert.ok(runIds.has('rule-err-a'));
    assert.ok(runIds.has('rule-err-b'));
  });

  it('stderr receives a [derive] log line per rule throw', () => {
    const record = makePassingRecord({ run_id: 'rule-err-stderr' });
    const captured = [];
    const origErr = console.error;
    console.error = (...args) => { captured.push(args.join(' ')); };
    try {
      withThrowingRule('rule-scenario-step-failure', () => {
        deriveFromRecord(record);
      });
    } finally {
      console.error = origErr;
    }
    const matched = captured.find(line =>
      line.includes('[derive]') &&
      line.includes('rule-scenario-step-failure') &&
      line.includes('rule-err-stderr')
    );
    assert.ok(matched, `expected [derive] stderr line, got: ${JSON.stringify(captured)}`);
  });

  // F-091578-033: behavioral coverage on the operator-facing framing of a
  // ruleError. The previous tests pin structural fields (ruleId/runId/message)
  // and the synthetic stub message ('boom from test'). NONE pin the
  // actionable-hint sub-pattern an operator needs to know "a rule errored,
  // findings may be incomplete — re-run with a fix" rather than "a generic
  // exception bubbled up — restart the job."
  //
  // The framing lives across two operator surfaces:
  //   1. The stderr `[derive] rule '<id>' threw on run_id=<id>: <msg>` line
  //      (derive-findings.js:88-90) — the word "rule" carries the framing.
  //   2. The synthesized rendering an operator builds from the ruleErrors[]
  //      shape — `rule=<id>` is the framing word.
  //
  // Sub-pattern: /rule|finding|skipped/i — survives rewordings ("rule X
  // failed", "finding pipeline skipped X", "rule errored") but fails if the
  // framing collapses to a generic "error" / "exception" message.
  it('ruleError surface preserves actionable-hint sub-pattern (F-091578-033)', () => {
    const record = makePassingRecord({ run_id: 'rule-err-actionable' });
    const captured = [];
    const origErr = console.error;
    console.error = (...args) => { captured.push(args.join(' ')); };
    let result;
    try {
      result = withThrowingRule('rule-scenario-step-failure', () => {
        return deriveFromRecordWithErrors(record);
      });
    } finally {
      console.error = origErr;
    }

    // (a) The structured ruleErrors[] entry must let an operator-facing
    // renderer (CLI cli.js:377 builds `rule=<id> run_id=<id> msg=<msg>`)
    // produce a line that carries the actionable framing.
    const entry = result.ruleErrors.find(e => e.runId === 'rule-err-actionable');
    assert.ok(entry, 'ruleErrors must include the failing run');
    const operatorLine = `rule=${entry.ruleId} run_id=${entry.runId} msg=${entry.message}`;
    assert.match(operatorLine, /rule|finding|skipped/i,
      'operator-rendered ruleError line must carry "rule"/"finding"/"skipped" framing so action=re-run-with-fix is legible, not action=restart-job');

    // (b) The stderr [derive] line itself must independently carry the same
    // sub-pattern — that line is what surfaces in CI logs even when no CLI
    // wrapper renders the structured array.
    const derived = captured.find(line => line.includes('[derive]'));
    assert.ok(derived, `expected [derive] stderr line, got: ${JSON.stringify(captured)}`);
    assert.match(derived, /rule|finding|skipped/i,
      '[derive] stderr line must preserve the "rule errored, findings incomplete" framing across rewordings');
  });
});

// ============================================================
// Multi-scenario derivation (F-375053-007 regression)
// ============================================================
//
// Bug: assembleFinding hardcoded `record.scenario_results?.[0]?.execution_mode`
// and every helper in rules.js (scenarioSurface, scenarioMode, scenarioId,
// failedSteps, scenarioVerdict) read only index 0. Multi-scenario records
// emitted findings ONLY from scenario[0]; later scenarios with failed steps
// emitted nothing, and any finding that DID emit got scenario[0]'s metadata
// regardless of which scenario it described.
//
// Fix: deriveFromRecordWithErrors iterates per-scenario, presenting each rule
// a per-scenario VIEW of the record so the index-0 helpers see the right
// scenario. Backward compat: single-scenario records produce identical output.
// Dedupe collapses any overlap between rules that already iterated all
// scenarios internally (rule-blocked-scenario, rule-execution-mode-gap).

describe('Multi-scenario derivation (F-375053-007)', () => {
  /** Three-scenario record: scenario 0 passes, scenario 1 fails on verify-output,
   *  scenario 2 is blocked. Each scenario uses a different product_surface so
   *  we can assert findings are tied to the RIGHT scenario's metadata. */
  function makeMultiScenarioRecord() {
    return makePassingRecord({
      run_id: 'multi-scen-001',
      repo: 'mcp-tool-shop-org/multi-test',
      scenario_results: [
        {
          scenario_id: 'scen-pass',
          product_surface: 'cli',
          execution_mode: 'bot',
          verdict: 'pass',
          step_results: [{ step_id: 'run-help', status: 'pass' }],
          evidence: [{ kind: 'log', url: 'https://example.com/log' }]
        },
        {
          scenario_id: 'scen-fail',
          product_surface: 'mcp-server',
          execution_mode: 'bot',
          verdict: 'fail',
          step_results: [
            { step_id: 'run-init', status: 'pass' },
            { step_id: 'verify-output', status: 'fail' }
          ],
          evidence: [{ kind: 'log', url: 'https://example.com/log' }]
        },
        {
          scenario_id: 'scen-blocked',
          product_surface: 'desktop',
          execution_mode: 'mixed',
          verdict: 'blocked',
          blocking_reason: 'GUI runner unavailable',
          step_results: [{ step_id: 'launch', status: 'blocked' }],
          evidence: []
        }
      ],
      overall_verdict: { proposed: 'fail', verified: 'fail', downgraded: false }
    });
  }

  it('emits step-failure finding for scenario 1 (was hidden behind scenario[0])', () => {
    const candidates = deriveFromRecord(makeMultiScenarioRecord());
    const stepFailFindings = candidates.filter(c =>
      c.derived.rule_id === 'rule-scenario-step-failure'
    );
    assert.ok(stepFailFindings.length >= 1,
      `pre-fix bug: scenario[0] passed so rule-scenario-step-failure produced 0 findings; ` +
      `post-fix: scenario[1] should emit one. Got ${stepFailFindings.length}.`);
    // The emitted finding's product_surface must be scenario 1's surface
    // (mcp-server), not scenario 0's (cli) — proves the per-scenario projection
    // is feeding the right metadata to the rule.
    const mcpFinding = stepFailFindings.find(c => c.product_surface === 'mcp-server');
    assert.ok(mcpFinding,
      `step-failure finding should carry scenario[1]'s product_surface "mcp-server", ` +
      `got: ${stepFailFindings.map(c => c.product_surface).join(', ')}`);
    // And the scenario_ids on the finding should be exactly that scenario's id.
    assert.deepEqual(mcpFinding.scenario_ids, ['scen-fail']);
  });

  it('emits blocked-scenario finding for scenario 2', () => {
    const candidates = deriveFromRecord(makeMultiScenarioRecord());
    const blocked = candidates.filter(c =>
      c.derived.rule_id === 'rule-blocked-scenario'
    );
    assert.ok(blocked.length >= 1, 'should emit at least one blocked-scenario finding');
    const blockedScen = blocked.find(c => c.summary.includes('scen-blocked'));
    assert.ok(blockedScen, `expected finding for scen-blocked, got: ${blocked.map(b => b.summary).join('|')}`);
  });

  it('emits attestation-gap finding for scenario 2 (mixed mode, no attested_by)', () => {
    const candidates = deriveFromRecord(makeMultiScenarioRecord());
    const attestation = candidates.filter(c =>
      c.derived.rule_id === 'rule-execution-mode-gap'
    );
    assert.ok(attestation.length >= 1,
      `expected attestation-gap finding for mixed-mode scenario 2, got ${attestation.length}`);
  });

  it('single-scenario record output is unchanged (backward compat)', () => {
    // Run a single-scenario record through the derive pipeline. The shape
    // and contents of findings must match what the old (index-0-only) code
    // would have produced — no extra emissions, same metadata.
    const single = makeStepFailureRecord();
    const candidates = deriveFromRecord(single);
    const stepFail = candidates.find(c => c.derived.rule_id === 'rule-scenario-step-failure');
    assert.ok(stepFail, 'single-scenario step-failure record must still emit');
    assert.equal(stepFail.product_surface, 'cli');
    assert.equal(stepFail.execution_mode, 'bot');
    assert.deepEqual(stepFail.scenario_ids, ['cli-full-test']);
  });
});

import { parseRejectionReason } from '@dogfood-lab/verify';

// ============================================================
// Regression: F-e1d45d27 — schema:/policy: routed through
// parseRejectionReason instead of hand-rolled regex
// ============================================================
//
// ruleSchemaRejection.applies/derive and rulePolicyRejection.applies/derive
// (rules.js:347/353/386/392) used to test rejection_reasons entries with
// `/^schema:/.test(r)` / `/^policy:/.test(r)` directly instead of importing
// parse-rejection.js's authoritative classifier — the exact "hand-rolled
// .startsWith() chain" drift source parse-rejection.js's own file header
// names as its reason for existing. Fix imports `parseRejectionReason` from
// `@dogfood-lab/verify` (already a transitive dependency via
// @dogfood-lab/ingest; now direct) and reads `.prefix === 'schema:'` /
// `'policy:'`.
//
// This is a differential-equivalence proof, not just a "still fires" smoke
// test: `oldMatch` below is the two retired regexes, lifted verbatim, and the
// matrix proves the new classifier-based check agrees with them on every
// case — including the `policy-config:` adjacency the finding's own evidence
// cites (a longer, unrelated prefix that must NOT collide with the bare
// `policy:` match). A pure behavior test alone cannot catch a future
// reversion to hand-rolled regex (today the two mechanisms agree on every
// input), so the final test in this block source-scans rules.js for the
// retired call shape as a structural pin.

describe('Regression: rules.js schema:/policy: routes through parseRejectionReason (F-e1d45d27)', () => {
  const schemaRule = getRuleById('rule-schema-rejection');
  const policyRule = getRuleById('rule-policy-rejection');

  // The retired oracle: rules.js's pre-fix hand-rolled matchers, verbatim.
  const oldSchemaMatch = (r) => /^schema:/.test(r);
  const oldPolicyMatch = (r) => /^policy:/.test(r);

  // [reason, expected old-schema-match, expected old-policy-match]
  const CASES = [
    ['schema: /repo must be string', true, false],
    ['schema:no-space-variant', true, false],
    ['policy: forbidden tag "wip"', false, true],
    ['policy:no-space-variant', false, true],
    // Adjacency: policy-config: (VERIFY-F1's repo-custom-rule-predicate-fault
    // prefix) must NOT satisfy the policy: match.
    ['policy-config: predicate crashed evaluating custom rule', false, false],
    // A prefix sharing no token with either.
    ['provenance: source run could not be confirmed', false, false],
  ];

  for (const [reason, expectSchema, expectPolicy] of CASES) {
    it(`parseRejectionReason agrees with the retired regex for ${JSON.stringify(reason)}`, () => {
      const parsed = parseRejectionReason(reason);
      assert.equal(parsed.prefix === 'schema:', oldSchemaMatch(reason),
        `schema: classification must match the retired /^schema:/ regex for ${reason}`);
      assert.equal(parsed.prefix === 'policy:', oldPolicyMatch(reason),
        `policy: classification must match the retired /^policy:/ regex for ${reason}`);
      // Sanity-anchor the table itself against what the retired oracle says,
      // so a typo in CASES fails loudly here rather than masking a real gap.
      assert.equal(oldSchemaMatch(reason), expectSchema);
      assert.equal(oldPolicyMatch(reason), expectPolicy);
    });
  }

  it('ruleSchemaRejection.applies still fires on a schema: rejection (behaviorally unchanged)', () => {
    const ctx = {
      record: { verification: { schema_valid: false, rejection_reasons: ['schema: /repo must be string'] } },
      rejected: true,
      repoSlug: 'test-repo'
    };
    assert.equal(schemaRule.applies(ctx), true);
  });

  it('rulePolicyRejection.applies still fires on a policy: rejection (behaviorally unchanged)', () => {
    const ctx = {
      record: { verification: { policy_valid: false, rejection_reasons: ['policy: forbidden tag "wip"'] } },
      rejected: true,
      repoSlug: 'test-repo'
    };
    assert.equal(policyRule.applies(ctx), true);
  });

  it('ruleSchemaRejection.applies does NOT fire on a policy-config: rejection (no adjacency collision)', () => {
    const ctx = {
      record: { verification: { schema_valid: false, rejection_reasons: ['policy-config: predicate crashed'] } },
      rejected: true,
      repoSlug: 'test-repo'
    };
    assert.equal(schemaRule.applies(ctx), false);
  });

  it('rulePolicyRejection.applies does NOT fire on a policy-config: rejection (no adjacency collision)', () => {
    const ctx = {
      record: { verification: { policy_valid: false, rejection_reasons: ['policy-config: predicate crashed'] } },
      rejected: true,
      repoSlug: 'test-repo'
    };
    assert.equal(policyRule.applies(ctx), false);
  });

  it('ruleSchemaRejection.derive filters reasons to only the schema: subset via the classifier', () => {
    const record = {
      run_id: 'e1d45d27-schema-filter',
      verification: {
        schema_valid: false,
        rejection_reasons: [
          'schema: /repo must be string',
          'policy: forbidden tag "wip"',
          'schema: /timing/started_at must match format "date-time"'
        ]
      }
    };
    const [finding] = schemaRule.derive({ record, repoSlug: 'test-repo' });
    assert.match(finding.summary, /\/repo must be string/);
    assert.match(finding.summary, /started_at must match format/);
    assert.doesNotMatch(finding.summary, /forbidden tag/);
  });

  it('rulePolicyRejection.derive filters reasons to only the policy: subset via the classifier', () => {
    const record = {
      run_id: 'e1d45d27-policy-filter',
      verification: {
        policy_valid: false,
        rejection_reasons: [
          'policy: forbidden tag "wip"',
          'schema: /repo must be string',
          'policy: surface[cli]: requires 2 evidence items, got 1'
        ]
      }
    };
    const [finding] = policyRule.derive({ record, repoSlug: 'test-repo' });
    assert.match(finding.summary, /forbidden tag/);
    assert.match(finding.summary, /requires 2 evidence items/);
    assert.doesNotMatch(finding.summary, /\/repo must be string/);
  });

  it('structural pin: rules.js imports the classifier and no longer hand-rolls /^schema:/ or /^policy:/ regex tests', () => {
    // A behavioral differential test cannot catch a reversion to hand-rolled
    // regex, because the two mechanisms agree on every input today (that IS
    // the fix's own correctness claim). This is the only test in the file
    // that actually pins "uses the shared classifier" rather than "produces
    // the same answer the classifier would have produced."
    const source = readFileSync(resolve(__dirname, 'rules.js'), 'utf-8');
    assert.doesNotMatch(source, /\/\^schema:\/\.test\(/,
      'rules.js must not reintroduce a hand-rolled /^schema:/.test(...) — use parseRejectionReason(r).prefix instead');
    assert.doesNotMatch(source, /\/\^policy:\/\.test\(/,
      'rules.js must not reintroduce a hand-rolled /^policy:/.test(...) — use parseRejectionReason(r).prefix instead');
    assert.match(source, /from ['"]@dogfood-lab\/verify['"]/,
      'rules.js must import the authoritative classifier from @dogfood-lab/verify');
  });
});
