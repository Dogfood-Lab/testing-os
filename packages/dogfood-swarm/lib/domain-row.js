/**
 * domain-row.js — The single renderer for a domain-map row.
 *
 * The same domain-map entity (name + ownership_class + description) used to
 * render in four visibly different layouts across `swarm domains` (three code
 * paths) and `swarm status`: the three cli.js paths put the ownership class in
 * trailing parens after the name, while status.js put it in a LEADING padded
 * column — so the class jumped position between two commands operators read
 * back-to-back. This helper picks the more information-dense cli.js form
 * (`[FROZEN]/[DRAFT ] name (class) — desc`, carrying per-row frozen state) and
 * is the sole renderer both surfaces call, so the ownership-class placement
 * and the frozen/draft marker are identical wherever a domain list prints.
 *
 * @param {object} domain — { name, ownership_class, description }
 * @param {object} [opts]
 * @param {boolean} [opts.frozen] — per-row frozen state; renders the
 *   [FROZEN]/[DRAFT ] bracket. Omit to render no bracket column (the
 *   `--dry-run` matched-files path, which has no frozen state yet).
 * @param {string} [opts.trailer] — text after the ` — ` separator; defaults to
 *   the domain description.
 * @returns {string} — one indented row (no trailing newline).
 */
export function formatDomainRow(domain, opts = {}) {
  const cls = domain.ownership_class ?? domain.ownership;
  const head = `${domain.name} (${cls})`;
  const trailerText = opts.trailer ?? domain.description;
  const trailer = trailerText ? ` — ${trailerText}` : '';

  if (opts.frozen === undefined) {
    return `  ${head}${trailer}`;
  }
  const marker = opts.frozen ? 'FROZEN' : 'DRAFT';
  return `  [${marker.padEnd(6)}] ${head}${trailer}`;
}
