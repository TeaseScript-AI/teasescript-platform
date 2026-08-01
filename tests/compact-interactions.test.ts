import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { compileProgram, InstructionCompilationError } from "../src/compiler/compile-program.js";
import {
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
  MAX_INTERACTION_STRING_UTF8_BYTES,
} from "../src/interaction-limits.js";
import { parse } from "../src/parser.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint } from "../src/runtime/checkpoint.js";
import { completeAction, executeInstruction, run } from "../src/runtime/engine.js";
import { execute, InterpreterCompilationError } from "../src/runtime/interpreter.js";
import { createSerializableList } from "../src/runtime/serializable-values.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";

function compiled(source: string, options: Parameters<typeof compileSource>[1] = {}) {
  const result = compileSource(source, options);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  assert.equal(validateInstructionPlan(result.plan).valid, true);
  return result.plan!;
}

function completePending(plan: ReturnType<typeof compiled>, snapshot: ReturnType<typeof createFreshRuntimeSnapshot>, interactionKind: "button" | "text" | "number" | "choice", payload: unknown) {
  const action = snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  return completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind,
    payload,
  });
}

function snapshotImmediatelyBeforeInteraction(
  plan: ReturnType<typeof compiled>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
  capabilities: Parameters<typeof executeInstruction>[2] = {},
) {
  let current = snapshot;
  while (plan.instructions[current.nextInstruction]?.kind !== "interaction") {
    const step = executeInstruction(plan, current, capabilities);
    assert.notEqual(step.snapshot.status, "failed");
    current = step.snapshot;
  }
  return current;
}

test("compact interaction forms preserve immutable command, speaker, label, separator, option, and construct spans", () => {
  const source = 'showButton as mistress "Ready"\nlet result = choose as mistress first: "Mystery",  second: "Again"';
  const parsed = parse(source);
  assert.deepEqual(parsed.diagnostics, []);
  const button = parsed.program.statements[0]!;
  assert.equal(button.kind, "showButtonStatement");
  assert.deepEqual(button.commandSpan, { start: { offset: 0, line: 0, column: 0 }, end: { offset: 10, line: 0, column: 10 } });
  assert.deepEqual(button.asSpan, { start: { offset: 11, line: 0, column: 11 }, end: { offset: 13, line: 0, column: 13 } });
  assert.deepEqual(button.speaker?.span, { start: { offset: 14, line: 0, column: 14 }, end: { offset: 22, line: 0, column: 22 } });
  assert.deepEqual(button.label.span, { start: { offset: 23, line: 0, column: 23 }, end: { offset: 30, line: 0, column: 30 } });
  assert.deepEqual(button.span, { start: { offset: 0, line: 0, column: 0 }, end: { offset: 30, line: 0, column: 30 } });

  const declaration = parsed.program.statements[1]!;
  assert.equal(declaration.kind, "letStatement");
  assert.equal(declaration.initializer.kind, "interactionExpression");
  const choice = declaration.initializer;
  assert.deepEqual(choice.commandSpan, { start: { offset: 44, line: 1, column: 13 }, end: { offset: 50, line: 1, column: 19 } });
  assert.deepEqual(choice.asSpan, { start: { offset: 51, line: 1, column: 20 }, end: { offset: 53, line: 1, column: 22 } });
  assert.equal(choice.options.length, 2);
  assert.deepEqual(choice.options[0]!.label?.span, { start: { offset: 63, line: 1, column: 32 }, end: { offset: 68, line: 1, column: 37 } });
  assert.deepEqual(choice.options[0]!.colonSpan, { start: { offset: 68, line: 1, column: 37 }, end: { offset: 69, line: 1, column: 38 } });
  assert.deepEqual(choice.options[0]!.separatorSpan, { start: { offset: 79, line: 1, column: 48 }, end: { offset: 80, line: 1, column: 49 } });
  assert.equal(choice.span.end.offset, source.length);
  assert.equal(Object.isFrozen(choice), true);
  assert.equal(Object.isFrozen(choice.options), true);
  assert.equal(Object.isFrozen(choice.options[0]), true);
});

test("all accepted compact forms parse and malformed forms recover at the next statement", () => {
  const accepted = [
    'showButton "Continue"', 'showButton as mistress "Ready"',
    "let answer = askText", 'let answer = askText "Type here"',
    "let answer = askText as mistress", 'let answer = askText as mistress "Type here"',
    "let amount = askNumber", 'let amount = askNumber "Enter a number"',
    "let amount = askNumber as mistress", 'let amount = askNumber as mistress "Enter a number"',
    'let result = choose "Bratty", "Very submissive"',
    'let result = choose as mistress "Bratty", "Very submissive"',
    'let result = choose bratty: "Bratty", submissive: "Very submissive"',
    'let result = choose as mistress first: "Mystery", second: "Mystery"',
    'let result = choose 1: "Open the door", 2: "Walk away"',
  ];
  for (const source of accepted) assert.deepEqual(parse(source).diagnostics, [], source);
  for (const source of ["showButton", "let x = choose", 'let x = choose "A",', "let x = askText as"]) {
    const result = parse(`${source}\nsay "recovered"`);
    assert.ok(result.diagnostics.length > 0, source);
    assert.equal(result.program.statements.at(-1)?.kind, "sayStatement", source);
  }
});

