/**
 * Contract enums — the single source of truth for the three FULL-SET enums
 * that the contract JSON schemas declare identically across multiple files.
 *
 * F1-CONTRACTS-002 (Wave 4, MED). Three full-set enums are hand-maintained as
 * identical literal arrays across the contract schema JSON documents:
 *
 *   - product_surface  ["cli","desktop","web","api","mcp-server",
 *                        "npm-package","plugin","library"]   — 7 files
 *   - execution_mode   ["bot","human","mixed"]               — 7 files
 *   - evidence-kind    ["log","screenshot","recording",
 *                        "transcript","artifact","other"]    — 4 files
 *
 * `stageC-cross-contract-enum-seal.test.ts` DETECTS drift between those JSON
 * copies, but nothing EXPORTS the sets as importable values. A consumer that
 * wants to render the surface picker, validate a CLI `--surface` flag, or
 * iterate the evidence kinds had to hand-copy the array — a fresh drift source
 * the seal cannot see.
 *
 * These constants are the value consumers import (NOT a hand-copied literal),
 * mirroring `SUPPORTED_SCHEMA_VERSIONS` in `src/schema-versions.ts`:
 *   - downstream packages import the set instead of re-typing it;
 *   - the seal test asserts each JSON-schema enum EQUALS the matching constant,
 *     converting drift-detect into single-source ENFORCEMENT — a JSON enum that
 *     diverges from the constant here goes RED.
 *
 * SCOPE — FULL-SET enums only. `doctrine.transfer_scope` is a DELIBERATE
 * 3-value subset (["surface_archetype","execution_mode","org_wide"]) of the
 * 5-value `transfer_scope` carried by finding/recommendation/pattern, and is
 * intentionally NOT exported here as a sealed full-set enum — the seal must
 * leave it alone.
 *
 * `as const` keeps the literal element types and freezes member order, so the
 * arrays double as `readonly` tuples for `typeof PRODUCT_SURFACES[number]`
 * union derivation downstream.
 */

/**
 * The full set of product surfaces a tested artifact can target. Order matches
 * the contract JSON enums byte-for-byte (the seal asserts sorted-set identity,
 * but consumers that render a picker get a stable, intentional order).
 */
export const PRODUCT_SURFACES = [
  'cli',
  'desktop',
  'web',
  'api',
  'mcp-server',
  'npm-package',
  'plugin',
  'library',
] as const;

/** How the work under test was executed. */
export const EXECUTION_MODES = ['bot', 'human', 'mixed'] as const;

/** The kinds of evidence a record may carry. */
export const EVIDENCE_KINDS = [
  'log',
  'screenshot',
  'recording',
  'transcript',
  'artifact',
  'other',
] as const;

/** Union of the eight product surfaces. */
export type ProductSurface = (typeof PRODUCT_SURFACES)[number];
/** Union of the three execution modes. */
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
/** Union of the six evidence kinds. */
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
