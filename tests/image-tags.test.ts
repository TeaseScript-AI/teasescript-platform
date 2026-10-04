import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource, type CompileOptions } from "../src/compiler.js";
import type { ProjectImageFile } from "../src/image-catalog.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

const images: readonly ProjectImageFile[] = [
  { path: "images/hall.jpg", keywords: ["hall"] },
  { path: "images/bedroom-soft.jpg", keywords: ["Bedroom", "punishment: 1"] },
  { path: "images/bedroom-strict.jpg", keywords: ["bedroom", "punishment: 4", "punishment"] },
  { path: "images/bathroom.jpg", keywords: ["bathroom", "punishment"] },
  { path: "images/garden.jpg", keywords: ["bedroom", "outdoor", "punishment: 5"] },
];
const options: CompileOptions = { images };

function compiled(source: string, compileOptions: CompileOptions = options): InstructionPlan {
  const result = compileSource(source, compileOptions);
  assert.deepEqual(result.diagnostics, [], source);
  return result.plan!;
}

/** The text of each `say`, after running to the end with each random draw taken from `draws`. */
function says(source: string, draws: readonly number[] = []): string[] {
  const plan = compiled(source);
  let next = 0;
  const finished = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
    random: { next: () => draws[next++] ?? 0 },
  });
  assert.equal(finished.snapshot.status, "halted", source);
  return finished.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function matches(where: string): string[] {
  return JSON.parse(says(`say findImages(where: ${where})\nexit`)[0]!);
}

function errors(source: string, compileOptions: CompileOptions = options): [string, string][] {
  return compileSource(source, compileOptions)
    .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => [diagnostic.code, diagnostic.message]);
}

test("the image catalog holds every image once, in path order, with its keywords as tags", () => {
  const result = compileProject([{ path: "main.tease", source: "exit" }], {
    images: [
      ...images,
      { path: "images/camera.jpg", keywords: ["Canon EOS", "long session", "people|anna", "red"] },
    ],
  });
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code, diagnostic.severity]),
    [["images/camera.jpg", "TST003", "warning"]],
  );
  assert.match(result.diagnostics[0]!.message, /'Canon EOS', 'long session', 'people\|anna'/u);
  assert.deepEqual(result.plan!.images, [
    {
      path: "images/bathroom.jpg",
      tags: [
        { name: "bathroom", value: null },
        { name: "punishment", value: null },
      ],
    },
    {
      path: "images/bedroom-soft.jpg",
      tags: [
        { name: "bedroom", value: null },
        { name: "punishment", value: 1 },
      ],
    },
    {
      path: "images/bedroom-strict.jpg",
      tags: [
        { name: "bedroom", value: null },
        { name: "punishment", value: 4 },
      ],
    },
    { path: "images/camera.jpg", tags: [{ name: "red", value: null }] },
    {
      path: "images/garden.jpg",
      tags: [
        { name: "bedroom", value: null },
        { name: "outdoor", value: null },
        { name: "punishment", value: 5 },
      ],
    },
    { path: "images/hall.jpg", tags: [{ name: "hall", value: null }] },
  ]);
  assert.equal(validateInstructionPlan(result.plan).valid, true);
  // A script without a catalog has an empty one.
  assert.deepEqual(compiled("exit", {}).images, []);
});

test("an image with two numbers for one tag, or a path outside the package, leaves no plan", () => {
  const result = compileProject([{ path: "main.tease", source: "exit" }], {
    images: [
      { path: "a.jpg", keywords: ["punishment: 3", "punishment: 4"] },
      { path: "../b.jpg", keywords: [] },
      { path: "c.jpg", keywords: [] },
      { path: "c.jpg", keywords: [] },
    ],
  });
  assert.equal(result.plan, null);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code]),
    [
      ["a.jpg", "TST004"],
      ["../b.jpg", "TSC009"],
      ["c.jpg", "TSC009"],
    ],
  );
});

