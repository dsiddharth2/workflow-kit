// Claims a worker lock, announces it on stdout, and holds until SIGTERM.
// Used by tests/pool-worker-lock.test.mjs to prove cross-process exclusion.
import { tryClaim } from '../../pool/worker-lock.mjs';

const target = process.argv[2];
const release = await tryClaim(target);
if (!release) {
  console.log('busy');
  process.exit(1);
}
console.log('locked');

const shutdown = async () => {
  await release();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep the event loop alive without spinning.
setInterval(() => {}, 60000);
