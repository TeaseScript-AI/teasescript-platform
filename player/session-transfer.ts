import {
  CheckpointError,
  validateScriptStorageEntries,
  type InstructionPlan,
  type RuntimeScriptStorageEntrySnapshot,
} from "../src/index.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint.js";
import { MAX_TEXT_LENGTH } from "../src/runtime/values/text-length.js";
import {
  isWellFormedCapturedMediaReference,
  validCapturedMediaRecord,
  type CapturedMediaKind,
  type CapturedMediaRecord,
} from "./captured-media.js";
import { capturedMediaReferences } from "./captured-media-persistence.js";
import { capturedMediaReferencesIn, sessionEvents } from "./kept-sessions.js";
import {
  restorePlayerRuntimeSession,
  type PlayerRuntimeRestorePoint,
  type PlayerRuntimeSession,
} from "./runtime-adapter.js";
import {
  parseTransferJson,
  STORAGE_TRANSFER_FORMAT,
  storageBundle,
  StorageTransferError,
  transferFileJson,
  transferFileName,
  transferTextJson,
  transferTextWithin,
  type StorageBundle,
} from "./storage-transfer.js";
import { base64urlSlices, decodeBase64url, gzipSupported, jsonFile } from "./transfer-encoding.js";

/**
 * A session moved by hand to another browser, where Continue goes on with it as after a reload (PLAYER-UI "Player
 * Settings"): the script's storage scope and title, the session's canonical checkpoint and the events that led to it,
 * the script's saved values, and each photo, recording, or file the session or those values use, under the reference they
 * hold. One versioned JSON document, as a file or text encoded as exported saved data is (`storage-transfer.ts`).
 */
export interface SessionTransfer {
  /** The trusted host's storage scope of the script; an import takes it only into the script of this scope. */
  readonly scope: string;
  /** The script's title when the exporting Player knew it. */
  readonly name: string | null;
  /** The checkpoint and events; read from an export, the checkpoint is checked when `restoreSessionTransfer` restores it. */
  readonly session: PlayerRuntimeRestorePoint;
  /** The script's saved values when the session was exported. */
  readonly entries: readonly RuntimeScriptStorageEntrySnapshot[];
  readonly media: readonly SessionTransferMedium[];
}

