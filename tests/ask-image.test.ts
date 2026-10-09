import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../src/runtime/serializable-values.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { pressPermanentButton } from "../src/runtime/operations/press-permanent-button.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runUntilExit } from "./helpers/run-until-exit.js";

const IMAGE = "captured-media:chosen:1";
// The trusted Player store vouches for exactly the images it stored.
const admission = {
  holds: (reference: string, kind: "image") => kind === "image" && reference === IMAGE,
};

function started(source: string, options: Parameters<typeof createFreshRuntimeSnapshot>[1] = {}) {
  const plan = compileValidPlan(source);
  assert.equal(validateInstructionPlan(plan).valid, true);
  const result = run(plan, createFreshRuntimeSnapshot(plan, options));
  return { plan, snapshot: result.snapshot, events: result.events };
}

function pendingImage(snapshot: RuntimeSnapshot) {
  const action = snapshot.foregroundAction;
  assert.ok(
    action?.kind === "interaction" && action.ui.kind === "image",
    `expected an image request, got ${action?.kind}`,
  );
  return { ...action, ui: action.ui };
}

function answered(plan: InstructionPlan, snapshot: RuntimeSnapshot, reference = IMAGE) {
  return completeAction(
    plan,
    snapshot,
    {
      actionId: pendingImage(snapshot).actionId,
      actionKind: "interaction",
      interactionKind: "image",
      payload: { kind: "image", reference },
    },
    { capturedMedia: admission },
  );
}

function binding(snapshot: RuntimeSnapshot, name: string) {
  return snapshot.frames[0]?.bindings.find((candidate) => candidate.name === name)?.value;
}

test("askImage waits for the player's image, and its reference reaches the Stage and storage", () => {
  const { plan, snapshot, events } = started(
    'let picture: string = askImage("Show me your outfit.", hint: "Add an image")\nshowImage picture\nsave picture as "outfit"\nexit',
  );
  assert.equal(snapshot.status, "waiting");
  // The question is said before the request opens; the hint only labels it.
  assert.deepEqual(
    events.flatMap((event) =>
      event.kind === "say"
        ? [`say ${event.text}`]
        : event.kind === "actionRequested" && event.action.kind === "interaction"
          ? ["request"]
          : [],
    ),
    ["say Show me your outfit.", "request"],
  );
  const request = pendingImage(snapshot);
  assert.equal(request.expectedResult, "string");
  assert.deepEqual(request.ui, {
    kind: "image",
    question: "Show me your outfit.",
    hint: "Add an image",
    allowCamera: true,
    allowFile: true,
    types: null,
    mime: null,
    accessibleName: { kind: "localizedDefault", key: "answer" },
  });
  const completion = answered(plan, snapshot);
  assert.equal(completion.outcome.kind, "completed");
  // The transcript records that the player answered with an image, never its reference.
  const transcript = completion.events.find((event) => event.kind === "playerTranscript");
  assert.ok(transcript?.kind === "playerTranscript");
  assert.equal(transcript.text, "Image");
  const finished = runUntilExit(plan, completion.snapshot).snapshot;
  assert.equal(plan.instructions[finished.nextInstruction]?.kind, "exit");
  assert.equal(finished.stageImage, IMAGE);
  assert.deepEqual(finished.scriptStorage, [{ key: "outfit", value: IMAGE }]);
});

test("askImage takes its message by name and its source and file options in any order", () => {
  const { snapshot } = started(
    'let pick = askImage(\n  types: [".jpg", ".PNG"],\n  allowCamera: false,\n  message: "Upload an image",\n  mime: ["image/jpeg", "image/png"]\n)\nexit',
  );
  assert.deepEqual(pendingImage(snapshot).ui, {
    kind: "image",
    question: "Upload an image",
    hint: null,
    allowCamera: false,
    allowFile: true,
    types: [".jpg", ".PNG"],
    mime: ["image/jpeg", "image/png"],
    accessibleName: { kind: "localizedDefault", key: "answer" },
  });
  const bare = started("let pick = askImage()\nexit");
  assert.equal(pendingImage(bare.snapshot).ui.question, null);
  assert.equal(pendingImage(bare.snapshot).ui.hint, null);
  // Without a question nothing is said.
  assert.equal(
    bare.events.some((event) => event.kind === "say"),
    false,
  );
});

