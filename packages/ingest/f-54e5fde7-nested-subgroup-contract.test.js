/**
 * F-54e5fde7: the submission schema's `repo` pattern
 * (^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$) forbids a second slash, so nested GitLab
 * subgroup paths (group/subgroup/project) are NOT supported end-to-end. The
 * contract decision is (b): declare them unsupported and make every consumer of
 * the slug fail CLOSED on a 3+-segment value instead of silently resolving a
 * DIFFERENT repo's policy file (`[org, repo] = slug.split('/')` dropped the
 * third segment, mapping group/subgroup/project → policies/repos/group/subgroup.yaml).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRepoPolicy } from './load-context.js';
import { parseRunUrlRepo } from '@dogfood-lab/verify/validators/repo-binding.js';
import { validateSubmissionSchema } from '@dogfood-lab/verify/validators/schema.js';

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'f54e5fde7-'));
  roots.push(root);
  return root;
}

describe('F-54e5fde7: nested subgroup slugs fail closed', () => {
  it('loadRepoPolicy returns null for a 3-segment slug even when the truncated path exists', () => {
    const root = makeRoot();
    // The WRONG file a naive 2-way destructure would resolve for
    // 'group/subgroup/project': policies/repos/group/subgroup.yaml.
    mkdirSync(join(root, 'policies', 'repos', 'group'), { recursive: true });
    writeFileSync(join(root, 'policies', 'repos', 'group', 'subgroup.yaml'), [
      'policy_version: "1.0.0"',
      'repo: group/subgroup',
      ''
    ].join('\n'), 'utf-8');

    const policy = loadRepoPolicy('group/subgroup/project', root);
    assert.equal(policy, null,
      'a 3-segment slug must not resolve another repo\'s policy file');
  });

  it('loadRepoPolicy still resolves a plain 2-segment slug', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'policies', 'repos', 'group'), { recursive: true });
    writeFileSync(join(root, 'policies', 'repos', 'group', 'project.yaml'), [
      'policy_version: "1.0.0"',
      'repo: group/project',
      ''
    ].join('\n'), 'utf-8');

    const policy = loadRepoPolicy('group/project', root);
    assert.ok(policy, 'two-segment slug must load');
    assert.equal(policy.policy_version, '1.0.0');
  });

  it('the submission schema rejects a nested-subgroup repo (the declared contract)', () => {
    const result = validateSubmissionSchema({ repo: 'group/subgroup/project' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('repo')),
      `expected a repo pattern error, got: ${JSON.stringify(result.errors)}`);
  });

  it('a nested gitlab run_url still parses to a full-namespace owner (fail-closed binding)', () => {
    // Deliberate: the reconstructed `${owner}/${repo}` for a nested run_url
    // contains 2+ slashes and can NEVER equal a schema-valid submission.repo,
    // so the repo-binding guard rejects with repo:mismatch instead of
    // silently skipping the binding — fail-closed, not fail-open.
    const parsed = parseRunUrlRepo('gitlab', 'https://gitlab.com/group/subgroup/project/-/jobs/123');
    assert.deepEqual(parsed, { owner: 'group/subgroup', repo: 'project' });
  });
});
