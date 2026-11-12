// What a program publishes stands in one order in the four modes: its answers, a stopped answer's items and a composed
// list's kinds (#1398).

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../../src/type-inference/core/budget.js";
import { type Item } from "../../../src/type-inference/core/items.js";
import {
  type CoreAnalysisRequest,
  CoreProgram,
  propertyStep,
} from "../../../src/type-inference/core/program.js";
import { VALUE_KIND_NAMES } from "../../../src/value-kinds.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES, publication, stopSet } from "../../helpers/type-core-oracles.js";
import {
  type Program,
  one,
  GLOBALS,
  prepared,
} from "../../helpers/type-core/type-core-sharing-setup.js";

/**
 * #1398, #1299: a value's kinds stand in their fixed order (`mergeItems`), so what a program publishes, every
 * occurrence's answer with the order of its items included, is the same in the four modes. On `main` before, each
 * source here published another order in one mode: a copy ring whose cut a reversed walk meets elsewhere (#1398's
 * reduction of G5's `cut/s49`), its suggested test's kinds with it, and a list whose elements are added under a
 * condition, whose element read's `empty` the sharing placed first or last (#1299); two kind pairs each.
 */
const ORDER_WITNESSES: readonly Program[] = [
  ...[
    ['"x"', "integer", "1"],
    ["true", "string", '"y"'],
  ].map(([value, type, initial]) =>
    one(
      `a copy ring of ${value} and a written ${type}`,
      [
        `let bad = {p0: ${value}, p1: ${value}}`,
        "let host = hostValue",
        `let wint: ${type} = ${initial}`,
        `let wnull: ${type}? = null`,
        "let written = {p0: wint, p1: wnull}",
        "let a5 = bad",
        "let a4 = a5",
        "let a3 = a4",
        "let a2 = a3",
        "let a0 = written",
        "if a2 != null {",
        "  a3 = a2",
        "}",
        "a4 = a3",
        "a5 = a4",
        "a0 = a5",
        "a2 = a4",
        "a4 = a0",
        'say "${a2.p0}"',
        "a3 = host",
        "exit",
      ].join("\n"),
    ),
  ),
  ...[
    ["1", "2"],
    ["true", "1"],
  ].map(([first, second]) =>
    one(
      `elements ${first} and ${second} added under a condition`,
      [
        'let flag = askBoolean "go"',
        "let xs = []",
        "if flag {",
        `  xs.add(${first})`,
        `  xs.add(${second})`,
        "}",
        "say xs[0]",
        "exit",
      ].join("\n"),
    ),
  ),
];

test("what a program publishes, its answers' orders included, is the same in the four modes (#1398, #1299)", () => {
  const differing = ORDER_WITNESSES.flatMap(({ name, files }) => {
    const [first, ...others] = MODES.map((mode) => publication(files, mode, GLOBALS));
    return others.every((other) => other === first) ? [] : [name];
  });
  assert.deepEqual(differing, []);
  // (the suggested test names the kinds in the kinds' table order, whichever the source or the walk meets first)
  const { request } = prepared(ORDER_WITNESSES[0]!);
  for (const mode of MODES)
    assert.deepEqual(
      inMode(mode, () => analyseCore(request)).diagnostics.flatMap((diagnostic) =>
        diagnostic.code === "TSV042" && "fits" in diagnostic ? [diagnostic.fits] : [],
      ),
      [["integer", "string"]],
      JSON.stringify(mode),
    );
});

/**
 * #1398 (Astra r1 on #1558): a stopped answer takes the same fixed order. A null-defaulted load read beside a list
 * holding it, alone and beside a second load: at the test demand allowance 256 the reversed modes stop and answer from
 * the stopped sources (`CoreAnswers.#items`: the typed default's own shape), the source modes from the solver. In every
 * mode, at that allowance and at the natural one, each occurrence's items, its element's and its properties' stand in
 * the kinds' table order, then `unknown` and `empty`, whichever source answers.
 */
const STOPPED_ORDER_WITNESSES: readonly Program[] = [
  one(
    "a null-defaulted load beside a list holding it",
    'let a = load(hostValue, default: null)\nlet pair = [a]\nsay pair[0]\nsay pair[1].p\nsay a otherwise "fallback"\nexit\n',
  ),
  one(
    "two null-defaulted loads beside a list holding both",
    'let a = load(hostValue, default: null)\nlet b = load(hostOther, default: null)\nlet pair = [a,b]\nsay pair[0]\nsay pair[1].p\nsay a otherwise "fallback"\nexit\n',
  ),
];

