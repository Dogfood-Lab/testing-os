/**
 * Write pattern, recommendation, and doctrine artifacts to disk.
 *
 * D2B-008 sibling family — these singleton writers (`writePattern`,
 * `writeRecommendation`, `writeDoctrine`) share the same id-then-write
 * pattern as the finding writer, and so share the same intra-batch
 * collision class when used in a loop (which the CLI does at
 * packages/findings/cli.js:665-672 / :728-732 / :789-793). The batch
 * helpers `writePatterns` / `writeRecommendations` / `writeDoctrines`
 * mirror `writeFindings(rootDir, findings)`: record the first occurrence
 * per id, refuse subsequent colliders with a structured
 * `PATTERN_ID_COLLISION` / `RECOMMENDATION_ID_COLLISION` /
 * `DOCTRINE_ID_COLLISION` error, return `{ written, errors }`. Callers
 * (CLI / programmatic) check `errors.length > 0` to surface non-zero.
 *
 * L3-001 (Wave A2 amend2 — family seal). The SINGLETON writers had the
 * same silent-clobber class as the singleton `writeFinding`: a second
 * call with the same id silently overwrote via atomicWriteFileSync. The
 * fail-closed guard now lives at the singleton AND batch path via a
 * shared process-level `seenArtifactWrites` Map keyed by
 * `${rootDir}:${kind}:${id}`. Second-with-same-id throws a typed
 * `*IdCollisionError`; batch path collects into errors[]. Operator
 * opt-in for legitimate re-write is `resetSeenArtifactWrites(rootDir?)`.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { atomicWriteFileSync } from '../lib/atomic-write.js';
import { loadYamlDir } from '../lib/safe-yaml-load.js';
import { validatePattern, validateRecommendation, validateDoctrine } from './validate-artifacts.js';

/**
 * Process-level memory of artifact ids written via the singletons (and
 * via the singleton-call inside the batch helpers). Keyed by
 * `${rootDir}:${kind}:${id}` so callers writing to distinct roots /
 * kinds don't collide.
 *
 * L3-001 family-seal of D2B-008.
 */
const seenArtifactWrites = new Map();

/**
 * Reset the artifact-singleton's in-process collision memory. Mirrors
 * `resetSeenWrites` in derive/write-findings.js. Pass a `rootDir` to
 * clear only entries scoped to that root.
 *
 * @param {string} [rootDir]
 */
export function resetSeenArtifactWrites(rootDir) {
  if (rootDir === undefined) {
    seenArtifactWrites.clear();
    return;
  }
  const prefix = `${rootDir}:`;
  for (const key of seenArtifactWrites.keys()) {
    if (key.startsWith(prefix)) seenArtifactWrites.delete(key);
  }
}

/**
 * Structured collision errors thrown by the singleton writers when called
 * twice in the same process with the same id. Mirror the batch helpers'
 * collision codes so the operator-facing vocabulary is identical.
 */
export class PatternIdCollisionError extends Error {
  constructor(patternId) {
    super(`pattern_id collision: '${patternId}' already written in this process; refused to silently clobber (D2B-008 / L3-001 family-seal). Call resetSeenArtifactWrites() if a legitimate re-write is intended.`);
    this.name = 'PatternIdCollisionError';
    this.code = 'PATTERN_ID_COLLISION';
    this.patternId = patternId;
  }
}

export class RecommendationIdCollisionError extends Error {
  constructor(recommendationId) {
    super(`recommendation_id collision: '${recommendationId}' already written in this process; refused to silently clobber (D2B-008 / L3-001 family-seal). Call resetSeenArtifactWrites() if a legitimate re-write is intended.`);
    this.name = 'RecommendationIdCollisionError';
    this.code = 'RECOMMENDATION_ID_COLLISION';
    this.recommendationId = recommendationId;
  }
}

export class DoctrineIdCollisionError extends Error {
  constructor(doctrineId) {
    super(`doctrine_id collision: '${doctrineId}' already written in this process; refused to silently clobber (D2B-008 / L3-001 family-seal). Call resetSeenArtifactWrites() if a legitimate re-write is intended.`);
    this.name = 'DoctrineIdCollisionError';
    this.code = 'DOCTRINE_ID_COLLISION';
    this.doctrineId = doctrineId;
  }
}

/**
 * Structured validation-error classes for the synthesis writers. Mirror
 * `FindingValidationError` in derive/write-findings.js and
 * `RecordValidationError` in @dogfood-lab/ingest/validate-record.js — typed
 * with `.code` so callers can pattern-match. D2B-002.
 */
