import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { analyseCore, solveDemands, type CorePass } from "../src/type-inference/core/answers.js";
import {
  joinParts,
  withTestAllowance,
  withTestDemandAllowance,
} from "../src/type-inference/core/budget.js";
import { Contract } from "../src/type-inference/core/contract.js";
import {
  canonicalRest,
  compareDemandNames,
  compareKeyIds,
  exportKeyIds,
  exportNames,
  importKeyIds,
  importNames,
  isSteps,
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
  keyPrefixIn,
  memberStepIn,
  restSteps,
  rootId,
  stepsOfId,
  type KeyId,
  type KeyPacket,
} from "../src/type-inference/core/contract/key-ids.js";
import {
  keyLane,
  withKeyRecords,
  withTextKeys,
  wrapperShape,
  type KeyRecord,
} from "../src/type-inference/core/contract/lanes.js";
import type { WrapperHop } from "../src/type-inference/core/contract/model.js";
import { keyOf, type Key } from "../src/type-inference/core/definitions.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { REASON, type Item } from "../src/type-inference/core/items.js";
import { memberStep } from "../src/type-inference/core/method-categories.js";
import type { Demand, Work } from "../src/type-inference/core/solver.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { probeMade } from "./helpers/type-core-made.js";
import { narrowingPass, nodeAt } from "./helpers/type-core-narrowing.js";
import { inMode, MODES, publishedAnswers, publishedRoute } from "./helpers/type-core-oracles.js";
import { Admission } from "../src/type-inference/core/admission.js";
import { sharedPaths } from "../src/type-inference/core/admission/structure.js";

