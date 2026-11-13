// Flow facts in the cells: dead code (AD-3), a loop's write before a break, the earliest admitted store, and the
// programs beside the set.

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import { recordDifferences, type CompactSite } from "../../helpers/type-core-records.js";
import { records } from "../../helpers/type-core/type-core-cells-setup.js";

/**
 * V30 §13 (a loop's start accounts for the values an earlier round left; a write in the body drops a check only when the
 * written value can make the check false): `cp9-cells/3b/loop/break/changed`'s write of `null` is followed by an
 * unconditional `break`, so no round starts with it and the use is valid, as its corrected record says (#2025). Its two
 * controls: without the `break`, and with the `break` under a condition, a later round can start with the `null`, which
 * nothing in the round checks before the use: the route rule's error, its writer that `null` (ADR 0021 rule 5.6; the
 * accepted record's r4-451).
 */
test("a loop's write that an unconditional break follows leaves no value for a later round, and its controls are errors (#2025)", () => {
  const head =
    'let flagHost = askBoolean "flag"\nlet n = 1\nif flagHost { n = null }\nif n != null { repeat 2 { repeat n {}\n n = null\n';
  const rows: readonly (readonly [string, string, boolean])[] = [
    ["an unconditional break (the corrected record)", `${head} break } }\nexit\n`, false],
    ["no break", `${head}} }\nexit\n`, true],
    ["a conditional break", `${head} if askBoolean "b" { break } } }\nexit\n`, true],
  ];
  const writer = head.lastIndexOf("null");
  const wrong: string[] = [];
  for (const [name, source, later] of rows) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    for (const mode of MODES) {
      const record = inMode(mode, () => compactAnalysis(request));
      const fits = !later
        ? record.outcome === "valid" && record.checks.length === 0
        : record.outcome === "compile-error" &&
          record.diagnostics.length === 1 &&
          record.diagnostics[0]?.requiredCheck?.writer?.offset === writer;
      if (!fits) wrong.push(`${name} in ${JSON.stringify(mode)}: ${JSON.stringify(record)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

const run = (request: NonNullable<ReturnType<typeof coreRequest>>, reversed: boolean) =>
  reversed
    ? withSolverSeam({ reverseWorklist: true }, () =>
        withConsumerOrder(
          (list) => [...list].reverse(),
          () => compactAnalysis(request),
        ),
      )
    : compactAnalysis(request);

// a record by the file and text at its sites, so a live form and its dead one compare where their offsets differ
const analysed = (program: string | readonly SourceFile[], reversed: boolean): string[] => {
  const files = typeof program === "string" ? [{ path: "main.tease", source: program }] : program;
  const request = coreRequest(files);
  assert.ok(request !== null, files.map((file) => file.source).join("\n"));
  const record = run(request, reversed);
  const text = (site: CompactSite): string =>
    `${site.file}:'${files.find((file) => file.path === site.file)!.source.slice(site.offset, site.end)}'`;
  return [
    record.outcome,
    ...record.diagnostics
      .map((d) => `${d.kind} ${d.class} ${d.context ?? "-"} ${text(d.site)}`)
      .sort(),
    ...record.checks
      .map(
        (c) =>
          `${c.kind} ${c.target} [${c.against.join(", ")}]${c.boundary ? " B" : ""} ${text(c.site)}`,
      )
      .sort(),
  ];
};
// per dead shape: the program with `before` live and `body` dead
const shapes: readonly (readonly [string, (before: string, body: string) => string])[] = [
  ["after exit", (before, body) => `${before}\nexit\n${body}\n`],
  ["a branch on a literal false", (before, body) => `${before}\nif false {\n  ${body}\n}\nexit\n`],
  [
    "a handler never registered",
    (before, body) =>
      `${before}\nif false {\n  showPermanentButton "Never" {\n    ${body}\n  }\n}\nexit\n`,
  ],
  ["a label nothing enters", (before, body) => `${before}\nexit\nlabel never\n${body}\nend\n`],
  [
    "a function nothing calls",
    (before, body) => `${before}\nfunction unused {\n  ${body}\n}\nexit\n`,
  ],
];
const takesInteger = "function take(count: integer) {\n  say count\n}\ntake(1)";
// an intrinsic violation of a known type: the live form's error (C2 twice, C5b, C7 at the root and an element)
const violations: readonly (readonly [string, string, string])[] = [
  ["a count that is text", 'let n = "bad"', "repeat n {}"],
  ["an index that is text", 'let xs = [1, 2]\nlet i = "first"', "say xs[i]"],
  ["a member of a whole number", "let n = 5", "say n.length"],
  ["an argument of text for a whole number", `${takesInteger}\nlet s = "bad"`, "take(s)"],
  [
    "an argument's element of text for whole numbers",
    'function takeAll(counts: integer[]) {\n  say counts\n}\ntakeAll([1])\nlet s = ["bad"]',
    "takeAll(s)",
  ],
];
// host data a dead call passes for a written parameter: the live form's warning and boundary, against that type
const hostArguments: readonly (readonly [string, string, string])[] = [
  ["host data for a whole number", takesInteger, "take(hostValue)"],
  [
    "host data in a list of whole numbers",
    "function takeAll(counts: integer[]) {\n  say counts\n}\ntakeAll([1])",
    "takeAll([hostValue])",
  ],
];

// a kind only the reaching definition decides: the live form's error, a warning in dead code
const flowOnly: readonly (readonly [string, string, string])[] = [
  ["a count stored a number last", "let n = 1\nn = 2.5", "repeat n {}"],
  ["an argument stored a number last", `${takesInteger}\nlet n = 1\nn = 2.5`, "take(n)"],
];

// a global is set up at the session's start wherever it is declared (V30 §12): a dead read before its declaration
// or in another file is the live form's error too
const global = 'global n: string = "bad"';
const caller = { path: "main.tease", source: `${global}\ncall "other.tease"\nexit\n` };
const globals: readonly (readonly [string, readonly SourceFile[], readonly SourceFile[]])[] = [
  [
    "a global declared after its dead read",
    [{ path: "main.tease", source: `exit\nrepeat n {}\n${global}\n` }],
    [{ path: "main.tease", source: `repeat n {}\n${global}\nexit\n` }],
  ],
  [
    "a global read in dead code of another file",
    [caller, { path: "other.tease", source: "exit\nrepeat n {}\n" }],
    [caller, { path: "other.tease", source: "repeat n {}\n" }],
  ],
];
// a dead call is no definition of its parameter: a guarded argument there leaves a live call's result as it was
const results: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "a number returned into a whole number",
    "global n = 2.0\nfunction f(x: number) {\n  return x\n}\nlet out: integer = f(2.5)",
    ["if n is integer { f(n) }", "if n is integer { f(x: n) }"],
  ],
  [
    "numbers returned into whole numbers",
    "global n = 2.0\nfunction f(x: number[]) {\n  return x\n}\nlet out: integer[] = f([2.5])",
    ["if n is integer { f([n]) }"],
  ],
];
// a parameter's and a result's marks come from their calls' bindings, which a dead call does not make: a guarded dead
// call's result is no error where its live form warns (a written `number` result is an intrinsic error, #1173:
// `writtenNumbers`)
const guardedResults: readonly (readonly [string, string, string])[] = [
  [
    "an inferred result",
    "global n = 2.0\nfunction f(x: number) {\n  return x\n}",
    "if n is integer { repeat f(x: n) {} }",
  ],
  [
    "an element of a result",
    "global n = 2.0\nfunction f(x: number[]) {\n  return x\n}\nlet seen = f([1.5])",
    "if n is integer { repeat f([n]).first {} }",
  ],
];
// a kind that came through a call (`called`) stays possible in dead code, so a guarded value copied from a call's
// result or a field or element of one warns as on `main`: the live form's record, X1's word on the use (reviews r3's
// and r4's B3 shapes, standing, with an operation, a length and a merge); a written `number` destination is an error
// at the use whatever it holds (#1173), in dead code too
const written = `global n = 2.0\nfunction f(x: number): number {\n  return x\n}\nfunction fs(x: number[]): number[] {\n  return x\n}`;
const transfers: readonly (readonly [string, string, string])[] = [
  [
    "a copy",
    "global n = 2.0\nfunction f(x: number): number {\n  return x\n}",
    "if n is integer { let v = f(n)\nrepeat v {} }",
  ],
  [
    "a field",
    "global n = 2.0\nfunction f(x: number): number {\n  return x\n}",
    "if n is integer { let v = {a: f(n)}\nrepeat v.a {} }",
  ],
  [
    "an element",
    "global n = 2.0\nfunction f(x: number): number {\n  return x\n}",
    "if n is integer { let v = [f(n)]\nrepeat v.first {} }",
  ],
  [
    "a nested call's result",
    "global n = 2.0\nfunction f(x: number): number {\n  return x\n}\nfunction g(x: number): number {\n  return f(x)\n}",
    "if n is integer { let v = g(n)\nrepeat v {} }",
  ],
  [
    "an operation on a call's result",
    "global n = 2.0\nfunction f(x: number): number {\n  return x\n}",
    "if n is integer { let v = f(n) * 1\nrepeat v {} }",
  ],
  [
    "a length of a call's result",
    "global ns = [2.0]\nfunction f(x: number[]): number[] {\n  return x\n}",
    'if ns != null { let v = f(ns).length\nif v { say "yes" } }',
  ],
  [
    "a place a call's result and a literal both store",
    "global n = 2.0\nfunction f(x: number): number {\n  return x\n}",
    "if n is integer { let v = f(n)\nrepeat v {}\nv = 3.5 }",
  ],
  [
    "a recursive call's result",
    "global n = 2.0\nfunction f(x: number): number {\n  if hostValue { return f(x) }\n  return x\n}",
    "if n is integer { let v = f(n)\nrepeat v {} }",
  ],
  [
    "a copy of a written copy",
    written,
    "if n is integer { let v: number = f(n)\nlet w = v\nrepeat w {} }",
  ],
];
// a written `number` destination: an intrinsic error at the use whatever it holds (#1173), the same in dead code
const writtenNumbers: readonly (readonly [string, string, string])[] = [
  [
    "a written result",
    "global n = 2.0\nfunction f(x: number): number {\n  return x\n}",
    "if n is integer { repeat f(n) {} }",
  ],
  ["a written copy", written, "if n is integer { let v: number = f(n)\nrepeat v {} }"],
  ["a written list", written, "if n is integer { let v: number[] = [f(n)]\nrepeat v.first {} }"],
  [
    "a written list a call returns",
    written,
    "if n is integer { let v: number[] = fs([n])\nrepeat v.first {} }",
  ],
  ["a written element", written, "if n is integer { let v: number = fs([n]).first\nrepeat v {} }"],
  [
    "a written nested list",
    written,
    "if n is integer { let v: number[][] = [[f(n)]]\nrepeat v.first.first {} }",
  ],
  [
    "a store into a written place",
    written,
    "if n is integer { let v: number = 0\nv = f(n)\nrepeat v {} }",
  ],
];
// a parameter copied in a callee only one call calls: a live call's narrowed argument is the parameter's value, the
// tested kind (S10 part 2b), which a dead call, binding nothing (F21), never gives: the dead form warns as on `main`,
// X1's word on the use and the copy's check
const narrowedArguments: readonly (readonly [string, string, string, readonly string[]])[] = [
  [
    "a parameter copied in its callee",
    "global n = 2.0\nfunction f(x: number) {\n  let v = x\n  repeat v {}\n}",
    "if n is integer { f(n) }",
    [
      "warning-runtime-check",
      "integer-use warning-runtime-check dead-code main.tease:'v'",
      "integer-check v [integer] main.tease:'v'",
    ],
  ],
];
// such a copy, written or not, as a dead call's argument for a written parameter stays unchecked, as every dead
// argument was on `main`
const copiedArguments: readonly (readonly [string, string])[] = [
  [`${written}\n${takesInteger}`, "if n is integer { let v = f(n)\ntake(v) }"],
  [`${written}\n${takesInteger}`, "if n is integer { let v: number = f(n)\ntake(v) }"],
];
// a member of a call's unknown result as a dead argument: the live form's record without the argument's own C7 (r4 N2)
const unknownArgument = [
  `function raw {\n  return hostValue\n}\n${takesInteger}`,
  "let v = raw()\ntake(v.field)",
] as const;

/**
 * AD-3 (ADR 0021 1.8: type checks apply to all code, reachable or not): in dead code a read of a declared
 * place keeps its contract's one known kind, so an intrinsic violation of a known type is the error its live form is,
 * at the same text; a dead call's argument meets its written parameter (F22) as a live one does, and is no definition
 * of it. The flow facts stay dropped there (X1): a kind only the read's reaching definition decides, or a call's result
 * whose marks would come from the dead call's binding, gives a warning, never an error the live form does not give.
 */
test("dead code keeps its intrinsic type errors and drops its flow facts, in both orders (AD-3)", () => {
  const differing: string[] = [];
  const dead = records.filter((record) => record.name.startsWith("cp9-cells/s4/s6b/dead-code/"));
  assert.equal(dead.length, 6);
  for (const record of dead)
    for (const reversed of [false, true]) {
      const request = coreRequest(record.files);
      assert.ok(request !== null, record.name);
      const differences = recordDifferences(record.expected, run(request, reversed));
      if (differences.length > 0)
        differing.push(`${record.name}${reversed ? " reversed" : ""}: ${differences.join("; ")}`);
    }
  for (const reversed of [false, true])
    for (const [what, before, body] of hostArguments) {
      const live = analysed(`${before}\n${body}\nexit\n`, reversed);
      for (const [where, shape] of shapes) {
        const found = analysed(shape(before, body), reversed);
        if (JSON.stringify(found) !== JSON.stringify(live))
          differing.push(`${what}, ${where}${reversed ? " reversed" : ""}: ${found.join("; ")}`);
      }
    }
  for (const reversed of [false, true]) {
    const order = reversed ? " reversed" : "";
    for (const [what, before, body] of [...violations, ...flowOnly]) {
      const live = analysed(`${before}\n${body}\nexit\n`, reversed);
      if (live[0] !== "compile-error") differing.push(`${what}, live${order}: ${live.join("; ")}`);
      for (const [where, shape] of shapes) {
        const found = analysed(shape(before, body), reversed);
        const flow = flowOnly.some(([name]) => name === what);
        const expected = flow
          ? found[0] === "warning-runtime-check" &&
            found.slice(1).every((line) => !line.includes("compile-error")) &&
            found.some((line) => line.includes(" dead-code "))
          : JSON.stringify(found) === JSON.stringify(live);
        if (!expected) differing.push(`${what}, ${where}${order}: ${found.join("; ")}`);
      }
    }
  }
  for (const reversed of [false, true]) {
    const order = reversed ? " reversed" : "";
    for (const [what, before, body] of writtenNumbers) {
      const live = analysed(`${before}\n${body}\nexit\n`, reversed);
      if (
        live[0] !== "compile-error" ||
        !live.some((line) => line.startsWith("integer-use compile-error"))
      )
        differing.push(`${what}, live${order}: ${live.join("; ")}`);
      for (const [where, shape] of shapes) {
        const found = analysed(shape(before, body), reversed);
        if (JSON.stringify(found) !== JSON.stringify(live))
          differing.push(`${what}, ${where}${order}: ${found.join("; ")}`);
      }
    }
    for (const [what, before, body] of transfers) {
      const live = analysed(`${before}\n${body}\nexit\n`, reversed);
      const unordered = ([outcome, ...lines]: readonly string[]): string =>
        JSON.stringify([outcome, ...[...lines].sort()]);
      const expected = unordered(
        live.map((line) =>
          line.replace(/^(\S+ warning-runtime-check) (call|branch) /, "$1 dead-code "),
        ),
      );
      if (!live.some((line) => /^\S+ warning-runtime-check (call|branch) /.test(line)))
        differing.push(`${what}, live${order}: ${live.join("; ")}`);
      for (const [where, shape] of shapes) {
        const found = analysed(shape(before, body), reversed);
        if (unordered(found) !== expected)
          differing.push(`${what}, ${where}${order}: ${found.join("; ")}`);
      }
    }
    for (const [what, before, body, dead] of narrowedArguments) {
      const live = analysed(`${before}\n${body}\nexit\n`, reversed);
      if (JSON.stringify(live) !== JSON.stringify(["valid"]))
        differing.push(`${what}, live${order}: ${live.join("; ")}`);
      const expected = JSON.stringify([dead[0], ...dead.slice(1).sort()]);
      for (const [where, shape] of shapes) {
        const found = analysed(shape(before, body), reversed);
        if (JSON.stringify([found[0], ...found.slice(1).sort()]) !== expected)
          differing.push(`${what}, ${where}${order}: ${found.join("; ")}`);
      }
    }
    for (const [before, body] of copiedArguments)
      for (const [where, shape] of shapes) {
        const found = analysed(shape(before, body), reversed);
        if (JSON.stringify(found) !== JSON.stringify(["valid"]))
          differing.push(
            `a guarded copy for a written parameter, ${body}, ${where}${order}: ${found.join("; ")}`,
          );
      }
    const unknownLive = analysed(`${unknownArgument.join("\n")}\nexit\n`, reversed);
    const ownCheck = (line: string): boolean =>
      line.startsWith("written-target ") || line.startsWith("copy-type take.count ");
    if (unknownLive.filter(ownCheck).length !== 2)
      differing.push(`a member of an unknown result, live${order}: ${unknownLive.join("; ")}`);
    for (const [where, shape] of shapes) {
      const found = analysed(shape(...unknownArgument), reversed);
      if (JSON.stringify(found) !== JSON.stringify(unknownLive.filter((line) => !ownCheck(line))))
        differing.push(`a member of an unknown result, ${where}${order}: ${found.join("; ")}`);
    }
    for (const [what, before, body] of guardedResults)
      for (const program of [
        `${before}\n${body}\nexit\n`,
        ...shapes.map(([, shape]) => shape(before, body)),
      ]) {
        const found = analysed(program, reversed);
        if (
          found[0] !== "warning-runtime-check" ||
          found.some((line) => line.includes("compile-error"))
        )
          differing.push(`${what}${order}: ${program}: ${found.join("; ")}`);
      }
    for (const [what, dead, live] of globals) {
      const expected = analysed(live, reversed);
      const found = analysed(dead, reversed);
      if (expected[0] !== "compile-error" || JSON.stringify(found) !== JSON.stringify(expected))
        differing.push(`${what}${order}: ${found.join("; ")}, live ${expected.join("; ")}`);
    }
    for (const [what, before, calls] of results) {
      const live = analysed(`${before}\nexit\n`, reversed);
      if (live[0] !== "compile-error") differing.push(`${what}, live${order}: ${live.join("; ")}`);
      for (const call of calls)
        for (const [where, shape] of shapes) {
          const found = analysed(shape(before, call), reversed);
          if (JSON.stringify(found) !== JSON.stringify(live))
            differing.push(`${what}, ${call}, ${where}${order}: ${found.join("; ")}`);
        }
    }
  }
  assert.deepEqual(differing, []);
});

test("a warning names the earliest admitted store of its offending kind, after a rejection too (F28)", () => {
  // the set's writer evidence (`provenance.writers`), which the compact fixture leaves out, by the writer's site
  for (const [name, site, writer] of [
    ["cp9-cells/provenance/earliest-number", 108, 49],
    ["cp9-cells/provenance/prefix-admitted", 192, 64],
    // the store of 1.5 into the whole record is rejected (A6): the first admitted number is `state.n = 2.5`
    ["cp9-cells/provenance/prefix-rejected", 196, 133],
  ] as const) {
    const record = records.find((candidate) => candidate.name === name);
    assert.ok(record !== undefined, name);
    const request = coreRequest(record.files);
    assert.ok(request !== null, name);
    const warning = analyseCore(request).diagnostics.find(
      (diagnostic) => diagnostic.site.start === site,
    );
    assert.ok(warning?.class === "warning-runtime-check" && warning.kind !== "budget", name);
    assert.deepEqual(
      warning.provenance.writers.map((found) => found.start),
      [writer],
      name,
    );
  }
});

/**
 * Programs beside the set, for cells whose transfers the set leaves untested (review r1): per program its cell, the
 * outcome and the diagnostics' context words in order.
 */
const CONTROLS: readonly (readonly [string, string, string, string])[] = [
  // the guard's mark travels with the value through a conversion, a length, a dict's keys and a declared result
  // (where its test's narrowing holds, a stored value is the tested kind, S10 part 2b: an intrinsic error; a call that
  // stores the value between them drops it, and the mark travels)
  [
    "guarded conversion",
    "let xs = null\nfunction refill { xs = [1] }\nif xs != null { refill()\n let wrong: string = xs.toSet() }",
    "warning-runtime-check",
    "call call call",
  ],
  [
    "guarded length",
    "let xs = [1]\nfunction refill { xs = [2] }\nif xs != null { refill()\n let wrong: string = xs.length }",
    "warning-runtime-check",
    "call",
  ],
  [
    "N2 narrowed conversion",
    "let xs = null\nif xs != null { let wrong: string = xs.toSet() }",
    "compile-error",
    "-",
  ],
  [
    "N2 narrowed length",
    "let xs = [1]\nif xs != null { let wrong: string = xs.length }",
    "compile-error",
    "-",
  ],
  [
    "guarded dict keys",
    "let xs = dict {x: 1}\nfunction refill { xs = dict {y: 2} }\nif xs != null { refill()\n for key in xs { let wrong: integer = key } }",
    "warning-runtime-check",
    "call",
  ],
  [
    "N2 narrowed dict keys",
    "let xs = dict {x: 1}\nif xs != null { for key in xs { let wrong: integer = key } }",
    "compile-error",
    "-",
  ],
  [
    "guarded declared result",
    "let xs = [1]\nfunction refill { xs = [2] }\nif xs != null { refill()\n let wrong: string = xs.count() }",
    "warning-runtime-check",
    "call",
  ],
  [
    "N2 narrowed declared result",
    "let xs = [1]\nif xs != null { let wrong: string = xs.count() }",
    "compile-error",
    "-",
  ],
  ["unguarded length", "let xs = [1]\nlet wrong: string = xs.length", "compile-error", "-"],
  // W34: copies of a source without an exact definition at the copy keep the guard's mark (review r3)
  [
    "guarded copies of a source a later store redefines",
    "let seed = {g: {v: 1.5}}\nif seed.g is integer {\n  let a = seed\n  let b = a\n  repeat b.g {}\n}\nseed = {g: {v: 2}}\nexit",
    "warning-runtime-check",
    "branch",
  ],
  [
    "unguarded copies of a source a later store redefines",
    "let seed = {g: {v: 1.5}}\nlet a = seed\nlet b = a\nrepeat b.g {}\nseed = {g: {v: 2}}\nexit",
    "compile-error",
    "-",
  ],
  // W34: a guard of the argument a parameter copies marks the callee's copies of it (review r5)
  [
    "a guarded argument copied in the callee",
    "let seed = {f: 2.0}\nfunction take(p) {\n  seed = p\n  let saved = seed\n  repeat saved.f {}\n}\nif seed.f is integer { take(seed) }\nexit",
    "warning-runtime-check",
    "branch",
  ],
  [
    "an unguarded argument copied in the callee",
    "let seed = {f: 2.0}\nfunction take(p) {\n  seed = p\n  let saved = seed\n  repeat saved.f {}\n}\ntake(seed)\nexit",
    "compile-error",
    "-",
  ],
  // F21: a dead call is no site and binds nothing
  [
    "F21 one live call beside a dead one",
    "function take(x) { repeat x {} }\ntake(1)\nif false { take(1.5) }",
    "valid",
    "",
  ],
  [
    "F21 two live calls",
    "function take(x) { repeat x {} }\ntake(1)\ntake(1.5)",
    "warning-runtime-check",
    "deferred-parameter",
  ],
  // X6, X7: a helper only blocks run stores as block code does, one ordinary code runs too as a call
  [
    "X6 a helper only a later block runs",
    'let n = 1\nfunction change { n = 1.5 }\nfunction unrelated { say "hello" }\nunrelated()\nlet shown: integer = n\nshowPermanentButton "x" { change() }',
    "valid",
    "",
  ],
  [
    "X7 a helper only an earlier block runs",
    'let n = 1\nfunction change { n = 1.5 }\nfunction unrelated { say "hello" }\nshowPermanentButton "x" { change() }\nunrelated()\nlet shown: integer = n',
    "warning-runtime-check",
    "handler",
  ],
  [
    "X6 a helper ordinary code runs too",
    'let n = 1\nfunction change { n = 1.5 }\nchange()\nlet shown: integer = n\nshowPermanentButton "x" { change() }',
    "warning-runtime-check",
    "call",
  ],
  [
    "X6 a helper's helper ordinary code runs too",
    'let n = 1\nfunction change { n = 1.5 }\nfunction outer { change() }\nshowPermanentButton "x" { outer() }\nouter()\nlet shown: integer = n',
    "warning-runtime-check",
    "call",
  ],
  // F25: every ask with a declared answer gives it, as its adapter row says
  ["F25 a date answer", 'let d = askDate "When?"\nlet w: integer = d', "compile-error", "-"],
  [
    "F25 a password answer",
    'let p = askPassword "Word?"\nlet w: integer = p',
    "compile-error",
    "-",
  ],
  // F25: a declared result is the receiver kind's own: text's `reverse` gives text, a list's `null`
  ["F25 a text's reversed text", 'let s = "abc".reverse()\nsay s.uppercase()', "valid", ""],
  [
    "F25 a list's reverse gives null",
    "let xs = [1, 2]\nlet r = xs.reverse()\nsay r + 1",
    "compile-error",
    "-",
  ],
  // V30 §19: askChoice gives a label's kind, or a button's value: a whole choice object's or an element's `value`, or
  // its `text` where it has no `value` (review r5)
  ["a name label", "let r = askChoice back: 5\nlet n: integer = r", "compile-error", "-"],
  ["a number label", 'let r = askChoice 1: "One"\nlet t: string = r', "compile-error", "-"],
  [
    "an element without its value",
    'let xs = [{text: "Corner"}]\nlet r = askChoice xs\nlet n: integer = r',
    "compile-error",
    "-",
  ],
  [
    "a whole choice object",
    'let r = askChoice {text: "A", value: {payload: 2}}\nlet t: string = r.payload',
    "compile-error",
    "-",
  ],
  [
    "a bound choice object",
    'let o = {text: "A", value: 3}\nlet r = askChoice o\nrepeat r {}',
    "valid",
    "",
  ],
  // review r6: a guarded copy of a computed record passed to a written parameter at two sites keeps its mark
  [
    "a guarded computed argument at two sites",
    "let source = null otherwise {f: 2.0}\nfunction take(p: object) { repeat p.f {} }\nif source.f is integer {\n  take(source)\n  take(source)\n}\nexit",
    "warning-runtime-check",
    "member",
  ],
  [
    "an unguarded computed argument at two sites",
    "let source = null otherwise {f: 2.0}\nfunction take(p: object) { repeat p.f {} }\ntake(source)\ntake(source)\nexit",
    "compile-error",
    "-",
  ],
  // V30 §19, F25, F7 (review r6): an external value beside a choice object's text; an unknown receiver's result is every
  // receiver kind's that has the method
  [
    "an external value beside a choice object without one",
    'let r: string = askChoice [{text: "A", value: hostValue}, {text: "B"}]',
    "warning-runtime-check",
    "unknown unknown",
  ],
  // (AD-1, #1073: the parse's `null` default reaches the member by a route without a check, the route rule's
  // error, as F15's `load` default does in the expectation set; the receiver's unknown keeps its warnings)
  [
    "F25 an unknown receiver's reverse",
    'let raw = fromJson("\\"abc\\"", default: null, files: false)\nlet text: string = raw.reverse()',
    "compile-error",
    "- - unknown",
  ],
  [
    "F7 an unknown receiver's remove",
    'let raw = fromJson("{}", default: null, files: false)\nlet text: string = raw.remove("key")',
    "compile-error",
    "- unknown - unknown",
  ],
  // X7, H1, G1(b) (Astra B4): a dead call registers no handler; a live one before the read does
  [
    "X7 a registration only a dead call makes before the read",
    'let n = 1\nfunction register { showPermanentButton "x" { n = 1.5 } }\nif false { register() }\nlet whole: integer = n\nregister()\nexit',
    "valid",
    "",
  ],
  [
    "X7 a registration a live call makes before the read",
    'let n = 1\nfunction register { showPermanentButton "x" { n = 1.5 } }\nregister()\nlet whole: integer = n\nexit',
    "warning-runtime-check",
    "handler",
  ],
  // F7b, C12 (Astra B3): a receiver that may be a list or a dict owes the dict key only as a check; a dict an error
  [
    "C12 remove on a possible list or dict",
    // (a value of an unrestricted dict: two returns of different kinds would be admission's error, ADR 0021 1.5, and a
    // written union of a list and a dict V30 §13's)
    'let pool: dict = dict{a: [1], b: dict{k: 1}}\nsay pool.get("a", default: []).remove(1)\nexit',
    "warning-runtime-check",
    "unknown",
  ],
  ["C12 remove on a dict", "let d = dict {key: 1}\nsay d.remove(1)\nexit", "compile-error", "-"],
  // F11, F12, C2, C5 (Astra B1): a property named as an internal step is the object's property
  [
    "C2 a property named iteration of the wrong kind",
    'let box = {iteration: "bad"}\nrepeat box.iteration {}\nexit',
    "compile-error",
    "-",
  ],
  ["C5 a property named entry", "let box = {entry: 1}\nrepeat box.entry {}\nexit", "valid", ""],
  ["C5 a property named index", "let box = {index: 1}\nrepeat box.index {}\nexit", "valid", ""],
  [
    "F13 a store into a property named element",
    "let box = {element: 1}\nbox.element = 2\nrepeat box.element {}\nexit",
    "valid",
    "",
  ],
  [
    "F13 a wrong store into a property named element",
    "let box = {element: 1}\nbox.element = 2.5\nrepeat box.element {}\nexit",
    "compile-error",
    "-",
  ],
];

test("the core gives the expected outcome for the programs beside the set", () => {
  const got = CONTROLS.map(([name, source]) => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const record = compactAnalysis(request);
    const contexts = record.diagnostics.map((diagnostic) => diagnostic.context ?? "-").join(" ");
    return `${name}: ${record.outcome} [${contexts}]`;
  });
  assert.deepEqual(
    got,
    CONTROLS.map(([name, , outcome, contexts]) => `${name}: ${outcome} [${contexts}]`),
  );
});
