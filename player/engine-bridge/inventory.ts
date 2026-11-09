/*
 * What the Player's main realm may load once the engine runs in its Worker, and what still has to move there (the L5
 * series). `tests/player-main-realm.test.ts` checks each list against the source: the `src/` modules the main realm
 * reaches, the imports that still reach Worker-side code, and the exports of `runtime-adapter.ts` and `runtime-view.ts`.
 *
 * `RATCHET` only shrinks: a family's PR removes the entries tagged with its family and adds none (its reviewers check
 * this). The one exception is L5b's: it added the main realm's imports of the transition facade (`in-process.ts`), each
 * tagged with the family that removes that importer's last use. Activation requires `RATCHET` empty, and the L5 gate
 * requires `in-process.ts`'s facade gone, not only its entries.
 */

/** The bridge families of the L5 series that move engine work into the Worker. */
export type BridgeFamily =
  "L5b" | "L5c" | "L5d" | "L5e" | "L5f" | "L5g" | "L5h" | "L5i" | "activation";

/** Families whose PRs have landed: none of their entries may remain in `RATCHET`. */
export const COMPLETED_FAMILIES: readonly BridgeFamily[] = [
  "L5b",
  "L5c",
  "L5d",
  "L5e",
  "L5f",
  "L5g",
  "L5h",
];

/** The `src/` modules the main realm may load, grouped by why. */
export const ALLOWED_SOURCE: readonly {
  readonly reason: string;
  readonly modules: readonly string[];
}[] = [
  {
    reason: "Values, numbers, text and colours, as the Player formats and checks them",
    modules: [
      "src/angle.ts",
      "src/code-points.ts",
      "src/color.ts",
      "src/conversions.ts",
      "src/deterministic-math.ts",
      "src/dict-operations.ts",
      "src/duration.ts",
      "src/list-methods.ts",
      "src/runtime/errors.ts",
      "src/runtime/values/plain-data.ts",
      "src/runtime/values/serializable-values.ts",
      "src/runtime/values/temporal-operations.ts",
      "src/runtime/values/text-length.ts",
      "src/runtime/values/value-predicates.ts",
      "src/runtime/values/value-text.ts",
      "src/runtime/values/value-types.ts",
      "src/text-operations.ts",
      "src/value-kinds.ts",
    ],
  },
  {
    reason: "Language facts and rules that presentation and answer checks read",
    modules: [
      "src/argument-rules.ts",
      "src/choice-rules.ts",
      "src/choice-values.ts",
      "src/delay-rules.ts",
      "src/form-fields.ts",
      "src/handle-members.ts",
      "src/handle-rules.ts",
      "src/image-input.ts",
      "src/interaction-answers.ts",
      "src/interaction-limits.ts",
      "src/language-facts.ts",
      "src/loop-rules.ts",
      "src/message-markup.ts",
      "src/message-presentation.ts",
      "src/public-keys.ts",
      "src/save-rules.ts",
      "src/shown-text-rules.ts",
      "src/speaker-terms.ts",
      "src/tag-query.ts",
      "src/tags.ts",
      "src/temporal-builtins.ts",
      "src/web-url.ts",
    ],
  },
  {
    reason: "Plan and source format types and constants; no plan is held",
    modules: [
      "src/plan/model.ts",
      "src/plan/source-location.ts",
      "src/project-paths.ts",
      "src/source.ts",
      "src/token.ts",
    ],
  },
  {
    reason:
      "Checks of host and storage data at the Player's persistence boundaries, and the checkpoint format's JSON writer",
    modules: [
      "src/external-data-capture.ts",
      "src/plan/validation-support.ts",
      "src/runtime/event-validation.ts",
      "src/runtime/host-data/script-storage.ts",
      "src/runtime/host-data/stored-files.ts",
      "src/runtime/host-data/temporal-captures.ts",
      "src/runtime/snapshot/checkpoint-json.ts",
      "src/runtime/snapshot/snapshot-format.ts",
    ],
  },
  {
    reason: "Readers of a published session's actions, media, timed work, draws and previews",
    modules: [
      "src/runtime/actions/choice-options.ts",
      "src/runtime/actions/form.ts",
      "src/runtime/actions/interrupts.ts",
      "src/runtime/actions/model.ts",
      "src/runtime/background/exact-interpolation.ts",
      "src/runtime/background/media.ts",
      "src/runtime/debug/debug-preview.ts",
      "src/runtime/debug/debug-trace-limits.ts",
      "src/runtime/operations/timed-work.ts",
      "src/runtime/random/random-alternatives.ts",
      "src/runtime/random/random-kinds.ts",
      "src/runtime/scopes/capture-copy.ts",
    ],
  },
  {
    reason: "The Start context: the host's time zone and presentation, sampled in the page",
    modules: ["src/temporal-capture.ts", "src/temporal.ts"],
  },
  {
    reason: "Regular expressions (RE2) for the text helpers above",
    modules: ["src/regex-case-pairs.ts", "src/regex-engine.ts", "src/regex.ts"],
  },
  {
    reason: "Test-only work counters, inert in production",
    modules: ["src/validation-testing.ts"],
  },
];

