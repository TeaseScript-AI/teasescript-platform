import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource, type ProjectSourceFile } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  pressPermanentButton,
  type PermanentButtonPressOutcome,
} from "../src/runtime/operations/press-permanent-button.js";
import { permanentButtonProjection } from "../src/runtime/permanent-buttons.js";
import { validateRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import {
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimePermanentButtons,
  pressPlayerRuntimePermanentButton,
} from "../player/runtime-adapter.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { runValidSourceUntilExit } from "./helpers/run-until-exit.js";
import { assertRuntimeResumeEquivalent, functionFrames } from "./helpers/runtime-equivalence.js";

/** Drives a session with clicks, answers, and time, round-tripping every snapshot through checkpoint JSON. */
class Session {
  readonly plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[] = [];

  constructor(source: string | readonly ProjectSourceFile[]) {
    if (typeof source === "string") this.plan = compileValidPlan(source);
    else {
      const compiled = compileProject(source);
      assert.deepEqual(compiled.diagnostics, []);
      this.plan = compiled.plan!;
    }
    this.snapshot = createImmediatePacingRuntimeSnapshot(this.plan);
    this.run();
  }

  run(): this {
    this.#restore();
    const result = run(this.plan, this.snapshot);
    this.events.push(...result.events);
    this.snapshot = result.snapshot;
    this.#restore();
    return this;
  }

  at(nowMs: number): this {
    const observed = observeTime(this.plan, this.snapshot, nowMs);
    assert.equal(observed.outcome.kind, "observed");
    this.events.push(...observed.events);
    this.snapshot = observed.snapshot;
    return this.run();
  }

  /** Clicks a button without running the session; a click that is not accepted must change nothing. */
  press(buttonId: unknown): PermanentButtonPressOutcome["kind"] {
    const result = pressPermanentButton(this.plan, this.snapshot, buttonId);
    if (result.outcome.kind !== "pressed") assert.deepEqual(result.snapshot, this.snapshot);
    this.events.push(...result.events);
    this.snapshot = result.snapshot;
    return result.outcome.kind;
  }

  click(buttonId: number): this {
    assert.equal(this.press(buttonId), "pressed");
    return this.run();
  }

  answer(text: string, actionId = this.snapshot.foregroundAction?.actionId): string {
    assert.ok(actionId !== undefined);
    const result = completeAction(this.plan, this.snapshot, {
      actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: text },
    });
    this.events.push(...result.events);
    this.snapshot = result.snapshot;
    if (result.outcome.kind === "completed") this.run();
    return result.outcome.kind;
  }

  said(): string[] {
    return this.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  }

  /** The shown buttons as `text` or `text (busy)`, in creation order. */
  buttons(): string[] {
    return permanentButtonProjection(this.snapshot).map(
      (button) => `${button.text}${button.busy ? " (busy)" : ""}`,
    );
  }

  #restore(): void {
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(this.plan, this.snapshot)),
    );
    assert.deepEqual(restored.snapshot, this.snapshot, "checkpoint JSON must round-trip exactly");
    this.snapshot = restored.snapshot;
  }
}

/** The button IDs of `removed` settlements, in order. */
function removed(events: readonly InterpreterEvent[]): number[] {
  return events.flatMap((event) =>
    event.kind === "actionCompleted" && event.settlement.actionKind === "permanentButton"
      ? [event.settlement.buttonId]
      : [],
  );
}

function errorCodes(source: string): string[] {
  return compileSource(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.code);
}

