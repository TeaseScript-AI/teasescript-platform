import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, solveDemands, type CorePass } from "../src/type-inference/core/answers.js";
import {
  joinParts,
  withTestAllowance,
  withTestDemandAllowance,
} from "../src/type-inference/core/budget.js";
import { Contract } from "../src/type-inference/core/contract.js";
import {
  compareKeyIds,
  exportKeyIds,
  importKeyIds,
  keyIdAt,
  keyIdBelow,
  keyIdDepth,
  keyIdFirst,
  keyIdOf,
  keyIdOfText,
  keyIdParent,
  keyIdPath,
  keyIdPlace,
  keyIdStep,
  keyOfId,
  memberStepIn,
  rootId,
  stepsOfId,
  type KeyId,
} from "../src/type-inference/core/contract/key-ids.js";
import {
  keyLane,
  withKeyRecords,
  type KeyRecord,
} from "../src/type-inference/core/contract/lanes.js";
import { keyOf } from "../src/type-inference/core/definitions.js";
import { REASON, type Item } from "../src/type-inference/core/items.js";
import { memberStep } from "../src/type-inference/core/method-categories.js";
import type { Demand, Work } from "../src/type-inference/core/solver.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { probeMade } from "./helpers/type-core-made.js";
import { narrowingPass } from "./helpers/type-core-narrowing.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";

/*
 * G3 stage 1, PR 1 (TABLE r4.196): the key cursors (`contract/key-ids.ts`) and the frozen wrapper lane
 * (`contract/lanes.ts`), exercised directly; no answer reads them yet. A cursor names one key of its pass whichever
 * way it is made, orders as its key's text, survives the pass's stops and forgets, and crosses passes only as a packet;
 * a family's lane is frozen at its first question, by the binding's wrapper shape alone; what the conversions walk and
 * make grows with what they charge (`helpers/type-core-made.ts`).
 */

const GLOBALS = ["hostValue", "hostOther", "hostInit"];

function request(source: string) {
  const made = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(made !== null, source);
  return made;
}

function bindingOf(pass: CorePass, label: string): PlaceId {
  const found = pass.program.places.find(
    (place) => place.kind.kind === "binding" && place.label === label,
  );
  assert.ok(found !== undefined, label);
  return found.id;
}

const stopped = (items: readonly Item[]): boolean =>
  items.some((item) => item.tag === "unknown" && (item.reasons & REASON.budget) !== 0);

/** Property steps of each class a key meets. */
const STEPS = [
  "q",
  // members a built-in value answers by itself (`memberStep`): a dict's, a temporal field
  "values",
  "year",
  // a property named like an internal step, quoted (`propertyStep`); a choice object's button value
  "'element",
  "#value",
  "anUnusuallyLongPropertyName",
  // either side of `SHORT`
  `p${"a".repeat(31)}`,
  `p${"a".repeat(32)}`,
  // siblings one a prefix of the other, the longer's next code unit above the dot and below it (`a.x` after `a-b`)
  "a",
  "ab",
  "a-b",
];

/** Places whose decimal texts sort apart from their values (`100|` < `12|` < `1|` < `9|`). */
const PLACES = [1, 9, 12, 100];

/** Every step alone, first, middle and last in a path of five, above and below another, thrice; siblings below. */
function familyKeys(): (readonly [PlaceId, readonly string[]])[] {
  const paths = new Map<string, readonly string[]>([["", []]]);
  const add = (path: readonly string[]): void => void paths.set(path.join("\u0000"), path);
  for (const step of STEPS) {
    for (const path of [[step], [step, "q"], ["q", step], [step, step, step]]) add(path);
    for (const at of [0, 2, 4]) add(Array.from({ length: 5 }, (_, k) => (k === at ? step : "q")));
  }
  for (const step of ["a", "ab", "a-b"]) add([step, "x"]);
  return PLACES.flatMap((place) => [...paths.values()].map((path) => [place, path] as const));
}

