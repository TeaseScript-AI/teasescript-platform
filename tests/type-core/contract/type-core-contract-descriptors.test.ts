import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../../../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../../../src/plan/model.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../../src/type-inference/core/budget.js";
import { storeContracts } from "../../../src/type-inference/core/check-result/check-result.js";
import {
  ContractDescriptors,
  type ContractReader,
} from "../../../src/type-inference/core/contract-descriptors.js";
import { propertyStep } from "../../../src/type-inference/core/program.js";
import { createSerializableList as list } from "../../../src/runtime/values/serializable-values.js";
import { planCheckList } from "../../helpers/plan-checks.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { heldStops, HELD_MODES } from "../../helpers/type-core-held-host.js";
import { runGlobals } from "../../helpers/type-core-route.js";

/*
 * The contract proof/descriptor service (#1526 phase A): a store's required contract is one descriptor per
 * distinct contract, shared by reference whatever the receiving place's name; built on a task stack; and a level whose
 * proof a stop cut is lost, never complete or open.
 */

const GLOBALS = ["hostValue", "hostOther"];

/** The type checks of a plan's instructions, in order. */
function checks(plan: InstructionPlan | null): { type: TypePlan; place: string }[] {
  return (plan?.instructions ?? []).flatMap((instruction) =>
    "typeCheck" in instruction && instruction.typeCheck !== undefined
      ? [instruction.typeCheck]
      : [],
  );
}

test("equal contracts are one descriptor, whatever place receives them", () => {
  const source =
    "let a = [[1]]\nlet b = [[2]]\nlet c = [3]\na = hostValue\nb = hostValue\nc = hostValue\nexit\n";
  const { plan } = compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND);
  const [a, b, c] = checks(plan);
  assert.deepEqual(
    [a?.place, b?.place, c?.place],
    ["'a'", "'b'", "'c'"],
    "each store names its own place",
  );
  const nested = { kind: "list", element: { kind: "list", element: { kind: "integer" } } };
  assert.deepEqual(a!.type, nested);
  assert.equal(a!.type, b!.type, "a and b receive one contract: one descriptor");
  assert.deepEqual(c!.type, { kind: "list", element: { kind: "integer" } });
  assert.notEqual(c!.type, a!.type);
  // (a part is a contract of its own: the integer below `a`'s lists is `c`'s element)
  assert.ok(a!.type.kind === "list" && a!.type.element?.kind === "list");
  assert.ok(c!.type.kind === "list");
  assert.equal(a!.type.element.element, c!.type.element);
  assert.ok(Object.isFrozen(a!.type), "a descriptor is immutable");
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  const results = [...storeContracts(analyseCore(request), request).values()];
  assert.deepEqual(
    results.map((result) => result.state),
    ["complete", "complete", "complete"],
  );
  const [first, second] = results;
  assert.ok(first?.state === "complete" && second?.state === "complete");
  assert.equal(first.ref, second.ref);
});

test("a copy's lazily decided level is complete with its whole contract or lost, never open, at every settled stop (#1556)", () => {
  const source =
    'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue\nsay "AFTER"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  const site = `0:${source.indexOf("b.f")}:${source.indexOf("\nsay", source.indexOf("b.f"))}`;
  // (what `b.f` receives: a copy of `a.f`, a list of lists of whole numbers, ADR 0021 1.3)
  const whole = { kind: "list", element: { kind: "list", element: { kind: "integer" } } };
  const element = [propertyStep("f"), "element"].join(".");
  // (the levels the capture leaves unfinished where a stop cuts it: at or below `b.f`'s element)
  for (const mode of HELD_MODES) {
    const natural = mode.run(() => storeContracts(analyseCore(request), request)).get(site);
    assert.ok(natural?.state === "complete", `${mode.name}: unstopped, the contract is complete`);
    assert.deepEqual(natural.ref, whole);
    const stops = heldStops({ name: "copy-nested", source, slice: true, values: [] }, mode, 8);
    assert.ok(stops.some((stop) => stop.phase === "walk"));
    for (const { allowance, phase } of stops) {
      const at = `${mode.name}, ${phase} stop at ${allowance}`;
      const answers = mode.run(() => withTestAllowance(allowance, () => analyseCore(request)));
      assert.ok(answers.budget.settled, at);
      const result = storeContracts(answers, request).get(site);
      const { plan } = mode.run(() =>
        withTestAllowance(allowance, () =>
          compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND),
        ),
      );
      const checked = checks(plan)[0]?.type;
      // complete only with the whole contract, checked at the store; else lost at the unfinished level, the plan
      // carrying the part it holds
      if (result?.state === "complete") {
        assert.deepEqual(result.ref, whole, at);
        assert.deepEqual(checked, whole, `${at}: the plan checks the whole contract`);
        continue;
      }
      assert.ok(result?.state === "lost", `${at}: lost, not ${result?.state}`);
      assert.equal(result.cause, "stop", at);
      assert.ok(
        result.required.length > 0 &&
          result.required.every((level) => level.path.join(".").startsWith(element)),
        `${at}: a level at or below \`b.f\`'s element is the one whose proof is unfinished`,
      );
      // (a lost contract with no part leaves the store to the check its warning names, `storedKinds`)
      if (result.partial !== null)
        assert.deepEqual(checked, result.partial, `${at}: the plan carries the part`);
    }
  }
});

