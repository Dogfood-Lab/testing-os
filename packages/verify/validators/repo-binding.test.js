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

/**
 * F-a2fb624f: sibling table to provenance-registry.test.js's — the pre-fix
 * tripwire here ('returns null for a provider with no parser') only probed
 * 'bitbucket', a NON-prototype key, so it gave zero coverage for the actual
 * F-7ce07baa defect class (every Object.prototype own-property name, which
 * `RUN_URL_PARSERS[provider]` resolved as a truthy inherited method before
 * the Object.hasOwn fix).
 */
const OBJECT_PROTOTYPE_KEYS = [
  'constructor', 'toString', 'valueOf', '__proto__',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
];

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

  describe('gitlab parser', () => {
    it('decodes owner/repo from a JOB run_url', () => {
      const bound = parseRunUrlRepo(
        'gitlab',
        'https://gitlab.com/acme/widget/-/jobs/987654'
      );
      assert.deepEqual(bound, { owner: 'acme', repo: 'widget' });
    });

    it('decodes owner/repo from a PIPELINE run_url', () => {
      const bound = parseRunUrlRepo(
        'gitlab',
        'https://gitlab.com/acme/widget/-/pipelines/424242'
      );
      assert.deepEqual(bound, { owner: 'acme', repo: 'widget' });
    });

    it('maps nested subgroups: owner = full namespace, repo = last segment', () => {
      // GitLab supports nested subgroups (group/subgroup/project). The mapping
      // decision (documented in repo-binding.js): owner = everything before the
      // LAST path segment (the full namespace, slashes preserved), repo = the
      // last segment. Reconstructing `${owner}/${repo}` yields the full project
      // path, which is what submission.repo carries for GitLab.
      const bound = parseRunUrlRepo(
        'gitlab',
        'https://gitlab.com/acme/team-a/widget/-/pipelines/1'
      );
      assert.deepEqual(bound, { owner: 'acme/team-a', repo: 'widget' });
      assert.equal(`${bound.owner}/${bound.repo}`, 'acme/team-a/widget');
    });

    it('parses self-hosted GitLab hosts (owner/repo = path before /-/)', () => {
      const bound = parseRunUrlRepo(
        'gitlab',
        'https://gitlab.example.com/acme/widget/-/jobs/55'
      );
      assert.deepEqual(bound, { owner: 'acme', repo: 'widget' });
    });

    it('returns null for a foreign/malformed run_url', () => {
      assert.equal(parseRunUrlRepo('gitlab', 'https://example.com/x'), null);
    });

    it('returns null when the URL has no /-/ run segment', () => {
      assert.equal(parseRunUrlRepo('gitlab', 'https://gitlab.com/acme/widget'), null);
    });

    it('returns null for a single-segment path (no namespace + project)', () => {
      assert.equal(parseRunUrlRepo('gitlab', 'https://gitlab.com/widget/-/jobs/1'), null);
    });
  });

  it('returns null for a provider with no parser (no throw)', () => {
    assert.equal(parseRunUrlRepo('bitbucket', 'https://bitbucket.org/a/b/pipelines/1'), null);
  });

  describe('F-7ce07baa: parseRunUrlRepo never resolves an inherited Object.prototype key', () => {
    for (const key of OBJECT_PROTOTYPE_KEYS) {
      it(`returns null (not the inherited method) for provider="${key}"`, () => {
        // Deletion/emptiness proof: revert parseRunUrlRepo to a bare
        // `RUN_URL_PARSERS[provider]` lookup and this goes red for every key
        // here — each currently resolves a truthy inherited Object.prototype
        // value the `if (!parser)` guard cannot catch, and `parser(runUrl)`
        // then calls an unrelated built-in method.
        assert.equal(
          parseRunUrlRepo(key, 'https://github.com/acme/widget/actions/runs/1'),
          null,
          `provider="${key}" must resolve to null, not an inherited Object.prototype member`
        );
      });
    }

    it('a non-string provider (object, number, null, undefined) never throws and returns null', () => {
      for (const bad of [{}, 42, null, undefined, ['github']]) {
        assert.equal(
          parseRunUrlRepo(bad, 'https://github.com/acme/widget/actions/runs/1'),
          null,
          `provider=${JSON.stringify(bad)} must resolve to null`
        );
      }
    });
  });
});
