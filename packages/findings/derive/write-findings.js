/**
 * Write derived candidate findings to disk as YAML files.
 *
 * D2B-008 — finding_id collision guard. The id generator
 * (`generateFindingId` → `dfind-<repoSlug>-<lessonSlug>`) does NOT yet
 * discriminate by `rule_id`, so two rules that emit the same lesson slug
 * for the same repo land on the same `finding_id`. AT HEAD a naive batch
 * write silently clobbered the first finding via the atomic temp+rename
 * (operator-invisible data loss). The batch helper `writeFindings` records
 * the first occurrence per id and REFUSES every subsequent write with a
 * structured `FINDING_ID_COLLISION` error routed through the existing
 * `errors[]` channel — the CLI's `if (errors.length > 0) exit(1)` branch
 * then propagates non-zero. The first write still lands so a
 * single-finding batch keeps working.
 *
 * L3-001 (Wave A2 amend2 — family seal). The SINGLETON `writeFinding`
 * had the same silent-clobber class on a different verb: two programmatic
 * calls to `writeFinding(rootDir, finding)` with the same `finding_id`
 * silently overwrote the first via atomicWriteFileSync. The fix-closed
 * guard now lives at the singleton AND batch path via a shared
 * process-level `seenWrites` Map keyed by `${rootDir}:${finding_id}`.
 * Second-with-same-id throws `FindingIdCollisionError` (with `.code =
 * FINDING_ID_COLLISION`); batch path collects into errors[]. The
 * `resetSeenWrites(rootDir?)` helper exists for the narrow case of a
 * caller that legitimately re-writes after an intentional disk wipe
 * (test isolation, etc.).
 *
 * The structural fix (putting `rule_id` into the id slug so collisions
 * stop happening in the first place) is needs-design and deferred to a
 * follow-on wave; this guard is the fail-closed stopgap.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import yaml from 'js-yaml';

import { atomicWriteFileSync } from '../lib/atomic-write.js';
import { validateFinding } from '../validate.js';

/**
 * Structured error thrown when `writeFinding` receives a finding that fails
 * `dogfood-finding.schema.json`. Mirrors `RecordValidationError` in
 * @dogfood-lab/ingest/validate-record.js — typed class with `.code` so
 * callers can pattern-match without grepping `.message`.
 *
 * D2B-002 — library-path schema gate. The CLI already validated via
 * `validateFinding` in `cli.js derive`, but programmatic callers of
 * `writeFinding` had no gate. Now neither can persist a malformed finding.
 */
export class FindingValidationError extends Error {
  constructor(errors, findingId) {
    const summary = errors
      .map(e => `${e.path || '/'} ${e.message}`)
      .join('; ');
    super(`finding failed schema validation${findingId ? ` (${findingId})` : ''}: ${summary}`);
    this.name = 'FindingValidationError';
    this.code = 'FINDING_SCHEMA_INVALID';
    this.findingId = findingId;
    this.errors = errors;
  }
}

/**
 * Structured error thrown by the singleton `writeFinding` when called
 * twice in the same process with the same `finding_id`. Mirrors the
 * batch helper's `FINDING_ID_COLLISION` code (same vocabulary across
 * singleton + batch paths). L3-001 family seal of D2B-008.
 */
export class FindingIdCollisionError extends Error {
  constructor(findingId) {
    super(`finding_id collision: '${findingId}' already written in this process; refused to silently clobber (D2B-008 / L3-001 family-seal). Call resetSeenWrites() if a legitimate re-write is intended.`);
    this.name = 'FindingIdCollisionError';
    this.code = 'FINDING_ID_COLLISION';
    this.findingId = findingId;
  }
}

/**
 * Process-level memory of ids that have already been written via
 * `writeFinding` (singleton) OR the singleton-call inside `writeFindings`
 * (batch). Keyed by `${rootDir}:${finding_id}` so callers writing to
 * distinct roots don't collide and so the test harness's per-test
 * `mkdtempSync` roots are naturally isolated.
 *
 * Exposed as a Map (rather than Set) so test isolation can clear only
 * a single root via `resetSeenWrites(rootDir)`.
 */
const seenWrites = new Map();

