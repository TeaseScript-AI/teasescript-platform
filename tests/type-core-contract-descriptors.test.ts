import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../src/plan/model.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { storeContracts } from "../src/type-inference/core/consumer.js";
import {
  ContractDescriptors,
  type ContractReader,
} from "../src/type-inference/core/contract-descriptors.js";
import { propertyStep } from "../src/type-inference/core/program.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { heldStops, HELD_MODES } from "./helpers/type-core-held-host.js";

/*
 * The contract proof/descriptor service (#1526 phase A, TABLE r4.278): a store's required contract is one descriptor per
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

test("a level a copy decides lazily is lost at every settled stop, and its check is the result's part (#1556)", () => {
  const source =
    'let a = {f: [[1]]}\nlet b = a\nsay "BEFORE"\nb.f = hostValue\nsay "AFTER"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS)!;
  const site = `0:${source.indexOf("b.f")}:${source.indexOf("\nsay", source.indexOf("b.f"))}`;
  const element = [propertyStep("f"), "element"];
  for (const mode of HELD_MODES) {
    const natural = mode.run(() => storeContracts(analyseCore(request), request)).get(site);
    assert.ok(natural?.state === "complete", `${mode.name}: unstopped, the contract is complete`);
    assert.deepEqual(natural.ref, {
      kind: "list",
      element: { kind: "list", element: { kind: "integer" } },
    });
    const stops = heldStops({ name: "copy-nested", source, slice: true, values: [] }, mode, 8);
    assert.ok(stops.some((stop) => stop.phase === "walk"));
    for (const { allowance, phase } of stops) {
      const at = `${mode.name}, ${phase} stop at ${allowance}`;
      const answers = mode.run(() => withTestAllowance(allowance, () => analyseCore(request)));
      assert.ok(answers.budget.settled, at);
      const result = storeContracts(answers, request).get(site);
      assert.ok(result?.state === "lost", `${at}: lost, not ${result?.state}`);
      assert.equal(result.cause, "stop");
      assert.ok(
        result.required.some((level) => level.path.join(".") === element.join(".")),
        `${at}: the element level is the one whose proof is unfinished`,
      );
      const { plan } = mode.run(() =>
        withTestAllowance(allowance, () =>
          compileSourceWithBackend(source, { globals: GLOBALS }, CORE_BACKEND),
        ),
      );
      assert.deepEqual(checks(plan)[0]?.type, result.partial, `${at}: the plan carries the part`);
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