test("compact choices diagnose a missing separator at the next option and recover", () => {
  const cases = [
    { source: 'let result = choose "One" "Two"', span: [26, 31] },
    { source: 'let result = choose first: "One" second: "Two"', span: [33, 39] },
  ];
  for (const scenario of cases) {
    const parsed = parse(`${scenario.source}\nsay "recovered"`);
    assert.deepEqual(parsed.diagnostics.map((diagnostic) => diagnostic.code), ["TSP031"]);
    assert.deepEqual(
      [parsed.diagnostics[0]!.span.start.offset, parsed.diagnostics[0]!.span.end.offset],
      scenario.span,
    );
    assert.equal(parsed.program.statements.at(-1)?.kind, "sayStatement");
  }
});

test("selected prelude names are protected in declarations and host configuration", () => {
  for (const name of ["showButton", "askText", "askNumber", "choose"]) {
    const sources = [
      `let ${name} = 1`,
      `speaker ${name} {}`,
      `function ${name} { return }`,
      `function sample(${name}) { return }`,
      `function sample { let ${name} = 1\nreturn }`,
    ];
    for (const source of sources) {
      assert.ok(compileSource(source).diagnostics.some((diagnostic) => diagnostic.code === "TSV001"), `${name}: ${source}`);
    }
    assert.ok(compileSource('say "ok"', { globals: [name] }).diagnostics.some((diagnostic) => diagnostic.code === "TSV001"), `${name}: global`);
    assert.ok(compileSource('say "ok"', { builtins: [name] }).diagnostics.some((diagnostic) => diagnostic.code === "TSV001"), `${name}: builtin`);
  }
});

test("choice diagnostics reject mixing and duplicates while labelled visible text may repeat", () => {
  const rejected = [
    'let x = choose first: "A", "B"',
    'let x = choose first: "A", 2: "B"',
    'let x = choose first: "A", first: "B"',
    'let x = choose 1: "A", 1.0: "B"',
    'let x = choose "Same", "Same"',
    'let x = choose 1e999: "A"',
  ];
  for (const source of rejected) assert.equal(compileSource(source).plan, null, source);
  assert.notEqual(compileSource('let x = choose first: "Same", second: "Same"').plan, null);
  const unsupported = compileSource("let x = [askText, askNumber]");
  assert.equal(unsupported.plan, null);
  assert.ok(unsupported.diagnostics.some((diagnostic) => diagnostic.code === "TSV032"));
});

test("direct AST and prepared-plan validation reject malformed new shapes", () => {
  const parsed = structuredClone(parse("let x = askText").program) as any;
  delete parsed.statements[0].initializer.commandSpan;
  assert.throws(
    () => compileProgram(parsed),
    (error: unknown) => error instanceof InstructionCompilationError && error.code === "TSC005",
  );
  const plan = structuredClone(compiled("showButton payload", { globals: ["payload"] })) as any;
  const interaction = plan.instructions.find((instruction: any) => instruction.kind === "interaction");
  interaction.preparedUi.buttonLabelTemporary = plan.temporaryCount + 1;
  assert.equal(validateInstructionPlan(plan).valid, false);
  const oldVersion = structuredClone(compiled("let answer = askText")) as any;
  oldVersion.version = 5;
  assert.equal(validateInstructionPlan(oldVersion).valid, false);
});

test("authored payloads evaluate once in source order before pending state", () => {
  const plan = compiled("let result = choose nextText(), nextText()", { builtins: ["nextText"] });
  const calls: string[] = [];
  const pending = run(plan, createFreshRuntimeSnapshot(plan), {
    builtins: {
      nextText: () => {
        const value = calls.length === 0 ? "First" : "Second";
        calls.push(value);
        return value;
      },
    },
  });
  assert.deepEqual(calls, ["First", "Second"]);
  assert.equal(pending.snapshot.status, "waiting");
  assert.deepEqual(pending.snapshot.foregroundAction?.kind === "interaction" ? pending.snapshot.foregroundAction.ui : null, {
    kind: "choice", labelType: "none",
    options: [{ text: "First", label: null }, { text: "Second", label: null }],
    accessibleName: { kind: "localizedDefault", key: "chooseOption" },
  });
  const completed = completePending(plan, pending.snapshot, "choice", { kind: "selectedText", selectedText: "Second" });
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(calls, ["First", "Second"]);
});

