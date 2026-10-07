import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import {
  createCheckpoint,
  createFreshRuntimeSession,
  createFreshRuntimeSnapshot,
  completeAction,
  deserializeCheckpoint,
  restoreRuntimeSession,
  run,
  RuntimeDebugContext,
  serializeCheckpoint,
  setDebugMode,
  type InterpreterEvent,
  type RuntimeSession,
} from "../src/index.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

// The protected `debugMode` (V30 §38) reads the session's Debug state, which only the host changes, as a recorded
// input between engine calls.

function said(events: readonly InterpreterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
}

function answer(session: RuntimeSession, text: string) {
  const action = session.view().foregroundAction;
  assert.equal(action?.kind, "interaction");
  return session.completeAction({
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "text",
    payload: { kind: "submittedText", submittedText: text },
  });
}

// The accepted example: Debug lets a tester past a line they would have to type exactly.
const TYPED_LINE = `let line = "I will follow the instructions."
let completed = false
while not completed {
    say line, instant
    let answer = askText "Type the line exactly"
    if answer == line or debugMode {
        completed = true
    } else {
        say "Try again.", instant
    }
}
say "Line completed.", instant
exit
`;

test("each read sees the Debug state the host set last, and a copied value keeps what it read", () => {
  const plan = compileValidPlan(TYPED_LINE);
  const session = createFreshRuntimeSession(plan);
  const asked = ["I will follow the instructions.", "Type the line exactly"];
  assert.deepEqual(said(session.run().events), asked);
  assert.equal(session.view().debugMode, false);
  answer(session, "no");
  assert.deepEqual(said(session.run().events), ["Try again.", ...asked]);

  const set = session.setDebugMode(true);
  assert.deepEqual(set, {
    events: [],
    instructionsExecuted: 0,
    outcome: { kind: "set", enabled: true },
  });
  assert.equal(session.view().debugMode, true);
  answer(session, "no");
  assert.deepEqual(said(session.run().events), ["Line completed."]);

  const copied = createFreshRuntimeSession(
    compileValidPlan(
      'let wasDebug = debugMode\nlet reply = askText "Anything"\nsay "${wasDebug} ${debugMode}", instant\nexit',
    ),
  );
  copied.run();
  copied.setDebugMode(true);
  answer(copied, "x");
  assert.deepEqual(said(copied.run().events), ["false true"]);
});

test("the Debug state starts as the host gives it and survives a checkpoint round trip", () => {
  const plan = compileValidPlan(
    'let reply = askText "Anything"\nsay "Debug: ${debugMode}", instant\nexit',
  );
  const session = createFreshRuntimeSession(plan, { debugMode: true });
  session.run();
  const restored = restoreRuntimeSession(
    deserializeCheckpoint(serializeCheckpoint(session.exportCheckpoint())),
  );
  assert.equal(restored.view().debugMode, true);
  answer(restored, "x");
  assert.deepEqual(said(restored.run().events), ["Debug: true"]);
  assert.throws(
    // Options arrive as external data.
    () => createFreshRuntimeSnapshot(plan, JSON.parse('{ "debugMode": "yes" }')),
    { name: "TypeError", message: "debugMode must be a boolean." },
  );
});

test("the snapshot API sets the Debug state as a session does, and keeps the value trace's history", () => {
  const plan = compileValidPlan(TYPED_LINE);
  const session = createFreshRuntimeSession(plan);
  const sessionTrace = new RuntimeDebugContext();
  session.run({ debugTrace: sessionTrace });
  const snapshotTrace = new RuntimeDebugContext();
  let snapshot = run(
    plan,
    createFreshRuntimeSnapshot(plan),
    {},
    { debugTrace: snapshotTrace },
  ).snapshot;

  const set = setDebugMode(plan, snapshot, true, { debugTrace: snapshotTrace });
  snapshot = set.snapshot;
  assert.deepEqual(session.setDebugMode(true, { debugTrace: sessionTrace }).outcome, set.outcome);
  assert.equal(
    serializeCheckpoint(session.exportCheckpoint()),
    serializeCheckpoint(createCheckpoint(plan, snapshot)),
  );
  const sessionBefore = sessionTrace.status();
  const snapshotBefore = snapshotTrace.status();
  answer(session, "no");
  session.run({ debugTrace: sessionTrace });
  const action = snapshot.foregroundAction!;
  snapshot = completeAction(
    plan,
    snapshot,
    {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: "no" },
    },
    { debugTrace: snapshotTrace },
  ).snapshot;
  snapshot = run(plan, snapshot, {}, { debugTrace: snapshotTrace }).snapshot;
  assert.equal(
    serializeCheckpoint(session.exportCheckpoint()),
    serializeCheckpoint(createCheckpoint(plan, snapshot)),
  );
  // Each trace continues the epoch that Start began, with the records from before the change.
  for (const [trace, before] of [
    [sessionTrace, sessionBefore],
    [snapshotTrace, snapshotBefore],
  ] as const) {
    assert.equal(trace.status().epoch, before.epoch);
    assert.equal(trace.status().firstRecord, before.firstRecord);
  }
});

test("an invalid request or an ended session changes nothing", () => {
  const plan = compileValidPlan('let reply = askText "Anything"\nexit');
  const snapshot = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  const checkpoint = serializeCheckpoint(createCheckpoint(plan, snapshot));
  const refused = setDebugMode(plan, snapshot, "on");
  assert.deepEqual(refused.outcome, {
    kind: "invalidRequest",
    message: "debugMode must be set to a boolean.",
  });
  assert.equal(serializeCheckpoint(createCheckpoint(plan, refused.snapshot)), checkpoint);

  const action = snapshot.foregroundAction!;
  const ended = run(
    plan,
    completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "interaction",
      interactionKind: "text",
      payload: { kind: "submittedText", submittedText: "x" },
    }).snapshot,
  ).snapshot;
  assert.equal(ended.status, "halted");
  const late = setDebugMode(plan, ended, true);
  assert.deepEqual(late.outcome, { kind: "invalidState", status: "halted" });
  assert.equal(late.snapshot.debugMode, false);
});

function diagnostics(source: string, options: Parameters<typeof compileSource>[1] = {}) {
  return compileSource(source, options).diagnostics.map((diagnostic) => diagnostic.message);
}

test("debugMode is a protected boolean that a script can read but not declare or assign", () => {
  const conflict =
    "Declaration 'debugMode' conflicts with a protected TeaseScript name. Choose another name, such as 'debugModeValue'.";
  assert.deepEqual(diagnostics("let debugMode = true\nexit"), [conflict]);
  assert.deepEqual(diagnostics("function check(debugMode) {\n    return 1\n}\nexit"), [conflict]);
  assert.deepEqual(diagnostics('for debugMode in [1, 2] {\n    say "x"\n}\nexit'), [conflict]);
  assert.deepEqual(diagnostics("debugMode = true\nexit"), [
    "Cannot assign to 'debugMode', which is read-only.",
  ]);
  assert.deepEqual(diagnostics("exit", { globals: ["debugMode"] }), [
    "Configured name 'debugMode' conflicts with a protected TeaseScript name.",
  ]);
  assert.equal(diagnostics("let shown: string = debugMode\nexit").length, 1);
  // A property of that name is an ordinary property.
  assert.deepEqual(
    diagnostics('let settings = { debugMode: 1 }\nsay "${settings.debugMode}"\nexit'),
    [],
  );
});
