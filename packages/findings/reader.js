/**
 * Finding reader/lister.
 * Discovers findings from the filesystem, supports filtering and lookup.
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, basename, extname, relative } from 'node:path';
import { parseFinding, validateFinding } from './validate.js';

/**
 * Discover all .yaml finding files under a root directory.
 * Walks findings/<org>/<repo>/*.yaml
 *
 * @param {string} rootDir - The dogfood-labs repo root.
 * @returns {string[]} Array of absolute paths to finding files.
 */
export function discoverFindings(rootDir) {
  const findingsDir = resolve(rootDir, 'findings');
  if (!existsSync(findingsDir)) return [];

  const paths = [];

  // Walk: findings/<org>/<repo>/*.yaml
  for (const org of listDirs(findingsDir)) {
    const orgDir = join(findingsDir, org);
    for (const repo of listDirs(orgDir)) {
      const repoDir = join(orgDir, repo);
      // Leaf-IO guard (B002): the two OUTER levels go through `listDirs`, whose
      // statSync is wrapped in try/catch so one unreadable dir is skipped. The
      // innermost leaf read was bare — a single repo dir going unreadable
      // (EACCES on a locked/permission-restricted dir, an ENOTDIR, a transient
      // FS error) would throw an unstructured Node stack out of discoverFindings
      // and hence out of every consumer (validate / list / derivePatterns /
      // advise / review queue), so one bad directory sank discovery for EVERY
      // other repo. Mirror the package standard (load-records.js
      // walkRecordsWithSkips, lib/safe-yaml-load.js walkDir): skip the bad
      // repoDir instead of throwing, and name it on stderr so the operator sees
      // WHICH directory was unreadable in CI logs rather than a raw stack.
      for (const file of listLeafFiles(repoDir)) {
        if (extname(file) === '.yaml') {
          paths.push(resolve(repoDir, file));
        }
      }
    }
  }

  return paths.sort();
}

/**
 * List the immediate entries of a leaf repo directory, guarding the bare
 * `readdirSync` against EACCES/ENOTDIR/transient FS errors.
 *
 * On error the directory is SKIPPED (returns `[]`) rather than throwing, and a
 * structured line naming the offending path is written to stderr so the failure
 * is operator-visible in CI logs. `discoverFindings` returns a `string[]` of
 * paths (no structured-skip channel rides the return shape), so this mirrors
 * the `findRecordFile` precedent (derive/load-records.js) of surfacing the skip
 * via stderr rather than silently swallowing it — a bad directory must not sink
 * discovery for every other repo, but it must also not vanish without a trace.
 *
 * Exported (package-internal) so the B002 leaf-IO guard can be exercised
 * directly with a real, portable readdir error (readdir on a non-directory
 * throws ENOTDIR on every platform), since the listDirs+leaf walk couples
 * statSync and readdirSync such that the failure cannot be staged through the
 * full walk cross-platform.
 *
 * @param {string} repoDir - Absolute path to a findings/<org>/<repo> directory.
 * @returns {string[]} Entry names, or `[]` if the directory could not be read.
 */
export function listLeafFiles(repoDir) {
  try {
    return readdirSync(repoDir);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `discoverFindings: skipping unreadable findings directory ${repoDir}: ${err.message}. ` +
      `Fix the directory's permissions/state and re-run; other repos were still discovered.`
    );
    return [];
  }
}

/**
 * Discover finding files from fixtures directory.
 * @param {string} rootDir - The dogfood-labs repo root.
 * @param {'valid' | 'invalid'} kind - Which fixture set.
 * @returns {string[]} Array of absolute paths.
 */
export function discoverFixtures(rootDir, kind) {
  const dir = resolve(rootDir, 'fixtures', 'findings', kind);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => extname(f) === '.yaml')
    .map(f => resolve(dir, f))
    .sort();
}

