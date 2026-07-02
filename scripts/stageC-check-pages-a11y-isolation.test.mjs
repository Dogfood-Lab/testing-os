/**
 * Structural regression pins for .github/workflows/pages.yml
 * (F-32c517c4 — the wave-2 F-a52776d5 fix had no pin; F-bc123f41 — the verify
 * step's inline interpolation broke the file's own env-hoist discipline).
 *
 * F-a52776d5 — pa11y runs `npx -y pa11y@<pin>`, whose transitive
 * puppeteer/chromium chain installs unpinned at run time with no lockfile. It
 * used to run INSIDE the deploy job, so a supply-chain compromise executed
 * under `pages: write` + `id-token: write`. The fix moved it into a dedicated
 * `a11y` job with `permissions: {}` (job-scoped, permissionless token) gated
 * on the deploy job's verified `page_url` output. Nothing pinned that shape:
 * a future edit moving pa11y back into the deploy job (or dropping the empty
 * permissions block) would pass every gate and silently reopen the
 * elevated-token exposure. These tests go RED on that revert.
 *
 * F-bc123f41 — the deploy job's verify step inline-interpolated
 * `${{ steps.deployment.outputs.page_url }}` into its shell body while the
 * sibling a11y step env-hoisted the SAME value citing the CWE-78 discipline.
 * The value is trusted (it comes from GitHub's own deploy-pages action), but
 * a file demonstrating both the hardened and unhardened pattern for one
 * variable is how the antipattern gets copy-pasted into a step where the
 * value IS attacker-influenced. Pin: no `${{ }}` interpolation inside any
 * `run:` body in this workflow.
 *
 * Why text/structure assertions and not a YAML parse: same rationale as
 * stageC-check-release-resilience.test.mjs — no YAML dependency for one
 * fixture; the job sections are extracted by indentation, which tracks the
 * real file.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pagesPath = resolve(repoRoot, '.github/workflows/pages.yml');

/**
 * Extract the full section of the job named `jobName` (the lines from
 * `  <jobName>:` up to the next 2-space-indented job key or EOF).
 */
function extractJob(yamlText, jobName) {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^  ${jobName}:\\s*$`).test(l));
  assert.ok(start >= 0, `could not find job "${jobName}" in pages.yml`);
  const body = [lines[start]];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^  \S/.test(lines[j])) break; // next job key at the same indent
    body.push(lines[j]);
  }
  return body.join('\n');
}

test('pages.yml exists', () => {
  assert.ok(existsSync(pagesPath), `expected workflow at ${pagesPath}`);
});

test('F-a52776d5 pin (F-32c517c4): the pa11y step lives in a dedicated job with an EMPTY permissions block', () => {
  const yaml = readFileSync(pagesPath, 'utf8');
  const a11y = extractJob(yaml, 'a11y');
  assert.match(
    a11y,
    /\bpa11y@\d/,
    'the a11y job must be where pa11y runs — if the invocation moved elsewhere this pin is aimed at the wrong job',
  );
  assert.match(
    a11y,
    /^    permissions:\s*\{\}\s*$/m,
    'the a11y job must declare `permissions: {}` — pa11y\'s unpinned transitive chromium chain must execute with a PERMISSIONLESS token, not the workflow-level pages:write + id-token:write (F-a52776d5)',
  );
  assert.match(
    a11y,
    /^    needs:\s*deploy\s*$/m,
    'the a11y job must gate on the deploy job (`needs: deploy`) so it only probes a verified deploy (F-a52776d5)',
  );
});

test('F-a52776d5 pin (F-32c517c4): pa11y does NOT run inside the elevated deploy job, which exposes the verified page_url output', () => {
  const yaml = readFileSync(pagesPath, 'utf8');
  const deploy = extractJob(yaml, 'deploy');
  assert.doesNotMatch(
    deploy,
    /\bpa11y@/,
    'pa11y must NOT run inside the deploy job — that job holds the workflow-level pages:write + id-token:write scope the F-a52776d5 restructure isolated pa11y from',
  );
  assert.match(
    deploy,
    /outputs:[\s\S]*page_url:\s*\$\{\{\s*steps\.verify\.outputs\.page_url\s*\}\}/,
    'the deploy job must expose the VERIFIED page_url (from the verify step, written only on a 2xx probe) so the a11y job can consume it without elevated scope',
  );
});

test('F-bc123f41: no `run:` body in pages.yml inline-interpolates a ${{ }} expression (env-hoist discipline holds file-wide)', () => {
  const yaml = readFileSync(pagesPath, 'utf8');
  const lines = yaml.split(/\r?\n/);
  // Walk each `run: |` block and flag any ${{ }} inside its body. Values must
  // be hoisted through `env:` so the shell sees a plain variable — one
  // pattern for the whole file, no unhardened template to copy-paste.
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      if (line.match(/^(\s*)/)[1].length <= indent) break; // block ended
      if (/\$\{\{/.test(line)) offenders.push(`${j + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `pages.yml run: bodies must not inline-interpolate \${{ }} — hoist through env: instead (CWE-78 discipline, F-bc123f41):\n${offenders.join('\n')}`,
  );
});
