import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSession,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  isMessageMarkup,
  parseMessageMarkup,
  run,
  serializeCheckpoint,
  stepToEvent,
  type InstructionPlan,
  type InterpreterEvent,
} from "../src/index.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

test("runs escapeMarkup through the protected Platform Standard Library prelude", () => {
  const compiled = compileSource(
    [
      'let dynamic = "**Mistress**"',
      'say "**Warning:** ${escapeMarkup(dynamic)}, no touching.", instant',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const result = run(compiled.plan!, createFreshRuntimeSnapshot(compiled.plan!));
  const output = result.events.find((event) => event.kind === "say");
  assert.equal(output?.kind, "say");
  if (output?.kind !== "say") throw new Error("Expected authored say output.");
  assert.equal(output.text, "Warning: **Mistress**, no touching.");
  assert.equal(output.content.visibleText, output.text);
  assert.deepEqual(
    output.content.blocks[0]?.kind === "paragraph" ? output.content.blocks[0].lines[0]?.spans : [],
    [{ kind: "bold", start: 0, end: 8, depth: 0 }],
  );

  const protectedName = compileSource('let escapeMarkup = "shadow"');
  assert.ok(protectedName.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV001"));
  assert.deepEqual(
    compileSource("say escapeMarkup(1), instant\nexit").diagnostics.map(
      (diagnostic) => diagnostic.code,
    ),
    ["TSV043"],
  );
  // `dynamic` hides the argument's type from the compiler, so the runtime check rejects it with the compiler's code.
  for (const [argument, message] of [
    [
      "1",
      "escapeMarkup(...) takes text (string), not a whole number (integer). Convert it with toString(...) first.",
    ],
    [
      "[1]",
      "escapeMarkup(...) takes text (string), not a list. Use .join() to combine its elements as text.",
    ],
    // `.join()` cannot join a list of lists.
    ["[[1]]", "escapeMarkup(...) takes text (string), not a list."],
    ["null", "escapeMarkup(...) takes text (string), not null."],
  ] as const) {
    const source = `function dynamic(value) { return value }\nsay escapeMarkup(dynamic(${argument})), instant\nexit`;
    const wrongType = compileValidPlan(source);
    const failure = run(wrongType, createFreshRuntimeSnapshot(wrongType)).snapshot.failure;
    const call = source.indexOf("escapeMarkup(");
    assert.deepEqual(
      [failure?.code, failure?.message, failure?.span.start.offset],
      ["TSV043", message, call],
      argument,
    );
  }
});

test("a parsed authored message shows once the reading time before it ends, also after a restore", () => {
  const compiled = compileValidPlan('say "first"\nsay "[u]**second**[/u]"\nexit');
  const reading = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = reading.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  if (gate?.kind !== "chatPacingGate") throw new Error("Expected a reading time.");
  assert.deepEqual(
    reading.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["first"],
  );

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, reading.snapshot)),
  );
  assert.deepEqual(restored.snapshot.foregroundAction, gate);
  const released = completeAction(restored.plan, restored.snapshot, {
    actionId: gate.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, released.snapshot);
  const output = resumed.events.find((event) => event.kind === "say");
  assert.equal(output?.kind, "say");
  if (output?.kind !== "say") throw new Error("Expected resumed say output.");
  assert.equal(output.text, "second");
  assert.equal(output.content.visibleText, "second");
  assert.deepEqual(
    output.content.blocks[0]?.kind === "paragraph"
      ? output.content.blocks[0].lines[0]?.spans.map((span) => span.kind)
      : [],
    ["underline", "bold"],
  );

  const pacingPlan = compileValidPlan('say "[color=#ff3344]x[/color]"\nexit');
  // The gate counts the visible text only.
  const paced = stepToEvent(pacingPlan, createFreshRuntimeSnapshot(pacingPlan));
  assert.equal(paced.events[0]?.kind, "say");
  assert.equal(paced.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(paced.snapshot.foregroundAction?.deadlineMs, 1_800);
});

test("a block-string fragment shown before a restored reading time is not evaluated or selected again", () => {
  const compiled = compileValidPlan(
    [
      "let evaluations = 0",
      "function fragment {",
      "  evaluations = evaluations + 1",
      '  return ["**Alpha**", "**Beta**"]',
      "}",
      'say "first", instant',
      'say """',
      "  # Selected",
      "  ${fragment()}",
      '"""',
      'say "evaluations=${evaluations}", instant',
      "exit",
    ].join("\n"),
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 0x2468_ace1 }));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  if (gate?.kind !== "chatPacingGate") throw new Error("Expected the block string's reading time.");
  const shown = waiting.events.filter((event) => event.kind === "say");
  assert.equal(shown.length, 2);
  const block = shown[1]!;
  assert.match(block.text, /^Selected\n(?:Alpha|Beta)$/u);
  assert.deepEqual(
    block.content.blocks.map((part) => part.kind),
    ["heading", "paragraph"],
  );
  assert.deepEqual(
    block.content.blocks[1]?.kind === "paragraph"
      ? block.content.blocks[1].lines[0]?.spans.map((span) => span.kind)
      : [],
    ["bold"],
  );
  const shownRngState = waiting.snapshot.rng.state;

  const uninterruptedRelease = completeAction(compiled, waiting.snapshot, {
    actionId: gate.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const uninterrupted = run(compiled, uninterruptedRelease.snapshot);

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)),
  );
  const restoredRelease = completeAction(restored.plan, restored.snapshot, {
    actionId: gate.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, restoredRelease.snapshot);

  assert.deepEqual(
    [...restoredRelease.events, ...resumed.events],
    [...uninterruptedRelease.events, ...uninterrupted.events],
  );
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
  assert.deepEqual(
    resumed.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["evaluations=1"],
  );
  assert.equal(resumed.snapshot.rng.state, shownRngState);
});

