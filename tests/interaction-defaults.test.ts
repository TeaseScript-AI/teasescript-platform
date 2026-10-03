import assert from "node:assert/strict";
import test from "node:test";

import { playerRuntimeForeground, createPlayerRuntimeSession } from "../player/runtime-adapter.js";
import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

type Plan = ReturnType<typeof compileValidPlan>;
type Snapshot = ReturnType<typeof createFreshRuntimeSnapshot>;

function pendingInput(plan: Plan, globals: Record<string, string | number> = {}) {
  const pending = run(plan, createFreshRuntimeSnapshot(plan, { globals }));
  const action = pending.snapshot.foregroundAction;
  assert.ok(
    action !== null &&
      action.kind === "interaction" &&
      (action.ui.kind === "text" || action.ui.kind === "number"),
  );
  return { snapshot: pending.snapshot, action, ui: action.ui };
}

function submit(plan: Plan, snapshot: Snapshot, submittedText: string) {
  const action = snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  return completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: action.interactionKind,
    payload: { kind: "submittedText", submittedText },
  });
}

function answer(plan: Plan, snapshot: Snapshot) {
  const done = run(plan, snapshot);
  assert.equal(done.snapshot.status, "halted");
  return done.snapshot.frames[0]?.bindings.find((binding) => binding.name === "answer")?.value;
}

test("a default answer prefills the field and submitting it unchanged returns the default", () => {
  const cases = [
    { source: 'let answer = askText "Your name?", default: "Ada"', prefill: "Ada", result: "Ada" },
    {
      source:
        'speaker mistress { name: "Mistress" }\nlet answer = askText as mistress default: "Ada"',
      prefill: "Ada",
      result: "Ada",
    },
    { source: 'let answer = askNumber "How many?", default: 10', prefill: "10", result: 10 },
    { source: "let answer = askNumber default: -2.5e-7", prefill: "-2.5e-7", result: -2.5e-7 },
    { source: "let answer = askNumber default: -0", prefill: "0", result: 0 },
    {
      source: 'let base = 4\nlet answer = askNumber "Corner time",\n    default: base * 2 + 0.5',
      prefill: "8.5",
      result: 8.5,
    },
    {
      source: 'let name = "Ada"\nlet answer = askText "Name?", default: "${name} Lovelace"',
      prefill: "Ada Lovelace",
      result: "Ada Lovelace",
    },
  ];
  for (const scenario of cases) {
    const plan = compileValidPlan(scenario.source);
    const { snapshot, ui } = pendingInput(plan);
    assert.equal(ui.prefill, scenario.prefill, scenario.source);

    const completed = submit(plan, snapshot, ui.prefill!);
    assert.equal(completed.outcome.kind, "completed", scenario.source);
    const transcript = completed.events.find((event) => event.kind === "playerTranscript");
    assert.equal(transcript?.text, scenario.prefill, scenario.source);
    assert.equal(answer(plan, completed.snapshot), scenario.result, scenario.source);
  }
});

test("the player may replace or clear a default answer, and a cleared field is retried", () => {
  const plan = compileValidPlan('let answer = askText "Name?", default: "Ada"');
  const { snapshot } = pendingInput(plan);
  const cleared = submit(plan, snapshot, "");
  assert.equal(cleared.outcome.kind, "invalidPayload");
  assert.deepEqual(cleared.snapshot, snapshot);
  const edited = submit(plan, snapshot, "Grace");
  assert.equal(edited.outcome.kind, "completed");
  assert.equal(answer(plan, edited.snapshot), "Grace");
});

test("a dynamic default is evaluated once after the hint and survives checkpoint restore", () => {
  const plan = compileValidPlan(
    'let calls = 0\nfunction next {\n    calls += 1\n    return calls * 10\n}\nlet answer = askNumber "Hint ${next()}", default: next()',
  );
  const { snapshot, ui } = pendingInput(plan);
  assert.deepEqual([ui.hint, ui.prefill], ["Hint 10", "20"]);
  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  assert.deepEqual(restored.snapshot, snapshot);
  const uninterrupted = submit(plan, snapshot, "20");
  const resumed = submit(restored.plan, restored.snapshot, "20");
  assert.deepEqual(resumed, uninterrupted);
  assert.equal(answer(plan, uninterrupted.snapshot), 20);
  assert.equal(
    run(plan, uninterrupted.snapshot).snapshot.frames[0]?.bindings.find(
      (binding) => binding.name === "calls",
    )?.value,
    2,
  );
});

