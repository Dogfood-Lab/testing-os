/**
 * schema.js — SQLite schema for the swarm control plane.
 *
 * 10 tables: runs, waves, domains, agent_runs, file_claims,
 * artifacts, findings, finding_events, verification_receipts, kv.
 */

export const SCHEMA_VERSION = 5;

export const SCHEMA_SQL = `
-- ───────────────────────────────────────────
-- A swarm run against a repo
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,
  local_path        TEXT NOT NULL,
  commit_sha        TEXT NOT NULL,
  branch            TEXT NOT NULL DEFAULT 'main',
  save_point_tag    TEXT,
  status            TEXT NOT NULL DEFAULT 'initializing',
  timeout_policy_ms INTEGER NOT NULL DEFAULT 1800000,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at      TEXT
);

-- ───────────────────────────────────────────
-- A wave within a run (audit, amend, feature, etc.)
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waves (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT    NOT NULL REFERENCES runs(id),
  phase                  TEXT    NOT NULL,
  wave_number            INTEGER NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'pending',
  domain_snapshot_id     TEXT,
  -- TRUTH-001: serial-verify discipline signal. Set by collect.js when any
  -- agent_run in the wave emitted verification_skipped: true (the
  -- --skip-verify discipline path). Read by swarm status to refuse claiming
  -- READY TO ADVANCE until the coordinators cumulative-tree verify has
  -- landed. Persistence so the discipline signal does not disappear when the
  -- collect-time stdout hint scrolls past.
  serial_verify_required INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at           TEXT,
  UNIQUE(run_id, wave_number)
);

-- ───────────────────────────────────────────
-- Domain definitions for a run (frozen after init)
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domains (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           TEXT    NOT NULL REFERENCES runs(id),
  name             TEXT    NOT NULL,
  globs            TEXT    NOT NULL,
  ownership_class  TEXT    NOT NULL DEFAULT 'owned',
  description      TEXT    DEFAULT '',
  frozen           INTEGER NOT NULL DEFAULT 0,
  UNIQUE(run_id, name)
);

-- ───────────────────────────────────────────
-- Per-wave, per-domain agent execution state
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_id              INTEGER NOT NULL REFERENCES waves(id),
  domain_id            INTEGER NOT NULL REFERENCES domains(id),
  status               TEXT    NOT NULL DEFAULT 'pending',
  output_path          TEXT,
  worktree_path        TEXT,
  worktree_branch      TEXT,
  started_at           TEXT,
  completed_at         TEXT,
  error_message        TEXT,
  -- TRUTH-003: per-agent serial-verify discipline signal. Mirrors the
  -- wave-level waves.serial_verify_required column but captures forensic
  -- truth at the agent identity (which agent skipped, which didn't) so the
  -- wave receipt can render per-row instead of collapsing to the wave
  -- aggregate. Set by collect.js when the agent output JSON carries
  -- verification_skipped=true.
  verification_skipped INTEGER NOT NULL DEFAULT 0
);

-- ───────────────────────────────────────────
-- Files touched by an agent (with violation flag)
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id  INTEGER NOT NULL REFERENCES agent_runs(id),
  file_path     TEXT    NOT NULL,
  claim_type    TEXT    NOT NULL DEFAULT 'edit',
  domain_id     INTEGER NOT NULL REFERENCES domains(id),
  violation     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent_run_id, file_path)
);

-- ───────────────────────────────────────────
-- Raw output artifacts from agents
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id  INTEGER NOT NULL REFERENCES agent_runs(id),
  artifact_type TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  content_hash  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────────────────────────
-- Deduplicated findings across all waves
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS findings (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                 TEXT    NOT NULL REFERENCES runs(id),
  finding_id             TEXT    NOT NULL,
  fingerprint            TEXT    NOT NULL,
  severity               TEXT    NOT NULL,
  category               TEXT    NOT NULL,
  file_path              TEXT,
  line_number            INTEGER,
  symbol                 TEXT,
  description            TEXT    NOT NULL,
  recommendation         TEXT,
  status                 TEXT    NOT NULL DEFAULT 'new',
  first_seen_wave        INTEGER REFERENCES waves(id),
  last_seen_wave         INTEGER REFERENCES waves(id),
  -- v4: Class #14b vantage-point extensions for verify-fixed v2.
  -- cross_ref points at a consumer-side fix location when the fix
  -- doesn't live at file_path/line_number. coordinator_resolved is
  -- the agent-attestation override path. verified_via_evidence is
  -- the operator-readable note explaining either path. See
  -- packages/dogfood-swarm/lib/verify-classifier-v2.js for the
  -- classification semantics. F-WAVE29-001 productization.
  cross_ref              TEXT,    -- JSON object: { file, symbol, line }
  coordinator_resolved   INTEGER NOT NULL DEFAULT 0,
  verified_via_evidence  TEXT,
  UNIQUE(run_id, fingerprint)
);

-- ───────────────────────────────────────────
-- Finding lifecycle events (append-only)
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finding_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id    INTEGER NOT NULL REFERENCES findings(id),
  event_type    TEXT    NOT NULL,
  wave_id       INTEGER REFERENCES waves(id),
  agent_run_id  INTEGER REFERENCES agent_runs(id),
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────────────────────────
-- Build verification receipts per wave
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verification_receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_id       INTEGER NOT NULL REFERENCES waves(id),
  repo_type     TEXT    NOT NULL,
  commands_run  TEXT    NOT NULL,
  exit_code     INTEGER NOT NULL,
  stdout        TEXT,
  stderr        TEXT,
  passed        INTEGER NOT NULL DEFAULT 0,
  test_count    INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────────────────────────
-- Key-value store for schema version + misc
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ───────────────────────────────────────────
-- Indexes for common queries
-- ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_waves_run        ON waves(run_id);
CREATE INDEX IF NOT EXISTS idx_domains_run      ON domains(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_wave  ON agent_runs(wave_id);
CREATE INDEX IF NOT EXISTS idx_file_claims_ar   ON file_claims(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_run     ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_fp      ON findings(run_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_finding_events_f ON finding_events(finding_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_ar     ON artifacts(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_verif_wave       ON verification_receipts(wave_id);

-- ───────────────────────────────────────────
-- v2: Agent state transition log (append-only)
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_state_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_run_id  INTEGER NOT NULL REFERENCES agent_runs(id),
  from_status   TEXT    NOT NULL,
  to_status     TEXT    NOT NULL,
  reason        TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────────────────────────
-- v2: Domain change events (append-only)
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domain_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id   INTEGER NOT NULL REFERENCES domains(id),
  event_type  TEXT    NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  reason      TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────────────────────────
-- v5: Wave state transition log (append-only)
-- Phase 5A: mirrors agent_state_events for waves. Append-only audit trail
-- written by lib/wave-state-machine.js#transitionWave(). Every successful
-- wave status change writes one row here. Field shape matches
-- agent_state_events verbatim (with wave_id swapped for agent_run_id) so the
-- two logs can be merged into a unified timeline view by future tooling.
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wave_state_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_id     INTEGER NOT NULL REFERENCES waves(id),
  from_status TEXT    NOT NULL,
  to_status   TEXT    NOT NULL,
  reason      TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────────────────────────
-- v2: Wave receipts (durable export artifacts)
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wave_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_id     INTEGER NOT NULL REFERENCES waves(id),
  json_path   TEXT,
  md_path     TEXT,
  content_hash TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(wave_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_state_ev ON agent_state_events(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_domain_ev      ON domain_events(domain_id);
CREATE INDEX IF NOT EXISTS idx_wave_state_ev  ON wave_state_events(wave_id);

-- ───────────────────────────────────────────
-- v3: Wave promotion records (append-only)
-- ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promotions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_id          INTEGER NOT NULL REFERENCES waves(id),
  run_id           TEXT    NOT NULL REFERENCES runs(id),
  from_phase       TEXT    NOT NULL,
  to_phase         TEXT    NOT NULL,
  authorized_by    TEXT    NOT NULL DEFAULT 'coordinator',
  gates_checked    TEXT    NOT NULL,
  overrides        TEXT,
  finding_snapshot TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_promotions_run  ON promotions(run_id);
CREATE INDEX IF NOT EXISTS idx_promotions_wave ON promotions(wave_id);
`;

