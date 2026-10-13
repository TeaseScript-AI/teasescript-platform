import { storedFileKind, type RuntimeFileStoreActionSnapshot } from "../src/index.js";
import type { CapturedMediaStore } from "./captured-media.js";
import type { PlayerDiagnostic } from "./session-camera.js";
import {
  activePlayerRuntimeFileStore,
  answerPlayerRuntimeFileStore,
  type PlayerFileStoreAnswer,
  type PlayerRuntimeSession,
} from "./runtime-adapter.js";

/** The store that keeps the files of a file store and vouches for them; the Player's captured-media store. */
export type FileStoreMedia = Pick<CapturedMediaStore, "add" | "read" | "holds">;

/**
 * The Player's answer to a file store (V30 §13 and §33): it keeps each file to store as session media of the kind of
 * its type, as a new photo is kept, or reads the bytes of each stored file, or their SHA-256. When it cannot, it answers
 * that it failed.
 */
export async function answerFileStore(
  action: RuntimeFileStoreActionSnapshot,
  media: FileStoreMedia,
): Promise<PlayerFileStoreAnswer> {
  try {
    if (action.operation === "store")
      return {
        kind: "stored",
        references: action.files.map(
          (file) =>
            media.add(
              storedFileKind(file.type),
              new Blob([bytesFromBase64(file.base64)], { type: file.type }),
            ).reference,
        ),
      };
    const answers: string[] = [];
    for (const reference of action.references) {
      const record = await media.read(reference);
      if (record === null) return { kind: "failed" };
      const data = await record.data.arrayBuffer();
      answers.push(
        action.operation === "hash"
          ? hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
          : base64FromBytes(new Uint8Array(data)),
      );
    }
    return action.operation === "hash"
      ? { kind: "hashed", hashes: answers }
      : { kind: "read", files: answers };
  } catch {
    // Such as a file too large for this browser's memory, or a hash outside a secure context, such as a Player over plain
    // HTTP on a local network, where the browser has no `crypto.subtle`.
    return { kind: "failed" };
  }
}

/** A SHA-256 digest as 64 lowercase hexadecimal digits. */
function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Base64 works on text of one byte per character, which this many bytes at a time are made into. */
const BYTE_CHUNK = 8_192;

function base64FromBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += BYTE_CHUNK)
    parts.push(String.fromCharCode(...bytes.subarray(start, start + BYTE_CHUNK)));
  return btoa(parts.join(""));
}

export interface FileStoreServiceHost {
  /** The published session, or `null` before one starts. */
  session(): PlayerRuntimeSession | null;
  /** Identifies the published session; it changes when another session starts. */
  generation(): number;
  /**
   * Observes the current time, publishes the result, and returns the published session; `null` when the session takes
   * no input, as once a Player error stopped it.
   */
  observe(): PlayerRuntimeSession | null;
  publish(session: PlayerRuntimeSession): void;
  readonly media: FileStoreMedia;
  diagnostic(diagnostic: PlayerDiagnostic): void;
  /** Runs `task` later, after the engine had a chance to run. */
  later(task: () => void): void;
}

/**
 * Answers each pending file store once and delivers that answer until the runtime settles it, as `CaptureService` does
 * for photos: when the runtime cannot take it yet (`executionPending`), the same answer is offered again later, so files
 * are never stored twice. Action IDs restart with every session, so an answer belongs to one session and one action.
 */
export class FileStoreService {
  readonly #host: FileStoreServiceHost;
  #key: string | null = null;
  #pending: Promise<PlayerFileStoreAnswer> | null = null;
  #servicing = false;
  #scheduled = false;
  #stopped = false;

  constructor(host: FileStoreServiceHost) {
    this.#host = host;
  }

  /** Services the published session's pending file store soon; call whenever the session changes. */
  request(): void {
    if (this.#scheduled || this.#stopped) return;
    this.#scheduled = true;
    this.#host.later(() => {
      this.#scheduled = false;
      void this.#service();
    });
  }

  /** Stops servicing, for example when the Player unmounts; answers still in flight are dropped. */
  stop(): void {
    this.#stopped = true;
    this.#key = null;
    this.#pending = null;
  }

  /** Forgets the answer being made, as for a new or stopped session; one still in flight is dropped. */
  reset(): void {
    this.#key = null;
    this.#pending = null;
  }

  async #service(): Promise<void> {
    const current = this.#host.session();
    const action = current && activePlayerRuntimeFileStore(current.state);
    if (!action || this.#servicing || this.#stopped) return;
    this.#servicing = true;
    const generation = this.#host.generation();
    const key = `${generation}:${action.actionId}`;
    try {
      if (this.#key !== key || this.#pending === null) {
        this.#key = key;
        this.#pending = answerFileStore(action, this.#host.media);
      }
      const answer = await this.#pending;
      if (this.#stopped || this.#key !== key || this.#host.generation() !== generation) return;
      // Input happens at the observed time.
      const observed = this.#host.observe();
      if (!observed || activePlayerRuntimeFileStore(observed.state)?.actionId !== action.actionId) {
        this.#settled(key);
        return;
      }
      const result = answerPlayerRuntimeFileStore(
        observed,
        action.actionId,
        answer,
        this.#host.media,
      );
      // `executionPending`: the same answer is offered again in the next service.
      if (result.outcome.kind === "executionPending") return;
      this.#settled(key);
      if (result.outcome.kind === "invalidPayload") {
        this.#host.diagnostic({ code: "file-store-rejected", message: result.outcome.message });
        // Never leave the script waiting: answer this file store as failed instead.
        this.#host.publish(
          answerPlayerRuntimeFileStore(observed, action.actionId, { kind: "failed" }).session,
        );
        return;
      }
      if (result.outcome.kind === "completed") this.#host.publish(result.session);
    } finally {
      this.#servicing = false;
      // A retry, or the next file store of the same or a replacing session.
      this.request();
    }
  }

  #settled(key: string): void {
    if (this.#key !== key) return;
    this.#key = null;
    this.#pending = null;
  }
}
