import type { Expression } from "../../src/ast.js";
import { PERSON_FIELDS } from "../../src/speaker-terms.js";
import type {
  ChoiceElementEvidence,
  ChoiceObjectEvidence,
  DynamicWhy,
  PlaceId,
} from "../../src/type-inference/graph.js";
import { VALUE_KIND_NAMES, VALUE_KINDS, type ValueKind } from "../../src/value-kinds.js";
import { caseInputs, type CaseInputs } from "./adapter-case-inputs.js";
import { isClosedFact, legacyOperation, type LegacyOutcome } from "./adapter-parity.js";

/**
 * The case tables of the branched routines of the legacy checker (O4 stage 2b, work note §6.6): `askChoice`,
 * `askForm`, the list functions over values and selectors, `linearRegression` and `predict`. Each routine's table is
 * enumerated here from templates over the registry's kinds and the written forms of an operand, and every row is
 * pinned by the legacy oracle: its fact, the errors at the operation and elsewhere, and the operands' facts. The class
 * of a row is declared by `classify` from the row's shape and the variant's declarations, never guessed from the fact
 * alone; a row whose answer changes on purpose at stage 5 is marked `stage5` and asserts no adapter answer.
 *
 * The tables are written to `tests/fixtures/type-inference/adapter-cases/<routine>.jsonl` and compared with what
 * this module generates, so that a table cannot drift from the oracle or from the templates.
 */

export type RoutineName = "choice" | "form" | "values" | "regression" | "prediction" | "commands";

export type CaseClass =
  /** A closed fact without an error: the adapter realizes it. */
  | "fact"
  /** A closed fact with an error at the operation: the check reports and still types; the adapter realizes the fact. */
  | "recovery"
  /** An error at the operation and no fact: the operation has no value. */
  | "invalid"
  /** No fact and no error: the compiler cannot know, from an operand's provenance or the legacy's own limit. */
  | "dynamic"
  /** A legacy fact that stage 5 changes on purpose (owner decisions Q1 and Q2): pinned, not required. */
  | "legacy"
  /** An operand holds a slot that saw only null, which the legacy has not decided: the solver's case, not a relation's. */
  | "open";

export type AdapterCell =
  "fact" | "invalid" | { readonly dynamic: DynamicWhy } | { readonly realized: string } | null;

export interface CaseRow {
  /** `<routine>/<template>/<variant>`. */
  readonly id: string;
  readonly source: string;
  /** The legacy's fact at the operation: a type text, or `unknown`. */
  readonly fact: string;
  /** Where the fact was read when not at the expression itself: the binding, for an expression the check records no type for. */
  readonly factFrom?: "binding";
  /** The error codes the operation reports, in order: those inside its span that are not an operand's own. */
  readonly errors: readonly string[];
  /** The error codes an operand reports on its own, such as a list literal that mixes kinds. */
  readonly operandErrors: readonly string[];
  readonly elsewhere: readonly string[];
  /** The facts of the operation's operands, in source order: the options, or the arguments. */
  readonly operands: readonly string[];
  readonly class: CaseClass;
  readonly adapter: AdapterCell;
  /** Why an operand the legacy cannot type is dynamic: the view the adapter is given for it. */
  readonly why: DynamicWhy | null;
  /** The messages of the operation's own errors, in order, by which the invalidating reports (§6.6) are told apart. */
  readonly messages: readonly string[];
  readonly stage5?: "Q1" | "Q2";
  readonly note?: string;
}

/** A generated row with the oracle's outcome and the relation's inputs, so that a test asserts the row as generated. */
export interface GeneratedRow {
  readonly row: CaseRow;
  readonly outcome: LegacyOutcome;
  readonly inputs: CaseInputs;
}

interface Variant {
  readonly id: string;
  readonly prelude: readonly string[];
  readonly operation: string;
  /** The provenance of an operand the legacy cannot type, and of a result it cannot type without an error. */
  readonly why: DynamicWhy | null;
  /** The operation is written in a function whose untyped parameter `p` is called with this argument. */
  readonly call?: string;
  readonly stage5?: "Q1" | "Q2";
  readonly note?: string;
}

