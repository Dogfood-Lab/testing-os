#!/usr/bin/env node
/**
 * case-file-prism-smoke.mjs — MANUAL on-rig live smoke for the PRISM-PER-SEAT jury
 * tier: each seat routes through a real prism-verify, one call per criterion.
 *
 * NOT a CI test (CI has neither prism nor Ollama). Run by hand on a rig with Ollama
 * serving the PRISM_JURY_SEATS models and prism-verify importable by `python`:
 *
 *   PRISM_SIGNING_KEY=~/.prism/signing-key.pem \
 *     node scripts/case-file-prism-smoke.mjs
 *
 * It adjudicates two case-files through the real panel and prints each advisory
 * verdict:
 *   1. the FIXED auth case-file  → expect ~corroborate (the guard is present)
 *   2. a BROKEN variant (guard removed) → expect the expiry criterion to fail
 *      (proves the jury DISCRIMINATES — a panel that passes everything is useless,
 *      the discrimination-floor concern).
 *
 * The discrimination check is the POINT. prism's own family-AB work has the receipt
 * for why: a verifier that cannot tell buggy from clean yields an uninterpretable
 * null, so it gates on discrimination rather than reporting a number it can't defend.
 *
 * Expect ~27s per (seat × criterion) — prism caps a call at 30s and runs four lenses
 * inside it — so this run is minutes, not seconds. That cost IS the tier.
 */

import { readFileSync } from 'node:fs';
import { adjudicate } from '../packages/dogfood-swarm/lib/case-file/adjudicate.js';
import { makePrismJury, PRISM_JURY_SEATS } from '../packages/dogfood-swarm/lib/case-file/prism-jury.js';

const fixed = JSON.parse(
  readFileSync(new URL('../fixtures/case-files/valid/well-formed-auth-fix.json', import.meta.url), 'utf8'),
);

// A broken variant: same objective + criteria, but the artifact ISSUES a token with no
// expiry guard. A competent juror should FAIL the expired-401 criterion.
const broken = JSON.parse(JSON.stringify(fixed));
broken.artifact_under_test.ref = 'packages/auth/refresh.js@BROKEN';
broken.artifact_under_test.content =
  '@@ -40,4 +40,4 @@\n function refresh(token) {\n-  // no expiry check\n   return issue(token);\n }';

const runJury = makePrismJury({ log: m => console.error(`  · ${m}`) });

function printResult(label, r) {
  console.log(`\n=== ${label} ===`);
  console.log(`overall: ${r.overall}   (authority=${r.authority}, law=${r.law}, advances_wave_alone=${r.advances_wave_alone})`);
  console.log(`panel: ${r.seats.join(', ')}`);
  for (const c of r.criteria) {
    console.log(`  ${c.id}: ${c.verdict}   [pass ${c.counts.pass} / fail ${c.counts.fail} / insufficient ${c.counts.insufficient_context}]`);
  }
}

console.error('Seats:', PRISM_JURY_SEATS.map(s => `${s.family}:${s.model}`).join(', '));
console.error(`Calls: ${PRISM_JURY_SEATS.length} seats × ${fixed.acceptance_criteria.length} criteria × 2 case-files = ${PRISM_JURY_SEATS.length * fixed.acceptance_criteria.length * 2}`);

console.error('\nAdjudicating the FIXED case-file…');
const started = Date.now();
const rFixed = await adjudicate(fixed, { runJury, seats: PRISM_JURY_SEATS });
console.error('\nAdjudicating the BROKEN case-file…');
const rBroken = await adjudicate(broken, { runJury, seats: PRISM_JURY_SEATS });

printResult('FIXED (guard present)', rFixed);
printResult('BROKEN (guard removed)', rBroken);

console.log(`\n(total ${((Date.now() - started) / 1000 / 60).toFixed(1)} min)`);
console.log('\n---');
if (rFixed.overall === rBroken.overall && rFixed.overall === 'corroborate') {
  console.log('⚠ NO DISCRIMINATION: both corroborated — the panel did not catch the removed guard.');
} else {
  console.log(`✓ discrimination: fixed=${rFixed.overall}, broken=${rBroken.overall}`);
}
