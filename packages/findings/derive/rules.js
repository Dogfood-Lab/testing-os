/**
 * Derivation rules for candidate finding extraction.
 *
 * Each rule declares:
 *   ruleId       — stable identifier
 *   description  — what it detects
 *   applies(ctx) — boolean: does this record trigger the rule?
 *   derive(ctx)  — CandidateFinding[]: emit zero or more findings
 *
 * ctx shape: { record, rejected, repoSlug }
 *   record    — full persisted dogfood record JSON
 *   rejected  — true if the record is in _rejected/
 *   repoSlug  — e.g. "repo-crawler-mcp"
 */

// ─── Helpers ────────────────────────────────────────────────

function hasRejectionMatching(record, pattern) {
  const reasons = record.verification?.rejection_reasons || [];
  return reasons.some(r => pattern.test(r));
}

function hasDowngradeReason(record, pattern) {
  const reasons = record.overall_verdict?.downgrade_reasons || [];
  return reasons.some(r => pattern.test(r));
}

function scenarioSurface(record) {
  return record.scenario_results?.[0]?.product_surface || null;
}

function scenarioMode(record) {
  return record.scenario_results?.[0]?.execution_mode || null;
}

function scenarioId(record) {
  return record.scenario_results?.[0]?.scenario_id || null;
}

function failedSteps(record) {
  const results = record.scenario_results?.[0]?.step_results || [];
  return results.filter(s => s.status === 'fail');
}

function scenarioVerdict(record) {
  return record.scenario_results?.[0]?.verdict || null;
}

// ─── Rule 1: Surface/interface misclassification ────────────

const ruleSurfaceMisclassification = {
  ruleId: 'rule-surface-misclassification',
  description: 'Detects when a repo uses an invalid or incorrect product_surface enum value, indicating the runtime interface was misclassified.',

  applies(ctx) {
    // Fires when schema rejection mentions product_surface enum failure
    return hasRejectionMatching(ctx.record, /product_surface.*must be equal to one of the allowed values/);
  },

  derive(ctx) {
    const { record, repoSlug } = ctx;
    const badSurface = scenarioSurface(record) || 'unknown';
    const sid = scenarioId(record);

    return [{
      issue_kind: 'surface_misclassification',
      root_cause_kind: 'surface_misclassification',
      remediation_kind: 'classification_fix',
      transfer_scope: 'surface_archetype',
      journey_stage: 'verification',
      product_surface: mapToValidSurface(badSurface, repoSlug),
      slug: `${repoSlug}-surface-misclassification`,
      title: `Product surface "${badSurface}" rejected — repo requires correct surface enum classification`,
      summary: `The scenario declared product_surface "${badSurface}" which is not a valid enum value. The schema rejected the record. The repo must declare its actual runtime interface using the correct surface vocabulary.`,
      rationale: `Schema rejection reason references product_surface enum failure. The declared value "${badSurface}" is not in the allowed set.`,
      evidence: [
        { evidence_kind: 'rejection', record_id: record.run_id, note: `Schema rejected product_surface "${badSurface}" as invalid enum value.` },
        ...(sid ? [{ evidence_kind: 'scenario_result', record_id: record.run_id, scenario_id: sid, note: 'Scenario used incorrect surface declaration.' }] : [])
      ]
    }];
  }
};

const VALID_SURFACES = new Set(['cli', 'desktop', 'web', 'api', 'mcp-server', 'npm-package', 'plugin', 'library']);

function mapToValidSurface(bad, repoSlug) {
  // Best-effort mapping for emitting a valid finding
  if (VALID_SURFACES.has(bad)) return bad;
  if (bad === 'mcp') return 'mcp-server';
  if (repoSlug.includes('mcp')) return 'mcp-server';
  return 'cli'; // safe fallback
}

/** Get a valid surface from a record, sanitizing if needed. */
function safeRecordSurface(record, repoSlug) {
  const raw = scenarioSurface(record) || 'cli';
  return mapToValidSurface(raw, repoSlug || '');
}

// ─── Rule 2: Evidence policy mismatch ───────────────────────

