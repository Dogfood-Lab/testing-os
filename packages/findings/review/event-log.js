/**
 * Append-only review event log.
 *
 * Events are stored as YAML arrays in reviews/<YYYY>/<date>-finding-review-log.yaml
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

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
 * Concurrency caveat: there is still a read-then-write race. Two simultaneous
 * appends can both read N events, both push their event, both rename — the
 * second rename wins, dropping the first appender's event. The atomic rename
 * eliminates the corrupted-file failure mode (worst-case at the previous
 * implementation), but operators running concurrent reviewers must serialize
 * via an external lock if no event may be lost.
 */
export function appendEvent(rootDir, event) {
  const logPath = getLogPath(rootDir);
  const dir = dirname(logPath);
  mkdirSync(dir, { recursive: true });

  let events = [];
  if (existsSync(logPath)) {
    const raw = readFileSync(logPath, 'utf-8');
    events = yaml.load(raw) || [];
    if (!Array.isArray(events)) events = [events];
  }

  events.push(event);

  // Atomic write: temp file → rename. Same pattern persist.js + rebuild-indexes.js use.
  const tmpSuffix = randomBytes(4).toString('hex');
  const tmpPath = `${logPath}.${tmpSuffix}.tmp`;
  writeFileSync(tmpPath, yaml.dump(events, { lineWidth: 120, noRefs: true }), 'utf-8');
  renameSync(tmpPath, logPath);
  return logPath;
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
