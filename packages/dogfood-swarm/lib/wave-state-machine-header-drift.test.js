/**
 * wave-state-machine-header-drift.test.js — F-88b6ba71: the header prose
 * about 'pending'/'collecting' must not silently re-drift from what
 * TRANSITIONS actually says, and the comment's own claim about test
 * coverage must not overclaim what a test can actually see.
 *
 * BACKGROUND. F-017409f3 (already approved, this session) fixed a header
 * paragraph that had claimed 'pending'/'collecting' have "no outbound
 * edges ... immovable without explicit override", when TRANSITIONS actually
 * gives both two edges (['aborted_for_rewind', 'dispatched']) as of Phase
 * 5B-2. That fix's own closing sentence then claimed the corrected prose was
 * "Pinned by wave-state-machine.test.js so the two cannot silently diverge
 * again" — but wave-state-machine.test.js
 * ('legacy "pending" + "collecting" have the rewind exit + the 5B-2 redrive
 * exit') pins TRANSITIONS' VALUES, not this comment's TEXT. Nothing
 * previously stopped a future edit from reverting ONLY the prose (leaving
 * TRANSITIONS untouched) and silently reintroducing the exact false claim
 * the original fix removed — the new comment overclaimed what its own cited
 * test protects, in the very sentence explaining why the old comment's
 * overclaim mattered.
 *
 * THIS FILE closes that self-referential gap directly, the way
 * scripts/check-doc-drift.mjs does for other surfaces (a source-text
 * pattern check, not a test-coverage argument) — but scoped to this domain
 * (packages/dogfood-swarm/lib/**\), reading wave-state-machine.js's own
 * source rather than depending on that root-level script.
 *
 * WHY BOTH A NEGATIVE AND A POSITIVE CHECK. A negative-only check (retired
 * phrase absent) would be satisfied by deleting the whole paragraph, which
 * is not what "keep the prose accurate" means. A positive check (the
 * corrected claim's actual wording present) proves the honest replacement
 * text is there, not just that one specific bad string is gone. Both run
 * against the SAME source read, so they cannot drift from each other.
 *
 * WHY THIS FILE, NOT AN EDIT TO wave-state-machine.test.js. That file lives
 * at package root, outside this domain's owned glob
 * (packages/dogfood-swarm/lib/**\). This is a NEW file, flat in lib/ — in
 * the owned glob AND in package.json's "lib/*.test.js" discovery glob.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRANSITIONS } from './wave-state-machine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'wave-state-machine.js'), 'utf-8');

describe('wave-state-machine.js header — pending/collecting prose stays honest (F-88b6ba71)', () => {
  it('GATE: the retired false claim only exists as the F-017409f3 historical quotation, never as a live restatement', () => {
    // NOT a blanket "the phrase never appears" check: line 62 legitimately
    // QUOTES the retired claim ("...previously claimed the opposite —
    // '<retired phrase>' — which was true at Phase 5A but...") as history,
    // and that quotation is worth keeping. The regression this guards
    // against is the phrase reappearing as a LIVE, unattributed claim — so
    // every occurrence must be immediately preceded by the attribution
    // marker; an occurrence found anywhere else (a reverted paragraph, or a
    // NEW unattributed reintroduction elsewhere) fails.
    const retiredClaim = /no outbound edges[\s\S]{0,60}?immovable without explicit override/gi;
    const matches = [...SRC.matchAll(retiredClaim)];
    assert.ok(matches.length >= 1, 'sanity: the F-017409f3 historical quotation itself must still be present — this test does not demand its removal');
    for (const m of matches) {
      const precedingContext = SRC.slice(Math.max(0, m.index - 150), m.index);
      assert.match(
        precedingContext, /previously claimed the opposite/i,
        `retired-claim text found at offset ${m.index} without the historical-quotation attribution immediately before it — ` +
          'this is exactly the F-88b6ba71 regression: the false claim reintroduced as a live statement',
      );
    }
  });

  it('GATE: the corrected, honest claim about test coverage is present (not just the false one absent)', () => {
    assert.match(
      SRC, /pins TRANSITIONS\.pending\/collecting/,
      'the corrected prose must state what wave-state-machine.test.js ACTUALLY pins (the table\'s values) — ' +
        'a deleted paragraph would also pass the negative check above but is not "keeping the prose accurate"',
    );
  });

  it('ANCHOR: TRANSITIONS.pending/collecting actually have the two edges the prose describes', () => {
    // Cheap, self-contained cross-check tying this file's phrase-drift guard
    // to the real invariant, not just literal text — mirrors (does not
    // replace) wave-state-machine.test.js's own value pin, out of domain.
    assert.deepEqual(TRANSITIONS.pending.slice().sort(), ['aborted_for_rewind', 'dispatched']);
    assert.deepEqual(TRANSITIONS.collecting.slice().sort(), ['aborted_for_rewind', 'dispatched']);
  });
});