const ruleEvidencePolicyMismatch = {
  ruleId: 'rule-evidence-policy-mismatch',
  description: 'Detects when a record is rejected because evidence requirements are not met — either insufficient count or missing required kinds.',

  applies(ctx) {
    return hasRejectionMatching(ctx.record, /required evidence kind|requires \d+ evidence items/);
  },

  derive(ctx) {
    const { record, repoSlug } = ctx;
    const reasons = record.verification?.rejection_reasons || [];
    const evidenceReasons = reasons.filter(r => /evidence/.test(r));
    const surface = safeRecordSurface(record, repoSlug);
    const sid = scenarioId(record);

    // Determine if it's overconstraint (too strict) or insufficiency (too weak)
    const isMissingKind = evidenceReasons.some(r => /required evidence kind/.test(r));
    const isCountShort = evidenceReasons.some(r => /requires \d+ evidence items/.test(r));

    return [{
      issue_kind: isMissingKind ? 'evidence_overconstraint' : 'evidence_insufficiency',
      root_cause_kind: 'policy_overconstraint',
      remediation_kind: 'evidence_requirement_change',
      transfer_scope: 'surface_local',
      journey_stage: 'verification',
      product_surface: surface,
      slug: `${repoSlug}-evidence-policy-mismatch`,
      title: `Evidence requirements rejected the record — policy may need calibration for ${surface} surface`,
      summary: `The record was rejected because evidence did not satisfy policy requirements: ${evidenceReasons.join('; ')}. This may indicate the policy needs calibration to match natural evidence shapes for this surface.`,
      rationale: `Policy rejection reasons explicitly reference evidence requirements: ${evidenceReasons.join('; ')}.`,
      evidence: [
        { evidence_kind: 'rejection', record_id: record.run_id, note: `Policy rejected due to evidence: ${evidenceReasons.join('; ')}` },
        ...(sid ? [{ evidence_kind: 'scenario_result', record_id: record.run_id, scenario_id: sid, note: 'Scenario evidence was insufficient for policy.' }] : [])
      ]
    }];
  }
};

// ─── Rule 3: Verdict downgrade ──────────────────────────────

const ruleVerdictDowngrade = {
  ruleId: 'rule-verdict-downgrade',
  description: 'Detects when the verifier downgrades a proposed pass to fail, indicating the source repo believed it passed but verification disagreed.',

  applies(ctx) {
    const v = ctx.record.overall_verdict;
    return v?.downgraded === true && v?.proposed === 'pass' && v?.verified !== 'pass';
  },

  derive(ctx) {
    const { record, repoSlug } = ctx;
    const reasons = record.overall_verdict?.downgrade_reasons || [];
    const rejReasons = record.verification?.rejection_reasons || [];
    const surface = safeRecordSurface(record, repoSlug);

    // Determine root cause from rejection details
    let issueKind = 'verification_gap';
    let rootCause = 'contract_drift';
    if (!record.verification?.schema_valid) {
      issueKind = 'schema_mismatch';
      rootCause = 'schema_alignment_failure';
    } else if (!record.verification?.policy_valid) {
      issueKind = 'policy_mismatch';
      rootCause = 'policy_overconstraint';
    } else if (!record.verification?.provenance_confirmed) {
      issueKind = 'provenance_gap';
      rootCause = 'missing_precondition';
    }

    return [{
      issue_kind: issueKind,
      root_cause_kind: rootCause,
      remediation_kind: 'verification_fix',
      transfer_scope: 'surface_local',
      journey_stage: 'verification',
      product_surface: surface,
      slug: `${repoSlug}-verdict-downgrade`,
      title: `Proposed pass was downgraded to ${record.overall_verdict.verified} by verifier`,
      summary: `The source repo proposed a pass verdict but the verifier downgraded it to ${record.overall_verdict.verified}. Downgrade reasons: ${reasons.join('; ')}. Rejection details: ${rejReasons.join('; ')}.`,
      rationale: `overall_verdict.downgraded is true, proposed was "pass" but verified is "${record.overall_verdict.verified}". Downgrade reasons: ${reasons.join('; ')}.`,
      evidence: [
        { evidence_kind: 'record', record_id: record.run_id, note: `Verdict downgraded: proposed=${record.overall_verdict.proposed} verified=${record.overall_verdict.verified}` },
        ...(rejReasons.length ? [{ evidence_kind: 'rejection', record_id: record.run_id, note: rejReasons.join('; ') }] : [])
      ]
    }];
  }
};

// ─── Rule 4: Scenario step failure ──────────────────────────

