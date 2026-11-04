import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { CorePass } from "../src/type-inference/core/answers.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { Consumers } from "../src/type-inference/core/consumers.js";
import {
  withContributions,
  withFlowCheck,
  type Contributions,
} from "../src/type-inference/core/contract/contributions.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
  WorkLedger,
} from "../src/type-inference/core/budget.js";
import { keyOf } from "../src/type-inference/core/definitions.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import { checkedResult } from "../src/type-inference/core/consumer.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { MODES, inMode, type Mode } from "./helpers/type-core-oracles.js";

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
    readonly (readonly [string, readonly string[], readonly string[]])[],
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
    // (a load's default, its typed default decision's: the default's key, qualified by the choice; a `null` default none)
    [
      'let d = {f: 1}\nlet v = load("k", default: d)\nsay "${v.f}"\nexit\n',
      [
        ["v", [], ["d"]],
        ["v", ["f"], ["d.f"]],
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
  ];
  for (const mode of MODES)
    for (const [source, asks] of cases) {
      const { pass } = analysed(source, mode, true);
      for (const [name, path, expected] of asks)
        assert.deepEqual(
          edges(pass, name, path),
          [...expected].sort(),
          `${source}: ${name}.${path.join(".")}`,
        );
    }
});

test("an inclusion keeps the transforms its answer went through: a default's choice, an `otherwise` side's null filter", () => {
  const qualifiers = (pass: CorePass, name: string): readonly string[] => {
    const place = pass.program.places.findIndex((at) => at?.label === name);
    const found = pass.contract.contributions(keyOf(place, []));
    assert.equal(found.state, "complete");
    return found.state === "complete" ? found.edges.flatMap((edge) => edge.qualifiers) : [];
  };
  for (const mode of MODES) {
    const loaded = analysed(
      'let d = {f: 1}\nlet v = load("k", default: d)\nsay "${v.f}"\nexit\n',
      mode,
      true,
    ).pass;
    assert.ok(qualifiers(loaded, "v").includes("defaultChoice"));
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
        found.edges.some((edge) => edge.qualifiers.includes("groupFirst")),
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

test("a snapshot charges each slot it visits, each inclusion it follows and each edge's qualifiers", () => {
  // (the charge counted from the published flows the snapshot walks: a slot visited one step, an inclusion followed
  // one unit and one per qualifier of its own, an edge kept one per qualifier of its list; each slot of these
  // sources reached once)
  for (const mode of MODES)
    for (const n of [8, 32]) {
      const source = `${Array.from({ length: n }, (_, at) => `let a${at} = hostValue`).join("\n")}\nlet b = a0\n${Array.from({ length: n - 1 }, (_, at) => `b = a${at + 1}`).join("\n")}\nsay "\${b}"\nexit\n`;
      const { pass } = analysed(source, mode, true);
      const place = pass.program.places.findIndex((at) => at?.label === "b");
      const start = `c|${keyOf(place, [])}`;
      let expected = 0;
      const todo = [{ slot: start, depth: 0 }];
      for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
        expected += 1;
        for (const inclusion of pass.solver.flowOf(next.slot) ?? []) {
          expected += 1 + inclusion.qualifiers.length;
          const depth = next.depth + inclusion.qualifiers.length;
          if (inclusion.slot!.startsWith("c|")) expected += depth;
          else todo.push({ slot: inclusion.slot!, depth });
        }
      }
      const before = pass.program.work.total;
      const found = edges(pass, "b");
      assert.ok(typeof found !== "string" && found.length === n, `${String(found)}`);
      assert.equal(pass.program.work.total - before, expected, source);
    }
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
  // (the inclusion matrix in code: every read of another slot's answer — a producing method, an inline producing helper
  // (a generator of items defined in the layer), a raw demand or a proof — either passes a flow as an argument,
  // follows the slot's `include` in its function, or carries its class on the line before (`// #1668: <class>`), so a
  // new read cannot go unclassified)
  const folder = join(process.cwd(), "src/type-inference/core/contract");
  const files = readdirSync(folder).filter((name) => name.endsWith(".ts"));
  const sources = new Map(files.map((file) => [file, readFileSync(join(folder, file), "utf8")]));
  const helpers = new Set<string>();
  for (const text of sources.values())
    for (const found of text.matchAll(
      /function\*\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*:\s*Work<\s*(?:readonly Item\[\]|Item\[\]|Proven<)/g,
    ))
      helpers.add(found[1]!);
  const method =
    /\b(?:contract|self|this|c)\.(contractOf|contractOfValueAt|contractOfValue|subAt|contractOfLiteral|entryAt|receiverKinds|valueReceiver|severalElements|keyThrough|indexItems|gathered|defaultKinds|onlyNull|expectedOf|contractRead)\(|\.proven\(|yield (?:positioned|projected)\(/;
  const helper = /yield\*\s+(?:inline\()?(\w+)\(/;
  const raw = /(?<![\w*])yield\s+(?:\{|demand\b)/;
  const argument =
    /[(,]\s*(?:flow|staged|read|lead|source|literal|whole|element|stored|below|through|kept|frontier|fallback|given|kinds|"run"|contract\.pass\.solver\.sink\(\))\s*[,)]/;
  const unclassified: string[] = [];
  for (const [file, text] of sources) {
    const lines = text.split("\n");
    lines.forEach((line, at) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      const named = helper.exec(line)?.[1];
      const producing =
        method.test(line) || raw.test(line) || (named !== undefined && helpers.has(named));
      if (!producing) return;
      // (the statement from the read to its end)
      const end = lines.findIndex((next, from) => from >= at && /[;{]\s*$/.test(next));
      const call = lines.slice(at, end < 0 ? at + 1 : Math.min(end + 1, at + 10)).join(" ");
      const tagged = /^\s*(?:[?:]\s*)?\/\/ #1668:/.test(lines[at - 1] ?? "");
      // (a raw demand or a proof read by its key: its `include` earlier in the same function)
      let start = at;
      while (
        start > 0 &&
        !/^(?:export )?(?:async )?function|^\s*(?:public|private) /.test(lines[start]!)
      )
        start -= 1;
      // (the demand's key, by its name: a raw demand's `key: <name>`, a proof's demand variable's `<name>.key`)
      const body = lines.slice(start, at).join(" ");
      // (a demand made by a factory and yielded by its variable: `<variable>.key`; a raw one: `key: <name>`, or `key`)
      const variable = /yield\s+(\w+)\s*[;)]/.exec(line)?.[1];
      const literal = /\bkey(?::\s*(\w+))?\s*[,}]/.exec(
        // (a raw demand's object from its `yield {` on; a yielded variable's made in the lines before)
        /yield\s+\{/.test(line)
          ? lines.slice(at, at + 3).join(" ")
          : lines.slice(Math.max(start, at - 12), at).join(" "),
      );
      const keyName = raw.test(line)
        ? /yield\s+\{/.test(line)
          ? literal === null
            ? undefined
            : (literal[1] ?? "key")
          : (literal?.[1] ?? variable)
        : /\.proven\(\s*(\w+)\s*\)/.exec(line)?.[1];
      const included =
        keyName !== undefined && new RegExp(`\\.include\\(\\s*${keyName}(?:\\.key)?\\b`).test(body);
      if (argument.test(call) || tagged || included) return;
      unclassified.push(`${file}:${at + 1}: ${trimmed}`);
    });
  }
  assert.ok(helpers.size > 20, `${helpers.size} producing helpers`);
  assert.deepEqual(unclassified, []);
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
