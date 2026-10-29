import assert from "node:assert/strict";
import test from "node:test";

import { compileSource, compileSourceWithBackend } from "../src/compiler.js";
import { DICT_METHODS, dictMethod } from "../src/dict-operations.js";
import { LIST_METHODS, listMethod } from "../src/list-methods.js";
import { TEXT_METHODS } from "../src/text-operations.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { run } from "../src/runtime/engine.js";
import {
  createCapturedSerializableList,
  createCapturedSerializableObject,
  type SerializableRuntimeValue,
} from "../src/runtime/values/serializable-values.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { checkedResult } from "../src/type-inference/core/consumer.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import type { CompactRecord } from "./helpers/type-core-records.js";
import { publishedAnswers } from "./helpers/type-core-standing.js";
import {
  derive,
  evaluate,
  syntaxOf,
  Underivable,
  type PredictedRun,
} from "./helpers/type-core-derived.js";
import { assignments, runGlobals } from "./helpers/type-core-route.js";
import type { CheckedDiagnostic, DiagnosticRule } from "../src/type-inference/core/result.js";

/*
 * C13 (TABLE C13, S3 §1) for S9b's first consumers: a `for` loop's iterable, a built-in method's arguments, the elements
 * `join` and `sort` read, what `toJson` writes (Astra's G1) and what a choice's buttons return (TSV029, TABLE r4.93):
 * each consumer's operand, written in every form a value reaches it by, of a kind that fits, of one that does not, of
 * both possible, or unknown, gives the ordered predicate's verdict at its own site, in both orders, and a stop never
 * turns it into an error; on the candidate route each verdict's check is the runtime's own, at the use, before the next
 * effect; and each consumer's work grows with the program.
 */

/**
 * A program's diagnostics with their rules, its record compared in the core's order and with its consumers' and solver's
 * orders reversed: both, equal.
 */
function analysed(source: string, allowance?: number): readonly CheckedDiagnostic[] {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const allowed = <T>(make: () => T): T =>
    allowance === undefined ? make() : withTestAllowance(allowance, make);
  const forward = allowed(() => compactAnalysis(request));
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => allowed(() => compactAnalysis(request)),
    ),
  );
  assert.deepEqual(reversed, forward, `${source}: both orders`);
  return allowed(() => checkedResult(analyseCore(request), request)).diagnostics;
}

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
    unknown: false,
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
    unknown: false,
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
    unknown: false,
  },
  {
    name: "a choice object's value",
    rule: "choice",
    program: (v) => `let c = askChoice {text: "x", value: ${v}}`,
    fit: "1",
    misfit: "{n: 1}",
    kind: "operator",
    at: "operand",
    unknown: false,
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

/** A run of `plan` to its end with `hostValue`: what it said, and the code and span of its failure. */
function ran(plan: InstructionPlan, hostValue: SerializableRuntimeValue) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
  };
}

/**
 * The source-to-runtime pairs of C13's new consumers on the candidate route: each warning's check is the use's own,
 * so the plan holds no check content for it and the same plan as the production route's checks; a value that fits
 * runs on, one that does not stops the run at the use, before the next effect.
 */
