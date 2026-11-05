import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../src/runtime/host-data/script-storage.js";
import {
  createSerializableList as list,
  createSerializableObject,
  type SerializableRuntimeValue,
} from "../src/runtime/values/serializable-values.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestDemandAllowance } from "../src/type-inference/core/budget.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";
import { runGlobals } from "./helpers/type-core-route.js";

// #1526 decision 2, condition 1 (TABLE r4.390): while a required check is missing at a stop, the candidate publishes no
// plan that lets the invalid value through unchecked. Sol's #1645 and #1648 witnesses, at a settled decision stop.

const GLOBALS = ["hostValue", "hostOther"];
const LOST = "a store whose check was lost at the budget";
const END = '\nsay "AFTER"\nexit\n';
const lines = (k: number, line: (at: number) => string): string =>
  Array.from({ length: k }, (_, at) => line(at)).join("\n");
const retarget = (k: number): string =>
  `let box = {first: {n: [[1]]}}\n${lines(k, (at) => `box = {first: {n: [[${at}]]}}`)}\nbox.first.n = hostValue`;
const reject = (k: number): string =>
  `let b = {f0: 1}\n${lines(k, (at) => `b = {f0: ${at}}`)}\nb = 5\nb.f0 = hostValue`;
const copied = (middle: string, tail: string): string =>
  `let b = {f: [[1]], first: {n: [[1]]}}\n${lines(16, (at) => `b = {f: [[${at}]], first: {n: [[${at}]]}}`)}\n${middle}\n${tail}`;
const object = (fields: Record<string, SerializableRuntimeValue>): SerializableRuntimeValue =>
  createSerializableObject(Object.entries(fields).map(([name, value]) => ({ name, value })));
const nested = (value: SerializableRuntimeValue): SerializableRuntimeValue => list([list([value])]);

/** A witness, the host values of its forbidden run, and the start of the stored value a decline names (unique). */
interface Witness {
  readonly name: string;
  readonly source: string;
  readonly forbidden: Readonly<Record<string, SerializableRuntimeValue>>;
  readonly at: string;
  readonly storage?: readonly RuntimeScriptStorageEntrySnapshot[];
}

const witness = (
  name: string,
  source: string,
  forbidden: Readonly<Record<string, SerializableRuntimeValue>> = {
    hostValue: nested("x"),
    hostOther: 3,
  },
  at = "hostValue",
  storage?: Witness["storage"],
): Witness => ({
  name,
  source: source + END,
  forbidden,
  at,
  ...(storage === undefined ? {} : { storage }),
});

/** At demand 16 in four modes: a required check is Lost at a settled decision stop (the witnesses' r4.295 column (2)). */
const DECLINED: readonly Witness[] = [
  witness(
    "1645-whole-object",
    'let a = {f: [[1]], g: ["s"]}\nlet b = a\nsay "BEFORE"\nb = {f: hostValue, g: ["t"]}',
    undefined,
    '{f: hostValue, g: ["t"]}',
  ),
  witness(
    "1645-property-order",
    'let a = {z: [[1]], a: ["s"]}\nlet b = a\nsay "BEFORE"\nb = {a: hostOther, z: hostValue}',
    { hostValue: nested("x"), hostOther: list(["t"]) },
    "{a: hostOther, z: hostValue}",
  ),
  witness("1648-retarget-exact", retarget(4)),
  witness("1648-retarget-whole", retarget(16)),
  // (a rejection's lost obligation: the stopped plan fails at an earlier store, but its check at the host store is lost)
  witness("1648-rejection", reject(16), { hostValue: "x" }),
  witness("1648-rejection-projection", copied('b.f = "s"', "let c = b.f\nc = hostValue")),
  witness("1648-rejection-wrapper", copied('b.f = "s"', "let c = {q: b}\nc.q = hostValue"), {
    hostValue: object({ f: nested("x"), first: object({ n: nested("x") }) }),
  }),
  witness(
    "1648-r2-escaping-wrapper",
    "let b = {first: {n: null}}\nb.first.n = [[1]]\nlet c = {q: b}\nc.q = hostValue",
    { hostValue: object({ first: object({ n: nested("x") }) }) },
  ),
  // (a store role's obligation, internal data: the natural compile rejects `combined={v:wide}`, the stop moves that to a
  // check against bare `unknown` at `let combined=base`)
  witness(
    "store-role-moved-error",
    'let wide:number=53\nlet narrow:string="s"\nlet base={v:narrow}\nlet combined=base\ncombined={v:wide}\nlet outcome=[base,combined]',
    {},
    "base\ncombined",
  ),
  // (Codex r1: a boundary the stop checks against bare `unknown`, no store, reader or part check carrying its contract)
  witness(
    "r1-get-default",
    "let a={n:[[1]]}\nlet b=a\nb.n=[hostValue].get(0,default:a.n)",
    { hostValue: nested("x") },
    "[hostValue]",
  ),
  witness(
    "r1-parse",
    "let a={n:[[1]]}\na=fromJson(hostValue,default:a,files:false)\nsay toJson(a)",
    { hostValue: '{"n":[["x"]]}' },
    "fromJson",
  ),
  witness("r1-load", 'let a={n:[[1]]}\nlet b=a\nb=load("k",default:a)\nsay toJson(b)', {}, "load", [
    { key: "k", value: object({ n: nested("x") }) },
  ]),
  // (declined at the first Lost store in source order: the retarget's, before the independent store's)
  witness(
    "1648-independent-beside-retarget",
    `${retarget(4)}\nlet independent = {value: [[1]]}\nindependent.value = hostOther`,
    { hostValue: nested(2), hostOther: nested("x") },
  ),
];

