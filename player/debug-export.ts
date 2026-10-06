import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CheckpointError,
  completeAction,
  createCheckpoint,
  INSTRUCTION_PLAN_VERSION,
  observeTime,
  pressPermanentButton,
  recordContinueCapture,
  applyExternalStorageEdit,
  reportMediaLoad,
  restoreCheckpoint,
  run,
  RUNTIME_SNAPSHOT_VERSION,
  serializeCheckpoint,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeCheckpoint,
  type RuntimeSnapshot,
} from "../src/index.js";
import { instructionSourcePath } from "../src/plan/model.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/checkpoint.js";
import { isWellFormedCapturedMediaReference } from "./captured-media.js";
import {
  base64urlSlices,
  decodeBase64url,
  jsonFile,
  measuredJsonFile,
} from "./transfer-encoding.js";

/**
 * A debug export: what a developer needs to find why a Player session failed, gathered with the player's consent. The
 * technical report locates the failure without runtime values. With the player's consent it also carries the canonical
 * checkpoint, the snapshot an earlier boundary left (the replay anchor), and every engine call the Player made since, so
 * `replayDebugExport` can run the same calls again; and photos the session used, linked to where they were used. The
 * file is untrusted external data wherever it is read.
 */
export interface DebugExport {
  readonly format: typeof DEBUG_EXPORT_FORMAT;
  readonly version: typeof DEBUG_EXPORT_VERSION;
  readonly build: DebugBuild;
  readonly package: DebugPackage;
  readonly incident: DebugIncident;
  /** The player's choices; `replay` requires `savedValues`, `answers`, and `sessionText`, because state copies them. */
  readonly selection: DebugSelection;
  /** Why parts are missing, in words for the developer. */
  readonly omissions: readonly string[];
  readonly checkpoint: RuntimeCheckpoint | null;
  /**
   * `current`: the state after the last recorded call, which a replay must reach. `lastGood`: the state could not be
   * checkpointed, so this is the last valid one, which is also the replay anchor.
   */
  readonly checkpointRole: "current" | "lastGood" | null;
  readonly replay: DebugReplay | null;
  readonly photos: readonly DebugPhoto[];
  /** Readable sections such as recent events or the Debug log, by name; replay never reads them. */
  readonly sections: Readonly<Record<string, unknown>>;
}

export interface DebugBuild {
  readonly commit: string | null;
  /** Whether the build had uncommitted changes; `null` when unknown. */
  readonly dirty: boolean | null;
  readonly mode: string | null;
  readonly appVersion: string | null;
  readonly checkpointVersion: number;
  readonly planVersion: number;
  readonly snapshotVersion: number;
}

/** What the trusted host knows of the script; unknown fields are `null`, never guessed. */
export interface DebugPackage {
  readonly id: string | null;
  readonly version: string | null;
  readonly contentHash: string | null;
}

export interface DebugIncident {
  /** A script failure, an exception of the Player itself, or an export the player asked for. */
  readonly kind: "runtimeFailure" | "hostError" | "requested";
  readonly code: string | null;
  readonly path: string | null;
  /** One-based line and column. */
  readonly line: number | null;
  readonly column: number | null;
  /** The error name of a Player exception, never its message. */
  readonly hostError: string | null;
}

export interface DebugSelection {
  readonly savedValues: boolean;
  readonly answers: boolean;
  readonly replay: boolean;
  readonly sessionText: boolean;
  readonly photos: boolean;
  readonly player: boolean;
}

export interface DebugReplay {
  /** The snapshot the calls start from; `null` when the checkpoint is the last good state and itself the anchor. */
  readonly anchorSnapshot: RuntimeSnapshot | null;
  readonly operations: readonly DebugOperation[];
  /** Whether every call since the anchor is recorded; otherwise `reason` says why not. */
  readonly complete: boolean;
  readonly reason: string | null;
}

export type DebugOperationKind = (typeof OPERATION_KINDS)[number];

