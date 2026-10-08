import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  restorePlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
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
import { AMSTERDAM } from "./helpers/temporal-fixtures.js";

type Plan = ReturnType<typeof compileValidPlan>;
type Snapshot = ReturnType<typeof createFreshRuntimeSnapshot>;

function pendingInput(plan: Plan, globals: Record<string, string | number | null> = {}) {
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
    {
      source: 'let answer = askText "Your name?", default: "Ada"\nexit',
      prefill: "Ada",
      result: "Ada",
    },
    {
      source:
        'speaker mistress { name: "Mistress" }\nlet answer = askText as mistress default: "Ada"\nexit',
      prefill: "Ada",
      result: "Ada",
    },
    { source: 'let answer = askNumber "How many?", default: 10\nexit', prefill: "10", result: 10 },
    {
      source: "let answer = askNumber default: -2.5e-7\nexit",
      prefill: "-2.5e-7",
      result: -2.5e-7,
    },
    { source: "let answer = askNumber default: -0\nexit", prefill: "0", result: 0 },
    {
      source: "let level = 3\nlet answer = askNumber default: level\nexit",
      prefill: "3",
      result: 3,
    },
    {
      source:
        'let base = 4\nlet answer = askNumber "Corner time",\n    default: base * 2 + 0.5\nexit',
      prefill: "8.5",
      result: 8.5,
    },
    {
      source: 'let name = "Ada"\nlet answer = askText "Name?", default: "${name} Lovelace"\nexit',
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
  const plan = compileValidPlan('let answer = askText "Name?", default: "Ada"\nexit');
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
    'let calls = 0\nfunction next {\n    calls += 1\n    return calls * 10\n}\nlet answer = askNumber hint: "Hint ${next()}", default: next()\nexit',
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

test("a default the compiler knows is wrong is a compile error that names the fix", () => {
  const cases = [
    [
      'let count = 3\nlet answer = askText "Code?", default: count\nexit',
      "TSV039",
      "The default answer of askText must be text, but 'count' holds a whole number (integer). Write it as text: 'default: \"${count}\"'.",
    ],
    [
      'let answer = askText "Code?", default: 10\nexit',
      "TSV039",
      "The default answer of askText must be text, not a whole number (integer). Write it as text: 'default: \"10\"'.",
    ],
    [
      "let answer = askText default: value * 2\nexit",
      "TSV039",
      "The default answer of askText must be text. Write it as text with interpolation: 'default: \"${...}\"'.",
    ],
    [
      'let answer = askText "Name?", default: "  "\nexit',
      "TSV039",
      "The default answer of askText must contain a non-whitespace character. Remove 'default:' to start with an empty field.",
    ],
    [
      'let answer = askText default: ""\nexit',
      "TSV039",
      "The default answer of askText must contain a non-whitespace character. Remove 'default:' to start with an empty field.",
    ],
    [
      "let answer = askText default: null\nexit",
      "TSV039",
      "The default answer of askText must be text, not null. Remove 'default:' to start with an empty field.",
    ],
    [
      'let answer = askNumber "How many?", default: "10"\nexit',
      "TSV039",
      "The default answer of askNumber must be a number, not text (string). Write it as a number: 'default: 10'.",
    ],
    [
      'let name = "Ada"\nlet answer = askNumber default: name\nexit',
      "TSV039",
      "The default answer of askNumber must be a number, but 'name' holds text (string). Use a number, such as 'default: 10'.",
    ],
    [
      "let answer = askNumber default: 1 s + 2 s\nexit",
      "TSV039",
      "The default answer of askNumber must be a number, not a duration. Use a number, such as 'default: 10'.",
    ],
    [
      "let answer = askNumber default: 1 == 1\nexit",
      "TSV039",
      "The default answer of askNumber must be a number, not true or false (boolean). Use a number, such as 'default: 10'.",
    ],
    [
      'let answer = askText "Name?", default:',
      "TSP028",
      "Expected a default answer after 'default:'.",
    ],
    ['let answer = askText "Name?" default: "Ada"', "TSP017", "Expected ',' before 'default:'."],
  ] as const;
  for (const [source, code, message] of cases) {
    const result = compileSource(source, { globals: ["value"] });
    assert.equal(result.plan, null, source);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [[code, message]],
      source,
    );
  }
});

test("inside an object literal, default: belongs to the nearest ask unless parentheses close it", () => {
  const grouped = compileValidPlan('let o = { name: askText "Name?", default: "Ada" }\nexit');
  assert.equal(pendingInput(grouped).ui.prefill, "Ada");

  const property = compileValidPlan(
    'let o = { name: (askText "Name?"), default: "Ada" }\nlet answer = o.default\nexit',
  );
  const { snapshot, ui } = pendingInput(property);
  assert.equal("prefill" in ui, false);
  assert.equal(answer(property, submit(property, snapshot, "Grace").snapshot), "Ada");
});

test("an invalid dynamic default fails before the field opens", () => {
  const notText =
    "The default answer of askText must be text. Write the value as text with interpolation: 'default: \"${...}\"'.";
  const notNumber =
    "The default answer of askNumber must be a finite number. Ask without 'default:' when there is no number to offer.";
  const cases = [
    ["let answer = askText default: value\nexit", 5, notText],
    ["let answer = askNumber default: value\nexit", "10", notNumber],
  ] as const;
  for (const [source, value, message] of cases) {
    const plan = compileValidPlan(source, { globals: ["value"] });
    const failed = run(plan, createFreshRuntimeSnapshot(plan, { globals: { value } }));
    assert.deepEqual(
      [failed.snapshot.failure?.code, failed.snapshot.failure?.message],
      ["TSR052", message],
      `${source} with ${JSON.stringify(value)}`,
    );
    assert.equal(failed.snapshot.foregroundAction, null);
    assert.equal(
      failed.events.some((event) => event.kind === "actionRequested"),
      false,
    );
  }
});

test("a default that is null or blank when the field opens starts the field empty", () => {
  const asks = [
    ["askText", "ask-text", "Ada"],
    ["askNumber", "ask-number", "2.5"],
    ["askInteger", "ask-number", "7"],
    ["askDate", "ask-date", "2026-10-04"],
    ["askTime", "ask-time", "14:30"],
    ["askDateTime", "ask-datetime", "2026-10-04T18:00"],
  ] as const;
  // A first play has not saved the key yet, so `load` gives null; a saved value may also be blank text.
  for (const stored of [undefined, "", " \n\t"]) {
    for (const [command, kind, typed] of asks) {
      const label = `${command} with ${JSON.stringify(stored)}`;
      const session = createPlayerRuntimeSession(
        `let answer = ${command} hint: "Hint", default: load("sa" + "ved", default: null)\nsay "Got \${answer}"\nexit`,
        {
          temporalContext: AMSTERDAM,
          ...(stored === undefined ? {} : { scriptStorage: [{ key: "saved", value: stored }] }),
        },
      );
      assert.equal(session.state.failure, null, label);
      const foreground = playerRuntimeForeground(session);
      assert.equal(foreground?.kind, kind, label);
      assert.equal("prefill" in foreground, false, label);

      const answered = submitPlayerRuntimeComposer(session, typed);
      assert.ok(answered !== null, label);
      assert.equal(answered.outcome.kind, "completed", label);
      // A date or time answer is shown in the player's presentation, by the transcript and `say` alike.
      const [shown, said] = answered.session.transcriptEntries.map((entry) => entry.text);
      if (kind === "ask-text" || kind === "ask-number") assert.equal(shown, typed, label);
      assert.equal(said, `Got ${shown}`, label);
    }
  }

  // Once saved, the same source prefills the field as before.
  const saved = createPlayerRuntimeSession(
    'let answer = askText "Your name?", default: load("name", default: "")\nexit',
    { scriptStorage: [{ key: "name", value: "Ada" }] },
  );
  const prefilled = playerRuntimeForeground(saved);
  assert.ok(prefilled?.kind === "ask-text");
  assert.equal(prefilled.prefill, "Ada");
});

test("a default that may be null compiles, and prefills only when it holds a value", () => {
  const plan = compileValidPlan(
    "let limit: number? = value\nlet answer = askNumber default: limit\nexit",
    { globals: ["value"] },
  );
  assert.equal("prefill" in pendingInput(plan, { value: null }).ui, false);
  assert.equal(pendingInput(plan, { value: 5 }).ui.prefill, "5");
});

test("an open field without a prefill restores without one", () => {
  const plan = compileValidPlan(
    'let answer = askText "Your name?", default: load("name", default: "")\nexit',
  );
  const { snapshot, ui } = pendingInput(plan);
  assert.equal("prefill" in ui, false);
  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  assert.deepEqual(restored.snapshot, snapshot);
  const uninterrupted = submit(plan, snapshot, "Ada");
  assert.deepEqual(submit(restored.plan, restored.snapshot, "Ada"), uninterrupted);
  // The answered field keeps no prefill in its retained settlement, which a checkpoint accepts.
  assert.equal(validateRuntimeSnapshot(uninterrupted.snapshot, plan).valid, true);
  const settled = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, uninterrupted.snapshot)),
  ).snapshot;
  assert.deepEqual(settled, uninterrupted.snapshot);
  assert.equal(answer(plan, uninterrupted.snapshot), "Ada");

  const tampered = structuredClone(snapshot);
  assert.ok(tampered.foregroundAction?.kind === "interaction");
  // EVIDENCE: fixture adds only a published prefill that the empty default never presented.
  (tampered.foregroundAction.ui as { prefill?: string }).prefill = "Ada";
  assert.equal(validateRuntimeSnapshot(tampered, plan).valid, false);

  const session = createPlayerRuntimeSession(
    'let day: date? = load("day", default: null)\nlet answer = askDate "Which day?", default: day\nexit',
    { temporalContext: AMSTERDAM },
  );
  const reopened = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.equal(validateRuntimeSnapshot(playerRuntimeSnapshot(reopened), reopened.plan).valid, true);
  assert.deepEqual(playerRuntimeForeground(reopened), playerRuntimeForeground(session));
  assert.equal("prefill" in playerRuntimeForeground(reopened)!, false);
});

