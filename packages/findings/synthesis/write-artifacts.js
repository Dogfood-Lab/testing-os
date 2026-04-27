/**
 * Write pattern, recommendation, and doctrine artifacts to disk.
 */

import { mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';

import { atomicWriteFileSync } from '../lib/atomic-write.js';

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
 * Load all patterns from disk.
 */
export function loadPatterns(rootDir) {
  return loadArtifacts(resolve(rootDir, 'patterns'));
}

/**
 * Load all recommendations from disk.
 */
export function loadRecommendations(rootDir) {
  return loadArtifacts(resolve(rootDir, 'recommendations'));
}

/**
 * Load all doctrines from disk.
 */
export function loadDoctrines(rootDir) {
  return loadArtifacts(resolve(rootDir, 'doctrine'));
}

function loadArtifacts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.yaml'))
    .map(f => {
      try {
        return yaml.load(readFileSync(join(dir, f), 'utf-8'));
      } catch { return null; }
    })
    .filter(Boolean);
}