const ruleScenarioStepFailure = {
  ruleId: 'rule-scenario-step-failure',
  description: 'Detects scenarios where specific steps fail, indicating entrypoint, build output, or verification truth issues.',

  applies(ctx) {
    const failed = failedSteps(ctx.record);
    return failed.length > 0 && scenarioVerdict(ctx.record) === 'fail';
  },

  derive(ctx) {
    const { record, repoSlug } = ctx;
    const failed = failedSteps(record);
    const surface = safeRecordSurface(record, repoSlug);
    const sid = scenarioId(record);
    const stepIds = failed.map(s => s.step_id);

    // Classify based on which steps failed
    let issueKind = 'entrypoint_truth';
    let rootCause = 'contract_drift';
    let remediation = 'scenario_change';

    if (stepIds.some(id => /verify|output|check/.test(id))) {
      issueKind = 'build_output_mismatch';
      rootCause = 'build_config_error';
      remediation = 'build_config_fix';
    }
    if (stepIds.some(id => /flag|arg|param/.test(id))) {
      issueKind = 'flag_contract_mismatch';
      rootCause = 'interface_assumption_error';
      remediation = 'entrypoint_fix';
    }

    return [{
      issue_kind: issueKind,
      root_cause_kind: rootCause,
      remediation_kind: remediation,
      transfer_scope: 'surface_local',
      journey_stage: 'first_run',
      product_surface: surface,
      slug: `${repoSlug}-step-failure-${stepIds[0]}`,
      title: `Scenario step(s) failed: ${stepIds.join(', ')} — ${surface} entrypoint or build output may be wrong`,
      summary: `The scenario failed at step(s): ${stepIds.join(', ')}. This typically indicates the entrypoint, build output path, or invocation contract differs from what the scenario expected. The scenario or build configuration needs correction.`,
      rationale: `scenario_results[0].verdict is "fail" with ${failed.length} failed step(s): ${stepIds.join(', ')}.`,
      evidence: [
        { evidence_kind: 'scenario_result', record_id: record.run_id, scenario_id: sid, note: `Failed steps: ${stepIds.join(', ')}` },
        { evidence_kind: 'record', record_id: record.run_id, note: 'Scenario-level verdict is fail.' }
      ]
    }];
  }
};

// ─── Rule 5: Blocked scenario ───────────────────────────────

const ruleBlockedScenario = {
  ruleId: 'rule-blocked-scenario',
  description: 'Detects scenarios that were blocked entirely, typically indicating a missing precondition or infrastructure gap.',

  applies(ctx) {
    return ctx.record.scenario_results?.some(s => s.verdict === 'blocked');
  },

  derive(ctx) {
    const { record, repoSlug } = ctx;
    const blocked = record.scenario_results.filter(s => s.verdict === 'blocked');

    return blocked.map(scenario => {
      const reason = scenario.blocking_reason || 'No blocking reason provided';
      const surface = mapToValidSurface(scenario.product_surface || 'cli', repoSlug);

      return {
        issue_kind: 'verification_gap',
        root_cause_kind: 'missing_precondition',
        remediation_kind: 'workflow_change',
        transfer_scope: 'surface_local',
        journey_stage: 'first_run',
        product_surface: surface,
        slug: `${repoSlug}-blocked-${scenario.scenario_id}`,
        title: `Scenario "${scenario.scenario_id}" was blocked: ${reason}`,
        summary: `The scenario "${scenario.scenario_id}" could not execute and was marked blocked. Blocking reason: ${reason}. This indicates a missing precondition or infrastructure gap that prevents dogfood verification.`,
        rationale: `scenario_results contains a scenario with verdict "blocked" and blocking_reason: "${reason}".`,
        evidence: [
          { evidence_kind: 'scenario_result', record_id: record.run_id, scenario_id: scenario.scenario_id, note: `Blocked: ${reason}` },
          { evidence_kind: 'record', record_id: record.run_id, note: 'Scenario could not execute.' }
        ]
      };
    });
  }
};

// ─── Rule 6: Execution mode attestation gap ─────────────────

const ruleExecutionModeGap = {
  ruleId: 'rule-execution-mode-gap',
  description: 'Detects human/mixed scenarios missing attestation, or execution mode mismatches with policy expectations.',

  applies(ctx) {
    return ctx.record.scenario_results?.some(s =>
      (s.execution_mode === 'human' || s.execution_mode === 'mixed') && !s.attested_by
    );
  },

  derive(ctx) {
    const { record, repoSlug } = ctx;
    const gaps = record.scenario_results.filter(s =>
      (s.execution_mode === 'human' || s.execution_mode === 'mixed') && !s.attested_by
    );

    return gaps.map(scenario => {
      const surface = mapToValidSurface(scenario.product_surface || 'desktop', repoSlug);

      return {
        issue_kind: 'execution_mode_mismatch',
        root_cause_kind: 'missing_precondition',
        remediation_kind: 'workflow_change',
        transfer_scope: 'execution_mode',
        journey_stage: 'verification',
        product_surface: surface,
        slug: `${repoSlug}-attestation-gap-${scenario.scenario_id}`,
        title: `${scenario.execution_mode} scenario "${scenario.scenario_id}" has no attested_by field`,
        summary: `The scenario uses ${scenario.execution_mode} execution mode but has no attested_by field. Human and mixed scenarios require attestation to prove a human actually exercised the product. The workflow must include the attester identity.`,
        rationale: `scenario_results contains execution_mode "${scenario.execution_mode}" with no attested_by field.`,
        evidence: [
          { evidence_kind: 'scenario_result', record_id: record.run_id, scenario_id: scenario.scenario_id, note: `${scenario.execution_mode} mode with no attested_by.` },
          { evidence_kind: 'record', record_id: record.run_id, note: 'Attestation gap detected.' }
        ]
      };
    });
  }
};

