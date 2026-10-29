import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { CARRIER_ROLES, operandsOf } from "../src/type-inference/core/carriers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import { heldBack, readFixture, type FixtureRecord } from "./helpers/type-core-fixture.js";
import {
  BOUNDED_ADMISSION_WITNESSES,
  CARRIER_WITNESSES,
  HOT_CANDIDATE_WITNESSES,
} from "./helpers/type-core-witnesses.js";
import {
  recordDifferences,
  recordOf,
  type CompactCheck,
  type CompactDiagnostic,
  type CompactRecord,
  type CompactSite,
} from "./helpers/type-core-records.js";

/**
 * The coarse core against its independent expectation set (checkpoint 9, TABLE §10.2, §10.5; the port plan's §3.1):
 * per record the outcome, the diagnostics as (kind, class, site, asserted context) and the checks as (kind, target,
 * required kinds, boundary, site) multisets. Every record is asserted except those `heldBack` names, each by its cell or
 * its name, with its reason.
 */
const records = readFixture();
const asserted = records.filter((record) => heldBack(record) === null);

function analysed(record: FixtureRecord): CompactRecord {
  const request = coreRequest(record.files);
  assert.ok(request !== null, `${record.name}: its files parse and resolve`);
  return compactAnalysis(request);
}

test("the core gives the expected record for every record of the cells it completes", (t) => {
  // the classes held back at the set's revision `8992e5c3…` (r481), so a refresh that moves records between them shows
  const held = new Map<string, number>();
  for (const record of records) {
    const reason = heldBack(record);
    if (reason !== null) held.set(reason, (held.get(reason) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(held), {
    "the adapters' records (S9b)": 9,
    "stage 3b's cells (S10)": 653,
    "operator site awaiting set correction (TABLE §3.4, r4.62)": 1,
    "S9b's F18 shapes (r4.81 (1))": 32,
  });
  assert.equal(asserted.length, 1_318);
  // (records of one exact input, their files in order, share its analysis; each is compared with its own record)
  const analyses = new Map<string, CompactRecord>();
  const failures = asserted.flatMap((record) => {
    const input = JSON.stringify(record.files);
    const actual = analyses.get(input) ?? analysed(record);
    analyses.set(input, actual);
    const differences = recordDifferences(record.expected, actual);
    return differences.length === 0 ? [] : [`${record.name}: ${differences.join("; ")}`];
  });
  // (TABLE §3.4, D2, r4.62: every site compares whole, a member read's and an operator's included)
  t.diagnostic(`${asserted.length} records compared by whole sites`);
  assert.deepEqual(failures, []);
});

/**
 * TABLE r4.63–r4.66's rule function as the set pins it (`cp9-cells/s6/rule-function/…`): its ten records, each compared
 * whole in both orders, but those `heldBack` names.
 */
test("the core gives the expected record for every rule-function record, in both orders (r4.63–r4.66)", () => {
  const ruleFunction = records.filter((record) =>
    record.name.startsWith("cp9-cells/s6/rule-function/"),
  );
  assert.equal(ruleFunction.length, 10);
  for (const record of ruleFunction) {
    if (heldBack(record) !== null) continue;
    const request = coreRequest(record.files);
    assert.ok(request !== null, `${record.name}: its files parse and resolve`);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(record.expected, compactAnalysis(request)), [], record.name);
    assert.deepEqual(recordDifferences(record.expected, reversed), [], `${record.name} reversed`);
  }
});

/**
 * AD-3 (TABLE r4.52; ADR 0021 1.8: type checks apply to all code, reachable or not): in dead code a read of a declared
 * place keeps its contract's one known kind, so an intrinsic violation of a known type is the error its live form is,
 * at the same text; a dead call's argument meets its written parameter (F22) as a live one does, and is no definition
 * of it. The flow facts stay dropped there (X1): a kind only the read's reaching definition decides, or a call's result
 * whose marks would come from the dead call's binding, gives a warning, never an error the live form does not give.
 */
test("dead code keeps its intrinsic type errors and drops its flow facts, in both orders (AD-3)", () => {
  const run = (request: NonNullable<ReturnType<typeof coreRequest>>, reversed: boolean) =>
    reversed
      ? withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder(
            (list) => [...list].reverse(),
            () => compactAnalysis(request),
          ),
        )
      : compactAnalysis(request);
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
    [
      "a branch on a literal false",
      (before, body) => `${before}\nif false {\n  ${body}\n}\nexit\n`,
    ],
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
  for (const reversed of [false, true])
    for (const [what, before, body] of hostArguments) {
      const live = analysed(`${before}\n${body}\nexit\n`, reversed);
      for (const [where, shape] of shapes) {
        const found = analysed(shape(before, body), reversed);
        if (JSON.stringify(found) !== JSON.stringify(live))
          differing.push(`${what}, ${where}${reversed ? " reversed" : ""}: ${found.join("; ")}`);
      }
    }
  // a kind only the reaching definition decides: the live form's error, a warning in dead code
  const flowOnly: readonly (readonly [string, string, string])[] = [
    ["a count stored a number last", "let n = 1\nn = 2.5", "repeat n {}"],
    ["an argument stored a number last", `${takesInteger}\nlet n = 1\nn = 2.5`, "take(n)"],
  ];
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
  // call's result is no error where its live form warns
  const guardedResults: readonly (readonly [string, string, string])[] = [
    [
      "a written result",
      "global n = 2.0\nfunction f(x: number): number {\n  return x\n}",
      "if n is integer { repeat f(n) {} }",
    ],
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
  // and r4's B3 shapes, standing, with an operation, a length and a merge); a written destination keeps the flag as it
  // keeps the guard mark
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
    ["a written copy", written, "if n is integer { let v: number = f(n)\nrepeat v {} }"],
    ["a written list", written, "if n is integer { let v: number[] = [f(n)]\nrepeat v.first {} }"],
    [
      "a written list a call returns",
      written,
      "if n is integer { let v: number[] = fs([n])\nrepeat v.first {} }",
    ],
    [
      "a copy of a written copy",
      written,
      "if n is integer { let v: number = f(n)\nlet w = v\nrepeat w {} }",
    ],
    [
      "a written element",
      written,
      "if n is integer { let v: number = fs([n]).first\nrepeat v {} }",
    ],
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
  for (const reversed of [false, true]) {
    const order = reversed ? " reversed" : "";
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

test("the comparison fails a record whose second boundary check is replaced by a copy of its first", () => {
  // the negative control of the port plan's §3.1: one ingress's boundary check lost beside a surviving one must show
  const record = asserted.find(
    (candidate) => candidate.name === "cp9-cells/r46/m3/sol-m3b/boundary-multisite-argument",
  );
  // two arguments of external data bound to one parameter: two boundary checks, one target, two sites
  assert.ok(record !== undefined, "the record with two external arguments");
  const boundaries = record.expected.checks.filter((check) => check.boundary);
  assert.equal(boundaries.length, 2);
  assert.notDeepEqual(boundaries[0], boundaries[1]);
  const altered: CompactRecord = {
    ...record.expected,
    checks: [
      ...record.expected.checks.filter((check) => !check.boundary),
      boundaries[0]!,
      boundaries[0]!,
    ],
  };
  const actual = analysed(record);
  assert.deepEqual(recordDifferences(record.expected, actual), []);
  assert.notDeepEqual(recordDifferences(altered, actual), []);
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
  // §3.2: the mark travels with the value through a conversion, a length, a dict's keys and a declared result
  // (where its test's narrowing holds, a stored value is the tested kind, S10 part 2b: an intrinsic error; a call that
  // stores the value between them drops it, and the mark travels)
  [
    "§3.2 guarded conversion",
    "let xs = null\nfunction refill { xs = [1] }\nif xs != null { refill()\n let wrong: string = xs.toSet() }",
    "warning-runtime-check",
    "call call call",
  ],
  [
    "§3.2 guarded length",
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
    "§3.2 guarded dict keys",
    "let xs = dict {x: 1}\nif xs != null { for key in xs { let wrong: integer = key } }",
    "warning-runtime-check",
    "branch",
  ],
  [
    "§3.2 guarded declared result",
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
  ["§3.2 unguarded length", "let xs = [1]\nlet wrong: string = xs.length", "compile-error", "-"],
  // W34: copies of a source without an exact definition at the copy keep the guard's mark (review r3)
  [
    "§3.2 guarded copies of a source a later store redefines",
    "let seed = {g: {v: 1.5}}\nif seed.g is integer {\n  let a = seed\n  let b = a\n  repeat b.g {}\n}\nseed = {g: {v: 2}}\nexit",
    "warning-runtime-check",
    "branch",
  ],
  [
    "§3.2 unguarded copies of a source a later store redefines",
    "let seed = {g: {v: 1.5}}\nlet a = seed\nlet b = a\nrepeat b.g {}\nseed = {g: {v: 2}}\nexit",
    "compile-error",
    "-",
  ],
  // W34: a guard of the argument a parameter copies marks the callee's copies of it (review r5)
  [
    "§3.2 a guarded argument copied in the callee",
    "let seed = {f: 2.0}\nfunction take(p) {\n  seed = p\n  let saved = seed\n  repeat saved.f {}\n}\nif seed.f is integer { take(seed) }\nexit",
    "warning-runtime-check",
    "branch",
  ],
  [
    "§3.2 an unguarded argument copied in the callee",
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
  // X6, X7 (r4.10): a helper only blocks run stores as block code does, one ordinary code runs too as a call
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
  ["§19 a name label", "let r = askChoice back: 5\nlet n: integer = r", "compile-error", "-"],
  ["§19 a number label", 'let r = askChoice 1: "One"\nlet t: string = r', "compile-error", "-"],
  [
    "§19 an element without its value",
    'let xs = [{text: "Corner"}]\nlet r = askChoice xs\nlet n: integer = r',
    "compile-error",
    "-",
  ],
  [
    "§19 a whole choice object",
    'let r = askChoice {text: "A", value: {payload: 2}}\nlet t: string = r.payload',
    "compile-error",
    "-",
  ],
  [
    "§19 a bound choice object",
    'let o = {text: "A", value: 3}\nlet r = askChoice o\nrepeat r {}',
    "valid",
    "",
  ],
  // §3.2 (review r6): a guarded copy of a computed record passed to a written parameter at two sites keeps its mark
  [
    "§3.2 a guarded computed argument at two sites",
    "let source = null otherwise {f: 2.0}\nfunction take(p: object) { repeat p.f {} }\nif source.f is integer {\n  take(source)\n  take(source)\n}\nexit",
    "warning-runtime-check",
    "member",
  ],
  [
    "§3.2 an unguarded computed argument at two sites",
    "let source = null otherwise {f: 2.0}\nfunction take(p: object) { repeat p.f {} }\ntake(source)\ntake(source)\nexit",
    "compile-error",
    "-",
  ],
  // §19, F25, F7 (review r6): an external value beside a choice object's text; an unknown receiver's result is every
  // receiver kind's that has the method
  [
    "§19 an external value beside a choice object without one",
    'let r: string = askChoice [{text: "A", value: hostValue}, {text: "B"}]',
    "warning-runtime-check",
    "unknown",
  ],
  [
    "F25 an unknown receiver's reverse",
    'let raw = fromJson("\\"abc\\"", default: null, files: false)\nlet text: string = raw.reverse()',
    "warning-runtime-check",
    "unknown unknown unknown",
  ],
  [
    "F7 an unknown receiver's remove",
    'let raw = fromJson("{}", default: null, files: false)\nlet text: string = raw.remove("key")',
    "warning-runtime-check",
    "unknown unknown unknown unknown",
  ],
  // X7, H1, G1(b) (r4.25; Astra B4): a dead call registers no handler; a live one before the read does
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

/** C1's warning and check for external data stored into a written place, by site (TABLE r4.43, C9 r4.29). */
test("external data in a choice's options or in a literal is warned at its own expression", () => {
  const sited = (source: string): readonly string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const record = compactAnalysis(request);
    return [
      record.outcome,
      ...record.diagnostics.map((diagnostic) => `${diagnostic.kind}@${diagnostic.site.offset}`),
      // C1's checks; C9's boundary checks are asserted with their cell
      ...record.checks
        .filter((check) => !check.boundary)
        .map((check) => `${check.kind}@${check.site.offset}`),
    ];
  };
  // r4.43 (1): an external option of a choice, as an external element of a literal
  assert.deepEqual(sited("let chosen: integer = askChoice [hostValue, 2]\nexit"), [
    "warning-runtime-check",
    "written-target@33",
    "copy-type@33",
  ]);
  assert.deepEqual(sited("let chosen: integer = askChoice [2, hostValue]\nexit"), [
    "warning-runtime-check",
    "written-target@36",
    "copy-type@36",
  ]);
  assert.deepEqual(sited("let pool: integer?[] = [hostValue, null, 7]\nexit"), [
    "warning-runtime-check",
    "written-target@24",
    "copy-type@24",
  ]);
  // V30 §19: a choice object gives its `value` (or its `text` without one), so its external value is the site
  assert.deepEqual(
    sited(
      'let chosen: integer = askChoice [{text: "A", value: hostValue}, {text: "B", value: 2}]\nexit',
    ),
    ["warning-runtime-check", "written-target@52", "copy-type@52"],
  );
  assert.deepEqual(sited('let chosen: integer = askChoice {text: "A", value: hostValue}\nexit'), [
    "warning-runtime-check",
    "written-target@51",
    "copy-type@51",
  ]);
  assert.deepEqual(sited("let chosen: integer = askChoice [{text: hostValue}]\nexit"), [
    "warning-runtime-check",
    "written-target@40",
    "copy-type@40",
  ]);
  // an external option read through a projection sits at its own expression (Astra B6-r2), in a choice and a literal
  assert.deepEqual(sited("let chosen: integer = askChoice [hostValue.field, 2]\nexit"), [
    "warning-runtime-check",
    "written-target@33",
    "member-read@33",
    "copy-type@33",
    "null-check@33",
  ]);
  assert.deepEqual(sited("let chosen: integer = [hostValue.field, 2][0]\nexit"), [
    "warning-runtime-check",
    "written-target@23",
    "member-read@23",
    "copy-type@23",
    "null-check@23",
  ]);
  // the selected value's site, not the first external expression in the option: a choice object's `value` beside an
  // external `text`, read whole or through a projection, alone or in a list; its `text` without a value
  assert.deepEqual(
    sited("let chosen: integer = askChoice {text: hostValue.label, value: hostValue.field}\nexit"),
    [
      "warning-runtime-check",
      "member-read@39",
      "written-target@63",
      "member-read@63",
      "null-check@39",
      "copy-type@63",
      "null-check@63",
    ],
  );
  assert.deepEqual(
    sited(
      "let chosen: integer = (askChoice {text: hostValue.label, value: {text: hostValue.field}}).text\nexit",
    ),
    [
      "warning-runtime-check",
      "member-read@40",
      "written-target@71",
      "member-read@71",
      "null-check@40",
      "copy-type@71",
      "null-check@71",
    ],
  );
  assert.deepEqual(
    sited(
      "let chosen: integer = (askChoice [{text: hostValue.label, value: {text: hostValue.field}}]).text\nexit",
    ),
    [
      "warning-runtime-check",
      "member-read@41",
      "written-target@72",
      "member-read@72",
      "null-check@41",
      "copy-type@72",
      "null-check@72",
    ],
  );
  assert.deepEqual(sited("let chosen: integer = askChoice {text: hostValue.label}\nexit"), [
    "warning-runtime-check",
    "written-target@39",
    "member-read@39",
    "copy-type@39",
    "null-check@39",
  ]);
  // r4.43 (3): options held in a variable follow the copy reading: the store into the written place; the literal's
  // host element is checked against its whole numbers where it is stored (the owner's F1)
  assert.deepEqual(sited("let opts = [hostValue, 1]\nlet answer: integer = askChoice opts\nexit"), [
    "warning-runtime-check",
    "written-target@12",
    "written-target@48",
    "copy-type@12",
    "copy-type@48",
  ]);
  assert.deepEqual(
    sited("let opts = [hostValue.field, 1]\nlet answer: integer = askChoice opts\nexit"),
    [
      "warning-runtime-check",
      "written-target@12",
      "member-read@12",
      "written-target@54",
      "copy-type@12",
      "null-check@12",
      "copy-type@54",
    ],
  );
});

test("a choice's option reached through index and property projections is selected before its path (Astra B6-r3)", () => {
  // C1's site in both orders: each form follows `let chosen: integer = `, sites zero-based
  const sites = (form: string): string[] => {
    const request = coreRequest([
      { path: "main.tease", source: `let chosen: integer = ${form}\nexit` },
    ]);
    assert.ok(request !== null, form);
    const both = [false, true].map((reversed) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      return [
        record.outcome,
        ...record.diagnostics
          .filter((diagnostic) => diagnostic.kind === "written-target")
          .map((diagnostic) => `${diagnostic.kind}@${diagnostic.site.offset}`),
        ...record.checks
          .filter((check) => check.kind === "copy-type" && !check.boundary)
          .map((check) => `${check.kind}@${check.site.offset}`),
      ];
    });
    assert.deepEqual(both[1], both[0], `${form}: both orders`);
    return both[0]!;
  };
  const at = (offset: number): string[] => [
    "warning-runtime-check",
    `written-target@${offset}`,
    `copy-type@${offset}`,
  ];
  // an option inside an index or a property projection, with and without a projection of the result
  assert.deepEqual(
    sites("(askChoice [{text: hostValue.label, value: {text: hostValue.field}}][0]).text"),
    at(72),
  );
  assert.deepEqual(
    sites(
      "(askChoice {option: {text: hostValue.label, value: {text: hostValue.field}}}.option).text",
    ),
    at(80),
  );
  assert.deepEqual(
    sites('(askChoice [{text: "A", value: {text: hostValue.field}}][0]).text'),
    at(60),
  );
  assert.deepEqual(sites('askChoice [{text: "A", value: hostValue.field}][0]'), at(52));
  assert.deepEqual(sites('askChoice {option: {text: "A", value: hostValue.field}}.option'), at(60));
  // a choice as another choice's option (Astra B6-r4), beside its literal analogue; a returned choice object as the
  // outer choice's button itself, never selected again (TABLE r4.93), so a text-only one has no length
  assert.deepEqual(sites("askChoice [(askChoice [hostValue.field, 1]), 2]"), at(45));
  assert.deepEqual(sites("[(askChoice [hostValue.field, 1]), 2][0]"), at(35));
  assert.deepEqual(
    sites(
      '(askChoice [(askChoice {text: "inner", value: {text: hostValue.label, value: {text: hostValue.field}}})]).text',
    ),
    at(75),
  );
  assert.deepEqual(
    sites('(askChoice [(askChoice {text: "inner", value: {text: hostValue.label}})]).length'),
    ["compile-error", "written-target@22", "copy-type@22"],
  );
  // the controls: the literal analogues and the direct choice object
  assert.deepEqual(
    sites("[{text: hostValue.label, value: {text: hostValue.field}}][0].value.text"),
    at(61),
  );
  assert.deepEqual(
    sites("{option: {text: hostValue.label, value: {text: hostValue.field}}}.option.value.text"),
    at(69),
  );
  assert.deepEqual(
    sites("(askChoice {text: hostValue.label, value: {text: hostValue.field}}).text"),
    at(71),
  );
});

test("C1's site follows a choice's selection as its value does, over options, wrappers, nesting and paths (Astra B6-r4)", () => {
  // the C1 sites of `let chosen: integer = <expression>`, in both orders: the n-th `hostValue`, the store, or none
  const sites = (expression: string): string[] => {
    const source = `let chosen: integer = ${expression}\nexit`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, expression);
    const both = [false, true].map((reversed) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // (a record is a multiset: each list in a canonical order)
      const offsets = [
        ...record.diagnostics
          .filter((d) => d.kind === "written-target")
          .map((d) => d.site.offset)
          .sort((a, b) => a - b),
        // (C1's checks: C9's boundary checks are not C1's and stand where external data enters or is read)
        ...record.checks
          .filter((check) => check.kind === "copy-type" && !check.boundary)
          .map((check) => check.site.offset)
          .sort((a, b) => a - b),
      ];
      return offsets.map((offset) =>
        source.startsWith("hostValue", offset)
          ? `hostValue #${source.slice(0, offset).split("hostValue").length - 1}`
          : offset === 22
            ? "the store"
            : `@${offset}`,
      );
    });
    assert.deepEqual(both[1], both[0], `${expression}: both orders`);
    return both[0]!;
  };
  // option kinds, with the step that selects their value (V30 §19)
  const kinds: readonly (readonly [string, string, boolean])[] = [
    ["hostValue", "", true],
    ["hostValue.field", "", true],
    ['{text: "A", value: hostValue.field}', ".value", true],
    ["{text: hostValue.label}", ".text", true],
    ['{text: "A", value: 3}', ".value", false],
  ];
  const wrappers: readonly ((option: string) => string)[] = [
    (option) => option,
    (option) => `[${option}][0]`,
    (option) => `{option: ${option}}.option`,
    (option) => `{option: [${option}]}.option[0]`,
  ];
  // a choice over the wrapped option, and its literal analogue: the same selection written as projections
  const nestings: readonly (readonly [
    (w: string) => string,
    (w: string, select: string) => string,
  ])[] = [
    [(w) => `askChoice [${w}]`, (w, select) => `[${w}][0]${select}`],
    [(w) => `askChoice [(askChoice [${w}])]`, (w, select) => `[[${w}][0]${select}][0]`],
    // (the inner choice's answer is the outer's button itself, never selected again: TABLE r4.93)
    [
      (w) => `askChoice [(askChoice {text: "inner", value: ${w}})]`,
      (w) => `[{text: "inner", value: ${w}}.value][0]`,
    ],
  ];
  const differing: string[] = [];
  let external = 0;
  for (const [option, select, isExternal] of kinds)
    for (const wrap of wrappers)
      for (const [choice, analogue] of nestings)
        for (const path of ["", ".text", ".length"]) {
          const chosen = `(${choice(wrap(option))})${path}`;
          const literal = `(${analogue(wrap(option), select)})${path}`;
          const expected = sites(literal);
          if (
            isExternal &&
            expected.every((site) => site === "hostValue #0") &&
            expected.length > 0
          )
            external += 1;
          const got = sites(chosen);
          if (JSON.stringify(got) !== JSON.stringify(expected))
            differing.push(
              `${chosen}: ${got.join(", ")} (its literal analogue: ${expected.join(", ")})`,
            );
        }
  assert.deepEqual(differing, []);
  // every external option's analogue sites C1 at its own external expression: 4 kinds × 4 wrappers × 3 × 3, less the 20
  // where the third nesting returns a choice object whole (TABLE r4.93): `{text: "A", value: hostValue.field}` at each
  // path and `{text: hostValue.label}` whole and at its length, in each wrapper
  assert.equal(external, 124);
});

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

/** A record as one sorted list of texts: its outcome, its diagnostics and its checks. */
function summary(record: CompactRecord): string[] {
  return [
    record.outcome,
    ...record.diagnostics.map((d) => `${d.kind} ${d.class} @${d.site.offset}`),
    ...record.checks.map(
      (check) =>
        `${check.kind} ${check.target} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} @${check.site.offset}`,
    ),
  ].sort();
}

/**
 * TABLE r4.46 (1), (2) (#1026): a choice object gives its `value` where it has the key and its `text` where it has
 * none, decided by the key and never by what the value resolves to (an empty answer is unresolved, not an absent key),
 * per alternative, on the value side and through a function's result (the contract) alike; a dict's `values` and
 * `keys` are lists of its values and of text that may hold none. Per program its record in both orders, with its sites
 * written as the text they start at: the set's records `cp9-cells/s4/choice-value/…` (set `486ac8093b597b45`), C9's
 * boundary check left out (it joins with S6), and controls beside them.
 */
test("a choice object's value is selected by its key, and a dict's values and keys are lists", () => {
  const programs: readonly (readonly [
    string,
    string,
    (at: (text: string) => number) => string[],
  ])[] = [
    [
      "set computed-integer",
      'let result: integer = askChoice {text:"A", value:dict{k:7}.values.first}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set computed-string",
      'let result = askChoice {text:0, value:dict{k:"bad"}.values.first}\nrepeat result {}\nexit\n',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("result {}")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:"bad"}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set bound-integer",
      'let v = dict{k:7}.values.first\nlet result: integer = askChoice {text:"A", value:v}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k:7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "set mixed-omitted",
      'repeat askChoice [{text:"A", value:1}, {text:"B"}] {}\nexit\n',
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("askChoice")}`,
        `integer-check askChoice [{text:"A", value:1}, {text:"B"}] [integer] @${at("askChoice")}`,
      ],
    ],
    [
      "set all-integer",
      'repeat askChoice [{text:"A", value:1}, {text:"B", value:2}] {}\nexit\n',
      () => ["valid"],
    ],
    ["set omitted-integers", "repeat askChoice [{text:0}, {text:1}] {}\nexit\n", () => ["valid"]],
    [
      "set omitted-string-written",
      'let s: integer = askChoice [{text:"A"}]\nexit\n',
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    [
      "set external-written",
      'let result: integer = askChoice {text:"A", value:hostValue}\nsay [result]\nexit\n',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type result [integer] @${at("hostValue")}`,
      ],
    ],
    // each alternative its own: the first object's value, the second's text, never the first's text
    [
      "an omitted value beside a present one",
      // (the options' shared `text` of one kind: a literal's elements share their properties' types, ADR 0021 1.4)
      "repeat askChoice [{text: 1, value: 1}, {text: 2}] {}\nexit",
      () => ["valid"],
    ],
    // a value computed in a solver component: the choice's own result, whichever member the solve enters
    [
      "a value from its own component",
      'function pick(n) {\n  if n > 0 { return askChoice {text: 0, value: pick(n - 1)} }\n  return "bad"\n}\nlet r: string = pick(1)\nexit',
      () => ["valid"],
    ],
    [
      "a wrong value from its own component",
      'function pick(n) {\n  if n > 0 { return askChoice {text: "zero", value: pick(n - 1)} }\n  return 5\n}\nlet r: string = pick(1)\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("pick(1)")}`],
    ],
    // the contract: a function's result (F20)
    [
      "a computed value through a result",
      'function pick { return askChoice {text: "A", value: dict{k: 7}.values.first} }\nlet n: integer = pick()\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: 7}.values [list] @${at("dict")}`,
      ],
    ],
    [
      "a wrong computed value through a result",
      'function pick { return askChoice {text: 0, value: dict{k: "bad"}.values.first} }\nrepeat pick() {}\nexit',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("pick() {}")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: "bad"}.values [list] @${at("dict")}`,
      ],
    ],
    // a present value that may be a missing member is that value, never the text beside it
    [
      "a value that may be missing",
      'let flag = askBoolean "f"\nfunction pick(f) {\n  if f { return {maybe: "s"} }\n  return {other: 1}\n}\nlet r: string = askChoice {text: 1, value: pick(flag).maybe}\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("pick(flag)")}`,
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type r [string] @${at("askChoice")}`,
        `null-check pick.result [non-null] @${at("pick(flag)")}`,
      ],
    ],
    // choice objects held in a variable, a container or a parameter: each record its own `value` or `text`, never
    // another record's `text` (#1027 review, Astra D1)
    [
      "held records with a value and without one",
      "let opts = [{text: 0, value: 1}, {text: 2}]\nrepeat askChoice opts {}\nexit",
      () => ["valid"],
    ],
    [
      "held records that do not fit",
      'let opts = [{text: "x", value: "bad"}, {text: "also bad"}]\nrepeat askChoice opts {}\nexit',
      (at) => ["compile-error", `integer-use compile-error @${at("askChoice")}`],
    ],
    [
      "held records in a dict under a computed key",
      'let key = "pick"\nlet choices = dict{[key]: {text: 0, value: 3}, other: {text: 4}}\nrepeat askChoice choices.values {}\nexit',
      () => ["valid"],
    ],
    [
      "held records from a parameter of two calls",
      'function pick(opts) { return askChoice opts }\nrepeat pick([{text: "unused", value: 1}]) {}\nrepeat pick([{text: 2}]) {}\nexit',
      () => ["valid"],
    ],
    // (the two returns' records share `text`, of one kind: ADR 0021 1.4, 1.5)
    [
      "a held record from a result",
      "function make(n) {\n  if n > 0 { return {text: 0, value: n} }\n  return {text: 2}\n}\nrepeat askChoice make(1) {}\nexit",
      () => ["valid"],
    ],
    // §3.2: under a test of the record's `value` the button value is marked, as the read of the `value` is
    [
      "a held record under a test of its value",
      'let o = {text: "A", value: 1.5}\nif o.value is integer { let n: integer = askChoice o }\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type n [integer] @${at("askChoice")}`,
      ],
    ],
    // a record's `value` stored after it is made is read by its key (a number widens the place, ADR 0021 1.2; a text
    // there would be admission's error and be ignored, A6)
    [
      "a held record whose value is stored",
      'let o = {text: "A", value: 1}\no.value = 2.5\nlet n: integer = askChoice o\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    // and a record's `text` stored after it is made (a number widens the place); a key without a store below it stays
    // per record (Astra on #1027), the options' texts of one kind (ADR 0021 1.4)
    [
      "a held record whose text is stored",
      "let o = {text: 1}\no.text = 2.5\nlet n: integer = askChoice o\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("askChoice")}`],
    ],
    [
      "held records beside a value stored elsewhere",
      "let other = {value: 0}\nother.value = 1\nlet opts = [{text: 0, value: 1}, {text: 2}]\nrepeat askChoice opts {}\nexit",
      () => ["valid"],
    ],
    [
      "held records none of whose buttons fits, beside a value stored elsewhere",
      'let other = {value: 0}\nother.value = 1\nlet opts = [{text: "w", value: "x"}, {text: "y"}]\nrepeat askChoice opts {}\nexit',
      (at) => ["compile-error", `integer-use compile-error @${at("askChoice")}`],
    ],
    // a choice object held in a variable, whose value may be a missing member: possibly its text, never certainly
    [
      "a held choice object whose value may be missing",
      'let flag = askBoolean "f"\nfunction pick(f) {\n  if f { return {maybe: "s"} }\n  return {other: 1}\n}\nlet o = {text: 1, value: pick(flag).maybe}\nlet r: string = askChoice o\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("pick(flag)")}`,
        `written-target warning-runtime-check @${at("askChoice")}`,
        `copy-type r [string] @${at("askChoice")}`,
        `null-check pick.result [non-null] @${at("pick(flag)")}`,
      ],
    ],
    // a dict's lists outside a choice: read, copied, and an object's own property of the name
    [
      "a dict's values",
      'repeat dict{k: "bad"}.values.first {}\nexit',
      (at) => [
        "compile-error",
        `integer-use compile-error @${at("dict")}`,
        `member-read warning-runtime-check @${at("dict")}`,
        `empty-check dict{k: "bad"}.values [list] @${at("dict")}`,
      ],
    ],
    // r4.47 (7), F12 with P3: an element read from an open derived list is possible, so a key is possible text, a
    // warning with its check; §10.5, r4.46 (2): a target through a dict's list is its source text, no key of the dict
    [
      "a dict's keys",
      "let d = dict{k: 1}\nrepeat d.keys.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("d.keys")}`,
        `member-read warning-runtime-check @${at("d.keys")}`,
        `empty-check d.keys [list] @${at("d.keys")}`,
        `integer-check d.keys.first [integer] @${at("d.keys")}`,
      ],
    ],
    [
      "a copy of a dict's values read by its contract",
      'let d = dict{k: "bad"}\nlet vs = d.values\nshowPermanentButton "b" { vs = d.values }\nrepeat vs.first {}\nexit',
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("vs.first")}`,
        `member-read warning-runtime-check @${at("vs.first")}`,
        `empty-check vs [list] @${at("vs.first")}`,
        `integer-check vs.element [integer] @${at("vs.first")}`,
      ],
    ],
    // a selection takes only its own emptiness: a deeper list's `empty-check` stays (#1027 review, Astra B1)
    [
      "a dict's values at depth 1",
      "let d = dict{a: 1}\nrepeat d.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's values at depth 2",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's keys below its values",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.keys.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `integer-use warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.keys [list] @${at("d.values")}`,
        `integer-check d.values.first.keys.first [integer] @${at("d.values")}`,
      ],
    ],
    [
      "a dict's values at depth 3",
      "let d = dict{a: dict{x: dict{}}, b: dict{y: dict{v: 1}}}\nrepeat d.values.first.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "a cleared inner dict's values",
      "let inner = dict{v: 1}\ninner.clear()\nlet d = dict{a: inner}\nrepeat d.values.first.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("d.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check d.values.first.values [list] @${at("d.values")}`,
      ],
    ],
    [
      "an inner dict bound before its values are read",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nlet inner = d.values.first\nrepeat inner.values.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values")}`,
        `member-read warning-runtime-check @${at("inner.values")}`,
        `empty-check d.values [list] @${at("d.values")}`,
        `empty-check inner.values [list] @${at("inner.values")}`,
      ],
    ],
    // the list-literal analogue: the inner list's selection keeps its check
    [
      "a list's lists",
      "let d = [[], [1]]\nrepeat d.first.first {}\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.first")}`,
        `empty-check d.element [list] @${at("d.first")}`,
      ],
    ],
    // §3.2: under a test of its own path the read is marked, as `xs.first` is
    [
      "a dict's values under a test of their path",
      'let d = dict{k: "a"}\nif d.values.first is integer { repeat d.values.first {} }\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("d.values.first is")}`,
        `member-read warning-runtime-check @${at("d.values.first {}")}`,
        `integer-use warning-runtime-check @${at("d.values.first {}")}`,
        `empty-check d.values [list] @${at("d.values.first is")}`,
        `empty-check d.values [list] @${at("d.values.first {}")}`,
        `integer-check d.values.first [integer] @${at("d.values.first {}")}`,
      ],
    ],
    // r4.43: C1's site at the external value among the options a dict's values give a choice
    [
      "a choice over a dict's values",
      'let n: integer = askChoice dict{a: {text: "A", value: hostValue}}.values\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type n [integer] @${at("hostValue")}`,
      ],
    ],
    // F19a: a receiver that may be a reference has the runtime's members, before a dict's list (review r2)
    [
      "a dict's keys on a receiver that may be a reference",
      // (a written union: a store of the speaker into the dict's place would be admission's error and be ignored, A6;
      // the union, a dict beside the speaker, is also V30 §13's error)
      'let o: string dict | speaker = dict{k: "bad"}\nrepeat o.keys.first {}\nexit',
      (at) => [
        "compile-error",
        `written-type compile-error @${at("string dict | speaker")}`,
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `member-read warning-runtime-check @${at("o.keys.first")}`,
        `integer-use warning-runtime-check @${at("o.keys.first")}`,
        `null-check o [non-null] @${at("o.keys.first")}`,
        `empty-check o.keys [list] @${at("o.keys.first")}`,
        `null-check o.keys [non-null] @${at("o.keys.first")}`,
        `integer-check o.keys.first [integer] @${at("o.keys.first")}`,
      ],
    ],
    // the same through an operation and a literal: the receiver's completed contract decides (review r3)
    [
      "a dict's keys through an operation whose receiver may be a reference",
      // (a dict or the speaker: a value of an unrestricted dict, since a written union of them is V30 §13's error)
      'speaker vera { length: 2 }\nlet pool: dict = dict{a: dict{k: "bad"}, b: vera}\nlet o = pool.get("a", default: vera)\nrepeat (o otherwise null).keys.first {}\nexit',
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `member-read warning-runtime-check @${at("(o otherwise")}`,
        `integer-use warning-runtime-check @${at("(o otherwise")}`,
        `null-check o otherwise null [non-null] @${at("(o otherwise")}`,
        `null-check o otherwise null [non-null] @${at("(o otherwise")}`,
        `empty-check (o otherwise null).keys [list] @${at("(o otherwise")}`,
        `null-check (o otherwise null).keys [non-null] @${at("(o otherwise")}`,
        `integer-check (o otherwise null).keys.first [integer] @${at("(o otherwise")}`,
      ],
    ],
    // a path through eight objects' own `values` is read once per step, as any property's (review r2: it exhausted the
    // allowance)
    [
      "a path through eight objects' own values",
      `let n0 = {v: 7}\n${Array.from({ length: 8 }, (_, i) => `let n${i + 1} = {values: [n${i}]}`).join("\n")}\nrepeat n8${".values.first".repeat(8)}.v {}\nexit`,
      () => ["valid"],
    ],
    [
      "an object's own values",
      "let o = {values: [1]}\nlet t: string = o.values.first\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("o.values.first")}`],
    ],
    [
      "external data among a dict's values",
      "let n: integer = dict{k: hostValue}.values.first\nexit",
      (at) => [
        "warning-runtime-check",
        `member-read warning-runtime-check @${at("dict")}`,
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type n [integer] @${at("hostValue")}`,
        `empty-check dict{k: hostValue}.values [list] @${at("dict")}`,
      ],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expect] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const expected = expect((text) => source.indexOf(text)).sort();
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = summary({ ...record, checks: record.checks.filter((check) => !check.boundary) });
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * A choice reads a written list's element as its literal analogue does (TABLE r4.42–r4.43, the lead's ruling on #1027):
 * a copied record below the list's element step takes its contract (F12 r4.7), with the read's word and the copy
 * check, in both orders.
 */
test("a choice's written list element reads below the list's element step, as its literal analogue", () => {
  const recordOf = (source: string): CompactRecord => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [forward, reversed] = [false, true].map((reverse) => {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reverse }, () => compactAnalysis(request));
      return reverse ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    });
    assert.deepEqual(reversed, forward, `${source}: both orders`);
    return forward!;
  };
  for (const store of ["rec.f = 2.5", 'showPermanentButton "b" { rec.f = 2.5 }']) {
    const head = `let rec = {f: 1}\n${store}\nlet n: integer = `;
    const choice = recordOf(`${head}(askChoice [{text: "A", value: rec}]).f\nexit`);
    // (the analogue's value expression is longer, so its sites start alike and end later)
    const starts = (record: CompactRecord): CompactRecord => ({
      ...record,
      diagnostics: record.diagnostics.map((d) => ({
        ...d,
        site: { ...d.site, end: d.site.offset },
      })),
      checks: record.checks.map((c) => ({ ...c, site: { ...c.site, end: c.site.offset } })),
    });
    assert.deepEqual(
      starts(choice),
      starts(recordOf(`${head}[{text: "A", value: rec}][0].value.f\nexit`)),
    );
    assert.deepEqual(
      [
        choice.outcome,
        ...choice.diagnostics.map((d) => `${d.kind} ${d.context} @${d.site.offset}`),
      ],
      ["warning-runtime-check", `written-target member @${head.length}`],
    );
  }
});

/**
 * §3.2 (review round 5 on #1027): a held choice object's button value keeps the mark of a test of the key it selects,
 * through copies, a list's element, a parameter and a path below it, as the keyed read does; a test of the other key
 * marks neither. Per program its record in both orders against the same program with the keyed read in its place, the
 * checks' targets aside.
 */
test("a held choice object's button value is marked by a test of its selected key, as the keyed read is", () => {
  // (each read at a count, which no stored value holds: the keyed read in a stored value takes its narrowing since S10
  // part 2b, which the choice's value, no read of the tested path, does not)
  const cases: readonly (readonly [string, string, string, string, string])[] = [
    [
      "a test of its value",
      'let o = {text: "unused", value: 2.0}\nif o.value is integer { repeat READ {} }\nexit',
      "askChoice o",
      "o.value",
      "warning-runtime-check",
    ],
    [
      "a test of its text, without a value",
      "let o = {text: 2.0}\nif o.text is integer { repeat READ {} }\nexit",
      "askChoice o",
      "o.text",
      "warning-runtime-check",
    ],
    [
      "a copy of a copy in the tested branch",
      'let o = {text: "unused", value: 2.0}\nif o.value is integer {\nlet p = o\nlet q = p\nrepeat READ {}\n}\nexit',
      "askChoice q",
      "q.value",
      "warning-runtime-check",
    ],
    [
      "a path below its value",
      'let o = {text: "unused", value: {n: 2.0}}\nif o.value.n is integer { repeat READ {} }\nexit',
      "(askChoice o).n",
      "o.value.n",
      "warning-runtime-check",
    ],
    [
      "a list's element",
      'let opts = [{text: "unused", value: 2.0}]\nif opts[0].value is integer { repeat READ {} }\nexit',
      "askChoice opts",
      "opts[0].value",
      "warning-runtime-check",
    ],
    [
      "a parameter",
      'function pick(o) {\nif o.value is integer { repeat READ {} }\n}\npick({text: "unused", value: 2.0})\nexit',
      "askChoice o",
      "o.value",
      "warning-runtime-check",
    ],
    [
      "a test of the other key",
      "let o = {text: 2.0, value: 2.5}\nif o.text is integer { repeat READ {} }\nexit",
      "askChoice o",
      "o.value",
      "compile-error",
    ],
  ];
  // its outcome first, then its diagnostics with their contexts and its checks without their targets
  const shape = (record: CompactRecord): string[] => [
    record.outcome,
    ...[
      ...record.diagnostics.map(
        (d) => `${d.kind} ${d.class} ${d.context ?? "-"} @${d.site.offset}`,
      ),
      ...record.checks.map(
        (check) =>
          `${check.kind} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} @${check.site.offset}`,
      ),
    ].sort(),
  ];
  const differing: string[] = [];
  for (const [name, program, choice, keyed, outcome] of cases)
    for (const reversed of [false, true]) {
      const [got, expected] = [choice, keyed].map((read) => {
        const request = coreRequest([
          { path: "main.tease", source: program.replace("READ", read) },
        ]);
        assert.ok(request !== null, `${name}: its source parses and resolves`);
        const run = (): CompactRecord =>
          withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
        return shape(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      });
      if (JSON.stringify(got) !== JSON.stringify(expected) || got![0] !== outcome)
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got!.join("; ")}`);
    }
  assert.deepEqual(differing, []);
});