/**
 * Load all findings from disk (real or fixtures).
 * Returns parsed + validated findings.
 *
 * @param {string} rootDir - The dogfood-labs repo root.
 * @param {{ fixtures?: boolean, fixtureKind?: 'valid' | 'invalid' }} opts
 * @returns {Array<{ path: string, data: object | null, valid: boolean, errors: Array }>}
 */
export function loadFindings(rootDir, opts = {}) {
  const paths = opts.fixtures
    ? discoverFixtures(rootDir, opts.fixtureKind || 'valid')
    : discoverFindings(rootDir);

  return paths.map(filePath => {
    const { data, error } = parseFinding(filePath);
    if (error) {
      return { path: filePath, data: null, valid: false, errors: [{ path: '/', message: error }] };
    }
    const result = validateFinding(data);
    return { path: filePath, data, ...result };
  });
}

/**
 * Find a single finding by its finding_id.
 * Searches real findings first, then fixtures.
 *
 * @param {string} rootDir - The dogfood-labs repo root.
 * @param {string} findingId - The finding_id to look up.
 * @returns {{ path: string, data: object, valid: boolean, errors: Array } | null}
 */
export function findById(rootDir, findingId) {
  // B-002 — collect torn finding files encountered during the scan. The
  // finding_id lives INSIDE the file, so a torn file cannot be matched to the
  // requested id; if the id turns out absent from every clean file, any torn
  // file may be the one hiding it. Surfacing them on stderr (below) mirrors the
  // derive CLI's "N finding(s) skipped (torn/unreadable)" honesty so a torn
  // YAML never silently masquerades as a not-found id.
  const torn = [];

  // Search real findings
  for (const filePath of discoverFindings(rootDir)) {
    const { data, error } = parseFinding(filePath);
    if (error) {
      torn.push({ path: filePath, error });
      continue;
    }
    if (data && data.finding_id === findingId) {
      const result = validateFinding(data);
      return { path: filePath, data, ...result };
    }
  }

  // Search valid fixtures
  for (const filePath of discoverFixtures(rootDir, 'valid')) {
    const { data, error } = parseFinding(filePath);
    if (error) {
      torn.push({ path: filePath, error });
      continue;
    }
    if (data && data.finding_id === findingId) {
      const result = validateFinding(data);
      return { path: filePath, data, ...result };
    }
  }

  if (torn.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`${torn.length} finding(s) skipped (torn/unreadable):`);
    for (const t of torn) {
      // eslint-disable-next-line no-console
      console.error(`  ${relative(rootDir, t.path)} — ${t.error}`);
    }
  }

  return null;
}

/**
 * Filter a list of loaded findings.
 *
 * @param {Array<{ data: object }>} findings - Loaded findings.
 * @param {{ repo?: string, status?: string, surface?: string, issueKind?: string, transferScope?: string }} filters
 * @returns {Array}
 */
export function filterFindings(findings, filters = {}) {
  return findings.filter(f => {
    if (!f.data) return false;
    if (filters.repo && f.data.repo !== filters.repo) return false;
    if (filters.status && f.data.status !== filters.status) return false;
    if (filters.surface && f.data.product_surface !== filters.surface) return false;
    if (filters.issueKind && f.data.issue_kind !== filters.issueKind) return false;
    if (filters.transferScope && f.data.transfer_scope !== filters.transferScope) return false;
    return true;
  });
}

/**
 * Check for duplicate finding_ids across all findings.
 * @param {Array<{ data: object, path: string }>} findings
 * @returns {Array<{ findingId: string, paths: string[] }>}
 */
export function findDuplicates(findings) {
  const seen = new Map();
  for (const f of findings) {
    if (!f.data || !f.data.finding_id) continue;
    const id = f.data.finding_id;
    if (!seen.has(id)) seen.set(id, []);
    seen.get(id).push(f.path);
  }

  return Array.from(seen.entries())
    .filter(([, paths]) => paths.length > 1)
    .map(([findingId, paths]) => ({ findingId, paths }));
}

/** List subdirectories of a directory. */
function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}
