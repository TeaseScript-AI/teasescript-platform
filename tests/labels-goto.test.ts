import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

function diagnostics(source: string): [string, number, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.span.start.line + 1,
    diagnostic.message,
  ]);
}

function codes(source: string): [string, number][] {
  return diagnostics(source).map(([code, line]) => [code, line]);
}

function outputs(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "say"
      ? [`say ${event.text}`]
      : event.kind === "runtimeFailure"
        ? [`failure ${event.code}`]
        : event.kind === "exit"
          ? ["exit"]
          : [],
  );
}

test("a goto continues at a label of the file, also from a function or out of loops", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let count = 0",
      "label again",
      "let pass = count + 1",
      "count = pass",
      'say "pass ${pass}"',
      "if count < 3 { goto again }",
      "function leave {",
      "    repeat 3 {",
      "        while true { goto done }",
      "    }",
      "}",
      "leave()",
      'say "skipped"',
      "label done",
      'say "done"',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(outputs(result.events), [
    "say pass 1",
    "say pass 2",
    "say pass 3",
    "say done",
    "exit",
  ]);
  // Running `let pass` again set the same variable; the goto left the function, loops, and blocks behind.
  assert.deepEqual(result.finalSnapshot.frames[0]!.bindings, [
    { name: "count", value: 3 },
    { name: "pass", value: 3 },
  ]);
});

test("a goto from an expiry block abandons the action it interrupted", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "timer async 1 {",
      "    goto late",
      "}",
      "let answer = askText",
      'say "never ${answer}"',
      "exit",
      "label late",
      'say "too late"',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(outputs(result.events), ["say too late", "exit"]);
  // The question was requested and is never answered or resumed.
  assert.equal(
    result.events.filter((event) => event.kind === "actionRequested").length,
    result.events.filter((event) => event.kind === "actionCompleted").length + 1,
  );
});

test("a goto stops non-persistent timers, and persistent timers keep running", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'let once = timer(duration: 1, async: true, display: "hidden") { say "once" }',
      'let kept = timer(duration: 1, async: true, display: "hidden", repeat: true, persist: true) {',
      '    say "kept"',
      "}",
      "goto onward",
      "label onward",
      "wait 2500 ms",
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(outputs(result.events), ["say kept", "say kept", "exit"]);
  const stopped = result.events.flatMap((event) =>
    event.kind === "actionCompleted" && event.settlement.actionKind === "timer"
      ? [event.settlement.settlementKind]
      : [],
  );
  assert.deepEqual(stopped, ["stopped"]);
});

test("media keeps playing across a goto", () => {
  const result = assertRuntimeResumeEquivalent(
    ['let music = playAudio async "music.mp3"', "goto next", "label next", "wait 1", "exit"].join(
      "\n",
    ),
    { mediaDurationMs: 10_000 },
  );
  const beforeExit = result.boundaries.findLast((snapshot) => snapshot.status !== "halted")!;
  assert.ok(beforeExit.backgroundActions.some((action) => action.kind === "media"));
});

test("end without a calling file is a runtime error", () => {
  const plan = compileValidPlan('say "start"\nlet n = 1\nif n > 0 { end }\nexit');
  assert.deepEqual(outputs(run(plan, createImmediatePacingRuntimeSnapshot(plan)).events), [
    "say start",
    "failure TSR066",
  ]);
});

test("labels stand in a file's outer scope, with unique names", () => {
  assert.deepEqual(codes("if true {\n    label inner\n}\nexit"), [["TSV051", 2]]);
  assert.deepEqual(codes("function f {\n    label inner\n}\nexit"), [["TSV051", 2]]);
  assert.deepEqual(codes("label twice\nlabel twice\nexit"), [["TSV051", 2]]);
  assert.deepEqual(codes("goto nowhere\nexit"), [["TSV051", 1]]);
  assert.deepEqual(codes("label random\nexit"), [["TSV001", 1]]);
  assert.deepEqual(codes("label\nexit"), [["TSP039", 1]]);
});