test("a contract deeper than the native stack is assembled on the task stack", () => {
  // (a synthetic reader: an object whose one property is an object, `depth` levels deep, an integer at the bottom)
  const depth = 10_000;
  const reader: ContractReader = {
    level: (_place, path) =>
      path.length < depth
        ? { by: "decided", tags: ["object"], inherited: false, unfinished: false }
        : { by: "decided", tags: ["integer"], inherited: false, unfinished: false },
    properties: () => new Set(["p"]),
  };
  const descriptors = new ContractDescriptors<null>(
    reader,
    () => ({ elements: null, field: () => null, order: (names) => [...names] }),
    1,
    false,
    Number.POSITIVE_INFINITY,
  );
  const result = descriptors.result(0, [], null, () => assert.fail("no level is too deep"));
  assert.ok(result.state === "complete");
  let levels = 0;
  let at: TypePlan = result.ref;
  for (; at.kind === "object"; levels += 1) {
    assert.equal(at.properties.length, 1);
    assert.equal(at.properties[0]!.name, "p");
    at = at.properties[0]!.type;
  }
  assert.equal(levels, depth);
  assert.deepEqual(at, { kind: "integer" });
});

test("a written contract deeper than the native stack is one node, made on an explicit stack", () => {
  // (a list of lists `depth` deep with a whole number at the bottom, built and read without recursion)
  const depth = 12_000;
  const build = (): TypePlan => {
    let plan: TypePlan = { kind: "integer" };
    for (let level = 0; level < depth; level += 1) plan = { kind: "list", element: plan };
    return plan;
  };
  const descriptors = new ContractDescriptors<null>(
    { level: () => assert.fail("a written term reads no level"), properties: () => new Set() },
    () => ({ elements: null, field: () => null, order: (names) => [...names] }),
    1,
    false,
  );
  const first = descriptors.written(build(), 0, []);
  const second = descriptors.written(build(), 1, []);
  assert.ok(first.state === "complete" && second.state === "complete");
  assert.equal(first.ref, second.ref, "an equal written contract is the same node");
  let levels = 0;
  let at: TypePlan | null = first.ref;
  for (; at?.kind === "list"; levels += 1) {
    assert.ok(Object.isFrozen(at));
    at = at.element;
  }
  assert.equal(levels, depth);
  assert.deepEqual(at, { kind: "integer" });
});

/** The compile's exit from the slice (its message), or `null` where it compiles. */
function sliceExit(source: string): string | null {
  try {
    compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND);
    return null;
  } catch (error) {
    if (!(error instanceof CandidateOutsideSlice)) throw error;
    return error.message;
  }
}

test("lists that hold themselves compile under the nesting cut, warned and checked when the script runs (#1646, #2764)", () => {
  // (found on main: each nests its lists without end, and the facts' walk threw past the slice's depth and failed the
  // compile; until #2764 the walk left the slice at its depth cut. The nesting cut knows `l`, and `a.f`, two levels deep
  // (`[[1]]`'s), so the store of `[l]` meets a level the compiler cannot know: the analysis's three warnings, as before,
  // and a check at each store, of which the one at `[l]` fails whatever the host gives, as the warning says it may.
  // Today's checker gives a TSV041 error at `[l]` instead: a compile error the new analysis does not give yet, #2720)
  for (const [source, place, at] of [
    ['let l=[[1]]\nl=[l]\nl=hostValue\nsay "AFTER"\nexit\n', "'l'", 14],
    ["let a={f:[[1]]}\na.f=[a.f]\na.f=hostValue\nexit\n", "'a.f'", 20],
  ] as const) {
    const { plan, diagnostics } = compileSourceWithBackend(
      source,
      { globals: GLOBALS },
      CORE_BACKEND,
    );
    assert.ok(plan !== null, source);
    assert.deepEqual(
      diagnostics.map((d) => `${d.span.start.line + 1} ${d.severity} ${d.code}`),
      ["2 warning TSV041", "2 warning TSV041", "3 warning TSV041"],
      source,
    );
    assert.deepEqual(
      planCheckList(plan).map(({ line, type, place: checked }) => ({ line, type, place: checked })),
      [
        { line: 2, type: "list<list<integer>>", place },
        { line: 3, type: "list<list<integer>>", place },
      ],
      source,
    );
    for (const host of [list([list([list([1])])]), "s"]) {
      const run = runGlobals(plan, { hostValue: host });
      assert.equal(run.failure?.startsWith(`TSR058@${at}:`), true, `${source}: ${run.failure}`);
      assert.deepEqual(run.said, [], source);
    }
  }
});

test("a store whose contract's lists nest past the slice's depth leaves the slice at the lowering's depth cut (#1646)", () => {
  // (found on main by #1652's generated family, 57 of its first 1,300 seeds: `a.q=[a]` nests the lists below `a.q`
  // without end, and the lowering's walk of the store `a=a.q` threw past the slice's depth from its own `levelWalk`,
  // failing the compile; it now leaves the slice at that store's value, as its depth cut below an object or a collection
  // does)
  assert.equal(
    sliceExit("let a={}\na=a.q\na.q=[a]\na.f=hostValue\nexit\n"),
    "The candidate type analysis does not cover a value whose structure the slice does not follow yet (main.tease, offset 11).",
  );
});
