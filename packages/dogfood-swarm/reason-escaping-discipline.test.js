/**
 * reason-escaping-discipline.test.js — mechanical guard against a NEW
 * reason-rendering site shipping unescaped.
 *
 * The wave-18 root cause (F-7c3e91a4 / F-463c7179): wave 16 fixed
 * formatOverrideGroups (cli.js) alone, while seven near-identical sibling
 * call sites (history.js, status.js, rewind.js, redrive.js, revalidate.js,
 * clean-claims.js x2) shipped zero escaping — undetected for two full
 * waves until an auditor's live CLI-subprocess repro found them by hand.
 * That is exactly the failure mode a mechanical, always-on gate exists to
 * catch instead of relying on the next auditor to find it again.
 *
 * Scans every commands/*.js file + cli.js for the bare identifiers this
 * package uses for operator-audit reason text (`reason`, `reasonRecorded`,
 * `lastReason` — the fields wave_state_events.reason / agent_state_events.
 * reason / domain_events.reason and the --reason CLI flag itself all funnel
 * through these names) and requires that any file touching one of them ALSO
 * references escapeReasonForDisplay somewhere in its source, unless
 * explicitly allowlisted below with a named, reviewable justification.
 *
 * SCOPE, STATED PLAINLY (mirrors amend1-wave9-filter-discipline.test.js's
 * own convention of naming a static scanner's boundary rather than
 * overclaiming it): this is a FILE-level co-occurrence check, not a
 * per-line or per-function one. It reliably catches the wave-18 regression
 * SHAPE — an entire file/call-site landing with zero escaping calls
 * anywhere in it, the actual historical defect — but would NOT catch a new
 * unescaped line added to a file that already legitimately calls
 * escapeReasonForDisplay elsewhere for a DIFFERENT site. The companion
 * wave18-4091637-5127-swarm-cp-pins.test.js file has call-site-precise
 * CLI-subprocess proofs for the sites that exist today; this gate is the
 * class-level trip-wire for tomorrow's new site landing with NO escaping
 * call anywhere in its file — the exact shape of gap that let wave 18's
 * seven siblings through undetected. A future maintainer who wants
 * per-call-site precision should extend this file, not silently trust the
 * coarser check; the allowlist below is INTENTIONALLY narrow and forces a
 * documented decision on every file the sweep flags, which is the same
 * "forces a thinking step" discipline amend1-wave9-filter-discipline.test.js
 * established for its own domain.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;

const REASON_IDENTIFIER = /\b(reason|reasonRecorded|lastReason)\b/;
const ESCAPE_CALL = 'escapeReasonForDisplay(';

// Files that legitimately reference a `reason`-shaped identifier WITHOUT it
// being operator-audit text from wave_state_events / agent_state_events /
// domain_events / the --reason CLI flag rendered to a text surface. Each
// entry MUST have a `reason` so a future maintainer can audit. Keep this
// list minimal — a file that SHOULD escape but doesn't belongs in the fix,
// not here.
const ALLOWLIST = [
  {
    file: 'commands/resume.js',
    reason: '`swarm resume` has no --reason flag. report.reason is a computed action-classifier string (e.g. "Some agents not complete — run `swarm resume`") built entirely from counts/statuses this function already knows — never operator free text.',
  },
  // F-7ef099e3 (wave 22): the commands/verify.js entry that used to sit here
  // is REMOVED, not reworded. Its text was the factually inverted safety
  // argument wave 19/20's own F-5d330a4f / F-4773fb77 findings corrected:
  // probe.reason is NOT "verifier-computed diagnostic text" in the safe
  // sense that entry implied — it embeds the AUDITED TARGET REPO's own
  // manifest `name` field verbatim (node.js/rust.js's probe()), reachable at
  // zero operator privilege, which is exactly WHY verify.js now calls
  // escapeReasonForDisplay on result.probe.reason (verify.js:254) and
  // p.reason (verify.js:286). The entry was already inert before this
  // removal — verify.js independently satisfies this gate's own
  // `stripped.includes(ESCAPE_CALL)` check via those two real calls, so the
  // allowlist text was never actually consulted by the running check — but a
  // dead entry with an inverted safety argument is a foot-gun for the next
  // maintainer who searches this array for prior art, not documentation.
  // Leaving wrong text in place is strictly worse than no entry at all.
  {
    file: 'commands/persist.js',
    reason: 'r.dogfood.reason is the dogfood-ingest HTTP/API rejection reason (system-computed), not an operator --reason value.',
  },
  {
    file: 'commands/collect.js',
    reason: 'check.reason (canTransition()\'s validity-check text) is system-computed state-machine diagnostic text fed to logStage (a structured JSON event), never rendered to a text/console surface. collect.js also threads a `reason` PARAMETER through to transitionAgent/transitionWave at several call sites — plumbing, not rendering.',
  },
  {
    file: 'commands/adjudicate.js',
    reason: 'the one `reason` occurrence is literal usage-hint text inside a help string ("... --override --reason \\"...\\"") naming the CLI flag for the operator to type next, not an interpolated/rendered VALUE.',
  },
  {
    file: 'commands/dispatch.js',
    reason: 'every `reason` occurrence is literal usage-hint text inside help/error strings naming the --reason flag for `swarm redrive` / `swarm defer` / `swarm reject` (e.g. "... --reason \\"<text>\\" --apply`"), not an interpolated/rendered VALUE.',
  },
];

function relativeFromPkg(absPath) {
  return absPath.slice(PKG_ROOT.length + 1).replace(/\\/g, '/');
}

function walkSync(dir, files = []) {
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

function allowlistEntryFor(relPath) {
  return ALLOWLIST.find((e) => e.file === relPath) || null;
}

/** The set of commands/*.js + cli.js files this discipline gate scans. */
function scanTargets() {
  const all = walkSync(PKG_ROOT);
  return all.filter((p) => {
    const rel = relativeFromPkg(p);
    if (rel.endsWith('.test.js') || rel.endsWith('.test.mjs')) return false;
    if (rel === 'commands/lib/escape-reason.js') return false; // the helper itself
    return rel === 'cli.js' || rel.startsWith('commands/');
  });
}

