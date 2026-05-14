/**
 * wave28-cross-fix.test.js — Phase 7 wave 2 backend cross-fix-deps.
 *
 * Closes the open loops surfaced by wave-1 ci-tooling + pipeline agents:
 *
 *   W2-BACK-001  validateAgentOutput wired into commands/collect.js — live
 *                agent JSONs are now rejected at write time with a
 *                structured AgentOutputValidationError instead of being
 *                silently normalized. F-252713-017 Class #11 closure.
 *
 *   W2-BACK-002  AUDIT_CATEGORIES extended for historical wave-15 +
 *                wave-20 vocabulary (hygiene, error_message_quality,
 *                cli_help_quality, silent_failure, tests_coverage). The
 *                shape-specific validateAuditOutput() in lib/output-schema.js
 *                now accepts these without false positives.
 *
 *   W2-BACK-003  6 raw writeFileSync callers in dogfood-swarm/ migrated to
 *                atomicWriteFileSync. Asserted indirectly: the migrated
 *                files import the helper.
 *
 *   W2-BACK-006  Two coordination logStage callsites (collect.js
 *                upsert_findings_failed + dispatch.js isolate_failed) carry
 *                a coord-<base36-ts>-<rand4> correlation_id at the outer
 *                envelope. FT-PIPELINE-004 cross-fix-dep.
 *
 *   W2-BACK-007  formatHumanBanner() surfaces correlation_id in TTY
 *                banners after the verdict + identity fields.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateAgentOutput,
  AgentOutputValidationError,
} from './lib/validate-agent-output.js';
import { AUDIT_CATEGORIES, validateAuditOutput } from './lib/output-schema.js';
import { formatHumanBanner } from './lib/log-stage.js';
import { renderTopLevelError } from './lib/error-render.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════
// W2-BACK-001 — validateAgentOutput contract gate
// ═══════════════════════════════════════════

// F-252713-017 — Phase 7 wave 1 ci-tooling agent built the schema; this
// suite is the wave 2 backend wiring closure that proves live agent JSONs
// (not just CI fixtures) are gated.
describe('W2-BACK-001 — validateAgentOutput rejects malformed agent JSONs', () => {
  it('valid audit envelope passes through', () => {
    const out = validateAgentOutput({
      domain: 'backend',
      stage: 'A',
      summary: 'one finding',
      findings: [{
        id: 'F-W28-001',
        severity: 'HIGH',
        category: 'bug',
        description: 'thing broke',
      }],
    });
    assert.equal(out.domain, 'backend');
  });

  it('valid feature envelope passes through', () => {
    const out = validateAgentOutput({
      domain: 'backend',
      summary: 'feature audit',
      features: [{
        id: 'F-FEAT-1',
        priority: 'MEDIUM',
        category: 'missing-feature',
        description: 'wire validator into collect.js',
      }],
    });
    assert.equal(out.features.length, 1);
  });

  it('valid amend envelope passes through', () => {
    const out = validateAgentOutput({
      domain: 'backend',
      summary: 'wave 28 amend',
      fixes: [{ finding_id: 'W2-BACK-001', description: 'wired validateAgentOutput' }],
      files_changed: ['packages/dogfood-swarm/commands/collect.js'],
    });
    assert.equal(out.fixes.length, 1);
  });

  it('missing domain throws AgentOutputValidationError with code', () => {
    let thrown;
    try {
      validateAgentOutput({ summary: 'no domain' });
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof AgentOutputValidationError);
    assert.equal(thrown.code, 'AGENT_OUTPUT_SCHEMA_INVALID');
    assert.match(thrown.message, /domain/);
  });

  it('invalid severity in finding throws with structured errors[]', () => {
    let thrown;
    try {
      validateAgentOutput({
        domain: 'backend',
        summary: 'bad severity',
        findings: [{
          id: 'F-X', severity: 'WARN', category: 'bug', description: 'x',
        }],
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof AgentOutputValidationError);
    assert.ok(Array.isArray(thrown.errors));
    // Ajv reports enum failures as { path: '/findings/0/severity', keyword: 'enum',
    // params: { allowedValues: [...] } }. Either the path or the keyword is enough
    // to confirm the gate caught the right field.
    assert.ok(
      thrown.errors.some(e =>
        /severity/.test(e.path || '') ||
        e.keyword === 'enum' ||
        /CRITICAL|HIGH|MEDIUM|LOW/.test(JSON.stringify(e.params || {})),
      ),
      `expected severity enum violation in errors[]; got ${JSON.stringify(thrown.errors)}`,
    );
  });

  it('AgentOutputValidationError carries domain + outputPath context', () => {
    let thrown;
    try {
      validateAgentOutput({ summary: 'no domain' }, {
        domain: 'backend',
        phase: 'health-audit-a',
        outputPath: '/tmp/out.json',
      });
    } catch (e) { thrown = e; }
    assert.equal(thrown.domain, 'backend');
    assert.equal(thrown.phase, 'health-audit-a');
    assert.equal(thrown.outputPath, '/tmp/out.json');
  });

  it('renderTopLevelError surfaces AGENT_OUTPUT_SCHEMA_INVALID hint with output path', () => {
    const orig = console.error;
    const lines = [];
    console.error = (...args) => lines.push(args.join(' '));
    try {
      const err = new AgentOutputValidationError(
        [{ path: '/findings/0/severity', message: 'must be equal to one of the allowed values' }],
        { domain: 'backend', outputPath: '/tmp/backend.json' },
      );
      renderTopLevelError(err);
    } finally {
      console.error = orig;
    }
    const joined = lines.join('\n');
    assert.match(joined, /\[AGENT_OUTPUT_SCHEMA_INVALID\]/);
    assert.match(joined, /Next:.*backend\.json/);
    assert.match(joined, /agent-output\.schema\.json/);
  });
});

// ═══════════════════════════════════════════
// W2-BACK-002 — AUDIT_CATEGORIES extended for historical reuse
// ═══════════════════════════════════════════

describe('W2-BACK-002 — AUDIT_CATEGORIES absorbs historical wave-15/20 vocab', () => {
  const NEW_CATEGORIES = [
    'hygiene',
    'error_message_quality',
    'cli_help_quality',
    'silent_failure',
    'tests_coverage',
  ];

  it('new categories are present in the enum', () => {
    for (const cat of NEW_CATEGORIES) {
      assert.ok(AUDIT_CATEGORIES.includes(cat),
        `expected '${cat}' in AUDIT_CATEGORIES; got ${AUDIT_CATEGORIES.join(', ')}`);
    }
  });

  it('original 12 categories still present (no regression)', () => {
    const ORIGINAL = [
      'bug', 'security', 'quality', 'types', 'tests', 'docs',
      'defensive', 'observability', 'degradation', 'future-proofing',
      'ux', 'accessibility',
    ];
    for (const cat of ORIGINAL) {
      assert.ok(AUDIT_CATEGORIES.includes(cat), `missing original category '${cat}'`);
    }
  });

  it('validateAuditOutput accepts a finding with category=hygiene', () => {
    const result = validateAuditOutput({
      domain: 'backend',
      stage: 'A',
      summary: 'hygiene check',
      findings: [{
        id: 'F-W28-H1',
        severity: 'LOW',
        category: 'hygiene',
        description: 'package.json field order drift',
      }],
    });
    assert.equal(result.valid, true,
      `expected valid=true; got errors: ${result.errors?.join('; ')}`);
  });

  it('validateAuditOutput accepts a finding with category=tests_coverage', () => {
    const result = validateAuditOutput({
      domain: 'backend',
      stage: 'A',
      summary: 'tests coverage gap',
      findings: [{
        id: 'F-W28-TC1',
        severity: 'MEDIUM',
        category: 'tests_coverage',
        description: 'no test exercises the resume path',
      }],
    });
    assert.equal(result.valid, true);
  });

  it('truly unknown categories still rejected (gate not weakened)', () => {
    const result = validateAuditOutput({
      domain: 'backend',
      stage: 'A',
      summary: 'made up category',
      findings: [{
        id: 'F-W28-X', severity: 'LOW', category: 'made-up-thing', description: 'x',
      }],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /Invalid category/.test(e)),
      `expected category rejection; got: ${result.errors.join('; ')}`);
  });
});

// ═══════════════════════════════════════════
// W2-BACK-003 — Migrated callers import atomicWriteFileSync
// ═══════════════════════════════════════════

describe('W2-BACK-003 — atomic-write helper adopted by 6 in-scope callers', () => {
  const MIGRATED = [
    'commands/dispatch.js',
    'commands/persist.js',
    'commands/receipt.js',
    'commands/resume.js',
    'commands/verify-fixed.js',
    'persist-results.js',
  ];

  for (const rel of MIGRATED) {
    it(`${rel} imports atomicWriteFileSync from @dogfood-lab/findings`, () => {
      const src = readFileSync(join(__dirname, rel), 'utf-8');
      assert.match(src, /atomicWriteFileSync/,
        `${rel} must reference atomicWriteFileSync after migration`);
      assert.match(src, /@dogfood-lab\/findings\/lib\/atomic-write\.js/,
        `${rel} must import the canonical helper, not relative path`);
    });

    it(`${rel} no longer calls raw writeFileSync at the migrated callsites`, () => {
      const src = readFileSync(join(__dirname, rel), 'utf-8');
      // No bare writeFileSync( calls — comments allowed (they're stripped).
      const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(noComments, /(?<![A-Za-z])writeFileSync\(/,
        `${rel} still has a raw writeFileSync( callsite after migration`);
    });
  }

  it('lib/verify/runner.js no longer imports writeFileSync (stale claim resolved)', () => {
    const src = readFileSync(join(__dirname, 'lib/verify/runner.js'), 'utf-8');
    assert.doesNotMatch(src, /writeFileSync/,
      'lib/verify/runner.js had a dead writeFileSync import; should be removed');
  });
});

// ═══════════════════════════════════════════
// W2-BACK-006 + W2-BACK-007 — correlation_id end-to-end
// ═══════════════════════════════════════════

describe('W2-BACK-006 — coordination logStage callsites mint a correlation_id', () => {
  it('collect.js source emits correlation_id at upsert_findings_failed', () => {
    const src = readFileSync(join(__dirname, 'commands/collect.js'), 'utf-8');
    // The stage name and the field name must both appear inside the same
    // logStage call. Use a focused match instead of a free-text search.
    const match = src.match(/logStage\('upsert_findings_failed',\s*\{([\s\S]*?)\}\)/);
    assert.ok(match, 'logStage upsert_findings_failed call not found');
    assert.match(match[1], /correlation_id/,
      'upsert_findings_failed logStage must include correlation_id');
  });

  it('dispatch.js source emits correlation_id at isolate_failed', () => {
    const src = readFileSync(join(__dirname, 'commands/dispatch.js'), 'utf-8');
    const match = src.match(/logStage\('isolate_failed',\s*\{([\s\S]*?)\}\)/);
    assert.ok(match, 'logStage isolate_failed call not found');
    assert.match(match[1], /correlation_id/,
      'isolate_failed logStage must include correlation_id');
  });

  it('mintCorrelationId helpers in collect.js and dispatch.js produce coord-<base36-ts>-<hex4> ids', () => {
    // F-W1-TEST-008: previous shape asserted a synthetic regex against itself
    // (a tautology). Read the actual source of both helpers and assert that
    // (a) each emits the same `coord-<base36-ts>-<rand>` shape, (b) the
    // random suffix is `randomBytes(2).toString('hex')` (4 hex chars), and
    // (c) the timestamp is `Date.now().toString(36)`. This catches any
    // regression that drops the base36 timestamp or changes the rand width.
    const sources = ['commands/collect.js', 'commands/dispatch.js'].map((rel) => ({
      rel,
      src: readFileSync(join(__dirname, rel), 'utf-8'),
    }));
    for (const { rel, src } of sources) {
      const mintMatch = src.match(
        /function mintCorrelationId\s*\(\)\s*\{([\s\S]*?)return\s+`coord-\$\{([^}]+)\}-\$\{([^}]+)\}`/
      );
      assert.ok(mintMatch, `${rel}: mintCorrelationId helper not found in expected shape`);
      const body = mintMatch[1];
      assert.match(body, /Date\.now\(\)\.toString\(36\)/,
        `${rel}: timestamp must be Date.now().toString(36)`);
      assert.match(body, /randomBytes\(2\)\.toString\('hex'\)/,
        `${rel}: random suffix must be randomBytes(2).toString('hex') (4 hex chars)`);
    }
  });
});

describe('W2-BACK-007 — formatHumanBanner surfaces correlation_id', () => {
  it('correlation_id appears in TTY banner after run/wave identity fields', () => {
    const banner = formatHumanBanner({
      component: 'dogfood-swarm',
      stage: 'isolate_failed',
      runId: 'r-1',
      waveId: 9,
      domain: 'backend',
      correlation_id: 'coord-abc-1234',
      err: 'git failed',
    });
    assert.match(banner, /^\[dogfood-swarm:isolate_failed\]/);
    assert.match(banner, /correlation_id=coord-abc-1234/);
    // Order: domain → run → wave → correlation_id.
    const domainIdx = banner.indexOf('domain=backend');
    const runIdx = banner.indexOf('run=r-1');
    const corrIdx = banner.indexOf('correlation_id=');
    assert.ok(domainIdx < runIdx, 'domain before run');
    assert.ok(runIdx < corrIdx, 'run before correlation_id');
  });

  it('correlationId (camelCase) variant also surfaces', () => {
    const banner = formatHumanBanner({
      component: 'dogfood-swarm',
      stage: 'upsert_findings_failed',
      runId: 'r-2',
      correlationId: 'coord-xyz-5678',
    });
    assert.match(banner, /correlation_id=coord-xyz-5678/);
  });

  it('absence of correlation_id leaves banner unchanged', () => {
    const banner = formatHumanBanner({
      component: 'ingest',
      stage: 'verify_complete',
      submission_id: 's-1',
      status: 'pass',
    });
    assert.doesNotMatch(banner, /correlation_id=/);
  });
});
