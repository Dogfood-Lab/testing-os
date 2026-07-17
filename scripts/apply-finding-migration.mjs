#!/usr/bin/env node
/**
 * apply-finding-migration.mjs — apply finding-record migrations from a JSON
 * manifest into the swarm control-plane DB.
 *
 * **Class #14b productization companion.** Wave 30 shipped verify-fixed v2
 * (lib/verify-classifier-v2.js) which reads finding.cross_ref +
 * finding.coordinator_resolved + finding.verified_via_evidence to classify
 * with vantage-point disclosure. v2 the *capability* shipped in v1.1.5.
 * v2 the *data infrastructure* (schema columns + this migration script)
 * ships in v1.1.6 — Class #14 self-application caught the gap at the
 * migration boundary before wave 31 dispatched.
 *
 * Idempotency contract:
 *   - The schema migration (db/schema.js applyMigrations) is idempotent at
 *     the connection-init layer via PRAGMA-checked ALTER TABLE + duplicate-
 *     column error catch. Running this script multiple times is safe.
 *   - The data UPDATE statements are idempotent in the obvious sense:
 *     they overwrite the same fields with the same values. Running twice
 *     produces no diff vs running once.
 *   - The script logs a coordinator_scope_expansion telemetry line per
 *     run (stderr, not stdout) so an operator running it twice sees that
 *     the second run was a no-op.
 *
 * Usage:
 *   node scripts/apply-finding-migration.mjs <manifest.json>
 *   node scripts/apply-finding-migration.mjs --check <manifest.json>   (no-op preview)
 *   node scripts/apply-finding-migration.mjs --db <path> <manifest.json>  (target a specific DB)
 *   node scripts/apply-finding-migration.mjs --allow-missing <manifest.json>  (see below)
 *
 * Default manifest path: swarms/migrations/wave-30-incidental-cross-refs.json
 * Default DB path:       swarms/control-plane.db
 *
 * Missing-finding contract (F-6042850f):
 *   If the manifest references a finding_id that is not present in the target
 *   DB for the manifest's run_id, the migration for that finding is a no-op —
 *   the field it was meant to backfill stays empty. This is almost always an
 *   operator error (wrong DB, stale run_id, or a typo'd F-id), so by default
 *   the script HARD-FAILS (exit 1) naming the missing F-ids, the resolved DB
 *   path, and the run_id. Pass --allow-missing to opt into an intentional
 *   partial-miss (exit 0 with the missing F-ids surfaced as a warning).
 *
 * Exit codes:
 *   0 — migrations applied (or already applied; idempotent no-op)
 *   1 — manifest read/parse error, DB error, or a manifest F-id was absent from
 *       the DB and --allow-missing was not passed
 *   2 — manifest validation failed (schema mismatch)
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_MANIFEST = join(
  REPO_ROOT,
  'swarms/migrations/wave-30-incidental-cross-refs.json'
);

function parseArgs(argv) {
  const args = { check: false, allowMissing: false, dbPath: null, manifest: null, help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--check') args.check = true;
    else if (a === '--allow-missing') args.allowMissing = true;
    else if (a === '--db') {
      args.dbPath = rest[++i];
      if (!args.dbPath) throw new Error('--db requires a path argument');
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      args.manifest = a;
    }
  }
  return args;
}

const USAGE = `Usage:
  node scripts/apply-finding-migration.mjs <manifest.json>
  node scripts/apply-finding-migration.mjs --check <manifest.json>   (no-op preview)
  node scripts/apply-finding-migration.mjs --db <path> <manifest.json>  (target a specific DB)
  node scripts/apply-finding-migration.mjs --allow-missing <manifest.json>  (accept a partial miss)

Applies finding-record migrations from a JSON manifest into the swarm
control-plane DB.

Default manifest path: swarms/migrations/wave-30-incidental-cross-refs.json
Default DB path:       swarms/control-plane.db

Options:
  --check           preview only — report what would change without writing
  --db <path>       target a specific control-plane DB
  --allow-missing   exit 0 on a partial miss (manifest F-id absent from the DB)
  -h, --help        this message

Exit codes: 0 (applied / idempotent no-op) | 1 (read/DB/missing-finding error) | 2 (manifest validation error)
`;

/**
 * F-3401d9b6: sentinel so the top-level `.catch()` can classify a manifest-
 * SHAPE failure (exit 2, "manifest validation failed" per the documented
 * exit-code contract above) via `instanceof`, not a substring match against
 * freely-editable error-message TEXT (the pre-fix `e.message.includes('schema
 * mismatch')`, which only the literal schema-tag-mismatch message happened
 * to satisfy — every other loadManifest validation throw fell through to
 * exit 1, lumped in with a genuine I/O/DB error). Mirrors
 * scripts/sync-version.mjs's DriftError, the sibling pattern this file's own
 * comments already point at (`err instanceof DriftError ? 1 : 2`).
 *
 * Thrown for all FOUR of loadManifest's manifest-SHAPE validation failures
 * (schema mismatch, missing run_id, missing cross_ref_migrations[], missing
 * coordinator_resolved_migrations[]) — deliberately NOT for a missing file or
 * unparseable JSON, both of which stay plain Error/SyntaxError and fall
 * through to exit 1 ("read/parse error"), matching the documented contract's
 * own read/parse-vs-validation distinction exactly.
 */
