import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_RUNTIME_BUILTINS,
  type ProjectDiagnostic,
  type ProjectSourceFile,
} from "../src/compiler.js";
import { compileStableProject, type LoweringTrace } from "../src/compiler/compile-program.js";
import { parse } from "../src/parser.js";
import { PlanControlFlow } from "../src/plan/control-flow.js";
import { Reachability } from "../src/reachability.js";
import { validateProjectSemantics } from "../src/semantic.js";
import { checkTypes } from "../src/type-checker.js";
import { DeadWays } from "../src/way-facts.js";
import { compileAndRunVariants, type FlowKnob } from "./helpers/flow-differential.js";

/*
 * Which code can run, against the runtime (V30 §30): for small scripts, every way is run. No instruction of a statement
 * that TSV065 or TSV066 reports, such as an `exit`, runs on any way. Each other statement of interest is a marker,
 * `say MARK`, which says its own place: where the compiler reports that a marker never runs, no run says it, and where
 * it does not, some run does. The compiler reports it with TSV065 or TSV066 on the marker or on a statement around it,
 * and where one problem gets one code, with TSV046 on the condition just before it that is always false or whose case
 * never matches, or with TSV058 on the loop just before it.
 *
 * By the rules that decide what can run, the cases keep clear of code that never runs without such a report: code after
 * a call of a function that never returns (a call counts as returning, ADR 0022 §4.3), in a function that no call that
 * can run reaches or that only a parameter default reaches that every call supplies (a default counts as running where
 * its function runs), in a block that no code that can run creates, and in a file nothing enters. Within a run of
 * statements that never run, only the first one is a marker.
 */

interface Case {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  /** The knobs `k1`.. that the script loads; each is present in half of the runs. */
  readonly knobs?: number;
}

const KNOB = 'let k = load "k1", default: false';

