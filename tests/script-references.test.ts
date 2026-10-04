import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, type ProjectSourceFile } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { validateRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import {
  assertRuntimeResumeEquivalent,
  type RuntimeResumeEquivalenceOptions,
} from "./helpers/runtime-equivalence.js";

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

function compiled(files: readonly ProjectSourceFile[]): InstructionPlan {
  const result = compileProject(files);
  assert.deepEqual(result.diagnostics, []);
  return result.plan!;
}

/** What a project says when it runs until it ends or fails. */
function ran(files: readonly ProjectSourceFile[]): string[] {
  const plan = compiled(files);
  return outputs(run(plan, createImmediatePacingRuntimeSnapshot(plan)).events);
}

function diagnostics(files: readonly ProjectSourceFile[]): [string, string, string][] {
  return compileProject(files).diagnostics.map((diagnostic) => [
    diagnostic.path,
    diagnostic.code,
    diagnostic.message,
  ]);
}

const HALL = { "rooms/hall.tease": 'say "hall"\nlabel start\nsay "hall start"\nexit' };

test("a script reference is a value that shows as the call that makes it and compares by path and label", () => {
  assert.deepEqual(
    said(
      project(
        [
          'let hall = script("rooms/hall.tease")',
          'let start: script = script("rooms/hall.tease", label: "start")',
          "say hall",
          'say "next: ${start}"',
          "say toString(start)",
          "say [hall, start]",
          'say hall == script("rooms/hall.tease")',
          "say hall == start",
          'say set[hall, start, script("rooms/hall.tease")].length',
          'let kept = dict{ "next": start }',
          'save kept["next"] as "next"',
          'let loaded = load "next"',
          "say loaded is script and loaded == start",
          "exit",
        ].join("\n"),
        HALL,
      ),
    ),
    [
      'script("rooms/hall.tease")',
      'next: script("rooms/hall.tease", label: "start")',
      'script("rooms/hall.tease", label: "start")',
      '[script("rooms/hall.tease"), script("rooms/hall.tease", label: "start")]',
      "true",
      "false",
      "2",
      "true",
      "exit",
    ],
  );
});

test("goto, call, and fallback go where a reference in a variable, list, or dict names", () => {
  assert.deepEqual(
    said(
      project(
        [
          'let rooms = [script("rooms/a.tease"), script("rooms/b.tease", label: "back")]',
          'let ends = dict{ "calm": script("ends/calm.tease") }',
          "for room in rooms {",
          "    call (room)",
          "}",
          'fallback (ends["calm"])',
          'let next = script("rooms/hall.tease", label: "start")',
          "goto (next)",
        ].join("\n"),
        {
          "rooms/a.tease": 'say "a"\nend',
          "rooms/b.tease": 'say "b, skipped"\nlabel back\nsay "b"\nend',
          "rooms/hall.tease": 'say "hall, skipped"\nlabel start\nsay "hall"\nend',
          "ends/calm.tease": 'say "calm end"\nexit',
        },
      ),
    ),
    ["a", "b", "hall", "calm end", "exit"],
  );
});

test("a reference saved in one session goes to its label in the next", () => {
  // The session that saves the reference shows its label; the one that loads it only sees `load`.
  const room =
    'let mood = "calm"\nlabel late\nsay "late"\nlet count = 3\nsay "count ${count}"\nexit';
  const writer = compiled(
    project('save script("room.tease", label: "late") as "next"\nexit', { "room.tease": room }),
  );
  const saved = run(writer, createImmediatePacingRuntimeSnapshot(writer)).snapshot.scriptStorage;
  assert.deepEqual(saved, [
    { key: "next", value: { kind: "script", path: "room.tease", label: "late" } },
  ]);
  const reader = 'let next = load "next"\ngoto (next)';
  assert.deepEqual(said(project(reader, { "room.tease": room }), { scriptStorage: saved }), [
    "late",
    "count 3",
    "exit",
  ]);
});

test("a computed target that names no file, no label, or a file that runs nothing fails when it runs", () => {
  const others = { ...HALL, "helpers.tease": 'function greet { say "hi" }' };
  const failure = (main: string): string[] => ran(project(main, others));
  assert.deepEqual(failure('let room = "cellar"\ngoto script("rooms/${room}.tease")'), [
    `failure TSR069: This goto names the file 'rooms/cellar.tease', but the project has no such file. Paths start at the package root, such as "rooms/hall.tease".`,
  ]);
  assert.deepEqual(
    failure('let name = "finish"\ncall script("rooms/hall.tease", label: name)\nexit'),
    [
      "failure TSR069: This call names label 'finish' of 'rooms/hall.tease', but that file has no such label.",
    ],
  );
  for (const transfer of ["goto (next)", "fallback (next)\nend"]) {
    assert.deepEqual(failure(`let path = "helpers.tease"\nlet next = script(path)\n${transfer}`), [
      "failure TSR069: 'helpers.tease' holds declarations only and runs nothing, so going there would end nowhere. Call its functions instead.",
    ]);
  }
  // Calling such a file runs nothing and returns at once.
  assert.deepEqual(failure('let path = "helpers.tease"\ncall script(path)\nsay "back"\nexit'), [
    "back",
    "exit",
  ]);
  // A loaded value that is not a reference is no target.
  assert.deepEqual(failure('let next = load "next"\ngoto (next)'), [
    "failure TSR058: goto needs a script reference here, made with script(...), but this is null.",
  ]);
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
      "'/rooms/hall.tease' is not a package file path: it has an empty folder name; separate folders with a single /.",
    ],
  ]);
  assert.deepEqual(check('let next = script("rooms/hall.tease", label: "finish")\nexit'), [
    ["TSV051", "'rooms/hall.tease' has no label 'finish'."],
  ]);
  assert.deepEqual(check('let next = script("rooms/*.tease")\nexit'), [
    [
      "TSV057",
      'A glob cannot be inside script(...). To pick a random file, write goto "rooms/*.tease" directly.',
    ],
  ]);
  assert.deepEqual(check('call script("rooms/*.tease", label: "start")\nexit'), [
    [
      "TSV057",
      'A glob cannot be inside script(...). To pick a random file, write call "rooms/*.tease" start directly.',
    ],
  ]);
  // Going to a file of declarations only would end nowhere; calling it is fine, as for a literal target.
  for (const transfer of [
    'goto script("helpers.tease")',
    'fallback (script("helpers.tease"))\nexit',
  ])
    assert.deepEqual(check(transfer), [
      [
        "TSV057",
        "'helpers.tease' holds declarations only and runs nothing, so going there would end nowhere. Call its functions instead.",
      ],
    ]);
  assert.deepEqual(
    check('call script("helpers.tease")\nlet later = script("helpers.tease")\nexit'),
    [],
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
    [
      "TSV020",
      'script(...) takes 1 argument (path), received 2. Name a label with label:, as in script("rooms/hall.tease", label: "start").',
    ],
  ]);
  assert.deepEqual(check('let next = script(1, at: "start")\nexit'), [
    [
      "TSV043",
      "script(...) takes the path of a file as text (string), but this is a whole number (integer).",
    ],
    ["TSV022", "script(...) has no parameter 'at'; its only named argument is label:."],
  ]);
  // A button cannot return a reference.
  assert.deepEqual(check('let next = choose script("rooms/hall.tease"), "stay"\nexit'), [
    [
      "TSV029",
      "A button cannot return a script reference. Give the buttons text or number values, and pick the script reference from the answer.",
    ],
  ]);
});

