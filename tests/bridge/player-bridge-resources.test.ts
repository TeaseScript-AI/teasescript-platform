import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import { BridgeRequestError, connectBridge } from "../../player/engine-bridge/client.js";
import { admissionOf, heldMedia, isHeldMedia } from "../../player/engine-bridge/held-media.js";
import { heldRecording } from "../../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  observePlayerRuntimeTime,
  playerRuntimeSnapshot,
  type PlayerCaptureAnswer,
} from "../../player/runtime/runtime-adapter.js";
import {
  activePlayerRuntimeCapture,
  activePlayerRuntimeFileStore,
  activePlayerRuntimeLock,
  type PlayerSession,
} from "../../player/runtime/runtime-view.js";
import { CaptureService, type PlayerDiagnostic } from "../../player/media/session-camera.js";
import { CapturedMediaStore } from "../../player/media/captured-media.js";
import { FileStoreService } from "../../player/media/stored-files.js";
import type { ActionCompletionOutcome } from "../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { viewCalls, viewed, withoutViews } from "../helpers/debug-readers.js";
import { hatch, inProcessBridge } from "../helpers/in-process-bridge.js";
import { serviceSection } from "../helpers/service-section.js";
import { asMalformed, untypedBridge } from "../helpers/bridge/untyped.js";

/*
 * L5e's bridge (B-resource): the capture, file store and lock answers as ops, what the Player's store holds of their
 * references sent with them, and the services' sections, also at a Player error stop. The lock dialogs' secrets are
 * checked in `player-lock-service.test.ts`, where the dialogs run.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString(
  "base64",
);

/** One action of each answer: two photos, a stored file, its read and hash, and a text and a file locked and opened. */
const SCRIPT = [
  "let photo = takePhoto()",
  "let missing = takePhoto()",
  `let picture = fileFromBase64("${PNG}", default: "")`,
  "let back = fileToBase64(picture)",
  "let digest = hashFile(picture)",
  'let locked = encryptText("secret", password: "p", publicKey: false, timeLock: false)',
  'let opened = decryptText(locked, password: "p", default: "none")',
  'let lockedFile = encryptFile(picture, password: "p", publicKey: false, timeLock: false)',
  'let openedFile = decryptFile(lockedFile, password: "p", default: "")',
  "exit",
].join("\n");

