import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, type ProjectSourceFile } from "../src/compiler.js";
import { compileStableProject } from "../src/compiler/compile-program.js";
import { parse } from "../src/parser.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { validateRuntimeSnapshot, type RuntimeSnapshot } from "../src/runtime/state.js";
import { createXorShift32State, nextXorShift32 } from "../src/runtime/random.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

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
        ? [`failure ${event.code}`]
        : event.kind === "exit"
          ? ["exit"]
          : [],
  );
}

/** Runs a project to its end, also stepwise with a checkpoint at every boundary, and returns what it said. */
function said(files: readonly ProjectSourceFile[]): string[] {
  return outputs(assertRuntimeResumeEquivalent(files).events);
}

function compiled(files: readonly ProjectSourceFile[]): InstructionPlan {
  const result = compileProject(files);
  assert.deepEqual(result.diagnostics, []);
  return result.plan!;
}

test("goto naming a file starts it afresh, from its top or at a label", () => {
  assert.deepEqual(
    said(
      project('let mood = "main"\ngoto "rooms/hall.tease"', {
        "rooms/hall.tease": 'let mood = "hall"\nsay mood\ngoto "rooms/yard.tease" back\n',
        "rooms/yard.tease": 'say "skipped"\nlabel back\nsay "yard"\nexit',
      }),
    ),
    ["hall", "yard", "exit"],
  );
});

test("call runs a file and continues after it when the file ends, in loops and functions too", () => {
  assert.deepEqual(
    said(
      project(
        [
          "let rounds = 0",
          "function visit(name) {",
          "    repeat 2 {",
          '        call "corner.tease"',
          "        rounds += 1",
          "    }",
          '    return "${name} ${rounds}"',
          "}",
          'say visit("first")',
          'say "after"',
          "exit",
        ].join("\n"),
        {
          // The called file has its own variables, fresh on every call; end in its function ends the file.
          "corner.tease": [
            "let count = 1",
            "function leave { end }",
            'say "corner ${count}"',
            "count += 1",
            "leave()",
            'say "never"',
            "end",
          ].join("\n"),
        },
      ),
    ),
    ["corner 1", "corner 1", "first 2", "after", "exit"],
  );
});

test("a goto back in a called file sets that file's variables anew", () => {
  assert.deepEqual(
    said(
      project('let n = 10\ncall "count.tease"\nsay "main ${n}"\nexit', {
        "count.tease": [
          "let n = 0",
          "label again",
          "let next = n + 1",
          "n = next",
          "if n < 3 { goto again }",
          'say "count ${n}"',
          "end",
        ].join("\n"),
      }),
    ),
    ["count 3", "main 10", "exit"],
  );
});

test("a goto in a called file replaces it, and the call still returns", () => {
  assert.deepEqual(
    said(
      project('call "a.tease"\nsay "back in main"\nexit', {
        "a.tease": 'say "a"\ngoto "b.tease"',
        "b.tease": 'say "b"\nend',
      }),
    ),
    ["a", "b", "back in main", "exit"],
  );
});

test("call of a label runs this file afresh from there and returns at its end", () => {
  assert.deepEqual(
    said(
      project(
        ['let name = "outer"', "call greeting", 'say "after ${name}"', "exit"].join("\n") +
          '\nlabel greeting\nlet greeted = "inner"\nsay "hello ${greeted}"\nend',
      ),
    ),
    ["hello inner", "after outer", "exit"],
  );
});

test("end without a caller continues at the fallback, which fallback none clears", () => {
  const files = project(
    [
      "fallback menu",
      'goto "task.tease"',
      "label menu",
      'say "menu"',
      'fallback "last.tease"',
      'goto "task.tease"',
    ].join("\n"),
    {
      "task.tease": 'say "task"\nend',
      "last.tease":
        'say "last"\nfallback none\nlet done = false\nif done { exit }\ngoto "task.tease"',
    },
  );
  const plan = compiled(files);
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.deepEqual(outputs(result.events), [
    "task",
    "menu",
    "task",
    "last",
    "task",
    "failure TSR066",
  ]);
});

