import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, type ProjectSourceFile } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createCheckpoint, deserializeCheckpoint, serializeCheckpoint } from "../src/index.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import {
  assertRuntimeResumeEquivalent,
  type RuntimeResumeEquivalenceOptions,
} from "./helpers/runtime-equivalence.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-validation.js";
import { validateScriptStorageEntries } from "../src/runtime/host-data/script-storage.js";

function project(main: string, others: Record<string, string> = {}): ProjectSourceFile[] {
  return [
    { path: "main.tease", source: main },
    ...Object.entries(others).map(([path, source]) => ({ path, source })),
  ];
}

function outputs(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "say"
      ? [event.text]
      : event.kind === "runtimeFailure"
        ? [`failure ${event.code}: ${event.message}`]
        : event.kind === "exit"
          ? ["exit"]
          : [],
  );
}

/** Runs a project to its end, also stepwise with a checkpoint at every boundary, and returns what it said. */
function said(
  files: readonly ProjectSourceFile[],
  options: RuntimeResumeEquivalenceOptions = {},
): string[] {
  return outputs(assertRuntimeResumeEquivalent(files, options).events);
}

/** The plan of a project whose only diagnostics are the TSV065 warnings of the files in `unstarted`, which nothing starts. */
function compiled(
  files: readonly ProjectSourceFile[],
  unstarted: readonly string[] = [],
): InstructionPlan {
  const result = compileProject(files);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
    unstarted.map((path) => [path, "TSV065"]),
  );
  return result.plan!;
}

/** The TSV065 warning of a file that no `goto` or `call` starts (#595). */
function unstarted(path: string): string {
  return `The code of '${path}' never runs, because no 'goto' or 'call' that can run starts the file. Remove the file, or start the file with a 'goto' or 'call'.`;
}

function diagnostics(files: readonly ProjectSourceFile[]): [string, string, string][] {
  return compileProject(files).diagnostics.map((diagnostic) => [
    diagnostic.path,
    diagnostic.code,
    diagnostic.message,
  ]);
}

const HALL = { "rooms/hall.tease": 'say "hall"\nexit' };

test("a script reference is a value that shows as the call that makes it and compares by path", () => {
  assert.deepEqual(
    said(
      project(
        [
          'let hall = script("rooms/hall.tease")',
          'let yard: script = script("rooms/yard.tease")',
          "say hall",
          'say "next: ${yard}"',
          "say toString(yard)",
          "say [hall, yard]",
          'say hall == script("rooms/hall.tease")',
          "say hall == yard",
          'say set[hall, yard, script("rooms/hall.tease")].length',
          'let kept = dict{ "next": yard }',
          'save kept["next"] as "next"',
          'let loaded = load "ne" + "xt", default: null',
          "say loaded is script and loaded == yard",
          "exit",
        ].join("\n"),
        { ...HALL, "rooms/yard.tease": 'say "yard"\nexit' },
      ),
      // A reference alone starts no file.
      { warnings: ["TSV065", "TSV065"] },
    ),
    [
      'script("rooms/hall.tease")',
      'next: script("rooms/yard.tease")',
      'script("rooms/yard.tease")',
      '[script("rooms/hall.tease"), script("rooms/yard.tease")]',
      "true",
      "false",
      "2",
      "true",
      "exit",
    ],
  );
});

test("goto and call go where a reference in a variable, list, or dict names", () => {
  assert.deepEqual(
    said(
      project(
        [
          'let rooms = [script("rooms/a.tease"), script("rooms/b.tease")]',
          'let ends = dict{ "calm": script("ends/calm.tease") }',
          "for room in rooms {",
          "    call (room)",
          "}",
          'let next = script("rooms/hall.tease")',
          "call (next)",
          'goto (ends["calm"])',
        ].join("\n"),
        {
          "rooms/a.tease": 'say "a"\nend',
          "rooms/b.tease": 'say "b"\nend',
          "rooms/hall.tease": 'say "hall"\nend',
          "ends/calm.tease": 'say "calm end"\nexit',
        },
      ),
    ),
    ["a", "b", "hall", "calm end", "exit"],
  );
});