/** At demand 16 in four modes: every required check published with its contract; forbidden input fails before AFTER. */
const PUBLISHED: readonly Witness[] = [
  witness(
    "1645-spine",
    'let root={f:[[1]], extra:42}\nlet w0={entry:root}\nlet w1={shell:w0}\nlet w2={entry:w1}\nlet old=w2.entry.shell.entry\nsay "BEFORE"\nw2.entry.shell.entry.f=hostValue',
  ),
  witness("1645-copy", 'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue'),
  witness("1645-open", "let a = {f: []}\nlet b = a\nb.f = hostValue", { hostValue: 5 }),
];

function compiled(
  source: string,
  demand: number | null,
): ReturnType<typeof compileSourceWithBackend> {
  const once = () => compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND);
  return demand === null ? once() : withTestDemandAllowance(demand, once);
}

const said = (run: ReturnType<typeof runGlobals>): boolean =>
  run.said.some((at) => at.text === "AFTER");
// (forbidden input passes when the run reaches AFTER, and where the witness shows its value, shows the forbidden text:
// a typed parse or load that rejects its input takes its default and goes on)
const passes = (source: string, run: ReturnType<typeof runGlobals>): boolean =>
  said(run) && (!source.includes("toJson") || run.said.some((at) => at.text.includes('"x"')));

test("a program whose required check a settled stop lost is declined at its store, in four modes (#1526 decision 2, condition 1)", () => {
  for (const mode of MODES)
    for (const { name, source, forbidden, at, storage } of DECLINED) {
      const where = `${name} (mode ${JSON.stringify(mode)})`;
      // (natural: no stop, no registry, nothing declined; the natural compile or its plan rejects the forbidden input)
      const natural = inMode(mode, () => compiled(source, null));
      if (natural.plan !== null)
        assert.equal(
          passes(source, runGlobals(natural.plan, forbidden, storage)),
          false,
          `${where}: the natural plan rejects`,
        );
      assert.throws(
        () => inMode(mode, () => compiled(source, 16)),
        (error) =>
          error instanceof CandidateOutsideSlice &&
          error.what === LOST &&
          source.indexOf(at) === source.lastIndexOf(at) &&
          error.site.start === source.indexOf(at),
        where,
      );
    }
});

test("a stopped program whose required checks are all published with their contracts compiles and rejects forbidden input", () => {
  for (const mode of MODES)
    for (const { name, source, forbidden } of PUBLISHED) {
      const where = `${name} (mode ${JSON.stringify(mode)})`;
      const stopped = inMode(mode, () => compiled(source, 16));
      assert.ok(stopped.plan !== null, where);
      assert.equal(said(runGlobals(stopped.plan, forbidden)), false, `${where}: the check stands`);
    }
});

test("a check published against nothing where the natural plan checks a domain is lost: the open control at demand 32 (#1526)", () => {
  // (the natural plan checks `b.f` against `list`, so `5` fails there; at demand 32 in source order the stopped plan
  // would carry no check at the store, and the program is declined)
  const { source } = PUBLISHED.find((entry) => entry.name === "1645-open")!;
  for (const mode of MODES.filter((each) => !each.reversed)) {
    const natural = inMode(mode, () => compiled(source, null));
    assert.notEqual(runGlobals(natural.plan!, { hostValue: 5 }).failure, null);
    assert.throws(
      () => inMode(mode, () => compiled(source, 32)),
      (error) => error instanceof CandidateOutsideSlice && error.what === LOST,
      JSON.stringify(mode),
    );
  }
});

test("a program the analysis rejects is rejected, not declined, whatever check a stop lost", () => {
  const source = `let z: integer = "s"\n${DECLINED[0]!.source}`;
  for (const mode of MODES) {
    const stopped = inMode(mode, () => compiled(source, 16));
    assert.equal(stopped.plan, null, JSON.stringify(mode));
    assert.ok(
      stopped.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      JSON.stringify(mode),
    );
  }
});
