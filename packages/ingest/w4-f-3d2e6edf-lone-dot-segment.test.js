/**
 * w4-f-3d2e6edf-lone-dot-segment.test.js
 *
 * F-3d2e6edf (wave 4): isUnsafeSegment permitted a bare '.' segment (the
 * traversal-plus-separator regex does not match a lone dot), and the
 * submission schema's repo pattern accepts '.' as a full org or repo segment. A schema-valid
 * submission.repo like './x' therefore passed every shared-guard callsite,
 * and path.join normalized the '.' away — computeRecordPath filed the record
 * one directory level UP (records/_rejected/x/... at the ORG level,
 * colliding with a real org named 'x'), and loadRepoPolicy resolved
 * policies/repos/./x.yaml → policies/repos/x.yaml. The verify CLI's local
 * safe() helper DID block '.' — the two guards disagreed.
 *
 * Contract: a segment that is exactly '.' is unsafe (aligned with
 * cli.js's safe()); embedded dots (next.js, repo.io) stay legal
 * (F-375053-006 regression guard).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isUnsafeSegment, UNSAFE_SEGMENT } from './lib/unsafe-segment.js';
import { loadRepoPolicy } from './load-context.js';

describe('F-3d2e6edf — a lone-dot segment is unsafe', () => {
  it("isUnsafeSegment('.') is true", () => {
    assert.equal(isUnsafeSegment('.'), true);
    assert.equal(UNSAFE_SEGMENT.test('.'), true);
  });

  it('embedded dots remain legal (F-375053-006 must not regress)', () => {
    assert.equal(isUnsafeSegment('next.js'), false);
    assert.equal(isUnsafeSegment('mcp-tool-shop.github.io'), false);
    assert.equal(isUnsafeSegment('repo.io'), false);
    assert.equal(isUnsafeSegment('a.'), false);
    assert.equal(isUnsafeSegment('.a'), false);
  });

  it('traversal and separators still rejected', () => {
    assert.equal(isUnsafeSegment('..'), true);
    assert.equal(isUnsafeSegment('foo/bar'), true);
    assert.equal(isUnsafeSegment('foo\\bar'), true);
  });

  it("loadRepoPolicy('./x') fails closed instead of resolving policies/repos/x.yaml", () => {
    const root = mkdtempSync(join(tmpdir(), 'lone-dot-policy-'));
    try {
      assert.equal(loadRepoPolicy('./x', root), null,
        "a lone-dot org segment must never collapse into the parent policy namespace");
      assert.equal(loadRepoPolicy('x/.', root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
