/**
 * f-0b7ba713-adjudicate-out-of-brief-escaping.test.js -- F-0b7ba713 (MEDIUM,
 * wave 24): commands/adjudicate.js imported neither escapeReasonForDisplay
 * nor escapePathForDisplay anywhere in the file (confirmed by grep) -- zero
 * escaping discipline applied. formatAdjudication's out-of-brief render
 * printed a juror's free-text finding with no escaping at all: free-form
 * natural-language text parsed directly from a local Ollama juror's own
 * JSON response, with zero character constraint (lib/case-file/ollama-jury.js's
 * parseJurorResponse parses the model's raw JSON output into
 * `out_of_brief: string[]`). Jurors judge a case-file built from this run's
 * own audit findings -- descriptions/paths this package already treats as
 * attacker-adjacent (commands/collect.js) -- so a juror's free-text
 * commentary on "a defect not covered by a criterion" could plausibly echo a
 * hostile substring one LLM hop further removed than a direct agent quote.
 *
 * Fixed by importing escapeReasonForDisplay into commands/adjudicate.js and
 * routing the juror's finding text through it at the render site. The
 * per-finding juror COUNT alongside it is a plain aggregation tally
 * (lib/case-file/adjudicate.js's normalizeAdjudication:
 * `existing.jurors += 1` / `{ finding: ..., jurors: 1 }`), never free text,
 * so it is correctly left unescaped.
 *
 * Runs the REAL, unmocked pipeline: the real exported normalizeAdjudication
 * (lib/case-file/adjudicate.js) fuses a hand-built jurorVerdicts array --
 * standing in for a live Ollama juror's parsed response, since this
 * environment has no live Ollama jury (this module's own documented
 * boundary: "the live path is the manual on-rig smoke") -- into a result
 * object, which the REAL exported formatAdjudication (this domain's
 * commands/adjudicate.js) then renders. Neither function is reimplemented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatAdjudication } from './commands/adjudicate.js';
import { normalizeAdjudication } from './lib/case-file/adjudicate.js';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADJUDICATE_SRC = stripComments(readFileSync(join(__dirname, 'commands', 'adjudicate.js'), 'utf-8'));

const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);

const JURY_REQUEST = {
  rubric: {
    acceptance_criteria: [{ id: 'c1', check: 'does the fix land correctly' }],
  },
};

function verdictWithOutOfBrief(findingText) {
  return [{ seat: 'test-juror', criteria: { c1: 'pass' }, out_of_brief: [findingText] }];
}

/** @pins F-0b7ba713 */
describe('F-0b7ba713 -- formatAdjudication escapes juror out_of_brief free text (o.finding)', () => {
  it('GATE: commands/adjudicate.js imports escapeReasonForDisplay and routes o.finding through it at the out-of-brief render site', () => {
    assert.ok(
      ADJUDICATE_SRC.includes("import { escapeReasonForDisplay } from './lib/escape-reason.js';"),
      'expected commands/adjudicate.js to import escapeReasonForDisplay from its local lib/escape-reason.js',
    );
    assert.ok(
      ADJUDICATE_SRC.includes('lines.push(`  (${o.jurors}) ${escapeReasonForDisplay(o.finding)}`);'),
      'expected the out-of-brief render line to route o.finding through escapeReasonForDisplay, leaving the numeric o.jurors count bare',
    );
  });

  it('a raw RLO/PDF bidi-reversal wrap in a juror\'s out-of-brief finding does not survive into the rendered text', () => {
    const payload = `notes${RLO}reversed-look${PDF}-here`;
    const result = normalizeAdjudication(verdictWithOutOfBrief(payload), JURY_REQUEST, {});
    const text = formatAdjudication({ result, adjudicationId: 1, receiptPath: null });
    assert.ok(!text.includes(payload), `raw RLO/PDF-wrapped juror finding must not survive -- got:\n${text}`);
    assert.ok(!text.includes(RLO), `raw RLO byte must not survive -- got:\n${JSON.stringify(text)}`);
    assert.ok(text.includes('\\u202e'), `escaped RLO marker must be present -- got:\n${text}`);
  });

  it('an embedded newline in a juror\'s out-of-brief finding does not forge a fake second line', () => {
    const payload = 'a real defect the rubric missed\n(5) F-000000 FORGED entirely fake out-of-brief row';
    const result = normalizeAdjudication(verdictWithOutOfBrief(payload), JURY_REQUEST, {});
    const text = formatAdjudication({ result, adjudicationId: 1, receiptPath: null });
    assert.ok(
      !text.split('\n').some((l) => l.trim() === '(5) F-000000 FORGED entirely fake out-of-brief row'),
      `the injected newline must not become its own real, forged out-of-brief line:\n${text}`,
    );
    assert.ok(text.includes('\\n'), `escaped newline marker must be present (proves the value reached the escaping call):\n${text}`);
  });

  it('sanity: o.jurors (a plain aggregation count, never juror free text) still renders as a plain number, unaffected', () => {
    const result = normalizeAdjudication(verdictWithOutOfBrief('an ordinary, benign finding'), JURY_REQUEST, {});
    assert.equal(result.out_of_brief[0].jurors, 1, 'sanity: exactly one juror raised this finding');
    const text = formatAdjudication({ result, adjudicationId: 1, receiptPath: null });
    assert.match(text, /\(1\) an ordinary, benign finding/, `expected the plain count + unescaped benign text -- got:\n${text}`);
  });

  it('ordinary benign out-of-brief text is not over-escaped (no spurious backslashes)', () => {
    const result = normalizeAdjudication(verdictWithOutOfBrief('missing a null check on line 42'), JURY_REQUEST, {});
    const text = formatAdjudication({ result, adjudicationId: 1, receiptPath: null });
    assert.match(text, /missing a null check on line 42/, `plain ASCII finding text must render verbatim -- got:\n${text}`);
  });
});
