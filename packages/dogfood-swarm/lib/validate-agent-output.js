/**
 * validate-agent-output.js — Ajv-backed live validator for agent outputs.
 *
 * F-252713-017 (Phase 7 wave 1 → wave 2 wiring): the wave-1 ci-tooling agent
 * built scripts/agent-output.schema.json + the schema-conformance handler.
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
 * "Next: inspect the failing output against scripts/agent-output.schema.json".
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
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The agent-output schema lives at scripts/agent-output.schema.json (repo
// root). It is NOT yet packaged through @dogfood-lab/schemas — backend wave 2
// keeps it where the wave-1 ci-tooling agent put it, and resolves the path
// relative to this module. If the schema graduates to the schemas package
// later, this resolution becomes a createRequire('@dogfood-lab/schemas/...')
// call mirroring validate-record.js.
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// fp-001: the schema is shipped INSIDE the package (packages/dogfood-swarm/
// schema/) so a published `npm install -g @dogfood-lab/dogfood-swarm` actually
// has it at runtime. The repo-root scripts/ copy is NOT in package.json `files`
// and is therefore ABSENT from the published tarball — resolving it from an
// installed package climbs out of node_modules to a path that does not exist,
// crashing `swarm dispatch`/`collect`/`revalidate` with ENOENT. Package-local
// is primary; the scripts/ path is the monorepo dev-tree fallback. The
// byte-equality drift guard lives in meta-amendA-schema-packaging.test.js.
const PKG_LOCAL_SCHEMA = join(__dirname, '..', 'schema', 'agent-output.schema.json');
const REPO_ROOT_SCHEMA = join(__dirname, '..', '..', '..', 'scripts', 'agent-output.schema.json');
const SCHEMA_PATH = existsSync(PKG_LOCAL_SCHEMA) ? PKG_LOCAL_SCHEMA : REPO_ROOT_SCHEMA;

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
 * Validate an agent JSON output against scripts/agent-output.schema.json.
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