test("dynamic interaction UI uses the established visible-text conversion once before waiting", () => {
  const numberPlan = compiled("showButton 12.5");
  const numberPending = run(numberPlan, createFreshRuntimeSnapshot(numberPlan));
  assert.equal(numberPending.snapshot.foregroundAction?.kind === "interaction" && numberPending.snapshot.foregroundAction.ui.kind === "button"
    ? numberPending.snapshot.foregroundAction.ui.buttonLabel
    : null, "12.5");

  const listPlan = compiled("let result = choose [\"left\", 2], [\"right\", 3]");
  const randomValues = [0.75, 0.75];
  let randomCalls = 0;
  const listPending = run(listPlan, createFreshRuntimeSnapshot(listPlan), {
    random: {
      next: () => {
        const value = randomValues[randomCalls]!;
        randomCalls += 1;
        return value;
      },
    },
  });
  assert.equal(randomCalls, 2);
  assert.deepEqual(listPending.snapshot.foregroundAction?.kind === "interaction" ? listPending.snapshot.foregroundAction.ui : null, {
    kind: "choice",
    labelType: "none",
    options: [{ text: "2", label: null }, { text: "3", label: null }],
    accessibleName: { kind: "localizedDefault", key: "chooseOption" },
  });
  const listInstruction = listPlan.instructions.find((instruction) => instruction.kind === "interaction");
  assert.ok(listInstruction?.kind === "interaction" && listInstruction.preparedUi?.kind === "choice");
  assert.deepEqual(
    listInstruction.preparedUi.options.map((option) =>
      listPending.snapshot.temporaries.find((temporary) => temporary.id === option.textTemporary)?.value,
    ),
    ["2", "3"],
  );

  const seededFirst = run(listPlan, createFreshRuntimeSnapshot(listPlan, { seed: 1591436852 }));
  const seededSecond = run(listPlan, createFreshRuntimeSnapshot(listPlan, { seed: 1591436852 }));
  assert.deepEqual(seededFirst.snapshot.foregroundAction, seededSecond.snapshot.foregroundAction);
  assert.deepEqual(seededFirst.snapshot.rng, seededSecond.snapshot.rng);

  const unsupportedPlan = compiled("showButton [true]");
  let unsupportedRandomCalls = 0;
  const unsupported = run(unsupportedPlan, createFreshRuntimeSnapshot(unsupportedPlan), {
    random: { next: () => { unsupportedRandomCalls += 1; return 0; } },
  });
  assert.equal(unsupportedRandomCalls, 1);
  assert.equal(unsupported.snapshot.failure?.code, "TSR021");
  assert.equal(unsupported.snapshot.foregroundAction, null);
  assert.equal(unsupported.snapshot.nextActionId, 1);
});

test("dynamic interaction UI commits prepared text and serialized RNG only after full validation", () => {
  const cases = [
    {
      name: "a later dynamic unlabelled duplicate",
      plan: compiled('let result = choose first, "same"', { globals: ["first"] }),
      globals: { first: createSerializableList(["same"]) },
      code: "TSR052",
    },
    {
      name: "an aggregate overflow after list selection",
      plan: compiled("let result = choose first, second", { globals: ["first", "second"] }),
      globals: {
        first: createSerializableList(["a".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 2)]),
        second: "b".repeat(MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 2 + 1),
      },
      code: "TSR052",
    },
    {
      name: "an unsupported selected list item after an earlier value",
      plan: compiled("let result = choose first, second", { globals: ["first", "second"] }),
      globals: {
        first: createSerializableList(["first"]),
        second: createSerializableList([true]),
      },
      code: "TSR021",
    },
  ] as const;
  for (const scenario of cases) {
    const before = snapshotImmediatelyBeforeInteraction(
      scenario.plan,
      createFreshRuntimeSnapshot(scenario.plan, { globals: scenario.globals, seed: 1591436852 }),
    );
    const temporaries = structuredClone(before.temporaries);
    const rng = structuredClone(before.rng);
    const nextActionId = before.nextActionId;
    const nextEventSequence = before.nextEventSequence;
    const failed = executeInstruction(scenario.plan, before);
    assert.equal(failed.snapshot.failure?.code, scenario.code, scenario.name);
    assert.equal(failed.snapshot.foregroundAction, null, scenario.name);
    assert.equal(failed.snapshot.nextActionId, nextActionId, scenario.name);
    // The existing structured failure event consumes its one sequence; no
    // interaction request or transcript sequence is allocated.
    assert.equal(failed.snapshot.nextEventSequence, nextEventSequence + 1, scenario.name);
    assert.deepEqual(failed.snapshot.temporaries, temporaries, scenario.name);
    assert.deepEqual(failed.snapshot.rng, rng, scenario.name);
    assert.equal(failed.snapshot.lastSettlement, null, scenario.name);
    assert.equal(failed.snapshot.nextInstruction, before.nextInstruction, scenario.name);
    assert.deepEqual(failed.events.map((event) => event.kind), ["runtimeFailure"], scenario.name);
  }
});