/**
 * Reset the singleton's in-process collision memory. Pass a `rootDir` to
 * clear only entries scoped to that root (cheap, narrow); pass nothing
 * to clear everything (only useful for full-process resets in tests).
 *
 * @param {string} [rootDir]
 */
export function resetSeenWrites(rootDir) {
  if (rootDir === undefined) {
    seenWrites.clear();
    return;
  }
  const prefix = `${rootDir}:`;
  for (const key of seenWrites.keys()) {
    if (key.startsWith(prefix)) seenWrites.delete(key);
  }
}

/**
 * Write a candidate finding to its canonical location.
 *
 * findings/<org>/<repo>/<finding_id>.yaml
 *
 * @param {string} rootDir - dogfood-labs repo root.
 * @param {object} finding - Schema-valid candidate finding object.
 * @returns {string} - Path written.
 */
export function writeFinding(rootDir, finding) {
  // D2B-002 — fail-closed schema gate BEFORE touching the filesystem. The
  // CLI already validates via `validateFinding` in `derive`; this protects
  // every other call site (synthesis, review, programmatic, tests) so no
  // path can persist a malformed finding.
  const validation = validateFinding(finding);
  if (!validation.valid) {
    throw new FindingValidationError(validation.errors, finding?.finding_id);
  }

  const [org, repo] = (finding.repo || '').split('/');
  if (!org || !repo) throw new Error(`Invalid repo in finding: ${finding.repo}`);

  // L3-001 (Wave A2 amend2): same-process same-id refusal. Programmatic
  // callers that loop over assembleFinding output now fail-closed at the
  // singleton path, not silently at the atomicWriteFileSync.
  const id = finding.finding_id;
  if (id !== undefined && id !== null) {
    const key = `${rootDir}:${id}`;
    if (seenWrites.has(key)) {
      throw new FindingIdCollisionError(id);
    }
  }

  const dir = resolve(rootDir, 'findings', org, repo);
  mkdirSync(dir, { recursive: true });

  const filePath = resolve(dir, `${finding.finding_id}.yaml`);

  // Strip undefined values for clean YAML
  const clean = JSON.parse(JSON.stringify(finding));
  const yamlStr = yaml.dump(clean, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false
  });

  atomicWriteFileSync(filePath, yamlStr);

  if (id !== undefined && id !== null) {
    seenWrites.set(`${rootDir}:${id}`, true);
  }
  return filePath;
}

/**
 * Write multiple findings to disk, refusing any intra-batch collision on
 * `finding_id`. See file header for the D2B-008 rationale.
 *
 * Returns `{ written, errors }`:
 *   - `written`: paths of findings successfully written (first occurrence per id).
 *   - `errors`: structured records for refused colliding writes (and any
 *      programmatic write failures). Collision records carry
 *      `{ findingId, code: 'FINDING_ID_COLLISION', error }`.
 *
 * The CLI at packages/findings/cli.js:425+ already exits non-zero when
 * `errors.length > 0`, so collisions now break CI rather than silently
 * destroying findings.
 *
 * @param {string} rootDir
 * @param {Array} findings
 * @returns {{ written: string[], errors: Array<{ findingId: string, code?: string, error: string }> }}
 */
export function writeFindings(rootDir, findings) {
  const written = [];
  const errors = [];
  const seenIds = new Map(); // finding_id → index of first occurrence (for debug)

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const id = f.finding_id;

    // Intra-batch collision guard — fail-closed.
    if (id !== undefined && id !== null && seenIds.has(id)) {
      const firstIdx = seenIds.get(id);
      errors.push({
        findingId: id,
        code: 'FINDING_ID_COLLISION',
        error: `intra-batch finding_id collision: '${id}' already claimed by index ${firstIdx}; refused write at index ${i} to avoid silent clobber (D2B-008)`
      });
      continue;
    }

    try {
      const path = writeFinding(rootDir, f);
      written.push(path);
      if (id !== undefined && id !== null) seenIds.set(id, i);
    } catch (err) {
      // D2B-002 — preserve structured codes (FINDING_SCHEMA_INVALID etc.) so
      // batch callers see the same vocabulary as singleton callers.
      const errRec = { findingId: id, error: err.message };
      if (err && err.code) errRec.code = err.code;
      errors.push(errRec);
    }
  }

  return { written, errors };
}