/*
 * G3 stage 1 (TABLE r4.196): the key cursors (`contract/key-ids.ts`) and the frozen wrapper lane
 * (`contract/lanes.ts`), exercised directly and through the decided paths that carry them (PR 3). A cursor names one
 * key of its pass whichever way it is made, orders as its key's text, survives the pass's stops and forgets, and
 * crosses passes only as a packet; a family's lane is frozen at its first question, by the binding's wrapper shape
 * alone; what the conversions walk and make grows with what they charge (`helpers/type-core-made.ts`).
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
        // (and in demands' names, as the solver orders a component's members: #1398)
        assert.equal(
          compareDemandNames(contract, joinParts("c", inOrder[a]!), joinParts("c", inOrder[b]!)),
          expected,
          `c|${texts[a]} ? c|${texts[b]}`,
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
  // the same through a replayed component's names, their cursors by the names' packet (the solver's replay seam)
  const exported = exportNames(old.contract, [joinParts("c", ids[0]!), joinParts("c", ids[1]!)])!;
  const sent: unknown = JSON.parse(JSON.stringify(exported.packet));
  assert.deepEqual(
    importNames(fresh.contract, exported.names, sent),
    ids.map((id) => joinParts("c", keyOfId(old.contract, id))),
  );
  for (const [index, name] of exported.names.entries())
    assert.deepEqual(
      tags(solveDemands(source, [name], sent)[0]!),
      tags(old.solver.run(old.contract.contractOf(keyOfId(old.contract, ids[index]!)))),
    );
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

test("a key's text and its cursor read one stop: after a stop both forms are stopped and read the stop, a completed read of either is forgotten, and a key below the stopped prefix is stopped (Codex r1 F1)", () => {
  const text =
    "let seed: integer=1\nlet leaf={n:seed}\nlet box={shell:leaf}\nlet out=box.shell.n\nexit\n";
  const pass = narrowingPass(request(text));
  const { contract, solver, values } = pass;
  const box = bindingOf(pass, "box");
  assert.equal(keyLane(contract, box, "shell"), "cursor");
  const node = nodeAt(pass, text.indexOf("box.shell.n"));
  const forms = (path: readonly string[]): Key[] => [
    keyOf(box, path),
    keyIdOf(contract, box, path),
  ];
  const read = (key: Key): string =>
    JSON.stringify(solver.run(values.keyItems(key, node)).map((item) => [item.tag, item.reasons]));
  const contractRead = (key: Key): string =>
    JSON.stringify(solver.run(contract.contractOf(key)).map((item) => [item.tag, item.reasons]));
  const [leaf, below] = [forms(["shell"]), forms(["shell", "n"])];
  // (before the stop: both forms read alike, each read completed)
  for (const key of below) assert.equal(read(key), JSON.stringify([["integer", 0]]));
  for (const key of [...leaf, ...below]) contractRead(key);
  contract.stop(box, ["shell"]);
  const stopped = JSON.stringify([["unknown", REASON.budget]]);
  for (const key of [...leaf, ...below]) {
    assert.equal(contract.keyStopped(key), true, String(key));
    assert.equal(contractRead(key), stopped, String(key));
  }
  for (const key of below) assert.equal(read(key), stopped, String(key));
  // (every entry reads one identity: one identity and one prefix's stores for both forms, a text's stop the cursor's)
  const [byText, byCursor] = below;
  assert.equal(contract.keyIdentity(byText!), contract.keyIdentity(byCursor!));
  assert.equal(contract.prefixStores(byText!), contract.prefixStores(byCursor!));
  const other = narrowingPass(request(text));
  const otherBox = bindingOf(other, "box");
  assert.equal(keyLane(other.contract, otherBox, "shell"), "cursor");
  other.contract.stopKey(keyOf(otherBox, ["shell"]));
  assert.equal(other.contract.keyStopped(keyIdOf(other.contract, otherBox, ["shell", "n"])), true);
});

test("a key's text and its cursor are one key to admission's indexes: the paths decided below a wrapper's prefix are the same asked by either (Codex r3 R3-F1)", () => {
  const text =
    "let seed: integer=1\nlet leaf={n:seed}\nlet box={shell:leaf}\nlet out=box.shell.n\nexit\n";
  const pass = narrowingPass(request(text));
  const box = bindingOf(pass, "box");
  assert.equal(keyLane(pass.contract, box, "shell"), "cursor");
  const admission = new Admission(
    pass,
    { run: (work) => pass.solver.run(work) },
    new Map(),
    new Set(),
  );
  const byCursor = sharedPaths(admission, keyIdOf(pass.contract, box, ["shell"]), []);
  assert.deepEqual(byCursor, [["n"]]);
  assert.deepEqual(sharedPaths(admission, keyOf(box, ["shell"]), []), byCursor);
});

test("a wrapper's own literal asked by an array converts it to its span once: asked again by an equal array, it charges nothing and names the same span (a member chain asks one literal and rest at every level)", () => {
  const text =
    "let seed: integer=1\nlet leaf={n:seed}\nlet box={shell:leaf}\nlet out=box.shell.n\nexit\n";
  const pass = narrowingPass(request(text));
  const box = bindingOf(pass, "box");
  const own = [...pass.definitions.byValue].find(([, definitions]) =>
    definitions.some(
      (d) =>
        d.place === box && d.how === "initializer" && d.kind === "whole" && d.path.length === 0,
    ),
  );
  assert.ok(own !== undefined);
  const first = probeMade(pass.contract, () =>
    canonicalRest(pass.contract, own[0], ["shell", "n"]),
  );
  const again = probeMade(pass.contract, () =>
    canonicalRest(pass.contract, own[0], ["shell", "n"]),
  );
  assert.ok(!isSteps(first.result));
  assert.deepEqual(restSteps(first.result), ["shell", "n"]);
  assert.ok(first.work.charged > 0);
  assert.equal(again.work.charged, 0);
  assert.equal(again.result, first.result);
});

test("a member chain's key asked at each of its offsets in turn, cold, climbs its path once: its member scan and its prefixes cost a unit a question after, linear in the path, and a repeated question its one unit (a member chain's demand asks each offset once)", () => {
  const asks = [
    [
      "memberStepIn",
      (contract: Contract, id: KeyId, at: number) => memberStepIn(contract, id, at),
      (_: Contract, at: number) => at,
    ],
    [
      "keyPrefixIn",
      (contract: Contract, id: KeyId, at: number) => keyPrefixIn(contract, id, at + 1),
      (contract: Contract, at: number) =>
        keyIdOf(
          contract,
          5,
          Array.from({ length: at + 1 }, () => "year"),
        ),
    ],
  ] as const;
  for (const [name, ask, answer] of asks) {
    const cost = (depth: number): number => {
      const { contract } = narrowingPass(request("let x = 1\nexit\n"));
      const id = keyIdOf(
        contract,
        5,
        Array.from({ length: depth }, () => "year"),
      );
      let charged = 0;
      for (let at = 0; at < depth; at += 1) {
        const { result, work } = probeMade(contract, () => ask(contract, id, at));
        assert.equal(result, answer(contract, at), `${name} @${at}`);
        charged += work.charged;
      }
      assert.equal(probeMade(contract, () => ask(contract, id, 3)).work.charged, 1, name);
      return charged;
    };
    const [at16, at32] = [cost(16), cost(32)];
    assert.ok(at32 <= 2.2 * at16, `${name}: ${at16} at 16, ${at32} at 32`);
  }
});

test("a member chain's work keeps its ratio to its text lane's from 8 to 16 levels in every mode: the key side's member walk on a cursor adds no term that grows with the chain", () => {
  const chain = (n: number): string => {
    const lines = ["let seed: integer = 1", "let root = {f: seed}"];
    for (let i = 0; i < n; i += 1)
      lines.push(`let a${i} = {year: ${i === 0 ? "root" : `a${i - 1}`}}`);
    const steps = Array.from({ length: n }, () => "year").join(".");
    return [...lines, `let out = a${n - 1}.${steps}.f`, "exit", ""].join("\n");
  };
  for (const mode of MODES) {
    const [at8, at16] = [8, 16].map((n) => {
      const source = request(chain(n));
      const cursor = inMode(mode, () => analyseCore(source)).budget.total;
      const text = withTextKeys(() => inMode(mode, () => analyseCore(source))).budget.total;
      return cursor / text;
    });
    assert.ok(
      at16! <= at8!,
      `${JSON.stringify(mode)}: ×${at8!.toFixed(4)} at 8, ×${at16!.toFixed(4)} at 16`,
    );
  }
});

test("a wrapper's read inside a callable takes the route its text lane takes: the routes a read records are read back in its key's identity", () => {
  const source = request(
    "let seed: integer = 1\nlet root = {f: seed}\nlet a0 = {q: root}\nfunction small {\n  return a0.q.f\n}\nlet out = small()\nexit\n",
  );
  const routes = (): string => {
    const answers = analyseCore(source);
    return JSON.stringify(answers.graph.nodes.map((node) => answers.at(node)?.route ?? null));
  };
  const { result, records } = withKeyRecords(routes);
  assert.ok(records.some((record) => record.kind === "lane" && record.lane === "cursor"));
  assert.equal(result, withTextKeys(routes));
});

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
    // (the family's own records: G3 stage 1's keys born while its shape is found ask their own families' lanes, a
    // host global's here, text by the program's facts alone)
    assert.deepEqual(
      records
        .filter((record) => record.binding === box)
        .map((record) => `${record.kind} ${record.hit}`),
      ["shape false", "lane false", "lane true"],
    );
    assert.ok(
      records
        .filter((record) => record.binding !== box)
        .every((record) => record.kind === "lane" && record.facts && record.lane === "text"),
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

test("a pass freezes its read families' lanes first (`selectLanes`); a family first asked while the marks are built (a wrapper's read inside a literal) keeps the fallback: text for the pass, never promoted, its answers the text lane's", () => {
  // (`a0.q` read alone, `b0.r` inside a literal; selected in either order, the marks built in the first shape)
  const reads = ["let x = a0.q.f", "let xs = [b0.r.f]"];
  for (const order of [reads, [...reads].reverse()]) {
    const source = request(
      `let seed: integer = 1\nlet root = {f: seed}\nlet a0 = {q: root}\nlet b0 = {r: root}\n${order.join("\n")}\nexit\n`,
    );
    const places = new CoreProgram(source).places.filter(({ kind }) => kind.kind === "binding");
    const bindings = places.map(({ id }) => id);
    const [a0, b0] = ["a0", "b0"].map((label) => places.find((place) => place.label === label)!.id);
    for (const mode of MODES) {
      const { result, records } = withKeyRecords(() => inMode(mode, () => analyseCore(source)));
      const lanes = records.filter((record) => record.kind === "lane");
      const inLiteral = lanes.filter((record) => record.binding === b0 && record.step === "r");
      const alone = lanes.filter((record) => record.binding === a0 && record.step === "q");
      const where = `${order[0]} first, ${mode.reversed ? "reversed" : "source"}, ${mode.unshared ? "unshared" : "shared"}`;
      assert.ok(inLiteral[0]?.building === true, where);
      assert.ok(
        inLiteral.slice(1).every((record) => record.hit && record.lane === "text"),
        where,
      );
      assert.ok(alone.length > 0 && alone.every((record) => record.lane === "cursor"), where);
      const text = withTextKeys(() => inMode(mode, () => analyseCore(source)));
      assert.equal(
        publishedAnswers(result, bindings, source).text,
        publishedAnswers(text, bindings, source).text,
        where,
      );
    }
  }
});

test("a shape's record counts its units as the ledger does: its demand's own, a shared build's, or apart (criterion 2)", () => {
  const source = request(
    "let leaf = {n: 1}\nlet box = {shell: leaf}\nlet out = box.shell.n\nexit\n",
  );
  // (a wrapper's shape and a failed one, asked as the demand's own work, inside a shared build, and apart)
  for (const [label, step] of [
    ["box", "shell"],
    ["out", "x"],
  ] as const)
    for (const scope of ["own", "shared", "apart"] as const) {
      const pass = narrowingPass(source);
      const { contract } = pass;
      const { work } = contract;
      const ask = (): WrapperHop | null =>
        wrapperShape(contract, bindingOf(pass, label), step, "lane");
      const [total, own, finishing] = [work.total, work.own, work.finishing];
      const { records } = withKeyRecords(() =>
        scope === "shared" ? work.shared(ask) : scope === "apart" ? work.apart(ask) : ask(),
      );
      const spent = { own: work.own - own, apart: work.finishing - finishing };
      const [record] = records;
      assert.ok(record?.kind === "shape" && !record.hit, `${label}, ${scope}`);
      assert.deepEqual(
        [record.own, record.shared, record.apart],
        [spent.own, work.total - total - spent.own, spent.apart],
        `${label}, ${scope}`,
      );
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
  // (a path whose steps are not yet kept: the scan's cold question makes them, its steps walked and charged)
  const scanned = keyIdOf(contract, 14, [...steps, "y"]);
  site("memberStepIn", () => memberStepIn(contract, scanned, n >> 1));
  const apart = keyIdBelow(contract, rootId(7), "t");
  site("compareKeyIds", () => compareKeyIds(contract, deepest, apart));
  // (width and branching, #1454 r1: `n` children below a step `n` code units wide, each compared with a short sibling;
  // two siblings whose steps share their first `n` code units)
  const wide = keyIdBelow(contract, rootId(13), "q".repeat(n));
  const children = Array.from({ length: n }, (_, k) => keyIdBelow(contract, wide, `s${k}`));
  const short = keyIdBelow(contract, rootId(13), "a");
  site("compareKeyIds, wide branching", () =>
    children.map((child) => compareKeyIds(contract, child, short)),
  );
  const [left, right] = ["0", "1"].map((end) =>
    keyIdBelow(contract, rootId(14), `p${"a".repeat(n)}${end}`),
  );
  site("compareKeyIds, shared prefix", () => compareKeyIds(contract, left!, right!));
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

/**
 * Each conversion at its boundary inputs (a place's own key, one step, three; a span from the start, the middle and the
 * end, an empty one), on a pass of its own in each state: cold; repeated, the same call made before on the same
 * contracts; and for a span, cached, the whole path's steps kept first. Its cursor and packet are made before it is
 * measured, so the units are the call's alone, each at least the nodes and lookups any conversion of its input must
 * inspect (Astra r1 B1: a cold empty span charged nothing; Codex r3 H1: setup charges hid such a call). The parts
 * (`keyIdParent`, `keyIdStep`, …) are constant reads, no conversion.
 */
