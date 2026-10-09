import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CheckpointError,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  restoreCheckpoint,
  run,
  serializeCheckpoint,
  type RuntimeCheckpoint,
} from "../src/index.js";
import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  restorePlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

/**
 * Runs `write` while `Object.prototype` has a `toJSON` getter and `Array.prototype` a `toJSON` method, which make
 * checkpoint serialization use its iterative writer. Both count every use and are removed afterwards.
 */
function withInheritedToJson<T>(write: () => T): { readonly result: T; readonly uses: number } {
  let uses = 0;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    get() {
      uses += 1;
      return undefined;
    },
  });
  Object.defineProperty(Array.prototype, "toJSON", {
    configurable: true,
    writable: true,
    value() {
      uses += 1;
      return "hooked";
    },
  });
  try {
    return { result: write(), uses };
  } finally {
    Reflect.deleteProperty(Object.prototype, "toJSON");
    Reflect.deleteProperty(Array.prototype, "toJSON");
  }
}

/** Checkpoint JSON from both writers: native, and iterative while inherited hooks are present. */
function bothWriters(checkpoint: RuntimeCheckpoint): {
  readonly native: string;
  readonly iterative: string;
} {
  const native = serializeCheckpoint(checkpoint);
  const hooked = withInheritedToJson(() => serializeCheckpoint(checkpoint));
  assert.equal(hooked.uses, 0, "serialization must not consult an inherited toJSON");
  return { native, iterative: hooked.result };
}

test("checkpoint JSON matches native ordering, escaping, and numeric representation", () => {
  const plan = compileValidPlan("exit");
  const snapshot = createFreshRuntimeSnapshot(plan);
  const scalars = [
    null,
    true,
    false,
    0,
    -0,
    1e-7,
    1e21,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    'quote" slash\\ controls\b\f\n\r\t\u0000 Unicode 😀 lone \ud800',
  ];
  scalars.forEach((value, index) =>
    snapshot.frames[0]!.bindings.push({ name: `value${index}`, value }),
  );
  const checkpoint = createCheckpoint(plan, snapshot);
  const expected = JSON.stringify(restoreCheckpoint(checkpoint));
  const { native, iterative } = bothWriters(checkpoint);
  assert.equal(native, expected);
  assert.equal(iterative, expected);
});

test("both checkpoint writers give the same bytes for a suspended session and its restore point", () => {
  const source = [
    'speaker vera { title: "Miss" }',
    'let record = { items: [1, 2.5, -0], note: "line\\nbreak" }',
    "function pause(seconds = 1) {\n  wait seconds s\n  return seconds\n}",
    "repeat 2 {",
    '  say as vera "round ${pause()}"',
    "}",
    "exit",
  ].join("\n");
  const plan = compileValidPlan(source);
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.ok(waiting.callFrames.length > 0 && waiting.loopFrames.length > 0);
  const checkpoint = createCheckpoint(plan, waiting);
  const { native, iterative } = bothWriters(checkpoint);
  assert.equal(iterative, native);
  assert.equal(serializeCheckpoint(deserializeCheckpoint(native)), native);

  // The Player adapter's restore points carry the same checkpoint JSON and restore the session.
  const session = createPlayerRuntimeSession(plan);
  const nativePoint = createPlayerRuntimeRestorePoint(session);
  const hooked = withInheritedToJson(() => createPlayerRuntimeRestorePoint(session));
  assert.equal(hooked.uses, 0);
  assert.equal(hooked.result.checkpointJson, nativePoint.checkpointJson);
  assert.equal(
    JSON.stringify(playerRuntimeSnapshot(restorePlayerRuntimeSession(nativePoint))),
    JSON.stringify(playerRuntimeSnapshot(session)),
  );
});

