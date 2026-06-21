/**
 * Hand-authored TypeScript interfaces for the contract payload shapes.
 *
 * FT-h (Wave, HIGH, consumability). The package exports the JSON-schema
 * OBJECTS, the three full-set enum unions, and `validatePayload`, but no
 * TypeScript interface for the actual payload SHAPES. A TS consumer that
 * builds a submission, reads a persisted record, or constructs a finding got
 * zero compile-time safety on the envelope — `validatePayload` only catches
 * the mistake at runtime, after the bad object already flowed through typed
 * code as `unknown`/`any`.
 *
 * These interfaces give consumers a typed shape to assert against at author
 * time. They are HAND-MAINTAINED to mirror the JSON schemas — there is no
 * codegen step — so each interface and nested type carries a `Mirrors:`
 * pointer to its source schema, and the {@link EXAMPLE_PAYLOADS} consts at the
 * bottom are `satisfies`-checked so `tsc --build` (which CI runs via
 * `npm run verify` → `npm run build`) goes RED the moment an interface drifts
 * from a representative payload. The companion vitest
 * (`test/payload-types.test.ts`) closes the other half of the loop: it pushes
 * those same examples through `validatePayload` and asserts the JSON schema
 * AGREES they are valid. Interface drift in EITHER direction is caught.
 *
 * Reused enum unions: enum-typed fields reference the exported
 * {@link ProductSurface} / {@link ExecutionMode} / {@link EvidenceKind} unions
 * rather than re-typing the literals, so those fields stay sealed to the same
 * single source the cross-contract enum seal enforces on the JSON side.
 *
 * SCOPE — the four payloads FT-h names: {@link Submission},
 * {@link ScenarioResult}, {@link Record}, {@link Finding}. The other four
 * contract schemas (pattern, recommendation, doctrine, policy) are out of
 * scope for this slice and intentionally not modelled here; add them the same
 * way (interface + `Mirrors:` pointer + a `satisfies` example) when a consumer
 * needs them.
 */

import type { ProductSurface, ExecutionMode, EvidenceKind } from './enums.js';

// ---------------------------------------------------------------------------
// Shared verdict / status string unions
//
// These small unions are NOT in enums.ts: enums.ts is deliberately scoped to
// the three FULL-SET enums the cross-contract seal guards (product_surface,
// execution_mode, evidence-kind). The verdict/status literals below are local
// to a single schema's properties, so they live with the interfaces that use
// them rather than widening the sealed-enum surface.
// ---------------------------------------------------------------------------

/** Scenario- and run-level verdict. Mirrors the `verdict` / `overall_verdict` enum. */
export type Verdict = 'pass' | 'fail' | 'blocked' | 'partial';

/** Per-step status. Mirrors `scenario_results[].step_results[].status`. */
export type StepStatus = 'pass' | 'fail' | 'blocked' | 'skip' | 'partial';

/** Machine CI check kind. Mirrors `ci_checks[].kind`. */
export type CiCheckKind = 'test' | 'coverage' | 'lint' | 'security' | 'build' | 'other';

/** Machine CI check status. Mirrors `ci_checks[].status`. */
export type CiCheckStatus = 'pass' | 'fail' | 'skip';

// ---------------------------------------------------------------------------
// Shared envelope sub-objects (identical across submission + record)
//
// Mirrors: dogfood-record-submission.schema.json AND dogfood-record.schema.json
// — `ref`, `source`, `timing`, `ci_checks[]` are byte-for-byte identical in
// both schemas, so they are modelled once and reused by both interfaces.
// ---------------------------------------------------------------------------

/** Git ref of the work under test. Mirrors the `ref` object. */
export interface Ref {
  /** Branch name, if applicable. */
  branch?: string;
  /** 40-char lowercase-hex commit SHA. Schema pattern: `^[0-9a-f]{40}$`. */
  commit_sha: string;
  /** Release version tag if applicable. */
  version?: string;
}

