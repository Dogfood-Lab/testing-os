/**
 * f-80afe435-isolate-default.test.js — F-80afe435 (HIGH, feature-execute):
 * `swarm dispatch` isolate defaults ON. Shared-worktree dispatch is the
 * unsound mode (Ji et al. 2026, arXiv:2607.02294; PROTOCOL DECOMPOSE_BY_SECRETS);
 * the CLI used to opt in via `const isolate = args.includes('--isolate')`, so
 * a bare `swarm dispatch <run> <phase>` shared one worktree across every
 * agent-bearing domain. Product half (swarm-cp-verbs) flips cli.js; this pin
 * locks the boolean contract without creating worktrees.
 *
 * Documented precedence: `--no-isolate` is the shared-tree escape hatch and
 * wins when both `--isolate` and `--no-isolate` appear on the argv.
 *
 * Strategy: cmdDispatch is not exported. Read the `const isolate = <expr>`
 * assignment out of cli.js and evaluate it against argv fixtures — same
 * source-parse seam other non-exported cmd* pins use, and zero worktree I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = readFileSync(join(__dirname, 'cli.js'), 'utf-8');

/**
 * Extract cmdDispatch's `const isolate = <expr>` and evaluate it against args.
 * Fails loud if the old opt-in-only form is still the resolver.
 */
function readDispatchIsolate(args) {
  assert.ok(Array.isArray(args), 'args must be an argv-tail array');

  const stripped = stripComments(CLI_SRC);
  const fnIdx = stripped.indexOf('function cmdDispatch(args)');
  assert.ok(fnIdx >= 0, 'cli.js must define function cmdDispatch(args)');

  // Bound the handler body so a later `const isolate` in another cmd* cannot
  // satisfy the pin. Walk braces from the first `{` after the signature.
  const bodyOpen = stripped.indexOf('{', fnIdx);
  assert.ok(bodyOpen > fnIdx, 'cmdDispatch body opening brace not found');
  let depth = 0;
  let bodyClose = -1;
  for (let i = bodyOpen; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        bodyClose = i;
        break;
      }
    }
  }
  assert.ok(bodyClose > bodyOpen, 'cmdDispatch body closing brace not found');
  const body = stripped.slice(bodyOpen, bodyClose + 1);

  const assign = body.match(/\bconst isolate\s*=\s*([^;]+);/);
  assert.ok(
    assign,
    'cmdDispatch must assign `const isolate = <expr>;` (F-80afe435 product half)',
  );
  const expr = assign[1].trim();

  assert.notEqual(
    expr,
    "args.includes('--isolate')",
    'F-80afe435 regression: isolate must not be opt-in-only via args.includes(--isolate)',
  );
  assert.match(
    expr,
    /--no-isolate/,
    'isolate resolution must consult --no-isolate (shared-tree escape hatch)',
  );

  // Evaluate the production expression against the fixture argv.
  return Function('args', `"use strict"; return (${expr});`)(args);
}

/** @pins F-80afe435 */
describe('F-80afe435 — swarm dispatch isolate defaults ON; --no-isolate escapes', () => {
  it('omitted --isolate flag => isolate true (default on)', () => {
    assert.equal(
      readDispatchIsolate(['run-1', 'health-audit-a']),
      true,
      'bare dispatch argv must isolate by default',
    );
  });

  it('--no-isolate => isolate false (shared)', () => {
    assert.equal(
      readDispatchIsolate(['run-1', 'health-audit-a', '--no-isolate']),
      false,
      '--no-isolate is the shared-worktree escape hatch',
    );
  });

  it('--isolate still true', () => {
    assert.equal(
      readDispatchIsolate(['run-1', 'health-audit-a', '--isolate']),
      true,
      'explicit --isolate remains true under the default-on contract',
    );
  });

  it('documented precedence: when both flags appear, --no-isolate wins', () => {
    assert.equal(
      readDispatchIsolate(['run-1', 'health-audit-a', '--isolate', '--no-isolate']),
      false,
      '--no-isolate must win over --isolate (isolate then no-isolate order)',
    );
    assert.equal(
      readDispatchIsolate(['run-1', 'health-audit-a', '--no-isolate', '--isolate']),
      false,
      '--no-isolate must win over --isolate (no-isolate then isolate order)',
    );
  });

  it('GATE: cmdDispatch usage / USAGE.dispatch surface the --no-isolate escape hatch', () => {
    // Operator-facing synopsis must name the escape hatch once the default
    // flips; otherwise `swarm dispatch` / `--help` still teach the old shape.
    assert.match(
      CLI_SRC,
      /function cmdDispatch\(args\)[\s\S]*?--no-isolate/,
      'cmdDispatch bad-args Usage must list --no-isolate',
    );
    assert.match(
      CLI_SRC,
      /USAGE[\s\S]*?dispatch:[\s\S]*?--no-isolate/,
      'USAGE.dispatch must list --no-isolate',
    );
  });
});
