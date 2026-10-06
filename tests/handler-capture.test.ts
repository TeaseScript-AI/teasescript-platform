import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource } from "../src/compiler.js";
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
import { pressPermanentButton } from "../src/runtime/operations/press-permanent-button.js";
import { permanentButtonProjection } from "../src/runtime/permanent-buttons.js";
import { validateRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent, functionFrames } from "./helpers/runtime-equivalence.js";

/*
 * Timer, media, and button blocks share the function, loop, and block variables of the code that creates them (V30
 * §14): one variable, kept in checkpointed scopes while a resource or block still uses it.
 */

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

/**
 * A simulated Player that clicks `ids` in order, each once no block is queued or running and `ready` holds; it lets
 * time pass otherwise.
 */
function clicking(
  ids: readonly number[],
  ready: (snapshot: RuntimeSnapshot) => boolean = () => true,
): (snapshot: RuntimeSnapshot, events: readonly InterpreterEvent[]) => number | null {
  return (snapshot, events) => {
    const index = events.filter((event) => event.kind === "permanentButtonPressed").length;
    const id = ids[index];
    const button = permanentButtonProjection(snapshot).find((shown) => shown.buttonId === id);
    const idle =
      snapshot.pendingTimerHandlers.length === 0 &&
      functionFrames(snapshot).every((frame) => frame.timerInterruption === null);
    return id !== undefined && button !== undefined && !button.busy && idle && ready(snapshot)
      ? id
      : null;
  };
}

/** Block, loop, and function scopes retained because blocks share their variables. */
function sharedScopes(snapshot: RuntimeSnapshot): string[][] {
  return snapshot.retainedScopes
    .filter((scope) => scope.file === null)
    .map((scope) => scope.bindings.map((binding) => binding.name));
}

test("a block assigns the function's own variable, so Stop ends the loop after its running wait", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "function challenge {",
      "    let stop = false",
      "    let rounds = 0",
      '    showPermanentButton "Stop" {',
      "        stop = true",
      "    }",
      "    while not stop {",
      "        rounds += 1",
      "        wait 5 s",
      "    }",
      '    say "stopped after ${rounds} rounds"',
      "}",
      "challenge()",
      "exit",
    ].join("\n"),
    // Clicked during the second wait, which still runs to its end.
    { press: clicking([1], (snapshot) => snapshot.currentSessionTimeMs >= 5_000) },
  );
  assert.deepEqual(said(result.events), ["stopped after 2 rounds"]);
  assert.equal(result.finalSnapshot.currentSessionTimeMs, 10_000);
});

test("each call, iteration, and loop-body let has its own variable; one declared outside a loop is shared", () => {
  const offers = assertRuntimeResumeEquivalent(
    [
      "function offer(title: string, n: integer) {",
      "    showPermanentButton title {",
      "        n += 1",
      '        say "${title} ${n}"',
      "    }",
      "}",
      'offer("A", 1)',
      'offer("B", 10)',
      "wait 10 s",
      "exit",
    ].join("\n"),
    { press: clicking([1, 1, 2, 1]) },
  );
  // Both calls returned before the first click; their counters live on.
  assert.deepEqual(said(offers.events), ["A 2", "A 3", "B 11", "A 4"]);

  const loops = assertRuntimeResumeEquivalent(
    [
      "function show(names: string[]) {",
      "    let clicks = 0",
      "    for name in names {",
      "        showPermanentButton name {",
      "            clicks += 1",
      '            say "${name} ${clicks}"',
      "        }",
      "    }",
      "    let turn = 0",
      "    while turn < 2 {",
      "        turn += 1",
      "        let mine = turn * 10",
      '        showPermanentButton "Round ${turn}" {',
      "            say mine",
      "        }",
      "    }",
      "    repeat 2 {",
      "        turn += 1",
      "        let copy = turn",
      '        showPermanentButton "Repeat ${copy}" {',
      '            say "r${copy}"',
      "        }",
      "    }",
      "}",
      'show(["x", "y", "z"])',
      "wait 10 s",
      "exit",
    ].join("\n"),
    { press: clicking([3, 1, 5, 2, 4, 7, 6]) },
  );
  assert.deepEqual(said(loops.events), ["z 1", "x 2", "20", "y 3", "10", "r4", "r3"]);
});

