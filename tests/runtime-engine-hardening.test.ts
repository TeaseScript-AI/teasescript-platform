import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  run,
  type RuntimeBuiltinFunction,
  type RuntimeCapabilityCall,
} from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";

test("requires explicit own registration for an inherited builtin name", () => {
  const compiled = inheritedBuiltinPlan("valueOf");
  const missing = run(compiled, createFreshRuntimeSnapshot(compiled));

  assert.equal(missing.snapshot.failure?.code, "TSR011");
  assert.match(
    missing.snapshot.failure?.message ?? "",
    /Unknown built-in function 'valueOf'/u,
  );

  let calls = 0;
  const valueOf: RuntimeBuiltinFunction = () => {
    calls += 1;
    return "registered";
  };
  const injected = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    { builtins: { valueOf } },
  );

  assert.equal(injected.snapshot.status, "halted");
  assert.equal(injected.snapshot.failure, null);
  assert.equal(calls, 1);
});

test("keeps core builtin precedence over injected names", () => {
  const compiled = compile("let output = random()", []);
  let injectedCalls = 0;
  let randomCalls = 0;
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    {
      builtins: {
        random: () => {
          injectedCalls += 1;
          return 0.75;
        },
      },
      random: {
        next: () => {
          randomCalls += 1;
          return 0.25;
        },
      },
    },
  );

  assert.equal(result.snapshot.status, "halted");
  assert.equal(result.snapshot.failure, null);
  assert.equal(injectedCalls, 0);
  assert.equal(randomCalls, 1);
});

test("exposes prototype-sensitive named arguments as own immutable keys", () => {
  const names = ["__proto__", "constructor", "prototype"] as const;
  const compiled = namedBuiltinPlan(names);
  let captured: RuntimeCapabilityCall["named"] | null = null;
  const capture: RuntimeBuiltinFunction = (call) => {
    captured = call.named;
    return null;
  };
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    { builtins: { capture } },
  );

  assert.equal(result.snapshot.status, "halted");
  assert.equal(result.snapshot.failure, null);
  assert.notEqual(captured, null);
  const named = captured!;
  assert.equal(Object.getPrototypeOf(named), null);
  assert.deepEqual(Object.keys(named), names);
  assert.equal(named.__proto__, 1);
  assert.equal(named.constructor, 2);
  assert.equal(named.prototype, 3);
  assert.equal(Object.isFrozen(named), true);
  assert.equal(Reflect.defineProperty(named, "extra", { value: 4 }), false);
});

test("detects duplicate prototype-sensitive named arguments", () => {
  const compiled = namedBuiltinPlan(["__proto__", "__proto__"]);
  const result = run(
    compiled,
    createFreshRuntimeSnapshot(compiled),
    { builtins: { capture: () => null } },
  );

  assert.equal(result.snapshot.failure?.code, "TSR010");
  assert.match(
    result.snapshot.failure?.message ?? "",
    /Duplicate named argument '__proto__'/u,
  );
});

function inheritedBuiltinPlan(name: string): InstructionPlan {
  const compiled = compile("let output = injectedBuiltin()", ["injectedBuiltin"]);
  const plan = JSON.parse(JSON.stringify(compiled)) as InstructionPlan;
  const call = bindingCall(plan);
  assert.equal(call.callee.kind, "identifier");
  if (call.callee.kind !== "identifier") throw new Error("Expected an identifier callee.");
  (call.callee as { name: string }).name = name;
  return plan;
}

function namedBuiltinPlan(names: readonly string[]): InstructionPlan {
  const argumentsSource = names
    .map((_, index) => `argument${index}: ${index + 1}`)
    .join(", ");
  const compiled = compile(
    `let output = capture(${argumentsSource})`,
    ["capture"],
  );
  const plan = JSON.parse(JSON.stringify(compiled)) as InstructionPlan;
  const call = bindingCall(plan);
  assert.equal(call.arguments.length, names.length);
  call.arguments.forEach((argument, index) => {
    assert.equal(argument.kind, "named");
    if (argument.kind !== "named") throw new Error("Expected a named argument.");
    (argument as { name: string }).name = names[index]!;
  });
  return plan;
}

function bindingCall(
  plan: InstructionPlan,
): Extract<InstructionPlan["instructions"][number], { kind: "declareBinding" }>["value"] & { kind: "call" } {
  const instruction = plan.instructions[0];
  assert.equal(instruction?.kind, "declareBinding");
  if (instruction?.kind !== "declareBinding") throw new Error("Expected a binding declaration.");
  assert.equal(instruction.value.kind, "call");
  if (instruction.value.kind !== "call") throw new Error("Expected a builtin call.");
  return instruction.value;
}

function compile(source: string, builtins: readonly string[]): InstructionPlan {
  const result = compileSource(source, { builtins });
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}
