import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  RuntimeDataError,
  cloneSerializableValue,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  createSerializableList,
  execute,
  restoreCheckpoint,
  run,
  validateInstructionPlan,
  validateRuntimeSnapshot,
  type InstructionPlan,
  type RuntimeCheckpoint,
  type RuntimeSnapshot,
  type SerializableRuntimeList,
  type SerializableRuntimeValue,
} from "../src/index.js";
import {
  SerializableValueError,
  fromHostRuntimeValue,
  toHostRuntimeValue,
  validateSerializableValue,
} from "../src/runtime/serializable-values.js";
import type { RuntimeValue } from "../src/runtime/values.js";

function plan(
  source = "exit",
  builtins: readonly string[] = [],
): InstructionPlan {
  const compiled = compileSource(source, { builtins });
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  return compiled.plan!;
}

function deepList(depth: number): SerializableRuntimeValue {
  let value: SerializableRuntimeValue = 0;
  for (let index = 0; index < depth; index += 1) {
    value = { kind: "list", items: [value] };
  }
  return value;
}

interface ProxyCounts {
  ownKeys: number;
  descriptors: number;
  gets: number;
  prototypes: number;
}

function stableProxy<T extends object>(
  target: T,
  counts: ProxyCounts,
  changingGet: (key: PropertyKey) => unknown,
): T {
  return new Proxy(target, {
    ownKeys(current) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(current);
    },
    getOwnPropertyDescriptor(current, key) {
      counts.descriptors += 1;
      return Reflect.getOwnPropertyDescriptor(current, key);
    },
    getPrototypeOf(current) {
      counts.prototypes += 1;
      return Reflect.getPrototypeOf(current);
    },
    get(_current, key) {
      counts.gets += 1;
      return changingGet(key);
    },
  });
}

function zeroCounts(): ProxyCounts {
  return { ownKeys: 0, descriptors: 0, gets: 0, prototypes: 0 };
}

test("fresh globals reject changing and throwing getters without invoking them", () => {
  const compiled = plan();
  for (const throws of [false, true]) {
    let reads = 0;
    const globals: Record<string, unknown> = {};
    Object.defineProperty(globals, "payload", {
      enumerable: true,
      get() {
        reads += 1;
        if (throws) throw new Error("raw getter failure");
        return reads === 1 ? 0 : deepList(20_000);
      },
    });

    assert.throws(
      () => createFreshRuntimeSnapshot(compiled, { globals: globals as never }),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message === "$.globals.payload is not a JSON-safe runtime value.",
    );
    assert.equal(reads, 0);
  }
});

test("fresh globals consume one captured proxy observation and never call get", () => {
  const compiled = plan();
  const counts = zeroCounts();
  const target = { kind: "list" as const, items: [0] };
  const payload = stableProxy(target, counts, (key) =>
    key === "items" ? [deepList(20_000)] : Reflect.get(target, key),
  );

  const snapshot = createFreshRuntimeSnapshot(compiled, {
    globals: { payload } as never,
  });

  assert.deepEqual(snapshot.frames[0]!.bindings, [
    { name: "payload", value: { kind: "list", items: [0] } },
  ]);
  assert.deepEqual(counts, {
    ownKeys: 1,
    descriptors: 2,
    gets: 0,
    prototypes: 1,
  });
});

test("instruction plans reject accessors before validation or execution", () => {
  const valid = JSON.parse(JSON.stringify(plan("exit"))) as InstructionPlan & {
    padding?: unknown;
  };
  let reads = 0;
  Object.defineProperty(valid, "padding", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? 0 : deepList(20_000);
    },
  });

  const validation = validateInstructionPlan(valid);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.errors[0], {
    code: "TSC002",
    message: "Plan contains a non-JSON-safe value.",
    path: "$.padding",
  });

  const safePlan = plan("exit");
  const snapshot = createFreshRuntimeSnapshot(safePlan);
  const before = JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshot;
  let randomCalls = 0;
  assert.throws(
    () => run(valid, snapshot, { random: { next: () => {
      randomCalls += 1;
      return 0.5;
    } } }),
    (error: unknown) =>
      error instanceof RuntimeDataError && error.code === "TSR100",
  );
  assert.equal(reads, 0);
  assert.equal(randomCalls, 0);
  assert.deepEqual(snapshot, before);
});

