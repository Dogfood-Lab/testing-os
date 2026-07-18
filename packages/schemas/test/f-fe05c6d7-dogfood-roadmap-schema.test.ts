/**
 * f-fe05c6d7-dogfood-roadmap-schema.test.ts — Ajv-validation harness for the
 * new T1 trajectory-layer artifact contract, dogfood-roadmap.schema.json.
 *
 * F-fe05c6d7 (wave 39, Feature Pass T1): dogfood-roadmap.schema.json is a
 * swarm-internal envelope — like agent-output.schema.json and
 * case-file.schema.json before it — NOT one of the eight contract-spine
 * schemas registered in allSchemas/validatePayload (verified below, not just
 * asserted in prose). It is loaded the same way
 * stageA-agent-output-lockstep.test.ts and case-file-criterion-ids.test.ts
 * load their respective envelopes: via createRequire off the package's own
 * ./json/* subpath export, compiled with createAjv() from ../src/index.js —
 * the in-tree Ajv2020 convention (allErrors, strict:false, ajv-formats) — so
 * this file introduces no new `new Ajv` call and needs no D2B-015 allowlist
 * entry (scripts/check-validator-cache-singleton.test.mjs already treats
 * every file under packages/schemas/ as the canonical Ajv home).
 *
 * ANTI-VACUITY discipline (mirrors case-file-criterion-ids.test.ts and
 * h4-reject-reason-conditional.test.ts): every REJECTS assertion below pins
 * the specific Ajv keyword (and, where it disambiguates a real regression,
 * the instancePath or missingProperty) that must fire — not merely
 * `valid === false`. A bare boolean check on a REQUIRED-key omission would
 * still catch a dropped `required` entry (the key stops being enforced), but
 * the const/conditional/maxItems tests below each pin the ONE keyword whose
 * removal would otherwise let the fixture through silently.
 *
 * WAVE-43 / AMENDMENT 3 (A3.2, F-471a06f1 + F-b785b581): T6's single
 * $defs/drainEntry — never satisfied by any real producer — is retired and
 * split into two per-population shapes matching each population's real
 * authored data: $defs/drainQueueEntry (drain_queue, now an object
 * {entries[],overdue_ids[]}, runs-ordinal, mirrors
 * lib/roadmap/drain.js#compileAuthoredDrainState's shipped return) and
 * $defs/grandfatheredManifestEntry (grandfathered_drain.outstanding[],
 * date-deadline, mirrors scripts/grandfathered-pins.json's real
 * {owner,revalidate_by}-only per-entry shape). expired_notes joins the
 * required (empty-allowed) sections, sharing the new $defs/operatorNote with
 * operator_notes (T3's loud-expiry rule, F-74ba2c79). See the schema file's
 * own top-level $comment for the full seam-decision writeup this wave. The
 * "representative fixtures" describe block below loads repo-root fixtures
 * under fixtures/roadmaps/ — OUT OF this package's domain (backend owns
 * packages/schemas/** only) — so 5 of those assertions were EXPECTED red
 * for the wave-43 staleness window, until the coordinator's fixture reland
 * (commit eadd83f) closed it; they are permanent regression pins, green
 * since. See the comment directly above that describe block for the exact
 * list and why each one stayed trustworthy as a pin through the window.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAjv, allSchemas } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/schemas/test → repo root is three levels up.
const repoRoot = resolve(here, '../../..');

const require = createRequire(import.meta.url);
const roadmapSchema = require('@dogfood-lab/schemas/json/dogfood-roadmap.schema.json') as {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  required: string[];
  properties: Record<string, { description?: string }>;
  $defs: { drainQueueEntry: object; grandfatheredManifestEntry: object; operatorNote: object; latestPointer: object };
};

const validate = createAjv().compile(roadmapSchema);

function loadFixture(rel: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, 'fixtures/roadmaps', rel), 'utf8'));
}

/** Minimal valid roadmap skeleton — every required section present, empty/zeroed. */
function makeRoadmap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'swarm-test-0000000000-0001',
    sequence: 1,
    compiled_at: '2026-07-17T00:00:00Z',
    repo: 'dogfood-lab/testing-os',
    compiled_from: { commit_sha: '0'.repeat(40) },
    open_summary: { open: 0, deferred: 0, approved: 0 },
    grandfathered_drain: { frozen_total: 0, drained: 0, outstanding: [] },
    recurrence_stats: {},
    attention: { advisory: true, items: [] },
    operator_notes: [],
    // WAVE-43 / AMENDMENT 3 (A3.4): required, empty-allowed sibling of
    // operator_notes — see the schema's own expired_notes description.
    expired_notes: [],
    // WAVE-43 / AMENDMENT 3 (A3.2a): drain_queue is now an object
    // {entries[],overdue_ids[]}, not a bare array — see $defs/drainQueueEntry.
    drain_queue: { entries: [], overdue_ids: [] },
    ...overrides,
  };
}