/**
 * v2 migration: add columns to existing tables.
 * These are idempotent (SQLite ALTER TABLE ADD COLUMN is no-op if column exists... sort of).
 * We catch errors for columns that already exist.
 */
export const MIGRATIONS_SQL = [
  // v2: runs: timeout policy per run (ms)
  "ALTER TABLE runs ADD COLUMN timeout_policy_ms INTEGER NOT NULL DEFAULT 1800000",
  // v2: waves: domain snapshot ID for wave-bound ownership checks
  "ALTER TABLE waves ADD COLUMN domain_snapshot_id TEXT",
  // v2: domains: human-readable description
  "ALTER TABLE domains ADD COLUMN description TEXT DEFAULT ''",
  // v3: agent_runs: worktree isolation paths
  "ALTER TABLE agent_runs ADD COLUMN worktree_path TEXT",
  "ALTER TABLE agent_runs ADD COLUMN worktree_branch TEXT",
  // v4: findings: Class #14b vantage-point extensions for verify-fixed v2.
  // F-WAVE29-001 productization. See lib/verify-classifier-v2.js for
  // classification semantics; the column shapes mirror the v2 envelope.
  "ALTER TABLE findings ADD COLUMN cross_ref TEXT",
  "ALTER TABLE findings ADD COLUMN coordinator_resolved INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE findings ADD COLUMN verified_via_evidence TEXT",
  // TRUTH-001: waves: persisted serial-verify discipline signal so `swarm
  // status` can refuse READY TO ADVANCE when --skip-verify was used and the
  // coordinator's authoritative cumulative-tree verify has not landed.
  "ALTER TABLE waves ADD COLUMN serial_verify_required INTEGER NOT NULL DEFAULT 0",
  // TRUTH-003: agent_runs: per-agent serial-verify signal so the wave
  // receipt can render which specific agent skipped verify rather than
  // collapsing to the wave aggregate. Composes with the wave-level column;
  // legacy single-agent semantics keep the default 0.
  "ALTER TABLE agent_runs ADD COLUMN verification_skipped INTEGER NOT NULL DEFAULT 0",
  // Phase 5A: wave_state_events table. CREATE IF NOT EXISTS so an existing
  // DB at an older SCHEMA_VERSION picks up the table on next openDb without
  // a destructive migration. The matching index lives below; both clauses are
  // idempotent. The SCHEMA_SQL block already covers fresh DBs; this MIGRATIONS
  // entry covers the upgrade path from earlier SCHEMA_VERSIONs.
  `CREATE TABLE IF NOT EXISTS wave_state_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    wave_id     INTEGER NOT NULL REFERENCES waves(id),
    from_status TEXT    NOT NULL,
    to_status   TEXT    NOT NULL,
    reason      TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_wave_state_ev ON wave_state_events(wave_id)",
];

/**
 * Valid statuses for each entity.
 */
// Phase enums must stay in sync with dispatch.js's AUDIT_PHASES /
// AMEND_PHASES. dispatch.js sets `runs.status = opts.phase` directly, so a
// `stage-d-audit` dispatch writes 'stage-d-audit' to the status column. SQLite
// has no enum enforcement so a missing entry here is silent doc-vs-runtime
// drift (sibling to wave-1 F-742440-012). Adding 'stage-d-audit' and
// 'stage-d-amend' (introduced in v1.1.0 per CHANGELOG) closes that gap.
// F-375053-005.
export const STATUS = {
  run: ['initializing', 'health-audit-a', 'health-audit-b', 'health-audit-c',
        'health-amend-a', 'health-amend-b', 'health-amend-c',
        'stage-d-audit', 'stage-d-amend',
        'feature-audit', 'feature-execute', 'test', 'treatment', 'complete', 'aborted'],
  wave: ['pending', 'dispatched', 'collecting', 'collected', 'verified', 'advanced', 'failed'],
  agent_run: ['pending', 'dispatched', 'running', 'complete', 'failed',
              'timed_out', 'invalid_output', 'ownership_violation'],
  finding: ['new', 'recurring', 'approved', 'fixed', 'unverified', 'deferred', 'rejected'],
  finding_event: ['reported', 'approved', 'fixed', 'unverified', 'deferred', 'rejected', 'recurred'],
  ownership_class: ['owned', 'shared', 'bridge'],
  claim_type: ['edit', 'create', 'delete'],
  severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
};
