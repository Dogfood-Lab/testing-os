/**
 * verify-classifier-v2.js — Shared classification base for the verify-fixed
 * v2 verb family.
 *
 * **Class #14b — classifier vantage-point limit.** Wave 27 productized v1
 * (lib/verify-fixed.js) to address Class #14a — "human/agent claims `[fixed]`
 * without any verification." The v1 classifier checks a single anchor point:
 * the original finding's `file:line` bucket. Wave 29 surfaced v1's own blind
 * spot — a fix can land in a *consumer* file (cross-file) while the original
 * `file:line` bucket still legitimately contains the symbol because that
 * symbol is the *target* of the consumer's fix. v1 reports
 * `claimed-but-still-present`; the agent re-audit reports `verified`. The
 * disagreement is real, not noise — v1's vantage point is too narrow.
 *
 * **The methodology axiom: verification has fractal structure.** Each
 * verification layer becomes a claimed-fixed surface needing its own
 * verify-* discipline. v2 doesn't pretend to remove the fractal — it makes
 * the current layer's vantage point *visible* by tagging every classification
 * with `verified_via`, so downstream consumers (and future classifier layers)
 * can see exactly which evidence path produced the verdict.
 *
 * **Pattern #8 shared envelope.** All four v2 verbs (verify-fixed,
 * verify-recurring, verify-unverified, verify-approved) read findings from
 * the same DB, classify with the same logic, and emit the same envelope:
 *
 *   {
 *     schema, runId, waveNumber, checkedAt, verb,
 *     summary, threshold, thresholdExceeded, exitCode,
 *     findings: [{
 *       finding_id, fingerprint, classification,
 *       file, line, symbol, severity, category, description,
 *       evidence, originalFixedWave,
 *       verified_via,         // NEW in v2 — see below
 *       cross_ref?,           // NEW in v2 — optional consumer-side fix anchor
 *       verb_specifics?,      // NEW in v2 — verb-specific extras
 *     }]
 *   }
 *
 * **`verified_via` values (vantage-point disclosure):**
 *
 *   anchor             — primary file's anchor was searched and the verdict
 *                        falls out of the anchor result. v1 behavior.
 *   cross_ref          — primary anchor still present, but the finding's
 *                        `cross_ref` location showed the fix landed there.
 *                        Class #14b core path — operator sees the cross-file
 *                        reasoning explicitly.
 *   allowlist          — coordinator marked `coordinator_resolved: true`
 *                        with `verified_via_evidence`. Mechanical anchors
 *                        couldn't see it; the agent attested semantically.
 *                        Use sparingly — every allowlist entry is a hole in
 *                        mechanical verification.
 *   agent_attestation  — the finding's status came in as 'fixed' but the
 *                        agent provided structured attestation (e.g., a
 *                        proof receipt) we trust without re-running anchors.
 *                        Distinct from allowlist: agent_attestation is the
 *                        normal happy path for findings whose fix isn't
 *                        anchorable (architectural, doc-level, etc.).
 *   unverifiable       — neither anchor nor cross_ref produced a verdict
 *                        and no allowlist/attestation overrode it. Human
 *                        review needed. Not a synonym for "broken" — it
 *                        means "this layer cannot conclude."
 *
 * Migration path for the wave-29 11 incidental closures:
 *   - For findings where the fix landed in a consumer file (e.g.,
 *     packages/ingest/persist.js): record `cross_ref: { file, symbol, line }`
 *     on the finding. v2 will classify them `verified_via: 'cross_ref'`.
 *   - For findings whose fix is architectural / doc-level / cross-cutting
 *     and lacks a single anchor: set `coordinator_resolved: true` plus
 *     `verified_via_evidence` (a one-line note from the coordinator's
 *     review). v2 will classify them `verified_via: 'allowlist'`.
 *   - This module does NOT mutate finding records — that's a coordinator
 *     cleanup task post-collect. v2 reads whatever the records say.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

/**
 * Tolerance window (lines) around the recorded line where finding the
 * anchor still counts as "exact match". Mirrors v1.
 */
const EXACT_LINE_TOLERANCE = 2;

/**
 * Width of the line-bucket window (lines). Mirrors v1.
 */
