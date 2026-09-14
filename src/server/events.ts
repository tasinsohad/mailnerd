import { EventEmitter } from "events";

class JobEvents extends EventEmitter {}

// Pinned to globalThis, NOT a plain module-level `new JobEvents()`.
//
// This module is instantiated TWICE in one process: once via vite.config.ts's direct
// `import sseHandler from "./src/server/sse-node"` (Node's own module registry — that's what
// serves /api/sse) and once through Vite's SSR module graph (server fns like troubleshoot.ts).
// Two registries means two separate emitter objects, so anything a server fn publishes never
// reaches an SSE subscriber: the stream connects, then sits silent forever.
//
// globalThis is shared across both registries in the process, so this keeps them the same object.
// Same trick queue.ts already uses to stop the BullMQ Worker being constructed twice.
const g = globalThis as unknown as { __jobEvents?: JobEvents; __inProcessProvisions?: Set<string> };
export const jobEvents: JobEvents = g.__jobEvents ?? (g.__jobEvents = new JobEvents());
// Increase listener limit for safety in concurrent setups
jobEvents.setMaxListeners(100);

// Domain IDs whose server setup is running (or waiting for a slot) inside this process instead of on
// the BullMQ queue. Their logs go out on jobEvents only, so the SSE handler must listen here even if
// Redis is up. Pinned to globalThis for the same reason: queue.ts adds, sse-node.ts reads, and they
// load through different module registries.
export const inProcessProvisions: Set<string> =
  g.__inProcessProvisions ?? (g.__inProcessProvisions = new Set());