test("each new C13 warning's check is its use's own on the candidate route: a fitting run goes on, a misfit stops at the use", () => {
  // each program, its warned use, the call whose own check stops the run, its code, a fitting and a misfit value
  const object = createCapturedSerializableObject([{ name: "n", value: 1 }]);
  const cases: readonly (readonly [
    string,
    string,
    string,
    string,
    SerializableRuntimeValue,
    SerializableRuntimeValue,
  ])[] = [
    // (an argument of text, of a list; the elements `join` shows, `sort` orders; what `toJson` writes)
    [
      'say "abc".contains(hostValue)\nsay "after"\nexit\n',
      "hostValue",
      '"abc".contains(hostValue)',
      "TSV043",
      "a",
      1,
    ],
    [
      'let r = [1].union(hostValue)\nsay "after"\nexit\n',
      "hostValue",
      "[1].union(hostValue)",
      "TSV043",
      createCapturedSerializableList([2]),
      1,
    ],
    [
      'let xs = [hostValue]\nsay xs.join()\nsay "after"\nexit\n',
      "xs.join()",
      "xs.join()",
      "TSV042",
      "a",
      object,
    ],
    [
      'let xs = [hostValue, hostValue]\nxs.sort()\nsay "after"\nexit\n',
      "xs.sort()",
      "xs.sort()",
      "TSV043",
      2,
      object,
    ],
    [
      'say toJson(hostValue otherwise /a/)\nsay "after"\nexit\n',
      "hostValue otherwise /a/",
      "toJson(hostValue otherwise /a/)",
      "TSV043",
      "x",
      null,
    ],
  ];
  for (const [source, use, stops, code, fitting, misfit] of cases) {
    const result = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
    assert.ok(result.plan !== null, source);
    const at = source.indexOf(use);
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.span.start.offset === at &&
          d.span.end.offset === at + use.length,
      ),
      `${source}: ${result.diagnostics.map((d) => d.message).join(" | ")}`,
    );
    const fits = ran(result.plan, fitting);
    assert.equal(fits.failure, null, `${source}: fitting`);
    assert.equal(fits.said.at(-1), "after", `${source}: fitting`);
    const call = source.indexOf(stops);
    assert.deepEqual(
      ran(result.plan, misfit),
      { said: [], failure: `${code}@${call}:${call + stops.length}` },
      `${source}: misfit`,
    );
  }
});

/** The work families of the new consumers, each at size k (the lead's gates: total 2.15, counters 2.35 per doubling). */
const SIGNATURE_FAMILIES: readonly {
  readonly name: string;
  readonly program: (k: number) => string;
}[] = [
  {
    name: "k method arguments on one text and one list",
    program: (k) =>
      `let t = "abc"\nlet xs = [1]\n${Array.from({ length: k }, (_, i) => `say t.contains("${i}")\nlet r${i} = xs.union([${i}])`).join("\n")}\nexit\n`,
  },
  {
    name: "k lists each sorted and joined",
    program: (k) =>
      `${Array.from({ length: k }, (_, i) => `let x${i} = [${i}, 1]\nx${i}.sort()\nsay x${i}.join()`).join("\n")}\nexit\n`,
  },
  {
    name: "toJson of an object k wide",
    program: (k) =>
      `say toJson({${Array.from({ length: k }, (_, i) => `f${i}: [${i}]`).join(", ")}})\nexit\n`,
  },
  { name: "k compound assignments", program: (k) => `let x = 0\n${"x += 1\n".repeat(k)}exit\n` },
  {
    name: "k loops over one list",
    program: (k) => `let xs = [1, 2]\n${"for e in xs {}\n".repeat(k)}exit\n`,
  },
  {
    name: "k content checks of written host lists",
    program: (k) =>
      `${Array.from({ length: k }, (_, i) => `let x${i}: object[] = hostValue\nsay x${i}.join()\nsay toJson(x${i})`).join("\n")}\nexit\n`,
  },
  {
    name: "k choices of written choice objects",
    program: (k) =>
      `${Array.from({ length: k }, (_, i) => `let c${i} = askChoice [{text: "a", value: ${i}}, {text: "b", value: "${i}"}]`).join("\n")}\nexit\n`,
  },
];

/**
 * The new consumers' work grows with the program: each family at k = 64 and 128, in the core's order and reversed, with
 * the sharing of answers on and off, its charged total per doubling of its syntax nodes within 2.15 and each counter of
 * at least 200 units within 2.35 (the work test's gates), and the analysis within its allowance.
 */
