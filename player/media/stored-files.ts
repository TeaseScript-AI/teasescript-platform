import type { ActionCompletionOutcome, RuntimeFileStoreActionSnapshot } from "../../src/index.js";
import { storedFileKind } from "../../src/runtime/host-data/stored-files.js";
import { answerRecord, dropAnswer, sendAnswer, type AnswerRecord } from "./answer-media.js";
import type { CapturedMediaStore } from "./captured-media.js";
import type { PlayerDiagnostic } from "./session-camera.js";
import { heldMedia } from "../engine-bridge/held-media.js";
import { endsQuietly, refusalCode, type ServiceSection } from "../runtime/player-bridge.js";
import type { PlayerFileStoreAnswer } from "../runtime/runtime-adapter.js";
import { activePlayerRuntimeFileStore, type PlayerSession } from "../runtime/runtime-view.js";

/**
 * The store that keeps the files of a file store, vouches for them, and discards those no answer handed off; the Player's
 * captured-media store.
 */
export type FileStoreMedia = Pick<CapturedMediaStore, "add" | "read" | "holds" | "discard">;

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
   * Runs `body` as one exclusive section of the published session, after the clock's observation inside it, which
   * `observed` gives (`null` once the session no longer owns the UI); `null` without a session, or once a Player error
   * stopped it.
   */
  section<T>(
    body: (section: ServiceSection, observed: PlayerSession | null) => Promise<T>,
  ): Promise<T | null>;
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
  /** The answer being made or delivered; its stored files are this service's until the runtime takes it (#1882). */
  #answer: AnswerRecord<PlayerFileStoreAnswer> | null = null;
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
    this.#replace(null);
  }

  /** Forgets the answer being made, as for a new or stopped session; one still in flight is dropped. */
  reset(): void {
    this.#replace(null);
  }

  async #service(): Promise<void> {
    if (this.#servicing || this.#stopped) return;
    const generation = this.#host.generation();
    // An answer of a session no longer published is never handed off.
    if (this.#answer !== null && this.#answer.generation !== generation) this.#replace(null);
    const current = this.#host.session();
    const action = current && activePlayerRuntimeFileStore(current.state);
    if (!action) return;
    this.#servicing = true;
    const key = `${generation}:${action.actionId}`;
    try {
      if (this.#answer?.key !== key)
        this.#replace(answerRecord(key, generation, answerFileStore(action, this.#host.media)));
      const record = this.#answer!;
      const answer = await record.promise;
      if (!this.#current(record)) return;
      await this.#host.section((section, observed) =>
        this.#deliver(section, observed, record, action.actionId, answer),
      );
    } catch (error) {
      // A refusal changed nothing: a basis another op replaced keeps this answer for the next service, a released
      // session needs none, and a Player error stop, or the Worker's loss, already dropped it.
      const refused = refusalCode(error);
      if (refused === "session") this.#settled(key);
      else if (refused !== "basis" && !endsQuietly(error)) throw error;
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
    observed: PlayerSession | null,
    record: AnswerRecord<PlayerFileStoreAnswer>,
    actionId: number,
    answer: PlayerFileStoreAnswer,
  ): Promise<void> {
    if (!this.#current(record)) return;
    if (!observed || activePlayerRuntimeFileStore(observed.state)?.actionId !== actionId)
      return this.#settled(record.key);
    const outcome = await this.#send(record, () =>
      section.send<ActionCompletionOutcome>(
        "answerFileStore",
        { actionId, answer, held: heldMedia(this.#host.media, madeFiles(answer)) },
        observed.revision,
      ),
    );
    // A reply after a stop or a replacement settles and reports nothing here.
    if (!this.#current(record)) return;
    // `executionPending`: the same answer is offered again in the next service.
    if (outcome.kind === "executionPending") return;
    if (outcome.kind !== "invalidPayload") return this.#settled(record.key);
    this.#host.diagnostic({ code: "file-store-rejected", message: outcome.message });
    // Never leave the script waiting: answer this file store as failed instead, which is now its answer.
    const fallback = answerRecord<PlayerFileStoreAnswer>(
      record.key,
      record.generation,
      Promise.resolve({ kind: "failed" }),
    );
    this.#replace(fallback);
    await this.#send(fallback, () =>
      section.send<ActionCompletionOutcome>(
        "answerFileStore",
        { actionId, answer: { kind: "failed" }, held: null },
        observed.revision,
      ),
    );
    if (this.#current(fallback)) this.#settled(fallback.key);
  }

  /** Sends `record`'s answer; see `sendAnswer`. */
  #send<R extends { readonly kind: string }>(
    record: AnswerRecord<PlayerFileStoreAnswer>,
    send: () => Promise<R>,
  ): Promise<R> {
    return sendAnswer(
      record,
      send,
      () => this.#answer === record,
      (dropped) => dropAnswer(dropped, madeFiles, this.#host.media),
    );
  }

  /** Makes `next` the answer, letting go of the one before (`dropAnswer`). */
  #replace(next: AnswerRecord<PlayerFileStoreAnswer> | null): void {
    const previous = this.#answer;
    this.#answer = next;
    if (previous !== next) dropAnswer(previous, madeFiles, this.#host.media);
  }

  /** Whether `record` is still the answer to deliver: not stopped, not reset or replaced, the same session. */
  #current(record: AnswerRecord<PlayerFileStoreAnswer>): boolean {
    return (
      !this.#stopped && this.#answer === record && this.#host.generation() === record.generation
    );
  }

  #settled(key: string): void {
    if (this.#answer?.key === key) this.#replace(null);
  }
}

/** The files a file store's answer made: those of a `stored` answer. */
function madeFiles(answer: PlayerFileStoreAnswer): readonly string[] {
  return answer.kind === "stored" ? answer.references : [];
}