const FINGERPRINT_BUCKET = 10;

/**
 * Full enum of `verified_via` values. Importable for test/assertion use.
 */
export const VERIFIED_VIA = Object.freeze({
  ANCHOR: 'anchor',
  CROSS_REF: 'cross_ref',
  ALLOWLIST: 'allowlist',
  AGENT_ATTESTATION: 'agent_attestation',
  UNVERIFIABLE: 'unverifiable',
});

const VERIFIED_VIA_VALUES = new Set(Object.values(VERIFIED_VIA));

/**
 * Resolve a finding's file_path against the run's checkout root.
 */
function resolveFilePath(repoRoot, filePath) {
  if (!filePath) return null;
  return isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
}

/**
 * Build a regex that matches the anchor we expect to find at a given symbol
 * or in a description. Preference: explicit symbol, then first identifier
 * token of length ≥4 in description.
 */
function buildAnchorRegex({ symbol, description }) {
  const sym = (symbol || '').trim();
  if (sym && /^[A-Za-z_][\w$]*$/.test(sym)) {
    return new RegExp(`\\b${escapeRegex(sym)}\\b`);
  }
  const desc = String(description || '');
  const match = desc.match(/\b([A-Za-z_][\w$]{3,})\b/);
  if (match) {
    return new RegExp(`\\b${escapeRegex(match[1])}\\b`);
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Default file reader. Tests inject a fake reader via opts.readLines.
 */
function defaultReadLines(absolutePath) {
  if (!absolutePath || !existsSync(absolutePath)) return null;
  try {
    return readFileSync(absolutePath, 'utf-8').split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * Compute the bucket [start, end] inclusive that contains `recordedLine`.
 * If no line was recorded (0 / null), scan the entire file.
 */
function bucketForLine(recordedLine, totalLines) {
  if (!recordedLine || recordedLine <= 0) {
    return { start: 1, end: totalLines };
  }
  const bucket = Math.floor(recordedLine / FINGERPRINT_BUCKET) * FINGERPRINT_BUCKET;
  return { start: Math.max(1, bucket), end: bucket + FINGERPRINT_BUCKET };
}

/**
 * Search for `anchor` in `lines` between bucket bounds (1-indexed). Return
 * the matched line number or null.
 */
function findAnchorInBucket(lines, anchor, bucketStart, bucketEnd) {
  const end = Math.min(bucketEnd, lines.length);
  for (let lineNo = bucketStart; lineNo <= end; lineNo++) {
    const text = lines[lineNo - 1];
    if (typeof text === 'string' && anchor.test(text)) {
      return lineNo;
    }
  }
  return null;
}

/**
 * Run the anchor-only classification path (v1 logic, encapsulated). Returns
 * { classification, evidence, matchedLine? } — never sets verified_via; the
 * outer classifier owns that field.
 */
function classifyByAnchor(finding, repoRoot, readLinesFn) {
  if (!finding.file_path) {
    return {
      classification: 'unverifiable',
      evidence: 'finding has no file_path; cannot re-audit without a target file',
      reason: 'no_file_path',
    };
  }
  const absPath = resolveFilePath(repoRoot, finding.file_path);
  const lines = readLinesFn(absPath);
  if (lines === null) {
    return {
      classification: 'unverifiable',
      evidence: `file not present at ${finding.file_path} (deleted, moved, or unreadable)`,
      reason: 'file_missing',
    };
  }
  const anchor = buildAnchorRegex({ symbol: finding.symbol, description: finding.description });
  if (!anchor) {
    return {
      classification: 'unverifiable',
      evidence: 'finding has no symbol and no identifier-like token in its description; nothing to anchor on',
      reason: 'no_anchor',
    };
  }
  const recordedLine = Number(finding.line_number) || 0;
  const { start, end } = bucketForLine(recordedLine, lines.length);
  const matchedLine = findAnchorInBucket(lines, anchor, start, end);

  if (matchedLine === null) {
    return {
      classification: 'verified',
      evidence: `anchor /${anchor.source}/ no longer present at ${finding.file_path}:${start}-${end}`,
      matchedLine: null,
    };
  }
  if (recordedLine > 0 && Math.abs(matchedLine - recordedLine) <= EXACT_LINE_TOLERANCE) {
    return {
      classification: 'claimed-but-still-present',
      evidence: `anchor /${anchor.source}/ still at ${finding.file_path}:${matchedLine} (recorded line ${recordedLine}); fix never landed`,
      matchedLine,
    };
  }
  return {
    classification: 'regressed',
    evidence: `anchor /${anchor.source}/ reappeared at ${finding.file_path}:${matchedLine} (recorded line ${recordedLine || 'unspecified'}); looks reverted within the same bucket`,
    matchedLine,
  };
}

/**
 * Run the cross_ref classification path. Looks up the consumer-side anchor
 * and decides whether the fix landed there.
 *
 * The cross_ref shape:
 *   { file: 'packages/ingest/persist.js', symbol: 'validateRecord', line: 131 }
 *
 * Logic:
 *   - If the cross_ref file or anchor is unreadable/unresolvable →
 *     unverifiable with cross_ref reason.
 *   - If the cross_ref anchor is *present* in its bucket → the fix has
 *     landed at the consumer site, so we treat the original finding as
 *     `verified` (the consumer guards against the upstream issue).
 *   - If the cross_ref anchor is *absent* → fall through to the primary
 *     anchor's verdict.
 */
function classifyByCrossRef(crossRef, repoRoot, readLinesFn) {
  if (!crossRef || !crossRef.file) {
    return { applicable: false, reason: 'no_cross_ref' };
  }
  const absPath = resolveFilePath(repoRoot, crossRef.file);
  const lines = readLinesFn(absPath);
  if (lines === null) {
    return {
      applicable: true,
      classification: 'unverifiable',
      evidence: `cross_ref file not present at ${crossRef.file} (deleted, moved, or unreadable)`,
    };
  }
  const anchor = buildAnchorRegex({
    symbol: crossRef.symbol,
    description: crossRef.description,
  });
  if (!anchor) {
    return {
      applicable: true,
      classification: 'unverifiable',
      evidence: `cross_ref at ${crossRef.file} has no symbol or identifier-like description token`,
    };
  }
  const recordedLine = Number(crossRef.line) || 0;
  const { start, end } = bucketForLine(recordedLine, lines.length);
  const matchedLine = findAnchorInBucket(lines, anchor, start, end);

  if (matchedLine !== null) {
    return {
      applicable: true,
      classification: 'verified',
      evidence: `cross_ref anchor /${anchor.source}/ landed at ${crossRef.file}:${matchedLine}; consumer-side fix verified`,
      matchedLine,
    };
  }
  return {
    applicable: true,
    classification: 'verified-no-cross-ref-anchor',
    evidence: `cross_ref anchor /${anchor.source}/ not present at ${crossRef.file}:${start}-${end}; falling through to primary anchor`,
  };
}

/**
 * Validate that a `verified_via` value is in the canonical enum. Throwing
 * here makes a typo at a call site fail loudly instead of leaking a
 * misclassification through to the operator's report.
 */
function assertVerifiedVia(via) {
  if (!VERIFIED_VIA_VALUES.has(via)) {
    throw new Error(
      `verify-classifier-v2: verified_via='${via}' is not in the canonical enum ` +
      `(${[...VERIFIED_VIA_VALUES].join(', ')})`
    );
  }
  return via;
}

/**
 * Classify a single finding under the v2 verb family.
 *
 * @param {object} finding — DB row + optional cross_ref / coordinator_resolved
 *   fields the coordinator may have attached. The classifier never mutates.
 * @param {string} repoRoot — absolute path of the repo working tree
 * @param {object} [opts]
 * @param {(absPath: string) => string[] | null} [opts.readLines] — file
 *   reader injection (test seam)
 *
 * @returns {{
 *   classification: 'verified' | 'regressed' | 'claimed-but-still-present' | 'unverifiable',
 *   evidence: string,
 *   verified_via: 'anchor' | 'cross_ref' | 'allowlist' | 'agent_attestation' | 'unverifiable',
 *   cross_ref?: object,
 * }}
 *
 * Decision order (highest priority first):
 *   1. coordinator_resolved=true → allowlist (operator-attested override)
 *   2. agent_attestation present → agent_attestation
 *   3. anchor path → if verified, accept and stop. If
 *      claimed-but-still-present, try cross_ref before settling.
 *   4. cross_ref path → if it produces `verified`, override the anchor's
 *      claimed-but-still-present verdict (Class #14b core).
 *   5. otherwise → fall back to the anchor verdict.
 */
export function classifyFindingV2(finding, repoRoot, opts = {}) {
  const readLinesFn = opts.readLines || defaultReadLines;

  // 1. Coordinator-resolved allowlist — fast path, no mechanical reasoning.
  if (finding.coordinator_resolved === true) {
    const evidence = finding.verified_via_evidence
      ? `coordinator-resolved: ${finding.verified_via_evidence}`
      : 'coordinator-resolved (no evidence string supplied)';
    return {
      classification: 'verified',
      evidence,
      verified_via: assertVerifiedVia(VERIFIED_VIA.ALLOWLIST),
    };
  }

  // 2. Agent attestation path — distinct from allowlist; documents that the
  // agent provided structured proof rather than a coordinator override.
  if (finding.agent_attestation && typeof finding.agent_attestation === 'object') {
    const att = finding.agent_attestation;
    const evidence = att.summary
      ? `agent attestation: ${att.summary}`
      : 'agent attestation (no summary supplied)';
    return {
      classification: 'verified',
      evidence,
      verified_via: assertVerifiedVia(VERIFIED_VIA.AGENT_ATTESTATION),
    };
  }

  // 3. Primary anchor path.
  const anchorResult = classifyByAnchor(finding, repoRoot, readLinesFn);

  // 3a. Anchor said `verified` outright — accept and tag.
  if (anchorResult.classification === 'verified') {
    const out = {
      classification: 'verified',
      evidence: anchorResult.evidence,
      verified_via: assertVerifiedVia(VERIFIED_VIA.ANCHOR),
    };
    if (finding.cross_ref) out.cross_ref = finding.cross_ref;
    return out;
  }

  // 3b. Anchor was unverifiable. Try cross_ref before giving up.
  if (anchorResult.classification === 'unverifiable') {
    const crossResult = classifyByCrossRef(finding.cross_ref, repoRoot, readLinesFn);
    if (crossResult.applicable && crossResult.classification === 'verified') {
      return {
        classification: 'verified',
        evidence: crossResult.evidence,
        verified_via: assertVerifiedVia(VERIFIED_VIA.CROSS_REF),
        cross_ref: finding.cross_ref,
      };
    }
    // Cross-ref was unverifiable too (or absent). Surface the cross_ref
    // reason if it's more informative than the anchor reason; otherwise
    // keep the original anchor reason.
    const evidence = crossResult.applicable
      ? `${anchorResult.evidence}; ${crossResult.evidence}`
      : anchorResult.evidence;
    const out = {
      classification: 'unverifiable',
      evidence,
      verified_via: assertVerifiedVia(VERIFIED_VIA.UNVERIFIABLE),
    };
    if (finding.cross_ref) out.cross_ref = finding.cross_ref;
    return out;
  }

  // 3c. Anchor said `claimed-but-still-present` or `regressed`. Cross_ref
  // may legitimately override `claimed-but-still-present` (Class #14b
  // core: the symbol is still there because it's the *target* of the
  // consumer-side fix). For `regressed`, we keep the anchor verdict
  // because the symbol moved within the bucket — that's a real signal,
  // not a vantage-point limit.
  if (anchorResult.classification === 'claimed-but-still-present' && finding.cross_ref) {
    const crossResult = classifyByCrossRef(finding.cross_ref, repoRoot, readLinesFn);
    if (crossResult.applicable && crossResult.classification === 'verified') {
      return {
        classification: 'verified',
        evidence: `${crossResult.evidence} (overrides primary anchor still at ${finding.file_path}:${anchorResult.matchedLine})`,
        verified_via: assertVerifiedVia(VERIFIED_VIA.CROSS_REF),
        cross_ref: finding.cross_ref,
      };
    }
  }

  // Default: anchor verdict stands, tagged anchor.
  const out = {
    classification: anchorResult.classification,
    evidence: anchorResult.evidence,
    verified_via: assertVerifiedVia(VERIFIED_VIA.ANCHOR),
  };
  if (finding.cross_ref) out.cross_ref = finding.cross_ref;
  return out;
}

/**
 * Build a renderer-agnostic delta envelope for any of the v2 verbs.
 *
 * Pattern #8 contract: the envelope shape is identical across verbs; the
 * only verb-specific bit is the `verb` field, the schema string, and any
 * verb-specific extras attached to individual finding entries via
 * `verb_specifics`.
 *
 * @param {object} args
 * @param {string} args.verb — short verb name (e.g. 'verify-fixed',
 *   'verify-recurring')
 * @param {string} args.schema — schema string for the envelope
 * @param {string} args.runId
 * @param {number|null} args.waveNumber
 * @param {Array<object>} args.findings — DB-loaded findings to classify
 * @param {string} args.repoRoot
 * @param {number} [args.threshold=0]
 * @param {function} [args.now]
 * @param {(absPath: string) => string[]|null} [args.readLines]
 * @param {(finding: object, classified: object) => object} [args.entryDecorator]
 *   — optional hook to attach `verb_specifics` to each finding entry
 */
export function buildV2Delta({
  verb,
  schema,
  runId,
  waveNumber,
  findings: rawFindings,
  repoRoot,
  threshold = 0,
  now = () => new Date().toISOString(),
  readLines,
  entryDecorator,
}) {
  const findings = [];
  const summary = {
    total: rawFindings.length,
    verified: 0,
    regressed: 0,
    claimedButStillPresent: 0,
    unverifiable: 0,
  };
  const verifiedViaDistribution = {
    anchor: 0,
    cross_ref: 0,
    allowlist: 0,
    agent_attestation: 0,
    unverifiable: 0,
  };

  for (const f of rawFindings) {
    const classified = classifyFindingV2(f, repoRoot, { readLines });
    const entry = {
      finding_id: f.finding_id,
      fingerprint: f.fingerprint,
      classification: classified.classification,
      file: f.file_path || null,
      line: f.line_number ?? null,
      symbol: f.symbol || null,
      severity: f.severity,
      category: f.category,
      description: f.description,
      recommendation: f.recommendation || null,
      evidence: classified.evidence,
      originalFixedWave: f.fixed_wave_id ?? f.last_seen_wave ?? null,
      verified_via: classified.verified_via,
    };
    if (classified.cross_ref) entry.cross_ref = classified.cross_ref;
    if (entryDecorator) {
      const extras = entryDecorator(f, classified);
      if (extras) entry.verb_specifics = extras;
    }
    findings.push(entry);

    if (classified.classification === 'verified') summary.verified += 1;
    else if (classified.classification === 'regressed') summary.regressed += 1;
    else if (classified.classification === 'claimed-but-still-present') summary.claimedButStillPresent += 1;
    else if (classified.classification === 'unverifiable') summary.unverifiable += 1;

    if (verifiedViaDistribution[classified.verified_via] !== undefined) {
      verifiedViaDistribution[classified.verified_via] += 1;
    }
  }

  const offending = summary.regressed + summary.claimedButStillPresent;
  const thresholdExceeded = offending > threshold;

  // Exit-code 3-way (mirrors v1 + wave-18 findings-digest disambiguation):
  //   0 — empty input OR clean within threshold
  //   1 — threshold exceeded (offending > threshold)
  //   2 — pipeline broken: every finding classified `unverifiable` while
  //       the input was non-empty.
  let exitCode;
  if (summary.total === 0) {
    exitCode = 0;
  } else if (summary.unverifiable === summary.total) {
    exitCode = 2;
  } else if (thresholdExceeded) {
    exitCode = 1;
  } else {
    exitCode = 0;
  }

  return {
    schema,
    runId,
    waveNumber,
    checkedAt: now(),
    verb,
    summary: {
      ...summary,
      verified_via_distribution: verifiedViaDistribution,
    },
    threshold,
    thresholdExceeded,
    exitCode,
    findings,
  };
}
