import { normalizeOpaqueColor } from "./color.js";

/**
 * Rules of `askChoice` options and button backgrounds, each with one message: compile error `TSV029` where the compiler
 * sees the problem, and otherwise runtime error `TSR052`.
 */

export function isButtonBackground(value: unknown): boolean {
  return normalizeOpaqueColor(value) !== null;
}

/** `shown` is the value as the runtime shows it, or its type; `null` when neither is known. */
export function buttonBackgroundMessage(shown: string | null): string {
  return `A button background must be an opaque CSS colour, such as "#336699"${shown === null ? "" : `, but this is ${shown}`}.`;
}

export const EMPTY_CHOICE_MESSAGE =
  "A choice needs at least one button, but its option lists are empty.";

export const CHOICE_TEXT_MESSAGE = "A choice object needs a 'text' property to label its button.";

export const CHOICE_VALUES_MESSAGE =
  "This choice option has two values, one before ':' and one in its value property. Keep one.";

export function isChoiceObjectProperty(name: string): boolean {
  return name === "value" || name === "text" || name === "background";
}

export function choicePropertyMessage(name: string): string {
  return `A choice object can only have 'value', 'text', and 'background', but this one has '${name}'. Remove it.`;
}
