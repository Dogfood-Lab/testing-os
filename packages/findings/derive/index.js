/**
 * Derivation engine exports.
 */
export { deriveFromRecord, deriveFromRecordWithErrors, deriveFromRecords, getRuleInventory, RULES } from './derive-findings.js';
export { generateFindingId, computeDedupeKey } from './ids.js';
export { dedupeWithinBatch, dedupeAgainstExisting } from './dedupe.js';
export { loadRecordsForRepo, loadRecordById, loadAllRecords } from './load-records.js';
export { writeFinding, writeFindings } from './write-findings.js';
export { getRuleById } from './rules.js';
