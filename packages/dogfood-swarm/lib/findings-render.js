/**
 * findings-render.js — TTY-aware multi-format renderer for findings digests.
 *
 * F-827321-002 (wave-23, D-BACK-002): `swarm findings <run>` printed raw
 * markdown (`**bold**`, `| pipe | tables |`, `## Header`) directly to stdout.
 * An operator running it interactively saw the asterisks and pipe characters
 * literally — markdown soup competing with the data. CI scrapers parsed it
 * fine; humans did not.
 *
 * This module extends the wave-17 `shouldEmitHuman()` discipline from
 * `lib/log-stage.js` to the findings digest:
 *   - default `text` when `process.stdout.isTTY` (interactive terminal)
 *   - default `markdown` when piped/redirected (`!isTTY`) — back-compat
 *   - explicit `--format=text|markdown|json` overrides auto-detect
 *   - `DOGFOOD_FINDINGS_FORMAT=raw|human|json` env var overrides everything
 *     (symmetric to `DOGFOOD_LOG_HUMAN`; `raw` = markdown, `human` = text)
 *
 * The wrapper-strip principle (wave-22): fix at the choke-point so the
 * bug-class is impossible to recur. Any future command that wants to emit a
 * findings digest must route through `renderDigest()` — there is no other
 * path. `renderMarkdown()` is preserved so CI scrapers and `>` redirects keep
 * working unchanged.
 *
 * F-c3d8fd7e (wave 22): the shared `truncate()` helper below only did
 * `.replace(/\s+/g, ' ').trim()` — which incidentally neutralizes a raw
 * embedded newline (fake-line-injection) but leaves ESC (0x1B, the ANSI
 * cursor-erase primitive), the C1 control range, and the Trojan Source class
 * (bidi override/isolate controls, zero-width block, combining marks)
 * completely untouched, because none of those are `\s`. A finding's
 * `description`/`recommendation`/summary text is written by an AUDIT AGENT
 * auditing an arbitrary (sometimes adversarial) target repo and can echo
 * attacker-chosen substrings from it (a crafted filename, commit message, or
 * quoted string) — the same class of hazard commands/lib/escape-reason.js
 * was built across waves 16-20 to close for the `--reason` CLI-flag family.
 * Routed through that ONE canonical escaper (`escapeReasonForDisplay`)
 * rather than forking a second copy of the same codepoint-class regex —
 * mirrors commands/history.js's own "escape BEFORE truncate" ordering (see
 * that file's formatHistory): escaping first means the length budget `n` is
 * spent on the operator-VISIBLE (escaped) text, and truncation can never cut
 * a dangerous sequence at a point that leaves it half-neutralized.
 *
 * LAYERING NOTE, DISCLOSED: this import inverts the package's usual
 * commands/ → lib/ direction (no other lib/ file imports from commands/
 * today). Deliberate, one-file exception for this wave: escape-reason.js is
 * being actively redesigned in place by a different domain this same wave,
 * so importing its stable export beats copy-paste-forking the control-byte/
 * bidi class into a second implementation mid-redesign. escape-reason.js's
 * own placement note already anticipates a future `git mv` into package-level
 * lib/ once ownership consolidates — this import is the second cited
 * consumer that note names as the trigger for that move.
 */

import { escapeReasonForDisplay } from '../commands/lib/escape-reason.js';

const SEV_SHORT = { CRITICAL: 'CRIT', HIGH: 'HIGH', MEDIUM: 'MED', LOW: 'LOW' };

/**
 * Decide the default render format for the findings digest.
 * Order:
 *   1. DOGFOOD_FINDINGS_FORMAT env (raw|human|json) — mapped to markdown|text|json
 *   2. explicit `format` argument (text|markdown|json)
 *   3. process.stdout.isTTY === true → 'text'
 *   4. otherwise → 'markdown' (back-compat for pipes/redirects/CI)
 *
 * Exported for test injection so the decision matrix can be verified
 * without spinning up child processes.
 */
export function shouldEmitFormat(explicit, stream = process.stdout) {
  const env = process.env.DOGFOOD_FINDINGS_FORMAT;
  if (env === 'raw') return 'markdown';
  if (env === 'human') return 'text';
  if (env === 'json') return 'json';
  if (explicit === 'text' || explicit === 'markdown' || explicit === 'json') {
    return explicit;
  }
  return stream && stream.isTTY === true ? 'text' : 'markdown';
}

