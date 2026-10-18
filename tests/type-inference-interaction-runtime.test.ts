import assert from "node:assert/strict";
import test from "node:test";

import type { InstructionPlan } from "../src/plan/model.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { updateInteraction } from "../src/runtime/operations/update-interaction.js";
import type { SerializableRuntimeValue } from "../src/runtime/serializable-values.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { valueKindOf, type ValueKind } from "../src/value-kinds.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

// The interaction adapters' shape and optionality branches at runtime (stage-2b work note §6.4): each program is a row
// of the case tables (`tests/fixtures/type-inference/adapter-cases/{choice,form,commands}.jsonl`), named by its `id`
// with its `fact` and adapter cell, answered through the runtime's own operations; the value `r` settles to is of the
// kind the adapter answers.

interface Asked {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
}

/** The program compiled with no diagnostics and run until it waits on its ask. */
function asked(source: string): Asked {
  const plan = compileValidPlan(source);
  const { snapshot } = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(snapshot.status, "waiting", snapshot.failure?.message);
  return { plan, snapshot };
}

function actionId(snapshot: RuntimeSnapshot): number {
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction", `expected an ask, got ${action?.kind}`);
  return action.actionId;
}

/** A form field edited by `update`, as the Player edits it before the form is submitted. */
function edited({ plan, snapshot }: Asked, update: Record<string, unknown>): Asked {
  const result = updateInteraction(plan, snapshot, {
    actionId: actionId(snapshot),
    actionKind: "interaction",
    interactionKind: "form",
    update,
  });
  assert.equal(result.outcome.kind, "updated", JSON.stringify(result.outcome));
  return { plan, snapshot: result.snapshot };
}

/** What `r` holds once the ask has settled and the script reaches its exit. */
function settled(plan: InstructionPlan, snapshot: RuntimeSnapshot): SerializableRuntimeValue {
  const finished = runUntilExit(plan, snapshot).snapshot;
  assert.equal(finished.status, "running", finished.failure?.message);
  const binding = finished.frames[0]!.bindings.find((candidate) => candidate.name === "r");
  assert.ok(binding !== undefined, "r is bound");
  return binding.value;
}

/** What `r` holds once the ask is completed with `payload`. */
function answered(
  { plan, snapshot }: Asked,
  interactionKind: "choice" | "form" | "image",
  payload: Record<string, unknown>,
): SerializableRuntimeValue {
  const result = completeAction(plan, snapshot, {
    actionId: actionId(snapshot),
    actionKind: "interaction",
    interactionKind,
    payload,
  });
  assert.equal(result.outcome.kind, "completed", JSON.stringify(result.outcome));
  return settled(plan, result.snapshot);
}

/** What `r` holds once the form's time limit of 5 s is reached, which settles the ask by itself. */
function timedOut({ plan, snapshot }: Asked): SerializableRuntimeValue {
  const observed = observeTime(plan, snapshot, 5_000);
  const completed = observed.events.find((event) => event.kind === "actionCompleted");
  assert.ok(
    completed?.kind === "actionCompleted" && completed.settlement.actionKind === "interaction",
  );
  assert.equal(completed.settlement.settlementKind, "timedOut");
  return settled(plan, observed.snapshot);
}

/** The kind of each property of an object, or of each entry of a dict, by its name. */
function partKinds(value: SerializableRuntimeValue): Record<string, ValueKind> {
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      (value.kind === "object" || value.kind === "dict"),
  );
  return Object.fromEntries(
    value.kind === "object"
      ? value.properties.map((property) => [property.name, valueKindOf(property.value)])
      : value.entries.map((entry) => [entry.key, valueKindOf(entry.value)]),
  );
}

test("a labelled choice settles to its label", () => {
  // choice/option/string.literal.name: fact `string{"one"}`, adapter `fact`.
  const r = answered(asked('let r = askChoice one: "a"\nexit'), "choice", {
    kind: "selectedOption",
    optionIndex: 0,
  });
  assert.equal(valueKindOf(r), "string");
  assert.equal(r, "one");
});

