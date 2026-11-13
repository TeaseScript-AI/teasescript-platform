import type { LanguageTokenClass } from "../../src/index.js";

/*
 * The code Debug's random-draw picker shows of a draw's file, as plain data: the engine host makes it
 * (`random-draw-code.ts`), and the Player's page shows it (`vue/src/debug/random/randomDrawPresentation.ts`).
 */

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
