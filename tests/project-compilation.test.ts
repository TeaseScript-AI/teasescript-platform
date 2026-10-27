import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource, type ProjectSourceFile } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  deserializeCheckpoint,
  createCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-construction.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-validation.js";

/** The plan of a project whose only diagnostics are the TSV065 warnings of the files in `unstarted`, which nothing starts. */
function compiledPlan(
  files: readonly ProjectSourceFile[],
  unstarted: readonly string[] = [],
): InstructionPlan {
  const result = compileProject(files);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
    unstarted.map((path) => [path, "TSV065"]),
  );
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function diagnostics(files: readonly ProjectSourceFile[]): [string, string, string][] {
  return compileProject(files).diagnostics.map((diagnostic) => [
    diagnostic.path,
    diagnostic.code,
    diagnostic.message,
  ]);
}

const twoFiles = [
  { path: "rooms/hall.tease", source: 'function greet { say "hall" }\ngreet()\nexit' },
  { path: "main.tease", source: 'function greet { say "main" }\ngreet()\nexit' },
  { path: "intro.tease", source: 'let visits = 1\nsay "intro ${visits}"\nexit' },
] as const;

test("a project compiles into one plan: main.tease first, then the other files by path", () => {
  const result = compileProject(twoFiles);
  // main.tease starts neither other file, so their code never runs.
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.path,
      diagnostic.span.start.line,
      diagnostic.code,
      diagnostic.message,
    ]),
    ["intro.tease", "rooms/hall.tease"].map((path) => [
      path,
      path === "intro.tease" ? 0 : 1,
      "TSV065",
      `The code of '${path}' never runs, because no 'goto' or 'call' that can run starts the file. Remove the file, or start the file with a 'goto' or 'call'.`,
    ]),
  );
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["main.tease", "intro.tease", "rooms/hall.tease"],
  );
  const plan = result.plan!;
  assert.deepEqual(
    plan.files.map((file) => file.path),
    ["main.tease", "intro.tease", "rooms/hall.tease"],
  );
  // Each file is one block: its root region, then its own functions.
  plan.files.forEach((file, index) => {
    assert.equal(file.startInstruction, index === 0 ? 0 : plan.files[index - 1]!.endInstruction);
    const functions = plan.functions.filter(
      (definition) =>
        definition.entryInstruction >= file.startInstruction &&
        definition.endInstruction <= file.endInstruction,
    );
    assert.deepEqual(
      functions.map((definition) => definition.name),
      file.path === "intro.tease" ? [] : ["greet"],
    );
    assert.ok(
      functions.every((definition) => definition.entryInstruction >= file.rootEndInstruction),
    );
  });
  assert.equal(plan.files.at(-1)!.endInstruction, plan.instructions.length);
  assert.equal(validateInstructionPlan(plan).valid, true);

  // A single source is the main.tease of a one-file project.
  const single = compileSource('say "hi"\nexit').plan!;
  assert.deepEqual(
    single.files.map((file) => [file.path, file.startInstruction, file.endInstruction]),
    [["main.tease", 0, single.instructions.length]],
  );
});

test("functions and top-level variables belong to their file", () => {
  assert.deepEqual(
    diagnostics([
      { path: "main.tease", source: "say visits\nexit" },
      { path: "intro.tease", source: "let visits = 1\ngreet()\nexit" },
      { path: "rooms/hall.tease", source: 'function greet { say "hall" }\nexit' },
    ]).map(([path, code]) => [path, code]),
    [
      ["main.tease", "TSV002"],
      ["intro.tease", "TSV018"],
    ],
  );
});

test("each diagnostic names its file, and an error in any file leaves no plan", () => {
  const result = compileProject([
    { path: "main.tease", source: 'say "fine"\nexit' },
    { path: "rooms/hall.tease", source: "say (\nexit" },
  ]);
  assert.equal(result.plan, null);
  assert.deepEqual(result.files[0]!.diagnostics, []);
  assert.ok(result.diagnostics.length > 0);
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.path === "rooms/hall.tease"));
  assert.deepEqual(
    result.files[1]!.diagnostics,
    result.diagnostics.map(({ path: _path, ...rest }) => rest),
  );
});

