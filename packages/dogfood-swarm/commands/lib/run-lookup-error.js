/**
 * Typed run/wave lookup failures for coordinator-readable verbs.
 *
 * Plain Error + `.code`/`.hint`/`.runId` — same convention as
 * roadmapError / thresholdError — so renderTopLevelError prints
 * `ERROR [<CODE>]:` plus a Next: line without needing a new class or
 * deriveHintForCode case in lib/error-render.js (swarm-cp-core).
 *
 * Sibling: dispatch's DISPATCH_RUN_NOT_FOUND (DispatchPreconditionError).
 * These CLI_* codes cover status/receipt/verify(+verify-*)/adjudicate/
 * collect/revalidate, which previously threw bare untyped Errors.
 */

export const CLI_RUN_NOT_FOUND = 'CLI_RUN_NOT_FOUND';
export const CLI_NO_WAVES = 'CLI_NO_WAVES';

const RUN_NOT_FOUND_HINT =
  'check `swarm runs` for the correct run id, or `swarm init <repo>` to create a fresh run';

/**
 * @param {string} runId
 * @param {string} [message]
 * @returns {Error}
 */
export function runNotFoundError(runId, message) {
  const e = new Error(message ?? `Run not found: ${runId}`);
  e.code = CLI_RUN_NOT_FOUND;
  e.runId = runId;
  e.hint = RUN_NOT_FOUND_HINT;
  return e;
}

/**
 * @param {string} runId
 * @param {string} [message]
 * @returns {Error}
 */
export function noWavesError(runId, message) {
  const e = new Error(message ?? `No waves found for run ${runId}`);
  e.code = CLI_NO_WAVES;
  e.runId = runId;
  e.hint =
    `run \`swarm dispatch ${runId} <phase>\` to create the first wave, or check \`swarm runs\` / \`swarm status ${runId}\``;
  return e;
}
