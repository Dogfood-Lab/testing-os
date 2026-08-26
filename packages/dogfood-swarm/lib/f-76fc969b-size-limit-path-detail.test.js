/**
 * F-76fc969b — SIZE_LIMIT `.message` is a one-line size fact; Path: and
 * remediation live on the structured envelope (Path: detail + Next: hint),
 * not packed into the ERROR header.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BoundedJsonError, readBoundedBuffer } from './bounded-json-read.js';
import { renderTopLevelError } from './error-render.js';

function captureLines(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

describe('F-76fc969b — SIZE_LIMIT Path:/Next: envelope slots', () => {
  let dir;

  beforeEach(() => {
    dir = join(tmpdir(), `f-76fc969b-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** @pins F-76fc969b */
  it('SIZE_LIMIT message is a one-line size fact without Path: or Inspect remediation', () => {
    const p = join(dir, 'too-big.json');
    writeFileSync(p, 'x'.repeat(2500));
    let err = null;
    try {
      readBoundedBuffer(p, { maxBytes: 1024 });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof BoundedJsonError);
    assert.equal(err.kind, 'SIZE_LIMIT');
    assert.equal(err.path, p);
    assert.match(err.message, /exceeds size limit/i);
    assert.match(err.message, /MB/);
    assert.doesNotMatch(err.message, /Path:/,
      'Path: must not be packed into .message — it is a render detail line');
    assert.doesNotMatch(err.message, /Inspect the file/i,
      'remediation must live on .hint / Next:, not in the ERROR header');
    assert.ok(err.hint, 'default .hint must still carry the inspect/lower-producer cue');
  });

  /** @pins F-76fc969b */
  it('renderTopLevelError prints Path: as an indented detail line for BoundedJsonError', () => {
    const longPath = join(dir, 'worktree', 'packages', 'dogfood-swarm', 'output-oversized.json');
    const err = new BoundedJsonError(
      'bounded-json: file exceeds size limit: 12.5 MB (limit: 1.0 MB)',
      { kind: 'SIZE_LIMIT', path: longPath, size: 12.5 * 1024 * 1024, maxBytes: 1024 * 1024 },
    );
    const lines = captureLines(() => renderTopLevelError(err));

    assert.match(lines[0] || '', /ERROR \[BOUNDED_JSON_SIZE_LIMIT\]:/);
    assert.doesNotMatch(lines[0] || '', /Path:/,
      'header must not re-embed Path: after the message shorten');
    const pathIdx = lines.findIndex((l) => /^\s+Path:/.test(l));
    assert.ok(pathIdx >= 0, `expected indented Path: detail — got ${JSON.stringify(lines)}`);
    // Long paths fold with hang indent — join until the next labeled detail.
    const pathBlock = [];
    for (let i = pathIdx; i < lines.length; i++) {
      if (i > pathIdx && /^\s+(Next|Caused by|Run|Wave|Agent run|Findings attempted):/.test(lines[i])) break;
      pathBlock.push(lines[i]);
    }
    // Hang spaces sit between wrap fragments — strip whitespace before compare.
    const pathText = pathBlock.join('').replace(/\s+/g, '');
    assert.ok(pathText.includes(longPath.replace(/\s+/g, '')),
      `Path: block must carry the file path — got ${JSON.stringify(pathBlock)}`);
    assert.ok(lines.some((l) => /^\s+Next:/.test(l)), 'Next: remediation must still render');
  });
});