test("a computed default keeps its runtime arithmetic errors whether or not the hint is constant", () => {
  for (const hint of ['"N"', "hint"]) {
    for (const source of [
      // A variable keeps the overflow a runtime error; a visible one is a compile error.
      `let big = 1e308\nlet answer = askNumber ${hint}, default: 1 / (big * 10)\nexit`,
      `let big = 1e308\nlet answer = askText ${hint}, default: "\${1 / (big * 10)}"\nexit`,
    ]) {
      const plan = compileValidPlan(source, { globals: ["hint"] });
      const failed = run(plan, createFreshRuntimeSnapshot(plan, { globals: { hint: "N" } }));
      assert.equal(failed.snapshot.failure?.code, "TSR036", source);
      assert.equal(failed.snapshot.foregroundAction, null, source);
    }
  }
});

test("plan and checkpoint validation reject a prefill that is not a valid answer", () => {
  const plan = structuredClone(compileValidPlan("let answer = askNumber default: 3\nexit"));
  const interaction = plan.instructions.find((instruction) => instruction.kind === "interaction");
  assert.ok(interaction?.kind === "interaction" && "ui" in interaction);
  // EVIDENCE: fixture replaces only the static number prefill with text that is not a number.
  (interaction.ui as { prefill: string }).prefill = "three";
  assert.equal(validateInstructionPlan(plan).valid, false);

  const valid = compileValidPlan("let answer = askText default: value\nexit", {
    globals: ["value"],
  });
  const { snapshot } = pendingInput(valid, { value: "Ada" });
  const tampered = structuredClone(snapshot);
  assert.ok(tampered.foregroundAction?.kind === "interaction");
  // EVIDENCE: fixture changes only the published prefill so it no longer matches its prepared temporary.
  (tampered.foregroundAction.ui as { prefill: string }).prefill = "Grace";
  assert.equal(validateRuntimeSnapshot(tampered, valid).valid, false);
});

