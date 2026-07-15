/**
 * f-017409f3-legacy-state-edges.test.js — F-017409f3: wave-state-machine.js's
 * own module header contradicted the TRANSITIONS table it documents. The
 * "Legacy-state notes" section claimed 'pending' and 'collecting' have "no
 * outbound edges in TRANSITIONS" and are "immovable without explicit
 * override" — but the table gives both states two outbound edges each
 * (`['dispatched', 'aborted_for_rewind']`), added by Phase 5B-2 (redrive) to
 * every non-terminal source, which the prose was never reconciled against.
 *
 * The table was always correct; the prose was corrected to match it (this
 * repo's lib/wave-state-machine.js). This test pins the TABLE's actual law
 * so the prose and the table cannot silently diverge again — this is the
 * regression the finding asks for explicitly: "pin the intent with a test
 * that asserts canTransition('pending','dispatched') and
 * canTransition('collecting','dispatched') return the chosen answer."
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canTransition } from './lib/wave-state-machine.js';

describe('canTransition — legacy source states are movable (F-017409f3)', () => {
  it('pending -> dispatched is allowed (redrive can resume a legacy fixture-driven wave)', () => {
    assert.equal(canTransition('pending', 'dispatched').allowed, true);
  });

  it('pending -> aborted_for_rewind is allowed (rewind can tear down a legacy fixture-driven wave)', () => {
    assert.equal(canTransition('pending', 'aborted_for_rewind').allowed, true);
  });

  it('collecting -> dispatched is allowed', () => {
    assert.equal(canTransition('collecting', 'dispatched').allowed, true);
  });

  it('collecting -> aborted_for_rewind is allowed', () => {
    assert.equal(canTransition('collecting', 'aborted_for_rewind').allowed, true);
  });

  // Negative control: 'pending'/'collecting' are NOT wide-open — they still
  // only have exactly the two edges every other non-terminal source has, not
  // an arbitrary transition. This is what makes the positive assertions
  // above meaningful rather than a canTransition-always-true tautology.
  it('pending -> verified is NOT allowed (not a real production transition)', () => {
    assert.equal(canTransition('pending', 'verified').allowed, false);
  });

  it('collecting -> advanced is NOT allowed (promotion is not reachable from an unwritten source)', () => {
    assert.equal(canTransition('collecting', 'advanced').allowed, false);
  });
});