test("each new C13 consumer's work and counters grow with the program in all four modes", () => {
  const steep: string[] = [];
  for (const family of SIGNATURE_FAMILIES)
    for (const reversed of [false, true])
      for (const unshared of [false, true]) {
        const [small, large] = [64, 128].map((k) => {
          const request = coreRequest([{ path: "main.tease", source: family.program(k) }]);
          assert.ok(request !== null, `${family.name} at ${k}`);
          const analyse = () =>
            reversed
              ? withConsumerOrder(
                  (list) => [...list].reverse(),
                  () => withSolverSeam({ reverseWorklist: true }, () => analyseCore(request)),
                )
              : analyseCore(request);
          const { budget } = unshared ? withoutSharing(analyse) : analyse();
          assert.equal(budget.exhausted, null, `${family.name} at ${k}: within the allowance`);
          return budget;
        });
        const scale =
          (large!.counts.get("syntaxNodes") ?? 0) / (small!.counts.get("syntaxNodes") ?? 1);
        const doubling = (before: number, after: number): number =>
          (2 * (after / Math.max(1, before))) / scale;
        const name = `${family.name}${reversed ? " reversed" : ""}${unshared ? " unshared" : ""}`;
        if (doubling(small!.total, large!.total) > 2.15)
          steep.push(`${name}: ${doubling(small!.total, large!.total).toFixed(3)}`);
        for (const [counter, after] of large!.counts)
          if (
            counter !== "syntaxNodes" &&
            after >= 200 &&
            doubling(small!.counts.get(counter) ?? 0, after) > 2.35
          )
            steep.push(
              `${name} ${counter}: ${doubling(small!.counts.get(counter) ?? 0, after).toFixed(3)}`,
            );
      }
  assert.deepEqual(steep, []);
});

/**
 * TABLE r4.93's witness (Astra's B6-r4): k record-valued nested choices, each TSV029's error, their answer read k levels
 * below: no record a button holds is composed into the answer, so the chain takes less work than its literal analogue
 * (the same objects read through `.value`, a deep literal read chain, itself the accepted read-chain product), at both
 * sizes and in both orders, and without the read it grows as the accepted nested-choice product (`I1106-nested-choices`
 * measured 3.06).
 */
test("record-valued nested choices compose no record: below their literal analogue, and within the nested-choice product", () => {
  const chain = (k: number, read: boolean): string => {
    let value = "0";
    for (let index = k - 1; index >= 0; index -= 1)
      value = `{x: askChoice {text: "${index}", value: ${value}}}`;
    return read
      ? `let c = (askChoice {text: "top", value: ${value}})${".x".repeat(k)}\nexit\n`
      : `let c = askChoice {text: "top", value: ${value}}\nexit\n`;
  };
  const analogue = (k: number): string => {
    let value = "0";
    for (let index = k - 1; index >= 0; index -= 1)
      value = `{x: {text: "${index}", value: ${value}}.value}`;
    return `let c = ${value}${".x".repeat(k)}\nexit\n`;
  };
  for (const reversed of [false, true]) {
    const budget = (source: string) => {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null);
      const analyse = () => analyseCore(request);
      const { budget: spent } = reversed
        ? withConsumerOrder(
            (list) => [...list].reverse(),
            () => withSolverSeam({ reverseWorklist: true }, analyse),
          )
        : analyse();
      assert.equal(spent.exhausted, null);
      return spent;
    };
    for (const k of [64, 128])
      assert.ok(
        budget(chain(k, true)).total < budget(analogue(k)).total,
        `at ${k}${reversed ? " reversed" : ""}`,
      );
    const [small, large] = [budget(chain(64, false)), budget(chain(128, false))];
    const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
    assert.ok((2 * (large.total / small.total)) / scale <= 3.06, `reversed: ${reversed}`);
  }
});

/**
 * The work of `join`'s and `sort`'s element checks does not grow with the list's width: over a list literal of k
 * elements (whose own check of one type, A8, is the literal's), the checks they add are the same at 64 and 128; and
 * `toJson`'s walk of an object k deep reads each level once, each level's path one step longer than the one above it
 * and charged as it is made: the read chain through nested literals, TABLE r4.83 (2)'s gated known limit (12,436 /
 * 41,682 units at k = 64, 128, 3.412 per doubling of the source), the depth no real script reaches.
 */
