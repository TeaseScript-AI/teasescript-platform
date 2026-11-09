import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { Project, ts } from "ts-morph";

import type { CorePass } from "../../src/type-inference/core/answers.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { Consumers } from "../../src/type-inference/core/consumers.js";
import {
  heldAsIs,
  otherwiseKeeps,
  qualifiersOf,
  withContributions,
  withFlowCheck,
  type Contributions,
  type Qualifier,
} from "../../src/type-inference/core/contract/contributions.js";
import { withoutEmpty } from "../../src/type-inference/core/exact-path.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
  WorkLedger,
} from "../../src/type-inference/core/budget.js";
import { keyOf } from "../../src/type-inference/core/definitions.js";
import { makeItem, type Item } from "../../src/type-inference/core/items.js";
import { Solver, type Demand, type Work } from "../../src/type-inference/core/solver.js";
import { coreRecord } from "../../src/type-inference/core/result.js";
import { checkedResult } from "../../src/type-inference/core/check-result/check-result.js";
import { coreRequest } from "../helpers/type-core-analysis.js";
import { itemScope } from "../helpers/type-core-items.js";
import { MODES, inMode, type Mode } from "../helpers/type-core-oracles.js";

// #1668: which keys' answers a key's contract includes in a settled pass, recorded only where a pass asks for it.

const GLOBALS = ["hostValue", "hostOther"];

/**
 * `source` analysed in `mode`, recording contributions where `record`: its passes and its answers; each published
 * slot given to `onPublish` with its pass's total work as it is published.
 */
function analysed(
  source: string,
  mode: Mode,
  record: boolean,
  onPublish?: (slot: string, total: number) => void,
) {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const passes: CorePass[] = [];
  const check = Consumers.prototype.check;
  // (the ledger charged last: the publishing pass's)
  const charge = WorkLedger.prototype.charge;
  let ledger: WorkLedger | null = null;
  WorkLedger.prototype.charge = function (this: WorkLedger, ...args) {
    // oxlint-disable-next-line typescript/no-this-alias -- EVIDENCE: fixture: the test captures the ledger the charge ran on.
    ledger = this;
    charge.apply(this, args);
  };
  Consumers.prototype.check = function (this: Consumers) {
    passes.push(this.pass);
    check.call(this);
  };
  try {
    const solve = () => inMode(mode, () => analyseCore(request));
    const run =
      onPublish === undefined
        ? solve
        : () => withFlowCheck((slot) => onPublish(slot, ledger!.total), solve);
    const answers = record ? withContributions(run) : run();
    return { answers, request, pass: passes.at(-1)!, passes };
  } finally {
    Consumers.prototype.check = check;
    WorkLedger.prototype.charge = charge;
  }
}

/** The edges of the key `name.path` in the pass, as `contract|place.path` texts, sorted; or why there are none. */
function edges(
  pass: CorePass,
  name: string,
  path: readonly string[] = [],
): string | readonly string[] {
  const { program } = pass;
  const place = program.places.findIndex((at) => at?.label === name);
  assert.ok(place >= 0, name);
  const found: Contributions = pass.contract.contributions(keyOf(place, path));
  if (found.state === "unavailable") return found.reason;
  return found.edges
    .map((edge) => {
      const key = edge.slot!.slice(2);
      const [at, ...steps] = key.split("|");
      const label = program.places[Number(at)]?.label ?? at;
      return [label, ...steps.filter((step) => step !== "")].join(".");
    })
    .sort();
}

test("a pass that asks for none records none, and recording changes no answer, demand or stop", () => {
  const sources = [
    'let a = 1\nlet b = a\nlet c = b\nsay "${c}"\nexit\n',
    'let a = {p: {f: 1}}\nlet b = a\nb.p.f = hostValue\nsay "${b.p.f}"\nexit\n',
    'let typed: integer | string = 1\nlet x = [{q: typed}, {q: 2}][0]\nsay "${x.q}"\nexit\n',
  ];
  for (const source of sources)
    for (const mode of MODES) {
      const off = analysed(source, mode, false);
      const name = source.includes("let a") ? "a" : "x";
      assert.equal(edges(off.pass, name), "the pass records none");
      const on = analysed(source, mode, true);
      const projected = (run: typeof off) => ({
        outcome: run.answers.outcome,
        record: JSON.stringify(coreRecord(checkedResult(run.answers, run.request), ["main.tease"])),
        demands: JSON.stringify([run.answers.budget.demands, run.answers.budget.decisions]),
      });
      assert.deepEqual(projected(on), projected(off), source);
      // (each inclusion recorded is charged as shared work: the total grows by at least one unit each, no demand's
      // allowance by any)
      let inclusions = 0;
      withFlowCheck(
        (_slot, flow) => (inclusions += flow.length),
        () => analysed(source, mode, true),
      );
      assert.ok(inclusions > 0, source);
      assert.ok(on.answers.budget.total - off.answers.budget.total >= inclusions, source);
    }
});

