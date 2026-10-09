import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  applyExternalStorageEdit,
  CheckpointError,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSession,
  createRuntimeSession,
  createTaggedRuntimeSession,
  executeInstruction,
  inspectRuntimeState,
  mediaPlaybackProjection,
  observeTime,
  permanentButtonProjection,
  pressPermanentButton,
  recordContinueCapture,
  reportMediaLoad,
  restoreRuntimeSession,
  run,
  RuntimeDataError,
  RuntimeDebugContext,
  runtimeDebugPreview,
  RuntimeSessionError,
  serializeCheckpoint,
  stageProjection,
  updateInteraction,
  type InstructionPlan,
  type RuntimeOperationResult,
  type RuntimeSession,
  type RuntimeSessionResult,
  type RuntimeSnapshot,
  type FreshRuntimeOptions,
  type TaggedRuntimeSnapshot,
} from "../src/index.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/checkpoint.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { AMSTERDAM } from "./helpers/temporal-fixtures.js";

/*
 * Engine-owned runtime sessions (docs/RUNTIME.md#runtime-sessions). The shared resume-equivalence helper compares
 * sessions with the snapshot API across the scenario corpus; these cases cover ownership: what a session publishes,
 * what it accepts, and how its operations commit.
 */

const CHOICE_LOOP = `let rounds = 0
while rounds < 100 {
    let picked = choose "left", "right"
    rounds += 1
    say "Round \${rounds}: \${picked}", instant
    wait 1
}
exit
`;

const IMMEDIATE = { seed: 5, baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 } as const;

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
  // A trusted export is the checked export's JSON, copied without checking, and it is the host's own data too.
  const trusted = withValidationTestStatistics((statistics) => {
    const copy = session.exportTrustedSnapshot();
    assert.equal(statistics().counts.snapshotValidationAnalyses ?? 0, 0);
    return copy;
  });
  assert.equal(JSON.stringify(trusted), JSON.stringify(session.exportSnapshot()));
  trusted.frames.length = 0;
  // Even the date and time contexts, which a fork shares, are copies the host may change.
  assert.ok(trusted.temporalCaptures.length > 0);
  for (const capture of trusted.temporalCaptures)
    assert.equal(Reflect.set(capture.context, "presentation", null), true);
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

test("a tagged snapshot restores without capture or validation to the checked restore's state", () => {
  const plan = compileValidPlan(CHOICE_LOOP);
  const source = createFreshRuntimeSession(plan, IMMEDIATE);
  source.run();
  source.completeAction(choiceRequest(source, 1));
  source.run();
  source.observeTime(1_000);
  source.run();
  const atExport = serializeCheckpoint(source.exportCheckpoint());
  const tagged = withValidationTestStatistics((statistics) => {
    const exported = source.exportTaggedSnapshot();
    assert.equal(statistics().counts.snapshotValidationAnalyses ?? 0, 0);
    return exported;
  });
  assert.equal(tagged.json, JSON.stringify(source.exportSnapshot()));
  assert.equal(Reflect.set(tagged, "json", "{}"), false);

  const restore = () =>
    withValidationTestStatistics((statistics) => {
      const restored = createTaggedRuntimeSession(source.plan, tagged);
      const { counts } = statistics();
      assert.equal(counts.externalCaptureVisits ?? 0, 0);
      assert.equal(counts.snapshotValidationAnalyses ?? 0, 0);
      return restored;
    });
  const restored = restore();
  const checked = createRuntimeSession(plan, JSON.parse(tagged.json));
  assert.equal(restored.plan, source.plan);
  assert.equal(serializeCheckpoint(restored.exportCheckpoint()), atExport);
  assert.equal(serializeCheckpoint(checked.exportCheckpoint()), atExport);

  // The source goes on; the restored session shares nothing with it and continues as the checked restore does.
  source.completeAction(choiceRequest(source, 1));
  source.run();
  restored.completeAction(choiceRequest(restored, 0));
  checked.completeAction(choiceRequest(checked, 0));
  assert.deepEqual(restored.run(), checked.run());
  assert.equal(
    serializeCheckpoint(restored.exportCheckpoint()),
    serializeCheckpoint(checked.exportCheckpoint()),
  );
  // The tagged snapshot stays as it was exported, and each restore of it is a session of its own.
  assert.equal(serializeCheckpoint(restore().exportCheckpoint()), atExport);
});

