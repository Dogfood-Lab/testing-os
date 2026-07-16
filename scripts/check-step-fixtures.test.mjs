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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from '@babel/parser';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = join(REPO_ROOT, 'packages');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

/** Mirrors scripts/pin-declarations.mjs's JS_PARSE_OPTS — one grammar, one behaviour. */
const PARSE_OPTS = {
  sourceType: 'module',
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  errorRecovery: false,
  plugins: ['estree', 'jsx'],
};

function walkTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkTestFiles(full, out);
    } else if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.mjs')) {
      out.push(full);
    }
  }
  return out;
}

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
 * Extract every `{ cmd, args }` object literal. That pair IS the step shape
 * (runStep's @param: `{ name, cmd, args?, optional?, ... }`); requiring both
 * keys is what distinguishes a step fixture from an arbitrary object.
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
    if (!props.has('cmd') || !props.has('args')) return;
    found.push({ cmd: props.get('cmd'), args: props.get('args'), line: node.loc?.start?.line ?? 0 });
  });
  return found;
}

/** Compose exactly as Node composes for `shell: true`: file + args joined by a space. */
const composeShellCommand = (cmd, args) => (args.length ? `${cmd} ${args.join(' ')}` : cmd);

function shCanParse(command) {
  const r = spawnSync('sh', ['-n', '-c', command], { encoding: 'utf-8' });
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

  for (const fx of extractStepFixtures(parse(source, PARSE_OPTS))) {
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

    if (fx.args?.type !== 'ArrayExpression') {
      skipped.push({ where, why: 'args is not an array literal' });
      continue;
    }
    const args = fx.args.elements.map(literalString);
    if (args.some((a) => a === null)) {
      skipped.push({ where, why: 'args contains a non-literal element' });
      continue;
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

  it('every step fixture in packages/** composes to a shell-parseable command', () => {
    const files = walkTestFiles(SCAN_ROOT);
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