test("a nested block shares its creator's variables, also one only the inner block uses", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "function arm(n: integer) {",
      '    showPermanentButton "Arm" {',
      "        timer async 1 s {",
      "            n += 1",
      '            say "n ${n}"',
      "        }",
      "    }",
      "}",
      "arm(5)",
      "wait 10 s",
      "exit",
    ].join("\n"),
    { press: clicking([1, 1], (snapshot) => snapshot.backgroundActions.length === 1) },
  );
  assert.deepEqual(said(result.events), ["n 6", "n 7"]);
});

test("every block of one media shares its variables across repeats", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "function scene {",
      "    let phase = 0",
      '    playAudio(file: "a.mp3", repeat: 3 times) {',
      "        at 250 ms {",
      "            phase += 1",
      "        }",
      "        finish {",
      '            say "finish ${phase}"',
      "        }",
      "    }",
      '    say "after ${phase}"',
      "}",
      "scene()",
      "exit",
    ].join("\n"),
    { mediaDurationMs: 1_000 },
  );
  assert.deepEqual(said(result.events), ["finish 3", "after 3"]);
});

test("the creator's later assignment reaches the block, and assignment still copies values", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "function example {",
      '    let message = "old"',
      "    timer async 1 s {",
      "        say message",
      "    }",
      '    message = "new"',
      "    let a = [1]",
      "    let b = a",
      '    showPermanentButton "Change" {',
      "        a[0] = 2",
      "    }",
      "    wait 5 s",
      '    say "${a[0]} / ${b[0]}"',
      "}",
      "example()",
      "exit",
    ].join("\n"),
    { press: clicking([1]) },
  );
  assert.deepEqual(said(result.events), ["new", "2 / 1"]);
});

test("blocks keep shared variables alive across transfers, removal, and a call, and release them after", () => {
  // A persistent button keeps counting in a function that returned, after a goto left its file.
  const persistent = assertRuntimeResumeEquivalent(
    [
      {
        path: "main.tease",
        source: [
          "function offer {",
          "    let n = 0",
          '    showPermanentButton "Add", persist: true {',
          "        n += 1",
          "        say n",
          "    }",
          "}",
          "offer()",
          'goto "room.tease"',
        ].join("\n"),
      },
      { path: "room.tease", source: "wait 10 s\nexit" },
    ],
    { press: clicking([1, 1]) },
  );
  assert.deepEqual(said(persistent.events), ["1", "2"]);

  // A block that removes its own button keeps running with the variable.
  const removed = assertRuntimeResumeEquivalent(
    [
      "function make {",
      "    let n = 0",
      '    return showPermanentButton "Once" {',
      "        n += 1",
      "        removePermanentButton(id)",
      "        wait 2 s",
      '        say "n ${n}"',
      "    }",
      "}",
      "let id = make()",
      "wait 10 s",
      "exit",
    ].join("\n"),
    { press: clicking([1]) },
  );
  assert.deepEqual(said(removed.events), ["n 1"]);
  const afterBlock = removed.boundaries.find(
    (snapshot) => snapshot.currentSessionTimeMs >= 2_000 && snapshot.callFrames.length === 0,
  );
  assert.ok(afterBlock !== undefined);
  assert.deepEqual(sharedScopes(afterBlock), [], "nothing shares the variable once the block ends");

  // A timer of the caller fires and finishes while a called file runs.
  const called = assertRuntimeResumeEquivalent([
    {
      path: "main.tease",
      source: [
        "function wait3 {",
        "    let n = 0",
        "    let t = timer(duration: 1, async: true, repeat: true) {",
        "        n += 1",
        "    }",
        "    timer async 1500 ms {",
        "        t.stop()",
        "    }",
        '    call "other.tease"',
        '    say "n ${n}"',
        "}",
        "wait3()",
        "exit",
      ].join("\n"),
    },
    { path: "other.tease", source: "wait 3 s\nend" },
  ]);
  assert.deepEqual(said(called.events), ["n 1"]);
  // While the function still runs its scope is on the stack; no boundary retains a scope nothing shares.
  assert.ok(called.boundaries.every((snapshot) => sharedScopes(snapshot).length === 0));
});

/** A session that round-trips every state through checkpoint JSON, for steps the equivalence helper does not take. */
class Session {
  readonly plan: InstructionPlan;
  snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[] = [];

