/**
 * F-e0eebfec — BoundedJsonError must participate in renderTopLevelError's
 * structured envelope (`ERROR [<CODE>]:` + `Next:`), not flatten to untyped
 * `ERROR: …`. Lives under lib/ (swarm-cp-core owns packages/dogfood-swarm/lib/**).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BoundedJsonError, readBoundedJson } from './bounded-json-read.js';
import { renderTopLevelError } from './error-render.js';

function captureRender(err) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    renderTopLevelError(err);
  } finally {
    console.error = orig;
  }
  return lines;
}

describe('F-e0eebfec — BoundedJsonError structured CLI envelope', () => {
  /** @pins F-e0eebfec */
  it('SIZE_LIMIT / PARSE_FAILED / READ_FAILED each set stable .code + .hint', () => {
    for (const kind of ['SIZE_LIMIT', 'READ_FAILED', 'PARSE_FAILED']) {
      const e = new BoundedJsonError(`bounded-json: ${kind}`, { kind, path: '/tmp/x.json' });
      assert.match(e.code, /^BOUNDED_JSON_/);
      assert.ok(e.hint, `${kind} must set a default .hint`);
      assert.equal(e.kind, kind);
    }
  });

  /** @pins F-e0eebfec */
  it('renderTopLevelError emits ERROR [<CODE>]: and Next: for each BoundedJson kind', () => {
    for (const [kind, code] of [
      ['SIZE_LIMIT', 'BOUNDED_JSON_SIZE_LIMIT'],
      ['READ_FAILED', 'BOUNDED_JSON_READ_FAILED'],
      ['PARSE_FAILED', 'BOUNDED_JSON_PARSE_FAILED'],
    ]) {
      const e = new BoundedJsonError(`msg-${kind}`, { kind, path: '/tmp/x.json' });
      // Strip constructor hint to force deriveHintForCode dual-coverage path.
      delete e.hint;
      const lines = captureRender(e);
      assert.match(lines[0] || '', new RegExp(`ERROR \\[${code}\\]:`),
        `${code} must render structured ERROR [CODE]: prefix`);
      assert.ok(lines.some((l) => l.trim().startsWith('Next:')),
        `${code} must render a Next: line via deriveHintForCode`);
    }
  });

  /** @pins F-e0eebfec */
  it('live PARSE_FAILED from readBoundedJson renders structured envelope', () => {
    const dir = join(tmpdir(), `f-e0eebfec-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, 'bad.json');
    try {
      writeFileSync(bad, '{not-json');
      let err = null;
      try {
        readBoundedJson(bad);
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof BoundedJsonError);
      assert.equal(err.code, 'BOUNDED_JSON_PARSE_FAILED');
      const lines = captureRender(err);
      assert.match(lines[0] || '', /ERROR \[BOUNDED_JSON_PARSE_FAILED\]:/);
      assert.ok(lines.some((l) => l.trim().startsWith('Next:')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
