import type { Expression, Program, Statement } from "../../src/ast.js";
import { collectGraph } from "../../src/type-inference/collector.js";
import { graphText } from "../../src/type-inference/graph.js";
import { analyzeTypes } from "../../src/type-inference/index.js";
import { request } from "./type-inference-graph.js";

/**
 * The condition-shape table (O4 stage 2c, work note §4): every line of the legacy branch decisions
 * (`#branchKindTask`, `#narrowTest`) gives rows from templates over the written forms that reach it, and each row pins
 * what the legacy observes of the source: the facts of the reads inside and after the branches, the condition's own
 * fact, the ordered diagnostics, and the `test` constraints the collector emits. The table is generated at the base
 * build, before any production change, so that the modified visitor is asserted against the legacy's observations.
 * The declared shape of a row's condition is what the recognizer must answer; it comes from the template, never from
 * the recognizer.
 */

/** The host globals the sources read: each is a value the check cannot know. */
const CONDITION_GLOBALS: readonly string[] = ["hostValue", "hostFlag", "hostList"];

/** A span of the row's source, in offsets. */
export interface Site {
  readonly start: number;
  readonly end: number;
}

export type DeclaredShape =
  | { readonly kind: "literal"; readonly value: boolean }
  | { readonly kind: "not" }
  | { readonly kind: "and" | "or" }
  | { readonly kind: "null"; readonly negated: boolean; readonly tested: Site }
  | {
      readonly kind: "type";
      readonly negated: boolean;
      readonly tested: Site;
      readonly type: string;
    }
  | { readonly kind: "other" };

export type Consumer = "if" | "exit" | "while" | "value" | "switch";

export interface ConditionRow {
  /** `<group>/<setup>/<test>/<consumer>`. */
  readonly id: string;
  readonly source: string;
  readonly consumer: Consumer;
  /** The condition expression's site and the legacy's fact for it; `null` for the switch, which has no condition. */
  readonly condition: (Site & { readonly fact: string | null }) | null;
  /** The shape the recognizer must give the condition; `null` for the switch. */
  readonly shape: DeclaredShape | null;
  /** The facts of the reads: `t` in the taken branch, `f` in the other, `u` after the statement; `null` where absent. */
  readonly reads: {
    readonly t: string | null;
    readonly f: string | null;
    readonly u: string | null;
  };
  /** Every diagnostic of the source, in the check's order, with its span. */
  readonly diagnostics: readonly {
    readonly severity: string;
    readonly code: string;
    readonly start: number;
    readonly end: number;
    readonly message: string;
  }[];
  /**
   * The statements the check found unreachable (`checked.unreachable`), by site in source order: the branch a literal
   * or an exhaustive test rules out, the code after an exit. The compiler reports them after lowering (TSV065), which
   * the differential compares on the rows' variants; the check's own set is pinned here.
   */
  readonly unreachable: readonly Site[];
  /** The collector's `test` constraints, as the graph dump writes them, in emission order. */
  readonly tests: readonly string[];
}

/** A condition's text with the shape it declares; `tested` offsets are relative to the text. */
interface Condition {
  readonly name: string;
  readonly text: string;
  readonly shape: DeclaredShape;
}

/** How the tested value is declared and read: the prelude, the written tested expression, and its read. */
interface Setup {
  readonly name: string;
  readonly prelude: string;
  /** The expression the tests are written on. */
  readonly tested: string;
  /** The expression the reads `t`, `f` and `u` read; the tested one unless a test names another variable. */
  readonly read?: string;
  /** The prelude of the differential's variant, which reads no host global; absent when none exists. */
  readonly runtime?: string;
}

function shifted(shape: DeclaredShape, by: number): DeclaredShape {
  if (shape.kind !== "null" && shape.kind !== "type") return shape;
  return { ...shape, tested: { start: shape.tested.start + by, end: shape.tested.end + by } };
}

function nullTest(tested: string, negated: boolean, nullFirst: boolean): Condition {
  const operator = negated ? "!=" : "==";
  const text = nullFirst ? `null ${operator} ${tested}` : `${tested} ${operator} null`;
  const start = nullFirst ? text.length - tested.length : 0;
  return {
    name: nullFirst ? `null-${negated ? "ne" : "eq"}` : `${negated ? "ne" : "eq"}-null`,
    text,
    shape: { kind: "null", negated, tested: { start, end: start + tested.length } },
  };
}

function typeTest(tested: string, type: string, negated: boolean, name: string): Condition {
  return {
    name: negated ? `is-not-${name}` : `is-${name}`,
    text: `${tested} is ${negated ? "not " : ""}${type}`,
    shape: { kind: "type", negated, tested: { start: 0, end: tested.length }, type },
  };
}

