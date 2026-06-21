/**
 * stageC-supported-versions-lockstep-seal.test.ts — seals SUPPORTED_SCHEMA_VERSIONS
 * `current` against drift, the same hazard class the package already sealed for
 * cross-contract enums (stageC-cross-contract-enum-seal) and the agent-output
 * envelope (stageA-agent-output-lockstep).
 *
 * schemas-B-001 (Stage C, MEDIUM, future-proofing) — `SUPPORTED_SCHEMA_VERSIONS`
 * (src/schema-versions.ts) is seven hand-typed `current: '1.0.0'` literals.
 * schema-versions.test.ts already proves each `current` is semver-shaped and that
 * its major sits inside [minMajor, maxMajor], but NOTHING pinned:
 *
 *   (a) the seven `current` literals against EACH OTHER — versioning here is
 *       LOCKSTEP (CLAUDE.md: "All packages bump together"), so a contributor who
 *       bumps `record.current` to '2.0.0' for a contract change but forgets the
 *       other six ships a half-bumped table that validates clean. That partial
 *       bump is exactly the drift this seal converts into a RED test.
 *
 *   (b) `current` against the artifacts it claims to describe — the persisted
 *       `records/*.json` carry a real `schema_version`, and `verify` stamps new
 *       records with `record.current`. If `record.current` ever drifts away from
 *       the major the committed corpus actually carries, the gate would start
 *       refusing (or silently re-stamping) historical truth. This seal pins the
 *       committed record corpus's major inside `record`'s accepted range and at
 *       `record.current`, so a `current` edit that orphans the corpus goes RED.
 *
 * WHY a separate file (not folded into schema-versions.test.ts): this mirrors the
 * package's own convention — drift seals get their own `stageC-*` / `stageA-*`
 * file with a top-of-file rationale, so the seal's intent survives a future
 * reader who only greps for "lockstep" or "seal". The existing schema-versions
 * test stays a per-entry SHAPE check; this is the cross-entry + cross-artifact
 * DRIFT check.
 *
 * Loading note: the committed record corpus is read from the repo-root `records/`
 * tree (resolved relative to this test file), JSON.parse only — no YAML parser
 * dependency is pulled into the schemas package for this seal. JSON records are
 * the canonical `schema_version`-carrying artifact and the one `verify` stamps,
 * so they are the right corpus to pin `current` against.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_SCHEMA_VERSIONS } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/schemas/test → repo root is three levels up.
const repoRoot = resolve(here, '../../..');
const recordsDir = join(repoRoot, 'records');

const majorOf = (semver: string): number => Number(semver.split('.')[0]);

/** Recursively collect every committed `records/**.json` path. */
function collectRecordJson(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out = out.concat(collectRecordJson(full));
    } else if (name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

describe('SUPPORTED_SCHEMA_VERSIONS lockstep + corpus seal (schemas-B-001)', () => {
  const entries = Object.entries(SUPPORTED_SCHEMA_VERSIONS);

  it('all `current` versions move in lockstep (a partial bump goes RED)', () => {
    // Lockstep versioning (CLAUDE.md): every @dogfood-lab/* package — and every
    // contract `current` here — bumps together. So all seven `current` literals
    // must be byte-identical. If a future contributor bumps one contract's
    // `current` for a real schema change but forgets the others, the table is
    // half-bumped and THIS assertion fails, naming every divergent entry.
    const currents = entries.map(([key, e]) => ({ key, current: e.current }));
    const authoritative = currents[0].current;
    for (const { key, current } of currents) {
      expect(
        current,
        `SUPPORTED_SCHEMA_VERSIONS.${key}.current is "${current}" but the table ` +
          `versions in LOCKSTEP — every contract's current must equal "${authoritative}". ` +
          `If you are bumping the schema contract, bump ALL ${entries.length} entries ` +
          `together (and the workspace package version); a partial bump is the drift ` +
          `this seal exists to catch.`,
      ).toBe(authoritative);
    }
  });

  it('every `current` major sits inside its own [minMajor, maxMajor]', () => {
    // Redundant-by-design with schema-versions.test.ts, kept here so this seal is
    // self-contained: a lockstep bump that moves `current` past its declared
    // accepted range (without widening maxMajor) is also drift.
    for (const [key, e] of entries) {
      const cm = majorOf(e.current);
      expect(cm, `${key}.current major ${cm} below minMajor ${e.minMajor}`).toBeGreaterThanOrEqual(
        e.minMajor,
      );
      expect(cm, `${key}.current major ${cm} above maxMajor ${e.maxMajor}`).toBeLessThanOrEqual(
        e.maxMajor,
      );
    }
  });

  describe('committed record corpus is pinned to `record.current` (schema_version carrier)', () => {
    const recordEntry = SUPPORTED_SCHEMA_VERSIONS.record;
    const recordFiles = collectRecordJson(recordsDir);

    it('finds the committed record corpus (sanity — the seal needs real artifacts)', () => {
      // If this fails the corpus moved/was renamed; the carrier seal below would
      // otherwise vacuously pass with zero records. Fail loud instead.
      expect(
        recordFiles.length,
        `Expected committed records under ${recordsDir}; found none. The carrier ` +
          `seal below pins those records' schema_version against record.current — ` +
          `with no records it would vacuously pass.`,
      ).toBeGreaterThan(0);
    });

    it('every committed record\'s schema_version major fits record.[minMajor,maxMajor]', () => {
      for (const file of recordFiles) {
        const rec = JSON.parse(readFileSync(file, 'utf8')) as { schema_version?: string };
        // Every persisted record schema requires schema_version; a record missing
        // it is itself a defect this seal should surface.
        expect(rec.schema_version, `${file} has no schema_version`).toBeDefined();
        const m = majorOf(rec.schema_version as string);
        expect(
          m,
          `${file} carries schema_version "${rec.schema_version}" (major ${m}) which ` +
            `falls outside record's accepted range ` +
            `[${recordEntry.minMajor}, ${recordEntry.maxMajor}]. Either the record is ` +
            `from an unsupported contract or record's range drifted from the corpus.`,
        ).toBeGreaterThanOrEqual(recordEntry.minMajor);
        expect(m).toBeLessThanOrEqual(recordEntry.maxMajor);
      }
    });

    it('record.current major matches the major the committed corpus actually carries', () => {
      // verify stamps new records with record.current. If record.current ever
      // drifts to a major the historical corpus does not carry, the stamp and the
      // persisted truth diverge silently. Pin record.current's major to the corpus.
      const corpusMajors = new Set(
        recordFiles.map((f) => {
          const rec = JSON.parse(readFileSync(f, 'utf8')) as { schema_version: string };
          return majorOf(rec.schema_version);
        }),
      );
      const currentMajor = majorOf(recordEntry.current);
      expect(
        corpusMajors.has(currentMajor),
        `record.current is "${recordEntry.current}" (major ${currentMajor}) but the ` +
          `committed record corpus carries majors {${[...corpusMajors].join(', ')}}. ` +
          `verify stamps new records with record.current — if it drifts off the ` +
          `corpus major, stamped records diverge from persisted history.`,
      ).toBe(true);
    });
  });

  it('goes RED when a single `current` is bumped in isolation (in-memory drift proof)', () => {
    // Prove the lockstep seal is not vacuous: simulate a partial bump of one
    // contract's current and assert the same equality check the seal runs rejects
    // it, while the un-drifted table passes.
    const enforceLockstep = (table: Record<string, { current: string }>) => {
      const vals = Object.values(table).map((e) => e.current);
      for (const v of vals) expect(v).toBe(vals[0]);
    };
    const drifted = {
      record: { current: '2.0.0' },
      finding: { current: '1.0.0' },
    };
    expect(() => enforceLockstep(drifted)).toThrow();
    const aligned = {
      record: { current: '1.0.0' },
      finding: { current: '1.0.0' },
    };
    expect(() => enforceLockstep(aligned)).not.toThrow();
  });
});
