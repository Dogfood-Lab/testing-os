/**
 * Write pattern, recommendation, and doctrine artifacts to disk.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { atomicWriteFileSync } from '../lib/atomic-write.js';
import { loadYamlDir } from '../lib/safe-yaml-load.js';

/**
 * Write a pattern to disk.
 */
export function writePattern(rootDir, pattern) {
  const dir = resolve(rootDir, 'patterns');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${pattern.pattern_id}.yaml`);
  atomicWriteFileSync(path, yaml.dump(JSON.parse(JSON.stringify(pattern)), { lineWidth: 120, noRefs: true }));
  return path;
}

/**
 * Write a recommendation to disk.
 */
export function writeRecommendation(rootDir, rec) {
  const dir = resolve(rootDir, 'recommendations');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${rec.recommendation_id}.yaml`);
  atomicWriteFileSync(path, yaml.dump(JSON.parse(JSON.stringify(rec)), { lineWidth: 120, noRefs: true }));
  return path;
}

/**
 * Write a doctrine to disk.
 */
export function writeDoctrine(rootDir, doc) {
  const dir = resolve(rootDir, 'doctrine');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${doc.doctrine_id}.yaml`);
  atomicWriteFileSync(path, yaml.dump(JSON.parse(JSON.stringify(doc)), { lineWidth: 120, noRefs: true }));
  return path;
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
