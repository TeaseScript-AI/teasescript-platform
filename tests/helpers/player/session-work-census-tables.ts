/*
 * The session-work census's declared tables (`tests/player/player-session-work-census.test.ts` checks the walk of
 * `tools/session-work-census.mjs` against them): the sending surfaces, each entry point's policy and the surfaces it
 * reaches, the escapes, and each adoption path with its history passage.
 */

export interface Surface {
  readonly file: string;
  readonly name: string;
  readonly member?: string;
}

export const CLIENT = "player/engine-bridge/client.ts";
export const SESSION = "player/vue/src/session/usePlayerSession.ts";
export const CLOCK = "player/vue/src/session/useRuntimeSceneClock.ts";

/** Every public member of `BridgeClient`: what sends to the host unguarded, what takes the clock's ticket, and what does not send. */
export const CLIENT_MEMBERS = {
  sending: ["request", "post", "signal"],
  // A section takes a `ClockTicket`: leaving it out fails type-checking, so the walk does not follow it (#1983).
  // Where a ticket came from it does not decide: a check-disabling construct, or one a `BridgeClient` wrapper kept.
  ticketed: ["section"],
  // The Worker's end and its loss listener send no session work.
  nonSending: ["terminate", "onLoss"],
} as const;
export const SURFACES: readonly Surface[] = [
  ...CLIENT_MEMBERS.sending.map((member) => ({ file: CLIENT, name: "BridgeClient", member })),
];

/**
 * What the session must have observed before an entry point's work: a `CLOCK_WORK` row it posts through
 * `clock.before`; its own observation (an input or service section's, development time's); none, as today; a read
 * with no time dependency; lifecycle or control; creation, outside an existing session's clock (rebased when shown);
 * resume or rebase; the clock's own scheduling; the bridge's internals; or composition only.
 */
