import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { before, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

/*
 * L5i.5, R3: the census of session work (`tools/session-work-census.mjs`). The tool derives the sending boundary from
 * the code and walks references back from it; this file holds what the walk finds, classified at each entry point by
 * what the session must have observed before its work (orchestrator 2's rulings on plan r3). Forwarders stay
 * unclassified: a forwarder reached from two entry points carries each one's policy. An entry point, escape or
 * boundary member the tables do not hold fails, and so does a row nothing matches.
 *
 * What it claims: the entry points the clock's literal oracle drives (`player-clock-work.test.ts`, the five `ClockWork`
 * rows' entry points and development time's skip and auto-skip) are found and classified. The walk does not see
 * senders through a structural interface (`InputSectionHost`: `draftInput`, `runInput`) or callers in `.vue` files
 * (#1983).
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

const CLIENT = "player/engine-bridge/client.ts";
const FACADE = "player/engine-bridge/in-process.ts";
const SESSION = "player/vue/src/usePlayerSession.ts";
const CLOCK = "player/vue/src/useRuntimeSceneClock.ts";

/** Every public member of `BridgeClient`: what sends to the host, and what does not. */
const CLIENT_MEMBERS = {
  sending: ["request", "section", "signal"],
  // The Worker's end and its loss listener send no session work.
  nonSending: ["terminate", "onLoss"],
} as const;
/** Every function the in-process facade exports: the session functions, and what does not send. */
const FACADE_EXPORTS = {
  sending: ["hatch", "introduceNow", "beginRecordingNow"],
  // The backend's creation, and reads of the connection's state (plans, recording, trace, random), with no session.
  nonSending: ["createInProcessBackend", "heldRandom", "heldTrace", "heldPlan", "heldRecording"],
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
  "player/vue/src/rewindOwner.ts createRewindOwner > apply > finally:callback#2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > back > step:callback": [
    "resume",
    ["BridgeClient.request"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > close > then:callback#1.1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > close > then:callback#1.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > enroll > DebugHistoryView:callback": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > enroll > DebugHistoryView:callback > catch:callback":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/rewindOwner.ts createRewindOwner > forward > step:callback": [
    "resume",
    ["BridgeClient.request"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > gate > then:callback.1": [
    "resume",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > gate > then:callback.2": [
    "resume",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > apply > then:callback#1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > open > function": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > retryReturn": [
    "resume",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/rewindOwner.ts createRewindOwner > reportUnless > function": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugRewind.ts useDebugRewind > tryOnScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > clearScriptStorage": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > showSession": [
    "resume",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > watch:callback#11": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > tryOnScopeDispose:callback#3": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSavedData > owned:callback > commit:callback#2":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSession > owned:callback > replaceSession > admit:callback#1":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSession > owned:callback > replaceSession > admit:callback#2":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > readTransfer": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > reviewSessionImport": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/lock-service.ts LockService > request > later:callback": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/media-device.ts MediaDevice > #create > listen:callback#4": [
    "clock: audioEnded",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/player-bridge.ts PlayerBridge > #collected > FinalizationRegistry:callback": [
    "lifecycle",
    ["BridgeClient.request"],
  ],
  "player/player-bridge.ts PlayerBridge > request > #send:callback": [
    "bridge plumbing",
    ["BridgeClient.request"],
  ],
  "player/player-bridge.ts PlayerBridge > viewCalls > #send:callback": [
    "bridge plumbing",
    ["BridgeClient.request"],
  ],
  "player/session-camera.ts CaptureService > request > later:callback": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/stored-files.ts FileStoreService > request > later:callback": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section"],
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
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal", "introduceNow"],
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
    ["own observation", ["BridgeClient.request", "BridgeClient.section"]],
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices > watch:callback#2":
    ["own observation", ["BridgeClient.request", "BridgeClient.section"]],
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices > watch:callback#3":
    ["own observation", ["BridgeClient.request", "BridgeClient.section"]],
  "player/vue/src/stagePhotos.ts usePlanPhotoPreload": ["read", ["BridgeClient.request"]],
  "player/vue/src/stagePhotos.ts usePlanPhotoPreload > watch:callback": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/useDebugExport.ts useDebugExport": ["none", ["BridgeClient.request"]],
  "player/vue/src/useDebugExport.ts useDebugExport > watch:callback#1": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/useDebugRandom.ts useDebugRandom > resolveLeastTried": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugRandom.ts useDebugRandom > tryOnScopeDispose:callback": [
    "clock: randomControl",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugRandom.ts useDebugRandom > watch:callback#1": [
    "clock: randomControl",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugRandom.ts useDebugRandom > watch:callback#2": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/useDebugRandom.ts useDebugRandom > watch:callback#3": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/useDebugRandom.ts useDebugRandom > watch:callback#4": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/useDebugRandom.ts useDebugRandom > watch:callback#5": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/useDebugRewind.ts useDebugRewind > back": [
    "resume",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugRewind.ts useDebugRewind > forward": [
    "resume",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugRewind.ts useDebugRewind > resume": [
    "resume",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugRewind.ts useDebugRewind > returnToSession": [
    "resume",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugRewind.ts useDebugRewind > then:callback.1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugView.ts useDebugView": [
    "read",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/useDebugView.ts useDebugView > watch:callback.2": [
    "read",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/useDevelopmentTime.ts useDevelopmentTime > advanceBy": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDevelopmentTime.ts useDevelopmentTime > skip": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/useDevelopmentTime.ts useDevelopmentTime > watch:callback#2 > setTimeout:callback":
    ["own observation", ["BridgeClient.request", "BridgeClient.section"]],
  "player/vue/src/usePlayerDebug.ts usePlayerDebug": [
    "composition",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerDebug.ts usePlayerDebug > explain": [
    "read",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerDebug.ts usePlayerDebug > tryOnScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerDebug.ts usePlayerDebug > watch:callback#3.2": [
    "clock: debugMode",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerDebug.ts usePlayerDebug > watch:callback#3.2 > run:callback": [
    "composition",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > MediaLoadQueue:callback.1": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > applyDebugMode > then:callback.1": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > applyDebugMode > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > copyToDebugRoom > then:callback": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > debugView > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > editSavedData": [
    "none",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > editSavedData > then:callback#1": [
    "none",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > exportSession": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > flushTracing > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSavedData": [
    "none",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSession": [
    "creation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSession > owned:callback": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSession > owned:callback > replaceSession > commit:callback#4":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > keepIn > admit:callback": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > keepOnce > owned:callback": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > keepSessionLater > function": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > lock > cancel": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > lock > submit": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > ownedSection > section:callback > body:callback":
    ["own observation", ["BridgeClient.request"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareKept > owned:callback": [
    "creation",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareKept > owned:callback > commit:callback#1":
    ["creation", ["BridgeClient.request", "BridgeClient.signal", "introduceNow"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareKept > owned:callback > commit:callback#2":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareRestore > begin > catch:callback#2":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > pressPermanentButton": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > reportHostError > then:callback.1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > resolveRandomDraw > catch:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > restoreKept > admit:callback": [
    "creation",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > rooms > reloadDebug": [
    "creation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > rooms > resetDebug": [
    "creation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > sendRandomRequest > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > startDebugSessionAnew > then:callback": [
    "creation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > startFrom > then:callback#1": [
    "creation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > startFrom > then:callback#2.1": [
    "creation",
    ["BridgeClient.request", "BridgeClient.section", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > startFrom > then:callback#2.2": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > then:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > toStartPage": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal", "introduceNow"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > tryOnScopeDispose:callback#1": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > useEventListener:callback.2": [
    "clock: keepCapture",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > watch:callback#10": [
    "none",
    ["BridgeClient.request"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > watch:callback#3": [
    "own observation",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > watch:callback#7 > then:callback.1": [
    "none",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > watch:callback#7 > then:callback.2": [
    "none",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/usePlayerSession.ts usePlayerSession > watch:callback#7 > yieldThenReport > setTimeout:callback":
    ["none", ["BridgeClient.request", "BridgeClient.section"]],
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > catchUp > function": [
    "clock scheduling",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation > observing:callback":
    ["clock scheduling", ["BridgeClient.request"]],
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > step > inNextTask:callback": [
    "clock scheduling",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > useEventListener:callback#1": [
    "clock scheduling",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > useEventListener:callback#2": [
    "clock: pageHide",
    ["BridgeClient.request", "BridgeClient.section"],
  ],
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > watch:callback#1": [
    "clock scheduling",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/useFailureRecording.ts useFailureRecording > stopped > then:callback.1": [
    "lifecycle",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/useFailureRecording.ts useFailureRecording > stopped > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request"],
  ],
  "player/vue/src/useDebugExport.ts useDebugExport > onScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.request"],
  ],
  "player/vue/src/useDebugExport.ts useDebugExport > watch:callback#2": [
    "read",
    ["BridgeClient.request"],
  ],
  "player/vue/src/session/useExportCandidate.ts useExportCandidate > debugExportCandidate > capture > captureExport:callback":
    ["lifecycle", ["BridgeClient.request"]],
  "player/vue/src/usePlayerSession.ts usePlayerSession > reportHostError > then:callback.2": [
    "lifecycle",
    ["BridgeClient.request"],
  ],
};

/** The escapes that are not followed (a value passed as a callback): each is an entry point too, with its policy. */
const ESCAPES: Readonly<Record<string, Policy>> = {
  // The reply hooks a request passes on: a debug export's capture releases its ticket from its hook.
  "player/engine-bridge/client.ts openBridge > Promise:callback > request > exclusive:callback {onReply}":
    "bridge plumbing",
  "player/player-bridge.ts PlayerBridge > request > #send:callback {onReply}": "bridge plumbing",
  "player/lock-service.ts LockService > #present > wake {wake}": "own observation",
  "player/vue/src/session/useCallView.ts useCallView {followCallView}": "lifecycle",
  "player/vue/src/usePlayerSession.ts usePlayerSession > then:callback {bridgeLost}": "lifecycle",
  "player/vue/src/usePlayerSession.ts usePlayerSession {catchUp}": "clock scheduling",
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > scheduleWakeUp {catchUp}":
    "clock scheduling",
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock {catchUp}": "clock scheduling",
};

/** The escapes the census follows: an object literal's property, or a destructured binding, that holds a forwarder. */
const FOLLOWED: readonly string[] = [
  "player/vue/src/usePlayerSession.ts usePlayerSession > discardSessionReview {discardSessionReview}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > readTransfer {readTransfer}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > reviewSessionImport {reviewSessionImport}",
  "player/engine-bridge/client.ts openBridge > Promise:callback > request {request}",
  "player/engine-bridge/client.ts openBridge > Promise:callback > section {section}",
  "player/player-bridge.ts PlayerBridge > captureExport > onReply {onReply}",
  "player/player-bridge.ts PlayerBridge > request > #send:callback > onReply {onReply}",
  "player/player-bridge.ts PlayerBridge > viewCalls > #send:callback > onReply {onReply}",
  "player/engine-bridge/client.ts openBridge > Promise:callback > signal {signal}",
  "player/vue/src/session/useCallView.ts useCallView > demandCallView {demandCallView}",
  "player/vue/src/session/useCallView.ts useCallView {reportHostError}",
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices > section {serviceSection}",
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices {serviceSection}",
  "player/vue/src/useDebugRandom.ts useDebugRandom > resolve {resolve}",
  "player/vue/src/useDebugRandom.ts useDebugRandom > resolveLeastTried {resolveLeastTried}",
  "player/vue/src/useDevelopmentTime.ts useDevelopmentTime > advanceBy {advanceBy}",
  "player/vue/src/useDevelopmentTime.ts useDevelopmentTime > skip {skip}",
  "player/vue/src/usePlayerDebug.ts usePlayerDebug > explain {explain}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > activate {activate}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > debugView {debugView}",
  "player/vue/src/session/useExportCandidate.ts useExportCandidate > debugExportCandidate {debugExportCandidate}",
  "player/vue/src/session/useExportCandidate.ts useExportCandidate > deliver > release {release}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > debugExportCandidate {debugExportCandidate}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > demandCallView {demandCallView}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > editSavedData {editSavedData}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > exportSession {exportSession}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > forgetRandomHistory {forgetRandomHistory}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSavedData {importSavedData}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > importSession {importSession}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > inputSection {inputSection}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > observe {observeForInput}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepare {prepare}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareInput {prepareInput}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareRestore > begin {begin}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareRestore {prepareRestore}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareScript {prepareScript}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > prepareStart > begin {begin}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > pressPermanentButton {pressPermanentButton}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > publishJump {publishJump}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > randomTried {randomTried}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > reportHostError {reportHostError}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > resolveRandomDraw {resolveRandomDraw}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > clearScriptStorage {clearScriptStorage}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > serviceSection {serviceSection}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > setDebugMode {setDebugMode}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > setRandomControl {setRandomControl}",
  "player/vue/src/usePlayerSession.ts usePlayerSession > toStartPage {toStartPage}",
  "player/vue/src/usePlayerSession.ts usePlayerSession {demandCallView}",
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > before {before}",
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > cancel {cancel}",
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > catchUp {catchUp}",
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > observe {observe}",
  "player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation {requestObservation}",
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
    "player/engine-bridge/ops/session.ts sessionOps > adoptCatchUp > sessionOp:callback#5.2": [
      "catch-up adoption",
      ["HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/session.ts sessionOps > beginRecording > sessionOp:callback#9.2": [
      "recorder attachment",
      ["HeldSession.keep"],
      "none",
    ],
    "player/engine-bridge/ops/session.ts sessionOps > continue > sessionOp:callback#1.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/session.ts sessionOps > skipPacing > sessionOp:callback#7.2": [
      "result",
      ["HeldSession.keep", "HeldSession.publish"],
      "publication observation",
    ],
    "player/engine-bridge/ops/session.ts sessionOps > stepTime > sessionOp:callback#2.2": [
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
  "player/engine-bridge/ops/history.ts historyOps > captureStorage > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > historyClose > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > rewindCommit > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > rewindDrop > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > historyEnroll > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > historyOpen > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > historyTimeline > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > rewindAdopt > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > rewindBack > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > rewindForward > run {run}",
  "player/engine-bridge/ops/history.ts historyOps > rewindReturn > run {run}",
  "player/engine-bridge/ops/recording.ts recordingOps > captureExport > run {run}",
  "player/engine-bridge/ops/recording.ts recordingOps > captureRecording > run {run}",
  "player/engine-bridge/ops/recording.ts recordingOps > commitIncident > run {run}",
  "player/engine-bridge/ops/recording.ts recordingOps > exportPrepare > run {run}",
  "player/engine-bridge/ops/recording.ts recordingOps > releaseRecording > run {run}",
  "player/engine-bridge/ops/recording.ts recordingOps > retireRun > run {run}",
  "player/engine-bridge/ops/transfer.ts transferOps > readTransfer > run {run}",
  "player/engine-bridge/ops/transfer.ts transferOps > releaseTransfer > run {run}",
  "player/engine-bridge/ops/transfer.ts transferOps > reviewTransfer > run {run}",
  "player/engine-bridge/ops/transfer.ts transferOps > transferCommit > run {run}",
  "player/engine-bridge/ops/persistence.ts persistenceOps > captureCheckpoint > run {run}",
  "player/engine-bridge/ops/persistence.ts persistenceOps > captureKeep > run {run}",
  "player/engine-bridge/ops/persistence.ts persistenceOps > planText > run {run}",
  "player/engine-bridge/ops/persistence.ts persistenceOps > preparePlanText > run {run}",
  "player/engine-bridge/ops/persistence.ts persistenceOps > releasePlanText > run {run}",
  "player/engine-bridge/ops/persistence.ts persistenceOps > restoreKept > run {run}",
  "player/engine-bridge/ops/random.ts randomOps > adoptRandom > run {run}",
  "player/engine-bridge/ops/random.ts randomOps > randomControl > run {run}",
  "player/engine-bridge/ops/random.ts randomOps > randomTried > run {run}",
  "player/engine-bridge/ops/random.ts randomOps > releaseRandom > run {run}",
  "player/engine-bridge/ops/session.ts sessionOp > run {run}",
  "player/engine-bridge/ops/session.ts sessionOps > start > run {run}",
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
    [...CLIENT_MEMBERS.sending, ...CLIENT_MEMBERS.nonSending].sort(),
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
  // A new caller of the forwarder `inputSection`, in a function nothing else calls: a new entry point.
  const caller = work({
    [SESSION]: session.replace(
      anchor,
      `  function extraInput() {\n    void inputSection(async (section) => section.observe());\n  }\n${anchor}`,
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
  "observe <- player/vue/src/usePlayerSession.ts usePlayerSession > observeForInput [awaited]",
  "observe <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > observe [exposed]",
  "observing <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > observe [returned]",
  "observing <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation [voided]",
  "observeForInput <- player/vue/src/useDevelopmentTime.ts useDevelopmentTime > autoSkipTask [awaited]",
  "observeForInput <- player/vue/src/useDevelopmentTime.ts useDevelopmentTime > jump [awaited]",
  "observeForInput <- player/vue/src/usePlayerSession.ts usePlayerSession > observe [exposed]",
  "requestObservation <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > before [unawaited]",
  "requestObservation <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > catchUp [returned]",
  "requestObservation <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > end [unawaited]",
  "requestObservation <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > requestObservation [exposed]",
  "before <- player/vue/src/usePlayerSession.ts usePlayerSession > requestObservation [returned]",
  "before <- player/vue/src/usePlayerSession.ts usePlayerSession > setDebugMode [unawaited]",
  "before <- player/vue/src/usePlayerSession.ts usePlayerSession > setRandomControl [unawaited]",
  "before <- player/vue/src/usePlayerSession.ts usePlayerSession > useEventListener:callback.2 [unawaited]",
  "before <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > before [exposed]",
  "before <- player/vue/src/useRuntimeSceneClock.ts useRuntimeSceneClock > useEventListener:callback#2 [returned]",
  "requestObservation (device) <- player/media-device.ts MediaDevice > #create > listen:callback#4 [returned]",
];

test("every use of the observation API is awaited, returned, handled or exposed (R2)", () => {
  const targets = [
    { file: CLOCK, path: "useRuntimeSceneClock > observe", name: "observe" },
    { file: CLOCK, path: "useRuntimeSceneClock > observing", name: "observing" },
    { file: CLOCK, path: "useRuntimeSceneClock > requestObservation", name: "requestObservation" },
    { file: CLOCK, path: "useRuntimeSceneClock > before", name: "before" },
    { file: SESSION, path: "usePlayerSession > observeForInput", name: "observeForInput" },
    {
      file: SESSION,
      path: "usePlayerSession > requestObservation",
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
