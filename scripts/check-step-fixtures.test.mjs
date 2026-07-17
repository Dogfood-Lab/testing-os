/**
 * check-step-fixtures.test.mjs — mechanical guard against a shell-hostile
 * verify-step fixture.
 *
 * THE DEFECT THIS EXISTS FOR. `runStep` (packages/dogfood-swarm/lib/verify/
 * runner.js) spawns via `execFileSync(cmd, args, { shell: true })`. Its own
 * contract says the quiet part out loud: "With `shell: true`, Node joins
 * `file` + `args` into a single string and hands it to the shell, so the argv
 * array does NOT neutralize shell metacharacters: every arg IS subject to
 * shell interpretation... The argv-array shape is a readability/consistency
 * convention here, not a sanitizer — do not treat it as one."
 *
 * Production honours that contract (every live `step.args` is a metachar-free
 * literal like `run`/`build`). Twelve TEST fixtures did not, and shipped two
 * platform-split defects that the argv-array shape made invisible:
 *
 *   1. `args: ['-e', 'console.log(1)']` composes to the bare string
 *      `node -e console.log(1)`. POSIX `/bin/sh` reads `(` as a subshell
 *      metachar and dies with a syntax error (exit 2); Windows `cmd.exe`
 *      tolerates it. Green on a dev laptop, red on Linux CI.
 *   2. `cmd: process.execPath` composes to
 *      `C:\Program Files\nodejs\node.exe -e ...` on Windows — the shell splits
 *      at the space and runs `C:\Program`. Red on Windows, green on Linux.
 *
 * WHY A GATE AND NOT JUST THE FIX. CI cannot catch this class. Nine of the
 * twelve broken fixtures sat on `optional: true` steps, and runSteps tolerates
 * an optional failure (runner.js: `if (!result.passed && !result.optional
 * && !opts.continueOnError) break;`). Those nine PASSED on Linux while
 * exercising the exact inverse of their stated intent — a fixture block
 * literally named SAFE_OPTIONAL_OVERRIDES, documented as "trivial in-process
 * no-ops so the verify path never shells out", was in fact shelling out and
 * failing on every platform, silently, for its whole life. A green CI is not
 * evidence here, so the detector has to be structural.
 *
 * METHOD — the shell's own parser, not a regex. `sh -n` syntax-checks a
 * command WITHOUT executing it, so the arbiter of "is this shell-safe" is the
 * shell itself. This mirrors the Class #14 pin-gate rewrite's hardest-won
 * lesson (docs/pin-matcher-rewrite.dispatch.md): the old gate inferred meaning
 * from prose with a regex and leaked a false grant on seven consecutive
 * audits; the rewrite read a real AST and has not leaked since. Fixtures are
 * likewise extracted from a real `@babel/parser` AST, never grepped.
 *
 * WHAT STILL SLIPS THROUGH (enumerated in the output, per the soundiness
 * doctrine — undisclosed unsoundness is the defect, not unsoundness itself):
 *   - Fixtures whose `cmd`/`args` are non-literal (a variable, a template, a
 *     spread, a function call). They are counted and reported as `skipped`,
 *     never silently passed.
 *   - `sh -n` checks SYNTAX, not resolution: a syntactically-valid command
 *     naming a nonexistent binary parses clean. That is why the whitespace/
 *     execPath check below exists as a separate structural rule rather than
 *     being folded into the parse.
 *   - Only `packages/**` test files are scanned — the production adapters are
 *     covered by runStep's own contract and their live steps are argument-free
 *     verbs.
 *   - If `sh` is absent the scan cannot run; the test FAILS LOUDLY rather than
 *     skipping, so an environment that cannot verify never reads as verified.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from '@babel/parser';

import { classifyFile, walkSourceFiles } from '../packages/portfolio/lib/parse-regression-pins.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = join(REPO_ROOT, 'packages');

/** Mirrors scripts/pin-declarations.mjs's JS_PARSE_OPTS — one grammar, one behaviour. */
const JS_PARSE_OPTS = {
  sourceType: 'module',
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  errorRecovery: false,
  plugins: ['estree', 'jsx'],
};

