/**
 * case-file-criterion-ids-lint.test.js — a `criterion_ids` entry naming a
 * criterion that does not exist must be an ERROR (sm-oos-004).
 *
 * This is the load-bearing half of per-criterion evidence budgeting, and it
 * exists because the cure has its own disease. `context[].criterion_ids` scopes
 * a claim to the criteria it grounds; a typo there —
 * `"AC-deferred-stays-deferrred"` — is STRUCTURALLY VALID JSON Schema, because
 * cross-field validity (this string must match an id in a sibling array) is not
 * expressible in JSON Schema. Nothing would reject it, and the claim would then
 * match NO criterion and be silently dropped from every brief in the run.
 *
 * That is a new, self-inflicted evidence-starvation path with no symptom — the
 * exact failure this wave exists to kill, introduced by its own fix. The
 * severity is `error`, not `warning`, precisely because silence is the failure
 * mode: a warning that scrolls past leaves the jury starved and the receipt
 * reporting `brief_omitted: {evidence: 0}` — truthfully, since a claim that
 * grounds nothing was never owed to any criterion. The lie would be
 * undetectable downstream. It has to fail closed at the boundary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { lintCaseFile } from './lib/case-file/lint.js';

const BASE = JSON.parse(
  readFileSync('E:/AI/testing-os/fixtures/case-files/valid/well-formed-auth-fix.json', 'utf-8'),
);

/** The canonical valid fixture, with criterion_ids applied to its claims. */
function withCriterionIds(idsPerClaim) {
  const cf = JSON.parse(JSON.stringify(BASE));
  cf.context = cf.context.map((c, i) => (
    idsPerClaim[i] === undefined ? c : { ...c, criterion_ids: idsPerClaim[i] }
  ));
  return cf;
}

const findingsFor = (cf) => lintCaseFile(cf).findings.filter(f => f.code === 'case-file-criterion-ids');

describe('lintCaseFile — criterion_ids must name real criteria', () => {
  it('the untouched canonical fixture still passes (backward compatibility)', () => {
    // fixtures/case-files/valid/well-formed-auth-fix.json has no criterion_ids
    // at all. Every existing case-file must keep linting clean.
    const { ok } = lintCaseFile(BASE);
    assert.equal(ok, true, 'a case-file with no criterion_ids must remain valid');
  });

  it('valid criterion_ids lint clean', () => {
    const cf = withCriterionIds([['AC-expired-401'], ['AC-valid-issues'], ['AC-expired-401', 'AC-valid-issues']]);
    const { ok } = lintCaseFile(cf);
    assert.equal(ok, true);
    assert.equal(findingsFor(cf).length, 0);
  });

  // THE DELETION-PROOF. Delete the check in lib/case-file/lint.js and this
  // goes red; the claim would then be silently dropped from every brief.
  it('an unknown criterion id is an ERROR and fails the lint', () => {
    const cf = withCriterionIds([['AC-deferred-stays-deferrred']]); // typo: triple r
    const { ok, findings } = lintCaseFile(cf);
    assert.equal(ok, false, 'a typo must fail the lint, not warn');
    const hit = findings.find(f => f.code === 'case-file-criterion-ids');
    assert.ok(hit, 'a criterion_ids diagnostic must be raised');
    assert.equal(hit.severity, 'error', 'severity must be error — silence is the failure mode');
    assert.match(hit.field, /^\/context\/0\/criterion_ids/, 'must point at the offending entry');
    assert.match(hit.message, /AC-deferred-stays-deferrred/, 'must name the bad id');
  });

  it('names the offending claim index when the typo is not the first claim', () => {
    const cf = withCriterionIds([['AC-expired-401'], ['AC-nope']]);
    const hit = findingsFor(cf)[0];
    assert.ok(hit);
    assert.match(hit.field, /^\/context\/1\/criterion_ids/);
  });

  it('flags every bad id, not just the first', () => {
    const cf = withCriterionIds([['AC-nope-one', 'AC-expired-401', 'AC-nope-two']]);
    const hits = findingsFor(cf);
    assert.equal(hits.length, 2, 'both unknown ids must be reported');
  });

  // An EMPTY list is "present but grounds nothing" — the same silent-starvation
  // shape as a typo, and equally invisible: it satisfies "every entry names a
  // real criterion" vacuously, because there are no entries. A global claim is
  // expressed by OMITTING the field, so an empty array is always a mistake.
  it('an empty criterion_ids array is an ERROR (it grounds nothing, silently)', () => {
    const cf = withCriterionIds([[]]);
    const { ok } = lintCaseFile(cf);
    assert.equal(ok, false, 'an empty list would drop the claim from every brief');
    const hit = findingsFor(cf)[0];
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
    assert.match(hit.hint, /omit the field/i, 'the hint must say how to express a global claim');
  });

  it('a non-array criterion_ids is reported rather than silently treated as global', () => {
    const cf = JSON.parse(JSON.stringify(BASE));
    cf.context[0] = { ...cf.context[0], criterion_ids: 'AC-expired-401' }; // string, not array
    const hit = findingsFor(cf)[0];
    assert.ok(hit, 'a malformed criterion_ids must not pass silently');
    assert.equal(hit.severity, 'error');
  });
});

