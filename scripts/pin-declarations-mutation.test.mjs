/**
 * pin-declarations-mutation.test.mjs — mutation-test the matcher's OWN
 * source (dispatch C9, finding 30).
 *
 * "Mutating the analyzer's own source is the separate established technique
 * for proving its test suite would catch a regression in itself." This is
 * NOT C4/Tier-2 (mutating a FIX under test to prove a USER's regression pin
 * fails without it — that is wave 19's general, real-runtime-cost feature,
 * deliberately deferred per the dispatch's scope decision). This is
 * narrower and wave-18 scope: a fixed, hand-authored set of mutants of
 * pin-declarations.mjs's own critical branches, each applied to a REAL COPY
 * of the source, dynamically imported, and run against the same probe set
 * (the adversarial corpus plus the key defect-kind fixtures) the real test
 * suite already exercises. A mutant that produces IDENTICAL results on every
 * probe has SURVIVED — undetected by our own test suite — and the test
 * fails loud with a legible diff (finding 15: "the gate's output must show a
 * legible mutant diff", not just a pass/fail verdict).
 *
 * Deliberately NOT StrykerJS (findings 16/13 — that is real, Tier-2-adjacent
 * infra with real runtime cost, wave-19 territory alongside C4). This is a
 * small, targeted, auditable set of mutants chosen to hit the branches that
 * would silently reopen exactly the false-grant class this rewrite exists to
 * close — id-shape validation, call-qualification, comment-to-node
 * attachment, fail-closed parse-error handling, empty/multi-id tag parsing,
 * and word-boundary precision.
 *
 * MECHANISM: each mutant is a source-text transformation applied to a fresh
 * read of pin-declarations.mjs, written to a throwaway file INSIDE scripts/
 * (so its relative import of parse-regression-pins.js still resolves),
 * dynamically imported via its own file:// URL (a distinct path per mutant
 * is naturally cache-distinct — no query-string cache-busting needed), run
 * against PROBES, and deleted immediately after. If a mutant's target text
 * is not found in the current source, the harness fails loud rather than
 * silently reporting "survived" — a mutation harness that can't locate its
 * own mutation must not be mistaken for one that ran and found nothing.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PIN_DECLARATION_CORPUS } from './pin-declarations-corpus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, 'pin-declarations.mjs');
const sourceText = readFileSync(sourcePath, 'utf-8');

/**
 * Each mutant names the exact substring it replaces. If `find` is not
 * present in the current source, this is a harness bug (source drifted
 * under the mutant), not a survived mutant — see loadMutant below.
 */