test("dynamic list payload selection is fixed before checkpoint restore and is never reevaluated", () => {
  const plan = compiled("showButton values()", { builtins: ["values"] });
  let calls = 0;
  const pending = run(plan, createFreshRuntimeSnapshot(plan, { seed: 1364229357 }), {
    builtins: {
      values: () => {
        calls += 1;
        return createSerializableList(["left", 2]);
      },
    },
  });
  assert.equal(calls, 1);
  const label = pending.snapshot.foregroundAction?.kind === "interaction" && pending.snapshot.foregroundAction.ui.kind === "button"
    ? pending.snapshot.foregroundAction.ui.buttonLabel
    : null;
  const savedRng = pending.snapshot.rng;
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, pending.snapshot)));
  const resumed = run(restored.plan, restored.snapshot, {
    builtins: { values: () => { calls += 1; return createSerializableList(["wrong"]); } },
  });
  assert.equal(calls, 1);
  assert.equal(resumed.snapshot.foregroundAction?.kind === "interaction" && resumed.snapshot.foregroundAction.ui.kind === "button"
    ? resumed.snapshot.foregroundAction.ui.buttonLabel
    : null, label);
  assert.deepEqual(resumed.snapshot.rng, savedRng);

  const uninterrupted = run(
    plan,
    completePending(plan, pending.snapshot, "button", { kind: "activate" }).snapshot,
  );
  const restoredCompleted = run(
    restored.plan,
    completePending(restored.plan, restored.snapshot, "button", { kind: "activate" }).snapshot,
  );
  assert.deepEqual(restoredCompleted.snapshot, uninterrupted.snapshot);
  assert.deepEqual(restoredCompleted.events, uninterrupted.events);
});

test("requesting speaker is captured before payload side effects change the default speaker", () => {
  const plan = compiled([
    "speaker first {}", "speaker second {}", "speaker first",
    "function changeDefault {", "speaker second", 'return "Hint"', "}",
    "let answer = askText changeDefault()",
  ].join("\n"));
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  const first = pending.snapshot.speakers.find((speaker) => speaker.identifier === "first");
  const second = pending.snapshot.speakers.find((speaker) => speaker.identifier === "second");
  assert.equal(action.speakerId, first?.id);
  assert.equal(pending.snapshot.defaultSpeaker, second?.id);
});

test("fixed-seed payload RNG is prepared once and restore does not reevaluate it", () => {
  const plan = compiled("let result = choose `A ${random()}`, `B ${random()}`");
  const pending = run(plan, createFreshRuntimeSnapshot(plan, { seed: 1364229357 }));
  const savedRng = pending.snapshot.rng;
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, pending.snapshot)));
  assert.deepEqual(restored.snapshot.rng, savedRng);
  const action = restored.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction" && action.ui.kind === "choice");
  const selected = action.ui.options[1]!.text;
  const completed = completePending(restored.plan, restored.snapshot, "choice", { kind: "selectedText", selectedText: selected });
  assert.deepEqual(completed.snapshot.rng, savedRng);
});

test("dynamic rejection is atomic before action identity, pending state, or transcript allocation", () => {
  const duplicatePlan = compiled("let result = choose first, second", { globals: ["first", "second"] });
  const failed = run(duplicatePlan, createFreshRuntimeSnapshot(duplicatePlan, { globals: { first: "same", second: "same" } }));
  assert.equal(failed.snapshot.status, "failed");
  assert.equal(failed.snapshot.foregroundAction, null);
  assert.equal(failed.snapshot.nextActionId, 1);
  assert.equal(failed.events.some((event) => event.kind === "actionRequested" || event.kind === "playerTranscript"), false);

  const overPlan = compiled("showButton payload", { globals: ["payload"] });
  const over = run(overPlan, createFreshRuntimeSnapshot(overPlan, { globals: { payload: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1) } }));
  assert.equal(over.snapshot.status, "failed");
  assert.equal(over.snapshot.nextActionId, 1);
  assert.equal(over.snapshot.foregroundAction, null);
});

