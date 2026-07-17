/**
 * Regression tests for scripts/apply-finding-migration.mjs.
 *
 * Stage C Wave A2 D4B-003 (Class #14 6th-iteration instance): the existing
 * Windows-cross-platform main-entry guard pattern is `process.argv[1] &&
 * pathToFileURL(process.argv[1]).href === import.meta.url`. Sibling scripts
 * (sync-version.mjs:167, check-finding-regression-pins.mjs:285, the live
 * canonical at check-doc-drift.mjs:994) all have the short-circuit. The
 * apply-finding-migration.mjs guard at line 232 is missing the
 * `process.argv[1] &&` half — invocation paths where argv[1] is undefined
 * (Node REPL, dynamic `import()` from stdin/eval, certain test harnesses)
 * throw `TypeError: The "path" argument must be of type string. Received
 * undefined` instead of cleanly no-op'ing the main-entry block.
 *
 * Test invariant (two halves):
 *   1. Importing the module from a context where `process.argv[1]` is
 *      undefined must NOT throw a TypeError. The main block silently
 *      no-ops; only the named exports (applyMigration, loadManifest) are
 *      visible.
 *   2. Counter-test: when invoked normally as a Node entrypoint
 *      (`node scripts/apply-finding-migration.mjs --help-ish`), the main
 *      block runs as before — proven by parseArgs reaching the no-manifest
 *      exit path with code 1 (manifest-required error).
 *
 * Pattern reference: Class #14 main-entry-guard sweep first landed in
 * W31-BACK-001 (apply-finding-migration.mjs:225 comment block names the
 * pattern). The audit-the-audit caught that the guard itself shipped with
 * the older, fragile half — fixed in this wave alongside the doc-drift
 * schema-conformance vacuous-gate cleanup.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const targetScript = resolve(repoRoot, 'scripts/apply-finding-migration.mjs');

test('apply-finding-migration: target script exists', () => {
  assert.ok(existsSync(targetScript), `expected ${targetScript}`);
});

test('apply-finding-migration: main-entry guard short-circuits when process.argv[1] is undefined (D4B-003)', () => {
  // Reproduce the failure path: spawn `node -e` with no script argv[1].
  // The module must import cleanly — main() must NOT fire, and crucially
  // `pathToFileURL(undefined)` must NOT throw a TypeError that would
  // propagate up through the dynamic import.
  //
  // We resolve to a file: URL string and import() it from the -e snippet.
  // When the guard is buggy (`if (import.meta.url === pathToFileURL(process.argv[1]).href)`),
  // the import rejects with `TypeError: The "path" argument must be of type
  // string. Received undefined`. When fixed (`if (process.argv[1] && ...)`),
  // the import resolves and the named exports become visible.
  const fileUrl = `file:///${targetScript.replace(/\\/g, '/')}`;
  const snippet = `
    import(${JSON.stringify(fileUrl)})
      .then((mod) => {
        if (typeof mod.applyMigration !== 'function') {
          console.error('MISSING_EXPORT_applyMigration');
          process.exit(3);
        }
        if (typeof mod.loadManifest !== 'function') {
          console.error('MISSING_EXPORT_loadManifest');
          process.exit(3);
        }
        console.log('GUARD_OK');
        process.exit(0);
      })
      .catch((err) => {
        console.error('IMPORT_FAILED:' + err.message);
        process.exit(4);
      });
  `;

  const result = spawnSync(process.execPath, ['-e', snippet], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  // Diagnostic surface: include both streams on any non-zero exit so a
  // future regression points at the exact failure (TypeError vs. missing
  // export vs. some new failure mode).
  if (result.status !== 0) {
    const tag = result.stderr.includes('Received undefined')
      ? 'D4B-003 REGRESSION: main-entry guard threw TypeError on undefined process.argv[1] — the `process.argv[1] &&` short-circuit is missing'
      : 'apply-finding-migration import failed';
    assert.fail(
      `${tag}\n` +
        `  exit: ${result.status}\n` +
        `  stdout: ${result.stdout}\n` +
        `  stderr: ${result.stderr}`,
    );
  }
  assert.match(result.stdout, /GUARD_OK/);
});

test('apply-finding-migration: main-entry block still runs when invoked as a script (D4B-003 counter-test)', () => {
  // Sanity check: the fix preserves normal-invocation behavior. With no
  // manifest and no --check flag, parseArgs accepts; the missing-manifest
  // path exits 1 with a message naming the manifest path. The exact text
  // is not load-bearing — we just want non-zero exit + non-empty stderr,
  // proving main() actually ran.
  const result = spawnSync(
    process.execPath,
    [targetScript, '/nonexistent/manifest-that-does-not-exist.json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.notEqual(
    result.status,
    0,
    'main-entry block should have run and exited non-zero on missing manifest',
  );
  assert.ok(
    (result.stderr ?? '').length > 0 || (result.stdout ?? '').length > 0,
    'main() should have produced output on the missing-manifest path',
  );
});

test('apply-finding-migration: guard line uses the canonical `process.argv[1] &&` short-circuit (D4B-003 structural pin)', () => {
  // Structural assertion: the fix must use the same idiom as sibling scripts
  // (sync-version.mjs:167, check-finding-regression-pins.mjs:285, the
  // current canonical at check-doc-drift.mjs:994). Pinning the literal
  // ensures a future hand-edit that drops the short-circuit re-introduces
  // the regression and fails this test before CI ships it. We accept both
  // operand orders around `===` since sibling scripts split — sync-version
  // and check-finding-regression-pins write `pathToFileURL(...) === import.meta.url`
  // while apply-finding-migration's prior shape was the reverse. The
  // load-bearing assertion is the `process.argv[1] && ...` short-circuit
  // immediately followed by a `pathToFileURL(process.argv[1])` comparison
  // against `import.meta.url`.
  const src = readFileSync(targetScript, 'utf8');
  const stripped = src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const guardLine = stripped
    .split(/\r?\n/)
    .find((l) => /^\s*if\s*\(.*process\.argv\[1\]/.test(l) && l.includes('pathToFileURL'));
  assert.ok(
    guardLine,
    `expected an executable line in scripts/apply-finding-migration.mjs that begins 'if (...process.argv[1]' and references pathToFileURL — found none`,
  );
  assert.match(
    guardLine,
    /process\.argv\[1\]\s*&&/,
    'main-entry guard must short-circuit on `process.argv[1] &&` before calling pathToFileURL(process.argv[1])',
  );
  assert.match(
    guardLine,
    /pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href\s*===\s*import\.meta\.url|import\.meta\.url\s*===\s*pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href/,
    'main-entry guard must compare pathToFileURL(process.argv[1]).href against import.meta.url',
  );
});

// ── F-6042850f: missing-finding path must HARD-FAIL, not report SUCCESS ──────
//
// Pre-fix, applyMigration() silently `continue`d past any manifest finding_id
// absent from the DB, main() emitted only a `WARN:` line, and the process
// exited 0 with the "APPLIED" summary. An operator running a migration against
// the wrong DB, a stale run_id, or a manifest with a typo'd F-id therefore saw
// a green run while the Class #14b backfill landed nothing.
//
// These tests seed a REAL control-plane DB via the production openDb path
// (CLAUDE.md rule 6 — real fixtures, no mocks), then drive the CLI with a
// `--db <path>` targeting that temp DB:
//
//   RED   — a manifest whose finding_id is not in the DB exits 0 / "APPLIED".
//   GREEN — same manifest exits 1, and the message names the missing F-id,
//           the resolved DB path, and the manifest run_id.
//   ESCAPE — `--allow-missing` restores exit 0 for the intentional partial-miss.
//   CONTROL — a manifest whose finding_id IS present exits 0 without the flag.

const MIGRATION_SCHEMA = 'finding-migration/v1';

/**
 * Seed a fresh control-plane DB under `dir` with one run and, optionally, one
 * finding for that run. Returns the DB path. Uses the production openDb so the
 * schema (including the wave-30 cross_ref / coordinator_resolved columns) is
 * created exactly as it is in production.
 */