/** Holds `script`'s plan in the bridge's host through `prepare`; returns its token. */
async function prepared(bridge: PlayerBridge, script: string): Promise<string> {
  const plan = compilePlayerProject(script).plan;
  assert.ok(plan);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

const shown = (session: PlayerSession) => ({
  revision: session.revision,
  state: session.state,
  events: [...session.events],
});

/** The complete state the in-process host holds for `session`. */
const hostSnapshot = (session: PlayerSession) => hatch(session, playerRuntimeSnapshot);

const refusedAs = (code: string) => (error: unknown) =>
  error instanceof BridgeRequestError && error.code === code;

/** What the Player's store holds in the tape: what the answers below hand the engine. */
const STORE = new Map([
  ["photo-1", "image"],
  ["file-1", "image"],
  ["file-2", "file"],
  ["file-3", "image"],
]);
const store = { holds: (reference: string, kind: string) => STORE.get(reference) === kind };

/** The answer the tape gives the active action, its op, and the references in that answer. */
function answerFor(state: PlayerSession["state"], photoHeld: boolean) {
  const capture = activePlayerRuntimeCapture(state);
  if (capture !== null) {
    const reference = photoHeld ? "photo-1" : "not held";
    const answer = { kind: "captured", reference };
    return { op: "answerCapture", actionId: capture.actionId, answer, refs: [reference] };
  }
  const file = activePlayerRuntimeFileStore(state);
  if (file !== null) {
    const answer =
      file.operation === "store"
        ? { kind: "stored", references: ["file-1"] }
        : file.operation === "read"
          ? { kind: "read", files: [PNG] }
          : { kind: "hashed", hashes: ["0".repeat(64)] };
    const refs = file.operation === "store" ? ["file-1"] : [];
    return { op: "answerFileStore", actionId: file.actionId, answer, refs };
  }
  const lock = activePlayerRuntimeLock(state);
  assert.ok(lock !== null, "an action the tape answers");
  const answer =
    lock.call === "encryptText"
      ? { kind: "locked", text: Buffer.from("a lock").toString("base64") }
      : lock.call === "decryptText"
        ? { kind: "opened", text: "secret" }
        : lock.call === "encryptFile"
          ? { kind: "locked", file: "file-2" }
          : { kind: "opened", file: "file-3", type: "image/png" };
  const refs = "file" in answer ? [answer.file] : [];
  return { op: "answerLock", actionId: lock.actionId, answer, refs };
}

/**
 * A tape of L5e's ops on one session: refusals without effect first, then each action answered, the second photo one
 * the store does not hold, with the capture service's fallback; each step's result and what the session shows after it.
 */
async function playTape(
  bridge: PlayerBridge,
  recording = false,
  calls = false,
): Promise<{ readonly steps: unknown[]; readonly session: PlayerSession }> {
  let session = await bridge.start(await prepared(bridge, SCRIPT), START, recording);
  if (calls) session = await viewCalls(bridge, session, true);
  const seen = (current: PlayerSession) => ({ ...shown(current), viewed: viewed(current) });
  const steps: unknown[] = [seen(session)];
  const capture = activePlayerRuntimeCapture(session.state)!;
  const valid = {
    actionId: capture.actionId,
    answer: { kind: "unavailable", reason: "denied" } as const,
  };
  const holed: unknown[] = [];
  holed[1] = { reference: "x", kind: "image" };
  // Malformed arguments are refused before the engine sees them.
  for (const args of [
    { ...valid, held: [{ reference: "x", kind: "picture" }] },
    { ...valid, held: [{ reference: "x", kind: "image", extra: 1 }] },
    { ...valid, held: holed },
    { ...valid, held: {} },
    { ...valid, actionId: 1.5, held: [] },
    { ...valid, actionId: -1, held: [] },
    { ...valid, answer: "unavailable", held: [] },
    // The adapter would make these an unavailable camera, so the bridge refuses them first.
    { ...valid, answer: { kind: "bogus", reason: "failed" }, held: [] },
    { ...valid, answer: { kind: "captured", reference: "photo-1", extra: 1 }, held: [] },
    { ...valid, held: [], more: 1 },
  ])
    await assert.rejects(
      bridge.request(session, "answerCapture", asMalformed(args)),
      refusedAs("arguments"),
    );
  // An answer of another action or of another kind is the engine's refusal, which changes nothing. The file store's
  // answer of a capture's kind is sent as it is on purpose.
  for (const [op, args] of [
    ["answerCapture", { ...valid, actionId: 999, held: [] }],
    ["answerFileStore", { ...valid, answer: { kind: "failed" }, held: [] }],
  ] as const) {
    const result = await untypedBridge(bridge).request(session, op, args);
    session = bridge.latest(session)!;
    steps.push({ op, result, session: seen(session) });
  }
  // A basis an op since replaced is refused without effect.
  await assert.rejects(
    bridge.request(session, "answerCapture", { ...valid, held: [] }, { basis: 0 }),
    refusedAs("basis"),
  );
  steps.push(seen(bridge.latest(session)!));
  let photos = 0;
  while (session.state.status === "waiting") {
    const photo = activePlayerRuntimeCapture(session.state) !== null;
    const next = answerFor(session.state, !photo || photos++ === 0);
    const held = heldMedia(store, next.refs);
    // EVIDENCE: test: `answerFor` picks at run time an answer op, which completes an action.
    const result = (await untypedBridge(bridge).request(session, next.op, {
      actionId: next.actionId,
      answer: next.answer,
      held,
    })) as ActionCompletionOutcome;
    session = bridge.latest(session)!;
    steps.push({ op: next.op, held, result, session: seen(session) });
    if (result.kind !== "invalidPayload") continue;
    // The capture service's fallback, which names no reference and has no admission.
    const fallback = await untypedBridge(bridge).request(session, next.op, {
      actionId: next.actionId,
      answer: { kind: "unavailable", reason: "failed" },
      held: null,
    });
    session = bridge.latest(session)!;
    steps.push({ op: next.op, result: fallback, session: seen(session) });
  }
  return { steps, session };
}

interface TapeStep {
  readonly result?: ActionCompletionOutcome;
  readonly session?: ReturnType<typeof shown>;
  readonly state?: PlayerSession["state"];
}

test("the capture, file store and lock ops (#1869) give the same replies, publications and events in-process and in a Worker", async () => {
  const inProcess = await inProcessBridge();
  const worker = new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
  try {
    const played = await playTape(inProcess);
    assert.deepEqual((await playTape(worker)).steps, played.steps);
    // With the call view (L5f) the critical view is the same, and the full view equal across the backends.
    const full = await playTape(await inProcessBridge(), false, true);
    assert.deepEqual((await playTape(worker, false, true)).steps, full.steps);
    assert.deepEqual(withoutViews(full.steps), withoutViews(played.steps));
    // EVIDENCE: fixture: `playTape`'s steps have these fields.
    const tape = played.steps as TapeStep[];
    const [start, unknown, wrongKind, afterRefusals, ...answers] = tape;
    assert.deepEqual(
      [unknown?.result?.kind, wrongKind?.result?.kind],
      ["unknownAction", "wrongActionKind"],
    );
    // The refusals changed nothing the session shows.
    assert.deepEqual(afterRefusals?.state, start?.state);
    assert.deepEqual(
      answers.map((step) => step.result?.kind),
      [
        "completed",
        "invalidPayload",
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
      ],
    );
    assert.equal(answers.at(-1)?.session?.state.status, "halted");
    const values = Object.fromEntries(
      hostSnapshot(played.session).frames[0]!.bindings.map((binding) => [
        binding.name,
        binding.value,
      ]),
    );
    assert.deepEqual(values, {
      photo: "photo-1",
      missing: null,
      picture: "file-1",
      back: PNG,
      digest: "0".repeat(64),
      locked: Buffer.from("a lock").toString("base64"),
      opened: "secret",
      lockedFile: "file-2",
      openedFile: "file-3",
    });
  } finally {
    worker.client.terminate();
  }
});

test("the recording holds exactly the store's answers about each answer's own references", async () => {
  const bridge = await inProcessBridge();
  await playTape(bridge, true);
  const queries = heldRecording(bridge)!
    .operations.filter((operation) => operation.kind === "completeAction")
    .map((operation) => operation.admissionQueries);
  // In order: the engine asks only about the references in each answer, with the kind its action stores. The photo
  // the store does not hold is asked about and refused; its fallback and the answers without references ask nothing.
  assert.deepEqual(queries.slice(-10), [
    [{ reference: "photo-1", kind: "image", result: true }],
    [{ reference: "not held", kind: "image", result: false }],
    [],
    [{ reference: "file-1", kind: "image", result: true }],
    [],
    [],
    [],
    [],
    [{ reference: "file-2", kind: "file", result: true }],
    [{ reference: "file-3", kind: "image", result: true }],
  ]);
});

test("an answer without the store's table is not vouched for, with the recording on and off", async () => {
  for (const recording of [false, true]) {
    const bridge = await inProcessBridge();
    const session = await bridge.start(
      await prepared(bridge, "let photo = takePhoto()\nexit"),
      START,
      recording,
    );
    const { actionId } = activePlayerRuntimeCapture(session.state)!;
    const outcome = await bridge.request(session, "answerCapture", {
      actionId,
      answer: { kind: "captured", reference: "photo-1" },
      held: null,
    });
    assert.equal(outcome.kind, "invalidPayload", `recording ${recording}`);
    if (recording) assert.deepEqual(heldRecording(bridge)!.operations.at(-1)?.admissionQueries, []);
  }
});

test("the store's table answers only what it lists, of the kind it lists", () => {
  const table = heldMedia(store, ["photo-1", "file-2", "not held"]);
  assert.deepEqual(table, [
    { reference: "photo-1", kind: "image" },
    { reference: "file-2", kind: "file" },
  ]);
  assert.ok(isHeldMedia(table));
  const admission = admissionOf(table);
  assert.deepEqual(
    [
      admission.holds("photo-1", "image"),
      admission.holds("photo-1", "file"),
      admission.holds("not held", "image"),
      admission.holds("elsewhere", "image"),
    ],
    [true, false, false, false],
  );
});

test("a lock dialog that an expiry block interrupts refuses its answer, which changes nothing", async () => {
  const bridge = await inProcessBridge();
  let session = await bridge.start(
    await prepared(
      bridge,
      'timer async 1 s { say "Time is up", instant\n wait 2 s }\nlet locked = encryptText("x")\nexit',
    ),
    START,
    false,
  );
  const ask = activePlayerRuntimeLock(session.state)!;
  assert.equal(ask.phase, "ask");
  await bridge.request(session, "observeTime", { atMs: 1_500, media: [] });
  session = bridge.latest(session)!;
  const outcome = await bridge.request(session, "answerLock", {
    actionId: ask.actionId,
    answer: { kind: "submitted" },
    held: [],
  });
  assert.equal(outcome.kind, "suspendedAction");
  assert.deepEqual(bridge.latest(session)!.state, session.state);
});

/** A capture service over `bridge`, as `usePlayerSession` makes one, logging the requests its sections post. */
function captureHarness(
  bridge: PlayerBridge,
  answer: () => Promise<PlayerCaptureAnswer>,
  onSend: (op: string, args: unknown) => void = () => {},
) {
  const state: { session: PlayerSession | null; generation: number } = {
    session: null,
    generation: 0,
  };
  const sent: string[] = [];
  const diagnostics: PlayerDiagnostic[] = [];
  const held = new Set<string>();
  const discarded: string[] = [];
  const service = new CaptureService(answer, {
    session: () => state.session,
    generation: () => state.generation,
    section: serviceSection(
      bridge,
      () => state.session,
      (next) => (state.session = next),
      (op, args) => {
        sent.push(op);
        onSend(op, args);
      },
    ),
    capturedMedia: {
      holds: (reference, kind) => kind === "image" && held.has(reference),
      // The answers here name media no store made; what the service lets go of is only recorded.
      discard: (reference) => void discarded.push(reference),
    },
    diagnostic: (diagnostic) => diagnostics.push(diagnostic),
    later: (task) => setImmediate(task),
  });
  const start = async (source: string) => {
    state.generation++;
    state.session = await bridge.start(await prepared(bridge, source), START, true);
  };
  /**
   * The Player error stop, as `usePlayerSession` makes it: once the store froze, at once in-process, the stop commits and
   * the services forget their work in the same tick.
   */
  const stop = async () => {
    const halting = bridge.halt(state.session!);
    if (!bridge.frozen(state.session!)) await halting;
    service.reset();
  };
  return { state, sent, diagnostics, held, discarded, service, start, stop };
}

const turns = async (count: number) => {
  for (let turn = 0; turn < count; turn++) await new Promise((resolve) => setTimeout(resolve, 5));
};
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; !done(); turn++) {
    assert.ok(turn < 400, "timed out");
    await turns(1);
  }
}
const PHOTO = "let photo = takePhoto()\nshowImage photo\nexit";

