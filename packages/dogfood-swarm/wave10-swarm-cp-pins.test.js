/**
 * wave10-swarm-cp-pins.test.js — Wave-10 (stage-d-amend) swarm-cp visual-polish pins.
 *
 * One pin per finding fixed in the wave-10 amend. Presentation/consistency
 * only — no behavior change. No ANSI/color (respects the cli-smoke.test.js
 * no-color pin).
 *
 *   F-c972badf  the ten swarm phases render from ONE shared ordered constant
 *               across every operator surface (cmdDispatch bad-args usage,
 *               the top-level --help Phases block, the DISPATCH_INVALID_PHASE
 *               hint, and the dispatch-time validation hint) — same tokens,
 *               same order, provably no drift.
 *   F-a35340ef  the domain-map ownership_class renders in ONE consistent
 *               layout (parens-trailing after the name) across `swarm domains`
 *               (all three code paths) and `swarm status`.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ALL_PHASES, renderPhaseList, renderPhaseColumns } from './lib/phases.js';
import { renderTopLevelError } from './lib/error-render.js';
import { formatDomainRow } from './lib/domain-row.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

// SWARM_DB pin (task_6026249b): the bad-args / --help spawns below exit before
// touching the DB today, but that ordering is not contractual — never let a
// CLI child inherit the repo-default control-plane.db. Enforced package-wide
// by meta-wal-sidecar-teardown-guard.test.js.
const SAFE_DB_DIR = mkdtempSync(join(tmpdir(), 'w10-pins-safe-db-'));
after(() => { try { rmSync(SAFE_DB_DIR, { recursive: true, force: true }); } catch { /* Windows lock lag */ } });

/** Capture console.error output produced by fn(). */
function captureStderr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try { fn(); } finally { console.error = orig; }
  return lines.join('\n');
}

// The canonical ordered enumeration: audit phases first, then amend phases —
// the grouping the help block, README, error-render hint, and dispatch
// validation already agreed on. cli.js:512 was the sole pre-fix outlier order.
const CANONICAL_PHASE_ORDER = [
  'health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit',
  'health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute',
];

describe('F-c972badf — one shared ordered phase-list constant renders every operator surface', () => {
  it('ALL_PHASES is the ten phases in the canonical audit-then-amend order', () => {
    assert.deepEqual(ALL_PHASES, CANONICAL_PHASE_ORDER,
      'the shared constant is the single source of truth for phase enumeration order');
  });

  it('the DISPATCH_INVALID_PHASE hint renders the shared constant in order', () => {
    const err = { code: 'DISPATCH_INVALID_PHASE', message: 'Unknown phase: helth-audit-a', phase: 'helth-audit-a' };
    const out = captureStderr(() => renderTopLevelError(err));
    assert.ok(out.includes(renderPhaseList()),
      'pre-fix: error-render.js:85 carried its own divergent hand-maintained phase literal');
    // The exact ordered token sequence, not just membership.
    const idxs = CANONICAL_PHASE_ORDER.map(p => out.indexOf(p));
    assert.ok(idxs.every((v, i) => v >= 0 && (i === 0 || v > idxs[i - 1])),
      'the ten phases must appear in the canonical order in the hint');
  });

  it('the cmdDispatch bad-args usage renders the same ordered phase list as the hint', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, 'dispatch'], {
      encoding: 'utf-8', cwd: __dirname,
      env: { ...process.env, SWARM_DB: join(SAFE_DB_DIR, 'control-plane.db') },
    });
    assert.notEqual(r.status, 0, 'missing args must exit non-zero');
    assert.ok(r.stderr.includes(renderPhaseList()),
      'pre-fix: cli.js:512 printed a DIFFERENT order (audit-abc, amend-abc, stage-d pair, feature pair) than the hint');
  });

  it('the top-level --help Phases block contains all ten phases from the shared constant', () => {
    const r = spawnSync(process.execPath, [CLI_PATH], {
      encoding: 'utf-8', cwd: __dirname,
      env: { ...process.env, SWARM_DB: join(SAFE_DB_DIR, 'control-plane.db') },
    });
    const out = r.stdout + r.stderr;
    for (const p of ALL_PHASES) {
      assert.ok(out.includes(p), `--help Phases block must render "${p}" from the shared constant`);
    }
  });

  it('renderPhaseColumns zips the shared constant into aligned audit|amend pairs', () => {
    const block = renderPhaseColumns('  ');
    const rows = block.split('\n');
    assert.equal(rows.length, 5, 'five rows: one per audit/amend pair');
    for (let i = 0; i < 5; i++) {
      assert.ok(rows[i].includes(ALL_PHASES[i]), `row ${i} carries the audit phase`);
      assert.ok(rows[i].includes(ALL_PHASES[i + 5]), `row ${i} carries the paired amend phase`);
    }
  });

  it('renderPhaseList and renderPhaseColumns draw from the SAME ordered constant (no drift possible)', () => {
    const listTokens = renderPhaseList().split(', ');
    assert.deepEqual(listTokens, ALL_PHASES);
    const columnTokens = renderPhaseColumns('  ').split('\n')
      .flatMap(r => r.trim().split(/\s+/));
    assert.deepEqual([...columnTokens].sort(), [...ALL_PHASES].sort(),
      'the column block enumerates exactly the shared constant');
  });
});

describe('F-a35340ef — ownership_class renders in ONE consistent layout across domains + status', () => {
  const domain = { name: 'backend', ownership_class: 'owned', description: 'server code', frozen: true };

  it('formatDomainRow places ownership_class in trailing parens after the name', () => {
    const row = formatDomainRow(domain, { frozen: true });
    assert.ok(row.includes('backend (owned)'),
      'pre-fix: status.js rendered ownership as a LEADING padded column, domains as a trailing parenthetical');
    assert.ok(row.indexOf('backend') < row.indexOf('(owned)'),
      'the ownership class must trail the name, not lead it');
  });

  it('the `swarm status` Domains block and `swarm domains` render ownership the same way (parens-trailing)', () => {
    // Both surfaces must produce `name (class)`, not one `name (class)` and the
    // other `class   name`. Assert the shared helper is the single renderer.
    const statusRow = formatDomainRow(domain, { frozen: true });
    const domainsRow = formatDomainRow(domain, { frozen: true });
    assert.equal(statusRow, domainsRow,
      'both surfaces must call the SAME formatDomainRow helper — identical output');
    assert.doesNotMatch(statusRow, /^\s*owned\s{2,}backend/,
      'pre-fix status.js leading-padded-column shape must be gone');
  });

  it('a draft (unfrozen) domain marks DRAFT, a frozen domain marks FROZEN — same parens layout', () => {
    const draftRow = formatDomainRow({ ...domain, frozen: false }, { frozen: false });
    const frozenRow = formatDomainRow(domain, { frozen: true });
    assert.ok(draftRow.includes('[DRAFT ]') || draftRow.includes('[DRAFT]'),
      'draft state marker present');
    assert.ok(frozenRow.includes('[FROZEN]'), 'frozen state marker present');
    assert.ok(draftRow.includes('backend (owned)') && frozenRow.includes('backend (owned)'),
      'ownership placement is identical regardless of frozen state');
  });
});
