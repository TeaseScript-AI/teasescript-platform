import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, type ProjectSourceFile } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  createCheckpoint,
  deserializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

function compiledPlan(
  files: readonly ProjectSourceFile[],
  options: { readonly globals?: readonly string[] } = {},
): InstructionPlan {
  const result = compileProject(files, options);
  assert.deepEqual(result.diagnostics, []);
  return result.plan!;
}

/** Each diagnostic as its file, code, and one-based line. */
function diagnostics(
  files: readonly ProjectSourceFile[],
  options: { readonly globals?: readonly string[] } = {},
): [string, string, number][] {
  return compileProject(files, options).diagnostics.map((diagnostic) => [
    diagnostic.path,
    diagnostic.code,
    diagnostic.span.start.line + 1,
  ]);
}

function messages(files: readonly ProjectSourceFile[]): string[] {
  return compileProject(files).diagnostics.map((diagnostic) => diagnostic.message);
}

/** What each `say` shows, prefixed with its explicit speaker's name. */
function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "say"
      ? [event.speaker === null ? event.text : `${event.speaker.displayName}: ${event.text}`]
      : [],
  );
}

function runToEnd(
  plan: InstructionPlan,
  options: Parameters<typeof createImmediatePacingRuntimeSnapshot>[1] = {},
) {
  return run(plan, createImmediatePacingRuntimeSnapshot(plan, options));
}

/** A compiled plan as external JSON data, which a fixture may change in ways its type excludes. */
interface ExternalPlan {
  instructions: ExternalInstruction[];
  readonly [field: string]: unknown;
}

interface ExternalInstruction {
  value?: unknown;
  properties?: { value: unknown }[];
  readonly [field: string]: unknown;
}

function externalPlan(plan: InstructionPlan): ExternalPlan {
  // EVIDENCE: fixture: a JSON round trip of a compiled plan keeps its instructions and their properties as objects.
  return JSON.parse(JSON.stringify(plan)) as ExternalPlan;
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Array<Mutable<Item>>
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function mutableCopy<T>(value: T): Mutable<T> {
  // EVIDENCE: fixture: a JSON round trip of runtime-produced data keeps its shape for an invalid mutation.
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

test("globals and speakers are set up before the story: main.tease first, then by path, in source order", () => {
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: [
        'say "${first} ${second} ${third} ${fromHandler} ${host.lastName}"',
        "first = 7",
        "again()",
        'say "${first}"',
        "exit",
        "function again {",
        "  global first = 1",
        "}",
      ].join("\n"),
    },
    {
      path: "b.tease",
      source: [
        'speaker host { lastName: "Second is ${second}" }',
        "function never {",
        "  global third = first + second",
        "}",
      ].join("\n"),
    },
    {
      path: "a.tease",
      source: [
        "if false {",
        "  global second = first + 1",
        "}",
        'timer async 1 { global fromHandler = "h" }',
        "end",
      ].join("\n"),
    },
  ]);
  const result = runToEnd(plan);
  assert.equal(result.snapshot.status, "halted");
  // Every declaration has its value before main.tease starts, though no other file and no block around them ran.
  assert.deepEqual(said(result.events), ["1 2 3 h Second is 2", "7"]);
  // Reaching a declaration later does nothing.
  assert.deepEqual(
    result.snapshot.globals.map((binding) => binding.name),
    ["first", "second", "fromHandler", "host", "third"],
  );
});

