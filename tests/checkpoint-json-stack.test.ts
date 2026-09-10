import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CheckpointError,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/index.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

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
  assert.equal(serializeCheckpoint(checkpoint), JSON.stringify(restoreCheckpoint(checkpoint)));
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
