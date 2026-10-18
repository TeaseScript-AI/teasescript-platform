import assert from "node:assert/strict";
import test from "node:test";

import type { SolvedTypeFacts } from "../src/type-inference/backend.js";
import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import type {
  Constraint,
  ConstraintGraph,
  Origin,
  PlaceKind,
  SourceSite,
  TypeTerm,
} from "../src/type-inference/graph.js";
import { analyzeTypes } from "../src/type-inference/index.js";
import { exportFacts, exportTypes } from "../src/type-inference/solver/export.js";
import type { CellView } from "../src/type-inference/solver/interpret.js";
import { solve, type Solution } from "../src/type-inference/solver/solve.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * The export of a solution as the legacy's facts (O4 stage 3a, work note §6 and §3.7), against the legacy's own facts
 * of the same sources: each form the export writes, from the smallest source the legacy writes that way, where the two
 * agree by design; where they differ by design, both texts and the reason, which the facts differential of work note
 * §7 classifies. Then the legacy's order, a structural cycle, and the shared structure of the exported types.
 */

const relations = operationRelations();

interface Analyzed {
  readonly source: string;
  readonly solution: Solution;
  readonly facts: SolvedTypeFacts;
  readonly legacy: SolvedTypeFacts;
}

/** The solution, its export, and the legacy's facts of one project, from the request the compiler would make. */
function analyzed(files: readonly string[], globals: readonly string[] = []): Analyzed {
  const made = request(
    files.map((source, index) => ({ path: `file${index}.tease`, source })),
    globals,
  );
  assert.notEqual(made, null, "the sources parse and resolve");
  const solution = solve(collectGraph(made!), { relations, verify: true });
  return {
    source: files[0]!,
    solution,
    facts: exportFacts(solution),
    legacy: analyzeTypes(made!).facts(),
  };
}

/**
 * Which fact a form is read from: a binding by name, a value by its source text and node kind (where the first
 * occurrence of `at` starts, else of the text itself), a function's result by the function's name.
 */
type FactRef =
  | { readonly binding: string }
  | { readonly value: string; readonly kind: string; readonly at?: string }
  | { readonly result: string };

/** The fact's text in `facts` and the place of the solution it is exported from. */
function factOf(
  analysis: Analyzed,
  facts: SolvedTypeFacts,
  ref: FactRef,
): { readonly text: string; readonly place: number } {
  const places = analysis.solution.graph.places;
  if ("binding" in ref) {
    const found = facts.bindings.filter((fact) => fact.name === ref.binding);
    assert.equal(found.length, 1, `one binding ${ref.binding}`);
    const place = places.find(
      (candidate) => candidate.kind.kind === "binding" && candidate.kind.name === ref.binding,
    );
    assert.ok(place !== undefined, `a place for ${ref.binding}`);
    return { text: found[0]!.type, place: place.id };
  }
  if ("value" in ref) {
    const start = analysis.source.indexOf(ref.at ?? ref.value);
    const end = start + ref.value.length;
    const found = facts.values.filter(
      (fact) => fact.site.start === start && fact.site.end === end && fact.kind === ref.kind,
    );
    assert.equal(found.length, 1, `one ${ref.kind} value ${ref.value}`);
    const place = places.find(
      (candidate) =>
        candidate.kind.kind === "value" &&
        candidate.kind.node === ref.kind &&
        candidate.site?.start === start &&
        candidate.site.end === end,
    );
    assert.ok(place !== undefined, `a place for ${ref.value}`);
    return { text: found[0]!.type, place: place.id };
  }
  const found = facts.functions.filter((fact) => fact.name === ref.result);
  assert.equal(found.length, 1, `one function ${ref.result}`);
  const fn = analysis.solution.graph.functions.find((candidate) => candidate.name === ref.result);
  assert.ok(fn !== undefined && found[0]!.result !== null, `a result for ${ref.result}`);
  return { text: found[0]!.result, place: fn.result };
}

interface Form {
  /** The form the row pins. */
  readonly form: string;
  readonly source: string;
  readonly fact: FactRef;
  /** The solver's view of the place, which the row renders. */
  readonly view: CellView["kind"];
  readonly exported: string;
  /** Where the legacy writes another text by design: its text and why. */
  readonly legacy?: { readonly text: string; readonly why: string };
}

