/**
 * anchor CLI handlers — the operator-facing surface for the three anchor verbs,
 * wired into run.js: --anchor-compute, --anchor-post, --anchor-verify.
 *
 * Each handler returns `{ ok, exitCode, lines, event }` so run.js owns the actual
 * console + logStage + process.exit (matching how `--verify-chain` is dispatched
 * via verify-chain.js's verifyChain + formatChainResult). Handlers are
 * operator-legible: no raw stack traces, structured exit codes.
 *
 * Off by default: nothing in the normal ingest/CI path calls these. They are
 * operator-run only.
 *
 * Exit codes:
 *   0  success (compute wrote/idempotent; post landed; verify all-clear)
 *   1  a verification FAILURE (truncation detected, anchor mismatch) — fail loud
 *   2  an operator/precondition error (bad algo, no seed, xrpl missing, etc.)
 *
 * Only --anchor-post reaches the network, and it lazily loads xrpl there; compute
 * and verify never import xrpl.
 */

import { computeAnchor, recordAnchorPost } from './compute-root.js';
import { verifyAnchorState } from './verify-anchor.js';
import { postAnchor } from './post-anchor.js';
import { ANCHOR_DEFAULTS, resolveTrustedAccounts } from './config.js';

/**
 * --anchor-compute: compute the next anchor and write its append-only manifest.
 * Offline; never imports xrpl.
 *
 * @param {string} repoRoot
 * @param {object} [opts] - { mode, algo, network }
 * @returns {{ ok: boolean, exitCode: number, lines: string[], event: object }}
 */
export function handleAnchorCompute(repoRoot, opts = {}) {
  try {
    const result = computeAnchor(repoRoot, opts);
    if (result.empty) {
      return {
        ok: true,
        exitCode: 0,
        lines: [`anchor-compute: nothing to anchor — ${result.reason}`],
        event: { stage: 'anchor_compute_complete', empty: true, reason: result.reason },
      };
    }
    const m = result.manifest;
    const lines = [
      `anchor-compute: ${result.written ? 'wrote' : 'idempotent (already present)'} anchor seq ${m.anchor_seq}`,
      `  algo:       ${m.algo}`,
      `  leaf_count: ${m.leaf_count}`,
      `  seq_range:  [${m.seq_range[0]}, ${m.seq_range[1]}]`,
      `  root:       ${m.root}`,
      `  head:       ${m.head_digest}`,
      `  prev:       ${m.prev_anchor_root || '(genesis)'}`,
      `  manifest:   ${result.path}`,
    ];
    for (const w of result.warnings || []) lines.push(`  WARNING: ${w}`);
    return {
      ok: true,
      exitCode: 0,
      lines,
      event: {
        stage: 'anchor_compute_complete',
        anchor_seq: m.anchor_seq,
        leaf_count: m.leaf_count,
        root: m.root,
        written: result.written,
      },
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: 2,
      lines: [`anchor-compute failed: ${err.message}`],
      event: { stage: 'error', failed_stage: 'anchor_compute', code: err.code ?? null, message: err.message },
    };
  }
}

/**
 * --anchor-post: compute (if needed) + post the anchor to the XRP Ledger. Needs
 * the optional xrpl package and XRPL_SEED. Lazily loads xrpl; a missing xrpl or
 * missing seed exits 2 with an actionable message.
 *
 * @param {string} repoRoot
 * @param {object} [opts] - { mode, network, wsUrl, seed }
 * @returns {Promise<{ ok: boolean, exitCode: number, lines: string[], event: object }>}
 */
