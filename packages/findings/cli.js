#!/usr/bin/env node

/**
 * dogfood findings CLI
 *
 * Commands:
 *   list       List all findings (supports --repo, --status, --surface, --issue-kind, --transfer-scope)
 *   show <id>  Show a single finding by finding_id
 *   validate   Validate all findings (or a specific file with --file)
 *   derive     Derive candidate findings from records (--dry-run or --write)
 *   explain    Explain how a derived finding was produced
 */

import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  validateFindingFile,
  validateFinding,
  discoverFindings,
  discoverFixtures,
  loadFindings,
  findById,
  filterFindings,
  findDuplicates
} from './index.js';
import {
  deriveFromRecord,
  deriveFromRecords,
  getRuleInventory,
  getRuleById,
  dedupeAgainstExisting,
  loadRecordById,
  loadRecordsForRepo,
  loadAllRecords,
  writeFindings
} from './derive/index.js';
import {
  performAction,
  performMerge,
  getReviewQueue,
  getEventsForFinding
} from './review/index.js';
import {
  derivePatterns,
  deriveRecommendations,
  deriveDoctrine,
  validatePattern,
  validateRecommendation,
  validateDoctrine,
  writePattern,
  writeRecommendation,
  writeDoctrine,
  loadPatterns,
  loadRecommendations,
  loadDoctrines
} from './synthesis/index.js';
import {
  generateAdviceBundle,
  generateSyncExport
} from './advise/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const positional = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = args[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function formatFindingSummary(f, rootDir) {
  const rel = relative(rootDir, f.path);
  const d = f.data;
  const valid = f.valid ? 'valid' : 'INVALID';
  return `[${d.status}] ${d.finding_id}  (${d.product_surface}, ${d.issue_kind}, ${d.transfer_scope})  [${valid}]\n  ${d.title}\n  ${rel}`;
}