test("clicks run their button's block while the script waits, also from a checkpoint at every boundary", () => {
  // Clicks 1 and 2 have the same text; click 2 queues while block 1 waits. Stop's goto leaves the file entry, which
  // removes every button but the persistent Pause; exit removes that too.
  const source = [
    "let count = 0",
    'showPermanentButton "Add one" {',
    "    count += 1",
    '    say "one: ${count}"',
    "    wait 1",
    "}",
    'showPermanentButton "Add one" {',
    "    count += 10",
    '    say "ten: ${count}"',
    "}",
    'showPermanentButton "Stop" {',
    "    goto stopped",
    "}",
    'showPermanentButton "Pause", persist: true {',
    '    say "paused"',
    "    wait 2",
    '    say "resumed"',
    "}",
    'say "waiting"',
    "wait 30",
    'say "never stopped"',
    "exit",
    "label stopped",
    'say "stopped at ${count}"',
    "wait 5",
    'say "done"',
    "exit",
  ].join("\n");
  const clicks = [1, 2, 4, 3, 4];
  const result = assertRuntimeResumeEquivalent(source, {
    press: (snapshot, events) => {
      const index = events.filter((event) => event.kind === "permanentButtonPressed").length;
      const button = permanentButtonProjection(snapshot).find(
        (shown) => shown.buttonId === clicks[index],
      );
      // The second click comes while the first block waits; the others once no block is queued or running.
      const idle =
        snapshot.pendingTimerHandlers.length === 0 &&
        functionFrames(snapshot).every((frame) => frame.timerInterruption === null);
      return button !== undefined && !button.busy && (idle || index === 1) ? button.buttonId : null;
    },
  });
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    [
      "waiting",
      "one: 1",
      "ten: 11",
      "paused",
      "resumed",
      "stopped at 11",
      "paused",
      "resumed",
      "done",
    ],
  );
  assert.deepEqual(
    result.events.flatMap((event) =>
      event.kind === "permanentButtonPressed" ? [`${event.buttonId} ${event.text}`] : [],
    ),
    ["1 Add one", "2 Add one", "4 Pause", "3 Stop", "4 Pause"],
  );
  const shown = result.boundaries.map((snapshot) =>
    permanentButtonProjection(snapshot)
      .map((button) => button.buttonId)
      .join(","),
  );
  assert.ok(shown.includes("1,2,3,4") && shown.includes("4"));
  assert.deepEqual(permanentButtonProjection(result.finalSnapshot), []);
});

test("a click interrupts a question, which returns with its identity, or a goto block abandons it", () => {
  const session = new Session(
    [
      'showPermanentButton "Hint" {',
      '    say "hint"',
      "}",
      'showPermanentButton "Skip" {',
      "    goto skipped",
      "}",
      'let name = askText "Name?"',
      'say "hello ${name}"',
      "exit",
      "label skipped",
      'say "skipped"',
      "exit",
    ].join("\n"),
  );
  const question = session.snapshot.foregroundAction;
  assert.equal(question?.kind, "interaction");
  session.click(1);
  assert.deepEqual(session.said(), ["hint"]);
  assert.deepEqual(session.snapshot.foregroundAction, question);
  assert.deepEqual(
    session.events.filter(
      (event) => event.kind === "actionRequested" && event.action.kind === "interaction",
    ).length,
    1,
    "the question is not asked again",
  );
  assert.deepEqual(session.buttons(), ["Hint", "Skip"]);
  session.click(2);
  assert.deepEqual(session.said(), ["hint", "skipped"]);
  assert.equal(session.snapshot.status, "halted");
  assert.equal(session.answer("Bo", question!.actionId), "staleAction");
  assert.deepEqual(session.buttons(), []);
});

test("a busy, removed, unknown, early, or malformed click changes nothing", () => {
  const session = new Session(
    [
      'let busy = showPermanentButton "Busy" {',
      '    say "busy"',
      "    wait 1",
      "}",
      'let gone = showPermanentButton "Gone" {',
      "}",
      "removePermanentButton(gone)",
      'timer async 2 { say "timer" }',
      "wait 10",
      "exit",
    ].join("\n"),
  );
  assert.equal(session.press(1), "pressed");
  assert.deepEqual(session.buttons(), ["Busy (busy)"]);
  assert.equal(session.press(1), "busy", "its click is queued");
  session.run();
  assert.equal(session.press(1), "busy", "its block runs");
  assert.equal(session.press(2), "removedButton");
  assert.equal(session.press(3), "unknownButton");
  for (const malformed of [0, -1, 1.5, "1", null])
    assert.equal(session.press(malformed), "invalidPayload");
  session.at(1000);
  assert.deepEqual(session.buttons(), ["Busy"], "the button is active again once its block ends");
  // The timer's block is due and runs before any later click.
  const observed = observeTime(session.plan, session.snapshot, 2000);
  session.snapshot = observed.snapshot;
  session.events.push(...observed.events);
  assert.equal(session.press(1), "executionPending");
  session.run();
  assert.deepEqual(session.said(), ["busy", "timer"]);
  // A running script, before it waits, takes no click either.
  const running = runValidSourceUntilExit('showPermanentButton "Later" {\n}\nexit');
  const early = pressPermanentButton(
    compileValidPlan('showPermanentButton "Later" {\n}\nexit'),
    running.snapshot,
    1,
  );
  assert.equal(early.outcome.kind, "executionPending");
});