test("every file says how it ends, and the project reaches an exit", () => {
  const runsOff =
    "TSV052 The script can run past the end of this file. Add exit where the session should finish, or end to return to the file that called this one.";
  const format = ([code, , message]: [string, number, string]) => `${code} ${message}`;
  assert.deepEqual(diagnostics('say "hi"').map(format), [runsOff]);
  assert.deepEqual(diagnostics('let n = 1\nif n > 0 { exit }\nsay "maybe"').map(format), [runsOff]);
  // Branches that all end need nothing after them, and a label can be reached after a transfer.
  assert.deepEqual(
    diagnostics("let n = 1\nif n > 0 { exit } else { goto again }\nlabel again\nexit"),
    [],
  );
  assert.deepEqual(diagnostics('exit\nlabel later\nsay "later"').map(format), [runsOff]);
  assert.deepEqual(diagnostics("let n = 0\nwhile true { n += 1 }"), [
    [
      "TSV053",
      2,
      "The script never reaches exit, so the session has no end. Add exit where the session should finish.",
    ],
  ]);
  assert.deepEqual(diagnostics("end"), [
    [
      "TSV053",
      1,
      "The script never reaches exit, so the session has no end. Add exit where the session should finish.",
    ],
  ]);
});

test("a variable is used after a label only when every way to the label set it", () => {
  // The ordinary loop: count is set before the label on every way there.
  assert.deepEqual(
    codes("let count = 0\nlabel again\ncount += 1\nif count < 3 { goto again }\nexit"),
    [],
  );
  assert.deepEqual(diagnostics("goto later\nlet x = 1\nlabel later\nsay x\nexit"), [
    [
      "TSV054",
      4,
      "A goto can reach this line without running 'let x' first, so x may have no value here. Move the label that the goto jumps to before 'let x', or set x on every way here.",
    ],
  ]);
  // A goto in a function or block has run what came before its call or start, and no more.
  assert.deepEqual(
    codes("let x = 1\nfunction f { goto later }\nf()\nlet y = 2\nlabel later\nsay x\ny = 3\nexit"),
    [["TSV054", 7]],
  );
  assert.deepEqual(
    codes(
      "let x = 1\ntimer async 1 { goto later }\nlet y = 2\nwait 2\nlabel later\nsay x\nsay y\nexit",
    ),
    [["TSV054", 7]],
  );
  // A function never called adds no way to the label.
  assert.deepEqual(codes("function f { goto later }\nlet y = 2\nlabel later\nsay y\nexit"), []);
});

test("plan validation keeps gotos on labels and closes each root region with an end", () => {
  const plan = compileValidPlan("label top\nlet n = 1\nif n > 1 { goto top }\nexit");
  const errors = (changed: unknown): string[] =>
    validateInstructionPlan(changed).errors.map((error) => `${error.path} ${error.message}`);
  const gotoIndex = plan.instructions.findIndex((instruction) => instruction.kind === "goto");
  const file = plan.files[0]!;
  assert.deepEqual(file.labels, [{ name: "top", instruction: 0 }]);
  assert.equal(plan.instructions[file.rootEndInstruction - 1]!.kind, "end");

  const retarget = (target: number): unknown => ({
    ...plan,
    instructions: plan.instructions.map((instruction, index) =>
      index === gotoIndex ? { ...instruction, target } : instruction,
    ),
  });
  assert.deepEqual(errors(retarget(1)), [
    `$.instructions[${gotoIndex}].target A goto must continue at a label of its own file.`,
  ]);
  const withLabels = (labels: unknown): unknown => ({ ...plan, files: [{ ...file, labels }] });
  assert.deepEqual(errors(withLabels([{ name: "top", instruction: file.rootEndInstruction }])), [
    "$.files[0].labels[0].instruction Plan labels stand in source order inside their file's root region.",
    `$.instructions[${gotoIndex}].target A goto must continue at a label of its own file.`,
  ]);
  assert.deepEqual(
    errors(
      withLabels([
        { name: "top", instruction: 0 },
        { name: "top", instruction: 1 },
      ]),
    ),
    ["$.files[0].labels[1].name Plan label names must be unique identifiers."],
  );
  const unclosed = {
    ...plan,
    instructions: plan.instructions.map((instruction, index) =>
      index === file.rootEndInstruction - 1
        ? { kind: "exit", span: instruction.span }
        : instruction,
    ),
  };
  assert.deepEqual(errors(unclosed), [
    "$.files[0].rootEndInstruction A file's root region must close with an end.",
  ]);
});