/**
 * An ORPHANED criterion — one with no scoped evidence — must warn (sm-oos-005).
 *
 * This is the same disease one door over from the typo check above, and it is
 * strictly worse: a typo is a mistake, an omission looks like a decision. Once
 * scoping is in use, a criterion that no claim names receives ZERO evidence and
 * the case-file lints perfectly clean, so on a capped tier it is judged from the
 * artifact alone with nothing anywhere saying so. Silent starvation, reachable
 * by omission, surviving inside the gate built to stop silent starvation by
 * typo — introduced by that very gate's own feature.
 *
 * WARNING, not error, deliberately. A criterion judged from the artifact alone
 * is legitimate — `AC-yaml-merge-inert` can reasonably be decided from the diff
 * excerpt. An error would force the clerk to INVENT grounding it does not have,
 * which is the extraction floor pointed backwards: manufacturing
 * `fable-inference` to satisfy a gate. A warning surfaces the fact and leaves
 * the judgement with the clerk and the reader — exactly what the contract does
 * with `insufficient_context`.
 *
 * ONLY FIRES WHEN SCOPING IS IN USE. If no claim carries criterion_ids every
 * claim is global, every criterion gets the whole pack, and an orphan is
 * impossible BY CONSTRUCTION — warning there would fire on every legacy
 * case-file and train the reader to ignore it. A warning that always fires is
 * noise, and noise is how a real signal gets missed.
 */
describe('lintCaseFile — an orphaned criterion warns once scoping is in use', () => {
  const orphanFindings = (cf) => lintCaseFile(cf).findings.filter(f => f.code === 'case-file-criterion-orphaned');

  it('warns when scoping is in use and a criterion is unnamed — but does NOT block', () => {
    // All three claims scoped to AC-expired-401; AC-valid-issues gets nothing.
    const cf = withCriterionIds([['AC-expired-401'], ['AC-expired-401'], ['AC-expired-401']]);
    const { ok } = lintCaseFile(cf);
    const hits = orphanFindings(cf);

    assert.equal(hits.length, 1, 'the orphaned criterion must be reported');
    assert.equal(hits[0].severity, 'warning', 'must not force the clerk to invent grounding');
    assert.equal(ok, true, 'a warning must not block the handoff — ok stays true');
    assert.match(hits[0].message, /AC-valid-issues/, 'must name the orphaned criterion');
    assert.match(hits[0].message, /artifact alone/, 'must state the consequence plainly');
  });

  // CONTROL (a) — the noise guard. Every legacy case-file is fully global.
  it('a fully-global case-file produces ZERO orphan warnings', () => {
    assert.equal(orphanFindings(BASE).length, 0,
      'with no scoping in use an orphan is impossible by construction — warning here would be pure noise');
  });

  // CONTROL (b)
  it('a case-file where every criterion is scoped produces ZERO orphan warnings', () => {
    const cf = withCriterionIds([['AC-expired-401'], ['AC-valid-issues'], ['AC-expired-401', 'AC-valid-issues']]);
    assert.equal(orphanFindings(cf).length, 0);
    assert.equal(lintCaseFile(cf).ok, true);
  });

  it('a partially-scoped pack does not orphan: a global claim grounds every criterion', () => {
    // Claim 0 scoped to AC-expired-401, claims 1-2 left global. AC-valid-issues
    // still receives the global claims, so it is NOT orphaned.
    const cf = withCriterionIds([['AC-expired-401']]);
    assert.equal(orphanFindings(cf).length, 0,
      'a criterion reached by a global claim has evidence and is not an orphan');
  });

  // SPEC CASE 4 — an empty context[] is the grounding lint's business, not
  // this check's. Warning here too would double-report the same fact in two
  // voices, which is the nag this check is shaped to avoid.
  it('an empty context[] produces ZERO orphan warnings (the grounding lint owns that)', () => {
    const cf = JSON.parse(JSON.stringify(BASE));
    cf.context = [];
    assert.equal(orphanFindings(cf).length, 0);
  });

  it('reports every orphaned criterion, not just the first', () => {
    const cf = JSON.parse(JSON.stringify(BASE));
    cf.acceptance_criteria.push({ id: 'AC-third', check: 'returns 403 for a revoked token' });
    cf.context = cf.context.map(c => ({ ...c, criterion_ids: ['AC-expired-401'] }));
    const hits = orphanFindings(cf);
    assert.equal(hits.length, 2, 'AC-valid-issues and AC-third are both orphaned');
  });
});