const cases: readonly Case[] = [
  {
    name: "branches that a literal or a type rules out",
    knobs: 1,
    files: {
      "main.tease": [
        KNOB,
        'let name: string? = "Ann"',
        "let count = 1",
        "if false {",
        "  say MARK",
        "}",
        "if k {",
        "  say MARK",
        "} else {",
        "  say MARK",
        "}",
        "if true {",
        "  say MARK",
        "} else {",
        "  say MARK",
        "}",
        "if true {",
        "  say MARK",
        "} else if k {",
        "  say MARK",
        "}",
        "if name == null {",
        "  say MARK",
        "}",
        "if name != null {",
        "  say MARK",
        "}",
        "while name == null {",
        "  say MARK",
        "}",
        "repeat 0 {",
        "  say MARK",
        "}",
        "for item in [] {",
        "  say MARK",
        "}",
        "while false {",
        "  say MARK",
        "}",
        "switch k {",
        "  case true {",
        "    say MARK",
        "  }",
        "  case false {",
        "    say MARK",
        "  }",
        "  default {",
        "    say MARK",
        "  }",
        "}",
        "switch count {",
        "  case is string {",
        "    say MARK",
        "  }",
        "  default {",
        "    say MARK",
        "  }",
        "}",
        "exit",
      ].join("\n"),
    },
  },
  {
    name: "the lazy operators in a condition",
    knobs: 1,
    files: {
      "main.tease": [
        KNOB,
        "function check: boolean {",
        "  say MARK",
        "  return true",
        "}",
        "if k and false {",
        "  say MARK",
        "}",
        "if false and check() {",
        "  say MARK",
        "}",
        "if true or check() {",
        "  say MARK",
        "} else {",
        "  say MARK",
        "}",
        "if k or check() {",
        "  say MARK",
        "}",
        "if (not true) and k {",
        "  say MARK",
        "}",
        "if (k and false) or (false and check()) {",
        "  say MARK",
        "}",
        "exit",
      ].join("\n"),
    },
  },
  // A `while true` with each way out, taken on the second round: what follows the loop runs only after a `break`.
  ...["break", "goto done", "exit", 'goto "other.tease"', 'call "other.tease"', "stop()"].map(
    (out): Case => ({
      name: `while true with '${out}'`,
      knobs: 1,
      files: {
        "main.tease": [
          KNOB,
          ...(out === "stop()" ? ["function stop {", "  say MARK", "  exit", "}"] : []),
          "if k {",
          "  let n = 0",
          "  while true {",
          "    say MARK",
          "    n += 1",
          "    if n > 1 {",
          `      ${out}`,
          "    }",
          "    wait 1 s",
          "  }",
          "  say MARK",
          "}",
          "exit",
          ...(out === "goto done" ? ["label done", "say MARK", "exit"] : []),
        ].join("\n"),
        ...(out.includes('"other.tease"')
          ? { "other.tease": `say MARK\n${out.startsWith("goto") ? "exit" : "end"}` }
          : {}),
      },
    }),
  ),
  {
    name: "while true with 'return'",
    knobs: 1,
    files: {
      "main.tease": [
        KNOB,
        "function spin {",
        "  let n = 0",
        "  while true {",
        "    say MARK",
        "    n += 1",
        "    if n > 1 {",
        "      return",
        "    }",
        "    wait 1 s",
        "  }",
        "  say MARK",
        "}",
        "if k {",
        "  spin()",
        "  say MARK",
        "}",
        "exit",
      ].join("\n"),
    },
  },
  {
    name: "while true with a way out that never runs",
    knobs: 1,
    files: {
      "main.tease": [
        KNOB,
        'let name: string? = "Ann"',
        "if k {",
        "  while true {",
        "    if false {",
        "      say MARK",
        "      break",
        "    }",
        "    if name == null {",
        "      say MARK",
        "      break",
        "    }",
        "    wait 1 s",
        "    continue",
        "    say MARK",
        "  }",
        "  say MARK",
        "}",
        "say MARK",
        "exit",
      ].join("\n"),
    },
  },
  {
    name: "a goto loop, a goto past code, and a label loop with no way out",
    knobs: 1,
    files: {
      "main.tease": [
        KNOB,
        "let n = 0",
        "label top",
        "say MARK",
        "n += 1",
        "if n < 2 {",
        "  goto top",
        "}",
        "say MARK",
        "goto done",
        "say MARK",
        "label done",
        "say MARK",
        "if k {",
        '  goto "spin.tease"',
        "}",
        "exit",
      ].join("\n"),
      "spin.tease": ["label spin", "say MARK", "wait 1 s", "goto spin", "say MARK"].join("\n"),
    },
  },
  {
    name: "exit, end, and return",
    files: {
      "main.tease": [
        "function f: integer {",
        "  say MARK",
        "  return 1",
        "  say MARK",
        "}",
        "let v = f()",
        "say MARK",
        'call "child.tease"',
        "say MARK",
        "repeat 2 {",
        "  say MARK",
        "  exit",
        "}",
        "say MARK",
      ].join("\n"),
      "child.tease": "say MARK\nend\nsay MARK",
    },
  },
  {
    name: "an exit that never runs",
    knobs: 1,
    files: {
      "main.tease": [
        KNOB,
        "if k {",
        "  goto done",
        "  exit",
        "}",
        "if false {",
        "  exit",
        "}",
        "say MARK",
        "label done",
        "say MARK",
        "exit",
      ].join("\n"),
    },
  },
  {
    name: "while true with 'end' in a called file",
    knobs: 1,
    files: {
      "main.tease": [KNOB, "if k {", '  call "loop.tease"', "  say MARK", "}", "exit"].join("\n"),
      "loop.tease": [
        "let n = 0",
        "while true {",
        "  say MARK",
        "  n += 1",
        "  if n > 1 {",
        "    end",
        "  }",
        "  wait 1 s",
        "}",
        "say MARK",
        "end",
      ].join("\n"),
    },
  },
  {
    name: "a parameter default, supplied and left out",
    files: {
      "main.tease": [
        "function give: integer {",
        "  say MARK",
        "  return 1",
        "}",
        "function show(value = give()) {",
        "  say MARK",
        "  if value > 5 {",
        "    say MARK",
        "  }",
        "}",
        "show()",
        "show(7)",
        "exit",
      ].join("\n"),
    },
  },
  {
    name: "timer and button blocks",
    files: {
      "main.tease": [
        "timer async 1 s {",
        "  say MARK",
        "  if false {",
        "    say MARK",
        "  }",
        "}",
        'let button = showPermanentButton "Press" {',
        "  say MARK",
        "  if true {",
        "    say MARK",
        "  } else {",
        "    say MARK",
        "  }",
        "}",
        "if false {",
        "  timer async 1 s {",
        "    say MARK",
        "  }",
        "}",
        "wait 2 s",
        "say MARK",
        "exit",
      ].join("\n"),
    },
  },
];

interface Marker {
  readonly path: string;
  /** The 1-based line, which holds one marker. */
  readonly line: number;
  readonly offset: number;
  readonly text: string;
}