export class PatternValidationError extends Error {
  constructor(errors, patternId) {
    super(`pattern failed schema validation${patternId ? ` (${patternId})` : ''}: ${errors.map(e => `${e.path || '/'} ${e.message}`).join('; ')}`);
    this.name = 'PatternValidationError';
    this.code = 'PATTERN_SCHEMA_INVALID';
    this.patternId = patternId;
    this.errors = errors;
  }
}

export class RecommendationValidationError extends Error {
  constructor(errors, recommendationId) {
    super(`recommendation failed schema validation${recommendationId ? ` (${recommendationId})` : ''}: ${errors.map(e => `${e.path || '/'} ${e.message}`).join('; ')}`);
    this.name = 'RecommendationValidationError';
    this.code = 'RECOMMENDATION_SCHEMA_INVALID';
    this.recommendationId = recommendationId;
    this.errors = errors;
  }
}

export class DoctrineValidationError extends Error {
  constructor(errors, doctrineId) {
    super(`doctrine failed schema validation${doctrineId ? ` (${doctrineId})` : ''}: ${errors.map(e => `${e.path || '/'} ${e.message}`).join('; ')}`);
    this.name = 'DoctrineValidationError';
    this.code = 'DOCTRINE_SCHEMA_INVALID';
    this.doctrineId = doctrineId;
    this.errors = errors;
  }
}

/**
 * Write a pattern to disk.
 *
 * D2B-002 — fail-closed schema gate BEFORE touching the filesystem. The CLI
 * had NO validation here at HEAD (worse than `writeFinding`, which had at
 * least the CLI-side gate). Now neither the CLI nor any programmatic caller
 * can persist a malformed pattern.
 *
 * L3-001 — same-process same-id refusal (family seal of D2B-008).
 */
export function writePattern(rootDir, pattern) {
  const v = validatePattern(pattern);
  if (!v.valid) throw new PatternValidationError(v.errors, pattern?.pattern_id);

  const id = pattern?.pattern_id;
  if (id !== undefined && id !== null) {
    const key = `${rootDir}:pattern:${id}`;
    if (seenArtifactWrites.has(key)) throw new PatternIdCollisionError(id);
  }

  const dir = resolve(rootDir, 'patterns');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${pattern.pattern_id}.yaml`);
  atomicWriteFileSync(path, yaml.dump(JSON.parse(JSON.stringify(pattern)), { lineWidth: 120, noRefs: true }));

  if (id !== undefined && id !== null) seenArtifactWrites.set(`${rootDir}:pattern:${id}`, true);
  return path;
}

/**
 * Write a recommendation to disk.
 *
 * D2B-002 — fail-closed schema gate.
 * L3-001 — same-process same-id refusal (family seal of D2B-008).
 */
export function writeRecommendation(rootDir, rec) {
  const v = validateRecommendation(rec);
  if (!v.valid) throw new RecommendationValidationError(v.errors, rec?.recommendation_id);

  const id = rec?.recommendation_id;
  if (id !== undefined && id !== null) {
    const key = `${rootDir}:recommendation:${id}`;
    if (seenArtifactWrites.has(key)) throw new RecommendationIdCollisionError(id);
  }

  const dir = resolve(rootDir, 'recommendations');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${rec.recommendation_id}.yaml`);
  atomicWriteFileSync(path, yaml.dump(JSON.parse(JSON.stringify(rec)), { lineWidth: 120, noRefs: true }));

  if (id !== undefined && id !== null) seenArtifactWrites.set(`${rootDir}:recommendation:${id}`, true);
  return path;
}

/**
 * Write a doctrine to disk.
 *
 * D2B-002 — fail-closed schema gate.
 * L3-001 — same-process same-id refusal (family seal of D2B-008).
 */