test("removePermanentButton removes a button and its queued click, but not a block that runs", () => {
  const session = new Session(
    [
      'let a = showPermanentButton "A" {',
      '    say "a"',
      "}",
      'let b = showPermanentButton "B" {',
      "    removePermanentButton(b)",
      '    say "b runs on"',
      "    say b",
      "    removePermanentButton(b)",
      "}",
      'showPermanentButton "Remove A" {',
      "    wait 1",
      "    removePermanentButton(a)",
      "}",
      "say a",
      "wait 10",
      "exit",
    ].join("\n"),
  );
  // A's click waits behind the running Remove A block, which removes A and drops the click.
  session.click(3);
  assert.equal(session.press(1), "pressed");
  session.run().at(1000);
  assert.deepEqual(session.buttons(), ["B", "Remove A"]);
  session.click(2);
  assert.deepEqual(session.said(), [
    '<permanent button "A">',
    "b runs on",
    "<permanent button, removed>",
  ]);
  assert.deepEqual(session.buttons(), ["Remove A"]);
  assert.deepEqual(removed(session.events), [1, 2], "each removal settles its button once");
  assert.equal(session.snapshot.status, "waiting");
});

test("a button belongs to the file entry that showed it unless it persists, and exit removes every button", () => {
  const session = new Session([
    {
      path: "main.tease",
      source: [
        "function offerHelp {",
        '    showPermanentButton "Help" {',
        '        say "help"',
        "    }",
        "}",
        "offerHelp()",
        'let kept = showPermanentButton "Kept",',
        "    persist: true {",
        '    say "kept"',
        "}",
        'showPermanentButton "Dropped", persist: false {',
        '    say "dropped"',
        "}",
        'call "room.tease"',
        "wait 1",
        'goto "hall.tease"',
      ].join("\n"),
    },
    { path: "room.tease", source: 'showPermanentButton "Room" {\n    say "room"\n}\nwait 1\nend' },
    { path: "hall.tease", source: 'showPermanentButton "Quit" {\n    exit\n}\nwait 10\nexit' },
  ]);
  // A function's button belongs to its caller's entry, and a call keeps the caller's buttons.
  assert.deepEqual(session.buttons(), ["Help", "Kept", "Dropped", "Room"]);
  session.click(1).click(4);
  assert.deepEqual(session.said(), ["help", "room"]);
  // The end of the called file removes its own button.
  session.at(1000);
  assert.deepEqual(session.buttons(), ["Help", "Kept", "Dropped"]);
  // A goto leaves main's entry; only the persistent button stays, and `persist: false` is the default.
  session.at(2000);
  assert.deepEqual(session.buttons(), ["Kept", "Quit"]);
  session.click(2);
  assert.deepEqual(session.said(), ["help", "room", "kept"]);
  // An exit in a block ends the session and removes every button.
  session.click(5);
  assert.equal(session.snapshot.status, "halted");
  assert.deepEqual(session.buttons(), []);
  // Leaving an entry settles its buttons; exit only clears the session.
  assert.deepEqual(removed(session.events), [4, 1, 3]);
});

test("permanent buttons need a block, shown text, and their own identifier", () => {
  assert.deepEqual(errorCodes('showPermanentButton "Stop"\nexit'), ["TSP018"]);
  assert.deepEqual(errorCodes('showPermanentButton("Stop") {\n}\nexit'), ["TSP035"]);
  assert.deepEqual(errorCodes('showPermanentButton ["a", "b"] {\n}\nexit'), ["TSV040"]);
  assert.deepEqual(errorCodes('showPermanentButton "Stop" {\n    return 1\n}\nexit'), ["TSV033"]);
  const button = 'let stop = showPermanentButton "Stop" {\n}\n';
  assert.deepEqual(errorCodes(`${button}say "\${stop}"\nexit`), ["TSV042"]);
  assert.deepEqual(errorCodes(`${button}save stop as "button"\nexit`), ["TSV043"]);
  assert.deepEqual(errorCodes(`${button}say stop.text\nexit`), ["TSV043"]);
  assert.deepEqual(errorCodes('removePermanentButton("Stop")\nexit'), ["TSV043"]);
  assert.deepEqual(errorCodes(`${button}removePermanentButton(stop, stop)\nexit`), ["TSV020"]);
});