test("each key's edges are the keys its contract includes: copies, written places, projections, selections, defaults", () => {
  // (each hand-derived from the source: what the key's answer takes from another key, through the literal, operation,
  // projection and default slots on the way; a key read only to decide (a receiver, a written type's marks) is no edge)
  const cases: readonly (readonly [
    string,
    readonly (readonly [string, readonly string[], string | readonly string[]])[],
  ])[] = [
    [
      'let a = 1\nlet b = a\nlet c = b\nsay "${c}"\nexit\n',
      [
        ["b", [], ["a"]],
        ["c", [], ["b"]],
        ["a", [], []],
      ],
    ],
    // (a written place's contract is its written type: its stores give marks only)
    [
      'let typed: integer | string = 1\nlet x: integer | string = typed\nsay "${x}"\nexit\n',
      [["x", [], []]],
    ],
    // (a whole copy of a literal's property: the literal's own items, no key's)
    [
      'let a = {p: 1}\nlet b = a\nsay "${b.p}"\nexit\n',
      [
        ["b", ["p"], []],
        ["b", [], ["a"]],
      ],
    ],
    // (a property read stored in a literal: the read key's property)
    [
      'let a = {p: {f: 1}}\nlet b = {q: a.p}\nsay "${b.q.f}"\nexit\n',
      [
        ["b", ["q"], ["a.p"]],
        ["b", ["q", "f"], ["a.p.f"]],
      ],
    ],
    // (a selection: each option's key at the path)
    [
      'let typed: integer | string = 1\nlet y = {q: 2}\nlet x = [{q: typed}, y][0]\nsay "${x.q}"\nexit\n',
      [
        ["x", ["q"], ["typed", "y.q"]],
        ["x", [], ["y"]],
      ],
    ],
    // (`otherwise`: both sides; `get`: the element and the default)
    [
      'let a = {f: 1}\nlet b = hostValue otherwise a\nsay "${b.f}"\nexit\n',
      [
        ["b", [], ["a", "hostValue"]],
        ["b", ["f"], ["a.f", "hostValue.f"]],
      ],
    ],
    [
      'let typed: integer | string = 1\nlet d = {f: typed}\nlet xs = [d]\nlet g = xs.get(0, default: {f: 2})\nsay "${g.f}"\nexit\n',
      [
        ["g", [], ["xs.element"]],
        ["g", ["f"], ["xs.element.f"]],
      ],
    ],
    // (a load's default that reads a variable reads it at the call (F18), by the value side's walk, which
    // records no flow: no edges, never none; a `null` default none)
    [
      'let d = {f: 1}\nlet v = load("k", default: d)\nsay "${v.f}"\nexit\n',
      [
        ["v", [], "exact records no flow"],
        ["v", ["f"], "exact records no flow"],
      ],
    ],
    ['let v = load("k", default: null)\nsay "${v}"\nexit\n', [["v", [], []]]],
    // (a default or an `otherwise` side whose items the choice or the filter removes whole: none of its keys)
    ['let a = null\nlet b = load("k", default: a)\nsay "${b}"\nexit\n', [["b", [], []]]],
    ['let a = null\nlet b = a otherwise 1\nsay "${b}"\nexit\n', [["b", [], []]]],
    // (an object's own selection replaces its elements: no key of them)
    ['let a = {p: 1}\nlet b = a.first\nsay "${b}"\nexit\n', [["b", [], []]]],
    // (a length, an iteration and two methods' results of an unknown value: the value's unknown, so its key)
    ['let a = hostValue\nlet b = a.length\nsay "${b}"\nexit\n', [["b", [], ["a"]]]],
    ['let a = hostValue\nfor b in a {\n  say "${b}"\n}\nexit\n', [["b", [], ["a"]]]],
    ['let a = hostValue\nlet b = a.remove("k")\nsay "${b}"\nexit\n', [["b", [], ["a"]]]],
    ['let a = hostValue\nlet b = a.startsWith("k")\nsay "${b}"\nexit\n', [["b", [], ["a"]]]],
    // (an element an empty collection holds none of, which the selection removes: no key of it; a held one's its key)
    ['let a = []\nlet b = a.get(0, default: 1)\nsay "${b}"\nexit\n', [["b", [], []]]],
    ['let a = []\nfor b in a {\n  say "${b}"\n}\nexit\n', [["b", [], []]]],
    ['let a = dict {}\nlet b = a.remove("k")\nsay "${b}"\nexit\n', [["b", [], []]]],
    [
      'let a = dict {"k": hostValue}\nlet b = a.remove("k")\nsay "${b}"\nexit\n',
      [["b", [], ["a.element"]]],
    ],
    // (filters below a composition: a slot whose answer the path's filters remove whole is no edge, with all below it;
    // one they remove in part stays)
    [
      'let n = null\nlet v = 1\nlet b = [v].get(0, default: n) otherwise 2\nsay "${b}"\nexit\n',
      [["b", [], ["v"]]],
    ],
    [
      'let e = []\nlet v = [hostValue]\nfor b in [e.first, v.first] {\n  say "${b}"\n}\nexit\n',
      [["b", [], ["v.element"]]],
    ],
    [
      'let e = []\nlet v = [hostValue]\nlet b = [e.first, v.first].get(0, default: 0)\nsay "${b}"\nexit\n',
      [["b", [], ["v.element"]]],
    ],
    [
      'let e = []\nlet v = [hostValue]\nlet b = dict {"e": e.first, "v": v.first}.remove("v")\nsay "${b}"\nexit\n',
      [["b", [], ["v.element"]]],
    ],
    [
      'let a = []\nlet b = []\nb.add(a.first)\nfor x in b {\n  say "${x}"\n}\nexit\n',
      [["b", ["element"], []]],
    ],
    [
      'let a = [hostValue]\nlet b = []\nb.add(a.first)\nfor x in b {\n  say "${x}"\n}\nexit\n',
      [["b", ["element"], ["a.element"]]],
    ],
    // (two filters deep: the element's `empty` and the `otherwise` side's null each drop their own slot)
    [
      'let n = null\nlet e = []\nlet v = 1\nlet b = [e.first, v, n].get(0, default: 3) otherwise 2\nsay "${b}"\nexit\n',
      [["b", [], ["v"]]],
    ],
    // (a slot the filters remove in part: its surviving items its own)
    [
      'let x = 1\nif hostValue is integer {\n  x = null\n}\nlet b = [x].get(0, default: 3) otherwise 2\nsay "${b}"\nexit\n',
      [["b", [], ["x"]]],
    ],
    // (a join drops its operands' `empty` where one of them holds an element: an operand holding only it is no edge;
    // where none holds one, each operand's emptiness is the join's)
    [
      'let a = []\nlet v = [1]\nlet b = a + v\nsay "${b.first}"\nexit\n',
      [["b", ["element"], ["v.element"]]],
    ],
    [
      'let a = []\nlet v = [1]\nlet b = v + a\nsay "${b.first}"\nexit\n',
      [["b", ["element"], ["v.element"]]],
    ],
    [
      'let a = []\nlet c = []\nlet b = a + c\nsay "${b.first}"\nexit\n',
      [["b", ["element"], ["a.element", "c.element"]]],
    ],
    // (a reader that holds only its receiver's unknowns: a slot of the receiver without one is no edge)
    [
      'let n = 1\nlet u = hostValue\nlet b = [n, u].get(0, default: 0).length\nsay "${b}"\nexit\n',
      [["b", [], ["u"]]],
    ],
    [
      'let n = 1\nlet u = hostValue\nlet b = [n, u].get(0, default: 0).remove("k")\nsay "${b}"\nexit\n',
      [["b", [], ["u"]]],
    ],
    [
      'let n = 1\nlet u = hostValue\nlet b = [n, u].get(0, default: 0).startsWith("k")\nsay "${b}"\nexit\n',
      [["b", [], ["u"]]],
    ],
    [
      'let n = 1\nlet u = hostValue\nfor b in [n, u].get(0, default: 0) {\n  say "${b}"\n}\nexit\n',
      [["b", [], ["u"]]],
    ],
    [
      'let n = 1\nlet u = hostValue\nlet b = [n, u].get(0, default: 0).values.first\nsay "${b}"\nexit\n',
      [["b", [], ["u"]]],
    ],
    // (below an unknown, its unknown: the unknown's key)
    ['let a = hostValue\nlet b = a.f\nsay "${b}"\nexit\n', [["a", ["f"], ["a"]]]],
  ];
  for (const mode of MODES)
    for (const [source, asks] of cases) {
      const { pass } = analysed(source, mode, true);
      for (const [name, path, expected] of asks)
        assert.deepEqual(
          edges(pass, name, path),
          typeof expected === "string" ? expected : [...expected].sort(),
          `${source}: ${name}.${path.join(".")}`,
        );
    }
});

