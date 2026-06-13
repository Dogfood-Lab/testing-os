/**
 * @dogfood-lab/schemas — JSON-schema spine for testing-os.
 *
 * Each schema is a JSON Schema 2020-12 document. Consumers can either:
 *
 *   1. Import the typed schema object:
 *        import { recordSchema } from '@dogfood-lab/schemas';
 *
 *   2. Reference the raw JSON file via the subpath export:
 *        import recordSchema from '@dogfood-lab/schemas/json/dogfood-record.schema.json'
 *          with { type: 'json' };
 *
 * The schemas are the same files served by the legacy
 * `mcp-tool-shop-org/dogfood-labs/schemas/` URLs during the cutover window.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsonDir = resolve(here, '../src/json');

/**
 * Load and parse a bundled JSON schema.
 *
 * d1-schemas-B002 — readFileSync + JSON.parse are wrapped so a corrupt or
 * truncated package-bundled `src/json/*.schema.json` (a packaging defect that
 * can ship in a tarball) throws a SELF-IDENTIFYING error at module-init instead
 * of a bare `SyntaxError: Unexpected end of JSON input` that names no file. The
 * rethrown message names the package and the offending filename so the consumer
 * knows exactly which of the eight schemas to inspect/re-install — they do not
 * have to bisect by hand. This is the only structured channel available at
 * module-init (no CLI renderer / no logStage pipeline exists this early), so the
 * helpful contract is "a thrown Error whose message carries the recovery handle."
 *
 * `dirOverride` exists only for the test seam (`_loadSchemaForTests`); production
 * callers always read from the real bundled `jsonDir`.
 */
function load(filename: string, dirOverride?: string): JsonSchema {
  const path = resolve(dirOverride ?? jsonDir, filename);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(
      `@dogfood-lab/schemas: failed to read bundled schema ${filename} (at ${path}): ${
        (e as Error).message
      }`,
    );
  }
  try {
    return JSON.parse(raw) as JsonSchema;
  } catch (e) {
    throw new Error(
      `@dogfood-lab/schemas: failed to parse bundled schema ${filename} (at ${path}) as JSON — the package artifact may be corrupt or truncated: ${
        (e as Error).message
      }`,
    );
  }
}

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export const recordSchema: JsonSchema = load('dogfood-record.schema.json');
export const recordSubmissionSchema: JsonSchema = load('dogfood-record-submission.schema.json');
export const findingSchema: JsonSchema = load('dogfood-finding.schema.json');
export const patternSchema: JsonSchema = load('dogfood-pattern.schema.json');
export const recommendationSchema: JsonSchema = load('dogfood-recommendation.schema.json');
export const doctrineSchema: JsonSchema = load('dogfood-doctrine.schema.json');
export const policySchema: JsonSchema = load('policy.schema.json');
export const scenarioSchema: JsonSchema = load('scenario.schema.json');

export const allSchemas = {
  record: recordSchema,
  recordSubmission: recordSubmissionSchema,
  finding: findingSchema,
  pattern: patternSchema,
  recommendation: recommendationSchema,
  doctrine: doctrineSchema,
  policy: policySchema,
  scenario: scenarioSchema,
} as const;

export type SchemaName = keyof typeof allSchemas;

/**
 * Test-only seam for d1-schemas-B002. Exposes the module-private {@link load}
 * so the parse-error-context guard can be exercised against a corrupt fixture
 * without touching the real bundled `src/json` tree. Mirrors the existing
 * `_resetValidatorCacheForTests` / `_schemasModuleInstanceCount` test exports —
 * underscore-prefixed, not part of the public API.
 *
 * @param filename    schema basename, e.g. `dogfood-record.schema.json`
 * @param dirOverride optional directory to read from instead of the bundled
 *                    `jsonDir` (tests point this at a TEST_ROOT temp dir)
 */
export function _loadSchemaForTests(filename: string, dirOverride?: string): JsonSchema {
  return load(filename, dirOverride);
}

export {
  compileSchema,
  validatePayload,
  createAjv,
  _resetValidatorCacheForTests,
  _schemasModuleInstanceCount,
  type ValidationError,
  type ValidationResult,
} from './validate.js';