test("a key's cursor names one key of its pass whichever way it is made; its text, parts, spans and member steps are its key's; it orders as its key's text in either allocation order, and crosses passes only as a packet", () => {
  const keys = familyKeys();
  const source = request("let x = 1\nexit\n");
  const [first, second] = [narrowingPass(source), narrowingPass(source)];
  const ids: KeyId[][] = [];
  for (const [pass, order] of [
    [first, keys],
    [second, [...keys].reverse()],
  ] as const) {
    const { contract } = pass;
    const made = new Map<string, KeyId>();
    for (const [place, path] of order) {
      const id = keyIdOf(contract, place, path);
      // (made one step from its parent's, from its root: one cursor)
      let below = rootId(place);
      for (const step of path) below = keyIdBelow(contract, below, step);
      assert.equal(below, id, keyOf(place, path));
      made.set(keyOf(place, path), id);
    }
    const inOrder = keys.map(([place, path]) => made.get(keyOf(place, path))!);
    // equal exactly when one key; the same path in two places one path id
    assert.equal(new Set(inOrder).size, keys.length);
    for (const [index, id] of inOrder.entries()) {
      const [place, path] = keys[index]!;
      const elsewhere = keyIdOf(
        contract,
        PLACES[(PLACES.indexOf(place) + 1) % PLACES.length]!,
        path,
      );
      assert.notEqual(elsewhere, id);
      assert.equal(keyIdPath(elsewhere), keyIdPath(id));
    }
    // (so far no key's text or steps were made)
    assert.equal(contract.keyTexts.size + contract.pathStepLists.size, 0);
    for (const [index, id] of inOrder.entries()) {
      const [place, path] = keys[index]!;
      const where = keyOf(place, path);
      assert.equal(keyOfId(contract, id), where);
      assert.equal(keyIdOfText(contract, where), id, where);
      assert.equal(keyIdPlace(id), place);
      assert.equal(keyIdDepth(contract, id), path.length);
      assert.equal(keyIdStep(contract, id), path.at(-1) ?? "");
      assert.equal(keyIdFirst(contract, id), path[0] ?? null);
      assert.equal(
        keyIdParent(contract, id),
        path.length === 0 ? null : keyIdOf(contract, place, path.slice(0, -1)),
      );
      for (let from = 0; from <= path.length; from += 1) {
        assert.deepEqual(stepsOfId(contract, id, from), path.slice(from), `${where} @${from}`);
        assert.equal(memberStepIn(contract, id, from), memberStep(path, from), `${where} @${from}`);
      }
    }
    // the order of their texts, never of their ids
    const texts = inOrder.map((id) => keyOfId(contract, id));
    for (let a = 0; a < inOrder.length; a += 1)
      for (let b = 0; b < inOrder.length; b += 1) {
        const expected = texts[a]! < texts[b]! ? -1 : texts[a]! > texts[b]! ? 1 : 0;
        assert.equal(
          compareKeyIds(contract, inOrder[a]!, inOrder[b]!),
          expected,
          `${texts[a]} ? ${texts[b]}`,
        );
      }
    ids.push(inOrder);
  }
  // the passes met the paths in opposite orders: other ids, one order, and a packet that maps one onto the other
  assert.ok(ids[0]!.some((id, index) => ids[1]![index] !== id));
  const packet: unknown = JSON.parse(JSON.stringify(exportKeyIds(first.contract, ids[0]!)));
  const imported = importKeyIds(second.contract, packet);
  assert.deepEqual(imported, ids[1]);
  // a raw id read in the other pass names another key
  assert.ok(
    ids[0]!.some(
      (id) =>
        keyOfId(second.contract, keyIdAt(keyIdPlace(id), keyIdPath(id))) !==
        keyOfId(first.contract, id),
    ),
  );
  for (const malformed of [
    null,
    { nodes: [[1, "q"]], keys: [] },
    { nodes: [[-1, "a.b"]], keys: [] },
    { nodes: [[-1, ""]], keys: [] },
    { nodes: [[-1, "q"]], keys: [[1, 1]] },
    { nodes: [], keys: [[-1, -1]] },
  ])
    assert.throws(() => importKeyIds(second.contract, malformed), /A key packet has/);
});