test("join's and sort's element checks take the same work at any width, and toJson's deep walk is the read chain's known product", () => {
  const spent = (source: string) => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null);
    return analyseCore(request).budget;
  };
  const list = (k: number): string =>
    `let xs = [${Array.from({ length: k }, (_, i) => String(i)).join(", ")}]\n`;
  const added = (k: number): number =>
    (spent(`${list(k)}xs.sort()\nsay xs.join()\nexit\n`).counts.get("checks") ?? 0) -
    (spent(`${list(k)}exit\n`).counts.get("checks") ?? 0);
  assert.equal(added(128), added(64));
  const deep = (k: number) => spent(`say toJson(${"{a: ".repeat(k)}1${"}".repeat(k)})\nexit\n`);
  const [small, large] = [deep(64), deep(128)];
  assert.equal(large.exhausted, null);
  const scale = (large.counts.get("syntaxNodes") ?? 0) / (small.counts.get("syntaxNodes") ?? 1);
  assert.ok((2 * (large.total / small.total)) / scale <= 3.42);
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

/** A value of each kind of a contract's parameter: one the parameter takes, and one it does not (`null`: it takes any). */
const PARAMETER_VALUES: Readonly<Record<string, readonly [string, string | null]>> = {
  text: ['"a"', "1"],
  regex: ["/a/", '"a"'],
  textOrRegex: ['"a"', "1"],
  position: ["1", '"x"'],
  count: ["1", '"x"'],
  index: ["0", '"x"'],
  list: ["[1]", "1"],
  collection: ["[1]", "1"],
  value: ["1", null],
  key: ['"a"', "1"],
};

/** A positional parameter of a contract: its receiver as written, its method, its parameters' kinds and its position. */
interface ContractParameter {
  readonly receiver: string;
  readonly name: string;
  readonly kinds: readonly string[];
  readonly position: number;
}

/**
 * Every positional parameter of the contracts of text, lists, sets and dicts (`TEXT_METHODS`, `LIST_METHODS`,
 * `DICT_METHODS`), on a receiver of each kind that has its method; a list's `get` is C2's with its `default:`.
 */
function contractParameters(): ContractParameter[] {
  const found: ContractParameter[] = [];
  const add = (receiver: string, name: string, kinds: readonly string[]): void =>
    kinds.forEach((_, position) => found.push({ receiver, name, kinds, position }));
  for (const method of Object.values(TEXT_METHODS))
    add(
      '"abc"',
      method.name,
      method.parameters.map((parameter) => parameter.kind),
    );
  for (const method of Object.keys(LIST_METHODS).map((name) => listMethod(name)!))
    if (method.named === undefined)
      for (const kind of method.receivers)
        add(
          kind === "list" ? "[1, 2]" : "[1, 2].toSet()",
          method.name,
          method.parameters.map((parameter) => parameter.kind),
        );
  for (const method of Object.keys(DICT_METHODS).map((name) => dictMethod(name)!))
    if (method.named === undefined)
      add(
        "dict{a: 1}",
        method.name,
        method.parameters.map(() => "key"),
      );
  return found;
}

/** The call of a contract's method with each argument a value its parameter takes, and `argument` at `position`. */
function contractCall(parameter: ContractParameter, argument: string): string {
  const values = parameter.kinds.map((kind, position) =>
    position === parameter.position ? argument : PARAMETER_VALUES[kind]![0],
  );
  return `${parameter.receiver}.${parameter.name}(${values.join(", ")})`;
}

/**
 * C13 by construction over the contracts (Sol r1 B1): every positional parameter of every text, list, set and dict
 * method that takes some kinds only rejects a definite misfit at the argument, in both orders, as the current checker
 * does; one that takes any value has no misfit.
 */
