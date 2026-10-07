import assert from "node:assert/strict";
import test from "node:test";

import { compileProject } from "../src/compiler.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

/*
 * Messages that change in place (V30 §37 "Updatable messages", `docs/RUNTIME.md#message-handles`): a `say` used as a
 * value gives a `messageHandle`, whose `.text` reads and replaces the message's text.
 */

/** The messages the events show, in order of creation, each with its texts in order. */
function messageTexts(events: readonly InterpreterEvent[]): string[][] {
  const messages = new Map<number, string[]>();
  for (const event of events) {
    if (event.kind === "say") messages.set(event.sequence, [event.text]);
    else if (event.kind === "messageUpdated") messages.get(event.messageId)!.push(event.text);
  }
  return [...messages.values()];
}

function lines(...source: string[]): string {
  return source.join("\n");
}

test("a say's handle reads its markup source and replaces or appends its text in place, through every copy", () => {
  const compiled = plan(
    lines(
      'let line = say "*Waiting*.", instant',
      "let other = line",
      'line.text += "."',
      'other.text = "**Ready**"',
      'line.text = "**Ready**"',
      'line.text = ""',
      "say other.text, instant",
      'say "${line == other}", instant',
      "exit",
    ),
  );
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
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

test("each run of a say value shows its own message, and a handle shows as its identity", () => {
  const compiled = plan(
    lines(
      "let shown: messageHandle[] = []",
      "repeat 2 {",
      '    shown.add(say("Count", instant))',
      "}",
      'shown[1].text += ": 2"',
      "say shown[0], instant",
      "exit",
    ),
  );
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(result.snapshot.status, "halted");
  assert.deepEqual(messageTexts(result.events), [
    ["Count"],
    ["Count", "Count: 2"],
    [`<message ${result.events.find((event) => event.kind === "say")!.sequence}>`],
  ]);
});

test("a say value works wherever a value does, in source order, and one that does not run shows nothing", () => {
  const compiled = plan(
    lines(
      "function shown(first: messageHandle, second: messageHandle) {",
      '    first.text += " 1"',
      "    return second",
      "}",
      'let last = shown(say("A", instant), say bubble() ("B", instant))',
      'last.text += " 2"',
      'if false and say("Never", instant) == last {',
      "}",
      "function made: messageHandle {",
      '    return say "Returned", instant',
      "}",
      "let returned = made()",
      'returned.text = "Returned!"',
      "exit",
    ),
  );
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(result.snapshot.status, "halted");
  assert.deepEqual(messageTexts(result.events), [
    ["A", "A 1"],
    ["B", "B 2"],
    ["Returned", "Returned!"],
  ]);
});

test("the importer's growing dots and stroke counter play and resume alike at every boundary", () => {
  const dots = lines(
    'let waiting = say "Waiting.", instant',
    "repeat 2 {",
    "    wait 1 s",
    '    waiting.text += "."',
    "}",
    "exit",
  );
  const counter = lines(
    "let count: integer = 0",
    'let strokes = say "Strokes: 0", instant',
    "repeat 50 {",
    "    wait 1 s",
    "    count += 1",
    '    strokes.text = "Strokes: ${count}"',
    "}",
    "exit",
  );
  const played = assertRuntimeResumeEquivalent(dots, { scenarioName: "growing dots" });
  assert.deepEqual(messageTexts(played.events), [["Waiting.", "Waiting..", "Waiting..."]]);
  const counted = assertRuntimeResumeEquivalent(counter, { scenarioName: "stroke counter" });
  const [strokes] = messageTexts(counted.events);
  assert.equal(strokes?.length, 51);
  assert.equal(strokes?.at(-1), "Strokes: 50");
});

test("a method on a message's text keeps the text read before its arguments run, also across a wait", () => {
  // The method's receiver is prepared before the argument waits, so every boundary lies in between.
  assertRuntimeResumeEquivalent(
    lines(
      "function later {",
      "    wait 1 ms",
      '    return "B"',
      "}",
      'let line = say "A", instant',
      'say line.text.replace("A", later()), instant',
      "exit",
    ),
    { scenarioName: "prepared message text" },
  );
  // An argument that changes the text does not change the receiver read before it, as for a text variable.
  const compiled = plan(
    lines(
      "function later(message: messageHandle) {",
      '    message.text = "X"',
      '    return "B"',
      "}",
      'let line = say "A", instant',
      'say line.text.replace("A", later(line)), instant',
      "exit",
    ),
  );
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(messageTexts(result.events), [["A", "X"], ["B"]]);
});

test("an append reads the text before its value waits, so a change made meanwhile is replaced", () => {
  const compiled = plan(
    lines(
      'let line = say "Ready", instant',
      'let tick = timer(duration: 1 s, async: true, display: "hidden") {',
      '    line.text = "Changed by the timer"',
      "}",
      'line.text += askText "Add what?"',
      "exit",
    ),
  );
  const asking = run(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  const changed = run(compiled, observeTime(compiled, asking.snapshot, 1_000).snapshot);
  const action = changed.snapshot.foregroundAction;
  assert.ok(action?.kind === "interaction");
  const answered = completeAction(compiled, changed.snapshot, {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: action.interactionKind,
    payload: { kind: "submittedText", submittedText: "!" },
  });
  const finished = run(compiled, answered.snapshot);
  assert.deepEqual(
    messageTexts([...asking.events, ...changed.events, ...answered.events, ...finished.events])[0],
    ["Ready", "Changed by the timer", "Ready!"],
  );
});

test("a text write starts, ends, and moves no pacing, also while the message's own pacing runs", () => {
  const compiled = plan(
    lines('let line = say "Waiting", 2', 'line.text = "Ready"', 'say "Next", 1', "exit"),
  );
  const shown = run(compiled, createFreshRuntimeSnapshot(compiled));
  // The next message still waits for the first one's two seconds.
  assert.equal(shown.snapshot.status, "waiting");
  assert.deepEqual(messageTexts(shown.events), [["Waiting", "Ready"]]);
  const gate = shown.snapshot.foregroundAction;
  assert.ok(gate?.kind === "chatPacingGate");
  assert.equal(gate.deadlineMs, 2_000);
});

test("a say staged behind pacing gives its handle only once its message is shown", () => {
  const compiled = plan(
    lines('say "First", 1', 'let line = say "Second", 2', 'line.text += "!"', "exit"),
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(waiting.snapshot.status, "waiting");
  assert.deepEqual(messageTexts(waiting.events), [["First"]]);
  // The prepared output keeps the source of its text; no message is live and no handle exists yet.
  assert.equal(waiting.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.deepEqual(waiting.snapshot.liveMessages, []);
  const json = serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot));
  assert.match(json, /"sourceText":"Second"/);

  const released = run(compiled, observeTime(compiled, waiting.snapshot, 1_000).snapshot);
  const restored = deserializeCheckpoint(json);
  const resumed = run(restored.plan, observeTime(restored.plan, restored.snapshot, 1_000).snapshot);
  assert.deepEqual(resumed.events, released.events);
  assert.deepEqual(resumed.snapshot, released.snapshot);
  assert.deepEqual(messageTexts(released.events), [["Second", "Second!"]]);
});

test("an instant say that supersedes earlier pacing gives its handle at once", () => {
  const compiled = plan(
    lines('say "First", 1', 'let line = say "Now", instant', 'line.text += "!"', "exit"),
  );
  const result = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(messageTexts(result.events), [["First"], ["Now", "Now!"]]);
});

test("message handles resume equivalently at every boundary, through waits, a timer block, and pacing", () => {
  for (const pacing of ["instant", "1"]) {
    assertRuntimeResumeEquivalent(
      lines(
        "let count = 0",
        `let dots = say("Waiting.", ${pacing})`,
        `let strokes = say "Strokes: 0", ${pacing}`,
        'let tick = timer(duration: 1 s, async: true, display: "hidden", repeat: true) {',
        "    count += 1",
        '    strokes.text = "Strokes: ${count}"',
        "}",
        "repeat 2 {",
        "    wait 1 s",
        '    dots.text += "."',
        "}",
        "wait 1500 ms",
        "tick.stop()",
        'dots.text = "Done after ${randomInteger(1..=6)}"',
        "say strokes.text",
        "exit",
      ),
      { scenarioName: `message handles, pacing ${pacing}` },
    );
  }
});

test("a public operation drops the messages no handle reaches, and keeps those a value still holds", () => {
  const compiled = plan(
    lines(
      "let kept = []",
      "function show {",
      '    let shown = say "Local", instant',
      "}",
      "function keep {",
      '    kept.add({ line: say("Kept", instant) })',
      "}",
      "show()",
      "keep()",
      'let gone = [say("Removed", instant)]',
      "gone.removeFirst()",
      'let captured = [say("Captured", instant)]',
      'let tick = timer(duration: 1 s, async: true, display: "hidden") {',
      '    captured[0].text = "Changed"',
      "}",
      "captured.removeFirst()",
      "exit",
    ),
  );
  const ending = runUntilExit(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  const ids = new Map(
    ending.events.flatMap((event) => (event.kind === "say" ? [[event.text, event.sequence]] : [])),
  );
  // Removing the only handle from the list the timer's block shares with the file leaves nothing to reach it.
  assert.deepEqual(ending.snapshot.liveMessages, [
    { messageId: ids.get("Kept")!, sourceText: "Kept" },
  ]);
  assert.equal(validateRuntimeSnapshot(ending.snapshot, compiled).valid, true);
});

test("a handle that a timer block shares keeps its message while the block can still run", () => {
  const compiled = plan(
    lines(
      "function start {",
      '    let line = say "Waiting", instant',
      '    timer(duration: 1 s, async: true, display: "hidden") {',
      '        line.text += "!"',
      "    }",
      "}",
      "start()",
      "wait 2 s",
      "exit",
    ),
  );
  const waiting = run(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  assert.equal(waiting.snapshot.status, "waiting");
  assert.equal(waiting.snapshot.liveMessages.length, 1);
  const fired = run(compiled, observeTime(compiled, waiting.snapshot, 1_000).snapshot);
  assert.deepEqual(messageTexts([...waiting.events, ...fired.events]), [["Waiting", "Waiting!"]]);
  // Once the block has run, nothing reaches the message.
  assert.deepEqual(fired.snapshot.liveMessages, []);
});

test("a write the compiler cannot check fails at runtime before it changes the message", () => {
  // Parameters without a type leave the receiver and value to the runtime.
  for (const [write, code] of [
    ["setText(line, 5)", "TSR050"],
    ['setColor(line, "red")', "TSR003"],
    ["say colorOf(line)", "TSR017"],
  ] as const) {
    const compiled = plan(
      lines(
        "function setText(message, text) {",
        "    message.text = text",
        "}",
        "function setColor(message, color) {",
        "    message.color = color",
        "}",
        "function colorOf(message) {",
        "    return message.color",
        "}",
        'let line = say "Kept", instant',
        write,
        "exit",
      ),
    );
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
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
  const compiled = plan(
    lines('say "Before", instant', 'let line = say "Waiting", instant', "wait 1 s", "exit"),
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(validateRuntimeSnapshot(waiting, compiled).valid, true);
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
      validateRuntimeSnapshot(changed(waiting, change).snapshot, compiled).valid,
      false,
      name,
    );
  }
  // A record no handle reaches is harmless; the next operation drops it.
  const extra: RuntimeSnapshot = { ...waiting, liveMessages: [earlier, record] };
  assert.equal(validateRuntimeSnapshot(extra, compiled).valid, true);
  assert.deepEqual(observeTime(compiled, extra, 0).snapshot.liveMessages, [record]);
});

test("restore checks the source a staged say value keeps against its prepared text", () => {
  const compiled = plan(lines('say "First", 1', 'let line = say "**Second**", 2', "exit"));
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  const gate = waiting.foregroundAction;
  assert.ok(gate?.kind === "chatPacingGate" && gate.preparedOutput !== null);
  assert.equal(gate.preparedOutput.sourceText, "**Second**");
  const withoutSource = changed(
    waiting,
    (data) => delete data.foregroundAction.preparedOutput.sourceText,
  );
  assert.equal(validateRuntimeSnapshot(withoutSource.snapshot, compiled).valid, false);
  // The source must be the one the prepared content was parsed from.
  const otherSource = changed(
    waiting,
    (data) => (data.foregroundAction.preparedOutput.sourceText = "Second"),
  );
  assert.equal(validateRuntimeSnapshot(otherSource.snapshot, compiled).valid, false);
  assert.equal(validateRuntimeSnapshot(changed(waiting, () => {}).snapshot, compiled).valid, true);
});

test("handles go with globals and callers across files, and a file's own handles end with it", () => {
  const files = [
    {
      path: "main.tease",
      source: lines(
        "global kept: messageHandle[] = []",
        'let local = say "Local", instant',
        'kept.add(say("Global", instant))',
        'call "other.tease"',
        'local.text += "!"',
        'goto "last.tease"',
      ),
    },
    {
      path: "other.tease",
      source: lines('kept[0].text += "+"', 'let mine = say "Other", instant', "end"),
    },
    { path: "last.tease", source: lines('kept[0].text += "#"', "wait 1 s", "exit") },
  ];
  const compiled = compileProject(files);
  assert.deepEqual(compiled.diagnostics, []);
  const waiting = run(compiled.plan!, createImmediatePacingRuntimeSnapshot(compiled.plan!));
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
  assertRuntimeResumeEquivalent(files, { scenarioName: "message handles across files" });
});
