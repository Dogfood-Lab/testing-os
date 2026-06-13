/**
 * SUPPORTED_SCHEMA_VERSIONS — the single source of truth for which
 * `schema_version` values this build of testing-os accepts.
 *
 * F1-CONTRACTS-001 (Wave 2, HIGH). Every contract schema declares
 * `schema_version` as a pattern-only string (`^\d+\.\d+\.\d+$`) — it gates
 * SHAPE, not VALUE. Nothing compared a declared `schema_version` against a
 * supported set, so a submission declaring `schema_version: '2.0.0'` (or
 * `99.0.0`) validated clean against the live 1.x schema whenever its shape
 * happened to fit: a genuinely-incompatible future major was silently
 * mis-validated instead of cleanly refused.
 *
 * This map is the value consumers import (NOT a hand-copied literal):
 *   - `packages/verify` imports it to drive the `schema_version` VALUE gate
 *     (`validators/schema-version.js`) and to stamp the persisted record's
 *     `schema_version` (`record.current`) instead of a hardcoded `'1.0.0'`.
 *
 * Per registered contract: the `current` version plus the accepted MAJOR
 * range `[minMajor, maxMajor]`. The gate compares a payload's MAJOR against
 * that range — patch/minor deltas inside the range PASS; a major above
 * `maxMajor` means "this build is too old, upgrade testing-os"; a major below
 * `minMajor` means "re-emit against the current contract".
 *
 * Keys mirror `allSchemas` for the contracts that carry a `schema_version`
 * field, plus the `agentOutput` swarm envelope. `policy` and `scenario` do
 * NOT carry a `schema_version` contract field and are intentionally absent —
 * the gate only fires on payloads that declare a `schema_version`.
 */

export interface SupportedSchemaVersion {
  /** The current/canonical version this build emits for the contract. */
  current: string;
  /** Lowest MAJOR this build will accept (inclusive). Below → TOO_OLD. */
  minMajor: number;
  /** Highest MAJOR this build will accept (inclusive). Above → TOO_NEW. */
  maxMajor: number;
}

/**
 * The registered contract keys that carry a `schema_version`. `record` and
 * `recordSubmission` share the v1 record family; `agentOutput` is the swarm
 * agent-output envelope (validated separately at collect time, registered
 * here so a future versioned envelope has one home).
 */
export type SupportedSchemaContract =
  | 'record'
  | 'recordSubmission'
  | 'finding'
  | 'pattern'
  | 'recommendation'
  | 'doctrine'
  | 'agentOutput';

export const SUPPORTED_SCHEMA_VERSIONS: Record<
  SupportedSchemaContract,
  SupportedSchemaVersion
> = {
  record: { current: '1.0.0', minMajor: 1, maxMajor: 1 },
  recordSubmission: { current: '1.0.0', minMajor: 1, maxMajor: 1 },
  finding: { current: '1.0.0', minMajor: 1, maxMajor: 1 },
  pattern: { current: '1.0.0', minMajor: 1, maxMajor: 1 },
  recommendation: { current: '1.0.0', minMajor: 1, maxMajor: 1 },
  doctrine: { current: '1.0.0', minMajor: 1, maxMajor: 1 },
  agentOutput: { current: '1.0.0', minMajor: 1, maxMajor: 1 },
} as const;
