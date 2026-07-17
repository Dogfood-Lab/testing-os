/**
 * roadmap-compiler-content-hash.test.js — F-e02e5bfd / F-c7b0f47b:
 * dogfood-roadmap.schema.json's OPTIONAL `content_hash` field is computed by
 * writeRoadmapArtifact (sha256 of the artifact body) but, before this fix,
 * was only ever handed to recordRoadmapArtifact for the DB ledger row —
 * never written into the artifact JSON itself. A schema field the codebase
 * already got right in spirit was unreachable in the real file. This suite
 * proves the sequence-suffixed history file now carries `content_hash`,
 * while the sequence-free `<run-id>.json` mirror (which F-feeaef78's
 * cross-process determinism proof pins byte-for-byte) does NOT gain it —
 * embedding a per-write-attempt hash into a file that explicitly represents
 * "current content, not a specific write attempt" would contradict that
 * file's own documented purpose (compiler.js's own comment on `sequence`'s
 * identical exclusion).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { openDb, closeDb } from '../db/connection.js';
import { writeRoadmapArtifact } from './roadmap/compiler.js';

const tmpRoots = [];
const dbPaths = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const p of dbPaths) {
    try { closeDb(p); } catch { /* already closed */ }
  }
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

function seedRun(dbPath, runId, repoDir) {
  const db = openDb(dbPath);
  dbPaths.push(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', ?, ?, 'feature-audit')`)
    .run(runId, repoDir, 'a'.repeat(40));
  return db;
}

/** @pins F-e02e5bfd */
describe('writeRoadmapArtifact — content_hash embedded in the written artifact (F-e02e5bfd)', () => {
  it('the sequence-suffixed history file carries a content_hash matching sha256 of the pre-hash body', () => {
    const dbDir = makeTmpDir('roadmap-hash-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeTmpDir('roadmap-hash-repo-');
    const runId = 'run-hash-1';
    seedRun(dbPath, runId, repoDir);

    const artifact = { run_id: runId, repo: 'org/repo', run_anchored_at: '2026-07-17T00:00:00.000Z' };
    const written = writeRoadmapArtifact(runId, artifact, { dbPath });

    const onDisk = JSON.parse(readFileSync(written.path, 'utf-8'));
    assert.equal(typeof onDisk.content_hash, 'string');
    assert.ok(onDisk.content_hash.length > 0);

    // The embedded hash must equal sha256 of the body BEFORE content_hash was
    // added (sequence included) — never a hash that includes itself.
    const bodyWithoutHash = { ...artifact, sequence: written.sequence };
    const expectedHash = createHash('sha256').update(JSON.stringify(bodyWithoutHash, null, 2)).digest('hex');
    assert.equal(onDisk.content_hash, expectedHash);
  });

  it('the DB ledger row records the SAME content_hash value as the embedded field', () => {
    const dbDir = makeTmpDir('roadmap-hash-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeTmpDir('roadmap-hash-repo-');
    const runId = 'run-hash-2';
    const db = seedRun(dbPath, runId, repoDir);

    const artifact = { run_id: runId, repo: 'org/repo', run_anchored_at: '2026-07-17T00:00:00.000Z' };
    const written = writeRoadmapArtifact(runId, artifact, { dbPath });

    const onDisk = JSON.parse(readFileSync(written.path, 'utf-8'));
    const ledgerRow = db.prepare('SELECT content_hash FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = ?')
      .get(runId, written.sequence);
    assert.equal(ledgerRow.content_hash, onDisk.content_hash);
  });

  it('the sequence-free <run-id>.json mirror does NOT carry content_hash or sequence — it represents current content, not one write attempt', () => {
    const dbDir = makeTmpDir('roadmap-hash-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeTmpDir('roadmap-hash-repo-');
    const runId = 'run-hash-3';
    seedRun(dbPath, runId, repoDir);

    const artifact = { run_id: runId, repo: 'org/repo', run_anchored_at: '2026-07-17T00:00:00.000Z' };
    const written = writeRoadmapArtifact(runId, artifact, { dbPath });

    const mirror = JSON.parse(readFileSync(written.currentPath, 'utf-8'));
    assert.equal(Object.hasOwn(mirror, 'content_hash'), false);
    assert.equal(Object.hasOwn(mirror, 'sequence'), false);
    assert.deepEqual(mirror, artifact, 'the mirror must stay exactly what F-feeaef78 pins — untouched by this fix');
  });
});
