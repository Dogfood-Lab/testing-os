/**
 * stageC-handbook-db-runbooks — doc drift seal for d7-docs-B001 + d7-docs-B002.
 *
 * These are documentation fixes, so the test discipline is "cross-check the doc
 * claim against the source it describes, and go RED if either side drifts."
 * Both findings document real behavior in packages/dogfood-swarm/db/connection.js
 * that previously had NO handbook coverage:
 *
 *   d7-docs-B001 — openDb's schema-version-too-new throw (the `version >
 *     SCHEMA_VERSION` branch) was undocumented. We now document it in
 *     error-codes.md under CONTROL_PLANE_SCHEMA_TOO_NEW with the exact
 *     message-shape fragment and the "upgrade the tool, do NOT do DB surgery"
 *     recovery.
 *
 *   d7-docs-B002 — there was no standalone runbook for a locked control-plane
 *     DB; the WAL + busy_timeout contract was mentioned only inside
 *     COLLECT_UPSERT_FAILED. operating-guide.md now carries a
 *     "Recovering from a locked control-plane DB" subsection naming WAL,
 *     busy_timeout, and the kill-the-stuck-process recovery.
 *
 * Why this is a real seal and not a tautology: each assertion pins the doc text
 * to a fact READ from connection.js (the source of truth). If the throw message
 * changes, or BUSY_TIMEOUT_MS moves off 5000, or the doc entry is deleted, the
 * corresponding assertion fails — the doc can't silently drift away from the
 * code it claims to describe. Reading connection.js here is read-only; this test
 * never edits anything under packages/.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const connectionSrc = readFileSync(
  resolve(repoRoot, 'packages/dogfood-swarm/db/connection.js'),
  'utf8'
);
const errorCodes = readFileSync(
  resolve(repoRoot, 'site/src/content/docs/handbook/error-codes.md'),
  'utf8'
);
const operatingGuide = readFileSync(
  resolve(repoRoot, 'site/src/content/docs/handbook/operating-guide.md'),
  'utf8'
);

/**
 * Slice a markdown doc from the heading `anchor` up to the next heading at the
 * SAME-OR-SHALLOWER level (or end of file). `anchor` must begin with its `#`
 * markers (e.g. `## Foo` or `### \`BAR\``) so the level is known. Length-robust:
 * the section can grow without the test silently truncating it mid-content.
 */
