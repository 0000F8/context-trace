/**
 * Tiny CLI harness for test/counter-lock.test.mjs: calls the adapter's
 * exported `nextIndex(sessionId)` and prints the result as JSON, then exits.
 * Run as a genuinely separate OS process (not just a separate in-process
 * async call) so the counter-lock test exercises real cross-process
 * contention on the counter file, which is exactly the race the lock has to
 * prevent — two hook processes launched by Claude Code at nearly the same
 * moment, not two async calls interleaving inside one process.
 *
 * Importing capture.mjs does not run its hook logic: `main()` only
 * auto-invokes when capture.mjs is the process's entrypoint.
 */
import { nextIndex } from '../capture.mjs';

const sessionId = process.argv[2];
const index = await nextIndex(sessionId);
process.stdout.write(JSON.stringify({ index }));
