import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  surfaceFromType,
  deriveVerdict,
  buildScenarioResults,
  computeOverallVerdict,
  buildAuditPayload,
} from './persist-results.js';

// --- surfaceFromType (mapComponentType) ---

describe('surfaceFromType', () => {
  it('maps all component types correctly', () => {
    assert.equal(surfaceFromType('backend'), 'cli');
    assert.equal(surfaceFromType('frontend'), 'web');
    assert.equal(surfaceFromType('api'), 'cli');
    assert.equal(surfaceFromType('cli'), 'cli');
    assert.equal(surfaceFromType('library'), 'cli');
    assert.equal(surfaceFromType('service'), 'cli');
    assert.equal(surfaceFromType('web'), 'web');
    assert.equal(surfaceFromType('ui'), 'web');
    assert.equal(surfaceFromType('site'), 'web');
    assert.equal(surfaceFromType('package'), 'cli');
    assert.equal(surfaceFromType('plugin'), 'cli');
  });

  it('defaults unknown types to cli', () => {
    assert.equal(surfaceFromType('config'), 'cli');
    assert.equal(surfaceFromType('tests'), 'cli');
    assert.equal(surfaceFromType('docs'), 'cli');
    assert.equal(surfaceFromType('ci'), 'cli');
    assert.equal(surfaceFromType(''), 'cli');
    assert.equal(surfaceFromType(undefined), 'cli');
  });

  it('handles case-insensitive input', () => {
    assert.equal(surfaceFromType('Frontend'), 'web');
    assert.equal(surfaceFromType('BACKEND'), 'cli');
  });
});

// --- deriveVerdict (computeComponentVerdict) ---

describe('deriveVerdict', () => {
  it('returns pass when no findings', () => {
    assert.equal(deriveVerdict([]), 'pass');
  });

  // d4-swarm-core-002 (Stage A): fixtures use UPPERCASE severity — the case the
  // agent-output contract (and every real audit JSON) actually carries. The
  // lowercase fixtures these replaced pinned the d4-swarm-core-001 bug and gave
  // the release gate zero effective coverage.
  it('returns fail when critical findings exist', () => {
    const findings = [{ severity: 'CRITICAL', status: 'open' }];
    assert.equal(deriveVerdict(findings), 'fail');
  });

  it('returns partial when high findings exist', () => {
    const findings = [{ severity: 'HIGH', status: 'open' }];
    assert.equal(deriveVerdict(findings), 'partial');
  });

  it('returns pass when only medium findings', () => {
    const findings = [
      { severity: 'MEDIUM', status: 'open' },
      { severity: 'LOW', status: 'open' },
    ];
    assert.equal(deriveVerdict(findings), 'pass');
  });

  it('ignores fixed critical findings', () => {
    const findings = [{ severity: 'CRITICAL', status: 'fixed' }];
    assert.equal(deriveVerdict(findings), 'pass');
  });

  it('ignores fixed high findings', () => {
    const findings = [{ severity: 'HIGH', status: 'fixed' }];
    assert.equal(deriveVerdict(findings), 'pass');
  });
});

// --- buildScenarioResults + computeOverallVerdict (mergeAuditResults) ---