export function writeDoctrine(rootDir, doc) {
  const v = validateDoctrine(doc);
  if (!v.valid) throw new DoctrineValidationError(v.errors, doc?.doctrine_id);

  const id = doc?.doctrine_id;
  if (id !== undefined && id !== null) {
    const key = `${rootDir}:doctrine:${id}`;
    if (seenArtifactWrites.has(key)) throw new DoctrineIdCollisionError(id);
  }

  const dir = resolve(rootDir, 'doctrine');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${doc.doctrine_id}.yaml`);
  atomicWriteFileSync(path, yaml.dump(JSON.parse(JSON.stringify(doc)), { lineWidth: 120, noRefs: true }));

  if (id !== undefined && id !== null) seenArtifactWrites.set(`${rootDir}:doctrine:${id}`, true);
  return path;
}

/**
 * Internal — generic batch writer with intra-batch id-collision guard.
 *
 * @template T
 * @param {Array<T>} items
 * @param {(item: T) => string | undefined} getId
 * @param {(item: T) => string} doWrite - performs the write, returns path
 * @param {string} idLabel - error-field name on the error record (e.g. 'patternId')
 * @param {string} code - structured collision code (e.g. 'PATTERN_ID_COLLISION')
 * @returns {{ written: string[], errors: Array<object> }}
 */
function writeBatch(items, getId, doWrite, idLabel, code) {
  const written = [];
  const errors = [];
  const seen = new Map(); // id → index of first occurrence

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = getId(item);

    if (id !== undefined && id !== null && seen.has(id)) {
      const firstIdx = seen.get(id);
      errors.push({
        [idLabel]: id,
        code,
        error: `intra-batch ${idLabel.replace(/Id$/, '_id')} collision: '${id}' already claimed by index ${firstIdx}; refused write at index ${i} to avoid silent clobber (D2B-008)`
      });
      continue;
    }

    try {
      const path = doWrite(item);
      written.push(path);
      if (id !== undefined && id !== null) seen.set(id, i);
    } catch (err) {
      // D2B-002 — preserve structured codes
      // (PATTERN_SCHEMA_INVALID etc.) so batch callers see the same
      // vocabulary as singleton callers.
      const errRec = { [idLabel]: id, error: err.message };
      if (err && err.code) errRec.code = err.code;
      errors.push(errRec);
    }
  }

  return { written, errors };
}

/**
 * Write multiple patterns to disk, refusing intra-batch `pattern_id` collision.
 * See file header for D2B-008 rationale.
 *
 * @param {string} rootDir
 * @param {Array} patterns
 * @returns {{ written: string[], errors: Array<{ patternId?: string, code?: string, error: string }> }}
 */
export function writePatterns(rootDir, patterns) {
  return writeBatch(
    patterns,
    p => p?.pattern_id,
    p => writePattern(rootDir, p),
    'patternId',
    'PATTERN_ID_COLLISION'
  );
}

/**
 * Write multiple recommendations to disk, refusing intra-batch
 * `recommendation_id` collision. See file header for D2B-008 rationale.
 *
 * @param {string} rootDir
 * @param {Array} recommendations
 * @returns {{ written: string[], errors: Array<{ recommendationId?: string, code?: string, error: string }> }}
 */
export function writeRecommendations(rootDir, recommendations) {
  return writeBatch(
    recommendations,
    r => r?.recommendation_id,
    r => writeRecommendation(rootDir, r),
    'recommendationId',
    'RECOMMENDATION_ID_COLLISION'
  );
}

/**
 * Write multiple doctrines to disk, refusing intra-batch `doctrine_id`
 * collision. See file header for D2B-008 rationale.
 *
 * @param {string} rootDir
 * @param {Array} doctrines
 * @returns {{ written: string[], errors: Array<{ doctrineId?: string, code?: string, error: string }> }}
 */
export function writeDoctrines(rootDir, doctrines) {
  return writeBatch(
    doctrines,
    d => d?.doctrine_id,
    d => writeDoctrine(rootDir, d),
    'doctrineId',
    'DOCTRINE_ID_COLLISION'
  );
}

/**
 * Load all patterns from disk (legacy array shape).
 *
 * Torn pattern YAML files are NO LONGER silently dropped — they surface
 * via `loadPatternsWithSkips`. H2 / F-721047-010 — silent-loader closure.
 */
export function loadPatterns(rootDir) {
  return loadPatternsWithSkips(rootDir).entries.map(e => e.data);
}

/**
 * Load all recommendations from disk (legacy array shape).
 *
 * Torn recommendation YAML files are NO LONGER silently dropped — they
 * surface via `loadRecommendationsWithSkips`. H2 / F-721047-010.
 */
export function loadRecommendations(rootDir) {
  return loadRecommendationsWithSkips(rootDir).entries.map(e => e.data);
}

/**
 * Load all doctrines from disk (legacy array shape).
 *
 * Torn doctrine YAML files are NO LONGER silently dropped — they surface
 * via `loadDoctrinesWithSkips`. H2 / F-721047-010.
 */
export function loadDoctrines(rootDir) {
  return loadDoctrinesWithSkips(rootDir).entries.map(e => e.data);
}

/**
 * Audit-honesty loaders: surface structured skip records for any torn
 * artifact YAML files.
 *
 * @param {string} rootDir
 * @returns {{ entries: Array<{ path: string, data: object }>, skipped: Array<{ path: string, error: string }> }}
 */
export function loadPatternsWithSkips(rootDir) {
  return loadYamlDir(resolve(rootDir, 'patterns'), { recursive: false });
}

export function loadRecommendationsWithSkips(rootDir) {
  return loadYamlDir(resolve(rootDir, 'recommendations'), { recursive: false });
}

export function loadDoctrinesWithSkips(rootDir) {
  return loadYamlDir(resolve(rootDir, 'doctrine'), { recursive: false });
}