/** The files with each `MARK` replaced by its place, and the markers. */
function marked(files: Readonly<Record<string, string>>): {
  readonly files: ProjectSourceFile[];
  readonly markers: readonly Marker[];
} {
  const markers: Marker[] = [];
  const out = Object.entries(files).map(([path, source]) => {
    let offset = 0;
    const lines = source.split("\n").map((line, index) => {
      const column = line.indexOf("say MARK");
      const text = `${path}:${index + 1}`;
      const replaced = column === -1 ? line : line.replace("MARK", `"${text}"`);
      if (column !== -1) markers.push({ path, line: index + 1, offset: offset + column, text });
      offset += replaced.length + 1;
      return replaced;
    });
    return { path, source: lines.join("\n") };
  });
  return { files: out, markers };
}

/** The first line of the statement that ends just before line `line` of `source`, matching its braces. */
function previousStatementLine(source: string, line: number): number | null {
  const lines = source.split("\n");
  let index = line - 2;
  while (index >= 0 && lines[index]!.trim() === "") index -= 1;
  if (index < 0) return null;
  let depth = 0;
  for (; index >= 0; index -= 1) {
    const text = lines[index]!;
    depth += (text.match(/\}/g) ?? []).length - (text.match(/\{/g) ?? []).length;
    if (depth <= 0) return index + 1;
  }
  return null;
}

/** Whether the compiler reports that the marker never runs (see the header). */
function reported(
  marker: Marker,
  diagnostics: readonly ProjectDiagnostic[],
  source: string,
): boolean {
  const here = diagnostics.filter((diagnostic) => diagnostic.path === marker.path);
  const line = (diagnostic: ProjectDiagnostic): number => diagnostic.span.start.line + 1;
  const before = previousStatementLine(source, marker.line);
  return here.some(
    (diagnostic) =>
      ((diagnostic.code === "TSV065" || diagnostic.code === "TSV066") &&
        diagnostic.span.start.offset <= marker.offset &&
        marker.offset < diagnostic.span.end.offset) ||
      (diagnostic.code === "TSV046" &&
        line(diagnostic) === marker.line - 1 &&
        /always false|never matches/.test(diagnostic.message)) ||
      (diagnostic.code === "TSV058" && line(diagnostic) === before),
  );
}

test("a statement reported as never running never runs, and one not reported runs on some way", () => {
  for (const testCase of cases) {
    const { files, markers } = marked(testCase.files);
    const knobs: FlowKnob[] = Array.from({ length: testCase.knobs ?? 0 }, (_, index) => ({
      key: `k${index + 1}`,
    }));
    const { diagnostics, plan, runs } = compileAndRunVariants(files, knobs, {}, null, null, true);
    assert.deepEqual(
      diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
      testCase.name,
    );
    assert.notEqual(runs.length, 0, testCase.name);
    // No instruction of a reported statement runs.
    const flow = new PlanControlFlow(plan!);
    for (const index of new Set(runs.flatMap((run) => [...run.executed]))) {
      const { span } = plan!.instructions[index]!;
      const path = plan!.files[flow.fileOf(index)]!.path;
      const reportedHere = diagnostics.find(
        (diagnostic) =>
          (diagnostic.code === "TSV065" || diagnostic.code === "TSV066") &&
          diagnostic.path === path &&
          diagnostic.span.start.offset <= span.so &&
          span.eo <= diagnostic.span.end.offset,
      );
      assert.equal(
        reportedHere,
        undefined,
        `${testCase.name}: ${path}:${span.sl + 1} runs, but is reported as never running`,
      );
    }
    for (const run of runs) assert.equal(run.failure, null, `${testCase.name}: ${run.present}`);
    const said = new Set(runs.flatMap((run) => run.says));
    const sources = new Map(files.map((file) => [file.path, file.source]));
    for (const marker of markers) {
      const never = reported(marker, diagnostics, sources.get(marker.path)!);
      assert.equal(
        said.has(marker.text),
        !never,
        `${testCase.name}: ${marker.text} ${never ? "is reported, but runs" : "is not reported, but never runs"}`,
      );
    }
    // Each report of code other than an `exit` stands on a marker, so the cases check what follows its first statement.
    for (const diagnostic of diagnostics)
      if (diagnostic.code === "TSV065")
        assert.ok(
          markers.some(
            (marker) =>
              marker.path === diagnostic.path &&
              diagnostic.span.start.offset <= marker.offset &&
              marker.offset < diagnostic.span.end.offset,
          ),
          `${testCase.name}: ${diagnostic.path}:${diagnostic.span.start.line + 1} ${diagnostic.code} covers no marker`,
        );
  }
});