/**
 * F-e9543066: this gate used to discover test files with its own narrow
 * `.test.js`/`.test.mjs` suffix check (the removed `walkTestFiles`) instead
 * of the canonical classifyFile()/walkSourceFiles() pair that
 * scripts/pin-declarations.mjs, scripts/check-finding-regression-pins.mjs,
 * and scripts/suggest-pins.mjs already route through — invisible to
 * `.test.ts` (14 real files under packages/schemas/test/ at fix time),
 * `.test.cjs`, `-test.`/`_test.`/bare `test.` names, and a bare
 * `test/`-directory fixture, all of which classifyFile() already recognizes.
 * Routing through the shared classifier below closes that drift risk.
 *
 * Reusing it also newly surfaces those 14 `.test.ts` files to THIS file's own
 * parser, and JS_PARSE_OPTS above cannot read them: TS-only syntax (type
 * annotations, `as` casts, interfaces) is not valid ESTree/JS grammar, and
 * @babel/parser throws without the `typescript` plugin — confirmed
 * empirically (all 4 sampled *.test.ts files under packages/schemas/test/
 * threw "Unexpected token" against JS_PARSE_OPTS pre-fix). Left alone,
 * widening the walk would have traded an undisclosed coverage gap for an
 * uncaught crash the moment those files were scanned — `auditSource` has no
 * try/catch around `parse()`. TS_PARSE_OPTS + parseOptsFor mirror
 * pin-declarations.mjs's own JS_PARSE_OPTS/TS_PARSE_OPTS/parseOptsFor split —
 * same parser, same fix, same reason, applied here too.
 */
const TS_PARSE_OPTS = { ...JS_PARSE_OPTS, plugins: ['estree', 'jsx', 'typescript'] };
const parseOptsFor = (label) => (/\.tsx?$/.test(label) ? TS_PARSE_OPTS : JS_PARSE_OPTS);

/** Generic AST walk. `loc`/`range`/comment arrays are skipped as non-structural. */
function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    if (key === 'leadingComments' || key === 'trailingComments' || key === 'comments') continue;
    walkAst(node[key], visit);
  }
}

const literalString = (node) =>
  node && (node.type === 'Literal' || node.type === 'StringLiteral') && typeof node.value === 'string'
    ? node.value
    : null;

/** `process.execPath` — structurally flagged: it is a PATH, and paths hold spaces. */
const isProcessExecPath = (node) =>
  node?.type === 'MemberExpression' &&
  node.object?.name === 'process' &&
  (node.property?.name === 'execPath' || node.property?.value === 'execPath');

/**
 * Extract every step-shaped object literal: any ObjectExpression carrying a
 * literal `cmd` key (runStep's @param: `{ name, cmd, args?, optional?, ... }`,
 * runner.js:205 — `args` is documented OPTIONAL). `args` itself is NOT
 * required here: requiring it used to drop cmd-only fixtures before they
 * were ever considered a candidate (F-2f846533) — invisible to `checked`,
 * `skipped`, and `violations` alike, which is strictly worse than the
 * disclosed non-literal-cmd/args gap (that at least reports as `skipped`).
 * `args: undefined` on the returned record (key absent) is the caller's
 * signal to default to `[]`, mirroring runStep's own
 * `const cmdArgs = step.args || [];` (runner.js:226) at runtime.
 */
function extractStepFixtures(ast) {
  const found = [];
  walkAst(ast, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const props = new Map();
    for (const p of node.properties || []) {
      if (p.type !== 'Property' && p.type !== 'ObjectProperty') continue;
      const key = p.key?.name ?? p.key?.value;
      if (typeof key === 'string') props.set(key, p.value);
    }
    if (!props.has('cmd')) return;
    found.push({ cmd: props.get('cmd'), args: props.get('args'), line: node.loc?.start?.line ?? 0 });
  });
  return found;
}

/** Compose exactly as Node composes for `shell: true`: file + args joined by a space. */
const composeShellCommand = (cmd, args) => (args.length ? `${cmd} ${args.join(' ')}` : cmd);