interface Template {
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
function valueForms(kind: ValueKind): ValueForm[] {
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
const LITERAL_KINDS: readonly ValueKind[] = VALUE_KIND_NAMES.filter((kind) => LITERALS.has(kind));
const WRITTEN_KINDS: readonly ValueKind[] = VALUE_KIND_NAMES.filter(
  (kind) => VALUE_KINDS[kind].written,
);

function literal(kind: ValueKind, second = false): string {
  const pair = LITERALS.get(kind);
  if (pair === undefined) throw new Error(`no literal of ${kind}`);
  return second ? pair[1] : pair[0];
}

function variant(
  id: string,
  prelude: readonly string[],
  operation: string,
  why: DynamicWhy | null = null,
  more: Partial<Pick<Variant, "call" | "stage5" | "note">> = {},
): Variant {
  return { id, prelude, operation, why, ...more };
}

/** The operation in a function whose parameter has no type: the legacy types it unknown; stage 5 types it per call (Q1 = C). */
function parameterVariant(id: string, operation: string, call: string): Variant {
  return variant(id, [], operation, "host", {
    call,
    stage5: "Q1",
    note: "the legacy types an untyped parameter unknown in its body; with Q1 = C the view is each call's argument",
  });
}

function pairs<T>(items: readonly T[], same: boolean): [T, T][] {
  const made: [T, T][] = [];
  items.forEach((left, i) =>
    items.forEach((right, j) => {
      if (j > i || (same && j === i)) made.push([left, right]);
    }),
  );
  return made;
}

// ---------------------------------------------------------------------------------------------------------------------
// askChoice

const LABELS: readonly (readonly [string, string])[] = [
  ["plain", ""],
  ["name", "one: "],
  ["integer", "1: "],
  ["number", "1.5: "],
];

const CHOICE_TEMPLATES: readonly Template[] = [
  {
    id: "option",
    *variants() {
      for (const kind of VALUE_KIND_NAMES)
        for (const value of valueForms(kind))
          for (const [label, prefix] of LABELS)
            yield variant(
              `${kind}.${value.form}.${label}`,
              value.prelude,
              `askChoice ${prefix}${value.expression}`,
            );
      for (const [label, prefix] of LABELS)
        yield variant(`host.${label}`, [], `askChoice ${prefix}hostValue`, "host");
      yield parameterVariant("parameter", "askChoice p", '"a"');
    },
  },
  {
    id: "written-collection",
    *variants() {
      for (const kind of LITERAL_KINDS) {
        yield variant(`${kind}.one`, [], `askChoice [${literal(kind)}]`);
        yield variant(`${kind}.two`, [], `askChoice [${literal(kind)}, ${literal(kind, true)}]`);
        yield variant(`${kind}.set`, [], `askChoice set [${literal(kind)}, ${literal(kind)}]`);
        if (kind !== "null")
          yield variant(`${kind}.variable`, [`let v = ${literal(kind)}`], "askChoice [v]");
        yield variant(
          `${kind}.object-value`,
          [],
          `askChoice [{ text: "A", value: ${literal(kind)} }]`,
        );
        yield variant(`${kind}.object-text`, [], `askChoice [{ text: ${literal(kind)} }]`);
        yield variant(`${kind}.labelled`, [], `askChoice one: [${literal(kind)}]`);
      }
      for (const [left, right] of pairs(LITERAL_KINDS, false))
        yield variant(
          `mixed.${left}.${right}`,
          [],
          `askChoice [${literal(left)}, ${literal(right)}]`,
        );
      for (const kind of WRITTEN_KINDS)
        yield variant(`${kind}.annotated`, [`let v: ${kind} = hostValue`], "askChoice [v]");
      yield variant("nullable", ["let v: integer? = hostValue"], "askChoice [v]");
      yield variant("object-value-only", [], "askChoice [{ value: 1 }]");
      yield variant(
        "object-value-and-text",
        [],
        'askChoice [{ text: "A", value: 1 }, { text: "B" }]',
      );
      yield variant("object-extra", [], 'askChoice [{ text: "A", value: 1, extra: 2 }]');
      yield variant("object-background", [], 'askChoice [{ text: "A", background: "#fff" }]');
      yield variant("object-text-host", [], "askChoice [{ text: hostText }]", "host");
      yield variant("object-value-host", [], 'askChoice [{ text: "A", value: hostValue }]', "host");
      yield variant("computed-object-value", ['let o = { text: "A", value: 1 }'], "askChoice [o]");
      yield variant("computed-object-text", ['let o = { text: "A" }'], "askChoice [o]");
      yield variant(
        "computed-object-labelled",
        ['let o = { text: "A", value: 1 }'],
        "askChoice one: [o]",
      );
      yield variant("host-element", [], "askChoice [hostValue]", "host");
      yield variant("host-element-labelled", [], "askChoice one: [hostValue]", "host");
      yield variant("nested", [], "askChoice [[1]]");
      yield variant("empty", [], "askChoice []");
      yield variant("empty-labelled", [], "askChoice one: []");
      yield variant("empty-set", [], "askChoice set []");
      yield variant("empty-and-value", [], 'askChoice gone: [], only: "Only"');
      yield variant("two-lists", [], 'askChoice [1, 2], ["a"]');
      yield variant("two-lists-labelled", [], "askChoice 1: [1], 2: [2]");
      yield variant("list-and-value", [], 'askChoice [1], "a"');
    },
  },
  {
    id: "computed-collection",
    *variants() {
      for (const kind of WRITTEN_KINDS) {
        yield variant(`${kind}.list`, [`let xs: ${kind}[] = hostValue`], "askChoice xs");
        yield variant(
          `${kind}.list.labelled`,
          [`let xs: ${kind}[] = hostValue`],
          "askChoice 7: xs",
        );
        yield variant(`${kind}.list.nullable`, [`let xs: ${kind}[]? = hostValue`], "askChoice xs");
        yield variant(`${kind}.set`, [`let xs: ${kind} set = hostValue`], "askChoice xs");
        yield variant(`${kind}.dict`, [`let xs: ${kind} dict = hostValue`], "askChoice xs");
        yield variant(
          `${kind}.nullable-elements`,
          [`let xs: ${kind}?[] = hostValue`],
          "askChoice xs",
        );
      }
      for (const kind of LITERAL_KINDS)
        if (kind !== "null")
          yield variant(
            `${kind}.variable`,
            [`let xs = [${literal(kind)}, ${literal(kind, true)}]`],
            "askChoice xs",
          );
      yield variant("list-or-string", ["let xs: integer[] | string = hostValue"], "askChoice xs");
      yield variant("list-or-list", ["let xs: integer[] | string[] = hostValue"], "askChoice xs");
      yield variant(
        "list-or-numbers",
        ["let xs: integer[] | number[] = hostValue"],
        "askChoice xs",
      );
      yield variant("list-or-null-list", ["let xs: integer[] | null = hostValue"], "askChoice xs");
      yield variant("bare-list", ["let xs: list = hostValue"], "askChoice xs");
      yield variant("bare-set", ["let xs: set = hostValue"], "askChoice xs");
      yield variant("host-list", [], "askChoice hostList", "host");
      yield variant("host-list-labelled", [], "askChoice 7: hostList", "host");
      yield variant("host-elements", ["let xs = [hostValue]"], "askChoice xs", "host");
      yield variant("computed-objects", ['let xs = [{ text: "A", value: 1 }]'], "askChoice xs");
      yield variant("computed-objects-text", ['let xs = [{ text: "A" }]'], "askChoice xs");
      yield variant("computed-objects-no-text", ["let xs = [{ value: 1 }]"], "askChoice xs");
      yield variant("computed-objects-number-text", ["let xs = [{ text: 1 }]"], "askChoice xs");
      yield variant("nested-lists", ["let xs = [[1]]"], "askChoice xs");
      yield variant(
        "restricted-elements",
        ['let c = askChoice "a", "b"', "let xs = [c]"],
        "askChoice xs",
      );
      yield parameterVariant("parameter", "askChoice p", "[1]");
    },
  },
  {
    id: "several",
    *variants() {
      for (const [left, right] of pairs(LITERAL_KINDS, true))
        yield variant(
          `${left}.${right}`,
          [],
          `askChoice ${literal(left)}, ${literal(right, true)}`,
        );
      yield variant("prefill", [], 'askChoice "a", "b", prefill: "a"');
      yield variant("prefill-host", [], 'askChoice "a", "b", prefill: hostValue', "host");
      yield variant("restricted-and-literal", ['let c = askChoice "a", "b"'], 'askChoice c, "c"');
      yield variant("labelled-and-plain", [], 'askChoice 1: "A", "text"');
      yield variant("two-names", [], 'askChoice one: "A", two: "B"');
      yield variant("name-and-integer", [], 'askChoice one: "A", 2: "B"');
      yield variant("integer-and-number", [], 'askChoice 1: "A", 1.5: "B"');
      yield variant("literal-and-host", [], 'askChoice "a", hostValue', "host");
      yield variant("host-and-literal", [], 'askChoice hostValue, "a"', "host");
      yield variant("literal-and-variable", ['let v = "b"'], 'askChoice "a", v');
      yield variant("literal-and-annotated", ["let v: string = hostValue"], 'askChoice "a", v');
      yield variant("literal-and-nullable", ["let v: string? = hostValue"], 'askChoice "a", v');
      yield variant(
        "literal-and-other-kind-annotated",
        ["let v: integer = hostValue"],
        'askChoice "a", v',
      );
      yield variant("marker-texts", [], 'askChoice "?", "!", "+"');
      yield variant("folded-literals", [], "askChoice -1, 1 + 1");
      yield variant("folded-text", [], 'askChoice "a" + "b", "c"');
      yield variant("labelled-object-with-value", [], 'askChoice one: { value: 1, text: "A" }');
      yield variant("labelled-object-text", [], 'askChoice one: { text: "A" }');
      yield variant("computed-object-bad-text", ["let o = { text: [1] }"], "askChoice o");
      yield variant("computed-object-bad-text-element", ["let o = { text: [1] }"], "askChoice [o]");
      yield variant("computed-objects-bad-text", ["let xs = [{ text: [1] }]"], "askChoice xs");
      yield variant(
        "computed-object-prefill-host",
        ['let o = { text: "A", value: 1 }'],
        "askChoice o, prefill: hostValue",
        "host",
      );
      yield variant("object-value-host-no-text", [], "askChoice { value: hostValue }", "host");
      yield variant(
        "object-text-host-and-computed",
        ['let o = { text: "A" }'],
        "askChoice { text: hostText, value: 1 }, o",
        "host",
      );
      yield variant(
        "elements-text-host-and-computed",
        ['let o = { text: "A" }'],
        "askChoice [{ text: hostText, value: 1 }, o]",
        "host",
      );
      yield variant("exponent-numbers", [], "askChoice 1e21, 2e21");
      yield variant("exponent-numbers-variable", ["let v = askChoice 1e21, 2e21"], "askChoice v");
      yield variant("union-of-kinds", ["let v: integer | timer = hostValue"], "askChoice v");
      yield variant(
        "union-of-kinds-element",
        ["let v: integer | timer = hostValue"],
        "askChoice [v]",
      );
      yield variant(
        "computed-object-unshown-text",
        ["let v: timer = hostValue", "let o = { text: v }"],
        "askChoice o",
      );
      yield variant(
        "labelled-host-text-and-computed",
        ['let o = { value: 1, text: "One" }'],
        "askChoice first: hostText, o",
        "host",
      );
      yield variant("labelled-host-and-literal", [], 'askChoice first: hostText, "b"', "host");
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// askForm

const FORM_FIELD_KINDS: readonly string[] = [
  "boolean",
  "cycle",
  "integer",
  "number",
  "text",
  "date",
  "time",
  "datetime",
];

/** Nine written descriptors a dict's fields are enumerated over, each with its own number kind or none. */
const DICT_DESCRIPTORS: readonly (readonly [string, string])[] = [
  ["integer", "1"],
  ["number", "1.5"],
  ["text", '"a"'],
  ["boolean", "true"],
  ["typed", '{ type: "integer" }'],
  ["value-integer", "{ value: 1 }"],
  ["value-number", "{ value: 1.5 }"],
  ["cycle", "[1, 2]"],
  ["null", "null"],
  ["typed-text", '{ type: "text" }'],
];

function form(fields: string, more = ""): string {
  return `askForm("Q", fields: ${fields}${more})`;
}

const FORM_TEMPLATES: readonly Template[] = [
  {
    id: "container",
    *variants() {
      yield variant("object", [], form("{ n: 1 }"));
      yield variant("empty-object", [], form("{}"));
      yield variant("dict", [], form('dict { "n": 1 }'));
      yield variant("empty-dict", [], form("dict {}"));
      yield variant("object-variable", ["let f = { n: 1 }"], form("f"));
      yield variant("dict-variable", ['let f = dict { "n": 1 }'], form("f"));
      yield variant("object-annotated", ["let f: object = hostValue"], form("f"));
      yield variant("object-nullable", ["let f: object? = hostValue"], form("f"));
      yield variant("dict-annotated", ["let f: dict = hostValue"], form("f"));
      yield variant("host", [], form("hostValue"), "host");
      yield variant("host-dict", [], form("hostDict"), "host");
      yield parameterVariant("parameter", form("p"), "{ n: 1 }");
      for (const kind of LITERAL_KINDS)
        if (kind !== "object" && kind !== "dict")
          yield variant(`${kind}.literal`, [], form(literal(kind)));
      for (const kind of WRITTEN_KINDS)
        if (kind !== "object" && kind !== "dict")
          yield variant(`${kind}.annotated`, [`let f: ${kind} = hostValue`], form("f"));
      yield variant("cancel", [], form("{ n: 1 }", ', cancel: "Back"'));
      yield variant("cancel-object", [], form("{ n: 1 }", ', cancel: { text: "Back" }'));
      yield variant("cancel-host", [], form("{ n: 1 }", ", cancel: hostValue"), "host");
      yield variant("cancel-number", [], form("{ n: 1 }", ", cancel: 5"));
      yield variant("submit", [], form("{ n: 1 }", ', submit: "OK"'));
      yield variant("hint", [], form("{ n: 1 }", ', hint: "h"'));
      yield variant("timeout-submit", [], form("{ n: 1 }", ', timeout: 5 s, onTimeout: "submit"'));
      yield variant("timeout-cancel", [], form("{ n: 1 }", ', timeout: 5 s, onTimeout: "cancel"'));
      yield variant(
        "timeout-host",
        [],
        form("{ n: 1 }", ", timeout: 5 s, onTimeout: hostText"),
        "host",
      );
      yield variant("timeout-bogus", [], form("{ n: 1 }", ', timeout: 5 s, onTimeout: "bogus"'));
      yield variant("timeout-alone", [], form("{ n: 1 }", ", timeout: 5 s"));
      yield variant("on-timeout-alone", [], form("{ n: 1 }", ', onTimeout: "submit"'));
      yield variant(
        "timeout-submit-no-start",
        [],
        form('{ n: { type: "integer" } }', ', timeout: 5 s, onTimeout: "submit"'),
      );
      yield variant(
        "cancel-and-timeout-submit",
        [],
        form("{ n: 1 }", ', cancel: "Back", timeout: 5 s, onTimeout: "submit"'),
      );
      yield variant("cancel-host-container", [], form("hostValue", ', cancel: "Back"'), "host");
      yield variant("host-dict-timeout-alone", [], form("hostDict", ", timeout: 1 s"), "host");
      yield variant(
        "object-annotated-hint-host",
        ["let f: object = hostValue"],
        form("f", ", hint: hostText"),
        "host",
      );
      yield variant("host-and-hint-host", [], form("hostValue", ", hint: hostText"), "host");
      yield variant(
        "host-dict-timeout-number",
        [],
        form("hostDict", ', timeout: 5, onTimeout: "submit"'),
        "host",
      );
      yield variant("host-dict-hint-list", [], form("hostDict", ", hint: [1]"), "host");
      yield variant("host-cancel-number", [], form("hostValue", ", cancel: 5"), "host");
    },
  },
  {
    id: "written-descriptor",
    *variants() {
      for (const kind of FORM_FIELD_KINDS)
        yield variant(`type.${kind}`, [], form(`{ n: { type: "${kind}" } }`));
      yield variant("type.bogus", [], form('{ n: { type: "bogus" } }'));
      yield variant("type.host", [], form("{ n: { type: hostText } }"), "host");
      yield variant("type.number-literal", [], form("{ n: { type: 5 } }"));
      yield variant("type.variable", ['let t = "integer"'], form("{ n: { type: t } }"));
      for (const kind of LITERAL_KINDS)
        yield variant(`value.${kind}`, [], form(`{ n: { value: ${literal(kind)} } }`));
      for (const kind of WRITTEN_KINDS)
        yield variant(
          `value.${kind}.annotated`,
          [`let v: ${kind} = hostValue`],
          form("{ n: { value: v } }"),
        );
      yield variant(
        "value.integer.nullable",
        ["let v: integer? = hostValue"],
        form("{ n: { value: v } }"),
      );
      yield variant("value.host", [], form("{ n: { value: hostValue } }"), "host");
      yield variant("options.strings", [], form('{ n: { options: ["a", "b"] } }'));
      yield variant("options.integers", [], form("{ n: { options: [1, 2] } }"));
      yield variant("options.mixed", [], form('{ n: { options: [1, "a"] } }'));
      yield variant(
        "options.objects",
        [],
        form('{ n: { options: [{ text: "A", value: 1 }, { text: "B" }] } }'),
      );
      yield variant("options.object-no-text", [], form("{ n: { options: [{ value: 1 }] } }"));
      yield variant(
        "options.computed-object",
        ['let o = { text: "A", value: 1 }'],
        form("{ n: { options: [o] } }"),
      );
      yield variant(
        "options.computed-object-text",
        ['let o = { text: "A" }'],
        form("{ n: { options: [o] } }"),
      );
      yield variant("options.host-element", [], form("{ n: { options: [hostValue] } }"), "host");
      yield variant("options.nested", [], form("{ n: { options: [[1]] } }"));
      yield variant("options.empty", [], form("{ n: { options: [] } }"));
      for (const kind of WRITTEN_KINDS)
        yield variant(
          `options.${kind}.list`,
          [`let xs: ${kind}[] = hostValue`],
          form("{ n: { options: xs } }"),
        );
      yield variant(
        "options.list-variable",
        ['let xs = ["a", "b"]'],
        form("{ n: { options: xs } }"),
      );
      yield variant(
        "options.objects-variable",
        ['let xs = [{ text: "A", value: 1 }, { text: "B" }]'],
        form("{ n: { options: xs } }"),
      );
      yield variant("options.number", [], form("{ n: { options: 5 } }"));
      yield variant("options.host", [], form("{ n: { options: hostList } }"), "host");
      yield variant(
        "options.nullable-list",
        ["let xs: string[]? = hostValue"],
        form("{ n: { options: xs } }"),
      );
      yield variant("toggle", [], form("{ n: { value: true, options: [true, false] } }"));
      yield variant("value-and-options", [], form("{ n: { value: 1, options: [1, 2] } }"));
      yield variant("text-and-options", [], form('{ n: { value: "a", options: ["a"] } }'));
      yield variant("optional.true", [], form("{ n: { value: 1, optional: true } }"));
      yield variant("optional.false", [], form("{ n: { value: 1, optional: false } }"));
      yield variant("optional.host", [], form("{ n: { value: 1, optional: hostFlag } }"), "host");
      yield variant("optional.typed", [], form('{ n: { type: "boolean", optional: true } }'));
      yield variant("optional.typed-text", [], form('{ n: { type: "text", optional: true } }'));
      yield variant("optional.cycle", [], form('{ n: { options: ["a"], optional: true } }'));
      yield variant("optional.toggle", [], form("{ n: { value: true, optional: true } }"));
      yield variant("min", [], form("{ n: { min: 1 } }"));
      yield variant("max", [], form("{ n: { max: 1.5 } }"));
      yield variant("min-and-value", [], form("{ n: { min: 1, value: 2.5 } }"));
      yield variant(
        "typed-integer-number-start",
        [],
        form('{ n: { type: "integer", value: 1.5 } }'),
      );
      yield variant("typed-number-integer-start", [], form('{ n: { type: "number", value: 1 } }'));
      yield variant("typed-text-number-start", [], form('{ n: { type: "text", value: 1 } }'));
      yield variant("unknown-property", [], form("{ n: { bogus: 1 } }"));
      yield variant("empty", [], form("{ n: {} }"));
      yield variant("text-only", [], form('{ n: { text: "T" } }'));
      yield variant("two-fields", [], form('{ n: 1, s: "a" }'));
      yield variant(
        "two-fields-one-typed",
        [],
        form('{ n: { type: "integer" }, s: { value: "a", optional: true } }'),
      );
      yield variant(
        "type.cycle-with-options",
        [],
        form('{ n: { type: "cycle", options: [1, 2] } }'),
      );
      yield variant(
        "type.cycle-with-text-options",
        [],
        form('{ n: { type: "cycle", options: ["a", "b"] } }'),
      );
      yield variant(
        "options.nullable-value-object",
        ["let v: integer? = hostValue"],
        form('{ n: { options: [{ value: v, text: "One" }] } }'),
      );
      yield variant(
        "options.nullable-value-computed-object",
        ["let v: integer? = hostValue", 'let option = { value: v, text: "One" }'],
        form("{ n: { options: [option] } }"),
      );
      yield variant(
        "options.nullable-text-object",
        ["let v: string? = hostValue"],
        form("{ n: { options: [{ text: v }] } }"),
      );
      yield variant(
        "options.null-value-object",
        [],
        form('{ n: { options: [{ value: null, text: "One" }] } }'),
      );
    },
  },
  {
    id: "shorthand",
    *variants() {
      for (const kind of VALUE_KIND_NAMES)
        for (const value of valueForms(kind))
          yield variant(`${kind}.${value.form}`, value.prelude, form(`{ n: ${value.expression} }`));
      yield variant("host", [], form("{ n: hostValue }"), "host");
      yield parameterVariant("parameter", form("{ n: p }"), "1");
      for (const kind of LITERAL_KINDS)
        yield variant(`cycle.${kind}`, [], form(`{ n: [${literal(kind)}] }`));
      yield variant("cycle.objects", [], form('{ n: [{ text: "A", value: 1 }, { text: "B" }] }'));
      yield variant(
        "cycle.computed-object",
        ['let o = { text: "A", value: 1 }'],
        form("{ n: [o] }"),
      );
      yield variant("cycle.host-element", [], form("{ n: [hostValue] }"), "host");
      yield variant("cycle.nested", [], form("{ n: [[1]] }"));
      yield variant("cycle.empty", [], form("{ n: [] }"));
      yield variant("cycle.mixed", [], form('{ n: [1, "a"] }'));
    },
  },
  {
    id: "computed-descriptor",
    *variants() {
      const descriptors: readonly (readonly [string, string])[] = [
        ["typed", '{ type: "integer" }'],
        ["typed-host", "{ type: hostText }"],
        ["options", '{ options: ["a"] }'],
        ["options-objects", '{ options: [{ text: "A", value: 1 }] }'],
        ["toggle", "{ value: true, options: [true, false] }"],
        ["value-and-options", "{ value: 1, options: [1] }"],
        ["value-integer", "{ value: 1 }"],
        ["value-number", "{ value: 1.5 }"],
        ["value-text", '{ value: "a" }'],
        ["value-boolean", "{ value: true }"],
        ["value-list", "{ value: [1] }"],
        ["value-optional", "{ value: 1, optional: true }"],
        ["value-optional-host", '{ value: "a", optional: hostFlag }'],
        ["min", "{ min: 1 }"],
        ["empty", "{}"],
        ["text", '{ text: "T" }'],
      ];
      for (const [id, descriptor] of descriptors)
        yield variant(
          id,
          [`let d = ${descriptor}`],
          form("{ n: d }"),
          descriptor.includes("host") ? "host" : null,
        );
      yield variant("value-host", ["let d = { value: hostValue }"], form("{ n: d }"), "host");
      yield variant("options-host", ["let d = { options: hostList }"], form("{ n: d }"), "host");
      yield variant("object-annotated", ["let d: object = hostValue"], form("{ n: d }"));
      yield variant(
        "object-nullable",
        ["let d = { value: 1 }", "let e: object? = d"],
        form("{ n: e }"),
      );
      yield variant("in-variable-container", ["let f = { n: { value: 1 } }"], form("f"));
      yield variant(
        "in-variable-container-typed",
        ['let f = { n: { type: "integer" } }'],
        form("f"),
      );
    },
  },
  {
    id: "dict",
    *variants() {
      for (const [[leftId, left], [rightId, right]] of pairs(DICT_DESCRIPTORS, true))
        yield variant(`${leftId}.${rightId}`, [], form(`dict { "a": ${left}, "b": ${right} }`));
      yield variant("host-entry", [], form('dict { "a": hostValue }'), "host");
      yield variant("computed-key", ['let k = "a"'], form("dict { k: 1 }"));
      for (const kind of WRITTEN_KINDS)
        yield variant(`${kind}.annotated`, [`let f: ${kind} dict = hostValue`], form("f"));
      yield variant("variable", ['let f = dict { "a": 1, "b": 1.5 }'], form("f"));
      yield variant("variable-objects", ['let f = dict { "a": { value: 1 } }'], form("f"));
      yield variant("nullable", ["let f: integer dict? = hostValue"], form("f"));
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// List functions over values and selectors, linearRegression and predict

const STATISTICS: readonly string[] = ["sum", "average", "median", "stddev", "min", "max"];

function statistic(name: string, list: string, more = ""): string {
  return name === "percentile" ? `percentile(${list}, 50${more})` : `${name}(${list}${more})`;
}

const VALUES_TEMPLATES: readonly Template[] = [
  {
    id: "elements",
    *variants() {
      for (const name of [...STATISTICS, "percentile"]) {
        for (const kind of LITERAL_KINDS)
          yield variant(
            `${name}.${kind}`,
            [],
            statistic(name, `[${literal(kind)}, ${literal(kind, true)}]`),
          );
        yield variant(`${name}.one`, [], statistic(name, "[1]"));
        // An empty list is reported from its known value (`checkFewest`); the result is unknown from the element
        // nothing was stored into.
        yield variant(`${name}.empty`, [], statistic(name, "[]"));
        yield variant(`${name}.mixed-numbers`, [], statistic(name, "[1, 2.5]"));
        yield variant(`${name}.host-list`, [], statistic(name, "hostList"), "host");
        yield variant(`${name}.host-element`, [], statistic(name, "[hostValue]"), "host");
      }
      for (const kind of WRITTEN_KINDS) {
        yield variant(`sum.${kind}.annotated`, [`let xs: ${kind}[] = hostValue`], "sum(xs)");
        yield variant(`sum.${kind}.nullable-list`, [`let xs: ${kind}[]? = hostValue`], "sum(xs)");
      }
      yield variant("sum.nullable-elements", ["let xs: integer?[] = hostValue"], "sum(xs)");
      yield variant("sum.set-annotated", ["let xs: integer set = hostValue"], "sum(xs)");
      yield variant("sum.set-literal", [], "sum(set [1, 2])");
      yield variant("sum.scalar", [], "sum(1)");
      yield variant("sum.text", [], 'sum("x")');
      yield variant("sum.list-or-string", ["let xs: integer[] | string = hostValue"], "sum(xs)");
      yield variant("sum.bare-list", ["let xs: list = hostValue"], "sum(xs)");
      yield parameterVariant("sum.parameter", "sum(p)", "[1, 2]");
      yield variant("percentile.host-percent", [], "percentile([1, 2], hostValue)", "host");
      yield variant("percentile.text-percent", [], 'percentile([1, 2], "x")');
      yield variant("percentile.negative-percent", [], "percentile([1, 2], -1)");
      yield variant("percentile.host-list-text-percent", [], 'percentile(hostList, "x")', "host");
      yield variant(
        "percentile.host-element-negative-percent",
        [],
        "percentile([hostValue], -1)",
        "host",
      );
      yield variant(
        "percentile.host-list-and-percent",
        [],
        "percentile([hostValue], hostValue)",
        "host",
      );
      yield variant("percentile.no-percent", [], "percentile([1, 2])");
      yield variant("percentile.extra-positional", [], "percentile([1, 2], 50, 3)");
      yield variant("sum.extra-named", [], "sum([1], extra: 1)");
      yield variant("sum.extra-positional", [], "sum([1], 2)");
      yield variant("sum.no-arguments", [], "sum()");
      yield variant("min.extra-named-list", [], "min([1, 2], extra: 1)");
      yield variant(
        "sum.mixed-allowed-kinds",
        ["let xs: (integer | duration)[] = hostValue"],
        "sum(xs)",
      );
      yield variant(
        "sum.text-or-null-elements",
        ["let xs: (string | null)[] = hostValue"],
        "sum(xs)",
      );
      yield variant("sum.null-elements", [], "sum([null])");
      yield variant("sum.null-list", [], "sum(null)");
      for (const name of STATISTICS)
        for (const kind of WRITTEN_KINDS)
          if (name !== "sum")
            yield variant(
              `${name}.${kind}.annotated`,
              [`let xs: ${kind}[] = hostValue`],
              `${name}(xs)`,
            );
    },
  },
  {
    id: "selector",
    *variants() {
      for (const kind of LITERAL_KINDS)
        yield variant(
          `sum.${kind}`,
          [],
          `sum([{ p: ${literal(kind)} }, { p: ${literal(kind, true)} }], by: "p")`,
        );
      for (const name of STATISTICS)
        yield variant(`${name}.objects`, [], `${name}([{ p: 1 }, { p: 2 }], by: "p")`);
      yield variant("percentile.objects", [], 'percentile([{ p: 1 }, { p: 2 }], 50, by: "p")');
      yield variant("missing", [], 'sum([{ p: 1 }], by: "q")');
      yield variant("variable", ['let k = "p"'], "sum([{ p: 1 }], by: k)");
      yield variant("host", [], "sum([{ p: 1 }], by: hostText)", "host");
      yield variant("number", [], "sum([{ p: 1 }], by: 1)");
      yield variant("scalars", [], 'sum([1, 2], by: "p")');
      yield variant("objects-variable", ["let xs = [{ p: 1 }, { p: 2 }]"], 'sum(xs, by: "p")');
      yield variant("host-list", [], 'sum(hostList, by: "p")', "host");
      yield variant("some-missing", [], 'sum([{ p: 1 }, { q: 2 }], by: "p")');
      yield variant("host-property", [], 'sum([{ p: hostValue }], by: "p")', "host");
      yield variant("object-and-scalar", [], 'sum([{ p: 1 }, 2], by: "p")');
      yield variant("nested-property", [], 'sum([{ p: { q: 1 } }], by: "p")');
      yield variant(
        "optional-property",
        ["let v: integer? = hostValue"],
        'sum([{ p: v }], by: "p")',
      );
      yield variant("bare-objects", ["let xs: object[] = hostValue"], 'sum(xs, by: "p")');
      yield variant("null-selector", [], "sum([{ null: 1 }], by: null)");
      yield variant("host-list-variable-selector", ['let k = "p"'], "sum(hostList, by: k)", "host");
      yield variant("host-list-host-selector", [], "sum(hostList, by: hostText)", "host");
      yield variant("host-list-number-selector", [], "sum(hostList, by: 1)", "host");
      yield variant("null-selector-plain", [], "sum([{ p: 1 }], by: null)");
      yield variant("nullable-selector", ["let k: string? = hostValue"], "sum([{ p: 1 }], by: k)");
      yield variant("empty-list", [], 'sum([], by: "p")');
      yield variant("null-elements", [], 'sum([null], by: "p")');
      yield variant("extra-named", [], 'sum([{ p: 1 }], by: "p", extra: 1)');
      yield parameterVariant("parameter", 'sum(p, by: "p")', "[{ p: 1 }]");
    },
  },
];

const POINTS = "[{ x: 1, y: 2 }, { x: 2, y: 3 }]";

const REGRESSION_TEMPLATES: readonly Template[] = [
  {
    id: "points",
    *variants() {
      yield variant("plain", [], `linearRegression(${POINTS})`);
      yield variant("one-point", [], "linearRegression([{ x: 1, y: 2 }])");
      yield variant("empty", [], "linearRegression([])");
      yield variant("selectors", [], `linearRegression(${POINTS}, x: "x", y: "y")`);
      yield variant(
        "other-names",
        [],
        'linearRegression([{ a: 1, b: 2 }, { a: 2, b: 3 }], x: "a", y: "b")',
      );
      yield variant("x-only", [], `linearRegression(${POINTS}, x: "x")`);
      yield variant("y-only", [], `linearRegression(${POINTS}, y: "y")`);
      yield variant("x-variable", ['let k = "x"'], `linearRegression(${POINTS}, x: k, y: "y")`);
      yield variant("x-host", [], `linearRegression(${POINTS}, x: hostText, y: "y")`, "host");
      yield variant("x-number", [], `linearRegression(${POINTS}, x: 1, y: "y")`);
      yield variant("missing-selector", [], `linearRegression(${POINTS}, x: "a", y: "y")`);
      yield variant("numbers", [], "linearRegression([1, 2])");
      yield variant("scalar", [], "linearRegression(1)");
      yield variant("texts", [], 'linearRegression(["a", "b"])');
      yield variant("decimal-points", [], "linearRegression([{ x: 1.5, y: 2 }, { x: 2.5, y: 3 }])");
      yield variant("duration-x", [], "linearRegression([{ x: 1 s, y: 2 }, { x: 2 s, y: 3 }])");
      yield variant("duration-y", [], "linearRegression([{ x: 1, y: 2 s }, { x: 2, y: 3 s }])");
      yield variant("text-y", [], 'linearRegression([{ x: 1, y: "a" }])');
      yield variant("text-x", [], 'linearRegression([{ x: "a", y: 1 }])');
      yield variant("host-x", [], "linearRegression([{ x: hostValue, y: 1 }])", "host");
      yield variant("host-points", [], "linearRegression(hostList)", "host");
      yield variant("host-element", [], "linearRegression([hostValue])", "host");
      yield variant("variable", [`let ps = ${POINTS}`], "linearRegression(ps)");
      yield variant("annotated", ["let ps: object[] = hostValue"], "linearRegression(ps)");
      yield variant(
        "narrowed",
        [`let ps = ${POINTS}`, "let qs: object[]? = ps"],
        "linearRegression(qs)",
      );
      yield variant("nullable", ["let ps: object[]? = hostValue"], "linearRegression(ps)");
      yield variant("extra-named", [], "linearRegression([1, 2], extra: 1)");
      yield variant("extra-positional", [], "linearRegression([1, 2], 3)");
      yield variant("no-arguments", [], "linearRegression()");
      yield variant("durations", [], "linearRegression([1 s, 2 s])");
      yield variant("decimals", [], "linearRegression([1.5, 2.5])");
      yield variant("one-number", [], "linearRegression([1])");
      yield variant("empty-selected", [], 'linearRegression([], x: "x", y: "y")');
      for (const kind of LITERAL_KINDS) {
        yield variant(
          `x.${kind}`,
          [],
          `linearRegression([{ x: ${literal(kind)}, y: 2 }, { x: ${literal(kind, true)}, y: 3 }], x: "x", y: "y")`,
        );
        yield variant(
          `y.${kind}`,
          [],
          `linearRegression([{ x: 1, y: ${literal(kind)} }, { x: 2, y: ${literal(kind, true)} }], x: "x", y: "y")`,
        );
      }
      for (const kind of WRITTEN_KINDS) {
        yield variant(
          `x.${kind}.annotated`,
          [`let v: ${kind} = hostValue`],
          'linearRegression([{ x: v, y: 1 }, { x: v, y: 2 }], x: "x", y: "y")',
        );
        yield variant(
          `y.${kind}.annotated`,
          [`let v: ${kind} = hostValue`],
          'linearRegression([{ x: 1, y: v }, { x: 2, y: v }], x: "x", y: "y")',
        );
      }
      yield variant(
        "x.nullable",
        ["let v: integer? = hostValue"],
        'linearRegression([{ x: v, y: 1 }], x: "x", y: "y")',
      );
      yield variant(
        "y.nullable",
        ["let v: integer? = hostValue"],
        'linearRegression([{ x: 1, y: v }], x: "x", y: "y")',
      );
      yield variant(
        "x.host-values",
        [],
        'linearRegression([{ x: hostValue, y: 1 }], x: "x", y: "y")',
        "host",
      );
      yield parameterVariant("parameter", "linearRegression(p)", POINTS);
    },
  },
];

const PREDICTION_TEMPLATES: readonly Template[] = [
  {
    id: "line",
    *variants() {
      const line = (slope: string, intercept: string, start: string) =>
        `{ slope: ${slope}, intercept: ${intercept}, start: ${start} }`;
      for (const kind of LITERAL_KINDS)
        yield variant(`intercept.${kind}`, [], `predict(${line("1", literal(kind), "0")}, 1)`);
      for (const kind of LITERAL_KINDS)
        yield variant(`slope.${kind}`, [], `predict(${line(literal(kind), "2", "0")}, 1)`);
      for (const kind of LITERAL_KINDS)
        yield variant(`start.${kind}`, [], `predict(${line("1", "2", literal(kind))}, 1)`);
      for (const kind of LITERAL_KINDS)
        yield variant(`x.${kind}`, [], `predict(${line("1", "2", "0")}, ${literal(kind)})`);
      yield variant("intercept.host", [], `predict(${line("1", "hostValue", "0")}, 1)`, "host");
      yield variant("slope.host", [], `predict(${line("hostValue", "2", "0")}, 1)`, "host");
      yield variant("start.host", [], `predict(${line("1", "2", "hostValue")}, 1)`, "host");
      yield variant("x.host", [], `predict(${line("1", "2", "0")}, hostValue)`, "host");
      yield variant(
        "intercept.annotated",
        ["let i: integer = hostValue"],
        `predict(${line("1", "i", "0")}, 1)`,
      );
      yield variant(
        "intercept.nullable",
        ["let i: integer? = hostValue"],
        `predict(${line("1", "i", "0")}, 1)`,
      );
      yield variant(
        "intercept.duration-annotated",
        ["let i: duration = hostValue"],
        `predict(${line("1", "i", "0")}, 1)`,
      );
      yield variant("no-start", [], "predict({ slope: 1, intercept: 2 }, 1)");
      yield variant("no-intercept", [], "predict({ slope: 1, start: 0 }, 1)");
      yield variant("no-slope", [], "predict({ intercept: 2, start: 0 }, 1)");
      yield variant(
        "extra",
        [],
        `predict(${line("1", "2", "0")}, 1)`.replace("start: 0 }", "start: 0, extra: 1 }"),
      );
      yield variant("empty", [], "predict({}, 1)");
      yield variant("regression", [`let l = linearRegression(${POINTS})`], "predict(l, 1)");
      yield variant(
        "regression-durations",
        ["let l = linearRegression([{ x: 1 s, y: 2 }, { x: 2 s, y: 3 }])"],
        "predict(l, 3 s)",
      );
      yield variant(
        "regression-duration-y",
        ["let l = linearRegression([{ x: 1, y: 2 s }, { x: 2, y: 3 s }])"],
        "predict(l, 3)",
      );
      yield variant("variable", [`let l = ${line("1", "2", "0")}`], "predict(l, 1)");
      yield variant("annotated", ["let l: object = hostValue"], "predict(l, 1)");
      yield variant("host", [], "predict(hostValue, 1)", "host");
      yield variant("scalar", [], "predict(1, 1)");
      yield variant("text", [], 'predict("a", 1)');
      yield variant("list", [], "predict([1], 1)");
      yield variant("no-x", [], `predict(${line("1", "2", "0")})`);
      yield variant("extra-named", [], `predict(${line("1", "2", "0")}, 1, extra: 1)`);
      yield variant("extra-positional", [], `predict(${line("1", "2", "0")}, 1, 2)`);
      yield variant("no-arguments", [], "predict()");
      yield variant(
        "date-x-and-start",
        ["let d: date = hostValue"],
        `predict(${line("1", "2", "d")}, d)`,
      );
      yield variant(
        "date-start-number-x",
        ["let d: date = hostValue"],
        `predict(${line("1", "2", "d")}, 1)`,
      );
      yield variant("duration-x-and-start", [], `predict(${line("1", "2 s", "1 s")}, 3 s)`);
      yield variant(
        "nullable-x",
        ["let n: integer? = hostValue"],
        `predict(${line("1", "2", "0")}, n)`,
      );
      yield variant("null-x", [], `predict(${line("1", "2", "0")}, null)`);
      yield variant(
        "narrowed-line",
        [`let l = ${line("1", "2", "0")}`, "let m: object? = l"],
        "predict(m, 1)",
      );
      yield variant("nullable-line", ["let m: object? = hostValue"], "predict(m, 1)");
      yield variant(
        "host-intercept-date-start",
        ["let d: date = hostValue"],
        `predict(${line("1", "hostValue", "d")}, 1)`,
        "host",
      );
      yield variant(
        "object-line-host-x",
        ["let l: object = hostValue"],
        "predict(l, hostValue)",
        "host",
      );
      yield parameterVariant("parameter", "predict(p, 1)", line("1", "2", "0"));
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// The asks with a fixed answer and the command expressions (§5.6): small input spaces, enumerated whole

const PERSON_FIELD_NAMES: readonly string[] = [...PERSON_FIELDS].sort();

const COMMAND_TEMPLATES: readonly Template[] = [
  {
    id: "ask",
    *variants() {
      for (const name of [
        "Text",
        "Password",
        "Number",
        "Integer",
        "Date",
        "Time",
        "DateTime",
        "Boolean",
      ])
        yield variant(name.toLowerCase(), [], `ask${name} "Q?"`);
      yield variant("text.prefill", [], 'askText "Q?", prefill: "a"');
      yield variant("text.prefill-number", [], 'askText "Q?", prefill: 5');
      yield variant("number.prefill-text", [], 'askNumber "Q?", prefill: "x"');
      yield variant("text.hint", [], 'askText "Q?", hint: "h"');
      yield variant("text.question-host", [], "askText hostText", "host");
      yield variant("text.question-number", [], "askText 5");
      yield variant("boolean.prefill", [], 'askBoolean "Q?", prefill: true');
      yield variant("boolean.prefill-text", [], 'askBoolean "Q?", prefill: "x"');
    },
  },
  {
    id: "booleans",
    *variants() {
      const ask = (more: string) => `askBooleans("Q?", texts: ["A"], prefill: [false]${more})`;
      yield variant("plain", [], ask(""));
      yield variant("cancel", [], ask(', cancel: "Back"'));
      yield variant("cancel-object", [], ask(', cancel: { text: "Back" }'));
      yield variant("cancel-host", [], ask(", cancel: hostValue"), "host");
      yield variant("cancel-number", [], ask(", cancel: 5"));
      yield variant("texts-numbers", [], 'askBooleans("Q?", texts: [1], prefill: [false])');
      yield variant(
        "texts-host",
        [],
        'askBooleans("Q?", texts: hostList, prefill: [false])',
        "host",
      );
      yield variant(
        "prefill-host",
        [],
        'askBooleans("Q?", texts: ["A"], prefill: hostList)',
        "host",
      );
      yield variant("prefill-numbers", [], 'askBooleans("Q?", texts: ["A"], prefill: [1])');
      yield variant("lengths", [], 'askBooleans("Q?", texts: ["A", "B"], prefill: [false])');
      yield variant("no-texts", [], 'askBooleans("Q?", texts: [], prefill: [])');
      yield variant(
        "question-host",
        [],
        'askBooleans(hostText, texts: ["A"], prefill: [false])',
        "host",
      );
    },
  },
  {
    id: "image",
    *variants() {
      yield variant("plain", [], 'askImage("P")');
      yield variant("skip", [], 'askImage("P", allowSkip: true)');
      yield variant("no-skip", [], 'askImage("P", allowSkip: false)');
      yield variant("skip-host", [], 'askImage("P", allowSkip: hostFlag)', "host");
      yield variant("skip-number", [], 'askImage("P", allowSkip: 5)');
      yield variant("no-source", [], 'askImage("P", allowCamera: false, allowFile: false)');
      yield variant("camera-only", [], 'askImage("P", allowFile: false)');
      yield variant("types", [], 'askImage("P", types: [".png"])');
      yield variant("mime", [], 'askImage("P", mime: ["image/png"])');
      yield variant("types-numbers", [], 'askImage("P", types: [1])');
      yield variant("hint", [], 'askImage("P", hint: "h")');
      yield variant("message-host", [], "askImage(hostText)", "host");
    },
  },
  {
    id: "command",
    *variants() {
      yield variant("say", [], 'say "hi"');
      yield variant("say.presentation", [], 'say bubble(color: "#fff") "hi"');
      yield variant("say.host", [], "say hostText", "host");
      yield variant("say.number", [], "say 5");
      yield variant("showButton", [], 'showButton "Go"');
      yield variant("showButton.timeout", [], 'showButton "Go", timeout: 5 s');
      yield variant("showButton.timeout-host", [], 'showButton "Go", timeout: hostValue', "host");
      yield variant("showButton.number", [], "showButton 5");
      yield variant("showPermanentButton", [], 'showPermanentButton "Stop" { exit }');
      yield variant(
        "showPermanentButton.host",
        [],
        "showPermanentButton hostText { exit }",
        "host",
      );
      yield variant("showPopup", [], 'showPopup(message: "x")');
      yield variant("showPopup.button", [], 'showPopup(message: "x", buttonText: "OK")');
      yield variant("showPopup.host", [], "showPopup(message: hostText)", "host");
      yield variant("timer", [], "timer async 1 s");
      yield variant("timer.handler", [], "timer async 1 s { }");
      yield variant("timer.host", [], "timer async hostValue", "host");
      yield variant("timer.number", [], "timer async 5");
      yield variant("playAudio", [], 'playAudio async "a.mp3"');
      yield variant("playVideo", [], 'playVideo async "a.mp4"');
      yield variant("playAudio.host", [], "playAudio async hostText", "host");
      yield variant("showCamera", [], "showCamera");
      yield variant("takePhoto", [], "takePhoto()");
      yield variant("findImages", [], 'findImages(where: "heat" > 1)');
      yield variant("findScripts", [], 'findScripts(where: "x" > 1)');
    },
  },
  {
    id: "speaker-field",
    *variants() {
      for (const name of PERSON_FIELD_NAMES) yield variant(name, [], `account.${name}`);
      yield variant("bogus", [], "account.bogus");
    },
  },
];

const ROUTINES: ReadonlyMap<RoutineName, readonly Template[]> = new Map([
  ["choice", CHOICE_TEMPLATES],
  ["form", FORM_TEMPLATES],
  ["values", VALUES_TEMPLATES],
  ["regression", REGRESSION_TEMPLATES],
  ["prediction", PREDICTION_TEMPLATES],
  ["commands", COMMAND_TEMPLATES],
]);

export const ROUTINE_NAMES: readonly RoutineName[] = [...ROUTINES.keys()];

// ---------------------------------------------------------------------------------------------------------------------
// The generator and the class rule

function program(variant: Variant): string {
  const lines =
    variant.call === undefined
      ? [...variant.prelude, `let r = ${variant.operation}`]
      : [
          ...variant.prelude,
          "function f(p) {",
          `  let r = ${variant.operation}`,
          "}",
          `f(${variant.call})`,
        ];
  return [...lines, "exit"].join("\n");
}

/** The operation's operands as written: the options and named arguments of an ask, or the arguments of a call. */
function operandNodes(outcome: LegacyOutcome): readonly Expression[] {
  const node = outcome.node;
  return node.kind === "interactionExpression"
    ? [
        ...node.options.map((option) => option.expression),
        ...node.formArguments.map((argument) => argument.value),
      ]
    : node.kind === "callExpression"
      ? node.arguments.map((argument) => argument.value)
      : [];
}

function operandFacts(outcome: LegacyOutcome): string[] {
  return operandNodes(outcome).map(
    (operand) =>
      outcome
        .factsAt({ start: operand.span.start.offset, end: operand.span.end.offset })
        .join(" / ") || "untyped",
  );
}

/** The legacy's errors of an operand standing alone, keyed by code and offsets within it; checked once per text. */
const OWN_ERRORS = new Map<string, ReadonlySet<string>>();

function ownErrorsOf(variant: Variant, source: string, operand: Expression): ReadonlySet<string> {
  const text = source.slice(operand.span.start.offset, operand.span.end.offset);
  const alone = program({ ...variant, operation: text });
  const kept = OWN_ERRORS.get(alone);
  if (kept !== undefined) return kept;
  const outcome = legacyOperation(alone);
  const start = outcome.node.span.start.offset;
  const found = new Set(
    outcome.errorSpans.map((error) => `${error.code}@${error.start - start}-${error.end - start}`),
  );
  OWN_ERRORS.set(alone, found);
  return found;
}

/**
 * The errors inside the operation's span split into the operation's own and its operands' own: an error an operand
 * reports when it stands alone, at the same place, is the operand's (a list literal that mixes kinds), not the
 * operation's, and the relation is not asked to answer for it.
 */
function splitErrors(
  variant: Variant,
  source: string,
  outcome: LegacyOutcome,
): {
  readonly errors: { readonly code: string; readonly message: string }[];
  readonly operandErrors: string[];
} {
  const errors: { readonly code: string; readonly message: string }[] = [];
  const operandErrors: string[] = [];
  const operands = operandNodes(outcome).map((operand) => ({
    start: operand.span.start.offset,
    end: operand.span.end.offset,
    own: ownErrorsOf(variant, source, operand),
  }));
  for (const error of outcome.errorSpans) {
    const operand = operands.find(
      (candidate) => error.start >= candidate.start && error.end <= candidate.end,
    );
    const key =
      operand === undefined
        ? undefined
        : `${error.code}@${error.start - operand.start}-${error.end - operand.start}`;
    if (key !== undefined && operand!.own.has(key)) operandErrors.push(error.code);
    else errors.push({ code: error.code, message: error.message });
  }
  return { errors, operandErrors };
}

/**
 * The reports of the legacy routines that take the operation's value away (the branch returns `UNKNOWN_TYPE` with
 * them), by routine, matched on the code or the message: every other report at the operation is the check's own and
 * leaves the answer it computed (work note §6.6). The sites, for review: `shape` (`list-function-checks.ts`, codes
 * TSV020 and TSV022); `valuesType` ("needs a list, not", "needs a list of objects for", "needs the name of a
 * property as its"); `valueKind` for the statistics ("needs <kinds>, not", "needs values of one kind", the angle
 * message) and the missing-property note of `#listFunctionType`; `listFunctionType` for points ("needs y: with
 * x:"); `predictType` (the x's kind, the angle message, "never null", "needs a line from linearRegression(...),
 * with"); `#choiceEntry` and the computed collection of `#interactionTask` (`#checkMembers` and `#checkElements`:
 * "A button cannot return", "A choice option must be a value", "A choice list element must be", the may-be report)
 * and the empty choice; `#formAnswersTask` ("'fields:' takes an object or dict of fields"); the account field read
 * ("The account has no field"). A regression keeps its object with unknown amounts after a rejected value, so
 * `valueKind`'s reports are not invalidating there.
 */
const INVALIDATING: Readonly<Record<RoutineName, readonly RegExp[]>> = {
  choice: [
    /^A button cannot return /,
    /^A choice option must be a value/,
    /^A choice list element must be/,
    / may be .*[Cc]heck it first/,
    /^A choice needs at least one button/,
  ],
  form: [/^'fields:' takes an object or dict of fields/],
  values: [
    /^TSV020$/,
    /^TSV022$/,
    / needs a list, not /,
    / needs a list of objects for /,
    / needs the name of a property as its /,
    /\(\.\.\.\) needs (?!a number as its |a percentage from ).*, not /,
    / needs values of one kind: /,
    / does not take angles/,
    /: the objects in this list have no property /,
  ],
  regression: [
    /^TSV020$/,
    /^TSV022$/,
    / needs y: with x:/,
    / needs a list, not /,
    / needs a list of objects for /,
    / needs the name of a property as its /,
  ],
  prediction: [
    /^TSV020$/,
    /^TSV022$/,
    / needs a number, date, datetime, or absolute date and time as its x, not /,
    / does not take angles/,
    / are never null\.$/,
    / needs a line from linearRegression\(\.\.\.\), with slope, intercept, and start, not /,
  ],
  commands: [/^The account has no field /],
};

function invalidating(
  routine: RoutineName,
  error: { readonly code: string; readonly message: string },
): boolean {
  return INVALIDATING[routine].some(
    (pattern) => pattern.test(error.code) || pattern.test(error.message),
  );
}

/**
 * The provenance of a result the legacy leaves unknown without an invalidating report: the first dynamic place
 * among the places the contract's result is read from, in the order the routine reads them, else `unknown member`,
 * the legacy's own limit on closed operands. Declared per contract from the evidence, as the adapters walk it (work
 * note §6.6): a choice's options and written elements by what the button returns (a written object's `value`, else
 * its `text`); a form's `fields`, then the descriptors' `value` and `options`; a statistic's `by:` (a selector the
 * legacy cannot see leaves the property unknown before the list is read), then its list; a regression's `y:` and
 * `x:` likewise, then its list; a prediction's line (the x only validates).
 */
function provenance(inputs: CaseInputs, why: DynamicWhy | null): DynamicWhy {
  const { contract, operation, dynamicPlaces } = inputs;
  const dynamic = (place: PlaceId | null | undefined): boolean =>
    place !== null && place !== undefined && dynamicPlaces.has(place);
  const named = (name: string) => operation.named.find((entry) => entry.name === name)?.value;
  const first = (places: readonly (PlaceId | null | undefined)[]): DynamicWhy | undefined =>
    places.some(dynamic) ? (why ?? undefined) : undefined;
  const evidence = operation.evidence;
  const returned = (object: ChoiceObjectEvidence | null, place: PlaceId): PlaceId | null =>
    object === null ? place : (object.value ?? object.text);
  const elements = (list: readonly ChoiceElementEvidence[]): (PlaceId | null)[] =>
    list.map((element) => returned(element.object, element.place));
  /** A selector that is not visible text leaves the property unknown before the list is read. */
  const selector = (name: string): DynamicWhy | undefined => {
    const place = named(name);
    if (place === undefined) return undefined;
    if (dynamic(place)) return why ?? undefined;
    const written =
      evidence?.kind === "selectors"
        ? evidence.written.find((entry) => entry.name === name)
        : undefined;
    return written === undefined || written.text === null ? "unknown member" : undefined;
  };
  switch (`${contract.family}.${contract.name}`) {
    case "interaction.choice": {
      if (evidence?.kind !== "choice") return "unknown member";
      // A labelled option's button returns the label: nothing of the option contributes.
      const places = evidence.options.flatMap((option) =>
        option.label !== null
          ? []
          : option.content.kind === "list" || option.content.kind === "set"
            ? elements(option.content.elements)
            : option.content.kind === "object"
              ? [returned(option.content.object, option.place)]
              : [option.place],
      );
      return first(places) ?? "unknown member";
    }
    case "interaction.form": {
      if (dynamic(named("fields"))) return why ?? "unknown member";
      if (evidence?.kind !== "form" || evidence.fields === "computed") return "unknown member";
      const places = evidence.fields.entries.flatMap((entry) =>
        entry.written.kind === "object"
          ? [
              entry.written.value,
              entry.written.options?.place,
              ...(entry.written.options?.elements == null
                ? []
                : elements(entry.written.options.elements)),
            ]
          : entry.written.kind === "list"
            ? elements(entry.written.elements)
            : [],
      );
      return first(places) ?? "unknown member";
    }
    case "listFunction.linearRegression":
      return selector("y") ?? selector("x") ?? first([operation.arguments[0]]) ?? "unknown member";
    case "listFunction.predict":
      return first([operation.arguments[0]]) ?? "unknown member";
    default:
      if (contract.family === "listFunction")
        return selector("by") ?? first([operation.arguments[0]]) ?? "unknown member";
      return "unknown member";
  }
}

/**
 * The class of a row, from what the oracle says and the routine's declared invalidating reports (work note §6.1 and
 * §6.6): a closed fact is `fact`, or `recovery` with an error; no fact with an invalidating report is `invalid`; no
 * fact without one (no report, or the check's own reports beside the answer) is `dynamic` of the result's
 * provenance; a `stage5` variant is `legacy`, and a row with an undecided null slot is `open`: neither asserts an
 * adapter answer.
 */
function classify(
  routine: RoutineName,
  variant: Variant,
  fact: string,
  errors: readonly { readonly code: string; readonly message: string }[],
  inputs: CaseInputs,
): { readonly class: CaseClass; readonly adapter: AdapterCell } {
  if (variant.stage5 !== undefined) return { class: "legacy", adapter: null };
  if (inputs.open) return { class: "open", adapter: null };
  const closed = fact !== "unknown" && isClosedFact(fact);
  if (fact !== "unknown" && !closed)
    throw new Error(`the fact ${fact} of ${variant.id} is not closed`);
  if (closed) return { class: errors.length > 0 ? "recovery" : "fact", adapter: "fact" };
  if (errors.some((error) => invalidating(routine, error)))
    return { class: "invalid", adapter: "invalid" };
  return { class: "dynamic", adapter: { dynamic: provenance(inputs, variant.why) } };
}

/** Every row of a routine's table, generated from its templates and pinned by the legacy oracle. */
export function generateTable(routine: RoutineName): GeneratedRow[] {
  const templates = ROUTINES.get(routine);
  if (templates === undefined) throw new Error(`no routine ${routine}`);
  const rows: GeneratedRow[] = [];
  const seen = new Set<string>();
  for (const template of templates)
    for (const variant of template.variants()) {
      const id = `${routine}/${template.id}/${variant.id}`;
      if (seen.has(id)) throw new Error(`two rows ${id}`);
      seen.add(id);
      const source = program(variant);
      const outcome = legacyOperation(source);
      if (outcome.type === null)
        throw new Error(`the legacy typed no operation at ${id}:\n${source}`);
      const fact = outcome.type;
      const inputs = caseInputs(outcome, variant.why);
      const { errors, operandErrors } = splitErrors(variant, source, outcome);
      const { class: cls, adapter } = classify(routine, variant, fact, errors, inputs);
      const row: CaseRow = {
        id,
        source,
        fact,
        errors: errors.map((error) => error.code),
        messages: errors.map((error) => error.message),
        operandErrors,
        elsewhere: outcome.errorsElsewhere,
        operands: operandFacts(outcome),
        class: cls,
        adapter,
        why: variant.why,
        ...(outcome.factFrom === "binding" ? { factFrom: "binding" as const } : {}),
        ...(variant.stage5 === undefined ? {} : { stage5: variant.stage5 }),
        ...(variant.note === undefined ? {} : { note: variant.note }),
      };
      rows.push({ row, outcome, inputs });
    }
  return rows;
}