/**
 * One engine call the Player made, with the plain arguments it passed after the plan and snapshot: `run` takes its run
 * options; `observeTime` the time and media reports; `completeAction` the request; `reportMediaLoad` the media and
 * report; `pressPermanentButton` the button; `recordContinueCapture` the capture; `applyExternalStorageEdit` the edit.
 */
export interface DebugOperation {
  readonly seq: number;
  readonly kind: DebugOperationKind;
  readonly args: readonly unknown[];
  /** The answers the Player's media store gave during a `completeAction`, in order. */
  readonly admissionQueries: readonly DebugAdmissionQuery[];
  /** The outcome kind, `ran` for `run`, or `null` when the call threw. */
  readonly outcome: string | null;
  /** The sequence of the first event the call emitted, and how many it emitted. */
  readonly events: { readonly first: number | null; readonly count: number };
  /** The session status after the call; unchanged when it threw. */
  readonly status: RuntimeSnapshot["status"];
  /** The error name when the call threw. */
  readonly thrown: string | null;
}

export interface DebugAdmissionQuery {
  readonly reference: string;
  readonly kind: "image";
  readonly result: boolean;
}

/** A photo the session used; `data` is its original bytes when the player chose to include them. */
export interface DebugPhoto {
  readonly reference: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly data: Uint8Array<ArrayBuffer> | null;
  readonly usedBy: readonly DebugPhotoUse[];
}

/** Where a photo was used: the recorded call and the action it answered, or the saved value it was loaded from. */
export interface DebugPhotoUse {
  readonly relation: "capture" | "imageAnswer" | "savedValue";
  readonly operation: number | null;
  readonly actionId: number | null;
}

/** Why a file is not a debug export this tool can read; `unsupported` is a valid export of another version. */
export class DebugExportError extends Error {
  override readonly name = "DebugExportError";
  constructor(
    readonly kind: "invalid" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

export const DEBUG_EXPORT_FORMAT = "teasescript-debug-export";
// 2: adds the `applyExternalStorageEdit` call.
export const DEBUG_EXPORT_VERSION = 2;
/** The most JSON a reader decompresses or parses; a diagnostic-tool limit, not a TeaseScript one. */
export const DEBUG_EXPORT_MAX_JSON_BYTES = 64 * 1024 * 1024;

const OPERATION_KINDS = [
  "run",
  "observeTime",
  "completeAction",
  "reportMediaLoad",
  "pressPermanentButton",
  "recordContinueCapture",
  "applyExternalStorageEdit",
] as const;
const ARITY: Readonly<Record<DebugOperationKind, number>> = {
  run: 1,
  observeTime: 2,
  completeAction: 1,
  reportMediaLoad: 2,
  pressPermanentButton: 1,
  recordContinueCapture: 1,
  applyExternalStorageEdit: 1,
};
const STATUSES = ["ready", "running", "waiting", "halted", "failed"] as const;
const SELECTION_FIELDS = [
  "savedValues",
  "answers",
  "replay",
  "sessionText",
  "photos",
  "player",
] as const;
const SECTION_NAMES: readonly string[] = [
  "eventsTail",
  "transcriptTail",
  "player",
  "errors",
  "debugLog",
  "debugTrace",
  "storage",
  "answers",
  "media",
];

/** The revisions of this build, for an export's `build`. */
export function debugBuildRevisions(): Pick<
  DebugBuild,
  "checkpointVersion" | "planVersion" | "snapshotVersion"
> {
  return {
    checkpointVersion: CHECKPOINT_VERSION,
    planVersion: INSTRUCTION_PLAN_VERSION,
    snapshotVersion: RUNTIME_SNAPSHOT_VERSION,
  };
}

/** The file name for a debug export of the named script. */
export function debugExportFileName(name: string, gzip: boolean): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 80);
  return `${safe || "script"}-debug.teasedebug.json${gzip ? ".gz" : ""}`;
}

/** The export as a file: gzip, or plain JSON without `gzip`. Its checkpoint and anchor are validated on the way. */
export function debugExportFile(exported: DebugExport, gzip: boolean): Promise<Blob> {
  return jsonFile(pieces(exported), gzip);
}