test("every cursor conversion charges at least what it must inspect, alone, at every boundary, cold, repeated and cached", () => {
  const source = request("let x = 1\nexit\n");
  const problems: string[] = [];
  for (const depth of [0, 1, 3]) {
    const steps = Array.from({ length: depth }, (_, k) => (k === 1 ? "values" : `s${k}`));
    const text = keyOf(6, steps);
    for (const state of ["cold", "repeated", "cached"] as const) {
      // (per call: its name, its call on the prepared cursor and packet, and its least inspection in this state)
      const calls: (readonly [
        string,
        (contract: Contract, fresh: Contract, id: KeyId, packet: KeyPacket) => void,
        number,
      ])[] = [
        ["keyIdBelow", (contract, _, id) => keyIdBelow(contract, id, "n"), 1],
        ["keyIdOf", (contract) => keyIdOf(contract, 6, steps), depth],
        ["keyIdOfText", (contract) => keyIdOfText(contract, text), 1 + depth],
        ["keyOfId", (contract, _, id) => keyOfId(contract, id), state === "cold" ? depth + 1 : 1],
        ...[0, depth >> 1, depth].map(
          (from) =>
            [
              `stepsOfId @${from}`,
              (contract: Contract, _: Contract, id: KeyId) => stepsOfId(contract, id, from),
              state === "cached" || (state === "repeated" && from === 0) ? 1 : depth - from + 1,
            ] as const,
        ),
        ...[0, depth].map(
          (from) =>
            [
              `memberStepIn @${from}`,
              (contract: Contract, _: Contract, id: KeyId) => memberStepIn(contract, id, from),
              1,
            ] as const,
        ),
        ["exportKeyIds", (contract, _, id) => exportKeyIds(contract, [id]), depth + 1],
        ["importKeyIds", (_, fresh, __, packet) => importKeyIds(fresh, packet), depth + 1],
      ];
      for (const [name, call, least] of calls) {
        if (state === "cached" && !name.startsWith("stepsOfId")) continue;
        const [contract, fresh] = [narrowingPass(source).contract, narrowingPass(source).contract];
        const id = keyIdOf(contract, 5, steps);
        const packet = exportKeyIds(contract, [id]);
        if (state === "repeated") call(contract, fresh, id, packet);
        if (state === "cached") stepsOfId(contract, id, 0);
        const { work } = probeMade(name === "importKeyIds" ? fresh : contract, () =>
          call(contract, fresh, id, packet),
        );
        const inspected = work.counters.invSteps ?? 0;
        if (inspected < least)
          problems.push(
            `${name}, ${depth} steps, ${state}: ${inspected} charged, at least ${least}`,
          );
      }
    }
  }
  assert.deepEqual(problems, []);
});

