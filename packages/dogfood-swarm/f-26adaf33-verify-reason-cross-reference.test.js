/**
 * f-26adaf33-verify-reason-cross-reference.test.js -- F-26adaf33 (LOW, wave 22):
 * a second, independent render site of `result.reason` exists beyond the one
 * wave 20's fix comment (F-4773fb77) documents. commands/verify.js's
 * formatVerify (the `if (result.reason) lines.push(...)` line) carries the
 * wave-20 safety argument for why leaving result.reason unescaped is
 * deliberate and safe -- it is always a fixed template string from
 * lib/verify/runner.js, never target-repo content. cli.js's non-pass exit
 * path (`swarm verify: ${result.verdict.toUpperCase()} -- ${why}`, where
 * `why` falls back to result.reason) renders the SAME field a second time
 * with no cross-reference to that safety argument. NOT a live defect (the
 * value is safe today by the identical reasoning) -- a documentation-
 * completeness gap: a future reader auditing "is it safe to leave
 * result.reason unescaped" who reads only one site's comment would not know
 * a second render site relies on the same invariant.
 *
 * Fixed by adding a one-line cross-reference at both sites. This test pins
 * two things: (1) both cross-reference comments actually exist (the fix
 * itself), and (2) the underlying safety invariant the comments describe --
 * enumerated independently against the REAL adapter source, not assumed
 * from prose (PROTOCOL.md "Fixing a class, not an instance" sub-law 2:
 * "enumerate the population independently and diff it against what your
 * detector sees").
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = readFileSync(join(__dirname, 'cli.js'), 'utf-8');
const VERIFY_JS_SRC = readFileSync(join(__dirname, 'commands', 'verify.js'), 'utf-8');
const NODE_ADAPTER_SRC = readFileSync(join(__dirname, 'lib', 'verify', 'adapters', 'node.js'), 'utf-8');
const PYTHON_ADAPTER_SRC = readFileSync(join(__dirname, 'lib', 'verify', 'adapters', 'python.js'), 'utf-8');
const RUST_ADAPTER_SRC = readFileSync(join(__dirname, 'lib', 'verify', 'adapters', 'rust.js'), 'utf-8');
const RUNNER_SRC = readFileSync(join(__dirname, 'lib', 'verify', 'runner.js'), 'utf-8');

/** @pins F-26adaf33 */
describe('F-26adaf33 -- the "result.reason is safe by construction" invariant is documented at BOTH render sites', () => {
  it('GATE: cli.js\'s non-pass exit path carries a comment cross-referencing verify.js\'s F-4773fb77 safety argument', () => {
    const stripped = stripComments(CLI_SRC);
    // The comment itself is stripped by design (it is prose, not the thing
    // under test) -- assert against the UNSTRIPPED source instead, since the
    // comment's PRESENCE is exactly what this finding's fix adds.
    assert.match(
      CLI_SRC,
      /F-26adaf33[\s\S]{0,400}commands\/verify\.js/,
      'cli.js must carry a comment near the swarm-verify non-pass exit path citing F-26adaf33 and pointing at commands/verify.js',
    );
    // Sanity: the render line itself is unchanged (this finding does not
    // change behavior, only documents it) -- still interpolates `why`
    // unescaped, exactly as wave 20's identical reasoning already covers.
    assert.match(
      stripped,
      /console\.error\(`swarm verify: \$\{result\.verdict\.toUpperCase\(\)\} — \$\{why\}`\);/,
      'the non-pass exit path render line itself must be unchanged',
    );
  });

  it('GATE: verify.js\'s F-4773fb77 safety-argument comment carries a reciprocal cross-reference to cli.js', () => {
    assert.match(
      VERIFY_JS_SRC,
      /F-26adaf33[\s\S]{0,400}cli\.js/,
      'commands/verify.js must carry a comment near its own result.reason render citing F-26adaf33 and pointing back at cli.js',
    );
  });

  it('the safety invariant itself: every adapter\'s step `name` is drawn from a small, fixed, hardcoded set -- never target-repo or operator-controlled content', () => {
    // ve-tc-001: the character class is `[a-z:]`, not `[a-z]`, so the colon in
    // the node adapter's `typecheck:tests` step name is captured rather than
    // silently split (a bare `[a-z]+` would match `typecheck` up to the colon
    // and drop the literal from the set — the pin would stay green while going
    // BLIND to a real new step-name literal, the exact multi-occurrence-drift
    // shape this pin exists to catch). Re-audit, per this pin's own charter:
    // `typecheck:tests` is a hardcoded per-adapter literal exactly like the
    // other five — it is NOT target-repo or operator content — so F-26adaf33's
    // (and F-4773fb77's) safety argument for leaving `result.reason` / cli.js's
    // `why` unescaped still holds. The set grew; the invariant did not change.
    const nameLiterals = (src) => Array.from(src.matchAll(/\bname:\s*'([a-z:]+)'/g), (m) => m[1]);
    const allNames = new Set([
      ...nameLiterals(NODE_ADAPTER_SRC),
      ...nameLiterals(PYTHON_ADAPTER_SRC),
      ...nameLiterals(RUST_ADAPTER_SRC),
    ]);
    assert.deepEqual(
      [...allNames].sort(),
      ['build', 'check', 'lint', 'test', 'typecheck', 'typecheck:tests'],
      `expected exactly the 6 hardcoded step-name literals this finding's safety argument counts on -- if this ever grows, F-26adaf33's (and F-4773fb77's) safety argument needs re-auditing, not just this pin updating: ${JSON.stringify([...allNames].sort())}`,
    );
  });

  it('the safety invariant itself: runner.js never assigns a step exit_code from a template literal, string concatenation, or quoted text -- only numeric literals, identifiers, `??`, and `?:`', () => {
    const exitCodeAssignments = Array.from(RUNNER_SRC.matchAll(/exit_code:\s*(.+),?$/gm), (m) => m[1].replace(/,$/, '').trim());
    assert.ok(exitCodeAssignments.length > 0, 'sanity: at least one exit_code assignment must be found in runner.js (pin is stale if this is empty)');
    // Every RHS must consist only of identifiers/property access, digits,
    // parens, `??`, `?`, `:`, whitespace, and a leading `-` for a negative
    // sentinel -- no backtick, quote, or `+` (the shapes that would smuggle
    // string content, including a template literal or concatenation, into
    // what must stay a plain number).
    const SAFE_SHAPE = /^[A-Za-z_$][\w.]*(\s*\?\?\s*-?\d+)?$|^[A-Za-z_$][\w.]*\s*\?\s*\([A-Za-z_$][\w.]*\s*\?\?\s*-?\d+\)\s*:\s*\([A-Za-z_$][\w.]*\s*\?\?\s*-?\d+\)$|^\d+$/;
    for (const rhs of exitCodeAssignments) {
      assert.ok(!/[`'"+]/.test(rhs), `exit_code RHS must not contain a template literal, string, or concatenation operator -- got "${rhs}"`);
      assert.ok(SAFE_SHAPE.test(rhs), `exit_code RHS must be a recognized numeric/identifier/ternary shape -- got "${rhs}" (if this is a NEW, legitimately-safe shape, widen SAFE_SHAPE deliberately rather than loosening the quote/backtick/concatenation check above)`);
    }
  });
});