test("a start value uses only literals, earlier globals, operators, and load", () => {
  assert.deepEqual(
    diagnostics([
      {
        path: "main.tease",
        source: [
          "global early = later + 1",
          "global itself = itself",
          "global rolled = random()",
          'global asked = askText "Name?"',
          "global timed = timer async 5",
          'global lazy = load "k", default: helper()',
          "global either = false or chance(50)",
          "function helper { return 1 }",
          "let local = 2",
          "global fromLocal = local",
          "speaker vera { firstName: local }",
          "exit",
        ].join("\n"),
      },
      { path: "b.tease", source: "global later = 1" },
    ]),
    [
      ["main.tease", "TSV055", 1],
      ["main.tease", "TSV055", 2],
      ["main.tease", "TSV055", 3],
      ["main.tease", "TSV055", 4],
      ["main.tease", "TSV055", 5],
      ["main.tease", "TSV055", 6],
      ["main.tease", "TSV055", 7],
      ["main.tease", "TSV055", 10],
      ["main.tease", "TSV055", 11],
    ],
  );
  assert.deepEqual(
    messages([{ path: "main.tease", source: "global early = later\nglobal later = 1\nexit" }]),
    [
      "The start value of global 'early' cannot use 'later', which gets its value later: globals and speakers are set up in order, main.tease first, then the other files by path, each from top to bottom. Declare 'later' before 'early'.",
    ],
  );
  // Selecting at random is rejected where the type shows a list, and at runtime otherwise.
  assert.deepEqual(
    diagnostics([
      {
        path: "main.tease",
        source:
          'global picks = [1, 2]\nglobal pick = picks.random\nglobal shown = "${picks}"\nexit',
      },
    ]),
    [
      ["main.tease", "TSV055", 2],
      ["main.tease", "TSV055", 3],
    ],
  );
  const unknown = runToEnd(
    compiledPlan([
      { path: "main.tease", source: 'global pick = (load "picks", default: [1, 2]).random\nexit' },
    ]),
  );
  assert.equal(unknown.snapshot.failure?.code, "TSR067");

  // Earlier globals, operators, and load with its default are fine.
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: [
        "global base = 2",
        'global level = load "level", default: base',
        "global doubled = level * 2 + base",
        'global caption = "Level ${level} of ${[1, 2, 3].length}"',
        'say "${caption} ${doubled}"',
        "exit",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(said(runToEnd(plan).events), ["Level 2 of 3 6"]);
  assert.deepEqual(said(runToEnd(plan, { scriptStorage: [{ key: "level", value: 5 }] }).events), [
    "Level 5 of 3 12",
  ]);
});

test("a global with default: starts with that value and assigns its value where it stands", () => {
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: [
        'say "start ${attempts} ${level}"',
        "practice(3)",
        "practice(4)",
        'say "now ${attempts} ${level}"',
        "exit",
        "function practice(count) {",
        "  let localCount = count * 2",
        "  global attempts = localCount, default: 0",
        // The default belongs to the nearest construct that takes one: here the load.
        '  global level = load "level", default: 1',
        "  level = level + 10",
        "}",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(said(runToEnd(plan, { scriptStorage: [{ key: "level", value: 5 }] }).events), [
    "start 0 5",
    "now 8 25",
  ]);

  // Without default:, a local value is an error that explains both fixes.
  assert.deepEqual(
    messages([
      {
        path: "main.tease",
        source: [
          "function practice {",
          '  let localCount = askInteger "How many did you do?"',
          "  global attempts = localCount",
          "}",
          "exit",
        ].join("\n"),
      },
    ]),
    [
      "Global 'attempts' needs a value from the start of the session, before the story runs, so it cannot start with 'localCount'. Add a start value, as in 'global attempts = localCount, default: 0', or write 'global attempts = 0' and later 'attempts = localCount'.",
    ],
  );
  // The default of an ask is the ask's, so the start value would ask the player; grouping gives it to the global.
  assert.deepEqual(
    diagnostics([
      { path: "main.tease", source: 'global name = askText "Name?", default: "nobody"\nexit' },
    ]),
    [["main.tease", "TSV055", 1]],
  );
  assert.deepEqual(
    diagnostics([
      { path: "main.tease", source: 'global name = (askText "Name?"), default: "nobody"\nexit' },
    ]),
    [],
  );
});

test("globals follow the let type rules with one type environment for all files", () => {
  assert.deepEqual(
    messages([
      { path: "main.tease", source: "global best = null\nsetBest()\nbest = 5\nexit" },
      { path: "b.tease", source: 'global function setBest {\n  best = "Ada"\n}' },
    ]),
    [
      "'best' holds text (string) or null since line 2 of b.tease, so it cannot be set to a whole number (integer). To show it as text, write \"${5}\".",
    ],
  );
  // An assignment in another file makes an integer global a number everywhere.
  assert.deepEqual(
    messages([
      {
        path: "main.tease",
        source: 'global speed = 1\nlet items = [1, 2, 3]\nsay "${items[speed]}"\nexit',
      },
      { path: "b.tease", source: "global function faster {\n  speed = speed * 1.5\n}" },
    ]),
    [
      "A list index must be a whole number (integer), but this is a number. 'speed' is a number because line 2 of b.tease can store a non-whole number in it. Round it with floor(...), round(...), or ceil(...).",
    ],
  );
  // A start value narrows like a let: the start values after it and main.tease's top level know what it stored, until
  // a call may change it. A suggested declaration keeps the global a global.
  assert.deepEqual(
    said(
      runToEnd(
        compiledPlan([
          {
            path: "main.tease",
            source:
              'global reward: integer | string = 1\nglobal next = reward + 1\nsay "${reward + 1} ${next}"\nexit',
          },
        ]),
      ).events,
    ),
    ["2 2"],
  );
  assert.deepEqual(
    diagnostics([
      {
        path: "main.tease",
        source: 'global reward: integer | string = 1\nchange()\nsay "${reward + 1}"\nexit',
      },
      { path: "b.tease", source: 'global function change {\n  reward = "high"\n}' },
    ]),
    [["main.tease", "TSV043", 3]],
  );
  assert.deepEqual(messages([{ path: "main.tease", source: "global x = 1\nx = null\nexit" }]), [
    "'x' holds a whole number (integer), so it cannot be set to null. To allow null, declare it as 'global x: integer? = ...'.",
  ]);

  // A declared type is checked at runtime for a value the compiler cannot know.
  const typed = compiledPlan([
    { path: "main.tease", source: 'global level: integer = load "level", default: 1\nexit' },
  ]);
  assert.equal(runToEnd(typed).snapshot.status, "halted");
  assert.equal(
    runToEnd(typed, { scriptStorage: [{ key: "level", value: "high" }] }).snapshot.failure?.code,
    "TSR058",
  );
});

test("a global function is callable from every file and sees only globals, its parameters, and its locals", () => {
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: 'let tmp = "main"\nsay countdown(2)\nsay "${tmp} ${total}"\nexit',
    },
    {
      path: "lib/count.tease",
      source: [
        "global total = 0",
        "global function countdown(n) {",
        "  let tmp = n",
        "  total += tmp",
        "  announce(n)",
        '  if n == 0 { return "done" }',
        "  return countdown(n - 1)",
        "}",
      ].join("\n"),
    },
    {
      path: "lib/voice.tease",
      source:
        'speaker vera { displayName: "Vera" }\nglobal function announce(n) {\n  say as vera "${n}"\n}',
    },
  ]);
  assert.deepEqual(said(runToEnd(plan).events), [
    "Vera: 2",
    "Vera: 1",
    "Vera: 0",
    "done",
    "main 3",
  ]);
  const [lib] = plan.functions.filter((definition) => definition.name === "countdown");
  assert.equal(lib?.global, true);

  assert.deepEqual(
    messages([
      {
        path: "main.tease",
        source: [
          "let secret = 1",
          "function helper { }",
          "global function punish(count) {",
          '  say "${secret}"',
          "  helper()",
          "}",
          "exit",
        ].join("\n"),
      },
    ]),
    [
      "Global function 'punish' can be called from any file, so it cannot use 'secret' of this file. Make 'secret' a global, or pass it as a parameter.",
      "Global function 'punish' can be called from any file, so it can call only global functions and built-ins, not 'helper' of this file. Make 'helper' a global function.",
    ],
  );
  // A global function's name is the project's: a function, variable, or parameter of that name is an error at both places.
  assert.deepEqual(
    diagnostics([
      { path: "main.tease", source: "global function punish { }\nexit" },
      {
        path: "other.tease",
        source: "function punish { }\nlet punish = 1\nfunction count(punish) { }",
      },
    ]),
    [
      ["main.tease", "TSV001", 1],
      ["main.tease", "TSV001", 1],
      ["main.tease", "TSV001", 1],
      ["other.tease", "TSV001", 1],
      ["other.tease", "TSV001", 2],
      ["other.tease", "TSV001", 3],
    ],
  );
  assert.deepEqual(
    messages([
      { path: "main.tease", source: "global function punish { }\nexit" },
      { path: "other.tease", source: "function punish { }" },
    ]),
    [
      "The global function 'punish' has the same name as the function on line 1 of other.tease. Globals, global functions, and speakers need a name of their own in the whole project; rename one of them.",
      "'punish' is already the name of the global function on line 1 of main.tease. Globals, global functions, and speakers need a name of their own in the whole project; rename one of them.",
    ],
  );
});