test("findImages lists the matching images in catalog order", () => {
  assert.deepEqual(matches(`"bedroom"`), [
    "images/bedroom-soft.jpg",
    "images/bedroom-strict.jpg",
    "images/garden.jpg",
  ]);
  assert.deepEqual(matches(`("bedroom" or "bathroom") and not "outdoor"`), [
    "images/bathroom.jpg",
    "images/bedroom-soft.jpg",
    "images/bedroom-strict.jpg",
  ]);
  // A valued tag also counts as present.
  assert.deepEqual(matches(`"punishment" and "bedroom"`), [
    "images/bedroom-soft.jpg",
    "images/bedroom-strict.jpg",
    "images/garden.jpg",
  ]);
  assert.deepEqual(matches(`"punishment" > 3`), ["images/bedroom-strict.jpg", "images/garden.jpg"]);
  // A tag without a number makes every comparison false, also !=; not applies afterwards.
  assert.deepEqual(matches(`"punishment" != 4`), ["images/bedroom-soft.jpg", "images/garden.jpg"]);
  assert.deepEqual(matches(`not ("punishment" >= 4) and "punishment"`), [
    "images/bathroom.jpg",
    "images/bedroom-soft.jpg",
  ]);
  assert.deepEqual(matches(`"Hall"`), ["images/hall.jpg"]);

  assert.deepEqual(
    says(
      [
        'let wanted = ["bedroom"]',
        'let found = findImages(all: wanted, none: ["outdoor"], any: [])',
        "say found.length",
        'say findImages(where: "attic").length',
        "say findImages().length",
        'say findImages(any: ["hall", "bathroom"])',
        "exit",
      ].join("\n"),
    ),
    ["2", "0", "5", `["images/bathroom.jpg", "images/hall.jpg"]`],
  );
});

test("a comparison reads an ordinary expression, evaluated once in written order before matching", () => {
  assert.deepEqual(
    says(
      [
        "let minimum = 2",
        'say findImages(where: "punishment" > minimum + 1)',
        'function first { say "first"\nreturn ["bedroom"] }',
        'function second { say "second"\nreturn 4 }',
        'say findImages(all: first(), where: "punishment" >= second()).length',
        "exit",
      ].join("\n"),
    ),
    [`["images/bedroom-strict.jpg", "images/garden.jpg"]`, "first", "second", "2"],
  );
});

test("showImage tagged picks one matching image with one draw from the session random generator", () => {
  const source = 'showImage tagged "bedroom", "punishment" > 3, none: ["outdoor"]\nexit';
  assert.deepEqual(says(`${source.replace("\nexit", "")}\nsay "done"\nexit`, [0.99]), ["done"]);
  const plan = compiled(source);
  for (const [draw, expected] of [
    [0, "images/bedroom-strict.jpg"],
    [0.99, "images/bedroom-strict.jpg"],
  ] as const) {
    const finished = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
      random: { next: () => draw },
    });
    assert.equal(finished.snapshot.stageImage, expected);
  }

  const many = compiled('showImage tagged "bedroom"\nexit');
  const picked = [0, 0.5, 0.99].map(
    (draw) =>
      run(many, createImmediatePacingRuntimeSnapshot(many), { random: { next: () => draw } })
        .snapshot.stageImage,
  );
  assert.deepEqual(picked, [
    "images/bedroom-soft.jpg",
    "images/bedroom-strict.jpg",
    "images/garden.jpg",
  ]);

  // Without an injected source, the draw comes from the snapshot's seeded generator and advances it once.
  const seeded = createImmediatePacingRuntimeSnapshot(many, { seed: 7 });
  const first = run(many, seeded);
  const again = run(many, createImmediatePacingRuntimeSnapshot(many, { seed: 7 }));
  assert.equal(first.snapshot.stageImage, again.snapshot.stageImage);
  assert.notDeepEqual(first.snapshot.rng, seeded.rng);
});

test("restoring a checkpoint inside or after a query never evaluates or draws again", () => {
  const source = [
    'function minimum { wait 1 ms\nsay "asked"\nreturn 3 }',
    'showImage tagged "bedroom", "punishment" >= minimum()',
    "wait 1 ms",
    'say "shown"',
    "exit",
  ].join("\n");
  const { boundaries, events, finalSnapshot } = assertRuntimeResumeEquivalent(source, {
    images,
    seed: 0x5eed,
  });
  assert.ok(boundaries.length >= 2);
  assert.deepEqual(
    events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["asked", "shown"],
  );
  assert.ok(["images/bedroom-strict.jpg", "images/garden.jpg"].includes(finalSnapshot.stageImage!));

  // The checkpoint carries the catalog; a restored plan matches without the images being read again.
  const plan = compiled(source);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, createImmediatePacingRuntimeSnapshot(plan))),
  );
  assert.deepEqual(restored.plan.images, plan.images);
});

test("a pick that provably matches no image is a compile error; one that only may match fails at runtime", () => {
  assert.deepEqual(errors('showImage tagged "attic"\nexit'), [
    ["TST002", "No image in the package has these tags."],
  ]);
  assert.deepEqual(errors('showImage tagged "hall", "punishment" > 0\nexit'), [
    ["TST002", "No image in the package has these tags."],
  ]);
  assert.deepEqual(errors('showImage tagged "bedroom", none: ["bedroom"]\nexit'), [
    ["TST002", "No image in the package has these tags."],
  ]);
  assert.deepEqual(errors('showImage tagged "bedroom"\nexit', {}), [
    ["TST002", "The package has no images to pick from."],
  ]);
  // A list may be empty.
  assert.deepEqual(errors('let none = findImages(where: "attic")\nexit'), []);

  const plan = compiled('let minimum = 9\nshowImage tagged "punishment" > minimum\nexit');
  const failed = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(failed.snapshot.status, "failed");
  assert.equal(failed.snapshot.failure?.code, "TSR082");
});