for (const delayMs of [0, 50, 250])
  test(`the capture and file store services answer once when replies come ${delayMs} ms late`, async () => {
    const bridge = await inProcessBridge(delayMs);
    let photos = 0;
    const camera = captureHarness(bridge, async () => {
      photos++;
      return { kind: "captured", reference: "photo-1" };
    });
    camera.held.add("photo-1");
    await camera.start(PHOTO);
    camera.service.request();
    await until(() => camera.state.session?.state.status === "halted");
    camera.service.stop();
    assert.equal(photos, 1);
    assert.equal(hostSnapshot(camera.state.session!).stageImage, "photo-1");

    let current: PlayerSession | null = await bridge.start(
      await prepared(bridge, `let picture = fileFromBase64("${PNG}", default: "")\nexit`),
      START,
      false,
    );
    const media = new CapturedMediaStore(
      null,
      { create: () => "blob:", revoke: () => {} },
      "files",
    );
    const files = new FileStoreService({
      session: () => current,
      generation: () => 1,
      section: serviceSection(
        bridge,
        () => current,
        (next) => (current = next),
      ),
      media,
      diagnostic: (diagnostic) => assert.fail(diagnostic.message),
      later: (task) => setImmediate(task),
    });
    files.request();
    await until(() => current?.state.status === "halted");
    files.stop();
    assert.equal(media.size, 1, "the file was stored once");
    const picture = hostSnapshot(current!).frames[0]!.bindings.find(
      (binding) => binding.name === "picture",
    )?.value;
    assert.ok(typeof picture === "string" && media.holds(picture, "image"));
  });