test("speakers are global: declared anywhere in any file and known in every file", () => {
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: [
        "speaker vera",
        'say "Hello"',
        'say as cashier "Ask ${vera.firstName}"',
        "exit",
      ].join("\n"),
    },
    {
      path: "people.tease",
      source: [
        'global shop = "Corner"',
        "if false {",
        '  speaker vera { displayName: "Vera"\n    firstName: "Vera" }',
        "}",
        'speaker cashier { displayName: "${shop} cashier" }',
        "end",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(said(runToEnd(plan).events), ["Vera: Hello", "Corner cashier: Ask Vera"]);

  // A global is not a variable of its file: it has its value before any goto, unlike a skipped let.
  assert.deepEqual(
    diagnostics([
      {
        path: "main.tease",
        source: 'goto later\nlet n = 1\nglobal g = 1\nlabel later\nsay "${g}"\nexit',
      },
    ]),
    [],
  );
  assert.deepEqual(
    diagnostics([
      { path: "main.tease", source: 'goto later\nlet n = 1\nlabel later\nsay "${n}"\nexit' },
    ]),
    [["main.tease", "TSV054", 4]],
  );

  // A file of declarations only runs nothing, so it needs no ending; a global with default: assigns where it stands.
  const main = { path: "main.tease", source: 'say "${shop}"\nexit' };
  assert.deepEqual(
    diagnostics([
      main,
      {
        path: "shop.tease",
        source: 'global shop = "Corner"\nspeaker clerk { }\nglobal function greet { }',
      },
    ]),
    [],
  );
  assert.deepEqual(
    diagnostics([
      main,
      { path: "shop.tease", source: 'global shop = "Corner"\nglobal sign = shop, default: ""' },
    ]),
    [["shop.tease", "TSV052", 2]],
  );

  // Two speakers of one name are an error at both places, also in sibling blocks.
  assert.deepEqual(
    diagnostics([
      { path: "main.tease", source: "if true { speaker voice { } }\nexit" },
      { path: "other.tease", source: "if true { speaker voice { } }" },
    ]),
    [
      ["main.tease", "TSV001", 1],
      ["other.tease", "TSV001", 1],
    ],
  );
});

test("checkpoints restore in the middle of startup and after it", () => {
  const files = [
    {
      path: "main.tease",
      source:
        'global rounds = 2\nsay as vera "Start ${rounds}"\npractice(rounds)\nsay "Score ${score}"\nexit',
    },
    {
      path: "lib.tease",
      source: [
        'speaker vera { displayName: "Vera" }',
        "global score = rounds * 10",
        "global function practice(times) {",
        "  repeat times {",
        "    wait 1",
        "    score += 1",
        "  }",
        "  timer async 1 { score += 100 }",
        "  wait 2",
        "}",
      ].join("\n"),
    },
  ];
  const { boundaries, events } = assertRuntimeResumeEquivalent(files);
  assert.deepEqual(said(events), ["Vera: Start 2", "Score 122"]);
  // The fresh state and the boundaries after the first two of the three start values are inside the startup.
  assert.deepEqual(
    boundaries.slice(0, 3).map((snapshot) => snapshot.globals.map((binding) => binding.name)),
    [["rounds"], ["rounds", "vera"], ["rounds", "vera", "score"]],
  );
});

test("plan validation keeps the startup at the start of main.tease and calls of other files to global functions", () => {
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: "global a = 1\nglobal b = 2\nlocal()\nshared()\nexit\nfunction local { }",
    },
    {
      path: "lib.tease",
      source: "function helper { }\nglobal function shared {\n  timer async 1 { }\n}",
    },
  ]);
  assert.equal(validateInstructionPlan(plan).valid, true);
  const errors = (changed: unknown): string[] =>
    validateInstructionPlan(changed).errors.map((error) => `${error.path} ${error.message}`);
  const withInstruction = (index: number, change: Record<string, unknown>) => ({
    ...plan,
    instructions: plan.instructions.map((instruction, at) =>
      at === index ? { ...instruction, ...change } : instruction,
    ),
  });
  const withFunction = (id: number, change: Record<string, unknown>) => ({
    ...plan,
    functions: plan.functions.map((definition) =>
      definition.id === id ? { ...definition, ...change } : definition,
    ),
  });
  const id = (name: string) => plan.functions.find((definition) => definition.name === name)!.id;

  assert.deepEqual(errors(withInstruction(1, { name: "a" })), [
    "$.instructions[1].name Each global and speaker is set up once.",
  ]);
  assert.deepEqual(errors(withInstruction(0, { file: 2 })), [
    "$.instructions[0].file The source file of a start value is invalid.",
  ]);
  const moved = {
    ...plan,
    instructions: [plan.instructions[1], plan.instructions[2], plan.instructions[0]],
  };
  assert.ok(
    errors({
      ...moved,
      instructions: [...moved.instructions, ...plan.instructions.slice(3)],
    }).includes(
      "$.instructions[2] Globals and speakers are set up only at the start of main.tease.",
    ),
  );
  assert.deepEqual(errors(withFunction(id("helper"), { global: "yes" })), [
    `$.functions[${id("helper") - 1}].global Function global must be a boolean.`,
  ]);

  // main.tease may call a global function of another file, but no other function of it.
  const call = (name: string) =>
    plan.instructions.findIndex(
      (instruction) => instruction.kind === "callFunction" && instruction.functionId === id(name),
    );
  assert.deepEqual(errors(withInstruction(call("shared"), { functionId: id("helper") })), [
    `$.instructions[${call("shared")}] An instruction refers to a function of another file.`,
  ]);
  // A global function calls only global functions, and its timer block is global with it.
  const sharedEntry = plan.functions.find((definition) => definition.id === id("shared"))!;
  const helperCall = { ...plan.instructions[call("local")]!, functionId: id("helper") };
  assert.ok(
    errors({
      ...plan,
      instructions: plan.instructions.map((instruction, index) =>
        index === sharedEntry.bodyEntryInstruction
          ? { ...helperCall, returnInstruction: index + 1 }
          : instruction,
      ),
    }).includes(
      `$.instructions[${sharedEntry.bodyEntryInstruction}] A global function calls a function that is not global.`,
    ),
  );
  const handler = plan.functions.find((definition) => definition.handler === "timer")!;
  assert.equal(handler.global, true);
  const start = plan.instructions.findIndex((instruction) => instruction.kind === "startTimer");
  assert.deepEqual(errors(withFunction(handler.id, { global: false })), [
    `$.instructions[${start}] A handler is global exactly when the code that registers it is.`,
  ]);
});