export async function handleAnchorPost(repoRoot, opts = {}) {
  const network = opts.network || ANCHOR_DEFAULTS.network;
  try {
    const receipt = await postAnchor(repoRoot, {
      ...opts,
      network,
      // Production: persist the on-chain facts back into the manifest file.
      deps: {
        recordPost: (seq, facts) => recordAnchorPost(repoRoot, seq, facts),
        ...(opts.deps || {}),
      },
    });
    if (!receipt.ok) {
      return {
        ok: false,
        exitCode: 1,
        lines: [
          `anchor-post: submission did NOT succeed (engine result: ${receipt.engine_result || 'unknown'}).`,
          '  The anchor did NOT land on-chain. Retry when the network is reachable.',
        ],
        event: { stage: 'error', failed_stage: 'anchor_post', engine_result: receipt.engine_result },
      };
    }
    return {
      ok: true,
      exitCode: 0,
      lines: [
        `anchor-post: anchored seq ${receipt.anchor_seq} on ${receipt.network}`,
        `  tx:           ${receipt.tx_hash}`,
        `  root:         ${receipt.root}`,
        `  leaf_count:   ${receipt.leaf_count}`,
        `  ledger_index: ${receipt.ledger_index ?? '(unavailable)'}`,
        `  close_time:   ${receipt.close_time_iso ? receipt.close_time_iso + ' (on-chain clock)' : '(unavailable)'}`,
      ],
      event: {
        stage: 'anchor_post_complete',
        anchor_seq: receipt.anchor_seq,
        tx_hash: receipt.tx_hash,
        ledger_index: receipt.ledger_index,
      },
    };
  } catch (err) {
    // XRPL_NOT_INSTALLED / XRPL_SEED_INVALID / ANCHOR_NOTHING_TO_POST etc.
    const hint = err.hint ? ` (${err.hint})` : '';
    return {
      ok: false,
      exitCode: 2,
      lines: [`anchor-post failed: ${err.message}${hint}`],
      event: { stage: 'error', failed_stage: 'anchor_post', code: err.code ?? null, message: err.message },
    };
  }
}

/**
 * --anchor-verify: run the truncation check (always, offline) and — when a
 * fetched tx is supplied — the on-chain anchor verification. OFFLINE-HONEST: with
 * no tx it reports "XRPL NOT verified" rather than passing the on-chain leg.
 *
 * @param {string} repoRoot
 * @param {object} [opts] - { tx, trustedAnchorAccounts, memoType }
 * @returns {{ ok: boolean, exitCode: number, lines: string[], event: object }}
 */
export function handleAnchorVerify(repoRoot, opts = {}) {
  const trustedAnchorAccounts = resolveTrustedAccounts(opts.trustedAnchorAccounts);
  const state = verifyAnchorState(repoRoot, {
    tx: opts.tx,
    trustedAnchorAccounts,
    memoType: opts.memoType || ANCHOR_DEFAULTS.memoType,
  });

  const t = state.truncation;
  const lines = [];
  lines.push(`anchor-verify: ${state.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`  anchors:            ${t.anchor_count}`);
  lines.push(`  chain entries:      ${t.chain_count} (head seq ${t.chain_head_seq ?? '(empty)'})`);
  lines.push(`  anchored through:   seq ${t.anchored_through_seq ?? '(none)'} (≥ ${t.anchored_count} entries)`);
  lines.push(`  truncation check:   ${t.ok ? 'OK' : 'FAILED'}`);
  if (!t.ok) {
    for (const f of t.failures) lines.push(`    - [${f.kind}] ${f.reason}`);
  }
  lines.push(`  XRPL on-chain:      ${state.xrpl_verified ? 'VERIFIED' : 'NOT verified'}`);
  lines.push(`  ${state.note}`);

  return {
    ok: state.ok,
    exitCode: state.ok ? 0 : 1,
    lines,
    event: {
      stage: state.ok ? 'anchor_verify_complete' : 'error',
      ...(state.ok ? {} : { failed_stage: 'anchor_verify' }),
      truncation_ok: t.ok,
      xrpl_verified: state.xrpl_verified,
      anchored_through_seq: t.anchored_through_seq,
      chain_head_seq: t.chain_head_seq,
    },
  };
}