test("real source completes, retries invalid input, records provenance, and resumes at top level", () => {
  const plan = compiled('speaker mistress { name: "Mistress" }\nlet answer = askText as mistress "Type here"\nsay answer');
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  assert.notEqual(action.speakerId, null);
  const invalid = completePending(plan, pending.snapshot, "text", { kind: "submittedText", submittedText: " \t" });
  assert.equal(invalid.outcome.kind, "invalidPayload");
  assert.deepEqual(invalid.snapshot, pending.snapshot);
  const completed = completePending(plan, invalid.snapshot, "text", { kind: "submittedText", submittedText: "ok\r\nnow" });
  assert.deepEqual(completed.events.map((event) => event.kind), ["playerTranscript", "actionCompleted"]);
  assert.equal(completed.events[0]?.kind === "playerTranscript" ? completed.events[0].requestingSpeakerId : null, action.speakerId);
  const done = run(plan, completed.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.equal(done.events.find((event) => event.kind === "say")?.text, "ok\nnow");
});

test("an authored empty hint remains distinct from an omitted hint", () => {
  const emptyPlan = compiled('let answer = askText ""');
  const emptyPending = run(emptyPlan, createFreshRuntimeSnapshot(emptyPlan));
  const emptyAction = emptyPending.snapshot.foregroundAction;
  assert.ok(emptyAction !== null && emptyAction.kind === "interaction" && emptyAction.ui.kind === "text");
  assert.equal(emptyAction.ui.hint, "");
  assert.deepEqual(emptyAction.ui.accessibleName, { kind: "localizedDefault", key: "answer" });

  const omittedPlan = compiled("let answer = askText");
  const omittedPending = run(omittedPlan, createFreshRuntimeSnapshot(omittedPlan));
  const omittedAction = omittedPending.snapshot.foregroundAction;
  assert.ok(omittedAction !== null && omittedAction.kind === "interaction" && omittedAction.ui.kind === "text");
  assert.equal(omittedAction.ui.hint, null);
});

test("real source preserves button transcript and all choice result domains", () => {
  const cases = [
    { source: 'let result = choose "A", "B"', payload: { kind: "selectedText", selectedText: "B" }, result: "B", text: "B" },
    { source: 'let result = choose first: "Same", second: "Same"', payload: { kind: "selectedLabel", selectedLabel: "second" }, result: "second", text: "Same" },
    { source: 'let result = choose 1: "One", 2: "Two"', payload: { kind: "selectedLabel", selectedLabel: 2 }, result: 2, text: "Two" },
  ] as const;
  for (const scenario of cases) {
    const plan = compiled(scenario.source);
    const pending = run(plan, createFreshRuntimeSnapshot(plan));
    const completed = completePending(plan, pending.snapshot, "choice", scenario.payload);
    assert.equal(completed.outcome.kind, "completed");
    assert.equal(completed.outcome.kind === "completed" && completed.outcome.settlement.actionKind === "interaction" ? completed.outcome.settlement.result : null, scenario.result);
    assert.equal(completed.events[0]?.kind === "playerTranscript" ? completed.events[0].text : null, scenario.text);
  }

  const buttonPlan = compiled('showButton "Continue"');
  const buttonPending = run(buttonPlan, createFreshRuntimeSnapshot(buttonPlan));
  const buttonDone = completePending(buttonPlan, buttonPending.snapshot, "button", { kind: "activate" });
  assert.equal(buttonDone.events[0]?.kind === "playerTranscript" ? buttonDone.events[0].text : null, "Continue");
});

test("function-owned interaction result survives checkpoint completion and explicit call-frame resume", () => {
  const plan = compiled('function prompt {\nlet value = askNumber\nreturn value\n}\nlet result = prompt()\nsay result');
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  assert.notEqual(action.ownerCallFrameId, null);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, pending.snapshot)));
  const completed = completePending(restored.plan, restored.snapshot, "number", { kind: "submittedText", submittedText: " 1.5e2 " });
  assert.equal(validateRuntimeSnapshot(completed.snapshot, restored.plan).valid, true);
  const done = run(restored.plan, completed.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.equal(done.events.find((event) => event.kind === "say")?.text, "150");
  assert.deepEqual(done.snapshot.temporaries, []);
  assert.deepEqual(done.snapshot.callFrames, []);
});

test("dynamic settlement retains canonical UI provenance before and after payload cleanup", () => {
  const buttonPlan = compiled("showButton label", { globals: ["label"] });
  const buttonPending = run(buttonPlan, createFreshRuntimeSnapshot(buttonPlan, { globals: { label: "Continue" } }));
  const buttonCompleted = completePending(buttonPlan, buttonPending.snapshot, "button", { kind: "activate" });
  assert.equal(validateRuntimeSnapshot(buttonCompleted.snapshot, buttonPlan).valid, true);
  const wrongButton = structuredClone(buttonCompleted.snapshot) as any;
  wrongButton.lastSettlement.transcriptText = "Wrong";
  assert.equal(validateRuntimeSnapshot(wrongButton, buttonPlan).valid, false);
  const buttonAfterCleanup = run(buttonPlan, buttonCompleted.snapshot).snapshot;
  assert.equal(validateRuntimeSnapshot(buttonAfterCleanup, buttonPlan).valid, true);
  const corruptedCheckpoint = structuredClone(createCheckpoint(buttonPlan, buttonAfterCleanup)) as any;
  corruptedCheckpoint.snapshot.lastSettlement.ui.buttonLabel = "Wrong";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corruptedCheckpoint)));

  const choicePlan = compiled("let result = choose first, second", { globals: ["first", "second"] });
  const choicePending = run(choicePlan, createFreshRuntimeSnapshot(choicePlan, { globals: { first: "One", second: "Two" } }));
  const choiceCompleted = completePending(choicePlan, choicePending.snapshot, "choice", { kind: "selectedText", selectedText: "One" });
  const wrongChoice = structuredClone(choiceCompleted.snapshot) as any;
  wrongChoice.lastSettlement.result = "Two";
  wrongChoice.temporaries.find((temporary: any) => temporary.id === wrongChoice.lastSettlement.destinationTemporary).value = "Two";
  assert.equal(validateRuntimeSnapshot(wrongChoice, choicePlan).valid, false);
  const choiceAfterCleanup = run(choicePlan, choiceCompleted.snapshot).snapshot;
  const missingOption = structuredClone(choiceAfterCleanup) as any;
  missingOption.lastSettlement.transcriptText = "Missing";
  missingOption.lastSettlement.result = "Missing";
  assert.equal(validateRuntimeSnapshot(missingOption, choicePlan).valid, false);
  const malformedCheckpoint = structuredClone(createCheckpoint(choicePlan, choiceAfterCleanup)) as any;
  malformedCheckpoint.snapshot.lastSettlement.ui.options[0].text = "Corrupted";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(malformedCheckpoint)));

  const labelledPlan = compiled("let result = choose first: firstText, second: secondText", { globals: ["firstText", "secondText"] });
  const labelledPending = run(labelledPlan, createFreshRuntimeSnapshot(labelledPlan, { globals: { firstText: "Same", secondText: "Same" } }));
  const labelledCompleted = completePending(labelledPlan, labelledPending.snapshot, "choice", { kind: "selectedLabel", selectedLabel: "first" });
  const labelledAfterCleanup = run(labelledPlan, labelledCompleted.snapshot).snapshot;
  const mismatchedLabel = structuredClone(labelledAfterCleanup) as any;
  mismatchedLabel.lastSettlement.result = "third";
  assert.equal(validateRuntimeSnapshot(mismatchedLabel, labelledPlan).valid, false);
  const mismatchedLabelCheckpoint = structuredClone(createCheckpoint(labelledPlan, labelledAfterCleanup)) as any;
  mismatchedLabelCheckpoint.snapshot.lastSettlement.transcriptText = "Missing";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(mismatchedLabelCheckpoint)));
});

