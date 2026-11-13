import assert from "node:assert/strict";
import test from "node:test";
import {
  type CheckedDiagnostic,
  type DiagnosticRule,
} from "../../../src/type-inference/core/result.js";
import { analysed } from "../../helpers/type-core/type-core-signatures-setup.js";

/*
 * C13 (S3) for S9b's first consumers: a `for` loop's iterable, a built-in method's arguments, the elements
 * `join` and `sort` read, what `toJson` writes (Astra's G1) and what a choice's buttons return (TSV029):
 * each consumer's operand, written in every form a value reaches it by, of a kind that fits, of one that does not, of
 * both possible, or unknown, gives the ordered predicate's verdict at its own site, in both orders, and a stop never
 * turns it into an error; on the candidate route each verdict's check is the runtime's own, at the use, before the next
 * effect; and each consumer's work grows with the program.
 */

/** A consumer of the family: its program around the operand `V`, the kinds it takes, a fitting and a misfit value. */
interface Consumer {
  readonly name: string;
  /** The rule its diagnostics carry. */
  readonly rule: DiagnosticRule["rule"];
  readonly program: (operand: string) => string;
  readonly fit: string;
  readonly misfit: string;
  /** The diagnostic's kind, and where it stands: at the operand, or at the call that reads the operand's elements. */
  readonly kind: "operator" | "member-read";
  readonly at: "operand" | ((source: string, operand: string) => readonly [number, number]);
  /** Whether an unknown operand owes the consumer's warning (C13's rule), or the runtime checks it (`toJson`, TSV029). */
  readonly unknown: boolean;
}

/** The call around an operand: from the operand to the end of the call's parentheses. */
const call =
  (method: string) =>
  (source: string, operand: string): readonly [number, number] => {
    const start = source.lastIndexOf(`${operand}.${method}(`);
    return [start, source.indexOf(")", start + `${operand}.${method}(`.length) + 1];
  };

