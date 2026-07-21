/**
 * sqlite-datetime.js — SQLite datetime → RFC 3339 UTC at the export read boundary.
 *
 * The control plane's timestamp columns default to SQLite's own
 * `datetime('now')` (db/schema.js), which stores a space-separated,
 * timezone-UNMARKED UTC string (`'YYYY-MM-DD HH:MM:SS'`). The dogfood
 * submission and persisted-record schemas constrain their timestamp fields
 * to JSON-Schema `format: "date-time"` (RFC 3339), so exporting the stored
 * string verbatim is rejected by the repo's own ingest —
 * `record_schema_invalid_from_submission` on /timing/started_at and
 * /timing/finished_at, observed in run swarm-1784601601-bd4a
 * (ai-rpg-engine): the control plane's own bridge was bounced by its own
 * gate and the run's evidence never landed.
 *
 * Conversion is pure string surgery — never `new Date(raw)` on the raw
 * value, because the ECMA-262 grammar parses a non-'T'-separated,
 * non-offset-suffixed string as LOCAL time (the exact trap F-5cfa163c
 * fixed for commands/roadmap.js's deterministicNow; this is the
 * string-returning sibling of its parseSqliteUtcDatetime). SQLite's value
 * always means UTC, so `'T'` + `'Z'` is the truth-preserving rewrite.
 *
 * Not every column carries the SQLite shape: lib/state-machine.js writes
 * Date#toISOString() into agent_runs.started_at/completed_at, and test
 * fixtures insert `...Z` strings directly — an already-timezone-marked
 * value is trusted as-is. Unknown shapes also pass through unchanged so
 * the schema gate downstream reports them instead of this helper silently
 * manufacturing a plausible-looking timestamp.
 */

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Normalize one stored timestamp for a schema-constrained export field.
 *
 * @param {string|null|undefined} raw — stored column value
 * @returns {string|null} RFC 3339 UTC string, or null when the column was NULL
 */
export function toRfc3339Utc(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  if (SQLITE_DATETIME.test(raw)) return `${raw.replace(' ', 'T')}Z`;
  return raw;
}