test("a reference saved in one session starts its file in the next", () => {
  const room = 'say "room"\nexit';
  const writer = compiled(
    project('save script("room.tease") as "next"\nexit', { "room.tease": room }),
    ["room.tease"],
  );
  const saved = run(writer, createImmediatePacingRuntimeSnapshot(writer)).snapshot.scriptStorage;
  assert.deepEqual(saved, [{ key: "next", value: { kind: "script", path: "room.tease" } }]);
  const reader = 'let next = load "ne" + "xt", default: null\ngoto (next)';
  assert.deepEqual(said(project(reader, { "room.tease": room }), { scriptStorage: saved }), [
    "room",
    "exit",
  ]);
  // A reference saved with a label names no place a file starts at now, so it is not read as one.
  assert.equal(
    validateScriptStorageEntries(
      [{ key: "next", value: { kind: "script", path: "room.tease", label: "late" } }],
      "storage",
    ),
    "storage[0].value contains a malformed script reference.",
  );
  // A function called before its file's let runs.
  const early = project("function show { say level }\nshow()\nlet level = 1\nexit");
  assert.deepEqual(said(early, { ending: "failed" }), [
    "failure TSR070: 'level' has no value yet: its 'let level' has not run. Give level a value before it is used.",
  ]);
});

test("a computed target that names no file, or a file that runs nothing, fails when it runs", () => {
  const others = { ...HALL, "helpers.tease": 'function greet { say "hi" }' };
  const failure = (main: string): string[] => said(project(main, others), { ending: "failed" });
  assert.deepEqual(failure('let room = "cellar"\ngoto script("rooms/${room}.tease")'), [
    `failure TSR069: This goto names the file 'rooms/cellar.tease', but the project has no such file. Paths start at the package root, such as "rooms/hall.tease".`,
  ]);
  // A path computed otherwise may name any file, so the goto warns that it may name a file that runs nothing.
  assert.deepEqual(
    said(project('let path = "helpers.tease"\nlet next = script(path)\ngoto (next)', others), {
      ending: "failed",
      warnings: ["TSV074"],
    }),
    [
      "failure TSR069: 'helpers.tease' holds declarations only and runs nothing, so going there would end nowhere. Use its global functions, speakers, and globals in any file without going there.",
    ],
  );
  // Calling such a file runs nothing and returns at once. The compiler cannot tell which file the path names, so the
  // call warns that it may start the running file.
  assert.deepEqual(
    said(project('let path = "helpers.tease"\ncall script(path)\nsay "back"\nexit', others), {
      warnings: ["TSV073"],
    }),
    ["back", "exit"],
  );
  // A loaded value that is not a reference is no target. An earlier session may have saved a reference to any file.
  assert.deepEqual(
    said(project('let next = load "ne" + "xt", default: null\ngoto (next)', others), {
      ending: "failed",
      warnings: ["TSV074"],
    }),
    [
      "failure TSR058: goto needs a script reference here, made with script(...), but this is null.",
    ],
  );
});

test("a goto to a reference that can name a file of declarations only warns, or is an error where it names only that file", () => {
  const others = { ...HALL, "helpers.tease": 'function greet { say "hi" }' };
  const check = (main: string): [string, string][] =>
    diagnostics(project(main, others)).map(([, code, message]) => [code, message]);
  const runsNothing =
    "'helpers.tease' holds declarations only and runs nothing, so going there would end nowhere. Use its global functions, speakers, and globals in any file without going there.";
  // V30 §29: where the references of the project can name only that file, as for a script(...) of its path.
  assert.deepEqual(
    check('if debugMode { exit }\nlet next = script("helpers.tease")\ngoto (next)'),
    [
      ["TSV057", runsNothing],
      ["TSV065", unstarted("rooms/hall.tease")],
    ],
  );
  // Where they may name another file too, the run decides, and the goto fails if it goes there.
  const rooms = 'let rooms = [script("helpers.tease"), script("rooms/hall.tease")]\n';
  assert.deepEqual(check(`${rooms}goto (rooms[0])`), [
    [
      "TSV074",
      "The file of this 'goto' is known only when it runs, so the compiler cannot tell whether it is 'helpers.tease', which holds declarations only and runs nothing. If it is, the 'goto' fails. If it can be, make sure the 'goto' leads to a file that runs something.",
    ],
  ]);
  assert.deepEqual(
    said(project(`${rooms}goto (rooms[0])`, others), { ending: "failed", warnings: ["TSV074"] }),
    [`failure TSR069: ${runsNothing}`],
  );
  assert.deepEqual(said(project(`${rooms}goto (rooms[1])`, others), { warnings: ["TSV074"] }), [
    "hall",
    "exit",
  ]);
  // A call of such a file runs nothing and returns.
  assert.deepEqual(
    said(project('let next = script("helpers.tease")\ncall (next)\nsay "back"\nexit', others), {
      warnings: ["TSV065"],
    }),
    ["back", "exit"],
  );
});