const CONSUMERS: readonly Consumer[] = [
  {
    name: "a for loop's iterable",
    rule: "iterable",
    program: (v) => `for e in ${v} {}`,
    fit: "[1]",
    misfit: "1",
    kind: "operator",
    at: "operand",
    unknown: true,
  },
  {
    name: "a pair loop's iterable",
    rule: "iterable",
    program: (v) => `for k, e in ${v} {}`,
    fit: "dict{a: 1}",
    misfit: "[1]",
    kind: "operator",
    at: "operand",
    unknown: true,
  },
  {
    name: "text or a regex an argument of text takes",
    rule: "argument",
    program: (v) => `say "abc".contains(${v})`,
    fit: '"a"',
    misfit: "1",
    kind: "operator",
    at: "operand",
    unknown: true,
  },
  {
    name: "a regex an argument of text takes",
    rule: "argument",
    program: (v) => `say "abc".matches(${v})`,
    fit: "/a/",
    misfit: '"a"',
    kind: "operator",
    at: "operand",
    unknown: true,
  },
  {
    name: "a list or a set an argument of a list takes",
    rule: "argument",
    program: (v) => `let r = [1].union(${v})`,
    fit: "[2]",
    misfit: "1",
    kind: "operator",
    at: "operand",
    unknown: true,
  },
  {
    name: "join's separator",
    rule: "argument",
    program: (v) => `say ["a"].join(${v})`,
    fit: '","',
    misfit: "1",
    kind: "operator",
    at: "operand",
    unknown: true,
  },
  {
    name: "the elements join shows",
    rule: "elements",
    program: (v) => `say ${v}.join()`,
    fit: '["a"]',
    misfit: "[{n: 1}]",
    kind: "member-read",
    at: call("join"),
    unknown: false,
  },
  {
    name: "the elements sort orders",
    rule: "elements",
    program: (v) => `${v}.sort()`,
    fit: "[2, 1]",
    misfit: "[{n: 1}]",
    kind: "member-read",
    at: call("sort"),
    unknown: false,
  },
  {
    name: "a value toJson writes below its argument",
    rule: "json",
    program: (v) => `say toJson({a: ${v}})`,
    fit: "[1]",
    misfit: "[1..2]",
    kind: "operator",
    at: (source) => {
      const start = source.lastIndexOf("{a: ");
      return [start, source.indexOf("})", start) + 1];
    },
    unknown: false,
  },
  {
    name: "a value toJson writes in a dict",
    rule: "json",
    program: (v) => `say toJson(dict{a: ${v}})`,
    fit: "[1]",
    misfit: "[1..2]",
    kind: "operator",
    at: (source) => {
      const start = source.lastIndexOf("dict{a: ");
      return [start, source.indexOf("})", start) + 1];
    },
    unknown: false,
  },
  {
    name: "a value toJson writes in a list",
    rule: "json",
    program: (v) => `say toJson([${v}])`,
    fit: "[1]",
    misfit: "[1..2]",
    kind: "operator",
    at: (source) => {
      const start = source.lastIndexOf("toJson([") + "toJson(".length;
      return [start, source.lastIndexOf("])") + 1];
    },
    unknown: false,
  },
  {
    name: "a held choice object's text, where it has no value",
    rule: "choice",
    program: (v) => `let w = {text: ${v}}\nlet c = askChoice w`,
    fit: '"a"',
    misfit: "{n: 1}",
    kind: "operator",
    at: (source) => {
      const start = source.lastIndexOf("askChoice w") + "askChoice ".length;
      return [start, start + 1];
    },
    unknown: true,
  },
  {
    name: "a held choice object's value",
    rule: "choice",
    program: (v) => `let w = {text: "t", value: ${v}}\nlet c = askChoice w`,
    fit: "1",
    misfit: "{n: 1}",
    kind: "operator",
    at: (source) => {
      const start = source.lastIndexOf("askChoice w") + "askChoice ".length;
      return [start, start + 1];
    },
    unknown: true,
  },
  {
    name: "a held choice object's text as an element of a choice's list",
    rule: "choice",
    program: (v) => `let w = {text: ${v}}\nlet c = askChoice [w, "b"]`,
    fit: '"a"',
    misfit: "{n: 1}",
    kind: "operator",
    at: (source) => {
      const start = source.lastIndexOf("askChoice [w") + "askChoice [".length;
      return [start, start + 1];
    },
    unknown: true,
  },
  {
    name: "a choice object's value",
    rule: "choice",
    program: (v) => `let c = askChoice {text: "x", value: ${v}}`,
    fit: "1",
    misfit: "{n: 1}",
    kind: "operator",
    at: "operand",
    unknown: true,
  },
  {
    name: "an element of a choice's list",
    rule: "choice",
    program: (v) => `let c = askChoice [${v}]`,
    fit: '"a"',
    misfit: "[1]",
    kind: "operator",
    at: "operand",
    unknown: false,
  },
];

/** How a value reaches the operand: its setup before the program, and the operand's text. */
interface Form {
  readonly name: string;
  readonly reach: (value: string) => readonly [string, string];
}

const FORMS: readonly Form[] = [
  { name: "written", reach: (value) => ["", value] },
  { name: "a variable", reach: (value) => [`let v = ${value}\n`, "v"] },
  { name: "a property", reach: (value) => [`let o = {p: ${value}}\n`, "o.p"] },
  {
    name: "a function's result",
    reach: (value) => [`function f {\n  return ${value}\n}\n`, "f()"],
  },
];

/** The verdicts: none at the operand, an error, a warning with the operand's check. */
type Verdict = "quiet" | "error" | "warning";

/**
 * A consumer's diagnostics of its own rule (any site: one elsewhere is a defect too) as a verdict at its site: none, an
 * error, or warnings each with the operand check its obligation owes there.
 */