function other(name: string, text: string): Condition {
  return { name, text, shape: { kind: "other" } };
}

function literal(value: boolean): Condition {
  return { name: String(value), text: String(value), shape: { kind: "literal", value } };
}

function not(condition: Condition): Condition {
  return { name: `not-${condition.name}`, text: `not (${condition.text})`, shape: { kind: "not" } };
}

function logic(operator: "and" | "or", left: Condition, right: Condition): Condition {
  return {
    name: `${left.name}-${operator}-${right.name}`,
    text: `${left.text} ${operator} ${right.text}`,
    shape: { kind: operator },
  };
}

/** `pairs` parentheses around the whole condition: the shape is unchanged, the tested site moves. */
function wrapped(condition: Condition, pairs: number, name: string): Condition {
  return {
    name,
    text: `${"(".repeat(pairs)}${condition.text}${")".repeat(pairs)}`,
    shape: shifted(condition.shape, pairs),
  };
}

/** The null and type tests the legacy narrows by, on the setup's tested expression. */
function narrowingTests(tested: string): Condition[] {
  return [
    nullTest(tested, false, false),
    nullTest(tested, false, true),
    nullTest(tested, true, false),
    nullTest(tested, true, true),
    typeTest(tested, "integer", false, "integer"),
    typeTest(tested, "integer", true, "integer"),
    typeTest(tested, "integer?", false, "integer-opt"),
    typeTest(tested, "null", false, "null"),
    typeTest(tested, "integer | string", false, "integer-or-string"),
    typeTest(tested, "integer[]", false, "integer-list"),
  ];
}

/** The comparisons and values that are no test: the `other` line of the switch. */
function otherTests(tested: string): Condition[] {
  return [
    other("eq-1", `${tested} == 1`),
    other("1-eq", `1 == ${tested}`),
    other("ne-w", `${tested} != w`),
    other("eq-n", `${tested} == n`),
    other("n-eq", `n == ${tested}`),
    other("otherwise", `${tested} otherwise 1`),
    other("bare", tested),
    other("neg", `-${tested}`),
    other("host", "hostValue"),
    other("int", "-1"),
  ];
}

const VARIABLE_SETUPS: readonly Setup[] = [
  {
    name: "integer-opt",
    prelude: "let v: integer? = hostValue\n",
    tested: "v",
    runtime: "let v: integer? = null\nif randomInteger(0..=1) == 1 { v = 1 }\n",
  },
  {
    name: "integer-or-string",
    prelude: "let v: integer | string = hostValue\n",
    tested: "v",
    runtime: 'let v: integer | string = 1\nif randomInteger(0..=1) == 1 { v = "a" }\n',
  },
  {
    name: "string-opt",
    prelude: "let v: string? = hostValue\n",
    tested: "v",
    runtime: 'let v: string? = null\nif randomInteger(0..=1) == 1 { v = "a" }\n',
  },
  {
    name: "integer",
    prelude: "let v: integer = hostValue\n",
    tested: "v",
    runtime: "let v: integer = 0\nif randomInteger(0..=1) == 1 { v = 1 }\n",
  },
  {
    name: "boolean-opt",
    prelude: "let v: boolean? = hostValue\n",
    tested: "v",
    runtime: "let v: boolean? = null\nif randomInteger(0..=1) == 1 { v = true }\n",
  },
  {
    name: "number-or-string",
    prelude: "let v: number | string = hostValue\n",
    tested: "v",
    runtime: 'let v: number | string = 1.5\nif randomInteger(0..=1) == 1 { v = "a" }\n',
  },
  { name: "null-only", prelude: "let v = null\n", tested: "v", runtime: "let v = null\n" },
  { name: "host", prelude: "let v = hostValue\n", tested: "v" },
];

/** The tested expressions that are no plain variable: `#narrowTest` narrows none of them. */
const PLACE_SETUPS: readonly Setup[] = [
  {
    name: "property",
    prelude: "let p: integer? = hostValue\nlet o = { p: p }\n",
    tested: "o.p",
    runtime: "let p: integer? = null\nif randomInteger(0..=1) == 1 { p = 1 }\nlet o = { p: p }\n",
  },
  {
    name: "index",
    prelude: "let xs: (integer | null)[] = hostList\n",
    tested: "xs[0]",
    runtime: "let xs: (integer | null)[] = [1]\nif randomInteger(0..=1) == 1 { xs[0] = null }\n",
  },
  {
    name: "call",
    prelude: "function h { return hostValue }\n",
    tested: "h()",
    runtime: "function h {\n  if randomInteger(0..=1) == 1 { return 1 }\n  return null\n}\n",
  },
];