test("a script(...) with literal text is checked like a file target, and a computed target needs a reference", () => {
  const others = { ...HALL, "helpers.tease": 'function greet { say "hi" }' };
  const check = (main: string): [string, string][] =>
    diagnostics(project(main, others)).map(([, code, message]) => [code, message]);
  assert.deepEqual(check('let next = script("rooms/yard.tease")\nexit'), [
    [
      "TSV057",
      "The project has no file 'rooms/yard.tease'. Paths start at the package root, such as \"rooms/hall.tease\".",
    ],
  ]);
  assert.deepEqual(check('let next = script("/rooms/hall.tease")\nexit'), [
    [
      "TSV057",
      "'/rooms/hall.tease' is not a package file path: the path has an empty folder name. Separate folders with a single '/'.",
    ],
  ]);
  assert.deepEqual(check('let next = script("rooms/*.tease")\nexit'), [
    [
      "TSV057",
      'A glob cannot be inside script(...). To pick a random file, write goto "rooms/*.tease" directly.',
    ],
  ]);
  assert.deepEqual(check('call script("rooms/*.tease")\nexit'), [
    [
      "TSV057",
      'A glob cannot be inside script(...). To pick a random file, write call "rooms/*.tease" directly.',
    ],
  ]);
  // Going to a file of declarations only would end nowhere; calling it is fine, as for a literal target.
  assert.deepEqual(check('goto script("helpers.tease")'), [
    [
      "TSV057",
      "'helpers.tease' holds declarations only and runs nothing, so going there would end nowhere. Use its global functions, speakers, and globals in any file without going there.",
    ],
  ]);
  assert.deepEqual(
    check('call script("helpers.tease")\nlet later = script("helpers.tease")\nexit'),
    [["TSV065", unstarted("rooms/hall.tease")]],
  );
  assert.deepEqual(check('let path = "rooms/hall.tease"\ngoto (path)'), [
    [
      "TSV043",
      'goto needs a script reference here, but this is text (string). Plain text is not a jump target: turn a path into one with script(...), as in goto script("rooms/hall.tease").',
    ],
  ]);
  assert.deepEqual(check("call (3)\nexit"), [
    [
      "TSV043",
      'call needs a script reference here, but this is a whole number (integer). Make one with script(...), as in call script("rooms/hall.tease").',
    ],
  ]);
  assert.deepEqual(check('let next = script("rooms/hall.tease", "start")\nexit'), [
    ["TSV020", "script() takes 1 argument (path), received 2."],
  ]);
  assert.deepEqual(check('let next = script(1, at: "start")\nexit'), [
    [
      "TSV043",
      "script(...) takes the path of a file as text (string), but this is a whole number (integer).",
    ],
    ["TSV022", "script() takes its arguments without names. Remove 'at:'."],
  ]);
  // A button cannot return a reference, also through its text; with a value written before ':' it may show one.
  const noReturn =
    "A button cannot return a script reference. Give the buttons text or number values, and pick the script reference from the answer.";
  assert.deepEqual(check('let next = askChoice script("rooms/hall.tease"), "stay"\nexit'), [
    ["TSV029", noReturn],
  ]);
  assert.deepEqual(check('let next = askChoice { text: script("rooms/hall.tease") }\nexit'), [
    ["TSV029", noReturn],
  ]);
  assert.deepEqual(
    check('let next = askChoice go: script("rooms/hall.tease"), stay: "Stay"\nexit'),
    [["TSV065", unstarted("rooms/hall.tease")]],
  );
});

