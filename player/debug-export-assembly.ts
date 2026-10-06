import {
  createCheckpoint,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeCheckpoint,
  type RuntimeSnapshot,
} from "../src/index.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/checkpoint.js";
import { capturedMediaReferences } from "./captured-media-persistence.js";
import {
  DEBUG_EXPORT_VERSION,
  debugBuildRevisions,
  type DebugBuild,
  type DebugExport,
  type DebugIncident,
  type DebugPackage,
  type DebugPhoto,
  type DebugPhotoUse,
  type DebugReplay,
  type DebugSelection,
} from "./debug-export.js";
import type { DebugRecording } from "./debug-recorder.js";
import type { PlayerTranscriptEntryPresentation } from "./model.js";

/**
 * What the Player knows when the player asks for a debug export, frozen then, so that the preview, its size, and the
 * download describe one export while play continues. Owner decision (DEBUGGER.md "Debug export"): noise is never
 * collected; personal content is chosen per export and off by default.
 */
export interface DebugExportCandidate {
  readonly build: Pick<DebugBuild, "commit" | "dirty" | "mode" | "appVersion">;
  readonly package: Pick<DebugPackage, "id" | "version">;
  readonly session: {
    readonly plan: InstructionPlan;
    readonly snapshot: RuntimeSnapshot;
    readonly events: readonly InterpreterEvent[];
    readonly transcriptEntries: readonly PlayerTranscriptEntryPresentation[];
  } | null;
  readonly recording: DebugRecording | null;
  /** The error name of an exception of the Player itself that stopped the session. */
  readonly hostError: string | null;
  readonly photos: readonly DebugPhotoCandidate[];
  /** Player settings, geometry, and browser details, exported only when chosen. */
  readonly player: Readonly<Record<string, string | number | boolean | null>>;
}