/** A photo, recording, or file of the session or its saved values, as the Player stores it. */
export interface SessionTransferMedium {
  readonly reference: string;
  readonly kind: CapturedMediaKind;
  readonly type: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** What a file or text the Player exported holds: the saved data of scripts, or a session. */
export type PlayerTransfer =
  | { readonly kind: "savedData"; readonly bundle: StorageBundle }
  | { readonly kind: "session"; readonly session: SessionTransfer };

const FORMAT = "teasescript-session";
const VERSION = 1;
const FIELDS = ["format", "version", "scope", "name", "checkpoint", "events", "entries", "media"];
const MEDIUM_FIELDS = [
  "reference",
  "kind",
  "type",
  "width",
  "height",
  "durationMs",
  "byteLength",
  "data",
];

/** A stored record as a medium of an export, reading its bytes. */
export async function sessionTransferMedium(
  record: CapturedMediaRecord,
): Promise<SessionTransferMedium> {
  return {
    reference: record.reference,
    kind: record.kind,
    type: record.mimeType,
    width: record.width ?? null,
    height: record.height ?? null,
    durationMs: record.durationMs ?? null,
    bytes: new Uint8Array(await record.data.arrayBuffer()),
  };
}

/** A medium of an import as a record of `namespace`, the script's scope. */
export function sessionMediumRecord(
  medium: SessionTransferMedium,
  namespace: string,
): CapturedMediaRecord {
  return {
    namespace,
    reference: medium.reference,
    kind: medium.kind,
    mimeType: medium.type,
    size: medium.bytes.length,
    ...(medium.width !== null && { width: medium.width }),
    ...(medium.height !== null && { height: medium.height }),
    ...(medium.durationMs !== null && { durationMs: medium.durationMs }),
    data: new Blob([medium.bytes], { type: medium.type }),
  };
}

/** The exported file: gzip, or plain JSON without `gzip`. */
export function sessionTransferFile(
  transfer: SessionTransfer,
  gzip = gzipSupported(),
): Promise<Blob> {
  return jsonFile(pieces(transfer), gzip);
}

/** The exported text, as saved data's (`storageTransferText`); text longer than a text can be fails with `TSK004`. */
export function sessionTransferText(
  transfer: SessionTransfer,
  gzip = gzipSupported(),
): Promise<string> {
  return transferTextWithin(pieces(transfer), gzip, MAX_TEXT_LENGTH);
}

/** The file name for the session of the script `name`. */
export function sessionTransferFileName(name: string, gzip = gzipSupported()): string {
  return transferFileName(name, "session.teasesession", gzip);
}

/** Reads an exported file of saved data or of a session; its contents decide which, not its name or type. */
export async function readPlayerTransferFile(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<PlayerTransfer> {
  return playerTransfer(await transferFileJson(bytes));
}

/** Reads exported text of saved data or of a session, also its plain JSON. */
export async function readPlayerTransferText(text: string): Promise<PlayerTransfer> {
  return playerTransfer(await transferTextJson(text));
}

function playerTransfer(json: string): PlayerTransfer {
  const document = parseTransferJson(json);
  if (document["format"] === FORMAT) return { kind: "session", session: sessionTransfer(document) };
  if (document["format"] === STORAGE_TRANSFER_FORMAT)
    return { kind: "savedData", bundle: storageBundle(document) };
  throw new StorageTransferError("This is not saved data or a session exported from a Player.");
}

/**
 * Validates the whole document, the checkpoint apart, before anything uses it: its exact fields, each event as a kept
 * session's, the saved values as runtime storage, and each medium as a stored record, used by the session or its values.
 */
function sessionTransfer(document: Readonly<Record<string, unknown>>): SessionTransfer {
  if (document["version"] !== VERSION)
    throw new StorageTransferError("This session uses a format version this Player cannot read.");
  if (!hasExactly(document, FIELDS))
    throw new StorageTransferError(
      "This session must have exactly format, version, scope, name, checkpoint, events, entries, and media.",
    );
  const { scope, name, checkpoint, events, entries, media } = document;
  if (typeof scope !== "string") throw new StorageTransferError("This session has no scope.");
  if (name !== null && typeof name !== "string")
    throw new StorageTransferError("The name of this session's script is not text.");
  if (!isRecord(checkpoint)) throw new StorageTransferError("This session has no checkpoint.");
  // Parsed JSON is plain data, which this writes as its own JSON; the restore checks it.
  let checkpointJson: string;
  try {
    checkpointJson = serializeValidatedRuntimeJson(checkpoint);
  } catch {
    throw new StorageTransferError("This session's checkpoint is too large for this browser.");
  }
  const valid = Array.isArray(events) ? sessionEvents(events) : null;
  if (valid === null)
    throw new StorageTransferError(
      "The events of this session are damaged, so it cannot continue.",
    );
  const failure = validateScriptStorageEntries(entries, "entries");
  if (failure !== null)
    throw new StorageTransferError(`A saved value of this session is invalid: ${failure}`);
  // EVIDENCE: validation: validateScriptStorageEntries accepted entries as storable script-storage entries.
  const values = entries as readonly RuntimeScriptStorageEntrySnapshot[];
  if (!Array.isArray(media))
    throw new StorageTransferError("The photos and files of this session are not a list.");
  const used = capturedMediaReferencesIn(checkpointJson, valid);
  for (const entry of values)
    for (const reference of capturedMediaReferences(entry.value)) used.add(reference);
  const seen = new Set<string>();
  const parsed: SessionTransferMedium[] = [];
  for (let index = 0; index < media.length; index += 1)
    parsed.push(parseMedium(media[index], `Photo or file ${index + 1}`, used, seen));
  return {
    scope,
    name,
    session: { checkpointJson, events: valid },
    entries: values,
    media: parsed,
  };
}

function parseMedium(
  medium: unknown,
  label: string,
  used: ReadonlySet<string>,
  seen: Set<string>,
): SessionTransferMedium {
  if (!isRecord(medium) || !hasExactly(medium, MEDIUM_FIELDS))
    throw new StorageTransferError(
      `${label} must have exactly reference, kind, type, width, height, durationMs, byteLength, and data.`,
    );
  const { reference, kind, type, width, height, durationMs, byteLength, data } = medium;
  if (typeof reference !== "string" || !isWellFormedCapturedMediaReference(reference))
    throw new StorageTransferError(`${label} has no valid reference.`);
  if (seen.has(reference)) throw new StorageTransferError(`${label} is listed twice.`);
  seen.add(reference);
  if (!used.has(reference))
    throw new StorageTransferError(`${label} is not used by the session or its saved values.`);
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0)
    throw new StorageTransferError(`${label} has no valid byteLength.`);
  const bytes = typeof data === "string" ? decodeBase64url(data) : null;
  if (bytes === null)
    throw new StorageTransferError(`${label} is damaged: its data is not base64url.`);
  if (bytes.length !== byteLength)
    throw new StorageTransferError(
      `${label} is damaged or incomplete: it has ${bytes.length} bytes instead of ${byteLength}.`,
    );
  // Checked as a photo or file a kept session keeps (`validCapturedMediaRecord`): its kind, type, and size agree, and
  // its dimensions and duration, if any, are valid.
  const record = validCapturedMediaRecord(
    {
      namespace: "",
      reference,
      kind,
      mimeType: type,
      size: bytes.length,
      ...(width !== null && { width }),
      ...(height !== null && { height }),
      ...(durationMs !== null && { durationMs }),
      data: new Blob([bytes], { type: typeof type === "string" ? type : "" }),
    },
    "",
    reference,
  );
  if (record === null)
    throw new StorageTransferError(
      `${label} is damaged: its kind, type, size, or dimensions are not valid.`,
    );
  return {
    reference,
    kind: record.kind,
    type: record.mimeType,
    width: record.width ?? null,
    height: record.height ?? null,
    durationMs: record.durationMs ?? null,
    bytes,
  };
}

/**
 * The session of an import restored for the script this Player shows, of storage scope `scope` and plan `plan`, as
 * Continue would find it after a reload; nothing runs. Refuses with the reason a session of another script, of another
 * version of the script or the Player, one that is damaged, and one that has ended.
 */
export function restoreSessionTransfer(
  transfer: SessionTransfer,
  scope: string,
  plan: InstructionPlan,
): PlayerRuntimeSession {
  if (transfer.scope !== scope)
    throw new StorageTransferError(
      `This session belongs to another script, ${transfer.name ?? transfer.scope}. Open that script and import it there.`,
    );
  let restored: PlayerRuntimeSession;
  try {
    restored = restorePlayerRuntimeSession(transfer.session);
  } catch (error) {
    if (error instanceof CheckpointError && error.info.code === "TSK001")
      throw new StorageTransferError(
        "This session was exported by another version of the Player, so this Player cannot continue it. Continue it where it was exported.",
      );
    throw new StorageTransferError(
      `This session is damaged, so it cannot continue. Export it again where it runs. Details: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A kept session goes on only with the plan it ran (`restoreKept`).
  if (JSON.stringify(restored.plan) !== JSON.stringify(plan))
    throw new StorageTransferError(
      "This session comes from another version of this script or of the Player, so it cannot continue here. Continue it where it was exported.",
    );
  if (restored.state.status === "halted" || restored.state.status === "failed")
    throw new StorageTransferError("This session has ended, so there is nothing to continue.");
  return restored;
}

/** The document in pieces, with one event and one saved value per line; media data is encoded slice by slice. */
function* pieces(transfer: SessionTransfer): Generator<string> {
  yield `{"format":${JSON.stringify(FORMAT)},"version":${VERSION},\n"scope":${JSON.stringify(transfer.scope)},"name":${JSON.stringify(transfer.name)},\n"checkpoint":`;
  // The checkpoint as the runtime wrote it, which may be as long as a text can be.
  yield transfer.session.checkpointJson;
  yield `,\n"events":[`;
  for (const [index, event] of transfer.session.events.entries()) {
    yield index === 0 ? "\n" : ",\n";
    yield serializeValidatedRuntimeJson(event);
  }
  yield `\n],\n"entries":[`;
  for (const [index, entry] of transfer.entries.entries()) {
    yield index === 0 ? "\n" : ",\n";
    yield serializeValidatedRuntimeJson({ key: entry.key, value: entry.value });
  }
  yield `\n],\n"media":[`;
  for (const [index, medium] of transfer.media.entries()) {
    yield `${index === 0 ? "\n" : ",\n"}{"reference":${JSON.stringify(medium.reference)},"kind":${JSON.stringify(medium.kind)},"type":${JSON.stringify(medium.type)},"width":${JSON.stringify(medium.width)},"height":${JSON.stringify(medium.height)},"durationMs":${JSON.stringify(medium.durationMs)},"byteLength":${medium.bytes.length},"data":"`;
    yield* base64urlSlices(medium.bytes);
    yield `"}`;
  }
  yield "\n]}\n";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
