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
import { completeAction, run } from "../src/runtime/engine.js";
import { execute, InterpreterCompilationError } from "../src/runtime/interpreter.js";
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

test("exact dynamic string boundary is accepted and narrator fallback remains null", () => {
  const plan = compiled("showButton payload", { globals: ["payload"] });
  const pending = run(plan, createFreshRuntimeSnapshot(plan, { globals: { payload: "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES) } }));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  assert.equal(action.speakerId, null);
  assert.equal(action.ui.kind === "button" ? action.ui.buttonLabel.length : 0, MAX_INTERACTION_STRING_UTF8_BYTES);
});

test("exact aggregate and option-count limits apply to compact source", () => {
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