/** The variable `w` and the null-valued `n` that the `other` comparisons read. */
const OTHER_PRELUDE = "let w: integer? = hostValue\nlet n = null\n";
const OTHER_RUNTIME =
  "let w: integer? = null\nif randomInteger(0..=1) == 1 { w = 1 }\nlet n = null\n";

/** The statement that consumes a condition, with the reads around it, at the top level. */
function consume(consumer: Exclude<Consumer, "switch">, condition: string, read: string): string {
  switch (consumer) {
    case "if":
      return `if ${condition} { let t = ${read} } else { let f = ${read} }\nlet u = ${read}\nexit\n`;
    case "exit":
      return `if ${condition} { exit }\nlet u = ${read}\nexit\n`;
    case "while":
      return `while ${condition} { let t = ${read} }\nlet u = ${read}\nexit\n`;
    case "value":
      return `let b = ${condition}\nlet u = ${read}\nexit\n`;
  }
}

/** Where `consume` puts the condition, from the start of its text. */
function conditionOffset(consumer: Exclude<Consumer, "switch">): number {
  switch (consumer) {
    case "if":
    case "exit":
      return "if ".length;
    case "while":
      return "while ".length;
    case "value":
      return "let b = ".length;
  }
}

interface Template {
  readonly id: string;
  readonly source: string;
  readonly consumer: Consumer;
  readonly conditionStart: number | null;
  readonly conditionText: string | null;
  readonly shape: DeclaredShape | null;
  /** The source of the differential's variant without host globals, when the setup has one. */
  readonly runtime: string | null;
}

function template(
  group: string,
  setup: Setup,
  condition: Condition,
  consumer: Exclude<Consumer, "switch">,
  extra: { readonly prelude: string; readonly runtime: string } = { prelude: "", runtime: "" },
): Template {
  const read = setup.read ?? setup.tested;
  const prelude = `${setup.prelude}${extra.prelude}`;
  const start = prelude.length + conditionOffset(consumer);
  return {
    id: `${group}/${setup.name}/${condition.name}/${consumer}`,
    source: `${prelude}${consume(consumer, condition.text, read)}`,
    consumer,
    conditionStart: start,
    conditionText: condition.text,
    shape: shifted(condition.shape, start),
    runtime: variant(setup, condition, extra.runtime, consume(consumer, condition.text, read)),
  };
}

/** A host flag the differential's variant declares in place of the host global of that name. */
const FLAG_RUNTIME = "let hostFlag = randomInteger(0..=1) == 1\n";

/**
 * The differential's variant of a template: the setup's globals-free prelude, a declared `hostFlag` when the condition
 * reads it, and the same consumer; none when the setup has no variant or the condition reads `hostValue` itself.
 */
function variant(
  setup: Setup,
  condition: Condition,
  extra: string,
  consumed: string,
): string | null {
  if (setup.runtime === undefined || condition.text.includes("hostValue")) return null;
  const flag = condition.text.includes("hostFlag") ? FLAG_RUNTIME : "";
  return `${flag}${setup.runtime}${extra}${consumed}`;
}

const CONSUMERS: readonly Exclude<Consumer, "switch">[] = ["if", "exit", "while", "value"];
const LOGIC_OPERATORS: readonly ("and" | "or")[] = ["and", "or"];

