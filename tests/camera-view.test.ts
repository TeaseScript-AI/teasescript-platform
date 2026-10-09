import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import { createCheckpoint, serializeCheckpoint } from "../src/runtime/checkpoint.js";
import { parse } from "../src/parser.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/state.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { runUntilExit, runValidSourceUntilExit } from "./helpers/run-until-exit.js";
import { runValidSource } from "./helpers/run-valid-source.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { sayTexts } from "./helpers/runtime-events.js";

const warnings = (events: readonly InterpreterEvent[]) =>
  events.flatMap((event) => (event.kind === "developerWarning" ? [event.code] : []));

function codes(source: string): string[] {
  return compileSource(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.code);
}

test("showCamera shows the camera view, its handle moves it, and hideCamera and exit hide it", () => {
  assert.deepEqual(runValidSourceUntilExit("showCamera\nexit").snapshot.cameraView, {
    placement: "window",
    shown: true,
  });
  const moved = runValidSourceUntilExit(
    [
      "let view = showCamera stage",
      'say "${view.placement}", instant',
      'view.placement = "window"',
      'say "${view.placement}", instant',
      "say view, instant",
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(sayTexts(moved), ["stage", "window", "<camera window>"]);
  assert.deepEqual(moved.snapshot.cameraView, { placement: "window", shown: true });
  // A second showCamera moves the one view of the camera instead of opening another.
  assert.deepEqual(
    runValidSourceUntilExit("showCamera\nshowCamera stage\nexit").snapshot.cameraView,
    { placement: "stage", shown: true },
  );
  assert.deepEqual(runValidSourceUntilExit("showCamera\nhideCamera\nexit").snapshot.cameraView, {
    placement: "window",
    shown: false,
  });
  const ended = runValidSource("showCamera stage\nexit").snapshot;
  assert.equal(ended.status, "halted");
  assert.deepEqual(ended.cameraView, { placement: "stage", shown: false });
});

test("a hidden camera view keeps its placement readable, and moving it only warns", () => {
  const hidden = runValidSourceUntilExit(
    [
      "let view = showCamera stage",
      "hideCamera",
      'view.placement = "window"',
      'say "${view.placement}", instant',
      "say view, instant",
      "showCamera",
      'say "${view.placement}", instant',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(warnings(hidden.events), ["TSW010"]);
  // showCamera shows the camera's view again, so the earlier handle sees it.
  assert.deepEqual(sayTexts(hidden), ["stage", "<camera, hidden>", "window"]);
});

test("camera views outlive the function that showed them and leave the Stage image and photos alone", () => {
  const result = runValidSourceUntilExit(
    [
      "function lookAtMe {",
      "    return showCamera stage",
      "}",
      "let view = lookAtMe()",
      'showImage "images/room.jpg"',
      "hideImage",
      'view.placement = "window"',
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(result.snapshot.cameraView, { placement: "window", shown: true });
  // takePhoto() waits for the Player and changes nothing on screen.
  const plan = compileValidPlan("showCamera stage\nlet photo = takePhoto()\nexit");
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const capture = waiting.foregroundAction;
  assert.equal(capture?.kind, "capture");
  const answered = completeAction(plan, waiting, {
    actionId: capture.actionId,
    actionKind: "capture",
    payload: { kind: "unavailable", reason: "denied" },
  }).snapshot;
  assert.deepEqual(runUntilExit(plan, answered).snapshot.cameraView, {
    placement: "stage",
    shown: true,
  });
});

test("showCamera, hideCamera, and a placement write wait for the previous message's pacing", () => {
  for (const [source, before] of [
    ['say "Look at me."\nshowCamera\nexit', null],
    ['showCamera\nsay "Hidden soon."\nhideCamera\nexit', { placement: "window", shown: true }],
    [
      'let view = showCamera\nsay "Over the Stage."\nview.placement = "stage"\nexit',
      { placement: "window", shown: true },
    ],
  ] as const) {
    const plan = compileValidPlan(source);
    const paced = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
    assert.equal(paced.foregroundAction?.kind, "chatPacingGate", source);
    assert.deepEqual(paced.cameraView, before, source);
  }
});

test("camera view state survives a JSON checkpoint at every boundary", () => {
  assertRuntimeResumeEquivalent(
    [
      "let view = showCamera stage",
      'say "On the Stage.", instant',
      "wait 1",
      'view.placement = "window"',
      'say "In the window."',
      "hideCamera",
      "wait 1",
      "exit",
    ].join("\n"),
  );
});

test("the compiler and runtime reject what a camera view cannot do", () => {
  for (const [source, code] of [
    ['let view = showCamera\nview.placement = "nowhere"\nexit', "TSV059"],
    ['let view = showCamera\nview.placement += "stage"\nexit', "TSV059"],
    ["let view = showCamera\nview.size = 1\nexit", "TSV059"],
    ['let view = showCamera\nsay "${view.size}"\nexit', "TSV059"],
    ["let view = showCamera\nview.hide()\nexit", "TSV059"],
    ['save showCamera as "view"\nexit', "TSV043"],
    ["function f(view = showCamera) {\n    return view\n}\nexit", "TSV032"],
    ["global view = showCamera\nexit", "TSV055"],
    ["let showCamera = 1\nexit", "TSV001"],
    ["hideCamera(1)\nexit", "TSP035"],
    ["showCamera(1)\nexit", "TSP035"],
  ] as const)
    assert.ok(codes(source).includes(code), `${source}: ${codes(source).join(", ")}`);
  // The compiler follows the handle's type through aliases, function results, and collections.
  for (const source of [
    'let view = showCamera\nlet alias = view\nalias.placement = "nowhere"\nexit',
    'function show {\n    return showCamera\n}\nshow().placement = "nowhere"\nexit',
    'let views = [showCamera]\nviews[0].placement = "nowhere"\nexit',
  ])
    assert.deepEqual(codes(source), ["TSV059"], source);
  const computed = runValidSource(
    'let view = showCamera\nlet where = "nowhere"\nview.placement = where\nexit',
  ).snapshot;
  assert.equal(computed.failure?.code, "TSR050");
  assert.deepEqual(computed.cameraView, { placement: "window", shown: true });
});

test("restore rejects malformed camera view state and plans", () => {
  const plan = compileValidPlan("let view = showCamera stage\nwait 5\nexit");
  const json = serializeCheckpoint(
    createCheckpoint(plan, run(plan, createFreshRuntimeSnapshot(plan)).snapshot),
  );
  const pending = () => JSON.parse(json);
  const badPlacement = pending();
  badPlacement.snapshot.cameraView.placement = "floor";
  const extraField = pending();
  extraField.snapshot.cameraView.extra = 1;
  // A held handle needs the camera view.
  const noView = pending();
  noView.snapshot.cameraView = null;
  const badHandle = pending();
  badHandle.snapshot.frames[0].bindings[0].value = { kind: "cameraView", viewId: 1 };
  for (const checkpoint of [badPlacement, extraField, noView, badHandle])
    assertCheckpointRejected(checkpoint, "TSK002");
  // A halted session shows no camera view.
  const showing = compileValidPlan("showCamera\nexit");
  const halted = JSON.parse(
    serializeCheckpoint(
      createCheckpoint(showing, run(showing, createFreshRuntimeSnapshot(showing)).snapshot),
    ),
  );
  halted.snapshot.cameraView.shown = true;
  assertCheckpointRejected(halted, "TSK002");
  const forged = JSON.parse(JSON.stringify(plan));
  const instruction = forged.instructions.find(
    (candidate: { kind: string }) => candidate.kind === "showCamera",
  );
  instruction.placement = "floor";
  assert.equal(validateInstructionPlan(forged).valid, false);
});

test("a camera command inside a loop lets a waiting block change what the loop narrowed", () => {
  // The command waits for pacing, so the timer may change v before the loop tests it again.
  for (const command of ["showCamera", "hideCamera"]) {
    const source = [
      "let v: integer | string = 1",
      'timer async hidden 1 {\n    v = "text"\n}',
      'say "Waiting.", 2',
      "if v is integer {",
      "    while v < 3 {",
      `        ${command}`,
      "    }",
      "}",
      "exit",
    ].join("\n");
    assert.deepEqual(codes(source), ["TSV043"], command);
  }
});

test("showCamera may start the line after a colon, and a broken call keeps the closing brace", () => {
  assert.deepEqual(codes("let obj = { view:\n    showCamera\n}\nexit"), []);
  const broken = parse('if true { showCamera( }\nsay "after"\nexit');
  assert.deepEqual(
    broken.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP035"],
  );
  assert.equal(broken.program.statements.length, 3);
  // A brace opened inside the rejected group closes there, so the block keeps its statements.
  const argument = parse(
    'if true { hideImage({ a: 1 })\n    say "inside", instant\n}\nsay "after", instant\nexit',
  );
  assert.deepEqual(
    argument.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP035"],
  );
  assert.equal(argument.program.statements.length, 3);
  // showCamera still ends a speaker declaration that misses its closing brace.
  const speaker = parse('speaker person {\n    name: "Person"\nshowCamera\nsay "after"\nexit');
  assert.deepEqual(
    speaker.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSP007"],
  );
});

test("a mix with a camera view never suggests a type that cannot be written", () => {
  for (const source of [
    "let view = showCamera\nlet mixed = [view, 1]\nexit",
    "let view = showCamera\nlet views = [view]\nlet more = views + [1]\nexit",
    "let view = showCamera\nlet views = set[view]\nlet more = views.union(set[1])\nexit",
  ]) {
    const messages = compileSource(source).diagnostics.map((diagnostic) => diagnostic.message);
    assert.equal(messages.length, 1, source);
    assert.doesNotMatch(messages[0]!, /camera \|/u, source);
    assert.match(messages[0]!, /keep camera views apart/u, source);
  }
});
