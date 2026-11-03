import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import type { TypePlan } from "../src/plan/model.js";
import {
  createSerializableList,
  createSerializableObject,
} from "../src/runtime/values/serializable-values.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { storeContracts } from "../src/type-inference/core/consumer.js";
import { propertyStep } from "../src/type-inference/core/program.js";
import { outsideSyntax } from "../src/type-inference/core/slice-syntax.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import {
  capturedWithin,
  planChecks,
  storeRunProblems,
  type Globals,
  type Span,
} from "./helpers/type-core-contract-knowledge.js";
import { heldStops, HELD_MODES, type HeldMode } from "./helpers/type-core-held-host.js";

/*
 * The contracts of stable admission (#1526 phase B, TABLE r4.278; #1556): once admission settled, before the walk, the
 * contract of each store owing a check is captured while the solver still runs, so a stop in the walk or the
 * publication keeps the store's whole check; a stop while the capture runs (`extraction`) leaves what it cut lost, with
 * the plan's check as before. Judged by what the script does: a fitting value reaches AFTER, a forbidden one fails at the
 * store.
 */

const GLOBALS = ["hostValue", "hostOther"];
const L = (...items: Parameters<typeof createSerializableList>[0]) => createSerializableList(items);
const O = (
  fields: Readonly<Record<string, Parameters<typeof createSerializableList>[0][number]>>,
) => createSerializableObject(Object.entries(fields).map(([name, value]) => ({ name, value })));

/** A list of lists of whole numbers, the type each witness's store receives. */
const NESTED: TypePlan = { kind: "list", element: { kind: "list", element: { kind: "integer" } } };

/** A witness: its source, its store's statement and the values that fit and that do not. */
interface Witness {
  readonly name: string;
  readonly source: string;
  readonly store: string;
}

const WITNESSES: readonly Witness[] = [
  {
    name: "#1556",
    source: 'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue\nsay "AFTER"\nexit\n',
    store: "b.f = hostValue",
  },
  {
    name: "#1526",
    source:
      'let root={f:[[1]], extra:42}\nlet w0={entry:root}\nlet w1={shell:w0}\nlet w2={entry:w1}\nlet old=w2.entry.shell.entry\nsay "BEFORE"\nw2.entry.shell.entry.f=hostValue\nsay "AFTER"\nexit\n',
    store: "w2.entry.shell.entry.f=hostValue",
  },
];

const FITTING: readonly Globals[] = [{ hostValue: L(L(2)), hostOther: 3 }];
const FORBIDDEN: readonly Globals[] = [{ hostValue: L(L("x")), hostOther: 3 }];

/**
 * A case's settled stops in a mode, at most four of each phase: its first, its last and two evenly between. CI judges
 * these; the sweep of every allowance in four modes, against `main` at the same work (TABLE r4.295), is the PR's queue
 * evidence.
 */
function sampledStops(source: string, mode: HeldMode): { allowance: number; phase: string }[] {
  const byPhase = new Map<string, { allowance: number; phase: string }[]>();
  for (const stop of heldStops({ name: "sampled", source, slice: true, values: [] }, mode)) {
    const list = byPhase.get(stop.phase) ?? [];
    list.push(stop);
    byPhase.set(stop.phase, list);
  }
  return [...byPhase.values()].flatMap((list) =>
    list.length <= 4
      ? list
      : [0, 1, 2, 3].map((i) => list[Math.round((i * (list.length - 1)) / 3)]!),
  );
}

const spanOf = (source: string, text: string): Span => {
  const start = source.indexOf(text);
  return { start, end: start + text.length };
};