test("a stopped answer's items stand in the kinds' table order too, in the four modes (#1398)", () => {
  const rank = new Map([...VALUE_KIND_NAMES, "unknown", "empty"].map((tag, index) => [tag, index]));
  const ordered = (items: readonly Item[]): boolean =>
    items.every(
      (item, index) => index === 0 || rank.get(items[index - 1]!.tag)! <= rank.get(item.tag)!,
    );
  const misordered: string[] = [];
  let stopped = 0;
  let lists = 0;
  for (const program of STOPPED_ORDER_WITNESSES) {
    const request = coreRequest(program.files, [...GLOBALS, "hostOther"]);
    assert.ok(request !== null, program.name);
    for (const allowance of [256, null])
      for (const mode of MODES) {
        const run = (): Answers => inMode(mode, () => analyseCore(request));
        const answers = allowance === null ? run() : withTestDemandAllowance(allowance, run);
        if (answers.budget.decisions.some((decision) => decision.stopped)) stopped += 1;
        for (const node of answers.graph.nodes) {
          const at = answers.at(node);
          if (at === null) continue;
          const tags = new Set(at.items.map((item) => item.tag));
          const each: (readonly Item[])[] = [
            at.items,
            ...(tags.has("list") ? [answers.project(node, "element")] : []),
            ...(tags.has("object") ? [...answers.properties(node).values()] : []),
          ];
          for (const items of each) {
            lists += 1;
            if (!ordered(items))
              misordered.push(
                `${program.name} ${JSON.stringify(mode)} ${allowance ?? "natural"} node ${node.id}: ${items.map((item) => item.tag).join(",")}`,
              );
          }
        }
      }
  }
  assert.deepEqual(misordered, []);
  assert.ok(stopped > 0, "a decision stops in some mode at the test allowance");
  assert.ok(lists > 100, `${lists} lists`);
});

/**
 * #1398 (Codex r3, r4 and r5 on #1558): a list of a value's kinds takes its one order where it is
 * completed (`inItsOrder`): a written spelling's where exactly one spelling covers every kind but `null`, `unknown` and
 * `empty`, else the table's then `unknown`. The rows: a receiver beside its contract's reference kinds, the `besides`
 * gathered from a site's other warnings, a warning's `fits` (a fixed table of what fits, the one list the rule leaves
 * to the table's order, D3), a sort's families (in its elements' order), a fallback's family beside its receiving union
 * (its rule, its check and the check's text), what two reads take together, a shown set's elements, one place's
 * decision after a stop (Codex r4), the sort's warning the stop defers at a test allowance, a literal's sorted elements
 * after a stop; a written parse's or load's elements, read and sorted (Codex r5), a written value beside an inferred
 * kind it spells (D2's coverage) or one it does not, two spellings joined and one spelling read twice, and a written
 * value in a literal's cell; after a stop, a literal of a typed parse, a sorted literal of a written value and a typed
 * load's written default. Each row's published lists in the four modes: a written type's spelling keeps its own (the
 * store rows' `[string, integer]`, a written type a decision borrows, one a fallback's receiving type only repeats),
 * and the sort's offending kind is the one its elements' order picks, deferred or not.
 */
