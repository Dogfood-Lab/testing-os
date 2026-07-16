/**
 * f-bf28b667-dogfood-reason-escaping.test.js — F-bf28b667 (LOW, wave 20):
 * this finding shipped as two DISTINCT halves, and this file is honest about
 * pinning only the half that has runtime behavior to assert:
 *
 *   HALF A (pinned here — substantive): commands/persist.js's
 *   result.dogfood.reason is either a fixed literal ('Dry run' / 'Not
 *   requested' / 'Ingest script not found') OR, on a failed ingest, a local
 *   execFileSync child-process error message (`Command failed: <cmd>\n<stderr>`,
 *   per Node's own child_process error shape) — and that stderr CAN
 *   legitimately be multi-line (packages/ingest/run.js's own validation
 *   output). Both render sites for this field now escape it:
 *     1. commands/persist.js's formatPersist() — the "Ingested: NO — ..." line.
 *     2. cli.js's cmdPersist() — the "ERROR [INGEST_FAILED]: ..." stderr line
 *        on the --ingest exit-1 path (a SEPARATE render of the same field;
 *        escaping only the summary render and leaving this one bare would
 *        repeat the single-instance-patch shape this wave exists to close —
 *        same class as F-d6cf96e4's two-site fix, different field).
 *
 *   HALF B (NOT pinned — disclosed, not silently skipped): persist.js's own
 *   header comment previously claimed to be "the only shell-string exec in
 *   the package's command layer" (false — init.js had one, F-264bd9d2) and
 *   described its ingest mechanism as "HTTP/API" (it is a local subprocess,
 *   packages/ingest/run.js invoked via execFileSync). Both corrected. A
 *   comment-text correction has no runtime surface — nothing to assert
 *   without inventing a tautological "the string X appears in a comment"
 *   check, which is exactly the kind of green-either-way test this repo's
 *   whole pin-matcher rewrite exists to stop crediting. Left honestly
 *   unpinned.
 *
 * Site 1 (persist.js) is pinned the same way F-d6cf96e4's site 1 is: a
 * DIRECT call to the real, exported formatPersist() with a hand-built
 * report object, mirroring meta-amendB-operator-output.test.js's existing
 * 'fp-p-004: formatPersist distinguishes artifacts-written from submitted'
 * block's own style for this exact function.
 *
 * Site 2 (cli.js) cannot be driven adversarially through a REAL ingest
 * failure without depending on packages/ingest/run.js's exact validation
 * wording (out of this domain's owned glob, and not guaranteed to contain a
 * newline on every failure shape) — so, matching F-d6cf96e4 site 2's same
 * honest reasoning, it is pinned by a source-pattern GATE proving the
 * escaping call is present at this exact call site.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatPersist } from './commands/persist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = readFileSync(join(__dirname, 'cli.js'), 'utf-8');

function baseReport(dogfoodReason) {
  return {
    runId: 'r1',
    verdict: 'pass',
    artifacts: { export: '/x/e.json', dogfoodSubmission: '/x/s.json', audit: '/x/audit' },
    dogfood: { ingested: false, reason: dogfoodReason },
    repoKnowledge: { artifactsWritten: true, submitted: false, path: '/x/audit', status: 'pass', posture: 'healthy' },
  };
}

/** @pins F-bf28b667 */
describe('F-bf28b667 — site 1: formatPersist escapes a multi-line dogfood.reason (real execFileSync child-process error shape)', () => {
  it('a "Command failed: <cmd>\\n<stderr>"-shaped multi-line reason renders as ONE summary line, not fragmented', () => {
    // The REAL shape Node's child_process produces for a failed execFileSync
    // call (see persist.js's own comment) — not a contrived payload.
    const realShapedReason = 'Command failed: node "packages/ingest/run.js" --provenance=stub --file "/x/s.json"\nValidationError: commit_sha must be 40 hex characters';
    const text = formatPersist(baseReport(realShapedReason));
    const lines = text.split('\n');
    const ingestedLine = lines.find((l) => l.includes('Ingested: NO'));
    assert.ok(ingestedLine, `expected an "Ingested: NO" line — got:\n${text}`);
    assert.ok(
      !lines.some((l) => l.trim() === 'ValidationError: commit_sha must be 40 hex characters'),
      `the embedded stderr newline must not become its own real output line (visual fragmentation) — got:\n${text}`,
    );
    assert.match(
      ingestedLine,
      /Command failed:.*\\nValidationError: commit_sha must be 40 hex characters/,
      `the multi-line child-process error must render as ONE line with a literal \\n escape — got: ${ingestedLine}`,
    );
  });

  it('the ANSI cursor-erase primitive in dogfood.reason never lands as a raw ESC byte', () => {
    const ESC = String.fromCharCode(0x1b);
    const text = formatPersist(baseReport(`Command failed: git${ESC}[1A${ESC}[2KTOTALLY LEGITIMATE`));
    assert.doesNotMatch(text, /\x1b/, 'no raw ESC byte may reach the persist summary output');
    assert.match(text, /Command failed: git\\x1b\[1A\\x1b\[2KTOTALLY LEGITIMATE/, 'the ANSI payload must render as its visible \\xHH escape form');
  });

  it('the ordinary fixed-literal reasons ("Dry run", "Not requested") still render plainly (no over-escaping)', () => {
    assert.match(formatPersist(baseReport('Not requested')), /Ingested: NO — Not requested/);
    assert.match(formatPersist(baseReport('Dry run')), /Ingested: NO — Dry run/);
  });
});

/** @pins F-bf28b667 */
describe('F-bf28b667 — site 2: cli.js cmdPersist() escapes the SAME field on the --ingest exit-1 stderr render', () => {
  it('GATE: the "ERROR [INGEST_FAILED]" console.error call site routes result.dogfood.reason through escapeReasonForDisplay', () => {
    assert.match(
      CLI_SRC,
      /console\.error\(`ERROR \[INGEST_FAILED\]: dogfood ingest did not complete — \$\{escapeReasonForDisplay\(result\.dogfood\.reason\)\}`\);/,
      'cmdPersist\'s exit-1 ERROR line must call escapeReasonForDisplay on result.dogfood.reason — a SEPARATE render ' +
        'of the same field formatPersist escapes (site 1 above); a local execFileSync child-process error message ' +
        'can legitimately be multi-line, which is exactly what site 1\'s test proves reaches this field in real operation',
    );
  });

  it('sanity: the escaping call sits on the --ingest && !dryRun && failed-ingest guarded path, not the unconditional success path', () => {
    // Bounded by the NEXT top-level `function ` declaration rather than a
    // guessed character count — see the identical rationale in
    // f-d6cf96e4-recommendation-reason-escaping.test.js's sibling sanity check.
    const fnStart = CLI_SRC.indexOf('function cmdPersist(');
    const fnEnd = CLI_SRC.indexOf('\nfunction ', fnStart + 10);
    assert.ok(fnStart > -1 && fnEnd > fnStart, 'expected to locate cmdPersist()\'s full body in cli.js');
    const cmdPersistSrc = CLI_SRC.slice(fnStart, fnEnd);
    const guardIdx = cmdPersistSrc.indexOf("result.dogfood.ingested !== true");
    const escapeCallIdx = cmdPersistSrc.indexOf('ERROR [INGEST_FAILED]');
    assert.ok(guardIdx > -1 && escapeCallIdx > -1, 'both anchors must be found within cmdPersist()');
    assert.ok(guardIdx < escapeCallIdx, 'the escaped ERROR render must be inside the failed-ingest guard, not on the unconditional path');
  });
});