/**
 * Locate a POSIX shell (F-af5ed718).
 *
 * A bare `spawnSync('sh', ...)` is a PATH lookup, and on Windows Git's
 * installer does NOT put its `usr/bin` on PATH — only `Git\cmd` and
 * `Git\mingw64\bin`. So `sh.exe` is present on disk while `sh` is
 * unresolvable, and this gate failed with ENOENT for every fixture in a plain
 * PowerShell session: `npm run verify` — the repo's own canonical pre-commit
 * check — was red in the repo's primary shell while green in git-bash and
 * green on Linux CI. **The gate built to catch Windows/Linux verify-parity
 * gaps had one, on its first wave.** It was written and "verified" from a
 * git-bash shell, which is exactly the environment that hides the defect; the
 * probe proving `sh` reachable was itself run in the wrong shell.
 *
 * DERIVED, not enumerated. The location comes from `git --exec-path` — git is
 * a hard prerequisite of this repo (it IS a git repo, and the ownership probe
 * and `--isolate` worktrees need it), and Git for Windows ships the same sh
 * this gate wants. Walking up from git's own exec-path to a sibling
 * `usr/bin/sh.exe` asks the installed tool where it lives rather than
 * hardcoding `C:\Program Files\Git\...`, which would be the enumeration class
 * this run has now caught four separate times (CONTROL_CLASS, ZALGO_RUN,
 * DASH_CONFUSABLES, the ingest flag registry). A machine that moved Git, or
 * uses a non-default install root, resolves correctly.
 *
 * Returns the resolved argv[0] (`'sh'` or an absolute path), or null when no
 * POSIX shell exists at all — which the caller must treat as "cannot verify",
 * never as "verified clean".
 */