test("any other tagged input is captured and validated, also a changed one, another plan's, or another process's", () => {
  const plan = compileValidPlan(CHOICE_LOOP);
  const session = createFreshRuntimeSession(plan, IMMEDIATE);
  session.run();
  const tagged = session.exportTaggedSnapshot();
  /** Requires the checked path: capture and validation, and the session `createRuntimeSession` gives for the JSON. */
  const checked = (restorePlan: InstructionPlan, input: TaggedRuntimeSnapshot, context: string) => {
    const restored = withValidationTestStatistics((statistics) => {
      const created = createTaggedRuntimeSession(restorePlan, input);
      assert.ok((statistics().counts.externalCaptureVisits ?? 0) > 0, `${context}: not captured`);
      return created;
    });
    assert.equal(
      serializeCheckpoint(restored.exportCheckpoint()),
      serializeCheckpoint(
        createRuntimeSession(restorePlan, JSON.parse(input.json)).exportCheckpoint(),
      ),
      context,
    );
  };

  // Another plan object of the same source has a key of its own.
  const twin = compileValidPlan(CHOICE_LOOP);
  const twinSession = createFreshRuntimeSession(twin, IMMEDIATE);
  twinSession.run();
  const twinTagged = twinSession.exportTaggedSnapshot();
  assert.equal(twinTagged.json, tagged.json);
  assert.notEqual(twinTagged.tag, tagged.tag);
  checked(plan, twinTagged, "another plan's tag");
  checked(twin, tagged, "another plan");
  // EVIDENCE: fixture: a plain copy of a validated plan is unvalidated external data.
  checked(
    JSON.parse(JSON.stringify(plan)) as InstructionPlan,
    tagged,
    "an unvalidated copy of the plan",
  );
  const flipped = (tagged.tag.startsWith("0") ? "1" : "0") + tagged.tag.slice(1);
  checked(plan, { json: tagged.json, tag: flipped }, "a changed tag");
  // EVIDENCE: fixture: a host's tagged snapshot that lost its tag.
  checked(plan, { json: tagged.json } as never, "no tag");
  session.completeAction(choiceRequest(session, 0));
  session.run();
  checked(
    plan,
    { json: tagged.json, tag: session.exportTaggedSnapshot().tag },
    "a later snapshot's tag",
  );

  // A change that validation accepts is kept, and one it refuses throws, though the tag is the original.
  const changed = JSON.parse(tagged.json);
  assert.deepEqual(changed.frames[0].bindings[0], { name: "rounds", value: 0 });
  changed.frames[0].bindings[0].value = 7;
  const changedJson = JSON.stringify(changed);
  checked(plan, { json: changedJson, tag: tagged.tag }, "changed JSON");
  const refused = (input: unknown, message: RegExp) => {
    // EVIDENCE: fixture: deliberately malformed host input.
    const malformed = input as TaggedRuntimeSnapshot;
    assert.throws(
      () => createTaggedRuntimeSession(plan, malformed),
      (error) =>
        error instanceof RuntimeDataError && error.code === "TSR101" && message.test(error.message),
    );
  };
  refused(
    { json: tagged.json.replace('"nextInstruction":', '"nextInstruction":9'), tag: tagged.tag },
    /./,
  );
  refused({ json: "{", tag: tagged.tag }, /JSON is invalid/);
  refused({ json: 5, tag: tagged.tag }, /JSON as a string/);
  refused(null, /JSON as a string/);

  // Each part is read once, so what the tag proves is what runs.
  let reads = 0;
  const swapping = {
    get json() {
      reads += 1;
      return reads === 1 ? tagged.json : changedJson;
    },
    tag: tagged.tag,
  };
  const proven = createTaggedRuntimeSession(plan, swapping);
  assert.equal(reads, 1);
  assert.equal(
    serializeCheckpoint(proven.exportCheckpoint()),
    serializeCheckpoint(createRuntimeSession(plan, JSON.parse(tagged.json)).exportCheckpoint()),
  );

  // Another process's engine has keys of its own.
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const plan = m.compileSource(${JSON.stringify(CHOICE_LOOP)}).plan;
    const session = m.createFreshRuntimeSession(plan, ${JSON.stringify(IMMEDIATE)});
    session.run();
    process.stdout.write(JSON.stringify(session.exportTaggedSnapshot()));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const foreign: TaggedRuntimeSnapshot = JSON.parse(child.stdout);
  assert.equal(foreign.json, tagged.json);
  checked(plan, foreign, "another process's tagged snapshot");
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

test("a kept settled media or timer handle does not make a session step walk unrelated values", () => {
  // Diagnostic scale evidence, not a capacity contract: the work of one step must not grow with the size of a large
  // value walked beside the handle, nor with the number of values or retained scopes after the variable that holds it.
  const work = (source: string, globals: NonNullable<FreshRuntimeOptions["globals"]>) => {
    const session = createFreshRuntimeSession(compileValidPlan(source), { ...IMMEDIATE, globals });
    session.run();
    if (session.view().backgroundActions.some((action) => action.kind === "media")) {
      session.reportMediaLoad(1, { kind: "loaded", durationMs: 1_000 });
      session.run();
    }
    return withValidationTestStatistics((statistics) => {
      session.observeTime(1);
      session.run();
      const { settledMedia, settledTimers } = session.exportTrustedSnapshot();
      assert.equal(settledMedia.length + settledTimers.length, 1);
      return statistics().counts;
    });
  };
  const payload = (width: number) => ({
    payload: { kind: "list" as const, items: Array.from({ length: width }, (_, index) => index) },
  });
  const separate = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`value${index}`, index]));
  for (const start of ['playAudio async "a.mp3"', "timer async 5"]) {
    const inList = `global keeper: list = []\nkeeper.add(${start})\nkeeper[0].stop()\nwait 1000\nexit`;
    const narrow = work(inList, payload(4));
    assert.ok((narrow.recordReachVisits ?? 0) > 0);
    assert.deepEqual(work(inList, payload(2_000)), narrow);
    const inVariable = `let keeper = ${start}\nkeeper.stop()\nwait 1000\nexit`;
    assert.deepEqual(work(inVariable, separate(2_000)), work(inVariable, separate(4)));
  }
  // Each pending timer keeps the scope of the call that started it.
  const retained = (count: number) =>
    [
      "function register(n: integer) {",
      "  let captured = n",
      "  timer async 1000 {",
      "    let seen = captured",
      "  }",
      "}",
      'let keeper = playAudio async "a.mp3"',
      "keeper.stop()",
      "let i = 0",
      `while i < ${count} {`,
      "  register(i)",
      "  i += 1",
      "}",
      "wait 1000",
      "exit",
    ].join("\n");
  assert.equal(
    work(retained(2_000), {}).recordReachVisits,
    work(retained(4), {}).recordReachVisits,
  );
});

