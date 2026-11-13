// The written forms of a value the adapter case tables' templates enumerate, by the registry's kinds, and the variant
// and template shapes they build.

import type { DynamicWhy } from "../../../../src/type-inference/graph.js";
import { VALUE_KIND_NAMES, VALUE_KINDS, type ValueKind } from "../../../../src/value-kinds.js";

export interface Variant {
  readonly id: string;
  readonly prelude: readonly string[];
  readonly operation: string;
  /** The provenance of an operand the legacy cannot type: the dynamic view the adapter is given for it. */
  readonly why: DynamicWhy | null;
  /** The operation is written in a function whose untyped parameter `p` is called with this argument. */
  readonly call?: string;
  readonly stage5?: "Q1" | "Q2";
  readonly note?: string;
}

export interface Template {
  readonly id: string;
  readonly variants: () => Iterable<Variant>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The forms a value is written in, by the registry's kinds.

/** Two written values of each kind that has a literal, distinct so that two of them restrict a choice to both. */
const LITERALS: ReadonlyMap<ValueKind, readonly [string, string]> = new Map([
  ["integer", ["1", "2"]],
  ["number", ["1.5", "2.5"]],
  ["string", ['"a"', '"b"']],
  ["boolean", ["true", "false"]],
  ["null", ["null", "null"]],
  ["duration", ["1 s", "2 s"]],
  ["calendarDuration", ["1 calendar days", "2 calendar days"]],
  ["angle", ["90 deg", "45 deg"]],
  ["regex", ["/a/", "/b/"]],
  ["range", ["1..3", "2..4"]],
  ["list", ["[1]", "[2]"]],
  ["set", ["set [1]", "set [2]"]],
  ["dict", ['dict { "a": 1 }', 'dict { "b": 2 }']],
  ["object", ["{ a: 1 }", "{ b: 2 }"]],
]);

/** An expression that makes a value of a kind without a literal. */
const MADE: ReadonlyMap<ValueKind, string> = new Map([
  ["timer", "timer async 1 s"],
  ["media", 'playAudio async "a.mp3"'],
  ["messageHandle", 'say "hi"'],
  ["camera", "showCamera"],
  ["permanentButton", 'showPermanentButton "Stop" { exit }'],
]);

const SPEAKER = 'speaker guide {\n displayName: "Guide"\n}';

/** The expression each kind is made by in these tables: its first literal, or the expression that makes one. */
export const MADE_KINDS: ReadonlyMap<ValueKind, string> = new Map([
  ...[...LITERALS].map(([kind, pair]): [ValueKind, string] => [kind, pair[0]]),
  ...MADE,
  ["speaker", "guide"],
]);

/**
 * Kinds no written form of these tables makes, with the reason: the tables cover them only where an annotation names
 * them (`written`), and not at all otherwise.
 */
export const UNMADE_KINDS: ReadonlyMap<ValueKind, string> = new Map([
  ["script", "a script handle comes only from a catalog query; its annotation covers the kind"],
  ["date", "no literal; the annotation covers the kind"],
  ["time", "no literal; the annotation covers the kind"],
  ["datetime", "no literal; the annotation covers the kind"],
  ["absoluteDateTime", "no literal; the annotation covers the kind"],
]);

interface ValueForm {
  readonly form: "literal" | "variable" | "annotated" | "nullable";
  readonly prelude: readonly string[];
  readonly expression: string;
}

/** The written forms of one value of a kind: a literal, a variable holding one, an annotated host value, nullable. */
export function valueForms(kind: ValueKind): ValueForm[] {
  const forms: ValueForm[] = [];
  const literal = LITERALS.get(kind);
  if (literal !== undefined) {
    forms.push({ form: "literal", prelude: [], expression: literal[0] });
    // A `let` of `null` alone is an open slot the legacy decides later (`?null`), not a value of the kind.
    if (kind !== "null")
      forms.push({ form: "variable", prelude: [`let v = ${literal[0]}`], expression: "v" });
  }
  const made = MADE.get(kind);
  if (made !== undefined)
    forms.push({ form: "variable", prelude: [`let v = ${made}`], expression: "v" });
  if (kind === "speaker") forms.push({ form: "variable", prelude: [SPEAKER], expression: "guide" });
  if (VALUE_KINDS[kind].written) {
    forms.push({ form: "annotated", prelude: [`let v: ${kind} = hostValue`], expression: "v" });
    if (kind !== "null")
      forms.push({ form: "nullable", prelude: [`let v: ${kind}? = hostValue`], expression: "v" });
  }
  return forms;
}

/** The kinds a literal is written for, in registry order. */
export const LITERAL_KINDS: readonly ValueKind[] = VALUE_KIND_NAMES.filter((kind) =>
  LITERALS.has(kind),
);
export const WRITTEN_KINDS: readonly ValueKind[] = VALUE_KIND_NAMES.filter(
  (kind) => VALUE_KINDS[kind].written,
);

export function literal(kind: ValueKind, second = false): string {
  const pair = LITERALS.get(kind);
  if (pair === undefined) throw new Error(`no literal of ${kind}`);
  return second ? pair[1] : pair[0];
}

export function variant(
  id: string,
  prelude: readonly string[],
  operation: string,
  why: DynamicWhy | null = null,
  more: Partial<Pick<Variant, "call" | "stage5" | "note">> = {},
): Variant {
  return { id, prelude, operation, why, ...more };
}

/** The operation in a function whose parameter has no type: the legacy types it unknown; stage 5 types it per call (Q1 = C). */
export function parameterVariant(id: string, operation: string, call: string): Variant {
  return variant(id, [], operation, "host", {
    call,
    stage5: "Q1",
    note: "the legacy types an untyped parameter unknown in its body; with Q1 = C the view is each call's argument",
  });
}

export function pairs<T>(items: readonly T[], same: boolean): [T, T][] {
  const made: [T, T][] = [];
  items.forEach((left, i) =>
    items.forEach((right, j) => {
      if (j > i || (same && j === i)) made.push([left, right]);
    }),
  );
  return made;
}