test("a toJSON hook that captured arrays copied when the runtime loaded is not consulted", () => {
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const source = 'let values = [[1, 2], [3]]\nlet words = ["a", "b"]\nexit';
  // Captured arrays copy Array.prototype as it was when the runtime loaded, so the hook outlives its removal there.
  const script = `
    import assert from 'node:assert/strict';
    let uses = 0;
    Array.prototype.toJSON = function () { uses += 1; return 'hooked'; };
    const m = await import(${JSON.stringify(moduleUrl)});
    delete Array.prototype.toJSON;
    const plan = m.compileSource(${JSON.stringify(source)}).plan;
    const ended = m.run(plan, m.createFreshRuntimeSnapshot(plan)).snapshot;
    const encoded = m.serializeCheckpoint(m.createCheckpoint(plan, ended));
    assert.equal(uses, 0);
    process.stdout.write(encoded);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const plan = compileValidPlan(source);
  const ended = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  assert.equal(child.stdout, serializeCheckpoint(createCheckpoint(plan, ended)));
});

test("serialization retains checkpoint validation and rejects malformed data before traversal", () => {
  const plan = compileValidPlan("exit");
  const checkpoint = createCheckpoint(plan, createFreshRuntimeSnapshot(plan));
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...checkpoint }, "plan", {
    enumerable: true,
    get() {
      getterCalls++;
      return checkpoint.plan;
    },
  });
  for (const value of [
    { ...checkpoint, version: -1 },
    { ...checkpoint, extra: true },
    { ...checkpoint, snapshot: { ...checkpoint.snapshot, frames: [] } },
    accessor,
  ]) {
    assert.throws(
      () =>
        serializeCheckpoint(
          // EVIDENCE: deliberately malformed external fixtures exercise the runtime validation boundary.
          value as typeof checkpoint,
        ),
      CheckpointError,
    );
  }
  assert.equal(getterCalls, 0);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const value of [Infinity, undefined, () => 1, cycle]) {
    const snapshot = createFreshRuntimeSnapshot(plan);
    snapshot.frames[0]!.bindings.push({
      name: "invalid",
      // EVIDENCE: invalid values are deliberately injected to verify serializer validation.
      value: value as never,
    });
    assert.throws(() => serializeCheckpoint({ ...checkpoint, snapshot }), CheckpointError);
  }
});

test("deep source-produced lists and objects serialize and resume with a constrained stack", () => {
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import * as m from ${JSON.stringify(moduleUrl)};
    for (const kind of ['list', 'object']) {
      for (const depth of [256, 1024, 2048]) {
        const expression = kind === 'list'
          ? '['.repeat(depth) + '1' + ']'.repeat(depth)
          : '{ value: '.repeat(depth) + '1' + ' }'.repeat(depth);
        const compiled = m.compileSource('let value = ' + expression + '\\nlet next = random()\\nsay next\\nexit');
        assert.equal(compiled.diagnostics.length, 0);
        assert.ok(compiled.plan);
        const initial = m.createFreshRuntimeSnapshot(compiled.plan, {
          seed: 12345, baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0,
        });
        const boundary = m.executeInstruction(compiled.plan, initial);
        assert.equal(boundary.snapshot.status, 'running');
        const checkpoint = m.createCheckpoint(compiled.plan, boundary.snapshot);
        m.restoreCheckpoint(checkpoint);
        // Too deep for native JSON on this stack, so serialization falls back to its iterative writer.
        if (depth === 2048) assert.throws(() => JSON.stringify(checkpoint), RangeError);
        const encoded = m.serializeCheckpoint(checkpoint);
        const restored = m.deserializeCheckpoint(encoded);
        assert.equal(m.serializeCheckpoint(restored), encoded);
        let leaf = restored.snapshot.frames[0].bindings[0].value;
        let measured = 0;
        while (leaf && typeof leaf === 'object') {
          assert.equal(leaf.kind, kind);
          leaf = kind === 'list' ? leaf.items[0] : leaf.properties[0].value;
          measured++;
        }
        assert.equal(measured, depth);
        assert.equal(leaf, 1);
        const direct = m.run(compiled.plan, boundary.snapshot);
        const resumed = m.run(restored.plan, restored.snapshot);
        assert.equal(resumed.snapshot.status, 'halted');
        assert.deepEqual(resumed.events, direct.events);
        assert.equal(m.serializeCheckpoint(m.createCheckpoint(restored.plan, resumed.snapshot)),
          m.serializeCheckpoint(m.createCheckpoint(compiled.plan, direct.snapshot)));
        console.log(JSON.stringify({ kind, depth, bytes: encoded.length }));
      }
    }
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=256", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.equal(child.stdout.trim().split("\n").length, 6);
});
