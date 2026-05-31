/**
 * Record loader for the derivation engine.
 * Discovers and loads verified dogfood records from the filesystem.
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

import { isUnsafeSegment } from '@dogfood-lab/ingest/lib/unsafe-segment.js';
import { loadJsonFile } from '../lib/safe-yaml-load.js';

/**
 * Load all records for a specific repo (legacy array shape).
 *
 * Torn record JSON files are NO LONGER silently dropped — they surface via
 * the sibling `loadRecordsForRepoWithSkips`. H2 / F-721047-010 — silent-
 * loader closure. The advisor-surfaced sibling at line :110.
 *
 * @param {string} rootDir - dogfood-labs repo root.
 * @param {string} repoKey - Full org/repo key (e.g. "mcp-tool-shop-org/repo-crawler-mcp").
 * @returns {Array<{ record: object, rejected: boolean, path: string }>}
 */
export function loadRecordsForRepo(rootDir, repoKey) {
  return loadRecordsForRepoWithSkips(rootDir, repoKey).entries;
}

/**
 * Audit-honesty variant of `loadRecordsForRepo`: returns both the loaded
 * records and a list of torn / unreadable JSON files.
 *
 * @param {string} rootDir
 * @param {string} repoKey
 * @returns {{ entries: Array<{ record: object, rejected: boolean, path: string }>, skipped: Array<{ path: string, error: string }> }}
 */
export function loadRecordsForRepoWithSkips(rootDir, repoKey) {
  const [org, repo] = repoKey.split('/');
  // Path-traversal guard: F-916867-005. Mirrors persist.js + load-context.js
  // via the central helper at @dogfood-lab/ingest/lib/unsafe-segment.js.
  // A malformed repoKey (`..` or path-separator) would otherwise resolve
  // outside the records tree and silently load (or skip) unrelated files.
  if (!org || !repo || isUnsafeSegment(org) || isUnsafeSegment(repo)) {
    return { entries: [], skipped: [] };
  }
  const entries = [];
  const skipped = [];

  // Accepted records
  const acceptedDir = resolve(rootDir, 'records', org, repo);
  const acc = walkRecordsWithSkips(acceptedDir, false);
  entries.push(...acc.entries);
  skipped.push(...acc.skipped);

  // Rejected records
  const rejectedDir = resolve(rootDir, 'records', '_rejected', org, repo);
  const rej = walkRecordsWithSkips(rejectedDir, true);
  entries.push(...rej.entries);
  skipped.push(...rej.skipped);

  return { entries, skipped };
}

/**
 * Load a single record by run_id.
 *
 * @param {string} rootDir - dogfood-labs repo root.
 * @param {string} runId - The run_id to find.
 * @returns {{ record: object, rejected: boolean, path: string } | null}
 */
export function loadRecordById(rootDir, runId) {
  // Search accepted records
  const acceptedRoot = resolve(rootDir, 'records');
  const found = findRecordFile(acceptedRoot, runId, false);
  if (found) return found;

  // Search rejected records
  const rejectedRoot = resolve(rootDir, 'records', '_rejected');
  return findRecordFile(rejectedRoot, runId, true);
}

/**
 * Load all records across all repos (legacy array shape).
 *
 * Torn record JSON files are NO LONGER silently dropped — they surface via
 * the sibling `loadAllRecordsWithSkips`. H2 / F-721047-010.
 *
 * @param {string} rootDir - dogfood-labs repo root.
 * @returns {Array<{ record: object, rejected: boolean, path: string }>}
 */
export function loadAllRecords(rootDir) {
  return loadAllRecordsWithSkips(rootDir).entries;
}

/**
 * Audit-honesty variant of `loadAllRecords`.
 *
 * @param {string} rootDir
 * @returns {{ entries: Array<{ record: object, rejected: boolean, path: string }>, skipped: Array<{ path: string, error: string }> }}
 */
export function loadAllRecordsWithSkips(rootDir) {
  const entries = [];
  const skipped = [];

  // Accepted records
  const recordsDir = resolve(rootDir, 'records');
  if (existsSync(recordsDir)) {
    for (const org of listDirs(recordsDir)) {
      if (org === '_rejected') continue;
      const orgDir = join(recordsDir, org);
      for (const repo of listDirs(orgDir)) {
        const repoDir = join(orgDir, repo);
        const w = walkRecordsWithSkips(repoDir, false);
        entries.push(...w.entries);
        skipped.push(...w.skipped);
      }
    }
  }

  // Rejected records
  const rejectedDir = resolve(rootDir, 'records', '_rejected');
  if (existsSync(rejectedDir)) {
    for (const org of listDirs(rejectedDir)) {
      const orgDir = join(rejectedDir, org);
      for (const repo of listDirs(orgDir)) {
        const repoDir = join(orgDir, repo);
        const w = walkRecordsWithSkips(repoDir, true);
        entries.push(...w.entries);
        skipped.push(...w.skipped);
      }
    }
  }

  return { entries, skipped };
}

/**
 * Walk a record directory tree, load all `.json` files via the shared
 * `loadJsonFile` helper, and return `{ entries, skipped }`. Torn JSON
 * files are NO LONGER silently dropped — they appear in `skipped` with
 * a structured `{ path, error }`.
 *
 * H2 / F-721047-010 — silent-loader closure (advisor-surfaced sibling at
 * load-records.js:110).
 */
function walkRecordsWithSkips(dir, rejected) {
  const entries = [];
  const skipped = [];
  if (!existsSync(dir)) return { entries, skipped };

  function walk(d) {
    let children;
    try {
      children = readdirSync(d);
    } catch (err) {
      skipped.push({ path: d, error: `readdir error: ${err.message}` });
      return;
    }
    for (const entry of children) {
      const full = join(d, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch (err) {
        skipped.push({ path: full, error: `stat error: ${err.message}` });
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (extname(entry) !== '.json') continue;
      const { data, error } = loadJsonFile(full);
      if (error !== null) {
        skipped.push({ path: full, error });
      } else {
        entries.push({ record: data, rejected, path: full });
      }
    }
  }

  walk(dir);
  return { entries, skipped };
}

/**
 * Find a specific record file by run_id pattern.
 *
 * H2 / F-721047-010 — silent-loader closure (advisor-surfaced sibling at
 * load-records.js:137). Replaces the bare `try { ... } catch {}` with the
 * structured `loadJsonFile` helper. A torn JSON file that happens to
 * include the run_id in its name no longer silently masks the actual
 * record under a different (perhaps later-renamed) sibling.
 */
function findRecordFile(rootDir, runId, rejected) {
  if (!existsSync(rootDir)) return null;

  function search(dir) {
    let children;
    try {
      children = readdirSync(dir);
    } catch {
      // Permission/transient error on the directory — fall through; the
      // caller's outer search will try sibling roots.
      return null;
    }
    for (const entry of children) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const found = search(full);
        if (found) return found;
        continue;
      }
      if (extname(entry) !== '.json') continue;
      if (!entry.includes(runId)) continue;
      const { data, error } = loadJsonFile(full);
      if (error !== null) {
        // A torn JSON file that happens to be named after the run_id —
        // surface this loudly via console.error rather than silently
        // hiding it. The caller still gets null and may find a sibling.
        // eslint-disable-next-line no-console
        console.error(`findRecordFile: torn record JSON at ${full}: ${error}`);
        continue;
      }
      if (data && data.run_id === runId) {
        return { record: data, rejected, path: full };
      }
    }
    return null;
  }

  return search(rootDir);
}

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => {
    try { return statSync(join(dir, name)).isDirectory(); }
    catch { return false; }
  });
}
