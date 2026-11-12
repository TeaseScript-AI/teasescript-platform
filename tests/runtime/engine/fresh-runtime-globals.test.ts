import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  createFreshRuntimeSnapshot,
  run,
  type SerializableRuntimeValue,
} from "../../../src/index.js";
import { withValidationTestStatistics } from "../../../src/validation-testing.js";
import { COLLIDING_A, COLLIDING_B } from "../../helpers/colliding-texts.js";

test("fresh global initialization preserves imported value kinds in binding order", () => {
  const compiled = compileSource("exit");
  assert.notEqual(compiled.plan, null);
  // Hosts may pass null-prototype dictionaries.
  const globals: Record<string, SerializableRuntimeValue> = Object.assign(Object.create(null), {
    title: "Session",
    count: 3,
    enabled: false,
    missing: null,
    tags: { kind: "list", items: ["a", 1] },
    profile: { kind: "object", properties: [{ name: "level", value: 2 }] },
  });

  const snapshot = createFreshRuntimeSnapshot(compiled.plan!, { globals });

  assert.deepEqual(snapshot.globals, [
    { name: "title", value: "Session" },
    { name: "count", value: 3 },
    { name: "enabled", value: false },
    { name: "missing", value: null },
    { name: "tags", value: { kind: "list", items: ["a", 1] } },
    { name: "profile", value: { kind: "object", properties: [{ name: "level", value: 2 }] } },
  ]);
});

test("a host global of sets whose members share a print reaches the script whole, and a duplicate is refused", () => {
  const compiled = compileSource("for group in incoming {\n    say group\n}\nexit", {
    globals: ["incoming"],
  });
  assert.deepEqual(compiled.diagnostics, []);
  const list = (text: string): SerializableRuntimeValue => ({ kind: "list", items: [text] });
  const set = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
    kind: "set",
    items,
  });
  const start = (incoming: SerializableRuntimeValue) =>
    createFreshRuntimeSnapshot(compiled.plan!, {
      globals: { incoming },
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    });

  const incoming = set(
    set(list(COLLIDING_A)),
    set(list(COLLIDING_B)),
    set(list(COLLIDING_A), list(COLLIDING_B)),
  );
  const exactKeys = withValidationTestStatistics((finish) => {
    start(incoming);
    return finish().counts.setValidationExactKeys;
  });
  // The members' prints are equal, so their whole values were compared.
  assert.ok(exactKeys !== undefined && exactKeys >= 4, String(exactKeys));
  const result = run(compiled.plan!, start(incoming));
  assert.equal(result.snapshot.status, "halted");
  const [a, b] = [JSON.stringify(COLLIDING_A), JSON.stringify(COLLIDING_B)];
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    [`[[${a}]]`, `[[${b}]]`, `[[${a}], [${b}]]`],
  );

  assert.throws(
    () => start(set(list(COLLIDING_A), list(COLLIDING_B), list(COLLIDING_A))),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "globals.incoming.items contains a duplicate member.",
  );
});
