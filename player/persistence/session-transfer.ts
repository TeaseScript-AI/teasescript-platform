import type { RuntimeScriptStorageEntrySnapshot } from "../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { MAX_TEXT_LENGTH } from "../../src/runtime/values/text-length.js";
import type { CapturedMediaKind, CapturedMediaRecord } from "../media/captured-media.js";
import type { PlayerRuntimeRestorePoint } from "../runtime/runtime-adapter.js";
import { transferFileName, transferTextWithin, type StorageBundle } from "./storage-transfer.js";
import { base64urlSlices, gzipSupported, jsonFile } from "./transfer-encoding.js";

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

/** The format and version a session export writes, which `session-transfer-read.ts` reads. */
export const SESSION_TRANSFER_FORMAT = "teasescript-session";
export const SESSION_TRANSFER_VERSION = 1;
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

/** The document in pieces, with one event and one saved value per line; media data is encoded slice by slice. */
function* pieces(transfer: SessionTransfer): Generator<string> {
  yield `{"format":${JSON.stringify(SESSION_TRANSFER_FORMAT)},"version":${SESSION_TRANSFER_VERSION},\n"scope":${JSON.stringify(transfer.scope)},"name":${JSON.stringify(transfer.name)},\n"checkpoint":`;
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
