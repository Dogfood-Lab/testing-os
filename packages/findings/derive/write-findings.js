/**
 * Write derived candidate findings to disk as YAML files.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import yaml from 'js-yaml';

import { atomicWriteFileSync } from '../lib/atomic-write.js';

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
  const [org, repo] = (finding.repo || '').split('/');
  if (!org || !repo) throw new Error(`Invalid repo in finding: ${finding.repo}`);

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
  return filePath;
}

/**
 * Write multiple findings and return write stats.
 *
 * @param {string} rootDir
 * @param {Array} findings
 * @returns {{ written: string[], errors: Array<{ findingId: string, error: string }> }}
 */
export function writeFindings(rootDir, findings) {
  const written = [];
  const errors = [];

  for (const f of findings) {
    try {
      const path = writeFinding(rootDir, f);
      written.push(path);
    } catch (err) {
      errors.push({ findingId: f.finding_id, error: err.message });
    }
  }

  return { written, errors };
}