/** SCM provenance of the run. Mirrors the `source` object. */
export interface Source {
  /** SCM provider. GitHub-only for now. */
  provider: 'github';
  /** Workflow filename that produced the submission. */
  workflow: string;
  /** Provider-native run ID (GitHub Actions run ID). */
  provider_run_id: string;
  /** Run attempt number. Schema default is 1. */
  attempt?: number;
  /** URL to the provider run. Schema format: uri. */
  run_url: string;
  /** GitHub username that triggered the workflow. */
  actor?: string;
}

/** Wall-clock timing of the run. Mirrors the `timing` object. */
export interface Timing {
  /** ISO-8601 date-time the run started. */
  started_at: string;
  /** ISO-8601 date-time the run finished. */
  finished_at: string;
  /** Duration in milliseconds. */
  duration_ms?: number;
}

/** A machine-evaluated CI result. Mirrors a `ci_checks[]` element. */
export interface CiCheck {
  id: string;
  kind: CiCheckKind;
  status: CiCheckStatus;
  /** Numeric result (test count, coverage %, etc.). */
  value?: number;
  /** Policy threshold if applicable. */
  threshold?: number;
}

// ---------------------------------------------------------------------------
// ScenarioResult — shared between submission + record
//
// Mirrors: `scenario_results[]` in dogfood-record-submission.schema.json AND
// dogfood-record.schema.json (identical item shape in both).
// ---------------------------------------------------------------------------

/** A single per-step execution result. Mirrors `scenario_results[].step_results[]`. */
export interface StepResult {
  /** Must match a step.id from the scenario definition. Pattern: `^[a-z0-9][a-z0-9-]*$`. */
  step_id: string;
  status: StepStatus;
  notes?: string;
}

/** A piece of evidence attached to a scenario result. Mirrors `scenario_results[].evidence[]`. */
export interface ScenarioEvidence {
  /** Evidence kind — reuses the sealed full-set {@link EvidenceKind} union. */
  kind: EvidenceKind;
  /** Evidence URL. Schema format: uri. */
  url: string;
  description?: string;
  /** ISO-8601 date-time when this evidence URL becomes unavailable. */
  expires_at?: string;
}

/**
 * One scenario's dogfood evidence.
 *
 * Mirrors the `scenario_results[]` item shape shared by the submission and the
 * persisted record. `product_surface` / `execution_mode` reuse the sealed
 * full-set enum unions.
 */
