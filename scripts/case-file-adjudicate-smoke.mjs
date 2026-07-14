#!/usr/bin/env node
/**
 * case-file-adjudicate-smoke.mjs — MANUAL on-rig live smoke for the case-file
 * adjudication path against a real local-Ollama family-different jury.
 *
 * NOT a CI test (CI has no Ollama). Run by hand on a rig with Ollama serving the
 * LOCAL_JURY_SEATS models:
 *
 *   node scripts/case-file-adjudicate-smoke.mjs
 *
 * It adjudicates two case-files through the real panel and prints each advisory
 * verdict:
 *   1. the FIXED auth case-file  → expect ~corroborate (the guard is present)
 *   2. a BROKEN variant (guard removed) → expect the expiry criterion to fail
 *      (proves the jury DISCRIMINATES — a panel that passes everything is useless,
 *      the discrimination-floor concern).
 */

import { readFileSync } from 'node:fs';
import { adjudicate } from '../packages/dogfood-swarm/lib/case-file/adjudicate.js';
import { makeOllamaJury, LOCAL_JURY_SEATS } from '../packages/dogfood-swarm/lib/case-file/ollama-jury.js';

const fixed = JSON.parse(
  readFileSync(new URL('../fixtures/case-files/valid/well-formed-auth-fix.json', import.meta.url), 'utf8'),
);

// A broken variant: same objective + criteria, but the artifact ISSUES a token
// with no expiry guard. A competent juror should FAIL the expired-401 criterion.
const broken = JSON.parse(JSON.stringify(fixed));
broken.artifact_under_test.ref = 'packages/auth/refresh.js@BROKEN';
broken.artifact_under_test.content =
  '@@ -40,4 +40,4 @@\n function refresh(token) {\n-  // no expiry check\n   return issue(token);\n }';

const runJury = makeOllamaJury({ seats: LOCAL_JURY_SEATS, log: m => console.error(`  · ${m}`) });

function printResult(label, r) {
  console.log(`\n=== ${label} ===`);
  console.log(`overall: ${r.overall}   (authority=${r.authority}, law=${r.law}, advances_wave_alone=${r.advances_wave_alone})`);
  console.log(`panel: ${r.seats.join(', ')}`);
  for (const c of r.criteria) {
    console.log(`  ${c.id}: ${c.verdict}   [pass ${c.counts.pass} / fail ${c.counts.fail} / insufficient ${c.counts.insufficient_context}]`);
  }
  if (r.out_of_brief.length) {
    console.log('  out-of-brief:');
    for (const o of r.out_of_brief) console.log(`    - (${o.jurors}) ${o.finding}`);
  }
}

console.error('Seats:', LOCAL_JURY_SEATS.map(s => `${s.family}:${s.model}`).join(', '));
console.error('Adjudicating the FIXED case-file…');
const rFixed = await adjudicate(fixed, { runJury, seats: LOCAL_JURY_SEATS });
console.error('Adjudicating the BROKEN case-file…');
const rBroken = await adjudicate(broken, { runJury, seats: LOCAL_JURY_SEATS });

printResult('FIXED (guard present)', rFixed);
printResult('BROKEN (guard removed)', rBroken);

// Discrimination check: the broken variant should not read the same as the fixed.
console.log('\n---');
if (rFixed.overall === rBroken.overall && rFixed.overall === 'corroborate') {
  console.log('⚠ NO DISCRIMINATION: both corroborated — the panel did not catch the removed guard.');
} else {
  console.log(`✓ discrimination: fixed=${rFixed.overall}, broken=${rBroken.overall}`);
}
