import type { RuntimeOperationResult } from "../../src/runtime/engine.js";

export function sayTexts(result: RuntimeOperationResult): string[] {
  return result.events.filter((event) => event.kind === "say").map((event) => event.text);
}