test("persist is a literal option of the command, and the block line it replaces names the fix", () => {
  /** Each error as `code line:column message`; the trailing errors show that parsing recovered after the option. */
  const errors = (source: string): string[] =>
    compileSource(source)
      .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .map(
        (diagnostic) =>
          `${diagnostic.code} ${diagnostic.span.start.line}:${diagnostic.span.start.column} ${diagnostic.message}`,
      );
  const after = "    let = 1\n}\nlet = 2\nexit";
  const recovered = (line: number) => [
    `TSP013 ${line}:8 Expected a variable identifier after 'let'.`,
    `TSP013 ${line + 2}:4 Expected a variable identifier after 'let'.`,
  ];
  assert.deepEqual(errors(`showPermanentButton "Pause \${1 + 2}" {\n    persist: true\n${after}`), [
    "TSP035 1:4 Write 'persist:' on the command instead of in the block: 'showPermanentButton \"Pause ${1 + 2}\", persist: true {'.",
    ...recovered(2),
  ]);
  const cases: [option: string, error: string][] = [
    [
      "persist: yes",
      "TSP035 0:37 showPermanentButton option 'persist' must be the literal true or false.",
    ],
    [
      "persist: true, persist: false",
      "TSP035 0:43 Duplicate showPermanentButton option 'persist'.",
    ],
    [
      "color: true",
      "TSP035 0:28 Unknown showPermanentButton option 'color'; the only option is 'persist'.",
    ],
    ["persist:", "TSP012 0:37 Expected true or false after 'persist:'."],
  ];
  for (const [option, error] of cases) {
    assert.deepEqual(errors(`showPermanentButton "Stop", ${option} {\n${after}`), [
      error,
      ...recovered(1),
    ]);
  }
  // A missing value also leaves a block on the next line to the button.
  assert.deepEqual(errors(`showPermanentButton "Stop", persist:\n{\n${after}`), [
    "TSP012 1:0 Expected true or false after 'persist:'.",
    ...recovered(2),
  ]);

  // Text that would take the option as its own, such as a compact choice, is grouped in the replacement, which keeps
  // the two choice options and makes the button persist.
  const [replacement] = compileSource(
    'showPermanentButton choose "A", "B" {\n    persist: true\n    say "clicked"\n}\nexit',
  ).diagnostics.map(
    (diagnostic) => /'(showPermanentButton .*) \{'\.$/u.exec(diagnostic.message)?.[1],
  );
  assert.equal(replacement, 'showPermanentButton (choose "A", "B"), persist: true');
  const [statement] = parse(`${replacement} {\n    say "clicked"\n}\nexit`).program.statements;
  assert.ok(statement?.kind === "showPermanentButtonStatement");
  assert.equal(statement.persist, true);
  assert.ok(statement.text.kind === "parenthesizedExpression");
  assert.ok(statement.text.expression.kind === "interactionExpression");
  assert.equal(statement.text.expression.options.length, 2);
});

test("a parameter default shows its button only when the argument is left out", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'let other = showPermanentButton "Other" {',
      "}",
      'function make(button = showPermanentButton "Made" {',
      '    say "made"',
      "}) {",
      "    return button",
      "}",
      "let first = make()",
      "let second = make(other)",
      "say first",
      "say second",
      "wait 1",
      "exit",
    ].join("\n"),
    {
      press: (_snapshot, events) =>
        events.some((event) => event.kind === "permanentButtonPressed") ? null : 2,
    },
  );
  assert.deepEqual(
    result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ['<permanent button "Made">', '<permanent button "Other">', "made"],
  );
});

test("a block a parameter default shows may change variables when the script waits", () => {
  const source = [
    "let value: number | string = 1",
    'function make(button = showPermanentButton "Text" { value = "text" }) {',
    "    return button",
    "}",
    "let made = make()",
    "if value is number {",
    "    wait 1",
    '    say "${value + 1}"',
    "}",
    "exit",
  ].join("\n");
  assert.deepEqual(errorCodes(source), ["TSV043"]);
});

test("a button label may be quoted inside interpolation", () => {
  const plan = compileValidPlan('say "count ${[showPermanentButton "Hint" {}].length}"\nexit');
  const said = run(plan, createImmediatePacingRuntimeSnapshot(plan)).events.flatMap((event) =>
    event.kind === "say" ? [event.text] : [],
  );
  assert.deepEqual(said, ["count 1"]);
});

test("deeply nested button text is checked without exhausting the native stack", () => {
  const depth = 2_000;
  const source = `let b = ${"showPermanentButton (".repeat(depth)}"x"${") {\n}".repeat(depth)}\nexit`;
  // Every label but the innermost is a button, which cannot be shown; the checks report that instead of failing.
  assert.deepEqual([...new Set(errorCodes(source))], ["TSV042"]);
});