test("an operation that throws ends its session, and argument errors leave it usable", () => {
  const ended = (session: RuntimeSession, cause: unknown) => {
    for (const call of [
      () => session.view(),
      () => session.run(),
      () => session.observeTime(1),
      () => session.exportSnapshot(),
      () => session.exportTrustedSnapshot(),
      () => session.exportTaggedSnapshot(),
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
  // EVIDENCE: fixture: a builtin that is not a function is a deliberately malformed argument.
  const notAFunction = { answer: 42 } as never;
  assert.throws(
    () => createRuntimeSession(plan, snapshot, { capabilities: { builtins: notAFunction } }),
    { name: "TypeError", message: "capabilities.builtins.answer must be a function." },
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

test("a fork keeps each of its parent's capabilities that its options do not give", () => {
  const plan = compileValidPlan(
    'let value = answer()\nlet pick = ["first", "last"].random\nsay "${value} ${pick}", instant\nexit',
    { builtins: ["answer"] },
  );
  const fixed = (value: number) => ({ next: () => value });
  const parent = createRuntimeSession(plan, createImmediatePacingRuntimeSnapshot(plan), {
    capabilities: { builtins: { answer: () => 42 }, random: fixed(0) },
  });
  const said = (session: RuntimeSession) =>
    session.run().events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  // EVIDENCE: fixture: an explicit undefined, which an untyped caller may pass, is still no capabilities.
  const explicitlyNone = { capabilities: undefined } as never;
  for (const options of [undefined, {}, explicitlyNone, { capabilities: {} }])
    assert.deepEqual(said(parent.fork(options)), ["42 first"]);
  // Options replace only the capabilities they give.
  assert.deepEqual(said(parent.fork({ capabilities: { builtins: { answer: () => 7 } } })), [
    "7 first",
  ]);
  assert.deepEqual(said(parent.fork({ capabilities: { random: fixed(0.99) } })), ["42 last"]);
});

test("a fork admits only functions as builtins, and a session keeps the builtins it admitted", () => {
  const plan = compileValidPlan('say "${answer()}", instant\nexit', { builtins: ["answer"] });
  const builtins = { answer: () => 42 };
  const parent = createRuntimeSession(plan, createImmediatePacingRuntimeSnapshot(plan), {
    capabilities: { builtins },
  });
  // The session checked the function it uses, so a later change to the host's record does not reach it.
  builtins.answer = () => 7;
  const said = (session: RuntimeSession) =>
    session.run().events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
  // EVIDENCE: fixture: a builtin that is not a function is a deliberately malformed fork option.
  const notAFunction = { answer: 42 } as never;
  assert.throws(() => parent.fork({ capabilities: { builtins: notAFunction } }), {
    name: "TypeError",
    message: "capabilities.builtins.answer must be a function.",
  });
  // EVIDENCE: fixture: an explicit undefined, which an untyped caller may pass, gives no builtin.
  const explicitlyNone = { answer: undefined } as never;
  assert.doesNotThrow(() => parent.fork({ capabilities: { builtins: explicitlyNone } }));
  // The refused fork left the parent usable.
  assert.deepEqual(said(parent.fork()), ["42"]);
  assert.deepEqual(said(parent), ["42"]);
});

test("the other host operations, projections, and inspection give the snapshot API's results", () => {
  const plan = compileValidPlan(`let count = 0
showPermanentButton "Add one" {
    count += 1
    say "count \${count}"
}
let beat = playAudio(file: "beat.mp3", async: true)
let settings = askForm "Settings", fields: {
    enabled: { value: false, description: "Turn it on" },
    intensity: ["Low", "High"]
}, submit: "Continue"
say "level \${settings.intensity}"
exit
`);
  const start = 1_700_000_000_000;
  let snapshot = createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: start });
  const session = createRuntimeSession(plan, snapshot);
  const outcomes: string[] = [];
  const same = (
    legacy: RuntimeOperationResult,
    operate: (current: RuntimeSession) => RuntimeSessionResult,
  ) => {
    snapshot = legacy.snapshot;
    const { snapshot: _, ...expected } = legacy;
    assert.deepEqual(operate(session), expected);
    const outcome: unknown = "outcome" in legacy ? legacy.outcome : null;
    if (typeof outcome === "object" && outcome !== null && "kind" in outcome)
      outcomes.push(String(outcome.kind));
    assert.equal(serializeCheckpoint(session.exportCheckpoint()), checkpointOf(plan, snapshot));
    assert.deepEqual(session.stageProjection(), stageProjection(snapshot));
    assert.deepEqual(session.mediaPlaybackProjection(), mediaPlaybackProjection(snapshot));
    assert.deepEqual(session.permanentButtonProjection(), permanentButtonProjection(snapshot));
  };
  const form = () => snapshot.foregroundAction!.actionId;
  const update = (fieldId: string, optionIndex: number) => ({
    actionId: form(),
    actionKind: "interaction",
    interactionKind: "form",
    update: { kind: "select", fieldId, optionIndex },
  });

  // The script waits for its audio to load; a click before the form opens must wait for execution.
  same(run(plan, snapshot), (current) => current.run());
  same(reportMediaLoad(plan, snapshot, 99, { kind: "loaded", durationMs: 1 }), (current) =>
    current.reportMediaLoad(99, { kind: "loaded", durationMs: 1 }),
  );
  same(reportMediaLoad(plan, snapshot, 1, { kind: "loaded", durationMs: 5_000 }), (current) =>
    current.reportMediaLoad(1, { kind: "loaded", durationMs: 5_000 }),
  );
  same(pressPermanentButton(plan, snapshot, 1), (current) => current.pressPermanentButton(1));
  same(run(plan, snapshot), (current) => current.run());
  same(pressPermanentButton(plan, snapshot, 99), (current) => current.pressPermanentButton(99));
  same(pressPermanentButton(plan, snapshot, 1), (current) => current.pressPermanentButton(1));
  same(run(plan, snapshot), (current) => current.run());
  same(updateInteraction(plan, snapshot, update("missing", 0)), (current) =>
    current.updateInteraction(update("missing", 0)),
  );
  same(updateInteraction(plan, snapshot, update("intensity", 1)), (current) =>
    current.updateInteraction(update("intensity", 1)),
  );
  same(applyExternalStorageEdit(plan, snapshot, { key: "" }), (current) =>
    current.applyExternalStorageEdit({ key: "" }),
  );
  same(applyExternalStorageEdit(plan, snapshot, { key: "level", value: 7 }), (current) =>
    current.applyExternalStorageEdit({ key: "level", value: 7 }),
  );
  same(recordContinueCapture(plan, snapshot, { wallClockMs: "soon" }), (current) =>
    current.recordContinueCapture({ wallClockMs: "soon" }),
  );
  same(recordContinueCapture(plan, snapshot, { wallClockMs: start + 60_000 }), (current) =>
    current.recordContinueCapture({ wallClockMs: start + 60_000 }),
  );
  const submit = {
    actionId: form(),
    actionKind: "interaction",
    interactionKind: "form",
    payload: { kind: "submit" },
  };
  same(completeAction(plan, snapshot, submit), (current) => current.completeAction(submit));
  const reports = [{ mediaId: 1, segment: 0, progressMs: 1_000 }];
  same(observeTime(plan, snapshot, 1_000, reports), (current) =>
    current.observeTime(1_000, reports),
  );
  same(run(plan, snapshot), (current) => current.run());
  assert.equal(session.view().status, "halted");
  // Each operation was both refused and accepted.
  assert.deepEqual(outcomes, [
    "unknownMedia",
    "accepted",
    "executionPending",
    "unknownButton",
    "pressed",
    "invalidPayload",
    "updated",
    "invalidEdit",
    "applied",
    "invalidCapture",
    "recorded",
    "completed",
    "observed",
  ]);
  assert.deepEqual(session.inspect(), inspectRuntimeState(plan, snapshot));
});

test("callReturnInstructions gives where each active call continues, outermost first", () => {
  const plan = compileValidPlan(`function inner(first) {
    let answer = choose first, "b"
    return answer
}
function outer(first) {
    let picked = inner(first)
    return picked
}
let result = outer("a")
say result, instant
exit
`);
  const session = createRuntimeSession(plan, createImmediatePacingRuntimeSnapshot(plan));
  session.run();
  const returns = session.callReturnInstructions();
  assert.equal(returns.length, 2);
  assert.deepEqual(
    returns,
    session.exportSnapshot().callFrames.map((frame) => frame.returnInstruction),
  );
  assert.ok(Object.isFrozen(returns));
  session.completeAction(choiceRequest(session, 1));
  session.run();
  assert.deepEqual(session.callReturnInstructions(), []);
});

test("the debugger reads give the state's calls, variables, camera, queue, and date presentation", () => {
  const plan = compileValidPlan(`global level = 2
let names = ["a", "b"]
let note = say "Waiting", instant
function hold(seconds) {
    timer async 1 {
        note.text = "Tick"
        wait 5
    }
    wait seconds
    return seconds
}
let held = hold(10)
exit
`);
  const session = createFreshRuntimeSession(plan, {
    temporalContext: AMSTERDAM,
    wallClockMs: 1_700_000_000_000,
    baseDelayMs: 0,
    delayPerWordMs: 0,
    delayPerCharacterMs: 0,
  });
  session.run();
  session.observeTime(1_000);
  assert.equal(session.view().queuedBlocks, 1);
  session.run();
  const exported = session.exportSnapshot();

  // A block interrupted the function's wait: the stack is the function, then the timer block.
  const calls = session.callStack();
  assert.deepEqual(
    calls.map((call) => [call.kind, call.functionName, call.interruption]),
    [
      ["function", "hold", null],
      ["function", "timer expiry", "timer"],
    ],
  );
  assert.deepEqual(
    calls.map((call) => [call.id, call.returnInstruction, call.scopeBaseDepth, call.callSiteSpan]),
    exported.callFrames.map((frame) => [
      frame.id,
      frame.returnInstruction,
      frame.scopeBaseDepth,
      frame.callSiteSpan,
    ]),
  );
  assert.equal(session.view().suspendedAction?.kind, "delay");

  // Each variable with its bounded preview; a message handle names its message, whose text is listed.
  const preview = (binding: RuntimeSnapshot["globals"][number]) => {
    const { text, truncated } = runtimeDebugPreview(binding.value);
    const value = binding.value;
    return {
      name: binding.name,
      preview: text,
      truncated,
      messageId:
        typeof value === "object" && value !== null && value.kind === "messageHandle"
          ? value.messageId
          : null,
    };
  };
  const scope = (frame: RuntimeSnapshot["frames"][number]) => ({
    id: frame.id,
    file: frame.file,
    variables: frame.bindings.map(preview),
  });
  const variables = session.variablePreviews();
  assert.deepEqual(variables, {
    globals: exported.globals.map(preview),
    frames: exported.frames.map(scope),
    retainedScopes: exported.retainedScopes.map(scope),
    liveMessages: exported.liveMessages,
  });
  assert.deepEqual(
    variables.liveMessages.map((message) => message.sourceText),
    ["Tick"],
  );
  assert.ok(variables.frames.some((frame) => frame.variables.some((v) => v.messageId !== null)));
  assert.equal(Reflect.set(variables.globals[0]!, "name", "changed"), false);

  assert.deepEqual(session.temporalPresentation(), AMSTERDAM.presentation);
  assert.deepEqual(session.view().cameraView, null);
  assert.deepEqual(session.view().queuedBlocks, 0);
});
