import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { CORE_RUNTIME_BUILTINS } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { compareProjectPaths } from "../src/project-paths.js";
import { validateProjectSemantics } from "../src/semantic.js";
import type { TypeAnalysisRequest } from "../src/type-inference/backend.js";
import { collectGraph } from "../src/type-inference/collector.js";
import {
  graphText,
  type ConstraintGraph,
  type SyntaxEvidence,
} from "../src/type-inference/graph.js";
import { analyzeTypes } from "../src/type-inference/index.js";
import { registryView } from "../src/type-inference/registry-view.js";

/** The request the compiler would make for these files, after name checking. */
function request(
  files: readonly { readonly path: string; readonly source: string }[],
  globals: readonly string[] = [],
): TypeAnalysisRequest | null {
  const parsed = files.map((file) => ({ path: file.path, program: parse(file.source).program }));
  const options = { builtins: CORE_RUNTIME_BUILTINS, globals };
  const names = validateProjectSemantics(parsed, options);
  if (
    names.some((result) => result.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
  )
    return null;
  return {
    files: parsed,
    options: {
      ...options,
      sharedWrites: new Map(names.flatMap((result) => [...result.sharedWrites])),
      written: {
        lets: new Set(names.flatMap((result) => [...result.writtenLets])),
        globals: new Set(names.flatMap((result) => [...result.writtenGlobals])),
      },
      speakers: new Map(names.flatMap((result) => [...result.speakers])),
    },
    services: { valueKinds: registryView() },
  };
}

function collect(source: string): {
  readonly graph: ConstraintGraph;
  readonly lines: readonly string[];
} {
  const made = request([{ path: "main.tease", source }]);
  assert.notEqual(made, null, "the names resolve");
  const graph = collectGraph(made!);
  return { graph, lines: graphText(graph).split("\n") };
}

/** Asserts that one line of the dump matches, with `#N` ids left open by the pattern. */
function expectLine(lines: readonly string[], pattern: RegExp): void {
  assert.ok(
    lines.some((line) => pattern.test(line)),
    `a line matching ${pattern} among:\n${lines.join("\n")}`,
  );
}

function rejectLine(lines: readonly string[], pattern: RegExp): void {
  assert.ok(
    !lines.some((line) => pattern.test(line)),
    `no line matching ${pattern} among:\n${lines.join("\n")}`,
  );
}

test("an empty literal's cell is bottom and a load without a declaration is a plain view", () => {
  const { lines } = collect('let xs = []\nsave 1 as "k"\nlet v = load("k", default: null)\nexit');
  // The literal owns its cell; nothing stores into it, so the solver sees no evidence, not dynamic data.
  expectLine(lines, /^has @\d+#\d+ list<ref list@\d+\[\]#\d+> @0:9-11 operand in file 0$/);
  rejectLine(lines, /^store .* -> list@\d+\[\]#\d+ /);
  expectLine(lines, /^store @\d+#\d+ -> xs#\d+ initializer @0:9-11 initializer in file 0$/);
  // A load without a receiving declaration has a view without a written type; its default is its own operand.
  expectLine(
    lines,
    /^load "k" view load@\d+#\d+ default @\d+#\d+ -> @\d+#\d+ @0:\d+-\d+ load in file 0$/,
  );
  expectLine(lines, /^save @\d+#\d+ as "k" /);
});

test("a declared receiver reaches the load, and an annotated union fits a literal store", () => {
  const { lines } = collect(
    [
      'let a: integer = load("k", default: 1)',
      'let xs: (integer | string)[] = [1, "a"]',
      'let b: string = ""',
      'b = load("k", default: "x")',
      "exit",
    ].join("\n"),
  );
  expectLine(lines, /^load "k" view load@\d+#\d+ as integer default @\d+#\d+ -> @\d+#\d+ /);
  expectLine(lines, /^load "k" view load@\d+#\d+ as string default @\d+#\d+ -> @\d+#\d+ /);
  expectLine(lines, /^xs#\d+: let xs: list<\(integer \| string\)> /);
  // The literal's members store into its own cell; the literal stores into the written place; nothing is a conflict yet.
  expectLine(lines, /^store @\d+#\d+ -> list@\d+\[\]#\d+ element @0:\d+-\d+ element in file 0$/);
});

test("element and property reads are held projections; stores through them mutate the root", () => {
  const { lines } = collect(
    ["let a = [[]]", "a[0].add(1)", "let o = { x: 1 }", "o.y.z = 2", "let c = a[0]", "exit"].join(
      "\n",
    ),
  );
  // `a[0]` is a target of the occurrence of `a`, and the add projects its element from that target.
  expectLine(lines, /^project @\d+#\d+\[index\] -> @\d+#\d+ @0:13-17 read in file 0$/);
  expectLine(lines, /^project @\d+#\d+\[element\] -> @13\[\]#\d+ @0:13-24 element in file 0$/);
  expectLine(lines, /^store @\d+#\d+ -> @13\[\]#\d+ element @0:22-23 element in file 0$/);
  expectLine(lines, /^mutate a#\d+ at 0:13-24 /);
  // A nested property store projects twice and mutates `o`.
  expectLine(lines, /^project @\d+#\d+\.y -> @\d+#\d+ @0:\d+-\d+ read in file 0$/);
  expectLine(lines, /^project @\d+#\d+\.z -> @\d+#\d+ @0:\d+-\d+ assignment in file 0$/);
  expectLine(lines, /^mutate o#\d+ /);
  // The copy of `a[0]` happens at the initializer, not at the read.
  expectLine(lines, /^store @\d+#\d+ -> c#\d+ initializer /);
  rejectLine(lines, /^copy /);
});

test("compound assignments read the place first; `x = x otherwise d` is a fallback of the read", () => {
  const { lines } = collect("let n = 1\nn += 2\nlet v = null\nv = v otherwise 0\nexit");
  expectLine(lines, /^read n#\d+ -> @10#\d+ at 0:10-11 /);
  expectLine(
    lines,
    /^operation operator\.\+\(@10#\d+, @15#\d+\) -> @10#\d+ @0:10-16 compound assignment in file 0$/,
  );
  expectLine(lines, /^store @10#\d+ -> n#\d+ compound /);
  expectLine(lines, /^assign @10#\d+ -> n#\d+ at 0:10-16 /);
  expectLine(lines, /^fallback @34#\d+ otherwise @46#\d+ -> @34#\d+ /);
  expectLine(lines, /^store @34#\d+ -> v#\d+ assignment /);
});

test("functions have parameter and result places, defaults, body stores, returns and an exit", () => {
  const source = [
    "function f(a, b: integer, c = 1) {",
    "  c = c * 1.5",
    "  if a { return b }",
    "  return c",
    "}",
    "say f(true, 2)",
    "exit",
  ].join("\n");
  const { graph, lines } = collect(source);
  assert.equal(graph.functions.length, 1);
  expectLine(lines, /^f\.b#\d+: parameter 1 b of fn#0: integer /);
  expectLine(
    lines,
    /^store @\d+#\d+ -> f\.c#\d+ parameter default @0:30-31 parameter default in fn#0$/,
  );
  // The body's store into the parameter is an ordinary assignment; a call's argument is never a store.
  expectLine(lines, /^store @\d+#\d+ -> f\.c#\d+ assignment @0:41-48 assignment in fn#0$/);
  expectLine(lines, /^call fn#0\(@\d+#\d+, @\d+#\d+\) -> @\d+#\d+ @0:86-96 call in file 0$/);
  rejectLine(lines, /^store .* -> f\.a#\d+ /);
  expectLine(lines, /^return @\d+#\d+ from fn#0 @0:58-66 return in fn#0$/);
  expectLine(lines, /^exit fn#0 @0:33-81 return in fn#0$/);
});

test("loops copy the iteration value, addAll stores elements, and get keeps its default off the receiver", () => {
  const { lines } = collect(
    [
      "let xs = [1, 2]",
      "for item in xs { say item }",
      'let d = dict{"a": 1}',
      "for key, value in d { say key }",
      "xs.addAll([3])",
      "let g = xs.get(0, default: 9)",
      "exit",
    ].join("\n"),
  );
  expectLine(lines, /^project @\d+#\d+\[iteration\] -> item's source#\d+ /);
  expectLine(lines, /^store item's source#\d+ -> item#\d+ loop variable /);
  expectLine(lines, /^has key#\d+ string /);
  expectLine(lines, /^project @\d+#\d+\[entry\] -> value's source#\d+ /);
  expectLine(lines, /^store @\d+#\d+ -> xs\[\]#\d+ elements /);
  expectLine(lines, /^get @\d+#\d+\[@\d+#\d+\] default @\d+#\d+ -> @\d+#\d+ /);
  // Q2: the default does not flow into the receiver's cell.
  rejectLine(lines, /^store @139#\d+ /);
});

test("speaker stores name the speaker, stores through a parameter project, and the account copy seeds the player", () => {
  const { lines } = collect(
    [
      "speaker vera {",
      '  mood: "calm"',
      "}",
      'vera.mood = "glad"',
      'function cheer(who) { who.mood = "x" }',
      "player.copyFrom(account)",
      "say vera.mood",
      "exit",
    ].join("\n"),
  );
  expectLine(lines, /^speaker store vera\.mood <- @\d+#\d+ @0:23-29 start value in start$/);
  expectLine(lines, /^speaker store vera\.mood <- @\d+#\d+ @0:44-50 assignment in file 0$/);
  expectLine(lines, /^speaker read vera\.mood -> @\d+#\d+ /);
  // Through a parameter the store is a projection; the solver decides whether the owner may be a speaker.
  expectLine(lines, /^project @\d+#\d+\.mood -> @\d+#\d+ @0:\d+-\d+ assignment in fn#0$/);
  expectLine(lines, /^mutate cheer\.who#\d+ /);
  expectLine(
    lines,
    /^speaker store player\.firstName <- player\.firstName#\d+ @0:\d+-\d+ start value in start$/,
  );
  expectLine(
    lines,
    /^speaker store player\.petNames <- player\.petNames#\d+ @0:\d+-\d+ assignment in file 0$/,
  );
  expectLine(lines, /^has player\.petNames#\d+ list<string> /);
});

test("asks carry the evidence their result rules read, and handlers are regions of their own", () => {
  const { graph, lines } = collect(
    [
      'let answer = askChoice back: "Back", "Lines"',
      'let picture = askImage("Picture", allowSkip: false)',
      'let flags = askBooleans("Which?", texts: ["A", "B"], cancel: "Back")',
      'let t = timer async 5 s { say "done" }',
      'let m = playAudio async "a.mp3" { say m.volume }',
      "exit",
    ].join("\n"),
  );
  // A label written before `:` is evidence, not source: the option's expression is the operand, and the label
  // is what the button returns.
  rejectLine(lines, /^read .* -> @23#\d+ /);
  expectLine(
    lines,
    /^operation interaction\.choice\(@29#\d+, @37#\d+\) -> @\d+#\d+ \{"kind":"choice","options":\[\{"label":\{"kind":"string","value":"back"\},"place":\d+,"literal":\{"value":"Back"\},"content":\{"kind":"other"\}\},\{"label":null,"place":\d+,"literal":\{"value":"Lines"\},"content":\{"kind":"other"\}\}\]\} /,
  );
  expectLine(
    lines,
    /^operation interaction\.askImage\(@\d+#\d+, allowSkip: @\d+#\d+\) -> @\d+#\d+ \{"kind":"image","allowSkip":false\} /,
  );
  expectLine(
    lines,
    /^operation interaction\.booleans\(, message: @\d+#\d+, texts: @\d+#\d+, cancel: @\d+#\d+\) -> @\d+#\d+ \{"kind":"booleans","cancel":true\} /,
  );
  expectLine(
    lines,
    /^operation timer\.short\(@\d+#\d+\) -> @\d+#\d+ \{"kind":"timer","form":"short","async":true\} /,
  );
  expectLine(
    lines,
    /^operation media\.audio\(@\d+#\d+\) -> @\d+#\d+ \{"kind":"media","media":"audio","async":true\} /,
  );
  assert.deepEqual(
    graph.handlers.map((handler) => ({ created: handler.created, selfHandle: handler.selfHandle })),
    [
      { created: { kind: "file", file: 0 }, selfHandle: null },
      { created: { kind: "file", file: 0 }, selfHandle: "m" },
    ],
  );
  // The media block reads its own handle, bound as a media value inside the block's region.
  expectLine(lines, /^has m#\d+ media @0:\d+-\d+ initializer in handler#1$/);
  expectLine(lines, /^read m#\d+ -> @\d+#\d+ at 0:\d+-\d+ @0:\d+-\d+ read in handler#1$/);
  expectLine(lines, /^project @\d+#\d+\.volume -> @\d+#\d+ @0:\d+-\d+ read in handler#1$/);
});

test("form evidence keeps each written field and option element with its place", () => {
  const { lines } = collect(
    [
      'let buttons = [{ text: "Low", value: 1 }]',
      'let answers = askForm "Adjust", fields: {',
      "    enabled: { value: false },",
      '    intensity: [{ text: "Low" }, { text: "High" }],',
      '    level: { options: [{ text: "Low", value: 1 }, buttons[0]], value: 3 },',
      '    cycle: { options: buttons, type: "integer", optional: false, min: 1, max: 9 }',
      '}, cancel: "Back"',
      "exit",
    ].join("\n"),
  );
  const form = lines.find((line) => line.startsWith("operation interaction.form("));
  assert.notEqual(form, undefined);
  // EVIDENCE: the dump prints a constraint's evidence as the JSON of its `SyntaxEvidence`.
  const evidence = JSON.parse(
    form!.slice(form!.indexOf("{"), form!.lastIndexOf("}") + 1),
  ) as SyntaxEvidence;
  if (evidence.kind !== "form" || evidence.fields === "computed") assert.fail("a written form");
  // A toggle: its written `value:` by place. A shorthand list: its written elements, each with its text's place and
  // its literal. Written objects beside a computed element keep their `value`/`text` places; the computed element
  // keeps its place only. A computed `options:` keeps its place; `type:`, `optional:`, `min:`, `max:` are read.
  assert.deepEqual(
    evidence.fields.entries.map((entry) => [entry.name, entry.written.kind]),
    [
      ["enabled", "object"],
      ["intensity", "list"],
      ["level", "object"],
      ["cycle", "object"],
    ],
  );
  const level = evidence.fields.entries[2]!.written;
  if (level.kind !== "object" || level.options === null || level.options.elements === null)
    assert.fail("written options");
  assert.deepEqual(
    level.options.elements.map((element) => [element.literal, element.object !== null]),
    [
      [{ value: 1 }, true],
      [null, false],
    ],
  );
  const cycle = evidence.fields.entries[3]!.written;
  if (cycle.kind !== "object" || cycle.options === null) assert.fail("a cycle with options");
  assert.deepEqual(
    [cycle.type, cycle.optional, cycle.min !== null, cycle.max !== null, cycle.options.elements],
    ["integer", false, true, true, null],
  );
  assert.equal(evidence.cancel, true);
});

test("reads of unwritten variables link to their initializers; host globals and unknown callees are dynamic", () => {
  const made = request(
    [
      {
        path: "main.tease",
        source: "let d = 1\nsay d\nlet w = 2\nw = 3\nsay w\nsay unknownHost\nexit",
      },
    ],
    ["unknownHost"],
  );
  assert.notEqual(made, null);
  const graph = collectGraph(made!);
  const lines = graphText(graph).split("\n");
  expectLine(lines, /^known @\d+#\d+ from 0:8-9 @0:14-15 read in file 0$/);
  rejectLine(lines, /^known .* @0:\d+-\d+ read in file 0$.*w/);
  assert.equal(lines.filter((line) => line.startsWith("known ")).length, 1);
  expectLine(lines, /^unknownHost#\d+: host unknownHost$/);
  expectLine(lines, /^read unknownHost#\d+ -> @\d+#\d+ /);
});

test("the dump of a small source is deterministic and complete", () => {
  const source = "let x = 1\nx = x + 1\nexit";
  const first = collect(source);
  const second = collect(source);
  assert.equal(first.lines.join("\n"), second.lines.join("\n"));
  assert.deepEqual(first.lines, [
    "@8#0: value numberLiteral @0:8-9",
    "x#1: let x @0:0-9",
    "@14#2: value identifier @0:14-15",
    "@18#3: value numberLiteral @0:18-19",
    "@14#4: value binaryExpression @0:14-19",
    "has @8#0 integer @0:8-9 operand in file 0",
    "store @8#0 -> x#1 initializer @0:8-9 initializer in file 0",
    "read x#1 -> @14#2 at 0:14-15 @0:14-15 read in file 0",
    "has @18#3 integer @0:18-19 operand in file 0",
    "operation operator.+(@14#2, @18#3) -> @14#4 @0:14-19 operand in file 0",
    "store @14#4 -> x#1 assignment @0:14-19 assignment in file 0",
    "assign @14#4 -> x#1 at 0:10-19 @0:10-19 assignment in file 0",
  ]);
});

/** Every `.tease` project and file under `tests/fixtures` and `examples`, as the differential tool discovers them. */
function repositorySources(): readonly {
  readonly id: string;
  readonly files: readonly { readonly path: string; readonly source: string }[];
}[] {
  const found: { id: string; files: { path: string; source: string }[] }[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory).sort();
    if (entries.includes("main.tease")) {
      const files: { path: string; source: string }[] = [];
      const walk = (inner: string): void => {
        for (const entry of readdirSync(inner).sort()) {
          const path = join(inner, entry);
          if (statSync(path).isDirectory()) walk(path);
          else if (entry.endsWith(".tease"))
            files.push({ path: relative(directory, path), source: readFileSync(path, "utf8") });
        }
      };
      walk(directory);
      files.sort((left, right) => compareProjectPaths(left.path, right.path));
      found.push({ id: directory, files });
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (entry.endsWith(".tease"))
        found.push({
          id: path,
          files: [{ path: "main.tease", source: readFileSync(path, "utf8") }],
        });
    }
  };
  for (const root of ["tests/fixtures", "examples"]) visit(root);
  return found;
}

test("the collector resolves every read as the legacy check does, on every repository source", () => {
  let compared = 0;
  for (const { id, files } of repositorySources()) {
    const made = request(files);
    if (made === null) continue;
    const graph = collectGraph(made);
    const facts = analyzeTypes(made).facts();
    const site = (place: {
      readonly file: number;
      readonly start: number;
      readonly end: number;
    }): string => `${place.file}:${place.start}-${place.end}`;
    const collected = new Map<string, string | null>();
    for (const constraint of graph.constraints)
      if (constraint.kind === "read") {
        const binding = graph.places[constraint.binding]!;
        collected.set(site(constraint.site), binding.site === null ? null : site(binding.site));
      }
    const legacy = new Map<string, string | null>();
    for (const read of facts.reads)
      legacy.set(site(read.site), read.binding === null ? null : site(read.binding));
    assert.deepEqual([...collected].sort(), [...legacy].sort(), `the reads of ${id}`);
    // Structure: every referenced place exists, and collecting again gives the same graph.
    for (const constraint of graph.constraints)
      for (const value of Object.values(constraint))
        if (typeof value === "number" && "place" in constraint === false)
          assert.ok(
            value < graph.places.length || value < graph.functions.length,
            `an id of ${id}`,
          );
    assert.equal(
      graphText(collectGraph(made)),
      graphText(graph),
      `the dump of ${id} is deterministic`,
    );
    compared += 1;
  }
  assert.ok(compared >= 15, `${compared} sources compared`);
});