describe('dogfood-roadmap.schema.json — envelope hygiene', () => {
  it('declares JSON Schema 2020-12', () => {
    expect(roadmapSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('carries the canonical monorepo $id', () => {
    expect(roadmapSchema.$id).toBe(
      'https://github.com/dogfood-lab/testing-os/packages/schemas/src/json/dogfood-roadmap.schema.json',
    );
  });

  it('has a title and description', () => {
    expect(roadmapSchema.title).toBeTruthy();
    expect(roadmapSchema.description).toBeTruthy();
  });

  it('is NOT registered in allSchemas (swarm-internal envelope, mirrors agent-output/case-file)', () => {
    expect(Object.values(allSchemas)).not.toContain(roadmapSchema);
    expect(Object.keys(allSchemas)).toHaveLength(8);
  });

  it('every top-level property carries a description', () => {
    for (const [name, def] of Object.entries(roadmapSchema.properties)) {
      expect(def.description, `${name} missing description`).toBeTruthy();
    }
  });
});

describe('dogfood-roadmap.schema.json — minimal valid roadmap', () => {
  it('accepts the minimal skeleton (every array/object empty or zeroed)', () => {
    const roadmap = makeRoadmap();
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — T2 attention.advisory (non-optional sibling)', () => {
  it('accepts attention with advisory:true and items', () => {
    const roadmap = makeRoadmap({
      attention: {
        advisory: true,
        items: [{ file: 'a.js', score: 0.5, components: { churn: 0.1, recency: 0.2, fragmentation: 0.3 } }],
      },
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS attention missing the advisory sibling, non-vacuously', () => {
    const roadmap = makeRoadmap({ attention: { items: [] } });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const missingAdvisory = (validate.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'advisory',
    );
    expect(missingAdvisory, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS attention with advisory:false, non-vacuously (const violation, not merely a missing key)', () => {
    const roadmap = makeRoadmap({ attention: { advisory: false, items: [] } });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const constViolation = (validate.errors ?? []).some(
      err => err.keyword === 'const' && err.instancePath.endsWith('/attention/advisory'),
    );
    expect(constViolation, JSON.stringify(validate.errors)).toBe(true);
  });

  // WAVE-43 / AMENDMENT 3 (A3.2) FIXTURE-STALENESS NOTE (historical), stated
  // once here and pointed back to at every other repo-root-fixture
  // `valid===true` assertion below: fixtures/roadmaps/** is OUT OF this
  // package's domain (backend owns packages/schemas/** only — .claude/rules
  // and the wave-43 brief both name fixtures/ as ownership-gated, wave-41
  // precedent), so the amendment could not update the fixture files directly.
  // The 5 assertions below that call `validate(fixture)` and expect `true` on
  // valid/well-formed-run.json or valid/minimal-empty-sections.json were
  // EXPECTED RED for that window (both fixtures still carried the
  // pre-amendment bare-array drain_queue and lacked expired_notes) until the
  // coordinator's fixture reland (commit eadd83f, wave-43 merge
  // reconciliation) closed it; they are permanent regression pins, green
  // since. Every OTHER fixture-based assertion in this file stayed green
  // through that window, either because it asserts generic `valid===false`
  // (a stale fixture was invalid for an additional, unrelated reason on top
  // of its intended one) or because its keyword-specific check targets an
  // Ajv error unrelated to drain_queue — Ajv's allErrors:true still reported
  // that specific error alongside the unrelated ones. These are real
  // regression pins, not vacuous ones: each was proven red-then-green against
  // inline (non-fixture) fixtures in the describe blocks above and below, and
  // now additionally covers the real committed data.
  it('the real well-formed-run fixture carries advisory:true', () => {
    const fixture = loadFixture('valid/well-formed-run.json') as { attention: { advisory: boolean } };
    expect(fixture.attention.advisory).toBe(true);
    const valid = validate(fixture);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — T3 operator_notes (bounded, invariant conditional)', () => {
  it('accepts a kind=invariant note WITH enforced_by', () => {
    const roadmap = makeRoadmap({
      operator_notes: [{ kind: 'invariant', text: 'x', expires: 1, enforced_by: 'scripts/gate.mjs' }],
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS a kind=invariant note WITHOUT enforced_by, non-vacuously', () => {
    const roadmap = makeRoadmap({ operator_notes: [{ kind: 'invariant', text: 'x', expires: 1 }] });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const missingEnforcedBy = (validate.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'enforced_by',
    );
    expect(missingEnforcedBy, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a kind=theme note WITHOUT enforced_by (conditional is invariant-only)', () => {
    const roadmap = makeRoadmap({ operator_notes: [{ kind: 'theme', text: 'x', expires: '2027-01-01' }] });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a kind=open-question note WITHOUT enforced_by', () => {
    const roadmap = makeRoadmap({ operator_notes: [{ kind: 'open-question', text: 'x', expires: 3 }] });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts expires as an integer run-horizon OR an ISO date string', () => {
    const withInt = makeRoadmap({ operator_notes: [{ kind: 'theme', text: 'x', expires: 4 }] });
    expect(validate(withInt), JSON.stringify(validate.errors)).toBe(true);

    const withDate = makeRoadmap({ operator_notes: [{ kind: 'theme', text: 'x', expires: '2027-06-01' }] });
    expect(validate(withDate), JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS an 8th operator note, non-vacuously (maxItems:7)', () => {
    const roadmap = makeRoadmap({
      operator_notes: Array.from({ length: 8 }, (_, i) => ({ kind: 'theme', text: `n${i}`, expires: 1 })),
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const maxItemsViolation = (validate.errors ?? []).some(
      err => err.keyword === 'maxItems' && err.instancePath.endsWith('/operator_notes'),
    );
    expect(maxItemsViolation, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — expired_notes (WAVE-43/Amendment 3 A3.4, required empty-allowed, shares $defs/operatorNote)', () => {
  it('is in the schema\'s required list', () => {
    expect(roadmapSchema.required).toContain('expired_notes');
  });

  it('accepts an empty expired_notes array (required, but empty is valid)', () => {
    const roadmap = makeRoadmap({ expired_notes: [] });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS a roadmap with expired_notes entirely omitted, non-vacuously (required keyword)', () => {
    const roadmap = makeRoadmap();
    delete (roadmap as { expired_notes?: unknown }).expired_notes;
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const missingExpiredNotes = (validate.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'expired_notes',
    );
    expect(missingExpiredNotes, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a well-formed theme note in expired_notes', () => {
    const roadmap = makeRoadmap({
      expired_notes: [{ kind: 'theme', text: 'Wave-38 docs audit note, since expired.', expires: '2020-01-01' }],
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('shares $defs/operatorNote\'s invariant-requires-enforced_by conditional: REJECTS an expired invariant note WITHOUT enforced_by', () => {
    const roadmap = makeRoadmap({
      expired_notes: [{ kind: 'invariant', text: 'x', expires: '2020-01-01' }],
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const missingEnforcedBy = (validate.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'enforced_by',
    );
    expect(missingEnforcedBy, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts an expired invariant note WITH enforced_by', () => {
    const roadmap = makeRoadmap({
      expired_notes: [{ kind: 'invariant', text: 'x', expires: '2020-01-01', enforced_by: 'scripts/gate.mjs' }],
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('has NO maxItems cap, unlike operator_notes (deliberate — see the schema\'s own description)', () => {
    const roadmap = makeRoadmap({
      expired_notes: Array.from({ length: 9 }, (_, i) => ({ kind: 'theme', text: `n${i}`, expires: '2020-01-01' })),
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('operator_notes and expired_notes resolve to the SAME $defs/operatorNote (one shape, two lifecycle buckets)', () => {
    expect((roadmapSchema.properties.operator_notes as { items?: { $ref?: string } }).items?.$ref).toBe(
      '#/$defs/operatorNote',
    );
    expect((roadmapSchema.properties.expired_notes as { items?: { $ref?: string } }).items?.$ref).toBe(
      '#/$defs/operatorNote',
    );
  });
});

describe('dogfood-roadmap.schema.json — drain_queue is an object {entries[],overdue_ids[]} (WAVE-43/Amendment 3 A3.2a)', () => {
  it('accepts the empty-object skeleton', () => {
    const roadmap = makeRoadmap({ drain_queue: { entries: [], overdue_ids: [] } });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS the pre-amendment bare-array shape, non-vacuously (type keyword)', () => {
    const roadmap = makeRoadmap({ drain_queue: [] });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const wrongType = (validate.errors ?? []).some(
      err => err.keyword === 'type' && err.instancePath.endsWith('/drain_queue'),
    );
    expect(wrongType, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS drain_queue missing overdue_ids, non-vacuously (required keyword)', () => {
    const roadmap = makeRoadmap({ drain_queue: { entries: [] } });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const missingOverdueIds = (validate.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'overdue_ids',
    );
    expect(missingOverdueIds, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts entries[] plus a matching overdue_ids[] subset', () => {
    const roadmap = makeRoadmap({
      drain_queue: {
        entries: [
          { id: 'dstate-001', owner: 'core-lane', cadence_runs: 5, runs_since_review: 6, overdue: true },
          { id: 'dstate-002', owner: 'verbs-lane', cadence_runs: 5, runs_since_review: 2, overdue: false },
        ],
        overdue_ids: ['dstate-001'],
      },
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — $defs/drainQueueEntry (drain_queue.entries[], runs-ordinal, WAVE-43/Amendment 3 A3.2a)', () => {
  it('accepts a well-formed entry, with optional reason', () => {
    const roadmap = makeRoadmap({
      drain_queue: {
        entries: [
          { id: 'dstate-001', owner: 'core-lane', cadence_runs: 5, runs_since_review: 6, overdue: true, reason: 'cross-domain' },
        ],
        overdue_ids: ['dstate-001'],
      },
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a well-formed entry WITHOUT reason (optional, not required)', () => {
    const roadmap = makeRoadmap({
      drain_queue: {
        entries: [{ id: 'dstate-001', owner: 'core-lane', cadence_runs: 5, runs_since_review: 2, overdue: false }],
        overdue_ids: [],
      },
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('RED-PROOF (backend brief\'s required new-shape pin): REJECTS a drain_queue entry missing owner, non-vacuously', () => {
    const roadmap = makeRoadmap({
      drain_queue: {
        entries: [{ id: 'dstate-001', cadence_runs: 5, runs_since_review: 6, overdue: true }],
        overdue_ids: ['dstate-001'],
      },
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const missingOwner = (validate.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'owner',
    );
    expect(missingOwner, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS the pre-amendment $defs/drainEntry fields (added_at, due_at_run), non-vacuously (additionalProperties)', () => {
    const roadmap = makeRoadmap({
      drain_queue: {
        entries: [
          { id: 'dstate-001', owner: 'core-lane', cadence_runs: 5, runs_since_review: 6, overdue: true, added_at: '2026-07-01T00:00:00Z', due_at_run: 6 },
        ],
        overdue_ids: ['dstate-001'],
      },
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const additionalPropsRejected = (validate.errors ?? []).some(err => err.keyword === 'additionalProperties');
    expect(additionalPropsRejected, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS cadence_runs < 1, non-vacuously (minimum keyword — T6 "cadence in runs" cannot be zero or negative)', () => {
    const roadmap = makeRoadmap({
      drain_queue: {
        entries: [{ id: 'dstate-001', owner: 'core-lane', cadence_runs: 0, runs_since_review: 0, overdue: false }],
        overdue_ids: [],
      },
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const minimumViolation = (validate.errors ?? []).some(
      err => err.keyword === 'minimum' && err.instancePath.endsWith('/cadence_runs'),
    );
    expect(minimumViolation, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — $defs/grandfatheredManifestEntry (grandfathered_drain.outstanding[], date-deadline, WAVE-43/Amendment 3 A3.2b)', () => {
  it('accepts a well-formed entry, with optional reason', () => {
    const roadmap = makeRoadmap({
      grandfathered_drain: {
        frozen_total: 1,
        drained: 0,
        outstanding: [{ id: 'F-002109-003', owner: 'coordinator', revalidate_by: '2026-10-14', reason: 'frozen migration debt' }],
      },
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a well-formed entry WITHOUT reason (optional — the real manifest carries no per-entry reason)', () => {
    const roadmap = makeRoadmap({
      grandfathered_drain: {
        frozen_total: 1,
        drained: 0,
        outstanding: [{ id: 'F-002109-003', owner: 'coordinator', revalidate_by: '2026-10-14' }],
      },
    });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('RED-PROOF (backend brief\'s required new-shape pin): REJECTS a grandfathered_drain.outstanding entry missing owner, non-vacuously', () => {
    const roadmap = makeRoadmap({
      grandfathered_drain: {
        frozen_total: 1,
        drained: 0,
        outstanding: [{ id: 'F-002109-003', revalidate_by: '2026-10-14' }],
      },
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const missingOwner = (validate.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'owner',
    );
    expect(missingOwner, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS a missing revalidate_by, non-vacuously (required keyword — this population is date-deadline, not runs-ordinal)', () => {
    const roadmap = makeRoadmap({
      grandfathered_drain: {
        frozen_total: 1,
        drained: 0,
        outstanding: [{ id: 'F-002109-003', owner: 'coordinator' }],
      },
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const missingRevalidateBy = (validate.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'revalidate_by',
    );
    expect(missingRevalidateBy, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS the pre-amendment $defs/drainEntry fields (added_at, cadence_runs, due_at_run), non-vacuously (additionalProperties) — proves this population does NOT share drain_queue\'s runs-ordinal shape', () => {
    const roadmap = makeRoadmap({
      grandfathered_drain: {
        frozen_total: 1,
        drained: 0,
        outstanding: [
          { id: 'F-002109-003', owner: 'coordinator', revalidate_by: '2026-10-14', added_at: '2026-01-01T00:00:00Z', cadence_runs: 5, due_at_run: 6 },
        ],
      },
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const additionalPropsRejected = (validate.errors ?? []).some(err => err.keyword === 'additionalProperties');
    expect(additionalPropsRejected, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS a non-date revalidate_by, non-vacuously (format keyword)', () => {
    const roadmap = makeRoadmap({
      grandfathered_drain: {
        frozen_total: 1,
        drained: 0,
        outstanding: [{ id: 'F-002109-003', owner: 'coordinator', revalidate_by: 'not-a-date' }],
      },
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const formatViolation = (validate.errors ?? []).some(
      err => err.keyword === 'format' && err.instancePath.endsWith('/revalidate_by'),
    );
    expect(formatViolation, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — $defs/drainEntry is fully retired (WAVE-43/Amendment 3 A3.2)', () => {
  it('the schema no longer declares a $defs/drainEntry entry', () => {
    expect(Object.keys(roadmapSchema.$defs)).not.toContain('drainEntry');
  });

  it('declares both successor shapes instead', () => {
    expect(Object.keys(roadmapSchema.$defs)).toEqual(
      expect.arrayContaining(['drainQueueEntry', 'grandfatheredManifestEntry', 'operatorNote', 'latestPointer']),
    );
  });
});

describe('dogfood-roadmap.schema.json — $defs/latestPointer (companion micro-shape for latest.json)', () => {
  const validatePointer = createAjv().compile(roadmapSchema.$defs.latestPointer);

  it('accepts the real latest-pointer fixture', () => {
    const fixture = loadFixture('valid/latest-pointer.json');
    const valid = validatePointer(fixture);
    expect(valid, JSON.stringify(validatePointer.errors)).toBe(true);
  });

  it('REJECTS a pointer missing path, non-vacuously', () => {
    const valid = validatePointer({ run_id: 'swarm-x', sequence: 1 });
    expect(valid).toBe(false);
    const missingPath = (validatePointer.errors ?? []).some(
      err => err.keyword === 'required' && err.params?.missingProperty === 'path',
    );
    expect(missingPath, JSON.stringify(validatePointer.errors)).toBe(true);
  });
});

// WAVE-43 / AMENDMENT 3 (A3.2) fixture-staleness note (historical): see the
// shared comment above the T2 block's "the real well-formed-run fixture
// carries advisory:true" test. The two `valid===true` assertions immediately
// below (well-formed-run.json, minimal-empty-sections.json) were EXPECTED
// RED for the wave-43 window and went green at the coordinator's fixture
// reland (commit eadd83f); every `valid===false` assertion in this block
// stayed green throughout (a stale fixture was invalid for an additional
// reason on top of its intended one).
describe('dogfood-roadmap.schema.json — representative fixtures (fixtures/roadmaps/)', () => {
  it('valid/well-formed-run.json validates', () => {
    const fixture = loadFixture('valid/well-formed-run.json');
    const valid = validate(fixture);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('valid/minimal-empty-sections.json validates', () => {
    const fixture = loadFixture('valid/minimal-empty-sections.json');
    const valid = validate(fixture);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('invalid/missing-advisory-sibling.json fails', () => {
    const fixture = loadFixture('invalid/missing-advisory-sibling.json');
    expect(validate(fixture)).toBe(false);
  });

  it('invalid/invariant-note-missing-enforced-by.json fails', () => {
    const fixture = loadFixture('invalid/invariant-note-missing-enforced-by.json');
    expect(validate(fixture)).toBe(false);
  });

  it('invalid/too-many-operator-notes.json fails', () => {
    const fixture = loadFixture('invalid/too-many-operator-notes.json');
    expect(validate(fixture)).toBe(false);
  });

  it('invalid/drain-entry-missing-owner.json fails', () => {
    const fixture = loadFixture('invalid/drain-entry-missing-owner.json');
    expect(validate(fixture)).toBe(false);
  });

  it('invalid/notes-path-absolute.json fails', () => {
    const fixture = loadFixture('invalid/notes-path-absolute.json');
    expect(validate(fixture)).toBe(false);
  });

  it('invalid/sections-not-allowed.json fails', () => {
    const fixture = loadFixture('invalid/sections-not-allowed.json');
    expect(validate(fixture)).toBe(false);
  });
});

/**
 * WAVE-41 (F-c7b0f47b): the real committed roadmap artifact failed this
 * schema with 16 Ajv errors. Coordinator's binding seam call for this wave —
 * "the schema is the contract; core/verbs conform their emitters to it in
 * their own worktrees" — leaves exactly four places where the CONTRACT
 * itself, not an emitter, needed to change. Each gets its own describe block
 * below, matching this file's existing non-vacuity discipline (pin the
 * specific Ajv keyword, not a bare valid===false). See the schema's own
 * top-level $comment for the full seam-decision writeup.
 */
describe('dogfood-roadmap.schema.json — wave-41 axis (a): `sections` stays unblessed (F-c7b0f47b)', () => {
  it('REJECTS a roadmap carrying a `sections` key, non-vacuously (additionalProperties naming it, not merely valid:false)', () => {
    const roadmap = makeRoadmap({
      sections: {
        run_id: 'x', repo: 'y', generated_at: '2026-01-01T00:00:00Z',
        findings: { open: [], deferred: [], approved: [] },
      },
    });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const sectionsRejected = (validate.errors ?? []).some(
      err => err.keyword === 'additionalProperties' && err.params?.additionalProperty === 'sections',
    );
    expect(sectionsRejected, JSON.stringify(validate.errors)).toBe(true);
  });

  it('invalid/sections-not-allowed.json fails specifically because of `sections`, not some other defect', () => {
    const fixture = loadFixture('invalid/sections-not-allowed.json');
    const valid = validate(fixture);
    expect(valid).toBe(false);
    const sectionsRejected = (validate.errors ?? []).some(
      err => err.keyword === 'additionalProperties' && err.params?.additionalProperty === 'sections',
    );
    expect(sectionsRejected, JSON.stringify(validate.errors)).toBe(true);
  });

  it('a roadmap WITHOUT `sections` (the flat T1-T6 fields alone) validates — proves the rejection above is about `sections` specifically, not about being flat', () => {
    const roadmap = makeRoadmap();
    expect('sections' in roadmap).toBe(false);
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — wave-41 axis (b): notesPath is optional and repo-relative-only (F-c7b0f47b)', () => {
  it('accepts a repo-relative notesPath', () => {
    const roadmap = makeRoadmap({ notesPath: 'dogfood/roadmap-notes.json' });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a roadmap with notesPath entirely omitted (optional, not required)', () => {
    const roadmap = makeRoadmap();
    expect('notesPath' in roadmap).toBe(false);
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS a POSIX-absolute notesPath, non-vacuously (pattern keyword, not merely valid:false)', () => {
    const roadmap = makeRoadmap({ notesPath: '/abs/path/roadmap-notes.json' });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const patternViolation = (validate.errors ?? []).some(
      err => err.keyword === 'pattern' && err.instancePath.endsWith('/notesPath'),
    );
    expect(patternViolation, JSON.stringify(validate.errors)).toBe(true);
  });

  it('REJECTS a Windows-drive-absolute notesPath, non-vacuously (pattern keyword) — the finding\'s own proven exhibit shape', () => {
    const roadmap = makeRoadmap({ notesPath: 'E:\\AI\\testing-os\\dogfood\\roadmap-notes.json' });
    const valid = validate(roadmap);
    expect(valid).toBe(false);
    const patternViolation = (validate.errors ?? []).some(
      err => err.keyword === 'pattern' && err.instancePath.endsWith('/notesPath'),
    );
    expect(patternViolation, JSON.stringify(validate.errors)).toBe(true);
  });

  // WAVE-43 / AMENDMENT 3 (A3.2) fixture-staleness note (historical): see
  // the T2 block's shared comment. The `valid===true` assertion below was
  // EXPECTED RED for the wave-43 window, green since the fixture reland
  // (commit eadd83f); the notesPath VALUE assertion above it was unaffected.
  it('the real well-formed-run fixture carries a repo-relative notesPath', () => {
    const fixture = loadFixture('valid/well-formed-run.json') as { notesPath?: string };
    expect(fixture.notesPath).toBe('dogfood/roadmap-notes.json');
    const valid = validate(fixture);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it('invalid/notes-path-absolute.json fails specifically because notesPath is absolute (pattern, not additionalProperties — the key IS now recognized)', () => {
    const fixture = loadFixture('invalid/notes-path-absolute.json');
    const valid = validate(fixture);
    expect(valid).toBe(false);
    const patternViolation = (validate.errors ?? []).some(
      err => err.keyword === 'pattern' && err.instancePath.endsWith('/notesPath'),
    );
    expect(patternViolation, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — wave-41 axis (c): compiled_at semantics are honest, not wall-clock (F-c7b0f47b)', () => {
  it('compiled_at stays required — this axis is a description-only fix, not a shape change', () => {
    expect(roadmapSchema.required).toContain('compiled_at');
  });

  it('the description no longer claims compiled_at is the compile operation\'s own wall clock', () => {
    const desc = roadmapSchema.properties.compiled_at.description ?? '';
    expect(desc).not.toMatch(/compile operation'?s own clock/i);
  });

  it('the description states the honest DB-derived-determinism semantic, citing F-feeaef78 and runs.created_at', () => {
    const desc = roadmapSchema.properties.compiled_at.description ?? '';
    expect(desc).toMatch(/F-feeaef78/);
    expect(desc).toMatch(/runs\.created_at/);
    expect(desc).toMatch(/byte-identical/i);
  });

  it('a well-formed roadmap still validates with compiled_at present (no structural change, description-only fix)', () => {
    const roadmap = makeRoadmap({ compiled_at: '2026-01-01T00:00:00Z' });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('dogfood-roadmap.schema.json — wave-41 axis (d): content_hash stays optional, self-exclusion semantics specified (F-c7b0f47b)', () => {
  it('content_hash is NOT in required — stays optional, a deliberate choice this wave, not an oversight', () => {
    expect(roadmapSchema.required).not.toContain('content_hash');
  });

  it('the description specifies hash-then-attach (self-exclusion), never hash-including-self', () => {
    const desc = roadmapSchema.properties.content_hash.description ?? '';
    expect(desc).toMatch(/ABSENT/);
    expect(desc).toMatch(/hash-then-attach/i);
  });

  it('accepts a roadmap WITH content_hash present', () => {
    const roadmap = makeRoadmap({ content_hash: 'a3f5c9e1d2b4867012f9e6c8a4d1b3e5f7091a2c4e6b8d0f2a4c6e8b0d2f4a6c' });
    const valid = validate(roadmap);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  // WAVE-43 / AMENDMENT 3 (A3.2) fixture-staleness note (historical): see
  // the T2 block's shared comment. The `valid===true` assertion below was
  // EXPECTED RED for the wave-43 window, green since the fixture reland
  // (commit eadd83f); the content_hash-absence assertion above it was
  // unaffected throughout — content_hash's optionality is untouched by the
  // amendment.
  it('minimal-empty-sections.json omits content_hash entirely and still validates (proves optional, not merely nullable)', () => {
    const fixture = loadFixture('valid/minimal-empty-sections.json') as { content_hash?: string };
    expect('content_hash' in fixture).toBe(false);
    const valid = validate(fixture);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });
});