/** `debugExportFile`, with the size of the uncompressed JSON in UTF-8 bytes. */
export function measuredDebugExportFile(
  exported: DebugExport,
  gzip: boolean,
): Promise<{ readonly file: Blob; readonly jsonBytes: number }> {
  return measuredJsonFile(pieces(exported), gzip);
}

/** The document in pieces: deep runtime state is written without recursion, photo data slice by slice. */
function* pieces(exported: DebugExport): Generator<string> {
  const { checkpoint, replay, photos, sections } = exported;
  yield `{"format":${JSON.stringify(DEBUG_EXPORT_FORMAT)},"version":${DEBUG_EXPORT_VERSION},`;
  for (const field of ["build", "package", "incident", "selection", "omissions"] as const)
    yield `\n${JSON.stringify(field)}:${JSON.stringify(exported[field])},`;
  yield `\n"checkpoint":${checkpoint === null ? "null" : serializeCheckpoint(checkpoint)},`;
  yield `\n"checkpointRole":${JSON.stringify(exported.checkpointRole)},`;
  if (replay === null) yield `\n"replay":null,`;
  else {
    const anchor =
      replay.anchorSnapshot === null || checkpoint === null
        ? "null"
        : serializeValidatedRuntimeJson(
            createCheckpoint(checkpoint.plan, replay.anchorSnapshot).snapshot,
          );
    yield `\n"replay":{"complete":${replay.complete},"reason":${JSON.stringify(replay.reason)},"anchorSnapshot":${anchor},"operations":[`;
    for (const [index, operation] of replay.operations.entries())
      yield `${index === 0 ? "\n" : ",\n"}${serializeValidatedRuntimeJson(operation)}`;
    yield "]},";
  }
  yield `\n"photos":[`;
  for (const [index, photo] of photos.entries()) {
    const { data, ...descriptor } = photo;
    yield `${index === 0 ? "\n" : ",\n"}${JSON.stringify(descriptor).slice(0, -1)},"data":`;
    if (data === null) yield "null}";
    else {
      yield '"';
      yield* base64urlSlices(data);
      yield '"}';
    }
  }
  yield `],\n"sections":${serializeValidatedRuntimeJson(sections)}}\n`;
}

/** JSON text of plain data from an export, such as recorded arguments, written without recursion. */
export function debugExportJson(value: unknown): string {
  return serializeValidatedRuntimeJson(value);
}

/** Reads a debug export's JSON as untrusted data: every field, the checkpoint and anchor through checkpoint validation. */
export function parseDebugExport(json: string): DebugExport {
  try {
    return parseDocument(json);
  } catch (error) {
    if (error instanceof DebugExportError) throw error;
    // Untrusted data must be refused, never crash the reader, whatever the validation it met.
    throw new DebugExportError(
      "invalid",
      `The export could not be validated (${error instanceof Error ? error.name : "error"}).`,
    );
  }
}