test("every parameter of the text, list, set and dict contracts that takes some kinds rejects a misfit at its argument", (t) => {
  const missing: string[] = [];
  const stored: string[] = [];
  let checked = 0;
  for (const parameter of contractParameters()) {
    const kind = parameter.kinds[parameter.position]!;
    const misfit = PARAMETER_VALUES[kind]?.[1];
    assert.ok(misfit !== undefined, `${parameter.name}: a parameter kind ${kind} with values`);
    if (misfit === null) continue;
    // (a list's `addAll` adds its argument's elements as a store, F5: the store's consumer's, outside the slice)
    if (parameter.name === "addAll") {
      stored.push(contractCall(parameter, misfit));
      continue;
    }
    const call = contractCall(parameter, misfit);
    const source = `${call}\nexit\n`;
    // (the argument's offset: the call up to it, each argument before it a fitting value)
    const at = contractCall(parameter, "\u0000").indexOf("\u0000");
    const rejected = analysed(source).some(
      (d) =>
        d.class === "compile-error" && d.site.start === at && d.site.end === at + misfit.length,
    );
    const legacy = compileSource(source).diagnostics.some((d) => d.severity === "error");
    checked += 1;
    if (!rejected || !legacy)
      missing.push(
        `${call}: ${rejected ? "" : "no error at the argument"}${legacy ? "" : " (the current checker: none)"}`,
      );
  }
  t.diagnostic(`${checked} parameters rejecting a misfit; a store's: ${stored.join(", ")}`);
  assert.deepEqual(missing, []);
  assert.deepEqual(stored, ["[1, 2].addAll(1)"]);
});

/**
 * The derived oracle follows every admitted argument check (Sol r1 B5): each text, list and set method's parameter that
 * takes some kinds, given host data on the candidate route, and the elements `join` shows and `sort` orders; every run
 * of the plan under each host value is the run the oracle derives from the record and the source, and each discharge
 * of an argument by the call's own check is violable: a host value stops the run at the call (removing the check
 * would show here).
 */
test("every admitted argument check runs as the derived oracle predicts, and each such discharge stops a run at its call", (t) => {
  const programs = [
    ...contractParameters()
      .filter((parameter) => !parameter.receiver.startsWith("dict"))
      .filter((parameter) => PARAMETER_VALUES[parameter.kinds[parameter.position]!]?.[1] !== null)
      .map((parameter) => `let r = ${contractCall(parameter, "hostValue")}\nsay "after"\nexit\n`),
    'let xs = [hostValue otherwise [1]]\nsay xs.join()\nsay "after"\nexit\n',
    'let xs = [hostValue]\nxs.sort()\nsay "after"\nexit\n',
  ];
  const differing: string[] = [];
  let [planned, outside, discharges] = [0, 0, 0];
  for (const source of programs) {
    let result: ReturnType<typeof compileSourceWithBackend>;
    try {
      result = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      outside += 1;
      continue;
    }
    if (result.plan === null) {
      differing.push(`${source}: no plan`);
      continue;
    }
    planned += 1;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    const syntax = syntaxOf(source);
    const derived = (() => {
      try {
        return derive(syntax, compactAnalysis(request));
      } catch (error) {
        if (error instanceof Underivable) return error.message;
        throw error;
      }
    })();
    if (typeof derived === "string") {
      differing.push(`${source}: underivable: ${derived}`);
      continue;
    }
    const failures: (string | null)[] = [];
    for (const inputs of assignments(["hostValue"])) {
      const ran = runGlobals(result.plan, inputs);
      let predicted: PredictedRun | string;
      try {
        predicted = evaluate(syntax, derived.stores, inputs, false, derived.content).run;
      } catch (error) {
        if (!(error instanceof Underivable)) throw error;
        predicted = `underivable: ${error.message}`;
      }
      if (JSON.stringify(ran) !== JSON.stringify(predicted))
        differing.push(
          `${source} with ${JSON.stringify(inputs)}: ran ${JSON.stringify(ran)}, derived ${JSON.stringify(predicted)}`,
        );
      failures.push(ran.failure);
    }
    for (const discharge of derived.discharges)
      if (discharge.by === "native" && discharge.what === "argument") {
        discharges += 1;
        if (!failures.some((failure) => failure?.split("@")[1] === discharge.site))
          differing.push(`${source}: the call's own check at ${discharge.site} stops no run`);
      }
  }
  t.diagnostic(
    `${planned} programs with a plan (${outside} outside the slice), ${discharges} argument discharges`,
  );
  assert.deepEqual(differing, []);
});