test("#1422 B1: a replayed demand's key comes through a packet from the pass that made it, never by its raw id", () => {
  const source = request('let box = {one: 1, two: "x"}\nlet a = box.one\nlet b = box.two\nexit\n');
  const [old, fresh] = [narrowingPass(source), narrowingPass(source)];
  const box = bindingOf(old, "box");
  const ids = [keyIdOf(old.contract, box, ["one"]), keyIdOf(old.contract, box, ["two"])];
  // (the fresh pass meets the two paths the other way round)
  keyIdOf(fresh.contract, box, ["two"]);
  keyIdOf(fresh.contract, box, ["one"]);
  const tags = (items: readonly Item[]): string[] => items.map((item) => item.tag);
  const packet: unknown = JSON.parse(JSON.stringify(exportKeyIds(old.contract, ids)));
  for (const [index, id] of importKeyIds(fresh.contract, packet).entries()) {
    const key = keyOfId(old.contract, ids[index]!);
    const intended = tags(old.solver.run(old.contract.contractOf(key)));
    assert.equal(keyOfId(fresh.contract, id), key);
    const replayed = solveDemands(source, [joinParts("c", keyOfId(fresh.contract, id))]);
    assert.deepEqual(tags(replayed[0]!), intended);
    const raw = keyOfId(fresh.contract, keyIdAt(box, keyIdPath(ids[index]!)));
    assert.notEqual(raw, key);
    assert.notDeepEqual(tags(solveDemands(source, [joinParts("c", raw)])[0]!), intended);
  }
});

test("a cursor outlives its pass's stops and forgets, its family's lane too, while a stop vetoes the wrapper live and forgets a reader that read the cursor's demand finished (#1405)", () => {
  const source = request(
    "let seed: integer = 1\nlet leaf = {n: seed}\nlet box = {shell: leaf}\nlet out = box.shell.n\nexit\n",
  );
  const pass = narrowingPass(source);
  const { contract, solver } = pass;
  const box = bindingOf(pass, "box");
  const id = keyIdOf(contract, box, ["shell", "n"]);
  const key = keyOfId(contract, id);
  const demand = (name: string, make: Demand["make"]): Demand => ({
    key: name,
    kind: "contract",
    file: 0,
    offset: 0,
    make,
  });
  const named = demand(joinParts("kc", id), () => contract.contractOf(key));
  const reader = demand("kr", function* (): Work<readonly Item[]> {
    return yield named;
  });
  const run = (asked: Demand): readonly Item[] =>
    solver.run(
      (function* (): Work<readonly Item[]> {
        return yield asked;
      })(),
    );
  assert.ok(!stopped(run(named)));
  // (the reader reads the cursor's demand finished)
  assert.ok(!stopped(run(reader)));
  assert.equal(keyLane(contract, box, "shell"), "cursor");
  assert.notEqual(contract.wrapperHop(box, "shell"), null);
  const made = contract.pathParents.length;
  // (a stop at the key's prefix, at the key again, and at a sibling, which the reader never asked of)
  for (const path of [["shell"], ["shell", "n"], ["other"]]) {
    const asked = path[0] === "shell";
    contract.stop(box, path);
    assert.equal(
      solver.answer(reader.key) === undefined,
      asked,
      `the reader, stopped at ${path.join(".")}`,
    );
    assert.equal(solver.answer(named.key) === undefined, asked);
    assert.equal(keyIdOf(contract, box, ["shell", "n"]), id);
    assert.equal(keyOfId(contract, id), key);
    assert.equal(keyLane(contract, box, "shell"), "cursor");
    assert.equal(contract.wrapperHop(box, "shell"), null);
    assert.ok(stopped(run(reader)));
  }
  solver.forget([named.key]);
  assert.equal(keyIdOf(contract, box, ["shell", "n"]), id);
  // a pass that starts with the binding stopped (the pass after a stop): the lane the shape's, the answer vetoed
  const next = narrowingPass(source);
  next.contract.stop(box, ["shell"]);
  assert.equal(keyLane(next.contract, box, "shell"), "cursor");
  assert.equal(next.contract.wrapperHop(box, "shell"), null);
  // a path first asked now is a new id
  assert.ok(keyIdPath(keyIdOf(contract, box, ["shell", "fresh"])) >= made);
});

