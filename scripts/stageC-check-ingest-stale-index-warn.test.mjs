/**
 * Stage C amend-wave regression guard for .github/workflows/ingest.yml
 * (PB-CI-003 stale-index annotation).
 *
 * Why this file exists:
 *
 * When packages/ingest/run.js persists a record but the subsequent index
 * rebuild throws, run.js does NOT fail — it logs a structured
 * `"failed_stage":"rebuild_indexes"` NDJSON event to STDERR and a
 * `console.error` "indexes/ may be stale until next ingest" warning, then
 * still returns `written:true` / `status:accepted`. (Confirmed by reading
 * run.js; the result JSON it prints to stdout carries no staleness field, so
 * the workflow cannot detect this from /tmp/ingest-result.json alone.)
 *
 * Consequence pre-amend: the ingest workflow commits the new record with a
 * STALE indexes/ tree and goes green with no operator signal. That is exactly
 * the "a partial/degraded run must SAY it degraded" humanization failure.
 *
 * Fix (workflow-side only — run.js is owned by another agent and must not be
 * edited): the ingestion steps capture run.js's stderr to a file, and a
 * dedicated step scans that capture for the rebuild-failure signal and emits a
 * `::warning::` so the stale-index commit shows on the run summary — mirroring
 * the push-retry `::warning::` discipline already in this file.
 *
 * Text-token assertions (no YAML parse), same rationale as the sibling
 * stage-check tests. Goes RED if the stderr capture or the staleness
 * `::warning::` annotation is dropped.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const ingestPath = resolve(repoRoot, '.github/workflows/ingest.yml');

test('ingest.yml exists', () => {
  assert.ok(existsSync(ingestPath), `expected workflow at ${ingestPath}`);
});

test('PB-CI-003: run.js stderr is captured so the rebuild-failure signal survives for inspection', () => {
  const text = readFileSync(ingestPath, 'utf8');
  // The result JSON only captures stdout via `tee`; the staleness event is on
  // stderr. The workflow must capture stderr to a file so it can be scanned.
  assert.match(
    text,
    /ingest-stderr\.log/,
    'ingest.yml must capture run.js stderr to /tmp/ingest-stderr.log so the rebuild_indexes failure event can be detected (PB-CI-003) — the stdout result JSON carries no staleness field.',
  );
});

test('PB-CI-003: a step emits a ::warning:: when run.js signals a stale index (degraded run must SAY it degraded)', () => {
  const text = readFileSync(ingestPath, 'utf8');
  // The scan keys on the signal run.js actually emits: a structured
  // failed_stage:"rebuild_indexes" event and/or the "may be stale" warning.
  assert.match(
    text,
    /rebuild_indexes|may be stale/,
    'ingest.yml must scan for run.js\'s rebuild_indexes / "may be stale" staleness signal (PB-CI-003).',
  );
  assert.match(
    text,
    /::warning::[^\n]*stale|::warning::[^\n]*index/i,
    'ingest.yml must emit a ::warning:: when the stale-index signal is present so the degraded run shows on the summary (PB-CI-003) — mirroring the push-retry ::warning:: discipline.',
  );
});

test('F-f05363e2: a badge/trends regeneration failure ALSO writes a note to $GITHUB_STEP_SUMMARY (not just an inline ::warning::)', () => {
  const text = readFileSync(ingestPath, 'utf8');
  // The badge/trends regen step degrades a generate.js failure to a non-fatal
  // ::warning:: (correct — a dropped record is worse than stale badges). But
  // pre-fix that inline annotation was the ONLY signal; an operator scanning
  // the run SUMMARY page saw green with no note that the served README badges
  // are now stale. The fix mirrors the 'Warn on stale indexes' step: on the
  // fallback branch it also appends a heading + note to $GITHUB_STEP_SUMMARY.
  //
  // Text-token assertions (no YAML parse), same rationale as the sibling
  // PB-CI-003 checks above. Goes RED if the summary write is dropped.
  assert.match(
    text,
    /### Badge\/trends regeneration skipped/,
    'ingest.yml must append a "### Badge/trends regeneration skipped" heading to $GITHUB_STEP_SUMMARY on the badge/trends regen fallback branch (F-f05363e2).',
  );
  // Scope the summary-write assertion to the badge/trends context so a future
  // edit that keeps the stale-index summary write but drops the badge one still
  // fails: the heading and its GITHUB_STEP_SUMMARY redirect must co-occur in a
  // window that also mentions the badge/trends generator.
  const badgeWindow = text.slice(
    text.indexOf('### Badge/trends regeneration skipped') - 400,
    text.indexOf('### Badge/trends regeneration skipped') + 400,
  );
  assert.match(
    badgeWindow,
    /GITHUB_STEP_SUMMARY/,
    'the "Badge/trends regeneration skipped" note must be written to $GITHUB_STEP_SUMMARY (F-f05363e2).',
  );
  assert.match(
    badgeWindow,
    /generate\.js|badge|trends/i,
    'the badge/trends summary note must sit on the generate.js fallback branch (F-f05363e2).',
  );
});

test("F-703e5eac: the badge/trends regen step ALSO fires when the result JSON was unparseable but a record was already persisted", () => {
  const text = readFileSync(ingestPath, 'utf8');
  // 'Read result' exits 0 (via parse_failed=true) BEFORE ever reaching the
  // written= extraction when `jq -e` fails on unparseable stdout — so
  // `written` stays unset even though run.js may have already persisted the
  // record to disk. The 'Commit records and indexes' step immediately below
  // already ORs in parse_failed for exactly this reason (see its own `if:`);
  // pre-fix the badge/trends regen step did not, so a persisted-but-
  // unparseable-stdout run committed the record but silently left the served
  // badge/trends endpoints stale with no operator-visible signal.
  const badgeStepIdx = text.indexOf('Regenerate served badges + trends');
  const commitStepIdx = text.indexOf('Commit records and indexes');
  assert.ok(badgeStepIdx > 0 && commitStepIdx > badgeStepIdx, 'expected the badge regen step to precede the commit step in ingest.yml');
  const badgeStepBlock = text.slice(badgeStepIdx, commitStepIdx);
  assert.match(
    badgeStepBlock,
    /if:\s*steps\.result\.outputs\.written\s*==\s*'true'\s*\|\|\s*steps\.result\.outputs\.parse_failed\s*==\s*'true'/,
    "ingest.yml's 'Regenerate served badges + trends' step must fire on steps.result.outputs.parse_failed == 'true' in addition to written == 'true' (F-703e5eac), matching the 'Commit records and indexes' step's condition immediately below it.",
  );
});

/** @pins F-e03646c0 */
test("F-e03646c0: the badge/trends regen step ALSO fires on either ingestion leg's deferred pipeline fault, matching the Commit step's condition byte-for-byte", () => {
  const text = readFileSync(ingestPath, 'utf8');
  // F-42e57a77 added the two `fault` disjuncts to the 'Commit records and
  // indexes' step (a run.js exit>=2 fault can fire AFTER a record was
  // already persisted to the runner working tree) but never propagated them
  // to the 'Regenerate served badges + trends' step above it — the same
  // incomplete-propagation shape F-703e5eac closed for parse_failed. Net
  // effect pre-fix: a deferred fault after a persist still committed the
  // record correctly, but silently skipped badges/trends regeneration with
  // none of the ::warning::/$GITHUB_STEP_SUMMARY signal the parse_failed
  // sibling branch gets.
  const badgeStepIdx = text.indexOf('Regenerate served badges + trends');
  const commitStepIdx = text.indexOf('Commit records and indexes');
  assert.ok(badgeStepIdx > 0 && commitStepIdx > badgeStepIdx, 'expected the badge regen step to precede the commit step in ingest.yml');
  const badgeStepBlock = text.slice(badgeStepIdx, commitStepIdx);

  const nextStepAfterCommit = text.indexOf('\n      - name:', commitStepIdx + 1);
  const commitStepBlock = text.slice(commitStepIdx, nextStepAfterCommit > 0 ? nextStepAfterCommit : text.length);

  assert.match(
    badgeStepBlock,
    /if:\s*steps\.result\.outputs\.written\s*==\s*'true'\s*\|\|\s*steps\.result\.outputs\.parse_failed\s*==\s*'true'\s*\|\|\s*steps\.ingest_rd\.outputs\.fault\s*!=\s*''\s*\|\|\s*steps\.ingest_wd\.outputs\.fault\s*!=\s*''/,
    "ingest.yml's 'Regenerate served badges + trends' step must fire on either ingestion leg's deferred fault (steps.ingest_rd.outputs.fault / steps.ingest_wd.outputs.fault) in addition to written/parse_failed (F-e03646c0), matching the 'Commit records and indexes' step's condition.",
  );

  // The two conditions must be an EXACT match, not merely both "contain" the
  // four disjuncts — a hand-typed variant that reorders or subtly changes
  // one side is exactly how the F-703e5eac / F-e03646c0 asymmetry started in
  // the first place, and a future edit to just one side should fail loud here.
  const extractIf = (block) => {
    const m = /^\s*if:\s*(.+)$/m.exec(block);
    return m ? m[1].trim() : null;
  };
  const badgeIf = extractIf(badgeStepBlock);
  const commitIf = extractIf(commitStepBlock);
  assert.ok(badgeIf && commitIf, 'expected both steps to have an `if:` condition');
  assert.equal(
    badgeIf,
    commitIf,
    "the badge-regen step's `if:` condition must be BYTE-IDENTICAL to the Commit step's condition (F-e03646c0) — any future drift between them silently reintroduces the propagation gap this fix closed.",
  );
});