  constructor(source: string) {
    this.plan = compileValidPlan(source);
    this.snapshot = createImmediatePacingRuntimeSnapshot(this.plan);
    this.run();
  }

  run(): this {
    this.#take(run(this.plan, this.snapshot));
    return this;
  }

  click(buttonId: number): this {
    const result = pressPermanentButton(this.plan, this.snapshot, buttonId);
    assert.equal(result.outcome.kind, "pressed");
    this.#take(result);
    return this.run();
  }

  answer(interactionKind: "text" | "number", text: string): this {
    const result = completeAction(this.plan, this.snapshot, {
      actionId: this.snapshot.foregroundAction!.actionId,
      actionKind: "interaction",
      interactionKind,
      payload: { kind: "submittedText", submittedText: text },
    });
    assert.equal(result.outcome.kind, "completed");
    this.#take(result);
    return this.run();
  }

  at(nowMs: number): this {
    this.#take(observeTime(this.plan, this.snapshot, nowMs));
    return this.run();
  }

  #take(result: {
    readonly snapshot: RuntimeSnapshot;
    readonly events: readonly InterpreterEvent[];
  }) {
    this.events.push(...result.events);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(this.plan, result.snapshot)),
    );
    assert.deepEqual(restored.snapshot, result.snapshot, "checkpoint JSON must round-trip exactly");
    this.snapshot = restored.snapshot;
  }
}

test("a suspended store writes the shared variable with the value it read before suspending", () => {
  // The left value is read before the question; a click meanwhile sets 10, and the store then writes 1 + 2.
  const trap = new Session(
    [
      "function add {",
      "    let x = 1",
      '    showPermanentButton "Change" {',
      "        x = 10",
      "    }",
      '    x += askInteger "Add?"',
      "    say x",
      "}",
      "add()",
      "exit",
    ].join("\n"),
  );
  trap.click(1).answer("number", "2");
  assert.deepEqual(said(trap.events), ["Add?", "3"]);

  // A block's suspended element store reaches the function's list, also after its own question.
  const element = new Session(
    [
      "function fill {",
      '    let items = ["a", "b"]',
      '    showPermanentButton "Edit" {',
      '        items[1] = askText "New?"',
      "    }",
      "    wait 5 s",
      "    say items",
      "}",
      "fill()",
      "exit",
    ].join("\n"),
  );
  element.click(1).answer("text", "c").at(5_000);
  assert.deepEqual(said(element.events), ["New?", '["a", "c"]']);
  assert.equal(element.snapshot.status, "halted");
});

// oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixtures mutate readonly and invalid fields of a valid snapshot.
function mutableSnapshot(snapshot: RuntimeSnapshot): any {
  return structuredClone(snapshot);
}

type MutableSnapshot = ReturnType<typeof mutableSnapshot>;

test("checkpoints whose shared variables do not fit the plan and the scopes are rejected", () => {
  const session = new Session(
    [
      "function offer {",
      "    let n = 0",
      '    showPermanentButton "Add" {',
      "        n += 1",
      "        wait 1 s",
      "    }",
      "}",
      "offer()",
      'showPermanentButton "Other" {',
      "}",
      "wait 10 s",
      "exit",
    ].join("\n"),
  );
  session.click(1);
  const valid = session.snapshot;
  assert.equal(validateRuntimeSnapshot(valid, session.plan).valid, true);
  assert.deepEqual(sharedScopes(valid), [["n"]]);
  const scopeId = valid.retainedScopes.find((scope) => scope.file === null)!.id;
  const rootId = valid.frames[0]!.id;

  const malformed = "Runtime shared block variables are malformed.";
  const unresolved = "Runtime shared block variable has no scope that holds it.";
  const variants: [string, (snapshot: MutableSnapshot) => void, string][] = [
    ["a wrong name", (s) => (s.backgroundActions[0].button.captures[0].name = "m"), malformed],
    ["a missing list", (s) => delete s.backgroundActions[0].button.captures, malformed],
    ["an unknown scope", (s) => (s.callFrames[0].captures[0].scopeId = 999), unresolved],
    ["a root scope", (s) => (s.callFrames[0].captures[0].scopeId = rootId), unresolved],
    [
      "a variable for a button that shares none",
      (s) => s.backgroundActions[1].button.captures.push({ name: "n", scopeId }),
      malformed,
    ],
    ["a frame that differs from its button", (s) => (s.callFrames[0].captures = []), malformed],
    [
      "a retained scope nothing shares",
      (s) => {
        s.retainedScopes.push({ id: s.nextScopeId, file: null, entry: null, bindings: [] });
        s.nextScopeId += 1;
      },
      "Runtime retained scope is not shared by any block.",
    ],
    [
      "a shared scope without its mark",
      (s) => delete s.retainedScopes.find((scope: MutableSnapshot) => scope.id === scopeId).shared,
      unresolved,
    ],
    [
      "a scope without the variable",
      (s) =>
        (s.retainedScopes.find((scope: MutableSnapshot) => scope.id === scopeId).bindings = []),
      unresolved,
    ],
  ];
  for (const [label, change, error] of variants) {
    const changed = mutableSnapshot(valid);
    change(changed);
    assert.ok(validateRuntimeSnapshot(changed, session.plan).errors.includes(error), label);
  }
});

