import { EventEmitter } from "events";

class JobEvents extends EventEmitter {}

export const jobEvents = new JobEvents();
// Increase listener limit for safety in concurrent setups
jobEvents.setMaxListeners(100);