test("runtime execution uses the captured proxy plan rather than proxy get results", () => {
  const target = JSON.parse(JSON.stringify(plan("exit"))) as InstructionPlan;
  const counts = zeroCounts();
  const proxied = stableProxy(target, counts, (key) =>
    key === "instructions" ? [] : Reflect.get(target, key),
  );
  const snapshot = createFreshRuntimeSnapshot(target);

  const result = run(proxied, snapshot);

  assert.deepEqual(result.events.map((event) => event.kind), ["exit"]);
  assert.equal(result.snapshot.status, "halted");
  assert.equal(counts.gets, 0);
  assert.equal(counts.ownKeys, 1);
});

test("runtime snapshots reject accessors before clone, execution, events, or RNG", () => {
  const compiled = plan("say random()\nexit");
  const snapshot = JSON.parse(
    JSON.stringify(createFreshRuntimeSnapshot(compiled)),
  ) as RuntimeSnapshot & { padding?: unknown };
  let reads = 0;
  Object.defineProperty(snapshot, "padding", {
    enumerable: true,
    get() {
      reads += 1;
      return 0;
    },
  });

  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, false);
  const beforeSequence = snapshot.nextEventSequence;
  const beforeRng = snapshot.rng.state;
  let randomCalls = 0;
  assert.throws(
    () => run(compiled, snapshot, { random: { next: () => {
      randomCalls += 1;
      return 0.5;
    } } }),
    (error: unknown) =>
      error instanceof RuntimeDataError && error.code === "TSR101",
  );
  assert.equal(reads, 0);
  assert.equal(randomCalls, 0);
  assert.equal(snapshot.nextEventSequence, beforeSequence);
  assert.equal(snapshot.rng.state, beforeRng);
});

test("runtime execution consumes a stable captured proxy snapshot", () => {
  const compiled = plan("exit");
  const target = createFreshRuntimeSnapshot(compiled);
  const counts = zeroCounts();
  const proxied = stableProxy(target, counts, (key) =>
    key === "status" ? "halted" : Reflect.get(target, key),
  );

  const result = run(compiled, proxied);

  assert.deepEqual(result.events.map((event) => event.kind), ["exit"]);
  assert.equal(result.snapshot.status, "halted");
  assert.equal(counts.gets, 0);
  assert.equal(counts.ownKeys, 1);
});

test("checkpoint restoration converts accessor and proxy trap failures to TSK002", () => {
  const compiled = plan();
  const valid = createCheckpoint(
    compiled,
    createFreshRuntimeSnapshot(compiled),
  );

  let reads = 0;
  const accessorCheckpoint: Record<string, unknown> = {
    format: valid.format,
    version: valid.version,
    snapshot: valid.snapshot,
  };
  Object.defineProperty(accessorCheckpoint, "plan", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("raw checkpoint getter");
    },
  });
  assert.throws(
    () => restoreCheckpoint(accessorCheckpoint),
    (error: unknown) =>
      error instanceof CheckpointError &&
      error.info.code === "TSK002" &&
      error.info.path === "$.plan",
  );
  assert.equal(reads, 0);

  const trapCheckpoint = new Proxy(valid as RuntimeCheckpoint, {
    ownKeys() {
      throw new Error("raw ownKeys failure");
    },
  });
  assert.throws(
    () => restoreCheckpoint(trapCheckpoint),
    (error: unknown) =>
      error instanceof CheckpointError && error.info.code === "TSK002",
  );
});

