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

function load(filename: string): JsonSchema {
  const raw = readFileSync(resolve(jsonDir, filename), 'utf8');
  return JSON.parse(raw) as JsonSchema;
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

export {
  compileSchema,
  validatePayload,
  createAjv,
  _resetValidatorCacheForTests,
  type ValidationError,
  type ValidationResult,
} from './validate.js';
