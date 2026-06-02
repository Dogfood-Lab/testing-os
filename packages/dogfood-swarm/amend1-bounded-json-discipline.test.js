/**
 * amend1-bounded-json-discipline.test.js
 *
 * Wave A1 D3 — mechanical completeness gate for the bounded-JSON family
 * (H5).
 *
 * The rule. `JSON.parse(readFileSync(<path>))` is the bug shape this fix
 * exists to prevent. Any operator-supplied / agent-emitted / untrusted-
 * external read site under `packages/dogfood-swarm/**` MUST go through
 * `readBoundedJson` from `lib/bounded-json-read.js` so the 50 MB size gate
 * runs before the synchronous parse blocks the event loop.
 *
 * The allowlist captures sites that legitimately do bare
 * `JSON.parse(readFileSync(...))` — namely, internal trust-bounded sites
 * where the input was written by the swarm's own code into a known-small
 * DB column (gates_checked, overrides, domain globs, etc.). The kickoff
 * §H5 explicitly enumerates these.
 *
 * New sites under `packages/dogfood-swarm/**` either go through the
 * helper, or get added to the allowlist with a `reason`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;

const TEST_FILE_PATTERN = /\.test\.(js|mjs)$/;

// Files where `JSON.parse(readFileSync(...))` is legitimately bare:
// internal trust-bounded sites where the input was produced by the swarm's
// own code into a small DB column. Each entry MUST have a `reason`.
//
// Paths are relative to packages/dogfood-swarm/, forward slashes.
const ALLOWLIST = [
  {
    file: 'lib/advance.js',
    reason: 'JSON.parse on promotions.gates_checked/overrides/finding_snapshot, populated by the swarm itself at advance time — known-small structured JSON, no exotic input risk.',
  },
  {
    file: 'lib/persist/export.js',
    reason: 'JSON.parse on the same internal promotion-trail columns the export.js reads back from DB after advance.js wrote them.',
  },
  {
    file: 'lib/verify-fixed.js',
    reason: 'JSON.parse on findings.metadata column (swarm-internal, bounded by upsert-time limits in fingerprint.js).',
  },
  {
    file: 'lib/domains.js',
    reason: 'JSON.parse on domains.globs (swarm-internal, small canonical JSON array of glob patterns).',
  },
  {
    file: 'commands/resume.js',
    reason: 'JSON.parse on domains.globs in the redispatch prompt builder (swarm-internal, same domain-globs path as lib/domains.js).',
  },
  // L1-006 fix-up (Wave A1 D3): the prior allowlist included
  // lib/persist/repoknowledge-bridge.js with the reason "per-finding
  // JSON.parse on bridge-internal serialised arrays" — but the file has
  // zero JSON.parse calls (grep-verified at fix-up time). The bridge
  // builds its envelope from already-decoded DB objects via
  // buildRunExport; the parse was never there. Allowlist entries for
  // non-existent code are noise that hide future genuine adds. Removed.
  {
    file: 'lib/templates.js',
    reason: 'Loads agent-output.schema.json via createRequire from @dogfood-lab/schemas — a swarm-internal, repo-owned JSON Schema document. Same trust class as lib/validate-agent-output.js; this is the prompt-builder side that renders the contract block from the canonical schema.',
  },
  {
    file: 'lib/validate-agent-output.js',
    reason: 'Loads agent-output.schema.json via createRequire from @dogfood-lab/schemas — a swarm-internal, repo-owned JSON Schema document used to compile the Ajv validator on first use. Not operator-supplied input.',
  },
];

function walkSync(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const stat = statSync(p);
    if (stat.isDirectory()) walkSync(p, files);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
  }
  return files;
}

function relativeFromPkg(absPath) {
  return absPath.slice(PKG_ROOT.length + 1).replace(/\\/g, '/');
}

function isAllowlisted(relPath) {
  return ALLOWLIST.some(entry => entry.file === relPath);
}

describe('Bounded JSON read discipline (H5)', () => {
  it('no FROM-disk JSON.parse(readFileSync(...)) outside helper / allowlist', () => {
    const all = walkSync(PKG_ROOT);
    const sourceFiles = all.filter(p => !TEST_FILE_PATTERN.test(relativeFromPkg(p)));

    // Match the textual pattern JSON.parse(readFileSync(...)  — including
    // the multiline form JSON.parse(\n  readFileSync(... — to catch all
    // syntactic forms.
    //
    // We accept either a single-line form OR a form where JSON.parse and
    // readFileSync appear within a small window (the parse call argument).
    // The conservative match is JSON.parse(readFileSync(...
    const PARSE_PATTERN =
      /JSON\.parse\(\s*readFileSync\s*\(/;

    const offenders = [];
    for (const f of sourceFiles) {
      const rel = relativeFromPkg(f);
      // Skip the helper itself (it doesn't use JSON.parse on disk reads —
      // it implements bounded reads — but listing it for clarity).
      if (rel === 'lib/bounded-json-read.js') continue;
      const text = readFileSync(f, 'utf-8');
      if (!PARSE_PATTERN.test(text)) continue;
      if (isAllowlisted(rel)) continue;
      offenders.push(rel);
    }

    assert.deepEqual(offenders, [],
      `bounded-json discipline violation:\n  ${offenders.join('\n  ')}\n` +
      `Route the read through readBoundedJson from lib/bounded-json-read.js, ` +
      `OR add the file to the allowlist in amend1-bounded-json-discipline.test.js ` +
      `with a documented reason explaining why bare JSON.parse(readFileSync(...)) ` +
      `is safe at the site (typically: input is swarm-internal, trust-bounded, ` +
      `or size-bounded by an upstream gate).`);
  });

  it('migrated files import the helper', () => {
    const expected = [
      'commands/collect.js',
      'commands/revalidate.js',
      'persist-results.js',
      'lib/findings-digest.js',
      'lib/verify/adapters/node.js',
    ];

    const missing = [];
    for (const rel of expected) {
      const p = join(PKG_ROOT, rel);
      const text = readFileSync(p, 'utf-8');
      // Helper import — accept either `bounded-json-read` literal or the
      // exported name. We assert both: the import statement AND a reference
      // to readBoundedJson in the file body.
      const imports = text.includes('bounded-json-read.js');
      const uses = text.includes('readBoundedJson');
      if (!imports || !uses) {
        missing.push(`${rel} (imports: ${imports}, uses: ${uses})`);
      }
    }

    assert.deepEqual(missing, [],
      `expected H5 migration site missing readBoundedJson:\n  ${missing.join('\n  ')}`);
  });
});