test("exact dynamic string boundary is accepted and narrator fallback remains null", () => {
  const plan = compiled("showButton payload", { globals: ["payload"] });
  const pending = run(plan, createFreshRuntimeSnapshot(plan, { globals: { payload: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES) } }));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  assert.equal(action.speakerId, null);
  assert.equal(action.ui.kind === "button" ? action.ui.buttonLabel.length : 0, MAX_INTERACTION_STRING_UTF8_BYTES);
});

test("the compact static labelled representation reaches the provisional generic option payload ceiling", () => {
  const aggregatePlan = compiled("let result = choose first, second", { globals: ["first", "second"] });
  const half = MAX_INTERACTION_AGGREGATE_UTF8_BYTES / 2;
  const aggregatePending = run(aggregatePlan, createFreshRuntimeSnapshot(aggregatePlan, {
    globals: { first: "a".repeat(half), second: "b".repeat(half) },
  }));
  assert.equal(aggregatePending.snapshot.status, "waiting");
  const aggregateRejected = run(aggregatePlan, createFreshRuntimeSnapshot(aggregatePlan, {
    globals: { first: "a".repeat(half), second: "b".repeat(half + 1) },
  }));
  assert.equal(aggregateRejected.snapshot.status, "failed");
  assert.equal(aggregateRejected.snapshot.foregroundAction, null);
  assert.equal(aggregateRejected.snapshot.nextActionId, 1);

  const options = Array.from(
    { length: MAX_INTERACTION_OPTION_ENTRIES },
    (_, index) => `${index + 1}: ""`,
  ).join(", ");
  const optionPlan = compiled(`let result = choose ${options}`);
  const optionPending = run(optionPlan, createFreshRuntimeSnapshot(optionPlan));
  const action = optionPending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction" && action.ui.kind === "choice");
  assert.equal(action.ui.options.length, MAX_INTERACTION_OPTION_ENTRIES);

  const tooMany = compileSource(`let result = choose ${options}, ${MAX_INTERACTION_OPTION_ENTRIES + 1}: ""`);
  assert.equal(tooMany.plan, null);
  assert.ok(tooMany.diagnostics.some((diagnostic) => diagnostic.code === "TSV031"));
});

test("legacy direct-AST execution rejects compact blocking interactions", () => {
  assert.throws(
    () => execute(parse('showButton "Continue"').program, { random: { next: () => 0.5 } }),
    (error: unknown) => error instanceof InterpreterCompilationError
      && error.diagnostics.some((diagnostic) => diagnostic.code === "TSC006"),
  );
});

