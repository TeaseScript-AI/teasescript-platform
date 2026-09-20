import assert from "node:assert/strict";
import test from "node:test";
import { isMessagePresentation } from "../src/message-presentation.js";
import { compileSource } from "../src/compiler.js";
import { normalizeColor, isNormalizedColor } from "../src/color.js";
import { run } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
import {
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { parseMessageMarkup } from "../src/message-markup.js";

test("accepts concrete CSS colour notations and preserves out-of-gamut coordinates", () => {
  for (const color of [
    "red",
    "#f00",
    "#ff0000",
    "rgb(255,0,0)",
    "rgb(255 0 0)",
    "hsl(0 100% 50%)",
    "hwb(0 0% 0%)",
  ])
    assert.equal(normalizeColor(color), normalizeColor("red"), color);
  for (const color of ["lab(50% 20 30)", "lch(50% 40 30)", "oklab(50% .1 .1)", "oklch(.5 .1 30)"])
    assert.ok(isNormalizedColor(normalizeColor(color)), color);
  assert.equal(normalizeColor("oklch(.5 .8 20)"), "oklch(0.5 0.8 20)");
  const smallChroma = normalizeColor("oklch(.5 1e-14 20)");
  assert.equal(smallChroma, "oklch(0.5 1e-14 20)");
  assert.equal(isNormalizedColor(smallChroma), true);
  for (const color of [
    "oops",
    "currentColor",
    "var(--color)",
    "color(srgb-linear 1 0 0)",
    "red;display:none",
    "url(x)",
    "rgb(1 2)",
    "#12345",
  ])
    assert.equal(normalizeColor(color), null, color);
});

test("inherits speaker presentation, overrides one message and keeps prose backgrounds separate", () => {
  const result = assertRuntimeResumeEquivalent(
    `
speaker vera {
  displayName: "Vera"
  presentation: "prose"
  color: "red"
  font: "Georgia"
  bubble: { background: "blue", position: "right" }
  prose: { align: "left" }
}
speaker vera
say "inherited"
say bubble(color: "white", font: "serif") "override"
say "inherited again"
vera.prose = { background: "ivory", align: "right" }
say prose(background: "linen") "background override"
say "paper"
`,
    { scenarioName: "speaker and message presentation inheritance" },
  );
  const messages = result.events.filter((event) => event.kind === "say");
  assert.deepEqual(messages[0]!.presentation, {
    kind: "prose",
    position: null,
    align: "left",
    font: "Georgia",
    color: normalizeColor("red"),
    background: null,
  });
  assert.equal(messages[1]!.presentation.kind, "bubble");
  assert.equal(messages[1]!.presentation.position, "right");
  assert.equal(messages[1]!.presentation.background, normalizeColor("blue"));
  assert.equal(messages[1]!.presentation.color, normalizeColor("white"));
  assert.equal(messages[1]!.presentation.font, "serif");
  assert.deepEqual(messages[2]!.presentation, messages[0]!.presentation);
  assert.equal(messages[3]!.presentation.background, normalizeColor("linen"));
  assert.equal(messages[4]!.presentation.background, normalizeColor("ivory"));
});

test("evaluates option functions in source order exactly once across instruction checkpoints", () => {
  const result = assertRuntimeResumeEquivalent(
    `
let calls = ""
function option(value) {
  calls = "\${calls}\${value}"
  return value
}
say prose(color: option("red"), align: option("left")) option("text"), 0
say calls, instant
`,
    { scenarioName: "presentation expression source order" },
  );
  const messages = result.events.filter((event) => event.kind === "say");
  assert.equal(messages[0]!.presentation.color, normalizeColor("red"));
  assert.equal(messages[1]!.text, "redlefttext");
});

test("keeps contextual identifiers usable as ordinary say values", () => {
  const plan = compileValidPlan(
    'let prose = "prose value"\nlet bubble = "bubble value"\nsay prose, instant\nsay bubble, instant',
  );
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["prose value", "bubble value"],
  );
});

test("rejects invalid constant colours and presentation options at compile time", () => {
  for (const source of [
    'say prose(color: "not-a-color") "x"',
    'speaker vera { color: "not-a-color" }',
    'speaker vera { prose: { background: "not-a-color" } }',
    'say "[color=not-a-color]x[/color]"',
    'say prose(align: "diagonal") "x"',
    'say prose(align: "left", align: "right") "x"',
    'say prose(unknown: "x") "x"',
  ]) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.ok(result.diagnostics.length > 0, source);
  }
  assert.notEqual(compileSource('say "`[color=invalid]literal[/color]`"').plan, null);
});

