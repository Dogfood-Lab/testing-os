/**
 * agent-bearing.js — domains that receive an agent_run at dispatch.
 *
 * `shared` is a zone (never dispatched). `coordinator` is exclusive AND
 * skipped at dispatch (GitHub #67 / F-2710aadf): the coordinator authors
 * amends for that surface; seeding an agent would both race the coordinator
 * and make the class redundant with shared. Owned + bridge remain agent-bearing.
 *
 * One predicate, every filter site (dispatch / collect coverage /
 * revalidate coverage / dry-run preview). Callers must not invent a third
 * "skip anything that isn't owned|bridge" rule — that would drop future
 * classes the schema has not named yet.
 */

/**
 * @param {{ ownership_class?: string }} domain
 * @returns {boolean}
 */
export function isAgentBearingDomain(domain) {
  return domain.ownership_class !== 'shared'
    && domain.ownership_class !== 'coordinator';
}