test("a block of a file the session left sees that file's variables, and its goto brings that file back", () => {
  assert.deepEqual(
    said(
      project(
        [
          'let owner = "main"',
          'let beat = timer(duration: 1, async: true, display: "hidden", persist: true) {',
          '    say "beat for ${owner}"',
          "    goto resumed",
          "}",
          'goto "wait.tease"',
          "label resumed",
          'say "main again with ${owner}"',
          "exit",
        ].join("\n"),
        { "wait.tease": 'let owner = "wait"\nwait 5\nsay "never"\nexit' },
      ),
    ),
    ["beat for main", "main again with main", "exit"],
  );
});

test("a block's goto abandons the file its activation called and keeps that activation's callers", () => {
  assert.deepEqual(
    said(
      project('call "middle.tease"\nsay "main continues"\nexit', {
        "middle.tease": [
          "let step = 7",
          'let alarm = timer(duration: 1, async: true, display: "hidden", persist: true) {',
          "    goto interrupted",
          "}",
          'call "slow.tease"',
          'say "never"',
          "end",
          "label interrupted",
          'say "interrupted at ${step}"',
          "end",
        ].join("\n"),
        "slow.tease": 'wait 5\nsay "never slow"\nend',
      }),
    ),
    ["interrupted at 7", "main continues", "exit"],
  );
});

test("a timer of a file that called another fires during the call, and its goto continues that file", () => {
  // The owner's example on #570: main's timer ends the corner time and continues main with its own variables.
  assert.deepEqual(
    said(
      project(
        [
          "let score = 3",
          "timer async 60 s { goto timeUp }",
          'call "corner.tease"',
          'say "corner done"',
          "exit",
          "label timeUp",
          'say "time is up with ${score}"',
          "exit",
        ].join("\n"),
        { "corner.tease": 'say "corner"\nwait 120 s\nsay "never"\nend' },
      ),
    ),
    ["corner", "time is up with 3", "exit"],
  );
});

test("a non-persistent timer goes when the file entry that started it is left; a call leaves nothing", () => {
  assert.deepEqual(
    said(
      project(
        [
          'timer async 3 { say "main timer" }',
          'let kept = timer(duration: 4, async: true, display: "hidden", persist: true) { say "kept" }',
          'call "short.tease"',
          "wait 5",
          'goto "last.tease"',
        ].join("\n"),
        {
          // The called file's own timers go when it ends or goes elsewhere.
          "short.tease": 'timer async 2 { say "short timer" }\nwait 1\ngoto "shorter.tease"',
          "shorter.tease": 'timer async 1 { say "shorter timer" }\nend',
          "last.tease": 'timer async 1 { say "last timer" }\nwait 2\nexit',
        },
      ),
    ),
    ["main timer", "kept", "last timer", "exit"],
  );
});

test("calling files without end is bounded by the call depth", () => {
  const plan = compiled(project('call "main.tease"\nexit'));
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { maxCallDepth: 8 }));
  assert.deepEqual(outputs(result.events), ["failure TSR047"]);
});

test("restore validation checks activations, file calls, retained roots, and the fallback", () => {
  const files = project(
    [
      "fallback menu",
      'let t = timer(duration: 9, async: true, display: "hidden", persist: true) { say "t" }',
      'call "inner.tease"',
      "exit",
      "label menu",
      "exit",
    ].join("\n"),
    { "inner.tease": "function pause { wait 5 }\npause()\nend" },
  );
  const plan = compiled(files);
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(
    waiting.callFrames.map((frame) => frame.kind),
    ["file", "function"],
  );
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  const broken = (change: (snapshot: Mutable<RuntimeSnapshot>) => void): readonly string[] => {
    // EVIDENCE: structuredClone preserves the runtime snapshot shape while each fixture breaks one field.
    const snapshot = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
    change(snapshot);
    return validateRuntimeSnapshot(snapshot, plan).errors;
  };
  // The called file's root names the file its call names.
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.frames[1]!.file = 0;
    }),
    [],
  );
  // A function sees the root of the activation that called it.
  assert.notDeepEqual(
    broken((snapshot) => {
      const frame = snapshot.callFrames[1]!;
      if (frame.kind === "function") frame.rootScopeId = snapshot.frames[0]!.id;
    }),
    [],
  );
  // Only activation roots stand where a file call starts.
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.frames[2]!.file = 1;
    }),
    [],
  );
  // A timer's block belongs to the activation that started it.
  assert.notDeepEqual(
    broken((snapshot) => {
      for (const action of snapshot.backgroundActions) {
        if (action.kind === "timer") action.timer.rootScopeId = snapshot.frames[1]!.id;
      }
    }),
    [],
  );
  // A retained root is a root of a file.
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.retainedScopes.push({
        id: snapshot.nextScopeId,
        file: null,
        entry: null,
        bindings: [],
      });
      snapshot.nextScopeId += 1;
    }),
    [],
  );
  // The fallback is the destination of a fallback statement: here main's label, not another file's.
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.fallback = { file: 1, target: plan.files[0]!.labels[0]!.instruction };
    }),
    [],
  );
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.fallback = { file: 1, target: plan.files[1]!.entryInstruction };
    }),
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

