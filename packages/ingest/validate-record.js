/**
 * Persisted-record schema validator.
 *
 * Enforces dogfood-record.schema.json at write time. The submission validator
 * in @dogfood-lab/verify covers the inbound payload; this is the symmetric
 * gate on the outbound payload — the central verifier assembles the record
 * and the persist layer must not write anything that violates the contract.
 *
 * H3 hop 4 (LAST — the C1-sealing hop): delegates to the canonical
 * {@link validatePayload} from `@dogfood-lab/schemas`. Pre-H3 this module
 * compiled its own Ajv2020 + ajv-formats instance for the record schema,
 * which was the SAME schema the verifier-side path (now also canonical)
 * compiled in a SECOND instance — the structural root of the C1 two-Ajv
 * gap. After H3, ingest and verify share the single cached validator the
 * canonical seam holds for `dogfood-record.schema.json`.
 *
 * Contract preserved:
 *   - Throws {@link RecordValidationError} on validation failure (NOT a
 *     return value — the persist layer treats a malformed record as a
 *     programming error, not user input).
 *   - `.code === 'RECORD_SCHEMA_INVALID'` is the structural error-codes
 *     gate pin (just hardened in A2.1 FX2 — see scripts/doc-drift-patterns.json
 *     error-codes check); the migration keeps it intact.
 *   - Each `errors[]` entry carries `{ path, keyword, message, params }` —
 *     the keyword pin (packages/ingest/ingest.test.js:208-220) asserts
 *     `typeof e.keyword === 'string'` for every error. The H3 keyword
 *     extension at the canonical seam (validate.ts ValidationError) is
 *     what makes this contract preservable without ingest holding its
 *     own Ajv instance.
 */

import { validatePayload } from '@dogfood-lab/schemas';

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
  const result = validatePayload('record', record);
  if (result.valid) return record;

  // Project canonical ValidationError → ingest's historical error shape:
  // pre-H3 entries had `{ path, keyword, message, params }`. Canonical
  // ships the same fields (keyword added in H3 hop 0). Re-construct
  // explicitly so any future change to the canonical shape (extra
  // fields, renames) trips an explicit migration here rather than
  // silently widening RecordValidationError.errors[].
  const errors = result.errors.map(err => ({
    path: err.path,
    keyword: err.keyword,
    message: err.message,
    params: err.params,
  }));
  throw new RecordValidationError(errors);
}