/** A photo the session used, read only when the player includes it. */
export interface DebugPhotoCandidate {
  readonly reference: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly usedBy: readonly DebugPhotoUse[];
  read(): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** The player's choices: the categories, and which photos to include. */
export interface DebugExportChoices extends DebugSelection {
  readonly photoReferences: ReadonlySet<string>;
}

/** Every personal category off: what each export starts with. */
export const NO_PERSONAL_CONTENT: DebugExportChoices = Object.freeze({
  savedValues: false,
  answers: false,
  replay: false,
  sessionText: false,
  photos: false,
  player: false,
  photoReferences: new Set<string>(),
});

export type DebugCategory = keyof DebugSelection;

/** The categories replay data discloses, because runtime state holds copies of them. */
export const REPLAY_PREREQUISITES = ["savedValues", "answers", "sessionText"] as const;

/**
 * The choices after the player turns `category` on or off. Replay data can be turned on only after its prerequisites,
 * and turning one of them off turns replay data off. Turning photos on selects the photos a recorded call used.
 */
export function chooseDebugCategory(
  choices: DebugExportChoices,
  candidate: DebugExportCandidate,
  category: DebugCategory,
  on: boolean,
): DebugExportChoices {
  if (
    category === "replay" &&
    on &&
    !REPLAY_PREREQUISITES.every((prerequisite) => choices[prerequisite])
  )
    return choices;
  const next = { ...choices, [category]: on };
  if (!on && REPLAY_PREREQUISITES.some((prerequisite) => prerequisite === category))
    next.replay = false;
  if (category === "photos")
    next.photoReferences = on
      ? new Set(
          candidate.photos
            .filter((photo) => photo.usedBy.some((use) => use.operation !== null))
            .map((photo) => photo.reference),
        )
      : new Set();
  return next;
}

/** The choices with one photo included or left out. */
export function chooseDebugPhoto(
  choices: DebugExportChoices,
  reference: string,
  on: boolean,
): DebugExportChoices {
  const photoReferences = new Set(choices.photoReferences);
  if (on) photoReferences.add(reference);
  else photoReferences.delete(reference);
  return { ...choices, photoReferences };
}

/** How many recent events and transcript entries an export keeps; diagnostic tuning, not a limit on scripts. */
const EVENT_TAIL = 256;
const TRANSCRIPT_TAIL = 50;

/** One part of an export as the preview lists it. */
export interface DebugExportPart {
  readonly name: string;
  readonly detail: string;
}

/**
 * The export the choices give, with the parts the preview lists. Credentials and absolute file paths found in chosen
 * text are removed from readable sections; replay data that contains one is left out entirely, since removing it would
 * change what replays.
 */
export async function assembleDebugExport(
  candidate: DebugExportCandidate,
  choices: DebugExportChoices,
): Promise<{ readonly exported: DebugExport; readonly parts: readonly DebugExportPart[] }> {
  const { session, recording } = candidate;
  const parts: DebugExportPart[] = [];
  const omissions: string[] = [];
  const snapshot = recording?.endSnapshot ?? session?.snapshot ?? null;
  const plan = recording?.plan ?? session?.plan ?? null;
  const incident = describeIncident(snapshot, candidate.hostError);
  parts.push({
    name: "Technical report",
    detail: `Build, versions, ${incident.code ?? incident.hostError ?? "no error"}${incident.path === null ? "" : ` at ${incident.path}:${incident.line}`}, and the kinds of the last events`,
  });

  const sections: Record<string, unknown> = {};
  const events = session?.events.slice(-EVENT_TAIL) ?? [];
  sections["eventsTail"] = choices.sessionText
    ? removeSecrets(events)
    : events.map((event) => ({ sequence: event.sequence, kind: event.kind }));
  if (choices.sessionText && session !== null) {
    const transcript = session.transcriptEntries
      .slice(-TRANSCRIPT_TAIL)
      .map((entry) => ({
        ...(entry.kind === "message" ? { speaker: entry.speakerId } : {}),
        text: entry.text,
      }));
    sections["transcriptTail"] = removeSecrets(transcript);
    parts.push({
      name: "Session text",
      detail: `${transcript.length} recent message(s) and ${events.length} event(s) with their text`,
    });
  }
  if (choices.savedValues && snapshot !== null) {
    sections["storage"] = removeSecrets(snapshot.scriptStorage);
    parts.push({
      name: "Saved script values",
      detail: `${snapshot.scriptStorage.length} saved key(s)`,
    });
  }
  if (choices.answers) {
    const answers = recordedAnswers(recording);
    sections["answers"] = removeSecrets(answers);
    parts.push({ name: "Submitted answers", detail: `${answers.length} recorded answer(s)` });
    if (recording === null) omissions.push("No answers were recorded for this session.");
  }
  if (choices.player) {
    sections["player"] = { ...candidate.player };
    parts.push({
      name: "Player and browser details",
      detail: Object.keys(candidate.player).join(", "),
    });
  }

  let checkpoint: RuntimeCheckpoint | null = null;
  let checkpointRole: DebugExport["checkpointRole"] = null;
  let replay: DebugReplay | null = null;
  if (choices.replay && plan !== null && snapshot !== null) {
    ({ checkpoint, checkpointRole, replay } = replayData(plan, snapshot, recording, omissions));
    if (
      checkpoint !== null &&
      containsSecret(serializeValidatedRuntimeJson({ checkpoint, replay }))
    ) {
      checkpoint = null;
      checkpointRole = null;
      replay = null;
      omissions.push(
        "Replay data was left out because it contains text that looks like a credential or a file path; removing it would change the replay.",
      );
    }
    if (checkpoint !== null)
      parts.push({
        name: "Engine replay data",
        detail:
          replay === null
            ? "The current state, without recorded calls"
            : `The state, and ${replay.operations.length} recorded call(s) since ${replay.anchorSnapshot === null ? "the last good state" : "an earlier point"}${replay.complete ? "" : ` (incomplete: ${replay.reason})`}`,
      });
  }

  const photos: DebugPhoto[] = [];
  if (choices.photos)
    for (const candidatePhoto of candidate.photos) {
      if (!choices.photoReferences.has(candidatePhoto.reference)) continue;
      const data = await candidatePhoto.read().catch(() => null);
      if (data === null)
        omissions.push(`The bytes of ${candidatePhoto.reference} were not available.`);
      photos.push({
        reference: candidatePhoto.reference,
        mimeType: candidatePhoto.mimeType,
        byteLength: data?.length ?? candidatePhoto.byteLength,
        width: candidatePhoto.width,
        height: candidatePhoto.height,
        data,
        usedBy: candidatePhoto.usedBy,
      });
    }
  if (photos.length > 0)
    parts.push({ name: "Photos", detail: `${photos.length} original file(s)` });

  const exported: DebugExport = {
    format: "teasescript-debug-export",
    version: DEBUG_EXPORT_VERSION,
    build: { ...candidate.build, ...debugBuildRevisions() },
    package: { ...candidate.package, contentHash: plan === null ? null : await planHash(plan) },
    incident,
    selection: {
      savedValues: choices.savedValues,
      answers: choices.answers,
      replay: choices.replay,
      sessionText: choices.sessionText,
      photos: choices.photos,
      player: choices.player,
    },
    omissions,
    checkpoint,
    checkpointRole,
    replay,
    photos,
    sections,
  };
  return { exported, parts };
}

function describeIncident(
  snapshot: RuntimeSnapshot | null,
  hostError: string | null,
): DebugIncident {
  const failure = snapshot?.failure ?? null;
  if (failure !== null)
    return {
      kind: "runtimeFailure",
      code: failure.code,
      path: failure.path,
      line: failure.span.start.line + 1,
      column: failure.span.start.column + 1,
      hostError: null,
    };
  return {
    kind: hostError === null ? "requested" : "hostError",
    code: null,
    path: null,
    line: null,
    column: null,
    hostError,
  };
}

/** The checkpoint and recorded calls, or the last good state when the current one cannot be checkpointed. */
function replayData(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  recording: DebugRecording | null,
  omissions: string[],
): Pick<DebugExport, "checkpoint" | "checkpointRole" | "replay"> {
  const calls = (anchorSnapshot: RuntimeSnapshot | null): DebugReplay | null =>
    recording === null
      ? null
      : {
          anchorSnapshot,
          operations: recording.operations,
          complete: recording.complete,
          reason: recording.reason,
        };
  if (recording === null) omissions.push("No engine calls were recorded for this session.");
  try {
    return {
      checkpoint: createCheckpoint(plan, snapshot),
      checkpointRole: "current",
      replay: calls(recording?.anchorSnapshot ?? null),
    };
  } catch {
    if (recording === null) {
      omissions.push("The current state could not be checkpointed.");
      return { checkpoint: null, checkpointRole: null, replay: null };
    }
    omissions.push(
      "The current state could not be checkpointed; the export carries the last good state instead.",
    );
    return {
      checkpoint: createCheckpoint(plan, recording.anchorSnapshot),
      checkpointRole: "lastGood",
      replay: calls(null),
    };
  }
}

/** The answers the Player submitted, from the recorded completions of interactions. */
function recordedAnswers(recording: DebugRecording | null): unknown[] {
  if (recording === null) return [];
  return recording.operations.flatMap((operation) => {
    const request = operation.args[0];
    if (
      operation.kind !== "completeAction" ||
      !isRecord(request) ||
      request["actionKind"] !== "interaction"
    )
      return [];
    return [
      {
        operation: operation.seq,
        actionId: request["actionId"],
        interactionKind: request["interactionKind"],
        payload: request["payload"],
        outcome: operation.outcome,
      },
    ];
  });
}

/** The photos a session used, with where: recorded image answers and captures, and saved values. */
export function debugPhotoUses(
  recording: DebugRecording | null,
  savedValues: readonly { readonly value: Parameters<typeof capturedMediaReferences>[0] }[],
): ReadonlyMap<string, readonly DebugPhotoUse[]> {
  const uses = new Map<string, DebugPhotoUse[]>();
  const add = (reference: string, use: DebugPhotoUse) => {
    const list = uses.get(reference) ?? [];
    list.push(use);
    uses.set(reference, list);
  };
  for (const operation of recording?.operations ?? []) {
    const request = operation.args[0];
    if (operation.kind !== "completeAction" || !isRecord(request) || !isRecord(request["payload"]))
      continue;
    const payload = request["payload"];
    const actionId = typeof request["actionId"] === "number" ? request["actionId"] : null;
    if (payload["kind"] === "image" && typeof payload["reference"] === "string")
      add(payload["reference"], { relation: "imageAnswer", operation: operation.seq, actionId });
    const media = payload["media"];
    if (payload["kind"] === "captured" && isRecord(media) && typeof media["reference"] === "string")
      add(media["reference"], { relation: "capture", operation: operation.seq, actionId });
  }
  for (const entry of savedValues)
    for (const reference of capturedMediaReferences(entry.value))
      add(reference, { relation: "savedValue", operation: null, actionId: null });
  return uses;
}

// Text that looks like a credential or an absolute file path. Detection cannot prove text free of secrets; the dialog
// says so, and the player reviews the preview.
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}/gu,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gu,
  /(?:^|[\s"'(=])(?:\/(?:home|Users|root|var|etc|private|tmp|mnt|opt)\/[^\s"')]+|[A-Za-z]:\\\\?[^\s"')]+)/gu,
];

function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A copy of plain data with credential- and path-like text replaced; iterative, so deep data is no problem. */
function removeSecrets(value: unknown): JsonValue {
  const copy: JsonValue = JSON.parse(serializeValidatedRuntimeJson(value));
  if (typeof copy === "string") return scrub(copy);
  const pending: JsonValue[] = [copy];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (Array.isArray(current))
      current.forEach((item, index) => {
        if (typeof item === "string") current[index] = scrub(item);
        else if (item !== null && typeof item === "object") pending.push(item);
      });
    else if (current !== null && typeof current === "object")
      for (const [key, item] of Object.entries(current)) {
        if (typeof item === "string") current[key] = scrub(item);
        else if (item !== null && typeof item === "object") pending.push(item);
      }
  }
  return copy;
}

function scrub(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, " [removed]");
  return result;
}

/** The SHA-256 of the compiled plan, identifying the script's content; `null` where the browser cannot hash. */
async function planHash(plan: InstructionPlan): Promise<string | null> {
  const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
  if (subtle === undefined) return null;
  try {
    const digest = await subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializeValidatedRuntimeJson(plan)),
    );
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
