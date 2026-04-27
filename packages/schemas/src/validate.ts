/**
 * Ajv2020 validator factory for the schemas owned by this package.
 *
 * This is the canonical place to compile a testing-os schema. Sibling packages
 * (verify, findings, ingest) historically each wired their own Ajv instance per
 * schema; consumers can now go through {@link compileSchema} or
 * {@link validatePayload} to share one warm validator per schema and stay in
 * lockstep with the contract package itself.
 *
 * Ajv setup mirrors the existing in-tree convention:
 *   - `ajv/dist/2020.js` for draft 2020-12
 *   - `ajv-formats` registered for `date-time`, `uri`, etc.
 *   - `allErrors: true, strict: false`
 *
 * Strict is off because the in-tree schemas use `description` on root objects
 * (which Ajv strict mode treats as an unknown keyword in some contexts) and
 * we want all errors to surface in tests, not just the first.
 */

import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { allSchemas, type SchemaName, type JsonSchema } from './index.js';

// CommonJS default-export interop: under NodeNext+esModuleInterop the named
// `default` is what we actually want at runtime. Sibling JS packages get this
// for free via Node's CJS interop; the TS source has to be explicit.
const Ajv2020Ctor = (
  (Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module
) as unknown as new (opts?: { allErrors?: boolean; strict?: boolean }) => {
  compile: (schema: unknown) => ValidateFunction;
  addFormat: (...args: unknown[]) => unknown;
};

const addFormats = (
  (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule
) as unknown as (ajv: InstanceType<typeof Ajv2020Ctor>) => void;

export interface ValidationError {
  path: string;
  message: string;
  params?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const validatorCache = new Map<SchemaName, ValidateFunction>();

/**
 * Build a fresh Ajv2020 instance with the in-tree convention. Exposed so
 * callers that need to register additional schemas, vocabularies, or formats
 * can do so without forking this module.
 */
export function createAjv(): InstanceType<typeof Ajv2020Ctor> {
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/**
 * Compile (and cache) the validator for one of the eight named schemas.
 *
 * Use this when you want the raw Ajv {@link ValidateFunction} — for example,
 * to inspect `validate.errors` directly or wire it into a custom error
 * formatter. For the common case prefer {@link validatePayload}.
 */
export function compileSchema(name: SchemaName): ValidateFunction {
  const cached = validatorCache.get(name);
  if (cached) return cached;

  const schema = allSchemas[name] as JsonSchema;
  if (!schema) {
    throw new Error(`Unknown schema name: ${String(name)}`);
  }

  const ajv = createAjv();
  const validate = ajv.compile(schema);
  validatorCache.set(name, validate);
  return validate;
}

/**
 * Validate a payload against one of the named schemas and return a
 * structured result with normalised error paths/messages.
 *
 * Mirrors the shape used by `packages/verify/validators/schema.js` and
 * `packages/findings/validate.js` so consumers can migrate without
 * refactoring their error-handling code.
 */
export function validatePayload(name: SchemaName, payload: unknown): ValidationResult {
  const validate = compileSchema(name);
  const valid = validate(payload);

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors: ValidationError[] = (validate.errors ?? []).map(err => ({
    path: err.instancePath || '/',
    message: err.message ?? 'unknown error',
    params: err.params as Record<string, unknown> | undefined,
  }));

  return { valid: false, errors };
}

/**
 * Test-only helper for clearing the compiled-validator cache. Production code
 * should never need this — the cache is correct because schemas are immutable
 * for the lifetime of the process.
 */
export function _resetValidatorCacheForTests(): void {
  validatorCache.clear();
}