test("a retained settlement keeps the prefill its field presented", () => {
  for (const source of [
    "let answer = askText default: value\nexit",
    "let answer = askText value\nexit",
  ]) {
    const plan = compileValidPlan(source, { globals: ["value"] });
    const { snapshot } = pendingInput(plan, { value: "Ada" });
    const done = run(plan, submit(plan, snapshot, "Grace").snapshot).snapshot;
    assert.equal(validateRuntimeSnapshot(done, plan).valid, true, source);
    const checkpoint = structuredClone(createCheckpoint(plan, done));
    const settlement = checkpoint.snapshot.lastSettlement;
    assert.ok(settlement?.actionKind === "interaction" && settlement.ui.kind === "text", source);
    assert.equal(settlement.ui.prefill, source.includes("default:") ? "Ada" : undefined, source);
    // A default that was empty when the field opened presented none, so only a field without a default is checked.
    if (source.includes("default:")) continue;
    // EVIDENCE: the cloned fixture is mutable; it only adds a prefill that a field without a default never presented.
    (settlement.ui as { prefill?: string }).prefill = "Ada";
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)), source);
  }
});

test("the Player composer receives the default answer, also after a restore", () => {
  const session = createPlayerRuntimeSession(
    'let answer = askNumber hint: "How many?", default: 12\nexit',
  );
  const expected = {
    kind: "ask-number",
    accessibleName: "Number",
    hint: "How many?",
    prefill: "12",
  };
  assert.deepEqual(playerRuntimeForeground(session), expected);
  assert.deepEqual(
    playerRuntimeForeground(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session))),
    expected,
  );
  const withoutDefault = createPlayerRuntimeSession('let answer = askText "Name?"\nexit');
  assert.equal(
    playerRuntimeForeground(withoutDefault)?.kind === "ask-text" &&
      "prefill" in playerRuntimeForeground(withoutDefault)!,
    false,
  );
});
