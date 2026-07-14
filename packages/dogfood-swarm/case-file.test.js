/**
 * case-file.test.js — the jury case-file contract: schema, neutrality lint, handoff.
 *
 * The case-file (docs/case-file-contract.md) is the neutral briefing a
 * planner-tier clerk assembles to PREPARE an external family-different jury
 * before it verifies an artifact — the mechanism that lets "Fable prepares" not
 * collapse into "Fable sways". These tests pin the three guarantees that make
 * that safe:
 *
 *   1. SHAPE — the schema accepts a well-formed briefing and rejects a malformed
 *      one (missing objective, an untagged/unsourced context claim).
 *   2. NEUTRALITY — the lint catches a verdict-leak, a reasoning-leak, and an
 *      ungrounded pack, and is HIGH-PRECISION: legitimate falsifiable checks
 *      ("returns a valid token", "the test passes", "rejects invalid input") do
 *      NOT false-positive. A false positive would block a legitimate criterion,
 *      so this precision pin is the honest-boundary guarantee in test form.
 *   3. FAIL-CLOSED — the handoff refuses (throws) any case-file that fails the
 *      lint, so a biasing briefing never reaches the jury, and the neutral
 *      request it builds carries the abstention rubric that makes
 *      `insufficient_context` a first-class per-criterion answer.
 *
 * Fixtures are REAL files under fixtures/case-files/{valid,invalid,lint}/ (hard
 * rule #6 — exercise the real code path against real data), one per lint pass
 * and severity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateCaseFileSchema } from './lib/case-file/schema.js';
import {
  lintCaseFile,
  VERDICT_LEAK_PATTERNS,
  REASONING_LEAK_PATTERNS,
  MIN_EXTRACTION_RATIO,
} from './lib/case-file/lint.js';
import {
  toJuryRequest,
  assertCaseFileClean,
  CaseFileNeutralityError,
  ABSTENTION_RUBRIC,
} from './lib/case-file/handoff.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'case-files');

function loadFixture(rel) {
  return JSON.parse(readFileSync(join(FIXTURES, rel), 'utf-8'));
}

// codes present in a lint result, for concise assertions
const codesOf = result => result.findings.map(f => f.code);

describe('case-file schema (structural gate)', () => {
  it('accepts a well-formed case-file', () => {
    const { valid, errors } = validateCaseFileSchema(loadFixture('valid/well-formed-auth-fix.json'));
    assert.equal(valid, true, `expected valid, got errors: ${JSON.stringify(errors)}`);
    assert.equal(errors.length, 0);
  });

  it('rejects a case-file missing the required objective', () => {
    const { valid, errors } = validateCaseFileSchema(loadFixture('invalid/missing-objective.json'));
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.keyword === 'required' && /objective/.test(JSON.stringify(e.params))),
      `expected a required-objective error, got: ${JSON.stringify(errors)}`,
    );
  });

  it('rejects a context claim with no provenance source (the un-tagged claim)', () => {
    const { valid, errors } = validateCaseFileSchema(loadFixture('invalid/untagged-context.json'));
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.keyword === 'required' && /source/.test(JSON.stringify(e.params))),
      `expected a required-source error on the context item, got: ${JSON.stringify(errors)}`,
    );
  });

  it('forbids an unexpected top-level field (additionalProperties:false — no smuggled verdict)', () => {
    const withVerdict = { ...loadFixture('valid/well-formed-auth-fix.json'), verdict: 'accept' };
    const { valid, errors } = validateCaseFileSchema(withVerdict);
    assert.equal(valid, false);
    assert.ok(
      errors.some(e => e.keyword === 'additionalProperties'),
      `expected additionalProperties rejection of the smuggled verdict field, got: ${JSON.stringify(errors)}`,
    );
  });
});

describe('case-file neutrality lint', () => {
  it('passes a clean, grounded, verdict-free case-file with zero findings', () => {
    const result = lintCaseFile(loadFixture('valid/well-formed-auth-fix.json'));
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0, `unexpected findings: ${JSON.stringify(result.findings)}`);
  });

  it('flags a verdict-leak in an acceptance criterion (the clerk grading, not specifying)', () => {
    const result = lintCaseFile(loadFixture('lint/verdict-leak-in-criterion.json'));
    assert.equal(result.ok, false);
    const leak = result.findings.find(f => f.code === 'case-file-verdict-leak');
    assert.ok(leak, `expected a verdict-leak finding, got: ${JSON.stringify(result.findings)}`);
    assert.equal(leak.severity, 'error');
    assert.equal(leak.ruleId, 'correctness-adverb');
    assert.match(leak.field, /acceptance_criteria\/0\/check/);
  });

  it('flags a producer reasoning-trace leaked into the artifact content (Lock-2 boundary)', () => {
    const result = lintCaseFile(loadFixture('lint/reasoning-leak-in-content.json'));
    assert.equal(result.ok, false);
    const leak = result.findings.find(f => f.code === 'case-file-reasoning-leak');
    assert.ok(leak, `expected a reasoning-leak finding, got: ${JSON.stringify(result.findings)}`);
    assert.equal(leak.severity, 'error');
    assert.equal(leak.field, '/artifact_under_test/content');
  });

  it('errors when the entire context pack is fable-inference (ungrounded rubric)', () => {
    const result = lintCaseFile(loadFixture('lint/ungrounded-all-inference.json'));
    assert.equal(result.ok, false);
    const grounding = result.findings.find(f => f.code === 'case-file-grounding');
    assert.ok(grounding, `expected a grounding finding, got: ${JSON.stringify(result.findings)}`);
    assert.equal(grounding.severity, 'error');
  });

  it('warns (does not block) on a thinly-grounded pack below the extraction floor', () => {
    const result = lintCaseFile(loadFixture('lint/thin-grounding.json'));
    assert.equal(result.ok, true, 'a warning must not block — ok stays true');
    const grounding = result.findings.find(f => f.code === 'case-file-grounding');
    assert.ok(grounding);
    assert.equal(grounding.severity, 'warning');
  });

  it('batch-reports every fault (never stops at the first — the policy-lint discipline)', () => {
    // One case-file that trips schema (bad criterion id), verdict-leak, AND all-
    // inference grounding at once. All three classes must appear in one pass.
    const multi = {
      objective: 'The handler swallows a duplicate event without error.',
      artifact_under_test: { kind: 'diff', ref: 'src/handler.js@0001' },
      acceptance_criteria: [
        { id: 'bad id with spaces', check: 'a duplicate event is correctly ignored', source: 'fable-inference' },
      ],
      context: [{ claim: 'events probably carry a dedupe key', source: 'fable-inference' }],
    };
    const result = lintCaseFile(multi);
    assert.equal(result.ok, false);
    const codes = new Set(codesOf(result));
    assert.ok(codes.has('case-file-schema'), 'expected the bad AC id to trip the schema pass');
    assert.ok(codes.has('case-file-verdict-leak'), 'expected the "correctly" verdict-leak');
    assert.ok(codes.has('case-file-grounding'), 'expected the all-inference grounding error');
  });
});

describe('verdict-leak precision (the honest boundary — no false positives)', () => {
  // A false positive blocks a legitimate criterion, so the gate is deliberately
  // high-precision. These clean, falsifiable checks must NOT trip any pattern.
  const CLEAN_CHECKS = [
    'returns a valid token for a fresh login',
    'the test suite passes on Node 22 and 24',
    'rejects invalid input with a 400',
    'returns the right value for a present key',
    'the fix works for an empty batch',
    'exits 0 on a clean run and 1 on a finding',
  ];

  for (const phrase of CLEAN_CHECKS) {
    it(`does not flag a legitimate check: "${phrase}"`, () => {
      const hit = VERDICT_LEAK_PATTERNS.find(p => p.regex.test(phrase));
      assert.equal(hit, undefined, `pattern "${hit?.id}" false-positived on a legitimate check`);
    });
  }

  it('DOES flag the conclusion-shaped phrases it is meant to catch', () => {
    const DIRTY = ['correctly returns 401', 'the bug is a null deref', 'this looks good', 'it works as expected'];
    for (const phrase of DIRTY) {
      assert.ok(
        VERDICT_LEAK_PATTERNS.some(p => p.regex.test(phrase)),
        `expected a verdict-leak match on "${phrase}"`,
      );
    }
  });

  it('exports non-empty pattern sets and a sane extraction floor', () => {
    assert.ok(VERDICT_LEAK_PATTERNS.length > 0);
    assert.ok(REASONING_LEAK_PATTERNS.length > 0);
    for (const p of [...VERDICT_LEAK_PATTERNS, ...REASONING_LEAK_PATTERNS]) {
      assert.equal(typeof p.id, 'string');
      assert.ok(p.regex instanceof RegExp);
    }
    assert.ok(MIN_EXTRACTION_RATIO > 0 && MIN_EXTRACTION_RATIO < 1);
  });
});

describe('case-file handoff (fail-closed transform → neutral jury request)', () => {
  it('builds a neutral jury request from a clean case-file', () => {
    const req = toJuryRequest(loadFixture('valid/well-formed-auth-fix.json'));

    assert.equal(req.artifact.kind, 'diff');
    assert.equal(req.artifact.ref, 'packages/auth/refresh.js@a1b2c3d');
    assert.equal(req.rubric.objective, loadFixture('valid/well-formed-auth-fix.json').objective);
    assert.equal(req.rubric.acceptance_criteria.length, 2);
    assert.deepEqual(Object.keys(req.rubric.acceptance_criteria[0]).sort(), ['check', 'id']);
    assert.equal(req.evidence.length, 3);
    assert.equal(req.evidence[0].source, 'from-code', 'evidence keeps provenance for jury weighting');
    assert.equal(req.neutrality.verdict_free, true);
    assert.equal(req.neutrality.reasoning_stripped, true);
    assert.equal(req.neutrality.gated_by, 'case-file-lint');
  });

  it('the jury-facing rubric strips criterion provenance (judge the check, not its source)', () => {
    const req = toJuryRequest(loadFixture('valid/well-formed-auth-fix.json'));
    for (const c of req.rubric.acceptance_criteria) {
      assert.equal(c.source, undefined, 'criterion source must not reach the jury (avoids biasing the verdict)');
    }
  });

  it('attaches an abstention rubric that names insufficient_context as a valid answer', () => {
    const req = toJuryRequest(loadFixture('valid/well-formed-auth-fix.json'));
    assert.equal(req.abstention, ABSTENTION_RUBRIC);
    assert.match(req.abstention, /insufficient_context/);
    assert.match(req.abstention, /floor, not a ceiling/);
  });

  it('carries a warning count through on a lint-clean-but-warned case-file (thin grounding)', () => {
    // thin-grounding lints OK (warning only) — the handoff proceeds and surfaces
    // the warning count rather than blocking.
    const req = toJuryRequest(loadFixture('lint/thin-grounding.json'));
    assert.equal(req.neutrality.warnings, 1);
  });

  it('REFUSES a verdict-leaking case-file (fail-closed — never reaches the jury)', () => {
    assert.throws(
      () => toJuryRequest(loadFixture('lint/verdict-leak-in-criterion.json')),
      err => {
        assert.ok(err instanceof CaseFileNeutralityError);
        assert.equal(err.code, 'CASE_FILE_NEUTRALITY_VIOLATION');
        assert.ok(err.findings.length >= 1);
        assert.ok(err.findings.every(f => f.severity === 'error'));
        return true;
      },
    );
  });

  it('REFUSES a reasoning-leaking case-file', () => {
    assert.throws(
      () => toJuryRequest(loadFixture('lint/reasoning-leak-in-content.json')),
      CaseFileNeutralityError,
    );
  });

  it('assertCaseFileClean returns warning-only findings on an ok case-file, throws on an error one', () => {
    const warnings = assertCaseFileClean(loadFixture('lint/thin-grounding.json'));
    assert.ok(Array.isArray(warnings));
    assert.ok(warnings.every(f => f.severity === 'warning'));

    assert.throws(
      () => assertCaseFileClean(loadFixture('lint/ungrounded-all-inference.json')),
      CaseFileNeutralityError,
    );
  });
});
