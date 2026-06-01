/**
 * Finding schema validator.
 * Validates YAML finding files against dogfood-finding.schema.json.
 *
 * H3 hop 2: delegates to the canonical {@link validatePayload} from
 * `@dogfood-lab/schemas`. Pre-H3 this module compiled its own
 * Ajv2020 + ajv-formats instance for the finding schema; that
 * duplicated the verifier's compile path and was the second of four
 * sites contributing to the C1 two-Ajv structural gap. The migration
 * collapses finding-validation to the single cached validator the
 * canonical seam shares with the rest of the workspace.
 *
 * Return contract preserved: `{ valid, errors: [{ path, message, params }] }`.
 * The canonical ValidationError now also carries `keyword`; finding
 * callers don't read it today, but it is forwarded so a downstream
 * consumer that wraps validateFinding (e.g. a future review-time
 * keyword pin parallel to ingest.test.js:208-220) can lean on it.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { validatePayload } from '@dogfood-lab/schemas';

/**
 * Parse a YAML finding file and return the data.
 * @param {string} filePath - Absolute path to a .yaml finding file.
 * @returns {{ data: object | null, error: string | null }}
 */
export function parseFinding(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = yaml.load(raw);
    if (!data || typeof data !== 'object') {
      return { data: null, error: 'File did not parse to an object' };
    }
    return { data, error: null };
  } catch (err) {
    return { data: null, error: `YAML parse error: ${err.message}` };
  }
}

/**
 * Validate a parsed finding object against the schema.
 * @param {object} finding - Parsed finding data.
 * @returns {{ valid: boolean, errors: Array<{ path: string, message: string, keyword?: string, params?: object }> }}
 */
export function validateFinding(finding) {
  // H3: delegate to canonical seam. The pre-H3 implementation manually
  // mapped Ajv.errors → { path, message, params }; canonical does the
  // same and adds `keyword`. Forward the full canonical shape — finding
  // callers consume `path`/`message`/`params` today, and the keyword
  // forward keeps the door open for future review-side keyword pins.
  return validatePayload('finding', finding);
}

/**
 * Parse and validate a YAML finding file in one call.
 * @param {string} filePath - Absolute path to a .yaml finding file.
 * @returns {{ valid: boolean, data: object | null, errors: Array<{ path: string, message: string }> }}
 */
export function validateFindingFile(filePath) {
  const { data, error } = parseFinding(filePath);
  if (error) {
    return { valid: false, data: null, errors: [{ path: '/', message: error }] };
  }

  const result = validateFinding(data);
  return { ...result, data };
}