const COMPOSED_ORDER_ROWS: readonly {
  readonly name: string;
  readonly source: string;
  readonly analyse?: (request: CoreAnalysisRequest) => Answers;
  readonly lists: (
    answers: Answers,
    request: CoreAnalysisRequest,
  ) => readonly (readonly string[])[];
  readonly expected: readonly string[];
}[] = (() => {
  // (each diagnostic of a rule, a budget stop set aside)
  const ruled = (answers: Answers) =>
    answers.diagnostics.flatMap((diagnostic) => ("rule" in diagnostic ? [diagnostic] : []));
  const warnings = (answers: Answers) =>
    ruled(answers).flatMap((diagnostic) =>
      diagnostic.class === "warning-runtime-check" ? [diagnostic] : [],
    );
  const receivers = (answers: Answers) =>
    warnings(answers).flatMap((warning) =>
      warning.provenance.detail.receiver === null ? [] : [warning.provenance.detail.receiver.kinds],
    );
  const sort = "let values: (string | integer)[] = hostValue\nvalues.sort()\nexit\n";
  const fallback =
    'let direct: string | integer = "s"\nif hostValue == 1 { direct = 1 }\n' +
    "let value: string | integer | duration = direct otherwise hostOther\nsay value\nexit\n";
  const fallbacks = (answers: Answers) =>
    warnings(answers).flatMap((warning) => (warning.rule.rule === "fallback" ? [warning] : []));
  const stopped = (request: CoreAnalysisRequest) => analyseCore(request).stoppedAt("work");
  // (the admitted decision of `box`'s `n` elements, borrowed from a written type or not)
  const decided =
    (inherited: boolean) =>
    (answers: Answers, request: CoreAnalysisRequest): readonly (readonly string[])[] => {
      const box = new CoreProgram(request).places.find(
        ({ kind }) => kind.kind === "binding" && kind.name === "box",
      )!.id;
      const { admitted } = answers.place(box, [propertyStep("n"), "element"]);
      return admitted.by === "decided" && admitted.inherited === inherited ? [admitted.kinds] : [];
    };
  const deferred = (answers: Answers) =>
    answers.budget.deferred.flatMap((warning) =>
      warning.rule.rule === "elements" ? [{ warning, families: warning.rule.families }] : [],
    );
  // (the items of the last `text` after `before` in `source`, or of its `step`)
  const readOf =
    (source: string, before: string, text: string, step?: "element") =>
    (answers: Answers): readonly (readonly string[])[] => {
      const start = source.lastIndexOf(before + text) + before.length;
      const node = answers.graph.nodes.find(
        (found) =>
          found.span?.start.offset === start && found.span.end.offset === start + text.length,
      );
      if (node === undefined) return [];
      const items =
        step === undefined ? (answers.at(node)?.items ?? []) : answers.project(node, step);
      return [items.map((item) => item.tag)];
    };
  // (a written type's admitted kinds at a path of a binding)
  const written =
    (name: string, path: readonly string[]) =>
    (answers: Answers, request: CoreAnalysisRequest): readonly (readonly string[])[] => {
      const place = new CoreProgram(request).places.find(
        ({ kind }) => kind.kind === "binding" && kind.name === name,
      )!.id;
      const { admitted } = answers.place(place, path);
      return admitted.by === "written" ? [admitted.kinds] : [];
    };
  const elements = (answers: Answers) =>
    warnings(answers).flatMap((warning) =>
      warning.rule.rule === "elements" ? [{ warning, families: warning.rule.families }] : [],
    );
  const parse = "let xs: (string | integer)[] = fromJson(hostValue)\nxs.sort()\nexit\n";
  const load = 'let xs: (string | integer)[] = load("k", default: [1])\nxs.sort()\nexit\n';
  const w = "let w: string | integer = fromJson(hostValue)\n";
  const union =
    "let w: (string | integer)[] | (string | integer)[] = fromJson(hostValue)\nsay w[0]\nexit\n";
  const narrowed =
    "let x = hostValue\nif x is string | integer {\n  let y = x\n  let a = [y, 1]\n  a.sort()\n}\nexit\n";
  const typedLiteral = "let ys: (string | integer)[] = [fromJson(hostValue), 1]\nsay ys[0]\nexit\n";
  return [
    {
      name: "a receiver beside its contract's reference kinds",
      source: "let alias: speaker? = null\nsay alias.uppercase()\nexit\n",
      lists: receivers,
      expected: ["speaker", "null"],
    },
    {
      name: "a host receiver beside its contract's reference kinds",
      source: "let alias: speaker? = hostValue\nsay alias.uppercase()\nexit\n",
      lists: receivers,
      expected: ["speaker", "unknown"],
    },
    {
      name: "a condition's other kinds at its site",
      // (its other kinds stored by handlers: a run the compiler does not prove, the warning, never the route rule's error,
      // AD-1 and X7)
      source:
        "let value: integer | string | duration | boolean = true\ntimer async 1 s { value = 1 }\n" +
        'timer async 2 s { value = "s" }\ntimer async 3 s { value = 1 s }\nif value {}\nexit\n',
      lists: (answers) =>
        warnings(answers).flatMap((warning) =>
          warning.kinds[0] === "integer" && warning.besides.length > 0 ? [warning.besides] : [],
        ),
      expected: ["string", "duration"],
    },
    {
      name: "a sort's fits where a domain stands in for host data",
      source: sort,
      lists: (answers) =>
        warnings(answers).flatMap((warning) =>
          warning.rule.rule === "elements" ? [warning.fits] : [],
        ),
      expected: ["integer", "string"],
    },
    {
      name: "a sort's families, in its elements' order",
      source: sort,
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.rule.rule === "elements" && diagnostic.rule.families.length > 0
            ? [diagnostic.rule.families]
            : [],
        ),
      expected: ["string", "number"],
    },
    {
      name: "a sort's offending kind, by its elements' own order",
      source: sort,
      lists: (answers) =>
        warnings(answers).flatMap((warning) =>
          warning.rule.rule === "elements" ? [warning.kinds] : [],
        ),
      expected: ["integer"],
    },
    {
      name: "toJson's fits where a domain stands in for host data",
      source: "let values: (string | regex | integer)[] = hostValue\nsay toJson(values)\nexit\n",
      lists: (answers) =>
        warnings(answers).flatMap((warning) =>
          warning.rule.rule === "json" ? [warning.fits] : [],
        ),
      expected: ["integer", "string"],
    },
    {
      name: "a fallback's family beside its receiving union",
      source: fallback,
      lists: (answers) =>
        fallbacks(answers).flatMap((warning) =>
          warning.rule.rule === "fallback"
            ? [
                warning.rule.type,
                warning.obligation.against,
                warning.obligation.on.split(" against ")[1]!.split("|"),
              ]
            : [],
        ),
      expected: ["integer", "number", "string", "duration"],
    },
    {
      name: "a fallback's family alone",
      source:
        'let direct: string | integer = "s"\nif hostValue == 1 { direct = 1 }\n' +
        "let value = direct otherwise false\nsay value\nexit\n",
      lists: (answers) =>
        fallbacks(answers).flatMap((warning) =>
          warning.rule.rule === "fallback" ? [warning.rule.type, warning.obligation.against] : [],
        ),
      expected: ["integer", "number", "string"],
    },
    {
      name: "what two reads take together",
      source:
        'let value = [] + "s"\nlet first: number = value\nlet second = value + 1\nsay second\nexit\n',
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.class === "compile-error" && diagnostic.expects?.takes
            ? [diagnostic.expects.takes]
            : [],
        ),
      expected: ["integer", "number"],
    },
    {
      name: "a shown set's elements",
      source:
        'let values: (string | integer | object) set = set["s"]\nif hostValue == 1 { values = set[1] }\n' +
        'say "${values}"\nexit\n',
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.rule.rule === "shown" && diagnostic.rule.elements.length > 0
            ? [diagnostic.rule.elements]
            : [],
        ),
      expected: ["string", "integer", "object"],
    },
    {
      name: "one place's decision after a stop",
      source: 'let box = {n: [1, "s"]}\nexit\n',
      analyse: stopped,
      lists: decided(false),
      expected: ["integer", "string"],
    },
    {
      name: "a written type a place's decision borrows after a stop",
      source: "let w: string | integer = 1\nlet box = {n: [w]}\nexit\n",
      analyse: stopped,
      lists: decided(true),
      expected: ["string", "integer"],
    },
    {
      name: "a written type a fallback's receiving type repeats",
      source: 'let value: string | integer = load("key", default: false)\nsay value\nexit\n',
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.rule.rule === "fallback" ? [diagnostic.rule.type] : [],
        ),
      expected: ["string", "integer"],
    },
    ...[40, 160].flatMap((allowance) => {
      const analyse = (request: CoreAnalysisRequest) =>
        withTestAllowance(allowance, () => analyseCore(request));
      return [
        {
          name: `a deferred sort's offending kind at the allowance ${allowance}`,
          source: sort,
          analyse,
          lists: (answers: Answers) => deferred(answers).map(({ warning }) => warning.kinds),
          expected: ["integer"],
        },
        {
          name: `a deferred sort's fits at the allowance ${allowance}`,
          source: sort,
          analyse,
          lists: (answers: Answers) => deferred(answers).map(({ warning }) => warning.fits),
          expected: ["integer", "string"],
        },
        {
          name: `a deferred sort's families at the allowance ${allowance}`,
          source: sort,
          analyse,
          lists: (answers: Answers) => deferred(answers).map(({ families }) => families),
          expected: ["string", "number"],
        },
      ];
    }),
    {
      name: "a literal's sorted elements after a stop",
      source: 'let ys = ["s", 1].sort()\nexit\n',
      analyse: (request) => withTestAllowance(40, () => analyseCore(request)),
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.rule.rule === "elements" ? [diagnostic.kinds] : [],
        ),
      expected: ["integer", "string"],
    },
    ...[
      ["parse", parse],
      ["load", load],
    ].flatMap(([how, source]) => [
      {
        name: `a written ${how}'s elements, read`,
        source: source!,
        lists: readOf(source!, "\n", "xs", "element"),
        expected: ["string", "integer", "empty"],
      },
      {
        name: `a written ${how}'s admitted elements`,
        source: source!,
        lists: written("xs", ["element"]),
        expected: ["string", "integer"],
      },
      {
        name: `a written ${how}'s sorted elements' offending kind`,
        source: source!,
        lists: (answers: Answers) => elements(answers).map(({ warning }) => warning.kinds),
        expected: ["integer"],
      },
      {
        name: `a written ${how}'s sorted elements' families`,
        source: source!,
        lists: (answers: Answers) => elements(answers).map(({ families }) => families),
        expected: ["string", "number"],
      },
      ...[40, 160].map((allowance) => ({
        name: `a written ${how}'s deferred sort's offending kind at the allowance ${allowance}`,
        source: source!,
        analyse: (request: CoreAnalysisRequest) =>
          withTestAllowance(allowance, () => analyseCore(request)),
        lists: (answers: Answers) => deferred(answers).map(({ warning }) => warning.kinds),
        expected: ["integer"],
      })),
    ]),
    {
      name: "a written value beside an inferred kind it spells",
      source: `${w}let xs = [1]\nxs.add(w)\nsay xs[0]\nexit\n`,
      lists: readOf(`${w}let xs = [1]\nxs.add(w)\nsay xs[0]\nexit\n`, "say ", "xs[0]"),
      expected: ["string", "integer"],
    },
    {
      name: "a written value beside a kind it does not spell",
      source: `${w}let x = w otherwise true\nsay x\nexit\n`,
      lists: readOf(`${w}let x = w otherwise true\nsay x\nexit\n`, "say ", "x"),
      expected: ["integer", "string", "boolean"],
    },
    {
      name: "two spellings of one union joined",
      source: `${w}let v: integer | string = fromJson(hostOther)\nlet xs = [w]\nxs.add(v)\nsay xs[0]\nexit\n`,
      lists: readOf(
        `${w}let v: integer | string = fromJson(hostOther)\nlet xs = [w]\nxs.add(v)\nsay xs[0]\nexit\n`,
        "say ",
        "xs[0]",
      ),
      expected: ["integer", "string"],
    },
    {
      name: "one spelling read from two written places",
      source: `${w}let u: string | integer = fromJson(hostOther)\nlet xs = [w]\nxs.add(u)\nsay xs[0]\nexit\n`,
      lists: readOf(
        `${w}let u: string | integer = fromJson(hostOther)\nlet xs = [w]\nxs.add(u)\nsay xs[0]\nexit\n`,
        "say ",
        "xs[0]",
      ),
      expected: ["string", "integer"],
    },
    {
      name: "a written value in a literal's cell",
      source: `${w}let xs = [w]\nsay xs[0]\nexit\n`,
      lists: readOf(`${w}let xs = [w]\nsay xs[0]\nexit\n`, "say ", "xs[0]"),
      expected: ["string", "integer"],
    },
    // (after a stop at the test allowance 16: a typed parse's written destination beside a whole number in a literal,
    // the literal's children's kinds, each once; a sorted literal of a written value and a whole number, its deferred
    // families; a typed load's default a written value, the stores' syntax decision)
    {
      name: "a stopped literal of a typed parse and a whole number",
      source: typedLiteral,
      analyse: (request) => withTestAllowance(16, () => analyseCore(request)),
      lists: readOf(typedLiteral, " = ", "[fromJson(hostValue), 1]", "element"),
      // (each child's kinds once, beside its sibling's, as a stopped literal's shape gives them)
      expected: ["string", "integer", "integer"],
    },
    {
      name: "a stopped sort of a literal of a written value and a whole number",
      source: `${w}[w, 1].sort()\nexit\n`,
      analyse: (request) => withTestAllowance(16, () => analyseCore(request)),
      lists: (answers) => deferred(answers).map(({ families }) => families),
      expected: ["string", "number"],
    },
    {
      name: "a stopped syntax decision of a typed load's written default",
      source: `${w}let x = load(hostOther, default: w)\nlet ys = [x, 1]\nys.sort()\nexit\n`,
      analyse: stopped,
      lists: (answers, request) => {
        const x = new CoreProgram(request).places.find(
          ({ kind }) => kind.kind === "binding" && kind.name === "x",
        )!.id;
        const { admitted } = answers.place(x, []);
        return admitted.by === "decided" ? [admitted.kinds] : [];
      },
      expected: ["string", "integer"],
    },
    // (Codex r8: after a stop at the test allowance 16, a sort of a placeless literal's element, #1581's cells)
    {
      name: "a stopped sort of a placeless literal's element",
      source: '["s", 1][0].sort()\nexit\n',
      analyse: (request) => withTestAllowance(16, () => analyseCore(request)),
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.code === "TSV043" ? [diagnostic.kinds] : [],
        ),
      expected: ["integer", "string"],
    },
    // (Codex r6: after a stop, an inferred range conversion's elements; a written union of one spelling twice; a
    // stored read a written type test narrows host data to, natural)
    {
      name: "a stopped range conversion's elements",
      source: "let a = (1..5).toList()\nsay a[0]\nexit\n",
      analyse: stopped,
      lists: readOf(
        "let a = (1..5).toList()\nsay a[0]\nexit\n",
        "= ",
        "(1..5).toList()",
        "element",
      ),
      expected: ["integer", "empty"],
    },
    {
      name: "a stopped parse of a written union of one spelling twice",
      source: union,
      analyse: (request) => withTestAllowance(16, () => analyseCore(request)),
      lists: readOf(union, "= ", "fromJson(hostValue)", "element"),
      expected: ["string", "integer", "empty"],
    },
    {
      name: "a stored read a written type test narrows",
      source: narrowed,
      lists: readOf(narrowed, "[", "y"),
      expected: ["string", "integer"],
    },
    {
      name: "a sort of a stored read a written type test narrows, its families",
      source: narrowed,
      lists: (answers) => elements(answers).map(({ families }) => families),
      expected: ["string", "number"],
    },
    {
      name: "a sort of a stored read a written type test narrows, its offending kind",
      source: narrowed,
      lists: (answers) => elements(answers).map(({ warning }) => warning.kinds),
      expected: ["integer"],
    },
  ];
})();

