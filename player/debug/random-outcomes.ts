import type { RandomDrawView, RandomOutcome } from "../../src/index.js";
import { runtimeDebugPreview } from "../../src/runtime/debug/debug-preview.js";

/*
 * How Debug names a random draw's outcomes (DEBUGGER.md "Random draws"), in both realms: the picker shows them, and the
 * engine's host keeps each site's earlier outcomes by them (`random-decisions.ts`).
 */

/** An outcome's identity: the same value, index, or order is the same outcome. */
export function outcomeKey(outcome: RandomOutcome): string {
  return JSON.stringify(outcome);
}

/** A number as the picker shows it: a whole number in full, any other to six significant digits. */
export function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

/** An outcome of `draw` as the picker shows it: the value it gives, a candidate's value, or a shuffle's new order. */
export function randomOutcomeLabel(draw: RandomDrawView, outcome: RandomOutcome): string {
  const { support } = draw;
  switch (outcome.kind) {
    case "boolean":
      return String(outcome.value);
    case "number":
      return numberText(outcome.value);
    case "index": {
      const candidates =
        support.kind === "candidates" || support.kind === "weighted" ? support.candidates : [];
      const candidate = candidates[outcome.index];
      return candidate === undefined ? `#${outcome.index}` : runtimeDebugPreview(candidate).text;
    }
    case "order": {
      const items = support.kind === "order" ? support.items : [];
      return `[${outcome.order.map((index) => (items[index] === undefined ? `#${index}` : runtimeDebugPreview(items[index]).text)).join(", ")}]`;
    }
  }
}