test("a goto, call, or fallback names a file and label that exist", () => {
  const codes = (main: string, others: Record<string, string> = {}): [string, string][] =>
    compileProject(project(main, others)).diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
    ]);
  const others = {
    "rooms/hall.tease": "label start\nexit",
    "helpers.tease": 'function greet { say "hi" }',
  };
  assert.deepEqual(codes('goto "rooms/yard.tease"', others), [
    [
      "TSV057",
      "The project has no file 'rooms/yard.tease'. Paths start at the package root, such as \"rooms/hall.tease\".",
    ],
  ]);
  assert.deepEqual(codes('call "rooms/hall.tease" finish\nexit', others), [
    ["TSV051", "'rooms/hall.tease' has no label 'finish'."],
  ]);
  assert.deepEqual(codes('goto "helpers.tease"', others), [
    [
      "TSV057",
      "'helpers.tease' holds declarations only and runs nothing, so going there would end nowhere. Call its functions instead.",
    ],
  ]);
  // Calling such a file runs nothing and returns at once.
  assert.deepEqual(codes('call "helpers.tease"\nexit', others), []);
  assert.deepEqual(
    codes('let room = "hall"\ngoto "rooms/${room}.tease"', others).map(([code]) => code),
    ["TSP039"],
  );
});

test("a glob picks only files that do something, and needs one", () => {
  const codes = (main: string): [string, string][] =>
    compileProject(
      project(main, {
        "rooms/hall.tease": "label start\nexit",
        "rooms/yard.tease": "exit",
        "rooms/helpers.tease": 'function greet { say "hi" }',
        "lib/tools.tease": "function tool { return 1 }",
      }),
    ).diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]);
  assert.deepEqual(codes('goto "rooms/*.tease"'), []);
  assert.deepEqual(codes('call "rooms/*.tease" start\nexit'), []);
  assert.deepEqual(codes('goto "cellar/*.tease"'), [
    [
      "TSV057",
      "No file of the project matches 'cellar/*.tease'. Paths start at the package root, such as \"rooms/*.tease\".",
    ],
  ]);
  assert.deepEqual(codes('goto "rooms/*.tease" finish'), [
    ["TSV057", "No file matching 'rooms/*.tease' has label 'finish'."],
  ]);
  // Calling a file of declarations only would do nothing, so a glob never picks one.
  assert.deepEqual(codes('call "lib/*.tease"\nexit'), [
    [
      "TSV057",
      "Every file matching 'lib/*.tease' holds declarations only and runs nothing, so there is nothing to pick.",
    ],
  ]);
  assert.deepEqual(codes('fallback "rooms/*"\nexit'), [
    ["TSV057", "'rooms/*' is not a pattern of package file paths: it does not name a .tease file."],
  ]);
  const plan = compiled(
    project('call "rooms/*.tease"\nexit', {
      "rooms/a.tease": "end",
      "rooms/b.tease": "end",
      "rooms/helpers.tease": "function help { return 1 }",
    }),
  );
  const transfer = plan.instructions.find((instruction) => instruction.kind === "transfer");
  assert.ok(transfer?.kind === "transfer" && "pick" in transfer.destination);
  assert.deepEqual(
    transfer.destination.pick.map((option) => plan.files[option.file]!.path),
    ["rooms/a.tease", "rooms/b.tease"],
  );
});

