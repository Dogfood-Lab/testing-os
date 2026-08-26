/**
 * READY FOR swarm-cp-tests — copy to packages/dogfood-swarm/f-03526468-agents-table-pipe-escape.test.js
 *
 * f-03526468-agents-table-pipe-escape.test.js — F-03526468 (MEDIUM):
 * formatReceiptMarkdown's Agents markdown table interpolated Error and
 * Fixes skipped cells raw after escapeReasonForDisplay, which leaves
 * literal `|` untouched. A payload like `boom | forged | cell` forged
 * extra columns (9 `|` vs the header's 7). Cell-boundary
 * escapeMarkdownTableCell closes both sites without widening
 * escapeReasonForDisplay for plain-text status/history lines.
 *
 * Verbs cannot land this file: packages/dogfood-swarm/*.test.js is
 * swarm-cp-tests (bridge). Source pin lives in commands/receipt.js +
 * commands/lib/escape-reason.js (F-03526468 comments).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatReceiptMarkdown } from './commands/receipt.js';

function baseReceipt(agents) {
  return {
    run: { id: 'r1', repo: 'org/repo', commit_sha: 'a'.repeat(40), branch: 'main' },
    wave: {
      id: 1,
      number: 11,
      phase: 'health-amend-a',
      status: 'complete',
      domain_snapshot_id: 'x',
      serial_verify_required: true,
      ownership_probe_degraded: false,
    },
    generated_at: '2026-08-26T00:00:00Z',
    agents,
    state_transitions: [],
    ownership_violations: [],
    findings: {
      total: 0,
      by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      this_wave: { new: 0, recurring: 0, fixed: 0 },
      by_status: {},
    },
    verification: null,
    recommendation: { action: 'WAIT', reason: null },
    fixes_skipped: null,
  };
}

function agentsTableLines(md) {
  const lines = md.split('\n');
  const start = lines.indexOf('## Agents');
  assert.ok(start >= 0, 'expected ## Agents section');
  const table = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    if (line.startsWith('|')) table.push(line);
  }
  assert.ok(table.length >= 3, `expected header, separator, and at least one agent row — got:\n${md}`);
  return table;
}

/** Column-delimiter `|` only — a `\|` escape is not a delimiter. */
function delimiterPipeCount(line) {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) count++;
  }
  return count;
}

/** @pins F-03526468 */
describe('F-03526468 — Agents table Error / Fixes skipped cells are pipe-safe', () => {
  it('an Error containing `|` keeps the agent row pipe count equal to the header', () => {
    const receipt = baseReceipt([
      {
        domain: 'backend',
        ownership_class: 'owned',
        status: 'failed',
        verification_skipped: true,
        fixes_skipped: [],
        error: 'boom | forged | cell',
      },
    ]);
    const md = formatReceiptMarkdown(receipt);
    const [header, , agentRow] = agentsTableLines(md);
    assert.equal(
      delimiterPipeCount(agentRow),
      delimiterPipeCount(header),
      `Error 'boom | forged | cell' must not forge columns — header=${header}\nrow=${agentRow}`,
    );
    assert.match(agentRow, /boom \\\| forged \\\| cell/, `literal | must render escaped — got:\n${agentRow}`);
    assert.doesNotMatch(agentRow, /\| boom \| forged \| cell \|/, 'unescaped pipe-split Error must not appear');
  });

  it('a Fixes skipped reason containing `|` keeps the agent row pipe count equal to the header', () => {
    const receipt = baseReceipt([
      {
        domain: 'backend',
        ownership_class: 'owned',
        status: 'complete',
        verification_skipped: true,
        fixes_skipped: [{ finding_id: 'F-pipe|id', reason: 'needs | review' }],
        error: null,
      },
    ]);
    const md = formatReceiptMarkdown(receipt);
    const [header, , agentRow] = agentsTableLines(md);
    assert.equal(
      delimiterPipeCount(agentRow),
      delimiterPipeCount(header),
      `Fixes skipped with | must not forge columns — header=${header}\nrow=${agentRow}`,
    );
    assert.match(
      agentRow,
      /F-pipe\\\|id\(needs \\\| review\)/,
      `Fixes skipped | must render escaped — got:\n${agentRow}`,
    );
  });
});