/**
 * Render a structured digest (built by lib/findings-digest.js renderWithStatus
 * via `buildDigestModel`) to the requested format.
 *
 * The structured `model` shape is intentionally renderer-agnostic so
 * markdown/text/json all consume the same source of truth.
 */
export function renderDigest(model, format, stream) {
  const fmt = shouldEmitFormat(format, stream);
  if (fmt === 'json') return renderJson(model);
  if (fmt === 'text') return renderText(model);
  return renderMarkdown(model);
}

// ── markdown renderer (back-compat with pre-wave-23 buildDigest output) ──
//
// Preserved verbatim from the pre-wave-23 lib/findings-digest.js shape so
// CI scrapers and operators piping `swarm findings <run> > digest.md` keep
// working. Any change here is a contract break — guard it with the
// markdown-regression test in wave23-findings-format.test.js.

export function renderMarkdown(model) {
  const lines = [];
  lines.push(`# Findings Digest — ${model.runId} wave ${model.waveNumber}`);
  lines.push('');

  if (model.status === 'clean') {
    lines.push(`✅ **All clear** — ${model.noFindingSummaries.length} agents reported, 0 findings`);
  } else if (model.status === 'pipeline_broken') {
    if (model.totalDomains === 0) {
      lines.push(`🛑 **Audit pipeline failure:** no domain outputs were loaded for this wave. See \`swarm status ${model.runId}\` for diagnostics. THIS IS NOT A CLEAN WAVE.`);
    } else {
      lines.push(`🛑 **Audit pipeline failure:** ${model.failedDomains} of ${model.totalDomains} domains failed to report (${model.reportedDomains} parsed). See \`swarm status ${model.runId}\` for diagnostics. THIS IS NOT A CLEAN WAVE.`);
    }
  } else {
    const sevSummary = [
      `${model.counts.CRITICAL} CRIT`,
      `${model.counts.HIGH} HIGH`,
      `${model.counts.MEDIUM} MED`,
      `${model.counts.LOW} LOW`,
    ].join(', ');
    lines.push(`⚠️ **${model.findings.length} findings:** ${sevSummary} — see \`swarm findings ${model.runId}\` details below`);
  }
  lines.push('');

  const totalParts = [
    `CRIT ${model.counts.CRITICAL}`,
    `HIGH ${model.counts.HIGH}`,
    `MED ${model.counts.MEDIUM}`,
    `LOW ${model.counts.LOW}`,
  ];
  if (model.unknownCount > 0) totalParts.push(`Unknown ${model.unknownCount}`);

  lines.push(`**Total:** ${model.findings.length} | ${totalParts.join(' | ')}`);
  lines.push('');

  lines.push('| Sev | ID | Domain | File:Line | Description |');
  lines.push('|-----|-----|--------|-----------|-------------|');
  for (const f of model.findings) {
    const sev = SEV_SHORT[f.severity] || f.severity || '?';
    const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '—';
    lines.push(
      `| ${sev} | ${f.id || '—'} | ${f.domain} | ${loc} | ${truncate(f.description, 140)} |`
    );
  }

  if (model.noFindingSummaries.length > 0) {
    lines.push('');
    lines.push('## Clean domains (0 findings)');
    lines.push('');
    for (const { domain, summary } of model.noFindingSummaries) {
      lines.push(`- **${domain}** — ${truncate(summary, 240)}`);
    }
  }

  if (model.parseErrors.length > 0) {
    lines.push('');
    lines.push('## Parse errors');
    lines.push('');
    for (const { domain, parseError } of model.parseErrors) {
      lines.push(`- **${domain}** — ${parseError}`);
    }
  }

  return lines.join('\n');
}

// ── text renderer (TTY default, wave-23) ──
//
// The wave-17 verdict-first principle applied to tabular findings data:
//   - severity counts at the TOP, before per-finding rows
//   - aligned columns via String.padEnd matching the widest cell per column
//   - underlined section headers (Section\n=======) instead of `## Header`
//   - no `**bold**` wrappers — plain text (operator's terminal can't render them)
//   - F-091578-034's 3-way disambiguation preserved: clean / findings /
//     pipeline_broken each carry distinct verdict-first headers, and the
//     "THIS IS NOT A CLEAN WAVE." anti-confusion line survives.