test("a plan sets up its globals once, with start values of the accepted kinds", () => {
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: 'global items = [1]\nspeaker vera { firstName: "V" }\nglobal level = 2\nexit',
    },
  ]);
  const fresh = createFreshRuntimeSnapshot(plan);
  // A rejected plan fails at the plan and checkpoint boundaries, before anything runs.
  const rejected = (changed: ExternalPlan): string[] => {
    assert.throws(() =>
      deserializeCheckpoint(
        JSON.stringify({
          format: CHECKPOINT_FORMAT,
          version: CHECKPOINT_VERSION,
          plan: changed,
          snapshot: fresh,
        }),
      ),
    );
    return validateInstructionPlan(changed).errors.map((error) => `${error.path} ${error.message}`);
  };
  const span = plan.instructions[0]!.span;
  const call = (callee: unknown, args: unknown[] = []) => ({
    kind: "call",
    callee,
    arguments: args,
    span,
  });
  const bump = call({ kind: "identifier", name: "bump", span });
  const changed = (index: number, change: (instruction: ExternalInstruction) => void) => {
    const copy = externalPlan(plan);
    change(copy.instructions[index]!);
    return copy;
  };
  const startValue =
    "A start value uses only literals, globals set up before it, operators, and load.";

  // No control flow returns into the startup, which would set a global up again.
  const loop = externalPlan(plan);
  loop.instructions[3] = { kind: "jump", target: 0, span };
  assert.deepEqual(rejected(loop), [
    "$.instructions[3].target Control flow cannot lead back into the start of main.tease, which sets up the globals once.",
  ]);
  // A start value calls nothing: no host builtin, and no method that changes an earlier global.
  assert.deepEqual(
    rejected(
      changed(0, (instruction) => {
        instruction.value = bump;
      }),
    ),
    [`$.instructions[0].value ${startValue}`],
  );
  const add = call(
    { kind: "property", object: { kind: "identifier", name: "items", span }, name: "add", span },
    [{ kind: "positional", value: { kind: "literal", value: 2, span }, span }],
  );
  assert.deepEqual(
    rejected(
      changed(2, (instruction) => {
        instruction.value = add;
      }),
    ),
    [`$.instructions[2].value ${startValue}`],
  );
  // The same holds for speaker properties and for the lazy default of a load.
  assert.deepEqual(
    rejected(
      changed(1, (instruction) => {
        instruction.properties![0]!.value = bump;
      }),
    ),
    [`$.instructions[1].properties[0].value ${startValue}`],
  );
  assert.deepEqual(
    rejected(
      changed(2, (instruction) => {
        instruction.value = {
          kind: "storageLoad",
          key: { kind: "literal", value: "level", span },
          default: bump,
          span,
        };
      }),
    ),
    [`$.instructions[2].value ${startValue}`],
  );
  // A start value reads only globals set up before it; a speaker's properties may read the speaker.
  assert.deepEqual(
    rejected(
      changed(0, (instruction) => {
        instruction.value = { kind: "identifier", name: "level", span };
      }),
    ),
    [`$.instructions[0].value ${startValue}`],
  );
  const self = changed(1, (instruction) => {
    instruction.properties![0]!.value = { kind: "identifier", name: "vera", span };
  });
  assert.deepEqual(validateInstructionPlan(self).errors, []);

  // A label and a goto of main.tease stand after the startup.
  const labelled = compiledPlan([
    { path: "main.tease", source: "global g = 1\nlabel again\nif false { goto again }\nexit" },
  ]);
  const goto = labelled.instructions.findIndex((instruction) => instruction.kind === "goto");
  const back = externalPlan(labelled);
  back.instructions[goto] = { ...back.instructions[goto]!, target: 0 };
  assert.ok(
    rejected(back).includes(
      `$.instructions[${goto}].target Control flow cannot lead back into the start of main.tease, which sets up the globals once.`,
    ),
  );
  const early = externalPlan(labelled);
  // EVIDENCE: fixture: the JSON copy of a compiled plan keeps its file table with each file's labels.
  const files = early.files as { labels: { instruction: number }[] }[];
  files[0]!.labels[0]!.instruction = 0;
  assert.ok(
    rejected(early).includes(
      "$.files[0].labels A label cannot stand in the start of main.tease, which sets up the globals once.",
    ),
  );
});

