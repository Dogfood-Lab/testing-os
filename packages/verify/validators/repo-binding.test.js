/**
 * repo-binding.test.js — verify-B-001 (Stage C, MED)
 *
 * The cross-field anti-forgery guard in verify/index.js binds submission.repo
 * to the owner/repo decoded from source.run_url. That decode is provider-keyed
 * (RUN_URL_PARSERS in repo-binding.js). The forgery vector (verify-A-001)
 * reopens silently if a provider is added to the submission schema's
 * `source.provider` enum without a corresponding parser branch: the guard would
 * see `parseRunUrlRepo(provider, url) === null`, skip the comparison, and accept
 * a forged repo with no error and no other test failure.
 *
 * The coverage test below is the tripwire: it reads the ACTUAL `source.provider`
 * enum from the canonical submission schema and asserts every member has a
 * parser. Add a provider to the schema and forget the parser → this test goes
 * red in CI before the binding can ship disabled.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { RUN_URL_PARSERS, parseRunUrlRepo } from './repo-binding.js';

const require = createRequire(import.meta.url);
const schemaPath = require.resolve(
  '@dogfood-lab/schemas/json/dogfood-record-submission.schema.json'
);
const submissionSchema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const PROVIDER_ENUM = submissionSchema.properties.source.properties.provider.enum;

describe('repo-binding guard coverage (verify-B-001)', () => {
  it('exposes the provider enum it is meant to cover (sanity)', () => {
    assert.ok(Array.isArray(PROVIDER_ENUM) && PROVIDER_ENUM.length > 0);
    assert.ok(PROVIDER_ENUM.includes('github'));
  });

  it('has a run_url parser for EVERY registered source.provider', () => {
    const missing = PROVIDER_ENUM.filter(p => typeof RUN_URL_PARSERS[p] !== 'function');
    assert.deepEqual(
      missing,
      [],
      `source.provider enum members without a RUN_URL_PARSERS branch: ${missing.join(', ')}. ` +
        'Add a parser in validators/repo-binding.js or the anti-forgery repo binding ' +
        'silently no-ops for these providers (verify-A-001 / verify-B-001).'
    );
  });

  describe('github parser', () => {
    it('decodes owner/repo from a well-formed run_url', () => {
      const bound = parseRunUrlRepo(
        'github',
        'https://github.com/acme/widget/actions/runs/12345'
      );
      assert.deepEqual(bound, { owner: 'acme', repo: 'widget' });
    });

    it('returns null for a foreign/malformed run_url', () => {
      assert.equal(parseRunUrlRepo('github', 'https://example.com/x'), null);
    });
  });

  it('returns null for a provider with no parser (no throw)', () => {
    assert.equal(parseRunUrlRepo('gitlab', 'https://gitlab.com/a/b/-/jobs/1'), null);
  });
});
