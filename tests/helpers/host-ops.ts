/*
 * Every op of the composed host (`playerBridgeOps`), once, with each fact the families need of it: its plan JSON role
 * (a producer, whose outcomes `plan-json-family.ts` declares, or why it is none) and whether it is a session-free read
 * (`READ_OPS`). The checks compare this inventory with the composed host and with `READ_OPS` both ways, so a new op
 * fails until it is classified here.
 */

const SESSION_OP =
  "a held session's step, input or view: the session holds its plan, whose JSON it never writes";
const SERVICE_OP = "a held session's answer from a service of the page: no plan";
const DEBUG_SOURCE_OP = "Debug's source view of a held plan, from its sources, not its JSON";
const RANDOM_OP = "Debug's random control and history on the connection: draws and sites, no plan";
const REWIND_OP =
  "Debug's rewind history on the connection: snapshots of held sessions and their restores, whose plan stays held; no plan JSON";

/** One op's facts. */
export interface HostOp {
  /** `producer`, or why the op touches no plan JSON a reader could keep. */
  readonly planJson: "producer" | string;
  /** Whether `PlayerBridge.read` reads it (`READ_OPS`). */
  readonly read: boolean;
}

export const HOST_OPS = {
  captureStorage: { planJson: "a held session's saved values, for a rewind adoption", read: true },
  releasePlanText: { planJson: "cleanup: the one remover of a reserved plan JSON", read: false },
  captureCheckpoint: {
    planJson: "a whole checkpoint, which holds the plan inside it; no plan JSON of its own",
    read: true,
  },
  prepare: {
    planJson: "holds a plan under a new token; its JSON is written only when reserved",
    read: false,
  },
  planMetadata: { planJson: "a held plan's metadata, read from the plan", read: false },
  teardown: { planJson: "cleanup: lets go of every plan's JSON with the plans", read: false },
  readTransfer: { planJson: "parses a document; it reaches no held plan", read: false },
  transferCommit: {
    planJson: "the reviewed state and the events' JSON, kept under the ticket",
    read: false,
  },
  releaseTransfer: { planJson: "cleanup of a ticket, which holds no plan JSON", read: false },
  captureRecording: {
    planJson: "a held session's recording under a ticket; its plan stays in the host, no plan JSON",
    read: true,
  },
  releaseRecording: { planJson: "cleanup of a ticket, which holds no plan JSON", read: false },
  captureExport: {
    planJson: "a debug export's capture under a ticket; its plan stays in the host, no plan JSON",
    read: false,
  },
  exportPrepare: { planJson: "a plan's hash and replay checkpoints; no plan JSON", read: false },
  retireRun: { planJson: "a debug export's diagnostic run; no plan", read: false },
  commitIncident: {
    planJson: "a debug export's incident of a run with no session; no plan",
    read: false,
  },
  debugTracing: { planJson: "the connection's value trace", read: false },
  debugView: { planJson: "a held session's trace view", read: true },
  restartTrace: { planJson: "a held session's trace, begun anew", read: false },
  setDebugMode: { planJson: "a held session's Debug state", read: false },
  start: { planJson: SESSION_OP, read: false },
  continue: { planJson: SESSION_OP, read: false },
  observeTime: { planJson: SESSION_OP, read: false },
  observeInput: { planJson: SESSION_OP, read: false },
  stepTime: { planJson: SESSION_OP, read: false },
  beginCatchUp: { planJson: SESSION_OP, read: false },
  stepCatchUp: { planJson: SESSION_OP, read: false },
  adoptCatchUp: { planJson: SESSION_OP, read: false },
  dropCatchUp: { planJson: SESSION_OP, read: false },
  skipPacing: { planJson: SESSION_OP, read: false },
  viewCalls: { planJson: SESSION_OP, read: false },
  beginRecording: { planJson: SESSION_OP, read: false },
  submitComposer: { planJson: SESSION_OP, read: false },
  selectChoice: { planJson: SESSION_OP, read: false },
  activateButton: { planJson: SESSION_OP, read: false },
  stepFormField: { planJson: SESSION_OP, read: false },
  dismissFormField: { planJson: SESSION_OP, read: false },
  clearFormField: { planJson: SESSION_OP, read: false },
  draftForm: { planJson: SESSION_OP, read: false },
  submitForm: { planJson: SESSION_OP, read: false },
  cancelForm: { planJson: SESSION_OP, read: false },
  skipImage: { planJson: SESSION_OP, read: false },
  answerImage: { planJson: SESSION_OP, read: false },
  openUrl: { planJson: SESSION_OP, read: false },
  closePopup: { planJson: SESSION_OP, read: false },
  closeExport: { planJson: SESSION_OP, read: false },
  pressPermanentButton: { planJson: SESSION_OP, read: false },
  completeStorageWrite: { planJson: SESSION_OP, read: false },
  applyStorageEdit: { planJson: SESSION_OP, read: false },
  reportMediaLoad: { planJson: SESSION_OP, read: false },
  answerCapture: { planJson: SERVICE_OP, read: false },
  answerFileStore: { planJson: SERVICE_OP, read: false },
  answerLock: { planJson: SERVICE_OP, read: false },
  drawCode: { planJson: DEBUG_SOURCE_OP, read: false },
  codeLines: { planJson: DEBUG_SOURCE_OP, read: false },
  randomControl: { planJson: RANDOM_OP, read: false },
  adoptRandom: { planJson: RANDOM_OP, read: false },
  releaseRandom: { planJson: RANDOM_OP, read: false },
  resolveDraw: { planJson: RANDOM_OP, read: false },
  randomTried: { planJson: RANDOM_OP, read: true },
  preparePlanText: { planJson: "producer", read: false },
  restoreKept: { planJson: "producer", read: false },
  planText: { planJson: "producer", read: false },
  captureKeep: { planJson: "producer", read: true },
  reviewTransfer: { planJson: "producer", read: false },
  historyOpen: { planJson: REWIND_OP, read: false },
  historyEnroll: { planJson: REWIND_OP, read: false },
  historyClose: { planJson: REWIND_OP, read: false },
  historyTimeline: { planJson: REWIND_OP, read: false },
  rewindBack: { planJson: REWIND_OP, read: false },
  rewindForward: { planJson: REWIND_OP, read: false },
  rewindCommit: { planJson: REWIND_OP, read: false },
  rewindDrop: { planJson: REWIND_OP, read: false },
  rewindReturn: { planJson: REWIND_OP, read: false },
  rewindAdopt: { planJson: REWIND_OP, read: false },
} as const satisfies Record<string, HostOp>;
