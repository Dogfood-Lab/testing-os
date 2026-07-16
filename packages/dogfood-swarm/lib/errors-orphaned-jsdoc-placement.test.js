/**
 * errors-orphaned-jsdoc-placement.test.js — F-e0fb3761 (Wave 18):
 *
 * The JSDoc block documenting StateMachineRejectionError ("Thrown by
 * transitionAgent when a state-machine transition is rejected...") sat
 * directly above `export class DispatchPreconditionError`, not above the
 * class it actually describes — StateMachineRejectionError itself, defined
 * 150+ lines later at the bottom of the file with no doc comment of its
 * own. Looks like an insertion-ordering slip: DispatchPreconditionError's
 * own comment+class pair was added between a pre-existing
 * StateMachineRejectionError doc comment and its class, and the class was
 * later relocated to the bottom of the file without its comment following
 * it.
 *
 * Zero runtime effect — both classes work correctly regardless of comment
 * placement (per the approved finding) — so this is a pure source-text
 * placement check, the same "read the source, assert on its shape" pattern
 * as wave-state-machine-header-drift.test.js in this same directory.
 *
 * THE FIX. Moved the StateMachineRejectionError doc block down to directly
 * precede its own class. DispatchPreconditionError already had its own
 * correct, adjacent doc block (immediately below the orphan) — removing the
 * orphan from above it needed no forward-reference stub, since
 * DispatchPreconditionError was never missing its own documentation.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) because the
 * swarm-cp-core domain owns `packages/dogfood-swarm/lib/**` only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StateMachineRejectionError, DispatchPreconditionError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'errors.js'), 'utf-8');

describe('errors.js — StateMachineRejectionError JSDoc sits above its own class (F-e0fb3761)', () => {
  it('GATE: a JSDoc block\'s closing `*/` immediately precedes `export class StateMachineRejectionError`', () => {
    const classMatch = SRC.match(/export class StateMachineRejectionError/);
    assert.ok(classMatch, 'sanity: the class must exist');
    const classIndex = classMatch.index;
    const precedingContext = SRC.slice(Math.max(0, classIndex - 400), classIndex);
    // Only whitespace is allowed between the doc comment's closing `*/` and
    // the class keyword — an orphaned doc comment sitting elsewhere in the
    // file (e.g. still glued above DispatchPreconditionError) would leave
    // ordinary code (another class's closing brace, a blank line) in this
    // window instead of a `*/`.
    assert.match(
      precedingContext, /\*\/\s*$/,
      'StateMachineRejectionError must be directly preceded by a JSDoc block\'s closing `*/`, not by unrelated code — ' +
      'this is exactly the F-e0fb3761 regression: the doc comment orphaned 150+ lines away, above DispatchPreconditionError instead',
    );
  });

  it('GATE: that JSDoc block documents StateMachineRejectionError specifically (transitionAgent + the three kind values), not a placeholder', () => {
    const classIndex = SRC.match(/export class StateMachineRejectionError/).index;
    const docStart = SRC.lastIndexOf('/**', classIndex);
    assert.ok(docStart >= 0, 'a JSDoc opener must exist before the class');
    const docBlock = SRC.slice(docStart, classIndex);
    assert.match(docBlock, /transitionAgent/,
      'the doc must name transitionAgent, the function that throws this error');
    assert.match(docBlock, /BLOCKED/);
    assert.match(docBlock, /TERMINAL/);
    assert.match(docBlock, /INVALID/);
  });

  it('GATE: DispatchPreconditionError no longer has the StateMachineRejectionError doc glued above it', () => {
    const classIndex = SRC.match(/export class DispatchPreconditionError/).index;
    // Window sized from the PRE-FIX file: the orphan's opening phrase sat
    // 2048 chars before this class (measured directly against the unfixed
    // source) — 3000 leaves comfortable margin so a too-small window can't
    // produce a false-negative "pass" by simply failing to reach the text.
    const precedingContext = SRC.slice(Math.max(0, classIndex - 3000), classIndex);
    assert.doesNotMatch(
      precedingContext, /Thrown by transitionAgent when a state-machine transition is rejected/,
      'DispatchPreconditionError must not sit directly under the StateMachineRejectionError doc block — that was the F-e0fb3761 orphaning bug',
    );
    // Positive check: DispatchPreconditionError keeps its OWN correct doc
    // (never touched by this fix) — a deleted orphan is not the same as a
    // still-documented class.
    assert.match(
      precedingContext, /Thrown when a `swarm dispatch` precondition fails/,
      'DispatchPreconditionError must keep its own doc block, undisturbed by removing the orphan above it',
    );
  });

  it('ANCHOR: both classes still construct correctly — comment placement has zero runtime effect, and the move must not have clipped code', () => {
    const rejection = new StateMachineRejectionError('blocked', {
      kind: 'BLOCKED', from: 'dispatched', to: 'complete', hint: 'override required',
    });
    assert.equal(rejection.name, 'StateMachineRejectionError');
    assert.equal(rejection.code, 'STATE_MACHINE_BLOCKED');
    assert.equal(rejection.kind, 'BLOCKED');
    assert.equal(rejection.from, 'dispatched');
    assert.equal(rejection.to, 'complete');

    const precondition = new DispatchPreconditionError('run not found', {
      code: 'DISPATCH_RUN_NOT_FOUND', runId: 'run-1',
    });
    assert.equal(precondition.name, 'DispatchPreconditionError');
    assert.equal(precondition.code, 'DISPATCH_RUN_NOT_FOUND');
    assert.equal(precondition.runId, 'run-1');
  });
});
