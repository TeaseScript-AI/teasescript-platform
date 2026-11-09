import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeClient, SectionSend } from "../../player/engine-bridge/client.js";
import type { OpArgs, OpCall } from "../../player/engine-bridge/op-catalogue.js";
import type { CheckpointCapture } from "../../player/engine-bridge/ops/persistence.js";
import type { ReadCall, ReadOps } from "../../player/engine-bridge/session-protocol.js";
import type { PlanMetadata } from "../../player/engine-bridge/plan-facts.js";
import type {
  PlayerBridge,
  ServiceSection,
  SessionSection,
} from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import type {
  AnswerCall,
  InputOutcome,
  InputSection,
} from "../../player/vue/src/session/runtime-input.js";
import type { TemporalContext, TimeObservationOutcome } from "../../src/playback.js";

/*
 * The bridge's senders, typed by the op catalogue (`op-catalogue.ts`): each `@ts-expect-error` row is a call the types
 * refuse, and the call before it, the same with that one defect removed, compiles, so the error expected is the row's
 * own. The rows never run: type-checking this file is the test, under each compiler the repository runs.
 */
export async function senderRows(
  client: BridgeClient,
  send: SectionSend,
  bridge: PlayerBridge,
  session: PlayerSession,
  section: SessionSection,
  service: ServiceSection,
  input: InputSection,
  temporal: TemporalContext,
  rewind: OpCall<"rewindBack" | "rewindForward">,
  rewindOp: "rewindBack" | "rewindForward",
  forward: OpArgs<"rewindForward">,
  time: OpCall<"observeTime" | "stepTime">,
  timeOp: "observeTime" | "stepTime",
  step: OpArgs<"stepTime">,
  readCall: ReadCall<"debugView" | "captureCheckpoint">,
  readOp: "debugView" | "captureCheckpoint",
  view: ReadOps["debugView"]["args"],
  answerOp: "submitComposer" | "selectChoice",
): Promise<void> {
  const observed = { atMs: 0, media: [] };

  // The client (`BridgeClient.request`): unknown op, wrong arguments, an unrelated result, the old result parameter.
  const metadata: PlanMetadata | null = (await client.request("planMetadata", { plan: "p1" }))
    .result;
  // @ts-expect-error -- no op of that name.
  await client.request("noSuchOp", { plan: "p1" });
  // @ts-expect-error -- `plan` is a string.
  await client.request("planMetadata", { plan: 1 });
  // @ts-expect-error -- `planMetadata` gives its plan's metadata, no number.
  const unrelated: number = (await client.request("planMetadata", { plan: "p1" })).result;
  await client.request<"planMetadata">("planMetadata", { plan: "p1" });
  // @ts-expect-error -- the type argument is the op, not a result the caller chooses.
  await client.request<PlanMetadata>("planMetadata", { plan: "p1" });
  // A correlated union of calls; an op of the union with another op's arguments.
  await client.request(...rewind);
  // @ts-expect-error -- `rewindBack` takes more than `rewindForward`'s arguments.
  await client.request(rewindOp, forward);

  // `BridgeClient.signal` sends `halt` alone.
  await client.signal("halt", null, "s1");
  // @ts-expect-error -- `release` is a request.
  await client.signal("release", null, "s1");

  // A client section's send (`SectionSend`).
  const sent: TimeObservationOutcome = (await send("observeTime", observed, 0)).result;
  // @ts-expect-error -- no op of that name.
  await send("noSuchOp", observed, 0);
  // @ts-expect-error -- `observeTime` gives a time observation's outcome, no number.
  const sentNumber: number = (await send("observeTime", observed, 0)).result;
  await send(...rewind, 0);
  // @ts-expect-error -- uncorrelated.
  await send(rewindOp, forward, 0);

  // `PlayerBridge.request`, of a session's ops.
  const outcome: TimeObservationOutcome = await bridge.request(session, "observeTime", observed);
  // @ts-expect-error -- no op of that name.
  await bridge.request(session, "noSuchOp", observed);
  // @ts-expect-error -- `planMetadata` is an op of no session.
  await bridge.request(session, "planMetadata", { plan: "p1" });
  // @ts-expect-error -- `observeTime` gives a time observation's outcome, no number.
  const outcomeNumber: number = await bridge.request(session, "observeTime", observed);
  await bridge.request<"observeTime">(session, "observeTime", observed);
  // @ts-expect-error -- the type argument is the op, not a result the caller chooses.
  await bridge.request<TimeObservationOutcome>(session, "observeTime", observed);
  await bridge.request(session, ...time);
  // @ts-expect-error -- `observeTime` takes no `stepTime` arguments.
  await bridge.request(session, timeOp, step);

  // `PlayerBridge.read`, of ops of no session that read one.
  const checkpoint: CheckpointCapture = await bridge.read(session, "captureCheckpoint");
  // @ts-expect-error -- `observeTime` is a session's op, no read.
  await bridge.read(session, "observeTime", observed);
  // @ts-expect-error -- a checkpoint's capture, no number.
  const checkpointNumber: number = await bridge.read(session, "captureCheckpoint");

  // `PlayerBridge.historyStep`.
  await bridge.historyStep(...rewind);
  // @ts-expect-error -- uncorrelated.
  await bridge.historyStep(rewindOp, forward);

  // A session's section (`SessionSection.send`).
  const sectionOutcome: TimeObservationOutcome = await section.send("observeTime", observed);
  // @ts-expect-error -- no op of that name.
  await section.send("noSuchOp", observed);
  // @ts-expect-error -- the type argument is the op, not a result the caller chooses.
  await section.send<TimeObservationOutcome>("observeTime", observed);
  await section.send(...time);
  // @ts-expect-error -- uncorrelated.
  await section.send(timeOp, step);

  // A service's section (`ServiceSection.send`).
  const serviced: TimeObservationOutcome = await service.send("observeTime", observed, 0);
  // @ts-expect-error -- no op of that name.
  await service.send("noSuchOp", observed, 0);
  // @ts-expect-error -- `observeTime` gives a time observation's outcome, no number.
  const servicedNumber: number = await service.send("observeTime", observed, 0);
  // @ts-expect-error -- the type argument is the op, not a result the caller chooses.
  await service.send<TimeObservationOutcome>("observeTime", observed, 0);
  await service.send(...time, 0);
  // @ts-expect-error -- uncorrelated.
  await service.send(timeOp, step, 0);

  // An input section (`InputSection.send`).
  await input.send("observeTime", observed);
  // @ts-expect-error -- no op of that name.
  await input.send("noSuchOp", observed);
  // @ts-expect-error -- the type argument is the op, not a result the caller chooses.
  await input.send<TimeObservationOutcome>("observeTime", observed);
  await input.send(...time);
  // @ts-expect-error -- uncorrelated.
  await input.send(timeOp, step);

  // The ops whose check admits a payload only in shape, which the engine validates: a caller sends the precise one.
  const edit = { key: "k", value: 3 } as const;
  const editBogus = { key: "k", value: { kind: "bogus" } } as const;
  await bridge.request(session, "applyStorageEdit", edit);
  // @ts-expect-error -- no `SerializableRuntimeValue`.
  await bridge.request(session, "applyStorageEdit", editBogus);
  const stored = { actionId: 1, answer: { kind: "failed" }, held: null } as const;
  const storedBogus = { actionId: 1, answer: { kind: "bogus" }, held: null } as const;
  await bridge.request(session, "answerFileStore", stored);
  // @ts-expect-error -- no `PlayerFileStoreAnswer`.
  await bridge.request(session, "answerFileStore", storedBogus);
  const locked = { actionId: 1, answer: { kind: "notOpened" }, held: null } as const;
  const lockedBogus = { actionId: 1, answer: { kind: "bogus" }, held: null } as const;
  await bridge.request(session, "answerLock", locked);
  // @ts-expect-error -- no `PlayerLockAnswer`.
  await bridge.request(session, "answerLock", lockedBogus);
  const report = { mediaId: 1, report: { kind: "failed" } } as const;
  const reportBogus = { mediaId: 1, report: { kind: "bogus" } } as const;
  await bridge.request(session, "reportMediaLoad", report);
  // @ts-expect-error -- no `MediaLoadReport`.
  await bridge.request(session, "reportMediaLoad", reportBogus);
  const capture = { capture: { wallClockMs: 0, temporalContext: temporal } } as const;
  const captureBogus = { capture: { wallClockMs: 0, temporalContext: {} } } as const;
  await bridge.request(session, "continue", capture);
  // @ts-expect-error -- no `TemporalContext`.
  await bridge.request(session, "continue", captureBogus);
  const camera = {
    actionId: 1,
    answer: { kind: "unavailable", reason: "denied" },
    held: null,
  } as const;
  const cameraBogus = {
    actionId: 1,
    answer: { kind: "unavailable", reason: "bogus" },
    held: null,
  } as const;
  await bridge.request(session, "answerCapture", camera);
  // @ts-expect-error -- no `CaptureUnavailableReason`.
  await bridge.request(session, "answerCapture", cameraBogus);

  // `read`, a projection without `session`: each op with its own arguments, a union only as a correlated call.
  await bridge.read(session, "captureCheckpoint");
  await bridge.read(session, "debugView", view);
  await bridge.read(session, ...readCall);
  // @ts-expect-error -- an op of the union with arguments of neither.
  await bridge.read(session, readOp, {});

  // `answer`'s call (`AnswerCall`), a projection without `actionId`: `args` and `input` where the op requires them, and
  // an op paired with its own.
  const composer: AnswerCall<"submitComposer"> = ["submitComposer", () => ({ text: "x" }), null];
  // @ts-expect-error -- `submitComposer` requires `input`.
  const composerWithoutInput: AnswerCall<"submitComposer"> = [
    "submitComposer",
    () => ({ text: "x" }),
  ];
  // @ts-expect-error -- `submitComposer` requires `args`.
  const composerWithoutArgs: AnswerCall<"submitComposer"> = ["submitComposer", undefined, null];
  const choice: AnswerCall<"submitComposer" | "selectChoice"> = [
    "selectChoice",
    () => ({ optionId: "o" }),
    null,
  ];
  // @ts-expect-error -- an op of the union with the arguments of one of them.
  const unpaired: AnswerCall<"submitComposer" | "selectChoice"> = [
    answerOp,
    () => ({ text: "x" }),
    null,
  ];
  const dismiss: AnswerCall<"dismissFormField"> = ["dismissFormField"];

  // `InputOutcome` is the catalogue's input result: an input op's outcome assigns (the control), another does not.
  const stale: InputOutcome = { kind: "staleAction", actionId: 1 };
  // @ts-expect-error -- no input op's outcome.
  const foreign: InputOutcome = { kind: "notAnOutcome" };

  void [metadata, unrelated, sent, sentNumber, outcome, outcomeNumber, checkpoint, stale, foreign];
  void [composer, composerWithoutInput, composerWithoutArgs, choice, unpaired, dismiss];
  void [checkpointNumber, sectionOutcome, serviced, servicedNumber];
}

test("the senders' type rows type-check: each refused row is refused, and its control compiles", () => {
  assert.equal(typeof senderRows, "function");
});