test("serializable-value APIs reject accessors and consume stable proxy arrays", () => {
  let reads = 0;
  const unstable = { kind: "list" } as Record<string, unknown>;
  Object.defineProperty(unstable, "items", {
    enumerable: true,
    get() {
      reads += 1;
      return [0];
    },
  });

  assert.equal(
    validateSerializableValue(unstable),
    "$.items is not a JSON-safe runtime value.",
  );
  assert.throws(
    () => cloneSerializableValue(unstable as never),
    (error: unknown) => error instanceof SerializableValueError,
  );
  assert.throws(
    () => toHostRuntimeValue(unstable as never),
    (error: unknown) => error instanceof SerializableValueError,
  );
  assert.equal(reads, 0);

  const counts = zeroCounts();
  const source = [0];
  const proxied = stableProxy(source, counts, () => deepList(20_000));
  assert.deepEqual(createSerializableList(proxied), {
    kind: "list",
    items: [0],
  });
  assert.equal(counts.gets, 0);
  assert.equal(counts.ownKeys, 1);
});

test("host conversion rejects accessors without invocation and captures proxy data", () => {
  let reads = 0;
  const unstable = { kind: "list" } as Record<string, unknown>;
  Object.defineProperty(unstable, "items", {
    enumerable: true,
    get() {
      reads += 1;
      return [0];
    },
  });
  assert.throws(
    () => fromHostRuntimeValue(unstable as unknown as RuntimeValue),
    (error: unknown) => error instanceof SerializableValueError,
  );
  assert.equal(reads, 0);

  const counts = zeroCounts();
  const target = { kind: "list" as const, items: [0] };
  const proxied = stableProxy(target, counts, (key) =>
    key === "items" ? [deepList(20_000)] : Reflect.get(target, key),
  );
  assert.deepEqual(fromHostRuntimeValue(proxied), {
    kind: "list",
    items: [0],
  });
  assert.equal(counts.gets, 0);
  assert.equal(counts.ownKeys, 1);
});

test("low-level builtin results are captured once and invalid accessors fail as TSR013", () => {
  const compiled = plan("let value = unstable()\nexit", ["unstable"]);
  const initial = createFreshRuntimeSnapshot(compiled);
  const before = JSON.parse(JSON.stringify(initial)) as RuntimeSnapshot;
  let reads = 0;
  const returned = { kind: "list" } as Record<string, unknown>;
  Object.defineProperty(returned, "items", {
    enumerable: true,
    get() {
      reads += 1;
      return [0];
    },
  });

  const result = run(compiled, initial, {
    builtins: { unstable: () => returned as never },
  });

  assert.equal(reads, 0);
  assert.deepEqual(result.events.map((event) => event.kind), ["runtimeFailure"]);
  assert.equal(result.snapshot.failure?.code, "TSR013");
  assert.deepEqual(initial, before);
});

test("low-level builtin proxy results execute only the captured descriptor graph", () => {
  const compiled = plan("say unstable().first\nexit", ["unstable"]);
  const counts = zeroCounts();
  const target: SerializableRuntimeList = { kind: "list", items: [0] };
  const returned = stableProxy(target, counts, (key) =>
    key === "items" ? [999] : Reflect.get(target, key),
  );

  const result = run(compiled, createFreshRuntimeSnapshot(compiled), {
    builtins: { unstable: () => returned },
  });

  assert.equal(result.snapshot.failure, null);
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["0"],
  );
  assert.equal(counts.gets, 0);
  assert.equal(counts.ownKeys, 1);
});

test("compatibility builtin host accessors become structured runtime failures", () => {
  const compiled = compileSource("let value = unstable()\nexit", {
    builtins: ["unstable"],
  });
  assert.deepEqual(compiled.diagnostics, []);
  let reads = 0;
  const returned = { kind: "list" } as Record<string, unknown>;
  Object.defineProperty(returned, "items", {
    enumerable: true,
    get() {
      reads += 1;
      return [0];
    },
  });

  const result = execute(compiled.program, {
    random: { next: () => 0.5 },
    builtins: { unstable: () => returned as unknown as RuntimeValue },
  });

  assert.equal(reads, 0);
  assert.deepEqual(result.errors.map((error) => error.code), ["TSR013"]);
  assert.deepEqual(result.events, []);
});