test("tag lists and bounds are checked for their types, and runtime values are validated", () => {
  assert.deepEqual(
    errors('say findImages(where: "punishment" > "3")\nexit').map(([code]) => code),
    ["TSV043"],
  );
  assert.deepEqual(
    errors("say findImages(all: 3)\nexit").map(([code]) => code),
    ["TSV043"],
  );
  assert.deepEqual(
    errors("say findImages(none: [1])\nexit").map(([code]) => code),
    ["TSV043"],
  );

  for (const [source, code] of [
    ['let names = load "names", default: ["Bed Room"]\nsay findImages(all: names)\nexit', "TSR081"],
    [
      'let bound = load "bound", default: "high"\nsay findImages(where: "punishment" > bound)\nexit',
      "TSR080",
    ],
  ] as const) {
    const plan = compiled(source);
    const failed = run(plan, createImmediatePacingRuntimeSnapshot(plan));
    assert.equal(failed.snapshot.failure?.code, code, source);
  }
});

test("a malformed tag query names the accepted form", () => {
  const cases: [string, string][] = [
    ["showImage tagged intensity > 3", 'Write the tag name in quotes: "intensity".'],
    [
      'showImage tagged 3 < "punishment"',
      'Write the quoted tag name before the comparison, such as "punishment" > 3.',
    ],
    [
      'showImage tagged "punishment: 4"',
      'Compare the tag\'s number instead, such as "punishment" == 4.',
    ],
    [
      'showImage tagged "corner time"',
      "'corner time' is not a tag name: use lowercase letters a–z, digits, and hyphens.",
    ],
    [
      'showImage tagged "room-${1}"',
      "Write a tag name in a query out in full; for computed names, use all:, none:, or any: with a list.",
    ],
    [
      'showImage tagged "a" + "b"',
      'Inside a tag query, write tags in quotes and combine them with and, or, not, and comparisons such as "punishment" > 3.',
    ],
    [
      'showImage tagged none: ["outdoor"], "bedroom"',
      "Write the tags before all:, none:, or any:.",
    ],
    [
      'showImage tagged "bedroom", source: "local"',
      "Unknown option 'source'. tagged takes all:, none:, and any:.",
    ],
    [
      'showImage tagged "bedroom", none: ["a"], none: ["b"]',
      "The option 'none' appears more than once.",
    ],
    ["showImage tagged", "Expected a tag after 'tagged', such as showImage tagged \"bedroom\"."],
    [
      'say findImages("bedroom")',
      "findImages takes named arguments: where:, all:, none:, and any:.",
    ],
    [
      'say findImages(where: "a", where: "b")',
      "The option 'where' appears more than once; combine the tags with and.",
    ],
    [
      'say findImages(from: "images/*")',
      "Unknown option 'from'. findImages takes where:, all:, none:, and any:.",
    ],
  ];
  for (const [line, message] of cases) {
    const diagnostics = compileSource(`${line}\nexit`, options).diagnostics;
    assert.deepEqual(
      diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message]),
      [["TST001", message]],
      line,
    );
  }
  assert.deepEqual(
    compileSource("let tagged = 1\nexit").diagnostics.length > 0 &&
      compileSource("function findImages { }\nexit").diagnostics.length > 0,
    true,
  );
});

test("plan validation rejects a malformed image catalog or tag query", () => {
  const plan = compiled('say findImages(where: "bedroom" and "punishment" > 1)\nexit');
  const cases: [string, (plan: MutablePlan) => void, string][] = [
    ["images out of path order", (mutable) => mutable.images.reverse(), "$.images[1].path"],
    [
      "a non-canonical tag",
      (mutable) => (mutable.images[0]!.tags[0]!.name = "Bathroom"),
      "$.images[0].tags[0]",
    ],
    [
      "a step without operands",
      (mutable) => (tagQuery(mutable).steps = [{ kind: "and" }]),
      ".steps[0]",
    ],
    [
      "two predicates left over",
      (mutable) => {
        const query = tagQuery(mutable);
        query.steps = Array.isArray(query.steps) ? query.steps.slice(0, -1) : [];
      },
      ".steps",
    ],
    ["a missing operand", (mutable) => (tagQuery(mutable).operands = []), ".operands"],
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
  images: { path: string; tags: { name: string; value: number | null }[] }[];
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
