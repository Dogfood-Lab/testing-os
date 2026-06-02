/**
 * validate-agent-output.js — Ajv-backed live validator for agent outputs.
 *
 * F-252713-017 (Phase 7 wave 1 → wave 2 wiring): the wave-1 ci-tooling agent
 * built the agent-output schema + the schema-conformance handler.
 * That handler validates fixture JSONs at CI time. This module closes Class
 * #11 (multi-occurrence fix completeness) by running the SAME schema inside
 * collect.js BEFORE upsertFindings — live agent outputs are now rejected at
 * write time with a structured error, not silently normalized.
 *
 * Mirrors packages/ingest/validate-record.js:
 *   - createRequire to resolve the canonical schema path
 *   - Ajv2020 + ajv-formats, lazy-compiled, cached
 *   - throws on invalid (programming/contract error, not user input)
 *   - returns the input on valid so callers can chain
 *
 * Why a typed error: the renderTopLevelError seam in lib/error-render.js
 * pattern-matches on `.code`. AGENT_OUTPUT_SCHEMA_INVALID gets the same
 * actionable-hint treatment that RECORD_SCHEMA_INVALID does — operator sees
 * "Next: inspect the failing output against packages/schemas/src/json/agent-output.schema.json".
 *
 * Phase routing: the canonical envelope only requires { domain, summary }.
 * The phase-specific inner shape is governed by oneOf-style $defs in the
 * schema. validateAgentOutput() takes a `phase` hint so the error message can
 * point operators at the right $def block — but the schema itself is
 * permissive at the top level so audit / feature / amend outputs can ALL
 * pass the same validator. The legacy validateAuditOutput / validateFeatureOutput
 * / validateAmendOutput in lib/output-schema.js stay for shape-specific
 * checks; this validator is the contract gate.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// fp-p-006 (deferred from the self-audit, now landed): the agent-output schema
// is the single source of truth, shipped via @dogfood-lab/schemas and resolved
// the same way the eight contract schemas are — createRequire on the `./json/*`
// subpath export (CLAUDE.md rule #5; mirrors packages/ingest/validate-record.js).
// This replaced the prior package-local copy (packages/dogfood-swarm/schema/)
// plus its byte-equality drift guard (meta-amendA-schema-packaging.test.js):
// one file, shipped through the dependency, with no copy to keep in sync.
//
// The schema is NOT one of the eight payload schemas registered in the schemas
// package's `validatePayload` map, so it is compiled here with a local Ajv2020
// instance rather than the canonical compileSchema seam — it is a swarm output
// envelope, not a contract-spine schema. That local `new Ajv` is allowlisted
// in scripts/check-validator-cache-singleton.test.mjs for exactly this reason.
const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve('@dogfood-lab/schemas/json/agent-output.schema.json');

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
    _loadError = new Error(`agent-output schema load failed: ${e.message}`);
    throw _loadError;
  }
}

/**
 * Structured error thrown when an agent JSON output violates the canonical
 * envelope. Mirrors RecordValidationError shape so the CLI seam renders
 * code + hint + cause uniformly.
 */
export class AgentOutputValidationError extends Error {
  /**
   * @param {Array<{path?: string, message?: string, keyword?: string, params?: object}>} errors
   * @param {object} [opts]
   * @param {string} [opts.domain]
   * @param {string} [opts.phase]
   * @param {string} [opts.outputPath]
   */
  constructor(errors, opts = {}) {
    const summary = errors
      .map(e => `${e.path || '/'} ${e.message}`)
      .join('; ');
    super(`agent output failed schema validation: ${summary}`);
    this.name = 'AgentOutputValidationError';
    this.code = 'AGENT_OUTPUT_SCHEMA_INVALID';
    this.errors = errors;
    if (opts.domain) this.domain = opts.domain;
    if (opts.phase) this.phase = opts.phase;
    if (opts.outputPath) this.outputPath = opts.outputPath;
  }
}

/**
 * Validate an agent JSON output against packages/schemas/src/json/agent-output.schema.json.
 *
 * @param {object} output — parsed JSON agent output
 * @param {object} [opts]
 * @param {string} [opts.domain] — surface in error context
 * @param {string} [opts.phase] — wave phase (audit / feature-audit / amend);
 *   surfaces in error context so the operator sees which $def block the
 *   inner shape was supposed to match.
 * @param {string} [opts.outputPath] — path on disk that produced this output
 * @returns {object} the same output reference, unchanged, on success
 * @throws {AgentOutputValidationError}
 */
export function validateAgentOutput(output, opts = {}) {
  const validate = getValidator();
  const valid = validate(output);
  if (valid) return output;

  const errors = (validate.errors || []).map(err => ({
    path: err.instancePath || '/',
    keyword: err.keyword,
    message: err.message,
    params: err.params,
  }));
  throw new AgentOutputValidationError(errors, opts);
}
