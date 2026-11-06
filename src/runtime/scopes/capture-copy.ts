import type { RuntimeCaptureSnapshot } from "./captures.js";

// A copy of a resource's captured variables, without the scope logic that resolves and retains them (`captures.ts`).

export function cloneCaptures(
  captures: readonly RuntimeCaptureSnapshot[],
): RuntimeCaptureSnapshot[] {
  return captures.map((capture) => ({ name: capture.name, scopeId: capture.scopeId }));
}
