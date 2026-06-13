/**
 * Regression pin parser.
 *
 * Scans a directory tree for `F-NNNNNN-NNN` finding-id comment pins in source
 * and test files, returning two maps that the always-on CI gate (Class #14)
 * consumes to enforce "every fixed F-id has a regression test that would have
 * caught the bug."
 *
 * The convention pinned by this parser is:
 *
 *   ```js
 *   // F-721047-004 — POLICIES_ROOT is the parent of all per-org dirs.
 *   ```
 *
 * Either a leading-comment line or an in-test marker like
 * `describe('… (F-721047-001)', …)` counts as a pin. Both source files and
 * test files can carry pins; the CI gate cross-references the two maps.
 *
 * Design constraints:
 *   - JSON-serializable output so the FT-BACKEND-002 `swarm verify-fixed`
 *     command can join its delta against this parser's emit.
 *   - File classification is path-based (`*.test.js|ts|mjs` or any path that
 *     contains `/test/` is "test"; everything else is "source"). Mirrors the
 *     existing portfolio/loadPolicies() walk style — no glob library, plain
 *     readdirSync recursion.
 *   - Skips `node_modules`, `dist`, `.git`, `coverage`, and any directory
 *     whose name starts with `.` (covers `.claude`, `.next`, etc.).
 *
 * Companion to FT-BACKEND-002 (`swarm verify-fixed` runtime check) and
 * FT-OUTPUTS-001 (this commit-time check). Together they operationalize
 * Class #14 (claimed-fixed without verification) — the runtime gate runs
 * on demand, this parser feeds the always-on CI gate.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, sep, posix } from 'node:path';

/**
 * Strict F-id pattern. Six digits, dash, three digits — matches the
 * convention every fix in this repo has used since the dogfood-labs era.
 */
export const F_ID_PATTERN = /F-\d{6}-\d{3}/g;

/**
 * Less-strict shape detector for "looks like a finding id but isn't" so the
 * parser can deliberately skip prose F-005 / F-XXX-yyy / F-12-345 style refs
 * without having to enumerate them.
 */
const F_ID_PROSE_HINT = /F-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?/g;

const DEFAULT_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.vitest',
]);

/**
 * Posixify a filesystem path at a serialization/classification boundary.
 *
 * Normalizes BOTH separators: split() on the local `sep` handles host paths,
 * but Windows paths (`C:\repo\...`) seen on Linux still contain backslashes
 * verbatim, so the trailing `replace(/\\/g, '/')` catches those too. On Linux
 * `sep === '/'` makes the split-join a no-op and the replace does the work; on
 * Windows the split-join does the work. Idempotent on already-posix paths.
 *
 * SEED-1 (d3-ingest-005): used by walkSourceFiles before storing a path so the
 * Maps / toJSON output (and thus the committed regression-pin index) are
 * forward-slash regardless of host OS. Previously this transform lived inline
 * only in classifyFile and the STORED paths never reused it — that gap was the
 * leak. Hoisted to a named helper so the one transform has one home.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function posixifyPath(filePath) {
  return filePath.split(sep).join(posix.sep).replace(/\\/g, '/');
}

/**
 * Classify a path as "test" or "source" by convention. Mirrors how
 * `node --test` and `vitest` discover tests in this repo.
 */
export function classifyFile(filePath) {
  // Normalize BOTH separators (see posixifyPath) so the regex/includes checks
  // below work cross-platform. (feedback_audit_path_sep_blind_spot — Linux
  // runners were missing windows-classified test paths because sep === '/' on
  // Linux collapses to a no-op split-join, which is why the replace exists.)
  const normalised = posixifyPath(filePath);
  if (/\.test\.[mc]?[jt]sx?$/.test(normalised)) return 'test';
  if (/\.spec\.[mc]?[jt]sx?$/.test(normalised)) return 'test';
  if (normalised.includes('/test/') || normalised.includes('/tests/')) return 'test';
  if (normalised.includes('/__tests__/')) return 'test';
  return 'source';
}

/**
 * Extract every `F-NNNNNN-NNN` pin from a file's text. Returns a Set so a
 * file that mentions the same id twice (header comment + describe block,
 * say) only counts once per file.
 */
export function extractPinsFromText(text) {
  const pins = new Set();
  const matches = text.match(F_ID_PATTERN);
  if (!matches) return pins;
  for (const m of matches) pins.add(m);
  return pins;
}

/**
 * Recursively walk `rootDir`, returning the absolute paths of files whose
 * extension is in `extensions`. Same readdirSync-with-withFileTypes pattern
 * used by `loadPolicies()` — no glob lib needed.
 *
 * @param {string} rootDir
 * @param {object} [opts]
 * @param {Set<string>} [opts.extensions] - Allowed file extensions (with leading dot).
 * @param {Set<string>} [opts.skipDirs]   - Directory basenames to skip.
 * @returns {string[]}
 */