test("each glob target that runs draws its file once; restore never draws again", () => {
  const files = project(
    ["repeat 8 {", '    call "rooms/*.tease"', "}", 'fallback "ends/*.tease"', "end"].join("\n"),
    {
      "rooms/a.tease": 'say "a"\nend',
      "rooms/b.tease": 'say "b"\nend',
      "rooms/c.tease": 'say "c"\nend',
      "ends/calm.tease": 'say "calm end"\nexit',
      "ends/strict.tease": 'say "strict end"\nexit',
    },
  );
  // Every draw happens at a run of a glob target, the same way stepwise and after each restore.
  const seed = 12345;
  const result = assertRuntimeResumeEquivalent(files, { seed });
  const texts = outputs(result.events);
  assert.equal(texts.length, 10);
  assert.ok(texts.slice(0, 8).every((text) => ["a", "b", "c"].includes(text)));
  assert.ok(["calm end", "strict end"].includes(texts[8]!));
  assert.equal(texts[9], "exit");
  // Eight calls and the fallback draw once each; setting the fallback draws nothing.
  // A stored glob fallback is exactly the destination of a fallback statement.
  const plan = compiled(files);
  const set = result.boundaries.find((snapshot) => snapshot.fallback !== null)!;
  assert.deepEqual(validateRuntimeSnapshot(set, plan).errors, []);
  const narrowed = structuredClone(set);
  if (narrowed.fallback !== null && "pick" in narrowed.fallback) {
    narrowed.fallback = { pick: narrowed.fallback.pick.slice(1) };
  }
  assert.deepEqual(validateRuntimeSnapshot(narrowed, plan).errors, [
    "Runtime fallback is malformed.",
  ]);
  const expected = createXorShift32State(seed);
  for (let draw = 0; draw < 9; draw += 1) nextXorShift32(expected);
  assert.equal(result.finalSnapshot.rng.state, expected.state);
});

test("a label that a file is entered at sees none of the variables set before it", () => {
  const result = compileProject(
    project('let x = 1\nlabel again\nsay x\ngoto "other.tease"', {
      "other.tease": 'goto "main.tease" again',
    }),
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
    [
      [
        "TSV054",
        "This line can be reached without running 'let x' first, through a goto, call, or fallback to a label after it, so x may have no value here. Set x after that label, or make it a global.",
      ],
    ],
  );
});

test("a block changes the variables of a file the session left, also across a file call", () => {
  assert.deepEqual(
    said(
      project(
        [
          "let data = [7]",
          "let scores = { first: 7 }",
          "function later {",
          '    call "pause.tease"',
          "    return 9",
          "}",
          'let t = timer(duration: 1, async: true, display: "hidden", persist: true) {',
          "    data[0] = 9",
          "    scores.first = later()",
          '    say "${data[0]} ${scores.first}"',
          "}",
          'goto "wait.tease"',
        ].join("\n"),
        { "wait.tease": "wait 5\nexit", "pause.tease": "wait 1\nend" },
      ),
    ),
    ["9 9", "exit"],
  );
});