test("askImage evaluates computed arguments once, in source order, before it asks", () => {
  const { plan, snapshot } = started(
    'let order: string[] = []\nfunction flag(value: boolean): boolean {\n  order.add("file")\n  return value\n}\nfunction text(value: string): string {\n  order.add("message")\n  return value\n}\nfunction kinds(value: string[]): string[] {\n  order.add("types")\n  return value\n}\nlet pick = askImage(allowFile: flag(true), message: text("Photo ${1 + 1}"), types: kinds([".png"]), hint: "Pick")\nlet after = order\nexit',
  );
  assert.deepEqual(binding(snapshot, "order"), {
    kind: "list",
    items: ["file", "message", "types"],
  });
  const request = pendingImage(snapshot);
  assert.equal(request.ui.question, "Photo 2");
  assert.equal(request.ui.hint, "Pick");
  assert.deepEqual(request.ui.types, [".png"]);
  const finished = runUntilExit(plan, answered(plan, snapshot).snapshot).snapshot;
  assert.equal(binding(finished, "pick"), IMAGE);
  assert.deepEqual(binding(finished, "after"), {
    kind: "list",
    items: ["file", "message", "types"],
  });
});

test("an invalid answer, an unvouched image, or typed text leaves the request waiting", () => {
  const { plan, snapshot } = started('let pick = askImage("Add an image")\nexit');
  const before = structuredClone(snapshot);
  const id = pendingImage(snapshot).actionId;
  const attempts: unknown[] = [
    // A well-formed string the store does not hold, for example a package asset path.
    { kind: "image", reference: "images/coast.svg" },
    { kind: "image", reference: "" },
    { kind: "image", reference: IMAGE, extra: true },
    { kind: "submittedText", submittedText: IMAGE },
    { kind: "image" },
    IMAGE,
  ];
  for (const payload of attempts) {
    const outcome = completeAction(
      plan,
      snapshot,
      { actionId: id, actionKind: "interaction", interactionKind: "image", payload },
      { capturedMedia: admission },
    );
    assert.equal(outcome.outcome.kind, "invalidPayload", JSON.stringify(payload));
    assert.deepEqual(outcome.events, []);
    assert.deepEqual(outcome.snapshot, before);
  }
  // Without a trusted store even its own image is not admitted.
  const unvouched = completeAction(plan, snapshot, {
    actionId: id,
    actionKind: "interaction",
    interactionKind: "image",
    payload: { kind: "image", reference: IMAGE },
  });
  assert.equal(unvouched.outcome.kind, "invalidPayload");
  const wrongKind = completeAction(plan, snapshot, {
    actionId: id,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: "photo.png" },
  });
  assert.deepEqual(wrongKind.outcome, {
    kind: "wrongActionKind",
    actionId: id,
    expectedActionKind: "interaction",
    receivedActionKind: "interaction:text",
  });
  // The request is still the same one, and a valid image completes it.
  assert.equal(answered(plan, snapshot).outcome.kind, "completed");
});

test("a pending image request survives a JSON checkpoint and completes like the original", () => {
  const { plan, snapshot } = started(
    'let pick = askImage(message: "Show me", hint: "Add an image", types: [".png"])\nshowImage pick\nlet done = "yes"\nexit',
  );
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, snapshot)));
  assert.deepEqual(restored.snapshot, snapshot);
  assert.deepEqual(pendingImage(restored.snapshot).ui, pendingImage(snapshot).ui);
  const original = answered(plan, snapshot);
  const resumed = answered(restored.plan, restored.snapshot);
  assert.deepEqual(resumed.events, original.events);
  // The question was said before the request opened and is not said again.
  assert.equal(
    [...original.events, ...run(plan, original.snapshot).events].some(
      (event) => event.kind === "say" && event.text === "Show me",
    ),
    false,
  );
  const originalRun = run(plan, original.snapshot);
  const resumedRun = run(restored.plan, resumed.snapshot);
  assert.deepEqual(resumedRun.snapshot, originalRun.snapshot);
  assert.deepEqual(resumedRun.events, originalRun.events);
  assert.equal(resumedRun.snapshot.stageImage, IMAGE);
  // A settled request also round-trips, and a repeated answer replays its settlement.
  assert.deepEqual(
    restoreCheckpoint(createCheckpoint(plan, original.snapshot)).snapshot,
    original.snapshot,
  );
  assert.equal(
    answeredAgain(plan, original.snapshot, pendingImage(snapshot).actionId),
    "alreadySettled",
  );
});