// A reply in transit is what these cases need, not any particular delay.
test("a Player error stop during the observation's round trip sends no answer", async () => {
  const bridge = await inProcessBridge(50);
  let deliver: (answer: PlayerCaptureAnswer) => void = () => {};
  const camera = captureHarness(
    bridge,
    () => new Promise((resolve) => (deliver = resolve)),
    (op) => {
      // The stop comes while the observation's reply is in transit.
      if (op === "observeTime") queueMicrotask(() => void camera.stop());
    },
  );
  camera.held.add("photo-1");
  await camera.start(PHOTO);
  camera.service.request();
  await turns(2);
  deliver({ kind: "captured", reference: "photo-1" });
  await until(() => bridge.frozen(camera.state.session!));
  await turns(20);
  camera.service.stop();
  assert.deepEqual(camera.sent, ["observeTime"]);
  assert.equal(hostSnapshot(camera.state.session!).foregroundAction?.kind, "capture");
});

for (const which of ["answer", "fallback"] as const)
  test(`${which === "answer" ? "an answer" : "a fallback"} queued behind a prepare when the Player stops is refused and never runs`, async () => {
    const bridge = await inProcessBridge();
    let queued: Promise<unknown> | null = null;
    const camera = captureHarness(
      bridge,
      async () => ({ kind: "captured", reference: which === "answer" ? "photo-1" : "not held" }),
      (op, args) => {
        // EVIDENCE: fixture: an answer op's arguments, whose `held` is null only for the fallback.
        const fallback = (args as { readonly held?: unknown }).held === null;
        if (op !== "answerCapture" || fallback !== (which === "fallback")) return;
        // An async prepare occupies the host's queue, so this request waits there; then the Player stops.
        queued = bridge.client.request("prepare", {
          source: { kind: "source", script: 'say "x"\nexit' },
        });
        queueMicrotask(() => void camera.stop());
      },
    );
    camera.held.add("photo-1");
    await camera.start(PHOTO);
    camera.service.request();
    await until(() => queued !== null);
    await queued;
    await turns(10);
    camera.service.stop();
    assert.equal(hostSnapshot(camera.state.session!).foregroundAction?.kind, "capture");
    // The queued request is not in the recording; in the fallback case, the refused answer before it is.
    const recorded = heldRecording(bridge)!.operations.filter(
      (operation) => operation.kind === "completeAction",
    );
    assert.deepEqual(
      recorded.map((operation) => operation.outcome),
      which === "answer" ? [] : ["invalidPayload"],
    );
    assert.deepEqual(
      camera.diagnostics.map((diagnostic) => diagnostic.code),
      which === "answer" ? [] : ["capture-rejected"],
    );
  });

