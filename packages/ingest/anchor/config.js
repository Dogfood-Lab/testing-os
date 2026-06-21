/**
 * Anchor configuration — network defaults and the trusted-anchor-account
 * allowlist (the authorization root for verification).
 *
 * Any funded XRPL wallet can post a memo, so the trust does not come from the
 * memo — it comes from REQUIRING the posting account to be on an allowlist the
 * verifier controls. BUNDLED_TRUSTED_ACCOUNTS is pinned here so that even if a
 * future config file is fetched/overridden remotely, the account check can never
 * be silently turned off: the resolver UNIONs the bundled list with any
 * operator-supplied accounts (a remote config can ADD, never DROP).
 *
 * The allowlist starts EMPTY by design: testing-os has not minted a production
 * anchor wallet yet. An operator adds their funded wallet's classic address here
 * (and/or passes it via the CLI) when they stand up real anchoring. Verification
 * with an empty allowlist correctly FAILS the on-chain leg — fail closed, never
 * trust an unlisted account.
 */

/** Bundled allowlist — pinned, can never be dropped by a remote override. */
export const BUNDLED_TRUSTED_ACCOUNTS = Object.freeze([]);

/** Default network and endpoints. testnet is the default; mainnet is documented. */
export const ANCHOR_DEFAULTS = Object.freeze({
  network: 'testnet',
  wsUrl: {
    testnet: 'wss://s.altnet.rippletest.net:51233',
    mainnet: 'wss://xrplcluster.com',
  },
  memoType: 'testing-os-anchor-v1',
});

/**
 * Resolve the trusted anchor accounts: the bundled fallback UNION any
 * operator-supplied accounts. The bundled list can never be removed, so an
 * operator-supplied list can only ADD authorized accounts, never disable the
 * check.
 *
 * @param {string[]} [operatorAccounts] - Accounts supplied via CLI/config.
 * @returns {string[]} The de-duplicated union.
 */
export function resolveTrustedAccounts(operatorAccounts = []) {
  const extra = Array.isArray(operatorAccounts) ? operatorAccounts : [];
  return [...new Set([...BUNDLED_TRUSTED_ACCOUNTS, ...extra])];
}
