import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import type { TypePlan } from "../src/plan/model.js";
import { createSerializableList } from "../src/runtime/values/serializable-values.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { storeContracts } from "../src/type-inference/core/consumer.js";
import { propertyStep } from "../src/type-inference/core/program.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import {
  capturedWithin,
  planChecks,
  storeRunProblems,
  type Globals,
  type Span,
} from "./helpers/type-core-contract-knowledge.js";
import { heldStops, HELD_MODES } from "./helpers/type-core-held-host.js";

/*
 * The contracts of stable admission (#1526 phase B, TABLE r4.278; #1556): once admission settled, before the walk, the
 * contract of each store owing a check is captured while the solver still runs, so a stop in the walk or the
 * publication keeps the store's whole check; a stop while the capture runs (`extraction`) leaves what it cut lost, with
 * the plan's check as before. Judged by what the script does: a fitting value reaches AFTER, a forbidden one fails at the
 * store.
 */

const GLOBALS = ["hostValue", "hostOther"];
const L = (...items: Parameters<typeof createSerializableList>[0]) => createSerializableList(items);

/** A list of lists of whole numbers, the type each witness's store receives. */
const NESTED: TypePlan = { kind: "list", element: { kind: "list", element: { kind: "integer" } } };

/** A witness: its source, its store's statement and the values that fit and that do not. */
interface Witness {
  readonly name: string;
  readonly source: string;
  readonly store: string;
  readonly step: number;
}

const WITNESSES: readonly Witness[] = [
  {
    name: "#1556",
    source: 'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue\nsay "AFTER"\nexit\n',
    store: "b.f = hostValue",
    step: 5,
  },
  {
    name: "#1526",
    source:
      'let root={f:[[1]], extra:42}\nlet w0={entry:root}\nlet w1={shell:w0}\nlet w2={entry:w1}\nlet old=w2.entry.shell.entry\nsay "BEFORE"\nw2.entry.shell.entry.f=hostValue\nsay "AFTER"\nexit\n',
    store: "w2.entry.shell.entry.f=hostValue",
    step: 29,
  },
];

const FITTING: readonly Globals[] = [{ hostValue: L(L(2)), hostOther: 3 }];
const FORBIDDEN: readonly Globals[] = [{ hostValue: L(L("x")), hostOther: 3 }];

const spanOf = (source: string, text: string): Span => {
  const start = source.indexOf(text);
  return { start, end: start + text.length };
};

test("a copied store's whole contract is checked at every settled stop past its capture (#1556, #1526)", () => {
  for (const witness of WITNESSES) {
    const { source } = witness;
    const store = spanOf(source, witness.store);
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    for (const mode of HELD_MODES) {
      const natural = mode.run(() => analyseCore(request));
      const [captured] = capturedWithin(natural, store);
      assert.ok(captured?.result.state === "complete", `${witness.name} ${mode.name}: unstopped`);
      assert.deepEqual(captured.result.ref, NESTED);
      const stops = heldStops(
        { name: witness.name, source, slice: true, values: [] },
        mode,
        witness.step,
      );
      const phases = new Set(stops.map((stop) => stop.phase));
      assert.ok(phases.has("extraction") && (phases.has("walk") || phases.has("publication")));
      for (const { allowance, phase } of stops) {
        const at = `${witness.name} ${mode.name}, ${phase} stop at ${allowance}`;
        const answers = mode.run(() => withTestAllowance(allowance, () => analyseCore(request)));
        const result = capturedWithin(answers, store)[0]?.result;
        const { plan } = mode.run(() =>
          withTestAllowance(allowance, () =>
            compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND),
          ),
        );
        if (phase !== "extraction" || result?.state === "complete") {
          // (past its capture the store's contract is whole, and the plan checks it whole at the store)
          assert.ok(result?.state === "complete", `${at}: ${result?.state}`);
          assert.deepEqual(result.ref, NESTED, at);
          assert.deepEqual(planChecks(plan), [NESTED], at);
          assert.deepEqual(storeRunProblems(plan!, store, FITTING, FORBIDDEN), [], at);
          continue;
        }
        // (a stop while the capture runs: lost where it cut, never complete or open, the plan as before; or not yet
        // requested where the stop came before the capture found its stores)
        assert.ok(result === undefined || result.state === "lost", `${at}: ${result?.state}`);
        if (result?.state === "lost") assert.equal(result.cause, "extraction", at);
      }
    }
  }
});