function parseDocument(json: string): DebugExport {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw new DebugExportError("invalid", "The file is not JSON.");
  }
  const root = record(document, "$");
  if (root["format"] !== DEBUG_EXPORT_FORMAT)
    throw new DebugExportError("invalid", "The file is not a TeaseScript debug export.");
  if (root["version"] !== DEBUG_EXPORT_VERSION)
    throw new DebugExportError(
      "unsupported",
      `The export has ${typeof root["version"] === "number" ? `version ${root["version"]}` : "no version number"}; this tool reads version ${DEBUG_EXPORT_VERSION}. Use a checkout of the build it names.`,
    );
  exactly(root, "$", [
    "format",
    "version",
    "build",
    "package",
    "incident",
    "selection",
    "omissions",
    "checkpoint",
    "checkpointRole",
    "replay",
    "photos",
    "sections",
  ]);
  const build = parseBuild(root["build"]);
  const selection = parseSelection(root["selection"]);
  const checkpointRole = oneOf(root["checkpointRole"], "$.checkpointRole", [
    "current",
    "lastGood",
    null,
  ] as const);
  const checkpoint =
    root["checkpoint"] === null ? null : restore(root["checkpoint"], "$.checkpoint", build);
  if ((checkpoint === null) !== (checkpointRole === null))
    fail("$.checkpointRole", "must be null exactly when there is no checkpoint");
  // The checkpoint holds the same state as replay data, so it needs the same consent.
  if (checkpoint !== null && !selection.replay)
    fail("$.checkpoint", "is present although replay data was not selected");
  const replay = parseReplay(root["replay"], checkpoint, checkpointRole, build);
  if (replay !== null && !selection.replay)
    fail("$.replay", "is present although replay data was not selected");
  const photos = parsePhotos(root["photos"]);
  if (photos.length > 0 && !selection.photos)
    fail("$.photos", "are present although photos were not selected");
  return {
    format: DEBUG_EXPORT_FORMAT,
    version: DEBUG_EXPORT_VERSION,
    build,
    package: parsePackage(root["package"]),
    incident: parseIncident(root["incident"]),
    selection,
    omissions: strings(root["omissions"], "$.omissions"),
    checkpoint,
    checkpointRole,
    replay,
    photos,
    sections: parseSections(root["sections"]),
  };
}

function parseBuild(value: unknown): DebugBuild {
  const build = record(value, "$.build");
  exactly(build, "$.build", [
    "commit",
    "dirty",
    "mode",
    "appVersion",
    "checkpointVersion",
    "planVersion",
    "snapshotVersion",
  ]);
  return {
    commit: nullableString(build["commit"], "$.build.commit"),
    dirty: build["dirty"] === null ? null : boolean(build["dirty"], "$.build.dirty"),
    mode: nullableString(build["mode"], "$.build.mode"),
    appVersion: nullableString(build["appVersion"], "$.build.appVersion"),
    checkpointVersion: count(build["checkpointVersion"], "$.build.checkpointVersion"),
    planVersion: count(build["planVersion"], "$.build.planVersion"),
    snapshotVersion: count(build["snapshotVersion"], "$.build.snapshotVersion"),
  };
}

function parsePackage(value: unknown): DebugPackage {
  const found = record(value, "$.package");
  exactly(found, "$.package", ["id", "version", "contentHash"]);
  return {
    id: nullableString(found["id"], "$.package.id"),
    version: nullableString(found["version"], "$.package.version"),
    contentHash: nullableString(found["contentHash"], "$.package.contentHash"),
  };
}

function parseIncident(value: unknown): DebugIncident {
  const incident = record(value, "$.incident");
  exactly(incident, "$.incident", ["kind", "code", "path", "line", "column", "hostError"]);
  const line = incident["line"] === null ? null : count(incident["line"], "$.incident.line");
  const column =
    incident["column"] === null ? null : count(incident["column"], "$.incident.column");
  return {
    kind: oneOf(incident["kind"], "$.incident.kind", [
      "runtimeFailure",
      "hostError",
      "requested",
    ] as const),
    code: nullableString(incident["code"], "$.incident.code"),
    path: nullableString(incident["path"], "$.incident.path"),
    line,
    column,
    hostError: nullableString(incident["hostError"], "$.incident.hostError"),
  };
}

function parseSelection(value: unknown): DebugSelection {
  const selection = record(value, "$.selection");
  exactly(selection, "$.selection", SELECTION_FIELDS);
  const flag = (field: (typeof SELECTION_FIELDS)[number]) =>
    boolean(selection[field], `$.selection.${field}`);
  const chosen: DebugSelection = {
    savedValues: flag("savedValues"),
    answers: flag("answers"),
    replay: flag("replay"),
    sessionText: flag("sessionText"),
    photos: flag("photos"),
    player: flag("player"),
  };
  // State holds copies of saved values, answers, and session text, so replay data discloses all three.
  if (chosen.replay && !(chosen.savedValues && chosen.answers && chosen.sessionText))
    fail("$.selection.replay", "requires saved values, answers, and session text to be selected");
  return chosen;
}

