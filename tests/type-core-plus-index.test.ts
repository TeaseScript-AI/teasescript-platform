import assert from "node:assert/strict";
import test from "node:test";

import { Admission } from "../src/type-inference/core/admission.js";
import { analyseCore, solveDemands, type CorePass } from "../src/type-inference/core/answers.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { Consumers } from "../src/type-inference/core/consumers.js";
import {
  firstWriter,
  ingressLeaves,
  itemsSignature,
  writerKey,
  type Item,
  type Writer,
} from "../src/type-inference/core/items.js";
import type { PlusIndex } from "../src/type-inference/core/plus-index.js";
import type { CoreAnalysisRequest } from "../src/type-inference/core/program.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { itemScope } from "./helpers/type-core-items.js";
import { narrowingPass } from "./helpers/type-core-narrowing.js";
import { inMode, MODES } from "./helpers/type-core-oracles.js";

/*
 * #1384: a run of `+` asked below its elements at a third property indexes its terms by the properties their objects
 * hold (`plusSpan`) and answers each property from the terms holding it and the ranges of terms between them
 * (`indexedPlus`), on the value side, on the contract side and in admission's decider. Its answers are its operands'
 * walk's: the walk is the reference, asked first in a fresh pass (a pass's first property never indexes), the index
 * asked in another after two other properties of the same `+`.
 */

function request(source: string): CoreAnalysisRequest {
  const made = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(made !== null, source);
  return made;
}

/** An answer's items in their order, every field each carries, its writer and its ingress leaves by their keys. */
function ordered(items: readonly Item[]): string[] {
  return items.map((item) =>
    JSON.stringify({
      ...item,
      writer: item.writer === null ? null : writerKey(item.writer),
      ingress: item.ingress === undefined ? undefined : ingressLeaves(item.ingress).map(writerKey),
    }),
  );
}

/** The `+` operations of a pass's program, by their result places. */
function pluses(pass: CorePass): PlaceId[] {
  const out: PlaceId[] = [];
  for (const c of pass.program.opOf.values())
    if (c.kind === "operation" && c.contract.family === "operator" && c.contract.name === "+")
      out.push(c.result);
  return out;
}

/** A `+`'s answer at `path` on one side, at its own expression's node. */
function asked(pass: CorePass, value: PlaceId, path: readonly string[], exact: boolean): string[] {
  const c = pass.program.opOf.get(value)!;
  const node = c.kind === "operation" ? pass.program.exprAt(c.site) : null;
  return ordered(
    pass.solver.run(
      exact
        ? pass.values.valueItems(value, node, path)
        : pass.contract.contractOfValueAt(value, path),
    ),
  );
}

const run = "o + [{p: 1}] + o + [{r: 1}] + o + [{s: 1}] + o";

/** k joins along the left operands, and each join in the next one's right, a variable of objects read beside each. */
const left = (k: number): string =>
  `let o = [{q: 1}]\nlet xs = o + ${Array.from({ length: k }, (_, i) => `[{p${i}: 1}] + o`).join(" + ")}\nsay xs.length\nexit`;
const right = (k: number): string =>
  `let o = [{q: 1}]\nlet xs = ${Array.from({ length: k }).reduce<string>((e, _, i) => `[{p${i}: 1}] + (o + (${e}))`, "[{lastValue: 0}]")}\nsay xs.length\nexit`;

