/**
 * Append-only review event log.
 *
 * Events are stored ONE PER FILE under reviews/<YYYY>/<YYYY-MM-DD>/<event-id>.yaml
 * (the same sharded-immutable-file pattern the records/ store uses). This
 * replaced an earlier "daily YAML array, read-modify-rename under a file lock"
 * design: a Phase-9 50-fork race detector proved that NO lock FILE is reliably
 * exclusive on NTFS under heavy concurrent create churn — two appenders could
 * both win the lock, both read N events, both rename, and one clobber the
 * other's event (~1/3 of saturated runs, every child still exiting 0). A
 * shared mutable array file cannot be made safe under concurrency on that fs.
 * One immutable file per event removes the shared mutable state entirely: each
 * append writes a uniquely-named file, so concurrent appends CANNOT collide or
 * lose an event, and no lock is needed for correctness. `getAllEventsWithSkips`
 * already globs reviews/ recursively and merges per-file events.
 */

import { mkdirSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

import { loadYamlDir } from '../lib/safe-yaml-load.js';

let _eventCounter = 0;

/**
 * Generate a unique event ID. Includes a random suffix so the id is unique
 * ACROSS processes (the `_eventCounter` is per-process, so two forks would
 * otherwise mint the same `rev-<ts>-<seq>`); this id also names the per-event
 * file, so cross-process uniqueness keeps two concurrent appends from picking
 * the same filename.
 */
export function generateEventId() {
  const ts = Date.now().toString(36);
  const seq = (++_eventCounter).toString(36).padStart(4, '0');
  const rand = randomBytes(4).toString('hex');
  return `rev-${ts}-${seq}-${rand}`;
}

/**
 * Create a review event object.
 *
 * F2-INTEL-001 — back-compat extension for synthesis-artifact review events.
 * The original event shape is keyed by `finding_id`; the synthesis-artifact
 * review engine (review/review-artifacts.js) operates on patterns /
 * recommendations / doctrine, which have no `finding_id`. When `params.artifactId`
 * is supplied the event carries `artifact_id` + `artifact_kind` INSTEAD of
 * `finding_id`, so the same append-only log and `getAllEvents` reader serve both
 * object families. Finding events are byte-for-byte unchanged — the artifact
 * fields are additive and only appear when `artifactId` is set.
 */
export function createEvent(params) {
  const event = {
    review_event_id: generateEventId(),
    ...(params.artifactId
      ? { artifact_id: params.artifactId, artifact_kind: params.artifactKind }
      : { finding_id: params.findingId }),
    timestamp: new Date().toISOString(),
    actor: params.actor,
    action: params.action,
    from_status: params.fromStatus,
    to_status: params.toStatus
  };

  if (params.reason) event.reason = params.reason;
  if (params.fieldChanges && Object.keys(params.fieldChanges).length > 0) {
    event.field_changes = params.fieldChanges;
  }
  if (params.mergedFromIds?.length) event.merged_from_ids = params.mergedFromIds;
  if (params.invalidatedBy) event.invalidated_by = params.invalidatedBy;
  if (params.notes) event.notes = params.notes;

  return event;
}

/**
 * Get the log file path for a given date.
 */
export function getLogPath(rootDir, date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return resolve(rootDir, 'reviews', String(year), `${year}-${month}-${day}-finding-review-log.yaml`);
}

/**
 * Directory holding one date-sharded set of per-event files:
 * reviews/<YYYY>/<YYYY-MM-DD>/. Each appended event is its own file inside.
 */
export function getEventDir(rootDir, date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return resolve(rootDir, 'reviews', year, `${year}-${month}-${day}`);
}

/**
 * Append a review event by writing it to its OWN immutable file
 * (reviews/<YYYY>/<YYYY-MM-DD>/<event-id>.yaml). See the module header for why
 * this replaced the daily-array-under-a-lock design: no shared mutable file
 * means concurrent appends physically cannot collide or lose an event, so no
 * lock is needed for correctness — the Phase-9 50-fork race detector that lost
 * an event ~1/3 of saturated runs is structurally impossible here.
 *
 * Crash-safety: a single `openSync(path, 'wx')` + write of one event is atomic
 * at the file granularity — a crash mid-write leaves a complete event file or
 * none, never a torn shared array. The filename is the (cross-process-unique)
 * event id, so two concurrent appends never target the same path.
 *
 * @param {string} rootDir
 * @param {object} event - a `createEvent()` result.
 * @returns {string} the path of the event file written.
 */
export function appendEvent(rootDir, event) {
  const dir = getEventDir(rootDir);
  mkdirSync(dir, { recursive: true });

  const eventId = event.review_event_id || generateEventId();
  const eventPath = resolve(dir, `${eventId}.yaml`);
  const body = yaml.dump(event, { lineWidth: 120, noRefs: true });

  // 'wx' = O_EXCL exclusive-create: asserts the unique id has not collided
  // (it carries a random suffix, so it won't) rather than relying on it. No
  // temp+rename is needed — there is no shared file to atomically replace; one
  // event per file is already all-or-nothing.
  const fd = openSync(eventPath, 'wx');
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return eventPath;
}

/**
 * Read all events for a specific finding.
 */
export function getEventsForFinding(rootDir, findingId) {
  const all = getAllEvents(rootDir);
  return all.filter(e => e.finding_id === findingId);
}

/**
 * Read all events across all findings.
 *
 * Legacy shape: returns an array of events. Torn log files are NOT silently
 * dropped — they surface as structured skip records via the sibling API
 * `getAllEventsWithSkips()`. Callers that need to see which log files
 * failed to load should use that API; this one is kept array-shaped for
 * backward compatibility with the existing read sites (CLI display,
 * `getEventsForFinding`, the review.test.js / event-log-race.test.js
 * fixtures).
 *
 * H1 / F-721047-010 — silent-loader closure: previously the internal
 * `walkYaml` helper wrapped the whole `readdir`/`statSync`/`readFileSync`/
 * `yaml.load` loop in a single `try { ... } catch { /* skip bad files * / }`,
 * which made torn YAML, EACCES, and ENOENT all disappear with no signal.
 * The walk is now delegated to `loadYamlDir`, which returns
 * `{ entries, skipped }` — every torn file is recorded with a structured
 * error rather than dropped.
 */
export function getAllEvents(rootDir) {
  return getAllEventsWithSkips(rootDir).events;
}

/**
 * Read all events across all findings, plus a list of any log files that
 * failed to load (torn YAML, EACCES, etc.). The structured-skip API the
 * audit asked for — callers that care about pipeline honesty (rebuild
 * scripts, doctor commands, CI checks) should consume this one rather
 * than the array-shaped legacy `getAllEvents`.
 *
 * @param {string} rootDir
 * @returns {{ events: object[], skipped: Array<{ path: string, error: string }> }}
 */
export function getAllEventsWithSkips(rootDir) {
  const reviewsDir = resolve(rootDir, 'reviews');
  if (!existsSync(reviewsDir)) return { events: [], skipped: [] };

  const { entries, skipped } = loadYamlDir(reviewsDir, { recursive: true });

  const events = [];
  for (const entry of entries) {
    const data = entry.data;
    if (!data) continue;
    if (Array.isArray(data)) {
      events.push(...data);
    } else {
      // A single-event YAML file (defensive: shouldn't happen for daily logs,
      // but the original walkYaml tolerated either shape).
      events.push(data);
    }
  }

  events.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  return { events, skipped };
}
