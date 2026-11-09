import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { before, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { registerActivationWorkChecks } from "../helpers/player/activation-work-checks.js";

/*
 * L5i.5, R3: the census of session work (`tools/session-work-census.mjs`). The tool derives the sending boundary from
 * the code and walks references back from it; this file holds what the walk finds, classified at each entry point by
 * what the session must have observed before its work (orchestrator 2's rulings on plan r3). Forwarders stay
 * unclassified: a forwarder reached from two entry points carries each one's policy. An entry point, escape or
 * boundary member the tables do not hold fails, and so does a row nothing matches.
 *
 * What it claims: the entry points the clock's literal oracle drives (`player-clock-work.test.ts`, the five `ClockWork`
 * rows' entry points and development time's skip and auto-skip) are found and classified. Sections are not walked
 * (#1983). The type decides one thing: a sender passes a `ClockTicket` to either section API; leaving it out fails
 * type-checking in `.ts` and in an SFC. It does not decide where the ticket came from. Code outside the clock gets one
 * in two ways, both deliberately written: by a construct that switches the check off (a cast; `any`, including
 * `JSON.parse`'s; a non-null assertion; a type guard or assertion function; an overload; an ambient declaration; a
 * suppression directive), or by keeping the ticket the clock passes to a `BridgeClient` it implements or wraps (Sol
 * code r1 B1, job 11081923449b44). The ticket guards against a sender that forgets the clock, not against code written
 * to bypass it. The type-assertion `EVIDENCE:` rule sees only `as` and `<T>` casts (#2042).
 * Requests, signals and facade sends are walked in the `.ts` files under `player/`; a `.vue` caller through a
 * session's `connection` is outside the walk (#2041).
 */

interface Found {
  readonly file: string;
  readonly path: string;
  readonly kind?: string;
  readonly origins: readonly string[];
}
interface Walk {
  readonly boundary: {
    readonly interfaces: Readonly<Record<string, readonly string[]>>;
    readonly exports: Readonly<Record<string, readonly string[]>>;
  };
  readonly forwarders: readonly Found[];
  readonly entries: readonly Found[];
  readonly escapes: readonly Found[];
}
interface Use {
  readonly target: string;
  readonly file: string;
  readonly path: string;
  readonly use: string;
}
interface Surface {
  readonly file: string;
  readonly name: string;
  readonly member?: string;
}
interface Census {
  setOverrides(next: Readonly<Record<string, string>>): void;
  run(surfaces: readonly Surface[], options?: { readonly within?: string }): Walk;
  uses(targets: readonly { readonly file: string; readonly path: string }[]): readonly Use[];
  program(): { readonly program: unknown; readonly root: string };
}

let census: Census;
before(async () => {
  const tool = await import(
    pathToFileURL(resolve(process.cwd(), "tools/session-work-census.mjs")).href
  );
  assert.equal(typeof tool.createSessionWorkCensus, "function");
  // EVIDENCE: validation: the census module's export, checked callable above; `Census` is its documented API.
  census = (tool.createSessionWorkCensus as (root: string) => Census)(process.cwd());
});
// Session split S2's checks of activation work, over this census's program (`tests/helpers/player/activation-work-checks.ts`).
registerActivationWorkChecks(() => census);

const CLIENT = "player/engine-bridge/client.ts";
const FACADE = "player/engine-bridge/in-process.ts";
const SESSION = "player/vue/src/session/usePlayerSession.ts";
const CLOCK = "player/vue/src/session/useRuntimeSceneClock.ts";

/** Every public member of `BridgeClient`: what sends to the host unguarded, what takes the clock's ticket, and what does not send. */
const CLIENT_MEMBERS = {
  sending: ["request", "signal"],
  // A section takes a `ClockTicket`: leaving it out fails type-checking, so the walk does not follow it (#1983).
  // Where a ticket came from it does not decide: a check-disabling construct, or one a `BridgeClient` wrapper kept.
  ticketed: ["section"],
  // The Worker's end and its loss listener send no session work.
  nonSending: ["terminate", "onLoss"],
} as const;
/** Every function the in-process facade exports: the session functions, and what does not send. */
const FACADE_EXPORTS = {
  sending: ["hatch", "introduceNow", "beginRecordingNow"],
  // The backend's creation, and reads of the connection's state (plans, recording, runs, trace, random), with no session.
  nonSending: [
    "createInProcessBackend",
    "heldRandom",
    "heldTrace",
    "heldPlan",
    "heldRecording",
    "heldRuns",
    "heldTickets",
  ],
} as const;

const SURFACES: readonly Surface[] = [
  ...CLIENT_MEMBERS.sending.map((member) => ({ file: CLIENT, name: "BridgeClient", member })),
  ...FACADE_EXPORTS.sending.map((name) => ({ file: FACADE, name })),
];

/**
 * What the session must have observed before an entry point's work: a `CLOCK_WORK` row it posts through
 * `clock.before`; its own observation (an input or service section's, development time's); none, as today; a read
 * with no time dependency; lifecycle or control; creation, outside an existing session's clock (rebased when shown);
 * resume or rebase; the clock's own scheduling; the bridge's internals; or composition only.
 */
type Policy =
  | "clock: debugMode"
  | "clock: randomControl"
  | "clock: keepCapture"
  | "clock: pageHide"
  | "clock: audioEnded"
  | "own observation"
  | "none"
  | "read"
  | "lifecycle"
  | "creation"
  | "resume"
  | "clock scheduling"
  | "bridge plumbing"
  | "composition";

/** Each entry point of the work census, by file and place: its policy, and the surfaces it reaches. */
const ENTRIES: Readonly<Record<string, readonly [Policy, readonly string[]]>> = {
  "player/vue/src/session/rewindOwner.ts createRewindOwner > apply > finally:callback#2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > back > step:callback": [
    "resume",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > close > then:callback#1.1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > close > then:callback#1.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > enroll > DebugHistoryView:callback": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > enroll > DebugHistoryView:callback > catch:callback":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > forward > step:callback": [
    "resume",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > gate > then:callback.1": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > gate > then:callback.2": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > apply > then:callback#1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > open > function": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > retryReturn": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > reportUnless > function": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > tryOnScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > clearScriptStorage": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > showSession": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/useSessionRewind.ts useSessionRewind > followSessions > watch:callback#1":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/useSessionRewind.ts useSessionRewind > followSessions > tryOnScopeDispose:callback":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/persistence/useSavedDataTransfer.ts useSavedDataTransfer > importSavedData > owned:callback > commit:callback#2":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > importSession > owned:callback > replaceSession > admit:callback#1":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > importSession > owned:callback > replaceSession > admit:callback#2":
    ["creation", ["BridgeClient.request"]],
  // A session read for an import, released by the dialog that no longer imports it; a transfer's own, like its read.
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > discardSessionReview": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > readTransfer": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > reviewSessionImport": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/encryption/lock-service.ts LockService > request > later:callback": [
    "own observation",
    ["BridgeClient.request"],
  ],
  "player/media/media-device.ts MediaDevice > #create > listen:callback#4": [
    "clock: audioEnded",
    ["BridgeClient.request"],
  ],
  "player/runtime/player-bridge.ts PlayerBridge > #collected > FinalizationRegistry:callback": [
    "lifecycle",
    ["BridgeClient.request"],
  ],
  "player/runtime/player-bridge.ts PlayerBridge > request > #send:callback": [
    "bridge plumbing",
    ["BridgeClient.request"],
  ],
  "player/runtime/player-bridge.ts PlayerBridge > viewCalls > #send:callback": [
    "bridge plumbing",
    ["BridgeClient.request"],
  ],
  "player/media/session-camera.ts CaptureService > request > later:callback": [
    "own observation",
    ["BridgeClient.request"],
  ],
  "player/media/stored-files.ts FileStoreService > request > later:callback": [
    "own observation",
    ["BridgeClient.request"],
  ],
  "player/vue/src/hostedScript.ts prepareHostedScript > then:callback": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/hostedScript.ts prepareHostedScript > then:callback > catch:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/main.ts setup": [
    "composition",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/session/useCallView.ts useCallView > demandCallView > release": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/useCallView.ts useCallView > tryOnScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/useCallView.ts useCallView > viewCalls > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices > watch:callback#1":
    ["own observation", ["BridgeClient.request"]],
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices > watch:callback#2":
    ["own observation", ["BridgeClient.request"]],
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices > watch:callback#3":
    ["own observation", ["BridgeClient.request"]],
  "player/vue/src/stage/stagePhotos.ts usePlanPhotoPreload": ["read", ["BridgeClient.request"]],
  "player/vue/src/stage/stagePhotos.ts usePlanPhotoPreload > watch:callback": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/debug/history/useDebugExport.ts useDebugExport": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/debug/history/useDebugExport.ts useDebugExport > watch:callback#1": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > resolveLeastTried": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > tryOnScopeDispose:callback": [
    "clock: randomControl",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > watch:callback#1": [
    "clock: randomControl",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > watch:callback#2": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > watch:callback#3": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > watch:callback#4": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > watch:callback#5": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > back": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > forward": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > resume": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > returnToSession": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > then:callback.1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/useDebugView.ts useDebugView": [
    "read",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/useDebugView.ts useDebugView > watch:callback.2": [
    "read",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > advanceBy": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > skip": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > watch:callback#2 > setTimeout:callback":
    ["own observation", ["BridgeClient.request"]],
  "player/vue/src/debug/usePlayerDebug.ts usePlayerDebug": [
    "composition",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/debug/usePlayerDebug.ts usePlayerDebug > explain": [
    "read",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/usePlayerDebug.ts usePlayerDebug > tryOnScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/usePlayerDebug.ts usePlayerDebug > watch:callback#3.2": [
    "clock: debugMode",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/debug/usePlayerDebug.ts usePlayerDebug > watch:callback#3.2 > run:callback": [
    "composition",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/useSessionMedia.ts useSessionMedia > MediaLoadQueue:callback.1": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/activation/work/debugMode.ts completeDebugMode > then:callback.1": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/activation/work/debugMode.ts completeDebugMode > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > copyToDebugRoom > then:callback": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > debugView > then:callback.2":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  // Debug's demand of the call view, through `useCallView`'s returned function the composable exposes: a control.
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > demandCallView": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > editSavedData": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/persistence/useSavedValues.ts useSavedValues > editSavedData > then:callback#1":
    ["none", ["BridgeClient.request"]],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > exportSession": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > flushTracing > then:callback.2":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > importSavedData": [
    "none",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > importSession": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > importSession > owned:callback":
    ["creation", ["BridgeClient.request", "BridgeClient.signal", "introduceNow"]],
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > importSession > owned:callback > replaceSession > commit:callback#4":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > keepIn > admit:callback": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > keepOnce > owned:callback":
    ["none", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > keepSessionLater > function":
    ["none", ["BridgeClient.request"]],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > lock > cancel": [
    "own observation",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > lock > submit": [
    "own observation",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > section > section:callback":
    ["own observation", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > prepareKept > owned:callback":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > prepareKept > owned:callback > commit:callback#1":
    ["creation", ["BridgeClient.request", "BridgeClient.signal", "introduceNow"]],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > prepareKept > owned:callback > commit:callback#2":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/activation/work/continue.ts continueRestored > catch:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > pressPermanentButton": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/activation/work/stop.ts stopLateStart > then:callback.1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/activation/work/draw.ts resolveDrawFor > catch:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > restoreKept > admit:callback":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > rooms > reloadDebug": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > rooms > resetDebug": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/session/useRandomControl.ts useRandomControl > flushRandom > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  // The adoption's own reaction, which settles its reply through the record's `settle`: its success writes the
  // history's revision, and only a handler's failure reaches the error stop; its failure is the error stop.
  "player/vue/src/session/activation/work/adopt.ts adopt > then:callback.1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/activation/work/adopt.ts adopt > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > startDebugSessionAnew > then:callback":
    ["creation", ["BridgeClient.request", "BridgeClient.signal", "introduceNow"]],
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > startFrom > then:callback#1":
    ["creation", ["BridgeClient.request", "BridgeClient.signal", "introduceNow"]],
  // The begin's own reaction, which settles it through the record's `settle`: its success is the creation, its
  // failure the error stop, as at the base.
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > startFrom > then:callback#2.1":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > startFrom > then:callback#2.2":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > then:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > toStartPage": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > tryOnScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > startKeeping > useEventListener:callback.2":
    ["clock: keepCapture", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > startKeeping > watch:callback":
    ["none", ["BridgeClient.request"]],
  "player/vue/src/session/useSessionMedia.ts useSessionMedia > watchMedia > watch:callback#3": [
    "own observation",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/persistence/useSavedValues.ts useSavedValues > watchWrites > watch:callback#1 > then:callback.1":
    ["none", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useSavedValues.ts useSavedValues > watchWrites > watch:callback#1 > then:callback.2":
    ["none", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useSavedValues.ts useSavedValues > watchWrites > watch:callback#1 > yieldThenReport > setTimeout:callback":
    ["none", ["BridgeClient.request"]],
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > catchUp > function": [
    "clock scheduling",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation > observing:callback":
    ["clock scheduling", ["BridgeClient.request"]],
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > step > inNextTask:callback":
    ["clock scheduling", ["BridgeClient.request"]],
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > useEventListener:callback#1":
    ["clock scheduling", ["BridgeClient.request"]],
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > useEventListener:callback#2":
    ["clock: pageHide", ["BridgeClient.request"]],
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > watch:callback#1": [
    "clock scheduling",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/activation/useFailureRecording.ts useFailureRecording > stopped > then:callback.1":
    ["lifecycle", ["BridgeClient.request"]],
  "player/vue/src/session/activation/useFailureRecording.ts useFailureRecording > stopped > then:callback.2":
    ["lifecycle", ["BridgeClient.request"]],
  "player/vue/src/debug/history/useDebugExport.ts useDebugExport > onScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.request"],
  ],
  "player/vue/src/debug/history/useDebugExport.ts useDebugExport > watch:callback#2": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/activation/useExportCandidate.ts useExportCandidate > debugExportCandidate > capture > captureExport:callback":
    ["lifecycle", ["BridgeClient.request"]],
  "player/vue/src/session/activation/work/stop.ts stopLateStart > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request"],
  ],
};

/** The escapes that are not followed (a value passed as a callback): each is an entry point too, with its policy. */
const ESCAPES: Readonly<Record<string, Policy>> = {
  // The reply hooks a request passes on: a debug export's capture releases its ticket from its hook.
  "player/engine-bridge/client.ts openBridge > Promise:callback > request > exclusive:callback {onReply}":
    "bridge plumbing",
  "player/runtime/player-bridge.ts PlayerBridge > request > #send:callback {onReply}":
    "bridge plumbing",
  "player/encryption/lock-service.ts LockService > #present > wake {wake}": "own observation",
  "player/vue/src/session/useCallView.ts useCallView {followCallView}": "lifecycle",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > then:callback {bridgeLost}":
    "lifecycle",
  // The export lease's release, which the activation's retirement (`own`) and the dialog's cancellation run, and which
  // the handoff takes back from the cancellation.
  "player/vue/src/session/activation/useExportCandidate.ts useExportCandidate > deliver {release}":
    "lifecycle",
  "player/vue/src/session/activation/useExportCandidate.ts useExportCandidate > deliver > handOver {release}":
    "lifecycle",
  "player/vue/src/session/useSessionMedia.ts useSessionMedia > watchMedia {catchUp}":
    "clock scheduling",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > scheduleWakeUp {catchUp}":
    "clock scheduling",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock {catchUp}":
    "clock scheduling",
};

/** The escapes the census follows: an object literal's property, or a destructured binding, that holds a forwarder. */
const FOLLOWED: readonly string[] = [
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > discardSessionReview {discardSessionReview}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > readTransfer {readTransfer}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > reviewSessionImport {reviewSessionImport}",
  "player/engine-bridge/client.ts openBridge > Promise:callback > request {request}",
  "player/runtime/player-bridge.ts PlayerBridge > captureExport > onReply {onReply}",
  "player/runtime/player-bridge.ts PlayerBridge > request > #send:callback > onReply {onReply}",
  "player/runtime/player-bridge.ts PlayerBridge > viewCalls > #send:callback > onReply {onReply}",
  "player/engine-bridge/client.ts openBridge > Promise:callback > signal {signal}",
  "player/vue/src/session/useCallView.ts useCallView > demandCallView {demandCallView}",
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices > section {serviceSection}",
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices {serviceSection}",
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > resolve {resolve}",
  "player/vue/src/debug/random/useDebugRandom.ts useDebugRandom > resolveLeastTried {resolveLeastTried}",
  "player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > advanceBy {advanceBy}",
  "player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > skip {skip}",
  "player/vue/src/debug/usePlayerDebug.ts usePlayerDebug > explain {explain}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > activate {activate}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > debugView {debugView}",
  "player/vue/src/session/activation/useExportCandidate.ts useExportCandidate > debugExportCandidate {debugExportCandidate}",
  "player/vue/src/session/activation/useExportCandidate.ts useExportCandidate > deliver > release {release}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > debugExportCandidate {debugExportCandidate}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > demandCallView {demandCallView}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > editSavedData {editSavedData}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > exportSession {exportSession}",
  "player/vue/src/session/useRandomControl.ts useRandomControl > forgetRandomHistory {forgetRandomHistory}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > importSavedData {importSavedData}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > importSession {importSession}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > inputSection {inputSection}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > observe {observeForInput}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > prepare {prepare}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > prepareInput {prepareInput}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > prepareRestore {prepareRestore}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > prepareScript {prepareScript}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > pressPermanentButton {pressPermanentButton}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > publishJump {publishJump}",
  "player/vue/src/session/useRandomControl.ts useRandomControl > randomTried {randomTried}",
  "player/vue/src/session/useRandomControl.ts useRandomControl > resolveRandomDraw {resolveRandomDraw}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > clearScriptStorage {clearScriptStorage}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > serviceSection {serviceSection}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > setDebugMode {setDebugMode}",
  "player/vue/src/session/useRandomControl.ts useRandomControl > setRandomControl {setRandomControl}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > toStartPage {toStartPage}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {demandCallView}",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > before {before}",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > cancel {cancel}",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > catchUp {catchUp}",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > observe {observe}",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation {requestObservation}",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > section {section}",
  "player/vue/src/session/useRandomControl.ts useRandomControl > adoptRandom {adoptRandom}",
  "player/vue/src/session/useRandomControl.ts useRandomControl > flushRandom {flushRandom}",
  "player/vue/src/session/useRandomControl.ts useRandomControl > settleUncontrolledDraw {settleUncontrolledDraw}",
  "player/vue/src/session/useRandomControl.ts useRandomControl {ownedSection}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > forgetRandomHistory {forgetRandomHistory}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > ownedSection {ownedSection}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > randomTried {randomTried}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > resolveRandomDraw {resolveRandomDraw}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > setRandomControl {setRandomControl}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {adoptRandom}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {flushRandom}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {forgetRandomHistory}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {randomTried}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {resolveRandomDraw}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {setRandomControl}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {settleUncontrolledDraw}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > applyDebugMode {applyDebugMode}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > flushTracing {flushTracing}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > setDebugTracing {setDebugTracing}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace {copyToDebugRoom}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace {keepSessionLater}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > copyToDebugRoom {copyToDebugRoom}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > debugView {debugView}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > keepSessionLater {keepSessionLater}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > setDebugMode {setDebugMode}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > setDebugTracing {setDebugTracing}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {applyDebugMode}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {debugView}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {flushTracing}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {setDebugMode}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {setDebugTracing}",
  "player/vue/src/session/useSessionMedia.ts useSessionMedia {ownedSection}",
  "player/vue/src/session/useSessionRewind.ts useSessionRewind > adoptRewound {adoptRewound}",
  "player/vue/src/session/useSessionRewind.ts useSessionRewind > prepareInput {prepareInput}",
  "player/vue/src/session/useSessionRewind.ts useSessionRewind > retireRewind {retireRewind}",
  "player/vue/src/session/useSessionRewind.ts useSessionRewind {adoptRandom}",
  "player/vue/src/session/useSessionRewind.ts useSessionRewind {applyDebugMode}",
  "player/vue/src/session/useSessionRewind.ts useSessionRewind {settleUncontrolledDraw}",
  "player/vue/src/session/useSessionRewind.ts useSessionRewind {showSession}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > adoptRandom {adoptRandom}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > applyDebugMode {applyDebugMode}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > settleUncontrolledDraw {settleUncontrolledDraw}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > showSession {showSession}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {adoptRewound}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {prepareInput}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {retireRewind}",
  "player/vue/src/session/persistence/useSavedValues.ts useSavedValues > clearScriptStorage {clearScriptStorage}",
  "player/vue/src/session/persistence/useSavedValues.ts useSavedValues > editSavedData {editSavedData}",
  "player/vue/src/session/persistence/useSavedValues.ts useSavedValues {inputSection}",
  "player/vue/src/session/persistence/useSavedValues.ts useSavedValues {retireRewind}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > retireRewind {retireRewind}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {clearScriptStorage}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {editSavedData}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > keepSessionLater {keepSessionLater}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > prepareKept {prepareKept}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > prepareScript {prepareScript}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > settleKeepAttempt {settleKeepAttempt}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > settlePlanJson {settlePlanJson}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > toStartPage {toStartPage}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession {endSession}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession {prepareRestore}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession {prepareStart}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > endSession {endSession}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > prepareStart {prepareStart}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {keepSessionLater}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {prepareKept}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {prepareScript}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {settleKeepAttempt}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {settlePlanJson}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {toStartPage}",
  "player/vue/src/session/persistence/useSavedDataTransfer.ts useSavedDataTransfer > importSavedData {importSavedData}",
  "player/vue/src/session/persistence/useSavedDataTransfer.ts useSavedDataTransfer {endSession}",
  "player/vue/src/session/persistence/useSavedDataTransfer.ts useSavedDataTransfer {prepareStart}",
  "player/vue/src/session/persistence/useSavedDataTransfer.ts useSavedDataTransfer {retireRewind}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {importSavedData}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > discardSessionReview {discardSessionReview}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > exportSession {exportSession}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > importSession {importSession}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > readTransfer {readTransfer}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > reviewSessionImport {reviewSessionImport}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer {endSession}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer {prepareKept}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer {retireRewind}",
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer {settlePlanJson}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > prepareKept {prepareKept}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > settlePlanJson {settlePlanJson}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {discardSessionReview}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {exportSession}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {importSession}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {readTransfer}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {reviewSessionImport}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > activate {activate}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > prepare {prepare}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > prepareRestore > begin {begin}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > prepareRestore {prepareRestore}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > prepareStart > begin {begin}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > prepareStart {prepareStart}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > supersede {supersede}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation {adoptRandom}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation {settlePlanJson}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation {showSession}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {activate}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {prepareRestore}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {prepareStart}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {prepare}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {supersede}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > reportActivationError {reportActivationError}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > reportPageError {reportPageError}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace {reportActivationError}",
  "player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace {reportPageError}",
  "player/vue/src/session/useRandomControl.ts useRandomControl {reportActivationError}",
  "player/vue/src/session/useRandomControl.ts useRandomControl {reportPageError}",
  "player/vue/src/session/useSessionRewind.ts useSessionRewind {reportPageError}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > reportActivationError {reportActivationError}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > reportHostError {reportPageError}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > reportPageError {reportPageError}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {reportActivationError}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {reportPageError}",
  "player/vue/src/session/activation/useActivationRun.ts useActivationRun {report}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > report {report}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > lose {lose}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {lose}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > startFrom > failed {failed}",
  "player/vue/src/session/activation/work/adopt.ts adopt > done {done}",
  "player/vue/src/session/activation/work/adopt.ts adopt > failed {failed}",
  "player/vue/src/session/useCallView.ts useCallView {reportActivationError}",
  "player/vue/src/session/useSessionMedia.ts useSessionMedia {reportActivationError}",
];

/**
 * What an adoption path gives the connection's rewind history (L5i.6), the table's third column: `publish` takes every
 * publication into it (`observePublication`), an introduction's included; `keep` alone, a same-revision wrapper, is no
 * publication, so a path passes none exactly when it reaches no `publish`.
 */
type HistoryPassage = "publication observation" | "introduction" | "none";
/** How an op's result session is adopted in the host (item 15): each entry point that reaches `publish` or `keep`. */
type Adoption =
  | "result"
  | "catch-up adoption"
  | "recorder attachment"
  | "introduction"
  | "host dispatch"
  | "facade exception";
const ADOPTIONS: Readonly<Record<string, readonly [Adoption, readonly string[], HistoryPassage]>> =
  {
    "player/engine-bridge/engine-host.ts (module)": [
      "host dispatch",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/in-process.ts beginRecordingNow": [
      "facade exception",
      ["HeldSession.keep"],
      "none",
    ],
    "player/engine-bridge/in-process.ts createInProcessBackend": [
      "host dispatch",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/in-process.ts hatch": [
      "facade exception",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/in-process.ts introduceNow": [
      "facade exception",
      ["HeldSession.publish"],
      "introduction",
    ],
    "player/engine-bridge/node-worker.ts (module)": [
      "host dispatch",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/input.ts inputOps > applyStorageEdit > sessionOp:callback#3.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/input.ts inputOps > completeStorageWrite > sessionOp:callback#2.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/input.ts inputOps > pressPermanentButton > sessionOp:callback#1.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/input.ts interactionOp > sessionOp:callback.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/media.ts mediaOps > reportMediaLoad > sessionOp:callback.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/random.ts randomOps > resolveDraw > sessionOp:callback.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/resources.ts answerOp > sessionOp:callback.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/session.ts sessionOp:callback.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/session.ts catchUpOps > adoptCatchUp > sessionOp:callback#3.2": [
      "catch-up adoption",
      ["HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/session.ts sessionRunOps > beginRecording > sessionOp:callback#3.2": [
      "recorder attachment",
      ["HeldSession.keep"],
      "none",
    ],
    "player/engine-bridge/ops/session.ts sessionRunOps > continue > sessionOp:callback#1.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/session.ts sessionInputOps > skipPacing > sessionOp:callback#2.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/session.ts sessionInputOps > stepTime > sessionOp:callback#1.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/trace.ts traceOps > setDebugMode > sessionOp:callback#2.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/worker-host.ts startBridgeHost > drain > then:callback": [
      "introduction",
      ["HeldSession.keep", "HeldSession.publish"],
      "introduction",
    ],
    "player/engine-bridge/worker-host.ts startBridgeHost > listen:callback": [
      "introduction",
      ["HeldSession.keep", "HeldSession.publish"],
      "introduction",
    ],
  };
/** The adoption census's followed escapes: the op tables' `run` members, and the facade's exposures. */
const ADOPTION_ESCAPES: readonly string[] = [
  "player/engine-bridge/ops/history.ts historyControlOps > captureStorage > run {run}",
  "player/engine-bridge/ops/history.ts historyControlOps > historyClose > run {run}",
  "player/engine-bridge/ops/history.ts rewindSettleOps > rewindCommit > run {run}",
  "player/engine-bridge/ops/history.ts rewindSettleOps > rewindDrop > run {run}",
  "player/engine-bridge/ops/history.ts historyControlOps > historyEnroll > run {run}",
  "player/engine-bridge/ops/history.ts historyControlOps > historyOpen > run {run}",
  "player/engine-bridge/ops/history.ts historyControlOps > historyTimeline > run {run}",
  "player/engine-bridge/ops/history.ts rewindSettleOps > rewindAdopt > run {run}",
  "player/engine-bridge/ops/history.ts rewindStepOps > rewindBack > run {run}",
  "player/engine-bridge/ops/history.ts rewindStepOps > rewindForward > run {run}",
  "player/engine-bridge/ops/history.ts rewindSettleOps > rewindReturn > run {run}",
  "player/engine-bridge/ops/recording.ts exportCaptureOps > captureExport > run {run}",
  "player/engine-bridge/ops/recording.ts recordingRunOps > captureRecording > run {run}",
  "player/engine-bridge/ops/recording.ts recordingRunOps > commitIncident > run {run}",
  "player/engine-bridge/ops/recording.ts exportCaptureOps > exportPrepare > run {run}",
  "player/engine-bridge/ops/recording.ts recordingRunOps > releaseRecording > run {run}",
  "player/engine-bridge/ops/recording.ts recordingRunOps > retireRun > run {run}",
  "player/engine-bridge/ops/transfer.ts transferOps > readTransfer > run {run}",
  "player/engine-bridge/ops/transfer.ts transferOps > releaseTransfer > run {run}",
  "player/engine-bridge/ops/transfer.ts transferOps > reviewTransfer > run {run}",
  "player/engine-bridge/ops/transfer.ts transferOps > transferCommit > run {run}",
  "player/engine-bridge/ops/persistence.ts keptStateOps > captureCheckpoint > run {run}",
  "player/engine-bridge/ops/persistence.ts keptStateOps > captureKeep > run {run}",
  "player/engine-bridge/ops/persistence.ts planTextOps > planText > run {run}",
  "player/engine-bridge/ops/persistence.ts planTextOps > preparePlanText > run {run}",
  "player/engine-bridge/ops/persistence.ts planTextOps > releasePlanText > run {run}",
  "player/engine-bridge/ops/persistence.ts keptStateOps > restoreKept > run {run}",
  "player/engine-bridge/ops/random.ts randomOps > adoptRandom > run {run}",
  "player/engine-bridge/ops/random.ts randomOps > randomControl > run {run}",
  "player/engine-bridge/ops/random.ts randomOps > randomTried > run {run}",
  "player/engine-bridge/ops/random.ts randomOps > releaseRandom > run {run}",
  "player/engine-bridge/ops/session.ts sessionOp > run {run}",
  "player/engine-bridge/ops/session.ts sessionRunOps > start > run {run}",
  "player/engine-bridge/ops/source-views.ts sourceViewOps > codeLines > run {run}",
  "player/engine-bridge/ops/source-views.ts sourceViewOps > drawCode > run {run}",
  "player/engine-bridge/ops/trace.ts traceOps > debugTracing > run {run}",
  "player/engine-bridge/ops/trace.ts traceOps > debugView > run {run}",
  "player/engine-bridge/player-ops.ts playerBridgeOps > planMetadata > run {run}",
  "player/engine-bridge/player-ops.ts playerBridgeOps > prepare > run {run}",
  "player/engine-bridge/player-ops.ts playerBridgeOps > teardown > run {run}",
  "player/engine-bridge/worker-host.ts release > run {run}",
];

const keyOf = (found: Found) => `${found.file} ${found.path}`;

function assertTable<T>(
  found: readonly Found[],
  table: Readonly<Record<string, T>>,
  value: (found: Found) => T,
  label: string,
): void {
  const keys = new Set(found.map(keyOf));
  const missing = [...keys].filter((key) => !Object.hasOwn(table, key)).sort();
  const stale = Object.keys(table)
    .filter((key) => !keys.has(key))
    .sort();
  // Every difference at once, so one run shows all a change needs.
  const differing = found
    .filter((each) => Object.hasOwn(table, keyOf(each)))
    .filter((each) => !isDeepStrictEqual(value(each), table[keyOf(each)]))
    .map((each) => ({ key: keyOf(each), found: value(each), declared: table[keyOf(each)] }));
  assert.deepEqual(
    { missing, stale, differing },
    { missing: [], stale: [], differing: [] },
    `${label}: unclassified, stale or differing`,
  );
}

/** The work census at the sources as they are, or with `overrides`. */
function work(overrides: Readonly<Record<string, string>> = {}): Walk {
  census.setOverrides(overrides);
  try {
    return census.run(SURFACES);
  } finally {
    census.setOverrides({});
  }
}

const followed = (escape: Found) => escape.kind === "property" || escape.kind === "destructured";

test("the session-work census finds exactly the classified entry points of every sending surface", (context: TestContext) => {
  const found = work();
  assert.deepEqual(
    [...(found.boundary.interfaces[`${CLIENT}#BridgeClient`] ?? [])].sort(),
    [...CLIENT_MEMBERS.sending, ...CLIENT_MEMBERS.ticketed, ...CLIENT_MEMBERS.nonSending].sort(),
    "every public BridgeClient member is sending or listed as not",
  );
  assert.deepEqual(
    [...(found.boundary.exports[FACADE] ?? [])].sort(),
    [...FACADE_EXPORTS.sending, ...FACADE_EXPORTS.nonSending].sort(),
    "every function the facade exports is sending or listed as not",
  );
  const lookup = (key: string) => ENTRIES[key]!;
  assertTable(
    found.entries,
    ENTRIES,
    (each): readonly [Policy, readonly string[]] => [lookup(keyOf(each))[0], each.origins],
    "entry points",
  );
  assertTable(
    found.escapes.filter((each) => !followed(each)),
    ESCAPES,
    (each) => ESCAPES[keyOf(each)]!,
    "escapes",
  );
  assert.deepEqual(
    found.escapes.filter(followed).map(keyOf).sort(),
    [...FOLLOWED].sort(),
    "followed escapes",
  );
  context.diagnostic(
    `surfaces ${SURFACES.length}, forwarders ${found.forwarders.length}, entry points ${found.entries.length}, escapes ${found.escapes.length} (${found.escapes.filter(followed).length} followed)`,
  );
});

test("the census fails a new caller of a forwarder, a new BridgeClient member, and a callback escape", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (path: string) => readFile(resolve(process.cwd(), path), "utf8");
  const [session, client] = await Promise.all([source(SESSION), source(CLIENT)]);
  const anchor = "  function publishJump(next: PlayerSession) {";
  assert.ok(session.includes(anchor));
  // A new caller of the forwarder `observeForInput`, in a function nothing else calls: a new entry point.
  const caller = work({
    [SESSION]: session.replace(
      anchor,
      `  function extraInput() {\n    void observeForInput();\n  }\n${anchor}`,
    ),
  });
  assert.ok(
    caller.entries.some((each) => keyOf(each) === `${SESSION} usePlayerSession > extraInput`),
    "a new caller of a forwarder is a new entry point",
  );
  assert.ok(caller.entries.some((each) => !Object.hasOwn(ENTRIES, keyOf(each))));
  // A new public member of the client's interface: the boundary differs from the lists.
  const memberAnchor = "  onLoss(listener: (error: BridgeLostError) => void): void;";
  assert.equal(client.split(memberAnchor).length, 2, "the anchor is BridgeClient's own member");
  const member = work({
    [CLIENT]: client.replace(memberAnchor, `  ping(): void;\n${memberAnchor}`),
  });
  assert.ok(member.boundary.interfaces[`${CLIENT}#BridgeClient`]?.includes("ping"));
  // A forwarder passed as a callback: an escape the table does not hold.
  const escape = work({
    [SESSION]: session.replace(
      anchor,
      `  void Promise.resolve().then(pressPermanentButton);\n${anchor}`,
    ),
  });
  assert.ok(
    escape.escapes.some((each) => !followed(each) && !Object.hasOwn(ESCAPES, keyOf(each))),
    "a callback escape is unclassified",
  );
});

test("every host path that adopts an op's result is classified (item 15)", () => {
  const found = census.run(
    ["publish", "keep"].map((member) => ({
      file: "player/engine-bridge/ops/session.ts",
      name: "HeldSession",
      member,
    })),
    { within: "player/engine-bridge/" },
  );
  const lookup = (key: string) => ADOPTIONS[key]!;
  assertTable(
    found.entries,
    ADOPTIONS,
    (each): readonly [Adoption, readonly string[], HistoryPassage | "inconsistent"] => {
      const [adoption, , passage] = lookup(keyOf(each));
      const publishes = each.origins.includes("HeldSession.publish");
      return [
        adoption,
        each.origins,
        publishes === (passage !== "none") ? passage : "inconsistent",
      ];
    },
    "adoption entry points",
  );
  assert.deepEqual(
    found.escapes.map(keyOf).sort(),
    [...ADOPTION_ESCAPES].sort(),
    "adoption escapes",
  );
  // `publishing` and `answered` decide through `adoptResult`, the one decision.
  const forwarders = found.forwarders.map(keyOf);
  for (const caller of [
    "player/engine-bridge/ops/session.ts publishing",
    "player/engine-bridge/ops/input.ts answered",
  ])
    assert.ok(forwarders.includes(caller), caller);
  assert.ok(forwarders.includes("player/engine-bridge/ops/session.ts HeldSession > adoptResult"));
});

// R2: every use of the clock's and the host's observation API. A promise is awaited, returned, handled at once, or
// exposed under another name (followed); `before` and `requestObservation` return nothing.
const OBSERVATION_USES: readonly string[] = [
  "observe <- player/vue/src/session/usePlayerSession.ts usePlayerSession > observeForInput [awaited]",
  "observe <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > observe [exposed]",
  "observing <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > observe [returned]",
  "observing <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation [voided]",
  "observeForInput <- player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > autoSkipTask [awaited]",
  "observeForInput <- player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > jump [awaited]",
  "observeForInput <- player/vue/src/session/usePlayerSession.ts usePlayerSession > observe [exposed]",
  "requestObservation <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > before [unawaited]",
  "requestObservation <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > catchUp [returned]",
  "requestObservation <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > end [unawaited]",
  "requestObservation <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation [exposed]",
  "before <- player/vue/src/session/useSessionMedia.ts useSessionMedia > requestObservation [returned]",
  "before <- player/vue/src/session/useDebugModeAndTrace.ts useDebugModeAndTrace > setDebugMode [unawaited]",
  "before <- player/vue/src/session/useRandomControl.ts useRandomControl > setRandomControl [unawaited]",
  "before <- player/vue/src/session/persistence/useKeptSession.ts useKeptSession > startKeeping > useEventListener:callback.2 [unawaited]",
  "before <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > before [exposed]",
  "before <- player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > useEventListener:callback#2 [returned]",
  "requestObservation (device) <- player/media/media-device.ts MediaDevice > #create > listen:callback#4 [returned]",
];

test("every use of the observation API is awaited, returned, handled or exposed (R2)", () => {
  const targets = [
    { file: CLOCK, path: "useRuntimeSceneClock > observe", name: "observe" },
    { file: CLOCK, path: "useRuntimeSceneClock > observing", name: "observing" },
    { file: CLOCK, path: "useRuntimeSceneClock > requestObservation", name: "requestObservation" },
    { file: CLOCK, path: "useRuntimeSceneClock > before", name: "before" },
    { file: SESSION, path: "usePlayerSession > observeForInput", name: "observeForInput" },
    {
      file: "player/vue/src/session/useSessionMedia.ts",
      path: "useSessionMedia > requestObservation",
      name: "requestObservation (device)",
    },
  ];
  const named = new Map(targets.map((each) => [`${each.file} ${each.path}`, each.name]));
  const found = census
    .uses(targets)
    .map((each) => `${named.get(each.target)} <- ${each.file} ${each.path} [${each.use}]`);
  assert.deepEqual([...new Set(found)].sort(), [...OBSERVATION_USES].sort());
  // What returns a promise is never left unawaited; `observing` is voided only where a recovery is passed in, which it
  // decides every failure with, so it does not reject.
  for (const use of found.filter((each) => /^observ(e|eForInput|ing) </u.test(each)))
    assert.match(
      use,
      /\[(awaited|returned|handled|exposed)\]$|^observing <- .* requestObservation \[voided\]$/u,
      use,
    );
});
