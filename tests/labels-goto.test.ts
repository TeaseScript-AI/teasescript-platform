import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource } from "../src/compiler.js";
import type { Instruction, InstructionPlan, PlanLabel } from "../src/plan/model.js";
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

test("a block's goto drops the queued blocks of finished non-persistent timers and keeps persistent ones", () => {
  // Both one-shot timers finish at 1 s while the third timer's block runs, so their blocks wait; its goto then leaves
  // the activation that started them.
  const result = assertRuntimeResumeEquivalent(
    [
      'timer(duration: 1, async: true, display: "hidden") { say "dropped" }',
      'timer(duration: 1, async: true, display: "hidden", persist: true) { say "kept" }',
      'timer(duration: 500 ms, async: true, display: "hidden") {',
      "    wait 1",
      "    goto onward",
      "}",
      "wait 5",
      "exit",
      "label onward",
      "wait 1",
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(outputs(result.events), ["say kept", "exit"]);
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
  // A file of declarations only runs nothing, so it needs no ending; the project still needs an exit.
  assert.deepEqual(
    compileProject([
      { path: "main.tease", source: 'say "hi"\nexit' },
      { path: "helpers.tease", source: 'function helper {\n    say "helping"\n}' },
    ]).diagnostics,
    [],
  );
  assert.deepEqual(diagnostics('let n = 1\nif n > 0 { exit }\nsay "maybe"').map(format), [runsOff]);
  // Branches that all end need nothing after them, and a label can be reached after a transfer.
  assert.deepEqual(
    diagnostics("let n = 1\nif n > 0 { exit } else { goto again }\nlabel again\nexit"),
    [],
  );
  assert.deepEqual(diagnostics('exit\nlabel later\nsay "later"').map(format), [runsOff]);
  assert.deepEqual(diagnostics("let n = 0\nwhile true { n += 1 }"), [
    [
      "TSV058",
      2,
      "If this loop starts, it has no way to stop. Add a condition with `break` to leave the loop, or use `exit` to finish the session.",
    ],
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

  const retarget = (target: number) => ({
    ...plan,
    instructions: plan.instructions.map((instruction, index) =>
      index === gotoIndex ? { ...instruction, target } : instruction,
    ),
  });
  assert.deepEqual(errors(retarget(1)), [
    `$.instructions[${gotoIndex}].target A goto must continue at a label of its own file.`,
  ]);
  const withLabels = (labels: readonly object[]) => ({ ...plan, files: [{ ...file, labels }] });
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

test("a goto that skips a let is found where functions and handlers use the variable", () => {
  for (const use of ["function read { say x }\nread()", "timer async 1 { say x }\nwait 2"]) {
    assert.deepEqual(codes(`goto later\nlet x = 1\nlabel later\n${use}\nexit`), [["TSV054", 4]]);
  }
  // A goto that cannot run adds no way to the label.
  assert.deepEqual(
    codes("function f {\n    return\n    goto later\n}\nf()\nlet x = 1\nlabel later\nsay x\nexit"),
    [],
  );
  // A function called before the let is checked when it runs, as before labels existed.
  assert.deepEqual(codes("function read { say x }\nread()\nlet x = 1\nread()\nexit"), []);
  // Nor does a goto in a branch or loop body that certainly does not run, while one that may run does.
  for (const [start, expected] of [
    [
      'function jump: boolean { goto later }\nif true { say "yes" } else if jump() { say "no" }',
      [],
    ],
    ["repeat 0 { goto later }", []],
    ["for value in [] { goto later }", []],
    [
      'function jump: boolean { goto later }\nif false { say "yes" } else if jump() { say "no" }',
      [["TSV054", 5]],
    ],
    ["repeat 1 { goto later }", [["TSV054", 4]]],
    ["for value in [1] { goto later }", [["TSV054", 4]]],
  ] as const) {
    const source = `${start}\nlet x = 1\nlabel later\nsay x\nexit`;
    assert.deepEqual(codes(source), expected, start);
  }
  const deadBranch = compileValidPlan(
    'function jump: boolean { goto later }\nif true { say "yes" } else if jump() { say "no" }\nlet x = 1\nlabel later\nsay x\nexit',
  );
  assert.deepEqual(
    outputs(run(deadBranch, createImmediatePacingRuntimeSnapshot(deadBranch)).events),
    ["say yes", "say 1", "exit"],
  );
});

test("a goto in deeply nested blocks compiles", () => {
  const depth = 10_000;
  const source = `let x = 1\n${"timer async 1 {\n".repeat(depth)}goto done\n${"}\n".repeat(depth)}label done\nsay x\nexit`;
  assert.deepEqual(compileSource(source).diagnostics, []);
});

test("a call counts as returning, so the file still says how it ends", () => {
  assert.deepEqual(diagnostics("function finish { exit }\nfinish()"), [
    [
      "TSV052",
      2,
      "This path reaches the end of the file after finish(). Even if finish ends the session, add exit (or end) here so the ending is explicit.",
    ],
  ]);
  assert.deepEqual(codes("function finish { exit }\nfinish()\nexit"), []);
  // A goto after a branch that always returns does not run, by the same flow as the ending check.
  assert.deepEqual(
    codes(
      "function f {\n    if true { return }\n    goto later\n}\nf()\nlet x = 1\nlabel later\nsay x\nexit",
    ),
    [],
  );
});

test("plan validation keeps labels out of blocks, loops, and statements", () => {
  for (const [source, kind] of [
    ['let n = 1\nrepeat 2 { say "body" }\nexit', "loopControl"],
    ['let n = 1\nif n > 0 { say "body" }\nexit', "leaveScope"],
    ["let answer = askText\nexit", "declareBinding"],
  ] as const) {
    const plan = compileValidPlan(source);
    const target = plan.instructions.findIndex((instruction) => instruction.kind === kind);
    const errors = validateInstructionPlan({
      ...plan,
      files: [{ ...plan.files[0]!, labels: [{ name: "inside", instruction: target }] }],
      instructions: plan.instructions.map((instruction, index) =>
        index === 0 ? { kind: "goto", target, span: instruction.span } : instruction,
      ),
    }).errors.map((error) => error.message);
    assert.ok(
      errors.includes("A label must stand between statements of its file's outer scope."),
      kind,
    );
  }
});

test("plan validation finds a say presentation or button timeout that a label entry skips", () => {
  // Without the label the same plans are valid: the operand is set before it is read.
  const say = compileValidPlan('say "hello", instant\nexit');
  const sayInstruction = say.instructions.find((instruction) => instruction.kind === "say")!;
  const span = sayInstruction.span;
  const sayPlan = (step: Instruction, labels: readonly PlanLabel[]): InstructionPlan => ({
    ...say,
    temporaryCount: 1,
    instructions: [
      {
        kind: "storeTemporary",
        temporaryId: 1,
        value: { kind: "literal", value: null, span },
        expectBoolean: false,
        span,
      },
      step,
      { ...sayInstruction, presentation: { kind: "temporary", temporaryId: 1, span } },
      ...say.instructions.slice(say.instructions.indexOf(sayInstruction) + 1),
    ],
    files: [{ ...say.files[0]!, rootEndInstruction: 5, endInstruction: 5, labels }],
  });
  const button = compileValidPlan('let t = 1\nshowButton "Go", timeout: t\nexit');
  const [, speaker, label, timeout, interaction, ...rest] = button.instructions;
  assert.equal(timeout?.kind, "storeTemporary");
  const buttonPlan = (step: Instruction, labels: readonly PlanLabel[]): InstructionPlan => ({
    ...button,
    instructions: [timeout!, step, speaker!, label!, interaction!, ...rest],
    files: [{ ...button.files[0]!, labels }],
  });
  for (const plan of [sayPlan, buttonPlan]) {
    const evaluate: Instruction = {
      kind: "evaluate",
      expression: { kind: "literal", value: 1, span },
      span,
    };
    assert.deepEqual(validateInstructionPlan(plan(evaluate, [])).errors, []);
    const entry = plan({ kind: "goto", target: 2, span }, [{ name: "entry", instruction: 2 }]);
    assert.deepEqual(
      validateInstructionPlan(entry).errors.map((error) => error.message),
      ["A label must stand between statements of its file's outer scope."],
    );
  }
});
