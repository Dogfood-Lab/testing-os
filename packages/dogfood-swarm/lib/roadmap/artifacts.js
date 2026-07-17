/**
 * artifacts.js — T5 roadmap_artifacts sequencing + insert helper
 * (F-830bce9e / F-swarmcpcore-003, docs/trajectory-and-closure.dispatch.md).
 *
 * T5: "one artifact per run; latest.json points at the newest; a recompile
 * within a run supersedes with a new sequence number... Versions supersede;
 * nothing rewrites." 'latest' is DERIVED as MAX(sequence_number) per run_id
 * — never a separate mutable pointer column — so roadmap_artifacts stays
 * append-only like every other event-shaped table in this schema (see
 * db/schema.js's own header comment on the table). The on-disk
 * `latest.json` a future CLI verb writes is a generated PROJECTION of
 * `latestRoadmapArtifact` below, never a second source of truth.
 *
 * compileRoadmap (./compile.js) is a PURE READ over the DB — this module is
 * its WRITE-side counterpart. Neither compile.js nor this module writes the
 * artifact JSON to disk; that split belongs to a future CLI verb
 * (commands/roadmap.js, swarm-cp-verbs' domain), per F-swarmcpcore-002's own
 * recommendation: "a thin commands/roadmap.js wraps it as the CLI verb and
 * handles the file write + latest.json pointer." This module is what that
 * verb calls to record the DB-side ledger row once it has written the file
 * and computed its content_hash.
 *
 * CONCURRENCY: `recordRoadmapArtifact` computes the next sequence number and
 * inserts it inside ONE db.transaction(), which serializes against other
 * writers IN THE SAME PROCESS. A genuine CROSS-PROCESS race (two `swarm
 * roadmap compile` invocations racing for the same run) is caught by the
 * UNIQUE(run_id, sequence_number) index — the loser's INSERT throws rather
 * than silently overwriting or retrying. This is deliberate: a concurrent
 * double-compile is rare enough, and important enough to see, that failing
 * loud beats a silent auto-retry that would mask a scheduling problem —
 * matches this package's general fail-loud posture (db/migrate.js's
 * module-load assertions, the D3B-006 finding_id uniqueness index).
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @returns {number} — 1 for a run with no prior artifact, else MAX+1.
 */
export function nextSequenceNumber(db, runId) {
  const row = db.prepare(`SELECT MAX(sequence_number) AS max_seq FROM roadmap_artifacts WHERE run_id = ?`).get(runId);
  return (row?.max_seq ?? 0) + 1;
}

/**
 * Record one compiled roadmap artifact. The caller has ALREADY written the
 * artifact JSON to disk and computed its content_hash (sha256-truncated-hex,
 * matching lib/persist/export.js's existing convention) before calling this
 * — this function only appends the DB-side ledger row.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ runId: string, path: string, contentHash: string }} artifact
 * @returns {number} the sequence_number this artifact was recorded at.
 * @throws if a concurrent writer already claimed the computed sequence
 *   number for this run_id (UNIQUE(run_id, sequence_number) — see this
 *   module's header for why this is a throw, not a silent retry).
 */
export function recordRoadmapArtifact(db, { runId, path, contentHash }) {
  const tx = db.transaction(() => {
    const sequenceNumber = nextSequenceNumber(db, runId);
    db.prepare(
      `INSERT INTO roadmap_artifacts (run_id, sequence_number, path, content_hash) VALUES (?, ?, ?, ?)`,
    ).run(runId, sequenceNumber, path, contentHash);
    return sequenceNumber;
  });
  return tx();
}

/**
 * The newest recorded artifact for a run — the row `latest.json` on disk
 * should project. Returns `null` for a run with no compiled artifact yet.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @returns {{ id: number, run_id: string, sequence_number: number, path: string, content_hash: string, created_at: string } | null}
 */
export function latestRoadmapArtifact(db, runId) {
  return db.prepare(
    `SELECT * FROM roadmap_artifacts WHERE run_id = ? ORDER BY sequence_number DESC LIMIT 1`,
  ).get(runId) || null;
}
