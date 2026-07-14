/**
 * case-file/schema.js — Ajv-backed validator for the jury case-file envelope.
 *
 * The case-file is the neutral briefing a planner-tier clerk (a Fable agent)
 * assembles to PREPARE an external family-different jury before it verifies an
 * artifact (see docs/case-file-contract.md). This module is the STRUCTURAL gate
 * — it answers "is this the right shape?" The neutrality SEMANTICS the shape
 * cannot express (no conclusion-words in a criterion, the grounding-extraction
 * floor, no leaked producer reasoning) live in ./lint.js, exactly as the policy
 * schema gates SHAPE while docs/policy-lint.md gates the data-independent
 * semantics.
 *
 * Mirrors packages/dogfood-swarm/lib/validate-agent-output.js:
 *   - createRequire to resolve the canonical schema path off the ./json/*
 *     subpath export (CLAUDE.md rule #5 — one source of truth, the schemas pkg)
 *   - Ajv2020 + ajv-formats, lazy-compiled, cached
 *   - returns a structured { valid, errors } result rather than throwing, so the
 *     lint can BATCH-report a schema fault alongside its own findings instead of
 *     stopping at the first (the policy-lint discipline: never stop at finding #1)
 *
 * The case-file schema ships via @dogfood-lab/schemas/json/ but is NOT one of
 * the eight payload schemas wired through the canonical compileSchema /
 * validatePayload seam — it is a swarm envelope resolved as a raw JSON file, so
 * it is compiled here with a local Ajv2020, the same exception agent-output
 * takes. This file is allowlisted in scripts/check-validator-cache-singleton.test.mjs
 * for exactly that reason (the D2B-015 "no new Ajv outside packages/schemas"
 * static invariant).
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SCHEMA_PATH = require.resolve('@dogfood-lab/schemas/json/case-file.schema.json');

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
    _loadError = new Error(`case-file schema load failed: ${e.message}`);
    throw _loadError;
  }
}

/**
 * Validate a parsed case-file object against case-file.schema.json.
 *
 * Returns a structured result (never throws on an INVALID case-file — a schema
 * fault is a lint finding to report, not a crash). A genuinely broken schema
 * load (corrupt bundled JSON, missing dependency) still throws, because that is
 * a programming/packaging error, not a caller-input error.
 *
 * @param {unknown} caseFile — parsed JSON case-file
 * @returns {{ valid: boolean, errors: Array<{path: string, keyword: string, message: string, params: object}> }}
 */
export function validateCaseFileSchema(caseFile) {
  const validate = getValidator();
  const valid = validate(caseFile);
  if (valid) return { valid: true, errors: [] };

  const errors = (validate.errors || []).map(err => ({
    path: err.instancePath || '/',
    keyword: err.keyword,
    message: err.message || 'schema violation',
    params: err.params || {},
  }));
  return { valid: false, errors };
}