const FORMS: readonly Form[] = [
  {
    form: "a literal: the type member through typeKey",
    source: "let x = 1\nexit",
    fact: { value: "1", kind: "numberLiteral" },
    view: "known",
    exported: "integer",
  },
  {
    form: "an initializer: an object over its property cells, one of them a collection over its element cell",
    source: 'let o = {b: [1, 2.5], a: "s"}\nexit',
    fact: { binding: "o" },
    view: "known",
    exported: '{"a":string,"b":list<number>}',
  },
  {
    form: "a written union: the bound's members",
    source: "let x: (integer | null) = null\nexit",
    fact: { binding: "x" },
    view: "bound",
    exported: "(integer|null)",
  },
  {
    form: "a written collection: the bound over its element",
    source: "let xs: integer[] = []\nexit",
    fact: { binding: "xs" },
    view: "bound",
    exported: "list<integer>",
  },
  {
    form: "a restricted value: its values as typeKey writes them in detail",
    source: 'let c = askChoice "a", "b"\nexit',
    fact: { value: 'askChoice "a", "b"', kind: "interactionExpression" },
    view: "known",
    exported: 'string{"a"|"b"}',
  },
  {
    form: "a null-only variable",
    source: "let x = null\nexit",
    fact: { binding: "x" },
    view: "nullOnly",
    exported: "(?|null)",
  },
  {
    form: "a null-only element",
    source: "let xs = [null]\nexit",
    fact: { binding: "xs" },
    view: "known",
    exported: "list<(?|null)>",
  },
  {
    form: "a null-only expression value: not a place that stores decide",
    source: "let x = null\nexit",
    fact: { value: "null", kind: "nullLiteral" },
    view: "nullOnly",
    exported: "null",
  },
  {
    form: "a null-only function result: not a place that stores decide",
    source: 'function f {\n  say "x"\n}\nexit',
    fact: { result: "f" },
    view: "nullOnly",
    exported: "null",
  },
  {
    form: "a value the compiler cannot know only",
    source: 'let j = fromJson("1")\nexit',
    fact: { binding: "j" },
    view: "unknown",
    exported: "unknown",
  },
  {
    form: "a held JSON value: the text followed by !",
    source: 'let xs = []\nxs.add(fromJson("1"))\nxs.add(1)\nexit',
    fact: { binding: "xs" },
    view: "known",
    exported: "list<integer!>",
  },
  {
    form: "a held optional cell: the text with null, then !",
    source: 'let xs = []\nxs.add(null)\nxs.add(fromJson("1"))\nxs.add(1)\nexit',
    fact: { binding: "xs" },
    view: "known",
    exported: "list<(integer|null)!>",
  },
  {
    form: "a conflict: its working members, not its families",
    source: 'let x = 1\nx = "s"\nexit',
    fact: { binding: "x" },
    view: "conflict",
    exported: "integer",
  },
  {
    form: "a cycle through one cell, cut where the walk meets it again",
    source: "let a = []\na.add(a)\nexit",
    fact: { binding: "a" },
    view: "known",
    exported: "list<list<?>>",
  },
  {
    form: "a cycle through two cells, outer holder",
    source: "let a = []\nlet b = [a]\na.add(b)\nexit",
    fact: { binding: "a" },
    view: "known",
    exported: "list<list<list<?>>>",
  },
  {
    form: "a cycle through two cells, inner holder",
    source: "let a = []\nlet b = [a]\na.add(b)\nexit",
    fact: { binding: "b" },
    view: "known",
    exported: "list<list<?>>",
  },
  {
    form: "a cell that holds nothing",
    source: "function f {\n  return f()\n}\nexit",
    fact: { result: "f" },
    view: "never",
    exported: "never",
    legacy: {
      text: "unknown",
      why: "a recursion with no other return holds nothing (work note §3.5, §5); the legacy's result is unknown",
    },
  },
  {
    form: "the legacy's second null-only form",
    source: "let xs = []\nxs.add(null)\nexit",
    fact: { binding: "xs" },
    view: "known",
    exported: "list<(?|null)>",
    legacy: { text: "list<?null>", why: "one null-only form (work note §3.7)" },
  },
  {
    form: "a literal part that no store reaches",
    source: "let xs = []\nexit",
    fact: { binding: "xs" },
    view: "known",
    exported: "list<never>",
    legacy: {
      text: "list<?>",
      why: "empty by construction (work note §3.2, §3.5); the legacy keeps an undecided slot",
    },
  },
  {
    form: "a held optional variable",
    source: 'let x = null\nx = fromJson("1")\nx = 1\nexit',
    fact: { binding: "x" },
    view: "known",
    exported: "(integer|null)!",
    legacy: {
      text: "(integer!|null)",
      why: "the held mark is the cell's; the legacy marks the slot it keeps beside null in a union",
    },
  },
  {
    form: "a value the compiler cannot know after a known one",
    source: 'let x = 1\nx = fromJson("1")\nexit',
    fact: { binding: "x" },
    view: "known",
    exported: "integer!",
    legacy: {
      text: "integer",
      why: "held whatever the order (Q3.2a); the legacy marks only a slot still undecided when the value came",
    },
  },
  {
    form: "a value the compiler cannot know in a written type",
    source: 'let x: integer = 1\nx = fromJson("1")\nexit',
    fact: { binding: "x" },
    view: "bound",
    exported: "integer!",
    legacy: {
      text: "integer",
      why: "held whatever the kind; a written type is no slot in the legacy",
    },
  },
  {
    form: "a value the compiler cannot know beside null",
    source: 'let x = null\nx = fromJson("1")\nexit',
    fact: { binding: "x" },
    view: "unknown",
    exported: "unknown",
    legacy: {
      text: "(?!|null)",
      why: "a cell without a kind that holds such a value is unknown, which takes in null; the legacy keeps its slot",
    },
  },
  {
    form: "a null-only part of a literal value",
    source: "let xs = [null]\nexit",
    fact: { value: "[null]", kind: "listLiteral" },
    view: "known",
    exported: "list<(?|null)>",
    legacy: {
      text: "list<null>",
      why: "the literal's element cell is the variable's; only a value's own text is null",
    },
  },
];