// (a typed default's choice, which qualifies what its default's run includes, is the solver test's below: a literal
// default includes no key, and one that reads a key is the value side's walk, which records no flow, F18)
test("an inclusion keeps the transforms its answer went through: an `otherwise` side's null filter, a group's first entry", () => {
  const qualifiers = (pass: CorePass, name: string): readonly string[] => {
    const place = pass.program.places.findIndex((at) => at?.label === name);
    const found = pass.contract.contributions(keyOf(place, []));
    assert.equal(found.state, "complete");
    return found.state === "complete"
      ? found.edges.flatMap((edge) => qualifiersOf(edge.qualifiers))
      : [];
  };
  for (const mode of MODES) {
    const otherwise = analysed(
      'let a = {f: 1}\nlet b = hostValue otherwise a\nsay "${b.f}"\nexit\n',
      mode,
      true,
    ).pass;
    assert.ok(qualifiers(otherwise, "b").includes("operandFilter"));
    // (a level group read by its first entry, where the sharing groups them: the group's writer on it)
    if (mode.unshared) continue;
    const selected = analysed(
      'let typed: integer | string = 1\nlet y = {q: 2}\nlet x = [{q: typed}, y][0]\nsay "${x.q}"\nexit\n',
      mode,
      true,
    ).pass;
    const place = selected.program.places.findIndex((at) => at?.label === "x");
    const found = selected.contract.contributions(keyOf(place, ["q"]));
    assert.ok(
      found.state === "complete" &&
        found.edges.some((edge) => qualifiersOf(edge.qualifiers).includes("groupFirst")),
      JSON.stringify(found),
    );
  }
});

