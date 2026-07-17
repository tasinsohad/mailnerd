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
const g = globalThis as unknown as { __jobEvents?: JobEvents };
export const jobEvents: JobEvents = g.__jobEvents ?? (g.__jobEvents = new JobEvents());
// Increase listener limit for safety in concurrent setups
jobEvents.setMaxListeners(100);
