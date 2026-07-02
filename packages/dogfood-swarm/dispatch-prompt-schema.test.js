/**
 * dispatch-prompt-schema.test.js — Pact-style contract test for Stage B Item 1
 * and Item 4 (schema-derived prompt injection + domain-map alignment).
 *
 * Root cause closed: "brief-is-parallel-authority-to-frozen-state."
 *
 *  - Wave-2 wedge: the coordinator brief said `fixes_applied` / `files_edited`
 *    while the canonical schema required `fixes` / `files_changed`. Agents
 *    that read the brief instead of the schema produced schema-invalid
 *    outputs.
 *  - Wave-2 ci-tooling revalidate refusal: the coordinator brief told the
 *    agent to edit `scripts/*.mjs` while the frozen domain map omitted
 *    `scripts/**`. Agent obeyed the brief, collect-time `checkOwnership()`
 *    rejected the edits.
 *
 * Both symptoms are the SAME anti-pattern: brief asserts shape parallel to
 * frozen state. The fix in templates.js + dispatch.js renders the canonical
 * schema fragment AND the frozen-snapshot ownership facts directly into the
 * dispatched prompt — agents now read the same source of truth that the
 * collect-time gates enforce against.
 *
 * This test asserts the contract:
 *   1. Every generated wave-N/<domain>.md prompt contains a `## Output schema
 *      (canonical, derived from agent-output.schema.json)` block.
 *   2. The schema $id appears in the contract block.
 *   3. Canonical schema enum values appear in the prompt body (so a future
 *      schema enum change is forced through here).
 *   4. The `## Your domain (canonical, derived from frozen map)` block is
 *      present, with the domain's ownership class AND the snapshot ID.
 *   5. The canonical-output keys `fixes` and `files_changed` appear in
 *      amend prompts (NOT the historical drifted `fixes_applied` /
 *      `files_edited`).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readFileSync as _rfs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains, takeDomainSnapshot } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';

const RUN_ID = 'test-dispatch-prompt-schema';

const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve('@dogfood-lab/schemas/json/agent-output.schema.json');
const CANONICAL_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

function setupRun(dbPath) {
  const db = openDb(dbPath);

  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));

  saveDomainDraft(db, RUN_ID, [
    { name: 'backend', globs: ['packages/**', 'src/**'], ownership_class: 'owned' },
    { name: 'ci-tooling', globs: ['.github/**', 'scripts/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);

  return db;
}

describe('dispatch — schema-derived prompt injection (Stage B Item 1)', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-prompt-schema-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('audit prompt contains the canonical schema contract block + schema $id', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });

    for (const agent of result.agents) {
      const prompt = readFileSync(agent.promptPath, 'utf-8');
      assert.ok(
        prompt.includes('## Output schema (canonical, derived from agent-output.schema.json)'),
        `${agent.domain}: audit prompt must include the canonical schema header`,
      );
      assert.ok(
        prompt.includes(CANONICAL_SCHEMA.$id),
        `${agent.domain}: audit prompt must reference schema $id (${CANONICAL_SCHEMA.$id})`,
      );
    }
  });

  it('audit prompt enumerates the canonical severity + category + stage values', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });

    const severityEnum = CANONICAL_SCHEMA.$defs.finding.properties.severity.enum;
    const categoryEnum = CANONICAL_SCHEMA.$defs.finding.properties.category.enum;
    const stageEnum = CANONICAL_SCHEMA.properties.stage.enum;

    for (const agent of result.agents) {
      const prompt = readFileSync(agent.promptPath, 'utf-8');
      for (const sev of severityEnum) {
        assert.ok(
          prompt.includes(sev),
          `${agent.domain}: severity ${sev} must appear in canonical contract block`,
        );
      }
      for (const cat of categoryEnum) {
        assert.ok(
          prompt.includes(cat),
          `${agent.domain}: category ${cat} must appear in canonical contract block`,
        );
      }
      for (const stage of stageEnum) {
        assert.ok(
          prompt.includes(stage),
          `${agent.domain}: stage letter ${stage} must appear in canonical contract block`,
        );
      }
    }
  });

  it('amend prompt contains canonical fixes + files_changed keys (NOT the historical drift keys)', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });

    for (const agent of result.agents) {
      const prompt = readFileSync(agent.promptPath, 'utf-8');
      assert.ok(
        prompt.includes('`fixes`'),
        `${agent.domain}: amend prompt must reference canonical \`fixes\` key`,
      );
      assert.ok(
        prompt.includes('`files_changed`'),
        `${agent.domain}: amend prompt must reference canonical \`files_changed\` key`,
      );
      // The wave-2 wedge keys MUST NOT appear in the canonical contract block.
      // (They may appear as schema $id text matches inside a worked example we
      // intentionally REMOVED, so a substring check is load-bearing.)
      assert.equal(
        prompt.includes('fixes_applied'), false,
        `${agent.domain}: drifted key 'fixes_applied' must not appear — schema requires 'fixes'`,
      );
      assert.equal(
        prompt.includes('files_edited'), false,
        `${agent.domain}: drifted key 'files_edited' must not appear — schema requires 'files_changed'`,
      );
    }
  });

  it('feature-audit prompt contains canonical feature contract + priority/category/effort enums', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'feature-audit',
      dbPath,
      outputDir: tmpDir,
    });

    const priorityEnum = CANONICAL_SCHEMA.$defs.feature.properties.priority.enum;
    const categoryEnum = CANONICAL_SCHEMA.$defs.feature.properties.category.enum;
    const effortEnum = CANONICAL_SCHEMA.$defs.feature.properties.effort.enum;

    for (const agent of result.agents) {
      const prompt = readFileSync(agent.promptPath, 'utf-8');
      assert.ok(
        prompt.includes('## Output schema (canonical, derived from agent-output.schema.json)'),
        `${agent.domain}: feature prompt must include canonical schema header`,
      );
      for (const p of priorityEnum) {
        assert.ok(prompt.includes(p), `${agent.domain}: priority ${p} must appear`);
      }
      for (const c of categoryEnum) {
        assert.ok(prompt.includes(c), `${agent.domain}: feature category ${c} must appear`);
      }
      for (const e of effortEnum) {
        assert.ok(prompt.includes(e), `${agent.domain}: effort ${e} must appear`);
      }
    }
  });
});

describe('dispatch — domain-map alignment (Stage B Item 4)', () => {
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-domain-map-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('every prompt contains the canonical domain contract block with ownership class', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });

    for (const agent of result.agents) {
      const prompt = readFileSync(agent.promptPath, 'utf-8');
      assert.ok(
        prompt.includes('## Your domain (canonical, derived from frozen map)'),
        `${agent.domain}: prompt must include domain contract header`,
      );
      assert.ok(
        prompt.includes('Ownership class: `owned`'),
        `${agent.domain}: prompt must surface ownership class (owned for these test domains)`,
      );
      // F-950fe296: the contract block must state the TRUE enforcement
      // property — checkOwnership enforces against the frozen domain MAP;
      // the snapshot id is the audit anchor, not the enforcement source.
      assert.ok(
        prompt.includes('this block wins'),
        `${agent.domain}: prompt must include the domain-contract authority note`,
      );
      assert.ok(
        prompt.includes('enforces against the frozen domain'),
        `${agent.domain}: prompt must state enforcement runs against the frozen domain map`,
      );
      assert.ok(
        !prompt.includes('enforces against the snapshot.'),
        `${agent.domain}: prompt must NOT claim snapshot-based enforcement (false property, F-950fe296)`,
      );
    }
  });

  it('every prompt contains the frozen domain snapshot ID', () => {
    const db = openDb(dbPath);
    const snapshot = takeDomainSnapshot(db, RUN_ID);
    closeDb(dbPath);

    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });

    for (const agent of result.agents) {
      const prompt = readFileSync(agent.promptPath, 'utf-8');
      assert.ok(
        prompt.includes(snapshot.snapshotId),
        `${agent.domain}: prompt must surface snapshot ID ${snapshot.snapshotId} so the agent's authority surface matches collect-time enforcement`,
      );
    }
  });

  it('amend prompts also surface the domain contract block (parallel-authority closure)', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });

    for (const agent of result.agents) {
      const prompt = readFileSync(agent.promptPath, 'utf-8');
      assert.ok(
        prompt.includes('## Your domain (canonical, derived from frozen map)'),
        `${agent.domain}: amend prompt must include domain contract header`,
      );
      assert.ok(
        prompt.includes('Ownership class: `owned`'),
        `${agent.domain}: amend prompt must surface ownership class`,
      );
    }
  });

  it('feature-audit prompts also surface the domain contract block', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'feature-audit',
      dbPath,
      outputDir: tmpDir,
    });

    for (const agent of result.agents) {
      const prompt = readFileSync(agent.promptPath, 'utf-8');
      assert.ok(
        prompt.includes('## Your domain (canonical, derived from frozen map)'),
        `${agent.domain}: feature prompt must include domain contract header`,
      );
    }
  });
});
