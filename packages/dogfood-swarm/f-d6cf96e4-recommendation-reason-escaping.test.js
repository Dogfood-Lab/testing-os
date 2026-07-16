/**
 * f-d6cf96e4-recommendation-reason-escaping.test.js — F-d6cf96e4 (MEDIUM,
 * wave 20): receipt.recommendation.reason (computeRecommendation()'s return
 * value, commands/receipt.js) had TWO independent text-render sites:
 *
 *   1. commands/receipt.js's formatReceiptMarkdown() — the ## Recommendation
 *      section of the exported .md receipt artifact.
 *   2. cli.js's cmdReceipt() — the CLI's own separate `Recommendation: ...`
 *      stdout line (the --format=json branch already returns the raw object
 *      untouched, upstream of this line).
 *
 * Site 1 shipped escaped in wave 18's original sweep; site 2 did not — a
 * second, independent render of the SAME field, added THIS wave
 * proactively, before any real-world value ever reached it unescaped
 * ("class-completion", not a live-exploit fix: today every
 * computeRecommendation() branch returns a fixed, hand-edited English
 * string with no control bytes — see that function's own branches). Both
 * sites now route through escapeReasonForDisplay. This is exactly the
 * "don't repeat wave 18's single-instance patch" shape wave 19's audit
 * exists to catch, applied proactively to a field this wave already
 * touched once — so both sites are pinned, not just the historically-fixed
 * one.
 *
 * SITE 1 is pinned by a DIRECT call to the real, exported
 * formatReceiptMarkdown() with a hand-built receipt object — the exact
 * precedent wave18-4091637-5127-swarm-cp-pins.test.js's "Direct-call pins
 * for the remaining two self-discovered sites" describe block already
 * established for this identical function (there: state_transitions[0].reason;
 * here: recommendation.reason — same formatter, same escaping mechanism,
 * different field).
 *
 * SITE 2 cannot be driven adversarially through the real
 * buildReceipt()->computeRecommendation() call graph — every branch of
 * computeRecommendation() returns one of a small set of fixed literal
 * strings, never operator or target-repo content (this is disclosed
 * plainly, not glossed over: it is the reason the fix's own comment calls
 * this "safe today"). A CLI-subprocess test seeded only with those real
 * fixed strings would render byte-identical output whether or not the
 * escaping call is present (no control bytes to neutralize), making it a
 * VACUOUS pin for a revert of this specific line. So SITE 2 is pinned by a
 * source-pattern GATE proving the escaping call is present at THIS EXACT
 * call site — closing the precise gap reason-escaping-discipline.test.js's
 * own docstring discloses it cannot catch ("would NOT catch a new
 * unescaped line added to a file that already legitimately calls
 * escapeReasonForDisplay elsewhere for a DIFFERENT site" — cli.js already
 * calls it from a dozen other verbs, so that coarser FILE-level gate is
 * satisfied regardless of this one line).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatReceiptMarkdown } from './commands/receipt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = readFileSync(join(__dirname, 'cli.js'), 'utf-8');

function baseReceipt(recommendation) {
  return {
    run: { id: 'r1', repo: 'org/repo', commit_sha: 'a'.repeat(40), branch: 'main' },
    wave: { id: 1, number: 4, phase: 'health-amend-a', status: 'advanced', domain_snapshot_id: 'x', ownership_probe_degraded: false },
    generated_at: '2026-07-16T10:00:00Z',
    agents: [],
    state_transitions: [],
    ownership_violations: [],
    findings: { total: 0, by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, this_wave: { new: 0, recurring: 0, fixed: 0 }, by_status: {} },
    verification: null,
    recommendation,
  };
}

/** @pins F-d6cf96e4 */
describe('F-d6cf96e4 — site 1: formatReceiptMarkdown escapes recommendation.reason', () => {
  it('a raw newline in recommendation.reason cannot forge a fake Markdown line in the ## Recommendation section', () => {
    const forgedLine = '## Fake Section — nothing to see here';
    const receipt = baseReceipt({ action: 'FIX', reason: `Blocked agents need manual intervention before advancing\n${forgedLine}` });
    const text = formatReceiptMarkdown(receipt);
    assert.ok(
      !text.split('\n').some((l) => l.trim() === forgedLine),
      `the injected newline must not become its own real Markdown line — got:\n${text}`,
    );
    assert.ok(
      text.includes('Blocked agents need manual intervention before advancing\\n## Fake Section'),
      `the raw newline must render as the literal two-character escape \\n — got:\n${text}`,
    );
  });

  it('the ANSI cursor-erase primitive in recommendation.reason never lands as a raw ESC byte in the receipt', () => {
    const ESC = String.fromCharCode(0x1b);
    const receipt = baseReceipt({ action: 'WAIT', reason: `ok${ESC}[1A${ESC}[2KTOTALLY LEGITIMATE` });
    const text = formatReceiptMarkdown(receipt);
    assert.doesNotMatch(text, /\x1b/, 'no raw ESC byte may land in the markdown receipt');
    assert.match(text, /ok\\x1b\[1A\\x1b\[2KTOTALLY LEGITIMATE/, 'the ANSI payload must render as its visible \\xHH escape form');
  });

  it('a null recommendation.reason renders no trailer clause at all (no crash, no "undefined")', () => {
    const receipt = baseReceipt({ action: 'ADVANCE', reason: null });
    const text = formatReceiptMarkdown(receipt);
    assert.match(text, /\*\*ADVANCE\*\*$/m, 'no reason means no " — ..." trailer');
    assert.doesNotMatch(text, /undefined/);
  });
});

/** @pins F-d6cf96e4 */
describe('F-d6cf96e4 — site 2: cli.js cmdReceipt() escapes the SAME field on its own separate stdout render', () => {
  it('GATE: the "Recommendation:" console.log call site routes receipt.recommendation.reason through escapeReasonForDisplay', () => {
    assert.match(
      CLI_SRC,
      /console\.log\(`Recommendation: \$\{receipt\.recommendation\.action\}\$\{receipt\.recommendation\.reason \? ' — ' \+ escapeReasonForDisplay\(receipt\.recommendation\.reason\) : ''\}`\);/,
      'cmdReceipt\'s stdout Recommendation line must call escapeReasonForDisplay on receipt.recommendation.reason — ' +
        'this is a SEPARATE render of the same field formatReceiptMarkdown escapes (site 1 above); the --format=json ' +
        'branch above it returns the raw receipt object untouched and must stay that way (see the sibling ' +
        '--format=json losslessness pin elsewhere in this package for that half of the invariant)',
    );
  });

  it('sanity: the --format=json branch returns before this line runs, so it never double-escapes the JSON path', () => {
    // Bounded by the NEXT top-level `function ` declaration rather than a
    // guessed character count, so this stays correct as cmdReceipt() grows —
    // a fixed-length slice silently under-shooting the function body (cutting
    // off before either anchor) is exactly the kind of self-inflicted false
    // failure that would make a future maintainer distrust this gate.
    const fnStart = CLI_SRC.indexOf('function cmdReceipt(');
    const fnEnd = CLI_SRC.indexOf('\nfunction ', fnStart + 10);
    assert.ok(fnStart > -1 && fnEnd > fnStart, 'expected to locate cmdReceipt()\'s full body in cli.js');
    const cmdReceiptSrc = CLI_SRC.slice(fnStart, fnEnd);
    const jsonBranchIdx = cmdReceiptSrc.indexOf("if (format === 'json')");
    const recommendationLineIdx = cmdReceiptSrc.indexOf('Recommendation:');
    assert.ok(jsonBranchIdx > -1 && recommendationLineIdx > -1, 'both anchors must be found within cmdReceipt()');
    assert.ok(jsonBranchIdx < recommendationLineIdx, 'the --format=json branch (with its own `return`) must appear BEFORE the escaped stdout render');
  });
});