test("dynamic compact payloads resolve their captured interaction speaker without leaking context", () => {
  const buttonPlan = compiled([
    'speaker mistress { title: "Mistress" }',
    "showButton as mistress speaker.title",
  ].join("\n"));
  const buttonPending = run(buttonPlan, createFreshRuntimeSnapshot(buttonPlan));
  const buttonAction = buttonPending.snapshot.foregroundAction;
  if (buttonAction === null || buttonAction.kind !== "interaction" || buttonAction.ui.kind !== "button") {
    throw new Error("Expected pending button interaction.");
  }
  assert.equal(buttonAction.ui.buttonLabel, "Mistress");

  const textPlan = compiled([
    'speaker mistress { title: "Mistress" }',
    "function echo(value) { return value }",
    'let answer = askText as mistress `For ${echo(speaker.title)}`',
  ].join("\n"));
  const textPending = run(textPlan, createFreshRuntimeSnapshot(textPlan));
  const textAction = textPending.snapshot.foregroundAction;
  if (textAction === null || textAction.kind !== "interaction" || textAction.ui.kind !== "text") {
    throw new Error("Expected pending text interaction.");
  }
  assert.equal(textAction.ui.hint, "For Mistress");

  const choicePlan = compiled([
    'speaker mistress { title: "Mistress" }',
    'let result = choose as mistress speaker.title, `Yes, ${speaker.title}`',
  ].join("\n"));
  const choicePending = run(choicePlan, createFreshRuntimeSnapshot(choicePlan));
  const choiceAction = choicePending.snapshot.foregroundAction;
  if (choiceAction === null || choiceAction.kind !== "interaction" || choiceAction.ui.kind !== "choice") {
    throw new Error("Expected pending choice interaction.");
  }
  assert.deepEqual(choiceAction.ui.options.map((option) => option.text), ["Mistress", "Yes, Mistress"]);

  const leaked = compileSource([
    'speaker mistress { title: "Mistress" }',
    "function forbidden { return speaker.title }",
    "showButton as mistress forbidden()",
  ].join("\n"));
  assert.equal(leaked.plan, null);
  assert.ok(leaked.diagnostics.some((diagnostic) => diagnostic.code === "TSV002"));
});

test("prepared interaction plan validation rejects temporary aliasing only inside one materialization", () => {
  const sourcePlan = compiled("let result = choose first, second", { globals: ["first", "second"] });
  const mutations = [
    (interaction: any) => { interaction.preparedUi.options[1].textTemporary = interaction.preparedUi.options[0].textTemporary; },
    (interaction: any) => { interaction.speakerTemporary = interaction.preparedUi.options[0].textTemporary; },
    (interaction: any) => { interaction.destinationTemporary = interaction.preparedUi.options[0].textTemporary; },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(sourcePlan) as any;
    const interaction = malformed.instructions.find((instruction: any) => instruction.kind === "interaction");
    mutate(interaction);
    const validation = validateInstructionPlan(malformed);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.code === "TSC002" && error.message.includes("pairwise unique")));
  }
  assert.equal(validateInstructionPlan(sourcePlan).valid, true);
});

test("direct interaction AST capture rejects unsupported nested expressions and cross-field corruption", () => {
  const cases: any[] = [];

  const button = structuredClone(parse('showButton "Continue"').program) as any;
  button.statements[0].label = { kind: "hostileExpression", span: button.statements[0].label.span };
  cases.push(button);

  const choice = structuredClone(parse('let result = choose ("One")').program) as any;
  choice.statements[0].initializer.options[0].value.expression = {
    kind: "hostileExpression",
    span: choice.statements[0].initializer.options[0].value.expression.span,
  };
  cases.push(choice);

  const choiceWithHint = structuredClone(parse('let result = choose "One"').program) as any;
  choiceWithHint.statements[0].initializer.hint = choiceWithHint.statements[0].initializer.options[0].value;
  cases.push(choiceWithHint);

  const textWithOptions = structuredClone(parse('let result = askText "Hint"').program) as any;
  const parsedChoice = structuredClone(parse('let result = choose "One"').program) as any;
  textWithOptions.statements[0].initializer.options = [parsedChoice.statements[0].initializer.options[0]];
  cases.push(textWithOptions);

  const mismatchedCallStyle = structuredClone(parse('showButton helper("Continue")').program) as any;
  mismatchedCallStyle.statements[0].label.argumentStyle = "none";
  cases.push(mismatchedCallStyle);

  for (const malformed of cases) {
    assert.throws(
      () => compileProgram(malformed),
      (error: unknown) => error instanceof InstructionCompilationError && error.code === "TSC005",
    );
  }

  assert.doesNotThrow(() => compileProgram(parse('showButton "Continue"').program));
  assert.doesNotThrow(() => compileProgram(parse('let result = choose first: "One", second: "Two"').program));
});

test("static unlabelled choice duplicate detection uses canonical visible text", () => {
  const rejected = [
    'let x = choose true, "true"',
    'let x = choose false, "false"',
    'let x = choose null, "null"',
    'let x = choose 1, "1"',
    'let x = choose -1, "-1"',
    'let x = choose 1 + 1, "2"',
    'let x = choose (true), `true`',
    'let x = choose `${true}`, "true"',
    'let x = choose `value ${1 + 1}`, "value 2"',
  ];
  for (const source of rejected) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSV030"), source);
  }
});

test("numeric contexts classify compact interaction result domains narrowly", () => {
  assert.notEqual(compileSource('repeat (askNumber) { say "again" }').plan, null);
  assert.notEqual(compileSource('repeat (choose 1: "Once", 2: "Twice"\n) { say "again" }').plan, null);

  const rejected = [
    'repeat (askText) { say "never" }',
    'repeat (choose "Once", "Twice"\n) { say "never" }',
    'repeat (choose once: "Once", twice: "Twice"\n) { say "never" }',
  ];
  for (const source of rejected) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "TSV011"), source);
  }
});