test("the export writes each form as the legacy does where they agree by design, and both texts where not", () => {
  for (const form of FORMS) {
    const analysis = analyzed([form.source]);
    const exported = factOf(analysis, analysis.facts, form.fact);
    const legacy = factOf(analysis, analysis.legacy, form.fact);
    assert.equal(analysis.solution.view(exported.place).kind, form.view, `${form.form}: view`);
    assert.equal(exported.text, form.exported, `${form.form}: export`);
    assert.equal(
      legacy.text,
      form.legacy?.text ?? form.exported,
      `${form.form}: legacy${form.legacy === undefined ? "" : ` (${form.legacy.why})`}`,
    );
  }
});

test("the facts are sorted as the legacy sorts them, over files, function bodies and host globals", () => {
  const analysis = analyzed(
    [
      'function f(p = 1) {\n  let inner = p\n  return inner\n}\nlet x = f()\nlet h = hostValue\ngoto "file1.tease"',
      "let z = [3]\nexit",
    ],
    ["hostValue"],
  );
  const { facts, legacy } = analysis;
  // The graph makes a function's places after the code around it, so the order is the sort's, not the walk's.
  const walked = analysis.solution.graph.places.flatMap((place) =>
    place.kind.kind === "value" && place.site !== null ? [place.site] : [],
  );
  assert.notDeepEqual(walked, [...walked].sort(compareSites), "the places are not in site order");
  // The types are the solver's; the order and the declarations are the legacy's.
  const declared = (list: SolvedTypeFacts["bindings"]): readonly string[] =>
    list.map(({ site, kind, name }) => `${compactSite(site)} ${kind} ${name}`);
  assert.deepEqual(declared(facts.bindings), declared(legacy.bindings));
  const valued = (list: SolvedTypeFacts["values"]): readonly string[] =>
    list.map(({ site, kind }) => `${compactSite(site)} ${kind}`);
  assert.deepEqual(valued(facts.values), valued(legacy.values));
  // A read of a host global resolves to no declaration.
  assert.deepEqual(facts.reads, legacy.reads);
  assert.ok(facts.reads.some((read) => read.name === "hostValue" && read.binding === null));
  // A parameter's type is its default's; the body accepts the parameter's cell.
  assert.deepEqual(facts.functions, legacy.functions);
  assert.deepEqual(facts.functions[0]!.accepted, ["integer"]);
});

test("a cycle exports a finite type, the cut cell as the legacy's undecided slot", () => {
  const analysis = analyzed(["let a = []\na.add(a)\nexit"]);
  const types = exportTypes(analysis.solution);
  const binding = factOf(analysis, analysis.facts, { binding: "a" });
  const outer = types(binding.place).type;
  assert.ok(outer.kind === "list");
  assert.ok(outer.element.kind === "list");
  assert.equal(outer.element.element.kind, "unknown");
  // The element cell holds a list over itself: its own export is cut one level down.
  const member = analysis.solution.view(binding.place).members[0];
  assert.ok(member?.kind === "collection");
  assert.equal(types(member.element).text, "list<?>");
  // The literal and both reads hold the same cells and export the same text as the legacy.
  const texts = (facts: SolvedTypeFacts): readonly string[] =>
    facts.values.filter((fact) => fact.kind !== "callExpression").map((fact) => fact.type);
  assert.deepEqual(texts(analysis.facts), ["list<list<?>>", "list<list<?>>", "list<list<?>>"]);
  assert.deepEqual(texts(analysis.facts), texts(analysis.legacy));
});