export type Policy =
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
export const ENTRIES: Readonly<Record<string, readonly [Policy, readonly string[]]>> = {
  "player/vue/src/session/rewindOwner.ts createRewindOwner > apply > finally:callback#2": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > back > step:callback": [
    "resume",
    ["BridgeClient.post"],
  ],
  "player/vue/src/session/rewindControls.ts postClose > then:callback": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindControls.ts postRenew > then:callback.1": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindControls.ts postRenew > then:callback.2": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > install > DebugHistoryView:callback": [
    "read",
    ["BridgeClient.post"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > install > DebugHistoryView:callback > catch:callback":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > forward > step:callback": [
    "resume",
    ["BridgeClient.post"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > gate > then:callback.1": [
    "resume",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > gate > then:callback.2": [
    "resume",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/rewindOwner.ts createRewindOwner > reportUnless > function": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > tryOnScopeDispose:callback": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > clearScriptStorage": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > showSession": [
    "resume",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/useSessionRewind.ts useSessionRewind > followSessions > watch:callback#1":
    ["lifecycle", ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"]],
  // The session's follow posts the renewal that waits for the generation's first session (#2150).
  "player/vue/src/session/useSessionRewind.ts useSessionRewind > followSessions > watch:callback#2":
    ["lifecycle", ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/useSessionRewind.ts useSessionRewind > followSessions > tryOnScopeDispose:callback":
    ["lifecycle", ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"]],
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
  // The composable's test read of the recording the host holds (`readRecording`).
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > debugRecording": [
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
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/hostedScript.ts prepareHostedScript > then:callback > catch:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/main.ts setup": [
    "composition",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
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
  "player/vue/src/session/usePlayerSessionServices.ts usePlayerSessionServices > watch:callback#4":
    ["read", ["BridgeClient.request"]],
  "player/vue/src/development/scenarioStart.ts prepareScenario": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/development/scenarioStart.ts prepareScenario > then:callback#1": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/development/scenarioStart.ts prepareScenario > then:callback#2": [
    "creation",
    ["BridgeClient.request"],
  ],
  "player/vue/src/development/scenarioStart.ts prepareScenario > catch:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
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
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > forward": [
    "resume",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > resume": [
    "resume",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > returnToSession": [
    "resume",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/history/useDebugRewind.ts useDebugRewind > then:callback.1": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
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
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > skip": [
    "own observation",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/useDevelopmentTime.ts useDevelopmentTime > watch:callback#2 > setTimeout:callback":
    ["own observation", ["BridgeClient.request"]],
  "player/vue/src/debug/usePlayerDebug.ts usePlayerDebug": [
    "composition",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
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
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/debug/usePlayerDebug.ts usePlayerDebug > watch:callback#3.2 > run:callback": [
    "composition",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
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
    ["BridgeClient.request", "BridgeClient.signal"],
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
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > importSession": [
    "creation",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/persistence/useSessionTransfer.ts useSessionTransfer > importSession > owned:callback":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
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
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > prepareKept > owned:callback > commit:callback#2":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/activation/work/continue.ts continueRestored > catch:callback": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > pressPermanentButton": [
    "own observation",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
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
    ["BridgeClient.request", "BridgeClient.signal"],
  ],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > rooms > resetDebug": [
    "creation",
    ["BridgeClient.request", "BridgeClient.signal"],
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
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > startFrom > then:callback#1":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  // The begin's own reaction, which settles it through the record's `settle`: its success is the creation, its
  // failure the error stop, as at the base.
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > startFrom > then:callback#2.1":
    ["creation", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > startFrom > then:callback#2.2":
    ["lifecycle", ["BridgeClient.request", "BridgeClient.signal"]],
  "player/vue/src/session/useEngineConnection.ts useEngineConnection > then:callback": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  // The loss of the current connection: the Player's stop, whose work (`bridgeLost`) the readiness callback and the
  // replacement reach through it, as they take a connection.
  "player/vue/src/session/useEngineConnection.ts useEngineConnection > take > onLoss:callback": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  // The replacement of a lost connection from the player's click: it takes the fresh bridge as the readiness callback
  // does, and prepares the script in it.
  "player/vue/src/session/useEngineConnection.ts useEngineConnection > replace": [
    "lifecycle",
    ["BridgeClient.post", "BridgeClient.request", "BridgeClient.signal"],
  ],
  // The script's preparation, sent once the connection is ready when it was not yet: what the page's preparers send.
  "player/vue/src/session/useEngineConnection.ts useEngineConnection > prepareScriptSource > then:callback":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > restoreForRecovery > owned:callback":
    ["creation", ["BridgeClient.request"]],
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > toStartPage": [
    "lifecycle",
    ["BridgeClient.request", "BridgeClient.signal"],
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
export const ESCAPES: Readonly<Record<string, Policy>> = {
  // The reply hooks a request passes on: a debug export's capture releases its ticket from its hook.
  "player/engine-bridge/client.ts openBridge > Promise:callback > request > exclusive:callback {onReply}":
    "bridge plumbing",
  // A request of no session passes its hook to the post it makes at once.
  "player/engine-bridge/client.ts openBridge > Promise:callback > request {onReply}":
    "bridge plumbing",
  "player/runtime/player-bridge.ts PlayerBridge > request > #send:callback {onReply}":
    "bridge plumbing",
  "player/encryption/lock-service.ts LockService > #present > wake {wake}": "own observation",
  "player/vue/src/session/useCallView.ts useCallView {followCallView}": "lifecycle",
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
  // A history control's failure, which decides `closeSettled` or reports, at its reply's settlement.
  "player/vue/src/session/rewindControls.ts postClose {failed}": "lifecycle",
  "player/vue/src/session/rewindControls.ts postClose {reportPageError}": "lifecycle",
  "player/vue/src/session/rewindControls.ts postRenew {reportPageError}": "lifecycle",
};

/** The escapes the census follows: an object literal's property, or a destructured binding, that holds a forwarder. */
export const FOLLOWED: readonly string[] = [
  // The engine connection's owner: the composable's hooks it calls, and the script's preparation it gives the pages.
  "player/vue/src/session/useEngineConnection.ts useEngineConnection {lost}",
  "player/vue/src/session/useEngineConnection.ts useEngineConnection {ready}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > lost {lost}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > prepareScriptSource {prepareScriptSource}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {prepareScriptSource}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > discardSessionReview {discardSessionReview}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > readTransfer {readTransfer}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > reviewSessionImport {reviewSessionImport}",
  "player/engine-bridge/client.ts openBridge > Promise:callback > request {request}",
  "player/engine-bridge/client.ts openBridge > Promise:callback > post {post}",
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
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > catchUp {catchUp}",
  "player/vue/src/session/useRuntimeSceneClock.ts useRuntimeSceneClock > observe {observe}",
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
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > rebindScript {rebindScript}",
  "player/vue/src/session/persistence/useKeptSession.ts useKeptSession > restoreForRecovery {restoreForRecovery}",
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
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > heldDebugRecording {heldDebugRecording}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession > debugRecording {heldDebugRecording}",
  "player/vue/src/session/usePlayerSession.ts usePlayerSession {heldDebugRecording}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > activate {activate}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > prepare {prepare}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > continueRecipe > begin {begin}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > startRecipe > begin {begin}",
  "player/vue/src/session/activation/useSessionActivation.ts useSessionActivation > prepareRestore {prepareRestore}",
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
export type HistoryPassage = "publication observation" | "introduction" | "none";
/** How an op's result session is adopted in the host (item 15): each entry point that reaches `publish` or `keep`. */
export type Adoption =
  | "result"
  | "catch-up adoption"
  | "recorder attachment"
  | "introduction"
  | "host dispatch"
  | "facade exception";
export const ADOPTIONS: Readonly<
  Record<string, readonly [Adoption, readonly string[], HistoryPassage]>
> = {
  "player/engine-bridge/engine-host.ts (module)": [
    "host dispatch",
    ["HeldSession.keep", "HeldSession.publish"],
    "publication observation",
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
export const ADOPTION_ESCAPES: readonly string[] = [
  "player/engine-bridge/ops/history.ts historyControlOps > captureStorage > run {run}",
  "player/engine-bridge/ops/history.ts historyControlOps > historyClose > run {run}",
  "player/engine-bridge/ops/history.ts rewindSettleOps > rewindCommit > run {run}",
  "player/engine-bridge/ops/history.ts rewindSettleOps > rewindDrop > run {run}",
  "player/engine-bridge/ops/history.ts historyControlOps > historyRenew > run {run}",
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
  "player/engine-bridge/ops/recording.ts recordingRunOps > readRecording > run {run}",
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
