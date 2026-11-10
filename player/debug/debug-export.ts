import {
  completeAction,
  createCheckpoint,
  createRuntimeSession,
  observeTime,
  pressPermanentButton,
  recordContinueCapture,
  applyExternalStorageEdit,
  setDebugMode,
  reportMediaLoad,
  updateInteraction,
  restoreCheckpoint,
  resumeRandomDraw,
  run,
  pendingRandomDraw,
  replayRandomChoices,
  type InstructionPlan,
  type InterpreterEvent,
  type RandomChoiceReceipt,
  type RandomControlOptions,
  type RandomOutcome,
  type RuntimeCheckpoint,
  type RuntimeSession,
  type RuntimeSessionResult,
  type RuntimeSnapshot,
  type StoredFileKind,
} from "../../src/playback.js";
import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CheckpointError,
  serializeValidatedRuntimeJson,
} from "../../src/runtime/snapshot/checkpoint-json.js";
import { RANDOM_DRAW_KINDS } from "../../src/runtime/random/random-kinds.js";
import {
  count,
  DebugExportError,
  exactly,
  fail,
  parseEditedWhileDebugging,
  parseRewoundWhileDebugging,
  record,
} from "./debug-history-marks.js";
import {
  ANSWER_INPUTS,
  DEBUG_EXPORT_FORMAT,
  DEBUG_EXPORT_VERSION,
  OPERATION_KINDS,
  type DebugBuild,
  type DebugExport,
  type DebugIncident,
  type DebugOperation,
  type DebugOperationKind,
  type DebugPackage,
  type DebugPhoto,
  type DebugReplay,
  type DebugSelection,
} from "./debug-export-file.js";
import { instructionSourcePath } from "../../src/plan/model.js";

import { isWellFormedCapturedMediaReference } from "../media/captured-media.js";
import { decodeBase64url } from "../persistence/transfer-encoding.js";

/*
 * Reading a debug export as untrusted data, and replaying its recorded calls: the engine's side of the format, in the
 * Worker and in `tools/debug-export.mjs`. The format and its writer are `debug-export-file.ts`'s, re-exported here.
 */

export * from "./debug-export-file.js";
export {
  DebugExportError,
  type DebugEditedWhileDebugging,
  type DebugRewoundWhileDebugging,
} from "./debug-history-marks.js";

const ARITY: Readonly<Record<DebugOperationKind, number>> = {
  run: 1,
  observeTime: 2,
  completeAction: 1,
  reportMediaLoad: 2,
  pressPermanentButton: 1,
  recordContinueCapture: 1,
  applyExternalStorageEdit: 1,
  updateInteraction: 1,
  resumeRandomDraw: 1,
  setDebugMode: 1,
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
    "editedWhileDebugging",
    "rewoundWhileDebugging",
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
    editedWhileDebugging: parseEditedWhileDebugging(root["editedWhileDebugging"]),
    rewoundWhileDebugging: parseRewoundWhileDebugging(root["rewoundWhileDebugging"]),
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
    "randomChoices",
    "pausedAt",
    "input",
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
        kind: oneOf(found["kind"], `${queryPath}.kind`, [
          "image",
          "audio",
          "video",
          "file",
        ] as const),
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
  const randomChoices = array(operation["randomChoices"], `${path}.randomChoices`).map(
    (entry, choiceIndex) => parseReceipt(entry, `${path}.randomChoices[${choiceIndex}]`),
  );
  const pausedAt =
    operation["pausedAt"] === null ? null : count(operation["pausedAt"], `${path}.pausedAt`);
  if (thrown !== null && (randomChoices.length > 0 || pausedAt !== null))
    fail(path, "must not choose or pause at random draws when it threw");
  const input = oneOf(operation["input"], `${path}.input`, [null, ...ANSWER_INPUTS] as const);
  if (input !== null && kind !== "completeAction")
    fail(`${path}.input`, "belongs only to completeAction");
  return {
    seq,
    kind,
    args,
    admissionQueries,
    outcome,
    events: { first, count: eventCount },
    status: oneOf(operation["status"], `${path}.status`, STATUSES),
    thrown,
    randomChoices,
    pausedAt,
    input,
  };
}