function answeredAgain(plan: InstructionPlan, snapshot: RuntimeSnapshot, actionId: number) {
  return completeAction(
    plan,
    snapshot,
    {
      actionId,
      actionKind: "interaction",
      interactionKind: "image",
      payload: { kind: "image", reference: IMAGE },
    },
    { capturedMedia: admission },
  ).outcome.kind;
}

test("a timer expiry block may interrupt askImage, also across a checkpoint, and the same request is answered after it", () => {
  const { plan, snapshot } = started(
    'let ticks = 0\ntimer async 1 s {\n  wait 1 s\n  ticks = ticks + 1\n}\nlet pick = askImage("Add an image")\nexit',
  );
  const id = pendingImage(snapshot).actionId;
  // The expiry block waits while the request is suspended; the checkpoint keeps both.
  const interrupted = run(plan, observeTime(plan, snapshot, 1500).snapshot).snapshot;
  assert.equal(interrupted.foregroundAction?.kind, "delay");
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, interrupted)));
  assert.deepEqual(restored.snapshot, interrupted);
  const late = run(plan, observeTime(plan, restored.snapshot, 2500).snapshot).snapshot;
  assert.equal(binding(late, "ticks"), 1);
  assert.equal(pendingImage(late).actionId, id);
  assert.equal(validateRuntimeSnapshot(late, plan).valid, true);
  const finished = runUntilExit(plan, answered(plan, late).snapshot).snapshot;
  assert.equal(binding(finished, "pick"), IMAGE);
});

test("a permanent button's block may interrupt askImage, and the same request is answered after it", () => {
  const { plan, snapshot } = started(
    'let presses = 0\nshowPermanentButton "Help" {\n  presses = presses + 1\n}\nlet pick = askImage("Add an image")\nexit',
  );
  const id = pendingImage(snapshot).actionId;
  const pressed = pressPermanentButton(plan, snapshot, 1);
  assert.equal(pressed.outcome.kind, "pressed");
  const after = run(plan, pressed.snapshot).snapshot;
  assert.equal(binding(after, "presses"), 1);
  assert.equal(pendingImage(after).actionId, id);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, after)));
  assert.deepEqual(restored.snapshot, after);
  const finished = runUntilExit(plan, answered(plan, restored.snapshot).snapshot).snapshot;
  assert.equal(binding(finished, "pick"), IMAGE);
});

test("askImage is a reserved call whose arguments the compiler checks", () => {
  const diagnostics = (source: string, options: Parameters<typeof compileSource>[1] = {}) =>
    compileSource(`${source}\nexit`, options).diagnostics.map((diagnostic) => diagnostic.code);
  assert.deepEqual(diagnostics('let pick = askImage("a", "b")'), ["TSV020"]);
  assert.deepEqual(diagnostics('let pick = askImage("a", message: "b")'), ["TSV020"]);
  assert.deepEqual(diagnostics("let pick = askImage(camera: true)"), ["TSV022"]);
  // The question and the hint are text fields.
  assert.deepEqual(diagnostics('let pick = askImage(["a"])'), ["TSV040"]);
  assert.deepEqual(diagnostics('let pick = askImage("a", hint: ["b"])'), ["TSV040"]);
  assert.deepEqual(diagnostics('let pick = askImage("a", hint: "b", hint: "c")'), ["TSV023"]);
  assert.deepEqual(diagnostics('let pick = askImage(invalidMessage: "No")'), ["TSV022"]);
  assert.deepEqual(diagnostics("let pick = askImage(allowFile: 1)"), ["TSV043"]);
  assert.deepEqual(diagnostics('let pick = askImage(types: ["png"])'), ["TSV043"]);
  assert.deepEqual(diagnostics('let pick = askImage(mime: ["video/mp4"])'), ["TSV043"]);
  assert.deepEqual(diagnostics("let pick = askImage(types: [])"), ["TSV043"]);
  assert.deepEqual(diagnostics("let pick = askImage(allowCamera: false, allowFile: false)"), [
    "TSV043",
  ]);
  assert.deepEqual(diagnostics("let pick: string = askImage()"), []);
  assert.deepEqual(diagnostics("let pick: integer = askImage()"), ["TSV041"]);
  assert.deepEqual(diagnostics("let ask = askImage"), ["TSV028"]);
  assert.deepEqual(diagnostics("function frame(pick = askImage()) {\n}"), ["TSV032"]);
  assert.ok(diagnostics("let askImage = 1").length > 0);
  assert.ok(diagnostics("let pick = askImage()", { builtins: ["askImage"] }).length > 0);
});