describe('buildScenarioResults', () => {
  const auditA = {
    component_id: 'core',
    component_type: 'backend',
    findings: [
      { id: 'f1', severity: 'MEDIUM', status: 'open' },
      { id: 'f2', severity: 'LOW', status: 'open' },
    ],
    controls: [{ id: 'c1', status: 'pass' }],
  };

  const auditB = {
    component_id: 'ui',
    component_type: 'frontend',
    findings: [
      { id: 'f3', severity: 'HIGH', status: 'open' },
    ],
    controls: [{ id: 'c2', status: 'fail' }],
  };

  it('produces one scenario per audit result', () => {
    const results = buildScenarioResults([auditA, auditB], []);
    assert.equal(results.length, 2);
  });

  it('sets correct scenario_id and product_surface', () => {
    const results = buildScenarioResults([auditA], []);
    assert.equal(results[0].scenario_id, 'swarm-audit-core');
    assert.equal(results[0].product_surface, 'cli');
  });

  it('computes evidence severities', () => {
    // F-C1 (Wave A1 D3): evidence is now a schema-clean ARRAY of {kind, url,
    // description} items (the previous OBJECT shape violated the
    // dogfood-record-submission schema's evidence items contract). The
    // per-severity counts now live inside the description string of the
    // single evidence row; the same information is asserted via substring
    // match so a future tweak to phrasing does not break the test in
    // lockstep with persist-results.js's emitter.
    const results = buildScenarioResults([auditA], []);
    assert.ok(Array.isArray(results[0].evidence),
      'evidence must be an array per dogfood-record-submission schema');
    assert.equal(results[0].evidence.length, 1);
    const ev = results[0].evidence[0];
    assert.equal(ev.kind, 'artifact');
    assert.match(ev.url, /^swarm:\/\/audit\//);
    assert.match(ev.description, /2 finding\(s\)/);
    assert.match(ev.description, /medium:1/);
    assert.match(ev.description, /low:1/);
  });

  it('marks remediate step pass when remediation exists', () => {
    const remediate = [{ component_id: 'core', fixes: [] }];
    const results = buildScenarioResults([auditA], remediate);
    // F-C1 (Wave A1 D3): step_results items use `step_id` (schema-mandated),
    // updated in lockstep with persist-results.js stepResult() emitter shape.
    const remStep = results[0].step_results.find(s => s.step_id === 'remediate');
    assert.equal(remStep.status, 'pass');
  });

  it('marks remediate step fail when no remediation', () => {
    const results = buildScenarioResults([auditA], []);
    // F-C1 (Wave A1 D3): step_results items use `step_id` (schema-mandated).
    const remStep = results[0].step_results.find(s => s.step_id === 'remediate');
    assert.equal(remStep.status, 'fail');
  });
});

describe('computeOverallVerdict', () => {
  it('returns pass when all pass', () => {
    assert.equal(computeOverallVerdict([{ verdict: 'pass' }, { verdict: 'pass' }]), 'pass');
  });

  it('returns fail when any fail', () => {
    assert.equal(computeOverallVerdict([{ verdict: 'pass' }, { verdict: 'fail' }]), 'fail');
  });

  it('returns partial when any partial but no fail', () => {
    assert.equal(computeOverallVerdict([{ verdict: 'pass' }, { verdict: 'partial' }]), 'partial');
  });
});

// --- buildAuditPayload (computeMetrics + buildAuditPayload shape) ---

describe('buildAuditPayload', () => {
  const manifest = {
    repo: 'mcp-tool-shop-org/test-repo',
    commit_sha: 'b'.repeat(40),
  };

  const audits = [
    {
      component_id: 'core',
      controls: [
        { id: 'c1', domain: 'security', status: 'pass' },
        { id: 'c2', domain: 'docs', status: 'fail' },
      ],
      findings: [
        { id: 'f1', severity: 'CRITICAL', domain: 'security', status: 'open' },
        { id: 'f2', severity: 'MEDIUM', domain: 'docs', status: 'open' },
      ],
    },
    {
      component_id: 'ui',
      controls: [
        { id: 'c3', domain: 'hygiene', status: 'pass' },
      ],
      findings: [
        { id: 'f3', severity: 'LOW', domain: 'hygiene', status: 'open' },
      ],
    },
  ];

  it('produces valid run shape', () => {
    const payload = buildAuditPayload(manifest, audits, []);
    assert.equal(payload.run.slug, 'mcp-tool-shop-org/test-repo');
    assert.equal(payload.run.commit_sha, 'b'.repeat(40));
    assert.equal(payload.run.scope_level, 'full');
    assert.equal(payload.run.blocking_release, true); // has critical
  });

  it('merges controls and findings from all components', () => {
    const payload = buildAuditPayload(manifest, audits, []);
    assert.equal(payload.controls.length, 3);
    assert.equal(payload.findings.length, 3);
  });

  it('computes metrics correctly', () => {
    const payload = buildAuditPayload(manifest, audits, []);
    assert.equal(payload.metrics.critical_count, 1);
    assert.equal(payload.metrics.high_count, 0);
    assert.equal(payload.metrics.medium_count, 1);
    assert.equal(payload.metrics.low_count, 1);
    assert.equal(payload.metrics.controls_passed, 2);
    assert.equal(payload.metrics.controls_total, 3);
    assert.equal(payload.metrics.pass_rate, 0.6667);
  });

  it('collects domains from controls and findings', () => {
    const payload = buildAuditPayload(manifest, audits, []);
    assert.deepEqual(payload.run.domains_checked, ['docs', 'hygiene', 'security']);
  });

  it('applies remediation fixes to findings', () => {
    const remediate = [
      { component_id: 'core', fixes: [{ finding_id: 'f1' }] },
    ];
    const payload = buildAuditPayload(manifest, audits, remediate);
    assert.equal(payload.metrics.critical_count, 0); // f1 now fixed
    assert.equal(payload.run.blocking_release, false);
    assert.equal(payload.run.overall_status, 'pass_with_findings');
  });

  it('returns pass status when no open findings after remediation', () => {
    const allFixed = [
      { component_id: 'core', fixes: [{ finding_id: 'f1' }, { finding_id: 'f2' }] },
      { component_id: 'ui', fixes: [{ finding_id: 'f3' }] },
    ];
    const payload = buildAuditPayload(manifest, audits, allFixed);
    assert.equal(payload.run.overall_status, 'pass');
    assert.equal(payload.run.overall_posture, 'healthy');
  });

  it('returns zero pass_rate when no controls', () => {
    const noControls = [{ component_id: 'x', controls: [], findings: [] }];
    const payload = buildAuditPayload(manifest, noControls, []);
    assert.equal(payload.metrics.pass_rate, 0);
    assert.equal(payload.metrics.controls_total, 0);
  });
});