test("a genuinely open part stays open past the capture, as unstopped", () => {
  for (const [name, source] of [
    ["host element", 'let a = {f: [hostOther]}\nlet b = a\nb.f = hostValue\nsay "AFTER"\nexit\n'],
    ["empty list", 'let a = {f: []}\nlet b = a\nb.f = hostValue\nsay "AFTER"\nexit\n'],
  ] as const) {
    const store = spanOf(source, "b.f = hostValue");
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    const mode = HELD_MODES[0]!;
    const open = { kind: "list", element: null };
    const natural = capturedWithin(analyseCore(request), store)[0]?.result;
    assert.ok(natural?.state === "complete", name);
    assert.deepEqual(natural.ref, open);
    for (const { allowance, phase } of heldStops(
      { name, source, slice: true, values: [] },
      mode,
      3,
    )) {
      if (phase === "extraction") continue;
      const answers = withTestAllowance(allowance, () => analyseCore(request));
      const result = capturedWithin(answers, store)[0]?.result;
      assert.ok(result?.state === "complete", `${name}, ${phase} stop at ${allowance}`);
      assert.deepEqual(result.ref, open, `${name}, ${phase} stop at ${allowance}`);
    }
  }
});

test("a property whose proof a stop cut leaves its complete sibling checked whole", () => {
  const source =
    'let a = {f: [[1]], g: [["s"]]}\nlet b = a\nsay "BEFORE"\nb = hostValue\nsay "AFTER"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  const g = propertyStep("g");
  let witnessed = 0;
  for (const { allowance, phase } of heldStops(
    { name: "siblings", source, slice: true, values: [] },
    HELD_MODES[0]!,
    3,
  )) {
    if (phase !== "extraction") continue;
    const answers = withTestAllowance(allowance, () => analyseCore(request));
    const [result] = storeContracts(answers, request).values();
    // (where the stop left `g` alone unfinished, `f`'s check is the whole one)
    if (result?.state !== "lost" || !result.required.every((level) => level.path[0] === g))
      continue;
    witnessed += 1;
    const partial = result.partial;
    assert.ok(partial?.kind === "object", `stop at ${allowance}`);
    assert.deepEqual(
      partial.properties.find((property) => property.name === "f")?.type,
      NESTED,
      `stop at ${allowance}`,
    );
  }
  assert.ok(witnessed > 0, "some stop leaves `g` alone unfinished");
});

test("each analysis's captured contracts are its own final pass's", () => {
  // (a store A6 rejects starts a second pass: the contracts are that pass's)
  const sources = [
    'let a = {f: [[1]]}\nlet b = a\nb.f = hostValue\nb.f = [["s"]]\nsay "AFTER"\nexit\n',
    'let xs = [1]\nxs = hostValue\nsay "AFTER"\nexit\n',
  ];
  for (const source of sources) {
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    const answers = analyseCore(request);
    const lowered = [...storeContracts(answers, request).values()];
    assert.equal(answers.contracts.length, 1, source);
    const result = answers.contracts[0]?.result;
    assert.ok(result?.state === "complete" && lowered[0]?.state === "complete", source);
    assert.equal(result.epoch, answers.epoch, source);
    assert.deepEqual(result.ref, lowered[0].ref, source);
  }
});

test("a stop while the capture runs keeps what admission found before it", () => {
  // (admission's own check of a written store stands at every stop in the capture: the capture runs after its findings
  // are marked, so a stop there takes none of them back)
  const source =
    'let n: integer = 1\nlet a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nn = hostOther\nb.f = hostValue\nsay "AFTER"\nexit\n';
  const written = spanOf(source, "n = hostOther");
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  // (the warning admission gives the written store, as unstopped)
  const warned = (answers: ReturnType<typeof analyseCore>): string[] =>
    answers.diagnostics
      .filter((d) => d.site.start >= written.start && d.site.end <= written.end)
      .map((d) => d.code);
  let stops = 0;
  for (const mode of HELD_MODES) {
    const natural = warned(mode.run(() => analyseCore(request)));
    assert.ok(natural.length > 0, mode.name);
    for (const { allowance, phase } of heldStops(
      { name: "written", source, slice: true, values: [] },
      mode,
      4,
    )) {
      if (phase !== "extraction") continue;
      stops += 1;
      const at = `${mode.name}, extraction stop at ${allowance}`;
      assert.deepEqual(
        warned(mode.run(() => withTestAllowance(allowance, () => analyseCore(request)))),
        natural,
        at,
      );
      const { plan } = mode.run(() =>
        withTestAllowance(allowance, () =>
          compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND),
        ),
      );
      assert.deepEqual(
        storeRunProblems(
          plan!,
          written,
          [{ hostValue: L(L(2)), hostOther: 2 }],
          [{ hostValue: L(L(2)), hostOther: "x" }],
        ),
        [],
        at,
      );
    }
  }
  assert.ok(stops > 0);
});
