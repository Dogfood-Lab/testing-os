/**
 * schema_version VALUE gate — validators/schema-version.js
 *
 * F1-CONTRACTS-001 (Wave 2, HIGH). The contract JSON schemas gate
 * `schema_version` by PATTERN only (`^\d+\.\d+\.\d+$`). Nothing compared the
 * declared value against the set this build actually supports, so a
 * submission declaring `schema_version: '2.0.0'` (or `99.0.0`) validated
 * clean against the live 1.x schema whenever its shape happened to fit — a
 * genuinely-incompatible future major was silently mis-validated instead of
 * cleanly refused.
 *
 * This validator compares a payload's MAJOR against
 * SUPPORTED_SCHEMA_VERSIONS (the single source of truth imported from
 * `@dogfood-lab/schemas` — NOT a hand-copied literal) for the named contract
 * and returns a TYPED rejection-reason string:
 *
 *   - major > maxMajor → `CONTRACT_SCHEMA_TOO_NEW: ...` (operator must upgrade
 *     testing-os — this build does not understand the future contract).
 *   - major < minMajor → `CONTRACT_SCHEMA_TOO_OLD: ...` (submitter must
 *     re-emit against the current contract).
 *   - in range         → no reason (PASS; a patch/minor delta inside the range
 *     is accepted — do NOT reject on a non-major bump).
 *   - malformed / absent version → no reason (the JSON-schema PATTERN gate
 *     already owns shape; this validator only owns the VALUE comparison and
 *     stays silent rather than double-reporting a shape fault).
 *
 * Unlike the `schema`/`policy`/`steps` validators (whose caller prepends a
 * single fixed prefix), the TOO_NEW vs TOO_OLD discriminant is known HERE, at
 * the branch that fired — so this validator emits the FULL prefixed reason
 * string. `index.js` pushes it verbatim into `verification.rejection_reasons`
 * via the SAME `runValidator` seam (a thrown unknown-contract fault still
 * surfaces as `VALIDATOR_FAULT_CONTRACT_SCHEMA_VERSION`). The
 * `CONTRACT_SCHEMA_*` prefixes join the documented prefix taxonomy (see
 * verify/README.md → "Error shape").
 *
 * Return contract: `{ valid: boolean, errors: string[] }` — `errors` holds
 * the already-prefixed `CONTRACT_SCHEMA_*: ...` reason(s).
 */

import { SUPPORTED_SCHEMA_VERSIONS } from '@dogfood-lab/schemas';

/**
 * Parse the MAJOR component of a semver-ish string. Returns null when the
 * value is not a `\d+\.\d+\.\d+` triple — the shape gate owns that fault.
 *
 * @param {unknown} version
 * @returns {number | null}
 */
function parseMajor(version) {
  if (typeof version !== 'string') return null;
  const m = version.match(/^(\d+)\.\d+\.\d+$/);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * Gate a payload's declared `schema_version` against the supported MAJOR
 * range for a named contract.
 *
 * @param {object} payload - Payload carrying a `schema_version` field.
 * @param {string} [contract='recordSubmission'] - SUPPORTED_SCHEMA_VERSIONS key.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSchemaVersion(payload, contract = 'recordSubmission') {
  // Only gate payloads that actually declare a schema_version. A null/absent
  // value is the shape gate's concern, not the value gate's.
  if (!payload || typeof payload !== 'object') {
    return { valid: true, errors: [] };
  }
  const declared = payload.schema_version;
  if (declared === undefined || declared === null) {
    return { valid: true, errors: [] };
  }

  const supported = SUPPORTED_SCHEMA_VERSIONS[contract];
  if (!supported) {
    // Unknown contract key is a programmer error in the call site, not a
    // submission fault — throw so the runValidator seam surfaces it as a
    // VALIDATOR_FAULT_* operational incident rather than a submission reason.
    throw new Error(`validateSchemaVersion: unknown contract "${contract}"`);
  }

  const major = parseMajor(declared);
  if (major === null) {
    // Malformed shape — defer to the JSON-schema PATTERN gate; do not
    // double-report.
    return { valid: true, errors: [] };
  }

  if (major > supported.maxMajor) {
    return {
      valid: false,
      errors: [
        `CONTRACT_SCHEMA_TOO_NEW: ${contract} schema v${declared} but this build supports ` +
          `v${supported.current} (major ${supported.minMajor}–${supported.maxMajor}) — upgrade testing-os`,
      ],
    };
  }

  if (major < supported.minMajor) {
    return {
      valid: false,
      errors: [
        `CONTRACT_SCHEMA_TOO_OLD: ${contract} schema v${declared} is below the supported floor ` +
          `v${supported.current} (major ${supported.minMajor}–${supported.maxMajor}) — re-emit against the current contract`,
      ],
    };
  }

  return { valid: true, errors: [] };
}