test("a cell is exported once, and every place that holds it shares its type", () => {
  const analysis = analyzed(["let xs = [[1]]\nlet n = xs.length\nexit"]);
  const types = exportTypes(analysis.solution);
  const binding = factOf(analysis, analysis.facts, { binding: "xs" });
  const literal = factOf(analysis, analysis.facts, { value: "[[1]]", kind: "listLiteral" });
  const read = factOf(analysis, analysis.facts, {
    value: "xs",
    at: "xs.length",
    kind: "identifier",
  });
  // The literal, the variable it starts, and a read of the variable hold the literal's cells: one type object.
  const outer = types(binding.place).type;
  assert.equal(types(literal.place).type, outer);
  assert.equal(types(read.place).type, outer);
  const member = analysis.solution.view(binding.place).members[0];
  assert.ok(member?.kind === "collection");
  assert.ok(outer.kind === "list");
  assert.equal(outer.element, types(member.element).type);
  assert.equal(binding.text, "list<list<integer>>");
  assert.equal(read.text, binding.text);
});

test("speakers and storage keys are grouped and sorted as the legacy sorts them", () => {
  // The collector makes no speaker property, storage key or load view with a view of its own before stage 3c, so the
  // graph is written here: each place gets its type from a `has`, the loads that declare the key from a `load`.
  const site = (start: number): SourceSite => ({ file: 0, start, end: start + 1 });
  const integer: TypeTerm = { kind: "atom", name: "integer" };
  // Each place with its site, if it has one, and the type a `has` gives it.
  const places: readonly (readonly [PlaceKind, number | null, TypeTerm | null])[] = [
    [{ kind: "speakerProperty", speaker: "vera", name: "score" }, null, integer],
    [
      { kind: "speakerProperty", speaker: "vera", name: "mood" },
      null,
      { kind: "atom", name: "string" },
    ],
    [{ kind: "speakerProperty", speaker: "ada", name: "level" }, null, integer],
    [{ kind: "storageKey", key: "level" }, null, integer],
    [{ kind: "loadView", key: "level" }, 30, integer],
    [{ kind: "loadView", key: "level" }, 10, integer],
    [{ kind: "storageKey", key: "coins" }, null, integer],
    [{ kind: "loadView", key: "coins" }, 20, integer],
    [{ kind: "value", node: "loadExpression" }, 40, null],
  ];
  const origin: Origin = { site: site(0), role: "load", region: { kind: "file", file: 0 } };
  const graph: ConstraintGraph = {
    files: ["main.tease"],
    places: places.map(([kind, start], id) => ({
      id,
      site: start === null ? null : site(start),
      label: `@${id}`,
      kind,
    })),
    functions: [],
    handlers: [],
    constraints: [
      ...places.flatMap(([, , type], place): Constraint[] =>
        type === null ? [] : [{ ...origin, kind: "has", place, type }],
      ),
      // The load whose view is at 10 declares the key's type by its receiver.
      {
        ...origin,
        kind: "load",
        key: "level",
        view: 5,
        receiver: integer,
        fallback: null,
        result: 8,
      },
    ],
  };
  const facts = exportFacts(solve(graph, { relations, verify: true }));
  assert.deepEqual(facts.speakers, [
    { name: "ada", properties: [{ name: "level", type: "integer" }] },
    {
      name: "vera",
      properties: [
        { name: "mood", type: "string" },
        { name: "score", type: "integer" },
      ],
    },
  ]);
  assert.deepEqual(facts.storage, [
    {
      key: "coins",
      type: "integer",
      declared: false,
      loads: [{ site: site(20), type: "integer", declared: false }],
    },
    {
      key: "level",
      type: "integer",
      declared: true,
      loads: [
        { site: site(10), type: "integer", declared: true },
        { site: site(30), type: "integer", declared: false },
      ],
    },
  ]);
  assert.deepEqual(facts.uncheckedProperties, []);
});

function compactSite(site: SourceSite): string {
  return `${site.file}:${site.start}-${site.end}`;
}

function compareSites(left: SourceSite, right: SourceSite): number {
  return left.file - right.file || left.start - right.start || left.end - right.end;
}
