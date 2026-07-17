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

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  validateAgentOutput,
  AgentOutputValidationError,
} from './lib/validate-agent-output.js';
import { AUDIT_CATEGORIES, validateAuditOutput } from './lib/output-schema.js';
import { formatHumanBanner } from './lib/log-stage.js';
import { renderTopLevelError } from './lib/error-render.js';
import { stripComments } from './test-support/strip-comments.js';
import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';

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
      //
      // F-911b18ef (wave 22): migrated off a local two-step regex stripper
      // onto the shared test-support/strip-comments.js. This was not just a
      // hygiene migration: the naive pair (`/\*...\*\//g` then `//.*$/gm`)
      // is NOT lexer-aware, and direct differential testing against this
      // file's own real targets found it silently over-stripping TWO of the
      // six migrated files today — commands/persist.js and
      // persist-results.js both carry a `//` comment whose PROSE contains a
      // glob-shaped `/**` or `/*` substring (`commands/**+cli.js`,
      // `audit/*` respectively); the naive regex reads that as a phantom
      // block-comment OPEN and non-greedily consumes real code all the way
      // to the next unrelated `*/` (persist.js: swallows the entire
      // ingest-catch block, ~48 lines; persist-results.js: swallows five
      // whole helper function definitions, ~56 lines) — the exact wave-8
      // defect class strip-comments.js's own header documents. Neither
      // swallowed span currently contains a `writeFileSync(` call, so this
      // assertion is not live-broken today, but the blind spot is real and
      // silent: a future writeFileSync( added inside either erased span
      // would be invisible to this gate. The shared, lexer-aware stripper
      // closes it for all six files uniformly.
      const noComments = stripComments(src);
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
  // F-be3a3bf5 (wave 29): the two tests immediately below replace a pair that
  // regex-extracted the logStage() call's object-literal TEXT from the raw
  // source and asserted only /correlation_id/.test(capturedBody) -- true for
  // the KEY NAME appearing anywhere in the literal, so `correlation_id:
  // undefined`, `correlation_id: 'PLACEHOLDER-NOT-UNIQUE'` (every failure
  // logging the identical fake id), or even a ReferenceError from a deleted
  // `mintCorrelationId()` call all passed the old test unchanged, because it
  // never executed anything. These now drive a REAL collect() upsert-findings
  // failure and a REAL dispatch() --isolate failure (mirroring the established
  // ds-proac-03-collect-lifecycle.test.js pattern: hook the real NDJSON
  // stderr output of the real exported functions, never a reimplementation)
  // and assert the captured correlation_id matches the real
  // coord-<base36-ts>-<4-hex> shape (lib/correlation-id.js) AND differs
  // between two independent failures -- the exact two properties a hardcoded
  // placeholder cannot satisfy.
  let tmp, dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'w28-corr-'));
    dbPath = join(tmp, 'control-plane.db');
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  const CORRELATION_ID_SHAPE = /^coord-[0-9a-z]+-[0-9a-f]{4}$/;

  function setupRun(db, runId, localPath) {
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(runId, 'org/repo', localPath, 'a'.repeat(40));
    saveDomainDraft(db, runId, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, runId);
  }

  function captureStderr(fn) {
    const orig = console.error;
    const lines = [];
    console.error = (...a) => lines.push(a.map(String).join(' '));
    let thrown;
    try { fn(); } catch (e) { thrown = e; } finally { console.error = orig; }
    return { thrown, lines };
  }

  function findNdjsonEvent(lines, stage) {
    for (const ln of lines) {
      try {
        const obj = JSON.parse(ln);
        if (obj && obj.stage === stage) return obj;
      } catch { /* not an NDJSON line -- ignore */ }
    }
    return null;
  }

  it('collect.js emits a genuine, freshly-minted correlation_id at upsert_findings_failed when upsertFindings really throws (F-be3a3bf5)', () => {
    const db = openDb(dbPath);
    setupRun(db, 'r-corr-collect-1', tmp);
    setupRun(db, 'r-corr-collect-2', tmp);
    // Forces upsertFindings' inner INSERT INTO finding_events to throw --
    // the established F-693631-002 recipe (wave12-observability.test.js),
    // reused here rather than reinvented.
    db.exec('DROP TABLE finding_events');

    const emitOne = (runId) => {
      dispatch({ runId, phase: 'health-audit-a', dbPath, outputDir: tmp });
      const outputPath = join(tmp, `${runId}.json`);
      writeFileSync(outputPath, JSON.stringify({
        domain: 'backend',
        stage: 'A',
        summary: 'one finding',
        findings: [{
          id: 'F-CORR-1', severity: 'HIGH', category: 'bug',
          file: 'packages/backend/x.js', line: 10, symbol: 'fooFn',
          description: 'forces upsertFindings to run',
        }],
      }), 'utf-8');

      const { thrown, lines } = captureStderr(() =>
        collect({ runId, dbPath, outputs: { backend: outputPath } }));
      assert.ok(thrown, `collect must throw for ${runId} once finding_events is gone`);
      const event = findNdjsonEvent(lines, 'upsert_findings_failed');
      assert.ok(event, `expected a real upsert_findings_failed NDJSON event for ${runId}; got:\n${lines.join('\n')}`);
      return event.correlation_id;
    };

    const id1 = emitOne('r-corr-collect-1');
    const id2 = emitOne('r-corr-collect-2');

    assert.match(id1, CORRELATION_ID_SHAPE, `correlation_id must match coord-<base36-ts>-<4-hex>, got "${id1}"`);
    assert.match(id2, CORRELATION_ID_SHAPE, `correlation_id must match coord-<base36-ts>-<4-hex>, got "${id2}"`);
    assert.notEqual(id1, id2,
      'two independent failures must mint two DIFFERENT correlation_ids -- a hardcoded placeholder ' +
      '(the exact F-be3a3bf5 mutation) would make every failure report the identical id, defeating ' +
      'the entire point of correlating distinct incidents');
  });

  it('dispatch.js emits a genuine, freshly-minted correlation_id at isolate_failed when --isolate worktree creation really throws (F-be3a3bf5)', () => {
    const db = openDb(dbPath);
    setupRun(db, 'r-corr-isolate-1', join(tmp, 'does-not-exist-1'));
    setupRun(db, 'r-corr-isolate-2', join(tmp, 'does-not-exist-2'));

    const emitOne = (runId) => {
      const { thrown, lines } = captureStderr(() =>
        dispatch({ runId, phase: 'health-audit-a', dbPath, outputDir: tmp, isolate: true }));
      assert.ok(thrown, `dispatch must throw for ${runId} -- local_path does not exist`);
      const event = findNdjsonEvent(lines, 'isolate_failed');
      assert.ok(event, `expected a real isolate_failed NDJSON event for ${runId}; got:\n${lines.join('\n')}`);
      return event.correlation_id;
    };

    const id1 = emitOne('r-corr-isolate-1');
    const id2 = emitOne('r-corr-isolate-2');

    assert.match(id1, CORRELATION_ID_SHAPE, `correlation_id must match coord-<base36-ts>-<4-hex>, got "${id1}"`);
    assert.match(id2, CORRELATION_ID_SHAPE, `correlation_id must match coord-<base36-ts>-<4-hex>, got "${id2}"`);
    assert.notEqual(id1, id2,
      'two independent failures must mint two DIFFERENT correlation_ids, not a hardcoded placeholder shared across every failure');
  });

  it('the shared mintCorrelationId helper produces coord-<base36-ts>-<hex4> ids, and the coordination commands import it (not inline copies)', () => {
    // F-W1-TEST-008 / PH-DS-02: mintCorrelationId was extracted into the
    // single shared leaf lib/correlation-id.js (it had drifted — rewind/redrive
    // used Math.random, the others randomBytes). The shape contract now lives
    // in the ONE helper; assert it there, and assert every coordination command
    // imports it rather than re-defining a (re-driftable) inline copy.
    const helperSrc = readFileSync(join(__dirname, 'lib/correlation-id.js'), 'utf-8');
    const mintMatch = helperSrc.match(
      /function mintCorrelationId\s*\(\)\s*\{([\s\S]*?)return\s+`coord-\$\{([^}]+)\}-\$\{([^}]+)\}`/
    );
    assert.ok(mintMatch, 'lib/correlation-id.js: mintCorrelationId helper not found in expected shape');
    const body = mintMatch[1];
    assert.match(body, /Date\.now\(\)\.toString\(36\)/,
      'timestamp must be Date.now().toString(36)');
    assert.match(body, /randomBytes\(2\)\.toString\('hex'\)/,
      "random suffix must be randomBytes(2).toString('hex') (4 hex chars)");

    // No coordination command may re-define mintCorrelationId inline; each must
    // import the shared helper (guards against the drift PH-DS-02 just removed).
    for (const rel of ['commands/collect.js', 'commands/dispatch.js', 'commands/resume.js',
      'commands/rewind.js', 'commands/redrive.js']) {
      const src = readFileSync(join(__dirname, rel), 'utf-8');
      assert.doesNotMatch(src, /function mintCorrelationId\s*\(/,
        `${rel}: must not re-define mintCorrelationId inline — import it from ../lib/correlation-id.js`);
      assert.match(src, /import\s*\{[^}]*\bmintCorrelationId\b[^}]*\}\s*from\s*['"]\.\.\/lib\/correlation-id\.js['"]/,
        `${rel}: must import mintCorrelationId from the shared ../lib/correlation-id.js helper`);
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
