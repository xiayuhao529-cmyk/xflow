/**
 * Worker-only entrypoint.
 *
 * Production recommended:
 * - Web/API process:   RUN_WORKERS=0 (default), DISABLE_HTTP=0 (default)
 * - Worker process:    RUN_WORKERS=1, DISABLE_HTTP=1
 *
 * Both processes should point to the same MongoDB and Redis.
 */

process.env.RUN_WORKERS = process.env.RUN_WORKERS || "1";
process.env.DISABLE_HTTP = process.env.DISABLE_HTTP || "1";

require("./server");