/**
 * G3's seam at every reader and stop (Sol r1 B3): a check that owes the runtime nothing, an ordinary warning or an
 * error, stands in the core's record (`compactAnalysis`), its publication (`publishedAnswers`) and the candidate route's
 * diagnostics beside a retained runtime obligation; at every allowance, also one that stops a question after the
 * finished analysis, each reader answers, and holds the check or the stop's warning.
 */
test("a check that owes the runtime nothing reaches every reader, and a stop after the finished analysis keeps the readers answering", () => {
  const cases: readonly (readonly [string, "warning" | "compile-error", string])[] = [
    ["let n: integer = hostValue\nfor i in 3..1 {}\nexit\n", "warning", "TSV046"],
    ['repeat toInteger("-2", default: 0) {}\nexit\n', "compile-error", "TSV011"],
    ['say toInteger("bad", default: 0)\nexit\n', "compile-error", "TSV043"],
  ];
  const failures: string[] = [];
  for (const [source, wanted, code] of cases) {
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, source);
    const bindings = new CoreProgram(request).places
      .filter(({ kind }) => kind.kind === "binding")
      .map((place) => place.id);
    const holds = (record: CompactRecord): boolean =>
      record.diagnostics.some((d) => d.kind === "static" && d.class === wanted);
    const stopped = (record: CompactRecord): boolean =>
      record.diagnostics.some((d) => d.kind === "budget");
    const record = compactAnalysis(request);
    if (!holds(record)) failures.push(`${source}: the record lacks it`);
    if (source.includes("hostValue") && record.checks.length === 0)
      failures.push(`${source}: the record lacks the retained obligation`);
    const published = JSON.parse(publishedAnswers(analyseCore(request), bindings, request).record);
    if (
      !published.serialized.diagnostics.some(
        (d: { kind: string; class: string }) => d.kind === "static" && d.class === wanted,
      )
    )
      failures.push(`${source}: the publication lacks it`);
    const compiled = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
    if (!compiled.diagnostics.some((d) => d.code === code))
      failures.push(`${source}: the candidate route lacks it`);
    const total = analyseCore(request).budget.total;
    for (let allowance = 1; allowance <= total + 400; allowance += 1) {
      let made: CompactRecord;
      let codes: string[];
      try {
        made = withTestAllowance(allowance, () => compactAnalysis(request));
        codes = withTestAllowance(allowance, () =>
          compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND),
        ).diagnostics.map((d) => d.code);
      } catch (error) {
        failures.push(`${source} at ${allowance}: ${String(error)}`);
        break;
      }
      if (!holds(made) && !stopped(made)) {
        failures.push(`${source} at ${allowance}: neither the check nor a stop`);
        break;
      }
      if (!codes.includes(code) && !codes.includes("TSV076")) {
        failures.push(`${source} at ${allowance}: the route has neither the check nor a stop`);
        break;
      }
    }
  }
  assert.deepEqual(failures, []);
});

/**
 * A content check over the contents a written type admits (the owner's review F2; ADR 0021 1.8, 1.10): where a value
 * comes from outside the script (host data, a load, a parse) into a written collection type, directly or through a copy,
 * an object holding it, an element of an outer list or a replacement of an empty one, the elements `join` shows, `sort`
 * orders, `toJson` writes and a choice's list gives are its written element type's: one that does not fit owes the check
 * at the use, a warning (a list may be empty, so never an error), and one that fits is quiet; the incoming check is no
 * substitute. A known empty list is quiet. (A narrowing `is` test's element type narrows an element read, `v[0]`, not
 * the element path these checks read: `narrowing.ts`'s, outside this family.)
 */
