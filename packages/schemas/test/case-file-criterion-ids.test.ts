/**
 * case-file-criterion-ids.test.ts — non-vacuity pin for the additive,
 * optional `context[].criterion_ids` field on case-file.schema.json.
 *
 * context[] is a case-file's GLOBAL evidence pack: a claim with no
 * criterion_ids grounds every acceptance criterion. On a capped verifier
 * tier (--jury=prism budgets a fixed per-call `intent` size) that means
 * every claim competes for the same budget on every seat×criterion call,
 * most of them irrelevant to the criterion at hand — measured on the real
 * wave-2 case-file, a 15-claim global pack delivered 5 of 15 per criterion
 * (docs/case-file-contract.md, "Scoping evidence: criterion_ids").
 * criterion_ids lets the clerk scope a claim to only the criteria it
 * actually grounds, so a per-criterion call carries its own relevant claims
 * instead of a globally-truncated pack.
 *
 * case-file.schema.json is a swarm-internal envelope (like
 * agent-output.schema.json) — NOT one of the eight contract-spine schemas
 * registered in allSchemas/validatePayload (verified: `grep -rn case-file
 * packages/verify/` returns zero hits). It is loaded the same way
 * stageA-agent-output-lockstep.test.ts loads agent-output.schema.json: via
 * createRequire off the package's own ./json/* subpath export. Runtime
 * validation reuses createAjv() from ../src/index.js — the in-tree Ajv2020
 * convention (allErrors, strict:false, ajv-formats) — instead of
 * hand-rolling a second Ajv setup, so this file introduces no new textual
 * `new Ajv` call and needs no D2B-015 allowlist entry
 * (scripts/check-validator-cache-singleton.test.mjs already treats every
 * file under packages/schemas/ as the canonical Ajv home).
 *
 * ANTI-VACUITY: context.items has additionalProperties:false, so a
 * bad-type criterion_ids value is rejected whether or not the property is
 * actually *defined* with a type — an undefined property is ALSO rejected,
 * just via the `additionalProperties` keyword instead of `type`. A test
 * that only asserts `valid === false` cannot tell those two rejection
 * reasons apart, and would stay green even if the criterion_ids property
 * block were deleted outright (the same trap
 * case-file-prism-jury-intent-cap.test.js:394-398 names for a counter,
 * applied here to a schema). The two "REJECTS" tests below instead assert
 * an Ajv error with keyword === 'type' whose instancePath names
 * criterion_ids specifically — true only when the property carries a type
 * constraint; false when it is undefined, because then the sole error is
 * `additionalProperties` at the parent path. Verified by hand: deleting the
 * criterion_ids property block from case-file.schema.json and re-running
 * this file turns both REJECTS tests red (additionalProperties fires
 * instead of type); restoring the block turns them green again.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAjv } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/schemas/test → repo root is three levels up.
const repoRoot = resolve(here, '../../..');

const require = createRequire(import.meta.url);
const caseFileSchema = require('@dogfood-lab/schemas/json/case-file.schema.json');

const validate = createAjv().compile(caseFileSchema);

/** Minimal valid case-file skeleton shared by the tests below. */
function makeCaseFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objective: 'The parser handles empty input without throwing.',
    artifact_under_test: { kind: 'file', ref: 'src/parse.js' },
    acceptance_criteria: [
      { id: 'AC-empty', check: 'parse("") returns an empty array' },
      { id: 'AC-other', check: 'parse() ignores a trailing newline' },
    ],
    ...overrides,
  };
}

describe('case-file.schema.json — context[].criterion_ids', () => {
  it('(a) a context entry WITH one criterion_ids value validates', () => {
    const caseFile = makeCaseFile({
      context: [
        { claim: 'parse() is called by the ingest loop', source: 'from-code', criterion_ids: ['AC-empty'] },
      ],
    });
    const valid = validate(caseFile);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('(a) a context entry WITH multiple criterion_ids values validates', () => {
    const caseFile = makeCaseFile({
      context: [
        {
          claim: 'both code paths share the same tokenizer',
          source: 'from-code',
          criterion_ids: ['AC-empty', 'AC-other'],
        },
      ],
    });
    const valid = validate(caseFile);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('(b) REJECTS criterion_ids: [123] — wrong item type, non-vacuously', () => {
    const caseFile = makeCaseFile({
      context: [
        { claim: 'parse() is called by the ingest loop', source: 'from-code', criterion_ids: [123] },
      ],
    });
    const valid = validate(caseFile);
    expect(valid).toBe(false);

    // Non-vacuity proof — see file header. This is FALSE (not merely
    // untested) when the property is undefined, because then Ajv only ever
    // emits `additionalProperties`, never a `type` error naming
    // criterion_ids.
    const typeErrorOnField = (validate.errors ?? []).some(
      err => err.keyword === 'type' && err.instancePath.includes('/criterion_ids'),
    );
    expect(typeErrorOnField, JSON.stringify(validate.errors)).toBe(true);
  });

  it('(b) REJECTS criterion_ids: "AC-1" — not an array, non-vacuously', () => {
    const caseFile = makeCaseFile({
      context: [
        { claim: 'parse() is called by the ingest loop', source: 'from-code', criterion_ids: 'AC-1' },
      ],
    });
    const valid = validate(caseFile);
    expect(valid).toBe(false);

    const typeErrorOnField = (validate.errors ?? []).some(
      err => err.keyword === 'type' && err.instancePath.endsWith('/criterion_ids'),
    );
    expect(typeErrorOnField, JSON.stringify(validate.errors)).toBe(true);
  });

  it('(c) BACKWARD-COMPAT: the real well-formed-auth-fix fixture (no criterion_ids anywhere) still validates untouched', () => {
    const fixturePath = join(repoRoot, 'fixtures/case-files/valid/well-formed-auth-fix.json');
    const fixture: { context?: Array<Record<string, unknown>> } = JSON.parse(
      readFileSync(fixturePath, 'utf8'),
    );

    // Sanity: this proof only demonstrates the absent-field path if the
    // fixture genuinely has none — guards against a future fixture edit
    // silently invalidating what this test claims to cover.
    const contextEntries = Array.isArray(fixture.context) ? fixture.context : [];
    expect(contextEntries.length, 'fixture sanity: expected a non-empty context pack').toBeGreaterThan(0);
    for (const entry of contextEntries) {
      expect('criterion_ids' in entry, 'fixture sanity: expected no criterion_ids on this fixture').toBe(false);
    }

    const valid = validate(fixture);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('(c) BACKWARD-COMPAT: a context entry with criterion_ids omitted entirely still validates (absent === global)', () => {
    const caseFile = makeCaseFile({
      context: [{ claim: 'parse() is called by the ingest loop', source: 'from-code' }],
    });
    const valid = validate(caseFile);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});