export interface ScenarioResult {
  /** Stable ID matching a scenario definition in the source repo. */
  scenario_id: string;
  scenario_name?: string;
  /** Semver. Schema pattern: `^\d+\.\d+\.\d+$`. */
  scenario_version?: string;
  product_surface: ProductSurface;
  execution_mode: ExecutionMode;
  /** Human attester ID. Verifier enforces presence when execution_mode is human or mixed. */
  attested_by?: string;
  verdict: Verdict;
  /** Required when verdict is blocked. Verifier enforces. */
  blocking_reason?: string;
  /** Per-step execution results. Schema minItems: 1. */
  step_results: StepResult[];
  evidence?: ScenarioEvidence[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Submission — source-authored payload
// Mirrors: dogfood-record-submission.schema.json
// ---------------------------------------------------------------------------

/**
 * Source-authored dogfood submission payload — what a consumer repo emits via
 * `repository_dispatch`. Carries NO verifier-owned fields (no `verification`,
 * no `policy_version`); `overall_verdict` is a flat {@link Verdict} the source
 * PROPOSES (the verifier may confirm or downgrade, never upgrade).
 *
 * Mirrors: dogfood-record-submission.schema.json.
 */
export interface Submission {
  /** Semver of the submission schema. Schema pattern: `^\d+\.\d+\.\d+$`. */
  schema_version: string;
  /** Unique run identifier. Schema pattern: `^[A-Za-z0-9_-]+$` (filesystem-path-safe). */
  run_id: string;
  /** Full org/repo name. Schema pattern: `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`. */
  repo: string;
  ref: Ref;
  source: Source;
  timing: Timing;
  /** Optional — not all dogfood runs include CI. */
  ci_checks?: CiCheck[];
  /** Dogfood evidence. Schema minItems: 1. */
  scenario_results: ScenarioResult[];
  /** Source-proposed verdict (flat). */
  overall_verdict: Verdict;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Record — verifier-authored persisted record
// Mirrors: dogfood-record.schema.json
// ---------------------------------------------------------------------------

/**
 * The persisted record's `overall_verdict` object. Unlike the submission's
 * flat verdict, the record nests proposed-vs-verified to record the verifier's
 * decision. Mirrors `overall_verdict` in dogfood-record.schema.json.
 */
export interface RecordOverallVerdict {
  /** Verdict as proposed by the source repo. */
  proposed: Verdict;
  /** Final verdict after central verification. */
  verified: Verdict;
  /** True if verifier downgraded the proposed verdict. Schema default: false. */
  downgraded?: boolean;
  /** Machine-readable reasons if verifier downgraded. */
  downgrade_reasons?: string[];
}

/**
 * Provenance-remediation metadata — present when a record's provenance could
 * not be auto-confirmed but was manually stub-verified. Mirrors
 * `verification.provenance_remediation` in dogfood-record.schema.json.
 */
export interface ProvenanceRemediation {
  status?: 'stub_verified';
  /** Schema maxLength: 500. */
  note?: string;
  remediated_at: string;
  /** Tri-state: the original boolean, or null when it was never evaluated. */
  original_provenance_confirmed?: boolean | null;
}

/**
 * Verifier-owned verification block. Mirrors `verification` in
 * dogfood-record.schema.json. Never authored by source repos.
 */
export interface Verification {
  /** Final outcome. No pending state in persisted records. */
  status: 'accepted' | 'rejected';
  verified_at: string;
  /** True if GitHub API confirmed the source run exists and matches claims. */
  provenance_confirmed: boolean;
  /** True if submission passed JSON Schema validation. */
  schema_valid: boolean;
  /** True if record satisfies all applicable policy rules. */
  policy_valid: boolean;
  /** Machine-readable rejection reasons. Empty/absent if accepted. */
  rejection_reasons?: string[];
  provenance_remediation?: ProvenanceRemediation;
}

/**
 * Canonical persisted record written by the central verifier — all
 * source-authored fields plus verifier-owned ones (`policy_version`,
 * `verification`, and the nested {@link RecordOverallVerdict}). Never authored
 * by source repos.
 *
 * Mirrors: dogfood-record.schema.json.
 *
 * Named `Record` to match the schema title; this shadows the TS global
 * `Record<K, V>` utility type WITHIN modules that import it, which is the
 * intended contract-first naming. Modules needing the utility can alias on
 * import (`import type { Record as DogfoodRecord }`).
 */
export interface Record {
  /** Semver of the persisted record schema. */
  schema_version: string;
  /** Semver of the policy this record was evaluated against. Set by verifier. */
  policy_version: string;
  run_id: string;
  repo: string;
  ref: Ref;
  source: Source;
  timing: Timing;
  ci_checks?: CiCheck[];
  scenario_results: ScenarioResult[];
  overall_verdict: RecordOverallVerdict;
  verification: Verification;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Finding — reviewed, evidence-backed lesson
// Mirrors: dogfood-finding.schema.json
// ---------------------------------------------------------------------------

/** Finding lifecycle status. Mirrors `status`. */
export type FindingStatus = 'candidate' | 'reviewed' | 'accepted' | 'rejected';

/** Where in the product experience the lesson was observed. Mirrors `journey_stage`. */
export type JourneyStage =
  | 'install'
  | 'setup'
  | 'first_run'
  | 'core_loop'
  | 'export'
  | 'publish'
  | 'recovery'
  | 'integration'
  | 'verification'
  | 'rollout';

/** What visibly went wrong. Mirrors `issue_kind`. */
export type IssueKind =
  | 'entrypoint_truth'
  | 'interface_assumption'
  | 'docs_drift'
  | 'schema_mismatch'
  | 'build_output_mismatch'
  | 'flag_contract_mismatch'
  | 'evidence_insufficiency'
  | 'evidence_overconstraint'
  | 'policy_mismatch'
  | 'freshness_miscalibration'
  | 'read_after_write_timing'
  | 'provenance_gap'
  | 'execution_mode_mismatch'
  | 'surface_misclassification'
  | 'ux_discoverability'
  | 'verification_gap'
  | 'dispatch_format'
  | 'concurrency_conflict'
  | 'process_lifecycle';

/** Why it actually happened. Mirrors `root_cause_kind`. */
export type RootCauseKind =
  | 'contract_drift'
  | 'docs_code_drift'
  | 'surface_misclassification'
  | 'missing_precondition'
  | 'policy_overconstraint'
  | 'policy_underconstraint'
  | 'build_config_error'
  | 'interface_assumption_error'
  | 'timing_race'
  | 'tooling_gap'
  | 'human_process_gap'
  | 'schema_alignment_failure'
  | 'dispatch_encoding_error'
  | 'process_model_mismatch';

/** What kind of fix resolved it. Mirrors `remediation_kind`. */
export type RemediationKind =
  | 'docs_change'
  | 'scenario_change'
  | 'policy_calibration'
  | 'schema_fix'
  | 'build_config_fix'
  | 'entrypoint_fix'
  | 'verification_fix'
  | 'classification_fix'
  | 'retry_logic'
  | 'evidence_requirement_change'
  | 'workflow_change'
  | 'dispatch_fix'
  | 'process_fix';

/**
 * How far the lesson should travel. Mirrors the finding `transfer_scope` enum
 * (the FULL 5-value set — NOT the deliberate 3-value doctrine subset).
 */
export type TransferScope =
  | 'repo_local'
  | 'surface_local'
  | 'surface_archetype'
  | 'execution_mode'
  | 'org_wide';

/** Type of evidence supporting a finding. Mirrors `evidence[].evidence_kind`. */
export type FindingEvidenceKind =
  | 'record'
  | 'scenario_result'
  | 'ci_check'
  | 'policy'
  | 'artifact'
  | 'doc'
  | 'rejection';

/** A structured evidence binding on a finding. Mirrors `evidence[]`. */
export interface FindingEvidence {
  evidence_kind: FindingEvidenceKind;
  /** Run ID of the source record. */
  record_id?: string;
  /** Scenario ID if evidence is from a scenario result. */
  scenario_id?: string;
  /** Path or URL to an artifact. */
  artifact_ref?: string;
  /** Path to the policy file. */
  policy_ref?: string;
  /** Path to a documentation file. */
  doc_ref?: string;
  /** Schema maxLength: 500. */
  note?: string;
}

/** Type of fix reference. Mirrors `fix_refs[].ref_kind`. */
export type FixRefKind =
  | 'commit'
  | 'pr'
  | 'doc'
  | 'policy_change'
  | 'scenario_change'
  | 'workflow_change';

/** A link to a concrete repair action. Mirrors `fix_refs[]`. */
export interface FixRef {
  ref_kind: FixRefKind;
  /** Commit SHA, PR URL, file path, etc. */
  ref: string;
  /** Schema maxLength: 500. */
  note?: string;
}

/** Derivation metadata — present when a finding was machine-generated. Mirrors `derived`. */
export interface FindingDerived {
  method: 'deterministic_rule';
  /** Pattern: `^rule-[a-z0-9][a-z0-9-]*$`. */
  rule_id: string;
  derived_at: string;
  /** Schema minLength: 10, maxLength: 1000. */
  rationale: string;
}

/** The most recent review action taken on a finding. Mirrors `review.last_action`. */
export type ReviewAction =
  | 'review'
  | 'accept'
  | 'reject'
  | 'edit'
  | 'merge'
  | 'reopen'
  | 'invalidate'
  | 'supersede';

/** Structured reject reason. Mirrors `review.reject_reason`. */
export type RejectReason =
  | 'insufficient_evidence'
  | 'duplicate'
  | 'classification_error'
  | 'not_portable'
  | 'noise'
  | 'source_truth_changed'
  | 'merged_into_canonical';

/** Current state of the most recent review action. Mirrors `review`. */
export interface FindingReview {
  reviewed_by?: string;
  reviewed_at?: string;
  /** Schema maxLength: 1000. */
  decision_reason?: string;
  /** Schema maxLength: 2000. */
  review_notes?: string;
  last_action?: ReviewAction;
  /**
   * Structured reject reason. The schema's `allOf` makes this REQUIRED when
   * `status` is `rejected` — that conditional cannot be expressed in a plain
   * interface, so callers building a rejected finding must populate it (the
   * runtime `validatePayload` check is what enforces the conditional).
   */
  reject_reason?: RejectReason;
}

/** Merge and supersession lineage. Mirrors `lineage`. */
export interface FindingLineage {
  /** Finding IDs merged into this canonical finding. */
  merged_from?: string[];
  /** Finding ID that supersedes this one. */
  superseded_by?: string;
}

/** Invalidation metadata — present when an accepted finding is no longer trustworthy. Mirrors `invalidation`. */
export interface FindingInvalidation {
  is_invalidated: boolean;
  invalidated_at: string;
  /** Review event ID that triggered the invalidation. */
  invalidated_by?: string;
  /** Schema minLength: 5, maxLength: 1000. */
  reason: string;
}

/**
 * A reviewed, evidence-backed lesson extracted from one or more dogfood runs —
 * the smallest durable unit of reusable learning. `product_surface` /
 * `execution_mode` reuse the sealed full-set enum unions.
 *
 * Mirrors: dogfood-finding.schema.json. The schema additionally enforces an
 * `allOf` conditional (status `rejected` ⇒ `review.reject_reason` required)
 * that is not expressible here; rely on `validatePayload('finding', …)` for it.
 */
export interface Finding {
  /** Semver of the finding schema. */
  schema_version: string;
  /** Stable slug. Pattern: `^dfind-[a-z0-9][a-z0-9-]*$`. */
  finding_id: string;
  /** Schema minLength: 10, maxLength: 200. */
  title: string;
  status: FindingStatus;
  /** Full org/repo. Pattern: `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`. */
  repo: string;
  product_surface: ProductSurface;
  execution_mode?: ExecutionMode;
  journey_stage: JourneyStage;
  issue_kind: IssueKind;
  root_cause_kind: RootCauseKind;
  remediation_kind: RemediationKind;
  transfer_scope: TransferScope;
  /** Schema minLength: 20, maxLength: 1000. */
  summary: string;
  /** Portable rule derived from this finding. Schema maxLength: 500. */
  doctrine_statement?: string;
  /** Schema maxLength: 2000. */
  notes?: string;
  /** Run IDs of the source records. Schema minItems: 1. */
  source_record_ids: string[];
  /** Scenario IDs relevant to this finding. */
  scenario_ids?: string[];
  /** Structured evidence binding. Schema minItems: 1 — a finding with no evidence is invalid. */
  evidence: FindingEvidence[];
  fix_refs?: FixRef[];
  created_at?: string;
  updated_at?: string;
  derived?: FindingDerived;
  review?: FindingReview;
  lineage?: FindingLineage;
  invalidation?: FindingInvalidation;
}

// ---------------------------------------------------------------------------
// Representative example payloads — the load-bearing compile-time seal.
//
// Each const is `satisfies`-checked against its interface. `tsc --build` (run
// by CI via `npm run verify` → `npm run build`) compiles this `src/` file, so
// any field that an interface declares but a representative payload cannot fill
// — or any interface field that drifts in type from the JSON schema's intent —
// turns the build RED here, at author time, not at a downstream consumer.
//
// `satisfies` (not a type annotation) keeps each const's literal type narrow
// AND asserts assignability to the interface, so an EXTRA property that the
// interface forbids is also a compile error. The companion vitest pushes these
// same values through `validatePayload` so the JSON schema independently agrees
// they are valid — drift on either side is caught.
//
// Values mirror the representative payloads already proven valid in
// test/validate.test.ts, so they share that file's known-good provenance.
// ---------------------------------------------------------------------------

const EXAMPLE_SUBMISSION = {
  schema_version: '1.0.0',
  run_id: 'run-01H8Y4ZC9XJWQ5N6',
  repo: 'dogfood-lab/testing-os',
  ref: { commit_sha: 'a'.repeat(40), branch: 'main' },
  source: {
    provider: 'github',
    workflow: 'dogfood.yml',
    provider_run_id: '12345',
    run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/12345',
  },
  timing: {
    started_at: '2026-04-26T18:00:00Z',
    finished_at: '2026-04-26T18:05:00Z',
  },
  scenario_results: [
    {
      scenario_id: 'cli-resolve-and-list',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [{ step_id: 'install', status: 'pass' }],
    },
  ],
  overall_verdict: 'pass',
} satisfies Submission;

const EXAMPLE_SCENARIO_RESULT = {
  scenario_id: 'cli-resolve-and-list',
  scenario_name: 'Resolve loadout and list its packages',
  scenario_version: '1.0.0',
  product_surface: 'cli',
  execution_mode: 'mixed',
  attested_by: 'human-attester-01',
  verdict: 'partial',
  step_results: [
    { step_id: 'install', status: 'pass' },
    { step_id: 'resolve', status: 'partial', notes: 'slow but completed' },
  ],
  evidence: [
    { kind: 'log', url: 'https://example.com/run.log' },
  ],
} satisfies ScenarioResult;

const EXAMPLE_RECORD = {
  schema_version: '1.0.0',
  policy_version: '1.0.0',
  run_id: 'run-01H8Y4ZC9XJWQ5N6',
  repo: 'dogfood-lab/testing-os',
  ref: { commit_sha: 'b'.repeat(40) },
  source: {
    provider: 'github',
    workflow: 'dogfood.yml',
    provider_run_id: '12345',
    run_url: 'https://github.com/dogfood-lab/testing-os/actions/runs/12345',
  },
  timing: {
    started_at: '2026-04-26T18:00:00Z',
    finished_at: '2026-04-26T18:05:00Z',
  },
  scenario_results: [
    {
      scenario_id: 'cli-resolve-and-list',
      product_surface: 'cli',
      execution_mode: 'bot',
      verdict: 'pass',
      step_results: [{ step_id: 'install', status: 'pass' }],
    },
  ],
  overall_verdict: { proposed: 'pass', verified: 'pass' },
  verification: {
    status: 'accepted',
    verified_at: '2026-04-26T18:06:00Z',
    provenance_confirmed: true,
    schema_valid: true,
    policy_valid: true,
  },
} satisfies Record;

const EXAMPLE_FINDING = {
  schema_version: '1.0.0',
  finding_id: 'dfind-testing-os-schemas-payload-types',
  title: 'Schemas package shipped no payload interfaces',
  status: 'accepted',
  repo: 'dogfood-lab/testing-os',
  product_surface: 'npm-package',
  journey_stage: 'verification',
  issue_kind: 'schema_mismatch',
  root_cause_kind: 'tooling_gap',
  remediation_kind: 'schema_fix',
  transfer_scope: 'org_wide',
  summary:
    'TS consumers of @dogfood-lab/schemas got no compile-time safety on the payload envelope; only validatePayload caught shape errors, at runtime.',
  source_record_ids: ['testing-os-fth-001'],
  evidence: [{ evidence_kind: 'doc', doc_ref: 'packages/schemas/src/payload-types.ts' }],
} satisfies Finding;

/**
 * Representative valid payloads, one per modelled interface. Exported so the
 * companion vitest can push them through `validatePayload` and assert the JSON
 * schema agrees — the runtime half of the FT-h drift seal. Consumers may also
 * import these as ready-made fixtures.
 *
 * The `as const` example bodies above are `satisfies`-checked against their
 * interfaces; here we widen to the interface types so the exported shape is the
 * interface (not a frozen literal) for downstream reuse.
 */
export const EXAMPLE_PAYLOADS: {
  submission: Submission;
  scenarioResult: ScenarioResult;
  record: Record;
  finding: Finding;
} = {
  submission: EXAMPLE_SUBMISSION,
  scenarioResult: EXAMPLE_SCENARIO_RESULT,
  record: EXAMPLE_RECORD,
  finding: EXAMPLE_FINDING,
};
