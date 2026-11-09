/*
 * File transfers whose compiler verdict the run confirms: each test pins a warning or an error for a construct, then runs
 * it to show the outcome the verdict predicts, on the file-transfer tests' shared host.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject, type CompileOptions, type ProjectSourceFile } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import { pressPermanentButton } from "../../src/runtime/operations/press-permanent-button.js";
import type { RuntimeSnapshot } from "../../src/runtime/snapshot/state.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "../helpers/runtime-equivalence.js";
import { project, outputs, said, compiled } from "../helpers/runtime/file-transfers-host.js";

/** The TSV065 warning of a file that no `goto` or `call` starts (#595). */
function unstarted(path: string): string {
  return `The code of '${path}' never runs, because no 'goto' or 'call' that can run starts the file. Remove the file, or start the file with a 'goto' or 'call'.`;
}

test("a call whose file only the run decides warns, and fails when it starts the running file", () => {
  const warned = (files: ProjectSourceFile[]): string[] =>
    compileProject(files).diagnostics.map(
      (diagnostic) => `${diagnostic.path} ${diagnostic.code} ${diagnostic.message}`,
    );
  const failure = (files: ProjectSourceFile[]): readonly string[] =>
    assertRuntimeResumeEquivalent(files, { ending: "failed", warnings: ["TSV073"] }).events.flatMap(
      (event) => (event.kind === "runtimeFailure" ? [`${event.code} ${event.message}`] : []),
    );
  const message = (path: string) =>
    `TSR069 This call cannot start '${path}', because that file is already running. To run a part of a file and come back, put that part in a function and write the function's name with '()' instead.`;
  const later = (where: string, path: string) =>
    `This call runs later, from the timer on ${where}, so the compiler cannot tell whether '${path}' is already running then. If it is, the call fails. If that can happen, stop the timer while '${path}' runs, or put what '${path}' does in a function and write the function's name with '()' instead.`;
  // A computed target. Where the references of the project can name only the running file, it starts that file.
  assert.deepEqual(
    warned(
      project('call "a.tease"\nexit', { "a.tease": 'let me = script("a.tease")\ncall (me)\nend' }),
    ),
    [
      "a.tease TSV072 This call starts its own file, 'a.tease', which is already running. To run a part of it and come back, put that part in a function and write the function's name with '()' instead. To continue at a label without coming back, write 'goto' and the label.",
    ],
  );
  const computed = project('call "a.tease"\nexit', {
    "a.tease": 'let rooms = [script("a.tease"), script("b.tease")]\ncall (rooms[0])\nend',
    "b.tease": "end",
  });
  assert.deepEqual(warned(computed), [
    "a.tease TSV073 This call's file is known only when it runs, so the compiler cannot tell whether it is its own file, 'a.tease', which is already running. If it is, the call fails. If it can be, put the part to run in a function and write the function's name with '()' instead.",
  ]);
  assert.deepEqual(failure(computed), [message("a.tease")]);
  // A tagged pick whose bound only the run knows.
  const picked = project(
    '---\ntags: punishment: 4\n---\nlet lowest = 3\nlowest = 2\ncall tagged "punishment" > lowest\nexit',
    { "scene.tease": '---\ntags: punishment: 1\n---\nsay "scene"\nend' },
  );
  assert.deepEqual(warned(picked), [
    "main.tease TSV073 This call's tags depend on a value known only when it runs, so the compiler cannot tell whether it can pick its own file, 'main.tease', which is already running. If it does, the call fails. Leave 'main.tease' out with 'from:', or with a tag that it does not have.",
  ]);
  assert.deepEqual(failure(picked), [message("main.tease")]);
  // A block of main.tease that fires while main.tease, or the file it called, runs, also through a function.
  const own = project('timer async 1 s { call "main.tease" }\nwait 2 s\nexit');
  assert.deepEqual(warned(own), [`main.tease TSV073 ${later("line 1", "main.tease")}`]);
  assert.deepEqual(failure(own), [message("main.tease")]);
  const called = project('timer async 1 s { call "b.tease" }\ncall "b.tease"\nexit', {
    "b.tease": "wait 2 s\nend",
  });
  assert.deepEqual(warned(called), [`main.tease TSV073 ${later("line 1", "b.tease")}`]);
  assert.deepEqual(failure(called), [message("b.tease")]);
  const through = project("timer async 1 s { punish() }\nwait 2 s\nexit", {
    "lib.tease": 'global function punish { call "main.tease" }',
  });
  assert.deepEqual(warned(through), [
    `lib.tease TSV073 ${later("line 1 of 'main.tease'", "main.tease")}`,
  ]);
  assert.deepEqual(failure(through), [message("main.tease")]);
  assert.deepEqual(
    warned(project('timer async 1 s { call "rooms/*.tease" }\nexit', { "rooms/a.tease": "end" })),
    [
      "main.tease TSV073 This call runs later, from the timer on line 1, so the compiler cannot tell whether the file it starts is already running then. If it is, the call fails. If that can happen, stop the timer while such a file runs.",
    ],
  );
  // A button's block runs when the button is pressed, and a media block from the media.
  assert.deepEqual(
    warned(
      project('let b = showPermanentButton "Punish" { call "punish.tease" }\nwait 5 s\nexit', {
        "punish.tease": "wait 2 s\nend",
      }),
    ),
    [
      "main.tease TSV073 This call runs later, when the button on line 1 is pressed, so the compiler cannot tell whether 'punish.tease' is already running then. If it is, the call fails. If that can happen, remove the button while 'punish.tease' runs, or put what 'punish.tease' does in a function and write the function's name with '()' instead.",
    ],
  );
  assert.deepEqual(
    warned(
      project(
        'let music = playAudio async "music.mp3" {\n    at 1 s {\n        call "b.tease"\n    }\n}\ncall "b.tease"\nexit',
        { "b.tease": "wait 2 s\nend" },
      ),
    ),
    [
      "main.tease TSV073 This call runs later, from the media on line 1, so the compiler cannot tell whether 'b.tease' is already running then. If it is, the call fails. If that can happen, stop the media while 'b.tease' runs, or put what 'b.tease' does in a function and write the function's name with '()' instead.",
    ],
  );
  // A global function's call of a file whose code calls the function, directly or through another global function:
  // whether the call runs while that file runs depends on the run, by a test or a default here or in a caller.
  const relayed = project('call "rooms/b.tease"\nexit', {
    "rooms/a.tease": "end",
    "rooms/b.tease": "relay()\nend",
    "lib.tease":
      'global function relay { punish() }\nglobal function punish { call "rooms/*.tease" }',
  });
  assert.deepEqual(warned(relayed), [
    "lib.tease TSV073 This call can pick 'rooms/b.tease', which runs global function 'punish', so the compiler cannot tell whether that file is already running when this call picks it. If it is, the call fails. If that can happen, change the pattern so that it does not match 'rooms/b.tease'.",
  ]);
  const guard = (argument: string) =>
    project('visit(false)\nsay "back"\nexit', {
      "b.tease": `visit(${argument})\nsay "b"\nend`,
      "lib.tease":
        'global function visit(alreadyThere: boolean) {\n    if not alreadyThere { call "b.tease" }\n}',
    });
  assert.deepEqual(warned(guard("true")), [
    "lib.tease TSV073 This call starts 'b.tease', which runs global function 'visit', so the compiler cannot tell whether 'b.tease' is already running when the call runs. If it is, the call fails. If that can happen, run 'visit' only from files other than 'b.tease'.",
  ]);
  assert.deepEqual(said(guard("true"), { warnings: ["TSV073"] }), ["b", "back", "exit"]);
  assert.deepEqual(failure(guard("false")), [message("b.tease")]);
  const supplied = project('display("provided")\nexit', {
    "lib.tease":
      'global function visit {\n    call "main.tease"\n    return "done"\n}\nglobal function display(text = visit()) { say text }',
  });
  assert.deepEqual(warned(supplied), [
    "lib.tease TSV073 This call starts 'main.tease', which runs global function 'visit', so the compiler cannot tell whether 'main.tease' is already running when the call runs. If it is, the call fails. If that can happen, run 'visit' only from files other than 'main.tease'.",
  ]);
  assert.deepEqual(said(supplied, { warnings: ["TSV073"] }), ["provided", "exit"]);
  assert.deepEqual(
    warned(
      project("visit()\nexit", {
        "b.tease": "end",
        "lib.tease":
          'global function visit {\n    let rooms = [script("main.tease"), script("b.tease")]\n    call (rooms[1])\n}',
      }),
    ),
    [
      "lib.tease TSV073 This call's file is known only when it runs, so the compiler cannot tell whether it is 'main.tease', which runs global function 'visit'. If it is, and 'main.tease' is running then, the call fails. If that can happen, run 'visit' only from files other than 'main.tease'.",
    ],
  );
  // So does a call of the global function whose run a file's own code decides.
  const visit = 'global function visit {\n    call "main.tease"\n    return "done"\n}';
  for (const [files, outcome] of [
    [
      project('function display(text = visit()) { say text }\ndisplay("provided")\nexit', {
        "lib.tease": visit,
      }),
      ["provided", "exit"],
    ],
    [
      project('global inside = false\nvisit()\nsay "back"\nexit', {
        "b.tease": 'if not inside { visit() }\nsay "b"\nend',
        "lib.tease": 'global function visit {\n    inside = true\n    call "b.tease"\n}',
      }),
      ["b", "back", "exit"],
    ],
    // A block may end the wait before the call of the function.
    [
      project("timer async 1 s { exit }\nwait 2 s\nvisit()\nexit", { "lib.tease": visit }),
      ["exit"],
    ],
  ] as const) {
    assert.deepEqual(
      warned(files).map((line) => line.split(" ", 2).join(" ")),
      ["lib.tease TSV073"],
    );
    assert.deepEqual(said(files, { warnings: ["TSV073"] }), outcome);
  }
  // A block that calls a file which ends the session may leave first, so the call only warns (#1402 review r1).
  assert.deepEqual(
    warned(
      project('timer async 1 s { call "stop.tease" }\nwait 2 s\nvisit()\nexit', {
        "lib.tease": 'global function visit { call "main.tease" }',
        "stop.tease": 'say "stopped", instant\nexit',
      }),
    ).map((line) => line.split(" ", 2).join(" ")),
    ["main.tease TSV073", "lib.tease TSV073"],
  );
  // Where every way through the file runs the global function up to its call of that file, the call fails whenever the
  // file runs, which is an error (#1146).
  for (const [main, lib] of [
    ["visit()\nexit", 'global function visit { call "main.tease" }'],
    [
      'say "start"\nrelay()\nexit',
      'global function relay { visit() }\nglobal function visit { call "main.tease" }',
    ],
  ] as const)
    assert.deepEqual(warned(project(main, { "lib.tease": lib })), [
      "lib.tease TSV072 This call starts 'main.tease', which is already running, because 'main.tease' always runs global function 'visit' up to this call. Run 'visit' only from files other than 'main.tease'.",
    ]);
  // Where the known values rule the running file out, and references name only other files, the call runs.
  assert.deepEqual(
    said(
      project(
        '---\ntags: punishment: 1\n---\nlet minimum = 3\ncall tagged "punishment" > minimum\nlet next = [script("scene.tease")]\ncall (next[0])\nexit',
        { "scene.tease": '---\ntags: punishment: 4\n---\nsay "scene"\nend' },
      ),
    ),
    ["scene", "scene", "exit"],
  );
});

