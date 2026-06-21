/**
 * Schema validator — validates submissions against dogfood-record-submission.schema.json.
 *
 * H3 hop 3: delegates to the canonical {@link validatePayload} from
 * `@dogfood-lab/schemas`. Pre-H3 this module compiled its own
 * Ajv2020 + ajv-formats instance for the submission schema; that
 * duplicated the verifier's compile path against the inbound payload
 * AND was the third of four sites contributing to the C1 two-Ajv
 * structural gap. The migration collapses submission-validation to
 * the single cached validator the canonical seam shares with the
 * rest of the workspace.
 *
 * Return contract preserved: `{ valid, errors: string[] }`. The
 * string-prefix shape is consumed by verify/index.js, which prepends
 * `schema: ` / `policy: ` / `VALIDATOR_FAULT_SCHEMA: ` per the
 * Stage C D1B-003 operator-legibility cluster. The migration keeps
 * the `${path} ${message}` projection so downstream prefixes stay
 * exact.
 */

import { validatePayload } from '@dogfood-lab/schemas';

/**
 * Validate a submission payload against the submission JSON Schema.
 *
 * @param {object} submission
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSubmissionSchema(submission) {
  // The canonical compile path can throw at compileSchema time if the schema
  // file is unreadable or malformed (Ajv compile fault). We deliberately do
  // NOT catch it here: a thrown error propagates up to runValidator in
  // verify/index.js, which wraps thrown validators in `VALIDATOR_FAULT_SCHEMA`
  // (D1B-003 humanization). Pre-H3 this fault was surfaced via a `{ __loadError }`
  // sentinel the call site special-cased; routing the throw through the lawful
  // runValidator seam yields the same operator-facing prefix without the sentinel.
  const result = validatePayload('recordSubmission', submission);

  if (result.valid) {
    return { valid: true, errors: [] };
  }

  // String-prefix projection: pre-H3 wrote `${path} ${message}` directly
  // from Ajv.errors. The canonical ValidationError has the same
  // `{ path, message }` shape, so the formatting is verbatim.
  const errors = result.errors.map(err => `${err.path} ${err.message}`);

  return { valid: false, errors };
}