test("mixing permanent buttons with other values suggests no unwritable type", () => {
  const button = 'let b = showPermanentButton "x" {\n}\n';
  for (const source of [
    `${button}let values = [b, 1]\nexit`,
    `${button}let answer = choose { value: b, text: "B" }, { value: 1, text: "One" }\nexit`,
  ]) {
    const mixes = compileSource(source)
      .diagnostics.filter((diagnostic) => diagnostic.code === "TSV044")
      .map((diagnostic) => diagnostic.message);
    assert.equal(mixes.length, 1, source);
    assert.match(mixes[0]!, /keep permanent buttons apart/u, source);
  }
});

test("restore rejects button state the runtime cannot produce", () => {
  const session = new Session(
    'let a = showPermanentButton "A" {\n    wait 1\n}\nshowPermanentButton "B" {\n}\nwait 10\nexit',
  );
  session.press(2);
  assert.deepEqual(validateRuntimeSnapshot(session.snapshot, session.plan).errors, []);
  const broken = (change: (snapshot: Mutable<RuntimeSnapshot>) => void): readonly string[] => {
    // EVIDENCE: structuredClone preserves the runtime snapshot shape while each fixture breaks one field.
    const snapshot = structuredClone(session.snapshot) as Mutable<RuntimeSnapshot>;
    change(snapshot);
    return validateRuntimeSnapshot(snapshot, session.plan).errors;
  };
  const button = (snapshot: Mutable<RuntimeSnapshot>, index: number) => {
    const action = snapshot.backgroundActions[index];
    assert.equal(action?.kind, "permanentButton");
    return action.button;
  };
  for (const change of [
    (snapshot: Mutable<RuntimeSnapshot>) => snapshot.backgroundActions.reverse(),
    (snapshot: Mutable<RuntimeSnapshot>) => {
      button(snapshot, 0).buttonId = 2;
      button(snapshot, 1).buttonId = 1;
    },
    (snapshot: Mutable<RuntimeSnapshot>) => (button(snapshot, 0).persist = true),
    (snapshot: Mutable<RuntimeSnapshot>) => (button(snapshot, 0).handlerFunctionId = 2),
    (snapshot: Mutable<RuntimeSnapshot>) => (snapshot.nextPermanentButtonId = 2),
    (snapshot: Mutable<RuntimeSnapshot>) => snapshot.backgroundActions.pop(),
    (snapshot: Mutable<RuntimeSnapshot>) => (snapshot.pendingTimerHandlers[0]!.count = 2),
    (snapshot: Mutable<RuntimeSnapshot>) =>
      snapshot.pendingTimerHandlers.push({ ...snapshot.pendingTimerHandlers[0]! }),
    (snapshot: Mutable<RuntimeSnapshot>) =>
      (snapshot.frames[0]!.bindings[0]!.value = { kind: "permanentButtonHandle", buttonId: 9 }),
  ])
    assert.notDeepEqual(broken(change), []);
});

test("the Player shows a session's buttons, inactive while their block runs, and none once it ends", () => {
  let session = createPlayerRuntimeSession(
    'showPermanentButton "Count" {\n    wait 1\n}\nshowPermanentButton "Quit" {\n    exit\n}\nwait 10\nexit',
  );
  assert.deepEqual(playerRuntimePermanentButtons(session.snapshot), [
    { buttonId: 1, label: "Count", busy: false },
    { buttonId: 2, label: "Quit", busy: false },
  ]);
  const counted = pressPlayerRuntimePermanentButton(session, 1);
  assert.equal(counted.outcome.kind, "pressed");
  session = counted.session;
  // The press also ran the session, which started the block.
  assert.equal(functionFrames(session.snapshot).length, 1);
  assert.equal(playerRuntimePermanentButtons(session.snapshot)[0]!.busy, true);
  assert.equal(pressPlayerRuntimePermanentButton(session, 1).outcome.kind, "busy");
  session = pressPlayerRuntimePermanentButton(session, 2).session;
  assert.equal(session.snapshot.status, "waiting", "the Quit click waits behind the running block");
  assert.equal(pressPlayerRuntimePermanentButton(session, 2).outcome.kind, "busy");
  session = observePlayerRuntimeTime(session, 1000).session;
  assert.equal(session.snapshot.status, "halted");
  assert.deepEqual(playerRuntimePermanentButtons(session.snapshot), []);
});

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
    ? Array<Mutable<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;
