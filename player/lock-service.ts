import {
  fileType,
  OCTET_STREAM,
  storedFileKind,
  type RuntimeLockActionSnapshot,
  type RuntimeLockChoice,
  type RuntimeLockNotice,
} from "../src/index.js";
import type { LockServices, ReadLock } from "./encryption/lock.js";
import {
  activePlayerRuntimeLock,
  answerPlayerRuntimeLock,
  type PlayerLockAnswer,
  type PlayerRuntimeSession,
} from "./runtime-adapter.js";
import type { PlayerDiagnostic } from "./session-camera.js";
import { base64FromBytes, bytesFromBase64, type FileStoreMedia } from "./stored-files.js";

/**
 * A dialog of a lock (V30 §13, PLAYER-UI "Foreground interaction presentation"): the lock dialog of an encrypt call, with
 * the openers the player chooses, the unlock dialog of a decrypt call, with what opens this lock, or the composer's
 * password field of `password: askPassword(...)`.
 */
export type LockDialog =
  | {
      readonly kind: "lock";
      readonly key: string;
      readonly actionId: number;
      /** The openers the player chooses, in the order the dialog shows them. */
      readonly choices: readonly RuntimeLockChoice[];
      /** The moment the lock dialog suggests for a chosen time lock, 7 days from now, in epoch milliseconds. */
      readonly suggestedTimeLockMs: number | null;
      /** The openers the call itself gives besides them: a password, and a time lock. */
      readonly given: { readonly password: boolean; readonly timeLock: boolean };
    }
  | {
      readonly kind: "unlock";
      readonly key: string;
      readonly actionId: number;
      /** Whether a password opens it. */
      readonly password: boolean;
      /** The moments its time locks open at, in epoch milliseconds. */
      readonly moments: readonly number[];
      readonly notice: RuntimeLockNotice | null;
    }
  | {
      readonly kind: "password";
      readonly key: string;
      readonly actionId: number;
      /** Whether a "Repeat password" field asks for it again, as for an encrypt call. */
      readonly repeat: boolean;
      /** The `hint:` of `askPassword`, or `null`. */
      readonly hint: string | null;
    };

/**
 * What the player gave in a dialog: a password, and the lock dialog's moment, `null` where the player switched its time
 * lock off or the dialog does not ask for one; nothing for "Try again".
 */
export interface LockDialogInput {
  readonly password: string | null;
  readonly timeLockMs: number | null;
}

export interface LockServiceHost {
  /** The published session, or `null` before one starts. */
  session(): PlayerRuntimeSession | null;
  /** Identifies the published session; it changes when another session starts. */
  generation(): number;
  /** Observes the current time, publishes the result, and returns the published session, or `null` without input. */
  observe(): PlayerRuntimeSession | null;
  publish(session: PlayerRuntimeSession): void;
  readonly media: FileStoreMedia;
  diagnostic(diagnostic: PlayerDiagnostic): void;
  /** Shows a lock dialog, or none; `busy` while the Player locks or opens with what the player gave in it. */
  dialog(dialog: LockDialog | null, busy: boolean): void;
  /** Runs `task` later, after the engine had a chance to run. */
  later(task: () => void): void;
  /** Runs `task` after `delayMs`; the returned function cancels it. */
  after(delayMs: number, task: () => void): () => void;
  /** The browser's WebCrypto, or `undefined` outside a secure context. */
  readonly subtle?: SubtleCrypto | undefined;
  /** The time lock's code, the relays, and the device clock; the browser's by default. */
  readonly crypto?: LockServices;
}

/** The lock code, which the Player loads only when a script locks or opens; locking works offline once it is loaded. */
function lockCode() {
  return import("./encryption/lock.js");
}

const browserLockServices: LockServices = {
  tlock: () => import("./encryption/tlock.js"),
  fetch: (input, init) => fetch(input, init),
  nowMs: () => Date.now(),
};

/** A dialog's time lock that has passed by the device clock, but whose beacon was not out yet, is tried this often. */
const LATE_RETRY_MS = 30_000;
/** The longest a single wake waits for a dialog's time lock; a later moment is waited for in several wakes. */
const MAX_WAKE_MS = 60 * 60 * 1000;
/** How long after a round's moment its beacon is asked for, as relays publish it a moment later. */
const ROUND_MARGIN_MS = 2_000;

/**
 * Answers each lock step once and delivers that answer until the runtime settles it, as `FileStoreService` does, and
 * presents a step's dialog. What the player types stays in this service's memory, keyed by the dialog's action, until
 * the step after the dialog uses it; it never reaches the engine, and a reload forgets it, so that step asks again.
 */