const MUTANTS = [
  {
    name: 'invert-id-shape-check',
    rationale: 'C3 shape validation must reject malformed ids and accept well-formed ones — inverting the test should flip every corpus/probe assertion touching bad-shape or well-formed ids. (Retargeted for F-d77ffe1a\'s extractDeclaredIds rewrite — the single-line ok-computation this mutant inverts still exists, just inside the left-to-right token walk that also stops at the first post-valid-id failure.)',
    find: 'const ok = F_ID_PATTERN_ANCHORED.test(token);',
    replace: 'const ok = !F_ID_PATTERN_ANCHORED.test(token);',
  },
  {
    name: 'remove-qualifying-name-check',
    rationale: 'C1 requires the tag be attached to a real test()/it()/describe() call, not an arbitrary function call — removing the name check would let ANY call (e.g. mocha.test(...)) qualify.',
    find: 'if (!name || !QUALIFYING_CALL_NAMES.has(name)) return false;',
    replace: 'if (false) return false;',
  },
  {
    name: 'break-leading-comment-index-key',
    rationale: 'C2 attachment is keyed on comment.start at lookup time — indexing by comment.end instead would make every real tag report not-attached (the exact opposite defect from a false grant, but still a correctness break the suite must catch).',
    find: 'if (!index.has(c.start)) index.set(c.start, node);',
    replace: 'if (!index.has(c.end)) index.set(c.end, node);',
  },
  {
    name: 'silently-swallow-parse-errors',
    rationale: 'C7 fail-closed: a caught parse error must surface as parseError, never a fabricated clean result — this is THE mutation that would reopen "skipped and clean are indistinguishable" (finding 32).',
    find: `      parseError: {
        message: err.message,
        line: err.loc?.line ?? null,
        column: err.loc?.column ?? null,
      },
      pins: [],
      issues: [],
    };
  }`,
    replace: `      parseError: null,
      pins: [],
      issues: [],
    };
  }`,
  },
  {
    name: 'drop-empty-tag-detection',
    rationale: 'C3: an @pins tag with no id after it must be a reported defect, not silently ignored.',
    find: `    if (tokens.length === 0) {
      out.push({ token: null, ok: false });
      continue;
    }`,
    replace: `    if (tokens.length === 0) {
      continue;
    }`,
  },
  {
    name: 'keep-only-first-token',
    rationale: 'Multi-id @pins lines (comma-separated) must credit every listed id, not just the first.',
    find: 'const tokens = m[1].split(/[,\\s]+/).map((s) => s.trim()).filter(Boolean);',
    replace: 'const tokens = m[1].split(/[,\\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 1);',
  },
  {
    name: 'remove-word-boundary',
    rationale: 'PINS_TAG_LINE\'s \\b prevents an unrelated tag like @pinsomething from being misread as @pins — removing it would over-match.',
    find: 'const PINS_TAG_LINE = /^\\s*\\*?\\s*@pins\\b(.*)$/;',
    replace: 'const PINS_TAG_LINE = /^\\s*\\*?\\s*@pins(.*)$/;',
  },
  {
    name: 'remove-line-start-anchor',
    rationale: 'PINS_TAG_LINE requiring @pins to be the FIRST token on its line is what stops this module\'s own docstring PROSE mentioning "@pins" from being misread as a tag attempt (caught live during this wave\'s own development) — loosening the anchor would reintroduce that false-positive class.',
    find: 'const PINS_TAG_LINE = /^\\s*\\*?\\s*@pins\\b(.*)$/;',
    replace: 'const PINS_TAG_LINE = /@pins\\b(.*)$/;',
  },
];

function loadMutant(mutant, index) {
  if (!sourceText.includes(mutant.find)) {
    throw new Error(`mutant "${mutant.name}" target text not found in ${sourcePath} — source has drifted; update this mutant to match, do not silently skip it`);
  }
  const mutatedText = sourceText.replace(mutant.find, mutant.replace);
  assert.notEqual(mutatedText, sourceText, `mutant "${mutant.name}" produced no change — find/replace must differ`);
  const tempPath = resolve(here, `_mutant-${index}-${mutant.name}.mjs`);
  writeFileSync(tempPath, mutatedText, 'utf-8');
  return tempPath;
}

/**
 * The probe set every mutant is checked against — a mix of the full
 * adversarial corpus (both evasion and declared variants) and direct
 * fixtures for each defect kind, so a mutant only needs to disturb ONE
 * branch to be caught by SOMETHING here.
 */