let _resolvedSh;
function resolveSh() {
  if (_resolvedSh !== undefined) return _resolvedSh;

  if (!spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf-8' }).error) {
    _resolvedSh = 'sh';
    return _resolvedSh;
  }

  if (process.platform === 'win32') {
    const gitExec = spawnSync('git', ['--exec-path'], { encoding: 'utf-8' });
    if (!gitExec.error && gitExec.status === 0) {
      let dir = resolve(gitExec.stdout.trim());
      for (let hop = 0; hop < 6; hop++) {
        for (const rel of [join('usr', 'bin', 'sh.exe'), join('bin', 'sh.exe')]) {
          const candidate = join(dir, rel);
          if (existsSync(candidate)) {
            _resolvedSh = candidate;
            return _resolvedSh;
          }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }

  _resolvedSh = null;
  return _resolvedSh;
}

function shCanParse(command) {
  const sh = resolveSh();
  if (sh === null) return { ok: false, unavailable: true, stderr: 'no POSIX shell found (PATH, and git --exec-path on win32)' };
  const r = spawnSync(sh, ['-n', '-c', command], { encoding: 'utf-8' });
  if (r.error) return { ok: false, unavailable: true, stderr: String(r.error.code) };
  return { ok: r.status === 0, unavailable: false, stderr: String(r.stderr || '').trim() };
}

/**
 * The rule set. Returns { violations, skipped, checked } — never throws, so the
 * caller can report the whole picture instead of the first failure.
 */
function auditSource(source, label) {
  const violations = [];
  const skipped = [];
  let checked = 0;

  for (const fx of extractStepFixtures(parse(source, parseOptsFor(label)))) {
    const where = `${label}:${fx.line}`;

    if (isProcessExecPath(fx.cmd)) {
      violations.push({
        where,
        rule: 'cmd-may-contain-spaces',
        detail:
          'cmd: process.execPath — under shell:true the shell splits the path at its spaces ' +
          '("C:\\Program Files\\nodejs\\node.exe" runs as `C:\\Program`). Use bare `node`.',
      });
      continue;
    }

    const cmd = literalString(fx.cmd);
    if (cmd === null) {
      skipped.push({ where, why: 'cmd is not a string literal' });
      continue;
    }
    if (/\s/.test(cmd)) {
      violations.push({
        where,
        rule: 'cmd-contains-whitespace',
        detail: `cmd ${JSON.stringify(cmd)} contains whitespace; shell:true splits it at the space.`,
      });
      continue;
    }

    let args;
    if (fx.args === undefined) {
      // No `args` key at all -- default to `[]`, exactly as runStep does
      // (runner.js:226: `const cmdArgs = step.args || [];`). This is a real,
      // checked candidate, not a skip: the runtime never treats an absent
      // key as unverifiable, so neither does this gate.
      args = [];
    } else if (fx.args.type !== 'ArrayExpression') {
      skipped.push({ where, why: 'args is not an array literal' });
      continue;
    } else {
      args = fx.args.elements.map(literalString);
      if (args.some((a) => a === null)) {
        skipped.push({ where, why: 'args contains a non-literal element' });
        continue;
      }
    }

    checked += 1;
    const composed = composeShellCommand(cmd, args);
    const parsed = shCanParse(composed);
    if (parsed.unavailable) {
      violations.push({ where, rule: 'sh-unavailable', detail: `cannot verify: sh ${parsed.stderr}` });
      continue;
    }
    if (!parsed.ok) {
      violations.push({
        where,
        rule: 'not-posix-parseable',
        detail: `shell:true composes ${JSON.stringify(composed)}, which /bin/sh rejects: ${parsed.stderr}`,
      });
    }
  }

  return { violations, skipped, checked };
}

describe('verify-step fixtures must survive runStep\'s shell:true composition', () => {
  it('a POSIX shell is resolvable on THIS machine, in THIS shell (F-af5ed718)', () => {
    // The gate's own prerequisite, asserted first and by itself — because when
    // it was missing, every OTHER test in this file failed with an identical
    // `sh ENOENT` and none of them said why. This one names the real problem in
    // one line instead of making an operator infer it from a wall of red.
    //
    // It is not decoration: `sh` is unresolvable from a plain PowerShell
    // session on this repo's own primary rig (Git ships sh.exe but its
    // installer does not PATH `usr/bin`), so `npm run verify` was red in the
    // repo's primary shell while green in git-bash and green on Linux CI. This
    // assertion fails in exactly the environment the original probe could not
    // see — the probe having been run from git-bash, the one shell where the
    // defect is invisible.
    const sh = resolveSh();
    assert.notEqual(sh, null,
      'no POSIX shell found via PATH or `git --exec-path`. This gate consults the SHELL\'S OWN PARSER '
        + 'rather than a regex, so without one it cannot verify anything and must not pretend otherwise. '
        + 'On Windows, install Git for Windows (it ships sh.exe) or put a POSIX sh on PATH.');
    const probe = spawnSync(sh, ['-c', 'exit 7'], { encoding: 'utf-8' });
    assert.equal(probe.error, undefined, `resolved shell must actually spawn (got ${probe.error?.code})`);
    assert.equal(probe.status, 7, 'the resolved shell must be a real shell that runs the command it is given');
  });

  it('the detector actually fires on the exact shape that shipped (non-vacuity)', () => {
    // The real pre-fix fixture from lib/verify-runner-max-buffer-env-warning-dedup.test.js:71.
    // If this stops being caught, the gate is theater and every assertion below is worthless.
    const bad = `const s = { name: 'test', cmd: 'node', args: ['-e', 'console.log(1)'] };`;
    const { violations } = auditSource(bad, 'synthetic-bad.js');
    assert.equal(violations.length, 1, 'the unquoted-paren fixture MUST be caught');
    assert.equal(violations[0].rule, 'not-posix-parseable');
  });

  it('the detector fires on the process.execPath shape too (the Windows half of the class)', () => {
    const bad = `const s = { name: 'lint', cmd: process.execPath, args: ['-e', '"process.exit(0)"'] };`;
    const { violations } = auditSource(bad, 'synthetic-execpath.js');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'cmd-may-contain-spaces');
  });

  it('the detector does NOT fire on the correct quoted convention (no false positives)', () => {
    const good = `const s = { name: 'test', cmd: 'node', args: ['-e', '"console.log(1)"'] };
                  const t = { name: 'x', cmd: 'npm', args: ['run', 'build'] };
                  const u = { name: 'y', cmd: 'node', args: ['-e', '"console.log(\\'# tests 1\\')"'] };`;
    const { violations, checked } = auditSource(good, 'synthetic-good.js');
    assert.deepEqual(violations, []);
    assert.equal(checked, 3, 'all three must be genuinely checked, not skipped into a vacuous pass');
  });

  it('a cmd-only fixture (no args key at all) is never invisible to the gate (F-2f846533)', () => {
    // The exact pre-fix reproduction from the finding: `args` is entirely
    // absent (not an empty array, not present-but-non-literal) -- the
    // fixture relies on runStep's own documented default,
    // `const cmdArgs = step.args || [];` (runner.js:226), and its JSDoc
    // marks args OPTIONAL (`{ name, cmd, args?, optional?, ... }`,
    // runner.js:205). Before the fix, extractStepFixtures's precondition
    // `if (!props.has('cmd') || !props.has('args')) return;` dropped this
    // object before it was ever a candidate: not checked, not skipped, zero
    // signal anywhere -- strictly worse than the disclosed
    // non-literal-cmd/args gap, which at least surfaces as `skipped`.
    const bad = `const badStep = { name: 'lint', cmd: 'node -e "console.log(1)"', optional: true };`;
    const { violations, skipped, checked } = auditSource(bad, 'synthetic-cmd-only-bad.js');
    assert.ok(
      violations.length + skipped.length + checked > 0,
      'a cmd-only fixture must register SOME signal (violation, skip, or check) -- it must never vanish without a trace',
    );
    // This particular fixture folds the whole invocation into `cmd` itself
    // (no separate args), so `cmd` carries an embedded space -- exactly the
    // shell:true word-splitting hazard `cmd-contains-whitespace` exists to
    // catch, independent of whether `args` was ever supplied.
    assert.equal(violations.length, 1, 'an embedded-space cmd is unsafe under shell:true regardless of args presence');
    assert.equal(violations[0].rule, 'cmd-contains-whitespace');
  });

  it('a clean cmd-only fixture is CHECKED with args defaulted to [] (runner.js:226 parity, F-2f846533)', () => {
    // Same missing-`args`-key shape as the fixture above, but with a
    // whitespace-free `cmd` -- this is the case the finding's fix requires
    // to show up as a genuine check (not a skip, not a violation), because
    // extractStepFixtures must mirror runStep's own `step.args || []`
    // default rather than silently dropping the candidate.
    const good = `const s = { name: 'build', cmd: 'npm', optional: true };`;
    const { violations, skipped, checked } = auditSource(good, 'synthetic-cmd-only-good.js');
    assert.deepEqual(violations, []);
    assert.deepEqual(skipped, []);
    assert.equal(checked, 1, 'a whitespace-free cmd-only fixture must be genuinely checked with args=[], not silently dropped');
  });

  it('every step fixture in packages/** composes to a shell-parseable command', () => {
    // F-e9543066: canonical classifier, not a hand-rolled suffix check — see
    // the doc comment above TS_PARSE_OPTS for why that also required a
    // TS-aware parse path.
    const files = walkSourceFiles(SCAN_ROOT).filter((f) => classifyFile(f) === 'test');
    assert.ok(files.length > 0, 'fixture sanity: the scan must actually find test files');

    const allViolations = [];
    const allSkipped = [];
    let totalChecked = 0;

    for (const file of files) {
      const label = relative(REPO_ROOT, file).split(sep).join('/');
      const { violations, skipped, checked } = auditSource(readFileSync(file, 'utf-8'), label);
      allViolations.push(...violations);
      allSkipped.push(...skipped);
      totalChecked += checked;
    }

    // Enumerate the gaps in the OUTPUT, not in a docstring that will drift.
    console.log(
      `[step-fixture-gate] ${files.length} test files · ${totalChecked} fixtures verified via \`sh -n\` · ` +
        `${allSkipped.length} not statically checkable (${[...new Set(allSkipped.map((s) => s.why))].join('; ') || 'none'})`,
    );

    assert.ok(totalChecked > 0, 'a scan that verifies zero fixtures proves nothing');
    assert.deepEqual(
      allViolations,
      [],
      `shell-hostile step fixture(s):\n${allViolations.map((v) => `  ${v.where} [${v.rule}] ${v.detail}`).join('\n')}`,
    );
  });
});
