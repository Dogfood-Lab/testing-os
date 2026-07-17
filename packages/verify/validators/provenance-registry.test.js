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

/**
 * F-a2fb624f: the pre-fix tripwire (`provenanceForProvider('bitbucket') ===
 * null`) only probed a NON-prototype unknown key — green both before AND
 * after F-2965699b's fix, so it gave zero coverage for the actual defect
 * class. This table-driven set is the real regression guard: every
 * Object.prototype own-property name, which is exactly the key space
 * `PROVENANCE_ADAPTERS[provider]` resolved (as a truthy inherited method,
 * defeating `?? null`) before the Object.hasOwn fix. Shared verbatim with
 * repo-binding.test.js's sibling table so both prototype-safety sites are
 * proven against the identical key set.
 */
const OBJECT_PROTOTYPE_KEYS = [
  'constructor', 'toString', 'valueOf', '__proto__',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
];

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

  describe('F-2965699b: provenanceForProvider never resolves an inherited Object.prototype key', () => {
    for (const key of OBJECT_PROTOTYPE_KEYS) {
      it(`returns null (not the inherited method) for provider="${key}"`, () => {
        // Deletion/emptiness proof: revert provenanceForProvider to
        // `PROVENANCE_ADAPTERS[provider] ?? null` and this goes red for
        // every key here — each one currently resolves a truthy inherited
        // Object.prototype value that `?? null` cannot catch.
        assert.equal(provenanceForProvider(key), null,
          `provider="${key}" must resolve to null, not an inherited Object.prototype member`);
      });
    }

    it('a non-string provider (object, number, null, undefined) never throws and returns null', () => {
      for (const bad of [{}, 42, null, undefined, ['github']]) {
        assert.equal(provenanceForProvider(bad), null, `provider=${JSON.stringify(bad)} must resolve to null`);
      }
    });
  });
});
