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
 */

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
  const flat = String(s).replace(/\s+/g, ' ').trim();
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