test("a block runs later, so its end and its call of a file only warn and are checked when they run", () => {
  const press = (plan: InstructionPlan, snapshot: RuntimeSnapshot) => {
    const pressed = pressPermanentButton(plan, snapshot, 1);
    assert.equal(pressed.outcome.kind, "pressed");
    const after = run(plan, pressed.snapshot);
    return [...pressed.events, ...after.events];
  };
  // A Skip button of main.tease ends the file that main.tease called, while it waits (#1146). It can only be pressed
  // then, so its end has a call to return to.
  const scene = { "scene.tease": 'say "scene"\nwait 2 s\nsay "never"\nend' };
  const skip = compileProject(
    project('let skip = showPermanentButton "Skip" { end }\ncall "scene.tease"\nexit', scene),
  );
  assert.deepEqual(skip.diagnostics, []);
  const waiting = run(skip.plan!, createImmediatePacingRuntimeSnapshot(skip.plan!));
  assert.deepEqual(outputs([...waiting.events, ...press(skip.plan!, waiting.snapshot)]), [
    "scene",
    "exit",
  ]);
  // Once the call has come back, a message's reading time is a wait in main.tease, where no call waits.
  assert.deepEqual(
    compileProject(
      project(
        'let skip = showPermanentButton "Skip" { end }\ncall "scene.tease"\nsay "back"\nexit',
        scene,
      ),
    ).diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
    [
      [
        "TSV071",
        "This 'end' runs later, when the button on line 1 is pressed, so the compiler cannot tell whether it has a call to return to then. Without one, the 'end' fails. If that can happen, use 'exit' or 'goto' here instead of 'end'.",
      ],
    ],
  );
  // A timer may be due without a wait: one of no length, or one whose handle may set what remains to zero. A button may
  // then be pressed while the timer's block waits, and its block runs where that one returns to. Each still warns.
  for (const [main, line] of [
    ['timer async 0 s { end }\ncall "scene.tease"\nexit', 1],
    ['let t = timer async 1 s { end }\ncall "scene.tease"\nexit', 1],
    [
      'let skip = showPermanentButton "Skip" { end }\ntimer async 0 s { let hold = askBoolean "Hold?" }\ncall "scene.tease"\nexit',
      1,
    ],
  ] as const)
    assert.deepEqual(
      compileProject(project(main, scene)).diagnostics.map(
        (diagnostic) => `${diagnostic.code} ${diagnostic.span.start.line + 1}`,
      ),
      [`TSV071 ${line}`],
      main,
    );
  assert.deepEqual(
    said(project('timer async 0 s { end }\ncall "scene.tease"\nexit', scene), {
      warnings: ["TSV071"],
      ending: "failed",
    }),
    ["failure TSR066"],
  );
  // Two copies of a button may stay where the file that shows it starts again while the first stays: one copy may be
  // pressed while the other's block waits, and run where that one's end returns to.
  for (const [main, others] of [
    [
      'call "scene.tease"\ncall "scene.tease"\nexit',
      {
        "scene.tease":
          'let skip = showPermanentButton "Skip", persist: true { end }\nwait 2 s\nend',
      },
    ],
    [
      'let skip = showPermanentButton "Skip" {\n    say "skipping"\n    end\n}\ncall "g.tease"\nexit',
      {
        "g.tease": 'let again = askBoolean "Again?"\nif again { call "h.tease" }\nwait 1 s\nend',
        "h.tease": 'call "main.tease"\nend',
      },
    ],
  ] as const)
    assert.deepEqual(
      compileProject(project(main, others))
        .diagnostics.filter((diagnostic) => diagnostic.code === "TSV071")
        .map((diagnostic) => diagnostic.path),
      [Object.keys(others).length === 1 ? "scene.tease" : "main.tease"],
      main,
    );
  // A block created in a block's frame, also by a global function the block calls, belongs to the entry of that block,
  // which may stay after the called file ended. A block's goto to a label goes on in its own entry, here main.tease,
  // where no call waits (#1402 review r1).
  for (const [main, others, warned] of [
    [
      'global function spawn {\n    timer async 0 s { end }\n}\ntimer async 1 s {\n    spawn()\n    end\n}\ncall "scene.tease"\nexit',
      { "scene.tease": "wait 5 s\nend" },
      ["main.tease TSV071 2", "main.tease TSV071 6"],
    ],
    [
      'let skip = showPermanentButton "Skip" { goto later }\ncall "scene.tease"\nexit\nlabel later\nsay "later"\nend',
      scene,
      ["main.tease TSV071 6"],
    ],
  ] as const)
    assert.deepEqual(
      compileProject(project(main, others)).diagnostics.map(
        (diagnostic) => `${diagnostic.path} ${diagnostic.code} ${diagnostic.span.start.line + 1}`,
      ),
      warned,
      main,
    );
  // Where that entry was called, the call waits below it as long as the blocks stay, so they are safe (#1402 review r2).
  for (const holder of [
    'timer async 1 s {\n    timer async 1 s { end }\n}\ncall "scene.tease"\nend',
    'timer async 1 s {\n    showPermanentButton "Continue" { goto later }\n}\ncall "scene.tease"\nend\nlabel later\nsay "later"\nend',
  ])
    assert.deepEqual(
      compileProject(
        project('call "holder.tease"\nexit', {
          "holder.tease": holder,
          "scene.tease": "wait 5 s\nend",
        }),
      ).diagnostics,
      [],
      holder,
    );
  // One with a length written out whose handle is not kept is due only once the called file waited.
  assert.deepEqual(said(project('timer async 1 s { end }\ncall "scene.tease"\nexit', scene)), [
    "scene",
    "exit",
  ]);
  // A Replay button that a called file shows calls that file again once main.tease runs. Pressed while the file
  // runs, it would fail, so the call warns.
  const replayed = compileProject(
    project('call "scene.tease"\nwait 2 s\nexit', {
      "scene.tease": 'say "scene"\nsetup()\nend',
      "lib.tease":
        'global function setup {\n    let replay = showPermanentButton "Replay", persist: true { call "scene.tease" }\n}',
    }),
  );
  assert.deepEqual(
    replayed.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
    [["lib.tease", "TSV073"]],
  );
  const replay = replayed.plan!;
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
      `A 'goto' to 'rooms/hall.tease' starts it at its top, so it cannot go to label 'start'. Write 'goto "rooms/hall.tease"', or put the part after 'start' in a file of its own and 'goto' that file.`,
    ],
    [
      'if false { call "rooms/hall.tease" start }\nexit',
      "A call starts 'rooms/hall.tease' at its top, so it cannot go to label 'start'. Put the part after 'start' in a file of its own and call that file, or in a global function.",
    ],
    [
      'goto "rooms/*.tease" start',
      "A 'goto' starts the file it picks at its top, so it cannot go to label 'start'. Put the part after 'start' in a file of its own and 'goto' that file.",
    ],
    [
      'let next = script("rooms/hall.tease", label: "start")\ngoto (next)',
      "A file is always entered at its top, so 'script(...)' takes no 'label:'. Put the part after 'start' in a file of its own and name that file in 'script(...)'.",
    ],
    [
      'let name = "start"\ncall script("rooms/hall.tease", label: name)\nexit',
      "A file is always entered at its top, so 'script(...)' takes no 'label:'. Put the part after the label in a file of its own and name that file in 'script(...)'.",
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
          "A global function can run in any file, so it cannot go to label 'later' of 'lib.tease'. Put the part after the label in a file of its own and 'goto' that file, or in a global function that does the work and returns.",
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

test("an end with no call to return to is an error where code that runs without one always leads to it", () => {
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
      "This 'end' has no call to return to, because the session starts in 'main.tease' without one. Use 'exit' to finish the session, or 'goto' to continue in another file.",
    ],
  ]);
  const scene = { "scene.tease": 'say "scene"\nend' };
  const noCall = (line: number) =>
    `This 'end' has no call to return to when the 'goto' on line ${line} of 'main.tease' leads here. Write 'call' instead of 'goto' there to come back after it, or use 'exit' or 'goto' here instead of 'end'.`;
  const leave = { "scene.tease": "leave()\nexit\nfunction leave { end }" };
  // Also in a function that the file calls, and where a test that the compiler does not read keeps the goto from
  // running: the goto fails whenever it runs.
  for (const [main, others, line] of [
    ['say "start"\ngoto "scene.tease"', scene, 2],
    ['say "start"\ngoto "scene.tease"', leave, 2],
    ['let n = 1\nif n == 1 { exit }\ngoto "scene.tease"', scene, 3],
    // Also when another way calls the file, where the code after the goto always goes on to the end: through
    // branches that meet again, a call of a file that comes back, and a call of a function that ends the file.
    [
      'let pick = askBoolean "Call it?"\nif pick { call "scene.tease" } else { goto "scene.tease" }\nexit',
      scene,
      2,
    ],
    [
      'call "scene.tease"\ngoto "scene.tease"',
      {
        "scene.tease":
          'call "intro.tease"\nif askBoolean "Ready?" { say "yes" } else { say "no" }\nend',
        "intro.tease": 'say "intro"\nend',
      },
      2,
    ],
    ['call "scene.tease"\ngoto "scene.tease"', leave, 2],
  ] as const) {
    const found = diagnostics(main, others).filter(([, code]) => code === "TSV070");
    assert.deepEqual(
      found.map(([path, code]) => [path, code]),
      [["scene.tease", "TSV070"]],
      main,
    );
    assert.equal(found[0]![2], noCall(line));
  }
  // A script(...) of a path written out names its file, like a file target.
  assert.deepEqual(
    diagnostics('goto script("scene.tease")', scene).map(([path, code]) => [path, code]),
    [["scene.tease", "TSV070"]],
  );
  // A tagged pick may start only the files whose tags it may match, by its tag tests and literal tag lists, so the
  // scene never runs.
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
      [["scene.tease", "TSV065", unstarted("scene.tease")]],
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
  const others = { "scene.tease": 'say "scene"\nend', "done.tease": "exit" };
  const files = project(
    'let rooms = [script("scene.tease"), script("done.tease")]\ngoto (rooms[0])',
    others,
  );
  assert.deepEqual(diagnostics(files[0]!.source, others), [
    [
      "scene.tease",
      "TSV071",
      "The 'goto' on line 2 of 'main.tease' picks its file when it runs, so the compiler cannot tell whether this 'end' has a call to return to then. Without one, the 'end' fails. If that 'goto' can lead here, write 'call' instead of 'goto' there, or use 'exit' or 'goto' here instead of 'end'.",
    ],
  ]);
  const plan = compileProject(files).plan!;
  const ended = run(plan, createImmediatePacingRuntimeSnapshot(plan)).events;
  assert.deepEqual(outputs(ended), ["scene", "failure TSR066"]);
  assert.deepEqual(
    ended.flatMap((event) => (event.kind === "runtimeFailure" ? [event.message] : [])),
    [
      "This 'end' has no call to return to, because no file called this one. Start this file with 'call' where it should come back, or use 'exit' where the session should finish.",
    ],
  );
  // Also where the references of the project can name only one file: whether a way through the reference reaches the
  // end with no call waiting depends on the run, here on a global that the end's file tests (#1015 review r1, B1).
  assert.deepEqual(
    said(
      project(
        'global cameByCall = false\nlet next = script("room.tease")\ncameByCall = true\ncall (next)\ncameByCall = false\ngoto (next)',
        { "room.tease": 'say "room"\nif not cameByCall { exit }\nend' },
      ),
      { warnings: ["TSV071"] },
    ),
    ["room", "room", "exit"],
  );
  // The same with the file written out: after the goto, the code before the end may leave first, here when the test of
  // the global fails, so the end may never fail. The compiler does not read such a test, so it warns.
  const cameByCall =
    'global cameByCall = false\ncameByCall = true\ncall "room.tease"\ncameByCall = false\ngoto "room.tease"';
  const room = { "room.tease": 'say "room"\nif not cameByCall { exit }\nend' };
  assert.deepEqual(diagnostics(cameByCall, room), [
    [
      "room.tease",
      "TSV071",
      "This 'end' has no call to return to when the 'goto' on line 5 of 'main.tease' leads here, but the compiler cannot tell whether the script reaches it then. If it does, the 'end' fails. If that can happen, write 'call' instead of 'goto' there, or use 'exit' or 'goto' here instead of 'end'.",
    ],
  ]);
  // Also where a function or a called file leaves first.
  for (const others of [
    room,
    {
      "room.tease": 'say "room"\ncheck()\nend\nfunction check {\n    if not cameByCall { exit }\n}',
    },
    {
      "room.tease": 'say "room"\ncall "check.tease"\nend',
      "check.tease": "if not cameByCall { exit }\nend",
    },
  ])
    assert.deepEqual(said(project(cameByCall, others), { warnings: ["TSV071"] }), [
      "room",
      "room",
      "exit",
    ]);
  // Also a block that calls a file which ends the session (#1402 review r1).
  assert.deepEqual(
    said(
      project('global byCall = true\ncall "room.tease"\nbyCall = false\ngoto "room.tease"', {
        "room.tease":
          'if not byCall {\n    timer async 1 s { call "stop.tease" }\n}\nwait 2 s\nend',
        "stop.tease": 'say "stopped", instant\nexit',
      }),
      { warnings: ["TSV073", "TSV071"] },
    ),
    ["stopped", "exit"],
  );
  // A block may run while the code waits and leave first: here a timer that the goto does not stop.
  assert.deepEqual(
    said(
      project(
        'call "room.tease"\nlet t = timer(duration: 1 s, async: true, persist: true) { exit }\ngoto "room.tease"',
        { "room.tease": 'say "room"\nwait 2 s\nend' },
      ),
      { warnings: ["TSV071"] },
    ),
    ["room", "room", "exit"],
  );
});

