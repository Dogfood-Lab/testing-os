/**
 * templates-fence-safe-checklist-boundary.test.js — F-f2dc3caf:
 * fenceSafeBlock (wave-10's F-62e467be fix) recovers per-finding chunk
 * boundaries by splitting opts.priorContext at every line matching the bare
 * prefix `/^- \[/gm`, anchored on dispatch.js's bullet format
 * `- [status] finding_id: description (file)`. That anchor also matched a
 * GFM Markdown task-list line (`- [ ] step one` / `- [x] step two`) embedded
 * INSIDE a finding's own multi-line description — an ordinary, common
 * LLM-authored shape for repro/verification steps, not an exotic
 * construction. A finding whose description contains an evenly-paired
 * fenced example wrapping such a checklist got over-segmented into extra
 * chunks at each checklist line, so the fence's own opening/closing markers
 * ended up alone in their own odd-count chunks and were BOTH neutralized —
 * garbling a legitimate fenced example the wave-10 fix was specifically
 * designed to leave untouched (F-01458fdb's own protection, recovered
 * per-chunk by F-62e467be).
 *
 * THE FIX. fenceSafeBlock's boundary regex now requires the FULL real-bullet
 * shape (`- [<2+ word chars>] <colon-terminated token>`) rather than the
 * bare `- [` prefix — see templates.js#fenceSafeBlock's own header for why a
 * fence-parity-aware scan was considered and rejected in favor of this
 * tightened anchor (it cannot tell a fence that closes again within the
 * CURRENT finding apart from several independent findings' stray markers
 * that merely sum to even across a finding boundary — collapsing that
 * distinction would regress F-62e467be). CommonMark/GFM task-list syntax is
 * always a single space/x/X inside the brackets, so a checklist line can
 * never satisfy the tightened anchor and is simply never a boundary
 * candidate — the whole finding (fence included) stays one chunk, and a
 * single whole-chunk fenceSafe() parity check (2 runs, even) leaves it
 * untouched.
 *
 * PROOF METHOD. Mirrors templates-fence-safe-concatenation.test.js: direct
 * execution through the real, unmodified buildAuditPrompt (fenceSafeBlock is
 * module-private by design). Test 3 below deliberately COMBINES the
 * checklist-embedding finding with two INDEPENDENT stray-backtick findings
 * (the exact shape F-62e467be's own pin suite covers) to prove this fix does
 * not regress per-finding isolation while fixing the over-segmentation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuditPrompt } from './templates.js';

const BASE_OPTS = {
  repoPath: '/tmp/repo',
  repo: 'org/repo',
  domainName: 'backend',
  globs: ['packages/**'],
  ownershipClass: 'owned',
  domainSnapshotId: 'deadbeef',
  waveNumber: 1,
};

/** Mirrors templates-fence-safe-concatenation.test.js's own top-to-bottom toggle walker. */
function endsInsideOpenFence(text) {
  const markers = text.match(/`{3,}/g) || [];
  return markers.length % 2 === 1;
}

/** Builds a dispatch.js-shaped priorContext blob, exactly like commands/dispatch.js:488-496. */
function buildPriorContext(findings) {
  return findings
    .map((f) => `- [${f.status}] ${f.finding_id}: ${f.description} (${f.file || '?'})`)
    .join('\n');
}

// A realistic, evenly-paired (2 backtick runs) fenced repro-steps example
// whose OWN body embeds a GFM task-list checklist — one unchecked, one
// checked item, exercising both marker variants (`- [ ]` and `- [x]`) in a
// single fixture.
const CHECKLIST_FENCED_EXAMPLE =
  'Repro steps:\n```\n- [ ] run npm test\n- [x] observe the failure\n```\nThen apply the fix.';

describe('fenceSafeBlock via buildAuditPrompt — a finding-own checklist inside a legitimate fence no longer over-segments (F-f2dc3caf)', () => {
  it('a fenced repro-steps example embedding a checklist survives byte-identical', () => {
    const priorContext = buildPriorContext([
      { status: 'recurring', finding_id: 'F-aaaaaaaa', file: 'src/a.js', description: CHECKLIST_FENCED_EXAMPLE },
    ]);
    // Fixture sanity: the raw blob has an EVEN total run count (2 — one
    // opener, one closer) — this is the exact shape the bare `- [` anchor
    // used to shatter into three odd chunks despite the aggregate parity
    // already being safe.
    assert.equal((priorContext.match(/`{3,}/g) || []).length, 2,
      'fixture sanity: one legitimate opening + closing fence, evenly paired');

    const prompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a', priorContext });

    assert.ok(prompt.includes(CHECKLIST_FENCED_EXAMPLE),
      "a finding's own evenly-paired fenced example must survive byte-identical even when it embeds a `- [ ]`/`- [x]` checklist — the checklist lines must never be mistaken for a new finding-bullet boundary");
    assert.equal(endsInsideOpenFence(prompt), false, 'the document must still end outside any open fence');
  });

  it('the worked-example JSON block still parses after a checklist-embedding priorContext', () => {
    const priorContext = buildPriorContext([
      { status: 'recurring', finding_id: 'F-aaaaaaaa', file: 'src/a.js', description: CHECKLIST_FENCED_EXAMPLE },
    ]);
    const prompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a', priorContext });

    const m = /```json\n([\s\S]*?)\n```/.exec(prompt);
    assert.ok(m, 'the real ```json worked-example fence must still be literally present and matchable');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.domain, 'backend');
  });

  it('a checklist-embedding finding sandwiched between two INDEPENDENT stray-backtick findings survives intact, while its neighbors are still isolated and neutralized on their own (F-62e467be regression guard)', () => {
    const findings = [
      { status: 'new', finding_id: 'F-11111111', file: 'src/1.js', description: 'a lone ``` stray marker, never closed within this finding' },
      { status: 'recurring', finding_id: 'F-22222222', file: 'src/2.js', description: CHECKLIST_FENCED_EXAMPLE },
      { status: 'new', finding_id: 'F-33333333', file: 'src/3.js', description: 'another lone ``` stray marker, also never closed within this finding' },
    ];
    const priorContext = buildPriorContext(findings);
    // Fixture sanity: 1 (finding A) + 2 (finding B's legitimate pair) + 1
    // (finding C) = 4 backtick runs total (even) — a blob shape that could
    // hide either defect (F-62e467be's cross-finding cancellation, OR
    // F-f2dc3caf's within-finding over-segmentation) behind a misleadingly
    // reassuring aggregate parity.
    assert.equal((priorContext.match(/`{3,}/g) || []).length, 4,
      'fixture sanity: three independent contributors summing to an even total');

    const prompt = buildAuditPrompt({ ...BASE_OPTS, phase: 'health-audit-a', priorContext });

    assert.ok(prompt.includes(CHECKLIST_FENCED_EXAMPLE),
      "the sandwiched finding's own legitimate fenced+checklist example must survive byte-identical — neighboring findings' own stray markers must not affect it, and its OWN checklist lines must not fragment it");
    assert.ok(prompt.includes('F-11111111') && prompt.includes('F-33333333'),
      'the neighboring findings must still be present (neutralized internally, not dropped)');
    assert.equal(endsInsideOpenFence(prompt), false, 'the document must still end outside any open fence');

    const m = /```json\n([\s\S]*?)\n```/.exec(prompt);
    assert.ok(m, 'the real ```json worked-example fence must still be literally present and matchable');
    JSON.parse(m[1]);
  });
});
