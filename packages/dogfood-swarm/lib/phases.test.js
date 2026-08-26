/**
 * phases.test.js — lib/phases.js had ZERO direct unit coverage anywhere in
 * this repo before this file (verified: grepped the whole package for an
 * import of `./phases.js` / `../lib/phases.js` from any *.test.js — zero
 * hits), despite its own header calling itself "the single ordered source
 * of truth for the ten swarm phases." Added alongside the F-ab4fbab0 docs
 * fix (this same file's own "DISCLOSED EXCEPTION" paragraph) as the closest
 * available regression pin for that fix — see the parity describe block
 * below for why a direct behavioral test of the disclosed risk itself
 * (two independently-typed phase-literal copies that CAN desync) is
 * possible here, unlike F-2f7dd0ce's pure-docstring sibling fix in
 * roadmap-drain.test.js, which had no equivalent live check available.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUDIT_PHASES, AMEND_PHASES, ALL_PHASES, RUN_STATUSES, isDispatchablePhase, renderPhaseList, renderPhaseColumns } from './phases.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(__dirname, '..', 'commands');

describe('phases.js — the canonical ten-phase enumeration', () => {
  it('AUDIT_PHASES and AMEND_PHASES are each exactly the five documented phases, in order', () => {
    assert.deepEqual(AUDIT_PHASES, [
      'health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit',
    ]);
    assert.deepEqual(AMEND_PHASES, [
      'health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute',
    ]);
  });

  it('ALL_PHASES is exactly the concatenation — audit phases first, then amend (the documented grouping, not advance.js\'s interleaved progression order)', () => {
    assert.deepEqual(ALL_PHASES, [...AUDIT_PHASES, ...AMEND_PHASES]);
    assert.equal(ALL_PHASES.length, 10);
  });

  it('no phase name is duplicated within or across AUDIT_PHASES/AMEND_PHASES', () => {
    assert.equal(new Set(ALL_PHASES).size, ALL_PHASES.length);
  });

  it('test/treatment/complete are run statuses, not dispatchable phases', () => {
    assert.deepEqual(RUN_STATUSES, ['test', 'treatment', 'complete']);
    for (const s of RUN_STATUSES) {
      assert.equal(isDispatchablePhase(s), false, `${s} must not be dispatchable`);
      assert.equal(ALL_PHASES.includes(s), false);
    }
    assert.equal(isDispatchablePhase('feature-audit'), true);
    assert.equal(isDispatchablePhase('feature-execute'), true);
  });

  it('renderPhaseList() is the comma-joined flat enumeration', () => {
    assert.equal(renderPhaseList(), ALL_PHASES.join(', '));
  });

  it('renderPhaseColumns() pairs the i-th audit phase with the i-th amend phase, left-padded to the longest audit phase', () => {
    const rendered = renderPhaseColumns('  ');
    const rows = rendered.split('\n');
    assert.equal(rows.length, AUDIT_PHASES.length);
    const colWidth = Math.max(...AUDIT_PHASES.map((p) => p.length));
    AUDIT_PHASES.forEach((audit, i) => {
      assert.equal(rows[i], `  ${audit.padEnd(colWidth)}   ${AMEND_PHASES[i]}`);
    });
  });
});

/**
 * F-274e7ac5 / F-ab4fbab0's own disclosed risk, made mechanical: this file's
 * header names commands/collect.js (and, as of the F-ab4fbab0 correction,
 * commands/revalidate.js) as independently-typed local copies of
 * AUDIT_PHASES/AMEND_PHASES that "match today... but CAN desync on a future
 * edit to either." Both files are out of this domain's globs
 * (packages/dogfood-swarm/commands/** belongs to swarm-cp-verbs) — this
 * suite cannot fix a future desync, but it CAN detect one: it reads each
 * file's raw source text (never imports it — neither file EXPORTS its local
 * literal) and cross-checks the extracted array content against this
 * module's own canonical, imported AUDIT_PHASES/AMEND_PHASES. A future edit
 * to either copy without a matching edit here fails this test, which is the
 * closest mechanical proxy available for "the disclosed exception's own
 * named risk actually fires."
 *
 * @pins F-ab4fbab0
 */
describe('DISCLOSED EXCEPTION parity (F-274e7ac5 / F-ab4fbab0) — local phase-literal copies in commands/** must still match lib/phases.js byte-for-byte', () => {
  function extractLocalPhaseArray(filePath, constName) {
    const source = readFileSync(filePath, 'utf-8');
    const re = new RegExp(`const ${constName} = \\[([^\\]]*)\\]`);
    const match = source.match(re);
    if (!match) return null; // absent entirely = no local copy — the fix this wave's coordination expects for revalidate.js
    return match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^['"]|['"]$/g, ''));
  }

  it('commands/collect.js: either it now imports AUDIT_PHASES/AMEND_PHASES from lib/phases.js (the wave-43 verbs fix landed — the F-274e7ac5 disclosed exception dissolved), or its local copy still matches byte-for-byte', () => {
    const collectPath = join(COMMANDS_DIR, 'collect.js');
    const localAudit = extractLocalPhaseArray(collectPath, 'AUDIT_PHASES');
    const localAmend = extractLocalPhaseArray(collectPath, 'AMEND_PHASES');
    if (localAudit === null && localAmend === null) {
      // The verbs lane's wave-43 fix went further than the disclosed-exception
      // compromise: collect.js consumes the shared enumeration outright, so
      // there is no local literal left to desync — strictly better than the
      // parity this gate was built to hold. It must still USE the enumeration.
      const source = readFileSync(collectPath, 'utf-8');
      assert.match(source, /AUDIT_PHASES/, 'collect.js must still USE AUDIT_PHASES somehow (imported) if it no longer declares it locally');
      return;
    }
    assert.deepEqual(localAudit, AUDIT_PHASES, 'collect.js\'s local AUDIT_PHASES has desynced from lib/phases.js\'s canonical array');
    assert.deepEqual(localAmend, AMEND_PHASES, 'collect.js\'s local AMEND_PHASES has desynced from lib/phases.js\'s canonical array');
  });

  it('commands/revalidate.js: either it now imports AUDIT_PHASES/AMEND_PHASES from lib/phases.js (F-ab4fbab0\'s coordinated fix landed), or its local copy still matches byte-for-byte', () => {
    const revalidatePath = join(COMMANDS_DIR, 'revalidate.js');
    const localAudit = extractLocalPhaseArray(revalidatePath, 'AUDIT_PHASES');
    const localAmend = extractLocalPhaseArray(revalidatePath, 'AMEND_PHASES');
    if (localAudit === null && localAmend === null) {
      // The coordinated fix landed: no local literal left to desync.
      const source = readFileSync(revalidatePath, 'utf-8');
      assert.match(source, /AUDIT_PHASES/, 'revalidate.js must still USE AUDIT_PHASES somehow (imported) if it no longer declares it locally');
      return;
    }
    assert.deepEqual(localAudit, AUDIT_PHASES, 'revalidate.js\'s local AUDIT_PHASES has desynced from lib/phases.js\'s canonical array');
    assert.deepEqual(localAmend, AMEND_PHASES, 'revalidate.js\'s local AMEND_PHASES has desynced from lib/phases.js\'s canonical array');
  });
});