function verdict(
  diagnostics: readonly CheckedDiagnostic[],
  consumer: Consumer,
  site: readonly [number, number],
): Verdict | string {
  const own = diagnostics.filter((d) => "rule" in d && d.rule.rule === consumer.rule);
  const described = own.map((d) => `${d.class} ${d.kind} @${d.site.start}-${d.site.end}`);
  if (own.length === 0) return "quiet";
  if (
    !own.every(
      (d) => d.kind === consumer.kind && d.site.start === site[0] && d.site.end === site[1],
    )
  )
    return described.join(", ");
  if (own.every((d) => d.class === "compile-error")) return "error";
  if (
    own.every(
      (d) =>
        d.class === "warning-runtime-check" &&
        d.kind !== "budget" &&
        d.obligation.kind === "operand" &&
        d.obligation.site.start === site[0],
    )
  )
    return "warning";
  return described.join(", ");
}

/**
 * The family over C13's axes (closing a family by construction): every consumer × every form × a fitting value, a misfit
 * one, both possible (a function's two returns) and an unknown one (host data), in both orders. The verdict is derived
 * from the axes alone: a fitting value is quiet; a misfit the error, a possible misfit the warning with its check; an
 * unknown the warning where the consumer's rule warns of one, else quiet.
 */
test("C13's consumers give the ordered predicate's verdict for every form, kind and certainty, in both orders", (t) => {
  const differing: string[] = [];
  let programs = 0;
  for (const consumer of CONSUMERS) {
    const outcomes = (value: string, name: string, expected: Verdict): void => {
      for (const form of FORMS) {
        const [setup, operand] = form.reach(value);
        const source = `${setup}${consumer.program(operand)}\nexit\n`;
        const at = consumer.at;
        const site =
          at === "operand"
            ? ([source.lastIndexOf(operand), source.lastIndexOf(operand) + operand.length] as const)
            : at(source, operand);
        const got = verdict(analysed(source), consumer, site);
        programs += 1;
        if (got !== expected) differing.push(`${consumer.name}, ${form.name}, ${name}: ${got}`);
      }
    };
    outcomes(consumer.fit, "fitting", "quiet");
    outcomes(consumer.misfit, "misfit", "error");
    // (both possible: a list's element or the default of its `get`, Q2)
    const possible = `[${consumer.fit}].get(hostValue, default: ${consumer.misfit})`;
    const setup = "";
    {
      const source = `${setup}${consumer.program(possible)}\nexit\n`;
      const at = consumer.at;
      const site =
        at === "operand"
          ? ([
              source.lastIndexOf(possible),
              source.lastIndexOf(possible) + possible.length,
            ] as const)
          : at(source, possible);
      const got = verdict(analysed(source), consumer, site);
      programs += 1;
      if (got !== "warning") differing.push(`${consumer.name}, possible: ${got}`);
    }
    {
      const source = `${consumer.program("hostValue")}\nexit\n`;
      const at = consumer.at;
      const site =
        at === "operand"
          ? ([
              source.indexOf("hostValue"),
              source.indexOf("hostValue") + "hostValue".length,
            ] as const)
          : at(source, "hostValue");
      const got = verdict(analysed(source), consumer, site);
      programs += 1;
      const expected: Verdict = consumer.unknown ? "warning" : "quiet";
      if (got !== expected) differing.push(`${consumer.name}, unknown: ${got}`);
    }
  }
  t.diagnostic(`${programs} programs, each in both orders`);
  assert.deepEqual(differing, []);
});

/**
 * Astra's G2: a compound assignment's operation is its binary form's, one operand consumer (C4, F16) for both: over each
 * compound operator, a variable's and a property's target and an operand that fits, does not fit, is null or unknown,
 * the compound form owes what the binary form owes, each obligation's kind, target domain and verdict alike, its site
 * the compound's statement where the binary form's is its operation, and an operand's own where it is the operand's; a
 * known calendar duration with an exact offset is the same error beside it (decision 6 on #1072).
 */