test("a snapshot keeps the startup a phase of its own, before anything else and never again", () => {
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: "global g = 1\nglobal h = 2\ntimer async 1 { wait 2 }\nwait 2\nexit",
    },
  ]);
  const prefixEnd = 2;
  // A rejected state fails validation and JSON restore.
  const rejected = (snapshot: Mutable<RuntimeSnapshot>): void => {
    assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, false);
    assert.throws(() =>
      deserializeCheckpoint(
        JSON.stringify({ format: CHECKPOINT_FORMAT, version: CHECKPOINT_VERSION, plan, snapshot }),
      ),
    );
  };
  const restorable = (snapshot: RuntimeSnapshot): void => {
    assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
    assert.deepEqual(
      deserializeCheckpoint(JSON.stringify(createCheckpoint(plan, snapshot))).snapshot,
      snapshot,
    );
  };
  // Within the startup, a valid session holds only the globals set up so far.
  const initialized = executeInstruction(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(initialized.nextInstruction, 1);
  restorable(initialized);
  const waiting = run(plan, initialized).snapshot;
  const expired = observeTime(plan, waiting, 1000).snapshot;
  assert.equal(expired.pendingTimerHandlers.length, 1);
  restorable(expired);
  // A queued block could run before every global exists.
  const queued = mutableCopy(expired);
  queued.status = "running";
  queued.foregroundAction = null;
  queued.nextInstruction = 1;
  queued.globals = queued.globals.filter((binding) => binding.name !== "h");
  rejected(queued);
  // So could a call, a variable, or an action of the story.
  for (const change of [
    (copy: Mutable<RuntimeSnapshot>) => {
      copy.frames[0]!.bindings.push({ name: "x", value: 1 });
    },
    (copy: Mutable<RuntimeSnapshot>) => {
      copy.nextActionId = 2;
    },
  ]) {
    const copy = mutableCopy(initialized);
    change(copy);
    rejected(copy);
  }

  // After the startup, no saved position leads back into it: here the root position that a timer block, which waits
  // while the main wait has settled, returns to.
  const interrupted = observeTime(plan, run(plan, expired).snapshot, 2000).snapshot;
  const frame = interrupted.callFrames[0];
  assert.ok(frame?.timerInterruption !== null && frame?.timerInterruption.suspendedAction === null);
  restorable(interrupted);
  for (let position = 0; position < prefixEnd; position += 1) {
    const back = mutableCopy(interrupted);
    back.callFrames[0]!.returnInstruction = position;
    rejected(back);
  }
});

