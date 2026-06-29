/**
 * correlation-id.js — shared coordination-stage correlation-id minter.
 *
 * PH-DS-02 leaf-helper extraction. The five coordination commands (dispatch,
 * collect, resume, rewind, redrive) each minted a synthetic correlation_id
 * for their logStage breadcrumbs so a single `grep` of `coord-<ts>-<rand>`
 * ties one failure across stderr lines (the FT-PIPELINE-004 forensic-anchor
 * pattern). dispatch/collect/resume used `randomBytes(2).toString('hex')`;
 * rewind/redrive had drifted to `Math.random().toString(36).slice(2, 6)` — a
 * different-width, non-crypto, non-hex tail in the very field the operator
 * greps. This module is the single source of truth, mirroring the
 * atomic-write.js / log-stage.js single-purpose leaf-helper pattern: small
 * enough that a future "fold into @dogfood-lab/shared" refactor is mechanical.
 *
 * Format: `coord-<base36-millis>-<4 lowercase hex>`. The `coord-` prefix
 * distinguishes coordination-command events from the ingest pipeline's
 * `ing-<...>` ids so a single grep tells the operator which side of the
 * contract emitted the event.
 *
 * @returns {string}
 */
import { randomBytes } from 'node:crypto';

export function mintCorrelationId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `coord-${ts}-${rand}`;
}