test("a declined summary includes none of its sources; a taken one includes them as its own", () => {
  // (a whole copy's property read over its stores: summarised where its one source's answer is plain, read by itself
  // where it holds a called item. Hand-derived, `b.g`'s own flow is `a`'s literal at `g` and the store `a.g = …`
  // read once: through the summary where it is taken, by itself where it declines)
  const declined =
    'function f {\n  return hostValue\n}\nlet a = {g: 1}\na.g = f()\nlet b = a\nsay "${b.g}"\nexit\n';
  const taken = 'let a = {g: 1}\na.g = 2\nlet b = a\nsay "${b.g}"\nexit\n';
  for (const mode of MODES)
    for (const [source, store] of [
      [declined, "sub"],
      [taken, "sub summary"],
    ] as const) {
      const { pass } = analysed(source, mode, true);
      const place = pass.program.places.findIndex((at) => at?.label === "b");
      const flow = pass.solver.flowOf(`c|${keyOf(place, ["g"])}`);
      assert.ok(flow !== undefined, source);
      const routes = flow.map((inclusion) =>
        [inclusion.route, ...inclusion.qualifiers.filter((q) => q === "summary")].join(" "),
      );
      assert.deepEqual(routes, ["literal", store], source);
    }
});

test("a snapshot charges each slot it visits, each inclusion it follows and each filter it checks", () => {
  // (the charge counted from the published flows and answers the snapshot walks: a slot visited one step, an inclusion
  // followed one unit and one per qualifier of its own, a filter on its path one unit and one per item of the slot's
  // answer it checks; an edge keeps its path's last link, shared, for nothing more)
  const filtered = (qualifiers: readonly Qualifier[], items: readonly Item[]): readonly Item[] => {
    let kept = qualifiers.includes("withoutEmpty") ? withoutEmpty(items) : items;
    if (qualifiers.includes("operandFilter")) kept = kept.filter(otherwiseKeeps);
    if (qualifiers.includes("unknown") || qualifiers.includes("belowReceiver"))
      kept = kept.filter(heldAsIs);
    return kept;
  };
  const filtering: readonly Qualifier[] = [
    "withoutEmpty",
    "operandFilter",
    "unknown",
    "belowReceiver",
  ];
  const wide = (n: number) =>
    `${Array.from({ length: n }, (_, at) => `let a${at} = hostValue`).join("\n")}\nlet b = a0\n${Array.from({ length: n - 1 }, (_, at) => `b = a${at + 1}`).join("\n")}\nsay "\${b}"\nexit\n`;
  const sources = [
    wide(8),
    wide(32),
    'let n = null\nlet v = 1\nlet b = [v].get(0, default: n) otherwise 2\nsay "${b}"\nexit\n',
    'let n = 1\nlet u = hostValue\nlet b = [n, u].get(0, default: 0).length\nsay "${b}"\nexit\n',
  ];
  let checks = 0;
  for (const mode of MODES)
    for (const source of sources) {
      const { pass } = analysed(source, mode, true);
      const place = pass.program.places.findIndex((at) => at?.label === "b");
      const start = `c|${keyOf(place, [])}`;
      let expected = 0;
      const seen = new Set<string>();
      const todo: { readonly slot: string; readonly qualifiers: readonly Qualifier[] }[] = [
        { slot: start, qualifiers: [] },
      ];
      for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
        expected += 1;
        for (const inclusion of pass.solver.flowOf(next.slot) ?? []) {
          expected += 1 + inclusion.qualifiers.length;
          const qualifiers = [...next.qualifiers, ...inclusion.qualifiers];
          if (qualifiers.some((qualifier) => filtering.includes(qualifier))) {
            const answer = pass.solver.answer(inclusion.slot!)!;
            expected += 1 + answer.length;
            checks += 1;
            if (filtered(qualifiers, answer).length === 0) continue;
          }
          if (inclusion.slot!.startsWith("c|")) continue;
          if (!seen.has(`${inclusion.slot} ${qualifiers.join(",")}`)) {
            seen.add(`${inclusion.slot} ${qualifiers.join(",")}`);
            todo.push({ slot: inclusion.slot!, qualifiers });
          }
        }
      }
      const before = pass.program.work.total;
      assert.equal(typeof edges(pass, "b"), "object", source);
      assert.equal(pass.program.work.total - before, expected, source);
    }
  assert.ok(checks > 0, `${checks} filter checks`);
});