test("a loop of a calling file stays with its call while the called file runs", () => {
  // The same loop of a recursive call is another loop, so the call depth limit ends the recursion.
  const recursive = compiled(project('repeat 1 { call "main.tease" }\nexit'));
  const result = run(
    recursive,
    createImmediatePacingRuntimeSnapshot(recursive, { maxCallDepth: 4 }),
  );
  assert.deepEqual(outputs(result.events), ["failure TSR047"]);

  const plan = compiled(
    project('repeat 2 {\n    call "child.tease"\n    say "returned"\n}\nexit', {
      "child.tease": "wait 1\nend",
    }),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  const broken = (change: (snapshot: Mutable<RuntimeSnapshot>) => void): boolean => {
    // EVIDENCE: structuredClone preserves the runtime snapshot shape while each fixture breaks one field.
    const snapshot = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
    change(snapshot);
    return validateRuntimeSnapshot(snapshot, plan).valid;
  };
  // The caller's loop belongs to the caller, below the file call.
  assert.equal(
    broken((snapshot) => {
      const call = snapshot.callFrames[0]!;
      if (call.kind === "file") call.loopBaseDepth = 0;
    }),
    false,
  );
  // Its iteration scope lies in the caller's scopes.
  assert.equal(
    broken((snapshot) => {
      snapshot.loopFrames[0]!.scopeDepth = 2;
    }),
    false,
  );
  // And the caller stands inside the loop, so the loop must be there.
  assert.equal(
    broken((snapshot) => {
      snapshot.loopFrames.length = 0;
      const call = snapshot.callFrames[0]!;
      if (call.kind === "file") call.loopBaseDepth = 0;
    }),
    false,
  );
});

test("a plan enters a file only at the start of its root region", () => {
  const plan = compiled(project('call "b.tease"\nexit', { "b.tease": 'say "b"\nend' }));
  const moved = plan.files[1]!.startInstruction + 1;
  const errors = validateInstructionPlan({
    ...plan,
    files: plan.files.map((file, index) =>
      index === 1 ? { ...file, entryInstruction: moved } : file,
    ),
    instructions: plan.instructions.map((instruction) =>
      instruction.kind === "transfer"
        ? { ...instruction, destination: { file: 1, target: moved } }
        : instruction,
    ),
  }).errors.map((error) => error.message);
  assert.ok(
    errors.includes(
      "A file's entry must be the start of its root region, after main.tease's start values.",
    ),
  );
});

test("a timer block may change a loop condition while a called file runs", () => {
  assert.deepEqual(
    said(
      project(
        [
          "let x: integer? = 1",
          "timer async 1 { x = null }",
          "x = 1",
          'while x != null { call "delay.tease" }',
          'say "stopped"',
          "exit",
        ].join("\n"),
        { "delay.tease": "wait 1\nend" },
      ),
    ),
    ["stopped", "exit"],
  );
});

test("a transfer that cannot run enters no label", () => {
  for (const transfer of [
    'goto "b.tease" start',
    'call "b.tease" start',
    'fallback "b.tease" start',
  ]) {
    const result = compileProject(
      project(`if false { ${transfer} }\nexit`, {
        "b.tease": "let x = 1\nlabel start\nsay x\nend",
      }),
    );
    assert.deepEqual(result.diagnostics, [], transfer);
  }
});

test("a timer names an issued activation, also after that activation is gone", () => {
  const plan = compiled(
    project(
      [
        'let kept = timer(duration: 10, async: true, display: "hidden", persist: true)',
        "timer async 10",
        'goto "child.tease"',
      ].join("\n"),
      { "child.tease": "wait 1\nexit" },
    ),
  );
  // The persistent timer outlives main's activation, which nothing retains.
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture breaks one owner.
  const unissued = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
  for (const action of unissued.backgroundActions) {
    if (action.kind === "timer") action.timer.rootScopeId = unissued.nextScopeId + 10;
  }
  assert.equal(validateRuntimeSnapshot(unissued, plan).valid, false);
});

test("a transfer in a function never called or a block never started enters no label", () => {
  const codes = (main: string): string[] =>
    compileProject(
      project(main, { "b.tease": "let x = 1\nlabel start\nsay x\nend" }),
    ).diagnostics.map((diagnostic) => diagnostic.code);
  for (const main of [
    'if false { timer async 1 { goto "b.tease" start } }\nexit',
    'function never { goto "b.tease" start }\nexit',
    'function f { call "b.tease" start }\nif false { f() }\nexit',
    'function f { fallback "b.tease" start }\nfunction g { f() }\nexit',
  ]) {
    assert.deepEqual(codes(main), [], main);
  }
  // One that can run still enters its label afresh.
  assert.deepEqual(codes('function f { goto "b.tease" start }\nf()\nexit'), ["TSV054"]);
});

test("restore checks a timer's activation against its file and walks only real loop partitions", () => {
  const plan = compiled(
    project('timer async 10\ncall "child.tease"\nexit', {
      "child.tease": 'wait 1\ngoto "last.tease"',
      "last.tease": "wait 1\nend",
    }),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  // The timer started in main: the called file's activation cannot own it.
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture changes one owner.
  const wrongFile = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
  for (const action of wrongFile.backgroundActions) {
    if (action.kind === "timer") action.timer.rootScopeId = wrongFile.frames[1]!.id;
  }
  assert.equal(validateRuntimeSnapshot(wrongFile, plan).valid, false);

  const loops = compiled(
    project('repeat 2 { call "child.tease" }\nexit', { "child.tease": "wait 1\nend" }),
  );
  const inLoop = run(loops, createImmediatePacingRuntimeSnapshot(loops)).snapshot;
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture breaks one loop base.
  const huge = structuredClone(inLoop) as Mutable<RuntimeSnapshot>;
  const call = huge.callFrames[0]!;
  if (call.kind === "file") call.loopBaseDepth = Number.MAX_SAFE_INTEGER;
  assert.equal(validateRuntimeSnapshot(huge, loops).valid, false);
});

test("lowering appends many transfer destinations without a native argument limit", () => {
  const parsed = parse("fallback done\nexit\nlabel done\nexit").program;
  const fallback = parsed.statements[0]!;
  const program = {
    ...parsed,
    statements: [...Array.from({ length: 150_000 }, () => fallback), ...parsed.statements.slice(1)],
  };
  const plan = compileStableProject([{ path: "main.tease", program }]);
  assert.equal(
    plan.instructions.filter((instruction) => instruction.kind === "setFallback").length,
    150_000,
  );
});

test("a goto in a global function enters its file afresh where a call that can run reaches it", () => {
  const codes = (files: ProjectSourceFile[]): string[] =>
    compileProject(files).diagnostics.map((diagnostic) => diagnostic.code);
  const main = "let x = 1\nlabel later\nsay x\nexit\nglobal function skip { goto later }";
  // Nothing calls it, so its goto enters nothing.
  assert.deepEqual(codes(project(main)), []);
  // A call through another file's global function reaches it, so `later` is entered afresh.
  assert.deepEqual(
    codes(project(`indirect()\n${main}`, { "lib.tease": "global function indirect { skip() }" })),
    ["TSV054"],
  );
  // And it runs as a transfer to its own file, which starts at the label.
  assert.deepEqual(
    said(
      project("reset()\nexit", {
        "lib.tease": 'label again\nsay "again"\nexit\nglobal function reset { goto again }',
      }),
    ),
    ["again", "exit"],
  );
});

test("entering main.tease again skips the start values, which run once", () => {
  assert.deepEqual(
    said(
      project(
        [
          "global count = 0",
          "count += 1",
          'say "round ${count}"',
          'if count < 3 { goto "main.tease" }',
          "exit",
        ].join("\n"),
      ),
    ),
    ["round 1", "round 2", "round 3", "exit"],
  );
});

test("what a file call or a new entry into main.tease may change about a global is not known", () => {
  const codes = (main: string, others: Record<string, string>): string[] =>
    compileProject(project(main, others)).diagnostics.map((diagnostic) => diagnostic.code);
  const declared = "global value: integer | string = 1\n";
  // The called file's top level may change the global.
  assert.notDeepEqual(
    codes(`${declared}call "b.tease"\nlet count: integer = value\nsay count\nexit`, {
      "b.tease": 'value = "bad"\nend',
    }),
    [],
  );
  // Also through a global function of another file that calls it.
  assert.notDeepEqual(
    codes(`${declared}relay()\nlet count: integer = value\nsay count\nexit`, {
      "b.tease": 'value = "bad"\nend',
      "lib.tease": 'global function relay { call "b.tease" }',
    }),
    [],
  );
  // And main.tease, entered again, starts after the start values with what the session holds then.
  assert.notDeepEqual(
    codes(
      `${declared}global first = true\nlet count: integer = value\nsay count\nif first {\n    first = false\n    goto "b.tease"\n}\nexit`,
      { "b.tease": 'value = "bad"\ngoto "main.tease"' },
    ),
    [],
  );
  // Without a file call or a new entry, what the start values stored is still known.
  assert.deepEqual(codes(`${declared}let count: integer = value\nsay count\nexit`, {}), []);
});

test("a root retained for a block cannot bind the name of a global", () => {
  const plan = compiled(
    project(
      [
        "global score = 7",
        "let x = 1",
        'let t = timer(duration: 1, async: true, display: "hidden", persist: true) { say score }',
        'goto "slow.tease"',
      ].join("\n"),
      { "slow.tease": "wait 2\nexit" },
    ),
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(waiting.retainedScopes.length, 1);
  assert.deepEqual(validateRuntimeSnapshot(waiting, plan).errors, []);
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture adds one binding.
  const shadowing = structuredClone(waiting) as Mutable<RuntimeSnapshot>;
  shadowing.retainedScopes[0]!.bindings.push({ name: "score", value: 999 });
  assert.equal(validateRuntimeSnapshot(shadowing, plan).valid, false);
});

test("a photo taken in a called file or a global function of another file survives a checkpoint", () => {
  const plan = compiled(
    project(
      'call "booth.tease"\nsay "first ${shot}"\nlet second = snap()\nsay "second ${second}"\nexit',
      {
        "booth.tease":
          "global shot: string? = null\nglobal function snap {\n  return takePhoto()\n}\nshot = takePhoto()\nend\n",
      },
    ),
  );
  const photo = "captured-media:photo:1";
  const admission = { holds: (reference: string) => reference === photo };
  const answer = (snapshot: RuntimeSnapshot) => {
    const action = snapshot.foregroundAction;
    assert.equal(action?.kind, "capture");
    const completed = completeAction(
      plan,
      snapshot,
      {
        actionId: action.actionId,
        actionKind: "capture",
        payload: { kind: "captured", media: { kind: "image", reference: photo } },
      },
      { capturedMedia: admission },
    );
    assert.equal(completed.outcome.kind, "completed");
    return run(plan, completed.snapshot);
  };
  const restored = (snapshot: RuntimeSnapshot) =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot))).snapshot;

  // Waiting inside the called file, then inside the global function called from main.tease.
  const inFile = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  assert.equal(inFile.callFrames.at(-1)?.kind, "file");
  const inFunction = answer(inFile);
  assert.equal(inFunction.snapshot.callFrames.at(-1)?.kind, "function");
  for (const waiting of [inFile, inFunction.snapshot]) {
    assert.equal(validateRuntimeSnapshot(waiting, plan).valid, true);
    assert.deepEqual(restored(waiting), waiting);
  }
  const finished = answer(answer(restored(inFile)).snapshot);
  assert.deepEqual(answer(restored(inFunction.snapshot)).snapshot, finished.snapshot);
  assert.deepEqual(outputs([...inFunction.events, ...finished.events]), [
    `first ${photo}`,
    `second ${photo}`,
    "exit",
  ]);
});

