import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_SCHEMA_VERSIONS,
  type SupportedSchemaVersion,
  allSchemas,
} from '../src/index.js';

/**
 * F1-CONTRACTS-001 (Wave 2, HIGH) — schema_version VALUE gate, contract side.
 *
 * Pre-fix every contract schema declared `schema_version` as a pattern-only
 * string (`^\d+\.\d+\.\d+$`) with NO value gate, and `verify/index.js` hard-
 * coded the literal `'1.0.0'` with no lookup. There was no single source of
 * truth a consumer could import to decide whether a declared `schema_version`
 * is one this build actually supports.
 *
 * SUPPORTED_SCHEMA_VERSIONS is that source of truth: per registered contract,
 * the `current` version plus the accepted MAJOR range. The verify package
 * imports THIS value (not a hand-copied literal) to drive its gate.
 */

const CONTRACT_KEYS = [
  'record',
  'recordSubmission',
  'finding',
  'pattern',
  'recommendation',
  'doctrine',
  'agentOutput',
] as const;

describe('SUPPORTED_SCHEMA_VERSIONS — the single source of truth for schema_version', () => {
  it('exports an entry for every registered contract + the agent-output envelope', () => {
    for (const key of CONTRACT_KEYS) {
      expect(
        SUPPORTED_SCHEMA_VERSIONS[key],
        `missing SUPPORTED_SCHEMA_VERSIONS entry for "${key}"`,
      ).toBeDefined();
    }
  });

  it('every entry has a semver current + integer minMajor/maxMajor range', () => {
    const semver = /^\d+\.\d+\.\d+$/;
    for (const [key, entry] of Object.entries(SUPPORTED_SCHEMA_VERSIONS)) {
      const e = entry as SupportedSchemaVersion;
      expect(e.current, `${key}.current not semver`).toMatch(semver);
      expect(Number.isInteger(e.minMajor), `${key}.minMajor not integer`).toBe(true);
      expect(Number.isInteger(e.maxMajor), `${key}.maxMajor not integer`).toBe(true);
      expect(e.minMajor, `${key}.minMajor must be >= 1`).toBeGreaterThanOrEqual(1);
      expect(e.maxMajor, `${key}.maxMajor must be >= minMajor`).toBeGreaterThanOrEqual(e.minMajor);
    }
  });

  it('current major sits inside [minMajor, maxMajor] for every contract', () => {
    for (const [key, entry] of Object.entries(SUPPORTED_SCHEMA_VERSIONS)) {
      const e = entry as SupportedSchemaVersion;
      const currentMajor = Number(e.current.split('.')[0]);
      expect(currentMajor, `${key} current major below minMajor`).toBeGreaterThanOrEqual(e.minMajor);
      expect(currentMajor, `${key} current major above maxMajor`).toBeLessThanOrEqual(e.maxMajor);
    }
  });

  it('reconciles to ONE source: every JSON contract key with a schema_version is registered', () => {
    // Map the allSchemas keys that carry a `schema_version` field to the
    // SUPPORTED_SCHEMA_VERSIONS keys. recordSubmission shares the record
    // schema family; policy/scenario do not carry a schema_version contract
    // field and are intentionally absent.
    const contractCarriers: Array<keyof typeof allSchemas> = [
      'record',
      'recordSubmission',
      'finding',
      'pattern',
      'recommendation',
      'doctrine',
    ];
    for (const name of contractCarriers) {
      const schema = allSchemas[name];
      const required = (schema.required ?? []) as string[];
      expect(required, `${name} schema should require schema_version`).toContain('schema_version');
      expect(
        SUPPORTED_SCHEMA_VERSIONS[name],
        `contract "${name}" carries schema_version but is not registered in SUPPORTED_SCHEMA_VERSIONS`,
      ).toBeDefined();
    }
  });
});