test("a loop keeps a narrowing that only code which never runs would end, and no run fails on it", () => {
  // `y` is known not to be null where the loop starts, and only code that never runs sets it to null.
  const loop = (body: readonly string[]): string =>
    [
      'let x: string? = "a"',
      'let y: string? = load("y", default: "b")',
      KNOB,
      "if y != null {",
      "  repeat 3 {",
      '    say "${y.length}"',
      ...body.map((line) => `    ${line}`),
      "  }",
      "}",
      "exit",
    ].join("\n");
  for (const body of [
    // A branch that the type of `x` rules out (the case of the cleanup map, `l1`), and one that a literal rules out.
    ["if x == null {", "  y = null", "}"],
    ["if false {", "  y = null", "}"],
    // After a statement that never continues.
    ["if k {", "  break", "  y = null", "}"],
    ["continue", "y = null"],
    // The `default` of a switch whose cases take every value.
    [
      "switch k {",
      "  case true { x = y }",
      "  case false { x = y }",
      "  default { y = null }",
      "}",
    ],
  ]) {
    const source = loop(body);
    const { diagnostics, runs } = compileAndRunVariants(
      [{ path: "main.tease", source }],
      [{ key: "k1" }],
    );
    assert.deepEqual(
      diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
      source,
    );
    for (const run of runs) {
      assert.equal(run.failure, null, source);
      assert.deepEqual(run.says, ["1", "1", "1"].slice(0, run.says.length), source);
    }
  }
  // A type that `y` takes from `x`, which only code that never runs would widen: the check that leaves that code out
  // decides it afresh, so `repeat y` takes a whole number.
  const decided = [
    "let x: integer | string = 1",
    "let y = null",
    "repeat 3 {",
    "  if y != null { repeat y { wait 1 ms } }",
    "  y = x",
    '  if false { x = "s" }',
    "}",
    "exit",
  ].join("\n");
  const taken = compileAndRunVariants([{ path: "main.tease", source: decided }], []);
  assert.deepEqual(
    taken.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV065"],
  );
  assert.deepEqual(
    taken.runs.map((run) => [run.status, run.failure]),
    [["halted", null]],
  );
  // The same for what a store may reach: only a dead store could make `target` a speaker, so a store through it does not
  // erase the type of `vera.mood`, and storing a number there stays an error, as on main.
  assert.deepEqual(
    compileAndRunVariants(
      [
        {
          path: "main.tease",
          source: [
            'speaker vera { mood: "calm" }',
            'let target: object | speaker = { mood: "a" }',
            "repeat 1 {",
            '  target.mood = "s"',
            "  if false { target = vera }",
            "}",
            "vera.mood = 1",
            "say vera.mood.length",
            "exit",
          ].join("\n"),
        },
      ],
      [],
    ).diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.span.start.line + 1}`),
    ["TSV041 7"],
  );
  // Where such code can run, the loop forgets the narrowing, and the read is an error.
  for (const body of [
    ["if k {", "  y = null", "}"],
    ["if k {", "  continue", "}", "y = null"],
    ["switch k {", "  case true { x = y }", "  default { y = null }", "}"],
  ])
    assert.deepEqual(
      compileAndRunVariants([{ path: "main.tease", source: loop(body) }], []).diagnostics.map(
        (diagnostic) => `${diagnostic.code} ${diagnostic.span.start.line + 1}`,
      ),
      ["TSV043 6"],
      loop(body),
    );
});

test("the type check's narrowing follows the same statements that never run as the plan", () => {
  // The loop effects leave out what the type check found never runs (see `checkTypes`), so it must find what the plan
  // finds: the statements that cannot run once their function, block, or file runs.
  for (const testCase of cases) {
    const files = marked(testCase.files).files.map(({ path, source }) => ({
      path,
      program: parse(source).program,
    }));
    const options = { builtins: CORE_RUNTIME_BUILTINS };
    const names = validateProjectSemantics(files, options);
    const types = checkTypes(files, {
      ...options,
      sharedWrites: new Map(names.flatMap((result) => [...result.sharedWrites])),
      speakers: new Map(names.flatMap((result) => [...result.speakers])),
    });
    const trace: LoweringTrace = { origins: new Map(), statements: new Map() };
    const plan = compileStableProject(
      files.map((file, index) => ({
        ...file,
        picks: names[index]!.picks,
        captures: names[index]!.captures,
      })),
      types.runtimeChecks,
      () => {},
      [],
      types.formShapes,
      types.storageTypes,
      trace,
    );
    const ways = new DeadWays(new PlanControlFlow(plan), trace.origins, types.ways);
    const { unreachable } = new Reachability(
      files.map((file) => file.program),
      plan,
      trace,
      ways,
    ).statementFlow();
    for (const [statement, { start, end }] of trace.statements)
      if (start < end)
        assert.equal(
          types.unreachable.has(statement),
          unreachable.has(statement),
          `${testCase.name}: the statement at offset ${statement.span.start.offset}`,
        );
  }
});