test("a copied store's whole contract is checked at the settled stops past its capture (#1556, #1526)", () => {
  for (const witness of WITNESSES) {
    const { source } = witness;
    const store = spanOf(source, witness.store);
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    for (const mode of HELD_MODES) {
      const natural = mode.run(() => analyseCore(request));
      const [captured] = capturedWithin(natural, store);
      assert.ok(captured?.result.state === "complete", `${witness.name} ${mode.name}: unstopped`);
      assert.deepEqual(captured.result.ref, NESTED);
      const stops = sampledStops(source, mode);
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
        // (a stop while the capture runs: reported lost where it cut, with its cause, never complete or open and never
        // silently; the plan's check is what it was before the capture, decision 2 pending)
        assert.ok(result?.state === "lost", `${at}: ${result?.state}`);
        assert.equal(result.cause, "extraction", at);
      }
    }
  }
});

/** A receiving literal: `a`'s copy `depth` copies down stores `width` fields, host data in its first or its last. */
function receiving(depth: number, width: number, hostFirst: boolean): [string, string] {
  const fields = ["f0: [[1]]", ...Array.from({ length: width - 1 }, (_, i) => `f${i + 1}: ["s"]`)];
  const copies = Array.from(
    { length: depth },
    (_, i) => `let c${i + 1} = ${i === 0 ? "a" : `c${i}`}`,
  );
  const stored = [
    "f0: hostValue",
    ...Array.from({ length: width - 1 }, (_, i) => `f${i + 1}: ["t"]`),
  ];
  const literal = hostFirst ? stored : [...stored.slice(1), stored[0]!];
  return [
    `let a = {${fields.join(", ")}}\n${copies.join("\n")}`,
    `c${depth} = {${literal.join(", ")}}`,
  ];
}