function parseReplay(
  value: unknown,
  checkpoint: RuntimeCheckpoint | null,
  role: DebugExport["checkpointRole"],
  build: DebugBuild,
): DebugReplay | null {
  if (value === null) return null;
  const replay = record(value, "$.replay");
  exactly(replay, "$.replay", ["complete", "reason", "anchorSnapshot", "operations"]);
  if (checkpoint === null) fail("$.replay", "needs a checkpoint, whose plan it runs");
  const anchor = replay["anchorSnapshot"];
  // A last good checkpoint is the anchor itself; a current one is where the replay must end.
  if ((anchor === null) !== (role === "lastGood"))
    fail(
      "$.replay.anchorSnapshot",
      "must be null exactly when the checkpoint is the last good state",
    );
  const anchorSnapshot =
    anchor === null
      ? null
      : restore(
          {
            format: CHECKPOINT_FORMAT,
            version: build.checkpointVersion,
            plan: checkpoint.plan,
            snapshot: anchor,
          },
          "$.replay.anchorSnapshot",
          build,
        ).snapshot;
  const operations = array(replay["operations"], "$.replay.operations").map((entry, index) =>
    parseOperation(entry, `$.replay.operations[${index}]`, index),
  );
  return {
    anchorSnapshot,
    operations,
    complete: boolean(replay["complete"], "$.replay.complete"),
    reason: nullableString(replay["reason"], "$.replay.reason"),
  };
}

function parseOperation(value: unknown, path: string, index: number): DebugOperation {
  const operation = record(value, path);
  exactly(operation, path, [
    "seq",
    "kind",
    "args",
    "admissionQueries",
    "outcome",
    "events",
    "status",
    "thrown",
  ]);
  const seq = count(operation["seq"], `${path}.seq`);
  if (seq !== index + 1) fail(`${path}.seq`, `must be ${index + 1}`);
  const kind = oneOf(operation["kind"], `${path}.kind`, OPERATION_KINDS);
  const args = array(operation["args"], `${path}.args`);
  if (args.length !== ARITY[kind]) fail(`${path}.args`, `must hold ${ARITY[kind]} for ${kind}`);
  if (kind === "run") parseRunOptions(args[0], `${path}.args[0]`);
  const admissionQueries = array(operation["admissionQueries"], `${path}.admissionQueries`).map(
    (query, queryIndex) => {
      const queryPath = `${path}.admissionQueries[${queryIndex}]`;
      const found = record(query, queryPath);
      exactly(found, queryPath, ["reference", "kind", "result"]);
      return {
        reference: string(found["reference"], `${queryPath}.reference`),
        kind: oneOf(found["kind"], `${queryPath}.kind`, ["image"] as const),
        result: boolean(found["result"], `${queryPath}.result`),
      };
    },
  );
  if (admissionQueries.length > 0 && kind !== "completeAction")
    fail(`${path}.admissionQueries`, "belong only to completeAction");
  const events = record(operation["events"], `${path}.events`);
  exactly(events, `${path}.events`, ["first", "count"]);
  const eventCount = count(events["count"], `${path}.events.count`, true);
  const first = events["first"] === null ? null : count(events["first"], `${path}.events.first`);
  if ((first === null) !== (eventCount === 0))
    fail(`${path}.events.first`, "must be null exactly when the call emitted no events");
  const outcome = nullableString(operation["outcome"], `${path}.outcome`);
  const thrown = nullableString(operation["thrown"], `${path}.thrown`);
  if ((outcome === null) === (thrown === null))
    fail(path, "must have either an outcome or a thrown error");
  if (thrown !== null && eventCount > 0)
    fail(`${path}.events`, "must be empty for a call that threw");
  return {
    seq,
    kind,
    args,
    admissionQueries,
    outcome,
    events: { first, count: eventCount },
    status: oneOf(operation["status"], `${path}.status`, STATUSES),
    thrown,
  };
}

