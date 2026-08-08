import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
  MAX_INTERACTION_STRING_UTF8_BYTES,
} from "../src/interaction-limits.js";
import { parse } from "../src/parser.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint } from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
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


test("parenthesized advanced interaction-call forms are rejected with a focused diagnostic and exact span", () => {
  for (const source of [
    'showButton("Continue")',
    'showButton as mistress ("Continue")',
    'let answer = askText("Type here")',
    'let answer = askText as mistress ("Type here")',
    'let amount = askNumber("Enter a number")',
    'let amount = askNumber as mistress ("Enter a number")',
    'let result = choose("A", "B")',
    'let result = choose as mistress ("A", "B")',
  ]) {
    const parsed = parse(`${source}\nsay "recovered"`);
    const diagnostic = parsed.diagnostics[0];
    const opening = source.indexOf("(");
    assert.equal(diagnostic?.code, "TSP032", source);
    assert.deepEqual(
      diagnostic === undefined ? null : [diagnostic.span.start.offset, diagnostic.span.end.offset],
      [opening, opening + 1],
      source,
    );
    assert.ok(parsed.diagnostics.every((item) => ["TSP032", "TSP012"].includes(item.code)), source);
    assert.equal(parsed.program.statements.at(-1)?.kind, "sayStatement", source);
  }
});

test("unsupported additional compact interaction arguments are rejected at the separator", () => {
  for (const source of [
    'showButton "Continue", 5',
    'showButton as mistress "Continue", 5',
  ]) {
    const parsed = parse(`${source}\nsay "recovered"`);
    const diagnostic = parsed.diagnostics[0];
    const comma = source.indexOf(",");
    assert.equal(diagnostic?.code, "TSP032", source);
    assert.deepEqual(
      diagnostic === undefined ? null : [diagnostic.span.start.offset, diagnostic.span.end.offset],
      [comma, comma + 1],
      source,
    );
    assert.equal(parsed.program.statements.at(-1)?.kind, "sayStatement", source);
  }
});

test("misplaced interaction speaker clauses receive the focused compact-form diagnostic", () => {
  for (const source of [
    'showButton "Continue" as mistress',
    'let answer = askText "Type here" as mistress',
    'let amount = askNumber "Enter a number" as mistress',
    'let result = choose "A" as mistress, "B"',
  ]) {
    const parsed = parse(`${source}\nsay "recovered"`);
    const diagnostic = parsed.diagnostics[0];
    const asOffset = source.indexOf(" as ") + 1;
    assert.equal(diagnostic?.code, "TSP032", source);
    assert.deepEqual(
      diagnostic === undefined ? null : [diagnostic.span.start.offset, diagnostic.span.end.offset],
      [asOffset, asOffset + 2],
      source,
    );
    assert.equal(parsed.program.statements.at(-1)?.kind, "sayStatement", source);
  }
});

