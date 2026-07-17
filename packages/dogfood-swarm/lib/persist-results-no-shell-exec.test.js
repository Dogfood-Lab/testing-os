/**
 * persist-results-no-shell-exec.test.js — F-1f7f9de8: persist-results.js's
 * ingest shell-out uses the argv-array form, never a shell string.
 *
 * Sibling of the already-fixed F-21240958 (commands/persist.js) — same
 * defect class, a different file. Pre-fix, persist-results.js built a SHELL
 * STRING with two interpolated values:
 *
 *   execSync(`node "${ingestScript}" --provenance=stub --file "${submissionPath}"`, ...)
 *
 * `submissionPath` derives from `absDir = resolve(manifestDir)` where
 * `manifestDir = process.argv[2]` — an operator-supplied CLI positional,
 * unvalidated for shell metacharacters before being embedded inside a
 * double-quoted argument in a string handed to execSync (which always
 * invokes a shell, unlike execFileSync). A `manifestDir` value containing a
 * `"` would break out of the quoted argument.
 *
 * WHY A SOURCE-PATTERN GATE, NOT A DYNAMIC INJECTION POC. `"` is not a legal
 * Windows filename character, and persist-results.js hard-gates on
 * `existsSync(manifestPath)` before ever reaching the ingest call — so a
 * dynamic exploit test would need a REAL, on-disk, exploitable-but-still
 * Windows-legal directory name reaching a REAL shell, which is fragile and
 * platform-entangled. F-21240958's own regression pin
 * (wave2-4091637-5127-swarm-cp-pins.test.js, describe block
 * 'F-21240958 — persist.js ingest call never builds a shell command string')
 * already established this exact bar for the identical defect class in the
 * sibling file: assert the vulnerable pattern is ABSENT and the safe pattern
 * is PRESENT, by source text. This file matches that precedent exactly
 * rather than inventing a different, heavier standard for the same class of
 * fix.
 *
 * WHY THIS FILE LIVES FLAT IN lib/, NOT AT PACKAGE ROOT. persist-results.js
 * is itself one of this domain's three owned globs
 * (packages/dogfood-swarm/persist-results.js), but package-root
 * `*.test.js` siblings are not — the F-21240958 pin file documents the
 * identical gap for commands/**\ tests, forced to package root with an
 * explicit cross_domain_notes entry. This file avoids that gap: it lives
 * flat in lib/ (inside packages/dogfood-swarm/lib/**\, this domain's owned
 * glob) and is still discovered by package.json's `"lib/*.test.js"` test
 * glob, so no cross-domain note is needed — it just reads
 * persist-results.js's source via a relative path from lib/.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSIST_RESULTS_SRC = readFileSync(join(__dirname, '..', 'persist-results.js'), 'utf-8');

describe('F-1f7f9de8 — persist-results.js ingest call never builds a shell command string', () => {
  it('GATE: no execSync( call in persist-results.js — execFileSync with an argv array only', () => {
    assert.doesNotMatch(
      PERSIST_RESULTS_SRC,
      /execSync\(/,
      'pre-fix: execSync(`node "${ingestScript}" --provenance=stub --file "${submissionPath}"`) interpolated ' +
        'an operator-supplied, unvalidated CLI positional (manifestDir, via submissionPath) into a shell command string',
    );
    assert.match(
      PERSIST_RESULTS_SRC,
      /execFileSync\('node', \[ingestScript, '--provenance=stub', '--file', submissionPath\]/,
      "expected the argv-array form used by every other subprocess call in this package " +
        "(dispatch.js, lib/worktree.js, and F-21240958's fix in commands/persist.js)",
    );
  });

  it('GATE: execFileSync is imported from node:child_process, not execSync', () => {
    assert.match(PERSIST_RESULTS_SRC, /import \{ execFileSync \} from 'node:child_process'/);
    assert.doesNotMatch(
      PERSIST_RESULTS_SRC,
      /import \{[^}]*\bexecSync\b[^}]*\} from 'node:child_process'/,
      'execSync must not be imported at all — its presence in the import list is how the vulnerable call got written in the first place',
    );
  });
});
