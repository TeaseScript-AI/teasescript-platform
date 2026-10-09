import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, type ProjectSourceFile } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

const NO_FILE =
  "No file in the project that runs something has these tags. A file of declarations only is never picked.";

/** Tagged modules that finish with `ending`: `exit` after a `goto`, `end` to return from a `call`. */
function modules(ending: "end" | "exit"): Record<string, string> {
  return {
    "rooms/strict.tease": `---\ntitle: "Strict"\ntags: "chastity", punishment: 4\n---\nsay "strict"\n${ending}`,
    "rooms/soft.tease": `---\ntags: punishment: 1\n---\nsay "soft"\n${ending}`,
    "rooms/public.tease": `---\ntags: "public", punishment: 5\n---\nsay "public"\n${ending}`,
    "notes.tease": `say "notes"\n${ending}`,
  };
}

function project(main: string, ending: "end" | "exit" = "exit"): ProjectSourceFile[] {
  return [
    { path: "main.tease", source: main },
    ...Object.entries(modules(ending)).map(([path, source]) => ({ path, source })),
  ];
}

function says(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

/** What the project says, run to its end, also stepwise with a checkpoint restore at every boundary. */
function said(main: string, ending: "end" | "exit" = "exit"): string[] {
  return says(assertRuntimeResumeEquivalent(project(main, ending)).events);
}

function compiled(main: string, ending: "end" | "exit" = "exit"): InstructionPlan {
  const result = compileProject(project(main, ending));
  assert.deepEqual(result.diagnostics, []);
  return result.plan!;
}

/** What the project says with each random draw taken from `draws`, and how many draws it took. */
function drawn(
  main: string,
  draws: readonly number[],
  ending: "end" | "exit" = "exit",
): { says: string[]; draws: number } {
  const plan = compiled(main, ending);
  let next = 0;
  const finished = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
    random: { next: () => draws[next++] ?? 0 },
  });
  assert.equal(finished.snapshot.status, "halted");
  return { says: says(finished.events), draws: next };
}

function errors(main: string): [string, string][] {
  return compileProject(project(main))
    .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => [diagnostic.code, diagnostic.message]);
}

test("a file's header tags are in the plan file table, in name order", () => {
  const plan = compiled("exit");
  assert.deepEqual(
    plan.files.map((file) => [file.path, file.tags]),
    [
      ["main.tease", []],
      ["notes.tease", []],
      [
        "rooms/public.tease",
        [
          { name: "public", value: null },
          { name: "punishment", value: 5 },
        ],
      ],
      ["rooms/soft.tease", [{ name: "punishment", value: 1 }]],
      [
        "rooms/strict.tease",
        [
          { name: "chastity", value: null },
          { name: "punishment", value: 4 },
        ],
      ],
    ],
  );
  assert.equal(validateInstructionPlan(plan).valid, true);
});

test("findScripts lists script references to the matching files, in path order", () => {
  assert.deepEqual(
    said(
      [
        "let minimum = 3",
        'let strict = findScripts(where: "punishment" > minimum and not "public")',
        'let rooms = findScripts(from: "rooms/*.tease")',
        'let none = findScripts(where: "attic")',
        "say strict.length",
        "say rooms.length",
        "say none.length",
        "goto (strict[0])",
      ].join("\n"),
    ),
    ["1", "3", "0", "strict"],
  );
});

test("goto tagged and call tagged pick one matching file with one draw, entering it at its top", () => {
  // Only one file passes, so the draw cannot change the pick.
  assert.deepEqual(drawn('goto tagged "punishment" > 3, none: ["public"]', [0.99]), {
    says: ["strict"],
    draws: 1,
  });
  // Two files pass in path order, soft then strict; the draw picks one.
  for (const [draw, picked] of [
    [0, "soft"],
    [0.99, "strict"],
  ] as const) {
    assert.deepEqual(
      drawn('call tagged "punishment", from: "rooms/s*.tease"\nsay "back"\nexit', [draw], "end"),
      { says: [picked, "back"], draws: 1 },
    );
  }
  // A checkpoint restore at every boundary never draws again.
  assert.deepEqual(said('call tagged "chastity"\nsay "back"\nexit', "end"), ["strict", "back"]);
});

test("fallback tagged picks the file when the statement runs", () => {
  const files: ProjectSourceFile[] = [
    { path: "main.tease", source: 'fallback tagged "finale"\nsay "main"\nend' },
    { path: "finale.tease", source: '---\ntags: "finale"\n---\nsay "finale"\nexit' },
  ];
  assert.deepEqual(says(assertRuntimeResumeEquivalent(files).events), ["main", "finale"]);
});

test("a pick whose literal tags match no file is a compile error; one that only may match fails at runtime", () => {
  assert.deepEqual(errors('goto tagged "attic"'), [["TST002", NO_FILE]]);
  assert.deepEqual(errors('goto tagged "public", from: "rooms/s*.tease"'), [["TST002", NO_FILE]]);
  // Grouping keeps a written list literal, in every transfer form.
  for (const main of [
    'goto tagged all: (["absent"])',
    'call tagged all: [("absent")]\nexit',
    'fallback tagged "punishment", none: (["punishment"])\nexit',
  ]) {
    assert.deepEqual(errors(main), [["TST002", NO_FILE]], main);
  }
  const plan = compiled('let minimum = 9\ngoto tagged "punishment" > minimum');
  const failed = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(failed.snapshot.status, "failed");
  assert.equal(failed.snapshot.failure?.code, "TSR082");
  assert.equal(failed.snapshot.failure?.message, "No file has these tags.");
});