test("a computed source or filter that the request cannot use fails before it asks", () => {
  const cases: readonly [SerializableRuntimeValue, RegExp][] = [
    [
      { kind: "list", items: ["png"] },
      /types:\) takes file extensions such as "\.png", not 'png'/u,
    ],
    [{ kind: "list", items: [".png", 3] }, /types:\) takes texts such as "\.png", but it holds/u],
    [{ kind: "list", items: [] }, /types:\) needs at least one extension/u],
    [".png", /types:\) takes a list of file extensions/u],
  ];
  for (const [stored, message] of cases) {
    const { snapshot } = started(
      'let kinds = load "" + "kinds", default: null\nlet pick = askImage(types: kinds)\nexit',
      { scriptStorage: [{ key: "kinds", value: stored }] },
    );
    assert.equal(snapshot.status, "failed", JSON.stringify(stored));
    assert.equal(snapshot.failure?.code, "TSR052");
    assert.match(snapshot.failure?.message ?? "", message);
  }
  const { snapshot } = started(
    'let off = load "" + "off", default: null\nlet pick = askImage(allowCamera: off, allowFile: off)\nexit',
    { scriptStorage: [{ key: "off", value: false }] },
  );
  assert.equal(snapshot.status, "failed");
  assert.match(snapshot.failure?.message ?? "", /needs allowCamera: or allowFile: to be true/u);
  // A filter too long for an interaction fails at the interaction text limit, however long it is.
  const long = started(
    'let kinds = load "" + "kinds", default: null\nlet pick = askImage(types: kinds)\nexit',
    {
      scriptStorage: [
        { key: "kinds", value: { kind: "list", items: Array(150_000).fill(".png") } },
      ],
    },
  ).snapshot;
  assert.equal(long.failure?.code, "TSR052");
  assert.match(long.failure?.message ?? "", /adds up to more than 65,536 bytes of UTF-8/u);
});

test("an external plan cannot call askImage as an ordinary function", () => {
  const plan = compileValidPlan('let pick = random()\nshowImage "a"\nexit');
  const forged = JSON.parse(JSON.stringify(plan));
  const declare = forged.instructions.find(
    (instruction: { kind: string }) => instruction.kind === "declareBinding",
  );
  declare.value.callee.name = "askImage";
  declare.value.arguments = [];
  assert.equal(validateInstructionPlan(forged).valid, false);
});

test("restored state rejects a pending image request that differs from what was asked", () => {
  const { plan, snapshot } = started('let pick = askImage(types: [".png"])\nexit');
  assert.equal(validateRuntimeSnapshot(snapshot, plan).valid, true);
  const json = serializeCheckpoint(createCheckpoint(plan, snapshot));
  for (const tamper of [
    (ui: Record<string, unknown>) => (ui.types = [".gif"]),
    (ui: Record<string, unknown>) => (ui.types = null),
    (ui: Record<string, unknown>) => (ui.allowFile = false),
    (ui: Record<string, unknown>) => (ui.hint = "Other"),
    (ui: Record<string, unknown>) => {
      ui.allowFile = false;
      ui.allowCamera = false;
    },
    (ui: Record<string, unknown>) => (ui.mime = ["text/plain"]),
  ]) {
    const checkpoint = JSON.parse(json);
    tamper(checkpoint.snapshot.foregroundAction.ui);
    assert.throws(() => restoreCheckpoint(checkpoint), tamper.toString());
  }
  // A settled image answer must still be an image reference with its transcript.
  const settled = JSON.parse(
    serializeCheckpoint(createCheckpoint(plan, answered(plan, snapshot).snapshot)),
  );
  settled.snapshot.lastSettlement.transcriptText = IMAGE;
  assert.throws(() => restoreCheckpoint(settled));
});