/**
 * #1027's B1 beyond a dict's lists (review round 5's R5-3, Astra's delta): a collection's `get`, a loop's visit and the
 * removals that give an element consume only the selected element's emptiness mark; a demanded descendant's passes
 * through, so its read keeps the check whose runtime failure (TSR018) it guards. Per collection (a list, a dict's
 * values), form and depth 1–3, the selected element holds a list that many levels deep whose innermost may be empty,
 * read that many `first`s down; both orders. A scalar element is the control.
 */
test("a selection consumes only its own emptiness mark below get, a loop's visit and a removal", () => {
  const nest = (inner: string, depth: number): string =>
    `${"[".repeat(depth - 1)}${inner}${"]".repeat(depth - 1)}`;
  const collections: readonly (readonly [string, (depth: number) => string])[] = [
    ["a list", (depth) => `let c = [${nest("[]", depth)}, ${nest("[1]", depth)}]`],
    [
      "a dict's values",
      (depth) =>
        `let d = dict{a: ${nest("[]", depth)}, b: ${nest("[1]", depth)}}\nlet c = d.values`,
    ],
  ];
  // per form, the selection with its default (the selected element's shape) and the read below it
  const forms: readonly (readonly [string, (fallback: string, read: string) => string])[] = [
    ["get", (fallback, read) => `let picked = c.get(0, default: ${fallback})\nrepeat ${read} {}`],
    ["a loop's visit", (_, read) => `for picked in c { repeat ${read} {} }`],
    ["removeFirst", (_, read) => `let picked = c.removeFirst()\nrepeat ${read} {}`],
    ["removeAt", (_, read) => `let picked = c.removeAt(0)\nrepeat ${read} {}`],
  ];
  const programs: [string, string, string[]][] = [];
  for (const [collection, made] of collections)
    for (const [form, select] of forms)
      for (const depth of [1, 2, 3]) {
        const read = `picked${".first".repeat(depth)}`;
        const source = `${made(depth)}\n${select(nest("[1]", depth), read)}\nexit`;
        const at = source.indexOf(`repeat ${read}`) + "repeat ".length;
        const expected = [
          "warning-runtime-check",
          `member-read warning-runtime-check @${at}`,
          `empty-check picked${".element".repeat(depth - 1)} [list] @${at}`,
        ];
        // a dict's values may hold none: its removal keeps its own check (C6)
        if (collection === "a dict's values" && form === "removeFirst")
          expected.push(
            `member-read warning-runtime-check @${source.indexOf("c.removeFirst")}`,
            `empty-check c [list] @${source.indexOf("c.removeFirst")}`,
          );
        programs.push([`${form} of ${collection} at depth ${depth}`, source, expected.sort()]);
      }
  for (const [form, select] of forms)
    programs.push([
      `${form} of a list's scalar`,
      `let c = [1, 2]\n${select("1", "picked")}\nexit`,
      ["valid"],
    ]);
  const differing: string[] = [];
  for (const [name, source, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const got = summary(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * #1303: host data may be an empty list whatever a written type or a collection test says of its elements (V30 §16;
 * a test proves no element, #1245), so C6 keeps a selection's `empty-check` and its warning at the selection. #1303's
 * two witnesses as exact records; then its matrix: `first`, `last` and `random`, with and without a collection test, on
 * a host list written, with nullable elements, copied, nested, below a property or untyped, beside the `fromJson`,
 * `load` and literal controls, where only a literal with an element is quiet; and beside it the same data through a
 * computed key's load, a parameter, loops and an interpolation, with an opaque and a literal control. Every program
 * alike forward, with the sharing of answers off, and with the consumers' and solver's orders reversed.
 */
test("a host list's selection keeps its empty-check under a written type or a collection test (#1303)", () => {
  const modes: readonly (readonly [string, (run: () => CompactRecord) => CompactRecord])[] = [
    ["forward", (run) => run()],
    ["unshared", (run) => withoutSharing(run)],
    [
      "reversed",
      (run) =>
        withSolverSeam({ reverseWorklist: true }, () =>
          withConsumerOrder((list) => [...list].reverse(), run),
        ),
    ],
  ];
  const analysedIn = (source: string): CompactRecord => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const [first, ...others] = modes.map(([, mode]) => mode(() => compactAnalysis(request)));
    others.forEach((other, index) =>
      assert.deepEqual(other, first, `${source}(${modes[index + 1]![0]})`),
    );
    return first!;
  };
  const witnesses: readonly (readonly [string, string])[] = [
    [
      'let xs: integer[] = hostValue\nsay "BEFORE"\nlet out = xs.first\nsay "AFTER"\nexit\n',
      `outcome warning-runtime-check
       D written-target warning 20:29 unknown
       D written-target warning 20:29 unknown
       D member-read warning 53:61 unknown
       D member-read warning 53:61 unknown
       C copy-type xs [list] 20:29
       C copy-type xs.element [integer] 20:29
       B copy-type xs [list] 20:29
       C null-check xs [non-null] 53:61
       C empty-check xs [list] 53:61`,
    ],
    [
      'let xs = hostValue\nif xs is integer[] {\n    let out = xs.first\n    say "AFTER"\n}\nexit\n',
      `outcome warning-runtime-check
       D member-read warning 54:62 unknown
       C empty-check xs [list] 54:62`,
    ],
  ];
  for (const [source, text] of witnesses)
    assert.deepEqual(recordDifferences(recordOf(text), analysedIn(source)), [], source);
  // a program's empty-checks, each its target at a read, and at each one's site a warning per check there (§4)
  const differing: string[] = [];
  const expect = (source: string, owed: readonly (readonly [string, string])[]): void => {
    const record = analysedIn(source);
    const at = (site: CompactSite): string => `${site.offset}:${site.end}`;
    const got = record.checks
      .filter((check) => check.kind === "empty-check")
      .map((check) => `${check.target} [${check.against.join(", ")}] ${at(check.site)}`);
    const expected = owed.map(([target, read]) => {
      const start = source.lastIndexOf(read);
      return `${target} [list] ${start}:${start + read.length}`;
    });
    const unwarned = record.checks
      .filter((check) => check.kind === "empty-check")
      .filter(
        (check) =>
          record.checks.filter((other) => !other.boundary && at(other.site) === at(check.site))
            .length !==
          record.diagnostics.filter(
            (diagnostic) =>
              diagnostic.kind === "member-read" && at(diagnostic.site) === at(check.site),
          ).length,
      );
    if (JSON.stringify(got) !== JSON.stringify(expected) || unwarned.length > 0)
      differing.push(`${source}: ${got.join("; ")}${unwarned.length > 0 ? " (unwarned)" : ""}`);
  };
  const carriers: readonly (readonly [string, string])[] = [
    ["let xs: integer[] = hostValue", "xs"],
    ["let xs: integer?[] = hostValue", "xs"],
    ["let ys: integer[] = hostValue\nlet xs = ys", "xs"],
    ["let rows: integer[][] = hostValue\nlet xs = rows[0]", "xs"],
    ["let ys: integer[] = hostValue\nlet o = { items: ys }", "o.items"],
    ["let xs = hostValue", "xs"],
    ["let xs: integer[] = fromJson(hostValue, default: [])", "xs"],
    ["let xs = fromJson(hostValue, default: [1])", "xs"],
    ['let xs: integer[] = load("k", default: [])', "xs"],
    ['let xs = load("k", default: [1])', "xs"],
    ["let xs: integer[] = []", "xs"],
    ["let xs: integer[] = [1]", "xs"],
  ];
  for (const [carrier, owner] of carriers)
    for (const tested of [false, true])
      for (const selection of ["first", "last", "random"]) {
        const read = `${owner}.${selection}`;
        const body = tested
          ? `if ${owner} is integer[] {\n    let out = ${read}\n    say "AFTER"\n}`
          : `say "BEFORE"\nlet out = ${read}\nsay "AFTER"`;
        expect(
          `${carrier}\n${body}\nexit\n`,
          carrier === "let xs: integer[] = [1]" ? [] : [[owner, read]],
        );
      }
  // a computed key's load is host data (F19), below a property, written or tested, and gathered in a literal too (one
  // answer for every path below its root, whose mark is the path's, in either order); so is a written parameter's host
  // argument; a loop over a host list may not run, so the list it fills may stay empty (F5a); a loop's variable over a
  // host list, nested and written, tested or copied to a written place, may be empty; so may an interpolated written
  // host list (C11); an opaque value stored after `[]` keeps its check, selected or looped over (F5a); a literal with a
  // host element holds one
  const computed = 'let k = askText "key?"\n';
  const raw = "let key: string = hostValue\nlet raw = load(key, default: {items: [1]})\n";
  const loads = `${computed}let rows = [load(k, default: [1]), load(k, default: [2])]\n`;
  expect(`${computed}let xs: integer[] = load(k, default: [1])\nlet out = xs.first\nexit\n`, [
    ["xs", "xs.first"],
  ]);
  expect(`${raw}let xs: integer[] = raw.items\nlet out = xs.first\nexit\n`, [["xs", "xs.first"]]);
  expect(`${raw}if raw.items is integer[] {\n    let out = raw.items.first\n}\nexit\n`, [
    ["raw.items", "raw.items.first"],
  ]);
  expect(`${loads}let xs: integer[] = rows[0]\nlet out = xs.first\nexit\n`, [["xs", "xs.first"]]);
  expect(
    "let rows = hostValue\nfor row in rows {\n    let xs: integer[] = row\n    let out = xs.first\n}\nexit\n",
    [["xs", "xs.first"]],
  );
  expect("function f(xs: integer[]) {\n    return xs.first\n}\nlet out = f(hostValue)\nexit\n", [
    ["f.xs", "xs.first"],
  ]);
  expect(
    "let xs: integer[] = hostValue\nlet ys: integer[] = []\nfor x in xs {\n    ys.add(x)\n}\nlet out = ys.first\nexit\n",
    [["ys", "ys.first"]],
  );
  expect("let rows: integer[][] = hostValue\nfor xs in rows {\n    let out = xs.first\n}\nexit\n", [
    ["xs", "xs.first"],
  ]);
  expect(
    "let rows = hostValue\nfor xs in rows {\n    if xs is integer[] {\n        let out = xs.first\n    }\n}\nexit\n",
    [["xs", "xs.first"]],
  );
  expect('let xs: string[] = hostValue\nsay "${xs}"\nexit\n', [["xs", "xs"]]);
  const opaque = 'let s = "zzz"\nlet xs: string[] = []\nxs = s.findAll(/a/)\n';
  expect(`${opaque}let out = xs.first\nexit\n`, [["xs", "xs.first"]]);
  expect(
    `${opaque}let ys: string[] = []\nfor x in xs {\n    ys.add(x)\n}\nlet out = ys.first\nexit\n`,
    [["ys", "ys.first"]],
  );
  expect("let xs: integer[] = [hostValue]\nlet out = xs.first\nexit\n", []);
  assert.deepEqual(differing, []);
});

/**
 * TABLE r4.47 (#1026's follow-up): the set's records `cp9-cells/s4/followup/…` (set `716ac7091de2b95e`) in both orders,
 * as their outcome, diagnostics and checks with their sites: temporal fields and calendar parts by their declared
 * results (1), a selection's descendant emptiness (2), held choice options after a store below `value` or `text` (4),
 * clock reads by their declared kind with no boundary (5), and what fits a written place (6, §3.4, §10.5). Two records
 * are S6's and left out here: `temporal/year-string-fallback` differs only by C10's error at the fallback and
 * `temporal/year-present-wrong-store` only by A6's error at the store, both admission's; the set's test asserts them.
 */
test("the set's follow-up records give their records in both orders", () => {
  // per record its source, its outcome, diagnostics and checks, and the words it asserts (an unasserted word is null)
  type Expected = readonly [string, string, readonly string[], (readonly string[])?];
  const programs: readonly Expected[] = [
    [
      "temporal/weekday-repeat",
      'let d = toDate("2026-10-04")\nrepeat d.weekday {}\nexit\n',
      ["compile-error", "integer-use compile-error @36"],
    ],
    [
      "temporal/weekday-written-string",
      'let d = toDate("2026-10-04")\nlet name: string = d.weekday\nexit\n',
      ["valid"],
    ],
    [
      "temporal/year-written-integer",
      'let d = toDate("2026-10-04")\nlet n: integer = d.year\nexit\n',
      ["valid"],
    ],
    [
      "temporal/year-written-string",
      'let x: string = (askDate "When?").year\nexit\n',
      ["compile-error", "written-target compile-error @16"],
    ],
    [
      "temporal/year-fallback-written-union",
      'let x: integer | string = (askDate "When?").year otherwise "ok"\nexit\n',
      ["valid"],
    ],
    [
      "temporal/year-partial-presence-store",
      'let x = {p: (askDate "When?").year}\nif askBoolean "pick" { x = {q: 0} }\nx.p = 1\nexit\n',
      [
        "member-read warning-runtime-check @72",
        "null-check x [non-null] @72",
        "warning-runtime-check",
      ],
      ["member-read warning-runtime-check missing @72"],
    ],
    [
      "temporal/year-present-store",
      'let x = {p: (askDate "When?").year}\nx.p = 1\nexit\n',
      ["valid"],
    ],
    [
      "temporal/property-absent-in-every-source",
      "let x = {q: 0}\nx.p = 1\nexit\n",
      ["compile-error", "member-read compile-error @8"],
    ],
    [
      "temporal/calendar-parts-written-results",
      "let c = 2 calendar days\nlet monthCount: integer = c.months\nlet dayCount: integer = c.days\nlet offset: duration = c.exactOffset\nexit\n",
      ["valid"],
    ],
    [
      "temporal/calendar-exact-offset-repeat",
      "let c = 2 calendar days\nrepeat c.exactOffset {}\nexit\n",
      ["compile-error", "integer-use compile-error @31"],
    ],
    [
      "temporal/exact-duration-has-no-calendar-parts",
      "let d = 2 days\nsay d.days\nexit\n",
      ["compile-error", "member-read compile-error @19"],
    ],
    [
      "temporal/datetime-date-and-time-fields",
      'let dt = toDateTime("2026-10-04T18:00")\nlet y: integer = dt.year\nlet h: integer = dt.hour\nexit\n',
      ["valid"],
    ],
    [
      "temporal/time-date-field-inapplicable",
      'let t = toTime("18:00")\nsay t.year\nexit\n',
      ["compile-error", "member-read compile-error @28"],
    ],
    [
      "temporal/absolute-local-field-inapplicable",
      'let a = toAbsoluteDateTime("2026-10-04T12:30:00Z")\nsay a.year\nexit\n',
      ["compile-error", "member-read compile-error @55"],
    ],
    [
      "temporal/absolute-converted-local-field",
      'let a = toAbsoluteDateTime("2026-10-04T12:30:00Z")\nlet n: integer = a.toDateTime().year\nexit\n',
      ["valid"],
    ],
    [
      "emptiness/values-first",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.values.first {}\nexit\n",
      [
        "empty-check d.values [list] @46",
        "empty-check d.values.first.values [list] @46",
        "member-read warning-runtime-check @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/keys-first",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.keys.first {}\nexit\n",
      [
        "empty-check d.values [list] @46",
        "empty-check d.values.first.keys [list] @46",
        "integer-check d.values.first.keys.first [integer] @46",
        "integer-use warning-runtime-check @46",
        "member-read warning-runtime-check @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/get-outer",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.get(0, default: dict{v: 1}).values.first {}\nexit\n",
      [
        "empty-check d.values.get(0, default: dict{v: 1}).values [list] @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/get-inner",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.first.values.get(0, default: 0) {}\nexit\n",
      [
        "empty-check d.values [list] @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/iterate-values-direct",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nfor n in d.values.first.values { repeat n {} }\nexit\n",
      [
        "empty-check d.values [list] @48",
        "member-read warning-runtime-check @48",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/iterate-inner-then-select",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nfor inner in d.values { repeat inner.values.first {} }\nexit\n",
      [
        "empty-check inner.values [list] @70",
        "member-read warning-runtime-check @70",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/removeFirst-outer",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.removeFirst().values.first {}\nexit\n",
      [
        "empty-check d.values [list] @46",
        "empty-check d.values.removeFirst().values [list] @46",
        "member-read warning-runtime-check @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/removeAt-outer",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nrepeat d.values.removeAt(0).values.first {}\nexit\n",
      [
        "empty-check d.values.removeAt(0).values [list] @46",
        "member-read warning-runtime-check @46",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/bound-inner",
      "let d = dict{a: dict{v: 1}, b: dict{v: 2}}\nlet inner = d.values.first\nlet count: integer = inner.values.first\nrepeat count {}\nexit\n",
      [
        "empty-check d.values [list] @55",
        "empty-check inner.values [list] @91",
        "member-read warning-runtime-check @55",
        "member-read warning-runtime-check @91",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/cleared-bound-inner",
      "let d = dict{a: dict{v: 1}, b: dict{v: 2}}\nlet inner = d.values.first\ninner.clear()\nlet count: integer = inner.values.first\nrepeat count {}\nexit\n",
      [
        "empty-check d.values [list] @55",
        "empty-check inner.values [list] @105",
        "member-read warning-runtime-check @105",
        "member-read warning-runtime-check @55",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/list-literal-open-descendant",
      "let xs = [[], [1]]\nrepeat xs.first.first {}\nexit\n",
      [
        "empty-check xs.element [list] @26",
        "member-read warning-runtime-check @26",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/list-literal-held-control",
      "let xs = [[2], [1]]\nrepeat xs.first.first {}\nexit\n",
      ["valid"],
    ],
    [
      "emptiness/named-values",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nlet projected = d.values\nrepeat projected.first.values.first {}\nexit\n",
      [
        "empty-check projected [list] @71",
        "empty-check projected.first.values [list] @71",
        "member-read warning-runtime-check @71",
        "member-read warning-runtime-check @71",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/values-contract-route",
      "let d = dict{a: dict{}, b: dict{v: 1}}\ngoto inspect\nlabel inspect\nrepeat d.values.first.values.first {}\nexit\n",
      [
        "empty-check d.values [list] @73",
        "empty-check d.values.first.values [list] @73",
        "member-read warning-runtime-check @73",
        "member-read warning-runtime-check @73",
        "warning-runtime-check",
      ],
    ],
    [
      "emptiness/key-contract-count",
      "let d = dict{a: dict{}, b: dict{v: 1}}\nlet key = d.values.first.keys.first\ngoto inspect\nlabel inspect\nrepeat key {}\nexit\n",
      [
        "compile-error",
        "empty-check d.values [list] @49",
        "empty-check d.values.first.keys [list] @49",
        "integer-use compile-error @109",
        "member-read warning-runtime-check @49",
        "member-read warning-runtime-check @49",
      ],
    ],
    [
      "choice/value-base",
      'let o = {text: "A", value: 1}\nrepeat askChoice o {}\nexit\n',
      ["valid"],
    ],
    [
      "choice/value-store",
      'let o = {text: "A", value: 1}\no.value = 2\nrepeat askChoice o {}\nexit\n',
      ["valid"],
    ],
    ["choice/text-base", "let o = {text: 0}\nrepeat askChoice o {}\nexit\n", ["valid"]],
    [
      "choice/text-store",
      "let o = {text: 0}\no.text = 3\nrepeat askChoice o {}\nexit\n",
      ["valid"],
    ],
    [
      "choice/display-store",
      'let o = {text: "A", value: 1}\no.text = "B"\nrepeat askChoice o {}\nexit\n',
      ["valid"],
    ],
    [
      "clock/weekday-repeat",
      "let d = getDate()\nrepeat d.weekday {}\nexit\n",
      ["compile-error", "integer-use compile-error @25"],
    ],
    [
      "clock/weekday-written-string",
      "let d = getDate()\nlet weekdayName: string = d.weekday\nexit\n",
      ["valid"],
    ],
    ["clock/date-written", "let t: date = getDate()\nexit\n", ["valid"]],
    ["clock/year-written-integer", "let n: integer = getDate().year\nexit\n", ["valid"]],
    ["clock/time-written", "let t: time = getTime()\nexit\n", ["valid"]],
    [
      "clock/time-written-integer",
      "let t: integer = getTime()\nexit\n",
      ["compile-error", "written-target compile-error @17"],
    ],
    [
      "fit/literal-mixed-written",
      "let r: integer = [2, 2.5][0]\nexit\n",
      [
        "copy-type r [integer] @17",
        "warning-runtime-check",
        "written-target warning-runtime-check @17",
      ],
      ["written-target warning-runtime-check member @17"],
    ],
    [
      "fit/literal-number-written",
      "let r: integer = [2.5, 3.5][0]\nexit\n",
      ["compile-error", "written-target compile-error @17"],
    ],
    [
      "fit/external-mixed-written",
      "let r: integer = [hostValue, 2.5][0]\nexit\n",
      [
        "copy-type r [integer] @17",
        "copy-type r [integer] @18",
        "copy-type r [integer] boundary @18",
        "warning-runtime-check",
        "written-target warning-runtime-check @17",
        "written-target warning-runtime-check @18",
      ],
      [
        "written-target warning-runtime-check member @17",
        "written-target warning-runtime-check unknown @18",
      ],
    ],
    [
      "fit/widened-place-written",
      "let xs = [1]\nxs.add(1.5)\nlet r: integer = xs.first\nexit\n",
      [
        "copy-type r [integer] @42",
        "warning-runtime-check",
        "written-target warning-runtime-check @42",
      ],
      ["written-target warning-runtime-check member @42"],
    ],
    [
      "fit/scalar-overwrite-written",
      "let n = 1\nn = 2.5\nlet r: integer = n\nexit\n",
      ["compile-error", "written-target compile-error @35"],
    ],
    [
      "fit/literal-mixed-repeat",
      "repeat [2, 2.5][0] {}\nexit\n",
      [
        "integer-check [2, 2.5][0] [integer] @7",
        "integer-use warning-runtime-check @7",
        "warning-runtime-check",
      ],
      ["integer-use warning-runtime-check member @7"],
    ],
    [
      "fit/literal-number-repeat",
      "repeat [2.5, 3.5][0] {}\nexit\n",
      ["compile-error", "integer-use compile-error @7"],
    ],
    ["fit/literal-integer-written", "let r: integer = [2, 3][0]\nexit\n", ["valid"]],
  ];
  const differing: string[] = [];
  for (const [name, source, expected, words = []] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = summary(record);
      const worded = record.diagnostics.map(
        (d) => `${d.kind} ${d.class} ${d.context} @${d.site.offset}`,
      );
      if (
        JSON.stringify(got) !== JSON.stringify(expected) ||
        words.some((word) => !worded.includes(word))
      )
        differing.push(`${name}${reversed ? " reversed" : ""}: ${[...got, ...worded].join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * §3.4, X3 (the lead's ruling on #1026's follow-up): a choice's button value, selected by key past the element step over
 * its options, carries the word `member` as its literal analogue does, written or held, and with options of both keys;
 * a whole option object, no element step, is the control. Kinds, warnings and checks are the analogue's; both orders.
 */
test("a choice over a list of options takes its literal analogue's word", () => {
  const pairs: readonly (readonly [string, string, string])[] = [
    [
      "a written list",
      'let result: integer = askChoice [{text: "A", value: 2}, {text: "B", value: 2.5}]\nexit',
      'let result: integer = [{text: "A", value: 2}, {text: "B", value: 2.5}][0].value\nexit',
    ],
    [
      "a held list",
      'let opts = [{text: "A", value: 2}, {text: "B", value: 2.5}]\nlet result: integer = askChoice opts\nexit',
      'let opts = [{text: "A", value: 2}, {text: "B", value: 2.5}]\nlet result: integer = opts[0].value\nexit',
    ],
    [
      "a whole option object",
      'let result: integer = askChoice {text: "A", value: 2.5}\nexit',
      'let result: integer = {text: "A", value: 2.5}.value\nexit',
    ],
  ];
  // its outcome, then its diagnostics with their words and its checks
  const record = (source: string, reversed: boolean): string[] => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const run = (): CompactRecord =>
      withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
    const got = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    return [
      got.outcome,
      ...got.diagnostics.map((d) => `${d.kind} ${d.class} ${d.context ?? "-"} @${d.site.offset}`),
      ...got.checks.map(
        (check) =>
          `${check.kind} ${check.target} [${check.against.join(", ")}] @${check.site.offset}`,
      ),
    ];
  };
  const differing: string[] = [];
  for (const reversed of [false, true]) {
    for (const [name, choice, analogue] of pairs)
      if (JSON.stringify(record(choice, reversed)) !== JSON.stringify(record(analogue, reversed)))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record(choice, reversed).join("; ")}`,
        );
    // options of both keys have no single analogue: the same word, by the same element step (their texts of one
    // family, ADR 0021 1.4)
    const mixed = record(
      "let result: integer = askChoice [{text: 1, value: 2}, {text: 2.5}]\nexit",
      reversed,
    );
    if (!mixed.includes("written-target warning-runtime-check member @22"))
      differing.push(`options of both keys${reversed ? " reversed" : ""}: ${mixed.join("; ")}`);
  }
  assert.deepEqual(differing, []);
  assert.ok(
    record(pairs[0]![1], false).includes("written-target warning-runtime-check member @22"),
    "the written list's word is member",
  );
});

/**
 * V30 §6, F10, F27 (Astra's B1 on #1028): a range's list holds the range's whole numbers, as the category layer declares
 * a range's elements, and maybe none, as its bounds decide (review round 3: `3..1` holds none, and its list's `first`
 * fails at runtime with TSR018). Its element read is an integer into a count, a written integer and through `first`,
 * bound, in a loop and through a function's result of two returns, each selection with its empty check; in both
 * orders. A written text is the control.
 */
test("a range's list holds its whole numbers, maybe none", () => {
  const programs: readonly (readonly [string, string, readonly string[]])[] = [
    [
      "counted",
      "let xs = (1..3).toList()\nrepeat xs.first {}\nexit",
      [
        "empty-check xs [list] @32",
        "member-read warning-runtime-check @32",
        "warning-runtime-check",
      ],
    ],
    [
      "into a written integer",
      "let n: integer = (1..3).toList().first\nexit",
      [
        "empty-check (1..3).toList() [list] @17",
        "member-read warning-runtime-check @17",
        "warning-runtime-check",
      ],
    ],
    ["visited by a loop", "for x in (1..3).toList() { repeat x {} }\nexit", ["valid"]],
    [
      "through a function's result",
      'function make(f) {\nif f { return (1..3).toList() }\nreturn (2..4).toList()\n}\nrepeat make(askBoolean "f").first {}\nexit',
      [
        "empty-check make.result [list] @83",
        "member-read warning-runtime-check @83",
        "warning-runtime-check",
      ],
    ],
    [
      "an empty range's first",
      "let xs = (3..1).toList()\nrepeat xs.first {}\nexit",
      [
        "empty-check xs [list] @32",
        "member-read warning-runtime-check @32",
        "warning-runtime-check",
      ],
    ],
    [
      "an empty range's removal",
      "let xs = (3..1).toList()\nrepeat xs.removeFirst() {}\nexit",
      [
        "empty-check xs [list] @32",
        "member-read warning-runtime-check @32",
        "warning-runtime-check",
      ],
    ],
    [
      "into a written text",
      "let s: string = (1..3).toList().first\nexit",
      [
        "compile-error",
        "empty-check (1..3).toList() [list] @16",
        "member-read warning-runtime-check @16",
        "written-target compile-error @16",
      ],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const got = summary(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * TABLE r4.47 (1), F15, §3.4 (Astra's D1 on #1028): a method without a category answers the runtime's opaque `unknown`
 * on a receiver of a known kind, and on what the core cannot know keeps that value's own reasons, so a chain of such
 * methods stays opaque (the word `unmodelled`), with no external data and no boundary; a modelled method in the chain
 * gives its declared result. Both orders.
 */
test("a chain of methods without a category stays opaque", () => {
  const cases: readonly (readonly [string, string, readonly string[], readonly string[]])[] = [
    [
      "two methods without a category",
      'let n: integer = "  alpha  ".trimStart().trimEnd()\nexit',
      [
        "copy-type n [integer] @17",
        'null-check "  alpha  ".trimStart() [non-null] @17',
        "warning-runtime-check",
      ],
      ["written-target warning-runtime-check unmodelled @17"],
    ],
    [
      "a modelled method, then one without a category",
      'let n: integer = "  alpha  ".uppercase().trimStart()\nexit',
      ["copy-type n [integer] @17", "warning-runtime-check"],
      ["written-target warning-runtime-check unmodelled @17"],
    ],
    [
      "one without a category, then a modelled method",
      'let n: integer = "  alpha  ".trimStart().uppercase()\nexit',
      ["compile-error", 'null-check "  alpha  ".trimStart() [non-null] @17'],
      ["written-target compile-error null @17"],
    ],
    [
      "a receiver of a known kind or an opaque answer",
      'let s = "a"\nlet t = s\nif askBoolean "f" { t = s.trimStart() }\nlet n: integer = t.trimEnd()\nexit',
      // (the opaque answer stored into `t`, decided a text by its start value, owes its check there: A5, C1)
      [
        "copy-type n [integer] @79",
        "copy-type t [string] @46",
        "null-check t [non-null] @79",
        "warning-runtime-check",
      ],
      ["written-target warning-runtime-check unmodelled @79"],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expected, words] of cases)
    for (const reversed of [false, true]) {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, `${name}: its source parses and resolves`);
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // its outcome and checks, and the words of its value's diagnostics
      const got = [
        record.outcome,
        ...record.checks.map(
          (check) =>
            `${check.kind} ${check.target} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} @${check.site.offset}`,
        ),
      ].sort();
      const worded = record.diagnostics.map(
        (d) => `${d.kind} ${d.class} ${d.context} @${d.site.offset}`,
      );
      if (
        JSON.stringify(got) !== JSON.stringify(expected) ||
        words.some((word) => !worded.includes(word))
      )
        differing.push(`${name}${reversed ? " reversed" : ""}: ${[...got, ...worded].join("; ")}`);
    }
  assert.deepEqual(differing, []);
});

/**
 * Admission's rules over stores, literals and fallbacks that the set leaves untested (review r1 of M4 S6), each in both
 * orders with its record, sites written as the text they start at: a declaration's start value decides before an
 * earlier store in a function (ADR 0021 1.6); a literal's element that copies a written binding keeps its written type
 * (A4, ADR 0021 1.3); a value none of whose kinds fits a field's, an element's or an entry's decided type errs (C1, ADR
 * 0021 1.7); a definite misfit is rejected, so a later use sees the decided type (A6), a null into a copy of a written
 * binding and a literal's element of another type included; C10's unknown fallback may fit the receiving written union,
 * and each offending kind of a fallback owes its own check; a fallback whose contract fits asks nothing (§3.3). Review
 * r2: a copied written type checks a literal's other elements by their own kinds (a whole number fits a written
 * integer, a fraction does not); a store none of whose possible kinds fits is rejected too; literals are checked at
 * any depth; a concrete misfit of a fallback is checked against the receiving union too; the lazy defaults of
 * `fileFromBase64`, `decryptText` and `decryptFile` follow C10 (ADR 0021 7.2). Review r4: a copy of a written type is
 * decided at every path of that type, read or not, and admits `null` only where its type, an earlier store or a null
 * element of the literal it stands in does. Review r5: returns, parameter defaults and single-site arguments decide the
 * result's and the parameter's paths as stores do. G3 2c: an element's earliest decider read through its carriers'
 * transfers, below nested selections (of a nullable written source too, and before a fallback or as a default) and
 * below a choice of choice objects, in both orders of the objects.
 */
test("admission decides from the start value, keeps written copies, rejects every definite misfit, and checks fallbacks per kind", () => {
  const f =
    'function f(flag: boolean): string | boolean {\n  if flag { return "bad" }\n  return false\n}\n';
  const nest = (depth: number, value: string): string =>
    `${"[".repeat(depth)}${value}${"]".repeat(depth)}`;
  // (a fourth part: what the reversed order gives where it differs)
  const programs: readonly (
    | readonly [string, string, (at: (text: string) => number) => string[]]
    | readonly [
        string,
        string,
        (at: (text: string) => number) => string[],
        (at: (text: string) => number) => string[],
      ]
  )[] = [
    [
      "a start value after an earlier store in a function",
      'function change { n = "bad" }\nlet n = 1\nrepeat n {}\nexit',
      (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
    ],
    [
      "a literal element copying a written union",
      'let original: integer | string = 1\nlet xs = [original, "ok"]\nsay xs\nexit',
      () => ["valid"],
    ],
    [
      "a dict value copying a written union",
      'let original: integer | string = 1\nlet d = dict{a: original, b: "ok"}\nsay d\nexit',
      () => ["valid"],
    ],
    [
      "a shared field copying a written union",
      'let original: integer | string = 1\nlet rows = [{n: original}, {n: "ok"}]\nsay rows\nexit',
      () => ["valid"],
    ],
    [
      "no kind fitting a decided field",
      `${f}let box = {n: 1}\nbox.n = f(true)\nsay box.n\nexit`,
      (at) => ["compile-error", `written-target compile-error @${at("f(true)")}`],
    ],
    [
      "no kind fitting a decided element or entry",
      `${f}let xs = [1]\nxs.add(f(true))\nlet d = dict{k: 1}\nd["k"] = f(true)\nexit`,
      (at) => [
        "compile-error",
        `written-target compile-error @${at("f(true))")}`,
        `written-target compile-error @${at("f(true)\nexit")}`,
      ],
    ],
    [
      "a null into a copy of a written binding",
      "let n: integer = 1\nlet copy = n\ncopy = null\nrepeat copy {}\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("null")}`],
    ],
    [
      "a literal's element of another type",
      'let xs = [1, "bad"]\nlet r: integer = xs.first\nexit',
      (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
    ],
    [
      "a literal's nested element of another type",
      'let xs = [{n: 1}, {n: "bad"}]\nexit',
      (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
    ],
    [
      "an unknown fallback landing in a written union",
      "let r: integer | string = [1, null][1] otherwise hostValue\nexit",
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("[1, null]")}`,
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type r [integer, string] @${at("[1, null]")}`,
        `copy-type hostValue [integer, number, string] @${at("hostValue")}`,
        `copy-type hostValue [unknown] boundary @${at("hostValue")}`,
      ],
    ],
    [
      "a fallback of two other kinds",
      `${f}let x = [1, null][1] otherwise f(true)\nexit`,
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("f(true)")}`,
        `written-target warning-runtime-check @${at("f(true)")}`,
        `copy-type f.result [integer, number] @${at("f(true)")}`,
        `copy-type f.result [integer, number] @${at("f(true)")}`,
      ],
    ],
    [
      "a written integer copied beside a whole number",
      "let n: integer = 1\nlet xs = [n, 2]\nrepeat xs[0] {}\nlet rows = [{n: n}, {n: 2}]\nexit",
      () => ["valid"],
    ],
    [
      "a written integer copied beside a fraction",
      "let n: integer = 1\nlet xs = [n, 2.5]\nexit",
      (at) => ["compile-error", `written-target compile-error @${at("2.5")}`],
    ],
    [
      "a written union copied beside a whole number",
      'let n: integer | string = "a"\nlet d = dict{first: n, second: 2}\nexit',
      () => ["valid"],
    ],
    [
      "no possible kind fitting a decided field",
      `${f}let box = {n: 1}\nbox.n = f(true)\nrepeat box.n {}\nexit`,
      (at) => ["compile-error", `written-target compile-error @${at("f(true)")}`],
    ],
    [
      "a deep literal's element of another type",
      `let xs = [${nest(300, "1")}, ${nest(300, '"bad"')}]\nexit`,
      (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
    ],
    [
      "a deep literal's element copying a written union",
      `let typed: integer | string = 1\nlet xs = [${nest(300, "typed")}, ${nest(300, '"ok"')}]\nexit`,
      // (in both orders since G3 2c: reversed, its deepest paths' decisions cost depth × copies past their allowance,
      // G6's in #1319's design-round list, until the decisions above the copy read the literal's transfers)
      () => ["valid"],
    ],
    [
      "a default's other kind beside the receiving union",
      'function alternate(flag: boolean): string | integer {\n  if flag { return "allowed" }\n  return 2\n}\nlet r: boolean | string = toBoolean("bad", default: alternate(true))\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("toBoolean")}`,
        `written-target warning-runtime-check @${at("alternate(true)")}`,
        `copy-type r [boolean, string] @${at("toBoolean")}`,
        `copy-type alternate.result [boolean, string] @${at("alternate(true)")}`,
      ],
    ],
    [
      "a lazy file default of another kind",
      'let r = fileFromBase64("!", default: false)\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("false")}`],
    ],
    [
      "a lazy decryption default of external data",
      'let r = decryptText("!", password: "p", default: hostValue)\nexit',
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type hostValue [string] @${at("hostValue")}`,
        `copy-type hostValue [unknown] boundary @${at("hostValue")}`,
      ],
    ],
    [
      "a lazy decryption default landing in a written union",
      'let r: string | boolean = decryptFile("!", password: "p", default: false)\nexit',
      () => ["valid"],
    ],
    [
      "a lazy file default of null",
      'let r = fileFromBase64("!", default: null)\nexit',
      () => ["valid"],
    ],
    [
      "a copy of a written list stored a list of another kind, its elements unread",
      'let typed: integer[] = [1]\nlet copy = typed\nlet other = ["bad"]\ncopy = other\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("other\nexit")}`],
    ],
    [
      "a copy of a written integer stored a possible null, then external data",
      "let typed: integer = 1\nlet copy = typed\ncopy = [1, null][1]\ncopy = hostValue\nexit",
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("[1, null]")}`,
        `written-target warning-runtime-check @${at("hostValue")}`,
        `null-check copy [integer] @${at("[1, null]")}`,
        `copy-type copy [integer] @${at("hostValue")}`,
        `copy-type copy [integer] boundary @${at("hostValue")}`,
      ],
    ],
    // the earliest deciding element decides a literal's path, a written copy only where it comes first; a `null` or an
    // unknown before it decides nothing (review: Astra's B2)
    [
      "a fraction before a copy of a written integer",
      "let whole: integer = 1\nlet xs = [2.5, whole]\nxs = [3.5]\nexit",
      () => ["valid"],
    ],
    [
      "a fraction before a copy of a written integer, in dict values and shared fields",
      "let whole: integer = 1\nlet d = dict{a: 2.5, b: whole}\nd = dict{c: 3.5}\nlet rows = [{n: 2.5}, {n: whole}]\nrows = [{n: 3.5}]\nexit",
      () => ["valid"],
    ],
    [
      "a whole number before a copy of a written text",
      'let s: string = "a"\nlet xs = [1, s]\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("s]")}`],
    ],
    [
      "a copy of a written integer first, a null and external data before it",
      "let whole: integer = 1\nlet xs = [whole, 2.5]\nlet ys = [null, hostValue, whole]\nys = [3.5]\nexit",
      (at) => [
        "compile-error",
        `written-target compile-error @${at("2.5")}`,
        `written-target compile-error @${at("3.5")}`,
        // (the null element keeps the element optional, ADR 0021 1.3; the external one owes its check and boundary)
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type ys.element [integer, null] @${at("hostValue")}`,
        `copy-type ys.element [integer, null] boundary @${at("hostValue")}`,
      ],
    ],
    // a return's literal decides the result's paths as a store's does: a later return of another element kind errs
    // (ADR 0021 1.5, A8; review r5)
    [
      "two returns' lists of different element kinds",
      'function g(flag: boolean) {\n  if flag { return [1] }\n  return ["x"]\n}\nlet r = g(true)\nexit',
      (at) => ["compile-error", `written-target compile-error @${at('"x"')}`],
    ],
    // a return of another kind is rejected, so the result's readers see the first return's kind (A6, F23; review:
    // Astra's D1); a written result's alike
    [
      "a return of another element kind, its result read",
      'function f(flag: boolean) {\n  if flag { return [3] }\n  return ["bad"]\n}\nlet n: integer = f(true).first\nexit',
      (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
    ],
    [
      "a return of another kind, its result read",
      'function f(flag: boolean) {\n  if flag { return 3 }\n  return "bad"\n}\nlet n: integer = f(true)\nexit',
      (at) => ["compile-error", `written-target compile-error @${at('"bad"')}`],
    ],
    // a literal's `null` element beside the copy makes the element optional (ADR 0021 1.3, A8), its type strict
    [
      "a list whose first element copies a written integer, a later one possibly null, then external data",
      "let typed: integer = 1\nlet xs = [typed, [1, null][1], hostValue]\nexit",
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type xs.element [integer, null] @${at("hostValue")}`,
        `copy-type xs.element [integer, null] boundary @${at("hostValue")}`,
      ],
    ],
    // (a possible misfit warns at the store's value, the literal; an error would sit at its innermost expression)
    [
      "a set whose first element copies a written integer, a later one possibly a fraction",
      "let typed: integer = 1\nlet xs = set[typed, [1, 2.5][1]]\nexit",
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("set[")}`,
        `copy-type xs.element [integer] @${at("set[")}`,
      ],
    ],
    [
      "a default whose written contract fits",
      "let fallback: integer = hostValue\nlet result = [1].get(2, default: fallback)\nexit",
      (at) => [
        "warning-runtime-check",
        `written-target warning-runtime-check @${at("hostValue")}`,
        `copy-type fallback [integer] @${at("hostValue")}`,
        `copy-type fallback [integer] boundary @${at("hostValue")}`,
      ],
    ],
    // G3 2c: the earliest decider read through the carriers' transfers (`admission/transfers.ts`)
    [
      "nested selections' element of another type",
      'let seed = "s"\nlet xs = [[[[seed, "o"][0], "o"][0], "o"][0], 1]\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("1]")}`],
    ],
    [
      "a choice object's selected value read below the choice",
      'let out = askChoice [{text: "a", value: {n: 1}}, {text: "b", value: {n: "x"}}]\nsay "${out.n}"\nexit',
      (at) => ["compile-error", `written-target compile-error @${at('"x"')}`],
    ],
    [
      "the choice objects in the other order",
      'let out = askChoice [{text: "b", value: {n: "x"}}, {text: "a", value: {n: 1}}]\nsay "${out.n}"\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("1}")}`],
    ],
    [
      "nested selections of a nullable written source",
      'let typed: string? = hostValue\nlet xs = [[[typed, "o"][0], "o"][0], 1]\nexit',
      (at) => [
        "compile-error",
        `copy-type typed [string, null] @${at("hostValue")}`,
        `copy-type typed [string, null] boundary @${at("hostValue")}`,
        `written-target compile-error @${at("1]")}`,
        `written-target warning-runtime-check @${at("hostValue")}`,
      ],
    ],
    [
      "nested selections before a fallback",
      'let seed = "s"\nlet xs = [([[seed, "o"][0], "o"][0] otherwise 2), 1]\nexit',
      (at) => [
        "compile-error",
        `copy-type xs.element [string] @${at("[(")}`,
        `written-target compile-error @${at("2)")}`,
        `written-target compile-error @${at("1]")}`,
        `written-target warning-runtime-check @${at("[(")}`,
      ],
    ],
    [
      "nested selections as a default",
      'let seed = ["s"]\nlet xs = [seed.get(0, default: [["d", "o"][0], "o"][0]), 1]\nexit',
      (at) => [
        "warning-runtime-check",
        `copy-type xs.element [integer] @${at("[seed")}`,
        `written-target warning-runtime-check @${at("[seed")}`,
      ],
    ],
    [
      "a place decided below nested selections of objects",
      'let seed = {p: "s"}\nlet box = [[seed, {p: "o"}][0], {p: "o"}][0]\nbox = {p: 2}\nsay box.p\nexit',
      (at) => ["compile-error", `written-target compile-error @${at("2}")}`],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expect, expectReversed = expect] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const expected = (reversed ? expectReversed : expect)((text) => source.indexOf(text)).sort();
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = summary(record);
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * A4 at every carrier of a definition (review r5): a copy of a written binding that a store, a literal's element, an add,
 * an `addAll`, a single-site argument, a parameter's default or a return brings decides its destination by the written
 * type, read or not, so a later possible fraction there owes C1's check against `integer`, a scalar's and a collection's
 * element's alike, and external data carried beside the copy owes its boundary against `integer` (C9). Both orders.
 */
test("a copy of a written type keeps it through every carrier", () => {
  // per carrier: the program around the copy `COPY` and the later value `LATER`, and the stored value the later one's
  // check sits at (an `addAll`'s list)
  const carriers: readonly (readonly [string, string, string])[] = [
    ["a store", "let d = COPY\nd = LATER\nexit", "LATER"],
    ["an add", "let d = []\nd.add(COPY)\nd.add(LATER)\nexit", "LATER"],
    ["an addAll", "let d = []\nd.addAll([COPY])\nd.addAll([LATER])\nexit", "[LATER]"],
    ["a single-site argument", "function use(p) {\n  p = LATER\n}\nuse(COPY)\nexit", "LATER"],
    ["a parameter's default", "function use(p = COPY) {\n  p = LATER\n}\nuse()\nexit", "LATER"],
    [
      "a return",
      'function give {\n  if askBoolean "first?" { return COPY }\n  return LATER\n}\nlet r = give()\nexit',
      "LATER",
    ],
  ];
  const kinds: readonly (readonly [string, string, string])[] = [
    ["a scalar", "let typed: integer = 1\n", "[1, 2.5][1]"],
    ["a list's element", "let typed: integer[] = [1]\n", "[[1], [2.5]][1]"],
  ];
  // per carrier of a literal: the program around the literal `HELD` that holds the copy beside external data
  const ingresses: readonly (readonly [string, string])[] = [
    ["a store", "let d = HELD\nexit"],
    ["a single-site argument", 'function use(p) {\n  say "inside"\n}\nuse(HELD)\nexit'],
    ["a return", "function give {\n  return HELD\n}\nlet r = give()\nexit"],
  ];
  const programs: (readonly [string, string, string, boolean])[] = [];
  for (const [carrier, shape, site] of carriers)
    for (const [kind, declaration, later] of kinds)
      programs.push([
        `${kind} through ${carrier}`,
        declaration + shape.replace("COPY", "typed").replace("LATER", later),
        site.replace("LATER", later),
        false,
      ]);
  for (const [carrier, shape] of ingresses)
    programs.push([
      `external data beside a copy through ${carrier}`,
      `let typed: integer = 1\n${shape.replace("HELD", "[typed, hostValue]")}`,
      "hostValue",
      true,
    ]);
  const differing: string[] = [];
  for (const [name, source, offending, boundary] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const at = source.lastIndexOf(offending);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // the value's check against the written kind at its own site, and the boundary there for external data
      const checked = record.checks.some(
        (check) =>
          check.kind === "copy-type" &&
          check.boundary === boundary &&
          check.site.offset === at &&
          JSON.stringify(check.against) === '["integer"]',
      );
      if (record.outcome !== "warning-runtime-check" || !checked)
        differing.push(`${name}${reversed ? " reversed" : ""}: ${summary(record).join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * F21, ADR 0021 1.5 (review: Astra's B1): each call types an unannotated parameter from its argument, and its default
 * is the start value the function is checked against once, so a supplied argument and the default never constrain each
 * other: the argument decides nothing and is no candidate, a store of another kind in the body errs against the default
 * whether calls supply the argument or omit it, and a written parameter checks its argument. Per kind of value (a
 * scalar, a list, a record, a dict): supplied (positionally, by name, at two calls), a body store of the argument's
 * kind with the argument supplied or omitted, and written; both orders.
 */
test("a supplied argument and a parameter's default never constrain each other", () => {
  const kinds: readonly (readonly [string, string, string, string | null])[] = [
    ["a scalar", "3", '"hello"', "integer"],
    ["a list", "[3]", '["hello"]', "integer[]"],
    ["a record", "{n: 3}", '{n: "hello"}', null],
    ["a dict", "dict{a: 3}", 'dict{a: "hello"}', null],
  ];
  const programs: (readonly [string, string, boolean])[] = [];
  const body = (statement: string): string => `{\n  ${statement}\n}`;
  for (const [kind, given, other, written] of kinds) {
    const show = (parameter: string, statement: string): string =>
      `function show(${parameter}) ${body(statement)}\n`;
    const plain = `value = ${given}`;
    programs.push(
      [`${kind}, supplied`, `${show(plain, 'say "shown"')}show(${other})\nexit`, false],
      [
        `${kind}, supplied by name`,
        `${show(plain, 'say "shown"')}show(value: ${other})\nexit`,
        false,
      ],
      [
        `${kind}, supplied at two calls`,
        `${show(plain, 'say "shown"')}show(${other})\nshow(${other})\nexit`,
        false,
      ],
      [
        `${kind}, supplied, another kind stored in the body`,
        `${show(plain, `value = ${other}`)}show(${other})\nexit`,
        true,
      ],
      [
        `${kind}, omitted, another kind stored in the body`,
        `${show(plain, `value = ${other}`)}show()\nexit`,
        true,
      ],
    );
    if (written !== null)
      programs.push([
        `${kind}, written`,
        `${show(`value: ${written} = ${given}`, 'say "shown"')}show(${other})\nexit`,
        true,
      ]);
  }
  const differing: string[] = [];
  for (const [name, source, errs] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const expected = errs
      ? ["compile-error", `written-target compile-error @${source.indexOf('"hello"')}`]
      : ["valid"];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const got = summary(reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run());
      if (JSON.stringify(got) !== JSON.stringify(expected.sort()))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * TABLE §3.4, F12 (r4.48 (5)): the word is the read's first failing condition; an element read fails X3 (`member`)
 * where the contract answers it, several element-contributing sources or a literal of several elements meeting at the
 * read's element step, before a later condition's word (`branch`) and the result's own (`call`); a single exact
 * contribution keeps the read's word. A call's result with two returns and with one, a variable's literal of two
 * elements, a list stored in a branch beside another list and beside an empty one; both orders.
 */
test("an element read the contract answers is X3's member, before a later condition's word", () => {
  const programs: readonly (readonly [string, string, string])[] = [
    [
      "a call's result of two returns",
      "function f(flag: boolean) {\n  if flag { return [1] }\n  return [1.5]\n}\nrepeat f(true).first {}\nexit",
      "member",
    ],
    [
      "a call's result of one return",
      "function f {\n  return [[1, 2.5][0]]\n}\nrepeat f().first {}\nexit",
      "call",
    ],
    [
      "a variable's literal of two elements",
      "let xs = [1, 1.5]\nrepeat xs.first {}\nexit",
      "member",
    ],
    [
      "a list stored in a branch beside another",
      'let xs = [1]\nif askBoolean("b") { xs = [1.5] }\nrepeat xs.first {}\nexit',
      "member",
    ],
    [
      "a list stored in a branch beside an empty one",
      'let xs = [1.5]\nif askBoolean("b") { xs = [] }\nrepeat xs.first {}\nexit',
      "branch",
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, word] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const words = record.diagnostics
        .filter((diagnostic) => diagnostic.kind === "integer-use")
        .map((diagnostic) => `${diagnostic.class} ${diagnostic.context}`);
      if (JSON.stringify(words) !== JSON.stringify([`warning-runtime-check ${word}`]))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${words.join("; ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * C9, F18 beside F21 and ADR 0021 1.5 (reviews r7 and r8 of the repairs): external data an argument brings into an
 * unannotated parameter with a default is checked against the argument's own kinds at the boundary's path, never the
 * default's decision: a parsed text against its expected text, host data against `unknown`, positionally, by name and at
 * two calls; a record that carries a parsed text or host data against its record, at the first ingress (C9 r4.34,
 * r4.35); a list's element against the element's kinds; a written parameter's boundary is its type. Both orders.
 */
test("an argument beside a default meets its own boundary, never the default's", () => {
  const parsed = 'fromJson("\\"hello\\"", default: "hello", files: false)';
  const show = (parameter: string, statement: string): string =>
    `function show(${parameter}) {\n  ${statement}\n}\n`;
  // per program its outcome and its boundary checks, as target and kinds
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "a parsed text",
      `${show("value = [3]", "say value")}show(${parsed})\nexit`,
      "valid",
      ["show.value [string]"],
    ],
    [
      "a parsed text at two calls",
      `${show("value = [3]", "say value")}show(${parsed})\nshow(${parsed})\nexit`,
      "valid",
      ["show.value [string]", "show.value [string]"],
    ],
    [
      "host data",
      `${show("value = [3]", "say value.length")}show(hostValue)\nexit`,
      "warning-runtime-check",
      ["show.value [unknown]"],
    ],
    [
      "host data by name",
      `${show("value = [3]", "say value.length")}show(value: hostValue)\nexit`,
      "warning-runtime-check",
      ["show.value [unknown]"],
    ],
    [
      "a record carrying a parsed text",
      `${show('value = {text: ""}', "say value.text")}show({text: ${parsed}})\nexit`,
      "valid",
      ["show.value [object]"],
    ],
    [
      "a record carrying a parsed text and a parsed number",
      `${show('value = {text: ""}', "say value.text")}show({text: ${parsed}, count: fromJson("1", default: 1, files: false)})\nexit`,
      "valid",
      ["show.value [object]"],
    ],
    [
      "a record carrying host data and a parsed text",
      `${show('value = {text: ""}', "say value.text")}show({extra: hostValue, text: ${parsed}})\nexit`,
      "valid",
      ["show.value [object]"],
    ],
    [
      "a list carrying a parsed text",
      `${show('value = [""]', "say value")}show([${parsed}])\nexit`,
      "valid",
      ["show.value.element [string]"],
    ],
    [
      "a parsed text bound first",
      `${show("value = [3]", "say value")}let text = ${parsed}\nshow(text)\nexit`,
      "valid",
      ["text [string]"],
    ],
    [
      "a parsed text forwarded through another function",
      `${show("value = [3]", "say value")}function pass(given) {\n  show(given)\n}\npass(${parsed})\nexit`,
      "valid",
      ["pass.given [string]"],
    ],
    [
      "a parsed text into a written list",
      `${show("value: integer[] = [3]", "say value")}show(${parsed})\nexit`,
      "compile-error",
      ["show.value [list]"],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const boundaries = record.checks
        .filter((check) => check.boundary)
        .map((check) => `${check.target} [${check.against.join(", ")}]`)
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(boundaries) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${boundaries.join("; ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("external data a literal carries is warned and checked at its store where a type is admitted, read or not (C1, C9, the owner's F1)", () => {
  const after = '\nsay "AFTER"\nexit';
  // per program its outcome and its copy checks, as target, kinds, boundary (B) and site: C1's at the host expression
  // against the literal's decided elements, and C9's boundary there
  const at = (target: string, kinds: string, site: number): string[] => [
    `${target} [${kinds}] @${site}`,
    `${target} [${kinds}] B @${site}`,
  ];
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "a list",
      `let xs = [1, hostValue]${after}`,
      "warning-runtime-check",
      at("xs.element", "integer", 13),
    ],
    [
      "a list read nowhere live",
      `let xs = [1, hostValue]\nif false { repeat xs[0] {} }${after}`,
      "warning-runtime-check",
      at("xs.element", "integer", 13),
    ],
    [
      "a list, host data first",
      `let xs = [hostValue, 1]${after}`,
      "warning-runtime-check",
      at("xs.element", "integer", 10),
    ],
    [
      "a list of texts",
      `let xs = ["a", hostValue]${after}`,
      "warning-runtime-check",
      at("xs.element", "string", 15),
    ],
    [
      "a nested list",
      `let xs = [[1, hostValue]]${after}`,
      "warning-runtime-check",
      at("xs.element.element", "integer", 14),
    ],
    [
      "a nested list's later element",
      `let xs = [[1], [hostValue]]${after}`,
      "warning-runtime-check",
      at("xs.element.element", "integer", 16),
    ],
    [
      "a copied list",
      `let ys = [1, hostValue]\nlet xs = ys${after}`,
      "warning-runtime-check",
      at("ys.element", "integer", 13),
    ],
    [
      "a set",
      `let xs = set[1, hostValue]${after}`,
      "warning-runtime-check",
      at("xs.element", "integer", 16),
    ],
    [
      "a dict",
      `let xs = dict{a: 1, b: hostValue}${after}`,
      "warning-runtime-check",
      at("xs.entry", "integer", 23),
    ],
    [
      "a list of records",
      `let xs = [{n: 1}, {n: hostValue}]${after}`,
      "warning-runtime-check",
      ["xs.element.n [integer] @22", "xs.element [object] B @22"],
    ],
    [
      "a returned list",
      `function g {\n  return [1, hostValue]\n}\nlet xs = g()${after}`,
      "warning-runtime-check",
      at("g.result.element", "integer", 26),
    ],
    [
      "a passed list",
      `function f(p) {\n  say "x"\n}\nf([1, hostValue])${after}`,
      "warning-runtime-check",
      at("f.p.element", "integer", 34),
    ],
    // where no type is admitted, nothing is checked until a consumer asks
    ["a list of host data alone", `let xs = [hostValue, hostValue]${after}`, "valid", []],
    ["a record of host data alone", `let o = {n: hostValue}${after}`, "valid", []],
    ["a record of host data beside a number", `let r = {n: hostValue, m: 1}${after}`, "valid", []],
    [
      "a returned record of host data",
      `function packet {\n  return {amount: hostValue}\n}\nlet data = packet()${after}`,
      "valid",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const copies = record.checks
        .filter((check) => check.kind === "copy-type")
        .map(
          (check) =>
            `${check.target} [${check.against.join(", ")}]${check.boundary ? " B" : ""} @${check.site.offset}`,
        )
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(copies) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${copies.join("; ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a named collection in a literal or an add brings its elements' types to the literal's, as a written one would (A8, the owner's F2)", () => {
  const after = '\nsay "AFTER"\nexit';
  const lists = 'let a = [1]\nlet b = ["bad"]\n';
  // per program its outcome and its errors' sites: the named source of another type, where it is written
  const programs: readonly (readonly [string, string, string, readonly number[]])[] = [
    ["a list of lists", `${lists}let xs = [a, b]${after}`, "compile-error", [41]],
    ["a list of lists, nested", `${lists}let xs = [[a], [b]]${after}`, "compile-error", [43]],
    ["a set of lists", `${lists}let xs = set[a, b]${after}`, "compile-error", [44]],
    ["a dict of lists", `${lists}let xs = dict{x: a, y: b}${after}`, "compile-error", [51]],
    ["a record of lists", `${lists}let xs = [{n: a}, {n: b}]${after}`, "compile-error", [46]],
    [
      "a list of dicts",
      `let a = dict{k: 1}\nlet b = dict{k: "bad"}\nlet xs = [a, b]${after}`,
      "compile-error",
      [55],
    ],
    [
      "a list of sets",
      `let a = set[1]\nlet b = set["bad"]\nlet xs = [a, b]${after}`,
      "compile-error",
      [47],
    ],
    ["an add", `${lists}let xs = [a]\nxs.add(b)${after}`, "compile-error", [48]],
    ["a whole store", `${lists}let xs = a\nxs = b${after}`, "compile-error", [44]],
    ["each copy of the source", `${lists}let xs = [a, b, b, a]${after}`, "compile-error", [41, 44]],
    [
      "results of calls",
      `function f {\n  return [1]\n}\nfunction g {\n  return ["bad"]\n}\nlet xs = [f(), g()]${after}`,
      "compile-error",
      [75],
    ],
    [
      "fields read",
      `let r = {items: [1]}\nlet s = {items: ["bad"]}\nlet xs = [r.items, s.items]${after}`,
      "compile-error",
      [65],
    ],
    [
      "lists grown by adds",
      `let a = []\na.add(1)\nlet b = []\nb.add("bad")\nlet xs = [a, b]${after}`,
      "compile-error",
      [57],
    ],
    // the literal forms the named ones match
    ["inline lists", `let xs = [[1], ["bad"]]${after}`, "compile-error", [16]],
    ["an inline add", `let xs = [[1]]\nxs.add(["bad"])${after}`, "compile-error", [22]],
    ["inline records", `let xs = [{n: 1}, {n: "bad"}]${after}`, "compile-error", [22]],
    // a named record's field, reached only through copies, where the copy meets the literal, read or not (A2, ADR 0021
    // rule 1.1, TABLE r4.131)
    [
      "records, a field read",
      `let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, b]\nrepeat xs[0].n {}${after}`,
      "compile-error",
      [47],
    ],
    [
      "a record beside a literal one",
      `let b = {n: "bad"}\nlet xs = [{n: 1}, b]${after}`,
      "compile-error",
      [37],
    ],
    // whole numbers with numbers; fields apart
    [
      "whole numbers and numbers",
      `let a = [1]\nlet b = [2.5]\nlet xs = [a, b]${after}`,
      "valid",
      [],
    ],
    [
      "records of other fields",
      `let a = {n: 1}\nlet b = {m: "x"}\nlet xs = [a, b]${after}`,
      "valid",
      [],
    ],
    [
      "records, no field read",
      `let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, b]${after}`,
      "compile-error",
      [47],
    ],
    [
      "records holding lists, no field read",
      `let a = {items: [1]}\nlet b = {items: ["bad"]}\nlet xs = [a, b]${after}`,
      "compile-error",
      [59],
    ],
    // host data named in the literal: no error, C1's check against the decided lists (round 10 B1)
    [
      "host data",
      `let a = [1]\nlet b = hostValue\nlet xs = [a, b]${after}`,
      "warning-runtime-check",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, sites] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const errors = record.diagnostics
        .filter((diagnostic) => diagnostic.class === "compile-error")
        .map((diagnostic) => diagnostic.site.offset)
        .sort((a, b) => a - b);
      if (record.outcome !== outcome || JSON.stringify(errors) !== JSON.stringify(sites))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome} @${errors.join(", @")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a property only copies of whole objects bring errs where the copy meets the place, read or not; a store or a literal's own field keeps its error (ADR 0021 rule 1.1, TABLE r4.131)", () => {
  // per program its errors as site text
  const programs: readonly (readonly [string, string, readonly string[]])[] = [
    [
      "copies of variables",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet c = a\nc = b\nsay c.n\nexit',
      ["b"],
    ],
    // a conflict nobody reads is refused, as for inline objects, in either order of the copies
    [
      "copies of variables, unread",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet c = a\nc = b\nexit',
      ["b"],
    ],
    [
      "copies of variables, the other first",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet c = b\nc = a\nexit',
      ["a"],
    ],
    [
      "a list, a set and a dict of copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, b]\nlet ys = set[a, b]\nlet zs = dict{"a": a, "b": b}\nexit',
      ["b", "b", "b"],
    ],
    [
      "a literal of copies nothing stores",
      'let a = {n: 1}\nlet b = {n: "bad"}\nsay [a, b].length\nexit',
      ["b"],
    ],
    // a projection that copies a whole object is a copy too
    [
      "copies through projections",
      'let bundle = {left: {n: 1}, right: {n: "bad"}}\nlet c = bundle.left\nc = bundle.right\nsay c.n\nexit',
      ["bundle.right"],
    ],
    // a store through the property is the property's own, whatever names its value
    [
      "a direct store of a named value",
      'let a = {n: 1}\nlet c = a\nsay c.n\nlet wrong = "bad"\nc.n = wrong\nexit',
      ["wrong"],
    ],
    // copies inside literals that wrap them, at the wrapper that brings the copy
    [
      "copies through literal wrappers",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet c = {box: {inner: a}}\nc = {box: {inner: b}}\nsay c.box.inner.n\nexit',
      ["{box: {inner: b}}"],
    ],
    [
      "elements wrapping copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [{inner: a}, {inner: b}]\nsay xs[0].inner.n\nexit',
      ["{inner: b}"],
    ],
    // a dict's values, an added list's elements, and a wrapper without the property, like the list's
    [
      "dict values wrapping copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = dict{a: {inner: a}, b: {inner: b}}\nsay xs["a"].inner.n\nexit',
      ["{inner: b}"],
    ],
    [
      "an added list wrapping a copy",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [{inner: a}]\nxs.addAll([{inner: b}])\nsay xs[0].inner.n\nexit',
      ["[{inner: b}]"],
    ],
    [
      "a wrapper without the property beside the copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [{inner: a}, {inner: {}}, {inner: b}]\nsay xs[0].inner.n\nexit',
      ["{inner: b}"],
    ],
    [
      "a wrapper with the property beside the copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [{inner: a}, {inner: {n: 2}}, {inner: b}]\nsay xs[0].inner.n\nexit',
      ["{inner: b}"],
    ],
    // copies in a literal that lands inside another literal or through an add: at the copy in its own literal
    [
      "a list of copies inside an object",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = {items: [a, b]}\nxs.items[0].n = 2\nexit',
      ["b"],
    ],
    [
      "a list of copies inside a list",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [[a, b]]\nsay xs[0][0].n\nexit',
      ["b"],
    ],
    [
      "an added list of copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = []\nxs.addAll([a, b])\nsay xs[0].n\nexit',
      ["b"],
    ],
    [
      "an added element that is a list of copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = []\nxs.add([a, b])\nsay xs[0][0].n\nexit',
      ["b"],
    ],
    // a literal's own field is its own contribution, whatever it copies
    [
      "a literal's field copied from a property",
      'let a = {n: 1}\nlet c = {n: a.n}\nc = {n: "bad"}\nsay c.n\nexit',
      ['"bad"'],
    ],
    [
      "a literal's field beside the copies",
      'let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = [a, {n: 2}, b]\nsay xs[0].n\nexit',
      ["b"],
    ],
    // an object with a written property beside a plain one: the plain one where the copy meets the place, the written
    // one by its written type (A4)
    [
      "a plain property beside a written one",
      'let typed: integer = 1\nlet a = {n: typed, m: 1}\nlet b = {n: 2, m: "x"}\nlet c = a\nc = b\nlet xs = [a, b]\nexit',
      ["b", "b"],
    ],
    // a place whose own type is unknown, a property of it receiving copies, each rejection found again (Codex r2 B3)
    [
      "copies into a property of host data",
      'let c = hostValue\nlet a = {n: 1}\nlet b = {n: "x"}\nc.inner = a\nc.inner = b\nc.inner = b\nexit',
      ["b", "b"],
    ],
    [
      "copies into a place that starts empty",
      'let a = {n: 1}\nlet b = {n: "x"}\nlet c = null\nc = a\nc = b\nexit',
      ["b"],
    ],
    // whole numbers and numbers are one family, so nothing errs
    [
      "a whole number beside a number",
      "let a = {n: 1}\nlet b = {n: 1.5}\nlet xs = [a, b]\nlet c = a\nc = b\nexit",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const errors = record.diagnostics
        .filter((diagnostic) => diagnostic.class === "compile-error")
        .map(({ site }) => source.slice(site.offset, site.end));
      if (JSON.stringify(errors) !== JSON.stringify(expected))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${errors.join(", ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/** A record as its outcome, then each diagnostic's class, kind, site and related site, and each check, sorted (A2). */
function a2Record(source: string, reversed: boolean): string[] {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const run = (): CompactRecord =>
    withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
  const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
  const text = (site: { readonly offset: number; readonly end: number }): string =>
    `'${source.slice(site.offset, site.end)}'`;
  return [
    record.outcome,
    ...[
      ...record.diagnostics.map(
        ({ kind, class: level, site, related }) =>
          `${level} ${kind} ${text(site)}${related === undefined ? "" : ` related ${text(related)}`}`,
      ),
      ...record.checks.map((check) => `check ${check.kind} ${check.target} ${text(check.site)}`),
    ].sort(),
  ];
}

/**
 * A2's witnesses (TABLE r4.131, r4.154), their exact records in both orders of the copy and the object and in both
 * analysis orders: per form, a place copied with its setup and an object holding another type at one property, stored
 * into one place and as a list's elements, unread. Through whole copies (Codex r1's cycle of whole copies, a cycle fed
 * from outside, a copy into a property, a projection, nested objects, a written property beside an inferred one, a
 * property that may be null) the second errs where it meets the place or the list. Through a cycle of copies that adds or
 * takes steps (Codex r2's and r3's projections and composed projections, r2's and r5's self-grafts) their meeting is
 * beyond the bound (design §2.1.2): valid unread; read, the error is at the first read and names the second.
 */
test("A2's witnesses: whole copies err where they meet the place or the list, read or not; a cycle that adds or takes steps errs where it is read, in both orders", () => {
  // per form: its setup, the place copied, the object of another type, and for a cycle beyond the bound the path read
  const forms: readonly (readonly [string, string, string, string, string | null])[] = [
    [
      "a cycle of whole copies",
      "let a = {n: 1}\nlet b = {m: 2}\na = b\nb = a",
      "a",
      '{m: "x"}',
      null,
    ],
    [
      "a cycle fed from outside",
      "let src = {n: 1}\nlet a = src\nlet b = a\na = b",
      "b",
      '{n: "x"}',
      null,
    ],
    [
      "a copy into a property",
      "let src = {n: 1}\nlet a = {p: null}\na.p = src",
      "a",
      '{p: {n: "x"}}',
      null,
    ],
    ["a projection", "let bundle = {left: {n: 1}}\nlet a = bundle.left", "a", '{n: "x"}', null],
    [
      "nested objects",
      "let inner = {n: 1}\nlet a = {box: {inner: inner}}",
      "a",
      '{box: {inner: {n: "x"}}}',
      null,
    ],
    [
      "a written property beside an inferred one",
      "let typed: integer = 1\nlet a = {n: typed, m: 1}",
      "a",
      '{n: 2, m: "x"}',
      null,
    ],
    [
      "a property that may be null",
      "let a = {inner: {n: 1}}\nlet b = {inner: null}\nb = a",
      "b",
      '{inner: {n: "x"}}',
      null,
    ],
    ["a projection of itself", "let a = {inner: {n: 1}}\na = a.inner", "a", '{n: "x"}', "n"],
    [
      "a store into its own property",
      "let a = {n: 1, inner: null}\na.inner = a",
      "a",
      '{inner: {n: "x"}}',
      "inner.n",
    ],
    [
      "composed projections",
      "let a = {left: {right: {n: 1}}}\nlet b = a.left\na = b.right",
      "a",
      '{n: "x"}',
      "n",
    ],
    [
      "two places stored into each other's property",
      "let a = {n: 1, inner: null}\nlet b = {m: 2, inner: null}\na.inner = b\nb.inner = a",
      "a",
      '{inner: {m: "x"}}',
      "inner.m",
    ],
    [
      "a store into its own property in a loop",
      "let a = {n: 1, inner: null}\nrepeat 3 {\n  a.inner = a\n}",
      "a",
      '{inner: {n: "x"}}',
      "inner.n",
    ],
    [
      "a self-graft below a projection through wrappers",
      "let a = {n: 1, inner: null}\nlet b = {p: a}\nlet d = {q: b}\na = d.q.p\na.inner = a",
      "d",
      '{q: {p: {n: "x"}}}',
      "q.p.n",
    ],
  ];
  const differing: string[] = [];
  const expect = (label: string, source: string, expected: readonly string[]): void => {
    for (const reversed of [false, true]) {
      const actual = a2Record(source, reversed);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        differing.push(`${label}${reversed ? ", reversed" : ""}: ${actual.join(", ")}`);
    }
  };
  for (const [form, setup, place, other, read] of forms)
    for (const copyFirst of [true, false]) {
      const [first, second] = copyFirst ? [place, "bad"] : ["bad", place];
      const label = `${form}, ${copyFirst ? "the copy" : "the object"} first`;
      const stored = `${setup}\nlet bad = ${other}\nlet c = ${first}\nc = ${second}`;
      const listed = `${setup}\nlet bad = ${other}\nlet xs = [${first}, ${second}]\nexit`;
      if (read === null) {
        const at = (code: string): string[] => [
          "compile-error",
          `compile-error ${code} '${second}'`,
        ];
        expect(`${label}, stored`, `${stored}\nexit`, at("written-target"));
        expect(`${label}, listed`, listed, at("written-target"));
        continue;
      }
      expect(`${label}, stored`, `${stored}\nexit`, ["valid"]);
      expect(`${label}, listed`, listed, ["valid"]);
      expect(`${label}, read`, `${stored}\nsay c.${read}\nexit`, [
        "compile-error",
        `compile-error written-target 'c.${read}' related '${second}'`,
      ]);
    }
  // Codex r2's six permutations (#1293): a ring of three whole copies, two members starting with one object and the
  // third with another; the copy that first brings the third's type errs or is checked where it meets its member
  const objects = { good: "{n:1}", bad: '{n:"x"}', flag: "{n:true}" } as const;
  for (const first of ["good", "bad", "flag"] as const)
    for (const other of ["good", "bad", "flag"] as const) {
      if (first === other) continue;
      const ring =
        `let good=${objects.good}\nlet bad=${objects.bad}\nlet flag=${objects.flag}\n` +
        `let a2=${other}\nlet a0=${first}\nlet a1=${other}\na2=a0\na1=a2\na0=a1\nexit`;
      expect(`a ring of ${other}, ${first} and ${other}`, ring, [
        "compile-error",
        "check copy-type a2.n 'a0'",
        "compile-error written-target 'a2'",
        "warning-runtime-check written-target 'a0'",
      ]);
    }
  // Codex r3's B4 and the second store of the same object (#1293): a ring of three copies fed an object of three
  // properties, each relay then taking an empty object, or the same object again, and the first member another of
  // three other-typed properties; one error per property where it meets the first member (the same-object relays are
  // asked there too: a known cost, G5, #1339)
  const fields = (value: string): string => `p0:${value},p1:${value},p2:${value}`;
  for (const [axis, second] of [
    ["an empty object", "{}"],
    ["the same object", "good"],
  ] as const)
    expect(
      `a fed ring whose relays each also take ${axis}`,
      `let good={${fields("1")}}\nlet bad={${fields('"x"')}}\nlet a0=good\nlet a1=a0\nlet a2=a1\na0=a2\n` +
        `a1=${second}\na2=${second}\na0=bad\nexit`,
      [
        "compile-error",
        "compile-error written-target 'bad'",
        "compile-error written-target 'bad'",
        "compile-error written-target 'bad'",
      ],
    );
  // a written `object?` place holds any object, its properties unchecked, inline or copied (A1)
  expect(
    "a written object? place",
    'let a = {n: 1}\nlet b = {n: "x"}\nlet c: object? = null\nc = a\nc = b\nc = {n: 1}\nc = {n: "x"}\nexit',
    ["valid"],
  );
  assert.deepEqual(differing, []);
});

/**
 * A2's value origins (Astra r1 N1 on #1293): a property's value in one of two objects whose property holds two kinds, as
 * a literal, a written or an inferred binding, a written binding in a nested object, a binding written as a union or as
 * `object?` (the property itself, or one below it), in either object; the objects as a list's elements, stores into one
 * place, the same through projections, and a ring of whole copies, in both orders, unread and read. A written binding's
 * copy brings its written type as a literal brings its kind: the second errs where it meets the place or the list, read
 * or not, and a union's copy only where it comes second (first, the place takes both kinds). An `object?` holds any
 * object, its properties unchecked (A1): below it, nothing meets, and what a read of such a property gives is the read's
 * own record, not A2's.
 */
test("A2's value origins: a written binding's copy errs where it meets the place or the list as a literal's does, read or not, in both orders", () => {
  const values = { int: ["integer", "1"], str: ["string", '"text"'] } as const;
  // per origin: the setup it needs, the object with its value of a kind, the plain object of a kind, the path compared
  const origins: readonly (readonly [
    string,
    (kind: "int" | "str") => readonly [string, string],
    (kind: "int" | "str") => string,
    string,
  ])[] = [
    [
      "a literal",
      (kind) => ["", `{n: ${values[kind][1]}}`],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "a written binding",
      (kind) => [`let w: ${values[kind][0]} = ${values[kind][1]}\n`, "{n: w}"],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "an inferred binding",
      (kind) => [`let w = ${values[kind][1]}\n`, "{n: w}"],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "a written binding in a nested object",
      (kind) => [`let w: ${values[kind][0]} = ${values[kind][1]}\n`, "{p: {n: w}}"],
      (kind) => `{p: {n: ${values[kind][1]}}}`,
      "p.n",
    ],
    [
      "a union binding",
      (kind) => [`let w: (integer | string) = ${values[kind][1]}\n`, "{n: w}"],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "an object? binding beside a scalar",
      (kind) => [`let w: object? = {k: ${values[kind][1]}}\n`, "{n: w}"],
      (kind) => `{n: ${values[kind][1]}}`,
      "n",
    ],
    [
      "an object? binding below it",
      (kind) => [`let w: object? = {k: ${values[kind][1]}}\n`, "{n: w}"],
      (kind) => `{n: {k: ${values[kind][1]}}}`,
      "n.k",
    ],
  ];
  // per shape: the program after the objects `a` and `b`, the second's site, and the place read
  const shapes: readonly (readonly [
    string,
    (first: string, second: string) => string,
    (second: string) => string,
    string,
  ])[] = [
    ["a list", (first, second) => `let xs = [${first}, ${second}]`, (second) => second, "xs[0]"],
    ["a place", (first, second) => `let c = ${first}\nc = ${second}`, (second) => second, "c"],
    [
      "a list through projections",
      (first, second) =>
        `let x = {inner: ${first}}\nlet y = {inner: ${second}}\nlet xs = [x.inner, y.inner]`,
      () => "y.inner",
      "xs[0]",
    ],
    [
      "a place through projections",
      (first, second) =>
        `let x = {inner: ${first}}\nlet y = {inner: ${second}}\nlet c = x.inner\nc = y.inner`,
      () => "y.inner",
      "c",
    ],
    [
      "a ring of whole copies",
      (first, second) => `let c = ${first}\nlet d = c\nc = d\nd = ${second}`,
      (second) => second,
      "c",
    ],
  ];
  const differing: string[] = [];
  for (const [origin, value, plain, path] of origins)
    for (const side of ["int", "str"] as const) {
      const [setup, own] = value(side);
      const objects = {
        a: side === "int" ? own : plain("int"),
        b: side === "str" ? own : plain("str"),
      };
      const sideOf = side === "int" ? "a" : "b";
      for (const [shape, program, siteOf, place] of shapes)
        for (const [first, second] of [
          ["a", "b"],
          ["b", "a"],
        ] as const) {
          const source = `${setup}let a = ${objects.a}\nlet b = ${objects.b}\n${program(first, second)}\n`;
          const label = `${origin} in ${sideOf}, ${shape}, ${first} first`;
          const unread =
            origin.endsWith("below it") || (origin === "a union binding" && first === sideOf);
          const expected = unread
            ? ["valid"]
            : ["compile-error", `compile-error written-target '${siteOf(second)}'`];
          for (const reversed of [false, true]) {
            const actual = a2Record(`${source}exit`, reversed);
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              differing.push(`${label}${reversed ? ", reversed" : ""}: ${actual.join(", ")}`);
            if (origin.endsWith("below it")) continue;
            const read = a2Record(`${source}say ${place}.${path}\nexit`, reversed);
            if (JSON.stringify(read) !== JSON.stringify(expected))
              differing.push(`${label}, read${reversed ? ", reversed" : ""}: ${read.join(", ")}`);
          }
        }
    }
  assert.deepEqual(differing, []);
});

test("the copied-property check grows with the program, not with its copies times its fields, in either order (A2, TABLE r4.131)", () => {
  // k copies of a record with k fields and a record of k other-typed fields, each field read: one error per field; the
  // copies as a list's elements, as stores into one variable, and wrapped in literals of both. The gate's shapes (TABLE
  // r4.131), unread, in both orders of the copies: k copies of the first record in one list beside a copy of one that
  // differs in one field (one error, or one per copy where it comes first), and k places each receiving a copy of each
  // (one error per place, at its store). k places each receiving a copy of the first record and then its own object of
  // one other-typed field (one error each). A ring of k whole copies fed the first record and then the other (one error
  // per field, at the store bringing it: Codex r1's review of #1293), and a quiet one. Beyond the bound (r4.154),
  // linear: Codex r4's k independent property cycles of one object, `b_i = a.f_i`, `a.f_i = b_i`, the object then
  // copied beside another type (one error, at its own property), and r5's: those cycles beside k self-grafts
  // `a.g_i = a` (none). The written-type axis (Astra r1 N1): the elements, the stores, the places and the list with
  // each field a copy of a written binding (a ring of such copies costs what `main`'s ring costs, #1078)
  const fields = (k: number, value: string): string =>
    Array.from({ length: k }, (_, i) => `f${i}: ${value}`).join(", ");
  const records = (k: number): string =>
    `let good = {${fields(k, "1")}}\nlet bad = {${fields(k, '"x"')}}\n`;
  const reads = (k: number, read: string): string =>
    Array.from({ length: k }, (_, i) => `say "\${${read}.f${i}}"`).join("\n");
  const copies = (k: number, copy: string): string =>
    Array.from({ length: k }, () => copy).join(", ");
  // the records with each field a copy of a written binding, and the first record but one field of the other's
  const typed = (k: number): string =>
    `${Array.from({ length: k }, (_, i) => `let w${i}: integer = ${i}\nlet s${i}: string = "x"`).join("\n")}\n` +
    `let good = {${Array.from({ length: k }, (_, i) => `f${i}: w${i}`).join(", ")}}\n` +
    `let bad = {${Array.from({ length: k }, (_, i) => `f${i}: s${i}`).join(", ")}}\n` +
    `let other = {${Array.from({ length: k }, (_, i) => (i === 0 ? "f0: s0" : `f${i}: w${i}`)).join(", ")}}\n`;
  // a ring of k whole copies fed the first record, each relay's second store after it closes, then the other record at
  // its first member; and a ring whose steps each pass a chain of `length` copies (r3's axes, #1293)
  const ring = (k: number, second: (i: number) => string): string =>
    `${records(k)}let a0 = good\n` +
    `${Array.from({ length: k - 1 }, (_, i) => `let a${i + 1} = a${i}`).join("\n")}\na0 = a${k - 1}\n` +
    `${Array.from({ length: k - 1 }, (_, i) => second(i + 1)).join("\n")}\na0 = bad\nexit`;
  const chained = (k: number, length: number): string =>
    `${records(k)}let a0 = good\n` +
    Array.from({ length: k - 1 }, (_, i) =>
      Array.from({ length }, (_, step) =>
        step === length - 1
          ? `let a${i + 1} = ${step === 0 ? `a${i}` : `c${i}_${step - 1}`}`
          : `let c${i}_${step} = ${step === 0 ? `a${i}` : `c${i}_${step - 1}`}`,
      ).join("\n"),
    ).join("\n") +
    `\na0 = a${k - 1}\na0 = bad\nexit`;
  const shapes: readonly (readonly [string, (k: number) => string])[] = [
    [
      "elements",
      (k) =>
        `${records(k)}let xs = [${copies(k, "good")}]\nxs.add(bad)\n${reads(k, "xs[0]")}\nexit`,
    ],
    [
      "stores",
      (k) =>
        `${records(k)}let c = good\n${Array.from({ length: k }, () => "c = good").join("\n")}\nc = bad\n` +
        `${reads(k, "c")}\nexit`,
    ],
    [
      "wrapped stores",
      (k) =>
        `${records(k)}let c = {box: {inner: good}}\n` +
        `${Array.from({ length: k }, () => "c = {box: {inner: good}}").join("\n")}\n` +
        `c = {box: {inner: bad}}\n${reads(k, "c.box.inner")}\nexit`,
    ],
    [
      "wrapped elements",
      (k) =>
        `${records(k)}let xs = [${copies(k, "{inner: good}")}]\nxs.add({inner: bad})\n` +
        `${reads(k, "xs[0].inner")}\nexit`,
    ],
    [
      "independent property cycles",
      (k) =>
        `let a = {n: 1, ${fields(k, "null")}}\n` +
        `${Array.from({ length: k }, (_, i) => `let b${i} = a.f${i}\na.f${i} = b${i}`).join("\n")}\n` +
        'let bad = {n: "x"}\nlet c = a\nc = bad\nexit',
    ],
    [
      "one object copied by k places, each then receiving its own other copy",
      (k) =>
        `${records(k)}${Array.from({ length: k }, (_, i) => `let o${i} = {f${i}: "x"}\nlet c${i} = good\nc${i} = o${i}`).join("\n")}\nexit`,
    ],
    [
      "places",
      (k) =>
        `${records(k)}let other = {${fields(k, "1").replace("f0: 1", 'f0: "x"')}}\n` +
        `${Array.from({ length: k }, (_, i) => `let c${i} = good\nc${i} = other`).join("\n")}\nexit`,
    ],
    [
      "places, the other first",
      (k) =>
        `${records(k)}let other = {${fields(k, "1").replace("f0: 1", 'f0: "x"')}}\n` +
        `${Array.from({ length: k }, (_, i) => `let c${i} = other\nc${i} = good`).join("\n")}\nexit`,
    ],
    [
      "a list",
      (k) =>
        `${records(k)}let other = {${fields(k, "1").replace("f0: 1", 'f0: "x"')}}\n` +
        `let xs = [${copies(k, "good")}, other]\nexit`,
    ],
    [
      "a list, the other first",
      (k) =>
        `${records(k)}let other = {${fields(k, "1").replace("f0: 1", 'f0: "x"')}}\n` +
        `let xs = [other, ${copies(k, "good")}]\nexit`,
    ],
    [
      "a ring of k copies fed two objects of k other-typed fields",
      (k) =>
        `${records(k)}let a0 = good\n` +
        `${Array.from({ length: k - 1 }, (_, i) => `let a${i + 1} = a${i}`).join("\n")}\n` +
        `a0 = a${k - 1}\na${k - 1} = bad\nexit`,
    ],
    [
      "a ring of k copies fed two objects of k fields of one type",
      (k) =>
        `${records(k)}let a0 = good\n` +
        `${Array.from({ length: k - 1 }, (_, i) => `let a${i + 1} = a${i}`).join("\n")}\n` +
        `a0 = a${k - 1}\na${k - 1} = {${fields(k, "2")}}\nexit`,
    ],
    // rings through chains of two and of three copies, their relays of one store each (r3's axes, #1293)
    ["a fed ring through chains of two copies", (k) => chained(k, 2)],
    ["a fed ring through chains of three copies", (k) => chained(k, 3)],
    [
      "elements of written fields",
      (k) => `${typed(k)}let xs = [${copies(k, "good")}]\nxs.add(bad)\n${reads(k, "xs[0]")}\nexit`,
    ],
    [
      "stores of written fields",
      (k) =>
        `${typed(k)}let c = good\n${Array.from({ length: k }, () => "c = good").join("\n")}\nc = bad\n` +
        `${reads(k, "c")}\nexit`,
    ],
    [
      "places of written fields",
      (k) =>
        `${typed(k)}${Array.from({ length: k }, (_, i) => `let c${i} = good\nc${i} = other`).join("\n")}\nexit`,
    ],
    [
      "places of written fields, the other first",
      (k) =>
        `${typed(k)}${Array.from({ length: k }, (_, i) => `let c${i} = other\nc${i} = good`).join("\n")}\nexit`,
    ],
    ["a list of written fields", (k) => `${typed(k)}let xs = [${copies(k, "good")}, other]\nexit`],
    [
      "a list of written fields, the other first",
      (k) => `${typed(k)}let xs = [other, ${copies(k, "good")}]\nexit`,
    ],
    [
      "property cycles beside self-grafts",
      (k) =>
        `let a = {n: 1, ${fields(k, "null")}, ${fields(k, "null").replaceAll("f", "g")}}\n` +
        `${Array.from({ length: k }, (_, i) => `let b${i} = a.f${i}\na.f${i} = b${i}\na.g${i} = a`).join("\n")}\n` +
        "let c = a\nexit",
    ],
  ];
  const errors = (name: string, k: number): number =>
    name === "independent property cycles" ||
    name === "a list" ||
    name === "a list of written fields"
      ? 1
      : name === "property cycles beside self-grafts" || name.endsWith("of one type")
        ? 0
        : k;
  const steep: string[] = [];
  for (const [name, program] of shapes)
    for (const reversed of [false, true]) {
      const work = (k: number): ReadonlyMap<string, number> & { total: number } => {
        const request = coreRequest([{ path: "main.tease", source: program(k) }]);
        assert.ok(request !== null, name);
        const answers = reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder(
                (list) => [...list].reverse(),
                () => analyseCore(request),
              ),
            )
          : analyseCore(request);
        assert.equal(
          answers.diagnostics.filter((diagnostic) => diagnostic.class === "compile-error").length,
          errors(name, k),
          name,
        );
        return Object.assign(new Map(answers.budget.counts), { total: answers.budget.total });
      };
      // (k stores into one object carry the parent stack's log factor, 2.36 at 64 → 128 before A2 too: those cycles'
      // counters at 128 → 256)
      const from = name.includes("property cycles") ? 128 : 64;
      const small = work(from);
      const large = work(2 * from);
      // per doubling of the source, against `type-core-work.test.ts`'s criteria (2 for linear work): the total, and
      // each counter of at least 200 units
      const scale = (large.get("syntaxNodes") ?? 0) / (small.get("syntaxNodes") ?? 1);
      const doubling = (before: number, after: number): number =>
        (2 * (after / Math.max(1, before))) / scale;
      const label = `${name}${reversed ? " reversed" : ""}`;
      if (doubling(small.total, large.total) > 2.15)
        steep.push(`${label}: ${doubling(small.total, large.total).toFixed(3)}`);
      for (const [counter, after] of large)
        if (
          counter !== "syntaxNodes" &&
          after >= 200 &&
          doubling(small.get(counter) ?? 0, after) > 2.35
        )
          steep.push(`${label} ${counter}: ${doubling(small.get(counter) ?? 0, after).toFixed(3)}`);
    }
  // the fed ring's relays each also taking an empty object (r3's B4) or a conflicting object of one property (r3's axes,
  // #1293): A2's own work, the candidates it lists and its index, grows with the program; what its checks at the ring's
  // members then ask of the value side is `main`'s ring cost (#1078, #1339: the G5 design round), so not the total. The
  // second store of the same object is a known cost too (G5), its record in the witnesses above
  for (const [name, second, count] of [
    ["an empty object", "{}", (k: number) => k],
    ["a conflicting object of one property", '{f0: "x"}', (k: number) => 2 * k - 1],
  ] as const)
    for (const reversed of [false, true]) {
      const counted = (k: number): ReadonlyMap<string, number> => {
        const request = coreRequest([
          { path: "main.tease", source: ring(k, (i) => `a${i} = ${second}`) },
        ]);
        assert.ok(request !== null, name);
        const answers = reversed
          ? withSolverSeam({ reverseWorklist: true }, () =>
              withConsumerOrder(
                (list) => [...list].reverse(),
                () => analyseCore(request),
              ),
            )
          : analyseCore(request);
        assert.equal(
          answers.diagnostics.filter((diagnostic) => diagnostic.class === "compile-error").length,
          count(k),
          name,
        );
        return answers.budget.counts;
      };
      const [small, large] = [counted(16), counted(32)];
      const scale = (large.get("syntaxNodes") ?? 0) / (small.get("syntaxNodes") ?? 1);
      for (const counter of ["eligibility", "indexSteps"]) {
        const doubling =
          (2 * ((large.get(counter) ?? 0) / Math.max(1, small.get(counter) ?? 0))) / scale;
        if (doubling > 2.35)
          steep.push(
            `relays with ${name}${reversed ? " reversed" : ""} ${counter}: ${doubling.toFixed(3)}`,
          );
      }
    }
  assert.deepEqual(steep, []);
});

test("a mixed literal's conflicts are found once, under however many wrappers (A2)", () => {
  // k wrappers around a list of k copies (or k lists of two copies): one conflicting copy against k, at one size, so the
  // deep literal's own checks cancel and the difference is the conflicts' own work
  const source = (k: number, siblings: boolean, many: boolean): string => {
    const values = Array.from({ length: k }, (_, i) =>
      siblings ? (many || i === 0 ? "[a, b]" : "[a, a]") : many || i === 0 ? "b" : "a",
    ).join(", ");
    const list = siblings ? `[${values}]` : `[a, ${values}]`;
    return (
      `let a = {n: 1}\nlet b = {n: "bad"}\nlet xs = ${"{inner: ".repeat(k)}${list}${"}".repeat(k)}\n` +
      `say xs${".inner".repeat(k)}${siblings ? "[0][0]" : "[0]"}.n\nexit`
    );
  };
  for (const siblings of [false, true]) {
    const extra = (k: number): { checks: number; nodes: number } => {
      const counts = [false, true].map((many) => {
        const request = coreRequest([{ path: "main.tease", source: source(k, siblings, many) }]);
        assert.ok(request !== null);
        return analyseCore(request).budget.counts;
      });
      return {
        checks: (counts[1]!.get("checks") ?? 0) - (counts[0]!.get("checks") ?? 0),
        nodes: counts[1]!.get("syntaxNodes") ?? 0,
      };
    };
    const small = extra(32);
    const large = extra(64);
    // the conflicts' checks per doubling of the source, against `type-core-work.test.ts`'s counter criterion
    const doubling = (2 * (large.checks / small.checks)) / (large.nodes / small.nodes);
    assert.ok(doubling <= 2.35, `${siblings ? "siblings" : "copies"}: ${doubling.toFixed(3)}`);
  }
});

test("a written expected type holds a default to its own kinds at every depth, known or possible (C10, the owner's F3)", () => {
  const integer = (call: string): string => `let n: integer = ${call}\nrepeat n {}\nexit`;
  const integers = (call: string): string => `let xs: integer[] = ${call}\nrepeat xs[0] {}\nexit`;
  // per program its outcome and its written-target diagnostics, as class and site
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "a fraction for an integer",
      integer('fromJson("bad", default: 1.5)'),
      "compile-error",
      ["compile-error @42"],
    ],
    ["a whole number for an integer", integer('fromJson("bad", default: 2)'), "valid", []],
    [
      "a fraction loaded for an integer",
      integer('load("k", default: 1.5)'),
      "compile-error",
      ["compile-error @36"],
    ],
    ["a whole number loaded for an integer", integer('load("k", default: 2)'), "valid", []],
    [
      "a possible fraction for an integer",
      integer('fromJson("bad", default: [1, 2.5][0])'),
      "warning-runtime-check",
      ["warning-runtime-check @42"],
    ],
    [
      "host data for an integer",
      integer('fromJson("bad", default: hostValue)'),
      "warning-runtime-check",
      ["warning-runtime-check @42"],
    ],
    ["a fraction for a number", 'let n: number = fromJson("bad", default: 1.5)\nexit', "valid", []],
    [
      "a whole number for a number",
      'let n: number = fromJson("bad", default: 2)\nexit',
      "valid",
      [],
    ],
    [
      "a fraction for an integer or a text",
      'let n: integer | string = fromJson("1", default: 1.5)\nexit',
      "compile-error",
      ["compile-error @49"],
    ],
    [
      "a text for an integer or a text",
      'let n: integer | string = fromJson("1", default: "x")\nexit',
      "valid",
      [],
    ],
    // below the default, at the element (A8, r4.35)
    [
      "a fraction among integers",
      integers('fromJson("bad", default: [1.5])'),
      "compile-error",
      ["compile-error @46"],
    ],
    ["integers", integers('fromJson("bad", default: [2])'), "valid", []],
    [
      "a fraction loaded among integers",
      integers('load("k", default: [1, 2.5])'),
      "compile-error",
      ["compile-error @43"],
    ],
    [
      "a nested fraction",
      'let xs: integer[][] = fromJson("[]", default: [[1], [2.5]])\nexit',
      "compile-error",
      ["compile-error @53"],
    ],
    [
      "a possible list of fractions",
      integers('fromJson("[]", default: [[1], [2.5]][0])'),
      "warning-runtime-check",
      ["warning-runtime-check @44"],
    ],
    // an inferred default keeps the family: a fraction beside whole numbers
    [
      "a fraction beside inferred whole numbers",
      "let xs = [1]\nlet y = xs.get(0, default: 1.5)\nexit",
      "valid",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const found = record.diagnostics
        .filter((diagnostic) => diagnostic.kind === "written-target")
        .map((diagnostic) => `${diagnostic.class} @${diagnostic.site.offset}`)
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(found) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${found.join(", ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a value an operation carries of a named collection brings its element types to a literal (A8, F10, round 10 B2)", () => {
  const after = '\nsay "AFTER"\nexit';
  const lists = 'let a = [1]\nlet b = ["bad"]\n';
  // per program its outcome and its errors' sites: the second element, whose source holds text
  const programs: readonly (readonly [string, string, string, readonly number[]])[] = [
    ["take", `${lists}let xs = [a.take(1), b.take(1)]${after}`, "compile-error", [49]],
    ["takeLast", `${lists}let xs = [a.takeLast(1), b.takeLast(1)]${after}`, "compile-error", [53]],
    [
      "toList",
      `let a = set[1]\nlet b = set["bad"]\nlet xs = [a.toList(), b.toList()]${after}`,
      "compile-error",
      [56],
    ],
    ["toSet", `${lists}let xs = [a.toSet(), b.toSet()]${after}`, "compile-error", [49]],
    ["otherwise", `${lists}let xs = [a, b otherwise b]${after}`, "compile-error", [41]],
    [
      "a dict's values",
      `let a = dict{q: [1]}\nlet b = dict{q: ["bad"]}\nlet xs = [a.values[0], b.values[0]]${after}`,
      "compile-error",
      [69],
    ],
    // whole numbers with numbers; a dict's keys are text
    [
      "take of whole numbers and numbers",
      `let a = [1]\nlet b = [2.5]\nlet xs = [a.take(1), b.take(1)]${after}`,
      "valid",
      [],
    ],
    [
      "a dict's keys",
      `let a = dict{q: 1}\nlet b = dict{r: 2}\nlet xs = [a.keys, b.keys]${after}`,
      "valid",
      [],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, sites] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const errors = record.diagnostics
        .filter((diagnostic) => diagnostic.class === "compile-error")
        .map((diagnostic) => diagnostic.site.offset)
        .sort((x, y) => x - y);
      if (record.outcome !== outcome || JSON.stringify(errors) !== JSON.stringify(sites))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome} @${errors.join(", @")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("named external data in a literal is warned and checked at its store where a type is decided, read or not (round 10 B1)", () => {
  const after = '\nsay "AFTER"\nexit';
  // per program its outcome and its copy checks, as target, kinds, boundary (B) and site: C1's at the named value
  // against the literal's decided elements, and the boundary of the store that brought the data in, against its own
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "a named host value",
      `let a = hostValue\nlet xs = [1, a]${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @27"],
    ],
    [
      "a named host value first",
      `let a = hostValue\nlet xs = [a, 1]${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @27"],
    ],
    [
      "a copy of a copy",
      `let a = hostValue\nlet c = a\nlet xs = [1, c]${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @37"],
    ],
    [
      "a set",
      `let a = hostValue\nlet xs = set[1, a]${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @27"],
    ],
    [
      "a dict",
      `let a = hostValue\nlet xs = dict{p: 1, q: a}${after}`,
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.entry [integer] @27"],
    ],
    [
      "a returned host value",
      `function g {\n  return hostValue\n}\nlet xs = [1, g()]${after}`,
      "warning-runtime-check",
      ["g.result [unknown] B @22", "xs.element [integer] @43"],
    ],
    [
      "a named list of host data",
      `let a = [hostValue]\nlet xs = [a, [1]]${after}`,
      "warning-runtime-check",
      ["a.element [unknown] B @9", "xs.element.element [integer] @29"],
    ],
    // where nothing is decided, nothing is checked until a consumer asks
    [
      "named host values alone",
      `let a = hostValue\nlet b = hostValue\nlet xs = [a, b]${after}`,
      "valid",
      [],
    ],
    ["a record's named host field", `let a = hostValue\nlet r = {n: 1, m: a}${after}`, "valid", []],
    ["a named whole number", `let a = 2\nlet xs = [1, a]${after}`, "valid", []],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome, expected] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const copies = record.checks
        .filter((check) => check.kind === "copy-type")
        .map(
          (check) =>
            `${check.target} [${check.against.join(", ")}]${check.boundary ? " B" : ""} @${check.site.offset}`,
        )
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(copies) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${copies.join("; ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a literal's verdicts are shared only where its named elements hold the same values, in both orders (round 11 B1)", () => {
  // per program its errors' sites: the second literal, after the named value became text, at both its elements (A8
  // against its text, C1 against the whole numbers the first literal decided)
  const programs: readonly (readonly [string, string, readonly number[]])[] = [
    [
      "stores",
      'let a = hostValue\nlet xs = []\nxs = [a, 1]\na = "bad"\nxs = [a, 1]\nexit',
      [58, 61],
    ],
    [
      "adds",
      'let a = hostValue\nlet xs = []\nxs.add([a, 1])\na = "bad"\nxs.add([a, 1])\nexit',
      [62, 66],
    ],
    [
      "addAll",
      'let a = hostValue\nlet xs = []\nxs.addAll([[a, 1]])\na = "bad"\nxs.addAll([[a, 1]])\nexit',
      [70, 75],
    ],
    [
      "text first",
      'let a = "bad"\nlet xs = []\nxs = [a, 1]\na = hostValue\nxs = [a, 1]\nexit',
      [35],
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, sites] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    const errors = forward.diagnostics
      .filter((diagnostic) => diagnostic.class === "compile-error")
      .map((diagnostic) => diagnostic.site.offset)
      .sort((x, y) => x - y);
    if (JSON.stringify(errors) !== JSON.stringify(sites))
      differing.push(`${name}: @${errors.join(", @")}`);
    if (recordDifferences(forward, reversed).length > 0)
      differing.push(`${name} reversed: ${recordDifferences(forward, reversed).join("; ")}`);
  }
  assert.deepEqual(differing, []);
});

/**
 * The value carriers (round 11; the walk of `answers.ts` `#propertyNames`): each carrier over a direct, a named, a
 * computed and a projected list, in a literal beside the same carrier over another list (A8), stored before and after
 * its source changes (A2), and carrying host data with no consumer (C1, C9); in both orders. A carrier that gives
 * possible elements (a removal, a choice's answer) decides nothing (A2), yet its elements are published with the
 * literal's whole numbers, so named host data it carries owes its check, a choice's as a removal's (A7, A8, TABLE r4.67
 * (1): the round's `valid` for the choice was an artifact of a source dropped past the longest key); a load or a parse
 * typed by its default alone validates the loaded value by the default's own kinds, so host data the default holds
 * leaves the elements' kind open, C1's beside the call's boundary (TABLE r4.66 (3)).
 */
/*
 * The regressions of review rounds 11 to 17, Astra's and the external reviewer's below assert the answers layer: their
 * programs need constructs outside the candidate slice (functions, `get`, `otherwise`, the copy methods, written unions,
 * records), so their plan content and their runs wait for S7–S9b to widen the slice (TABLE r4.59); those inside it
 * prove plan and run in `type-core-candidate.test.ts` (the projections of a literal, the endpoint matrix, the cell
 * sample).
 */
test("a value any carrier gives brings its elements' types, decided and checked as a literal's, a choice's published as a removal's, in both orders (round 11, TABLE r4.67 (1))", () => {
  const carriers: readonly (readonly [string, (value: string) => string])[] = [
    ["projection", (value) => `[${value}][0]`],
    ["otherwise", (value) => `${value} otherwise ${value}`],
    ["get with its default", (value) => `[].get(0, default: ${value})`],
    ["load's default", (value) => `load("k", default: ${value})`],
    ["a parse's default", (value) => `fromJson("[]", default: ${value})`],
    ["take", (value) => `${value}.take(1)`],
    ["takeLast", (value) => `${value}.takeLast(1)`],
    ["toList", (value) => `${value}.toList()`],
    ["toSet", (value) => `${value}.toSet()`],
    ["removeFirst", (value) => `[${value}].removeFirst()`],
    ["+", (value) => `${value} + []`],
    ["a choice", (value) => `askChoice [{text: "A", value: ${value}}]`],
  ];
  const possible = new Set(["removeFirst", "a choice"]);
  // a list (a set for `toList`) of one element, and how the matrix's kinds of value hold it
  const list = (carrier: string, element: string): string =>
    carrier === "toList" ? `set[${element}]` : `[${element}]`;
  const kinds: readonly (readonly [
    string,
    (name: string, literal: string) => readonly [string, string],
  ])[] = [
    ["direct", (_, literal) => ["", literal]],
    ["named", (name, literal) => [`let ${name} = ${literal}\n`, name]],
    ["computed", (name, literal) => [`function ${name} {\n  return ${literal}\n}\n`, `${name}()`]],
    ["projected", (name, literal) => [`let ${name} = {items: ${literal}}\n`, `${name}.items`]],
  ];
  const differing: string[] = [];
  const analysed = (name: string, source: string): CompactRecord => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (items) => [...items].reverse(),
        () => compactAnalysis(request),
      ),
    );
    for (const difference of recordDifferences(forward, reversed))
      differing.push(`${name} reversed: ${difference}`);
    return forward;
  };
  const errors = (record: CompactRecord): number[] =>
    record.diagnostics
      .filter((diagnostic) => diagnostic.class === "compile-error")
      .map((diagnostic) => diagnostic.site.offset);
  for (const [carrier, carry] of carriers) {
    // A8: the second element's text is the error inside it, where the carrier's elements are definite
    for (const [kind, hold] of kinds) {
      const [goodSetup, good] = hold("g", list(carrier, "1"));
      const [badSetup, bad] = hold("b", list(carrier, '"bad"'));
      const source = `${goodSetup}${badSetup}let xs = [${carry(good)}, ${carry(bad)}]\nsay "AFTER"\nexit`;
      const name = `${carrier}, ${kind}`;
      const record = analysed(name, source);
      const second = source.indexOf(carry(bad), source.indexOf("let xs"));
      const found = errors(record);
      if (
        possible.has(carrier)
          ? record.outcome !== "valid"
          : found.length !== 1 || found[0]! < second || found[0]! >= second + carry(bad).length
      )
        differing.push(`${name}: ${record.outcome} @${found.join(", @")}`);
    }
    // A2, A6: a named value stored before and after a change of it: the change of the decided list is the error at its
    // text, rejected, so the second store holds whole numbers as the first does
    const one = list(carrier, "1");
    const changed = `let a = ${one}\nlet xs = []\nxs = [${carry("a")}, ${carry(one)}]\na = ${list(carrier, '"bad"')}\nxs = [${carry("a")}, ${carry(one)}]\nexit`;
    const record = analysed(`${carrier}, changed`, changed);
    if (JSON.stringify(errors(record)) !== JSON.stringify([changed.indexOf('"bad"')]))
      differing.push(`${carrier}, changed: ${record.outcome} @${errors(record).join(", @")}`);
    // the same, the named list host data first and text after: one record in both orders (round 11 B1's sharing)
    analysed(
      `${carrier}, changed from host data`,
      changed.replace(`let a = ${one}`, `let a = ${list(carrier, "hostValue")}`),
    );
    // C1, C9: host data the carrier brings into the decided elements, with no consumer
    const host = `let a = ${list(carrier, "hostValue")}\nlet xs = [${carry(one)}, ${carry("a")}]\nsay "AFTER"\nexit`;
    const carried = analysed(`${carrier}, host data`, host);
    const warned = carried.diagnostics.some(
      (diagnostic) =>
        diagnostic.kind === "written-target" && diagnostic.class === "warning-runtime-check",
    );
    // (a removal's or a choice's possible element decides nothing, F7, yet the elements are published with the
    // literal's whole numbers, so the named host data owes its check: C9 r4.12, r4.50 (1), TABLE r4.67 (1))
    if (carried.outcome !== "warning-runtime-check" || !warned)
      differing.push(`${carrier}, host data: ${carried.outcome}`);
  }
  assert.deepEqual(differing, []);
});

test("a literal's elements are compared at each store with their own certainty, guarded or not, in both orders (round 12 B1)", () => {
  const carriers: readonly (readonly [string, (value: string) => string])[] = [
    ["direct", (value) => value],
    ["take", (value) => `${value}.take(1)`],
    ["get with its default", (value) => `[].get(0, default: ${value})`],
    ["otherwise", (value) => `${value} otherwise ${value}`],
    ["projection", (value) => `[${value}][0]`],
    ["+", (value) => `${value} + []`],
  ];
  const differing: string[] = [];
  for (const [name, carry] of carriers) {
    const store = `xs = [${carry("a")}, ${carry('["bad"]')}]`;
    for (const [order, source] of [
      ["guarded first", `let a = [1]\nlet xs = []\nif a is list { ${store} }\n${store}\nexit`],
      ["unguarded first", `let a = [1]\nlet xs = []\n${store}\nif a is list { ${store} }\nexit`],
    ] as const) {
      const request = coreRequest([{ path: "main.tease", source }]);
      assert.ok(request !== null, `${name}, ${order}: its source parses and resolves`);
      const forward = compactAnalysis(request);
      const reversed = withSolverSeam({ reverseWorklist: true }, () =>
        withConsumerOrder(
          (list) => [...list].reverse(),
          () => compactAnalysis(request),
        ),
      );
      for (const difference of recordDifferences(forward, reversed))
        differing.push(`${name}, ${order}, reversed: ${difference}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("a literal's own elements decide through the operations that carry it, under their certainty (round 12 B2)", () => {
  const after = '\nsay "AFTER"\nexit';
  // per program its outcome and its copy checks: C1's at the named host value against the literal's whole numbers,
  // beside the boundary of the store that brought it in; a removal's possible element decides nothing (F7)
  const checked = ["a [unknown] B @8", "xs.element [integer] @27"];
  const programs: readonly (readonly [string, string, string, readonly string[]])[] = [
    [
      "get with its default",
      "let xs = [].get(0, default: [1, a])",
      "warning-runtime-check",
      checked,
    ],
    ["takeLast", "let xs = [1, a].takeLast(1)", "warning-runtime-check", checked],
    ["toSet", "let xs = [1, a].toSet()", "warning-runtime-check", checked],
    // (a list's `+` combines: the named read that brought the kind is C1's site, TABLE r4.63 (2))
    [
      "+",
      "let xs = [1, a] + []",
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @31"],
    ],
    // (a removal's possible element decides nothing, F7, but the place is published with the literal's whole numbers,
    // so the named host value owes its check there: C9 r4.12, r4.50 (1))
    [
      "removeFirst",
      "let xs = [[1, a]].removeFirst()",
      "warning-runtime-check",
      ["a [unknown] B @8", "xs.element [integer] @32"],
    ],
  ];
  const differing: string[] = [];
  for (const [name, store, outcome, expected] of programs) {
    const source = `let a = hostValue\n${store}${after}`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const copies = record.checks
        .filter((check) => check.kind === "copy-type")
        .map(
          (check) =>
            `${check.target} [${check.against.join(", ")}]${check.boundary ? " B" : ""} @${check.site.offset}`,
        )
        .sort();
      if (
        record.outcome !== outcome ||
        JSON.stringify(copies) !== JSON.stringify([...expected].sort())
      )
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}; ${copies.join("; ")}`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a written type an operation carries decides only where the operation's value holds it (A4, round 13 B1)", () => {
  // the receiver's element is selected, the written default never: the later text decides, the host value is checked
  // against it, nothing is an error
  const programs: readonly (readonly [string, string])[] = [
    [
      "a written list as a dead default",
      "let typed: integer[] = [1]\nlet xs = [[hostValue]].get(0, default: typed)",
    ],
    [
      "a written whole number in a dead default",
      "let typed: integer = 1\nlet xs = [[hostValue]].get(0, default: [typed])",
    ],
    [
      "a written list as a dead fallback",
      "let typed: integer[] = [1]\nlet xs = [hostValue] otherwise typed",
    ],
  ];
  const differing: string[] = [];
  for (const [name, store] of programs) {
    const source = `${store}\nxs.add("bad")\nexit`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      if (record.outcome !== "warning-runtime-check")
        differing.push(`${name}${reversed ? " reversed" : ""}: ${record.outcome}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("a written copy decides through operations only where its read runs, with its whole written type (A4, round 14)", () => {
  // per program its outcome: a dead written operand under an outer carrier decides nothing (the numbers widen, the host
  // value is checked); a selected copy of a written union keeps the union, which the later text fits
  const programs: readonly (readonly [string, string, string])[] = [
    [
      "a dead fallback under a get",
      "let typed: integer[] = [1]\nlet xs = [[hostValue] otherwise typed, [1]].get(0, default: [])\nxs.add(2.5)\nexit",
      "warning-runtime-check",
    ],
    [
      "a dead default under a get",
      "let typed: integer[] = [1]\nlet xs = [[[hostValue]].get(0, default: typed), [1]].get(0, default: [])\nxs.add(2.5)\nexit",
      "warning-runtime-check",
    ],
    [
      "a selected written union",
      'let typed: (integer | string)[] = [1]\nlet xs = [typed].get(0, default: [])\nxs.add("good")\nexit',
      "valid",
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      if (record.outcome !== outcome || (outcome === "valid" && record.checks.length > 0))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}, ${record.checks.length} checks`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a written copy carried through a projection or an operation keeps its written type where it is selected (A4, round 15)", () => {
  // per program its outcome: a selected written copy decides by its written type (strict integer, a union admitting
  // text), an evaluated but unselected one decides nothing
  const programs: readonly (readonly [string, string, string])[] = [
    [
      "an unselected receiver element",
      'let typed: integer[] = [1]\nlet xs = [typed].get(2, default: [])\nxs.add("good")\nexit',
      "valid",
    ],
    [
      "a selected union through otherwise",
      'let typed: (integer | string)[] = [1]\nlet xs = typed otherwise []\nxs.add("good")\nexit',
      "valid",
    ],
    [
      "a selected union through a projection",
      'let typed: (integer | string)[] = [1]\nlet xs = (null otherwise {v: typed}).v\nxs.add("good")\nexit',
      "valid",
    ],
    [
      "a projected written integer list",
      "let typed: integer[] = [1]\nlet xs = [typed][0]\nxs = [2.5]\nexit",
      "compile-error",
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, outcome] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      if (record.outcome !== outcome || (outcome === "valid" && record.checks.length > 0))
        differing.push(
          `${name}${reversed ? " reversed" : ""}: ${record.outcome}, ${record.checks.length} checks`,
        );
    }
  }
  assert.deepEqual(differing, []);
});

test("a written operand its operation does not give decides nothing, whether its items name writers or not (A4, F17a, F17b, Astra r2 B1)", () => {
  // per shape (a parameter, a captured binding, a record's field, a default's default, an `otherwise` fallback; an add or
  // a whole store) the operation gives the written operand (index 0: the copy decides, the text is the error at "ok") or
  // another one only (index 3: the empty value decides nothing, the text decides)
  const fill = (copy: string, store: string, typed = "typed: integer[]"): string =>
    `function fill(${typed}) {\n  let xs = ${copy}\n  ${store}\n}\nfill([4])\nfill([6])\nexit`;
  const shapes: readonly (readonly [string, (index: number, store: string) => string])[] = [
    ["a parameter", (index, store) => fill(`[typed].get(${index}, default: [])`, store)],
    [
      "a captured binding",
      (index, store) =>
        `let typed: integer[] = [4]\nfunction fill {\n  let xs = [typed].get(${index}, default: [])\n  ${store}\n}\nfill()\nexit`,
    ],
    [
      "a record's field",
      (index, store) => fill(`[{data: typed}].get(${index}, default: {data: []}).data`, store),
    ],
    [
      "a default's default",
      (index, store) => fill(`[].get(0, default: [typed].get(${index}, default: []))`, store),
    ],
    // (`otherwise` gives its fallback where its own operand may be null: `[null][0]`, never beside `[[]][0]`; and its own
    // operand where that may be a value: a written list, never a null one)
    [
      "an `otherwise` fallback",
      (index, store) => fill(`${index === 0 ? "[null][0]" : "[[]][0]"} otherwise typed`, store),
    ],
    [
      "an `otherwise` operand",
      (index, store) =>
        `let typed: integer[]? = ${index === 0 ? "[1]" : "null"}\nlet xs = typed otherwise []\n${store}\nexit`,
    ],
    [
      "an `otherwise` operand's projection",
      (index, store) =>
        `let typed: integer[]? = ${index === 0 ? "[1]" : "null"}\nlet xs = [typed][0] otherwise []\n${store}\nexit`,
    ],
  ];
  const programs: (readonly [string, string, boolean])[] = [];
  for (const [name, shape] of shapes)
    for (const [how, store] of [
      ["an add", 'xs.add("ok")'],
      ["a whole store", 'xs = ["ok"]'],
    ] as const) {
      programs.push([`${name}, selected, ${how}`, shape(0, store), true]);
      programs.push([`${name}, not selected, ${how}`, shape(3, store), false]);
    }
  programs.push([
    "an unwritten parameter, not selected",
    fill("[typed].get(3, default: [])", 'xs.add("ok")', "typed"),
    false,
  ]);
  const differing: string[] = [];
  for (const [name, source, error] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = error ? [`compile-error@${source.indexOf('"ok"')}`] : [];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // (the errors only: an `otherwise` keeps its fallback's kinds as possible where it never takes it, F17a, so the
      // later text may warn at the initializer)
      const got = record.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => `${d.class}@${d.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("a projection of a written binding keeps its written type at the projected path, through the carriers that select it (A4, F12, Astra r2 B2)", () => {
  // per expression over a written `integer[][]` (a fraction then the error) and `(integer | string)[][]` (text then
  // fits): a direct projection, a carrier's selected receiver or default, a copy of the elements, a removal; a nested
  // `.first` on a copy of the elements may still warn that it is empty (C6), never err
  const expressions = [
    "typed[0]",
    "typed.first",
    "[typed][0][0]",
    "[typed].get(0, default: [])[0]",
    "[typed].get(0, default: []).first",
    "[].get(0, default: typed)[0]",
    "[typed].take(1)[0][0]",
    "[typed].take(1).first.first",
    "[typed].removeAt(0)[0]",
    "(typed otherwise [])[0]",
  ];
  const programs: (readonly [string, string, boolean])[] = [];
  for (const expression of expressions) {
    programs.push([
      `${expression}, integer`,
      `let typed: integer[][] = [[1]]\nlet xs = ${expression}\nxs = [2.5]\nexit`,
      true,
    ]);
    programs.push([
      `${expression}, union`,
      `let typed: (integer | string)[][] = [[1]]\nlet xs = ${expression}\nxs = ["later"]\nexit`,
      false,
    ]);
  }
  programs.push([
    "an element of a written list",
    "let typed: integer[] = [1]\nlet n = typed[0]\nn = 2.5\nexit",
    true,
  ]);
  const differing: string[] = [];
  for (const [name, source, error] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = error ? [`compile-error@${source.lastIndexOf("2.5")}`] : [];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = record.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => `${d.class}@${d.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("literals of typed ingresses share their conflict paths only by the type their defaults give (A8, F18, Astra r2 D-W1)", () => {
  // a literal of one default's ingresses beside one of two defaults: the second still errs at the ingress of the other
  // default, as alone; a `load` beside a parse of one default, two classes of one kind, offends nowhere
  const seeds = 'let seed = {n: 1}\nlet other = {n: "x"}\nlet xs = []\n';
  const programs: readonly (readonly [string, string, string | null])[] = [
    [
      "loads, shared then mixed",
      `${seeds}xs.add([load("a", default: seed), load("b", default: seed)])\nxs.add([load("c", default: seed), load("d", default: other)])\nrepeat xs[0][0].n {}\nexit`,
      'load("d"',
    ],
    [
      "loads, mixed alone",
      `${seeds}xs.add([load("c", default: seed), load("d", default: other)])\nrepeat xs[0][0].n {}\nexit`,
      'load("d"',
    ],
    [
      "parses, shared then mixed",
      `${seeds}xs.add([fromJson("{}", default: seed), fromJson("{}", default: seed)])\nxs.add([fromJson("{}", default: seed), fromJson("{}", default: other)])\nrepeat xs[0][0].n {}\nexit`,
      'fromJson("{}", default: other)',
    ],
    [
      "a load beside a parse of one default",
      `${seeds}xs.add([load("a", default: seed), fromJson("{}", default: seed)])\nxs.add([load("c", default: seed), load("d", default: seed)])\nrepeat xs[0][0].n {}\nexit`,
      null,
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, offending] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = offending === null ? [] : [`compile-error@${source.indexOf(offending)}`];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = record.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => `${d.class}@${d.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("a written copy a carrier surely gives decides at the path's end too, an unselected one nowhere (A4, F17a, F17b, Codex r16 B1)", () => {
  // per expression over a written `integer` (a fraction then the error) and `integer | string` (text then fits): a
  // singleton literal's element or field, `otherwise` beside a never-null or an only-null operand, a `get` whose literal
  // proof gives its receiver or its default; and the operands those operations do not give, where the fraction fits
  const seed = "let seed = 1\nlet direct = seed\n";
  const programs: (readonly [string, string, boolean])[] = [];
  for (const expression of [
    "[typed][0]",
    "{n: typed}.n",
    "typed otherwise 0",
    "null otherwise typed",
    "[typed].get(0, default: 0)",
    "[].get(0, default: typed)",
  ]) {
    programs.push([
      `${expression}, integer`,
      `let typed: integer = 1\nlet xs = ${expression}\nxs = 2.5\nexit`,
      true,
    ]);
    programs.push([
      `${expression}, union`,
      `let typed: integer | string = 1\nlet xs = ${expression}\nxs = "ok"\nexit`,
      false,
    ]);
  }
  for (const expression of [
    "direct otherwise typed",
    "[direct].get(0, default: typed)",
    "[typed].get(4, default: direct)",
  ])
    programs.push([
      `${expression}, not given`,
      `${seed}let typed: integer = seed\nlet xs = ${expression}\nxs = 2.5\nexit`,
      false,
    ]);
  const differing: string[] = [];
  for (const [name, source, error] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = error ? [`compile-error@${source.lastIndexOf("2.5")}`] : [];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = record.diagnostics
        .filter((d) => d.class === "compile-error")
        .map((d) => `${d.class}@${d.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("an operation the receiver's or the key's decision leaves opaque or external carries no written type (F19a, F19, A4, Astra r3 B1)", () => {
  // per shape a projection, a `get` or a method of a receiver that may be a reference (the runtime's member, F19a), or
  // a `load` of a computed key (external data, F19): their typed operands give the value no written domain, so the
  // fraction or the text after them warns with its checks and never errs; the ordinary controls (a literal key, a
  // receiver that is no reference) keep their written copy's error
  const programs: readonly (readonly [string, string, boolean])[] = [
    [
      "a computed key's load",
      'let typed: integer[] = [1]\nlet key = "k"\nlet xs = load(key, default: typed)\nxs = [2.5]',
      false,
    ],
    [
      "a literal key's load",
      'let typed: integer[] = [1]\nlet xs = load("k", default: typed)\nxs = [2.5]',
      true,
    ],
    ["an index", "let typed: integer[][] | speaker = [[1]]\nlet xs = typed[0]\nxs = [2.5]", false],
    [
      "a first",
      "let typed: integer[][] | speaker = [[1]]\nlet xs = typed.first\nxs = [2.5]",
      false,
    ],
    [
      "a dict's values",
      "let typed: (integer[] dict) | speaker = dict{a: [1]}\nlet xs = typed.values[0]\nxs = [2.5]",
      false,
    ],
    [
      "a removal",
      "let typed: integer[][] | speaker = [[1]]\nlet xs = typed.removeAt(0)\nxs = [2.5]",
      false,
    ],
    ["a copy", "let typed: integer[] | speaker = [1]\nlet xs = typed.toList()\nxs = [2.5]", false],
    [
      "a get's receiver",
      "let typed: integer[][] | speaker = [[1]]\nlet xs = typed.get(0, default: [])\nxs = [2.5]",
      false,
    ],
    [
      "a get's default",
      'speaker vera { length: 2 }\nlet typed: integer[] = [1]\nlet pool: dict = dict{a: [[1]], b: vera}\nlet holder = pool.get("a", default: vera)\nlet xs = holder.get(0, default: typed)\nxs = [2.5]',
      false,
    ],
    ["a take", 'let typed: integer[] | speaker = [1]\nlet xs = typed.take(1)\nxs.add("ok")', false],
    [
      "a speaker's get",
      "speaker vera { length: 2 }\nlet typed: integer[] = [1]\nlet xs = vera.get(0, default: typed)\nxs = [2.5]",
      false,
    ],
    [
      "a speaker's get, inferred",
      'speaker vera { length: 2 }\nlet xs = vera.get(0, default: [1])\nxs = ["ok"]',
      false,
    ],
    [
      "a list's get",
      "let typed: integer[][] = [[1]]\nlet xs = typed.get(0, default: [])\nxs = [2.5]",
      true,
    ],
  ];
  const differing: string[] = [];
  for (const [name, body, error] of programs) {
    const source = `${body}\nexit`;
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const want = error ? [`compile-error@${source.lastIndexOf("2.5")}`] : [];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      // (a written union of a collection and the speaker, the only receiver with a written type that may be a reference
      // and holds a list, is also V30 §13's error, which this test sets aside)
      const got = record.diagnostics
        .filter((d) => d.class === "compile-error" && d.kind !== "written-type")
        .map((d) => `${d.class}@${d.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

test("each store of one value whole owes its obligation once, however many lists group it (§8, A7, Codex r18 B1)", () => {
  // the stores of `root` into `box` are one group (their earliest checked whole for the rest), met through the whole
  // stores of `box` and through its candidates: each owes its warning and check once
  const source =
    'let root = {n: hostValue}\nlet box = {n: 1}\nbox = root\nbox = root\nrepeat box.n {}\nsay "AFTER"\nexit';
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const stores = [source.indexOf("box = root") + "box = ".length, source.lastIndexOf("root")];
  for (const reversed of [false, true]) {
    const run = (): CompactRecord =>
      withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
    const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
    assert.deepEqual(
      {
        checks: record.checks
          .filter((check) => check.kind === "copy-type" && !check.boundary)
          .map((check) => `${check.target} ${check.against.join("|")} @${check.site.offset}`)
          .sort(),
        warnings: record.diagnostics
          .filter((diagnostic) => diagnostic.kind === "written-target")
          .map((diagnostic) => diagnostic.site.offset)
          .sort((a, b) => a - b),
      },
      { checks: stores.map((at) => `box.n integer @${at}`), warnings: stores },
      reversed ? "reversed" : "forward",
    );
  }
});

test("named external data a carrier stores into a place published with a kind owes its check there (C9 r4.12, r4.50 (1), R4-F1)", () => {
  // per carrier outside the candidate's slice (its plan and its run wait for the slice): the warning where the named
  // data is read, with a `copy-type` check against the published kind; a source decided at its own stores (a list whose
  // element `1` decides) keeps its check there only; a member of host data owes C5's obligation on the receiver and,
  // beside it, the destination's own check, where the member is read (F15, r4.60)
  const programs: readonly (readonly [string, string, string | null])[] = [
    ["otherwise", "let raw = hostValue\nlet out = raw otherwise 1\nexit", "raw otherwise"],
    ["get's default", "let raw = hostValue\nlet out = [raw].get(0, default: 1)\nexit", "raw]"],
    ["get's receiver", "let raw = hostValue\nlet out = [1, raw].get(1, default: 1)\nexit", "raw]"],
    ["first", "let raw = hostValue\nlet out = [1, raw].first\nexit", "raw]"],
    [
      "a written element beside",
      "let typed: integer = 1\nlet raw = hostValue\nlet out = [typed, raw][1]\nexit",
      "raw]",
    ],
    ["a decided source", "let raw = hostValue\nlet xs = [1, raw]\nlet out = xs[1]\nexit", null],
    [
      "a member of host data",
      'let parcel = hostValue\nlet out = parcel.get("count", default: 0)\nexit',
      "parcel.get",
    ],
  ];
  const differing: string[] = [];
  for (const [name, source, read] of programs) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const at = read === null ? -1 : source.indexOf(read, source.indexOf("let out"));
    const want = read === null ? [] : [`copy-type out @${at}`];
    for (const reversed of [false, true]) {
      const run = (): CompactRecord =>
        withSolverSeam({ reverseWorklist: reversed }, () => compactAnalysis(request));
      const record = reversed ? withConsumerOrder((list) => [...list].reverse(), run) : run();
      const got = record.checks
        .filter((check) => check.kind === "copy-type" && check.target === "out" && !check.boundary)
        .map((check) => `${check.kind} ${check.target} @${check.site.offset}`);
      if (JSON.stringify(got) !== JSON.stringify(want))
        differing.push(`${name}${reversed ? " reversed" : ""}: ${got.join(" ")}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * S6-CARRIERS §1: the carrier table names each operand's role and its evaluation position among the carrier's
 * operands, and every role of `CARRIER_ROLES` is some row's: a `get`'s receiver 0 and default 2 (its key is 1), an
 * `otherwise`'s operand 0 and fallback 1, a `load`'s and a parse's default 1, a list's `+` and a choice by operand.
 */
test("the carrier table names each operand's role and evaluation position (S6-CARRIERS §1)", () => {
  const source = [
    "let xs = [1, 2]",
    "let d = dict{a: 1}",
    "let o = {f: 1}",
    "let a = xs[0]",
    "let b = o.f",
    "let c = d.values",
    'for item in xs { say "x" }',
    "let e = hostValue otherwise 1",
    "let f = xs.get(0, default: 3)",
    'let g = load("k", default: 4)',
    'let h = fromJson("1", default: 5)',
    "let i = xs.take(1)",
    "let j = xs.removeFirst()",
    "let k = xs + [3] + [4]",
    'let l = askChoice 1, [2], {text: "t", value: 3}',
    "exit",
  ].join("\n");
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const program = new CoreProgram(request);
  program.index();
  const rows = new Set<string>();
  for (const value of [...program.projOf.keys(), ...program.opOf.keys()])
    for (const { kind, role, position } of operandsOf(program, value)) {
      assert.ok(role.startsWith(`${kind}/`), `${role} is a ${kind}'s`);
      rows.add(`${role} ${position}`);
    }
  assert.deepEqual(
    new Set([...rows].map((row) => row.slice(0, row.lastIndexOf(" ")))),
    new Set(CARRIER_ROLES),
  );
  for (const row of [
    "get/receiver 0",
    "get/default 2",
    "otherwise/operand 0",
    "otherwise/fallback 1",
    "load default/default 1",
    "parse default/default 1",
    "concatenation/operand 0",
    "concatenation/operand 1",
    "choice/option value 0",
    "choice/option element value 1",
    "choice/option text 2",
  ])
    assert.ok(rows.has(row), row);
});

/**
 * S6-CARRIERS §2 (the design review's D1): stops are ordered by evaluation key, not by the walk's traversal, so in a
 * list of choice objects the first element's selected text precedes the second element's selected value, whichever
 * row reaches each, in both element orders. Each program's whole record, in both orders.
 */
test("a choice list's earliest evaluated ingress names C1's site, in both element orders (S6-CARRIERS §2, D1)", () => {
  for (const [source, start] of [
    [
      'let out = askChoice [{text: hostValue}, {text: "two", value: hostValue}]\nout = "x"\nexit\n',
      28,
    ],
    [
      'let out = askChoice [{text: "two", value: hostValue}, {text: hostValue}]\nout = "x"\nexit\n',
      42,
    ],
  ] as const) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const site = { file: "main.tease", offset: start, end: start + "hostValue".length };
    const expected: CompactRecord = {
      outcome: "warning-runtime-check",
      diagnostics: [
        { kind: "written-target", class: "warning-runtime-check", site, context: null },
      ],
      checks: [
        { kind: "copy-type", target: "out", against: ["string"], boundary: false, site },
        { kind: "copy-type", target: "out", against: ["string"], boundary: true, site },
      ],
    };
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});

/**
 * S6-CARRIERS §3.1 (the first design review's B3): an identity holding an ingress occurrence is fresh, so two equal
 * computations over host data stay two contract entries and each keeps its leaf: a consumer that meets either
 * payload brings each store's boundary, at each host value. The whole record, in both orders.
 */
test("two equal computations over host data keep each ingress's boundary (S6-CARRIERS §3.1, design B3)", () => {
  const source =
    'let flagHost = askBoolean "flag"\nlet box = {payload: hostValue otherwise null}\n' +
    "if flagHost { box = {payload: hostValue otherwise null} }\nlet count: integer = box.payload\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const at = (offset: number, end: number) => ({ file: "main.tease", offset, end });
  const expected: CompactRecord = {
    outcome: "warning-runtime-check",
    diagnostics: [
      { kind: "written-target", class: "warning-runtime-check", site: at(158, 169), context: null },
      { kind: "written-target", class: "warning-runtime-check", site: at(158, 169), context: null },
    ],
    checks: [
      {
        kind: "copy-type",
        target: "count",
        against: ["integer"],
        boundary: false,
        site: at(158, 169),
      },
      {
        kind: "null-check",
        target: "count",
        against: ["integer"],
        boundary: false,
        site: at(158, 169),
      },
      { kind: "copy-type", target: "box", against: ["object"], boundary: true, site: at(53, 62) },
      { kind: "copy-type", target: "box", against: ["object"], boundary: true, site: at(109, 118) },
    ],
  };
  const forward = compactAnalysis(request);
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => compactAnalysis(request),
    ),
  );
  assert.deepEqual(recordDifferences(expected, forward), []);
  assert.deepEqual(recordDifferences(expected, reversed), []);
});

/**
 * S6-CARRIERS §4.6 with §3.2 (Codex r20 B1): literals grouped by the structure they hold at a path share an answer only
 * where their reads are marked alike. A read under a test of its path, or of a path below it, inside a computed child (a
 * `get`, a projection of a literal, an index, an `otherwise`) keeps its mark, so the definite fraction a guarded copy
 * also holds is the warning with its check, never the error. The whole record, in both orders.
 */
test("a guarded read inside a computed child keeps its mark where literals share a level (§4.6, §3.2, Codex r20 B1)", () => {
  const branch = (kind: CompactDiagnostic["kind"], site: CompactSite): CompactDiagnostic => ({
    kind,
    class: "warning-runtime-check",
    site,
    context: "branch",
  });
  const check = (
    kind: CompactCheck["kind"],
    target: string,
    against: string,
    site: CompactSite,
  ): CompactCheck => ({ kind, target, against: [against], boundary: false, site });
  const cases: readonly { readonly data: string; readonly guard: string; readonly own?: true }[] = [
    { data: "[root].get(0, default: root)", guard: "root != null" },
    { data: "({inner: root}).inner", guard: "root != null" },
    { data: "[root][0]", guard: "root != null" },
    { data: "(root otherwise null)", guard: "root.n is integer", own: true },
  ];
  for (const { data, guard, own } of cases) {
    const source =
      `let root = {n: 2.0}\nlet box = {noise: 0, data: ${data}}\n` +
      `if ${guard} { box = {noise: 1.5, data: ${data}} }\nrepeat box.data.n {}\nexit\n`;
    const read = source.indexOf("box.data.n");
    const at = (end: number): CompactSite => ({ file: "main.tease", offset: read, end });
    // (an `otherwise` may give its fallback, `null`: the member read's own check before the integer's)
    const expected: CompactRecord = {
      outcome: "warning-runtime-check",
      diagnostics: [
        ...(own ? [branch("member-read", at(read + 10))] : []),
        branch("integer-use", at(read + 10)),
      ],
      checks: [
        ...(own ? [check("null-check", "box.data", "non-null", at(read + 10))] : []),
        check("integer-check", "box.data.n", "integer", at(read + 10)),
      ],
    };
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});

/**
 * S6-CARRIERS §3.3, §3.4 (Codex r20 B6, N1, N2), from the landing index: a typed `load` or `fromJson`
 * no store brings, its property never stored or its text only displayed, keeps F18's own check where it runs (r4.57); a
 * member of host data owes C1 at the member read and C9 at the host value; and a surely measured length is derived
 * (F14), never the external data of the ingress it measures. The whole record, in both orders.
 */
test("the landing index keeps F18's own check, sites a member's C1 at its read and derives a known length (Codex r20 B6, N1, N2)", () => {
  const at = (offset: number, end: number): CompactSite => ({ file: "main.tease", offset, end });
  const boundary = (target: string, against: string, site: CompactSite): CompactCheck => ({
    kind: "copy-type",
    target,
    against: [against],
    boundary: true,
    site,
  });
  const valid = (...checks: CompactCheck[]): CompactRecord => ({
    outcome: "valid",
    diagnostics: [],
    checks,
  });
  const cases: readonly (readonly [string, CompactRecord])[] = [
    [
      'let out = {unused: load("x", default: 0), kept: 1}.kept\nsay "AFTER"\n',
      valid(boundary("load.result", "integer", at(19, 40))),
    ],
    [
      'let out = {unused: fromJson("1", default: 0, files: false), kept: 1}.kept\nsay "AFTER"\n',
      valid(boundary("fromJson.result", "integer", at(19, 58))),
    ],
    [
      'let out = askChoice {text: load("x", default: "one"), value: "two"}\nsay "AFTER"\n',
      valid(boundary("load.result", "string", at(27, 52))),
    ],
    [
      'let rows = [1]\nrows.add(hostValue.field)\nsay "AFTER"\n',
      {
        outcome: "warning-runtime-check",
        diagnostics: [
          {
            kind: "written-target",
            class: "warning-runtime-check",
            site: at(24, 39),
            context: "unknown",
          },
          {
            kind: "member-read",
            class: "warning-runtime-check",
            site: at(24, 39),
            context: "unknown",
          },
        ],
        checks: [
          {
            kind: "copy-type",
            target: "rows.element",
            against: ["integer"],
            boundary: false,
            site: at(24, 39),
          },
          {
            kind: "null-check",
            target: "hostValue",
            against: ["non-null"],
            boundary: false,
            site: at(24, 39),
          },
          boundary("rows.element", "integer", at(24, 33)),
        ],
      },
    ],
    [
      'let out = load("x", default: [1]).length\nsay "AFTER"\n',
      valid(boundary("load.result", "list", at(10, 33))),
    ],
  ];
  for (const [source, expected] of cases) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});

/**
 * C9, C1 with TABLE r4.60 (Codex r21 B3, N1): named host data a store brings beside inline host data owes the
 * destination's check at its read and keeps its source's boundary, the inline value its boundary at the store; what a
 * receiver's operation (a copy) reads of host data that an add or an `addAll` brings owes C1 at that operation, C9 at
 * the host value. The whole record, in both orders.
 */
test("named data beside inline host data keeps its check and boundary, and an add's C1 sits at its copy (Codex r21 B3, N1)", () => {
  const at = (offset: number, end: number): CompactSite => ({ file: "main.tease", offset, end });
  const check = (target: string, against: string, boundary: boolean, site: CompactSite) =>
    ({ kind: "copy-type", target, against: [against], boundary, site }) as const;
  const warned = (
    diagnostics: readonly (readonly [CompactDiagnostic["kind"], CompactSite])[],
    checks: readonly CompactCheck[],
  ): CompactRecord => ({
    outcome: "warning-runtime-check",
    diagnostics: diagnostics.map(([kind, site]) => ({
      kind,
      class: "warning-runtime-check",
      site,
      context: "unknown",
    })),
    checks,
  });
  const nonNull = (site: CompactSite): CompactCheck => ({
    kind: "null-check",
    target: "hostValue",
    against: ["non-null"],
    boundary: false,
    site,
  });
  const cases: readonly (readonly [string, CompactRecord])[] = [
    [
      'let raw = hostValue\nlet out = [1, hostValue, raw][2]\nsay "AFTER"\n',
      warned(
        [["written-target", at(45, 48)]],
        [
          check("out", "integer", false, at(45, 48)),
          check("raw", "unknown", true, at(10, 19)),
          check("out", "integer", true, at(34, 43)),
        ],
      ),
    ],
    [
      'let xs = [[1]]\nxs.add(hostValue.toList())\nsay "AFTER"\n',
      warned(
        [
          ["written-target", at(22, 40)],
          ["member-read", at(22, 40)],
        ],
        [
          check("xs.element.element", "integer", false, at(22, 40)),
          nonNull(at(22, 40)),
          check("xs.element", "list", true, at(22, 31)),
        ],
      ),
    ],
    [
      'let xs = [1]\nxs.addAll(hostValue.toList())\nsay "AFTER"\n',
      warned(
        [
          ["written-target", at(23, 41)],
          ["member-read", at(23, 41)],
        ],
        [
          check("xs.element", "integer", false, at(23, 41)),
          nonNull(at(23, 41)),
          check("xs.element", "integer", true, at(23, 32)),
        ],
      ),
    ],
  ];
  for (const [source, expected] of cases) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, source);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});

/**
 * S6-CARRIERS §4.2, §4.3: copies of one source with equal signatures are one class, and the class decides through its
 * earliest member no test of the read's path holds (a guard marks a read possible, so it decides nothing): an unguarded
 * copy decides whether a guarded one comes before it or after it, the add of text then the misfit (A6); without a
 * written type a guarded copy decides nothing (§4.2's trace: the add decides, the unguarded copy is the misfit); with
 * one, the class's earliest copy decides by it, guarded or not (A4, Astra's third round B1). The whole record, in both
 * orders.
 */
test("a class decides through its earliest member no guard of the path holds, in both orders (§4.2, §4.3)", () => {
  type Diagnostic = readonly [
    CompactDiagnostic["kind"],
    CompactDiagnostic["class"],
    number,
    number,
    CompactDiagnostic["context"],
  ];
  type Check = readonly [CompactCheck["kind"], string, string, boolean, number, number];
  const record = (
    outcome: CompactRecord["outcome"],
    diagnostics: readonly Diagnostic[],
    checks: readonly Check[],
  ): CompactRecord => ({
    outcome,
    diagnostics: diagnostics.map(([kind, cls, offset, end, context]) => ({
      kind,
      class: cls,
      site: { file: "main.tease", offset, end },
      context,
    })),
    checks: checks.map(([kind, target, against, boundary, offset, end]) => ({
      kind,
      target,
      against: [against],
      boundary,
      site: { file: "main.tease", offset, end },
    })),
  });
  const after = 'box.add("word")\nrepeat box[0] {}\nexit\n';
  const cases: readonly (readonly [string, CompactRecord])[] = [
    [
      `let root = [1]\nlet box = [null]\nif root != null {\n  box = root\n}\nbox = root\n${after}`,
      record("compile-error", [["written-target", "compile-error", 84, 90, null]], []),
    ],
    [
      `let root = [1]\nlet box = [null]\nbox = root\nif root != null {\n  box = root\n}\n${after}`,
      record(
        "compile-error",
        [
          ["written-target", "compile-error", 84, 90, null],
          ["integer-use", "warning-runtime-check", 99, 105, "member"],
        ],
        [["null-check", "box.element", "integer", false, 99, 105]],
      ),
    ],
    [
      'let raw = hostValue\nraw = 1\nlet root = [raw]\nlet box = [null]\nif root != null {\n  box = root\n}\nbox.add("word")\nbox = root\nrepeat box[0] {}\nexit\n',
      record(
        "compile-error",
        [
          ["written-target", "warning-runtime-check", 10, 19, "later"],
          ["written-target", "warning-runtime-check", 88, 92, "later"],
          ["written-target", "compile-error", 117, 121, null],
          ["integer-use", "warning-runtime-check", 129, 135, "member"],
          ["integer-use", "warning-runtime-check", 129, 135, "unknown"],
          ["integer-use", "warning-runtime-check", 129, 135, "member"],
        ],
        [
          ["copy-type", "raw", "integer", false, 10, 19],
          ["copy-type", "box.element", "string", false, 88, 92],
          ["null-check", "box.element", "integer", false, 129, 135],
          ["integer-check", "box.element", "integer", false, 129, 135],
          ["integer-check", "box.element", "integer", false, 129, 135],
          ["copy-type", "raw", "integer", true, 10, 19],
        ],
      ),
    ],
    [
      `let root: integer[] = [1]\nlet box = [null]\nif root != null {\n  box = root\n}\nbox.add("word")\nbox = root\nrepeat box[0] {}\nexit\n`,
      record("compile-error", [["written-target", "compile-error", 84, 90, null]], []),
    ],
    [
      `let root: integer[] = [1]\nlet box = [null]\nbox = root\nif root != null {\n  box = root\n}\n${after}`,
      record(
        "compile-error",
        [
          ["written-target", "compile-error", 95, 101, null],
          ["integer-use", "warning-runtime-check", 110, 116, "member"],
        ],
        [["null-check", "box.element", "integer", false, 110, 116]],
      ),
    ],
  ];
  for (const [source, expected] of cases) {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], source);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${source} reversed`);
  }
});

/**
 * S6-CARRIERS §6's witnesses, as exact records in both orders:
 * - the first design review's across-function copy (its B2): the function's copy reads its source across X4, the
 *   integer and unknown contract, and owes its own C1; the exact top-level copy owes nothing;
 * - the second design review's reversed copy (its B1): the function's copy comes first, yet the exact top-level copy
 *   decides `box.f`, so the text after it is the error and the function's copy is `later`;
 * - the round-4 span sources (round 4's D1): C9 at the host value's own span through a concatenation, an `otherwise`
 *   (its end the host value's) and a choice, C1 beside it where a later store decides;
 * - the external reviewer's projected copies (R5-F1): repeated, once bound (`stable`, the same records) and with a store
 *   below the copied path between them, whose later copies carry it at `f0` and whose earlier ones are `later`;
 * - Astra's M1 witnesses: a conditional store below the copied path before and between the copies;
 * - Astra's F3 shapes: two choice reads of `root.f` answer at their own nodes, the one after an effectful call by the
 *   call's word; an argument inside `root != null and use(root)` carries the operand's guard into its parameter;
 * - two reads of one key in one literal with a call storing to it between them are two key reads (TABLE r4.68 (1)): the
 *   later one's element carries the call's kind, as the same reads in three statements do; so are two with a call
 *   between them that registers a handler storing the key (X7, H9), whose later read takes the contract, as both do
 *   after the registration.
 */
test("the carrier design's witnesses give their exact records, in both orders (S6-CARRIERS §6)", () => {
  const witnesses = CARRIER_WITNESSES;

  for (const [name, source, text] of witnesses) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, name);
    const expected = recordOf(text);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], name);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${name} reversed`);
  }
});

/**
 * #1188's witnesses, as exact records in both orders (its design note's §2.0 and §2.4):
 * - rule (a)'s three forms (TABLE r4.121, r4.127, r4.130): a rejected value is ignored, so a list whose elements still
 *   disagree after it gets an error of its own (Astra's `rule-a-list`); nothing warns about or checks a rejected value
 *   (`other-written-record`, where the core warned about storing the rejected element into `result` against its type);
 *   and a later store whose live value does not fit the receiving place's decided type errs, against the surviving type
 *   (`new-assignment-error`) or where a rejected list's surviving value meets a place decided otherwise
 *   (`reversed-assignment`);
 * - a whole cycle split by its two rejected copies keeps each member's own contents, so the outer list's error stays
 *   (Astra's recheck r3 F1); a fed cycle whose feeder's store is rejected takes none of the rejected value (her N1);
 * - a merge place deciding by its first copy, beside its second copy in a literal that decides by that copy: the
 *   literal's check, as the meeting is hot only where the literal decides (§2.4 (d));
 * - a live nested union, whose outer list now errs where its elements disagree (TABLE r4.128 (1));
 * - a whole-copy ring whose members decide two properties differently, two of them in a list, with a plain or a written
 *   union decider: the list's rejection in the first pass leaves the ring's last copy a possibility, a warning and its
 *   check (Astra's review B1 of #1311: the ring's shared trie still owes its meetings to the list);
 * - two literals each holding its own `load` or `fromJson` default at the same position beside one shared record, in
 *   lists, sets, dicts and a nested position, in either order of the literals: each literal's contributor is its own
 *   below that position, so the second literal's string and integer still disagree whatever the first holds (Astra's
 *   PR review B1).
 */
test("#1188's witnesses give their exact records, in both orders (rule (a), cycles, containment, contributors)", () => {
  for (const [name, source, text] of HOT_CANDIDATE_WITNESSES) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, name);
    const expected = recordOf(text);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], name);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${name} reversed`);
  }
});

/**
 * The bounded admission repairs' witnesses (#1078, #1194), as exact records in both orders:
 * - A8's conflict paths per class of the elements' contracts (`Contract.classOf`): a narrowed selection, which has no
 *   class, beside an object of another kind, its identity kept apart from every class (Codex r1's B1: a carrier's
 *   identity read like the object's class id, and the error was lost); k method results or conversions of
 *   one class beside an object, the object last (its own error, and the read of the integer element's property) or
 *   first (an error at each result, each its own element); the object between two results of one class; two literals
 *   of one class landing in one place, each with its own error; conversions beside written text, and lists of one class
 *   beside a list of the object, in either order; results beside an object holding host data; objects of one class
 *   each holding the object beside one that differs below it, last or first (an error at each that differs from the
 *   earliest, where one class for every element would lose them);
 * - a written type's element levels, read once per type (#1194): copies of a written type through an optional level,
 *   with a union or an optional element, and of an open element type beside a deep written one, each deep misfit an
 *   error and each fitting store accepted;
 * - the sources a read takes from the copies joined into a place, by the full path of their own stores (#1078): k
 *   copies of one preset, each storing its own property, each read's error at its own copy's store; copies storing one
 *   property and the object above it (the object's other type errs at its store, where it meets the copy: A2,
 *   #1249); a chain of preset copies joined again.
 */
test("the bounded admission repairs' witnesses give their exact records, in both orders (#1078, #1194)", () => {
  for (const [name, source, text] of BOUNDED_ADMISSION_WITNESSES) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, name);
    const expected = recordOf(text);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], name);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${name} reversed`);
  }
});