/** Sol's wrapper family (design r1's `family.mjs`): `depth` wrappers over `root`, `variant` at the middle one, by `step`. */
function wrapped(depth: number, variant: string, step = "q"): string {
  const middle = Math.floor(depth / 2);
  const below = middle === 0 ? "root" : `a${middle - 1}`;
  const suffix = (k: number): string => Array.from({ length: k }, () => step).join(".");
  const lines = ["let typed: integer = 1", `let root = {f: typed, ${step}: null}`];
  for (let i = 0; i < depth; i += 1) {
    const extra = i === middle && variant === "sibling-property" ? ", r: 1" : "";
    lines.push(`let a${i} = {${step}: ${i === 0 ? "root" : `a${i - 1}`}${extra}}`);
  }
  const top = `a${depth - 1}`;
  const before: Record<string, readonly string[]> = {
    "store-before": [`a${middle}.${step} = ${below}`],
    "sibling-store": [`a${middle}.r = 2`],
    rejected: [`a${middle}.${step} = 5`, `a${middle}.${step} = ${below}`],
    guarded: [`if a${middle}.${step} is object {`, `  say "here"`, "}"],
    foreign: [
      "function poke {",
      `  a${middle}.${step} = ${below}`,
      "  return 0",
      "}",
      "let z = poke()",
    ],
    handler: [
      "function register {",
      `  showPermanentButton "Change" { a${middle}.${step} = ${below} }`,
      "  return 0",
      "}",
      "let z = register()",
    ],
    copy: [`let c = a${middle}`, `let viaCopy = c.${suffix(middle + 1)}.f`],
    "every-depth": Array.from(
      { length: depth },
      (_, k) => `let r${k} = ${top}${k === 0 ? "" : `.${suffix(k)}`}`,
    ),
    host: [
      `let h = hostValue.${step}`,
      `let hh = {${step}: hostValue}`,
      `let viaHost = hh.${step}`,
    ],
  };
  return [
    ...lines,
    ...(before[variant] ?? []),
    `let out = ${top}.${suffix(depth)}.f`,
    ...(variant === "store-after" ? [`a${middle}.${step} = ${below}`] : []),
    "exit",
    "",
  ].join("\n");
}

const VARIANTS = [
  "plain",
  "store-before",
  "store-after",
  "sibling-store",
  "sibling-property",
  "rejected",
  "guarded",
  "foreign",
  "handler",
  "copy",
  "every-depth",
  "host",
];

/** A wrapper's question as the lane probe saw it: the lane its family took, and the live answer. */
interface HopQuestion {
  readonly lane: string;
  readonly hop: boolean;
}

/**
 * `run` with the lane of every family whose wrapper an analysis asks (`wrapperHop`) asked first (`keyLane`), as the
 * flow will; every question, shape and lane recorded.
 */
function withLaneProbe(run: () => void): {
  readonly records: readonly KeyRecord[];
  readonly questions: readonly HopQuestion[];
} {
  const original = Contract.prototype.wrapperHop;
  const questions: HopQuestion[] = [];
  Contract.prototype.wrapperHop = function (this: Contract, read: PlaceId, step: string) {
    const lane = keyLane(this, read, step);
    const hop = original.call(this, read, step);
    questions.push({ lane, hop: hop !== null });
    return hop;
  };
  try {
    return { records: withKeyRecords(run).records, questions };
  } finally {
    Contract.prototype.wrapperHop = original;
  }
}

/** What contradicts the frozen-lane rule in a probe's records (`withLaneProbe`), as text. */
function laneProblems(records: readonly KeyRecord[]): string[] {
  const problems: string[] = [];
  const families = new Map<string, KeyRecord[]>();
  for (const record of records) {
    const family = `${record.pass}/${record.binding}/${record.step}`;
    families.set(family, [...(families.get(family) ?? []), record]);
  }
  for (const [family, list] of families) {
    const shapes = list.filter((record) => record.kind === "shape");
    const lanes = list.filter((record) => record.kind === "lane");
    // found once per pass, by its first asker, never carried from an earlier pass
    if (shapes.filter((record) => !record.hit).length > 1) problems.push(`${family}: found twice`);
    if (shapes[0]?.hit === true) problems.push(`${family}: first asked from a memo`);
    const outcomes = new Set(
      shapes.map((record) => record.outcome).filter((outcome) => outcome !== "stopped"),
    );
    if (outcomes.size > 1) problems.push(`${family}: shapes ${[...outcomes].join(", ")}`);
    if (new Set(lanes.map((record) => record.lane)).size > 1)
      problems.push(`${family}: lanes changed`);
    const first = lanes[0];
    const expected = outcomes.has("wrapper") ? "cursor" : "text";
    if (first !== undefined && !first.building && first.lane !== expected)
      problems.push(`${family}: lane ${first.lane} for a shape ${[...outcomes].join(", ")}`);
  }
  return problems;
}