function templates(): Template[] {
  const out: Template[] = [];
  const integerOpt = VARIABLE_SETUPS[0]!;
  const integerOrString = VARIABLE_SETUPS[1]!;
  // The null and type tests on a plain variable of each declared type, under each consumer.
  for (const setup of VARIABLE_SETUPS)
    for (const condition of narrowingTests(setup.tested))
      for (const consumer of CONSUMERS) out.push(template("narrow", setup, condition, consumer));
  // The same tests on a property, an element and a call: nothing narrows.
  for (const setup of PLACE_SETUPS)
    for (const condition of narrowingTests(setup.tested))
      out.push(template("place", setup, condition, "if"));
  // The comparisons and values that are no test, and the literals, on a nullable integer and an integer.
  for (const setup of [integerOpt, VARIABLE_SETUPS[3]!, VARIABLE_SETUPS[4]!])
    for (const condition of [...otherTests(setup.tested), literal(true), literal(false)])
      for (const consumer of CONSUMERS)
        out.push(
          template("other", setup, condition, consumer, {
            prelude: OTHER_PRELUDE,
            runtime: OTHER_RUNTIME,
          }),
        );
  // `not` over a test, a literal, a host flag and a comparison.
  for (const setup of [integerOpt, integerOrString])
    for (const inner of [
      nullTest(setup.tested, true, false),
      typeTest(setup.tested, "integer", false, "integer"),
      literal(true),
      other("flag", "hostFlag"),
      other("eq-1", `${setup.tested} == 1`),
    ])
      for (const consumer of CONSUMERS) out.push(template("not", setup, not(inner), consumer));
  // `and` and `or` with each side a test, a host flag or a literal; the right operand's flow is the left's outcome.
  for (const setup of [integerOpt, integerOrString]) {
    const sides = [
      nullTest(setup.tested, true, false),
      typeTest(setup.tested, "integer", false, "integer"),
      other("flag", "hostFlag"),
      literal(true),
      literal(false),
    ];
    for (const operator of LOGIC_OPERATORS)
      for (const left of sides)
        for (const right of sides)
          out.push(template("logic", setup, logic(operator, left, right), "if"));
  }
  // The right operand that is no boolean is still checked; a call on the right that writes the variable.
  for (const condition of [
    logic("and", literal(false), other("1", "1")),
    logic("or", literal(true), other("1", "1")),
    logic("and", other("flag", "hostFlag"), other("1", "1")),
  ])
    out.push(template("logic", integerOpt, condition, "if"));
  const bump: Setup = {
    name: "integer-opt-bump",
    prelude: "let v: integer? = hostValue\nfunction bump {\n  v = null\n  return true\n}\n",
    tested: "v",
    runtime:
      "let v: integer? = null\nif randomInteger(0..=1) == 1 { v = 1 }\nfunction bump {\n  v = null\n  return true\n}\n",
  };
  for (const condition of [
    logic("and", nullTest("v", true, false), other("bump", "bump()")),
    logic("and", other("bump", "bump()"), nullTest("v", true, false)),
    logic("or", nullTest("v", false, false), other("bump", "bump()")),
  ])
    out.push(template("logic", bump, condition, "if"));
  // The parentheses `unwrap` reads through: around the whole, one operand, five pairs; `null` against `(null)`.
  const ne = nullTest("v", true, false);
  const is = typeTest("v", "integer", false, "integer");
  const both = logic("and", ne, is);
  for (const condition of [
    wrapped(ne, 1, "ne-null-whole"),
    wrapped(ne, 5, "ne-null-five"),
    nullTest("(v)", true, false),
    { ...ne, name: "ne-null-right", text: "v != (null)" },
    wrapped(is, 1, "is-integer-whole"),
    wrapped(is, 5, "is-integer-five"),
    typeTest("(v)", "integer", false, "integer"),
    wrapped(both, 1, "ne-and-is-whole"),
    wrapped(both, 5, "ne-and-is-five"),
    logic("and", wrapped(ne, 1, "paren-ne-null"), is),
    logic("and", ne, wrapped(is, 1, "paren-is-integer")),
    {
      name: "null-eq-null",
      text: "null == null",
      shape: { kind: "null", negated: false, tested: { start: 0, end: 4 } },
    },
    {
      name: "null-eq-paren-null",
      text: "null == (null)",
      shape: { kind: "null", negated: false, tested: { start: 0, end: 4 } },
    },
    {
      name: "paren-null-eq-null",
      text: "(null) == null",
      shape: { kind: "null", negated: false, tested: { start: 0, end: 6 } },
    },
  ] satisfies Condition[])
    out.push(template("parens", integerOpt, condition, "if"));
  // A parameter without a type (Q1: the current narrowing, pinned; stage 5 gives each call its own view).
  for (const condition of [
    nullTest("p", true, false),
    typeTest("p", "integer", false, "integer"),
  ]) {
    const prelude = "function g(p) {\n  ";
    const body = `if ${condition.text} { let t = p } else { let f = p }\n  let u = p\n}\ng(1)\ng(null)\nexit\n`;
    const start = prelude.length + "if ".length;
    out.push({
      id: `parameter/untyped/${condition.name}/if`,
      source: `${prelude}${body}`,
      consumer: "if",
      conditionStart: start,
      conditionText: condition.text,
      shape: shifted(condition.shape, start),
      runtime: `${prelude}${body}`,
    });
  }
  // The switch's `case is` and `case null`: no condition expression; the facts and the collector's tests pinned.
  for (const setup of [integerOrString, { ...integerOpt, name: "integer-opt" }]) {
    const body =
      "switch v {\n  case null { let f = v }\n  case is integer { let t = v }\n  default { let d = v }\n}\nlet u = v\nexit\n";
    out.push({
      id: `switch/${setup.name}/case-is-integer/switch`,
      source: `${setup.prelude}${body}`,
      consumer: "switch",
      conditionStart: null,
      conditionText: null,
      shape: null,
      runtime: setup.runtime === undefined ? null : `${setup.runtime}${body}`,
    });
  }
  return out;
}