function sliceSection(doc, anchor) {
  const start = doc.indexOf(anchor);
  if (start < 0) return '';
  const level = (anchor.match(/^#+/) ?? ['#'])[0].length; // 2 for ##, 3 for ###
  const rest = doc.slice(start + anchor.length);
  // Next heading with between 1 and `level` hashes (same level or shallower).
  const re = new RegExp(`\\n#{1,${level}}\\s`);
  const next = rest.search(re);
  return anchor + (next < 0 ? rest : rest.slice(0, next));
}

// ─────────────────────────────────────────────────────────────────────────────
// d7-docs-B001 — CONTROL_PLANE_SCHEMA_TOO_NEW is documented and matches the throw.
// ─────────────────────────────────────────────────────────────────────────────

test('d7-docs-B001: connection.js actually throws the schema-too-new error (the doc is not a phantom)', () => {
  // The `version > SCHEMA_VERSION` refusal branch must exist in source — else
  // the doc entry documents behavior that no longer exists.
  assert.match(
    connectionSrc,
    /version\s*>\s*SCHEMA_VERSION/,
    'connection.js must still carry the schema-version-too-new branch the doc describes'
  );
  assert.ok(
    connectionSrc.includes('Pull the latest @dogfood-lab/dogfood-swarm before opening this DB'),
    'connection.js throw message must still contain the documented remedy sentence'
  );
});

test('d7-docs-B001: error-codes.md documents CONTROL_PLANE_SCHEMA_TOO_NEW with the throw message shape', () => {
  assert.ok(
    errorCodes.includes('CONTROL_PLANE_SCHEMA_TOO_NEW'),
    'error-codes.md must document the schema-too-new failure under CONTROL_PLANE_SCHEMA_TOO_NEW'
  );
  // The documented message-shape line must match the literal remedy sentence
  // emitted by connection.js — this is the bit that drifts.
  const remedy = 'Pull the latest @dogfood-lab/dogfood-swarm before opening this DB';
  assert.ok(
    errorCodes.includes(remedy),
    'error-codes.md message-shape must quote the actual connection.js remedy sentence'
  );
  assert.ok(
    connectionSrc.includes(remedy),
    'and connection.js must still emit it (both sides pinned together)'
  );
});

test('d7-docs-B001: the entry + throw are now a TYPED error carrying code CONTROL_PLANE_SCHEMA_TOO_NEW', () => {
  // Wave-2 (F4-CP-03 / F5-07) fulfilled the prior "should be typed" follow-up:
  // openDb now throws the typed ControlPlaneSchemaTooNewError (.code =
  // 'CONTROL_PLANE_SCHEMA_TOO_NEW'), so renderTopLevelError prints the
  // structured `ERROR [CONTROL_PLANE_SCHEMA_TOO_NEW]:` envelope. This seal is
  // the INVERSE of the pre-wave-2 untyped-disclosure seal it replaces: it now
  // guards that the error STAYS typed and that the doc reflects the typed shape
  // (rather than guarding the old plain-Error disclosure).
  const section = sliceSection(errorCodes, '### `CONTROL_PLANE_SCHEMA_TOO_NEW`');
  assert.match(
    section,
    /ControlPlaneSchemaTooNewError/,
    'the entry must document the typed error class'
  );
  assert.match(
    section,
    /code:?\s*[`'"]CONTROL_PLANE_SCHEMA_TOO_NEW/,
    'the entry must document the .code the typed error carries'
  );
  // connection.js must throw the TYPED class in the refusal branch, not a plain
  // `new Error(` — guards against a regression back to the untyped shape.
  assert.match(
    connectionSrc,
    /throw new ControlPlaneSchemaTooNewError\(/,
    'connection.js must throw the typed ControlPlaneSchemaTooNewError in the refusal branch'
  );
  assert.doesNotMatch(
    connectionSrc,
    /throw new Error\(\s*[\s\S]*?only understands v\$\{SCHEMA_VERSION\}/,
    'connection.js must no longer throw a plain Error in the refusal branch (it is now typed)'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// d7-docs-B002 — locked-control-plane-DB runbook exists and matches connection.js.
// ─────────────────────────────────────────────────────────────────────────────

test('d7-docs-B002: operating-guide.md has a standalone locked-control-plane-DB runbook', () => {
  assert.match(
    operatingGuide,
    /##\s+Recovering from a locked control-plane DB/,
    'operating-guide.md must carry a standalone "Recovering from a locked control-plane DB" section'
  );
});

test('d7-docs-B002: the runbook names the WAL + busy_timeout contract that connection.js applies', () => {
  // connection.js applies journal_mode=WAL + busy_timeout to file-backed conns.
  assert.match(connectionSrc, /journal_mode\s*=\s*WAL/, 'connection.js must still apply WAL (source of the doc claim)');
  assert.match(connectionSrc, /busy_timeout\s*=\s*\$\{BUSY_TIMEOUT_MS\}/, 'connection.js must still apply busy_timeout');

  const runbook = sliceSection(operatingGuide, '## Recovering from a locked control-plane DB');
  assert.match(runbook, /\bWAL\b/, 'runbook must name WAL');
  assert.match(runbook, /busy_timeout/, 'runbook must name busy_timeout');
});

test('d7-docs-B002: the documented busy_timeout window matches BUSY_TIMEOUT_MS in connection.js', () => {
  // Pin the doc's "5-second" / "5s" window to the actual constant. If someone
  // bumps BUSY_TIMEOUT_MS, this fails so the doc gets updated in lockstep.
  const m = connectionSrc.match(/const\s+BUSY_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(m, 'BUSY_TIMEOUT_MS literal must be present in connection.js');
  const seconds = Number(m[1]) / 1000;
  const runbook = sliceSection(operatingGuide, '## Recovering from a locked control-plane DB');
  // Accept "5-second" or "5s" or "5 s" phrasings for the computed window.
  const re = new RegExp(`${seconds}\\s*-?\\s*(second|s\\b)`, 'i');
  assert.match(
    runbook,
    re,
    `runbook must state the busy_timeout window as ${seconds}s to match BUSY_TIMEOUT_MS=${m[1]}`
  );
});

test('d7-docs-B002: the runbook steers to killing the stuck process, NOT manual DB surgery', () => {
  const runbook = sliceSection(operatingGuide, '## Recovering from a locked control-plane DB');
  assert.match(
    runbook,
    /stuck process|Stop-Process|kill /i,
    'runbook recovery must be "find and stop the stuck process"'
  );
  assert.match(
    runbook,
    /do\s*not[\s\S]{0,80}(delete|surgery|hand-edit)/i,
    'runbook must explicitly warn against deleting / hand-editing the DB to unstick a lock'
  );
});