test("host data inside a stored object literal is captured with its whole store (Codex r1 on #1606)", () => {
  // (the ingress sites lie inside the store's value, not at it: the store owes its whole check all the same, as the
  // lowering finds the store of each obligation's expression; no stop past the capture weakens it, the questions' stops
  // after the analysis included. Codex's two witnesses in four modes, the receiving-literal family across copy depth,
  // width and field order in two)
  const nested = { hostValue: L(L(2)), hostOther: 3 };
  const wrong = { hostValue: L(L("x")), hostOther: 3 };
  const rows: readonly (readonly [
    string,
    string,
    readonly Globals[],
    readonly Globals[],
    readonly HeldMode[],
  ])[] = [
    [
      'let a = {z: [[1]], a: ["s"]}\nlet b = a',
      "b = {a: hostOther, z: hostValue}",
      [{ hostValue: L(L(2)), hostOther: L("t") }],
      [
        { hostValue: L(L("x")), hostOther: L("t") },
        { hostValue: L(L(2)), hostOther: L(3) },
      ],
      HELD_MODES,
    ],
    [
      'let a = {f: [[1]], g: ["s"]}\nlet b = a',
      'b = {f: hostValue, g: ["t"]}',
      [nested],
      [wrong],
      HELD_MODES,
    ],
    ...(
      [
        [1, 2, false],
        [3, 2, true],
        [2, 4, false],
      ] as const
    ).map(
      ([depth, width, hostFirst]) =>
        [
          ...receiving(depth, width, hostFirst),
          [nested],
          [wrong],
          [HELD_MODES[0]!, HELD_MODES[3]!],
        ] as const,
    ),
  ];
  for (const [setup, storeText, fitting, forbidden, modes] of rows) {
    const source = `${setup}\nsay "BEFORE"\n${storeText}\nsay "AFTER"\nexit\n`;
    const store = spanOf(source, storeText);
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    for (const mode of modes) {
      const natural = mode.run(() => analyseCore(request));
      const [captured] = capturedWithin(natural, store);
      assert.ok(captured?.result.state === "complete", `${storeText} ${mode.name}: unstopped`);
      const compiled = (allowance?: number) =>
        mode.run(() =>
          allowance === undefined
            ? compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND)
            : withTestAllowance(allowance, () =>
                compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND),
              ),
        ).plan;
      const naturalPlan = compiled();
      const whole = planChecks(naturalPlan);
      assert.deepEqual(whole, [captured.result.ref], `${storeText} ${mode.name}`);
      assert.deepEqual(storeRunProblems(naturalPlan!, store, fitting, forbidden), []);
      // (the settled stops past the capture, and four where the questions after the analysis run out)
      const total = natural.budget.total;
      const questions = [0, 128, 256, 384].map((more) => ({
        allowance: total + more,
        phase: "question",
      }));
      for (const { allowance, phase } of [...sampledStops(source, mode), ...questions]) {
        if (phase === "extraction") continue;
        const at = `${storeText} ${mode.name}, ${phase} stop at ${allowance}`;
        const plan = compiled(allowance);
        assert.deepEqual(planChecks(plan), whole, at);
        assert.deepEqual(storeRunProblems(plan!, store, fitting, forbidden), [], at);
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
    for (const { allowance, phase } of sampledStops(source, mode)) {
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
    // (two such stops are enough here; every allowance is the PR's queue evidence)
    if (witnessed === 2) break;
  }
  assert.ok(witnessed > 0, "some stop leaves `g` alone unfinished");
});

test("a property whose proof a stop cut leaves its later complete sibling checked (Codex r1 on #1606)", () => {
  // (`g` decided before the capture by its own store, `f` cut: the later sibling's check stands at the store)
  const source =
    'let a = {f: [[1]], g: 1}\nlet b = a\nb.g = 2\nsay "BEFORE"\nb = hostValue\nsay "AFTER"\nexit\n';
  const store = spanOf(source, "b = hostValue");
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  const f = propertyStep("f");
  let witnessed = 0;
  for (const { allowance, phase } of heldStops(
    { name: "later sibling", source, slice: true, values: [] },
    HELD_MODES[0]!,
  )) {
    if (phase !== "extraction") continue;
    const answers = withTestAllowance(allowance, () => analyseCore(request));
    const [result] = storeContracts(answers, request).values();
    if (result?.state !== "lost" || !result.required.every((level) => level.path[0] === f))
      continue;
    witnessed += 1;
    const at = `stop at ${allowance}`;
    const partial = result.partial;
    assert.ok(partial?.kind === "object", at);
    assert.deepEqual(
      partial.properties.find((property) => property.name === "g")?.type,
      { kind: "integer" },
      at,
    );
    const { plan } = withTestAllowance(allowance, () =>
      compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND),
    );
    assert.deepEqual(
      storeRunProblems(
        plan!,
        store,
        [{ hostValue: O({ f: L(L(2)), g: 3 }), hostOther: 3 }],
        [{ hostValue: O({ f: L(L(2)), g: "x" }), hostOther: 3 }],
      ),
      [],
      at,
    );
    // (two such stops are enough here; every allowance is the PR's queue evidence)
    if (witnessed === 2) break;
  }
  assert.ok(witnessed > 0, "some stop leaves `f` alone unfinished");
});

test("a stop in the capture leaves every request after the one it cut lost, never absent (Codex r1 on #1606)", () => {
  const source =
    'let a = {f: [[1]]}\nlet b = a\nlet c = a\nsay "BEFORE"\nb.f = hostValue\nc.f = hostValue\nsay "AFTER"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  const stores = [spanOf(source, "b.f = hostValue"), spanOf(source, "c.f = hostValue")];
  let cutFirst = 0;
  for (const { allowance, phase } of heldStops(
    { name: "tail", source, slice: true, values: [] },
    HELD_MODES[0]!,
    3,
  )) {
    if (phase !== "extraction") continue;
    const answers = withTestAllowance(allowance, () => analyseCore(request));
    const at = `stop at ${allowance}`;
    for (const span of stores) assert.equal(capturedWithin(answers, span).length, 1, at);
    const first = answers.contracts.findIndex(({ result }) => result.state === "lost");
    assert.ok(first >= 0, at);
    if (first === 0) cutFirst += 1;
    for (const { result } of answers.contracts.slice(first))
      assert.ok(result.state === "lost" && result.cause === "extraction", at);
  }
  assert.ok(cutFirst > 0, "some stop cuts the first request");
});