for (const held of [true, false])
  test(`an answer ${held ? "that completes" : "the engine refuses"} whose reply is in transit at a stop shows, and nothing follows it`, async () => {
    const bridge = await inProcessBridge(50);
    const camera = captureHarness(
      bridge,
      async () => ({ kind: "captured", reference: held ? "photo-1" : "not held" }),
      (op) => {
        if (op === "answerCapture") queueMicrotask(() => void camera.stop());
      },
    );
    camera.held.add("photo-1");
    await camera.start(PHOTO);
    camera.service.request();
    await until(
      () => camera.sent.includes("answerCapture") && bridge.frozen(camera.state.session!),
    );
    await turns(20);
    camera.service.stop();
    // What the host ran shows, the photo or the refusal, which changed nothing; no diagnostic and no fallback follow.
    assert.deepEqual(camera.sent, ["observeTime", "answerCapture"]);
    assert.deepEqual(camera.diagnostics, []);
    assert.equal(camera.state.session!.state.status, held ? "halted" : "waiting");
    assert.equal(camera.state.session!.revision, bridge.latest(camera.state.session!)!.revision);
  });

test("an answer whose basis a hatch call replaced is offered again, and the photo is taken once", async () => {
  const bridge = await inProcessBridge();
  let photos = 0;
  let moved = false;
  const camera = captureHarness(
    bridge,
    async () => {
      photos++;
      return { kind: "captured", reference: "photo-1" };
    },
    (op) => {
      // A family not yet converted runs an op through the facade between the observation and the answer.
      if (op !== "answerCapture" || moved) return;
      moved = true;
      hatch(camera.state.session!, (current) =>
        observePlayerRuntimeTime(current, current.state.observedSessionTimeMs + 1_000, []),
      );
    },
  );
  camera.held.add("photo-1");
  await camera.start(PHOTO);
  camera.service.request();
  await until(() => camera.state.session?.state.status === "halted");
  camera.service.stop();
  assert.equal(photos, 1);
  assert.deepEqual(camera.sent, ["observeTime", "answerCapture", "observeTime", "answerCapture"]);
  assert.equal(hostSnapshot(camera.state.session!).stageImage, "photo-1");
});