test("from: names files of the project, written out in quotes", () => {
  assert.deepEqual(errors('let found = findScripts(from: "attic/*.tease")\nexit'), [
    ["TST006", "from: 'attic/*.tease' matches no file of the project."],
  ]);
  assert.deepEqual(
    errors('let found = findScripts(from: "../rooms/*.tease")\nexit').map(([code]) => code),
    ["TST006"],
  );
  for (const [main, message] of [
    [
      'let folder = "rooms"\nlet found = findScripts(from: folder)\nexit',
      'from: takes a file path or glob written out in quotes, such as from: "modules/*.tease".',
    ],
    [
      'let found = findScripts("chastity")\nexit',
      "findScripts takes named arguments: where:, all:, none:, any:, and from:.",
    ],
    [
      'let found = findScripts(source: "x")\nexit',
      "Unknown option 'source'. findScripts takes where:, all:, none:, any:, and from:.",
    ],
    [
      'goto tagged "a", from: "rooms/*.tease", from: "x.tease"',
      "The option 'from' appears more than once.",
    ],
    [
      'showImage tagged "a", from: "rooms/*.tease"\nexit',
      "Unknown option 'from'. tagged takes all:, none:, and any:.",
    ],
  ] as const) {
    assert.deepEqual(errors(main), [["TST001", message]], main);
  }
});

test("a script query yields script references, which only transfers and script values accept", () => {
  assert.deepEqual(
    errors('let found = findScripts(where: "chastity")\nshowImage found[0]\nexit').map(
      ([code]) => code,
    ),
    ["TSV043"],
  );
});

test("plan validation rejects non-canonical file tags and a from that no script query may have", () => {
  const plan = compiled('let found = findScripts(from: "rooms/*.tease")\nexit');
  const cases: [string, (plan: MutablePlan) => void, string][] = [
    [
      "a non-canonical file tag",
      (mutable) => (mutable.files[2]!.tags = [{ name: "Public", value: null }]),
      "$.files[2].tags",
    ],
    ["a from outside the package", (mutable) => (tagQuery(mutable).from = "../x.tease"), ".from"],
    [
      "a from on an image query",
      (mutable) => {
        const query = tagQuery(mutable);
        query.catalog = "images";
      },
      ".from",
    ],
  ];
  for (const [name, mutate, path] of cases) {
    const mutable: MutablePlan = JSON.parse(JSON.stringify(plan));
    mutate(mutable);
    const validation = validateInstructionPlan(mutable);
    assert.equal(validation.valid, false, name);
    assert.ok(
      validation.errors.some((error) => error.path.endsWith(path)),
      `${name}: ${JSON.stringify(validation.errors)}`,
    );
  }
});

interface MutablePlan {
  files: { tags: { name: string; value: number | null }[] }[];
  instructions: unknown[];
}

/** The first tag query expression in a plan. */
function tagQuery(plan: MutablePlan): Record<string, unknown> {
  const pending: unknown[] = [plan.instructions];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!isRecord(value)) continue;
    if (value.kind === "tagQuery") return value;
    for (const child of Object.values(value)) pending.push(child);
  }
  throw new Error("The plan has no tag query.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("a file of declarations only is never picked or listed, as for globs", () => {
  const files = (main: string): ProjectSourceFile[] => [
    { path: "main.tease", source: main },
    { path: "lib.tease", source: '---\ntags: "helpers"\n---\nfunction help { say "help" }' },
    { path: "room.tease", source: '---\ntags: "helpers"\n---\nsay "room"\nend' },
  ];
  const result = compileProject(
    files('say findScripts(where: "helpers")\ncall tagged "helpers"\nexit'),
  );
  assert.deepEqual(result.diagnostics, []);
  // The plan marks the file that runs nothing, so no query sees its tags.
  assert.deepEqual(
    result.plan!.files.map((file) => [file.path, file.tags]),
    [
      ["main.tease", []],
      ["lib.tease", null],
      ["room.tease", [{ name: "helpers", value: null }]],
    ],
  );
  assert.deepEqual(
    says(
      assertRuntimeResumeEquivalent(
        files('say findScripts(where: "helpers").length\ncall tagged "helpers"\nexit'),
      ).events,
    ),
    ["1", "room"],
  );

  // Only a file that runs something counts; a pick that finds none is a compile error.
  const onlyLib = (main: string) =>
    compileProject([files(main)[0]!, files(main)[1]!])
      .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => [diagnostic.code, diagnostic.message]);
  assert.deepEqual(onlyLib('call tagged "helpers"\nexit'), [
    [
      "TST002",
      "No file in the project that runs something has these tags. A file of declarations only is never picked.",
    ],
  ]);
  assert.deepEqual(onlyLib('let found = findScripts(from: "lib.tease")\nexit'), [
    [
      "TST006",
      "Every file matching 'lib.tease' holds declarations only and runs nothing, so there is nothing to pick.",
    ],
  ]);
});

test("picks and lists see path order, also with main.tease among the matches", () => {
  const files: ProjectSourceFile[] = [
    {
      path: "main.tease",
      source: '---\ntags: "start"\n---\nsay findScripts(where: "start")\nexit',
    },
    { path: "a.tease", source: '---\ntags: "start"\n---\nsay "a"\nexit' },
  ];
  assert.deepEqual(says(assertRuntimeResumeEquivalent(files).events), [
    '[script("a.tease"), script("main.tease")]',
  ]);
});