test("destinations compare by their values, and a pick holds plain destinations only", () => {
  const plan = compiled(
    project('fallback "ends/*.tease"\nend', { "ends/a.tease": "exit", "ends/b.tease": "exit" }),
  );
  // The same destinations written with their keys in another order.
  const reordered: InstructionPlan = {
    ...plan,
    instructions: plan.instructions.map((instruction) =>
      instruction.kind === "setFallback" &&
      instruction.destination !== null &&
      "pick" in instruction.destination
        ? {
            ...instruction,
            destination: {
              pick: instruction.destination.pick.map(({ file, target }) => ({ target, file })),
            },
          }
        : instruction,
    ),
  };
  assert.deepEqual(validateInstructionPlan(reordered).errors, []);
  const set = executeInstruction(reordered, createImmediatePacingRuntimeSnapshot(reordered));
  assert.deepEqual(validateRuntimeSnapshot(set.snapshot, reordered).errors, []);

  // A pick nested in a pick is malformed, however deep.
  type Nested = { readonly file: number; readonly target: number } | { readonly pick: Nested[] };
  let nested: Nested = { file: 0, target: 0 };
  for (let depth = 0; depth < 12_000; depth += 1) nested = { pick: [nested] };
  const deep = {
    ...plan,
    instructions: plan.instructions.map((instruction) =>
      instruction.kind === "setFallback" ? { ...instruction, destination: nested } : instruction,
    ),
  };
  assert.equal(validateInstructionPlan(deep).valid, false);
});

test("a glob with many stars checks a near match without backtracking blowup", () => {
  const result = compileProject(
    project(`goto "rooms/${"*a".repeat(14)}*b.tease"`, {
      [`rooms/${"a".repeat(40)}c.tease`]: "exit",
    }),
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV057"],
  );
});

test("a glob that may pick main.tease enters it again after its start values", () => {
  const result = compileProject(
    project(
      [
        "global value: integer | string = 1",
        "global first = true",
        "let count: integer = value",
        "say count",
        "if first {",
        "    first = false",
        '    goto "b.tease"',
        "}",
        "exit",
      ].join("\n"),
      { "b.tease": 'value = "bad"\ngoto "*.tease"' },
    ),
  );
  assert.notDeepEqual(result.diagnostics, []);
});