/** Programs with a run, whether its `+` are indexed, and the properties asked of each `+`. */
const RUNS: readonly { readonly source: string; readonly indexed: boolean }[] = [
  // along the left operands, and each join in the next one's right
  { source: `let o = [{q: 1}]\nlet xs = ${run}\nsay xs.length\nexit`, indexed: true },
  {
    source:
      "let o = [{q: 1}]\nlet xs = [{p: 1}] + (o + ([{r: 1}] + (o + [{s: 1}])))\nsay xs.length\nexit",
    indexed: true,
  },
  // holders lacking it in some objects, nested values below it, null
  {
    source:
      "let xs = [{q: 1}, {p: 2}] + [{p: [1]}] + [{r: {a: 1}}, {q: 2}] + [{s: null}] + [{}]\nsay xs.length\nexit",
    indexed: true,
  },
  // a missing, an empty object, a scalar, a null and an empty list beside the run's own objects (r1's defaults)
  ...["[{q: 1}]", "[{}]", "[{q: 1}, {p: 2}]"].map((literal) => ({
    source: `let o = ${literal}\nlet xs = ${run}\nsay xs.length\nexit`,
    indexed: true,
  })),
  ...["[1]", "[null]", "[]"].map((literal) => ({
    source: `let o = ${literal}\nlet xs = ${run}\nsay xs.length\nexit`,
    indexed: false,
  })),
  // a tested binding, its reads narrowed below the test; a second store; an unwritten read of host data
  {
    source: `let o = [{q: 1}]\nif o.first.p is integer {\n  let xs = ${run}\n  say xs.first.p\n}\nexit`,
    indexed: false,
  },
  {
    source: `let o = [{q: 1}]\no = [{p: 2}]\nlet xs = ${run}\nsay xs.length\nexit`,
    indexed: false,
  },
  { source: `let o = hostValue\nlet xs = ${run}\nsay xs.length\nexit`, indexed: false },
];

const STEPS: readonly string[] = ["p", "q", "r", "s", "absent"];

test("an indexed run of `+` answers below its elements as its operands' walk does, on both sides (#1384)", () => {
  const differing: string[] = [];
  for (const { source, indexed } of RUNS) {
    const made = request(source);
    for (const [m, mode] of MODES.entries())
      inMode(mode, () => {
        // (the index: its first `+` asked at two other properties first; the walk: each property a pass's first)
        const index = narrowingPass(made);
        for (const step of ["t", "u"]) asked(index, pluses(index)[0]!, ["element", step], true);
        for (const step of STEPS) {
          const walked = narrowingPass(made);
          for (const path of [
            ["element", step],
            ["element", step, "a"],
          ])
            for (const exact of [true, false])
              for (const value of pluses(walked)) {
                const expected = asked(walked, value, path, exact);
                const got = asked(index, value, path, exact);
                const span = index.contract.plusIndex?.indexed?.spans.get(value) ?? null;
                const where = `${source.split("\n").at(-3)}: ${value} at ${path.join(".")}, ${exact ? "value" : "contract"}, mode ${m}`;
                if ((span !== null) !== indexed) differing.push(`indexed: ${where}`);
                if (JSON.stringify(got) !== JSON.stringify(expected)) differing.push(where);
              }
        }
      });
  }
  assert.deepEqual(differing, []);
});

/** `run`'s admission passes in the order each first decides, and each finishing pass's index as it starts to finish. */
function observed<T>(run: () => T): {
  readonly result: T;
  readonly admission: readonly CorePass[];
  readonly finishing: readonly (PlusIndex | null)[];
} {
  const admission: CorePass[] = [];
  const finishing: (PlusIndex | null)[] = [];
  const { decide } = Admission.prototype;
  const { finish } = Consumers.prototype;
  Admission.prototype.decide = function (this: Admission, ...args) {
    if (!admission.includes(this.pass)) admission.push(this.pass);
    return decide.apply(this, args);
  };
  Consumers.prototype.finish = function (this: Consumers, all) {
    if (all) finishing.push(this.pass.contract.plusIndex);
    return finish.call(this, all);
  };
  try {
    return { result: run(), admission, finishing };
  } finally {
    Admission.prototype.decide = decide;
    Consumers.prototype.finish = finish;
  }
}

/** Whether a pass's index published a run. */
const published = (pass: CorePass): boolean =>
  [...(pass.contract.plusIndex?.indexed?.spans.values() ?? [])].some((span) => span !== null);

/**
 * Whether every run a pass's index published is whole: each span within its terms, each holder one of them, and the
 * tree of their earliest objects made to its root.
 */