test("a binding's wrapper shape is found once per pass whoever asks first, and each family's lane is frozen by it alone, whatever the analysis stops, rejects or finishes afresh, in every mode (TABLE r4.196)", () => {
  const problems: string[] = [];
  const seen = { cursor: 0, text: 0, vetoed: 0, passes: 0, building: 0 };
  const sources = [
    ...VARIANTS.map((variant) => wrapped(3, variant)),
    // property names a built-in value answers, internal steps' names, either side of `SHORT`
    ...["values", "year", "element", "iteration", `p${"a".repeat(31)}`, `p${"a".repeat(32)}`].map(
      (step) => wrapped(3, "every-depth", step),
    ),
  ];
  for (const [index, source] of sources.entries()) {
    const req = request(source);
    // (every mode for the plain and the rejected wrapper, each other source in one, in turn)
    for (const mode of index === 0 || index === 5 ? MODES : [MODES[index % MODES.length]!]) {
      // (the natural allowances; a demand allowance that stops decisions, restarting the pass, and stops the analysis
      // at a second; a work allowance that stops it midway, finishing afresh)
      let total = 0;
      for (const limit of ["natural", "demand", "work"] as const) {
        const { records, questions } = withLaneProbe(() =>
          inMode(mode, () => {
            if (limit === "demand") return withTestDemandAllowance(150, () => analyseCore(req));
            if (limit === "work")
              return withTestAllowance(Math.floor(total * 0.6), () => analyseCore(req));
            total = analyseCore(req).budget.total;
          }),
        );
        const where = `source ${index} (${mode.reversed ? "reversed" : "source"}, ${mode.unshared ? "unshared" : "shared"}, ${limit})`;
        problems.push(...laneProblems(records).map((problem) => `${where}: ${problem}`));
        for (const question of questions) {
          if (question.lane === "cursor") seen.cursor += 1;
          else seen.text += 1;
          if (question.lane === "cursor" && !question.hop) seen.vetoed += 1;
        }
        seen.passes = Math.max(seen.passes, new Set(records.map((record) => record.pass)).size);
        seen.building += records.filter(
          (record) => record.kind === "lane" && record.building,
        ).length;
      }
    }
  }
  assert.deepEqual(problems, []);
  // both lanes reached, live vetoes under a cursor lane, analyses of several passes
  assert.ok(
    seen.cursor > 0 && seen.text > 0 && seen.vetoed > 0 && seen.passes > 1,
    JSON.stringify(seen),
  );
});

test("a family's lane is the binding's whichever read asks; a question while its shape or the marks are being built leaves it text for the pass, never promoted, and the shape found then stands for the live answer", () => {
  const source = request(
    "let seed: integer = 1\nlet leaf = {n: seed}\nlet box = {shell: leaf}\nlet out = box.shell.n\nlet h = hostValue.n\nexit\n",
  );
  // positive, by the binding's read and by the binding (one shape found, by the first asker); a root key's text
  {
    const pass = narrowingPass(source);
    const box = bindingOf(pass, "box");
    const read = pass.program.places.find(
      (place) => pass.program.occurrenceOf.get(place.id) === box,
    )!.id;
    const { records } = withKeyRecords(() => {
      assert.equal(keyLane(pass.contract, read, "shell"), "cursor");
      assert.equal(keyLane(pass.contract, box, "shell"), "cursor");
      assert.equal(keyLane(pass.contract, box, null), "text");
    });
    assert.deepEqual(
      records.map((record) => `${record.kind} ${record.hit}`),
      ["shape false", "lane false", "lane true"],
    );
    // a read of a host global: its ingress vetoes the wrapper live, and its binding has no shape
    const host = pass.program.places.find((place) =>
      pass.program.isHost(pass.program.occurrenceOf.get(place.id) ?? -1),
    )!.id;
    assert.equal(keyLane(pass.contract, host, "n"), "text");
    assert.equal(pass.contract.wrapperHop(host, "n"), null);
  }
  // asked again while its own shape is being found: text for the pass, though the shape found is a wrapper
  {
    const pass = narrowingPass(source);
    const { contract } = pass;
    const box = bindingOf(pass, "box");
    const inner: string[] = [];
    const prefixStores = contract.prefixStores.bind(contract);
    contract.prefixStores = (key) => {
      inner.push(keyLane(contract, box, "shell"));
      return prefixStores(key);
    };
    const { records } = withKeyRecords(() => keyLane(contract, box, "shell"));
    assert.deepEqual(inner, ["text"]);
    assert.equal(keyLane(contract, box, "shell"), "text");
    assert.notEqual(contract.wrapperHop(box, "shell"), null);
    assert.ok(records.some((record) => record.kind === "lane" && record.building));
  }
  // asked while the marks are collected (a copied key that mark collection reaches): text for the pass
  {
    const pass = narrowingPass(source);
    const { contract } = pass;
    const [box, leaf] = [bindingOf(pass, "box"), bindingOf(pass, "leaf")];
    const inner: string[] = [];
    const copiedKey = contract.copiedKey.bind(contract);
    contract.copiedKey = (value) => {
      if (inner.length === 0) inner.push(keyLane(contract, leaf, "n"));
      return copiedKey(value);
    };
    assert.equal(keyLane(contract, box, "shell"), "cursor");
    assert.deepEqual(inner, ["text"]);
    assert.equal(keyLane(contract, leaf, "n"), "text");
    assert.notEqual(contract.wrapperHop(leaf, "n"), null);
  }
  // a failed shape: a store below the binding
  {
    const pass = narrowingPass(request(wrapped(3, "store-before")));
    assert.equal(keyLane(pass.contract, bindingOf(pass, "a1"), "q"), "text");
    assert.equal(keyLane(pass.contract, bindingOf(pass, "a0"), "q"), "cursor");
  }
});

