import type { ActionCompletionOutcome, RuntimeFileStoreActionSnapshot } from "../src/index.js";
import { storedFileKind } from "../src/runtime/host-data/stored-files.js";
import type { CapturedMediaStore } from "./captured-media.js";
import type { PlayerDiagnostic } from "./session-camera.js";
import { heldMedia } from "./engine-bridge/held-media.js";
import { refusalCode, type ServiceSection } from "./player-bridge.js";
import type { PlayerFileStoreAnswer } from "./runtime-adapter.js";
import { activePlayerRuntimeFileStore, type PlayerSession } from "./runtime-view.js";

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

export function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Base64 works on text of one byte per character, which this many bytes at a time are made into. */
const BYTE_CHUNK = 8_192;

export function base64FromBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += BYTE_CHUNK)
    parts.push(String.fromCharCode(...bytes.subarray(start, start + BYTE_CHUNK)));
  return btoa(parts.join(""));
}

export interface FileStoreServiceHost {
  /** The published session, or `null` before one starts. */
  session(): PlayerSession | null;
  /** Identifies the published session; it changes when another session starts. */
  generation(): number;
  /**
   * Runs `body` as one exclusive section of the published session, with an observation inside it; `null` without a
   * session, or once a Player error stopped it.
   */
  section<T>(body: (section: ServiceSection) => Promise<T>): Promise<T | null>;
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
      if (!this.#current(key, generation)) return;
      await this.#host.section((section) =>
        this.#deliver(section, key, generation, action.actionId, answer),
      );
    } catch (error) {
      // A refusal changed nothing: a basis another op replaced keeps this answer for the next service, a released
      // session needs none, and a Player error stop already dropped it.
      const refused = refusalCode(error);
      if (refused === "session") this.#settled(key);
      else if (refused !== "basis" && refused !== "halted") throw error;
    } finally {
      this.#servicing = false;
      // A retry, or the next file store of the same or a replacing session.
      this.request();
    }
  }

  /**
   * Delivers `answer` in a section, as `CaptureService` does: input happens at the observed time, and whether to send is
   * decided right before each send.
   */
  async #deliver(
    section: ServiceSection,
    key: string,
    generation: number,
    actionId: number,
    answer: PlayerFileStoreAnswer,
  ): Promise<void> {
    const observed = await section.observe();
    if (!this.#current(key, generation)) return;
    if (!observed || activePlayerRuntimeFileStore(observed.state)?.actionId !== actionId)
      return this.#settled(key);
    const outcome = await section.send<ActionCompletionOutcome>(
      "answerFileStore",
      {
        actionId,
        answer,
        held: heldMedia(this.#host.media, answer.kind === "stored" ? answer.references : []),
      },
      observed.revision,
    );
    // A reply after a stop or a replacement settles and reports nothing here.
    if (!this.#current(key, generation)) return;
    // `executionPending`: the same answer is offered again in the next service.
    if (outcome.kind === "executionPending") return;
    if (outcome.kind !== "invalidPayload") return this.#settled(key);
    this.#host.diagnostic({ code: "file-store-rejected", message: outcome.message });
    // Never leave the script waiting: answer this file store as failed instead, which is now its answer.
    const fallback: PlayerFileStoreAnswer = { kind: "failed" };
    this.#pending = Promise.resolve(fallback);
    await section.send(
      "answerFileStore",
      { actionId, answer: fallback, held: null },
      observed.revision,
    );
    if (this.#current(key, generation)) this.#settled(key);
  }

  /** Whether the answer of `key` is still the one to deliver: not stopped, not reset, the same session. */
  #current(key: string, generation: number): boolean {
    return !this.#stopped && this.#key === key && this.#host.generation() === generation;
  }

  #settled(key: string): void {
    if (this.#key !== key) return;
    this.#key = null;
    this.#pending = null;
  }
}