/** Run options as the engine takes them; the Player passes at most an instruction budget. */
function parseRunOptions(value: unknown, path: string): { instructionBudget?: number } {
  const options = record(value, path);
  exactly(options, path, Object.hasOwn(options, "instructionBudget") ? ["instructionBudget"] : []);
  return options["instructionBudget"] === undefined
    ? {}
    : { instructionBudget: count(options["instructionBudget"], `${path}.instructionBudget`) };
}

function parsePhotos(value: unknown): DebugPhoto[] {
  const seen = new Set<string>();
  return array(value, "$.photos").map((entry, index) => {
    const path = `$.photos[${index}]`;
    const photo = record(entry, path);
    exactly(photo, path, [
      "reference",
      "mimeType",
      "byteLength",
      "width",
      "height",
      "usedBy",
      "data",
    ]);
    const reference = string(photo["reference"], `${path}.reference`);
    if (!isWellFormedCapturedMediaReference(reference))
      fail(`${path}.reference`, "is not a captured-media reference");
    if (seen.has(reference)) fail(`${path}.reference`, "is listed twice");
    seen.add(reference);
    const mimeType = string(photo["mimeType"], `${path}.mimeType`);
    if (!mimeType.startsWith("image/")) fail(`${path}.mimeType`, "is not an image type");
    const byteLength = count(photo["byteLength"], `${path}.byteLength`);
    let data: Uint8Array<ArrayBuffer> | null = null;
    if (photo["data"] !== null) {
      data = decodeBase64url(string(photo["data"], `${path}.data`));
      if (data === null) fail(`${path}.data`, "is not canonical unpadded base64url");
      if (data.length !== byteLength)
        fail(`${path}.data`, `has ${data.length} bytes instead of byteLength ${byteLength}`);
    }
    const usedBy = array(photo["usedBy"], `${path}.usedBy`).map((use, useIndex) => {
      const usePath = `${path}.usedBy[${useIndex}]`;
      const found = record(use, usePath);
      exactly(found, usePath, ["relation", "operation", "actionId"]);
      return {
        relation: oneOf(found["relation"], `${usePath}.relation`, [
          "capture",
          "imageAnswer",
          "savedValue",
        ] as const),
        operation:
          found["operation"] === null ? null : count(found["operation"], `${usePath}.operation`),
        actionId:
          found["actionId"] === null ? null : count(found["actionId"], `${usePath}.actionId`),
      };
    });
    return {
      reference,
      mimeType,
      byteLength,
      width: photo["width"] === null ? null : count(photo["width"], `${path}.width`),
      height: photo["height"] === null ? null : count(photo["height"], `${path}.height`),
      data,
      usedBy,
    };
  });
}

function parseSections(value: unknown): Record<string, unknown> {
  const sections = record(value, "$.sections");
  for (const name of Object.keys(sections))
    if (!SECTION_NAMES.includes(name))
      fail("$.sections", `has an unknown section ${JSON.stringify(name)}`);
  return sections;
}

/** Restores checkpoint data through the engine's own validation; another revision is unsupported, not invalid. */
function restore(value: unknown, path: string, build: DebugBuild): RuntimeCheckpoint {
  try {
    return restoreCheckpoint(value);
  } catch (error) {
    if (error instanceof CheckpointError && error.info.code === "TSK001")
      throw new DebugExportError(
        "unsupported",
        `${path} is a checkpoint of another revision (export build ${build.commit ?? "unknown"}, checkpoint version ${build.checkpointVersion}); this tool reads checkpoint version ${CHECKPOINT_VERSION}. Use a checkout of the build it names.`,
      );
    // Every other refusal of the engine's validation, structured or not, means the data is not a valid checkpoint.
    const message = error instanceof Error ? error.message : String(error);
    throw new DebugExportError("invalid", `${path} is not a valid checkpoint: ${message}`);
  }
}

