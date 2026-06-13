/**
 * stageA-agent-output-lockstep.test.ts — seals the cross-file lockstep
 * invariant between the canonical agent-output schema (this package) and the
 * JS validators in @dogfood-lab/dogfood-swarm/lib/output-schema.js.
 *
 * d1-schemas-002 — both files DECLARE they are "kept in lockstep"
 * (agent-output.schema.json description; output-schema.js:24-26) and the lists
 * ARE currently identical, but until this test NO seal pinned one source
 * against the other:
 *
 *   - dispatch-prompt-schema.test.js reads the schema enum and asserts it
 *     appears in the dispatched prompt — it floats WITH the schema, so it
 *     cannot catch schema-vs-JS divergence.
 *   - wave28-cross-fix.test.js asserts AUDIT_CATEGORIES *contains* specific
 *     historical strings — membership, not full-set equality vs the schema.
 *
 * So a future edit that extends AUDIT_CATEGORIES in output-schema.js (or the
 * schema enum) without touching the other ships green and silently breaks the
 * stated lockstep. This test is the mechanical seal: sorted-set deepEqual on
 * all three pairs (category, severity, feature-category). Mirrors the C1
 * cache-seal discipline.
 *
 * Loading note: agent-output.schema.json is a swarm-internal schema (NOT one
 * of the 8 contract schemas in allSchemas), so it is loaded via the package's
 * own ./json/* subpath export the same way dispatch-prompt-schema.test.js
 * loads CANONICAL_SCHEMA. The JS half is imported through the workspace
 * subpath export (never a relative ../ path).
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  AUDIT_CATEGORIES,
  FEATURE_CATEGORIES,
  SEVERITY_ENUM,
} from '@dogfood-lab/dogfood-swarm/lib/output-schema.js';

const require = createRequire(import.meta.url);
const CANONICAL_SCHEMA = require('@dogfood-lab/schemas/json/agent-output.schema.json') as {
  $defs: {
    finding: {
      properties: {
        category: { enum: string[] };
        severity: { enum: string[] };
      };
    };
    feature: {
      properties: {
        category: { enum: string[] };
      };
    };
  };
};

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('agent-output schema ⇄ output-schema.js lockstep', () => {
  it('finding.category enum === AUDIT_CATEGORIES (full set)', () => {
    const schemaCats = CANONICAL_SCHEMA.$defs.finding.properties.category.enum;
    expect(sorted(schemaCats)).toEqual(sorted(AUDIT_CATEGORIES));
  });

  it('finding.severity enum === SEVERITY_ENUM (full set)', () => {
    const schemaSev = CANONICAL_SCHEMA.$defs.finding.properties.severity.enum;
    expect(sorted(schemaSev)).toEqual(sorted(SEVERITY_ENUM));
  });

  it('feature.category enum === FEATURE_CATEGORIES (full set)', () => {
    const schemaFeatCats = CANONICAL_SCHEMA.$defs.feature.properties.category.enum;
    expect(sorted(schemaFeatCats)).toEqual(sorted(FEATURE_CATEGORIES));
  });

  it('no duplicate entries in any enum (the schema is the published surface)', () => {
    const schemaCats = CANONICAL_SCHEMA.$defs.finding.properties.category.enum;
    const schemaSev = CANONICAL_SCHEMA.$defs.finding.properties.severity.enum;
    const schemaFeatCats = CANONICAL_SCHEMA.$defs.feature.properties.category.enum;
    expect(new Set(schemaCats).size).toBe(schemaCats.length);
    expect(new Set(schemaSev).size).toBe(schemaSev.length);
    expect(new Set(schemaFeatCats).size).toBe(schemaFeatCats.length);
  });
});