test("invalid computed colours use inherited or theme defaults without failing the story", () => {
  const plan = compileValidPlan(`
let invalid = "not a colour"
speaker vera { displayName: "Vera"
  color: "red"
  bubble: { background: "blue" }
}
speaker vera
say bubble(color: invalid, background: invalid) "first", instant
vera.color = 123
vera.bubble = { background: invalid }
say "second", instant
say "[color=\${invalid}]third[/color]", instant
`);
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(result.snapshot.status, "halted");
  const messages = result.events.filter((event) => event.kind === "say");
  assert.equal(messages[0]!.presentation.color, normalizeColor("red"));
  assert.equal(messages[0]!.presentation.background, normalizeColor("blue"));
  assert.equal(messages[1]!.presentation.color, null);
  assert.equal(messages[1]!.presentation.background, null);
  assert.equal(messages[2]!.text, "third");
});

test("captures presentation in paced output and validates restored presentation data", () => {
  const plan = compileValidPlan(
    'say "first"\nsay prose(background: "ivory", align: "left") "letter"',
  );
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  const gate = result.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  if (gate?.kind !== "chatPacingGate" || gate.preparedOutput === null)
    throw new Error("Missing prepared output.");
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, result.snapshot)),
  );
  const released = completeAction(restored.plan, restored.snapshot, {
    actionKind: "chatPacingGate",
    actionId: gate.actionId,
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, released.snapshot);
  assert.deepEqual(
    resumed.events.find((event) => event.kind === "say")?.presentation,
    gate.preparedOutput.presentation,
  );
  const malformed = JSON.parse(serializeCheckpoint(createCheckpoint(plan, result.snapshot)));
  malformed.snapshot.foregroundAction.preparedOutput.presentation.align = "diagonal";
  assert.equal(validateRuntimeSnapshot(malformed.snapshot, plan).valid, false);
});

test("removed spoiler tags are ordinary visible text", () => {
  const content = parseMessageMarkup("[spoiler]**visible**[/spoiler]");
  assert.equal(content.visibleText, "[spoiler]visible[/spoiler]");
});

test("a user-provided colour survives an input checkpoint and invalid input uses the default", () => {
  const plan = compileValidPlan(
    'say prose(color: askText "Colour") "The story continues.", instant',
  );
  const waiting = run(plan, createFreshRuntimeSnapshot(plan));
  const action = waiting.snapshot.foregroundAction;
  if (action?.kind !== "interaction") throw new Error("Expected colour input.");
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, waiting.snapshot)),
  );
  for (const text of ["red", "not a colour"]) {
    const completed = completeAction(restored.plan, restored.snapshot, {
      actionKind: "interaction",
      interactionKind: "text",
      actionId: action.actionId,
      payload: { kind: "submittedText", submittedText: text },
    });
    const result = run(restored.plan, completed.snapshot);
    assert.equal(result.snapshot.status, "halted");
    const output = result.events.find((event) => event.kind === "say");
    assert.equal(output?.text, "The story continues.");
    assert.equal(output?.presentation.color, normalizeColor(text));
  }
});

test("null options inherit, and malformed external resolved values are rejected", () => {
  const plan = compileValidPlan('say prose(color: null, align: null) "x", instant');
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  const output = result.events.find((event) => event.kind === "say");
  assert.equal(output?.presentation.color, null);
  assert.equal(output?.presentation.align, null);
  assert.equal(output?.presentation.position, null);
  assert.equal(isMessagePresentation(output?.presentation), true);
  assert.equal(isMessagePresentation({ ...output?.presentation, align: ["center"] }), false);
  assert.equal(isMessagePresentation({ ...output?.presentation, background: "url(x)" }), false);
});

test("parenthesized null presentation options retain ordinary inheritance semantics", () => {
  const result = assertRuntimeResumeEquivalent(
    `
speaker vera {
  presentation: (null)
  color: ((null))
  bubble: ({ color: "red", position: "right", align: "left" })
}
speaker vera
say bubble(color: ((null)), background: (null), position: (null), align: ((null)), font: (null)) "inherited"
`,
    { scenarioName: "parenthesized null presentation inheritance" },
  );
  assert.deepEqual(result.events.find((event) => event.kind === "say")?.presentation, {
    kind: "bubble",
    color: normalizeColor("red"),
    background: null,
    position: "right",
    align: "left",
    font: null,
  });
  assert.equal(compileSource('say prose(color: ("null")) "invalid"').plan, null);
  assert.equal(compileSource('speaker vera { bubble: ({ color: "invalid" }) }').plan, null);
});