/** The result of running an export's recorded calls again from its anchor. */
export type DebugReplayResult =
  | {
      readonly kind: "reproduced";
      /** The failure the replay ended in, which is the recorded one; `null` when the session had not failed. */
      readonly failure: DebugLocation | null;
      readonly operations: number;
    }
  | {
      readonly kind: "diverged";
      /** The first call whose result differs, or `null` when only the final state differs. */
      readonly operation: number | null;
      readonly reason: string;
      readonly location: DebugLocation | null;
    }
  | { readonly kind: "incomplete"; readonly reason: string };

/** Where execution stands: the failure location, or the next instruction's source. */
export interface DebugLocation {
  readonly code: string | null;
  readonly path: string;
  /** One-based line and column. */
  readonly line: number;
  readonly column: number;
  /** The function and file calls, outermost first, as `name` or `file`. */
  readonly calls: readonly string[];
}

/**
 * Runs the recorded calls from the replay anchor through the engine's public operations, each validating its arguments
 * as it would from the Player, and compares every result and the final state with the recording. Media admission is
 * answered from the recorded answers only, so no media is accessed; an unrecorded question is a divergence.
 */
export function replayDebugExport(exported: DebugExport): DebugReplayResult {
  const { checkpoint, replay } = exported;
  if (checkpoint === null || replay === null)
    return {
      kind: "incomplete",
      reason: exported.selection.replay
        ? "The export has no replay data."
        : "Replay data was not included in this export.",
    };
  if (!replay.complete)
    return { kind: "incomplete", reason: replay.reason ?? "The recorded calls are incomplete." };
  const plan = checkpoint.plan;
  let snapshot = replay.anchorSnapshot ?? checkpoint.snapshot;
  const failedAtAnchor = snapshot.status === "failed";
  for (const operation of replay.operations) {
    const queries = [...operation.admissionQueries];
    let unexpected: string | null = null;
    const capturedMedia = {
      holds(reference: string, kind: "image"): boolean {
        const query = queries.shift();
        if (query === undefined || query.reference !== reference || query.kind !== kind) {
          unexpected ??= `the engine asked whether ${kind} ${reference} is stored, which was not recorded`;
          return false;
        }
        return query.result;
      },
    };
    // A call that throws changes nothing and emits nothing; every recorded field is compared either way.
    let actual: {
      readonly snapshot: RuntimeSnapshot;
      readonly events: readonly InterpreterEvent[];
      readonly outcome: string | null;
      readonly thrown: string | null;
    };
    try {
      actual = { ...dispatch(plan, snapshot, operation, capturedMedia), thrown: null };
    } catch (error) {
      actual = {
        snapshot,
        events: [],
        outcome: null,
        thrown: error instanceof Error ? error.name : "Error",
      };
    }
    const first = actual.events[0]?.sequence ?? null;
    // An unrecorded store question explains everything after it, so it is reported first.
    const difference =
      unexpected !== null
        ? unexpected
        : actual.thrown !== operation.thrown || actual.outcome !== operation.outcome
          ? `${describe(actual)}, recorded ${describe(operation)}`
          : queries.length > 0
            ? `${queries.length} recorded media question(s) were not asked`
            : actual.events.length !== operation.events.count || first !== operation.events.first
              ? `emitted ${actual.events.length} event(s) from ${first}, recorded ${operation.events.count} from ${operation.events.first}`
              : actual.snapshot.status !== operation.status
                ? `left the session ${actual.snapshot.status}, recorded ${operation.status}`
                : null;
    if (difference !== null) return diverged(plan, actual.snapshot, operation, difference);
    snapshot = actual.snapshot;
  }
  if (exported.checkpointRole === "current") {
    const replayed = serializeValidatedRuntimeJson(createCheckpoint(plan, snapshot).snapshot);
    if (replayed !== serializeValidatedRuntimeJson(checkpoint.snapshot))
      return {
        kind: "diverged",
        operation: null,
        reason: "every call matched, but the final state differs from the exported checkpoint",
        location: location(plan, snapshot),
      };
  }
  // Only a recorded call that reaches the failure reproduces it; a failed anchor is evidence to read, not to replay.
  if (failedAtAnchor)
    return {
      kind: "incomplete",
      reason:
        "The session had already failed at the replay anchor, so no recorded call reaches the failure.",
    };
  return {
    kind: "reproduced",
    failure: snapshot.failure === null ? null : location(plan, snapshot),
    operations: replay.operations.length,
  };
}

