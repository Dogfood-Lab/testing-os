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
  let result;
  try {
    result = validatePayload('recordSubmission', submission);
  } catch (e) {
    // The canonical compile path can throw at compileSchema time if the
    // schema file is unreadable or malformed (Ajv compile fault). Pre-H3
    // the corresponding fault was surfaced via a `{ __loadError }` sentinel
    // that the runValidator helper in verify/index.js never actually
    // routed through `VALIDATOR_FAULT_*` — `getValidator` returned a plain
    // object and the call site special-cased its `__loadError` key. The
    // post-H3 path is cleaner: a thrown error here propagates up to
    // runValidator which already wraps thrown validators in
    // `VALIDATOR_FAULT_SCHEMA` (D1B-003 humanization). Same operator-
    // facing prefix, just routed through the lawful seam instead of a
    // sentinel. No catch — propagate.
    throw e;
  }

  if (result.valid) {
    return { valid: true, errors: [] };
  }

  // String-prefix projection: pre-H3 wrote `${path} ${message}` directly
  // from Ajv.errors. The canonical ValidationError has the same
  // `{ path, message }` shape, so the formatting is verbatim.
  const errors = result.errors.map(err => `${err.path} ${err.message}`);

  return { valid: false, errors };
}