test("script(...) marks the labels it may enter afresh by whether its path and label are literal text", () => {
  // Main reads x after label again, so x has no value when main is entered there.
  const main = 'let x = 1\nlabel again\nsay x\ngoto "other.tease"';
  const codes = (other: string): string[] =>
    diagnostics(project(main, { "other.tease": other, "else.tease": "label again\nexit" })).map(
      ([path, code]) => `${path} ${code}`,
    );
  // A literal path and label enter that label.
  assert.deepEqual(codes('let next = script("main.tease", label: "again")\nexit'), [
    "main.tease TSV054",
  ]);
  // A literal path alone enters the file's top.
  assert.deepEqual(codes('let next = script("main.tease")\nexit'), []);
  // A computed path with a literal label enters that label of every file that has it.
  assert.deepEqual(
    codes('let path = "else.tease"\nlet next = script(path, label: "again")\nexit'),
    ["main.tease TSV054"],
  );
  // A computed label enters every label of the files the path names: here only else.tease, then any file.
  const name = 'let name = "again"\n';
  assert.deepEqual(codes(`${name}let next = script("else.tease", label: name)\nexit`), []);
  assert.deepEqual(codes(`${name}let next = script("main.tease", label: name)\nexit`), [
    "main.tease TSV054",
  ]);
  assert.deepEqual(codes(`${name}let path = "x"\nlet next = script(path, label: name)\nexit`), [
    "main.tease TSV054",
  ]);
  // A grouped target adds nothing by itself: its reference came from a script(...) or from load.
  assert.deepEqual(codes('let next = load "next", default: script("main.tease")\ngoto (next)'), []);
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

test("restore accepts a fallback that a computed fallback resolved to", () => {
  const files = project(
    [
      'let next = script("rooms/hall.tease", label: "start")',
      "fallback (next)",
      'call "rooms/hall.tease"',
      "end",
    ].join("\n"),
    {
      "rooms/hall.tease": "wait 1\nend\nlabel start\nexit",
      "helpers.tease": 'function greet { say "hi" }',
    },
  );
  const plan = compiled(files);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  const hall = plan.files.findIndex((file) => file.path === "rooms/hall.tease");
  const helpers = plan.files.findIndex((file) => file.path === "helpers.tease");
  assert.deepEqual(waiting.fallback, {
    file: hall,
    target: plan.files[hall]!.labels[0]!.instruction,
  });
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  const errors = (change: (snapshot: Mutable<RuntimeSnapshot>) => void): readonly string[] => {
    // EVIDENCE: structuredClone preserves the runtime snapshot shape while each fixture breaks one field.
    const snapshot = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
    change(snapshot);
    return validateRuntimeSnapshot(snapshot, plan).errors;
  };
  // A computed fallback may have resolved to any file's entry or label, but not into a file that runs nothing.
  assert.deepEqual(
    errors((snapshot) => {
      snapshot.fallback = { file: 0, target: plan.files[0]!.entryInstruction };
    }),
    [],
  );
  // The closing end of a file's root region is neither its entry nor a label.
  const inside = plan.files[hall]!.rootEndInstruction - 1;
  for (const fallback of [
    { file: helpers, target: plan.files[helpers]!.entryInstruction },
    { file: hall, target: inside },
  ])
    assert.deepEqual(
      errors((snapshot) => {
        snapshot.fallback = fallback;
      }),
      ["Runtime fallback is malformed."],
    );
  // Without a computed fallback, the fallback is still exactly the destination of a fallback statement.
  const literal = compiled(
    project('fallback "rooms/hall.tease" start\ncall "rooms/hall.tease"\nend', {
      "rooms/hall.tease": "wait 1\nend\nlabel start\nexit",
    }),
  );
  const literalWaiting = run(literal, createImmediatePacingRuntimeSnapshot(literal)).snapshot;
  assert.deepEqual(validateRuntimeSnapshot(literalWaiting, literal).errors, []);
  assert.deepEqual(
    validateRuntimeSnapshot(
      { ...literalWaiting, fallback: { file: 0, target: literal.files[0]!.entryInstruction } },
      literal,
    ).errors,
    ["Runtime fallback is malformed."],
  );
});

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
    ? Array<Mutable<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;
