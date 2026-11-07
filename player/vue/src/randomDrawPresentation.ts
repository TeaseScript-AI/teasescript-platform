import type { LanguageTokenClass, RandomDrawView, RandomOutcome } from "../../../src/index.js";
import { checkedOutcome } from "../../../src/runtime/random/random-kinds.js";
import { randomDrawAlternatives } from "../../../src/runtime/random/random-alternatives.js";
import { runtimeDebugPreview } from "../../../src/runtime/debug/debug-preview.js";
import { numberText as text, randomOutcomeLabel } from "../../random-outcomes.js";

/**
 * How the random draw picker (DEBUGGER.md "Random draws") offers a draw's outcomes: a button for each when the draw has
 * few, a number field for a continuous draw or a large range, and a list to reorder for a shuffle. Which outcomes a draw
 * takes is the engine's: `randomDrawAlternatives` lists them when they are few, and `checkedOutcome` checks a typed one.
 */
export type RandomDrawChoices =
  | { readonly kind: "buttons"; readonly outcomes: readonly RandomDrawButton[] }
  | {
      readonly kind: "number";
      readonly integer: boolean;
      readonly hint: string;
      /** Why the draw does not take `value`, in the engine's words, or `null` when it does. */
      readonly refusal: (value: number) => string | null;
    }
  | { readonly kind: "order"; readonly items: readonly string[] };

export interface RandomDrawButton {
  readonly outcome: RandomOutcome;
  readonly label: string;
}

export function randomDrawChoices(draw: RandomDrawView): RandomDrawChoices {
  const { support } = draw;
  if (support.kind === "order")
    return { kind: "order", items: support.items.map((item) => runtimeDebugPreview(item).text) };
  // A pick offers every candidate it can draw, however many.
  const limit =
    support.kind === "candidates" || support.kind === "weighted"
      ? support.candidates.length
      : undefined;
  const { alternatives, complete } = randomDrawAlternatives(draw, limit);
  const field = (hint: string, integer = false): RandomDrawChoices => ({
    kind: "number",
    integer,
    hint,
    refusal: (value) => {
      const checked = checkedOutcome(support, { kind: "number", value });
      return typeof checked === "string" ? checked : null;
    },
  });
  if (!complete)
    switch (support.kind) {
      // The draw's number counts in the unit its script wrote, which the draw does not carry.
      case "integer":
        return field(`Whole number from ${text(support.min)} through ${text(support.max)}.`, true);
      case "unit":
        return field("From 0 up to, but not including, 1.");
      case "normal": {
        const { mean, spread } = support;
        return field(
          `Any finite number. Suggested: ${text(mean - 3 * spread)} to ${text(mean + 3 * spread)}.`,
        );
      }
      case "beta":
        return field("From 0 through 1.");
      case "pert":
        return field(`From ${text(support.min)} through ${text(support.max)}.`);
    }
  // Every outcome the engine lists: the natural result and the alternatives, in the order of their values.
  const outcomes =
    draw.natural.kind === "failure" ? [...alternatives] : [draw.natural, ...alternatives];
  return {
    kind: "buttons",
    outcomes: outcomes
      .sort((left, right) => rank(left) - rank(right))
      .map((outcome) => ({ outcome, label: randomOutcomeLabel(draw, outcome) })),
  };
}

/** Where an outcome stands among a draw's buttons: true before false, numbers and candidates in their order. */
function rank(outcome: RandomOutcome): number {
  switch (outcome.kind) {
    case "boolean":
      return outcome.value ? 0 : 1;
    case "number":
      return outcome.value;
    case "index":
      return outcome.index;
    case "order":
      return 0;
  }
}

/** What a stretch of code is, for its colour: the compiler's class of its token or comment (`classifyTokens`). */
export type CodeTokenClass = LanguageTokenClass;

export interface CodeSegment {
  readonly text: string;
  readonly kind: CodeTokenClass | null;
  /** Whether the segment is marked, as the draw is. */
  readonly mark: boolean;
}

export interface CodeLine {
  /** One-based. */
  readonly number: number;
  readonly segments: readonly CodeSegment[];
}

/** How many lines the code around a draw shows by default: the draw's line in the middle. */
export const CONTEXT_ROWS = 7;

/** What the picker shows of the draw's file: every line with the draw marked, and the range "Show whole" fits. */
export interface DrawCode {
  readonly lines: readonly CodeLine[];
  readonly enclosing: {
    readonly kind: "function" | "block" | "file";
    readonly from: number;
    readonly to: number;
  } | null;
}