test("a snapshot's cost grows with its edges, not with their paths' lengths", () => {
  // (Astra r1 on #1723: a chain of `otherwise` over one key reaches it once per level, the level's path one
  // `operandFilter` longer than the one above, so a snapshot copying each edge's path costs the square of the chain's
  // length; one sharing the paths costs as many units per level at 128 levels as at 16, give or take the fixed part)
  const cost = (n: number) => {
    let chain = "v0";
    for (let at = 1; at < n; at += 1) chain = `(${chain} otherwise v0)`;
    const { pass } = analysed(
      `let v0 = hostValue\nlet b = ${chain}\nsay "\${b}"\nexit\n`,
      MODES[0]!,
      true,
    );
    const before = pass.program.work.total;
    const found = edges(pass, "b");
    assert.ok(typeof found !== "string" && found.length === n, String(found));
    return pass.program.work.total - before;
  };
  const [short, long] = [cost(16), cost(128)];
  assert.ok(long / 128 < (short / 16) * 1.25, `${short} units at 16, ${long} at 128`);
});

test("a decision's copy of its run's flow is charged with its qualifiers", () => {
  // (a decided demand whose run includes one slot: its sink's inclusion one unit, the decision's qualified copy two;
  // nothing else of the run differs with recording on)
  const units = (record: boolean): number => {
    const scope = itemScope();
    const solve = () => {
      const solver = new Solver(scope);
      const read: Demand = {
        key: "read",
        kind: "value",
        file: 0,
        offset: 0,
        make: function* (): Work<readonly Item[]> {
          return [makeItem("integer")];
        },
      };
      const decided: Demand = {
        key: "decided",
        kind: "value",
        file: 0,
        offset: 1,
        make: function* (): Work<readonly Item[]> {
          solver.sink()?.include(read.key, "value");
          return yield read;
        },
        decision: {
          choose: () => "own",
          answer: (_choice, input) => input,
          flow: (_choice, inclusions) =>
            inclusions.map((inclusion) => ({ ...inclusion, qualifiers: ["defaultChoice"] })),
        },
      };
      solver.run(
        (function* (): Work<readonly Item[]> {
          return yield decided;
        })(),
      );
      if (record) assert.equal(solver.flowOf("decided")?.[0]?.qualifiers[0], "defaultChoice");
    };
    if (record) withContributions(solve);
    else solve();
    return scope.work.total;
  };
  assert.equal(units(true) - units(false), 3);
});

test("a cycle of copies publishes each member's edges once its component is solved", () => {
  for (const mode of MODES) {
    const pass = analysed('let a = 1\nlet b = a\na = b\nsay "${a} ${b}"\nexit\n', mode, true).pass;
    assert.deepEqual(edges(pass, "a"), ["b"]);
    assert.deepEqual(edges(pass, "b"), ["a"]);
  }
});

test("every slot a run includes is one its run read", () => {
  const sources = [
    'let typed: integer | string = 1\nlet y = {q: 2}\nlet x = [{q: typed}, y][0]\nsay "${x.q}"\nexit\n',
    'let a = {p: {f: 1}}\nlet b = {q: a.p}\nlet c = b\nc.q = hostValue\nsay "${c.q.f}"\nexit\n',
    'let a = 1\nlet b = a\na = b\nsay "${a} ${b}"\nexit\n',
  ];
  let published = 0;
  for (const mode of MODES)
    for (const source of sources)
      withFlowCheck(
        (slot, inclusions, reads) => {
          published += 1;
          // (an answer kept outside the solver includes the slots its maker's run read: `kept`)
          for (const inclusion of inclusions)
            if (inclusion.slot !== null && inclusion.route !== "kept")
              assert.ok(reads.has(inclusion.slot), `${slot} includes ${inclusion.slot} unread`);
        },
        () => analysed(source, mode, true),
      );
  assert.ok(published > 20, `${published} flows published`);
});

