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
} from "../src/runtime/snapshot/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { pressPermanentButton } from "../src/runtime/operations/press-permanent-button.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { createXorShift32State, nextXorShift32 } from "../src/runtime/random/random.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-validation.js";

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

test("goto naming a file starts it afresh from its top", () => {
  assert.deepEqual(
    said(
      project('let mood = "main"\ngoto "rooms/hall.tease"', {
        "rooms/hall.tease": 'let mood = "hall"\nsay mood\ngoto "rooms/yard.tease"\n',
        "rooms/yard.tease": 'let mood = "yard"\nsay mood\nexit',
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

test("a call starts another file, so a label or a file that may be running is an error", () => {
  const diagnostics = (files: ProjectSourceFile[]): [string, string, string][] =>
    compileProject(files).diagnostics.map((diagnostic) => [
      diagnostic.path,
      diagnostic.code,
      diagnostic.message,
    ]);
  assert.deepEqual(diagnostics(project('call greeting\nexit\nlabel greeting\nsay "hi"\nend')), [
    [
      "main.tease",
      "TSV057",
      "A call starts another file at its top, so it cannot go to label 'greeting' of this file. Use 'goto greeting' to continue at the label, or put that part in a function and call the function.",
    ],
  ]);
  const ownFile =
    "A call starts another file, but this call can start 'main.tease', the file it is in. To run a part of this file and come back, put it in a function and call that, or use goto with a label of this file to continue there.";
  // Every spelling of the file, also where the call never runs.
  for (const call of [
    'call "main.tease"',
    'call script("main.tease")',
    'if false { call "main.tease" }',
  ])
    assert.deepEqual(
      diagnostics(project(`${call}\nexit`)),
      [["main.tease", "TSV057", ownFile]],
      call,
    );
  const rooms = { "rooms/a.tease": "exit", "rooms/b.tease": "exit" };
  assert.deepEqual(
    diagnostics(project("exit", { ...rooms, "rooms/a.tease": 'call "rooms/*.tease"\nexit' })),
    [
      [
        "rooms/a.tease",
        "TSV057",
        "A call starts another file, but this call can start 'rooms/a.tease', the file it is in. Change the pattern so that it matches only other files.",
      ],
    ],
  );
  const tagged = (source: string) => `---\ntags: "scene"\n---\n${source}`;
  assert.deepEqual(
    diagnostics(
      project('call tagged "scene"\nexit', { "a.tease": tagged('call tagged "scene"\nend') }),
    ),
    [
      [
        "a.tease",
        "TSV057",
        "A call starts another file, but this call can start 'a.tease', the file it is in. Limit the candidates with 'from:', or with a tag that 'a.tease' does not have.",
      ],
    ],
  );
  // A comparison is false for a file without a number for its tag, and decided by a constant bound.
  const scenes = { "scene.tease": '---\ntags: punishment: 4\n---\nsay "scene"\nend' };
  for (const [header, pick, can] of [
    ["", '"punishment" > minimum', false],
    ['---\ntags: "punishment"\n---\n', '"punishment" > minimum', false],
    ["---\ntags: punishment: 1\n---\n", '"punishment" > 3', false],
    ["---\ntags: punishment: 4\n---\n", '"punishment" > 3', true],
    ["---\ntags: punishment: 1\n---\n", '"punishment" > minimum', true],
  ] as const)
    assert.deepEqual(
      diagnostics(
        project(`${header}let minimum = 3\ncall tagged ${pick}\nsay "back"\nexit`, scenes),
      ).map(([path, code]) => `${path} ${code}`),
      can ? ["main.tease TSV057"] : [],
      `${header}${pick}`,
    );
  // A tag test or `from:` that leaves the file out allows the call.
  assert.deepEqual(
    diagnostics(
      project('call tagged "scene"\nexit', {
        "a.tease": tagged('call tagged "scene", from: "b.tease"\nend'),
        "b.tease": tagged("end"),
      }),
    ),
    [],
  );
  // A global function runs in the file that called it, directly or through another global function.
  const lib = {
    "lib.tease":
      'global function relay { punish() }\nglobal function punish { call "rooms/*.tease" }',
  };
  assert.deepEqual(diagnostics(project("relay()\nexit", { ...rooms, ...lib })), []);
  assert.deepEqual(
    diagnostics(project("exit", { ...rooms, ...lib, "rooms/b.tease": "relay()\nexit" })),
    [
      [
        "lib.tease",
        "TSV057",
        "A call starts another file, but this call can start 'rooms/b.tease', which calls global function 'punish' and so is the running file then. Change the pattern so that it matches only other files.",
      ],
    ],
  );
});

test("a call that would start the running file fails when it runs", () => {
  const failure = (files: ProjectSourceFile[]): readonly string[] =>
    assertRuntimeResumeEquivalent(files, { ending: "failed" }).events.flatMap((event) =>
      event.kind === "runtimeFailure" ? [`${event.code} ${event.message}`] : [],
    );
  const message = (path: string) =>
    `TSR069 This call would start '${path}', the file that is running, but a call starts another file. To run a part of a file and come back, put it in a function and call that.`;
  // A computed target.
  assert.deepEqual(
    failure(
      project('call "a.tease"\nexit', { "a.tease": 'let me = script("a.tease")\ncall (me)\nend' }),
    ),
    [message("a.tease")],
  );
  // A block of main.tease that fires while the file main.tease called runs.
  assert.deepEqual(
    failure(
      project('timer async 1 s { call "b.tease" }\ncall "b.tease"\nexit', {
        "b.tease": "wait 2 s\nend",
      }),
    ),
    [message("b.tease")],
  );
});

test("a block runs later, so its end only warns and its call of a file is checked when it runs", () => {
  const press = (plan: InstructionPlan, snapshot: RuntimeSnapshot) => {
    const pressed = pressPermanentButton(plan, snapshot, 1);
    assert.equal(pressed.outcome.kind, "pressed");
    const after = run(plan, pressed.snapshot);
    return [...pressed.events, ...after.events];
  };
  // A Skip button of main.tease ends the file that main.tease called, while it waits.
  const skip = compileProject(
    project('let skip = showPermanentButton "Skip" { end }\ncall "scene.tease"\nsay "back"\nexit', {
      "scene.tease": 'say "scene"\nwait 2 s\nsay "never"\nend',
    }),
  );
  assert.deepEqual(
    skip.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
    [
      [
        "TSV071",
        "The block that line 1 starts runs later, so the compiler cannot tell whether a call waits for this end when it runs. Without one, the end fails. If the block can run while no file call waits, use exit or goto here instead of end.",
      ],
    ],
  );
  const waiting = run(skip.plan!, createImmediatePacingRuntimeSnapshot(skip.plan!));
  assert.deepEqual(outputs([...waiting.events, ...press(skip.plan!, waiting.snapshot)]), [
    "scene",
    "back",
    "exit",
  ]);
  // A Replay button that a called file shows calls that file again once main.tease runs.
  const replay = compiled(
    project('call "scene.tease"\nwait 2 s\nexit', {
      "scene.tease": 'say "scene"\nsetup()\nend',
      "lib.tease":
        'global function setup {\n    let replay = showPermanentButton "Replay", persist: true { call "scene.tease" }\n}',
    }),
  );
  // A persistent block, or a media block, may run after the file that started it has returned.
  assert.deepEqual(
    compileProject(
      project('call "scene.tease"\nwait 1 s\nexit', {
        "scene.tease": 'let stop = showPermanentButton "End", persist: true { end }\nend',
      }),
    ).diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
    [["scene.tease", "TSV071"]],
  );
  const shown = run(replay, createImmediatePacingRuntimeSnapshot(replay));
  assert.deepEqual(outputs([...shown.events, ...press(replay, shown.snapshot)]), [
    "scene",
    "scene",
  ]);
});

test("a file target names no label, and a global function goes to no label of its file", () => {
  const diagnostics = (main: string, others: Record<string, string> = {}): [string, string][] =>
    compileProject(project(main, others)).diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
    ]);
  const rooms = { "rooms/hall.tease": "label start\nexit", "rooms/yard.tease": "exit" };
  for (const [main, message] of [
    [
      'goto "rooms/hall.tease" start',
      `A goto to 'rooms/hall.tease' starts it at its top, so it cannot go to label 'start'. Write 'goto "rooms/hall.tease"', or put the part after 'start' in a file of its own and goto that file.`,
    ],
    [
      'if false { call "rooms/hall.tease" start }\nexit',
      "A call starts 'rooms/hall.tease' at its top, so it cannot go to label 'start'. Put the part after 'start' in a file of its own and call that file, or in a global function.",
    ],
    [
      'goto "rooms/*.tease" start',
      "A goto starts the file it picks at its top, so it cannot go to label 'start'. Put the part after 'start' in a file of its own and goto that file.",
    ],
    [
      'let next = script("rooms/hall.tease", label: "start")\ngoto (next)',
      "A script reference starts its file at its top, so it takes no 'label:'. Put the part after 'start' in a file of its own and name that file.",
    ],
    [
      'let name = "start"\ncall script("rooms/hall.tease", label: name)\nexit',
      "A call starts the file it picks at its top, so it cannot go to a label. Put the part after the label in a file of its own and call that file.",
    ],
  ] as const)
    assert.deepEqual(diagnostics(main, rooms), [["TSV057", message]], main);
  // Whether or not anything calls the function.
  for (const main of ["exit", "skip()\nexit"])
    assert.deepEqual(
      diagnostics(main, { "lib.tease": "label later\nexit\nglobal function skip { goto later }" }),
      [
        [
          "TSV051",
          "A global function can run in any file, so it cannot go to label 'later' of 'lib.tease'. Put the part after the label in a file of its own and goto that file, or in a function that does the work and returns.",
        ],
      ],
      main,
    );
  // A file of its own, which it starts at the top.
  assert.deepEqual(
    said(
      project("skip()\nexit", {
        "lib.tease": 'global function skip { goto "later.tease" }',
        "later.tease": 'say "later"\nexit',
      }),
    ),
    ["later", "exit"],
  );
});

test("an end with no call to return to is an error on every way the compiler can follow", () => {
  const diagnostics = (
    main: string,
    others: Record<string, string> = {},
  ): [string, string, string][] =>
    compileProject(project(main, others)).diagnostics.map((diagnostic) => [
      diagnostic.path,
      diagnostic.code,
      diagnostic.message,
    ]);
  assert.deepEqual(diagnostics('let stop = askBoolean "Stop?"\nif stop { end }\nexit'), [
    [
      "main.tease",
      "TSV070",
      "No call waits for this end, because the session starts in main.tease without one, so there is nothing to return to. Use exit to finish the session, or goto to continue in another file.",
    ],
  ]);
  const scene = { "scene.tease": 'say "scene"\nend' };
  const noCall =
    "No call waits for this end when the goto on line 2 of main.tease leads here, so there is nothing to return to. Write call there to come back after it, or use exit or goto here instead of end.";
  // Also when another way calls the file, and in a function that the file calls.
  for (const [main, others] of [
    ['say "start"\ngoto "scene.tease"', scene],
    [
      'let pick = askBoolean "Call it?"\nif pick { call "scene.tease" } else { goto "scene.tease" }\nexit',
      scene,
    ],
    ['say "start"\ngoto "scene.tease"', { "scene.tease": "leave()\nexit\nfunction leave { end }" }],
  ] as const) {
    const found = diagnostics(main, others).filter(([, code]) => code === "TSV070");
    assert.deepEqual(
      found.map(([path, code]) => [path, code]),
      [["scene.tease", "TSV070"]],
      main,
    );
    assert.equal(found[0]![2], noCall);
  }
  // A script(...) of a path written out names its file, like a file target.
  assert.deepEqual(
    diagnostics('goto script("scene.tease")', scene).map(([path, code]) => [path, code]),
    [["scene.tease", "TSV070"]],
  );
  // A tagged pick may start only the files whose tags it may match, by its tag tests and literal tag lists.
  const tagged = (tags: string, source: string) => `---\ntags: "${tags}"\n---\n${source}`;
  for (const pick of [
    'goto tagged "finale"',
    'goto tagged all: ["finale"]',
    'goto tagged none: ["scene"]',
  ])
    assert.deepEqual(
      diagnostics(pick, {
        "finale.tease": tagged("finale", "exit"),
        "scene.tease": tagged("scene", "end"),
      }),
      [],
      pick,
    );
  // A goto keeps the call that waits for the file it leaves.
  assert.deepEqual(
    said(
      project('call "a.tease"\nsay "back"\nexit', {
        "a.tease": 'goto "b.tease"',
        "b.tease": 'say "b"\nend',
      }),
    ),
    ["b", "back", "exit"],
  );
  // A computed target hides the way: a warning, and the end fails if no call waits when it runs.
  const files = project('let next = script("scene.tease")\ngoto (next)', {
    "scene.tease": 'say "scene"\nend',
    "done.tease": "exit",
  });
  assert.deepEqual(
    diagnostics(files[0]!.source, { "scene.tease": files[1]!.source, "done.tease": "exit" }),
    [
      [
        "scene.tease",
        "TSV071",
        "The goto on line 2 of main.tease picks its file when it runs, so the compiler cannot tell whether a call waits for this end then. Without one, the end fails. Write call there to come back after it, or use exit or goto here instead of end.",
      ],
    ],
  );
  const plan = compileProject(files).plan!;
  assert.deepEqual(outputs(run(plan, createImmediatePacingRuntimeSnapshot(plan)).events), [
    "scene",
    "failure TSR066",
  ]);
});

test("a block of a file the session left sees that file's variables, and its goto brings that file back", () => {
  assert.deepEqual(
    said(
      project(
        [
          'let owner = "main"',
          'let beat = timer(duration: 1 s, async: true, display: "hidden", persist: true) {',
          '    say "beat for ${owner}"',
          "    goto resumed",
          "}",
          'goto "wait.tease"',
          "label resumed",
          'say "main again with ${owner}"',
          "exit",
        ].join("\n"),
        { "wait.tease": 'let owner = "wait"\nwait 5 s\nsay "never"\nexit' },
      ),
    ),
    ["beat for main", "main again with main", "exit"],
  );
});

test("a block's goto abandons the file its activation called and keeps that activation's callers", () => {
  assert.deepEqual(
    outputs(
      assertRuntimeResumeEquivalent(
        project('call "middle.tease"\nsay "main continues"\nexit', {
          "middle.tease": [
            "let step = 7",
            'let alarm = timer(duration: 1 s, async: true, display: "hidden", persist: true) {',
            "    goto interrupted",
            "}",
            'call "slow.tease"',
            'say "never"',
            "end",
            "label interrupted",
            'say "interrupted at ${step}"',
            "end",
          ].join("\n"),
          "slow.tease": 'wait 5 s\nsay "never slow"\nend',
        }),
        // The persistent timer could fire after middle.tease returned, and then its end would have no call to return to.
        { warnings: ["TSV071"] },
      ).events,
    ),
    ["interrupted at 7", "main continues", "exit"],
  );
});

test("a block's goto that leaves a called file keeps the caller's finished timers' waiting blocks", () => {
  // The caller's one-shot timer finishes at 1 s while middle.tease's block waits, so its block waits too; the goto then
  // leaves only middle.tease, whose own finished timer's block goes.
  assert.deepEqual(
    said(
      project(
        [
          'timer(duration: 1 s, async: true, display: "hidden") { say "main a" }',
          'call "middle.tease"',
          'say "back in main"',
          "wait 5 s",
          "exit",
        ].join("\n"),
        {
          "middle.tease": [
            'timer(duration: 500 ms, async: true, display: "hidden") {',
            "    wait 2 s",
            "    goto there",
            "}",
            'timer(duration: 1 s, async: true, display: "hidden") { say "middle a" }',
            "wait 10 s",
            "end",
            "label there",
            'say "middle there"',
            "wait 5 s",
            "end",
          ].join("\n"),
        },
      ),
    ),
    ["main a", "middle there", "back in main", "exit"],
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
          'timer async 3 s { say "main timer" }',
          'let kept = timer(duration: 4 s, async: true, display: "hidden", persist: true) { say "kept" }',
          'call "short.tease"',
          "wait 5 s",
          'goto "last.tease"',
        ].join("\n"),
        {
          // The called file's own timers go when it ends or goes elsewhere.
          "short.tease": 'timer async 2 s { say "short timer" }\nwait 1 s\ngoto "shorter.tease"',
          "shorter.tease": 'timer async 1 s { say "shorter timer" }\nend',
          "last.tease": 'timer async 1 s { say "last timer" }\nwait 2 s\nexit',
        },
      ),
    ),
    ["main timer", "kept", "last timer", "exit"],
  );
});

test("calling files without end is bounded by the call depth", () => {
  const plan = compiled(
    project('call "a.tease"\nexit', {
      "a.tease": 'call "b.tease"\nend',
      "b.tease": 'call "a.tease"\nend',
    }),
  );
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { maxCallDepth: 8 }));
  assert.deepEqual(outputs(result.events), ["failure TSR047"]);
});