/** The `let` of `name` anywhere in the statements, including blocks, cases and function bodies. */
function findLet(
  statements: readonly Statement[],
  name: string,
): Extract<Statement, { kind: "letStatement" }> | undefined {
  const work: Statement[] = [...statements];
  while (work.length > 0) {
    const statement = work.shift()!;
    if (statement.kind === "letStatement" && statement.name.name === name) return statement;
    switch (statement.kind) {
      case "ifStatement":
        work.push(...statement.thenBlock.statements);
        if (statement.elseBlock?.kind === "block") work.push(...statement.elseBlock.statements);
        else if (statement.elseBlock !== null) work.push(statement.elseBlock);
        break;
      case "whileStatement":
      case "functionDeclaration":
        work.push(...statement.body.statements);
        break;
      case "switchStatement":
        for (const switchCase of statement.cases) work.push(...switchCase.body.statements);
        if (statement.defaultBlock !== null) work.push(...statement.defaultBlock.statements);
        break;
      default:
        break;
    }
  }
  return undefined;
}

/** The condition expression a consumer evaluates at `site`: an `if` or `while` condition, or a `let` initializer. */
export function conditionAt(program: Program, { start, end }: Site): Expression | undefined {
  const work: Statement[] = [...program.statements];
  while (work.length > 0) {
    const statement = work.shift()!;
    const candidate =
      statement.kind === "ifStatement" || statement.kind === "whileStatement"
        ? statement.condition
        : statement.kind === "letStatement"
          ? statement.initializer
          : undefined;
    if (
      candidate !== undefined &&
      candidate.span.start.offset === start &&
      candidate.span.end.offset === end
    )
      return candidate;
    if (statement.kind === "functionDeclaration") work.push(...statement.body.statements);
  }
  return undefined;
}

export interface GeneratedRow {
  readonly row: ConditionRow;
  /** The differential's variant of the source, which reads no host global; `null` when the setup has none. */
  readonly runtime: string | null;
}

/** The table: every template, observed by the legacy oracle and the collector on the current build. */
export function generateConditionTable(): GeneratedRow[] {
  return templates().map((entry) => {
    const made = request([{ path: "main.tease", source: entry.source }], CONDITION_GLOBALS, []);
    if (made === null)
      throw new Error(`${entry.id}: the source does not parse or resolve\n${entry.source}`);
    const program = made.files[0]!.program;
    const outcome = analyzeTypes(made);
    const facts = outcome.facts();
    const factAt = (node: Expression): string | null =>
      facts.values.find(
        (value) =>
          value.site.file === 0 &&
          value.site.start === node.span.start.offset &&
          value.site.end === node.span.end.offset &&
          value.kind === node.kind,
      )?.type ?? null;
    const readOf = (name: string): string | null => {
      const statement = findLet(program.statements, name);
      return statement === undefined ? null : factAt(statement.initializer);
    };
    let condition: ConditionRow["condition"] = null;
    if (entry.conditionStart !== null && entry.conditionText !== null) {
      const site = {
        start: entry.conditionStart,
        end: entry.conditionStart + entry.conditionText.length,
      };
      const node = conditionAt(program, site);
      if (node === undefined)
        throw new Error(`${entry.id}: no condition at ${site.start}-${site.end}`);
      condition = { ...site, fact: factAt(node) };
    }
    const row: ConditionRow = {
      id: entry.id,
      source: entry.source,
      consumer: entry.consumer,
      condition,
      shape: entry.shape,
      reads: { t: readOf("t"), f: readOf("f"), u: readOf("u") },
      diagnostics: outcome.checked.diagnostics
        .flat()
        .map((diagnostic) => ({
          severity: diagnostic.severity,
          code: diagnostic.code,
          start: diagnostic.span.start.offset,
          end: diagnostic.span.end.offset,
          message: diagnostic.message,
        })),
      unreachable: [...outcome.checked.unreachable]
        .map((statement) => ({
          start: statement.span.start.offset,
          end: statement.span.end.offset,
        }))
        .sort((a, b) => a.start - b.start || a.end - b.end),
      tests: graphText(collectGraph(made))
        .split("\n")
        .filter((line) => line.startsWith("test ")),
    };
    return { row, runtime: entry.runtime };
  });
}