test("CSS colour channel clamping and grammar agree for static and dynamic source", () => {
  const equivalent = [
    ["rgb(300 -20 0)", "red"],
    ["rgba(120%, -10%, 0%, 200%)", "red"],
    ["hsl(0 200% 50%)", "red"],
    ["hsl(0 100 50)", "red"],
    ["hwb(0 -20 0)", "red"],
    ["rgb(100% 0 0)", "red"],
    ["HSL(0TURN 100% 50%)", "red"],
    ["lab(150% 200% -200%)", "lab(100 250 -250)"],
    ["oklab(-10% .1 -.1)", "oklab(0 .1 -.1)"],
    ["lch(50% -10 30)", "lch(50 0 30)"],
    ["oklch(50% -.1 30)", "oklch(.5 0 30)"],
    ["hwb(400 -10% 200%)", "black"],
  ];
  for (const [input, expected] of equivalent) {
    const plan = compileValidPlan(`let dynamic = "${input}"
say prose(color: "${input}") "static", instant
say prose(color: dynamic) "dynamic", instant`);
    const result = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(result.snapshot.status, "halted");
    for (const event of result.events) {
      if (event.kind === "say")
        assert.equal(event.presentation.color, normalizeColor(expected), input);
    }
  }
  for (const input of [
    "rgb(1 2 3 .5)",
    "rgb(1,2,3 / .5)",
    "rgb(100%,0,0)",
    "hsl(0,100,50)",
    "hwb(0,0%,0%)",
    "lab(50%,0,0)",
    "rgb(1;2;3)",
    "rgb(1 2 3 / .5 / .2)",
    "rgb(1deg 2 3)",
    "oklch(.5 .1 20 .5)",
  ]) {
    assert.equal(normalizeColor(input), null, input);
    assert.equal(compileSource(`say prose(color: "${input}") "invalid"`).plan, null, input);
  }
});

test("colours convert once across literals, variables, speaker updates and checkpoints", () => {
  for (const input of ["white", "lab(100 250 -250)"]) {
    const result = assertRuntimeResumeEquivalent(
      `
speaker vera { color: "${input}" }
say as vera "declaration"
let dynamic = "${input}"
say prose(color: "${input}") "literal"
say prose(color: dynamic) "variable"
vera.color = dynamic
say as vera "updated speaker"
say "[color=${input}]markup[/color]"
`,
      { scenarioName: `single colour conversion: ${input}` },
    );
    const messages = result.events.filter((event) => event.kind === "say");
    const expected = normalizeColor(input);
    for (const message of messages.slice(0, 4)) assert.equal(message.presentation.color, expected);
    assert.equal(messages[0]!.speaker?.color, expected);
    assert.equal(messages[3]!.speaker?.color, expected);
    const block = messages[4]!.content.blocks[0];
    if (block?.kind !== "paragraph") throw new Error("Expected paragraph.");
    const span = block.lines[0]!.spans[0];
    if (span?.kind !== "color") throw new Error("Expected colour span.");
    assert.equal(span.value, expected);
  }
});

test("an authored colour that shows what is behind it is no colour at all", () => {
  for (const color of ["rgb(255 0 0 / .5)", "#ff000080", "oklch(.5 .1 30 / .2)", "transparent"]) {
    assert.equal(normalizeColor(color), null, color);
    assert.equal(isNormalizedColor(color), false, color);
  }
  // Full opacity written out is simply the colour, whichever notation carries it.
  for (const color of ["rgb(255 0 0 / 1)", "#ff0000ff", "rgba(255,0,0,100%)"])
    assert.equal(normalizeColor(color), normalizeColor("red"), color);
  for (const source of [
    'say bubble(color: "rgb(255 0 0 / .5)") "x"',
    'say bubble(background: "rgb(255 0 0 / .5)") "x"',
    'speaker vera { color: "#ff000080" }',
    'speaker vera { bubble: { background: "#ff000080" } }',
    'speaker vera { prose: { color: "transparent" } }',
  ]) {
    const result = compileSource(source);
    assert.equal(result.plan, null, source);
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === "TSC008"),
      source,
    );
  }
  assert.equal(
    isMessagePresentation({
      kind: "bubble",
      position: null,
      align: null,
      font: null,
      color: "oklch(0.5 0.1 30 / 0.5)",
      background: null,
    }),
    false,
  );
});

test("prose without a background leaves the panel to the Player", () => {
  const plan = compileValidPlan(`
let faded = "rgb(255 0 0 / .5)"
speaker vera {
  displayName: "Vera"
  color: "blue"
}
speaker vera
say prose "letter", instant
say bubble(color: faded, background: faded) "second", instant
say "[color=\${faded}]third[/color]", instant
`);
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  const messages = result.events.filter((event) => event.kind === "say");
  // Nothing was chosen, so nothing is reported; the Player decides what that looks like.
  assert.equal(messages[0]!.presentation.kind, "prose");
  assert.equal(messages[0]!.presentation.background, null);
  // A colour computed as see-through is unusable, and falls back like any other.
  assert.equal(messages[1]!.presentation.color, normalizeColor("blue"));
  assert.equal(messages[1]!.presentation.background, null);
  const block = messages[2]!.content.blocks[0];
  if (block?.kind !== "paragraph") throw new Error("Expected paragraph.");
  assert.deepEqual(
    block.lines[0]!.spans.map((span) => [span.kind, "value" in span ? span.value : null]),
    [["color", "inherit"]],
  );
  assert.equal(messages[2]!.text, "third");
});
