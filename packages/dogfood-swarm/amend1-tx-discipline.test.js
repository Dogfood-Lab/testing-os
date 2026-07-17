/**
 * amend1-tx-discipline.test.js
 *
 * Wave A1 D3 — mechanical completeness gate for the executeTransition
 * atomicity invariant (H9).
 *
 * The rule. Any source site under `packages/dogfood-swarm/**` that performs
 * an `UPDATE agent_runs` statement IN PROXIMITY to an `INSERT INTO
 * agent_state_events` MUST live inside a `db.transaction(` block (either
 * directly or transitively through a helper that wraps).
 *
 * Approach. The wave-9 fix uses the executeTransition wrapper, so the
 * canonical pair lives ONLY in lib/state-machine.js. The guard:
 *
 *   1. Asserts that BOTH `UPDATE agent_runs` and `INSERT INTO
 *      agent_state_events` appearing in the SAME source file requires that
 *      file to contain `db.transaction(`.
 *
 *   2. Asserts that `executeTransition` and `applyTimeoutPolicy` function
 *      bodies in lib/state-machine.js are tx-aware (self-wraps the pair, or
 *      routes through transitionAgent which wraps).
 *
 * Allowlist mechanism preserved for any future site (tests, dev-mode tools,
 * raw migration scripts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;

const TEST_FILE_PATTERN = /\.test\.(js|mjs)$/;

// Files allowed to UPDATE agent_runs OR INSERT agent_state_events without
// requiring a co-located db.transaction. Each entry must list a reason.
const ALLOWLIST = [
  // Sites that legitimately do a bare UPDATE on a non-status column.
  {
    file: 'commands/collect.js',
    reason: 'sets error_message on already-failed agents (no status change, no audit row needed).',
  },
  // applyTimeoutPolicy routes through transitionAgent which goes through
  // executeTransition (self-wrapping). The file legitimately mentions
  // UPDATE agent_runs only via the executeTransition path (no raw UPDATE).
  //
  // D3B-013 (Wave A2 Stage C): redrive.js has a same-status branch
  // (dispatched → dispatched) that records the operator's intent via a
  // raw `INSERT INTO agent_state_events`. canTransition rejects self-
  // loops in TRANSITIONS so we cannot route the no-op through the state
  // machine. The raw INSERT lives INSIDE the outer apply db.transaction()
  // so atomicity is preserved at the SQLite level; the file-level guard
  // above (text.includes('db.transaction(')) already accepts it. This
  // entry documents the special case so a future scan understands the
  // intent and a stricter line-level guard
  // (amend2-d3b-013-redrive-tx.test.js) pins the INSERT-inside-tx
  // structural invariant.
  {
    file: 'commands/redrive.js',
    reason: 'same-status (dispatched → dispatched) redrive intentionally uses a raw INSERT INTO agent_state_events because canTransition rejects self-loops. Raw INSERT lives inside the outer apply db.transaction() — pinned by amend2-d3b-013-redrive-tx.test.js.',
  },
];

function walkSync(dir, files = []) {
  // F-af78bb29: skip node_modules / dist / dot-dirs (guard mirrored from
  // meta-amendA-readme-contract.test.js#envVarsReadInSource) so an npm
  // hoisting change that materializes a package-local node_modules cannot
  // make this discipline gate sweep third-party sources. withFileTypes
  // avoids a follow-up statSync, so a broken symlink is skipped instead of
  // crashing the sweep.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkSync(p, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(p);
  }
  return files;
}

function relativeFromPkg(absPath) {
  return absPath.slice(PKG_ROOT.length + 1).replace(/\\/g, '/');
}

function isAllowlisted(relPath) {
  return ALLOWLIST.some(entry => entry.file === relPath);
}

/**
 * F-a02393b2 / F-a7bf6f4e: brace-balanced function-body extraction.
 *
 * Both probes below used to bound a function's body by TEXT LAYOUT — one by
 * "the file contains db.transaction( SOMEWHERE" (no function scope at all),
 * the other by "capture until the next top-level `export`". F-a7bf6f4e
 * proved the second binds the capture to file ORDER: any non-exported
 * helper inserted between two functions silently widens the capture to
 * include the neighbour's code, so an assertion about "the function under
 * test" can actually pass or fail on ITS NEIGHBOUR's body instead.
 *
 * This walks real brace depth from each function's own `{` to its own
 * matching `}`, so a reorder or an inserted helper cannot change what a
 * probe sees. Scope: named `function` declarations only (`function name(` /
 * `async function name(` / `export function name(`) — the shape every
 * function in this package uses at module scope. Arrow functions and object
 * methods are not extracted; a file that needs those covered needs a wider
 * extractor, not a silent stretch of this one.
 *
 * F-bb7f4885: a same-line default-parameter OBJECT literal — e.g.
 * `function computeAssessment(wave, ..., ctx = {}) {` (commands/status.js) —
 * used to mis-extract. The old single brace-walk started counting at the
 * signature line with no notion of "am I still inside the parameter list",
 * so `ctx = {}`'s own balanced pair closed depth back to zero before the
 * walk ever reached the function's REAL opening brace at the end of that
 * same line, truncating a 176-line body down to the signature line alone
 * (verified against commands/status.js:493 directly). Fixed by walking PAREN
 * depth first, from the `(` this function's own regex already matched
 * through, to find where the parameter list itself closes — a default
 * value's `{}` never touches paren depth, so this walk locates the true end
 * of the parameter list regardless of how many such literals a signature
 * carries. Only once that close is found does the brace walk begin, at the
 * first `{` on or after it. Tolerant, not lexer-exact, same as the original
 * brace walk: neither has awareness of strings, comments, or regex literals
 * containing a stray `(`, `)`, `{`, or `}` — an existing limitation of this
 * extractor, not one this fix introduces.
 */
