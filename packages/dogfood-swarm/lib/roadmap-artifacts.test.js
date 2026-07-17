/**
 * roadmap-artifacts.test.js — F-830bce9e / F-swarmcpcore-003 (T5):
 * roadmap_artifacts sequencing — "one artifact per run; latest.json points
 * at the newest; a recompile within a run supersedes with a new sequence
 * number." 'latest' is derived as MAX(sequence_number), never a mutable
 * pointer column.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { openMemoryDb } from '../db/connection.js';
import { nextSequenceNumber, recordRoadmapArtifact, latestRoadmapArtifact } from './roadmap/artifacts.js';

function seedRun(db, runId) {
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', '/tmp/r', ?, 'feature-audit')`)
    .run(runId, 'a'.repeat(40));
}

/** @pins F-830bce9e */
describe('roadmap_artifacts sequencing (F-830bce9e)', () => {
  it('nextSequenceNumber is 1 for a run with no prior artifact', () => {
    const db = openMemoryDb();
    seedRun(db, 'run-seq');
    assert.equal(nextSequenceNumber(db, 'run-seq'), 1);
  });

  it('recordRoadmapArtifact assigns sequential sequence numbers per run, and latestRoadmapArtifact tracks MAX', () => {
    const db = openMemoryDb();
    seedRun(db, 'run-seq');

    const seq1 = recordRoadmapArtifact(db, { runId: 'run-seq', path: 'dogfood/roadmap/run-seq.1.json', contentHash: 'hash1' });
    assert.equal(seq1, 1);
    assert.equal(latestRoadmapArtifact(db, 'run-seq').sequence_number, 1);

    const seq2 = recordRoadmapArtifact(db, { runId: 'run-seq', path: 'dogfood/roadmap/run-seq.2.json', contentHash: 'hash2' });
    assert.equal(seq2, 2, 'a recompile within the same run must supersede with the NEXT sequence number');
    const latest = latestRoadmapArtifact(db, 'run-seq');
    assert.equal(latest.sequence_number, 2);
    assert.equal(latest.content_hash, 'hash2');

    // T5: "nothing rewrites" — both rows must still exist (append-only), not
    // just the latest.
    const allRows = db.prepare('SELECT sequence_number FROM roadmap_artifacts WHERE run_id = ? ORDER BY sequence_number').all('run-seq');
    assert.deepEqual(allRows.map((r) => r.sequence_number), [1, 2]);
  });

  it('sequence numbers are scoped per run_id — two runs never interfere', () => {
    const db = openMemoryDb();
    seedRun(db, 'run-a');
    seedRun(db, 'run-b');

    recordRoadmapArtifact(db, { runId: 'run-a', path: 'a.json', contentHash: 'ha' });
    recordRoadmapArtifact(db, { runId: 'run-a', path: 'a2.json', contentHash: 'ha2' });
    const seqB = recordRoadmapArtifact(db, { runId: 'run-b', path: 'b.json', contentHash: 'hb' });

    assert.equal(seqB, 1, "run-b's first artifact must be sequence 1, unaffected by run-a's history");
  });

  it('latestRoadmapArtifact returns null for a run with no compiled artifact', () => {
    const db = openMemoryDb();
    seedRun(db, 'run-empty');
    assert.equal(latestRoadmapArtifact(db, 'run-empty'), null);
  });

  it('the UNIQUE(run_id, sequence_number) constraint refuses a duplicate sequence number for the same run', () => {
    const db = openMemoryDb();
    seedRun(db, 'run-dup');
    db.prepare(`INSERT INTO roadmap_artifacts (run_id, sequence_number, path, content_hash) VALUES (?, 1, 'x.json', 'hx')`).run('run-dup');
    assert.throws(() => {
      db.prepare(`INSERT INTO roadmap_artifacts (run_id, sequence_number, path, content_hash) VALUES (?, 1, 'y.json', 'hy')`).run('run-dup');
    }, /UNIQUE constraint failed/);
  });
});