test("recording the shapes and lanes changes no answer and no unit", () => {
  for (const variant of ["plain", "rejected", "every-depth", "host"]) {
    const req = request(wrapped(3, variant));
    for (const mode of MODES) {
      const outcome = (): string => {
        const answers = inMode(mode, () => analyseCore(req));
        return JSON.stringify([answers.diagnostics, answers.checks, [...answers.budget.counts]]);
      };
      assert.equal(withKeyRecords(outcome).result, outcome(), variant);
    }
  }
});

/** Each conversion on a path of `n` steps, by site: the arena reads and made units it walked, and its charge. */
function sites(n: number): Map<string, { readonly walked: number; readonly charged: number }> {
  const source = request("let x = 1\nexit\n");
  const { contract } = narrowingPass(source);
  const steps = Array.from({ length: n }, (_, k) => (k % 7 === 3 ? "values" : `s${k % 5}`));
  const out = new Map<string, { walked: number; charged: number }>();
  const site = <T>(name: string, run: () => T): T => {
    const { result, work } = probeMade(contract, run);
    out.set(name, { walked: work.visits + work.made, charged: work.charged });
    return result;
  };
  const deepest = site("keyIdBelow chain", () =>
    steps.reduce<KeyId>((id, step) => keyIdBelow(contract, id, step), rootId(7)),
  );
  site("keyIdOf", () => keyIdOf(contract, 8, steps));
  site("keyIdOfText", () => keyIdOfText(contract, keyOf(9, steps)));
  site("keyOfId", () => keyOfId(contract, deepest));
  const [whole, walked] = [keyIdOf(contract, 10, steps), keyIdOf(contract, 11, [...steps, "x"])];
  site("stepsOfId", () => stepsOfId(contract, whole));
  // (a span of a path whose whole steps are kept, and of one walked: the same path below another place shares them)
  const sliced = keyIdOf(contract, 12, steps);
  site("stepsOfId span, kept", () => stepsOfId(contract, sliced, n >> 1));
  site("stepsOfId span, walked", () => stepsOfId(contract, walked, n >> 1));
  site("memberStepIn", () => memberStepIn(contract, deepest, n >> 1));
  const apart = keyIdBelow(contract, rootId(7), "t");
  site("compareKeyIds", () => compareKeyIds(contract, deepest, apart));
  const packet = site("exportKeyIds", () => exportKeyIds(contract, [deepest]));
  const fresh = narrowingPass(source).contract;
  const { result, work } = probeMade(fresh, () => importKeyIds(fresh, packet));
  out.set("importKeyIds", { walked: work.visits + work.made, charged: work.charged });
  assert.equal(keyOfId(fresh, result[0]!), keyOfId(contract, deepest));
  return out;
}

test("what each cursor conversion walks and makes grows no faster than what it charges, both linear in the path (the uncharged-work probe)", () => {
  // (past `SHORT`'s free code units and elements, which make a short path's charge affine)
  const [small, large] = [sites(512), sites(1024)];
  const problems: string[] = [];
  for (const [name, at] of small) {
    const twice = large.get(name)!;
    const charged = twice.charged / at.charged;
    if (!(charged <= 2.2)) problems.push(`${name}: charged ×${charged.toFixed(3)}`);
    const ratio = twice.walked / twice.charged / (at.walked / at.charged);
    if (!(ratio <= 1.1)) problems.push(`${name}: walked per charged unit ×${ratio.toFixed(3)}`);
  }
  assert.deepEqual(problems, []);
});