test("prepared waiting and completed snapshots retain exact static UI provenance", () => {
  const buttonPlan = compiled("showButton label", { globals: ["label"] });
  const buttonPending = run(buttonPlan, createFreshRuntimeSnapshot(buttonPlan, { globals: { label: "Continue" } }));
  const wrongButtonAccessible = structuredClone(buttonPending.snapshot) as any;
  wrongButtonAccessible.foregroundAction.ui.accessibleName.key = "answer";
  assert.equal(validateRuntimeSnapshot(wrongButtonAccessible, buttonPlan).valid, false);

  const choicePlan = compiled("let result = choose first: firstText, second: secondText", {
    globals: ["firstText", "secondText"],
  });
  const choicePending = run(choicePlan, createFreshRuntimeSnapshot(choicePlan, {
    globals: { firstText: "One", secondText: "Two" },
  }));
  for (const mutate of [
    (snapshot: any) => { snapshot.foregroundAction.ui.accessibleName.key = "answer"; },
    (snapshot: any) => { snapshot.foregroundAction.ui.labelType = "number"; },
    (snapshot: any) => { snapshot.foregroundAction.ui.options[0].label = "other"; },
    (snapshot: any) => { snapshot.foregroundAction.ui.options.pop(); },
  ]) {
    const malformed = structuredClone(choicePending.snapshot) as any;
    mutate(malformed);
    assert.equal(validateRuntimeSnapshot(malformed, choicePlan).valid, false);
  }

  const completed = completePending(choicePlan, choicePending.snapshot, "choice", { kind: "selectedLabel", selectedLabel: "first" });
  const afterCleanup = run(choicePlan, completed.snapshot).snapshot;
  for (const mutate of [
    (snapshot: any) => { snapshot.lastSettlement.ui.accessibleName.key = "answer"; },
    (snapshot: any) => { snapshot.lastSettlement.ui.labelType = "number"; },
    (snapshot: any) => { snapshot.lastSettlement.ui.options[0].label = "other"; },
    (snapshot: any) => { snapshot.lastSettlement.ui.options.pop(); },
  ]) {
    const malformed = structuredClone(afterCleanup) as any;
    mutate(malformed);
    assert.equal(validateRuntimeSnapshot(malformed, choicePlan).valid, false);
    const checkpoint = structuredClone(createCheckpoint(choicePlan, afterCleanup)) as any;
    mutate(checkpoint.snapshot);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(checkpoint)));
  }
});

test("completed interaction settlement UI is deeply immutable across all returned aliases", () => {
  const plan = compiled("let result = choose first, second", { globals: ["first", "second"] });
  const pending = run(plan, createFreshRuntimeSnapshot(plan, { globals: { first: "One", second: "Two" } }));
  const completed = completePending(plan, pending.snapshot, "choice", { kind: "selectedText", selectedText: "One" });
  assert.equal(completed.outcome.kind, "completed");
  if (completed.outcome.kind !== "completed") return;
  const settlement = completed.outcome.settlement;
  assert.equal(settlement.actionKind, "interaction");
  if (settlement.actionKind !== "interaction") return;
  const event = completed.events.find((candidate) => candidate.kind === "actionCompleted");
  if (event === undefined || event.kind !== "actionCompleted") throw new Error("Expected actionCompleted event.");
  assert.equal(completed.snapshot.lastSettlement, settlement);
  assert.equal(event.settlement, settlement);
  assert.equal(Object.isFrozen(settlement), true);
  assert.equal(Object.isFrozen(settlement.ui), true);
  assert.equal(Object.isFrozen(settlement.ui.accessibleName), true);
  assert.equal(settlement.ui.kind, "choice");
  if (settlement.ui.kind !== "choice") return;
  const choiceUi = settlement.ui;
  assert.equal(Object.isFrozen(choiceUi.options), true);
  assert.ok(choiceUi.options.every((option) => Object.isFrozen(option)));
  assert.throws(() => { (choiceUi.options[0] as any).text = "Mutated"; }, TypeError);
  assert.equal((completed.snapshot.lastSettlement as any).ui.options[0].text, "One");
  assert.equal((event.settlement as any).ui.options[0].text, "One");

  const duplicate = completeAction(plan, completed.snapshot, {
    actionId: settlement.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedText", selectedText: "Two" },
  });
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  if (duplicate.outcome.kind !== "alreadySettled") return;
  const replay = duplicate.outcome.settlement;
  assert.equal(replay.actionKind, "interaction");
  if (replay.actionKind !== "interaction") return;
  assert.equal(Object.isFrozen(replay), true);
  assert.equal(Object.isFrozen(replay.ui), true);
  assert.equal(replay.ui.kind, "choice");
  if (replay.ui.kind !== "choice") return;
  const replayChoiceUi = replay.ui;
  assert.equal(Object.isFrozen(replayChoiceUi.options), true);
  assert.ok(replayChoiceUi.options.every((option) => Object.isFrozen(option)));
  assert.throws(() => { (replayChoiceUi.options[0] as any).text = "Mutated"; }, TypeError);
});