test("every producing read in the contract layer passes a flow, follows an inclusion or is classified", () => {
  // (the inclusion matrix in code, by the type checker and symbol identity: every call in the contract layer whose
  // result is a `Work` of items or of items with a proof (`Item` itself, however aliased or spelled), unless it is the
  // solver's `inline` transfer of the read in its argument, and every yield of a demand, passes a sink (the layer's
  // `FlowSink`, or the run's `"run"`) at a sink parameter, follows `FlowSink.include` of the same key in its own
  // function, or carries its class (`// #1668: <class>`) on the line before or leading its statement)
  const project = new Project({
    tsConfigFilePath: join(process.cwd(), "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  const files = project.addSourceFilesAtPaths(
    join(process.cwd(), "src/type-inference/core/contract/*.ts"),
  );
  // (a fixture beside the layer, in memory: Astra r1's optional callback and Codex r9's whose `Work` is an
  // intersection inside the union (reads with no sink, which the check must report), each with its control with a
  // sink (which it must accept))
  const fixture = project.createSourceFile(
    join(process.cwd(), "src/type-inference/core/contract/gate-fixture.ts"),
    [
      'import type { PlaceId } from "../../graph.js";',
      'import type { Contract } from "../contract.js";',
      'import type { Item } from "../items.js";',
      'import type { Work } from "../solver.js";',
      'import type { FlowSink } from "./contributions.js";',
      "export function* optional(contract: Contract, place: PlaceId, host: boolean, flow: FlowSink | null): Work<readonly Item[]> {",
      "  const read = host ? contract.contractOfValue.bind(contract) : undefined;",
      "  const pending = read?.(place);",
      "  if (pending) return yield* pending;",
      "  const passed = read?.(place, flow);",
      "  if (passed) return yield* passed;",
      "  type Tagged = (value: PlaceId, sink?: FlowSink | null) => Work<readonly Item[]> & { tag?: string };",
      "  const tagged: Tagged | undefined = host ? contract.contractOfValue.bind(contract) : undefined;",
      "  const mixed = tagged?.(place);",
      "  if (mixed) return yield* mixed;",
      "  const sunk = tagged?.(place, flow);",
      "  if (sunk) return yield* sunk;",
      "  return [];",
      "}",
    ].join("\n"),
    { overwrite: true },
  );
  files.push(fixture);
  project.resolveSourceFileDependencies();
  const program = project.getProgram().compilerObject;
  const checker = program.getTypeChecker();
  const core = (name: string) =>
    program.getSourceFile(join(process.cwd(), "src/type-inference/core", name))!;
  // (the declarations the forms are bound to, by their symbols)
  const declared = (file: ts.SourceFile, name: string): ts.Symbol => {
    for (const statement of file.statements)
      if (
        (ts.isInterfaceDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isFunctionDeclaration(statement)) &&
        statement.name?.text === name
      )
        return checker.getSymbolAtLocation(statement.name)!;
    throw new Error(`no ${name}`);
  };
  const item = declared(core("items.ts"), "Item");
  const flowSink = declared(core("contract/contributions.ts"), "FlowSink");
  const include = flowSink.members!.get(ts.escapeLeadingUnderscores("include"))!;
  const inline = declared(core("solver.ts"), "inline");
  const bare = (expression: ts.Expression): ts.Expression => {
    let at = expression;
    while (
      ts.isParenthesizedExpression(at) ||
      ts.isNonNullExpression(at) ||
      ts.isAsExpression(at) ||
      ts.isSatisfiesExpression(at)
    )
      at = at.expression;
    return at;
  };
  const functionLike = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node);
  const ownerOf = (node: ts.Node): ts.Node | null => {
    for (let at = node.parent; at !== undefined; at = at.parent) if (functionLike(at)) return at;
    return null;
  };
  // (a type's constituents, through nested unions and intersections: an optional call's `Work | undefined`, a
  // `Work & {…}` inside one)
  const parts = (type: ts.Type): readonly ts.Type[] =>
    type.isUnion() || type.isIntersection() ? type.types.flatMap(parts) : [type];
  const original = (symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  // (a list of items: an array whose element is `Item`; or what holds one as its `items`)
  const items = (type: ts.Type): boolean =>
    parts(type).some((part) => {
      const element = checker.isArrayLikeType(part)
        ? checker.getIndexTypeOfType(part, ts.IndexKind.Number)
        : undefined;
      if (element !== undefined) return original(element.getSymbol()) === item;
      const held = part.getProperty("items");
      return held !== undefined && items(checker.getTypeOfSymbol(held));
    });
  // (a `Work`'s result: the generator's return type, `Work<T>` being a `Generator` of `T`)
  const resultOf = (type: ts.Type): ts.Type | undefined => {
    if (type.getSymbol()?.getName() !== "Generator" || !(type.flags & ts.TypeFlags.Object))
      return undefined;
    // EVIDENCE: the Object flag tested above marks the TypeScript checker's ObjectType.
    const object = type as ts.ObjectType;
    if ((object.objectFlags & ts.ObjectFlags.Reference) === 0) return undefined;
    // EVIDENCE: the Reference object flag tested above marks the checker's TypeReference.
    return checker.getTypeArguments(object as ts.TypeReference)[1];
  };
  const producing = (call: ts.CallExpression): ts.Signature | undefined => {
    const signature = checker.getResolvedSignature(call);
    if (signature === undefined) return undefined;
    const returned = [checker.getReturnTypeOfSignature(signature), checker.getTypeAtLocation(call)];
    return returned.some((type) =>
      parts(type).some((part) => {
        const result = resultOf(part);
        return result !== undefined && items(result);
      }),
    )
      ? signature
      : undefined;
  };
  // (the layer's sink, by its class's symbol, or the run's `"run"`)
  const sink = (type: ts.Type): boolean =>
    parts(type).some(
      (part) =>
        original(part.getSymbol()) === flowSink || (part.isStringLiteral() && part.value === "run"),
    );
  const declarationOf = (call: ts.CallExpression): ts.Symbol | undefined => {
    const declaration = checker.getResolvedSignature(call)?.getDeclaration();
    const name = declaration?.name;
    return name === undefined ? undefined : original(checker.getSymbolAtLocation(name));
  };
  // (a key's identity: an identifier's symbol, or `<receiver>.key`'s receiver)
  const ids = new Map<ts.Symbol, number>();
  const idOf = (symbol: ts.Symbol | undefined): string | undefined => {
    if (symbol === undefined) return undefined;
    if (!ids.has(symbol)) ids.set(symbol, ids.size);
    return String(ids.get(symbol));
  };
  const keyOfExpression = (expression: ts.Expression): string | undefined => {
    const at = bare(expression);
    if (ts.isPropertyAccessExpression(at) && at.name.text === "key") {
      const receiver = idOf(checker.getSymbolAtLocation(bare(at.expression)));
      return receiver === undefined ? undefined : `${receiver}.key`;
    }
    return ts.isIdentifier(at) ? idOf(checker.getSymbolAtLocation(at)) : undefined;
  };
  const unclassified: string[] = [];
  let reads = 0;
  for (const file of files) {
    const tree = program.getSourceFile(file.getFilePath())!;
    const source = tree.getFullText();
    const lines = source.split("\n");
    const lineOf = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
    const tagged = (node: ts.Node): boolean => {
      if (/^\s*(?:[?:]\s*)?\/\/ #1668:/.test(lines[lineOf(node) - 1] ?? "")) return true;
      for (let at: ts.Node = node; !ts.isBlock(at) && !ts.isSourceFile(at); at = at.parent) {
        const comments = ts.getLeadingCommentRanges(source, at.getFullStart()) ?? [];
        if (comments.some((range) => source.slice(range.pos, range.end).includes("#1668:")))
          return true;
        if (ts.isStatement(at)) return false;
      }
      return false;
    };
    // (every `FlowSink.include` call: its function, where it stands, its key)
    const includes: {
      readonly owner: ts.Node | null;
      readonly at: number;
      readonly key: string | undefined;
    }[] = [];
    const collect = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.arguments[0] !== undefined &&
        declarationOf(node) === include
      )
        includes.push({
          owner: ownerOf(node),
          at: node.getStart(tree),
          key: keyOfExpression(node.arguments[0]),
        });
      ts.forEachChild(node, collect);
    };
    collect(tree);
    // (a demand's key: its object's `key`, or a variable's initializer's; and `<demand>.key` itself)
    const keysOf = (expression: ts.Expression): string[] => {
      const at = bare(expression);
      if (ts.isObjectLiteralExpression(at)) {
        for (const property of at.properties) {
          if (ts.isShorthandPropertyAssignment(property) && property.name.text === "key") {
            const value = idOf(checker.getShorthandAssignmentValueSymbol(property));
            return value === undefined ? [] : [value];
          }
          if (ts.isPropertyAssignment(property) && property.name.getText(tree) === "key") {
            const value = keyOfExpression(property.initializer);
            return value === undefined ? [] : [value];
          }
        }
        return [];
      }
      if (!ts.isIdentifier(at)) return [];
      const own = idOf(checker.getSymbolAtLocation(at));
      const declaration = checker.getSymbolAtLocation(at)?.valueDeclaration;
      return [
        ...(own === undefined ? [] : [`${own}.key`]),
        ...(declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
          ? keysOf(declaration.initializer)
          : []),
      ];
    };
    const visit = (node: ts.Node): void => {
      let read: ts.Node | null = null;
      let passed = false;
      let keys: string[] = [];
      if (
        ts.isYieldExpression(node) &&
        node.asteriskToken === undefined &&
        node.expression !== undefined
      ) {
        const type = checker.getTypeAtLocation(node.expression);
        if (type.getProperty("make") !== undefined && type.getProperty("key") !== undefined) {
          read = node;
          keys = keysOf(node.expression);
        }
      } else if (ts.isCallExpression(node)) {
        const signature = producing(node);
        // (the solver's `inline` only transfers the read made in its argument: that call is the read)
        if (signature !== undefined && declarationOf(node) !== inline) {
          read = node;
          const parameters = signature.getParameters();
          passed = node.arguments.some((argument, at) => {
            const parameter = parameters[Math.min(at, parameters.length - 1)];
            if (parameter === undefined) return false;
            const given = checker.getTypeAtLocation(argument);
            return (
              sink(checker.getTypeOfSymbolAtLocation(parameter, node)) &&
              sink(given) &&
              !(given.flags & ts.TypeFlags.Null)
            );
          });
          const callee = bare(node.expression);
          const proved = node.arguments[0];
          if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "proven" &&
            proved !== undefined
          )
            keys = keysOf(proved);
        }
      }
      if (read !== null) {
        reads += 1;
        const owner = ownerOf(read);
        const start = read.getStart(tree);
        const included = includes.some(
          (one) =>
            one.owner === owner &&
            one.at < start &&
            one.key !== undefined &&
            keys.includes(one.key),
        );
        if (!passed && !included && !tagged(read))
          unclassified.push(
            `${file.getBaseName()}:${lineOf(read) + 1}: ${read.getText(tree).split("\n")[0]}`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.ok(reads > 150, `${reads} reads`);
  assert.deepEqual(unclassified, [
    "gate-fixture.ts:8: read?.(place)",
    "gate-fixture.ts:14: tagged?.(place)",
  ]);
});

test("a stop's forgotten answers take their flows with them; a flow stands only beside its answer", () => {
  // (decisions stopping at small demand allowances forget their keys and every reader: a flow left published for a
  // forgotten slot would claim complete edges no answer stands behind)
  const sources = [
    'let a = {p: {f: 1}}\nlet b = a\nb.p.f = hostValue\nlet c = [b, {p: {f: 2}}][0]\nsay "${c.p.f}"\nexit\n',
    'let typed: integer | string = 1\nlet y = {q: [typed]}\nlet x = [{q: [1]}, y][0]\nx.q.add(hostValue)\nsay "${x.q.length}"\nexit\n',
    // (#1646's rejected cell and `otherwise` witnesses, whose decisions stop at 256 in every mode: a stopped key's
    // answer forgotten and never made again)
    'let a={f:[[1]],q:1}\na.q=[{r:1},{r:a}][0].r\na=hostValue\nsay "AFTER"\nexit\n',
    "let a={f:[[1]],q:1}\na.q=a otherwise 1\na=hostValue\nexit\n",
  ];
  let checked = 0;
  for (const allowance of [1, 4, 16, 256])
    for (const mode of MODES)
      for (const source of sources) {
        const slots: string[] = [];
        const { pass } = withTestDemandAllowance(allowance, () =>
          withFlowCheck(
            (slot) => slots.push(slot),
            () => analysed(source, mode, true),
          ),
        );
        for (const slot of slots) {
          if (pass.solver.flowOf(slot) === undefined) continue;
          checked += 1;
          assert.ok(pass.solver.answer(slot) !== undefined, `${slot}: a flow without its answer`);
        }
      }
  assert.ok(checked > 50, `${checked} flows checked`);
});

test("a program stop at any slot's publication leaves no flow without its answer", () => {
  // (each published slot's total, and the unit before it, as the program's allowance: the stop falls on that slot's
  // own charges, a proof's kept slot among them)
  const source = 'let a = {p: {q: {f: 1}}}\nlet b = a.p\nlet c = b.q\nsay "${c.f}"\nexit\n';
  let stopped = 0;
  for (const mode of MODES) {
    const totals = new Set<number>();
    const natural = analysed(source, mode, true, (_slot, total) => totals.add(total));
    for (const total of totals)
      for (const allowance of [total - 1, total]) {
        const slots = new Set<string>();
        const run = withTestAllowance(allowance, () =>
          analysed(source, mode, true, (slot) => slots.add(slot)),
        );
        if (run.answers.outcome !== natural.answers.outcome) stopped += 1;
        for (const pass of run.passes)
          for (const slot of slots)
            if (pass.solver.flowOf(slot) !== undefined)
              assert.ok(pass.solver.answer(slot) !== undefined, `${slot} at ${allowance}`);
      }
  }
  assert.ok(stopped > 0, `${stopped} runs stopped`);
});