test("the session starts in main.tease and never runs into the next file", () => {
  const plan = compiledPlan(
    [
      { path: "main.tease", source: 'say "main"\nexit' },
      { path: "after.tease", source: 'say "after"\nexit' },
    ],
    ["after.tease"],
  );
  const finished = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.deepEqual(
    finished.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["main"],
  );
  assert.equal(finished.snapshot.status, "halted");

  // The checkpoint carries the whole project plan.
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, finished.snapshot)),
  );
  assert.deepEqual(restored.plan, plan);
});

test("the file list needs main.tease and unique package paths", () => {
  const source = 'say "x"\nexit';
  assert.deepEqual(
    diagnostics([
      { path: "rooms/hall.tease", source },
      { path: "rooms/hall.tease", source },
      { path: "rooms/hall.tease", source },
      { path: "/abs.tease", source },
      { path: "a//b.tease", source },
      { path: "../up.tease", source },
      { path: "./main.tease", source },
      { path: "a\\b.tease", source },
      { path: "star*.tease", source },
      { path: "notes.txt", source },
      { path: "rooms/.tease", source },
      { path: "bad\u0007.tease", source },
    ]).map(([path, code, message]) => [path, code, message]),
    [
      ["rooms/hall.tease", "TSC009", "The project has more than one file 'rooms/hall.tease'."],
      [
        "/abs.tease",
        "TSC009",
        "'/abs.tease' is not a package file path: the path has an empty folder name. Separate folders with a single '/'.",
      ],
      [
        "a//b.tease",
        "TSC009",
        "'a//b.tease' is not a package file path: the path has an empty folder name. Separate folders with a single '/'.",
      ],
      [
        "../up.tease",
        "TSC009",
        "'../up.tease' is not a package file path: paths start at the package root and use no '.' or '..'.",
      ],
      [
        "./main.tease",
        "TSC009",
        "'./main.tease' is not a package file path: paths start at the package root and use no '.' or '..'.",
      ],
      [
        "a\\b.tease",
        "TSC009",
        "'a\\b.tease' is not a package file path: folders are separated with '/', not '\\'.",
      ],
      [
        "star*.tease",
        "TSC009",
        "'star*.tease' is not a package file path: '*' is only allowed in a glob.",
      ],
      [
        "notes.txt",
        "TSC009",
        "'notes.txt' is not a package file path: the path does not name a .tease file.",
      ],
      [
        "rooms/.tease",
        "TSC009",
        "'rooms/.tease' is not a package file path: the path does not name a .tease file.",
      ],
      [
        "bad\u0007.tease",
        "TSC009",
        "'bad\u0007.tease' is not a package file path: the path contains a control character.",
      ],
      ["main.tease", "TSC009", "The project has no main.tease. Every session starts there."],
    ],
  );
  // The remaining valid file is still checked.
  assert.deepEqual(
    compileProject([{ path: "rooms/hall.tease", source: "say (" }]).files.map((file) => [
      file.path,
      file.diagnostics.length > 0,
    ]),
    [["rooms/hall.tease", true]],
  );
});