test("snapshot validation requires exactly the globals set up so far, unshadowed", () => {
  const plan = compiledPlan([
    {
      path: "main.tease",
      source: "global a = 1\nspeaker vera { }\nglobal b = a + 1\nwait 1\nexit",
    },
  ]);
  const fresh = createFreshRuntimeSnapshot(plan);
  const afterOne = executeInstruction(plan, fresh).snapshot;
  const started = run(plan, fresh).snapshot;
  assert.equal(started.status, "waiting");
  for (const snapshot of [fresh, afterOne, started])
    assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
  assert.deepEqual(
    afterOne.globals.map((binding) => binding.name),
    ["a"],
  );

  const invalid = (snapshot: RuntimeSnapshot, change: (copy: Mutable<RuntimeSnapshot>) => void) => {
    const copy = mutableCopy(snapshot);
    change(copy);
    return validateRuntimeSnapshot(copy, plan).valid;
  };
  // A missing, extra, reordered, or early global.
  assert.equal(
    invalid(started, (copy) => copy.globals.pop()),
    false,
  );
  assert.equal(
    invalid(started, (copy) => copy.globals.push({ name: "c", value: 1 })),
    false,
  );
  assert.equal(
    invalid(started, (copy) => copy.globals.reverse()),
    false,
  );
  assert.equal(
    invalid(afterOne, (copy) => copy.globals.push({ name: "b", value: 2 })),
    false,
  );
  // A host global before them is fine, but not one that has a script global's name.
  assert.equal(
    invalid(started, (copy) => copy.globals.unshift({ name: "host", value: 1 })),
    true,
  );
  assert.equal(
    invalid(started, (copy) => copy.globals.unshift({ name: "a", value: 1 })),
    false,
  );
  // No scope binding has the name of a global.
  assert.equal(
    invalid(started, (copy) => copy.frames[0]!.bindings.push({ name: "a", value: 1 })),
    false,
  );
  // A failure names a file of the plan.
  const failing = compiledPlan([{ path: "main.tease", source: "global a = [1][1]\nexit" }]);
  const failed = run(failing, createFreshRuntimeSnapshot(failing)).snapshot;
  assert.equal(failed.failure?.path, "main.tease");
  assert.equal(validateRuntimeSnapshot(failed, failing).valid, true);
  const elsewhere = mutableCopy(failed);
  elsewhere.failure!.path = "other.tease";
  assert.equal(validateRuntimeSnapshot(elsewhere, failing).valid, false);
});

