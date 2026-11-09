/*
 * The compiler's checks of file transfers (`goto` and `call` naming a file, ends, globs, computed targets, the plan's
 * entries), read from its diagnostics, lowering and plan validation, on the file-transfer tests' shared host.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject, type ProjectSourceFile } from "../../src/compiler.js";
import { compileStableProject } from "../../src/compiler/compile-program.js";
import { parse } from "../../src/parser.js";
import { validateInstructionPlan } from "../../src/plan/validation.js";
import { project, compiled } from "../helpers/runtime/file-transfers-host.js";

test("a call starts another file, so a label or a call that can start the running file is an error", () => {
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
      "A call only starts a file, at its top, so 'call greeting' cannot go to a label or function of this file. Write 'goto greeting' to continue at a label, or 'greeting()' to run a function.",
    ],
  ]);
  const ownFile =
    "This call starts its own file, 'main.tease', which is already running. To run a part of it and come back, put that part in a function and write the function's name with '()' instead. To continue at a label without coming back, write 'goto' and the label.";
  // Every spelling of the file, also where the call never runs.
  for (const call of ['call "main.tease"', 'call script("main.tease")'])
    assert.deepEqual(
      diagnostics(project(`${call}\nexit`)),
      [["main.tease", "TSV072", ownFile]],
      call,
    );
  assert.deepEqual(diagnostics(project('if false { call "main.tease" }\nexit')), [
    [
      "main.tease",
      "TSV065",
      "This code never runs, because the condition on line 1 is never true. Remove it, or change the condition.",
    ],
    ["main.tease", "TSV072", ownFile],
  ]);
  const rooms = { "rooms/a.tease": "exit", "rooms/b.tease": "exit" };
  assert.deepEqual(
    diagnostics(
      project('goto "rooms/a.tease"', { ...rooms, "rooms/a.tease": 'call "rooms/*.tease"\nexit' }),
    ),
    [
      [
        "rooms/a.tease",
        "TSV072",
        "This call can pick its own file, 'rooms/a.tease', which is already running. Change the pattern so that it does not match 'rooms/a.tease'.",
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
        "TSV072",
        "This call can pick its own file, 'a.tease', which is already running. Leave 'a.tease' out with 'from:', or with a tag that it does not have.",
      ],
    ],
  );
  // A comparison is false for a file without a number for its tag, and a bound or a tag list is decided by its known
  // value; where none is known, the call only warns (V30 §13, §41).
  const scenes = { "scene.tease": '---\ntags: punishment: 4\n---\nsay "scene"\nend' };
  const values = 'let minimum = 3\nlet wanted = ["punishment"]\nlet lowest = 3\nlowest = 0\n';
  for (const [header, pick, codes] of [
    ["", '"punishment" > lowest', []],
    ['---\ntags: "punishment"\n---\n', '"punishment" > lowest', []],
    ["---\ntags: punishment: 1\n---\n", '"punishment" > 3', []],
    ["---\ntags: punishment: 4\n---\n", '"punishment" > 3', ["TSV072"]],
    ["---\ntags: punishment: 1\n---\n", '"punishment" > minimum', []],
    ["---\ntags: punishment: 4\n---\n", '"punishment" > minimum', ["TSV072"]],
    ["---\ntags: punishment: 1\n---\n", '"punishment" > lowest', ["TSV073"]],
    ["", "all: wanted", []],
    ['---\ntags: "punishment"\n---\n', "all: wanted", ["TSV072"]],
  ] as const)
    assert.deepEqual(
      diagnostics(project(`${header}${values}call tagged ${pick}\nsay "back"\nexit`, scenes)).map(
        ([path, code]) => `${path} ${code}`,
      ),
      codes.map((code) => `main.tease ${code}`),
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
  // A global function runs in the files whose code calls it where it can run, directly or through another global
  // function, and its call there only warns (see below). A caller in code that never runs does not count.
  const lib = {
    "lib.tease":
      'global function relay { punish() }\nglobal function punish { call "rooms/*.tease" }',
  };
  assert.deepEqual(diagnostics(project("relay()\nexit", { ...rooms, ...lib })), []);
  for (const caller of ["exit\nrelay()", "function never { relay() }\nexit"])
    assert.deepEqual(
      diagnostics(project("relay()\nexit", { ...rooms, ...lib, "rooms/b.tease": caller }))
        .filter(([, code]) => code !== "TSV065")
        .map(([path, code]) => `${path} ${code}`),
      [],
      caller,
    );
});

test("an end warns or fails only where the ways into its file decide it, for every entry, target, and block (#1146)", () => {
  // Generated over where the `end`s stand (the file's top level, a block of that file, or a block of the file that
  // calls it), how that file is entered (`call`, `goto`, or both), how many `end`s it has, and how the transfers name
  // it. Every project also holds what made the checks project-wide: a `script(...)` of any path, a load of an object,
  // and a called file whose block may leave the code it interrupts.
  const placements = [
    ["top", "button"],
    ["scene", "button"],
    ["scene", "timer"],
    ["scene", "media"],
    ["caller", "button"],
    ["caller", "timer"],
  ] as const;
  const entries = ["call", "goto", "both"] as const;
  const targets = {
    literal: { prelude: "", target: '"scene.tease"' },
    computed: { prelude: 'let next = script("scene.tease")\n', target: "(next)" },
    tagged: { prelude: "", target: 'tagged "scene"' },
    load: { prelude: 'let next = load "next", default: script("scene.tease")\n', target: "(next)" },
  } as const;
  const ends = (count: 1 | 2, test: string) =>
    count === 1 ? "{ end }" : `{\n    if ${test} { end }\n    say "bye"\n    end\n}`;
  const block = (kind: "button" | "timer" | "media", body: string) =>
    kind === "button"
      ? `let skip = showPermanentButton "Skip" ${body}`
      : kind === "timer"
        ? `timer async 1 s ${body}`
        : `playAudio async "music.mp3" {\n    at 1 s ${body.replaceAll("\n", "\n    ")}\n}`;
  const noise = {
    "lib.tease": "global function anywhere(path) { return script(path) }",
    "far.tease": 'timer async 1 s { goto "other.tease" }\nwait 2 s\nend',
    "other.tease": 'say "other"\nexit',
  };
  let members = 0;
  for (const [where, blockKind] of placements)
    for (const entry of entries)
      for (const count of [1, 2] as const)
        for (const [kind, { prelude, target }] of Object.entries(targets)) {
          const caller =
            where === "caller" ? `${block(blockKind, ends(count, "data.count > 0"))}\n` : "";
          const transfer =
            entry === "call"
              ? `${caller}call ${target}\nexit`
              : entry === "goto"
                ? `let stop = askBoolean "Stop?"\nif stop { exit }\n${caller}goto ${target}`
                : `let pick = askBoolean "Call it?"\n${caller}if pick { call ${target} } else { goto ${target} }\nexit`;
          const again = count === 2 ? 'let again = askBoolean "Again?"\n' : "";
          const scene =
            (kind === "tagged" ? '---\ntags: "scene"\n---\n' : "") +
            (where === "top"
              ? count === 1
                ? 'say "scene"\nend'
                : `${again}if again { end }\nsay "bye"\nend`
              : where === "scene"
                ? `${again}${block(blockKind, ends(count, "again"))}\nwait 5 s\nexit`
                : 'say "scene"\nwait 2 s\nend');
          const main = `call "far.tease"\nlet data = load "data", default: { count: 0 }\n${prelude}${transfer}`;
          // The oracle. Called, the file's ends have a call to return to. Entered by a goto with none, an end of its top
          // level fails for certain when the goto names the file, also when a call reaches it too; a computed target
          // hides that. A block of the file may run while no call waits, so its end warns. A block of the calling file
          // runs only while the called file runs, or never, as a goto leaves the entry that created it.
          const scenes = where === "top" ? count : 1;
          const named = kind === "literal" || kind === "tagged";
          const expected: string[] = [];
          if (entry !== "call" && where !== "scene")
            for (let index = 0; index < scenes; index += 1)
              expected.push(`scene.tease ${named ? "TSV070" : "TSV071"}`);
          // A loaded reference may name any file: the declarations of lib.tease, far.tease, which ends, or main.tease,
          // which may then start again, as the checks see it, with a second copy of a block that outlives its file
          // entry: one of main.tease, or a media block.
          const copies = kind === "load" && entry !== "goto";
          if (where === "scene" && (entry !== "call" || (copies && blockKind === "media")))
            for (let index = 0; index < count; index += 1) expected.push("scene.tease TSV071");
          if (where === "caller" && copies)
            for (let index = 0; index < count; index += 1) expected.push("main.tease TSV071");
          if (kind === "load" && entry !== "call")
            expected.push("main.tease TSV074", "far.tease TSV071");
          if (copies) expected.push("main.tease TSV073");
          const label = `${where} ${where === "top" ? "" : blockKind}, ${entry}, ${count} end(s), ${kind}`;
          assert.deepEqual(
            compileProject(project(main, { ...noise, "scene.tease": scene }))
              .diagnostics.map((diagnostic) => `${diagnostic.path} ${diagnostic.code}`)
              .sort(),
            expected.sort(),
            label,
          );
          members += 1;
        }
  assert.equal(members, 144);
});

test("the files that references may name are found without a native argument or stack limit", () => {
  for (const main of [
    `let values = [${"0, ".repeat(139_999)}0]`,
    `let data: integer${"[]".repeat(10_000)} = load "data", default: []`,
  ]) {
    const result = compileProject(project(`${main}\ncall "a.tease"\nexit`, { "a.tease": "end" }));
    assert.deepEqual(result.diagnostics, [], main.slice(0, 40));
    assert.notEqual(result.plan, null, main.slice(0, 40));
  }
});

test("a fallback statement is no statement", () => {
  assert.deepEqual(
    compileProject(project('fallback "a.tease"\nexit', { "a.tease": "exit" })).diagnostics.map(
      (diagnostic) => [diagnostic.code, diagnostic.message],
    ),
    [
      [
        "TSP001",
        "TeaseScript has no 'fallback': an 'end' returns to the file that called this one. Use 'call' to start a file that should come back here, and 'goto' or 'exit' where no call waits.",
      ],
    ],
  );
});

test("a function is no target of a call or goto", () => {
  // V30 §10: a function runs by its name and '()', without 'call'.
  const found = (main: string): [string, string, string][] =>
    compileProject(project(main)).diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
      main.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
    ]);
  const scene = 'function scene(level = 1) { say "scene ${level}" }\n';
  assert.deepEqual(found(`${scene}call scene()\nexit`), [
    [
      "TSP039",
      "A call only starts a file, so it cannot run function 'scene'. Leave out 'call' to run it.",
      "scene()",
    ],
  ]);
  assert.deepEqual(found(`${scene}if true {\n    call scene(level: 2)\n}\nexit`), [
    [
      "TSP039",
      "A call only starts a file, so it cannot run function 'scene'. Leave out 'call' to run it.",
      "scene(level: 2)",
    ],
  ]);
  assert.deepEqual(found(`${scene}goto scene()\nexit`), [
    [
      "TSP039",
      "A 'goto' only goes to a label or a file, so it cannot run function 'scene'. Leave out 'goto' to run it.",
      "scene()",
    ],
  ]);
  // The statement ends after the call, also at the `}` of a compact block, so the statements around it stay.
  const compact = `${scene}if true { call scene() } else { goto scene() }\nexit`;
  assert.deepEqual(
    found(compact).map(([code, , text]) => [code, text]),
    [
      ["TSP039", "scene()"],
      ["TSP039", "scene()"],
    ],
  );
  assert.deepEqual(
    parse(compact).program.statements.map((statement) => statement.kind),
    ["functionDeclaration", "ifStatement", "exitStatement"],
  );
});

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
      "'helpers.tease' holds declarations only and runs nothing, so going there would end nowhere. Use its global functions, speakers, and globals in any file without going there.",
    ],
  ]);
  // Calling such a file runs nothing and returns at once.
  assert.deepEqual(
    codes('call "helpers.tease"\nexit', { "helpers.tease": others["helpers.tease"] }),
    [],
  );
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
    [
      "TSV057",
      "'rooms/*' is not a pattern of package file paths: the path does not name a .tease file.",
    ],
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
    ["lib.tease"],
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