for (const during of ["observeTime", "answerFileStore"] as const)
  test(`a file store reset while its ${during === "observeTime" ? "observation" : "refused answer"} is in transit sends and reports nothing more`, async () => {
    const bridge = await inProcessBridge(50);
    let current: PlayerSession | null = await bridge.start(
      await prepared(bridge, `let picture = fileFromBase64("${PNG}", default: "")\nexit`),
      START,
      false,
    );
    const sent: string[] = [];
    const diagnostics: PlayerDiagnostic[] = [];
    // Once reset, as at a Player error stop, the service is offered no session to service again.
    let reset = false;
    // The store keeps the file but does not vouch for it, so the answer is refused.
    const media = new CapturedMediaStore(
      null,
      { create: () => "blob:", revoke: () => {} },
      "files",
    );
    media.holds = () => false;
    const files: FileStoreService = new FileStoreService({
      session: () => (reset ? null : current),
      generation: () => 1,
      section: serviceSection(
        bridge,
        () => current,
        (next) => (current = next),
        (op) => {
          sent.push(op);
          // A reset without a new generation, as the Player error stop makes it.
          if (op === during)
            queueMicrotask(() => {
              reset = true;
              files.reset();
            });
        },
      ),
      media,
      diagnostic: (diagnostic) => diagnostics.push(diagnostic),
      later: (task) => setImmediate(task),
    });
    files.request();
    await until(() => sent.includes(during));
    await turns(20);
    files.stop();
    // No answer after a reset observation, and no diagnostic or fallback after a reset refusal.
    assert.deepEqual(
      sent,
      during === "observeTime" ? ["observeTime"] : ["observeTime", "answerFileStore"],
    );
    assert.deepEqual(diagnostics, []);
  });
