/**
 * Persisted-record schema validator.
 *
 * Enforces dogfood-record.schema.json at write time. The submission validator
 * in @dogfood-lab/verify covers the inbound payload; this is the symmetric
 * gate on the outbound payload — the central verifier assembles the record
 * and the persist layer must not write anything that violates the contract.
 *
 * Mirrors the Ajv idiom in @dogfood-lab/verify/validators/schema.js — same
 * Ajv2020 + ajv-formats setup, lazy compile, cached compiled validator.
 * Kept in this package (not extracted to a shared util) because the two
 * call sites have different error shapes and lifecycles: submission validation
 * returns { valid, errors } so the verifier can build a rejection record;
 * record validation throws because a malformed record reaching the write
 * path is a programming error, not user input.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve('@dogfood-lab/schemas/json/dogfood-record.schema.json');

let _validator = null;
let _loadError = null;

function getValidator() {
  if (_validator) return _validator;
  if (_loadError) throw _loadError;

  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    _validator = ajv.compile(schema);
    return _validator;
  } catch (e) {
    _loadError = new Error(`record schema load failed: ${e.message}`);
    throw _loadError;
  }
}

/**
 * Structured error thrown when a persisted record violates the schema.
 * Caller code can `instanceof RecordValidationError` to distinguish from
 * IO/path errors.
 */
export class RecordValidationError extends Error {
  constructor(errors) {
    const summary = errors
      .map(e => `${e.path || '/'} ${e.message}`)
      .join('; ');
    super(`persisted record failed schema validation: ${summary}`);
    this.name = 'RecordValidationError';
    this.code = 'RECORD_SCHEMA_INVALID';
    this.errors = errors;
  }
}

/**
 * Validate a persisted record against dogfood-record.schema.json.
 * Throws RecordValidationError on failure; returns the record on success
 * so callers can chain (`writeFile(validateRecord(r))`).
 *
 * @param {object} record
 * @returns {object} the same record reference, unchanged
 * @throws {RecordValidationError}
 */
export function validateRecord(record) {
  const validate = getValidator();
  const valid = validate(record);
  if (valid) return record;

  const errors = (validate.errors || []).map(err => ({
    path: err.instancePath || '/',
    keyword: err.keyword,
    message: err.message,
    params: err.params
  }));
  throw new RecordValidationError(errors);
}
