/**
 * provenance-registry.test.js — provenance adapter coverage (peer of repo-binding.test.js)
 *
 * The forgery-vector tripwire in repo-binding.test.js asserts every
 * `source.provider` enum member has a run_url PARSER. This file closes the other
 * half of the same discipline: every provider must ALSO have a provenance
 * ADAPTER in PROVENANCE_ADAPTERS. A provider with a parser but no adapter would
 * be selectable at the binding layer yet un-confirmable at the provenance layer
 * — submissions for it would fail closed with an opaque "no adapter" path. The
 * coverage test reads the ACTUAL provider enum from the canonical submission
 * schema, so adding a provider without an adapter goes RED in CI.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { PROVENANCE_ADAPTERS, provenanceForProvider, githubProvenance, gitlabProvenance } from './provenance.js';

const require = createRequire(import.meta.url);
const schemaPath = require.resolve(
  '@dogfood-lab/schemas/json/dogfood-record-submission.schema.json'
);
const submissionSchema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const PROVIDER_ENUM = submissionSchema.properties.source.properties.provider.enum;

describe('provenance adapter coverage', () => {
  it('exposes the provider enum it is meant to cover (sanity)', () => {
    assert.ok(Array.isArray(PROVIDER_ENUM) && PROVIDER_ENUM.length > 0);
    assert.ok(PROVIDER_ENUM.includes('github'));
    assert.ok(PROVIDER_ENUM.includes('gitlab'));
  });

  it('has a provenance adapter factory for EVERY registered source.provider', () => {
    const missing = PROVIDER_ENUM.filter(p => typeof PROVENANCE_ADAPTERS[p] !== 'function');
    assert.deepEqual(
      missing,
      [],
      `source.provider enum members without a PROVENANCE_ADAPTERS factory: ${missing.join(', ')}. ` +
        'Add an adapter in validators/provenance.js or provenance falls closed for these providers ' +
        'with no confirmation path.'
    );
  });

  it('provenanceForProvider returns the matching factory', () => {
    assert.equal(PROVENANCE_ADAPTERS.github, githubProvenance);
    assert.equal(PROVENANCE_ADAPTERS.gitlab, gitlabProvenance);
    assert.equal(provenanceForProvider('github'), githubProvenance);
    assert.equal(provenanceForProvider('gitlab'), gitlabProvenance);
  });

  it('provenanceForProvider returns null for an unknown provider (no throw)', () => {
    assert.equal(provenanceForProvider('bitbucket'), null);
  });
});