/** A chosen random outcome: the draw's ID, site, and kind, and the outcome, which the engine checks when it replays. */
function parseReceipt(value: unknown, path: string): RandomChoiceReceipt {
  const receipt = record(value, path);
  exactly(receipt, path, ["drawId", "site", "kind", "outcome"]);
  const outcome = record(receipt["outcome"], `${path}.outcome`);
  const kind = oneOf(outcome["kind"], `${path}.outcome.kind`, [
    "number",
    "boolean",
    "index",
    "order",
  ] as const);
  const field = kind === "index" ? "index" : kind === "order" ? "order" : "value";
  exactly(outcome, `${path}.outcome`, ["kind", field]);
  const chosen: RandomOutcome =
    kind === "number"
      ? { kind, value: finiteNumber(outcome["value"], `${path}.outcome.value`) }
      : kind === "boolean"
        ? { kind, value: boolean(outcome["value"], `${path}.outcome.value`) }
        : kind === "index"
          ? { kind, index: count(outcome["index"], `${path}.outcome.index`, true) }
          : {
              kind,
              order: array(outcome["order"], `${path}.outcome.order`).map((index, position) =>
                count(index, `${path}.outcome.order[${position}]`, true),
              ),
            };
  return {
    drawId: count(receipt["drawId"], `${path}.drawId`),
    site: string(receipt["site"], `${path}.site`),
    kind: oneOf(receipt["kind"], `${path}.kind`, RANDOM_DRAW_KINDS),
    outcome: chosen,
  };
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

/**
 * The decisions of a recorded call: each chosen outcome at its draw, a pause at the draw it stands paused at, and the
 * natural outcome everywhere else; `undefined` when it decided nothing, so it runs without control.
 */
function recordedRandomControl(operation: DebugOperation): RandomControlOptions | undefined {
  return operation.randomChoices.length === 0 && operation.pausedAt === null
    ? undefined
    : replayRandomChoices(operation.randomChoices, operation.pausedAt);
}

/** How a replayed call's random decisions differ from its record, or `null` when they match. */
function randomDifference(
  operation: DebugOperation,
  choices: readonly RandomChoiceReceipt[],
  pausedAt: number | null,
): string | null {
  if (JSON.stringify(choices) !== JSON.stringify(operation.randomChoices))
    return `chose ${choices.length} random outcome(s), recorded ${operation.randomChoices.length}`;
  if (pausedAt !== operation.pausedAt)
    return `stands paused at draw ${pausedAt ?? "none"}, recorded ${operation.pausedAt ?? "none"}`;
  return null;
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
      holds(reference: string, kind: StoredFileKind): boolean {
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
      readonly randomChoices: readonly RandomChoiceReceipt[];
    };
    try {
      actual = { ...dispatch(plan, snapshot, operation, capturedMedia), thrown: null };
    } catch (error) {
      actual = {
        snapshot,
        events: [],
        outcome: null,
        thrown: error instanceof Error ? error.name : "Error",
        randomChoices: [],
      };
    }
    const pausedAt =
      actual.thrown === null ? (pendingRandomDraw(actual.snapshot)?.drawId ?? null) : null;
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
                : randomDifference(operation, actual.randomChoices, pausedAt);
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
  capturedMedia: { holds(reference: string, kind: StoredFileKind): boolean },
): {
  snapshot: RuntimeSnapshot;
  events: readonly InterpreterEvent[];
  outcome: string;
  randomChoices: readonly RandomChoiceReceipt[];
} {
  const [first, second] = operation.args;
  const randomControl = recordedRandomControl(operation);
  const control = randomControl === undefined ? {} : { randomControl };
  switch (operation.kind) {
    case "run": {
      const ran = run(plan, snapshot, {}, { ...parseRunOptions(first, "run options"), ...control });
      return {
        snapshot: ran.snapshot,
        events: ran.events,
        outcome: "ran",
        randomChoices: ran.randomChoices ?? [],
      };
    }
    case "resumeRandomDraw":
      return withOutcome(resumeRandomDraw(plan, snapshot, first, {}, control));
    case "observeTime":
      return withOutcome(observeTime(plan, snapshot, first, second, control));
    case "completeAction":
      return withOutcome(completeAction(plan, snapshot, first, { capturedMedia }));
    case "reportMediaLoad":
      return withOutcome(reportMediaLoad(plan, snapshot, first, second, control));
    case "pressPermanentButton":
      return withOutcome(pressPermanentButton(plan, snapshot, first));
    case "recordContinueCapture":
      return withOutcome(recordContinueCapture(plan, snapshot, first));
    case "applyExternalStorageEdit":
      return withOutcome(applyExternalStorageEdit(plan, snapshot, first));
    case "updateInteraction":
      return withOutcome(updateInteraction(plan, snapshot, first));
    case "setDebugMode":
      return withOutcome(setDebugMode(plan, snapshot, first));
  }
}

/**
 * An engine-owned session at the state `operations` reach from `anchor`: each recorded call runs again with its
 * recorded arguments, the media store answering from the recorded answers. A call that threw, or whose outcome, events,
 * or status differ from its record, stops the rebuild with an error, because the state it would give is not the one the
 * calls reached.
 */
export function rebuildRecordedSession(
  plan: InstructionPlan,
  anchor: RuntimeSnapshot,
  operations: readonly DebugOperation[],
): RuntimeSession {
  const session = createRuntimeSession(plan, anchor);
  for (const operation of operations) {
    if (operation.thrown !== null)
      throw new Error(`call ${operation.seq} (${operation.kind}) threw ${operation.thrown}`);
    const queries = [...operation.admissionQueries];
    const capturedMedia = {
      holds(reference: string, kind: StoredFileKind): boolean {
        const query = queries.shift();
        if (query === undefined || query.reference !== reference || query.kind !== kind)
          throw new Error(
            `call ${operation.seq} asked about ${kind} ${reference}, which was not recorded`,
          );
        return query.result;
      },
    };
    session.setRandomControl(recordedRandomControl(operation) ?? null);
    const result = dispatchToSession(session, operation, capturedMedia);
    const first = result.events[0]?.sequence ?? null;
    const view = session.view();
    if (
      result.outcome !== operation.outcome ||
      result.events.length !== operation.events.count ||
      first !== operation.events.first ||
      view.status !== operation.status ||
      randomDifference(operation, result.randomChoices, view.randomDraw?.drawId ?? null) !== null
    )
      throw new Error(`call ${operation.seq} (${operation.kind}) did not repeat its record`);
  }
  return session;
}

function dispatchToSession(
  session: RuntimeSession,
  operation: DebugOperation,
  capturedMedia: { holds(reference: string, kind: StoredFileKind): boolean },
): {
  readonly events: RuntimeSessionResult["events"];
  readonly outcome: string;
  readonly randomChoices: readonly RandomChoiceReceipt[];
} {
  const [first, second] = operation.args;
  const settled = (result: {
    events: RuntimeSessionResult["events"];
    outcome: { kind: string };
    randomChoices?: readonly RandomChoiceReceipt[];
  }) => ({
    events: result.events,
    outcome: result.outcome.kind,
    randomChoices: result.randomChoices ?? [],
  });
  switch (operation.kind) {
    case "run": {
      const ran = session.run(parseRunOptions(first, "run options"));
      return { events: ran.events, outcome: "ran", randomChoices: ran.randomChoices ?? [] };
    }
    case "resumeRandomDraw":
      return settled(session.resumeRandomDraw(first));
    case "observeTime":
      return settled(session.observeTime(first, second));
    case "completeAction":
      return settled(session.completeAction(first, { capturedMedia }));
    case "reportMediaLoad":
      return settled(session.reportMediaLoad(first, second));
    case "pressPermanentButton":
      return settled(session.pressPermanentButton(first));
    case "recordContinueCapture":
      return settled(session.recordContinueCapture(first));
    case "applyExternalStorageEdit":
      return settled(session.applyExternalStorageEdit(first));
    case "updateInteraction":
      return settled(session.updateInteraction(first));
    case "setDebugMode":
      return settled(session.setDebugMode(first));
  }
}

function withOutcome(result: {
  snapshot: RuntimeSnapshot;
  events: readonly InterpreterEvent[];
  outcome: { kind: string };
  randomChoices?: readonly RandomChoiceReceipt[];
}) {
  return {
    snapshot: result.snapshot,
    events: result.events,
    outcome: result.outcome.kind,
    randomChoices: result.randomChoices ?? [],
  };
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

function oneOf<const T extends readonly (string | null)[]>(
  value: unknown,
  path: string,
  options: T,
): T[number] {
  for (const option of options) if (option === value) return option;
  return fail(path, `must be one of ${options.map((option) => JSON.stringify(option)).join(", ")}`);
}
