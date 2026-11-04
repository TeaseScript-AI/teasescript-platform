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
import { withTestDemandAllowance } from "../src/type-inference/core/budget.js";
import { keyOf } from "../src/type-inference/core/definitions.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import { checkedResult } from "../src/type-inference/core/consumer.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { MODES, inMode, type Mode } from "./helpers/type-core-oracles.js";

// #1668: which keys' answers a key's contract includes in a settled pass, recorded only where a pass asks for it.

const GLOBALS = ["hostValue", "hostOther"];

/** `source` analysed in `mode`, recording contributions where `record`: its last pass and its answers. */
function analysed(source: string, mode: Mode, record: boolean) {
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, source);
  const passes: CorePass[] = [];
  const check = Consumers.prototype.check;
  Consumers.prototype.check = function (this: Consumers) {
    passes.push(this.pass);
    check.call(this);
  };
  try {
    const run = () => inMode(mode, () => analyseCore(request));
    const answers = record ? withContributions(run) : run();
    return { answers, request, pass: passes.at(-1)! };
  } finally {
    Consumers.prototype.check = check;
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
          for (const inclusion of inclusions)
            if (inclusion.slot !== null)
              assert.ok(reads.has(inclusion.slot), `${slot} includes ${inclusion.slot} unread`);
        },
        () => analysed(source, mode, true),
      );
  assert.ok(published > 20, `${published} flows published`);
});

test("every producing read in the contract layer passes a flow, follows an inclusion or is classified", () => {
  // (the inclusion matrix in code: a read of another slot's answer either includes it (a flow argument, or the slot
  // recorded just before it) or carries its class (`// #1668: <class>`), so a new read cannot go unclassified)
  const producing =
    /\b(?:contract|self|this|c)\.(contractOf|contractOfValueAt|contractOfValue|subAt|contractOfLiteral|entryAt|receiverKinds|valueReceiver|severalElements|keyThrough|indexItems|gathered|defaultKinds|onlyNull|expectedOf|contractRead)\(|\.proven\(|yield (?:positioned|projected)\(/;
  const flowing =
    /\b(flow|staged|read|lead|source|literal|whole|element|stored|below|through|kept|frontier|fallback)\b/;
  const folder = join(process.cwd(), "src/type-inference/core/contract");
  const unclassified: string[] = [];
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts"))) {
    const lines = readFileSync(join(folder, file), "utf8").split("\n");
    lines.forEach((line, at) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || !producing.test(line)) return;
      // (the statement from the read to its end, no comment after it)
      const end = lines.findIndex((next, from) => from >= at && /[;{]\s*$/.test(next));
      const call = lines.slice(at, end < 0 ? at + 1 : Math.min(end + 1, at + 6)).join(" ");
      const before = lines.slice(Math.max(0, at - 3), at).join(" ");
      if (flowing.test(call.slice(call.search(producing))) || /#1668:|\.include\(/.test(before))
        return;
      unclassified.push(`${file}:${at + 1}: ${trimmed}`);
    });
  }
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