describe('Reason-escaping discipline (mechanical guard against a new unescaped render site)', () => {
  it('every commands/*.js + cli.js file that references a reason-shaped identifier also calls escapeReasonForDisplay, unless allowlisted', () => {
    const offenders = [];
    for (const f of scanTargets()) {
      const rel = relativeFromPkg(f);
      const stripped = stripComments(readFileSync(f, 'utf-8'));
      if (!REASON_IDENTIFIER.test(stripped)) continue; // file never touches a reason-shaped field
      if (stripped.includes(ESCAPE_CALL)) continue;     // file DOES route through the helper somewhere

      if (allowlistEntryFor(rel)) continue;

      offenders.push(rel);
    }

    assert.deepEqual(offenders, [],
      `file(s) reference a reason-shaped identifier (reason / reasonRecorded / lastReason) but never call ` +
      `escapeReasonForDisplay anywhere in the file, and are not allowlisted:\n  ${offenders.join('\n  ')}\n\n` +
      `Either route the render site through commands/lib/escape-reason.js's escapeReasonForDisplay, ` +
      `or add a documented ALLOWLIST entry in this test explaining why the reference is not operator-audit text.`);
  });

  it('the allowlist stays honest: every entry resolves to a real file under the scanned tree and carries a real justification', () => {
    const scanned = new Set(scanTargets().map(relativeFromPkg));
    for (const entry of ALLOWLIST) {
      assert.ok(scanned.has(entry.file), `allowlist entry '${entry.file}' is not one of the files this gate scans (typo, or the file moved)`);
      assert.ok(entry.reason && entry.reason.length > 20, `allowlist entry '${entry.file}' needs a real justification`);
    }
  });

  // F-<self>: mutation-style proof that the sweep is not vacuously passing —
  // a file with the bare identifier and NO escape call must be caught. This
  // is the SAME "prove the gate can fail" discipline
  // amend1-wave9-filter-discipline.test.js's own mutation section applies,
  // scoped to this gate's own classification function rather than a
  // production file (which would require landing a real regression to test).
  it('mutation proof: a reason-touching, non-allowlisted, non-escaping file text is classified as an offender', () => {
    const stripped = stripComments('function f(reason) { console.log(`Reason: ${reason}`); }');
    assert.ok(REASON_IDENTIFIER.test(stripped), 'sanity: the probe text matches the identifier pattern');
    assert.ok(!stripped.includes(ESCAPE_CALL), 'sanity: the probe text has no escape call');
  });

  it('mutation proof: the SAME probe text is exempted once it calls escapeReasonForDisplay', () => {
    const stripped = stripComments(
      'function f(reason) { console.log(`Reason: ${escapeReasonForDisplay(reason)}`); }'
    );
    assert.ok(REASON_IDENTIFIER.test(stripped));
    assert.ok(stripped.includes(ESCAPE_CALL));
  });
});