/** The constructions of a text in the cursor modules, by form. */
const MADE_FORMS: readonly (readonly [string, RegExp])[] = [
  ["template", /`[^`]*\$\{/g],
  ["slice", /\.slice\(/g],
  ["concatenation", /\.concat\(|\.join\(|["'`]\s*\+[^+=]|[^+]\+\s*["'`]/g],
  ["joinParts", /\bjoinParts\(/g],
];

/** The ones there are, by file and form, and why each is bounded or charged. */
const MADE_LISTED: Readonly<Record<string, readonly [number, string]>> = {
  "key-ids.ts template": [
    7,
    "the cursor's type and text (two numbers); two error messages; a span's name (a path's id after a dot); a replayed name's cursor and span tokens (numbers, `exportNames`)",
  ],
  "key-ids.ts slice": [
    16,
    "a cursor's place and path; a key text's step to look up and its place, its scan charged (`keyIdOfText`); a kept path's span, kept (`keptArray`); a text key's parent and prefixes as the legacy sites made them (`keyParentIn`, `keyWalk`, `keyPrefixIn`); a text key's first step and place, to ask its lane (`canonicalKey`, one step); an array's views as the legacy sites made them (`arrayRef`, three); a demand name's span and cursor tokens read back as numbers (`compareDemandNames`, `exportNames`, `importNames`)",
  ],
  "key-ids.ts concatenation": [
    3,
    "a demand name with its cursors' texts, charged and kept once per name (`compareDemandNames`); a component's names for a replay and back (`exportNames`, `importNames`, the solver's test seam)",
  ],
  "key-ids.ts joinParts": [
    3,
    "two places' decimal texts with their bar (`compareKeyIds`); a wrapper literal's array rest, the legacy demand name's text, kept once (`canonicalRest`)",
  ],
  "lanes.ts joinParts": [
    2,
    "a family's memo key: charged where kept (`wrapperShape`), looked up (`keyLane`)",
  ],
  "lanes.ts slice": [
    1,
    "a recorded question's stack frames, under `withKeyRecords`' sites alone (evidence, `producer`)",
  ],
};

test("the cursor modules make no text but the listed ones, each bounded or charged (#1454 r1: the probe cannot see a string being made)", () => {
  const found: Record<string, number> = {};
  for (const file of ["key-ids.ts", "lanes.ts"]) {
    const source = readFileSync(
      new URL(`../../src/type-inference/core/contract/${file}`, import.meta.url),
      "utf8",
    );
    // (code only, comments aside)
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const [form, pattern] of MADE_FORMS) {
      const count = [...code.matchAll(pattern)].length;
      if (count > 0) found[`${file} ${form}`] = count;
    }
  }
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(MADE_LISTED).map(([key, [count]]) => [key, count])),
  );
});

test("the early selector alone (\`withTextKeys\`, criterion 3's seam): every family's keys their text, its shapes still found, its answers the cursors'", () => {
  const source = request(wrapped(4, "every-depth"));
  const bindings = new CoreProgram(source).places
    .filter(({ kind }) => kind.kind === "binding")
    .map(({ id }) => id);
  const cursors = publishedAnswers(analyseCore(source), bindings, source).text;
  const { result, records } = withKeyRecords(() => withTextKeys(() => analyseCore(source)));
  assert.equal(publishedAnswers(result, bindings, source).text, cursors);
  assert.ok(records.some((record) => record.kind === "shape" && record.outcome === "wrapper"));
  assert.ok(records.every((record) => record.kind !== "lane" || record.lane === "text"));
});

test("a wrapper's own cell copying a written binding lands below its place's own key (A4): its cursor's path is decided, and the plan checks it, as the text lane does (the corpus's `null/direct` cases)", () => {
  const files = [
    {
      path: "main.tease",
      source:
        "let typed:null=null\nlet root={f:typed,g:typed}\nlet foreign={f:hostValue,g:typed}\nlet a=foreign\na=a\nlet mid=a\nlet c=root\nc=mid\nc.f=null\nexit\n",
    },
  ];
  const { result, records } = withKeyRecords(() => publishedRoute(files, GLOBALS));
  assert.ok(records.some((record) => record.kind === "lane" && record.lane === "cursor"));
  assert.equal(result.text, withTextKeys(() => publishedRoute(files, GLOBALS)).text);
});