async function seedDb(dir, { runId, seedFindingId }) {
  const { openDb, closeDb } = await import(
    '../packages/dogfood-swarm/db/connection.js'
  );
  const dbPath = join(dir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, 'dogfood-lab/testing-os', dir, 'deadbeef', 'complete');
  if (seedFindingId) {
    db.prepare(
      `INSERT INTO findings
         (run_id, finding_id, fingerprint, severity, category, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(runId, seedFindingId, `fp-${seedFindingId}`, 'MEDIUM', 'bug', 'seed');
  }
  // Release the handle so the spawned CLI process opens its own connection
  // against the same file without WAL-writer contention on Windows.
  closeDb(dbPath);
  return dbPath;
}

function writeManifest(dir, { runId, crossRefFindingId }) {
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: MIGRATION_SCHEMA,
      run_id: runId,
      cross_ref_migrations: [
        {
          finding_id: crossRefFindingId,
          cross_ref: { file: 'x.js', symbol: 'y', line: 1 },
          verified_via_evidence: 'test',
        },
      ],
      coordinator_resolved_migrations: [],
    }),
    'utf8',
  );
  return manifestPath;
}

function runMigration(args, cwd) {
  return spawnSync(process.execPath, [targetScript, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('apply-finding-migration: a manifest F-id absent from the DB hard-fails (exit 1) naming the F-id, DB path, and run_id (F-6042850f)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-missing-'));
  try {
    const runId = 'swarm-test-missing-0001';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });
    // Manifest targets a finding_id that was NOT seeded → missing in the DB.
    const manifestPath = writeManifest(dir, {
      runId,
      crossRefFindingId: 'F-typo-99',
    });

    const result = runMigration(['--db', dbPath, manifestPath], dir);

    assert.equal(
      result.status,
      1,
      `missing-finding migration must exit 1, not report SUCCESS (F-6042850f). ` +
        `Got exit ${result.status}.\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(
      combined,
      /F-typo-99/,
      'failure message must name the missing F-id (WHAT)',
    );
    assert.match(
      combined,
      /control-plane\.db/,
      'failure message must name the resolved DB path (WHERE)',
    );
    assert.match(
      combined,
      /swarm-test-missing-0001/,
      'failure message must name the manifest run_id (WHERE)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-finding-migration: --allow-missing restores exit 0 for an intentional partial-miss (F-6042850f escape hatch)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-allow-'));
  try {
    const runId = 'swarm-test-allow-0001';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });
    const manifestPath = writeManifest(dir, {
      runId,
      crossRefFindingId: 'F-typo-99',
    });

    const result = runMigration(
      ['--db', dbPath, '--allow-missing', manifestPath],
      dir,
    );

    assert.equal(
      result.status,
      0,
      `--allow-missing must restore exit 0.\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-finding-migration: a manifest whose F-id is present applies and exits 0 without --allow-missing (F-6042850f control)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-present-'));
  try {
    const runId = 'swarm-test-present-0001';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });
    const manifestPath = writeManifest(dir, {
      runId,
      crossRefFindingId: 'F-present-01',
    });

    const result = runMigration(['--db', dbPath, manifestPath], dir);

    assert.equal(
      result.status,
      0,
      `all-present migration must exit 0.\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── F-3401d9b6: exit-code classification is typed (instanceof), not a ───────
// message-substring match against freely-editable error text ───────────────
//
// The documented exit-code contract (module docstring) is "0 applied/no-op |
// 1 read/parse/DB/missing-finding error | 2 manifest validation failed
// (schema mismatch)". Pre-fix, the top-level `.catch()` classified via
// `e.message.includes('schema mismatch')` — only the literal schema-tag-
// mismatch message happened to contain that substring, so loadManifest's
// OTHER three manifest-SHAPE validation throws (missing run_id, missing
// cross_ref_migrations[], missing coordinator_resolved_migrations[]) fell
// through to exit 1, lumped in with a genuine I/O/DB error. All four are
// equally "the manifest doesn't conform to what this tool expects." The fix
// exports ManifestValidationError from loadManifest and classifies via
// `instanceof` in the catch — see that class's own docstring.
//
// writeRawManifest (unlike writeManifest above) accepts an ARBITRARY object
// so a fixture can omit exactly one required field, reproducing the four
// loadManifest validation branches individually.

function writeRawManifest(dir, obj, name = 'manifest.json') {
  const manifestPath = join(dir, name);
  writeFileSync(manifestPath, JSON.stringify(obj), 'utf8');
  return manifestPath;
}

test('apply-finding-migration: a manifest missing run_id now exits 2 (manifest validation), not 1 (F-3401d9b6)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-classify-runid-'));
  try {
    const runId = 'swarm-test-classify-0001';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });
    const manifestPath = writeRawManifest(dir, {
      schema: MIGRATION_SCHEMA,
      cross_ref_migrations: [],
      coordinator_resolved_migrations: [],
    });

    const result = runMigration(['--db', dbPath, manifestPath], dir);

    assert.equal(
      result.status,
      2,
      `a manifest missing run_id is a manifest-SHAPE validation failure and must exit 2, matching the schema-mismatch case, not 1 (F-3401d9b6).\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
    );
    assert.match(result.stderr, /missing run_id/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-finding-migration: a manifest missing cross_ref_migrations[] now exits 2, not 1 (F-3401d9b6)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-classify-xref-'));
  try {
    const runId = 'swarm-test-classify-0002';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });
    const manifestPath = writeRawManifest(dir, {
      schema: MIGRATION_SCHEMA,
      run_id: runId,
      coordinator_resolved_migrations: [],
    });

    const result = runMigration(['--db', dbPath, manifestPath], dir);

    assert.equal(
      result.status,
      2,
      `a manifest missing cross_ref_migrations[] is a manifest-SHAPE validation failure and must exit 2, not 1 (F-3401d9b6).\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
    );
    assert.match(result.stderr, /missing cross_ref_migrations/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-finding-migration: a manifest missing coordinator_resolved_migrations[] now exits 2, not 1 (F-3401d9b6 — the previously wholly-untested 4th branch)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-classify-coord-'));
  try {
    const runId = 'swarm-test-classify-0003';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });
    const manifestPath = writeRawManifest(dir, {
      schema: MIGRATION_SCHEMA,
      run_id: runId,
      cross_ref_migrations: [],
    });

    const result = runMigration(['--db', dbPath, manifestPath], dir);

    assert.equal(
      result.status,
      2,
      `a manifest missing coordinator_resolved_migrations[] is a manifest-SHAPE validation failure and must exit 2, not 1 (F-3401d9b6).\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
    );
    assert.match(result.stderr, /missing coordinator_resolved_migrations/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** @pins F-3401d9b6 */
test('apply-finding-migration: a wrong schema tag still exits 2 (regression control — must not move), and I/O-shaped failures stay at exit 1 (F-3401d9b6)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-classify-control-'));
  try {
    const runId = 'swarm-test-classify-0004';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });

    // Control 1: wrong schema tag — the ONE case that already exited 2
    // pre-fix; must stay exit 2 post-fix (a validation failure, correctly
    // classified before and after).
    const schemaMismatchPath = writeRawManifest(dir, {
      schema: 'wrong-schema-tag',
      run_id: runId,
      cross_ref_migrations: [],
      coordinator_resolved_migrations: [],
    }, 'schema-mismatch.json');
    const schemaMismatchResult = runMigration(['--db', dbPath, schemaMismatchPath], dir);
    assert.equal(schemaMismatchResult.status, 2, 'schema mismatch must remain exit 2 (regression control)');

    // Control 2: manifest file does not exist at all — a read error, NOT a
    // manifest-shape validation failure. Must stay exit 1 (documented
    // contract: "1 — manifest read/parse/DB/missing-finding error").
    const missingResult = runMigration(['--db', dbPath, join(dir, 'does-not-exist.json')], dir);
    assert.equal(missingResult.status, 1, 'a missing manifest FILE is a read error, not a validation error — must stay exit 1');

    // Control 3: manifest file exists but is unparseable JSON — also a
    // read/parse error, not a manifest-shape validation failure. Must stay
    // exit 1; this fix only reclassifies loadManifest's four POST-parse
    // shape checks, never the JSON.parse itself.
    const malformedPath = join(dir, 'malformed.json');
    writeFileSync(malformedPath, '{ not valid json,,, }', 'utf8');
    const malformedResult = runMigration(['--db', dbPath, malformedPath], dir);
    assert.equal(malformedResult.status, 1, 'unparseable manifest JSON is a read/parse error, not a validation error — must stay exit 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-finding-migration: exit-code classification uses `instanceof ManifestValidationError`, not a message-substring match (F-3401d9b6 structural pin)', () => {
  const src = readFileSync(targetScript, 'utf8');
  assert.match(
    src,
    /export class ManifestValidationError extends Error/,
    'expected an exported ManifestValidationError class (F-3401d9b6), mirroring sync-version.mjs\'s DriftError',
  );
  assert.match(
    src,
    /process\.exit\(\s*e\s+instanceof\s+ManifestValidationError\s*\?\s*2\s*:\s*1\s*\)/,
    'the top-level catch must classify via `e instanceof ManifestValidationError`, not `e.message.includes(...)` (F-3401d9b6) — a future error-message wording tweak must not be able to silently reclassify the exit code',
  );
  assert.doesNotMatch(
    src,
    /e\.message\.includes\(\s*['"]schema mismatch['"]\s*\)/,
    'the substring-match classification this finding closed must not reappear (F-3401d9b6)',
  );
});

// ── F-bc3ea257: `--help`/`-h` must print the documented Usage block, exit 0 ──
//
// The script's Usage block lived only in the header comment; `--help` reached
// the `else if (a.startsWith('--')) throw` branch and exited 1 with "Unknown
// flag: --help". An operator reaching for the near-universal --help convention
// got an error exit instead of usage. The fix routes -h/--help to the Usage
// block and exits 0 BEFORE any migration runs, matching the sibling
// check-finding-regression-pins.mjs printHelp()/exit-0 path.

test('apply-finding-migration: --help prints the Usage block and exits 0 (F-bc3ea257)', () => {
  const result = spawnSync(process.execPath, [targetScript, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `--help must exit 0, not hit the Unknown-flag path.\n  stdout: ${result.stdout}\n  stderr: ${result.stderr}`,
  );
  assert.match(
    result.stdout,
    /Usage:/,
    '--help must print the Usage block to stdout',
  );
  assert.match(
    result.stdout,
    /apply-finding-migration\.mjs/,
    'the Usage block must name the script',
  );
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /Unknown flag/,
    '--help must not fall through to the unknown-flag rejection',
  );
});

test('apply-finding-migration: -h is an alias for --help (F-bc3ea257)', () => {
  const result = spawnSync(process.execPath, [targetScript, '-h'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `-h must exit 0.\n  stderr: ${result.stderr}`);
  assert.match(result.stdout, /Usage:/, '-h must print the Usage block');
});

test('apply-finding-migration: an unrecognized flag is still rejected after the --help branch (F-bc3ea257 guard)', () => {
  const result = spawnSync(process.execPath, [targetScript, '--nope'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'an unknown flag must still be a non-zero exit');
  assert.match(
    result.stderr,
    /Unknown flag/,
    'the unknown-flag rejection must survive the added --help branch',
  );
});

// ── F-f6d570aa: operator-facing status lines carry the [gate-name] prefix ────
//
// apply-finding-migration was the only gate script emitting ERROR:/WARN: status
// lines WITHOUT the shared `[gate-name]` bracket convention every sibling uses
// (sync-version, check-doc-drift, check-finding-regression-pins, build). In an
// interleaved `npm run verify` transcript a bare `ERROR:` line was unattributable
// at a glance. The fix namespaces the human-readable ERROR/WARN lines; the
// `coordinator_scope_expansion:` telemetry token deliberately stays bare.

test('apply-finding-migration: the missing-finding ERROR lines carry the [apply-finding-migration] prefix (F-f6d570aa)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-prefix-'));
  try {
    const runId = 'swarm-test-prefix-0001';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });
    const manifestPath = writeManifest(dir, {
      runId,
      crossRefFindingId: 'F-typo-99',
    });

    const result = runMigration(['--db', dbPath, manifestPath], dir);

    assert.equal(result.status, 1, 'missing-finding path still hard-fails');
    // Every human-readable ERROR line must be namespaced; no bare `ERROR:` at
    // line start survives.
    for (const line of result.stderr.split(/\r?\n/)) {
      if (/(^|\s)ERROR:/.test(line)) {
        assert.match(
          line,
          /\[apply-finding-migration\] ERROR:/,
          `ERROR status line must carry the [apply-finding-migration] prefix — got: ${line}`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-finding-migration: the --allow-missing WARN lines carry the [apply-finding-migration] prefix (F-f6d570aa)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afm-warn-'));
  try {
    const runId = 'swarm-test-warn-0001';
    const dbPath = await seedDb(dir, { runId, seedFindingId: 'F-present-01' });
    const manifestPath = writeManifest(dir, {
      runId,
      crossRefFindingId: 'F-typo-99',
    });

    const result = runMigration(['--db', dbPath, '--allow-missing', manifestPath], dir);

    assert.equal(result.status, 0, '--allow-missing keeps exit 0');
    assert.match(
      result.stderr,
      /\[apply-finding-migration\] WARN:/,
      'the --allow-missing partial-miss WARN line must carry the [apply-finding-migration] prefix',
    );
    for (const line of result.stderr.split(/\r?\n/)) {
      if (/(^|\s)WARN:/.test(line)) {
        assert.match(
          line,
          /\[apply-finding-migration\] WARN:/,
          `WARN status line must carry the [apply-finding-migration] prefix — got: ${line}`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