test("preserves message markup through every instruction checkpoint boundary", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'let literal = "**dynamic**"',
      'say "# Heading\\nReusable **format** and ${escapeMarkup(literal)}"',
      "exit",
    ].join("\n"),
    { scenarioName: "message markup checkpoint equivalence" },
  );
  const output = result.events.find((event) => event.kind === "say");
  assert.equal(output?.kind, "say");
  if (output?.kind === "say") {
    assert.equal(output.text, "Heading\nReusable format and **dynamic**");
    assert.equal(isMessageMarkup(output.content), true);
  }
});

test("a repeated say shows each text's own markup and parses an unchanged text once", () => {
  // One say shows these in turn: a repeat, changed text, empty, escaped and malformed markup, an earlier text again.
  const texts = [
    "**bold** start",
    "**bold** start",
    "plain words",
    "",
    "\\*escaped\\* stays",
    "[u]unclosed **mark",
    "**bold** start",
    "# Head\n- item",
  ];
  const source = `speaker vera {
    displayName: "Vera"
}
speaker anna {
    displayName: "Anna"
}
let texts = ${JSON.stringify(texts)}
let colors = ["white", "red", "white", "red", "white", "red", "white", "red"]
let paces = [0 s, 1 s, 0 s, 2 s, 0 s, 0 s, 1 s, 0 s]
let lines = []
let step = 0
for text in texts {
    if step % 2 == 0 {
        speaker vera
    } else {
        speaker anna
    }
    let line = say bubble(color: colors[step]) text, paces[step]
    lines.add(line)
    step += 1
}
lines[2].text = "changed *now*"
exit
`;
  const play = (plan: InstructionPlan) => {
    const session = createFreshRuntimeSession(plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    });
    const events: InterpreterEvent[] = [];
    for (;;) {
      events.push(...session.run().events);
      const gate = session.view().foregroundAction;
      if (gate?.kind !== "chatPacingGate") break;
      events.push(...session.observeTime(gate.deadlineMs).events);
    }
    assert.equal(session.view().status, "halted");
    return { events, snapshot: session.exportSnapshot() };
  };
  const plan = compileValidPlan(source);
  const first = play(plan);
  const says = first.events.flatMap((event) => (event.kind === "say" ? [event] : []));
  assert.deepEqual(
    says.map((event) => event.content),
    texts.map((text) => parseMessageMarkup(text)),
  );
  for (const event of says) assert.equal(event.text, event.content.visibleText);
  // Speaker, presentation, reading time, and the message handle still come from every say.
  assert.deepEqual(
    says.map((event) => [event.speaker?.identifier, event.presentation]),
    says.map((_, index) => [index % 2 === 0 ? "vera" : "anna", says[index % 2]!.presentation]),
  );
  assert.notDeepEqual(says[0]!.presentation, says[1]!.presentation);
  assert.equal(
    first.events.filter(
      (event) => event.kind === "actionRequested" && event.action.kind === "chatPacingGate",
    ).length,
    3,
  );
  assert.deepEqual(
    first.events.flatMap((event) => (event.kind === "messageUpdated" ? [event.content] : [])),
    [parseMessageMarkup("changed *now*")],
  );
  assert.deepEqual(
    first.snapshot.liveMessages.map((message) => [message.messageId, message.sourceText]),
    says.map((event, index) => [event.sequence, index === 2 ? "changed *now*" : texts[index]]),
  );
  // Scoped oracle for the parse cache: the repeated text is parsed once.
  assert.equal(says[1]!.content, says[0]!.content);
  // Another session of the same plan reuses the parses, and a newly compiled plan parses afresh, with the same result.
  for (const again of [play(plan), play(compileValidPlan(source))]) {
    assert.deepEqual(again.events, first.events);
    assert.deepEqual(again.snapshot, first.snapshot);
  }
});