function formatFindingDetail(f, rootDir) {
  const d = f.data;
  const lines = [
    `Finding: ${d.finding_id}`,
    `Title:   ${d.title}`,
    `Status:  ${d.status}`,
    `Repo:    ${d.repo}`,
    `Surface: ${d.product_surface}`,
    d.execution_mode ? `Mode:    ${d.execution_mode}` : null,
    `Stage:   ${d.journey_stage}`,
    ``,
    `Issue:       ${d.issue_kind}`,
    `Root cause:  ${d.root_cause_kind}`,
    `Remediation: ${d.remediation_kind}`,
    `Scope:       ${d.transfer_scope}`,
    ``,
    `Summary:`,
    `  ${d.summary.trim()}`,
  ];

  if (d.doctrine_statement) {
    lines.push('', 'Doctrine:', `  ${d.doctrine_statement.trim()}`);
  }

  if (d.notes) {
    lines.push('', 'Notes:', `  ${d.notes.trim()}`);
  }

  lines.push('', `Source records: ${d.source_record_ids.join(', ')}`);

  if (d.scenario_ids && d.scenario_ids.length) {
    lines.push(`Scenarios:      ${d.scenario_ids.join(', ')}`);
  }

  lines.push('', `Evidence (${d.evidence.length}):`);
  for (const e of d.evidence) {
    const parts = [`  - ${e.evidence_kind}`];
    if (e.record_id) parts.push(`record=${e.record_id}`);
    if (e.scenario_id) parts.push(`scenario=${e.scenario_id}`);
    if (e.doc_ref) parts.push(`doc=${e.doc_ref}`);
    if (e.policy_ref) parts.push(`policy=${e.policy_ref}`);
    if (e.artifact_ref) parts.push(`artifact=${e.artifact_ref}`);
    if (e.note) parts.push(`| ${e.note}`);
    lines.push(parts.join('  '));
  }

  if (d.fix_refs && d.fix_refs.length) {
    lines.push('', `Fix refs (${d.fix_refs.length}):`);
    for (const r of d.fix_refs) {
      const parts = [`  - ${r.ref_kind}: ${r.ref}`];
      if (r.note) parts.push(`| ${r.note}`);
      lines.push(parts.join('  '));
    }
  }

  lines.push('', `Valid: ${f.valid ? 'yes' : 'NO'}`);
  if (!f.valid && f.errors.length) {
    for (const err of f.errors) {
      lines.push(`  ERROR: ${err.path} — ${err.message}`);
    }
  }

  lines.push(`File: ${relative(rootDir, f.path)}`);

  return lines.filter(l => l !== null).join('\n');
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv);

  if (!command || command === 'help' || command === '--help') {
    console.log(`dogfood findings — finding contract spine + derivation engine

Commands:
  list                 List all findings
  show <finding_id>    Show a single finding in detail
  validate             Validate all findings (or --file <path> for one)
  validate --all       Validate all findings + all fixtures
  derive               Derive candidate findings from records
  explain <finding_id> Show derivation provenance for a finding
  rules                List all derivation rules
  accept <id>          Accept a finding (--actor, --reason)
  reject <id>          Reject a finding (--actor, --reason, --reject-reason)
  review <id>          Move finding to reviewed (--actor)
  edit <id>            Edit finding fields (--actor, --set field=value)
  merge <ids...>       Merge findings (--into <id>, --actor, --reason)
  reopen <id>          Reopen a rejected/accepted finding (--actor, --reason)
  invalidate <id>      Invalidate an accepted finding (--actor, --reason)
  history <id>         Show review history for a finding
  queue                Show review queue

Derive options:
  --record <run_id>    Derive from a specific record
  --repo <org/repo>    Derive from all records for a repo
  --all                Derive from all records
  --dry-run            Show what would be emitted (default)
  --write              Write candidates to disk

Filters (for list):
  --repo <org/repo>
  --status <candidate|reviewed|accepted|rejected>
  --surface <cli|desktop|web|api|mcp-server|npm-package|plugin|library>
  --issue-kind <kind>
  --transfer-scope <scope>
  --include-fixtures   Also list fixture findings`);
    process.exit(0);
  }

  if (command === 'list') {
    const includeFixtures = flags['include-fixtures'];
    const allFindings = loadFindings(ROOT);

    if (includeFixtures) {
      allFindings.push(...loadFindings(ROOT, { fixtures: true, fixtureKind: 'valid' }));
    }

    const filters = {};
    if (flags.repo) filters.repo = flags.repo;
    if (flags.status) filters.status = flags.status;
    if (flags.surface) filters.surface = flags.surface;
    if (flags['issue-kind']) filters.issueKind = flags['issue-kind'];
    if (flags['transfer-scope']) filters.transferScope = flags['transfer-scope'];

    const filtered = filterFindings(allFindings, filters);

    if (filtered.length === 0) {
      console.log('No findings found.');
      process.exit(0);
    }

    for (const f of filtered) {
      console.log(formatFindingSummary(f, ROOT));
      console.log();
    }
    console.log(`${filtered.length} finding(s)`);
    process.exit(0);
  }

  if (command === 'show') {
    const findingId = positional[0];
    if (!findingId) {
      console.error('Usage: dogfood findings show <finding_id>');
      process.exit(2);
    }

    const result = findById(ROOT, findingId);
    if (!result) {
      console.error(`Finding not found: ${findingId}`);
      process.exit(1);
    }

    console.log(formatFindingDetail(result, ROOT));
    process.exit(0);
  }

  if (command === 'validate') {
    const singleFile = flags.file;
    const all = flags.all;

    if (singleFile) {
      const filePath = resolve(singleFile);
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(2);
      }
      const result = validateFindingFile(filePath);
      if (result.valid) {
        console.log(`PASS: ${relative(ROOT, filePath)}`);
        process.exit(0);
      } else {
        console.error(`FAIL: ${relative(ROOT, filePath)}`);
        for (const err of result.errors) {
          console.error(`  ${err.path} — ${err.message}`);
        }
        process.exit(1);
      }
    }

    // Validate all findings + optionally fixtures
    let failed = 0;
    let passed = 0;

    const realFindings = loadFindings(ROOT);
    for (const f of realFindings) {
      if (f.valid) {
        console.log(`PASS: ${relative(ROOT, f.path)}`);
        passed++;
      } else {
        console.error(`FAIL: ${relative(ROOT, f.path)}`);
        for (const err of f.errors) {
          console.error(`  ${err.path} — ${err.message}`);
        }
        failed++;
      }
    }

    if (all) {
      // Valid fixtures should all pass
      const validFixtures = loadFindings(ROOT, { fixtures: true, fixtureKind: 'valid' });
      for (const f of validFixtures) {
        if (f.valid) {
          console.log(`PASS (fixture): ${relative(ROOT, f.path)}`);
          passed++;
        } else {
          console.error(`FAIL (fixture): ${relative(ROOT, f.path)}`);
          for (const err of f.errors) {
            console.error(`  ${err.path} — ${err.message}`);
          }
          failed++;
        }
      }

      // Invalid fixtures should all fail
      const invalidFixtures = loadFindings(ROOT, { fixtures: true, fixtureKind: 'invalid' });
      for (const f of invalidFixtures) {
        if (!f.valid) {
          console.log(`PASS (expected invalid): ${relative(ROOT, f.path)}`);
          passed++;
        } else {
          console.error(`FAIL (expected invalid but passed): ${relative(ROOT, f.path)}`);
          failed++;
        }
      }
    }

    // Duplicate check
    const allForDupes = [...loadFindings(ROOT)];
    const dupes = findDuplicates(allForDupes);
    if (dupes.length > 0) {
      for (const d of dupes) {
        console.error(`DUPLICATE: ${d.findingId} found in ${d.paths.map(p => relative(ROOT, p)).join(', ')}`);
        failed++;
      }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }

  if (command === 'derive') {
    const recordId = flags.record;
    const repoKey = flags.repo;
    const all = flags.all;
    const write = flags.write;

    // Load records based on scope
    let entries = [];
    if (recordId) {
      const entry = loadRecordById(ROOT, recordId);
      if (!entry) {
        console.error(`Record not found: ${recordId}`);
        process.exit(1);
      }
      entries = [entry];
    } else if (repoKey) {
      entries = loadRecordsForRepo(ROOT, repoKey);
      if (entries.length === 0) {
        console.error(`No records found for repo: ${repoKey}`);
        process.exit(1);
      }
    } else if (all) {
      entries = loadAllRecords(ROOT);
      if (entries.length === 0) {
        console.error('No records found.');
        process.exit(1);
      }
    } else {
      console.error('Specify --record <run_id>, --repo <org/repo>, or --all');
      process.exit(2);
    }

    // Derive
    const { candidates, ruleErrors, stats } = deriveFromRecords(entries);

    // Surface per-rule throws — derivation only "succeeded" when ruleErrors is empty.
    // Exit non-zero so CI never silently treats a partially-degraded run as green.
    if (ruleErrors.length > 0) {
      console.error(`${ruleErrors.length} rule error(s) during derivation:`);
      for (const e of ruleErrors) {
        console.error(`  rule=${e.ruleId} run_id=${e.runId} msg=${e.message}`);
      }
      process.exit(1);
    }

    // Validate all candidates against schema
    const invalid = candidates.filter(c => !validateFinding(c).valid);
    if (invalid.length > 0) {
      console.error(`${invalid.length} candidate(s) failed schema validation:`);
      for (const c of invalid) {
        const result = validateFinding(c);
        console.error(`  ${c.finding_id}: ${result.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
      }
      process.exit(1);
    }

    // Dedupe against existing findings
    const existingFindings = loadFindings(ROOT);
    const { toWrite, skippedUnchanged, collisions } = dedupeAgainstExisting(candidates, existingFindings);

    // Report
    console.log(`Processed ${stats.recordsProcessed} record(s)`);
    console.log(`Rules evaluated: ${stats.rulesEvaluated}`);
    console.log(`Candidates emitted: ${candidates.length}`);
    if (stats.deduped > 0) console.log(`Deduped within batch: ${stats.deduped}`);
    if (skippedUnchanged > 0) console.log(`Skipped unchanged: ${skippedUnchanged}`);
    if (collisions.length > 0) {
      console.log(`Collisions: ${collisions.length}`);
      for (const c of collisions) {
        console.log(`  ${c.findingId} (existing status: ${c.existingStatus})`);
      }
    }
    console.log();

    for (const c of toWrite) {
      console.log(`  - ${c.finding_id}`);
      console.log(`    rule: ${c.derived.rule_id}`);
      const evSummary = c.evidence.map(e => `${e.evidence_kind}:${e.record_id || e.scenario_id || ''}`).join(', ');
      console.log(`    evidence: ${evSummary}`);
    }

    if (!write) {
      console.log(`\n(dry-run) ${toWrite.length} candidate(s) would be written. Use --write to materialize.`);
      process.exit(0);
    }

    // Write mode
    const { written, errors } = writeFindings(ROOT, toWrite);
    console.log(`\nWritten: ${written.length}`);
    for (const p of written) {
      console.log(`  ${relative(ROOT, p)}`);
    }
    if (errors.length > 0) {
      console.error(`Errors: ${errors.length}`);
      for (const e of errors) {
        console.error(`  ${e.findingId}: ${e.error}`);
      }
      process.exit(1);
    }
    process.exit(0);
  }

  if (command === 'explain') {
    const findingId = positional[0];
    if (!findingId) {
      console.error('Usage: dogfood findings explain <finding_id>');
      process.exit(2);
    }

    const result = findById(ROOT, findingId);
    if (!result) {
      console.error(`Finding not found: ${findingId}`);
      process.exit(1);
    }

    const d = result.data;
    const lines = [
      `Finding: ${d.finding_id}`,
      `Title:   ${d.title}`,
      `Status:  ${d.status}`,
      ''
    ];

    if (d.derived) {
      lines.push(
        'Derivation:',
        `  Method:    ${d.derived.method}`,
        `  Rule:      ${d.derived.rule_id}`,
        `  Derived:   ${d.derived.derived_at}`,
        '',
        'Rationale:',
        `  ${d.derived.rationale.trim()}`,
        ''
      );

      const rule = getRuleById(d.derived.rule_id);
      if (rule) {
        lines.push(`Rule description:`, `  ${rule.description}`, '');
      }
    } else {
      lines.push('(Hand-authored finding — no derivation metadata)', '');
    }

    lines.push(`Source records: ${d.source_record_ids.join(', ')}`);
    if (d.scenario_ids?.length) {
      lines.push(`Scenarios:      ${d.scenario_ids.join(', ')}`);
    }

    lines.push('', `Evidence (${d.evidence.length}):`);
    for (const e of d.evidence) {
      const parts = [`  - ${e.evidence_kind}`];
      if (e.record_id) parts.push(`record=${e.record_id}`);
      if (e.scenario_id) parts.push(`scenario=${e.scenario_id}`);
      if (e.note) parts.push(`| ${e.note}`);
      lines.push(parts.join('  '));
    }

    lines.push('', `Classification:`);
    lines.push(`  Issue:       ${d.issue_kind}`);
    lines.push(`  Root cause:  ${d.root_cause_kind}`);
    lines.push(`  Remediation: ${d.remediation_kind}`);
    lines.push(`  Scope:       ${d.transfer_scope}`);

    console.log(lines.join('\n'));
    process.exit(0);
  }

  // ── Review commands ──────────────────────────────

  if (['accept', 'reject', 'review', 'reopen', 'invalidate'].includes(command)) {
    const findingId = positional[0];
    if (!findingId) {
      console.error(`Usage: dogfood findings ${command} <finding_id> --actor <name> [--reason "..."]`);
      process.exit(2);
    }
    const actor = flags.actor || 'operator';
    const result = performAction(ROOT, {
      findingId,
      action: command,
      actor,
      reason: flags.reason,
      rejectReason: flags['reject-reason'],
      notes: flags.notes
    });
    if (!result.success) {
      console.error(`FAILED: ${result.error}`);
      process.exit(1);
    }
    console.log(`${command}: ${findingId} → ${result.finding.status}`);
    if (result.event) {
      console.log(`Event: ${result.event.review_event_id} (${result.event.from_status} → ${result.event.to_status})`);
    }
    process.exit(0);
  }

  if (command === 'edit') {
    const findingId = positional[0];
    if (!findingId) {
      console.error('Usage: dogfood findings edit <finding_id> --actor <name> --set field=value [--set field=value]');
      process.exit(2);
    }
    // Parse --set flags
    const fieldChanges = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--set' && i + 1 < args.length) {
        const [field, ...rest] = args[++i].split('=');
        fieldChanges[field] = rest.join('=');
      }
    }
    if (Object.keys(fieldChanges).length === 0) {
      console.error('No field changes specified. Use --set field=value');
      process.exit(2);
    }
    const actor = flags.actor || 'operator';
    const result = performAction(ROOT, {
      findingId,
      action: 'edit',
      actor,
      fieldChanges,
      notes: flags.notes
    });
    if (!result.success) {
      console.error(`FAILED: ${result.error}`);
      process.exit(1);
    }
    console.log(`Edited: ${findingId}`);
    if (result.event?.field_changes) {
      for (const [field, change] of Object.entries(result.event.field_changes)) {
        console.log(`  ${field}: "${change.from}" → "${change.to}"`);
      }
    }
    process.exit(0);
  }

  if (command === 'merge') {
    const sourceIds = positional;
    const canonicalId = flags.into;
    const actor = flags.actor || 'operator';
    const reason = flags.reason;
    if (sourceIds.length < 2 || !canonicalId) {
      console.error('Usage: dogfood findings merge <id1> <id2> [<id3>...] --into <canonical_id> --actor <name> --reason "..."');
      process.exit(2);
    }
    const result = performMerge(ROOT, { sourceIds, canonicalId, actor, reason });
    if (!result.success) {
      console.error(`FAILED: ${result.error}`);
      process.exit(1);
    }
    console.log(`Merged into: ${canonicalId}`);
    console.log(`Sources superseded: ${sourceIds.filter(id => id !== canonicalId).join(', ')}`);
    console.log(`Evidence count: ${result.canonical.evidence.length}`);
    console.log(`Source records: ${result.canonical.source_record_ids.length}`);
    process.exit(0);
  }

  if (command === 'history') {
    const findingId = positional[0];
    if (!findingId) {
      console.error('Usage: dogfood findings history <finding_id>');
      process.exit(2);
    }
    const events = getEventsForFinding(ROOT, findingId);
    if (events.length === 0) {
      console.log(`No review history for: ${findingId}`);
      process.exit(0);
    }
    console.log(`Review history for ${findingId} (${events.length} event(s)):\n`);
    for (const e of events) {
      console.log(`  ${e.timestamp}  ${e.action}  ${e.from_status} → ${e.to_status}  by ${e.actor}`);
      if (e.reason) console.log(`    Reason: ${e.reason}`);
      if (e.field_changes) {
        for (const [field, change] of Object.entries(e.field_changes)) {
          console.log(`    ${field}: "${change.from}" → "${change.to}"`);
        }
      }
      if (e.merged_from_ids) console.log(`    Merged from: ${e.merged_from_ids.join(', ')}`);
    }
    process.exit(0);
  }

  if (command === 'queue') {
    const queue = getReviewQueue(ROOT);
    if (queue.length === 0) {
      console.log('Review queue is empty.');
      process.exit(0);
    }
    console.log(`Review queue (${queue.length} item(s)):\n`);
    for (const item of queue) {
      console.log(`  [${item.data.status}] ${item.data.finding_id}`);
      console.log(`    ${item.queueReason}`);
      console.log(`    ${item.data.title}`);
      console.log();
    }
    process.exit(0);
  }

  // ── Synthesis commands ──────────────────────────────

  if (command === 'patterns') {
    const sub = positional[0];
    if (sub === 'derive') {
      const write = flags.write;
      const { patterns, stats } = derivePatterns(ROOT, { includeFixtures: flags['include-fixtures'] });

      // Validate all
      const invalid = patterns.filter(p => !validatePattern(p).valid);
      if (invalid.length > 0) {
        console.error(`${invalid.length} pattern(s) failed schema validation`);
        for (const p of invalid) {
          const r = validatePattern(p);
          console.error(`  ${p.pattern_id}: ${r.errors.map(e => `${e.path} ${e.message}`).join('; ')}`);
        }
        process.exit(1);
      }

      console.log(`Findings considered: ${stats.findingsConsidered}`);
      console.log(`Clusters found: ${stats.clustersFound}`);
      console.log(`Below threshold: ${stats.belowThreshold}`);
      console.log(`Patterns emitted: ${patterns.length}\n`);

      for (const p of patterns) {
        console.log(`  ${p.pattern_id} [${p.pattern_strength}]`);
        console.log(`    ${p.title}`);
        console.log(`    findings: ${p.source_finding_ids.join(', ')}`);
        console.log();
      }

      if (write && patterns.length > 0) {
        for (const p of patterns) {
          const path = writePattern(ROOT, p);
          console.log(`Written: ${relative(ROOT, path)}`);
        }
      } else if (!write && patterns.length > 0) {
        console.log(`(dry-run) ${patterns.length} pattern(s) would be written. Use --write to materialize.`);
      }
      process.exit(0);
    }

    if (sub === 'list') {
      const patterns = loadPatterns(ROOT);
      if (patterns.length === 0) { console.log('No patterns found.'); process.exit(0); }
      for (const p of patterns) {
        console.log(`[${p.status}] ${p.pattern_id} (${p.pattern_strength || 'unknown'})`);
        console.log(`  ${p.title}`);
        console.log();
      }
      console.log(`${patterns.length} pattern(s)`);
      process.exit(0);
    }

    if (sub === 'show' || sub === 'explain') {
      const id = positional[1];
      if (!id) { console.error(`Usage: dogfood findings patterns ${sub} <pattern_id>`); process.exit(2); }
      const all = loadPatterns(ROOT);
      const p = all.find(x => x.pattern_id === id);
      if (!p) { console.error(`Pattern not found: ${id}`); process.exit(1); }

      console.log(`Pattern:   ${p.pattern_id}`);
      console.log(`Title:     ${p.title}`);
      console.log(`Status:    ${p.status}`);
      console.log(`Kind:      ${p.pattern_kind}`);
      console.log(`Strength:  ${p.pattern_strength || 'unknown'}`);
      console.log(`Scope:     ${p.transfer_scope}`);
      console.log(`\nSummary:\n  ${p.summary}`);
      console.log(`\nSupport: ${p.support.finding_count} findings, ${p.support.repo_count} repos, ${p.support.surface_count} surfaces`);
      console.log(`\nSource findings: ${p.source_finding_ids.join(', ')}`);
      console.log(`Dimensions: surfaces=${(p.dimensions.product_surfaces||[]).join(',')}, issues=${(p.dimensions.issue_kinds||[]).join(',')}`);
      if (p.lineage_note) console.log(`\nLineage: ${p.lineage_note}`);
      process.exit(0);
    }

    console.error('Usage: dogfood findings patterns <derive|list|show|explain> [options]');
    process.exit(2);
  }

  if (command === 'recommendations') {
    const sub = positional[0];
    if (sub === 'derive') {
      const write = flags.write;
      const { recommendations, stats } = deriveRecommendations(ROOT);

      console.log(`Patterns considered: ${stats.patternsConsidered}`);
      console.log(`Recommendations emitted: ${stats.recommendationsEmitted}\n`);

      for (const r of recommendations) {
        console.log(`  ${r.recommendation_id} [${r.confidence}]`);
        console.log(`    ${r.title}`);
        console.log();
      }

      if (write && recommendations.length > 0) {
        for (const r of recommendations) {
          const path = writeRecommendation(ROOT, r);
          console.log(`Written: ${relative(ROOT, path)}`);
        }
      } else if (!write && recommendations.length > 0) {
        console.log(`(dry-run) ${recommendations.length} recommendation(s) would be written. Use --write to materialize.`);
      }
      process.exit(0);
    }

    if (sub === 'list') {
      const recs = loadRecommendations(ROOT);
      if (recs.length === 0) { console.log('No recommendations found.'); process.exit(0); }
      for (const r of recs) {
        console.log(`[${r.status}] ${r.recommendation_id}`);
        console.log(`  ${r.title}`);
        console.log();
      }
      process.exit(0);
    }

    if (sub === 'show') {
      const id = positional[1];
      if (!id) { console.error('Usage: dogfood findings recommendations show <id>'); process.exit(2); }
      const all = loadRecommendations(ROOT);
      const r = all.find(x => x.recommendation_id === id);
      if (!r) { console.error(`Recommendation not found: ${id}`); process.exit(1); }
      console.log(`Recommendation: ${r.recommendation_id}`);
      console.log(`Title:          ${r.title}`);
      console.log(`Status:         ${r.status}`);
      console.log(`Kind:           ${r.recommendation_kind}`);
      console.log(`Confidence:     ${r.confidence}`);
      console.log(`\nSummary:\n  ${r.summary}`);
      console.log(`\nAction: ${r.action.type} → ${r.action.target}`);
      console.log(`  ${r.action.details}`);
      console.log(`\nBased on patterns: ${r.based_on_pattern_ids.join(', ')}`);
      console.log(`Applies to: ${(r.applies_to?.product_surfaces || []).join(', ')}`);
      process.exit(0);
    }

    console.error('Usage: dogfood findings recommendations <derive|list|show> [options]');
    process.exit(2);
  }

  if (command === 'doctrine') {
    const sub = positional[0];
    if (sub === 'derive') {
      const write = flags.write;
      const { doctrines, stats } = deriveDoctrine(ROOT);

      console.log(`Patterns considered: ${stats.patternsConsidered}`);
      console.log(`Doctrines emitted: ${stats.doctrinesEmitted}`);
      console.log(`Below threshold: ${stats.belowThreshold}\n`);

      for (const d of doctrines) {
        console.log(`  ${d.doctrine_id} [${d.strength}]`);
        console.log(`    ${d.title}`);
        console.log();
      }

      if (write && doctrines.length > 0) {
        for (const d of doctrines) {
          const path = writeDoctrine(ROOT, d);
          console.log(`Written: ${relative(ROOT, path)}`);
        }
      } else if (!write && doctrines.length > 0) {
        console.log(`(dry-run) ${doctrines.length} doctrine(s) would be written. Use --write to materialize.`);
      }
      process.exit(0);
    }

    if (sub === 'list') {
      const docs = loadDoctrines(ROOT);
      if (docs.length === 0) { console.log('No doctrine found.'); process.exit(0); }
      for (const d of docs) {
        console.log(`[${d.status}] ${d.doctrine_id} [${d.strength}]`);
        console.log(`  ${d.statement}`);
        console.log();
      }
      process.exit(0);
    }

    if (sub === 'show') {
      const id = positional[1];
      if (!id) { console.error('Usage: dogfood findings doctrine show <id>'); process.exit(2); }
      const all = loadDoctrines(ROOT);
      const d = all.find(x => x.doctrine_id === id);
      if (!d) { console.error(`Doctrine not found: ${id}`); process.exit(1); }
      console.log(`Doctrine:  ${d.doctrine_id}`);
      console.log(`Title:     ${d.title}`);
      console.log(`Status:    ${d.status}`);
      console.log(`Kind:      ${d.doctrine_kind}`);
      console.log(`Strength:  ${d.strength}`);
      console.log(`Scope:     ${d.transfer_scope}`);
      console.log(`\nStatement:\n  ${d.statement}`);
      console.log(`\nRationale:\n  ${d.rationale}`);
      console.log(`\nBased on patterns: ${d.based_on_pattern_ids.join(', ')}`);
      process.exit(0);
    }

    console.error('Usage: dogfood findings doctrine <derive|list|show> [options]');
    process.exit(2);
  }

  // ── Advice commands ──────────────────────────────

  if (command === 'advise') {
    const surface = flags.surface;
    const executionMode = flags['execution-mode'] || flags.mode;
    const repo = flags.repo;

    if (!surface && !repo) {
      console.error('Usage: dogfood findings advise --surface <surface> [--execution-mode <mode>] [--repo <org/repo>]');
      process.exit(2);
    }

    const bundle = generateAdviceBundle(ROOT, { surface, executionMode, repo });
    const a = bundle.advice;

    console.log(`Advice for: ${[surface, executionMode, repo].filter(Boolean).join(', ') || 'general'}\n`);

    if (a.starter_checks.length > 0) {
      console.log(`Starter checks (${a.starter_checks.length}):`);
      for (const c of a.starter_checks) {
        console.log(`  [${c.confidence}] ${c.id}`);
        console.log(`    ${c.title}`);
      }
      console.log();
    }

    if (a.evidence_expectations.length > 0) {
      console.log(`Evidence expectations (${a.evidence_expectations.length}):`);
      for (const e of a.evidence_expectations) {
        console.log(`  [${e.confidence}] ${e.id}`);
        console.log(`    ${e.title}`);
      }
      console.log();
    }

    if (a.verification_rules.length > 0) {
      console.log(`Verification rules (${a.verification_rules.length}):`);
      for (const v of a.verification_rules) {
        console.log(`  [${v.confidence}] ${v.id}`);
        console.log(`    ${v.title}`);
      }
      console.log();
    }

    if (a.likely_failure_classes.length > 0) {
      console.log(`Likely failure classes:`);
      for (const fc of a.likely_failure_classes) {
        console.log(`  ${fc.issueKind} (${fc.count} finding(s))`);
      }
      console.log();
    }

    if (a.relevant_doctrine.length > 0) {
      console.log(`Relevant doctrine (${a.relevant_doctrine.length}):`);
      for (const d of a.relevant_doctrine) {
        console.log(`  [${d.strength}] ${d.id}`);
        console.log(`    ${d.statement}`);
      }
      console.log();
    }

    console.log(`Support: ${bundle.support.pattern_count} patterns, ${bundle.support.finding_count} findings, ${bundle.support.recommendation_count} recommendations, ${bundle.support.doctrine_count} doctrine`);
    if (bundle.support.pattern_ids.length > 0) {
      console.log(`Pattern IDs: ${bundle.support.pattern_ids.join(', ')}`);
    }
    process.exit(0);
  }

  if (command === 'sync-export') {
    const bundle = generateSyncExport(ROOT);
    const json = flags.json;

    if (json) {
      console.log(JSON.stringify(bundle, null, 2));
    } else {
      console.log(`Dogfood sync export (${bundle.exported_at})`);
      console.log(`  Findings:        ${bundle.counts.findings}`);
      console.log(`  Patterns:        ${bundle.counts.patterns}`);
      console.log(`  Recommendations: ${bundle.counts.recommendations}`);
      console.log(`  Doctrine:        ${bundle.counts.doctrine}`);
      console.log(`\nUse --json for machine-readable output.`);
    }
    process.exit(0);
  }

  if (command === 'rules') {
    const inventory = getRuleInventory();
    console.log(`Derivation rules (${inventory.length}):\n`);
    for (const r of inventory) {
      console.log(`  ${r.ruleId}`);
      console.log(`    ${r.description}`);
      console.log();
    }
    process.exit(0);
  }

  console.error(`Unknown command: ${command}. Run with --help for usage.`);
  process.exit(2);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