test("every accepted compact interaction variant carries exact command and construct spans", () => {
  const expressions = [
    "askText",
    'askText "Type here"',
    "askText as mistress",
    'askText as mistress "Type here"',
    "askNumber",
    'askNumber "Enter a number"',
    "askNumber as mistress",
    'askNumber as mistress "Enter a number"',
    'choose "Bratty", "Very submissive"',
    'choose as mistress "Bratty", "Very submissive"',
    'choose bratty: "Bratty", submissive: "Very submissive"',
    'choose as mistress first: "Mystery", second: "Mystery"',
    'choose 1: "Open the door", 2: "Walk away"',
  ];
  for (const expressionSource of expressions) {
    const source = `let result = ${expressionSource}`;
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, [], expressionSource);
    const declaration = parsed.program.statements[0]!;
    assert.equal(declaration.kind, "letStatement");
    assert.equal(declaration.initializer.kind, "interactionExpression");
    const interaction = declaration.initializer;
    const command = expressionSource.startsWith("askText")
      ? "askText"
      : expressionSource.startsWith("askNumber")
        ? "askNumber"
        : "choose";
    const commandStart = source.indexOf(command);
    assert.deepEqual(interaction.commandSpan, {
      start: { offset: commandStart, line: 0, column: commandStart },
      end: { offset: commandStart + command.length, line: 0, column: commandStart + command.length },
    });
    assert.equal(interaction.span.start.offset, commandStart);
    assert.equal(interaction.span.end.offset, source.length);
    const asStart = source.indexOf(" as ");
    assert.equal(interaction.asSpan?.start.offset ?? -1, asStart < 0 ? -1 : asStart + 1);
    assert.equal(interaction.speaker?.span.start.offset ?? -1, asStart < 0 ? -1 : asStart + 4);
    for (const option of interaction.options) {
      assert.ok(option.span.start.offset >= interaction.commandSpan.end.offset);
      assert.ok(option.span.end.offset <= interaction.span.end.offset);
      if (option.label === null) assert.equal(option.colonSpan, null);
      else assert.notEqual(option.colonSpan, null);
    }
  }

  for (const source of ['showButton "Continue"', 'showButton as mistress "Ready"']) {
    const parsed = parse(source);
    assert.deepEqual(parsed.diagnostics, []);
    const button = parsed.program.statements[0]!;
    assert.equal(button.kind, "showButtonStatement");
    assert.deepEqual(button.commandSpan, {
      start: { offset: 0, line: 0, column: 0 },
      end: { offset: 10, line: 0, column: 10 },
    });
    assert.equal(button.span.start.offset, 0);
    assert.equal(button.span.end.offset, source.length);
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

test("interaction speaker references use the existing precise unknown-speaker diagnostic", () => {
  for (const source of [
    'showButton as missing "Continue"',
    'let answer = askText as missing',
    'let amount = askNumber as missing',
    'let result = choose as missing "A", "B"',
  ]) {
    const result = compileSource(source);
    assert.equal(result.plan, null);
    assert.ok(result.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV005"), source);
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
  const sequential = compiled("let x = [askText, askNumber]");
  assert.equal(sequential.instructions.filter((instruction) => instruction.kind === "interaction").length, 2);
});

test("interaction result domains participate in existing numeric semantic checks", () => {
  assert.notEqual(compileSource("let values = askNumber..3").plan, null);

  const textRange = compileSource("let values = askText..3");
  assert.equal(textRange.plan, null);
  assert.ok(textRange.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV010"));
});

test("prepared-plan validation rejects malformed new shapes and stale plan revisions", () => {
  const plan = structuredClone(compiled("showButton payload", { globals: ["payload"] })) as any;
  const interaction = plan.instructions.find((instruction: any) => instruction.kind === "interaction");
  interaction.preparedUi.buttonLabelTemporary = plan.temporaryCount + 1;
  assert.equal(validateInstructionPlan(plan).valid, false);

  const aliased = structuredClone(compiled("let answer = askText hint", { globals: ["hint"] })) as any;
  const aliasedInteraction = aliased.instructions.find((instruction: any) => instruction.kind === "interaction");
  aliasedInteraction.preparedUi.hintTemporary = aliasedInteraction.speakerTemporary;
  assert.equal(validateInstructionPlan(aliased).valid, false);

  const oldVersion = structuredClone(compiled("let answer = askText")) as any;
  oldVersion.version = 6;
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
  assert.ok(listInstruction?.kind === "interaction" && "preparedUi" in listInstruction);
  const preparedUi = listInstruction.preparedUi;
  assert.equal(preparedUi.kind, "choice");
  assert.ok(preparedUi.kind === "choice");
  const preparedOptions = listPending.snapshot.temporaries.find(
    (temporary) => temporary.id === preparedUi.optionsTemporary,
  )?.value;
  assert.deepEqual(preparedOptions, createSerializableList(["2", "3"]));

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

test("static compact interactions use the default speaker at the instruction boundary", () => {
  const plan = compiled([
    "speaker first {}",
    "speaker second {}",
    "speaker first",
    'say as second "Context"',
    'showButton "Continue"',
  ].join("\n"));
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  const first = pending.snapshot.speakers.find((speaker) => speaker.identifier === "first");
  assert.equal(pending.snapshot.defaultSpeaker, first?.id);
  assert.equal(pending.snapshot.contextualSpeaker, null);
  assert.equal(
    pending.snapshot.foregroundAction?.kind === "interaction"
      ? pending.snapshot.foregroundAction.speakerId
      : null,
    first?.id,
  );
});

test("compact interactions use narrator provenance when no speaker is available", () => {
  const plan = compiled('let answer = askText "Type here"');
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  const action = pending.snapshot.foregroundAction;
  assert.ok(action !== null && action.kind === "interaction");
  assert.equal(action.speakerId, null);

  const completed = completePending(
    plan,
    pending.snapshot,
    "text",
    { kind: "submittedText", submittedText: "answer" },
  );
  assert.equal(completed.events[0]?.kind, "playerTranscript");
  assert.equal(
    completed.events[0]?.kind === "playerTranscript"
      ? completed.events[0].requestingSpeakerId
      : undefined,
    null,
  );
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


test("blocking interactions resume through ordinary expression contexts and reject unsupported parameter defaults", () => {
  const defaultResult = compileSource(
    "function prompt(value = askText) { return value }\nlet result = prompt()",
  );
  assert.equal(defaultResult.plan, null);
  assert.ok(defaultResult.diagnostics.some((diagnostic) => diagnostic.code === "TSV032"));

  const pairPlan = compiled("let pair = [askText, askNumber]");
  const firstPending = run(pairPlan, createFreshRuntimeSnapshot(pairPlan));
  assert.equal(firstPending.snapshot.status, "waiting");
  assert.equal(
    firstPending.snapshot.foregroundAction?.kind === "interaction"
      ? firstPending.snapshot.foregroundAction.interactionKind
      : null,
    "text",
  );
  const firstCompleted = completePending(
    pairPlan,
    firstPending.snapshot,
    "text",
    { kind: "submittedText", submittedText: "alpha" },
  );
  assert.equal(firstCompleted.outcome.kind, "completed");
  const secondPending = run(pairPlan, firstCompleted.snapshot);
  assert.equal(secondPending.snapshot.status, "waiting");
  assert.equal(
    secondPending.snapshot.foregroundAction?.kind === "interaction"
      ? secondPending.snapshot.foregroundAction.interactionKind
      : null,
    "number",
  );
  const secondCompleted = completePending(
    pairPlan,
    secondPending.snapshot,
    "number",
    { kind: "submittedText", submittedText: "2.5" },
  );
  assert.equal(run(pairPlan, secondCompleted.snapshot).snapshot.status, "halted");

  const shortCircuit = compiled("let value = false and askText");
  const shortCircuitDone = run(shortCircuit, createFreshRuntimeSnapshot(shortCircuit));
  assert.equal(shortCircuitDone.snapshot.status, "halted");
  assert.equal(shortCircuitDone.snapshot.foregroundAction, null);
});

test("interaction results resume through assignment and loop-owned source contexts", () => {
  const assignmentPlan = compiled('let answer = "before"\nanswer = askText\nsay answer');
  const assignmentPending = run(assignmentPlan, createFreshRuntimeSnapshot(assignmentPlan));
  const assignmentCompleted = completePending(assignmentPlan, assignmentPending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "after",
  });
  const assignmentDone = run(assignmentPlan, assignmentCompleted.snapshot);
  assert.equal(assignmentDone.snapshot.status, "halted");
  assert.equal(assignmentDone.events.find((event) => event.kind === "say")?.text, "after");

  const loopPlan = compiled([
    "let count = 0",
    "repeat 1 {",
    "  let answer = askText",
    "  count = count + 1",
    "}",
    "say count",
  ].join("\n"));
  const loopPending = run(loopPlan, createFreshRuntimeSnapshot(loopPlan));
  assert.equal(loopPending.snapshot.status, "waiting");
  assert.equal(loopPending.snapshot.loopFrames.length, 1);
  const loopCompleted = completePending(loopPlan, loopPending.snapshot, "text", {
    kind: "submittedText",
    submittedText: "ok",
  });
  const loopDone = run(loopPlan, loopCompleted.snapshot);
  assert.equal(loopDone.snapshot.status, "halted");
  assert.equal(loopDone.events.find((event) => event.kind === "say")?.text, "1");
});

test("interaction expressions preserve function-argument source order across suspension", () => {
  const plan = compiled(
    [
      "function middle(first, second, third) { return second }",
      'let answer = middle(mark("before"), askText, mark("after"))',
      "say answer",
    ].join("\n"),
    { builtins: ["mark"] },
  );
  const marks: string[] = [];
  const capabilities: Parameters<typeof run>[2] = {
    builtins: {
      mark: (call) => {
        const value = call.positional[0];
        assert.equal(typeof value, "string");
        marks.push(value as string);
        return value!;
      },
    },
  };
  const pending = run(plan, createFreshRuntimeSnapshot(plan), capabilities);
  assert.deepEqual(marks, ["before"]);
  assert.equal(pending.snapshot.status, "waiting");
  const completed = completePending(
    plan,
    pending.snapshot,
    "text",
    { kind: "submittedText", submittedText: "answer" },
  );
  assert.equal(completed.outcome.kind, "completed");
  const done = run(plan, completed.snapshot, capabilities);
  assert.deepEqual(marks, ["before", "after"]);
  assert.equal(done.snapshot.status, "halted");
  assert.equal(done.events.find((event) => event.kind === "say")?.text, "answer");
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

test("every compact interaction survives pending checkpoint restore and source-to-runtime completion", () => {
  const scenarios = [
    { source: 'showButton "Continue"', interactionKind: "button" as const, payload: { kind: "activate" as const } },
    { source: 'let result = askText "Type here"', interactionKind: "text" as const, payload: { kind: "submittedText" as const, submittedText: "answer" } },
    { source: 'let result = askNumber "Number"', interactionKind: "number" as const, payload: { kind: "submittedText" as const, submittedText: "2.5" } },
    { source: 'let result = choose first: "One", second: "Two"', interactionKind: "choice" as const, payload: { kind: "selectedLabel" as const, selectedLabel: "second" } },
  ];

  for (const scenario of scenarios) {
    const plan = compiled(scenario.source);
    const pending = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(pending.snapshot.status, "waiting", scenario.source);
    assert.equal(validateRuntimeSnapshot(pending.snapshot, plan).valid, true, scenario.source);

    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
    );
    assert.deepEqual(restored.snapshot, pending.snapshot, scenario.source);

    const action = pending.snapshot.foregroundAction;
    assert.ok(action !== null && action.kind === "interaction", scenario.source);
    const request = {
      actionId: action.actionId,
      actionKind: "interaction" as const,
      interactionKind: scenario.interactionKind,
      payload: scenario.payload,
    };
    const uninterruptedCompletion = completeAction(plan, pending.snapshot, request);
    const restoredCompletion = completeAction(restored.plan, restored.snapshot, request);
    assert.equal(uninterruptedCompletion.outcome.kind, "completed", scenario.source);
    assert.deepEqual(restoredCompletion, uninterruptedCompletion, scenario.source);

    const uninterrupted = run(plan, uninterruptedCompletion.snapshot);
    const resumed = run(restored.plan, restoredCompletion.snapshot);
    assert.deepEqual(resumed.snapshot, uninterrupted.snapshot, scenario.source);
    assert.deepEqual(resumed.events, uninterrupted.events, scenario.source);
  }
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

test("interaction expressions resume through a direct function return", () => {
  const plan = compiled([
    "function prompt {",
    "return askText",
    "}",
    "let result = prompt()",
    "say result",
  ].join("\n"));
  const pending = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  const completed = completePending(
    plan,
    pending.snapshot,
    "text",
    { kind: "submittedText", submittedText: "returned" },
  );
  assert.equal(completed.outcome.kind, "completed");
  const done = run(plan, completed.snapshot);
  assert.equal(done.snapshot.status, "halted");
  assert.equal(done.events.find((event) => event.kind === "say")?.text, "returned");
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

test("dynamic settlement uses prepared UI provenance while available and intrinsic rules after cleanup", () => {
  const buttonPlan = compiled("showButton label", { globals: ["label"] });
  const buttonPending = run(buttonPlan, createFreshRuntimeSnapshot(buttonPlan, { globals: { label: "Continue" } }));
  const buttonCompleted = completePending(buttonPlan, buttonPending.snapshot, "button", { kind: "activate" });
  assert.equal(validateRuntimeSnapshot(buttonCompleted.snapshot, buttonPlan).valid, true);
  const wrongButton = structuredClone(buttonCompleted.snapshot) as any;
  wrongButton.lastSettlement.transcriptText = "Wrong";
  assert.equal(validateRuntimeSnapshot(wrongButton, buttonPlan).valid, false);
  const buttonAfterCleanup = run(buttonPlan, buttonCompleted.snapshot).snapshot;
  assert.equal(validateRuntimeSnapshot(buttonAfterCleanup, buttonPlan).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(serializeCheckpoint(createCheckpoint(buttonPlan, buttonAfterCleanup))));

  const choicePlan = compiled("let result = choose first, second", { globals: ["first", "second"] });
  const choicePending = run(choicePlan, createFreshRuntimeSnapshot(choicePlan, { globals: { first: "One", second: "Two" } }));
  const choiceCompleted = completePending(choicePlan, choicePending.snapshot, "choice", { kind: "selectedText", selectedText: "One" });
  const wrongChoice = structuredClone(choiceCompleted.snapshot) as any;
  wrongChoice.lastSettlement.result = "Two";
  wrongChoice.temporaries.find((temporary: any) => temporary.id === wrongChoice.lastSettlement.destinationTemporary).value = "Two";
  assert.equal(validateRuntimeSnapshot(wrongChoice, choicePlan).valid, false);
  const choiceAfterCleanup = run(choicePlan, choiceCompleted.snapshot).snapshot;
  assert.equal(validateRuntimeSnapshot(choiceAfterCleanup, choicePlan).valid, true);
  const labelledPlan = compiled("let result = choose first: firstText, second: secondText", { globals: ["firstText", "secondText"] });
  const labelledPending = run(labelledPlan, createFreshRuntimeSnapshot(labelledPlan, { globals: { firstText: "Alpha", secondText: "Beta" } }));
  const labelledCompleted = completePending(labelledPlan, labelledPending.snapshot, "choice", { kind: "selectedLabel", selectedLabel: "first" });
  const labelledAfterCleanup = run(labelledPlan, labelledCompleted.snapshot).snapshot;
  const differentPossibleHistory = structuredClone(labelledAfterCleanup) as any;
  differentPossibleHistory.lastSettlement.transcriptText = "Beta";
  assert.equal(validateRuntimeSnapshot(differentPossibleHistory, labelledPlan).valid, true);
  const mismatchedLabel = structuredClone(labelledAfterCleanup) as any;
  mismatchedLabel.lastSettlement.result = "third";
  assert.equal(validateRuntimeSnapshot(mismatchedLabel, labelledPlan).valid, false);
  const mismatchedLabelCheckpoint = structuredClone(createCheckpoint(labelledPlan, labelledAfterCleanup)) as any;
  mismatchedLabelCheckpoint.snapshot.lastSettlement.result = "third";
  assert.throws(() => deserializeCheckpoint(JSON.stringify(mismatchedLabelCheckpoint)));
});

test("static compact source delegates current interaction guards to plan validation instead of semantic source limits", () => {
  const oversizedButton = `showButton "${"x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1)}"`;
  const buttonResult = compileSource(oversizedButton);
  assert.deepEqual(buttonResult.semanticDiagnostics, []);
  assert.equal(buttonResult.plan, null);
  const buttonDiagnostic = buttonResult.diagnostics.find((diagnostic) => diagnostic.code === "TSC006");
  assert.deepEqual(buttonDiagnostic?.span, {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: oversizedButton.length, line: 0, column: oversizedButton.length },
  });
  assert.equal(buttonResult.diagnostics.some((diagnostic) => diagnostic.code === "TSV031"), false);

  const options = Array.from(
    { length: MAX_INTERACTION_OPTION_ENTRIES + 1 },
    (_, index) => `"option-${index}"`,
  ).join(", ");
  const choiceSource = `let result = choose ${options}`;
  const choiceResult = compileSource(choiceSource);
  assert.deepEqual(choiceResult.semanticDiagnostics, []);
  assert.equal(choiceResult.plan, null);
  const choiceDiagnostic = choiceResult.diagnostics.find((diagnostic) => diagnostic.code === "TSC006");
  const choiceStart = choiceSource.indexOf("choose");
  assert.deepEqual(choiceDiagnostic?.span, {
    start: { offset: choiceStart, line: 0, column: choiceStart },
    end: { offset: choiceSource.length, line: 0, column: choiceSource.length },
  });
  assert.equal(choiceResult.diagnostics.some((diagnostic) => diagnostic.code === "TSV031"), false);
});

test("compiled dynamic payloads delegate over-limit data to the existing runtime validation boundary", () => {
  const plan = compiled("showButton payload", { globals: ["payload"] });
  const oversized = "x".repeat(MAX_INTERACTION_STRING_UTF8_BYTES + 1);
  const result = run(plan, createFreshRuntimeSnapshot(plan, { globals: { payload: oversized } }));
  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.foregroundAction, null);
  assert.equal(result.snapshot.nextActionId, 1);
});

test("representative static and dynamic root/function choices complete through checkpoint restore", () => {
  const cases = [
    {
      name: "static-root",
      source: 'let result = choose first: "One", second: "Two", third: "Three"',
      payload: { kind: "selectedLabel" as const, selectedLabel: "second" },
    },
    {
      name: "static-function",
      source: [
        "function prompt {",
        'let result = choose first: "One", second: "Two", third: "Three"',
        "return result",
        "}",
        "let output = prompt()",
      ].join("\n"),
      payload: { kind: "selectedLabel" as const, selectedLabel: "second" },
    },
    {
      name: "dynamic-root",
      source: [
        'let prefix = "Option"',
        'let result = choose `${prefix} A`, `${prefix} B`, `${prefix} C`',
      ].join("\n"),
      payload: { kind: "selectedText" as const, selectedText: "Option B" },
    },
    {
      name: "dynamic-function",
      source: [
        "function prompt(prefix) {",
        'let result = choose `${prefix} A`, `${prefix} B`, `${prefix} C`',
        "return result",
        "}",
        'let output = prompt("Option")',
      ].join("\n"),
      payload: { kind: "selectedText" as const, selectedText: "Option B" },
    },
  ];

  for (const scenario of cases) {
    const plan = compiled(scenario.source);
    const pending = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(pending.snapshot.status, "waiting", `${scenario.name}: pending`);
    const action = pending.snapshot.foregroundAction;
    assert.ok(
      action !== null &&
        action.kind === "interaction" &&
        action.interactionKind === "choice" &&
        action.ui.kind === "choice",
      `${scenario.name}: pending choice`,
    );

    const checkpoint = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, pending.snapshot)),
    );
    const request = {
      actionId: action.actionId,
      actionKind: "interaction" as const,
      interactionKind: "choice" as const,
      payload: scenario.payload,
    };
    const completed = completeAction(checkpoint.plan, checkpoint.snapshot, request);
    assert.equal(completed.outcome.kind, "completed", `${scenario.name}: completion`);
    const handoff = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(plan, completed.snapshot)),
    );
    const uninterrupted = run(plan, completed.snapshot);
    const resumed = run(handoff.plan, handoff.snapshot);
    assert.deepEqual(resumed.events, uninterrupted.events, `${scenario.name}: events`);
    assert.deepEqual(resumed.snapshot, uninterrupted.snapshot, `${scenario.name}: snapshot`);
  }
});
