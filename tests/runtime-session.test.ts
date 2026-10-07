import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSession,
  createRuntimeSession,
  executeInstruction,
  observeTime,
  restoreRuntimeSession,
  run,
  RuntimeDataError,
  RuntimeDebugContext,
  RuntimeSessionError,
  serializeCheckpoint,
  type InstructionPlan,
  type RuntimeSession,
  type RuntimeSnapshot,
} from "../src/index.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/checkpoint.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

/*
 * Engine-owned runtime sessions (docs/RUNTIME.md#runtime-sessions). The shared resume-equivalence helper compares
 * sessions with the snapshot API across the scenario corpus; these cases cover ownership: what a session publishes,
 * what it accepts, and how its operations commit.
 */

const CHOICE_LOOP = `let rounds = 0
while rounds < 100 {
    let picked = choose "left", "right"
    rounds += 1
    say "Round \${rounds}: \${picked}"
    wait 1
}
exit
`;

function choiceRequest(session: RuntimeSession, optionIndex: number) {
  const action = session.view().foregroundAction;
  assert.equal(action?.kind, "interaction");
  return {
    actionId: action.actionId,
    actionKind: "interaction",
    interactionKind: "choice",
    payload: { kind: "selectedOption", optionIndex },
  };
}

function checkpointOf(plan: InstructionPlan, snapshot: RuntimeSnapshot): string {
  return serializeCheckpoint(createCheckpoint(plan, snapshot));
}

test("a session gives the snapshot API's results, outcomes, traces, and refusals", () => {
  const plan = compileValidPlan(CHOICE_LOOP);
  let snapshot = createImmediatePacingRuntimeSnapshot(plan, { seed: 11 });
  const session = createRuntimeSession(plan, snapshot);
  const legacyContext = new RuntimeDebugContext();
  const sessionContext = new RuntimeDebugContext();

  const ran = run(plan, snapshot, {}, { instructionTrace: true, debugTrace: legacyContext });
  snapshot = ran.snapshot;
  const { snapshot: _, ...ranResult } = ran;
  assert.deepEqual(session.run({ instructionTrace: true, debugTrace: sessionContext }), ranResult);

  const request = choiceRequest(session, 1);
  const inputs: readonly unknown[] = [
    { ...request, actionId: request.actionId + 5 },
    { ...request, payload: { kind: "selectedOption", optionIndex: 9 } },
    "not a request",
    request,
    request,
  ];
  for (const input of inputs) {
    const legacy = completeAction(plan, snapshot, input, { debugTrace: legacyContext });
    snapshot = legacy.snapshot;
    const { snapshot: __, ...expected } = legacy;
    assert.deepEqual(session.completeAction(input, { debugTrace: sessionContext }), expected);
    assert.equal(serializeCheckpoint(session.exportCheckpoint()), checkpointOf(plan, snapshot));
  }

  for (const nowMs of [-1, 500, 1_000, 200]) {
    const ranAgain = run(plan, snapshot, {}, { debugTrace: legacyContext });
    snapshot = ranAgain.snapshot;
    assert.deepEqual(session.run({ debugTrace: sessionContext }).events, ranAgain.events);
    const observed = observeTime(plan, snapshot, nowMs, [], { debugTrace: legacyContext });
    snapshot = observed.snapshot;
    const { snapshot: ___, ...expected } = observed;
    assert.deepEqual(session.observeTime(nowMs, [], { debugTrace: sessionContext }), expected);
  }
  assert.equal(serializeCheckpoint(session.exportCheckpoint()), checkpointOf(plan, snapshot));
  assert.deepEqual(sessionContext.status(), legacyContext.status());
});