export function renderText(model) {
  const lines = [];
  lines.push(underline(`Findings Digest — ${model.runId} wave ${model.waveNumber}`, '='));
  lines.push('');

  // Verdict-first banner — same 3-way state, plain-text framing.
  if (model.status === 'clean') {
    lines.push(`VERDICT: ALL CLEAR — ${model.noFindingSummaries.length} agents reported, 0 findings`);
  } else if (model.status === 'pipeline_broken') {
    if (model.totalDomains === 0) {
      lines.push(`VERDICT: AUDIT PIPELINE FAILURE — no domain outputs loaded.`);
      lines.push(`         THIS IS NOT A CLEAN WAVE.`);
      lines.push(`         See \`swarm status ${model.runId}\` for diagnostics.`);
    } else {
      lines.push(`VERDICT: AUDIT PIPELINE FAILURE — ${model.failedDomains} of ${model.totalDomains} domains failed to report (${model.reportedDomains} parsed).`);
      lines.push(`         THIS IS NOT A CLEAN WAVE.`);
      lines.push(`         See \`swarm status ${model.runId}\` for diagnostics.`);
    }
  } else {
    lines.push(`VERDICT: ${model.findings.length} FINDINGS`);
  }
  lines.push('');

  // Severity totals — verdict-first, before any per-finding rows.
  const totalParts = [
    `CRIT ${model.counts.CRITICAL}`,
    `HIGH ${model.counts.HIGH}`,
    `MED ${model.counts.MEDIUM}`,
    `LOW ${model.counts.LOW}`,
  ];
  if (model.unknownCount > 0) totalParts.push(`Unknown ${model.unknownCount}`);
  lines.push(`Total: ${model.findings.length} | ${totalParts.join(' | ')}`);
  lines.push('');

  // Per-finding aligned table — only if there are findings to show.
  if (model.findings.length > 0) {
    lines.push(underline('Findings', '-'));
    lines.push('');
    const rows = model.findings.map((f) => ({
      sev: SEV_SHORT[f.severity] || f.severity || '?',
      id: f.id || '—',
      domain: f.domain,
      loc: f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '—',
      desc: truncate(f.description, 140),
    }));
    const widths = {
      sev: maxWidth(rows, 'sev', 'Sev'),
      id: maxWidth(rows, 'id', 'ID'),
      domain: maxWidth(rows, 'domain', 'Domain'),
      loc: maxWidth(rows, 'loc', 'File:Line'),
    };
    lines.push(
      `${pad('Sev', widths.sev)}  ${pad('ID', widths.id)}  ${pad('Domain', widths.domain)}  ${pad('File:Line', widths.loc)}  Description`
    );
    lines.push(
      `${dash(widths.sev)}  ${dash(widths.id)}  ${dash(widths.domain)}  ${dash(widths.loc)}  ${dash(11)}`
    );
    for (const r of rows) {
      lines.push(
        `${pad(r.sev, widths.sev)}  ${pad(r.id, widths.id)}  ${pad(r.domain, widths.domain)}  ${pad(r.loc, widths.loc)}  ${r.desc}`
      );
    }
    lines.push('');
  }

  if (model.noFindingSummaries.length > 0) {
    lines.push(underline('Clean domains (0 findings)', '-'));
    lines.push('');
    for (const { domain, summary } of model.noFindingSummaries) {
      lines.push(`  ${domain} — ${truncate(summary, 240)}`);
    }
    lines.push('');
  }

  if (model.parseErrors.length > 0) {
    lines.push(underline('Parse errors', '-'));
    lines.push('');
    for (const { domain, parseError } of model.parseErrors) {
      lines.push(`  ${domain} — ${parseError}`);
    }
    lines.push('');
  }

  // Trim trailing blank line for cleaner terminal paste.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ── json renderer (wave-23) ──
//
// Envelope shape mirrors lib/error-render.js's typed-error renderer:
// stable `code`-style identifiers (`status`), human prose (`headline`),
// and structured detail. CI tooling that wants to gate on the digest can
// consume this directly — no markdown parser required.

export function renderJson(model) {
  return JSON.stringify(
    {
      runId: model.runId,
      waveNumber: model.waveNumber,
      status: model.status,
      exitCode: model.exitCode,
      headline: buildJsonHeadline(model),
      counts: { ...model.counts, UNKNOWN: model.unknownCount },
      totals: {
        findings: model.findings.length,
        domainsReporting: model.reportedDomains,
        domainsFailed: model.failedDomains,
        domainsTotal: model.totalDomains,
      },
      findings: model.findings.map((f) => ({
        id: f.id || null,
        severity: f.severity || null,
        domain: f.domain,
        file: f.file || null,
        line: f.line ?? null,
        description: f.description || null,
      })),
      cleanDomains: model.noFindingSummaries.map((d) => ({
        domain: d.domain,
        summary: d.summary,
      })),
      parseErrors: model.parseErrors.map((e) => ({
        domain: e.domain,
        parseError: e.parseError,
      })),
    },
    null,
    2
  );
}

function buildJsonHeadline(model) {
  if (model.status === 'clean') {
    return `All clear — ${model.noFindingSummaries.length} agents reported, 0 findings`;
  }
  if (model.status === 'pipeline_broken') {
    return model.totalDomains === 0
      ? 'Audit pipeline failure: no domain outputs loaded'
      : `Audit pipeline failure: ${model.failedDomains} of ${model.totalDomains} domains failed to report`;
  }
  return `${model.findings.length} findings`;
}

// ── helpers ──

function truncate(s, n) {
  if (!s) return '';
  // F-c3d8fd7e: escape BEFORE flattening/truncating — escapeReasonForDisplay
  // neutralizes the control-byte/bidi/zero-width class \s does not touch
  // (ESC, C1, bidi overrides, zero-width, combining marks) by turning each
  // into a safe multi-character literal (\n, \xHH, \uHHHH); only AFTER that
  // is it safe to run a dumb `\s+` collapse and a dumb character-count slice
  // on the result. Escaping raw control chars first also means a literal
  // embedded newline/tab now shows as its visible \n/\t marker instead of
  // silently vanishing into a collapsed space — consistent with every other
  // escaped free-text render site in this package.
  const escaped = escapeReasonForDisplay(String(s));
  const flat = escaped.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

function pad(s, width) {
  return String(s ?? '').padEnd(width, ' ');
}

function dash(width) {
  return '-'.repeat(Math.max(1, width));
}

function maxWidth(rows, key, header) {
  let w = String(header).length;
  for (const r of rows) {
    const len = String(r[key] ?? '').length;
    if (len > w) w = len;
  }
  return w;
}

function underline(text, char) {
  return `${text}\n${char.repeat(text.length)}`;
}

// ════════════════════════════════════════════════════════════════════
// verify-fixed delta renderers (F-252713-002, Phase 7 wave 1)
// ════════════════════════════════════════════════════════════════════
//
// `swarm verify-fixed <run>` re-audits findings the control plane shows
// as `[fixed]` and emits a delta model from lib/verify-fixed.js. We route
// rendering through the SAME wrapper-strip choke-point as the digest:
// no `console.log(rawMarkdown)` survives in the CLI; every output path
// flows through `renderVerifyFixedDelta()`. If a future command wants to
// show classification results, it must add a renderer here, not splice
// markdown directly to stdout.
//
// Format auto-detect mirrors `shouldEmitFormat()`:
//   - default `text` on TTY (interactive operator)
//   - default `markdown` when piped/redirected (CI, `> delta.md`)
//   - explicit `--format=text|markdown|json` overrides
//   - DOGFOOD_FINDINGS_FORMAT env (raw|human|json) overrides everything

const VF_CLASS_LABEL = {
  'verified':                  'VERIFIED',
  'regressed':                 'REGRESSED',
  'claimed-but-still-present': 'CLAIMED-PRESENT',
  'unverifiable':              'UNVERIFIABLE',
};

const VF_CLASS_ORDER = [
  'claimed-but-still-present',  // most actionable first — fix never landed
  'regressed',                  // second — fix landed and got reverted
  'unverifiable',               // third — needs human review
  'verified',                   // last — the boring success case
];

export function renderVerifyFixedDelta(model, format, stream) {
  const fmt = shouldEmitFormat(format, stream);
  if (fmt === 'json') return renderVerifyFixedJson(model);
  if (fmt === 'text') return renderVerifyFixedText(model);
  return renderVerifyFixedMarkdown(model);
}

// The "offending" set is verb-dependent. verify-fixed's offending basis is
// `regressed + claimedButStillPresent` (a fix claim that didn't hold). But
// verify-approved inverts the semantic: an approved anchor *should* still be
// present, so its offending basis is drift = `verified + regressed` — and it
// overrides thresholdExceeded/exitCode on that basis in approvalExitCode().
// Deriving offending from the verb keeps the human-facing count and headline
// aligned with the exit code the command actually returns.
function verifyOffending(model) {
  const s = model.summary;
  if (model.verb === 'verify-approved') {
    return { count: s.verified + s.regressed, label: 'verified + regressed' };
  }
  return { count: s.regressed + s.claimedButStillPresent, label: 'regressed + claimed' };
}

export function renderVerifyFixedJson(model) {
  // The delta model IS the JSON contract — outputs agent's
  // parse-regression-pins.js consumer reads this directly. Stringify
  // verbatim with stable key order from the producer.
  return JSON.stringify(model, null, 2);
}

export function renderVerifyFixedMarkdown(model) {
  const lines = [];
  lines.push(`# Verify-Fixed Delta — ${model.runId}${model.waveNumber != null ? ' wave ' + model.waveNumber : ''}`);
  lines.push('');
  lines.push(`Checked: ${model.checkedAt}`);
  lines.push('');

  lines.push(buildVerifyFixedHeadline(model, '**'));
  lines.push('');

  const s = model.summary;
  lines.push(`**Summary:** ${s.total} fixed findings | ${s.verified} verified | ${s.regressed} regressed | ${s.claimedButStillPresent} claimed-but-still-present | ${s.unverifiable} unverifiable`);
  lines.push('');

  if (model.threshold > 0 || model.thresholdExceeded) {
    const offending = verifyOffending(model);
    const verdict = model.thresholdExceeded ? 'EXCEEDED' : 'within threshold';
    lines.push(`**Threshold:** ${model.threshold} | offending (${offending.label}): ${offending.count} — ${verdict}`);
    lines.push('');
  }

  if (model.findings.length === 0) {
    lines.push('_No findings with status=`fixed` to verify._');
    return lines.join('\n');
  }

  lines.push('| Class | F-id | Sev | File:Line | Symbol | Evidence |');
  lines.push('|-------|------|-----|-----------|--------|----------|');
  const sorted = sortVerifyFindings(model.findings);
  for (const f of sorted) {
    const cls = VF_CLASS_LABEL[f.classification] || f.classification;
    const sev = SEV_SHORT[f.severity] || f.severity || '?';
    const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '—';
    lines.push(
      `| ${cls} | ${f.finding_id || '—'} | ${sev} | ${loc} | ${f.symbol || '—'} | ${truncate(f.evidence, 140)} |`
    );
  }

  return lines.join('\n');
}

export function renderVerifyFixedText(model) {
  const lines = [];
  lines.push(underline(`Verify-Fixed Delta — ${model.runId}${model.waveNumber != null ? ' wave ' + model.waveNumber : ''}`, '='));
  lines.push('');
  lines.push(`Checked: ${model.checkedAt}`);
  lines.push('');

  lines.push(`VERDICT: ${buildVerifyFixedHeadline(model, '')}`);
  lines.push('');

  const s = model.summary;
  lines.push(
    `Total: ${s.total} | VERIFIED ${s.verified} | REGRESSED ${s.regressed} | CLAIMED-PRESENT ${s.claimedButStillPresent} | UNVERIFIABLE ${s.unverifiable}`
  );

  if (model.threshold > 0 || model.thresholdExceeded) {
    const offending = verifyOffending(model);
    const verdict = model.thresholdExceeded ? 'EXCEEDED' : 'within threshold';
    lines.push(`Threshold: ${model.threshold} | offending (${offending.label}): ${offending.count} — ${verdict}`);
  }
  lines.push('');

  if (model.findings.length === 0) {
    lines.push('No findings with status=fixed to verify.');
    return lines.join('\n');
  }

  lines.push(underline('Findings', '-'));
  lines.push('');

  const sorted = sortVerifyFindings(model.findings);
  const rows = sorted.map((f) => ({
    cls: VF_CLASS_LABEL[f.classification] || f.classification,
    id: f.finding_id || '—',
    sev: SEV_SHORT[f.severity] || f.severity || '?',
    loc: f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : '—',
    symbol: f.symbol || '—',
    evidence: truncate(f.evidence, 140),
  }));
  const widths = {
    cls: maxWidth(rows, 'cls', 'Class'),
    id: maxWidth(rows, 'id', 'ID'),
    sev: maxWidth(rows, 'sev', 'Sev'),
    loc: maxWidth(rows, 'loc', 'File:Line'),
    symbol: maxWidth(rows, 'symbol', 'Symbol'),
  };
  lines.push(
    `${pad('Class', widths.cls)}  ${pad('ID', widths.id)}  ${pad('Sev', widths.sev)}  ${pad('File:Line', widths.loc)}  ${pad('Symbol', widths.symbol)}  Evidence`
  );
  lines.push(
    `${dash(widths.cls)}  ${dash(widths.id)}  ${dash(widths.sev)}  ${dash(widths.loc)}  ${dash(widths.symbol)}  ${dash(8)}`
  );
  for (const r of rows) {
    lines.push(
      `${pad(r.cls, widths.cls)}  ${pad(r.id, widths.id)}  ${pad(r.sev, widths.sev)}  ${pad(r.loc, widths.loc)}  ${pad(r.symbol, widths.symbol)}  ${r.evidence}`
    );
  }

  // Trim trailing blank for clean terminal paste, mirroring renderText().
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function buildVerifyFixedHeadline(model, emph) {
  const s = model.summary;
  if (s.total === 0) {
    return `${emph}No fixed findings to verify${emph}`;
  }
  if (model.verb === 'verify-approved') {
    return buildVerifyApprovedHeadline(model, emph);
  }
  if (model.exitCode === 2) {
    return `${emph}Verify pipeline broken${emph} — every fixed finding is unverifiable; human review required`;
  }
  const offending = verifyOffending(model).count;
  if (model.thresholdExceeded) {
    return `${emph}${offending} fix claim(s) failed verification${emph} (threshold ${model.threshold})`;
  }
  if (offending > 0) {
    return `${emph}${offending} fix claim(s) failed verification${emph} (within threshold ${model.threshold})`;
  }
  return `${emph}All ${s.verified} fix claim(s) verified${emph}`;
}

// verify-approved is a pre-amend anchor gate, not a fix-claim verifier, so
// its headline speaks in anchor-drift terms: "approval still points at a
// real anchor" vs "anchor drifted before the fix was dispatched". The
// offending set is drift = verified + regressed (see verifyOffending).
function buildVerifyApprovedHeadline(model, emph) {
  const s = model.summary;
  if (model.exitCode === 2) {
    return `${emph}Approval anchor broken${emph} — at least one approved finding is unverifiable; amend dispatch blocked`;
  }
  const drifted = verifyOffending(model).count;
  if (model.thresholdExceeded) {
    return `${emph}${drifted} approval anchor(s) drifted${emph} (threshold ${model.threshold})`;
  }
  if (drifted > 0) {
    return `${emph}${drifted} approval anchor(s) drifted${emph} (within threshold ${model.threshold})`;
  }
  return `${emph}All ${s.total} approval anchor(s) intact${emph}`;
}

function sortVerifyFindings(findings) {
  const orderIndex = (cls) => {
    const idx = VF_CLASS_ORDER.indexOf(cls);
    return idx < 0 ? VF_CLASS_ORDER.length : idx;
  };
  return [...findings].sort((a, b) => {
    const ca = orderIndex(a.classification);
    const cb = orderIndex(b.classification);
    if (ca !== cb) return ca - cb;
    const sa = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[a.severity] ?? 9;
    const sb = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return (a.finding_id || '').localeCompare(b.finding_id || '');
  });
}
