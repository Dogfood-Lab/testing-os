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

/**
 * Process-global module-instance counter — H3 fix-up.
 *
 * The H3 migration collapsed N Ajv instances to one per schema by routing
 * every consumer through {@link validatePayload}. That single-instance
 * guarantee depends on every consumer resolving `@dogfood-lab/schemas` to
 * the SAME loaded module — same `validate.js` evaluation → same
 * `validatorCache` Map → same compiled `ValidateFunction`s.
 *
 * Under npm workspace hoist resolution this can split: if any consumer's
 * `node_modules/@dogfood-lab/schemas/` symlinks differently than others,
 * Node loads the module twice. Each load gets its own `validatorCache` —
 * the C1 two-Ajv gap RELOCATED to the cache layer instead of sealed.
 *
 * The naive "compileSchema returns the same reference twice" check is
 * vacuous against this failure: a consumer in a split second instance
 * populates ITS OWN cache; the original instance's cache is untouched;
 * `compileSchema()` called twice from the original still returns the
 * same reference. Same assertion, both green and split states.
 *
 * The fix: a counter rooted in `globalThis` (via `Symbol.for`, which is
 * shared across module instances because the Symbol registry is
 * process-global). Every evaluation of this module increments it. The
 * D2B-015 seal test asserts the count is exactly 1 after every consumer
 * has been imported — if hoist split the package, two evaluations
 * happened, count >= 2, gate trips.
 *
 * The Symbol key is namespaced to `@dogfood-lab/schemas` so a second
 * unrelated package can't shadow it. The counter is the only
 * load-time side effect of this module — keeping it minimal so the
 * cost is unobservable.
 */
const _schemasInstanceSymbol = Symbol.for('@dogfood-lab/schemas.instances');
type GlobalWithCounter = Record<typeof _schemasInstanceSymbol, number>;
const _globalSlot = globalThis as unknown as GlobalWithCounter;
_globalSlot[_schemasInstanceSymbol] = (_globalSlot[_schemasInstanceSymbol] ?? 0) + 1;

/**
 * Returns how many times this module has been evaluated in the current
 * Node process. Used by the D2B-015 single-cache invariant test to
 * detect a workspace-hoist split. A green seal requires `=== 1`.
 *
 * Test-only export: production code has no reason to read this.
 */
export function _schemasModuleInstanceCount(): number {
  return _globalSlot[_schemasInstanceSymbol] ?? 0;
}

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
  /**
   * Ajv `errors[].keyword` — the rule that fired (`required`, `pattern`,
   * `enum`, `additionalProperties`, `minLength`, etc.).
   *
   * H3 keyword extension: surfacing this at the canonical seam means
   * downstream wrappers (e.g. ingest's RecordValidationError) can preserve
   * the keyword pin (packages/ingest/ingest.test.js:208-220 asserts
   * `typeof e.keyword === 'string'` for every error). Without this field
   * here, every consumer would have to ride compileSchema() and read
   * `validate.errors` directly to recover the keyword — which would
   * defeat the migration's goal of collapsing N Ajv instances to one
   * per schema.
   *
   * Optional in the type so future synthesised errors (e.g. higher-level
   * "validator failed to compile" envelopes) aren't forced to invent a
   * keyword. Live validation always populates it.
   */
  keyword?: string;
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
    keyword: err.keyword,
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