test("a compound assignment owes what its binary form owes, for every operator, target and operand (G2)", (t) => {
  const differing: string[] = [];
  let pairs = 0;
  for (const operator of ["+", "-"])
    for (const [setup, target] of [
      ["let x = 4\n", "x"],
      ["let o = {x: 4}\n", "o.x"],
      ["let xs = [4]\n", "xs[0]"],
      ['let d = toDate("2026-08-11")\n', "d"],
      ['let ds = [toDate("2026-08-11")]\n', "ds[0]"],
    ] as const)
      for (const operand of ["2", '"a"', "1 calendar day + 2 h", "null", "hostValue"]) {
        const compound = `${setup}${target} ${operator}= ${operand}\nexit\n`;
        const binary = `${setup}${target} = ${target} ${operator} (${operand})\nexit\n`;
        const operation = (source: string, statement: boolean): string[] =>
          analysed(source)
            .filter(
              (d) =>
                "rule" in d && (d.rule.rule === "operator" || d.rule.rule === "calendar-offset"),
            )
            .map((d) => {
              const whole = statement
                ? d.site.start === source.indexOf(`${target} ${operator}=`)
                : d.site.start === source.indexOf(`${target} ${operator} (`);
              const obligation =
                d.class === "warning-runtime-check" && d.kind !== "budget"
                  ? ` ${d.obligation.kind} [${d.obligation.against.join(", ")}]`
                  : "";
              return `${d.class}${obligation} ${whole ? "the operation" : `'${source.slice(d.site.start, d.site.end)}'`}`;
            })
            .sort();
        const [got, expected] = [operation(compound, true), operation(binary, false)];
        pairs += 1;
        // (the binary form's own operand sits in parentheses, its text the operand's alike)
        if (
          JSON.stringify(got) !==
          JSON.stringify(expected.map((e) => e.replace(`'(${operand})'`, `'${operand}'`)))
        )
          differing.push(
            `${compound.replace(/\n/g, "; ")}: ${got.join(", ")} against ${expected.join(", ")}`,
          );
      }
  // an element target's index is read as an operand of either form is: a known conversion error there stands at each
  // copy of it (Sol r1 N1)
  for (const operator of ["+", "-"]) {
    const index = 'toInteger("bad", default: 0)';
    const compound = `let xs = [4]\nxs[${index}] ${operator}= 1\nexit\n`;
    const binary = `let xs = [4]\nxs[${index}] = xs[${index}] ${operator} 1\nexit\n`;
    for (const source of [compound, binary]) {
      const conversions = analysed(source)
        .filter((d) => d.kind === "static" && d.rule.rule === "conversion")
        .map((d) => d.site.start);
      const copies = [...source.matchAll(/"bad"/g)].map((found) => found.index);
      if (JSON.stringify(conversions) !== JSON.stringify(copies))
        differing.push(`${source.replace(/\n/g, "; ")}: conversions at ${conversions.join(", ")}`);
      pairs += 1;
    }
  }
  t.diagnostic(`${pairs} compound forms against their binary forms`);
  assert.deepEqual(differing, []);
});

/**
 * C13 on receivers of several kinds and elements of several ordered types: an argument is checked where every kind the
 * receiver may be takes only some kinds (a text-or-list's `startsWith` is text's alone), and quiet where one kind takes
 * any value (a list's `contains`); `sort`'s elements of two ordered types possible are the warning with its check, in
 * both orders.
 */
test("C13 decides an argument by every kind its receiver may be, and sort by every ordered type its elements may be", () => {
  const either = '[["x"]].get(hostValue, default: "abc")';
  const own = (source: string, rule: DiagnosticRule["rule"]): string[] =>
    analysed(source)
      .filter((d) => "rule" in d && d.rule.rule === rule)
      .map((d) => `${d.class} '${source.slice(d.site.start, d.site.end)}'`);
  assert.deepEqual(own(`say ${either}.contains(1)\nexit\n`, "argument"), []);
  assert.deepEqual(own(`say ${either}.startsWith(1)\nexit\n`, "argument"), ["compile-error '1'"]);
  const mixed = '[[1].get(hostValue, default: "a")]';
  assert.deepEqual(own(`let xs = ${mixed}\nxs.sort()\nexit\n`, "elements"), [
    "warning-runtime-check 'xs.sort()'",
  ]);
  assert.deepEqual(
    own(`let xs = [[1].get(hostValue, default: 2)]\nxs.sort()\nexit\n`, "elements"),
    [],
  );
});