test('F-W1-CI-008: the checkout step keeps fetch-depth: 0 (full clone) so the push-retry rebase works against arbitrary history', () => {
  // The push-with-retry loop downstream does `git pull --rebase` on failure;
  // a shallow clone cannot rebase against history that diverged by more than
  // one commit — it either rebases onto a graft missing intermediate commits
  // or fails with "refusing to merge unrelated histories" masquerading as a
  // concurrent-ingest conflict. The fix landed in wave 1 as a comment +
  // `fetch-depth: 0` in ingest.yml but carried no regression net until the
  // wave-8 disposition (the F-f0339e12 structural filter surfaced it as a
  // narrative-only pin). Comment lines are excluded below because the
  // in-file rationale comment itself contains the literal counter-example
  // string "(NOT fetch-depth: 1)".
  const text = readFileSync(ingestPath, 'utf8');
  const configLines = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));
  assert.ok(
    configLines.some((l) => /^\s*fetch-depth:\s*0\s*$/.test(l)),
    "ingest.yml's checkout step must set `fetch-depth: 0` (full clone) — the push-retry `git pull --rebase` cannot rebase from a shallow clone (F-W1-CI-008).",
  );
  assert.ok(
    !configLines.some((l) => /fetch-depth:\s*[1-9]/.test(l)),
    'ingest.yml must not regress to a shallow fetch-depth checkout (F-W1-CI-008).',
  );
});
