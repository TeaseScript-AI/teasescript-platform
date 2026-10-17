import assert from "node:assert/strict";
import test from "node:test";

import { CORE_RUNTIME_BUILTINS } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { validateProjectSemantics } from "../src/semantic.js";
import { createSourceSpan, createSourcePosition } from "../src/source.js";
import { INTEGER_TYPE, openType, PropertyTable, type StaticType } from "../src/static-types.js";
import { typeKey } from "../src/storage-types.js";
import type { SolvedTypeFacts, TypeAnalysisOutcome } from "../src/type-inference/backend.js";
import { analyzeTypes, checkTypes } from "../src/type-inference/index.js";

/** Analyzes the files of a project as the compiler does, after name checking. */
function analyze(sources: Record<string, string>): TypeAnalysisOutcome {
  const files = Object.entries(sources).map(([path, source]) => ({
    path,
    program: parse(source).program,
  }));
  const options = { builtins: CORE_RUNTIME_BUILTINS };
  const names = validateProjectSemantics(files, options);
  for (const [index, result] of names.entries())
    assert.deepEqual(result.diagnostics, [], `names of ${files[index]!.path}`);
  return analyzeTypes({
    files,
    options: {
      ...options,
      sharedWrites: new Map(names.flatMap((result) => [...result.sharedWrites])),
      written: {
        lets: new Set(names.flatMap((result) => [...result.writtenLets])),
        globals: new Set(names.flatMap((result) => [...result.writtenGlobals])),
      },
      speakers: new Map(names.flatMap((result) => [...result.speakers])),
    },
  });
}

function binding(facts: SolvedTypeFacts, name: string): SolvedTypeFacts["bindings"][number] {
  const found = facts.bindings.filter((fact) => fact.name === name);
  assert.equal(found.length, 1, `one binding named ${name}`);
  return found[0]!;
}

/** The type the check gave the expression of `kind` that starts where `text` first stands in `source`. */
function valueAt(facts: SolvedTypeFacts, source: string, text: string, kind: string): string {
  const start = source.indexOf(text);
  assert.notEqual(start, -1, `${text} in the source`);
  const found = facts.values.filter((fact) => fact.site.start === start && fact.kind === kind);
  assert.equal(found.length, 1, `one ${kind} at ${text}`);
  return found[0]!.type;
}

test("the type analysis outcome carries the checked result and its facts on request", () => {
  const source = "let x = 1\nx = 2.5\nsay x\nexit";
  const outcome = analyze({ "main.tease": source });
  const files = [{ path: "main.tease", program: parse(source).program }];
  assert.deepEqual(
    outcome.checked.diagnostics,
    checkTypes(files, { builtins: CORE_RUNTIME_BUILTINS }).diagnostics,
  );
  assert.equal(outcome.facts(), outcome.facts(), "the facts are made once");
});

test("the facts give every declaration the type it keeps at the end of the check", () => {
  const source = [
    "let x = 1",
    "x = 2.5",
    "let s = null",
    's = "a"',
    "let xs = []",
    'xs.add("a")',
    "for item in xs { say item }",
    "function f(a, b: integer, c = 1) { return c }",
    "say x",
    "exit",
  ].join("\n");
  const facts = analyze({ "main.tease": source }).facts();
  // A non-whole number widens an inferred integer (ADR 0021 rule 1.2); null before a value makes it optional
  // (rule 1.1); the first element decides an empty list (rule 1.3); a loop variable copies the element.
  assert.equal(binding(facts, "x").type, "number");
  assert.equal(binding(facts, "s").type, "(null|string)");
  assert.equal(binding(facts, "xs").type, "list<string>");
  assert.equal(binding(facts, "item").type, "string");
  // A parameter without annotation or default is unknown; an annotation or a default decides (rule 1.5).
  assert.equal(binding(facts, "a").type, "unknown");
  assert.equal(binding(facts, "b").type, "integer");
  assert.equal(binding(facts, "c").type, "integer");
  assert.deepEqual(
    facts.functions.map((fact) => ({ ...fact, site: undefined })),
    [
      {
        site: undefined,
        name: "f",
        parameters: ["unknown", "integer", "integer"],
        accepted: ["unknown", "integer", "integer"],
        result: "integer",
      },
    ],
  );
  // Every checked expression has its type: a read of `x` after the widening is a number.
  assert.equal(valueAt(facts, source, "2.5", "numberLiteral"), "number");
  const read = source.lastIndexOf("say x") + "say ".length;
  const reads = facts.values.filter(
    (fact) => fact.site.start === read && fact.kind === "identifier",
  );
  assert.deepEqual(
    reads.map((fact) => fact.type),
    ["number"],
  );
  assert.ok(facts.bindings.every((fact) => fact.site.file === 0));
});

test("the facts place each site in its file and list storage keys with every load's view", () => {
  const facts = analyze({
    "main.tease": 'let a = load("level", default: 1)\ngoto "other.tease"',
    "other.tease": 'let b: integer | string = load("level", default: 1)\nsave 2 as "level"\nexit',
  }).facts();
  assert.equal(binding(facts, "a").site.file, 0);
  assert.equal(binding(facts, "b").site.file, 1);
  // A load that declares the key's type decides it for every file, and every other load of the key reads that type
  // (ADR 0021 §6.1); each load keeps whether it declared it.
  assert.deepEqual(
    facts.storage.map((fact) => ({
      ...fact,
      loads: fact.loads.map((load) => ({ ...load, site: load.site.file })),
    })),
    [
      {
        key: "level",
        type: "(integer|string)",
        declared: true,
        loads: [
          { site: 0, type: "(integer|string)", declared: false },
          { site: 1, type: "(integer|string)", declared: true },
        ],
      },
    ],
  );
});

test("the facts list the custom properties of speakers and the names no speaker keeps a type for", () => {
  const facts = analyze({
    "main.tease": [
      "speaker vera {",
      '  mood: "calm"',
      "  score: 1",
      "}",
      "function cheer(who) { who.score = 2 }",
      "exit",
    ].join("\n"),
  }).facts();
  // A store through a speaker the compiler cannot tell apart leaves the property's name without a type, for every
  // speaker (ADR 0021 rule 1.7): `score` is unchecked and `vera` keeps no type for it.
  assert.deepEqual(facts.speakers, [
    { name: "vera", properties: [{ name: "mood", type: "string" }] },
  ]);
  assert.deepEqual(facts.uncheckedProperties, ["score"]);
});

test("the detailed type text tells restricted values, held unknown values, and open shapes apart", () => {
  const restricted: StaticType = { kind: "scalar", name: "integer", values: [2, 1] };
  assert.equal(typeKey(restricted), "integer");
  assert.equal(typeKey(restricted, true, true), "integer{1|2}");
  assert.equal(typeKey(restricted, false, true), "integer{2|1}");
  const span = createSourceSpan(createSourcePosition(0, 0, 0), createSourcePosition(1, 0, 1));
  const held = openType();
  held.heldUnknown = span;
  assert.equal(typeKey(held), "?");
  assert.equal(typeKey(held, true, true), "?!");
  held.resolved = INTEGER_TYPE;
  assert.equal(typeKey(held), "integer");
  assert.equal(typeKey(held, true, true), "integer!");
  const table = new PropertyTable([["a", INTEGER_TYPE]]);
  const shape: StaticType = { kind: "object", properties: table };
  assert.equal(typeKey(shape, true, true), '{"a":integer}');
  table.open = true;
  assert.equal(typeKey(shape), '{"a":integer}');
  assert.equal(typeKey(shape, true, true), '{"a":integer,+}');
});