/** The Player modules that run in the engine Worker. */
export const WORKER_MODULES: readonly string[] = [
  "player/runtime-adapter.ts",
  "player/script-identity.ts",
  "player/engine-bridge/engine-host.ts",
  "player/engine-bridge/player-ops.ts",
  "player/compile-project.ts",
  "player/debug-recorder.ts",
  "player/debug-view.ts",
  "player/random-decisions.ts",
  "player/engine-bridge/in-process.ts",
];

/** A main-realm import of a value from Worker-side code, and the bridge family it belongs to. */
export interface RatchetEntry {
  readonly importer: string;
  readonly target: string;
  readonly name: string;
  readonly family: BridgeFamily;
}

export const RATCHET: readonly RatchetEntry[] = [
  // L5i
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "applyExternalStorageEdit",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "completeAction",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "createCheckpoint",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "createRuntimeSession",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "observeTime",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "pendingRandomDraw",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "pressPermanentButton",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "recordContinueCapture",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "replayRandomChoices",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "reportMediaLoad",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "restoreCheckpoint",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "resumeRandomDraw",
    family: "L5i",
  },
  { importer: "player/debug-export.ts", target: "src/playback.ts", name: "run", family: "L5i" },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "serializeCheckpoint",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "setDebugMode",
    family: "L5i",
  },
  {
    importer: "player/debug-export.ts",
    target: "src/playback.ts",
    name: "updateInteraction",
    family: "L5i",
  },
  {
    importer: "player/vue/src/DevelopmentPreview.vue",
    target: "player/compile-project.ts",
    name: "createPlayerRuntimeSession",
    family: "L5i",
  },
  {
    importer: "player/vue/src/usePlayerSession.ts",
    target: "player/engine-bridge/in-process.ts",
    name: "heldPlan",
    family: "L5i",
  },
  {
    importer: "player/vue/src/session/activation/useSessionActivation.ts",
    target: "player/engine-bridge/in-process.ts",
    name: "heldRecording",
    family: "L5i",
  },
  {
    importer: "player/vue/src/session/activation/useSessionActivation.ts",
    target: "player/engine-bridge/in-process.ts",
    name: "introduceNow",
    family: "L5i",
  },
  // activation
  {
    importer: "player/vue/src/usePlayerSession.ts",
    target: "player/engine-bridge/in-process.ts",
    name: "createInProcessBackend",
    family: "activation",
  },
];

/** How each export of `runtime-adapter.ts` leaves the main realm: an engine op, a reader of the plan or of the session, or the engine itself. */
export const ADAPTER_EXPORTS: Readonly<
  Record<
    string,
    {
      readonly kind: "op" | "planReader" | "sessionReader" | "engine";
      readonly family: BridgeFamily;
    }
  >