export class ManifestValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

function loadManifest(path) {
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  const text = readFileSync(path, 'utf-8');
  const json = JSON.parse(text);
  if (json.schema !== 'finding-migration/v1') {
    throw new ManifestValidationError(
      `Manifest schema mismatch — expected 'finding-migration/v1', got '${json.schema}'`
    );
  }
  if (!json.run_id) throw new ManifestValidationError('Manifest missing run_id');
  if (!Array.isArray(json.cross_ref_migrations)) {
    throw new ManifestValidationError('Manifest missing cross_ref_migrations[]');
  }
  if (!Array.isArray(json.coordinator_resolved_migrations)) {
    throw new ManifestValidationError('Manifest missing coordinator_resolved_migrations[]');
  }
  return json;
}

async function applyMigration(manifestPath, opts = {}) {
  const { check = false, dbPath = null } = opts;

  const { openDb } = await import('../packages/dogfood-swarm/db/connection.js');
  const manifest = loadManifest(manifestPath);

  const resolvedDbPath = dbPath || join(REPO_ROOT, 'swarms/control-plane.db');
  if (!existsSync(resolvedDbPath)) {
    throw new Error(
      `Control-plane DB not found at ${resolvedDbPath}. ` +
      `Migrations only apply to existing runs; run an audit/amend first.`
    );
  }

  const db = openDb(resolvedDbPath);

  // Verify the schema migration ran (the columns exist).
  const cols = db.prepare('PRAGMA table_info(findings)').all().map((c) => c.name);
  const required = ['cross_ref', 'coordinator_resolved', 'verified_via_evidence'];
  const missing = required.filter((c) => !cols.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `Schema migration not applied — findings table missing columns: ${missing.join(', ')}. ` +
      `openDb should have applied them via MIGRATIONS_SQL; check db/schema.js + db/connection.js.`
    );
  }

  const findings = db.prepare(`
    SELECT id, finding_id, cross_ref, coordinator_resolved, verified_via_evidence
    FROM findings WHERE run_id = ?
  `).all(manifest.run_id);
  const byFindingId = new Map(findings.map((f) => [f.finding_id, f]));

  const updateCrossRef = db.prepare(`
    UPDATE findings
    SET cross_ref = ?, verified_via_evidence = ?
    WHERE run_id = ? AND finding_id = ?
  `);
  const updateAllowlist = db.prepare(`
    UPDATE findings
    SET coordinator_resolved = 1, verified_via_evidence = ?
    WHERE run_id = ? AND finding_id = ?
  `);

  const targeted =
    manifest.cross_ref_migrations.length +
    manifest.coordinator_resolved_migrations.length;

  const result = {
    // F-6042850f: context the failure message needs to be self-contained —
    // WHERE (db_path + run_id) and how many of the manifest's target findings
    // were actually found in the DB (matched/targeted).
    run_id: manifest.run_id,
    db_path: resolvedDbPath,
    targeted,
    matched: 0,
    cross_ref_applied: 0,
    cross_ref_skipped_already_set: 0,
    cross_ref_missing_finding: [],
    coordinator_resolved_applied: 0,
    coordinator_resolved_skipped_already_set: 0,
    coordinator_resolved_missing_finding: [],
  };

  // Run inside a single transaction for atomicity. SQLite's transactional
  // semantics let us roll back if any UPDATE fails; the alternative (no
  // transaction) leaves the DB in a partial state on error.
  const tx = db.transaction(() => {
    for (const m of manifest.cross_ref_migrations) {
      const existing = byFindingId.get(m.finding_id);
      if (!existing) {
        result.cross_ref_missing_finding.push(m.finding_id);
        continue;
      }
      result.matched++;
      const newJson = JSON.stringify(m.cross_ref);
      // Idempotent skip: if the existing cross_ref already matches the
      // new one, there's nothing to do. We compare on the parsed JSON to
      // avoid whitespace-induced false negatives.
      let alreadySet = false;
      if (existing.cross_ref) {
        try {
          alreadySet =
            JSON.stringify(JSON.parse(existing.cross_ref)) === newJson &&
            existing.verified_via_evidence === m.verified_via_evidence;
        } catch { /* malformed existing JSON — overwrite */ }
      }
      if (alreadySet) {
        result.cross_ref_skipped_already_set++;
        continue;
      }
      if (!check) {
        updateCrossRef.run(newJson, m.verified_via_evidence, manifest.run_id, m.finding_id);
      }
      result.cross_ref_applied++;
    }
    for (const m of manifest.coordinator_resolved_migrations) {
      const existing = byFindingId.get(m.finding_id);
      if (!existing) {
        result.coordinator_resolved_missing_finding.push(m.finding_id);
        continue;
      }
      result.matched++;
      const alreadySet =
        existing.coordinator_resolved === 1 &&
        existing.verified_via_evidence === m.verified_via_evidence;
      if (alreadySet) {
        result.coordinator_resolved_skipped_already_set++;
        continue;
      }
      if (!check) {
        updateAllowlist.run(m.verified_via_evidence, manifest.run_id, m.finding_id);
      }
      result.coordinator_resolved_applied++;
    }
  });
  tx();

  return result;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const manifestPath = args.manifest
    ? resolve(process.cwd(), args.manifest)
    : DEFAULT_MANIFEST;
  const dbPath = args.dbPath ? resolve(process.cwd(), args.dbPath) : null;

  applyMigration(manifestPath, { check: args.check, dbPath })
    .then((result) => {
      const verb = args.check ? 'WOULD APPLY' : 'APPLIED';
      console.error(
        `coordinator_scope_expansion: finding-migration ${verb} — ` +
        `cross_ref(${result.cross_ref_applied}/${result.cross_ref_applied + result.cross_ref_skipped_already_set}), ` +
        `allowlist(${result.coordinator_resolved_applied}/${result.coordinator_resolved_applied + result.coordinator_resolved_skipped_already_set})`
      );

      const missing = [
        ...result.cross_ref_missing_finding,
        ...result.coordinator_resolved_missing_finding,
      ];

      // F-6042850f: a manifest F-id absent from the DB means the field this
      // migration exists to backfill stayed empty. Emitting only a WARN and
      // exiting 0 (the pre-fix behavior) let a run against the wrong DB, a
      // stale run_id, or a typo'd F-id report SUCCESS while nothing landed.
      // Fail closed by default — name WHAT is missing, WHERE, and the next
      // command to verify — unless the operator opted into a partial-miss.
      if (missing.length > 0 && !args.allowMissing) {
        if (result.cross_ref_missing_finding.length > 0) {
          console.error(
            `[apply-finding-migration] ERROR: cross_ref findings not in DB: ${result.cross_ref_missing_finding.join(', ')}`
          );
        }
        if (result.coordinator_resolved_missing_finding.length > 0) {
          console.error(
            `[apply-finding-migration] ERROR: coordinator_resolved findings not in DB: ${result.coordinator_resolved_missing_finding.join(', ')}`
          );
        }
        console.error(
          `[apply-finding-migration] ERROR: the manifest run_id "${result.run_id}" matched ${result.matched}/${result.targeted} target findings in ${result.db_path} — ` +
          `${missing.length} migration${missing.length === 1 ? '' : 's'} backfilled nothing. ` +
          `Verify the run exists (\`swarm status ${result.run_id}\`) and that the manifest F-ids match that run, then re-run against the correct DB. ` +
          `If a partial miss is intentional, pass --allow-missing to accept it.`
        );
        console.log(JSON.stringify(result, null, 2));
        process.exit(1);
      }

      // Partial miss accepted via --allow-missing: keep the gap loud but green.
      if (missing.length > 0) {
        if (result.cross_ref_missing_finding.length > 0) {
          console.error(
            `[apply-finding-migration] WARN: cross_ref findings not in DB (--allow-missing): ${result.cross_ref_missing_finding.join(', ')}`
          );
        }
        if (result.coordinator_resolved_missing_finding.length > 0) {
          console.error(
            `[apply-finding-migration] WARN: coordinator_resolved findings not in DB (--allow-missing): ${result.coordinator_resolved_missing_finding.join(', ')}`
          );
        }
      }

      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(`[apply-finding-migration] ERROR: ${e.message}`);
      // F-3401d9b6: classify via instanceof, not a message-substring match —
      // see ManifestValidationError's own docstring above loadManifest().
      process.exit(e instanceof ManifestValidationError ? 2 : 1);
    });
}

// W31-BACK-001 fix: previous heuristic compared `import.meta.url` to a
// hand-built `file://${process.argv[1]}` plus an `endsWith` fallback. Both
// failed on Windows because `process.argv[1]` uses backslashes while
// `import.meta.url` is always POSIX/URL form. Result: `node scripts/apply-
// finding-migration.mjs` silently no-op'd on Windows; only the imported
// API worked. `pathToFileURL(...).href` is the canonical Node cross-
// platform "is this script the entrypoint" pattern. Caught by wave-31
// audit-the-audit (Class #14 5th-iteration instance).
//
// Stage C Wave A2 D4B-003 (Class #14 6th-iteration instance): the
// canonical sibling form is `process.argv[1] && pathToFileURL(...).href`.
// Without the short-circuit, dynamic-import / REPL / certain test-harness
// invocation paths (where `process.argv[1]` is undefined) throw `TypeError:
// The "path" argument must be of type string` instead of cleanly no-op'ing
// the main-entry block. sync-version.mjs:167, check-finding-regression-
// pins.mjs:285, and check-doc-drift.mjs:994 all carry the short-circuit;
// this guard finally matches. Regression test: scripts/apply-finding-
// migration.test.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { applyMigration, loadManifest };