test("a computed target may start only the files that a reference of the project may name", () => {
  const warnings = (files: ProjectSourceFile[], options: CompileOptions = {}): string[] =>
    compileProject(files, options).diagnostics.map(
      (diagnostic) => `${diagnostic.path} ${diagnostic.code}`,
    );
  // V30 §29: the called files' ends have a call waiting, and the reference names rooms/hall.tease only.
  const called = {
    "a.tease": 'say "a"\nend',
    "b.tease": 'say "b"\nend',
    "c.tease": 'say "c"\nend',
    "rooms/hall.tease": 'say "hall"\nexit',
  };
  const example = project(
    'call "a.tease"\ncall "b.tease"\ncall "c.tease"\nlet next = script("rooms/hall.tease")\ngoto (next)',
    called,
  );
  assert.deepEqual(warnings(example), []);
  assert.deepEqual(said(example), ["a", "b", "c", "hall", "exit"]);
  // A text with ${...} names the files its texts allow; a load of a number gives no reference. Nothing starts the
  // other files.
  assert.deepEqual(
    warnings(
      project(
        'call "a.tease"\nlet room = load "room", default: "hall"\ngoto script("rooms/${room}.tease")',
        called,
      ),
    ),
    ["b.tease TSV065", "c.tease TSV065"],
  );
  // ADR 0023: a pool of findScripts(...) names the files it may list; one of them that ends still warns.
  const tagged = (tags: string, source: string) => `---\ntags: ${tags}\n---\n${source}`;
  const pool = {
    "scene.tease": 'say "scene"\nend',
    "modules/strict.tease": tagged("punishment: 5", 'say "strict"\nexit'),
    "modules/soft.tease": tagged("punishment: 1", 'say "soft"\nend'),
    "modules/corner.tease": tagged("punishment: 4", 'say "corner"\nend'),
    "fallback.tease": 'say "none"\nexit',
  };
  assert.deepEqual(
    warnings(
      project(
        [
          'call "scene.tease"',
          'let pool = findScripts(from: "modules/*.tease", where: "punishment" > 3)',
          'if pool.length > 0 { goto (pool.random) } else { goto "fallback.tease" }',
        ].join("\n"),
        pool,
      ),
    ),
    ["modules/corner.tease TSV071", "modules/soft.tease TSV065"],
  );
  // A reference that a load may give, which an earlier session may have saved, or a host value, may name any file.
  for (const [main, options] of [
    [
      'call "a.tease"\nlet next = load "next", default: script("rooms/hall.tease")\ngoto (next)',
      {},
    ],
    ['call "a.tease"\ngoto (host)', { globals: ["host"] }],
  ] as const)
    assert.deepEqual(
      warnings(project(main, called), options),
      ["a.tease TSV071", "b.tease TSV071", "c.tease TSV071"],
      main,
    );
  // Only where the target reads one (#1146): a host value that it does not read leaves it to the file it names.
  assert.deepEqual(
    warnings(
      project('call "a.tease"\nlet next = script("rooms/hall.tease")\ngoto (next)', called),
      { globals: ["host"] },
    ),
    ["b.tease TSV065", "c.tease TSV065"],
  );
});