test("the candidate route's decline and the capture's skip read one syntax rule", () => {
  // (whether a program is inside the slice's syntax is the slice's: the route declines before its analysis exactly where
  // the capture requests nothing, at the same construct)
  const programs: readonly (readonly [string, boolean])[] = [
    ['let a = {f: [[1]]}\nlet b = a\nb.f = hostValue\nsay "AFTER"\nexit\n', true],
    ['let a = {f: [[1]], g: ["s"]}\nlet b = a\nb = hostValue\nexit\n', true],
    [
      'let a = {f: [[1]]}\nlet b = a\nif hostValue is integer {say "x"}\nb.f = hostValue\nexit\n',
      false,
    ],
    ['let a = {f: [[1]]}\nlet b = a\nb.f = hostValue\nsay "${hostOther}"\nexit\n', false],
    ["let n = 1\nn += hostOther\nlet a = {f: [[1]]}\nlet b = a\nb.f = hostValue\nexit\n", false],
  ];
  for (const [source, inside] of programs) {
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
    const outside = outsideSyntax(request.files, new Set(GLOBALS));
    assert.equal(outside === null, inside, source);
    let declined: CandidateOutsideSlice | null = null;
    try {
      compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND);
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      declined = error;
    }
    if (outside !== null) {
      assert.equal(declined?.what, outside.what, source);
      assert.equal(declined.site.start, outside.span.start.offset, source);
    }
    // (every program here owes a store's check: captured inside the syntax, nothing outside)
    assert.equal(analyseCore(request).contracts.length > 0, inside, source);
  }
});

test("outside the slice's syntax the capture requests nothing and charges nothing", () => {
  // (a program the route declines by its syntax: the analysis is main's, no extraction phase at any allowance and no
  // contract, also where a store's value is cyclic, which the capture would follow to the slice's depth)
  const source =
    'let typed:integer[]=[1]\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\nif hostValue is integer {a=b}\nb=a\nb.q=a\nc=b\nlet out={p:c}\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  assert.notEqual(outsideSyntax(request.files, new Set(GLOBALS)), null);
  for (const mode of HELD_MODES) {
    const natural = mode.run(() => analyseCore(request));
    assert.equal(natural.budget.exhausted, null, mode.name);
    assert.deepEqual(natural.contracts, [], mode.name);
    const phases = new Set(
      heldStops({ name: "outside", source, slice: false, values: [] }, mode, 64).map(
        (stop) => stop.phase,
      ),
    );
    assert.ok(!phases.has("extraction"), `${mode.name}: ${[...phases].join(", ")}`);
  }
});

test("the capture ends at the first store whose contract leaves the slice's depth", () => {
  // (graph/533 of the corpus: two cyclic stores, read. The first contract deeper than the slice follows takes the program
  // out of the slice, as main's lowering leaves it at its first such check and asks nothing more: the analysis runs to its
  // end, its work main's analysis and that one walk, which main pays after its analysis (22,958,262 units forward on
  // `55bade020`), and the capture's own reads of the walk's levels (4,555). A regression oracle of this construction. In
  // the first mode alone in CI: each mode walks one cyclic contract of about 23 million units, seconds; every mode is
  // #1606's queue evidence)
  const source =
    'let typed:object={x:1}\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\na.q=b\nb.q=a\nc=[a,b][0]\nc=a\nlet out={p:c}\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  const { budget, contracts } = HELD_MODES[0]!.run(() => analyseCore(request));
  assert.equal(budget.exhausted, null);
  assert.equal(budget.stoppedIn, null);
  assert.deepEqual(contracts, []);
  assert.equal(budget.total, 22_962_817);
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
    for (const { allowance, phase } of sampledStops(source, mode)) {
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