/**
 * #1398 (Codex r10 on #1558): a narrowed local read's exact class takes its narrowing once, from its read class
 * (`readClass`), which already holds it, so building it costs what it did before the mark: at the test demand allowance
 * 256, reversed with the sharing on, a guarded list of a narrowed written value and a boolean stops its elements' `n`
 * in the second pass and its elements in the third, as on main.
 */
test("a narrowed local read's class charges its narrowing once: a guarded list's stops at 256 (#1398)", () => {
  for (const [kind, value] of [
    ["integer", "3"],
    ["string", '"written"'],
  ]) {
    const source =
      `let written: integer | string = ${value}\nif written is ${kind} {\nlet a = {n: written}\n` +
      "let b = {n: true}\nlet xs = [a, b]\nsay xs[0].n\n}\nexit\n";
    const found = stopSet(
      [{ path: "main.tease", source }],
      { reversed: true, unshared: false },
      ["hostValue", "hostInit", "hostOther"],
      256,
    );
    assert.deepEqual(
      found?.stops,
      [
        [2, "xs", "element.n", 1],
        [3, "xs", "element", 1],
      ],
      kind,
    );
  }
});

test("a list composed of a value's kinds stands in their fixed order where it is completed, in the four modes (#1398)", () => {
  const wrong: string[] = [];
  for (const row of COMPOSED_ORDER_ROWS) {
    const request = coreRequest(
      [{ path: "main.tease", source: row.source }],
      [...GLOBALS, "hostOther"],
    );
    assert.ok(request !== null, row.name);
    for (const mode of MODES) {
      const lists = row.lists(
        inMode(mode, () => (row.analyse ?? analyseCore)(request)),
        request,
      );
      if (lists.length === 0) wrong.push(`${row.name} ${JSON.stringify(mode)}: none published`);
      for (const list of lists)
        if (JSON.stringify(list) !== JSON.stringify(row.expected))
          wrong.push(`${row.name} ${JSON.stringify(mode)}: ${list.join(",")}`);
    }
  }
  assert.deepEqual(wrong, []);
});
