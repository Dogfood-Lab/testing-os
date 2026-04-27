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
 *
 * Default manifest path: swarms/migrations/wave-30-incidental-cross-refs.json
 *
 * Exit codes:
 *   0 — migrations applied (or already applied; idempotent no-op)
 *   1 — manifest read/parse error, finding not found, or DB error
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
  const args = { check: false, manifest: null };
  for (const a of argv.slice(2)) {
    if (a === '--check') args.check = true;
    else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      args.manifest = a;
    }
  }
  return args;
}

function loadManifest(path) {
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  const text = readFileSync(path, 'utf-8');
  const json = JSON.parse(text);
  if (json.schema !== 'finding-migration/v1') {
    throw new Error(
      `Manifest schema mismatch — expected 'finding-migration/v1', got '${json.schema}'`
    );
  }
  if (!json.run_id) throw new Error('Manifest missing run_id');
  if (!Array.isArray(json.cross_ref_migrations)) {
    throw new Error('Manifest missing cross_ref_migrations[]');
  }
  if (!Array.isArray(json.coordinator_resolved_migrations)) {
    throw new Error('Manifest missing coordinator_resolved_migrations[]');
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

  const result = {
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
  const manifestPath = args.manifest
    ? resolve(process.cwd(), args.manifest)
    : DEFAULT_MANIFEST;

  applyMigration(manifestPath, { check: args.check })
    .then((result) => {
      const verb = args.check ? 'WOULD APPLY' : 'APPLIED';
      console.error(
        `coordinator_scope_expansion: finding-migration ${verb} — ` +
        `cross_ref(${result.cross_ref_applied}/${result.cross_ref_applied + result.cross_ref_skipped_already_set}), ` +
        `allowlist(${result.coordinator_resolved_applied}/${result.coordinator_resolved_applied + result.coordinator_resolved_skipped_already_set})`
      );
      if (result.cross_ref_missing_finding.length > 0) {
        console.error(
          `WARN: cross_ref findings not in DB: ${result.cross_ref_missing_finding.join(', ')}`
        );
      }
      if (result.coordinator_resolved_missing_finding.length > 0) {
        console.error(
          `WARN: coordinator_resolved findings not in DB: ${result.coordinator_resolved_missing_finding.join(', ')}`
        );
      }
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      process.exit(e.message.includes('schema mismatch') ? 2 : 1);
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
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { applyMigration, loadManifest };