test("a call of another file's function that is not global cannot be restored", () => {
  const plan = compiledPlan([
    { path: "main.tease", source: "shared()\nexit" },
    { path: "lib.tease", source: "function helper { wait 1 }\nglobal function shared { wait 1 }" },
  ]);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(validateRuntimeSnapshot(waiting, plan).valid, true);
  assert.equal(waiting.callFrames[0]?.functionName, "shared");
  const helper = plan.functions.find((definition) => definition.name === "helper")!;
  const shared = plan.functions.find((definition) => definition.name === "shared")!;
  const moved = mutableCopy(waiting);
  const offset = helper.entryInstruction - shared.entryInstruction;
  moved.callFrames[0]!.functionId = helper.id;
  moved.callFrames[0]!.functionName = "helper";
  moved.nextInstruction += offset;
  const action = moved.foregroundAction;
  assert.ok(action?.kind === "delay");
  action.owningInstruction += offset;
  action.continuationInstruction += offset;
  assert.equal(validateRuntimeSnapshot(moved, plan).valid, false);

  // Nor can a session that failed in main.tease claim to stand in another file's code.
  const failing = compiledPlan([
    { path: "main.tease", source: "let x = [1][2]\nexit" },
    { path: "lib.tease", source: "let y = 2\nlet z = 3\nend\nfunction local { wait 1 }" },
  ]);
  const failed = run(failing, createFreshRuntimeSnapshot(failing)).snapshot;
  assert.equal(validateRuntimeSnapshot(failed, failing).valid, true);
  for (const position of [
    failing.files[1]!.startInstruction,
    failing.functions.find((definition) => definition.name === "local")!.bodyEntryInstruction,
  ]) {
    const elsewhere = mutableCopy(failed);
    elsewhere.nextInstruction = position;
    assert.equal(validateRuntimeSnapshot(elsewhere, failing).valid, false);
  }
});