test("nothing a session publishes or exports shares an object with its state", () => {
  const plan = compileValidPlan(CHOICE_LOOP);
  const supplied = createImmediatePacingRuntimeSnapshot(plan);
  const session = createRuntimeSession(plan, supplied);
  supplied.frames.length = 0;
  session.run();

  const completed = session.completeAction(choiceRequest(session, 0));
  assert.equal(completed.outcome.kind, "completed");
  const event = completed.events.find((candidate) => candidate.kind === "actionCompleted");
  assert.ok(event?.kind === "actionCompleted" && event.settlement.actionKind === "interaction");
  const ui = event.settlement.ui;
  assert.equal(ui.kind, "choice");
  // A frozen copy: in the snapshot API this nested UI is the returned snapshot's `lastSettlement.ui`.
  assert.equal(Reflect.set(ui.options[0]!, "text", "changed"), false);

  const view = session.view();
  assert.equal(Reflect.set(view, "status", "halted"), false);

  const exported = session.exportSnapshot();
  const before = serializeCheckpoint(session.exportCheckpoint());
  exported.frames.length = 0;
  Reflect.set(exported, "status", "halted");
  const checkpoint = session.exportCheckpoint();
  checkpoint.snapshot.frames.length = 0;
  assert.equal(serializeCheckpoint(session.exportCheckpoint()), before);
  assert.equal(session.view().status, "running");
});

