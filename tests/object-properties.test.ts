import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { Story } from "./helpers/story-session.js";

// A parameter without a type or default is unknown, so `pick(...)` gives a value the compiler cannot know.
const PICK = "function pick(value) {\n    return value\n}\n";

/** The diagnostics of `source` as code, message, and the source each span covers. */
function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

/** What a valid program says, and its runtime failure as code and message, if it has one. */
function outcome(source: string): { said: string[]; failure: [string, string] | null } {
  const result = runValidSource(source);
  const fault = result.snapshot.failure;
  return { said: sayTexts(result), failure: fault === null ? null : [fault.code, fault.message] };
}

test("reading a property that no object at its place can have is a compile error with the runtime's text", () => {
  assert.deepEqual(diagnostics('let d = { name: "x" }\nsay "${d.color}"\nexit'), [
    ["TSV043", "'d' has no property 'color'. Its only property is 'name'.", "color"],
  ]);
  assert.deepEqual(diagnostics('let d = { name: "x" }\nsay d.nmae\nexit'), [
    ["TSV043", "'d' has no property 'nmae'. Its only property is 'name'.", "nmae"],
  ]);
  // The same read of a value the compiler cannot know fails with the same text when the script runs.
  assert.deepEqual(outcome(`${PICK}let d = pick({ name: "x" })\nsay d.color\nexit`).failure, [
    "TSR017",
    "'d' has no property 'color'. Its only property is 'name'.",
  ]);
  // Among several properties, a near miss is named. `+=` reads the property first.
  assert.deepEqual(
    diagnostics(
      'let door = { name: "x", locked: true }\nsay door.nmae\nlet stats = { hp: 1 }\nstats.xp += 1\nexit',
    ),
    [
      [
        "TSV043",
        "'door' has no property 'nmae'. Its properties are 'name' and 'locked'. Did you mean 'name'?",
        "nmae",
      ],
      ["TSV043", "'stats' has no property 'xp'. Its only property is 'hp'.", "xp"],
    ],
  );
});

test("a property assigned before the read on every path compiles and runs", () => {
  assert.deepEqual(
    outcome(
      'let d = { name: "x" }\nlet ready = true\nif ready {\n    d.color = "red"\n} else {\n    d.color = "blue"\n}\nsay d.color\nexit',
    ),
    { said: ["red"], failure: null },
  );
});

test("a property that only some code adds compiles, and its read is checked when the script runs", () => {
  // Added in only one branch: the runtime decides, as before.
  assert.deepEqual(
    outcome(
      'let d = { name: "x" }\nlet ready = false\nif ready {\n    d.color = "red"\n}\nsay d.color\nexit',
    ).failure,
    ["TSR017", "'d' has no property 'color'. Its only property is 'name'."],
  );
  // The elements of a list or dict share their place, which has the properties of all of them.
  assert.deepEqual(
    outcome(
      'let rooms = [{ name: "hall" }, { name: "cellar", locked: true }]\nsay "${rooms[1].locked}"\nsay "${rooms[0].locked}"\nexit',
    ),
    {
      said: ["true"],
      failure: ["TSR017", "This object has no property 'locked'. Its only property is 'name'."],
    },
  );
  assert.deepEqual(
    diagnostics(
      'let rooms = [{ name: "hall" }, { name: "cellar", locked: true }]\nsay rooms[1].color\nlet doors = dict{ main: { name: "main" } }\ndoors["back"] = { name: "back", open: true }\nsay doors["main"].colour\nexit',
    ),
    [
      [
        "TSV043",
        "This object has no property 'color'. Its properties are 'name' and 'locked'.",
        "color",
      ],
      [
        "TSV043",
        "This object has no property 'colour'. Its properties are 'name' and 'open'.",
        "colour",
      ],
    ],
  );
});

test("a value the compiler cannot know may have any property", () => {
  for (const source of [
    // A parameter without a type or default.
    `${PICK}let d = { name: "x" }\nd = pick({ name: "y", color: "red" })\nsay d.color\nexit`,
    // An object of the type `object`.
    'let o: object = { name: "x", color: "red" }\nlet d = { name: "y" }\nd = o\nsay d.color\nexit',
    // Stored data, which may come from an older version of the script.
    'let d = load("door", default: { name: "x" })\nsay "${d.color}"\nexit',
    'let d = { name: "x" }\nd = load("door", default: d)\nsay "${d.color}"\nexit',
  ])
    assert.deepEqual(diagnostics(source), [], source);
  assert.deepEqual(
    outcome(
      `${PICK}let d = { name: "x" }\nd = pick({ name: "y", color: "red" })\nsay d.color\nexit`,
    ),
    { said: ["red"], failure: null },
  );
});

test("a property added by code the compiler checks later still reaches a read that runs after it", () => {
  // A timer block is checked after the top level, and a function that only a block calls after the top level too, but
  // both run during the wait, before the copies, the list, and the store are made.
  const story = new Story(
    'let a = { name: "a" }\nlet b = { name: "b" }\nlet s = { name: "s" }\nlet t = { p: { a: 1 } }\nlet d = { name: "d" }\ntimer async 1 s {\n    a.color = "red"\n    b.size = 2\n    s.p = { a: 2, b: 3 }\n    paint()\n}\nwait 2 s\nlet c = a\nlet items = [a, b]\nt = s\nlet e = d\nsay "${a.color} ${c.color} ${items[0].color} ${items[1].size} ${t.p.b} ${e.shade}"\nexit\nfunction paint {\n    d.shade = "dark"\n}',
  ).at(10_000);
  assert.equal(story.snapshot.failure, null);
  assert.deepEqual(
    story.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["red red red 2 3 dark"],
  );
  // Another file is checked after `main.tease`, but runs at the `call`.
  const project = compileProject([
    {
      path: "main.tease",
      source:
        'global door = { name: "main" }\ncall "paint.tease"\nlet copy = door\nsay "${door.color} ${copy.color}"\nexit',
    },
    { path: "paint.tease", source: 'door.color = "red"\nend' },
  ]);
  assert.deepEqual(project.diagnostics, []);
  const ran = run(project.plan!, createImmediatePacingRuntimeSnapshot(project.plan!));
  assert.deepEqual(sayTexts(ran), ["red red"]);
  // A call passes an object with more properties than the parameter's default has.
  assert.deepEqual(
    outcome(
      'function show(door = { name: "x" }) {\n    say door.color\n}\nshow({ name: "y", color: "red" })\nexit',
    ),
    { said: ["red"], failure: null },
  );
});