test("host globals keep their names, values, and read-only use, before the script's globals", () => {
  const files = [
    { path: "main.tease", source: 'global bonus = hostScore + 1\nsay "${report()}"\nexit' },
    { path: "lib.tease", source: 'global function report {\n  return "${hostScore} ${bonus}"\n}' },
  ];
  const plan = compiledPlan(files, { globals: ["hostScore"] });
  const result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { globals: { hostScore: 4 } }),
  );
  assert.deepEqual(said(result.events), ["4 5"]);
  assert.deepEqual(
    result.snapshot.globals.map((binding) => binding.name),
    ["hostScore", "bonus"],
  );
  assert.deepEqual(
    diagnostics([{ path: "main.tease", source: "hostScore = 1\nglobal hostScore = 2\nexit" }], {
      globals: ["hostScore"],
    }),
    [
      ["main.tease", "TSV001", 2],
      ["main.tease", "TSV004", 1],
    ],
  );
  assert.throws(
    () => createFreshRuntimeSnapshot(plan, { globals: { bonus: 1 } }),
    /globals\.bonus has the name of a global or speaker of the script/u,
  );
});

test("a runtime failure names the file whose source it points into", () => {
  const startup = compiledPlan([
    { path: "main.tease", source: "global items: integer[] = []\nexit" },
    { path: "b.tease", source: "global first = items[3]" },
  ]);
  const failedAtStart = runToEnd(startup);
  const event = failedAtStart.events.find((item) => item.kind === "runtimeFailure");
  assert.ok(event?.kind === "runtimeFailure");
  assert.deepEqual(
    [event.path, event.code, event.span.start.line, event.span.start.column],
    ["b.tease", "TSR025", 0, 21],
  );
  assert.equal(failedAtStart.snapshot.failure?.path, "b.tease");
  assert.doesNotThrow(() => createCheckpoint(startup, failedAtStart.snapshot));

  const inFunction = compiledPlan([
    { path: "main.tease", source: "fail()\nexit" },
    {
      path: "lib/fail.tease",
      source: 'global function fail {\n  let items = [1]\n  say "${items[2]}"\n}',
    },
  ]);
  const failedInFunction = runToEnd(inFunction).snapshot.failure;
  assert.deepEqual(
    [failedInFunction?.path, failedInFunction?.span.start.line],
    ["lib/fail.tease", 2],
  );
});
