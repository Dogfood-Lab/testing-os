/**
 * wave8-approve-disposition-honesty.test.js — Stage C (humanization) honesty
 * pin for F-b8c0ae3a.
 *
 * The unrouted-approved-findings recovery hint (printed to the operator from
 * cmdDispatch at cli.js and logged as an NDJSON `hint` from commands/
 * dispatch.js) told operators to "close with `swarm approve --defer/--reject`"
 * — but `cmdApprove` implements ONLY `--all` / `--ids` and NO disposition flag.
 * An operator following the hint got the "Specify --all or --ids" guard with no
 * clue the flag they were told to use does not exist.
 *
 * Choice: the HONESTY fix (option b in the finding). The real mechanism for
 * closing a file-less / unroutable approved finding already exists — the
 * `coordinator_resolved` path (attach `coordinator_resolved: true` +
 * `verified_via_evidence` to the finding row; verify-classifier-v2 treats it as
 * an allowlist closure). We remove the fictional `swarm approve --defer/--reject`
 * reference from both hint sites so the surfaces agree with reality, rather than
 * implementing a new disposition verb that would extend the finding-severity
 * gate's operator contract for no demonstrated need.
 *
 * These pins assert (1) neither hint site names the nonexistent flag, (2) both
 * still name the real `coordinator_resolved` recovery path, and (3) cmdApprove
 * genuinely has no --defer/--reject branch (so the honesty fix is not papering
 * over a real feature).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSrc = readFileSync(join(__dirname, 'cli.js'), 'utf-8');
const dispatchSrc = readFileSync(join(__dirname, 'commands', 'dispatch.js'), 'utf-8');

function cmdApproveBody() {
  const start = cliSrc.indexOf('function cmdApprove(');
  const end = cliSrc.indexOf('function cmdPersist(');
  return cliSrc.slice(start, end);
}

describe('unrouted-approved recovery hint honesty (F-b8c0ae3a)', () => {
  it('cmdApprove implements no --defer/--reject disposition flag', () => {
    const body = cmdApproveBody();
    assert.doesNotMatch(body, /--defer/, 'cmdApprove must not silently gain a --defer branch');
    assert.doesNotMatch(body, /--reject/, 'cmdApprove must not silently gain a --reject branch');
  });

  it('the console recovery hint (cli.js) no longer points at the nonexistent swarm approve --defer/--reject', () => {
    assert.doesNotMatch(cliSrc, /swarm approve --defer/, 'console hint must not name a flag cmdApprove does not implement');
    assert.doesNotMatch(cliSrc, /approve --defer\/--reject/, 'console hint must drop the fictional disposition flag');
  });

  it('the NDJSON recovery hint (dispatch.js) no longer points at the nonexistent swarm approve --defer/--reject', () => {
    assert.doesNotMatch(dispatchSrc, /swarm approve --defer/, 'NDJSON hint must not name a flag cmdApprove does not implement');
    assert.doesNotMatch(dispatchSrc, /approve --defer\/--reject/, 'NDJSON hint must drop the fictional disposition flag');
  });

  it('both hint sites still name the real coordinator_resolved recovery path', () => {
    assert.match(cliSrc, /coordinator_resolved/, 'console hint must keep the real recovery path');
    assert.match(dispatchSrc, /coordinator_resolved/, 'NDJSON hint must keep the real recovery path');
  });
});
