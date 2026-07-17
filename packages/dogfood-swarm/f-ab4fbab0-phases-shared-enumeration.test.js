/**
 * f-ab4fbab0-phases-shared-enumeration.test.js
 *
 * F-ab4fbab0 [MEDIUM] — lib/phases.js's own header discloses that it is the
 * "single ordered source of truth" for the ten swarm phases, but names ONE
 * known "DISCLOSED EXCEPTION" (F-274e7ac5): commands/collect.js carried its
 * own private `const AUDIT_PHASES = [...]` / `const AMEND_PHASES = [...]`
 * literal instead of importing this module — two independently-typed
 * copies that matched byte-for-byte today but COULD desync on a future edit
 * to either. This wave's own sweep (per swarms/PROTOCOL.md, "Fixing a
 * class, not an instance" — sub-law 2: "a detector's blind spot IS the
 * defect... enumerate the population independently and diff it against
 * what your detector sees") found a SECOND, undisclosed private copy in
 * commands/revalidate.js.
 *
 * This test is the mechanical, class-level gate: it enumerates every
 * commands/**\/*.js + cli.js source file (this domain's own owned globs —
 * swarm-cp-verbs) and asserts NONE contains a hand-typed literal matching
 * the phase-list shape. A future re-introduction of a private copy (in
 * EITHER of the two fixed files, or a brand-new third one) fails this test
 * with the offending file+line named, rather than waiting for a THIRD
 * confirming-audit cycle to rediscover it by hand.
 *
 * Mutation-catch note: re-adding either `const AUDIT_PHASES = [` or
 * `const AMEND_PHASES = [` anywhere under commands/ or at cli.js's own
 * top level is exactly the mutation this scan exists to catch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUDIT_PHASES, AMEND_PHASES } from './lib/phases.js';
import { stripComments } from './test-support/strip-comments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Walks commands/ recursively, yielding .js files (never node_modules). */
function* walkCommandsJs(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkCommandsJs(full);
    } else if (st.isFile() && entry.endsWith('.js')) {
      yield full;
    }
  }
}

/** @pins F-ab4fbab0 */
describe('F-ab4fbab0 — no private AUDIT_PHASES/AMEND_PHASES copy anywhere in swarm-cp-verbs\' domain', () => {
  it('lib/phases.js exports the two arrays with the expected 5-phase content (fixture sanity, not the sweep itself)', () => {
    assert.deepEqual(AUDIT_PHASES, [
      'health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit',
    ]);
    assert.deepEqual(AMEND_PHASES, [
      'health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute',
    ]);
  });

  it('commands/revalidate.js imports AUDIT_PHASES/AMEND_PHASES from lib/phases.js (the originally-cited fix)', () => {
    const src = readFileSync(join(__dirname, 'commands', 'revalidate.js'), 'utf-8');
    assert.match(src, /import\s*\{[^}]*AUDIT_PHASES[^}]*\}\s*from\s*['"]\.\.\/lib\/phases\.js['"]/,
      'commands/revalidate.js must import AUDIT_PHASES from ../lib/phases.js');
    assert.match(src, /import\s*\{[^}]*AMEND_PHASES[^}]*\}\s*from\s*['"]\.\.\/lib\/phases\.js['"]/,
      'commands/revalidate.js must import AMEND_PHASES from ../lib/phases.js');
  });

  it('commands/collect.js imports AUDIT_PHASES/AMEND_PHASES from lib/phases.js (F-274e7ac5\'s disclosed exception, now closed)', () => {
    const src = readFileSync(join(__dirname, 'commands', 'collect.js'), 'utf-8');
    assert.match(src, /import\s*\{[^}]*AUDIT_PHASES[^}]*\}\s*from\s*['"]\.\.\/lib\/phases\.js['"]/,
      'commands/collect.js must import AUDIT_PHASES from ../lib/phases.js');
    assert.match(src, /import\s*\{[^}]*AMEND_PHASES[^}]*\}\s*from\s*['"]\.\.\/lib\/phases\.js['"]/,
      'commands/collect.js must import AMEND_PHASES from ../lib/phases.js');
  });

  it('commands/dispatch.js still imports (not re-declares) AUDIT_PHASES/AMEND_PHASES — the ORIGINAL fixed site', () => {
    const src = readFileSync(join(__dirname, 'commands', 'dispatch.js'), 'utf-8');
    assert.match(src, /import\s*\{[^}]*AUDIT_PHASES[^}]*\}\s*from\s*['"]\.\.\/lib\/phases\.js['"]/);
  });

  it('sweep: no commands/**/*.js or cli.js file contains a private AUDIT_PHASES/AMEND_PHASES literal array declaration', () => {
    const files = [...walkCommandsJs(join(__dirname, 'commands')), join(__dirname, 'cli.js')];
    const offenders = [];
    const declRe = /\b(?:const|let|var)\s+(AUDIT_PHASES|AMEND_PHASES)\s*=\s*\[/g;

    for (const file of files) {
      const raw = readFileSync(file, 'utf-8');
      const stripped = stripComments(raw);
      let m;
      while ((m = declRe.exec(stripped))) {
        const line = stripped.slice(0, m.index).split('\n').length;
        offenders.push(`${file.replace(/\\/g, '/')}:${line}: private ${m[1]} declaration`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'every phase-list consumer in swarm-cp-verbs\' domain (commands/**, cli.js) must IMPORT ' +
      'AUDIT_PHASES/AMEND_PHASES from lib/phases.js, never hand-type its own copy (F-ab4fbab0):\n' +
      offenders.map((o) => `  ${o}`).join('\n')
    );
  });

  it('mutation-catch self-check: the sweep regex actually flags a re-introduced private copy', () => {
    const declRe = /\b(?:const|let|var)\s+(AUDIT_PHASES|AMEND_PHASES)\s*=\s*\[/g;
    const reintroduced = "const AUDIT_PHASES = ['health-audit-a'];\nconst AMEND_PHASES = ['health-amend-a'];\n";
    const matches = [...reintroduced.matchAll(declRe)];
    assert.equal(matches.length, 2, 'the sweep regex must match a re-introduced private declaration of either name');
  });
});
