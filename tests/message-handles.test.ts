import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../src/compiler.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { MESSAGE_TEXT_FUNCTIONS, messageSayPlan, withMessageSays } from "./helpers/message-says.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

/*
 * Message handles (`docs/RUNTIME.md#message-handles`) through trusted plans: a placeholder
 * `timer(duration: 1 ms, async: true, label: …)` stands for a `say` whose result is a message handle, and `.text` is
 * read and written through functions whose parameters the compiler leaves to the runtime.
 */

function source(...lines: string[]): string {
  return [MESSAGE_TEXT_FUNCTIONS, ...lines].join("\n");
}

const say = (text: string) => `timer(duration: 1 ms, async: true, label: ${JSON.stringify(text)})`;

/** The messages the events show, in order of creation, each with its texts in order. */
function messageTexts(events: readonly InterpreterEvent[]): string[][] {
  const messages = new Map<number, string[]>();
  for (const event of events) {
    if (event.kind === "say") messages.set(event.sequence, [event.text]);
    else if (event.kind === "messageUpdated") messages.get(event.messageId)!.push(event.text);
  }
  return [...messages.values()];
}

test("a say's handle reads its markup source and replaces or appends its text in place, through every copy", () => {
  const plan = messageSayPlan(
    source(
      `let line = ${say("*Waiting*.")}`,
      "let other = line",
      'appendText(line, ".")',
      'setText(other, "**Ready**")',
      'setText(line, "**Ready**")',
      'setText(line, "")',
      "say textOf(other), instant",
      'say "${line == other}", instant',
      "exit",
    ),
  );
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(result.snapshot.status, "halted");
  const [shown, ...updates] = result.events.filter(
    (event) => event.kind === "say" || event.kind === "messageUpdated",
  );
  assert.equal(shown?.kind, "say");
  // An unchanged text is no update; the empty text keeps the message.
  assert.deepEqual(
    updates.map((event) => [
      event.kind,
      event.kind === "messageUpdated" && event.messageId,
      event.text,
    ]),
    [
      ["messageUpdated", shown!.sequence, "Waiting.."],
      ["messageUpdated", shown!.sequence, "Ready"],
      ["messageUpdated", shown!.sequence, ""],
      ["say", false, ""],
      ["say", false, "true"],
    ],
  );
  const appended = updates[0]!;
  assert.ok(appended.kind === "messageUpdated");
  // The appended source is parsed whole, so the emphasis of the original text stays.
  assert.equal(appended.content.blocks[0]?.kind, "paragraph");
  assert.deepEqual(appended.content, {
    kind: "messageMarkup",
    visibleText: "Waiting..",
    blocks: [
      {
        kind: "paragraph",
        lines: [
          {
            text: "Waiting..",
            spans: [{ kind: "italic", start: 0, end: 7, depth: 0 }],
            ending: "",
          },
        ],
      },
    ],
  });
});

test("each run of a result-bearing say shows its own message, and a handle shows as its identity", () => {
  const plan = messageSayPlan(
    source(
      "let lines = []",
      "repeat 2 {",
      `    lines.add(${say("Count")})`,
      "}",
      'appendText(lines[1], ": 2")',
      "say lines[0], instant",
      "exit",
    ),
  );
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(result.snapshot.status, "halted");
  assert.deepEqual(messageTexts(result.events), [
    ["Count"],
    ["Count", "Count: 2"],
    [`<message ${result.events.find((event) => event.kind === "say")!.sequence}>`],
  ]);
});

test("a method on a message's text keeps the text read before its arguments run, also across a wait", () => {
  // The method's receiver is prepared before the argument waits, so every boundary lies in between.
  assertRuntimeResumeEquivalent(
    source(
      "function later {",
      "    wait 1 ms",
      '    return "B"',
      "}",
      "function rewrite(message) {",
      '    return message.text.replace("A", later())',
      "}",
      `let line = ${say("A")}`,
      "say rewrite(line), instant",
      "exit",
    ),
    { scenarioName: "prepared message text", transformPlan: withMessageSays },
  );
  // An argument that changes the text does not change the receiver read before it, as for a text variable.
  const plan = messageSayPlan(
    source(
      "function later(message) {",
      '    setText(message, "X")',
      '    return "B"',
      "}",
      "function rewrite(message) {",
      '    return message.text.replace("A", later(message))',
      "}",
      `let line = ${say("A")}`,
      "say rewrite(line), instant",
      "exit",
    ),
  );
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  assert.deepEqual(messageTexts(result.events), [["A", "X"], ["B"]]);
});

test("a text write starts, ends, and moves no pacing, also while the message's own pacing runs", () => {
  const plan = messageSayPlan(
    source(`let line = ${say("Waiting")}`, 'setText(line, "Ready")', 'say "Next", 1', "exit"),
    2,
  );
  const shown = run(plan, createFreshRuntimeSnapshot(plan));
  // The next message still waits for the first one's two seconds.
  assert.equal(shown.snapshot.status, "waiting");
  assert.deepEqual(messageTexts(shown.events), [["Waiting", "Ready"]]);
  const gate = shown.snapshot.foregroundAction;
  assert.ok(gate?.kind === "chatPacingGate");
  assert.equal(gate.deadlineMs, 2_000);
});

