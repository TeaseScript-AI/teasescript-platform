import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource } from "../src/compiler.js";
import type { ProjectImageFile } from "../src/image-catalog.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

const images: readonly ProjectImageFile[] = [
  { path: "images/bedroom.jpg", keywords: ["bedroom"] },
  { path: "images/hall.jpg", keywords: ["hall"] },
];
const PHOTO = "captured-media:photo:1";
const OTHER = "captured-media:photo:2";
// The trusted Player store vouches for exactly the photos it captured.
const admission = {
  holds: (reference: string, kind: "image") =>
    kind === "image" && (reference === PHOTO || reference === OTHER),
};

function started(source: string) {
  const plan = compileValidPlan(source, { images });
  assert.equal(validateInstructionPlan(plan).valid, true);
  const result = run(plan, createFreshRuntimeSnapshot(plan));
  return { plan, snapshot: result.snapshot, events: result.events };
}

function pendingCapture(snapshot: RuntimeSnapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "capture", `expected a capture, got ${action?.kind}`);
  return action;
}

function captured(plan: InstructionPlan, snapshot: RuntimeSnapshot, reference = PHOTO) {
  return completeAction(
    plan,
    snapshot,
    {
      actionId: pendingCapture(snapshot).actionId,
      actionKind: "capture",
      payload: { kind: "captured", media: { kind: "image", reference } },
    },
    { capturedMedia: admission },
  );
}

function binding(snapshot: RuntimeSnapshot, name: string) {
  return snapshot.frames[0]?.bindings.find((candidate) => candidate.name === name)?.value;
}

test("a photo taken with tags joins the image catalog, and tag queries find it after the package images", () => {
  const { plan, snapshot } = started(
    [
      "let level = 3",
      'let photo = takePhoto(tags: ["Bedroom", "punishment: ${level}", "bedroom"])',
      'let found = findImages(where: "bedroom")',
      'let strict = findImages(where: "punishment" >= 3)',
      'showImage tagged "punishment" > 2',
      "exit",
    ].join("\n"),
  );
  // The tags are read before the capture is requested, in name order, each name once.
  assert.deepEqual(pendingCapture(snapshot).tags, [
    { name: "bedroom", value: null },
    { name: "punishment", value: 3 },
  ]);
  const completion = captured(plan, snapshot);
  assert.equal(completion.outcome.kind, "completed");
  assert.deepEqual(completion.snapshot.capturedImages, [
    {
      reference: PHOTO,
      tags: [
        { name: "bedroom", value: null },
        { name: "punishment", value: 3 },
      ],
    },
  ]);
  const finished = runUntilExit(plan, completion.snapshot).snapshot;
  assert.deepEqual(binding(finished, "found"), {
    kind: "list",
    items: ["images/bedroom.jpg", PHOTO],
  });
  assert.deepEqual(binding(finished, "strict"), { kind: "list", items: [PHOTO] });
  assert.equal(finished.stageImage, PHOTO);
});

test("a photo without tags, or no photo, stays out of the catalog", () => {
  for (const [source, complete] of [
    ["let photo = takePhoto()\nlet all = findImages()\nexit", "captured"],
    ['let photo = takePhoto(tags: ["bedroom"])\nlet all = findImages()\nexit', "unavailable"],
  ] as const) {
    const { plan, snapshot } = started(source);
    const completion =
      complete === "captured"
        ? captured(plan, snapshot)
        : completeAction(plan, snapshot, {
            actionId: pendingCapture(snapshot).actionId,
            actionKind: "capture",
            payload: { kind: "unavailable", reason: "denied" },
          });
    assert.deepEqual(completion.snapshot.capturedImages, [], source);
    const finished = runUntilExit(plan, completion.snapshot).snapshot;
    assert.deepEqual(
      binding(finished, "all"),
      { kind: "list", items: ["images/bedroom.jpg", "images/hall.jpg"] },
      source,
    );
  }
});

test("tags that are not tags fail before the capture is requested", () => {
  for (const [source, message] of [
    [
      'let names = load "names", default: ["Bed Room"]\nlet photo = takePhoto(tags: names)\nexit',
      /holds 'Bed Room'/u,
    ],
    [
      'let names = load "names", default: ["level: 1", "level: 2"]\nlet photo = takePhoto(tags: names)\nexit',
      /'level' two different numbers/u,
    ],
    [
      'let names = load "na" + "mes", default: "bedroom"\nlet photo = takePhoto(tags: names)\nexit',
      /takes a list of tags/u,
    ],
  ] as const) {
    const plan = compileValidPlan(source);
    const failed = run(plan, createFreshRuntimeSnapshot(plan));
    assert.equal(failed.snapshot.status, "failed", source);
    assert.equal(failed.snapshot.failure?.code, "TSR083", source);
    assert.match(failed.snapshot.failure!.message, message, source);
    assert.equal(failed.snapshot.foregroundAction, null, source);
    assert.ok(!failed.events.some((event) => event.kind === "actionRequested"), source);
  }
});

test("written tags and the tags argument are checked at compile time", () => {
  const errors = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
    ]);
  assert.deepEqual(errors('let photo = takePhoto(tags: ["Bed Room"])'), [
    [
      "TST005",
      `'Bed Room' is not a tag: use lowercase letters a–z, digits, and hyphens, with an optional number, such as "punishment: 4".`,
    ],
  ]);
  assert.deepEqual(errors('let photo = takePhoto(tags: ["level: 1", "level: 2"])'), [
    ["TST005", "The tag 'level' has two different numbers."],
  ]);
  assert.deepEqual(
    errors('let photo = takePhoto(tags: "bedroom")').map(([code]) => code),
    ["TSV043"],
  );
  for (const source of [
    'let photo = takePhoto("bedroom")',
    'let photo = takePhoto(labels: ["a"])',
  ]) {
    assert.deepEqual(
      errors(source).map(([, message]) => message),
      ['takePhoto() takes only tags:, such as takePhoto(tags: ["bedroom"]).'],
      source,
    );
  }
});

