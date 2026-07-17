/**
 * f-264bd9d2-init-git-argv-form.test.js — F-264bd9d2 (LOW, wave 20):
 * commands/init.js's private git() helper now uses the argv-array form
 * (execFileSync), never a shell-string exec — closing the THIRD documented
 * instance of this class in this package (F-21240958 commands/persist.js,
 * pinned by wave2-4091637-5127-swarm-cp-pins.test.js's "F-21240958 — persist.js
 * ingest call never builds a shell command string" block; F-1f7f9de8
 * persist-results.js, pinned by lib/persist-results-no-shell-exec.test.js).
 *
 * SOURCE-PATTERN GATE, matching the established precedent for this EXACT
 * defect class — lib/persist-results-no-shell-exec.test.js's own header
 * explains why a dynamic on-disk injection PoC is deliberately NOT used for
 * this class: it would need a real, exploitable, still-OS-legal directory
 * name reaching a real shell, which is fragile and platform-entangled.
 *
 * A SEPARATE reason a dynamic hostile-path proof would not even be
 * RED-capable here, specific to init.js's git() helper: every call site
 * passes repoPath only as the `cwd` SPAWN OPTION, never string-interpolated
 * into an argv element or a command string — so a repo path containing
 * shell metacharacters is inert to a shell-string reimplementation of this
 * exact helper too (cwd is handed to the OS process-creation call directly
 * in both execFileSync and execSync; neither re-parses it through a shell).
 * The actual defect class this fix closes is architectural consistency +
 * defense-in-depth against a FUTURE edit that starts interpolating
 * operator/target-repo content into `args` (mirrors the two already-fixed
 * siblings) — provably checked by asserting the safe call shape is present
 * and the vulnerable one is absent, exactly like those two siblings do.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SRC = readFileSync(join(__dirname, 'commands', 'init.js'), 'utf-8');

/** @pins F-264bd9d2 */
describe('F-264bd9d2 — init.js private git() helper never builds a shell command string', () => {
  it('GATE: no execSync( call anywhere in init.js — execFileSync with an argv array only', () => {
    assert.doesNotMatch(
      INIT_SRC,
      /execSync\(/,
      'a shell-string exec (execSync) would re-parse its command through a shell — the same defect class already ' +
        'fixed in commands/persist.js (F-21240958) and persist-results.js (F-1f7f9de8)',
    );
    assert.match(
      INIT_SRC,
      /execFileSync\('git', args, \{ cwd, encoding: 'utf-8', stdio: \['pipe', 'pipe', 'pipe'\] \}\)/,
      "expected the argv-array form used by every other git/node invocation in the command layer " +
        "(dispatch.js's execFileSync('git', [...]), lib/worktree.js, and the two already-fixed siblings)",
    );
  });

  it('GATE: execFileSync is imported from node:child_process, not execSync', () => {
    assert.match(INIT_SRC, /import \{ execFileSync \} from 'node:child_process'/);
    assert.doesNotMatch(
      INIT_SRC,
      /import \{[^}]*\bexecSync\b[^}]*\} from 'node:child_process'/,
      'execSync must not be imported at all — its presence in the import list is how the vulnerable call got written in the first place',
    );
  });

  it('GATE: the private git() helper spawns argv elements, one array entry per argument — never a joined command string', () => {
    // Belt-and-braces on top of the two GATEs above: proves the helper does
    // not build a string anywhere in its own body (e.g. `args.join(' ')`
    // fed to execFileSync's 2nd positional as a single string would still
    // be argv-shaped syntactically but defeat the purpose). The function
    // body must pass `args` straight through as the array itself.
    const gitFnMatch = INIT_SRC.match(/function git\(cwd, args\) \{([\s\S]*?)\n\}/);
    assert.ok(gitFnMatch, 'expected a private function git(cwd, args) { ... } in init.js');
    assert.doesNotMatch(gitFnMatch[1], /\.join\(/, 'git() must not join args into a single string anywhere in its body');
    assert.match(gitFnMatch[1], /execFileSync\('git', args,/, "git() must pass `args` through as the array itself");
  });
});
