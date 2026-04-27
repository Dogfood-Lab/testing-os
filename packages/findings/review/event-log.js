/**
 * Append-only review event log.
 *
 * Events are stored as YAML arrays in reviews/<YYYY>/<date>-finding-review-log.yaml
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

import { withFileLock } from '../lib/file-lock.js';

let _eventCounter = 0;

/**
 * Generate a unique event ID.
 */
export function generateEventId() {
  const ts = Date.now().toString(36);
  const seq = (++_eventCounter).toString(36).padStart(4, '0');
  return `rev-${ts}-${seq}`;
}

/**
 * Create a review event object.
 */
export function createEvent(params) {
  const event = {
    review_event_id: generateEventId(),
    finding_id: params.findingId,
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
 * Append an event to the review log.
 *
 * Atomicity: writes the new event list to a unique temp file then renames it
 * over the canonical log file. `rename` is atomic on POSIX and Windows, so a
 * concurrent reader sees either the old contents or the new contents — never
 * a half-written file. This also makes the operation crash-safe: a Ctrl+C
 * between read and write leaves the original log intact.
 *
 * Concurrency: serialized at the choke point via `withFileLock` on the daily
 * log file (F-PIPELINE-011 / W3-PIPE-001 — Pattern #4 choke-point fix). The
 * read-then-write window is closed by holding a directory-mutex (`<logPath>.lock`)
 * across the read → push → rename sequence. Two concurrent `appendEvent` calls
 * to the SAME daily log serialize against each other; calls to DIFFERENT daily
 * logs (e.g. across a midnight boundary) do not contend. The lock is reclaimed
 * if the holder process dies — see `lib/file-lock.js` for the full design
 * rationale (why a lock dir, why not `O_APPEND`, stale recovery semantics,
 * single-machine scope).
 */
export function appendEvent(rootDir, event) {
  const logPath = getLogPath(rootDir);
  const dir = dirname(logPath);
  mkdirSync(dir, { recursive: true });

  // FAILS-then-PASSES proof gate (W3-PIPE-001):
  // Set DISABLE_APPEND_LOCK=1 in the env to bypass the lock for the explicit
  // purpose of demonstrating the race-detection test fails without the fix.
  // Wave-30 receipt documents the proof: with the lock, the multi-process
  // test passes 50/50 forks across 3 iterations, 20 consecutive test runs.
  // With the lock disabled, the test reliably fails (rename collisions on
  // unprotected concurrent rebuilds, dropped events).
  if (process.env.DISABLE_APPEND_LOCK) {
    let events = [];
    if (existsSync(logPath)) {
      const raw = readFileSync(logPath, 'utf-8');
      events = yaml.load(raw) || [];
      if (!Array.isArray(events)) events = [events];
    }
    events.push(event);
    const tmpSuffix = randomBytes(4).toString('hex');
    const tmpPath = `${logPath}.${tmpSuffix}.tmp`;
    writeFileSync(tmpPath, yaml.dump(events, { lineWidth: 120, noRefs: true }), 'utf-8');
    renameSync(tmpPath, logPath);
    return logPath;
  }

  return withFileLock(logPath, () => {
    let events = [];
    // Read-or-empty without an `existsSync` precheck: the readFileSync call
    // either returns the bytes or throws ENOENT. Avoiding `existsSync` here
    // closes a Windows-specific TOCTOU window where the dirent cache could
    // report `existsSync(logPath) === false` immediately after a sibling
    // process renamed a fresh file into place — which would cause us to
    // start with `events = []` and silently OVERWRITE the sibling's events.
    // The lock alone wasn't enough; the existsSync gate was the bug.
    try {
      const raw = readFileSync(logPath, 'utf-8');
      const parsed = yaml.load(raw);
      if (parsed) events = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }

    events.push(event);

    // Atomic write: temp file → rename. Same pattern persist.js + rebuild-indexes.js use.
    const tmpSuffix = randomBytes(4).toString('hex');
    const tmpPath = `${logPath}.${tmpSuffix}.tmp`;
    writeFileSync(tmpPath, yaml.dump(events, { lineWidth: 120, noRefs: true }), 'utf-8');
    renameSync(tmpPath, logPath);
    return logPath;
  });
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
 */
export function getAllEvents(rootDir) {
  const reviewsDir = resolve(rootDir, 'reviews');
  if (!existsSync(reviewsDir)) return [];

  const events = [];
  walkYaml(reviewsDir, data => {
    if (Array.isArray(data)) events.push(...data);
  });

  return events.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
}

/** Walk directory tree for .yaml files, parse and call cb with data. */
function walkYaml(dir, cb) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        walkYaml(full, cb);
      } else if (entry.endsWith('.yaml')) {
        const raw = readFileSync(full, 'utf-8');
        const data = yaml.load(raw);
        if (data) cb(data);
      }
    } catch { /* skip bad files */ }
  }
}
