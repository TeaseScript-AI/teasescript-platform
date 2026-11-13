// The templates of the asks' case tables: `askChoice`, `askForm`, and the asks with a fixed answer and the command
// expressions.

import { PERSON_FIELDS } from "../../../../src/speaker-terms.js";
import { VALUE_KIND_NAMES } from "../../../../src/value-kinds.js";
import {
  type Template,
  valueForms,
  LITERAL_KINDS,
  WRITTEN_KINDS,
  literal,
  variant,
  parameterVariant,
  pairs,
} from "./adapter-case-forms.js";

// ---------------------------------------------------------------------------------------------------------------------
// askChoice

const LABELS: readonly (readonly [string, string])[] = [
  ["plain", ""],
  ["name", "one: "],
  ["integer", "1: "],
  ["number", "1.5: "],
];

export const CHOICE_TEMPLATES: readonly Template[] = [
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
      yield variant("object-text-value", [], 'askChoice { text: "A", value: 1 }');
      yield variant("object-text", [], 'askChoice { text: "A" }');
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

export const FORM_TEMPLATES: readonly Template[] = [
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
        "cycle.objects-same",
        [],
        form('{ n: [{ text: "A", value: 1 }, { text: "B", value: 2 }] }'),
      );
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
// The asks with a fixed answer and the command expressions: small input spaces, enumerated whole

const PERSON_FIELD_NAMES: readonly string[] = [...PERSON_FIELDS].sort();

export const COMMAND_TEMPLATES: readonly Template[] = [
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
      for (const name of PERSON_FIELD_NAMES) yield variant(name, [], `playerProfile.${name}`);
      yield variant("bogus", [], "playerProfile.bogus");
    },
  },
];
