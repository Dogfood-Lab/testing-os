/**
 * f-c0b12add-finding-event-types-enum.test.js
 *
 * F-c0b12add [LOW] — `finding_events.event_type` is a freeform TEXT column
 * with no CHECK constraint and no single exported enum anywhere in the
 * package today (grepped before writing this test: no EVENT_TYPES /
 * KNOWN_EVENT_TYPES export exists). Every call site (cmdDefer/cmdReject via
 * disposeFindings, cmdApprove's bulk-approve literal, collect.js's
 * absence-closure path, lib/fingerprint.js's rediscovery path, revalidate.js,
 * adjudicate.js) writes its own literal or variable into event_type
 * independently. C1/C2 are about to add TWO more values ('reopened',
 * 'operator_closed') to this already-unenumerated vocabulary — the natural
 * moment to close the gap rather than widen it, per lib/finding-status.js's
 * own docstring documenting the identical drift class already happening once
 * for finding STATUS (the gate/receipt/status three-way divergence that
 * module was built to prevent from recurring).
 *
 * STATUS: RED IN ISOLATION — no EVENT_TYPES export exists yet anywhere in
 * this package. ASSUMPTION: it will be exported from lib/finding-status.js
 * (the existing home for finding-lifecycle vocabulary — CLOSED_FINDING_
 * STATUSES already lives there, and this finding's own recommendation says
 * to mirror that shape exactly). Loaded via dynamic import rather than a
 * static named import specifically so a missing export produces a clean,
 * per-test assertion failure instead of an ES-module SyntaxError that would
 * crash every test in this file at load time. If swarm-cp-core lands the
 * export somewhere else (e.g. a new lib/finding-events.js), update
 * `EVENT_TYPES_MODULE_PATH` below.
 *
 * The static-scan half is a DISCLOSED PARTIAL, not a complete guard, and
 * says so in its own assertion output: it can only see event_type values
 * written as LITERAL strings directly in an INSERT's SQL text (e.g. cli.js's
 * bulk-approve `VALUES (?, 'approved', 'bulk approve')`); a value passed as a
 * bound JS variable (the common case — e.g. disposeFindings' `insertEvent.run
 * (f.id, status, reason)`) cannot be checked statically. This mirrors the
 * finding's own text ("variable-passed values... can't be scanned
 * statically") rather than overclaiming full coverage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stripComments } from './test-support/strip-comments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_DIR = __dirname;

const EVENT_TYPES_MODULE_PATH = join(__dirname, 'lib', 'finding-status.js');

// The known set THIS test expects EVENT_TYPES to contain — the existing
// vocabulary (grepped across cli.js/collect.js/lib/fingerprint.js/revalidate.js/
// adjudicate.js before writing this file) plus C1/C2's two additions.
const EXPECTED_EVENT_TYPES = [
  'reported', 'approved', 'fixed', 'unverified', 'deferred', 'rejected', 'recurred',
  'reopened', 'operator_closed',
].sort();

async function loadEventTypes() {
  if (!existsSync(EVENT_TYPES_MODULE_PATH)) {
    return { error: `module not found at ${EVENT_TYPES_MODULE_PATH}` };
  }
  // A raw Windows path (e.g. "E:\...\finding-status.js") is not a valid ESM
  // specifier — Node's loader reads the drive letter as a URL scheme and
  // throws ERR_UNSUPPORTED_ESM_URL_SCHEME. pathToFileURL is required here,
  // not optional convenience (this file crashed on first run without it).
  const mod = await import(pathToFileURL(EVENT_TYPES_MODULE_PATH).href);
  if (!mod.EVENT_TYPES) {
    return { error: `lib/finding-status.js exists but does not export EVENT_TYPES` };
  }
  return { EVENT_TYPES: mod.EVENT_TYPES };
}

/** @pins F-c0b12add */
describe('F-c0b12add — EVENT_TYPES: a single exported enum for finding_events.event_type', () => {
  it('EVENT_TYPES is exported and pins the known set, including reopened/operator_closed', async () => {
    const { EVENT_TYPES, error } = await loadEventTypes();
    if (error) {
      assert.fail(
        `${error} — awaiting swarm-cp-core to land a frozen EVENT_TYPES array (mirroring ` +
        `CLOSED_FINDING_STATUSES' exact shape in the same file) before this pin can run.`
      );
    }
    assert.ok(Array.isArray(EVENT_TYPES), 'EVENT_TYPES must be an array');
    assert.deepEqual([...EVENT_TYPES].sort(), EXPECTED_EVENT_TYPES,
      `EVENT_TYPES must contain exactly the known vocabulary plus C1/C2's two additions; got ` +
      `${JSON.stringify([...EVENT_TYPES].sort())}, expected ${JSON.stringify(EXPECTED_EVENT_TYPES)}`);
  });

  it('EVENT_TYPES is frozen (Object.isFrozen), mirroring CLOSED_FINDING_STATUSES\' own immutability', async () => {
    const { EVENT_TYPES, error } = await loadEventTypes();
    if (error) {
      assert.fail(`${error} — see the preceding test for what's needed from swarm-cp-core.`);
    }
    assert.ok(Object.isFrozen(EVENT_TYPES), 'EVENT_TYPES must be frozen, matching CLOSED_FINDING_STATUSES\' Object.freeze shape');
  });
});