function buildProbes() {
  const probes = [];
  for (const entry of PIN_DECLARATION_CORPUS) {
    // Every probe's run() returns true iff behavior is CORRECT (matching its
    // name), so the baseline sanity test below can assert a flat "every
    // probe is true" — the evasion probe therefore NEGATES the raw
    // is-credited check (correct behavior is "not credited").
    probes.push({
      name: `${entry.name}/evasion-not-credited`,
      run: (mod) => !mod.scanFileForDeclaredPins(`${entry.name}.test.js`, entry.evasionCode).pins.some((p) => p.id === entry.targetId),
    });
    probes.push({
      name: `${entry.name}/declared-credited`,
      run: (mod) => mod.scanFileForDeclaredPins(`${entry.name}.test.js`, entry.declaredCode).pins.some((p) => p.id === entry.targetId),
    });
  }
  probes.push({
    name: 'wrong-node-is-flagged',
    run: (mod) => mod.scanFileForDeclaredPins('x.test.js', '/** @pins F-99998888 */\nconst helper = 1;\n').issues.some((i) => i.kind === 'wrong-node'),
  });
  probes.push({
    name: 'not-attached-is-flagged',
    run: (mod) => mod.scanFileForDeclaredPins('x.test.js', "test('a', () => {});\n/** @pins F-aaaaaaaa */\n").issues.some((i) => i.kind === 'not-attached'),
  });
  probes.push({
    name: 'empty-tag-is-flagged',
    run: (mod) => mod.scanFileForDeclaredPins('x.test.js', "/** @pins */\ntest('a', () => {});\n").issues.some((i) => i.kind === 'empty-tag'),
  });
  probes.push({
    name: 'bad-shape-is-flagged',
    run: (mod) => mod.scanFileForDeclaredPins('x.test.js', "/** @pins NOT-AN-ID */\ntest('a', () => {});\n").issues.some((i) => i.kind === 'bad-shape'),
  });
  probes.push({
    name: 'multi-id-both-credited',
    run: (mod) => mod.scanFileForDeclaredPins('x.test.js', "/** @pins F-aaaaaaaa, F-bbbbbbbb */\ntest('t', () => {});\n").pins.length === 2,
  });
  probes.push({
    name: 'unrelated-namespaced-call-not-qualifying',
    run: (mod) => mod.scanFileForDeclaredPins('x.test.js', "/** @pins F-00000000 */\nmocha.test('t', () => {});\n").pins.length === 0,
  });
  probes.push({
    name: 'word-boundary-precision',
    run: (mod) => mod.extractDeclaredIds('* @pinsomething F-e003b1fb').length === 0,
  });
  probes.push({
    name: 'prose-mid-sentence-mention-not-a-tag-attempt',
    run: (mod) => mod.extractDeclaredIds(' this cannot carry a per-iteration @pins tag — a static comment').length === 0,
  });
  probes.push({
    name: 'parse-error-surfaced',
    run: (mod) => mod.scanFileForDeclaredPins('bad.test.js', 'function( { [ ] } (').parseError !== null,
  });
  return probes;
}

function runProbes(mod, probes) {
  const out = {};
  for (const probe of probes) {
    try {
      out[probe.name] = probe.run(mod);
    } catch (err) {
      out[probe.name] = `ERROR: ${err.message}`;
    }
  }
  return out;
}

test('mutation harness: baseline (unmutated) module passes every probe as expected', async () => {
  const mod = await import(pathToFileURL(sourcePath).href);
  const probes = buildProbes();
  const results = runProbes(mod, probes);
  const failed = Object.entries(results).filter(([, v]) => v !== true);
  // Every probe in buildProbes() is phrased so `true` is the correct baseline
  // answer — a false or ERROR result here means the PROBE SET itself is
  // wrong, not the source.
  assert.deepEqual(failed, [], `baseline module failed probes it should pass: ${JSON.stringify(failed, null, 2)}`);
});

for (const [index, mutant] of MUTANTS.entries()) {
  test(`mutation: "${mutant.name}" is killed by the existing probe set`, async (t) => {
    const baselineMod = await import(pathToFileURL(sourcePath).href);
    const probes = buildProbes();
    const baseline = runProbes(baselineMod, probes);

    const tempPath = loadMutant(mutant, index);
    t.after(() => rmSync(tempPath, { force: true }));

    const mutatedMod = await import(pathToFileURL(tempPath).href);
    const mutated = runProbes(mutatedMod, probes);

    const diffs = Object.keys(baseline).filter((name) => JSON.stringify(baseline[name]) !== JSON.stringify(mutated[name]));

    assert.ok(
      diffs.length > 0,
      `mutant "${mutant.name}" SURVIVED — no probe detected it (rationale: ${mutant.rationale}). ` +
      'A surviving mutant means the test suite would not catch this exact regression; ' +
      'add or strengthen a probe/test before trusting this branch.',
    );
    t.diagnostic(`mutant "${mutant.name}" killed by: ${diffs.join(', ')}`);
  });
}