function extractFunctionBodies(text) {
  const lines = text.split('\n');
  const fnRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/;
  const bodies = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(fnRe);
    if (!m) continue;

    // Phase 1: walk PAREN depth from the opening '(' this regex already
    // matched through (position m[0].length - 1 on line i) until it returns
    // to zero — that is the parameter list's own closing ')', regardless of
    // any '{}' a default value carries.
    let parenDepth = 0, seenParenOpen = false;
    let paramsCloseLine = -1, paramsCloseCol = -1;
    for (let j = i; j < lines.length && paramsCloseLine === -1; j++) {
      const startCol = j === i ? m[0].length - 1 : 0;
      for (let k = startCol; k < lines[j].length; k++) {
        const ch = lines[j][k];
        if (ch === '(') { parenDepth++; seenParenOpen = true; }
        else if (ch === ')') {
          parenDepth--;
          if (seenParenOpen && parenDepth === 0) { paramsCloseLine = j; paramsCloseCol = k; break; }
        }
      }
    }
    if (paramsCloseLine === -1) continue; // unbalanced parens — not a function we can safely extract

    // Phase 2: the body's opening '{' is the first one at or after the
    // parameter list's close — in valid JS there is nothing between them but
    // whitespace, or a line break if the brace starts its own line.
    let bodyLine = -1, bodyCol = -1;
    for (let j = paramsCloseLine; j < lines.length && bodyLine === -1; j++) {
      const startCol = j === paramsCloseLine ? paramsCloseCol + 1 : 0;
      const idx = lines[j].indexOf('{', startCol);
      if (idx !== -1) { bodyLine = j; bodyCol = idx; }
    }
    if (bodyLine === -1) continue; // no body brace found — not a function we can safely extract

    // Phase 3: brace-depth from that known-good starting point to the
    // function's own matching '}' — unchanged from the original walk, just
    // no longer seeded from the signature line where an earlier default-
    // parameter '{}' could return depth to zero first.
    let depth = 0, endLine = -1;
    for (let j = bodyLine; j < lines.length && endLine === -1; j++) {
      const startCol = j === bodyLine ? bodyCol : 0;
      for (let k = startCol; k < lines[j].length; k++) {
        const ch = lines[j][k];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { endLine = j; break; } }
      }
    }
    if (endLine !== -1) bodies.set(m[1], lines.slice(i, endLine + 1).join('\n'));
  }
  return bodies;
}

