import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectDiagnostic, ProjectSourceFile } from "../src/compiler.js";
import { compileAndRunVariants, type FlowKnob } from "./helpers/flow-differential.js";

/*
 * Which code can run, against the runtime (V30 §30): for small scripts, every way is run, and each statement of interest
 * is a marker, `say MARK`, which says its own place. Where the compiler reports that a marker never runs, no run says
 * it; where it does not, some run does. The compiler reports it with TSV065 or TSV066 on the marker or on a statement
 * around it, and where one problem gets one code, with TSV046 on the condition just before it that is always false or
 * whose case never matches, or with TSV058 on the loop just before it.
 *
 * By the rules that decide what can run, the cases keep clear of code that never runs without such a report: code after
 * a call of a function that never returns (a call counts as returning, ADR 0022 §4.3), in a function that no call that
 * can run reaches, in a block that no code that can run creates, and in a file nothing enters. Within a run of
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
    const { diagnostics, runs } = compileAndRunVariants(files, knobs, {}, null, null, true);
    assert.deepEqual(
      diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
      testCase.name,
    );
    assert.notEqual(runs.length, 0, testCase.name);
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
    // Each report of code that never runs stands on a marker, so the cases check all of them.
    for (const diagnostic of diagnostics)
      if (diagnostic.code === "TSV065" || diagnostic.code === "TSV066")
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
