/**
 * Helper subprocess for event-log-race.test.js multi-process scenario.
 *
 * Forked once per parallel appender; each child appends ONE event tagged
 * with the unique id passed in argv[2]. The parent reads the resulting
 * YAML log and asserts every child's event landed.
 */

// Relative import: ingest cannot depend on findings (would create a
// workspace cycle with findings → ingest), so the helper reaches across
// the package boundary the same way the test does. See companion test for
// the full rationale.
import { appendEvent, createEvent } from '../findings/review/event-log.js';

const [, , rootDir, findingId] = process.argv;
if (!rootDir || !findingId) {
  console.error('usage: event-log-race.helper.mjs <rootDir> <findingId>');
  process.exit(2);
}

try {
  const event = createEvent({
    findingId,
    actor: 'race-test-fork',
    action: 'review',
    fromStatus: 'candidate',
    toStatus: 'reviewed',
  });
  appendEvent(rootDir, event);
  if (process.env.HELPER_DEBUG) {
    process.stderr.write(`helper[${findingId}] pid=${process.pid} appended OK\n`);
  }
  process.exit(0);
} catch (err) {
  console.error(`helper proc failed: ${err.message}`);
  process.exit(1);
}