test("restore validation checks activations, file calls, and retained roots", () => {
  const files = project(
    [
      'let t = timer(duration: 9 s, async: true, display: "hidden", persist: true) { say "t" }',
      'call "inner.tease"',
      "exit",
    ].join("\n"),
    { "inner.tease": "function pause { wait 5 s }\npause()\nend" },
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
  // The called file's root names the file its call names, and starts at its top.
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.frames[1]!.file = 0;
    }),
    [],
  );
  assert.notDeepEqual(
    broken((snapshot) => {
      snapshot.frames[1]!.entry = plan.files[1]!.entryInstruction + 1;
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
});

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
    ? Array<Mutable<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

test("a goto or call names a file that exists", () => {
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
  assert.deepEqual(codes('call "rooms/main.tease"\nexit', others), [
    [
      "TSV057",
      "The project has no file 'rooms/main.tease'. Paths start at the package root, such as \"rooms/hall.tease\".",
    ],
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
  assert.deepEqual(codes('goto "cellar/*.tease"'), [
    [
      "TSV057",
      "No file of the project matches 'cellar/*.tease'. Paths start at the package root, such as \"rooms/*.tease\".",
    ],
  ]);
  // Calling a file of declarations only would do nothing, so a glob never picks one.
  assert.deepEqual(codes('call "lib/*.tease"\nexit'), [
    [
      "TSV057",
      "Every file matching 'lib/*.tease' holds declarations only and runs nothing, so there is nothing to pick.",
    ],
  ]);
  assert.deepEqual(codes('call "rooms/*"\nexit'), [
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
    ["repeat 8 {", '    call "rooms/*.tease"', "}", 'goto "ends/*.tease"'].join("\n"),
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
  // Eight calls and the goto draw once each.
  const expected = createXorShift32State(seed);
  for (let draw = 0; draw < 9; draw += 1) nextXorShift32(expected);
  assert.equal(result.finalSnapshot.rng.state, expected.state);
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
          'let t = timer(duration: 1 s, async: true, display: "hidden", persist: true) {',
          "    data[0] = 9",
          "    scores.first = later()",
          '    say "${data[0]} ${scores.first}"',
          "}",
          'goto "wait.tease"',
        ].join("\n"),
        { "wait.tease": "wait 5 s\nexit", "pause.tease": "wait 1 s\nend" },
      ),
    ),
    ["9 9", "exit"],
  );
});

test("a loop of a calling file stays with its call while the called file runs", () => {
  // The same loop of a recursive call is another loop, so the call depth limit ends the recursion.
  const recursive = compiled(
    project('call "a.tease"\nexit', {
      "a.tease": 'repeat 1 { call "b.tease" }\nend',
      "b.tease": 'repeat 1 { call "a.tease" }\nend',
    }),
  );
  const result = run(
    recursive,
    createImmediatePacingRuntimeSnapshot(recursive, { maxCallDepth: 4 }),
  );
  assert.deepEqual(outputs(result.events), ["failure TSR047"]);

  const plan = compiled(
    project('repeat 2 {\n    call "child.tease"\n    say "returned"\n}\nexit', {
      "child.tease": "wait 1 s\nend",
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

test("a plan's global function has no label to go to", () => {
  const plan = compiled(
    project("skip()\nexit", {
      "lib.tease": 'label later\nexit\nglobal function skip { say "skip" }',
    }),
  );
  const lib = plan.files[1]!;
  const skip = plan.functions.find((definition) => definition.name === "skip")!;
  const at = plan.instructions.findIndex(
    (instruction, index) => index >= skip.bodyEntryInstruction && instruction.kind === "say",
  );
  const errors = validateInstructionPlan({
    ...plan,
    instructions: plan.instructions.map((instruction, index) =>
      index === at
        ? { kind: "goto", target: lib.labels[0]!.instruction, span: instruction.span }
        : instruction,
    ),
  }).errors.map((error) => error.message);
  assert.ok(
    errors.includes("A goto in a global function or its blocks has no label to continue at."),
  );
});

test("a timer block may change a loop condition while a called file runs", () => {
  assert.deepEqual(
    said(
      project(
        [
          "let x: integer? = 1",
          "timer async 1 s { x = null }",
          "x = 1",
          'while x != null { call "delay.tease" }',
          'say "stopped"',
          "exit",
        ].join("\n"),
        { "delay.tease": "wait 1 s\nend" },
      ),
    ),
    ["stopped", "exit"],
  );
});

test("a timer names an issued activation, also after that activation is gone", () => {
  const plan = compiled(
    project(
      [
        'let kept = timer(duration: 10 s, async: true, display: "hidden", persist: true)',
        "timer async 10 s",
        'goto "child.tease"',
      ].join("\n"),
      { "child.tease": "wait 1 s\nexit" },
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

test("restore checks a timer's activation against its file and walks only real loop partitions", () => {
  const plan = compiled(
    project('timer async 10 s\ncall "child.tease"\nexit', {
      "child.tease": 'wait 1 s\ngoto "last.tease"',
      "last.tease": "wait 1 s\nend",
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
    project('repeat 2 { call "child.tease" }\nexit', { "child.tease": "wait 1 s\nend" }),
  );
  const inLoop = run(loops, createImmediatePacingRuntimeSnapshot(loops)).snapshot;
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while the fixture breaks one loop base.
  const huge = structuredClone(inLoop) as Mutable<RuntimeSnapshot>;
  const call = huge.callFrames[0]!;
  if (call.kind === "file") call.loopBaseDepth = Number.MAX_SAFE_INTEGER;
  assert.equal(validateRuntimeSnapshot(huge, loops).valid, false);
});

test("lowering appends many transfer destinations without a native argument limit", () => {
  const parsed = parse('call "b.tease"\nexit').program;
  const call = parsed.statements[0]!;
  const program = {
    ...parsed,
    statements: [...Array.from({ length: 150_000 }, () => call), ...parsed.statements.slice(1)],
  };
  const plan = compileStableProject([
    { path: "main.tease", program },
    { path: "b.tease", program: parse("end").program },
  ]);
  assert.equal(
    plan.instructions.filter((instruction) => instruction.kind === "transfer").length,
    150_000,
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
        'let t = timer(duration: 1 s, async: true, display: "hidden", persist: true) { say score }',
        'goto "slow.tease"',
      ].join("\n"),
      { "slow.tease": "wait 2 s\nexit" },
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
    project('goto "ends/*.tease"', { "ends/a.tease": "exit", "ends/b.tease": "exit" }),
  );
  // The same destinations written with their keys in another order.
  const reordered: InstructionPlan = {
    ...plan,
    instructions: plan.instructions.map((instruction) =>
      instruction.kind === "transfer" && "pick" in instruction.destination
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
  const entered = executeInstruction(reordered, createImmediatePacingRuntimeSnapshot(reordered));
  assert.deepEqual(validateRuntimeSnapshot(entered.snapshot, reordered).errors, []);

  // A pick nested in a pick is malformed, however deep.
  type Nested = { readonly file: number; readonly target: number } | { readonly pick: Nested[] };
  let nested: Nested = { file: 0, target: 0 };
  for (let depth = 0; depth < 12_000; depth += 1) nested = { pick: [nested] };
  const deep = {
    ...plan,
    instructions: plan.instructions.map((instruction) =>
      instruction.kind === "transfer" ? { ...instruction, destination: nested } : instruction,
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

test("a computed target that may name main.tease enters it again after its start values", () => {
  const main = [
    "global value: integer | string = 1",
    "global first = true",
    "let count: integer = value",
    "say count",
    "if first {",
    "    first = false",
    '    goto "b.tease"',
    "}",
    "exit",
  ].join("\n");
  const codes = (b: string): string[] =>
    compileProject(
      project(main, { "b.tease": `value = "bad"\n${b}`, "c.tease": "exit" }),
    ).diagnostics.map((diagnostic) => diagnostic.code);
  // A grouped reference, a computed path, and a literal path to main.tease may start main again.
  for (const transfer of [
    'let next = script("main.tease")\ngoto (next)',
    'let path = "main.tease"\ngoto script(path)',
    'goto script("main.tease")',
  ])
    assert.notDeepEqual(codes(transfer), [], transfer);
  // A literal path to another file does not.
  assert.deepEqual(codes('goto script("c.tease")'), []);
});