test("a default of the wrong type or a blank text default is a compile error", () => {
  const cases = [
    [
      'let answer = askNumber "How many?", default: "ten"',
      "TSV039",
      "The default answer of askNumber must be a number, such as 'default: 10'.",
    ],
    [
      'let answer = askText "Code?", default: 10',
      "TSV039",
      "The default answer of askText must be text. Write a number as text, such as 'default: \"10\"'.",
    ],
    [
      'let answer = askText "Name?", default: "  "',
      "TSV039",
      "The default answer of askText must contain a non-whitespace character.",
    ],
    [
      "let answer = askText default: 1 + 2",
      "TSV039",
      "The default answer of askText must be text. Write a number as text, such as 'default: \"10\"'.",
    ],
    [
      "let answer = askNumber default: not false",
      "TSV039",
      "The default answer of askNumber must be a number, such as 'default: 10'.",
    ],
    [
      "let answer = askNumber default: 1 == 1",
      "TSV039",
      "The default answer of askNumber must be a number, such as 'default: 10'.",
    ],
    [
      'let answer = askText "Name?", default:',
      "TSP028",
      "Expected a default answer after 'default:'.",
    ],
  ] as const;
  for (const [source, code, message] of cases) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [[code, message]],
      source,
    );
  }
});

test("an invalid dynamic default fails before the field opens", () => {
  const cases = [
    ["let answer = askText default: value", 5],
    ["let answer = askText default: value", " \n"],
    ["let answer = askNumber default: value", "10"],
  ] as const;
  for (const [source, value] of cases) {
    const plan = compileValidPlan(source, { globals: ["value"] });
    const failed = run(plan, createFreshRuntimeSnapshot(plan, { globals: { value } }));
    assert.equal(
      failed.snapshot.failure?.code,
      "TSR052",
      `${source} with ${JSON.stringify(value)}`,
    );
    assert.equal(failed.snapshot.foregroundAction, null);
    assert.equal(
      failed.events.some((event) => event.kind === "actionRequested"),
      false,
    );
  }
});

test("a computed default keeps its runtime arithmetic errors whether or not the hint is constant", () => {
  for (const hint of ['"N"', "hint"]) {
    const source = `let answer = askNumber ${hint}, default: 1 / (1e308 * 10)`;
    const plan = compileValidPlan(source, { globals: ["hint"] });
    const failed = run(plan, createFreshRuntimeSnapshot(plan, { globals: { hint: "N" } }));
    assert.equal(failed.snapshot.failure?.code, "TSR036", source);
    assert.equal(failed.snapshot.foregroundAction, null, source);
  }
});

test("plan and checkpoint validation reject a prefill that is not a valid answer", () => {
  const plan = structuredClone(compileValidPlan("let answer = askNumber default: 3"));
  const interaction = plan.instructions.find((instruction) => instruction.kind === "interaction");
  assert.ok(interaction?.kind === "interaction" && "ui" in interaction);
  // EVIDENCE: fixture replaces only the static number prefill with text that is not a number.
  (interaction.ui as { prefill: string }).prefill = "three";
  assert.equal(validateInstructionPlan(plan).valid, false);

  const valid = compileValidPlan("let answer = askText default: value", { globals: ["value"] });
  const { snapshot } = pendingInput(valid, { value: "Ada" });
  const tampered = structuredClone(snapshot);
  assert.ok(tampered.foregroundAction?.kind === "interaction");
  // EVIDENCE: fixture changes only the published prefill so it no longer matches its prepared temporary.
  (tampered.foregroundAction.ui as { prefill: string }).prefill = "Grace";
  assert.equal(validateRuntimeSnapshot(tampered, valid).valid, false);
});

test("the Player composer receives the default answer", () => {
  const session = createPlayerRuntimeSession('let answer = askNumber "How many?", default: 12');
  assert.deepEqual(playerRuntimeForeground(session), {
    kind: "ask-number",
    accessibleName: "Number",
    hint: "How many?",
    prefill: "12",
  });
  const withoutDefault = createPlayerRuntimeSession('let answer = askText "Name?"');
  assert.equal(
    playerRuntimeForeground(withoutDefault)?.kind === "ask-text" &&
      "prefill" in playerRuntimeForeground(withoutDefault)!,
    false,
  );
});