test("a choice object settles to its value, written alone or as an element of a written list", () => {
  // choice/written-collection/integer.object-value: fact `integer{1}`, adapter `fact`. The table has no row for the
  // object written alone; the legacy's fact for it is the same `integer{1}`.
  for (const options of ['{ text: "A", value: 1 }', '[{ text: "A", value: 1 }]']) {
    const r = answered(asked(`let r = askChoice ${options}\nexit`), "choice", {
      kind: "selectedOption",
      optionIndex: 0,
    });
    assert.equal(valueKindOf(r), "integer", options);
    assert.equal(r, 1, options);
  }
});

test("a cycle field settles to the option it shows", () => {
  // form/written-descriptor/options.strings: fact `{"n":string}`, adapter `fact`.
  const form = asked('let r = askForm("Q", fields: { n: { options: ["a", "b"] } })\nexit');
  const r = answered(edited(form, { kind: "select", fieldId: "n", optionIndex: 1 }), "form", {
    kind: "submit",
  });
  assert.equal(valueKindOf(r), "object");
  assert.deepEqual(partKinds(r), { n: "string" });
});

test("a form of a written dict of fields settles to a dict", () => {
  // form/container/dict: fact `dict<integer>`, adapter `fact`.
  const r = answered(asked('let r = askForm("Q", fields: dict { "n": 1 })\nexit'), "form", {
    kind: "submit",
  });
  assert.equal(valueKindOf(r), "dict");
  assert.deepEqual(partKinds(r), { n: "integer" });
});

test("a form whose fields are a computed object settles to an object", () => {
  // form/container/object-variable: fact `{"n":integer}`, adapter `fact`.
  const r = answered(asked('let f = { n: 1 }\nlet r = askForm("Q", fields: f)\nexit'), "form", {
    kind: "submit",
  });
  assert.equal(valueKindOf(r), "object");
  assert.deepEqual(partKinds(r), { n: "integer" });
});

test("a computed descriptor with type: answers the generic kind, which the answer narrows to the kind typed", () => {
  // form/computed-descriptor/typed: fact `{"n":(absoluteDateTime|angle|boolean|calendarDuration|date|datetime|
  // duration|null|number|string|time)}`, adapter `fact`; the generic union holds `number`, the family of `integer`.
  let form = asked('let d = { type: "integer" }\nlet r = askForm("Q", fields: { n: d })\nexit');
  for (const update of [
    { kind: "edit", fieldId: "n" },
    { kind: "draft", fieldId: "n", text: "7" },
    { kind: "commit", fieldId: "n" },
  ])
    form = edited(form, update);
  const r = answered(form, "form", { kind: "submit" });
  assert.equal(valueKindOf(r), "object");
  assert.deepEqual(partKinds(r), { n: "integer" });
});

test("a cancelled form settles to null", () => {
  // form/container/cancel: fact `(null|{"n":integer})`, adapter `fact`.
  const form = asked('let r = askForm("Q", fields: { n: 1 }, cancel: "Back")\nexit');
  assert.equal(valueKindOf(answered(form, "form", { kind: "cancel" })), "null");
});

test('a timed-out form settles to null with onTimeout: "cancel", and to its object with "submit"', () => {
  // form/container/timeout-cancel: fact `(null|{"n":integer})`, adapter `fact`.
  const cancelled = timedOut(
    asked('let r = askForm("Q", fields: { n: 1 }, timeout: 5 s, onTimeout: "cancel")\nexit'),
  );
  assert.equal(valueKindOf(cancelled), "null");
  // form/container/timeout-submit: fact `{"n":integer}`, adapter `fact`.
  const submitted = timedOut(
    asked('let r = askForm("Q", fields: { n: 1 }, timeout: 5 s, onTimeout: "submit")\nexit'),
  );
  assert.equal(valueKindOf(submitted), "object");
  assert.deepEqual(partKinds(submitted), { n: "integer" });
});

test("a cancelled askBooleans settles to null", () => {
  // commands/booleans/cancel: fact `(list<boolean>|null)`, adapter `fact`.
  const form = asked(
    'let r = askBooleans("Q?", texts: ["A"], prefill: [false], cancel: "Back")\nexit',
  );
  assert.equal(valueKindOf(answered(form, "form", { kind: "cancel" })), "null");
});

test("a skipped askImage with allowSkip: true settles to null", () => {
  // commands/image/skip: fact `(null|string)`, adapter `fact`.
  const request = asked('let r = askImage("P", allowSkip: true)\nexit');
  assert.equal(valueKindOf(answered(request, "image", { kind: "skip" })), "null");
});