test("a pending capture keeps its tags across a restore, and a repeated completion adds no second entry", () => {
  const { plan, snapshot } = started(
    [
      'function tag { wait 1 ms\nreturn "corner" }',
      'let photo = takePhoto(tags: [tag(), "punishment: 2"])',
      'let found = findImages(where: "corner")',
      "exit",
    ].join("\n"),
  );
  // The tag call waits; restoring there and continuing still captures with both tags.
  assert.equal(snapshot.foregroundAction?.kind, "delay");
  const atWait = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  const resumed = run(
    plan,
    observeTime(plan, atWait.snapshot, atWait.snapshot.currentSessionTimeMs + 1).snapshot,
  );
  assert.deepEqual(pendingCapture(resumed.snapshot).tags, [
    { name: "corner", value: null },
    { name: "punishment", value: 2 },
  ]);

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, resumed.snapshot)),
  );
  const completion = captured(plan, restored.snapshot);
  assert.equal(completion.outcome.kind, "completed");
  const again = completeAction(
    plan,
    completion.snapshot,
    {
      actionId: pendingCapture(restored.snapshot).actionId,
      actionKind: "capture",
      payload: { kind: "captured", media: { kind: "image", reference: PHOTO } },
    },
    { capturedMedia: admission },
  );
  assert.equal(again.snapshot.capturedImages.length, 1);
  const finished = runUntilExit(plan, completion.snapshot).snapshot;
  assert.deepEqual(binding(finished, "found"), { kind: "list", items: [PHOTO] });
});

test("a second photo with a reference already in the catalog is rejected", () => {
  const { plan, snapshot } = started(
    'let first = takePhoto(tags: ["a"])\nlet second = takePhoto(tags: ["b"])\nexit',
  );
  const first = captured(plan, snapshot);
  const waiting = run(plan, first.snapshot).snapshot;
  const repeated = captured(plan, waiting, PHOTO);
  assert.equal(repeated.outcome.kind, "invalidPayload");
  assert.deepEqual(repeated.snapshot, waiting);
  assert.equal(captured(plan, waiting, OTHER).snapshot.capturedImages.length, 2);
});

test("a project that takes tagged photos cannot prove a pick empty at compile time", () => {
  const pick = { path: "main.tease", source: 'showImage tagged "selfie"\nexit' };
  assert.deepEqual(
    compileProject([pick], { images }).diagnostics.map((diagnostic) => diagnostic.code),
    ["TST002"],
  );
  const result = compileProject(
    [pick, { path: "camera.tease", source: 'let photo = takePhoto(tags: ["selfie"])\nexit' }],
    { images },
  );
  assert.deepEqual(result.diagnostics, []);
});

test("restore rejects capture tags or catalog entries no engine produces", () => {
  const { plan, snapshot } = started('let photo = takePhoto(tags: ["a"])\nlet x = 1\nexit');
  const completion = captured(plan, snapshot);
  const valid = completion.snapshot;
  assert.equal(validateRuntimeSnapshot(valid, plan).valid, true);
  const forged = (change: (copy: { capturedImages: unknown[] }) => void) => {
    const copy = JSON.parse(JSON.stringify(valid));
    change(copy);
    return validateRuntimeSnapshot(copy, plan).valid;
  };
  assert.equal(
    forged((copy) => copy.capturedImages.push(copy.capturedImages[0])),
    false,
  );
  assert.equal(
    forged(
      (copy) => (copy.capturedImages[0] = { reference: PHOTO, tags: [{ name: "A", value: null }] }),
    ),
    false,
  );

  // A session that has not started has taken no photos, also in a plan without startup declarations.
  const fresh = compileValidPlan('let found = findImages(where: "selfie")\nwait 1\nexit');
  const saved = JSON.parse(
    serializeCheckpoint(createCheckpoint(fresh, createFreshRuntimeSnapshot(fresh))),
  );
  saved.snapshot.capturedImages = [{ reference: PHOTO, tags: [{ name: "selfie", value: null }] }];
  assert.throws(() => deserializeCheckpoint(JSON.stringify(saved)));

  // An untagged capture holds no tags.
  const untagged = started("let photo = takePhoto()\nexit");
  const action = JSON.parse(JSON.stringify(untagged.snapshot));
  action.foregroundAction.tags = [{ name: "a", value: null }];
  assert.equal(validateRuntimeSnapshot(action, untagged.plan).valid, false);
});

test("a photo taken with tags in a called file is in the catalog after the call returns", () => {
  const result = compileProject(
    [
      {
        path: "main.tease",
        source: 'call "camera.tease"\nlet found = findImages(where: "selfie")\nexit',
      },
      { path: "camera.tease", source: 'let photo = takePhoto(tags: ["selfie"])\nend' },
    ],
    { images },
  );
  assert.deepEqual(result.diagnostics, []);
  const plan = result.plan!;
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  assert.deepEqual(pendingCapture(waiting).tags, [{ name: "selfie", value: null }]);
  const finished = runUntilExit(plan, captured(plan, waiting).snapshot).snapshot;
  assert.deepEqual(binding(finished, "found"), { kind: "list", items: [PHOTO] });
});