test("a say staged behind pacing gives its handle only once its message is shown", () => {
  const plan = messageSayPlan(
    source('say "First", 1', `let line = ${say("Second")}`, 'appendText(line, "!")', "exit"),
    2,
  );
  const waiting = run(plan, createFreshRuntimeSnapshot(plan));
  assert.equal(waiting.snapshot.status, "waiting");
  assert.deepEqual(messageTexts(waiting.events), [["First"]]);
  // The prepared output keeps the source of its text; no message is live and no handle exists yet.
  assert.equal(waiting.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.deepEqual(waiting.snapshot.liveMessages, []);
  const json = serializeCheckpoint(createCheckpoint(plan, waiting.snapshot));
  assert.match(json, /"sourceText":"Second"/);

  const released = run(plan, observeTime(plan, waiting.snapshot, 1_000).snapshot);
  const restored = deserializeCheckpoint(json);
  const resumed = run(restored.plan, observeTime(restored.plan, restored.snapshot, 1_000).snapshot);
  assert.deepEqual(resumed.events, released.events);
  assert.deepEqual(resumed.snapshot, released.snapshot);
  assert.deepEqual(messageTexts(released.events), [["Second", "Second!"]]);
});

test("an instant say that supersedes earlier pacing gives its handle at once", () => {
  const plan = messageSayPlan(
    source('say "First", 1', `let line = ${say("Now")}`, 'appendText(line, "!")', "exit"),
  );
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  assert.deepEqual(messageTexts(result.events), [["First"], ["Now", "Now!"]]);
});

test("message handles resume equivalently at every boundary, through waits and a timer block", () => {
  for (const pacing of ["instant", 1] as const) {
    assertRuntimeResumeEquivalent(
      source(
        "let count = 0",
        `let dots = ${say("Waiting.")}`,
        `let strokes = ${say("Strokes: 0")}`,
        'let tick = timer(duration: 1 s, async: true, display: "hidden", repeat: true) {',
        "    count += 1",
        '    setText(strokes, "Strokes: ${count}")',
        "}",
        "repeat 2 {",
        "    wait 1 s",
        '    appendText(dots, ".")',
        "}",
        "wait 1500 ms",
        "tick.stop()",
        'setText(dots, "Done after ${randomInteger(1..=6)}")',
        "say textOf(strokes)",
        "exit",
      ),
      {
        scenarioName: `message handles, pacing ${pacing}`,
        transformPlan: (compiled) => withMessageSays(compiled, pacing),
      },
    );
  }
});

test("a public operation drops the messages no handle reaches, and keeps those a value still holds", () => {
  const plan = messageSayPlan(
    source(
      "let kept = []",
      "function show(text) {",
      `    let shown = ${say("Local")}`,
      "    return null",
      "}",
      "function keep {",
      `    kept.add({ line: ${say("Kept")} })`,
      "}",
      "show(1)",
      "keep()",
      `let gone = [${say("Removed")}]`,
      "gone.removeFirst()",
      `let captured = [${say("Captured")}]`,
      'let tick = timer(duration: 1 s, async: true, display: "hidden") {',
      '    setText(captured[0], "Changed")',
      "}",
      "captured.removeFirst()",
      "exit",
    ),
  );
  const ending = runUntilExit(plan, createImmediatePacingRuntimeSnapshot(plan));
  const ids = new Map(
    ending.events.flatMap((event) => (event.kind === "say" ? [[event.text, event.sequence]] : [])),
  );
  // Removing the only handle from the list the timer's block shares with the file leaves nothing to reach it.
  assert.deepEqual(ending.snapshot.liveMessages, [
    { messageId: ids.get("Kept")!, sourceText: "Kept" },
  ]);
  assert.equal(validateRuntimeSnapshot(ending.snapshot, plan).valid, true);
});

test("a handle that a timer block shares keeps its message while the block can still run", () => {
  const plan = messageSayPlan(
    source(
      "function start {",
      `    let line = ${say("Waiting")}`,
      '    timer(duration: 1 s, async: true, display: "hidden") {',
      '        appendText(line, "!")',
      "    }",
      "}",
      "start()",
      "wait 2 s",
      "exit",
    ),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(waiting.snapshot.status, "waiting");
  assert.equal(waiting.snapshot.liveMessages.length, 1);
  const fired = run(plan, observeTime(plan, waiting.snapshot, 1_000).snapshot);
  assert.deepEqual(messageTexts([...waiting.events, ...fired.events]), [["Waiting", "Waiting!"]]);
  // Once the block has run, nothing reaches the message.
  assert.deepEqual(fired.snapshot.liveMessages, []);
});

test("a write that is not text, or to another property, fails before it changes the message", () => {
  for (const [write, code] of [
    ["setText(line, 5)", "TSR050"],
    ['setColor(line, "red")', "TSR003"],
    ["say colorOf(line)", "TSR017"],
  ] as const) {
    const plan = messageSayPlan(
      source(
        "function setColor(message, color) {",
        "    message.color = color",
        "}",
        "function colorOf(message) {",
        "    return message.color",
        "}",
        `let line = ${say("Kept")}`,
        write,
        "exit",
      ),
    );
    const result = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(result.snapshot.status, "failed", write);
    assert.equal(result.snapshot.failure?.code, code, write);
    assert.deepEqual(messageTexts(result.events), [["Kept"]], write);
    assert.deepEqual(
      result.snapshot.liveMessages.map((message) => message.sourceText),
      ["Kept"],
      write,
    );
  }
});

/** The plain data of `snapshot`, as a checkpoint carries it, after `change`. */
function changed(
  snapshot: RuntimeSnapshot,
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: the changes give fields wrong types and shapes that RuntimeSnapshot intentionally cannot express.
  change: (data: any) => void,
): { readonly snapshot: unknown } {
  // EVIDENCE: JSON round trip of a runtime-produced snapshot gives plain data that the callback then corrupts.
  const data = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  change(data);
  return { snapshot: data };
}

test("restore rejects live messages that are malformed, out of order, or missing for a handle", () => {
  const plan = messageSayPlan(
    source('say "Before", instant', `let line = ${say("Waiting")}`, "wait 1 s", "exit"),
  );
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  assert.equal(validateRuntimeSnapshot(waiting, plan).valid, true);
  const [record] = waiting.liveMessages;
  assert.ok(record !== undefined);
  const earlier = { messageId: record.messageId - 1, sourceText: "Old" };
  const variants: [string, (data: { liveMessages: unknown[] }) => void][] = [
    ["missing record", (data) => (data.liveMessages = [])],
    ["duplicate", (data) => (data.liveMessages = [record, record])],
    ["unsorted", (data) => (data.liveMessages = [record, earlier])],
    ["future ID", (data) => (data.liveMessages = [record, { messageId: 1_000, sourceText: "x" }])],
    ["not text", (data) => (data.liveMessages = [{ ...record, sourceText: 1 }])],
    ["extra field", (data) => (data.liveMessages = [{ ...record, text: "Waiting" }])],
  ];
  for (const [name, change] of variants) {
    assert.equal(
      validateRuntimeSnapshot(changed(waiting, change).snapshot, plan).valid,
      false,
      name,
    );
  }
  // A record no handle reaches is harmless; the next operation drops it.
  const extra: RuntimeSnapshot = { ...waiting, liveMessages: [earlier, record] };
  assert.equal(validateRuntimeSnapshot(extra, plan).valid, true);
  assert.deepEqual(observeTime(plan, extra, 0).snapshot.liveMessages, [record]);
});

test("restore checks the source a staged result-bearing say keeps against its prepared text", () => {
  const plan = messageSayPlan(
    source('say "First", 1', `let line = ${say("**Second**")}`, "exit"),
    2,
  );
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const gate = waiting.foregroundAction;
  assert.ok(gate?.kind === "chatPacingGate" && gate.preparedOutput !== null);
  assert.equal(gate.preparedOutput.sourceText, "**Second**");
  const withoutSource = changed(
    waiting,
    (data) => delete data.foregroundAction.preparedOutput.sourceText,
  );
  assert.equal(validateRuntimeSnapshot(withoutSource.snapshot, plan).valid, false);
  // The source must be the one the prepared content was parsed from.
  const otherSource = changed(
    waiting,
    (data) => (data.foregroundAction.preparedOutput.sourceText = "Second"),
  );
  assert.equal(validateRuntimeSnapshot(otherSource.snapshot, plan).valid, false);
  assert.equal(validateRuntimeSnapshot(changed(waiting, () => {}).snapshot, plan).valid, true);
});

test("handles go with globals and callers across files, and a file's own handles end with it", () => {
  const files = [
    {
      path: "main.tease",
      source: [
        "global kept = []",
        "global function appendText(message, text) {",
        "    message.text += text",
        "}",
        `let local = ${say("Local")}`,
        `kept.add(${say("Global")})`,
        'call "other.tease"',
        'appendText(local, "!")',
        'goto "last.tease"',
      ].join("\n"),
    },
    {
      path: "other.tease",
      source: ['appendText(kept[0], "+")', `let mine = ${say("Other")}`, "end"].join("\n"),
    },
    { path: "last.tease", source: ['appendText(kept[0], "#")', "wait 1 s", "exit"].join("\n") },
  ];
  const compiled = compileProject(files);
  assert.deepEqual(compiled.diagnostics, []);
  const plan = withMessageSays(compiled.plan!);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(waiting.snapshot.status, "waiting");
  assert.deepEqual(messageTexts(waiting.events), [
    ["Local", "Local!"],
    ["Global", "Global+", "Global+#"],
    ["Other"],
  ]);
  // Only the global list still reaches a message once main's activation and the call have ended.
  assert.deepEqual(
    waiting.snapshot.liveMessages.map((message) => message.sourceText),
    ["Global+#"],
  );
  assertRuntimeResumeEquivalent(
    files.map((file) => ({ path: file.path, source: file.source })),
    { scenarioName: "message handles across files", transformPlan: withMessageSays },
  );
});