export class LockService {
  readonly #host: LockServiceHost;
  readonly #crypto: LockServices;
  /** The answer being made or delivered, with the step it answers. */
  #answer: { readonly key: string; readonly promise: Promise<PlayerLockAnswer> } | null = null;
  /** What the player typed, by `generation:actionId` of the `ask` step whose dialog they answered. */
  readonly #typed = new Map<string, LockDialogInput>();
  /**
   * An encrypt call's lock dialog, for the openers the player chooses, that follows its password field in the same step,
   * and then the password typed in that field, by the step's key.
   */
  #followUp: { readonly key: string; readonly dialog: LockDialog; password: string | null } | null =
    null;
  #dialog: LockDialog | null = null;
  #busy = false;
  #preparing: string | null = null;
  #cancelRetry: (() => void) | null = null;
  #servicing = false;
  #scheduled = false;
  #stopped = false;

  constructor(host: LockServiceHost) {
    this.#host = host;
    this.#crypto = host.crypto ?? browserLockServices;
  }

  /** Services the published session's lock step soon; call whenever the session changes. */
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
    this.reset();
  }

  /** Forgets the answer being made, what was typed, and the dialog, as for a new or stopped session. */
  reset(): void {
    this.#answer = null;
    this.#typed.clear();
    this.#followUp = null;
    this.#showDialog(null);
  }

  /** The player's answer to the dialog shown: what they typed, or nothing to try the time lock again. */
  submit(input: LockDialogInput): void {
    const dialog = this.#dialog;
    if (dialog === null || this.#answer?.key === dialog.key) return;
    const followUp = this.#followUp?.key === dialog.key ? this.#followUp : null;
    // The password field's password waits, in memory, for the lock dialog that follows it.
    if (followUp !== null && dialog.kind === "password") {
      followUp.password = input.password;
      this.#showDialog(followUp.dialog);
      return;
    }
    this.#followUp = null;
    this.#typed.set(
      `${this.#host.generation()}:${dialog.actionId}`,
      followUp === null ? input : { ...input, password: followUp.password },
    );
    this.#answer = { key: dialog.key, promise: Promise.resolve({ kind: "submitted" }) };
    this.#showDialog(dialog, true);
    this.request();
  }

  /** The player cancels the unlock dialog shown, which gives the call's default. */
  cancel(): void {
    const dialog = this.#dialog;
    if (dialog?.kind !== "unlock" || this.#answer?.key === dialog.key) return;
    this.#answer = { key: dialog.key, promise: Promise.resolve({ kind: "cancelled" }) };
    this.#showDialog(dialog, true);
    this.request();
  }

  async #service(): Promise<void> {
    const current = this.#host.session();
    const action = current && activePlayerRuntimeLock(current.state);
    if (this.#servicing || this.#stopped) return;
    if (!action) {
      // Also while an expiry block interrupts a dialog: it shows again once the block returns.
      this.#showDialog(null);
      return;
    }
    const generation = this.#host.generation();
    // A dialog that asks again after an expiry block is a new presentation, so nothing typed before stays.
    const key = `${generation}:${action.actionId}:${action.resumes}`;
    if (action.phase === "ask" && this.#answer?.key !== key) {
      if (this.#dialog?.key !== key) await this.#present(action, key);
      return;
    }
    this.#servicing = true;
    try {
      if (this.#answer?.key !== key) {
        // The dialog the player just answered stays, busy, while this step uses what they gave.
        const answered =
          action.dialogActionId !== null && this.#dialog?.actionId === action.dialogActionId;
        this.#showDialog(answered ? this.#dialog : null, answered);
        const typed =
          action.dialogActionId === null
            ? null
            : (this.#typed.get(`${generation}:${action.dialogActionId}`) ?? undefined);
        this.#typed.clear();
        this.#answer = { key, promise: this.#work(action, typed) };
      }
      const answer = await this.#answer.promise;
      if (this.#stopped || this.#answer?.key !== key || this.#host.generation() !== generation)
        return;
      // Input happens at the observed time.
      const observed = this.#host.observe();
      if (!observed || activePlayerRuntimeLock(observed.state)?.actionId !== action.actionId) {
        this.#settled(key);
        return;
      }
      const result = answerPlayerRuntimeLock(observed, action.actionId, answer, this.#host.media);
      // `executionPending`: the same answer is offered again in the next service.
      if (result.outcome.kind === "executionPending") return;
      this.#settled(key);
      if (result.outcome.kind === "invalidPayload") {
        this.#host.diagnostic({ code: "lock-rejected", message: result.outcome.message });
        // Never leave the script waiting: a step fails, and a dialog's answer is dropped, so the dialog asks again.
        if (action.phase === "work")
          this.#host.publish(
            answerPlayerRuntimeLock(observed, action.actionId, {
              kind: "failed",
              reason: "unavailable",
            }).session,
          );
        else this.#showDialog(null);
        return;
      }
      if (result.outcome.kind === "completed") this.#host.publish(result.session);
    } finally {
      this.#servicing = false;
      // A retry, or the next step of the same or a replacing session.
      this.request();
    }
  }

  #settled(key: string): void {
    if (this.#answer?.key === key) this.#answer = null;
  }

  /** Shows the dialog of a step that asks; without WebCrypto it submits at once, so the next step reports it. */
  async #present(action: RuntimeLockActionSnapshot, key: string): Promise<void> {
    if (this.#preparing === key) return;
    if (this.#host.subtle === undefined) {
      this.#answer = { key, promise: Promise.resolve({ kind: "submitted" }) };
      this.request();
      return;
    }
    const encrypts = action.call === "encryptText" || action.call === "encryptFile";
    if (action.passwordField !== null) {
      // The password field asks first, and the lock dialog for the openers the player chooses after it.
      this.#followUp =
        encrypts && action.choices.length > 0
          ? { key, dialog: lockDialog(action, key), password: null }
          : null;
      this.#showDialog(
        {
          kind: "password",
          key,
          actionId: action.actionId,
          repeat: encrypts,
          hint: action.passwordField.hint,
        },
        false,
      );
      return;
    }
    if (encrypts) {
      this.#showDialog(lockDialog(action, key), false);
      return;
    }
    this.#preparing = key;
    const read = await this.#readLock(action).catch(() => null);
    this.#preparing = null;
    const current = this.#host.session();
    if (this.#stopped || current === null) return;
    const active = activePlayerRuntimeLock(current.state);
    if (
      active === null ||
      `${this.#host.generation()}:${active.actionId}:${active.resumes}` !== key ||
      active.phase !== "ask"
    ) {
      this.request();
      return;
    }
    // A lock that cannot be read any more is tried again, and its step reports why.
    if (read === null || read === "unreadable") {
      this.#answer = { key, promise: Promise.resolve({ kind: "submitted" }) };
      this.request();
      return;
    }
    const moments = (await lockCode()).timeLockMoments(read);
    this.#showDialog(
      {
        kind: "unlock",
        key,
        actionId: action.actionId,
        password: read.passwords.length > 0,
        moments,
        notice: action.notice,
      },
      false,
    );
    // A time lock whose moment comes while the dialog shows opens then, without the player.
    if (moments.length === 0 || action.notice === "unreachable") return;
    const now = this.#crypto.nowMs();
    const next = moments.filter((moment) => moment + ROUND_MARGIN_MS > now);
    const due = next.length > 0 ? Math.min(...next) + ROUND_MARGIN_MS : now + LATE_RETRY_MS;
    // Bounded wakes, each checking the clock again, so a moment far ahead is waited for, never cut short.
    const wake = () => {
      if (this.#dialog?.key !== key || this.#busy) return;
      const remaining = due - this.#crypto.nowMs();
      if (remaining <= 0) this.submit({ password: null, timeLockMs: null });
      else this.#cancelRetry = this.#host.after(Math.min(remaining, MAX_WAKE_MS), wake);
    };
    wake();
  }

  #showDialog(dialog: LockDialog | null, busy = false): void {
    // The lock dialog after a password field is the same step's: the same key, another dialog.
    if (this.#dialog === dialog && this.#busy === busy) return;
    if (this.#dialog?.key !== dialog?.key || busy) {
      this.#cancelRetry?.();
      this.#cancelRetry = null;
    }
    this.#dialog = dialog;
    this.#busy = dialog !== null && busy;
    this.#host.dialog(dialog, this.#busy);
  }

  /** The lock a decrypt step opens, `null` for bytes that are no lock, or `"unreadable"` for a file it cannot read. */
  async #readLock(action: RuntimeLockActionSnapshot): Promise<ReadLock | null | "unreadable"> {
    const bytes =
      action.call === "decryptText"
        ? bytesFromBase64(action.value)
        : await this.#file(action.value);
    return bytes === null ? "unreadable" : (await lockCode()).readLock(bytes);
  }

  async #file(reference: string): Promise<Uint8Array | null> {
    const record = await this.#host.media.read(reference);
    return record === null ? null : new Uint8Array(await record.data.arrayBuffer());
  }

  /**
   * The answer of a `work` step: the lock or the opened content, or why not. `typed` is what the player typed in the
   * dialog or password field before this step; `undefined` when this step follows one whose typed answer this Player no
   * longer has. An encrypt call locks with the openers it gives and, for its password field and the openers the player
   * chose, what they typed; a decrypt call's password field opens with the typed password alone.
   */
  async #work(
    action: RuntimeLockActionSnapshot,
    typed: LockDialogInput | null | undefined,
  ): Promise<PlayerLockAnswer> {
    if (this.#host.subtle === undefined) return { kind: "failed", reason: "unavailable" };
    try {
      if (action.call === "encryptText" || action.call === "encryptFile") {
        if (typed === undefined) return { kind: "ask" };
        // A step without the dialog or password field takes nothing typed.
        const answer = typed ?? { password: null, timeLockMs: null };
        const openers = {
          password:
            action.passwordField !== null || action.choices.includes("password")
              ? answer.password
              : action.password,
          timeLockMs: action.choices.includes("timeLock") ? answer.timeLockMs : action.timeLockMs,
        };
        // A lock needs an opener. The dialog does not submit without one, and an answer without one asks again.
        if (openers.password === null && openers.timeLockMs === null) return { kind: "ask" };
        const content =
          action.call === "encryptText"
            ? new TextEncoder().encode(action.value)
            : await this.#file(action.value);
        if (content === null) return { kind: "failed", reason: "unreadable" };
        const made = await (await lockCode()).lock(content, openers, this.#crypto);
        if (action.call === "encryptText")
          return { kind: "locked", text: base64FromBytes(made.bytes) };
        const entry = this.#host.media.add("file", new Blob([made.bytes], { type: OCTET_STREAM }));
        return { kind: "locked", file: entry.reference };
      }
      if (action.passwordField !== null && typed === undefined) return { kind: "ask" };
      const read = await this.#readLock(action);
      if (read === "unreadable") return { kind: "failed", reason: "unreadable" };
      if (read === null) return { kind: "notOpened" };
      const password = action.password ?? typed?.password ?? null;
      if (password !== null) {
        const content = await (await lockCode()).openWithPassword(read, password);
        if (content !== null) return this.#opened(action, content);
        // A password written in the call, also through its password field, gives the default; one typed in the dialog
        // asks again.
        return action.password !== null || action.passwordField !== null
          ? { kind: "notOpened" }
          : { kind: "ask", notice: "wrongPassword" };
      }
      const timed = await (await lockCode()).openWithTime(read, this.#crypto);
      if (timed.kind === "opened") return this.#opened(action, timed.content);
      const other = read.passwords.length > 0;
      if (timed.kind === "notYet") return { kind: "ask" };
      // Unreachable relays ask again where a password could open it or the dialog is already open, so it can try
      // again; otherwise a call with nothing else to try gives its default.
      if (timed.kind === "unreachable")
        return other || action.dialogActionId !== null
          ? { kind: "ask", notice: "unreachable" }
          : { kind: "notOpened" };
      // No time lock: a password may open it; a time lock whose key does not open it was changed.
      return read.times.length === 0 && other ? { kind: "ask" } : { kind: "notOpened" };
    } catch {
      // Such as a file too large for this browser's memory, or storage that cannot keep the locked file.
      return { kind: "failed", reason: "unavailable" };
    }
  }

  /** An opened text, which must be UTF-8, or an opened file, stored as a file of the type its bytes give. */
  #opened(action: RuntimeLockActionSnapshot, content: Uint8Array): PlayerLockAnswer {
    if (action.call === "decryptText") {
      try {
        return {
          kind: "opened",
          text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
        };
      } catch {
        return { kind: "notOpened" };
      }
    }
    const type = fileType(binaryHeader(content));
    const entry = this.#host.media.add(
      storedFileKind(type),
      new Blob([new Uint8Array(content)], { type }),
    );
    return { kind: "opened", file: entry.reference, type };
  }
}

/**
 * The lock dialog of an encrypt step, for the openers the player chooses: a chosen time lock suggests the step's moment,
 * and the call's own openers, also its password field's, are given.
 */
function lockDialog(action: RuntimeLockActionSnapshot, key: string): LockDialog {
  const timed = action.choices.includes("timeLock");
  return {
    kind: "lock",
    key,
    actionId: action.actionId,
    choices: action.choices,
    suggestedTimeLockMs: timed ? action.timeLockMs : null,
    given: {
      password: action.password !== null || action.passwordField !== null,
      timeLock: !timed && action.timeLockMs !== null,
    },
  };
}

/** The first bytes of a file, as the one-byte characters that `fileType` reads. */
function binaryHeader(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.subarray(0, 2048));
}