/** A call's result as the replay report names it. */
function describe(result: {
  readonly outcome: string | null;
  readonly thrown: string | null;
}): string {
  return result.thrown === null ? `outcome ${result.outcome}` : `threw ${result.thrown}`;
}

function dispatch(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  operation: DebugOperation,
  capturedMedia: { holds(reference: string, kind: "image"): boolean },
): { snapshot: RuntimeSnapshot; events: readonly InterpreterEvent[]; outcome: string } {
  const [first, second] = operation.args;
  switch (operation.kind) {
    case "run": {
      const ran = run(plan, snapshot, {}, parseRunOptions(first, "run options"));
      return { snapshot: ran.snapshot, events: ran.events, outcome: "ran" };
    }
    case "observeTime":
      return withOutcome(observeTime(plan, snapshot, first, second));
    case "completeAction":
      return withOutcome(completeAction(plan, snapshot, first, { capturedMedia }));
    case "reportMediaLoad":
      return withOutcome(reportMediaLoad(plan, snapshot, first, second));
    case "pressPermanentButton":
      return withOutcome(pressPermanentButton(plan, snapshot, first));
    case "recordContinueCapture":
      return withOutcome(recordContinueCapture(plan, snapshot, first));
    case "applyExternalStorageEdit":
      return withOutcome(applyExternalStorageEdit(plan, snapshot, first));
  }
}

function withOutcome(result: {
  snapshot: RuntimeSnapshot;
  events: readonly InterpreterEvent[];
  outcome: { kind: string };
}) {
  return { snapshot: result.snapshot, events: result.events, outcome: result.outcome.kind };
}

function diverged(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  operation: DebugOperation,
  reason: string,
): DebugReplayResult {
  return {
    kind: "diverged",
    operation: operation.seq,
    reason: `call ${operation.seq} (${operation.kind}) ${reason}`,
    location: location(plan, snapshot),
  };
}

function location(plan: InstructionPlan, snapshot: RuntimeSnapshot): DebugLocation | null {
  const calls = snapshot.callFrames.map((frame) =>
    frame.kind === "function" ? frame.functionName : "file",
  );
  if (snapshot.failure !== null)
    return {
      code: snapshot.failure.code,
      path: snapshot.failure.path,
      line: snapshot.failure.span.start.line + 1,
      column: snapshot.failure.span.start.column + 1,
      calls,
    };
  const instruction = plan.instructions[snapshot.nextInstruction];
  if (instruction === undefined) return null;
  return {
    code: null,
    path: instructionSourcePath(plan, snapshot.nextInstruction),
    line: instruction.span.sl + 1,
    column: instruction.span.sc + 1,
    calls,
  };
}

function fail(path: string, message: string): never {
  throw new DebugExportError("invalid", `${path} ${message}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  // EVIDENCE: validation: the guard above proved a non-array object parsed from JSON.
  return value as Record<string, unknown>;
}

function exactly(value: Record<string, unknown>, path: string, fields: readonly string[]): void {
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !fields.includes(key));
  if (unknown !== undefined) fail(path, `has an unknown field ${JSON.stringify(unknown)}`);
  const missing = fields.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) fail(path, `is missing ${JSON.stringify(missing)}`);
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be text");
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function strings(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${index}]`));
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be true or false");
  return value;
}

function count(value: unknown, path: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    fail(path, allowZero ? "must be a whole number" : "must be a positive whole number");
  return value;
}

function oneOf<const T extends readonly (string | null)[]>(
  value: unknown,
  path: string,
  options: T,
): T[number] {
  for (const option of options) if (option === value) return option;
  return fail(path, `must be one of ${options.map((option) => JSON.stringify(option)).join(", ")}`);
}