describe('Tx discipline — UPDATE agent_runs + INSERT agent_state_events co-occurrence (H9)', () => {
  it('any file containing BOTH writes wraps them in db.transaction (executeTransition pattern)', () => {
    const all = walkSync(PKG_ROOT).filter(p => !TEST_FILE_PATTERN.test(relativeFromPkg(p)));
    // F-a02393b2 anti-vacuity insurance: PKG_ROOT is __dirname and always
    // contains .js files today, so this is currently unreachable — but a
    // future refactor that hands walkSync the wrong root must not be able
    // to pass this gate by visiting nothing.
    assert.ok(all.length > 0, 'sweep must visit at least one source file');

    const offenders = [];
    for (const f of all) {
      const rel = relativeFromPkg(f);
      const text = readFileSync(f, 'utf-8');
      const hasUpdate = /UPDATE\s+agent_runs/.test(text);
      const hasInsertEvent = /INSERT\s+INTO\s+agent_state_events/.test(text);
      if (!hasUpdate || !hasInsertEvent) continue;
      if (isAllowlisted(rel)) continue;

      // F-a02393b2: a file-level `db.transaction(` anywhere used to exempt
      // EVERY write in the file (line 107's old `continue`), and a
      // co-occurrence split across two functions in the same file was
      // invisible to a file-scope regex. Narrow to function scope: find the
      // function bodies that actually contain BOTH statements, and require
      // db.transaction( inside THAT body specifically.
      const bodies = [...extractFunctionBodies(text).values()];
      const pairedBodies = bodies.filter(b =>
        /UPDATE\s+agent_runs/.test(b) && /INSERT\s+INTO\s+agent_state_events/.test(b));

      if (pairedBodies.length === 0) {
        // Both statements exist in the file but no single function's body
        // contains both — the pairing this invariant polices has no
        // function-scoped referent to check here. Fail loud rather than
        // fall back to the old file-level heuristic: a human needs to
        // confirm the split write path is genuinely atomic, or allowlist
        // it with a documented reason (see commands/redrive.js above).
        offenders.push(`${rel} — UPDATE agent_runs and INSERT INTO agent_state_events are both ` +
          `present but not co-located in one function body; cannot verify atomicity at function scope`);
        continue;
      }
      const unwrapped = pairedBodies.filter(b => !b.includes('db.transaction('));
      if (unwrapped.length > 0) {
        offenders.push(`${rel} — ${unwrapped.length} function body(ies) pair UPDATE agent_runs + ` +
          `INSERT INTO agent_state_events with no db.transaction( wrapper in that same body`);
      }
    }

    assert.deepEqual(offenders, [],
      `H9 tx discipline violation — file has both UPDATE agent_runs AND ` +
      `INSERT INTO agent_state_events but the pair is not co-located inside a single ` +
      `db.transaction()-wrapped function body:\n  ${offenders.join('\n  ')}\n` +
      `Route through transitionAgent (which goes through executeTransition in ` +
      `lib/state-machine.js, the self-wrapping helper), or wrap the pair in ` +
      `db.transaction() inside the same function at the call site.`);
  });

  // DELETION-PROOF for F-bb7f4885's two-phase (paren-then-brace) walk above.
  // Revert extractFunctionBodies to a single brace-walk seeded at the
  // signature line and this goes red: the default value's own '{}' closes
  // depth back to zero before the walk ever reaches the real body, and the
  // assertions below catch the 1-line truncation directly rather than via a
  // downstream sweep that might not touch this exact shape.
  it('extractFunctionBodies is not fooled by a same-line default-parameter object literal (F-bb7f4885)', () => {
    // Mirrors commands/status.js:493's real shape exactly (verified against
    // an acorn AST parse: that function's real span is 176 lines, and the
    // pre-fix walk truncated it to this same 1-line signature).
    const src = [
      'function computeAssessment(wave, agents, openBySeverity, blocked, inFlight, ctx = {}) {',
      '  const a = 1;',
      '  const b = 2;',
      '  return a + b;',
      '}',
      '',
    ].join('\n');
    const body = extractFunctionBodies(src).get('computeAssessment');
    assert.ok(body, 'computeAssessment must be found at all');
    assert.equal(body.split('\n').length, 5,
      'the FULL 5-line body must be extracted, not truncated to the 1-line signature');
    assert.match(body, /return a \+ b;/,
      'the body must include the real closing content, not stop at the default-param object');
  });

  it('lib/state-machine.js executeTransition body contains db.transaction(', () => {
    const text = readFileSync(join(PKG_ROOT, 'lib/state-machine.js'), 'utf-8');
    const body = extractFunctionBodies(text).get('executeTransition');
    assert.ok(body, 'executeTransition function must be defined');
    assert.ok(body.includes('db.transaction('),
      'executeTransition body must wrap in db.transaction()');
  });

  it('lib/state-machine.js applyTimeoutPolicy routes through transitionAgent (no raw SQL)', () => {
    const text = readFileSync(join(PKG_ROOT, 'lib/state-machine.js'), 'utf-8');
    // F-a7bf6f4e: this used to capture from applyTimeoutPolicy's signature
    // to the NEXT top-level `export` keyword — file-order-bound, not
    // syntax-bound. That already over-ran applyTimeoutPolicy's real `}` by
    // one JSDoc block; a helper inserted between applyTimeoutPolicy and
    // export function getTimeoutPolicy would have let the NEIGHBOUR's code
    // satisfy assert.ok(body.includes('transitionAgent(')) even if
    // applyTimeoutPolicy itself stopped calling it. extractFunctionBodies
    // bounds on applyTimeoutPolicy's own closing brace instead.
    const body = extractFunctionBodies(text).get('applyTimeoutPolicy');
    assert.ok(body, 'applyTimeoutPolicy function must be defined and findable');

    // applyTimeoutPolicy must NOT contain raw UPDATE agent_runs (the per-agent
    // transition must go through transitionAgent, which wraps).
    assert.ok(!body.match(/UPDATE\s+agent_runs/),
      'applyTimeoutPolicy must NOT contain raw UPDATE agent_runs — route ' +
      'through transitionAgent so executeTransition wraps the UPDATE+INSERT pair.');
    assert.ok(body.includes('transitionAgent('),
      'applyTimeoutPolicy must call transitionAgent so each iteration is atomic.');
  });
});