test("a fork is independent of its parent and shares only the immutable plan", () => {
  const plan = compileValidPlan(CHOICE_LOOP);
  const parent = createFreshRuntimeSession(plan, {
    seed: 3,
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  parent.run();
  const atFork = serializeCheckpoint(parent.exportCheckpoint());
  const child = parent.fork();
  assert.equal(child.plan, parent.plan);
  assert.equal(serializeCheckpoint(child.exportCheckpoint()), atFork);

  child.completeAction(choiceRequest(child, 0));
  child.run();
  assert.equal(serializeCheckpoint(parent.exportCheckpoint()), atFork);

  parent.completeAction(choiceRequest(parent, 1));
  parent.run();
  const sibling = restoreRuntimeSession(JSON.parse(atFork));
  sibling.completeAction(choiceRequest(sibling, 0));
  sibling.run();
  assert.equal(
    serializeCheckpoint(child.exportCheckpoint()),
    serializeCheckpoint(sibling.exportCheckpoint()),
  );
  assert.notEqual(
    serializeCheckpoint(parent.exportCheckpoint()),
    serializeCheckpoint(child.exportCheckpoint()),
  );
});

test("sessions come only from the factories, which validate what they import", () => {
  const plan = compileValidPlan(CHOICE_LOOP);
  const other = compileValidPlan('say "other"\nexit');
  const snapshot = createImmediatePacingRuntimeSnapshot(plan);
  const session = createRuntimeSession(plan, snapshot);
  assert.throws(
    () => Reflect.construct(session.constructor, [Symbol("RuntimeSession"), plan, snapshot, {}]),
    TypeError,
  );

  const malformed = (callback: () => void, code: string) =>
    assert.throws(callback, (error) => error instanceof RuntimeDataError && error.code === code);
  malformed(() => createRuntimeSession(other, run(plan, snapshot).snapshot), "TSR101");
  // EVIDENCE: fixture: a snapshot with an unknown status is deliberately malformed external data.
  const unknownStatus = { ...snapshot, status: "unknown" } as never;
  malformed(() => createRuntimeSession(plan, unknownStatus), "TSR101");
  // EVIDENCE: fixture: a plan of another version is deliberately malformed external data.
  const otherVersion = { ...plan, version: 0 } as never;
  malformed(() => createRuntimeSession(otherVersion, snapshot), "TSR100");
  // EVIDENCE: fixture: an empty object is deliberately not an instruction plan.
  const notAPlan = {} as never;
  assert.throws(() => createFreshRuntimeSession(notAPlan), TypeError);
  assert.throws(() => restoreRuntimeSession({ format: "other" }), CheckpointError);
});

test("an operation cannot start while another operation of its session runs", () => {
  const plan = compileValidPlan("let value = reenter()\nsay value\nexit", {
    builtins: ["reenter"],
  });
  const holder: { session: RuntimeSession | null } = { session: null };
  const reenter = () => {
    holder.session!.view();
    return 1;
  };
  holder.session = createRuntimeSession(plan, createImmediatePacingRuntimeSnapshot(plan), {
    capabilities: { builtins: { reenter } },
  });
  const ran = holder.session.run();
  const legacy = run(plan, createImmediatePacingRuntimeSnapshot(plan), {
    builtins: {
      reenter: () => {
        throw new RuntimeSessionError(
          "A runtime session operation cannot start while another operation of the same session runs.",
        );
      },
    },
  });
  assert.equal(holder.session.view().failure?.code, "TSR012");
  assert.deepEqual(ran.events, legacy.events);
});

test("an ordinary session step captures and validates only its new input", () => {
  // Diagnostic scale evidence, not a capacity contract: the work of one step must not grow with unchanged state.
  const work = (width: number) => {
    const plan = compileValidPlan(
      `let payload = []\nfor index in 1..=${width} {\n    payload.add({ index: index, text: "item \${index}" })\n}\n${CHOICE_LOOP}`,
    );
    const session = createFreshRuntimeSession(plan, {
      baseDelayMs: 0,
      delayPerWordMs: 0,
      delayPerCharacterMs: 0,
    });
    session.run({ instructionBudget: 100_000 });
    const request = choiceRequest(session, 1);
    return withValidationTestStatistics((statistics) => {
      session.completeAction(request);
      session.run();
      session.observeTime(1_000, []);
      session.run();
      return statistics().counts;
    });
  };
  const narrow = work(4);
  assert.equal(narrow.snapshotValidationAnalyses ?? 0, 0);
  assert.deepEqual(work(2_000), narrow);
});

test("an operation that throws ends its session, and argument errors leave it usable", () => {
  const ended = (session: RuntimeSession, cause: unknown) => {
    for (const call of [
      () => session.view(),
      () => session.run(),
      () => session.observeTime(1),
      () => session.exportSnapshot(),
      () => session.exportCheckpoint(),
      () => session.fork(),
    ])
      assert.throws(call, (error) => error instanceof RuntimeSessionError && error.cause === cause);
  };

  // A valid snapshot with one event sequence left: the first message takes it, and the second throws TSR101, after
  // the first was emitted. The snapshot API leaves its input as it was.
  const says = compileValidPlan('say "one", instant\nsay "two", instant\nexit');
  const nearly = createImmediatePacingRuntimeSnapshot(says);
  nearly.nextEventSequence = Number.MAX_SAFE_INTEGER - 1;
  const before = JSON.stringify(nearly);
  const exhausted = (error: unknown) =>
    error instanceof RuntimeDataError && error.code === "TSR101";
  assert.throws(() => run(says, nearly), exhausted);
  assert.equal(JSON.stringify(nearly), before);
  const session = createRuntimeSession(says, nearly);
  let thrown: unknown;
  assert.throws(
    () => session.run(),
    (error) => {
      thrown = error;
      return exhausted(error);
    },
  );
  ended(session, thrown);

  // A host random source that throws inside a collection's `.random` propagates from both APIs.
  const picks = compileValidPlan("let before = 1\nlet values = [1, 2]\nsay values.random\nexit");
  const failing = new Error("random source failed");
  const random = {
    next: () => {
      throw failing;
    },
  };
  assert.throws(() => run(picks, createImmediatePacingRuntimeSnapshot(picks), { random }), failing);
  const picking = createRuntimeSession(picks, createImmediatePacingRuntimeSnapshot(picks), {
    capabilities: { random },
  });
  assert.throws(() => picking.run(), failing);
  ended(picking, failing);

  // Malformed arguments are refused before the operation starts.
  const plan = compileValidPlan(CHOICE_LOOP);
  let snapshot = createImmediatePacingRuntimeSnapshot(plan);
  const usable = createRuntimeSession(plan, snapshot);
  assert.throws(() => usable.run({ instructionBudget: 0 }), RangeError);
  // EVIDENCE: fixture: null options are deliberately malformed arguments.
  const nullOptions = null as never;
  assert.throws(() => usable.observeTime(1, [], nullOptions), TypeError);
  // EVIDENCE: fixture: a number is deliberately not a RuntimeDebugContext.
  const notATrace = 1 as never;
  assert.throws(() => usable.stepToEvent({ debugTrace: notATrace }), TypeError);
  // EVIDENCE: fixture: an admission without `holds` is a deliberately malformed argument.
  const noHolds = {} as never;
  assert.throws(
    () => usable.completeAction({ actionId: 1 }, { capturedMedia: noHolds }),
    TypeError,
  );
  // EVIDENCE: fixture: a random source without `next` is a deliberately malformed argument.
  const noNext = {} as never;
  assert.throws(
    () => createRuntimeSession(plan, snapshot, { capabilities: { random: noNext } }),
    TypeError,
  );
  snapshot = run(plan, snapshot).snapshot;
  assert.deepEqual(
    usable.run().events,
    run(plan, createImmediatePacingRuntimeSnapshot(plan)).events,
  );
  assert.equal(serializeCheckpoint(usable.exportCheckpoint()), checkpointOf(plan, snapshot));
});

test("a session's plan, options, debug context, and deep output cannot reach or change its state", () => {
  const plan = compileValidPlan("let value = 1\nsay value, instant\nexit");
  const other = compileValidPlan('say "replacement", instant\nexit');
  const session = createRuntimeSession(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(Reflect.set(session, "plan", other), false);
  assert.equal(session.plan, plan);

  // A debug context holds nothing that leads to the recorder, which sees the session's state.
  const debugTrace = new RuntimeDebugContext();
  assert.deepEqual(Reflect.ownKeys(debugTrace), []);

  // Each option is read once, so the value checked is the value used.
  let reads = 0;
  const options = {
    get instructionBudget() {
      reads += 1;
      return reads === 1 ? 10 : 0;
    },
    debugTrace,
  };
  const ran = session.run(options);
  assert.equal(reads, 1);
  assert.deepEqual(
    ran.events,
    run(plan, createImmediatePacingRuntimeSnapshot(plan), {}, { instructionBudget: 10 }).events,
  );

  // Deeply nested values publish and fork without exhausting the stack, as the snapshot API runs them.
  const depth = 1_500;
  const deep = compileValidPlan(
    `let nested = ${"{ item: ".repeat(depth)}1${" }".repeat(depth)}\nsave nested as "deep"\nsay nested, instant\nexit`,
  );
  const initial = createImmediatePacingRuntimeSnapshot(deep, { persistentScriptStorage: true });
  const nested = createRuntimeSession(deep, initial);
  const legacy = run(deep, initial);
  // Compared as JSON: node:assert itself recurses through nested values.
  assert.equal(
    serializeValidatedRuntimeJson(nested.run()),
    serializeValidatedRuntimeJson({
      events: legacy.events,
      instructionsExecuted: legacy.instructionsExecuted,
    }),
  );
  assert.equal(
    serializeCheckpoint(nested.fork().exportCheckpoint()),
    checkpointOf(deep, legacy.snapshot),
  );
});

test("a fork keeps the property order of an imported snapshot, and an ended session refuses every fork", () => {
  const plan = compileValidPlan(CHOICE_LOOP);
  const initial = createImmediatePacingRuntimeSnapshot(plan);
  // EVIDENCE: fixture: the same snapshot fields in reverse order, which import accepts as they are.
  const reordered = Object.fromEntries(Object.entries(initial).reverse()) as never;
  const parent = createRuntimeSession(plan, reordered);
  const child = parent.fork();
  assert.equal(
    serializeCheckpoint(child.exportCheckpoint()),
    serializeCheckpoint(parent.exportCheckpoint()),
  );
  child.executeInstruction();
  assert.equal(
    serializeCheckpoint(child.exportCheckpoint()),
    checkpointOf(plan, executeInstruction(plan, reordered).snapshot),
  );

  const failing = new Error("random source failed");
  const picks = compileValidPlan("let values = [1, 2]\nsay values.random\nexit");
  const ended = createRuntimeSession(picks, createImmediatePacingRuntimeSnapshot(picks), {
    capabilities: {
      random: {
        next: () => {
          throw failing;
        },
      },
    },
  });
  assert.throws(() => ended.run(), failing);
  // EVIDENCE: fixture: null and a random source without `next` are deliberately malformed fork options.
  const malformed = [null, { capabilities: { random: {} } }] as never[];
  for (const options of malformed)
    assert.throws(
      () => ended.fork(options),
      (error) => error instanceof RuntimeSessionError && error.cause === failing,
    );
});