// ─── Rule 7: Schema rejection (non-surface) ────────────────

const ruleSchemaRejection = {
  ruleId: 'rule-schema-rejection',
  description: 'Detects schema validation failures not covered by surface misclassification — general contract drift between producer and consumer.',

  applies(ctx) {
    if (ctx.record.verification?.schema_valid !== false) return false;
    // Only fire if not already covered by surface misclassification
    const reasons = ctx.record.verification?.rejection_reasons || [];
    const hasSurfaceIssue = reasons.some(r => /product_surface/.test(r));
    const hasSchemaIssue = reasons.some(r => /^schema:/.test(r));
    return hasSchemaIssue && !hasSurfaceIssue;
  },

  derive(ctx) {
    const { record, repoSlug } = ctx;
    const reasons = record.verification?.rejection_reasons?.filter(r => /^schema:/.test(r)) || [];
    const surface = safeRecordSurface(record, repoSlug);

    return [{
      issue_kind: 'schema_mismatch',
      root_cause_kind: 'schema_alignment_failure',
      remediation_kind: 'schema_fix',
      transfer_scope: 'org_wide',
      journey_stage: 'verification',
      product_surface: surface,
      slug: `${repoSlug}-schema-rejection`,
      title: `Schema validation failed — producer/consumer contract drift detected`,
      summary: `The record was rejected due to schema validation failures: ${reasons.join('; ')}. This indicates the submission does not conform to the expected record contract. The source workflow or submission builder needs updating.`,
      rationale: `verification.schema_valid is false with schema rejection reasons: ${reasons.join('; ')}.`,
      evidence: [
        { evidence_kind: 'rejection', record_id: record.run_id, note: `Schema failures: ${reasons.join('; ')}` },
        { evidence_kind: 'record', record_id: record.run_id, note: 'Schema validation returned false.' }
      ]
    }];
  }
};

// ─── Rule 8: Policy rejection (non-evidence) ────────────────

const rulePolicyRejection = {
  ruleId: 'rule-policy-rejection',
  description: 'Detects policy validation failures not covered by evidence mismatch — general policy misalignment.',

  applies(ctx) {
    if (ctx.record.verification?.policy_valid !== false) return false;
    // Only fire if not already covered by evidence policy mismatch
    const reasons = ctx.record.verification?.rejection_reasons || [];
    const hasEvidenceIssue = reasons.some(r => /evidence/.test(r));
    const hasPolicyIssue = reasons.some(r => /^policy:/.test(r));
    return hasPolicyIssue && !hasEvidenceIssue;
  },

  derive(ctx) {
    const { record, repoSlug } = ctx;
    const reasons = record.verification?.rejection_reasons?.filter(r => /^policy:/.test(r)) || [];
    const surface = safeRecordSurface(record, repoSlug);

    return [{
      issue_kind: 'policy_mismatch',
      root_cause_kind: 'policy_underconstraint',
      remediation_kind: 'policy_calibration',
      transfer_scope: 'surface_local',
      journey_stage: 'verification',
      product_surface: surface,
      slug: `${repoSlug}-policy-rejection`,
      title: `Policy validation failed — repo does not satisfy surface policy requirements`,
      summary: `The record was rejected due to policy failures: ${reasons.join('; ')}. The repo policy or the scenario shape needs calibration to match actual product behavior.`,
      rationale: `verification.policy_valid is false with policy rejection reasons: ${reasons.join('; ')}.`,
      evidence: [
        { evidence_kind: 'rejection', record_id: record.run_id, note: `Policy failures: ${reasons.join('; ')}` },
        { evidence_kind: 'record', record_id: record.run_id, note: 'Policy validation returned false.' }
      ]
    }];
  }
};

// ─── Export all rules ───────────────────────────────────────

export const RULES = [
  ruleSurfaceMisclassification,
  ruleEvidencePolicyMismatch,
  ruleVerdictDowngrade,
  ruleScenarioStepFailure,
  ruleBlockedScenario,
  ruleExecutionModeGap,
  ruleSchemaRejection,
  rulePolicyRejection
];

export function getRuleById(ruleId) {
  return RULES.find(r => r.ruleId === ruleId) || null;
}