test("a button shows a script reference only when a written value is what it returns", () => {
  const plan = compiled(
    project('let next = askChoice go: script("rooms/hall.tease"), stay: "Stay"\nexit', HALL),
    ["rooms/hall.tease"],
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  const action = waiting.foregroundAction;
  assert.ok(action?.kind === "interaction" && action.ui.kind === "choice");
  assert.deepEqual(
    action.ui.options.map((option) => [option.text, option.value]),
    [
      ['script("rooms/hall.tease")', "go"],
      ["Stay", "stay"],
    ],
  );
  // A loaded reference is known only when the choice is prepared.
  const scriptStorage = [
    { key: "next", value: { kind: "script" as const, path: "rooms/hall.tease" } },
  ];
  assert.deepEqual(
    said(
      project(
        'let next = load "ne" + "xt", default: null\nlet answer = askChoice next, "stay"\nexit',
        HALL,
      ),
      { scriptStorage, ending: "failed", warnings: ["TSV065"] },
    ),
    [
      "failure TSR052: A button cannot return a script reference. Give the buttons text or number values, and pick the script reference from the answer.",
    ],
  );
});

test("a global holds a reference from the start of the session or from a later assignment, in every file", () => {
  assert.deepEqual(
    said(
      project(
        [
          'global next = script("rooms/hall.tease")',
          'global after = script("rooms/a.tease")',
          'call "rooms/setup.tease"',
          "call (after)",
          "call (next)",
          "exit",
        ].join("\n"),
        {
          "rooms/setup.tease": 'after = script("rooms/yard.tease")\nend',
          "rooms/a.tease": 'say "a"\nend',
          "rooms/yard.tease": 'say "yard"\nend',
          "rooms/hall.tease": 'say "hall ${next}"\nexit',
        },
      ),
    ),
    ["yard", 'hall script("rooms/hall.tease")', "exit"],
  );
});

test("plan and restore validation check the expression of a computed target", () => {
  const files = project(
    [
      "function pick(index) {",
      '    return [script("rooms/a.tease"), script("rooms/b.tease")][index]',
      "}",
      "call (pick(1))",
      "exit",
    ].join("\n"),
    { "rooms/a.tease": 'say "a"\nend', "rooms/b.tease": 'say "b"\nend' },
  );
  const result = assertRuntimeResumeEquivalent(files);
  assert.deepEqual(outputs(result.events), ["b", "exit"]);
  const plan = compiled(files);
  const at = plan.instructions.findIndex((instruction) => instruction.kind === "transfer");
  const transfer = plan.instructions[at]!;
  assert.ok(transfer.kind === "transfer" && "value" in transfer.destination);
  // The function's result waits in a temporary until the call reads it.
  assert.equal(transfer.destination.value.kind, "temporary");
  const before = result.boundaries.find((snapshot) => snapshot.nextInstruction === at)!;
  assert.deepEqual(validateRuntimeSnapshot(before, plan).errors, []);
  assert.deepEqual(validateRuntimeSnapshot({ ...before, temporaries: [] }, plan).errors, [
    "Runtime state is missing a temporary required by the next instruction.",
  ]);
  const errors = (destination: unknown): string[] =>
    validateInstructionPlan({
      ...plan,
      instructions: plan.instructions.map((instruction, index) =>
        index === at ? { ...instruction, destination } : instruction,
      ),
    }).errors.map((error) => `${error.path} ${error.message}`);
  assert.deepEqual(errors({ value: transfer.destination.value, file: 0 }), [
    `$.instructions[${at}].destination Transfer destination is malformed.`,
  ]);
  assert.ok(
    errors({
      value: { kind: "temporary", temporaryId: plan.temporaryCount + 1, span: transfer.span },
    }).length > 0,
  );
});

test("restore checks that each activation started at the top of its file", () => {
  const plan = compiled(
    project('call "rooms/hall.tease"\nexit', { "rooms/hall.tease": "wait 1 s\nlabel later\nend" }),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  const hall = plan.files.findIndex((file) => file.path === "rooms/hall.tease");
  assert.deepEqual(
    waiting.frames.flatMap((frame) => (frame.file === null ? [] : [[frame.file, frame.entry]])),
    [
      [0, plan.files[0]!.entryInstruction],
      [hall, plan.files[hall]!.entryInstruction],
    ],
  );
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  // Not at a label, nor at the end that closes the file's top level.
  for (const entry of [
    plan.files[hall]!.labels[0]!.instruction,
    plan.files[hall]!.rootEndInstruction - 1,
    null,
  ]) {
    // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture moves one entry.
    const snapshot = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
    snapshot.frames[1]!.entry = entry;
    assert.deepEqual(validateRuntimeSnapshot(snapshot, plan).errors, [
      "Runtime scope frame is malformed.",
    ]);
  }
});

test("restore checks a plan with a deeply nested computed target without walking it", () => {
  // The compiler and runtime take deep expressions, and restore checks the plan and the waiting session.
  const depth = 6_000;
  const path = `${"toString(".repeat(depth)}"room.tease"${")".repeat(depth)}`;
  const plan = compiled([
    { path: "main.tease", source: `wait 1 s\ngoto script(${path})` },
    { path: "room.tease", source: 'say "room"\nexit' },
  ]);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, waiting)));
  assert.deepEqual(
    outputs(run(restored.plan, restored.snapshot, {}, { instructionBudget: 100 }).events),
    [],
  );
});

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
    ? Array<Mutable<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;