test("plan validation checks the file table and keeps calls inside their file", () => {
  const plan = compiledPlan(twoFiles, ["intro.tease", "rooms/hall.tease"]);
  const errors = (changed: unknown): string[] =>
    validateInstructionPlan(changed).errors.map((error) => `${error.path} ${error.message}`);
  const files = plan.files;

  const outOfOrder =
    "Plan file paths must be package paths: main.tease first, then the others in order.";
  assert.ok(
    errors({ ...plan, files: [files[1], files[0], files[2]] }).includes(
      `$.files[0].path ${outOfOrder}`,
    ),
  );
  assert.ok(
    errors({ ...plan, files: [files[0], files[2], files[1]] }).includes(
      `$.files[2].path ${outOfOrder}`,
    ),
  );
  assert.equal(
    errors({ ...plan, files: [files[0], files[1]] })[0],
    "$.files Plan files do not cover the instruction stream.",
  );
  assert.equal(errors({ ...plan, files: [] })[0], "$.files Plan files must be a non-empty array.");
  assert.deepEqual(errors({ ...plan, files: [{ ...files[0]!, extra: 1 }, files[1], files[2]] }), [
    "$.files[0].extra Field is not defined by the current instruction-plan version.",
  ]);

  // main's greet() becomes a call of the hall's greet.
  const mainCall = plan.instructions.findIndex(
    (instruction) => instruction.kind === "callFunction",
  );
  const hallGreet = plan.functions.find(
    (definition) => definition.entryInstruction >= files[2]!.startInstruction,
  )!;
  const instructions = plan.instructions.map((instruction, index) =>
    index === mainCall ? { ...instruction, functionId: hallGreet.id } : instruction,
  );
  assert.deepEqual(errors({ ...plan, instructions }), [
    `$.instructions[${mainCall}] An instruction refers to a function of another file.`,
  ]);
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Array<Mutable<Item>>
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function mutableCopy(snapshot: RuntimeSnapshot): Mutable<RuntimeSnapshot> {
  // EVIDENCE: fixture: a JSON round trip of a runtime-produced snapshot keeps its shape for an invalid mutation.
  return JSON.parse(JSON.stringify(snapshot)) as Mutable<RuntimeSnapshot>;
}

test("a checkpoint runs code of a file only in an activation of that file", () => {
  const timers = compiledPlan(
    [
      { path: "main.tease", source: 'timer async 1 s { say "main handler" }\nwait 5 s\nexit' },
      { path: "other.tease", source: 'timer async 1 s { say "other handler" }\nexit' },
    ],
    ["other.tease"],
  );
  const otherStart = timers.files[1]!.startInstruction;
  const foreign = timers.functions.find((definition) => definition.entryInstruction >= otherStart)!;
  const waiting = run(timers, createImmediatePacingRuntimeSnapshot(timers)).snapshot;
  const expired = observeTime(timers, waiting, 1000).snapshot;
  assert.equal(validateRuntimeSnapshot(expired, timers).valid, true);

  // A queued expiry block of another file would run with main.tease's variables.
  const queued = mutableCopy(expired);
  queued.pendingTimerHandlers[0]!.handlerFunctionId = foreign.id;
  assert.equal(validateRuntimeSnapshot(queued, timers).valid, false);
  assert.throws(() =>
    deserializeCheckpoint(
      JSON.stringify({
        format: CHECKPOINT_FORMAT,
        version: CHECKPOINT_VERSION,
        plan: timers,
        snapshot: queued,
      }),
    ),
  );
  // So would a timer that another file's timer statement started in main.tease's activation.
  const active = mutableCopy(waiting);
  const timer = active.backgroundActions.find((action) => action.kind === "timer");
  assert.ok(timer?.kind === "timer");
  timer.owningInstruction = timers.instructions.findIndex(
    (instruction, index) => instruction.kind === "startTimer" && index >= otherStart,
  );
  timer.timer.handlerFunctionId = foreign.id;
  assert.equal(validateRuntimeSnapshot(active, timers).valid, false);

  // And a message paced in another file while main.tease runs.
  const says = compiledPlan(
    [
      { path: "main.tease", source: 'say "main"\nsay "second"\nexit' },
      { path: "other.tease", source: 'say "other"\nsay "other second"\nexit' },
    ],
    ["other.tease"],
  );
  const pacing = run(says, createFreshRuntimeSnapshot(says)).snapshot;
  assert.equal(pacing.status, "waiting");
  const offset = says.files[1]!.startInstruction;
  const moved = mutableCopy(pacing);
  moved.nextInstruction += offset;
  const gate = moved.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  gate!.owningInstruction += offset;
  gate!.continuationInstruction += offset;
  assert.equal(validateRuntimeSnapshot(moved, says).valid, false);
});

test("a host stack failure while the finished plan is validated is still TSC007", () => {
  const original = Object.keys;
  // Fails only where the finished, frozen plan is validated, as a host stack failure would.
  Object.keys = (value: Parameters<typeof original>[0]): string[] => {
    if (
      Object.isFrozen(value) &&
      "format" in value &&
      value.format === "teasescript-instruction-plan"
    ) {
      throw new RangeError("Maximum call stack size exceeded");
    }
    return original(value);
  };
  const source = "let value = 1\nexit";
  let result: ReturnType<typeof compileSource>;
  try {
    result = compileSource(source);
  } finally {
    Object.keys = original;
  }
  assert.equal(result.plan, null);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [["TSC007", 0, source.length]],
  );
});

test("a package file the host could not load is an error where a path written out names it, else a warning", () => {
  const broken = {
    path: "scenes/broken.tease",
    reason:
      "The text of 'scenes/broken.tease' uses a character encoding the Player cannot read. Save the file as UTF-8 in your text editor.",
  };
  const locked = { path: "images/locked.jpg", reason: "'images/locked.jpg' cannot be opened." };
  const bell = {
    path: "sounds/bell*.mp3",
    reason: "The name of 'sounds/bell*.mp3' is not usable.",
  };
  const attic = { path: "attic", folder: true, reason: "The folder 'attic' cannot be opened." };
  const unreadableFiles = [broken, locked, bell, attic];
  const compile = (main: string) =>
    compileProject([{ path: "main.tease", source: main }], { unreadableFiles });
  // Where nothing names them, each is a warning at itself, with the host's reason, and the script compiles.
  const clean = compile("exit");
  assert.notEqual(clean.plan, null);
  assert.deepEqual(
    clean.diagnostics.map(({ path, span, severity, code, message }) => [
      path,
      span.start.line,
      severity,
      code,
      message,
    ]),
    unreadableFiles.map(({ path, reason }) => [path, 0, "warning", "TSC011", reason]),
  );
  // A path or glob written out that names one is an error there instead, also where it never runs.
  for (const [main, file] of [
    ['goto "scenes/broken.tease"', broken],
    ['call "scenes/broken.tease"\nexit', broken],
    ['let next = script("scenes/broken.tease")\nexit', broken],
    ['if false {\n    goto "scenes/*.tease"\n}\nexit', broken],
    ['let found = findScripts(from: "scenes/*.tease")\nexit', broken],
    ['showImage "images/locked.jpg"\nexit', locked],
    ['playAudio async "sounds/bell*.mp3"\nexit', bell],
    // A folder may hold the file that a path or glob names.
    ['goto "attic/old.tease"', attic],
    ['call "*/old.tease"\nexit', attic],
    ['showImage "attic/photos/old.jpg"\nexit', attic],
  ] as const) {
    const result = compile(main);
    assert.equal(result.plan, null, main);
    assert.deepEqual(
      result.diagnostics.map(({ path, severity, code, message }) => [
        path,
        severity,
        code,
        message,
      ]),
      [
        ...unreadableFiles
          .filter((other) => other !== file)
          .map(({ path, reason }) => [path, "warning", "TSC011", reason]),
        ["main.tease", "error", "TSC011", file.reason],
      ],
      main,
    );
  }
  // A media path is not a glob, and a glob names only the files it matches.
  assert.deepEqual(
    compile('playAudio async "sounds/bell.mp3"\nshowImage "images/*.jpg"\nexit').diagnostics.map(
      ({ path, code }) => `${path} ${code}`,
    ),
    unreadableFiles.map(({ path }) => `${path} TSC011`),
  );
  // Every session starts at main.tease, so a main.tease the host could not load is an error, also in a folder it could
  // not read.
  for (const main of [
    { path: "main.tease", reason: "The text of 'main.tease' cannot be read." },
    { path: ".", folder: true, reason: "The package folder cannot be opened." },
  ])
    assert.deepEqual(
      compileProject([], { unreadableFiles: [main] }).diagnostics.map(
        ({ path, severity, code, message }) => [path, severity, code, message],
      ),
      [["main.tease", "error", "TSC011", main.reason]],
    );
});
