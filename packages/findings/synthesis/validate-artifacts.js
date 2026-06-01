/**
 * Schema validation for pattern, recommendation, and doctrine artifacts.
 *
 * H3 hop 1: delegates to the canonical {@link validatePayload} from
 * `@dogfood-lab/schemas`. Pre-H3 this module compiled its own
 * Ajv2020 + ajv-formats instance per schema; that duplicated the
 * verifier's compile path and created the C1 two-Ajv structural gap
 * (same JSON Schema → two distinct compiled validators in two
 * sibling packages). The migration collapses pattern, recommendation,
 * and doctrine to the single cached validator the canonical seam
 * shares with the rest of the workspace.
 *
 * Return contract preserved: `{ valid, errors: [{ path, message }] }`.
 * Synthesis callers ignored `params` and `keyword` historically — we
 * project the canonical ValidationError down to the narrower shape
 * the synthesis layer actually uses.
 */

import { validatePayload } from '@dogfood-lab/schemas';

function projectErrors(errors) {
  return errors.map(e => ({ path: e.path, message: e.message }));
}

export function validatePattern(data) {
  const result = validatePayload('pattern', data);
  return { valid: result.valid, errors: projectErrors(result.errors) };
}

export function validateRecommendation(data) {
  const result = validatePayload('recommendation', data);
  return { valid: result.valid, errors: projectErrors(result.errors) };
}

export function validateDoctrine(data) {
  const result = validatePayload('doctrine', data);
  return { valid: result.valid, errors: projectErrors(result.errors) };
}