test("an object that a load gives may hold a reference to any file", () => {
  // A saved object holds a reference in a property that the reader's type does not list.
  const scene = { "scene.tease": 'say "scene"\nend' };
  const writer = compiled(project('save { next: script("scene.tease") } as "data"\nexit', scene), [
    "scene.tease",
  ]);
  const scriptStorage = run(writer, createImmediatePacingRuntimeSnapshot(writer)).snapshot
    .scriptStorage;
  const reader = project(
    'let data: object = load "data", default: {}\nif data.next is script { goto (data.next) }\nexit',
    scene,
  );
  assert.deepEqual(
    outputs(
      assertRuntimeResumeEquivalent(reader, {
        scriptStorage,
        warnings: ["TSV071"],
        ending: "failed",
      }).events,
    ),
    ["scene", "failure TSR066"],
  );
  // Only where the target reads it (#1146): such a load elsewhere, also of an object in a list or of an object whose
  // type lists other properties, leaves a target that reads none to the files it names.
  for (const load of [
    'let items: object[] = load "items", default: []',
    'let data = load "data", default: { count: 0 }',
  ])
    assert.deepEqual(
      compileProject(
        project(`${load}\ncall "scene.tease"\nlet next = script("done.tease")\ngoto (next)`, {
          ...scene,
          "done.tease": "exit",
        }),
      ).diagnostics.map((diagnostic) => `${diagnostic.path} ${diagnostic.code}`),
      [],
      load,
    );
});