test("the compiler shares the variables visible where a block is created, and checks their types", () => {
  const codes = (source: string): string[] =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => diagnostic.code);
  // A block that may set a variable to null ends what the function knows about it at a wait.
  assert.deepEqual(
    codes(
      [
        "function check(value: string?) {",
        "    timer async 1 s {",
        "        value = null",
        "    }",
        "    if value != null {",
        "        wait 2 s",
        "        say value.length",
        "    }",
        "}",
        'check("abc")',
      ].join("\n"),
    ),
    ["TSV043"],
  );
  // Also in a global function that another file calls first.
  assert.deepEqual(
    compileProject([
      { path: "main.tease", source: 'check("abc")\nexit' },
      {
        path: "helpers.tease",
        source: [
          "global function check(value: string?) {",
          "    timer async 1 s {",
          "        value = null",
          "    }",
          "    if value != null {",
          "        wait 2 s",
          "        say value.length",
          "    }",
          "}",
        ].join("\n"),
      },
    ]).diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV043"],
  );
  // A variable of the same name that no block shares keeps its narrowing: a block's own one, or one in another block.
  for (const shared of [
    "        timer async 1 s {\n            let value = 1\n            value += 1\n        }",
    '        let value = "x"\n        timer async 1 s {\n            value = "y"\n        }',
  ])
    assert.deepEqual(
      codes(
        [
          "function optional(value: string?): string? {",
          "    return value",
          "}",
          "function f {",
          "    if true {",
          shared,
          "    }",
          "    if true {",
          '        let value = optional("abc")',
          "        if value != null {",
          "            wait 2 s",
          "            say value.length",
          "        }",
          "    }",
          "}",
          "f()",
        ].join("\n"),
      ),
      [],
    );
  // A block that only reads it does not.
  assert.deepEqual(
    codes(
      [
        "function check(value: string?) {",
        "    timer async 1 s {",
        "        if value != null {",
        "            say value",
        "        }",
        "    }",
        "    if value != null {",
        "        wait 2 s",
        "        say value.length",
        "    }",
        "}",
        'check("abc")',
      ].join("\n"),
    ),
    [],
  );
  // A block stores into the variable's own type.
  assert.deepEqual(
    codes(
      'function f {\n    let count = 0\n    showPermanentButton "a" {\n        count = "text"\n    }\n}\nf()',
    ),
    ["TSV041"],
  );
  // A local declared after the block is not visible in it, and a block's own variable may not hide a shared one.
  assert.deepEqual(
    codes(
      'function f {\n    showPermanentButton "a" {\n        say later\n    }\n    let later = 1\n}\nf()',
    ),
    ["TSV002"],
  );
  assert.deepEqual(
    compileSource(
      'function f {\n    let x = 1\n    showPermanentButton "a" {\n        let x = 2\n    }\n}\nf()\nexit',
    ).diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
    [
      [
        "TSV001",
        "'x' already names a variable of the code that created this button, which the block shares. Rename the block's variable.",
      ],
    ],
  );
  // A function called from a block sees its own names, not the block's.
  assert.deepEqual(
    codes(
      'function helper {\n    say n\n}\nfunction f {\n    let n = 1\n    showPermanentButton "a" {\n        helper()\n    }\n}\nf()',
    ),
    ["TSV002"],
  );
});