test("a content check reads the written element type of a value from outside the script: a misfit owes the use's check", (t) => {
  const consumers: readonly {
    readonly name: string;
    readonly rule: DiagnosticRule["rule"];
    readonly use: (receiver: string) => string;
    readonly site: (source: string, receiver: string) => readonly [number, number];
    readonly misfit: string;
    readonly fit: string;
  }[] = [
    {
      name: "join",
      rule: "elements",
      use: (r) => `let out = ${r}.join("|")`,
      site: (source, r) => {
        const start = source.lastIndexOf(`${r}.join(`);
        return [start, start + `${r}.join("|")`.length];
      },
      misfit: "object[]",
      fit: "string[]",
    },
    {
      name: "sort",
      rule: "elements",
      use: (r) => `${r}.sort()`,
      site: (source, r) => {
        const start = source.lastIndexOf(`${r}.sort()`);
        return [start, start + `${r}.sort()`.length];
      },
      misfit: "boolean[]",
      fit: "integer[]",
    },
    {
      name: "toJson",
      rule: "json",
      use: (r) => `say toJson(${r})`,
      site: (source, r) => {
        const start = source.lastIndexOf(`toJson(${r})`) + "toJson(".length;
        return [start, start + r.length];
      },
      misfit: "regex[]",
      fit: "integer[]",
    },
    {
      name: "a choice's list",
      rule: "choice",
      use: (r) => `let c = askChoice ${r}`,
      site: (source, r) => {
        const start = source.lastIndexOf(`askChoice ${r}`) + "askChoice ".length;
        return [start, start + r.length];
      },
      misfit: "integer[][]",
      fit: "integer[]",
    },
  ];
  const origins: readonly {
    readonly name: string;
    readonly source: (type: string, use: (receiver: string) => string) => readonly [string, string];
  }[] = [
    {
      name: "host data",
      source: (type, use) => [`let xs: ${type} = hostValue\n${use("xs")}\n`, "xs"],
    },
    {
      name: "a copy of host data",
      source: (type, use) => [`let xs: ${type} = hostValue\nlet ys = xs\n${use("ys")}\n`, "ys"],
    },
    {
      name: "an object's property",
      source: (type, use) => [
        `let h: ${type} = hostValue\nlet o = {xs: h}\n${use("o.xs")}\n`,
        "o.xs",
      ],
    },
    {
      name: "an element of an outer list",
      source: (type, use) => [`let w: ${type}[] = hostValue\n${use("w[0]")}\n`, "w[0]"],
    },
    {
      name: "a replaced empty list",
      source: (type, use) => [`let xs: ${type} = []\nxs = hostValue\n${use("xs")}\n`, "xs"],
    },
    {
      name: "a load",
      source: (type, use) => [`let xs: ${type} = load("k", default: [])\n${use("xs")}\n`, "xs"],
    },
    {
      name: "a parse",
      source: (type, use) => [
        `let xs: ${type} = fromJson(hostValue, default: [])\n${use("xs")}\n`,
        "xs",
      ],
    },
  ];
  const differing: string[] = [];
  let programs = 0;
  for (const consumer of consumers) {
    for (const origin of origins)
      for (const [type, expected] of [
        [consumer.misfit, "warning"],
        [consumer.fit, "quiet"],
      ] as const) {
        const [body, receiver] = origin.source(type, consumer.use);
        const source = `${body}exit\n`;
        const site = consumer.site(source, receiver);
        const own = analysed(source).filter((d) => "rule" in d && d.rule.rule === consumer.rule);
        const got =
          own.length === 0
            ? "quiet"
            : own.every(
                  (d) =>
                    d.class === "warning-runtime-check" &&
                    d.kind !== "budget" &&
                    d.site.start === site[0] &&
                    d.site.end === site[1] &&
                    d.obligation.kind === "operand",
                )
              ? "warning"
              : own.map((d) => `${d.class} @${d.site.start}-${d.site.end}`).join(", ");
        programs += 1;
        if (got !== expected) differing.push(`${consumer.name}, ${origin.name}, ${type}: ${got}`);
      }
    // (a known empty list holds no element to misfit)
    const empty = `let xs: ${consumer.misfit} = []\n${consumer.use("xs")}\nexit\n`;
    programs += 1;
    if (analysed(empty).some((d) => "rule" in d && d.rule.rule === consumer.rule))
      differing.push(`${consumer.name}, a known empty list: not quiet`);
  }
  t.diagnostic(`${programs} programs, each in both orders`);
  assert.deepEqual(differing, []);
});