/**
 * Walk the dogfood-swarm package recursively, returning non-test JS source
 * files (production writers only — fixture-seeding INSERTs in test files are
 * out of scope for this invariant, same convention as every other Pattern
 * #10-style scan in this wave).
 */
function* walkJs(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'swarms' || entry === '.swarm') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkJs(full);
    } else if (st.isFile() && /\.(js|mjs|cjs)$/.test(entry) && !/\.test\.(js|mjs|cjs)$/.test(entry)) {
      yield full;
    }
  }
}

/**
 * Extracts { columns, values } for the FIRST `INSERT INTO finding_events
 * (...) VALUES (...)` shape found in a SQL string. Naive comma-split — a
 * disclosed limitation for any value containing an embedded comma inside
 * quotes, which does not occur in this package's actual finding_events
 * insert sites (verified by inspection before writing this scan).
 */
function parseFindingEventsInsert(sqlText) {
  const m = /INSERT\s+INTO\s+finding_events\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sqlText);
  if (!m) return undefined;
  const columns = m[1].split(',').map((c) => c.trim());
  const values = m[2].split(',').map((v) => v.trim());
  return { columns, values };
}

describe('F-c0b12add — static scan: every LITERAL event_type value at an INSERT site is a member of EVENT_TYPES', () => {
  it('scans every INSERT INTO finding_events call site for a literal event_type value out of enum (disclosed partial: bound-variable values are not checked)', async () => {
    const { EVENT_TYPES, error } = await loadEventTypes();
    if (error) {
      assert.fail(`${error} — this scan needs the real EVENT_TYPES export to check membership against.`);
    }

    const stringRe = /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
    const offenders = [];
    const sitesScanned = [];

    for (const file of walkJs(PKG_DIR)) {
      const rel = file.replace(/\\/g, '/');
      const raw = readFileSync(file, 'utf-8');
      const stripped = stripComments(raw);
      let m;
      while ((m = stringRe.exec(stripped))) {
        const s = m[0];
        if (!/INSERT\s+INTO\s+finding_events/i.test(s)) continue;
        const parsed = parseFindingEventsInsert(s);
        if (!parsed) continue;
        const idx = parsed.columns.indexOf('event_type');
        if (idx === -1) continue;
        const value = parsed.values[idx];
        const literalMatch = /^'([^']*)'$/.exec(value) || /^"([^"]*)"$/.exec(value);
        if (!literalMatch) continue; // bound `?` parameter or expression — disclosed, not checkable statically.
        const literal = literalMatch[1];
        const line = stripped.slice(0, m.index).split('\n').length;
        sitesScanned.push(`${rel}:${line}: '${literal}'`);
        if (!EVENT_TYPES.includes(literal)) {
          offenders.push(`${rel}:${line}: literal event_type '${literal}' is not a member of EVENT_TYPES`);
        }
      }
    }

    // Non-vacuity: this scan must find at least the ONE known literal site
    // (cli.js's bulk-approve `VALUES (?, 'approved', 'bulk approve')`) or the
    // parser itself is broken and the whole assertion below would pass
    // vacuously over zero scanned sites.
    assert.ok(sitesScanned.length > 0,
      `expected to find at least one literal event_type INSERT site (e.g. cli.js's bulk-approve path); ` +
      `found none — the scanner itself may be broken, not the target code`);

    assert.deepEqual(offenders, [],
      `every literal event_type value at an INSERT INTO finding_events site must be a member of ` +
      `EVENT_TYPES:\n${offenders.map((o) => `  ${o}`).join('\n')}`);
  });
});
