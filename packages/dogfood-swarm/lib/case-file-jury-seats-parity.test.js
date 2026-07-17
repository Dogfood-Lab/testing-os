/**
 * case-file-jury-seats-parity.test.js — F-efe53969 (site 1 of 2): a docs
 * audit surfaced that DEFAULT_JURY_SEATS (adjudicate.js, used for
 * `--jury=local --cloud` per cli.js:1569) silently omits the `hermes3:8b`
 * seat that LOCAL_JURY_SEATS (ollama-jury.js) carries, and re-pins the qwen
 * seat from `qwen2.5:7b` to `qwen3.6` — with no comment explaining either
 * change.
 *
 * INVESTIGATION (per this wave's fix instruction: "confirm whether the
 * hermes-drop/qwen-repin in DEFAULT_JURY_SEATS is deliberate; if so, document
 * it inline; if not, align it"):
 *
 *   1. Commit history: DEFAULT_JURY_SEATS (commit 9a64093, "add case-file
 *      jury adjudication layer") predates LOCAL_JURY_SEATS (commit da4095f,
 *      "add free local-Ollama jury adapter") in the DAG. The qwen2.5:7b-over-
 *      qwen3.x rationale ("a thinking model can spend a bounded budget on
 *      hidden reasoning and return empty JSON — the prism qwen3:32b trap")
 *      was written explicitly, ON PURPOSE, in the LATER commit — and never
 *      backported to the earlier constant.
 *   2. ollama-jury.js's own header comment (lines 44-48) describes the
 *      INTENDED relationship explicitly: "adjudicate's own DEFAULT_JURY_SEATS
 *      includes the gpt-oss / glm `:cloud` seats ... this constant [
 *      LOCAL_JURY_SEATS] is the explicit free-local opt-in" — i.e. DEFAULT is
 *      documented, by its own sibling file, as "LOCAL plus the two cloud
 *      seats." The current qwen3.6 pin and missing hermes seat contradict
 *      that documented relationship.
 *   3. No test in this repo asserts the current (qwen3.6, no hermes) shape as
 *      intentional or required — case-file-adjudicate.test.js only asserts
 *      DEFAULT_JURY_SEATS is entirely non-Claude.
 *
 * Conclusion: unintentional drift, not a deliberate design choice. This pins
 * the corrected relationship: DEFAULT_JURY_SEATS's non-cloud seats are
 * IDENTICAL to LOCAL_JURY_SEATS (same families, same models — most load-
 * bearing: the SAME qwen2.5:7b pin, avoiding the documented "thinking model"
 * trap for the paid --cloud tier too), plus the two cloud-routed seats
 * (openai/gpt-oss:120b-cloud, zhipu/glm-4.6:cloud) on top.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_JURY_SEATS } from './case-file/adjudicate.js';
import { LOCAL_JURY_SEATS } from './case-file/ollama-jury.js';

const CLOUD_FAMILIES = new Set(['openai', 'zhipu']);

describe('DEFAULT_JURY_SEATS — parity with LOCAL_JURY_SEATS plus the two cloud seats (F-efe53969)', () => {
  it('DEFAULT_JURY_SEATS carries every LOCAL_JURY_SEATS family, with the IDENTICAL model pin', () => {
    for (const localSeat of LOCAL_JURY_SEATS) {
      const matching = DEFAULT_JURY_SEATS.find(s => s.family === localSeat.family);
      assert.ok(matching, `DEFAULT_JURY_SEATS is missing the '${localSeat.family}' family LOCAL_JURY_SEATS carries`);
      assert.equal(matching.model, localSeat.model,
        `DEFAULT_JURY_SEATS pins '${localSeat.family}' to a different model (${matching.model}) than ` +
        `LOCAL_JURY_SEATS's deliberate choice (${localSeat.model}) — the qwen2.5:7b-over-qwen3.x "thinking model ` +
        'trap" rationale applies equally to the cloud tier');
    }
  });

  it('specifically: the hermes seat is present (the finding\'s named omission)', () => {
    const hermes = DEFAULT_JURY_SEATS.find(s => s.family === 'hermes');
    assert.ok(hermes, 'DEFAULT_JURY_SEATS must carry the hermes seat LOCAL_JURY_SEATS carries');
    assert.equal(hermes.model, 'hermes3:8b');
  });

  it('specifically: qwen is re-pinned to qwen2.5:7b, not qwen3.6 (the finding\'s named re-pin)', () => {
    const qwen = DEFAULT_JURY_SEATS.find(s => s.family === 'qwen');
    assert.ok(qwen);
    assert.equal(qwen.model, 'qwen2.5:7b');
  });

  it('DEFAULT_JURY_SEATS adds exactly the two documented cloud seats on top of the local roster', () => {
    const nonCloud = DEFAULT_JURY_SEATS.filter(s => !CLOUD_FAMILIES.has(s.family));
    assert.equal(nonCloud.length, LOCAL_JURY_SEATS.length,
      'DEFAULT_JURY_SEATS\'s non-cloud seat count must equal LOCAL_JURY_SEATS\'s seat count — no extra drift, no extra omission');

    const cloud = DEFAULT_JURY_SEATS.filter(s => CLOUD_FAMILIES.has(s.family));
    assert.equal(cloud.length, 2);
    assert.ok(cloud.some(s => s.family === 'openai' && s.model === 'gpt-oss:120b-cloud'));
    assert.ok(cloud.some(s => s.family === 'zhipu' && s.model === 'glm-4.6:cloud'));
  });

  it('every DEFAULT_JURY_SEATS seat remains non-Claude (Lock 1 must survive this alignment)', () => {
    for (const seat of DEFAULT_JURY_SEATS) {
      assert.doesNotMatch(seat.family.toLowerCase(), /anthropic|claude/);
    }
  });
});
