/**
 * F-14ee286b — renderTopLevelError must fold long ERROR/detail lines to a
 * TTY budget with hanging indent so soft-wrap continuations stay children
 * of the header (not flush-left mid-path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { foldErrorLine, renderTopLevelError } from './error-render.js';
import { displayWidth } from './display-width.js';

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

describe('F-14ee286b — renderTopLevelError hanging-indent fold', () => {
  /** @pins F-14ee286b */
  it('foldErrorLine wraps past the budget and hangs continuations under the prefix', () => {
    const prefix = 'ERROR [AGENT_OUTPUT_SCHEMA_INVALID]: ';
    const body = 'x'.repeat(120);
    const lines = captureLines(() => foldErrorLine(prefix, body, 80));

    assert.ok(lines.length >= 2, `expected wrap into 2+ lines, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.ok(lines[0].startsWith(prefix));
    assert.ok(displayWidth(lines[0]) <= 80, `first line over budget: ${displayWidth(lines[0])}`);
    for (let i = 1; i < lines.length; i++) {
      assert.match(lines[i], /^\s+\S/, `continuation ${i} must be indented, got ${JSON.stringify(lines[i])}`);
      assert.ok(displayWidth(lines[i]) <= 80, `continuation ${i} over budget`);
      assert.equal(
        displayWidth(lines[i].match(/^\s*/)[0]),
        displayWidth(prefix),
        'hang width must match the ERROR [CODE]: prefix column',
      );
    }
  });

  /** @pins F-14ee286b */
  it('renderTopLevelError folds a long Next: hint and keeps Run:/Wave: as indented children', () => {
    const longPath = 'E:/AI/testing-os/.swarm/worktrees/' + 'w'.repeat(80) + '/packages/schemas/src/json/agent-output.schema.json';
    const lines = captureLines(() => renderTopLevelError({
      code: 'AGENT_OUTPUT_SCHEMA_INVALID',
      message: 'agent output failed schema validation',
      outputPath: longPath,
      runId: 'swarm-1787700871-d537',
      waveId: '11',
      domain: 'swarm-cp-core',
      // Force the long derived hint path (no .hint).
    }, { budget: 80 }));

    const nextIdx = lines.findIndex((l) => l.includes('Next:'));
    assert.ok(nextIdx >= 0, `expected a Next: line — got ${JSON.stringify(lines)}`);
    // Long revalidate hint must wrap; every continuation stays indented.
    const nextBlock = [];
    for (let i = nextIdx; i < lines.length; i++) {
      if (i > nextIdx && /^\s+(Path|Caused by|Run|Wave|Agent run|Findings attempted):/.test(lines[i])) break;
      nextBlock.push(lines[i]);
    }
    assert.ok(nextBlock.length >= 2, `long Next: must wrap under 80 cols — got ${JSON.stringify(nextBlock)}`);
    for (const line of nextBlock) {
      assert.ok(displayWidth(line) <= 80, `Next: block line over budget: ${displayWidth(line)}`);
    }
    for (let i = 1; i < nextBlock.length; i++) {
      assert.match(nextBlock[i], /^\s{2,}/, 'Next: continuation must keep the detail hierarchy');
    }

    assert.ok(lines.some((l) => /^\s+Run:/.test(l)));
    assert.ok(lines.some((l) => /^\s+Wave:/.test(l)));
  });

  /** @pins F-14ee286b */
  it('embedded newlines in e.message flatten under the ERROR hang (no flush-left orphans)', () => {
    const lines = captureLines(() => renderTopLevelError({
      code: 'BOUNDED_JSON_SIZE_LIMIT',
      message: 'line-one fact\nline-two should not be flush-left',
      hint: 'inspect the file',
    }));

    assert.match(lines[0], /^ERROR \[BOUNDED_JSON_SIZE_LIMIT\]:/);
    assert.doesNotMatch(lines[0], /\n/);
    assert.ok(
      lines[0].includes('line-one fact') && lines[0].includes('line-two'),
      `message lines must merge under the header — got ${lines[0]}`,
    );
    for (let i = 1; i < lines.length; i++) {
      assert.match(lines[i], /^\s+/, `detail/continuation ${i} must be indented`);
    }
  });
});