function whole(pass: CorePass): boolean {
  for (const span of pass.contract.plusIndex?.indexed?.spans.values() ?? []) {
    if (span === null) continue;
    const { run, lo, hi } = span;
    const leaves = run.earliest.slice(run.width, run.width + run.terms.length);
    if (
      !(lo < hi && hi <= run.terms.length) ||
      [...run.holders.values()].some((list) => list.some((at) => at >= run.terms.length)) ||
      leaves.some((writer) => writer === null) ||
      run.earliest[1] !== leaves.reduce<Writer | null>(firstWriter, null)
    )
      return false;
  }
  return true;
}

test("a stop while a run is indexed publishes none of it, and a fresh pass finishes the analysis (#1384)", () => {
  const made = request(left(8));
  const analysed = (allowance: number | null) =>
    observed(() =>
      allowance === null
        ? analyseCore(made)
        : withTestAllowance(allowance, () => analyseCore(made)),
    );
  const natural = analysed(null);
  assert.ok(published(natural.admission[0]!), "the run is indexed");
  // (the least allowance whose first pass publishes the run: one unit less stops at the run's last charge)
  let low = 0;
  let high = natural.result.budget.total;
  while (low < high) {
    const middle = (low + high) >> 1;
    const first = analysed(middle).admission[0];
    if (first !== undefined && published(first)) high = middle;
    else low = middle + 1;
  }
  const stopped = analysed(low - 1);
  const pass = stopped.admission[0]!;
  assert.equal(stopped.result.budget.exhausted, "work");
  assert.ok((pass.contract.plusIndex?.indexed?.shapes.size ?? 0) > 0, "its terms proved");
  assert.ok(!published(pass), "none of its runs published");
  for (const each of [...natural.admission, ...stopped.admission]) assert.ok(whole(each));
  assert.ok(stopped.finishing.length > 0, "finished");
  assert.ok(
    stopped.finishing.every((state) => state === null),
    "each finishing pass starts without an index",
  );
});

/** A member's answer as a replay compares it: its items' signature and their ingress stores. */
function signature(items: readonly Item[]): string {
  const stores = items.map((item) =>
    item.ingress === undefined ? "" : ingressLeaves(item.ingress).map(writerKey).join(","),
  );
  return `${itemsSignature(items, itemScope())} ${stores.sort().join(";")}`;
}

test("an indexed run's answers replay by their names, and a cycle through its terms keeps its solver (#1384)", () => {
  for (const source of [left(3), right(3)]) {
    const made = request(source);
    const { result, admission } = observed(() => analyseCore(made));
    const pass = admission.at(-1)!;
    assert.ok(published(pass), "the run is indexed");
    // (each below an element's property, answered alone in a fresh pass: there by the walk)
    const names = result.budget.finished
      .map((demand) => demand.key)
      .filter((key) => /^(op|lit)\|/.test(key) && key.includes("|element."));
    assert.ok(names.length > 0);
    for (const name of names)
      assert.deepEqual(
        ordered(solveDemands(made, [name])[0]!),
        ordered(pass.solver.answer(name)!),
        name,
      );
  }
  for (const source of [
    "let a = [{q: 1}]\nlet b = [{p: 1}]\na = b + a\nb = a + b\nsay b.length\nexit",
    `let o = [{q: 1}]\no = o + [{r: 2}]\nlet xs = ${run}\nsay xs.length\nexit`,
  ]) {
    const made = request(source);
    const components: {
      readonly members: readonly { readonly key: string; readonly items: readonly Item[] }[];
      readonly replay: { readonly names: readonly string[]; readonly packet: unknown } | null;
    }[] = [];
    const { admission } = observed(() =>
      withSolverSeam(
        { onComponent: (members, replay) => components.push({ members, replay }) },
        () => analyseCore(made),
      ),
    );
    assert.ok(components.length > 0, source);
    for (const pass of admission) assert.ok(!published(pass), source);
    for (const { members, replay } of components) {
      const keys = replay?.names ?? members.map((member) => member.key);
      const expected = members.map((member) => signature(member.items));
      for (const entry of keys)
        for (const reverseWorklist of [false, true])
          assert.deepEqual(
            withSolverSeam({ reverseWorklist }, () =>
              solveDemands(made, [entry, ...keys], replay?.packet).slice(1),
            ).map(signature),
            expected,
            `${entry}${reverseWorklist ? " reversed" : ""}`,
          );
    }
  }
});