export function walkSourceFiles(rootDir, { extensions = DEFAULT_SOURCE_EXTENSIONS, skipDirs = DEFAULT_SKIP_DIRS } = {}) {
  const out = [];
  if (!existsSync(rootDir)) return out;

  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        // Hide-dot convention: skip .claude/.vscode/.idea etc. unless the
        // caller explicitly opted them in via a custom skipDirs.
        if (entry.name.startsWith('.') && !skipDirs.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const dotIdx = entry.name.lastIndexOf('.');
      if (dotIdx === -1) continue;
      const ext = entry.name.slice(dotIdx);
      if (!extensions.has(ext)) continue;
      // SEED-1 (d3-ingest-005) — posixify at the serialization boundary.
      // These paths become the KEYS/VALUES of parseRegressionPins()'s
      // source_pins/test_pins Maps and are copied verbatim by toJSON() into
      // the committed docs/regression-pin-index.json when
      // check-finding-regression-pins.mjs runs with --write-index. On win32,
      // `join()` yields backslashes, so without this a Windows regeneration
      // commits backslash paths that a Linux-run delta-join silently
      // mismatches. Normalize ONCE here, reusing the exact transform
      // classifyFile() applies one function above (line ~75). NEVER a
      // win32-skip. (The `stack` keeps OS-native paths — readdirSync handles
      // those fine; only the STORED output crosses into serialized state.)
      out.push(posixifyPath(fullPath));
    }
  }

  out.sort();
  return out;
}

/**
 * Scan `rootDir` for F-id pins and bucket them by source vs test.
 *
 * @param {string} rootDir - Absolute path to the directory to scan.
 * @param {object} [opts]
 * @param {Set<string>} [opts.extensions] - Override the file-extension allowlist.
 * @param {Set<string>} [opts.skipDirs]   - Override the directory-skip set.
 * @returns {{
 *   source_pins: Map<string, string[]>,
 *   test_pins:   Map<string, string[]>,
 *   files_scanned: number
 * }} Map keys are the F-id strings (e.g. `"F-721047-001"`); values are
 *    sorted, deduplicated arrays of absolute file paths.
 */
export function parseRegressionPins(rootDir, opts = {}) {
  const sourcePins = new Map();
  const testPins = new Map();

  if (!existsSync(rootDir)) {
    return { source_pins: sourcePins, test_pins: testPins, files_scanned: 0 };
  }

  const stat = statSync(rootDir);
  if (!stat.isDirectory()) {
    return { source_pins: sourcePins, test_pins: testPins, files_scanned: 0 };
  }

  const files = walkSourceFiles(rootDir, opts);
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const pins = extractPinsFromText(text);
    if (pins.size === 0) continue;
    const bucket = classifyFile(file) === 'test' ? testPins : sourcePins;
    for (const pin of pins) {
      const arr = bucket.get(pin);
      if (arr) {
        if (!arr.includes(file)) arr.push(file);
      } else {
        bucket.set(pin, [file]);
      }
    }
  }

  // Stable order — both for human-readable index output and for snapshot tests.
  for (const map of [sourcePins, testPins]) {
    for (const [, arr] of map) arr.sort();
  }

  return {
    source_pins: sourcePins,
    test_pins: testPins,
    files_scanned: files.length,
  };
}

/**
 * Convert the Map-shaped result of {@link parseRegressionPins} into a plain
 * JSON-serializable object so the CI gate, the docs/regression-pin-index.json
 * generator, and the `swarm verify-fixed` delta join can all consume the same
 * payload without import-time coupling.
 *
 * @param {ReturnType<typeof parseRegressionPins>} result
 * @returns {{
 *   source_pins: Record<string, string[]>,
 *   test_pins:   Record<string, string[]>,
 *   files_scanned: number,
 *   summary: { source_ids: number, test_ids: number, orphan_source_ids: string[] }
 * }} `orphan_source_ids` lists every F-id present in source with no matching
 *    test pin — the exact failure-case the CI gate must fail on.
 */
export function toJSON(result) {
  const sourceObj = {};
  const testObj = {};
  for (const [k, v] of result.source_pins) sourceObj[k] = [...v];
  for (const [k, v] of result.test_pins) testObj[k] = [...v];

  const orphan = [];
  for (const id of Object.keys(sourceObj)) {
    if (!(id in testObj)) orphan.push(id);
  }
  orphan.sort();

  return {
    source_pins: sourceObj,
    test_pins: testObj,
    files_scanned: result.files_scanned,
    summary: {
      source_ids: Object.keys(sourceObj).length,
      test_ids: Object.keys(testObj).length,
      orphan_source_ids: orphan,
    },
  };
}
