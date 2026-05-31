/**
 * safe-yaml-load — single-source structured loader for the silent-loader family
 * (F-721047-010 / D2 amend wave 1).
 *
 * **Why this helper exists.** Multiple sites in `packages/findings/**` were
 * implementing the same pattern: walk a directory, parse `.yaml` (or `.json`)
 * files, and silently swallow every error with `try { ... } catch {}`. A torn
 * YAML file, an EACCES, a transient ENOENT — all disappeared, producing
 * partial results that looked complete. The advisor verified four such sites
 * (`review/event-log.js walkYaml`, `synthesis/recommendation-derivation.js
 * loadAcceptedPatterns`, `synthesis/write-artifacts.js loadArtifacts`,
 * `derive/load-records.js walkRecords/findRecordFile`) and surfaced two
 * advisor-found siblings in `derive/load-records.js`. The audit's framing
 * was that this was a "closed" anti-pattern but the header in
 * `lib/atomic-write.js` actually says it's OPEN — so this fix closes a
 * known-open pattern rather than regressing on a closure claim.
 *
 * **The contract.**
 *   loadYamlFile(path) → { data, error }
 *   loadJsonFile(path) → { data, error }
 *   loadYamlDir(dir, { recursive }) → { entries: [{path, data}], skipped: [{path, error}] }
 *   loadJsonDir(dir, { recursive }) → same shape
 *
 * - On success: `data` is the parsed payload, `error` is `null`.
 * - On failure: `data` is `null`, `error` is a string ("YAML parse error: …",
 *   "JSON parse error: …", "Read error: …" etc.). The caller can log the
 *   structured skip, fail loud, or continue — but never silently disappear.
 * - This is the same shape `validate.js parseFinding` returns, deliberately
 *   so existing consumers can swap in this helper without reshaping.
 *
 * **What this is NOT.** This is not a schema validator. It only does the
 * read+parse step. Schema validation lives in `validate.js` for findings
 * and in `@dogfood-lab/schemas` for the other contracts.
 *
 * **Concurrency.** No locking — this is a pure read helper. Callers that
 * need atomicity layer `withFileLock` on top (see `review/event-log.js
 * appendEvent`).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import yaml from 'js-yaml';

/**
 * Parse a YAML file. Returns `{ data, error }` — never throws for parse or
 * read failures.
 *
 * @param {string} filePath - Absolute path to a YAML file.
 * @returns {{ data: unknown, error: string | null }}
 */
export function loadYamlFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { data: null, error: `Read error: ${err.message}` };
  }
  try {
    const data = yaml.load(raw);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: `YAML parse error: ${err.message}` };
  }
}

/**
 * Parse a JSON file. Returns `{ data, error }` — never throws for parse or
 * read failures.
 *
 * @param {string} filePath - Absolute path to a JSON file.
 * @returns {{ data: unknown, error: string | null }}
 */
export function loadJsonFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { data: null, error: `Read error: ${err.message}` };
  }
  try {
    const data = JSON.parse(raw);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: `JSON parse error: ${err.message}` };
  }
}

/**
 * Walk a directory tree and load every matching file using `loadFile`.
 *
 * Returns `{ entries, skipped }`:
 *   - `entries`: `[{ path, data }]` — successful loads.
 *   - `skipped`: `[{ path, error }]` — files that couldn't be read or parsed,
 *     each with a structured error string. The caller decides whether to
 *     log, throw, or just count.
 *
 * If `dir` does not exist, returns `{ entries: [], skipped: [] }` (an empty
 * directory is not an error).
 *
 * If `readdirSync` or `statSync` on a child throws, the child is recorded in
 * `skipped` rather than aborting the whole walk. A torn permission on one
 * subdir cannot make sibling subdirs disappear.
 *
 * @param {string} dir - Absolute path to the directory.
 * @param {{ recursive?: boolean, ext?: string, loadFile?: (path: string) => { data: unknown, error: string | null } }} [opts]
 * @returns {{ entries: Array<{ path: string, data: unknown }>, skipped: Array<{ path: string, error: string }> }}
 */
function walkDir(dir, { recursive = true, ext = '.yaml', loadFile = loadYamlFile } = {}) {
  const entries = [];
  const skipped = [];

  if (!existsSync(dir)) return { entries, skipped };

  function visit(d) {
    let children;
    try {
      children = readdirSync(d);
    } catch (err) {
      skipped.push({ path: d, error: `readdir error: ${err.message}` });
      return;
    }
    for (const child of children) {
      const full = join(d, child);
      let stat;
      try {
        stat = statSync(full);
      } catch (err) {
        skipped.push({ path: full, error: `stat error: ${err.message}` });
        continue;
      }
      if (stat.isDirectory()) {
        if (recursive) visit(full);
        continue;
      }
      if (extname(child) !== ext) continue;
      const { data, error } = loadFile(full);
      if (error !== null) {
        skipped.push({ path: full, error });
      } else {
        entries.push({ path: full, data });
      }
    }
  }

  visit(dir);
  return { entries, skipped };
}

/**
 * Walk a directory tree and load every `.yaml` file. See `walkDir` for shape.
 *
 * @param {string} dir
 * @param {{ recursive?: boolean }} [opts]
 * @returns {{ entries: Array<{ path: string, data: unknown }>, skipped: Array<{ path: string, error: string }> }}
 */
export function loadYamlDir(dir, opts = {}) {
  return walkDir(dir, { ...opts, ext: '.yaml', loadFile: loadYamlFile });
}

/**
 * Walk a directory tree and load every `.json` file. See `walkDir` for shape.
 *
 * @param {string} dir
 * @param {{ recursive?: boolean }} [opts]
 * @returns {{ entries: Array<{ path: string, data: unknown }>, skipped: Array<{ path: string, error: string }> }}
 */
export function loadJsonDir(dir, opts = {}) {
  return walkDir(dir, { ...opts, ext: '.json', loadFile: loadJsonFile });
}