> = {
  PlayerRuntimeEngine: { kind: "engine", family: "L5b" },
  createPlayerRuntimeSession: { kind: "op", family: "L5b" },
  createPlayerRuntimeRestorePoint: { kind: "op", family: "L5h" },
  restorePlayerRuntimeSession: { kind: "op", family: "L5h" },
  playerRuntimeSnapshot: { kind: "op", family: "L5h" },
  playerRuntimeSnapshotOrNull: { kind: "op", family: "L5h" },
  playerRuntimeSnapshotJson: { kind: "op", family: "L5h" },
  playerRuntimeDebugVariables: { kind: "op", family: "L5i" },
  beginPlayerRuntimeRecording: { kind: "op", family: "L5b" },
  restorePlayerRuntimeSessionAt: { kind: "op", family: "L5i" },
  withPlayerRuntimeDebugTrace: { kind: "op", family: "L5i" },
  answeredByPlayerInput: { kind: "op", family: "L5c" },
  answerPlayerRuntimeCapture: { kind: "op", family: "L5e" },
  answerPlayerRuntimeFileStore: { kind: "op", family: "L5e" },
  answerPlayerRuntimeLock: { kind: "op", family: "L5e" },
  submitPlayerRuntimeComposer: { kind: "op", family: "L5c" },
  answerPlayerRuntimeImage: { kind: "op", family: "L5c" },
  stepPlayerRuntimeFormField: { kind: "op", family: "L5c" },
  commitPlayerRuntimeFormField: { kind: "op", family: "L5c" },
  dismissPlayerRuntimeFormField: { kind: "op", family: "L5c" },
  clearPlayerRuntimeFormField: { kind: "op", family: "L5c" },
  draftPlayerRuntimeForm: { kind: "op", family: "L5c" },
  submitPlayerRuntimeForm: { kind: "op", family: "L5c" },
  cancelPlayerRuntimeForm: { kind: "op", family: "L5c" },
  skipPlayerRuntimeImage: { kind: "op", family: "L5c" },
  openPlayerRuntimeUrl: { kind: "op", family: "L5c" },
  closePlayerRuntimePopup: { kind: "op", family: "L5c" },
  closePlayerRuntimeExport: { kind: "op", family: "L5c" },
  activatePlayerRuntimeButton: { kind: "op", family: "L5c" },
  selectPlayerRuntimeChoice: { kind: "op", family: "L5c" },
  skipPlayerRuntimePacing: { kind: "op", family: "L5b" },
  continuePlayerRuntimeSession: { kind: "op", family: "L5b" },
  observePlayerRuntimeTime: { kind: "op", family: "L5b" },
  stepPlayerRuntimeTime: { kind: "op", family: "L5b" },
  advancePlayerRuntimeTime: { kind: "op", family: "L5b" },
  beginPlayerRuntimeCatchUp: { kind: "op", family: "L5b" },
  stepPlayerRuntimeCatchUp: { kind: "op", family: "L5b" },
  adoptPlayerRuntimeCatchUp: { kind: "op", family: "L5b" },
  dropPlayerRuntimeCatchUp: { kind: "op", family: "L5b" },
  reportPlayerRuntimeMediaLoad: { kind: "op", family: "L5d" },
  applyPlayerRuntimeStorageEdit: { kind: "op", family: "L5c" },
  setPlayerRuntimeDebugMode: { kind: "op", family: "L5i" },
  pressPlayerRuntimePermanentButton: { kind: "op", family: "L5c" },
  setPlayerRuntimeRandomControl: { kind: "op", family: "L5i" },
  resumePlayerRuntimeRandomDraw: { kind: "op", family: "L5i" },
  completePlayerRuntimeStorageWrite: { kind: "op", family: "L5c" },
};

/** The exports of `runtime-view.ts`: readers of a published session state, which stay in the main realm. */
export const VIEW_READERS: readonly string[] = [
  "playerTemporalContext",
  "playerRuntimeForm",
  "playerRuntimeForeground",
  "playerRuntimeTimers",
  "playerRuntimeDeadlines",
  "playerRuntimePacingGate",
  "activePlayerRuntimeInteraction",
  "activePlayerRuntimePacingGate",
  "activePlayerRuntimeCapture",
  "activePlayerRuntimeFileStore",
  "activePlayerRuntimeLock",
  "playerRuntimeInteractionActionIds",
  "playerRuntimeUrlRequest",
  "nextPlayerRuntimeEventMs",
  "playerRuntimeAwaitsHost",
  "nextPlayerRuntimeCatchUpStepMs",
  "playerRuntimePermanentButtons",
  "playerRuntimeCameraView",
  "playerRuntimeMedia",
  "playerRuntimeMediaOrigin",
  "playerRuntimeDebugCountdown",
  "playerRuntimeCalls",
  "playerRuntimeDebugNow",
  "pendingPlayerRuntimeStorageWrite",
  "playerRuntimeTranscriptEventSequence",
  "playerRuntimeTranscript",
  "playerRuntimeTranscriptMessage",
  "appendTranscript",
  "activeInteraction",
  "choiceOptionId",
  "DEFAULT_SPEAKERS",
];
