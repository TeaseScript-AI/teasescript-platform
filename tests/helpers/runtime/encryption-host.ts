/*
 * The encryption tests' shared host (`runtime/encryption`, `runtime/encryption-interruptions`,
 * `semantic/encryption-checks`): a fake Player that answers the lock dialogs, a run through them, and the clock and keys.
 * Orchestrator 2's; a change to the exports `semantic/encryption-checks` uses names the O4 lead as required reviewer.
 */

import assert from "node:assert/strict";
import type { InstructionPlan } from "../../../src/plan/model.js";
import { validateInstructionPlan } from "../../../src/plan/validation.js";
import type { RuntimeLockActionSnapshot } from "../../../src/runtime/actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../../src/runtime/snapshot/checkpoint.js";
import { run } from "../../../src/runtime/engine.js";
import type { InterpreterEvent } from "../../../src/runtime/events.js";
import { completeAction } from "../../../src/runtime/operations/complete-action.js";
import { observeTime } from "../../../src/runtime/operations/observe-time.js";
import type { FreshRuntimeOptions, RuntimeSnapshot } from "../../../src/runtime/snapshot/state.js";
import {
  storedFileKind,
  type StoredFileKind,
} from "../../../src/runtime/host-data/stored-files.js";
import { compileValidPlan } from "../compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "../immediate-pacing-runtime.js";
import { validateRuntimeSnapshot } from "../../../src/runtime/snapshot/snapshot-validation.js";

/*
 * encryptText, encryptFile, decryptText, and decryptFile (V30 §13), from source through the engine's lock steps, which a
 * fake Player answers here: it keeps what each lock holds under a made-up Base64 lock or locked file, and opens it with
 * the right password, or with its time lock once its moment has passed. The real locks are tested with the Player.
 */

export const WALL_CLOCK_MS = Date.UTC(2026, 9, 14, 12, 0, 0);
/** Keyholders' public keys: an age recipient and an OpenSSH Ed25519 key. */
export const AGE_KEY = "age1szy34zwzdlhaxywum5gj5pvjp9z5auwqjl9m3kmv3gmz7t5tg9uqx4gu67";
export const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEa/HNw9HfBfxM2AimkF4iqPUNEnLALWhpLl/NrvV/61 keyholder";
const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

interface FakeLock {
  readonly content: string;
  readonly password: string | null;
  readonly timeLockMs: number | null;
}

type DialogAnswer =
  | {
      readonly password?: string;
      readonly timeLockMs?: number;
      readonly publicKeys?: readonly string[];
      readonly key?: string;
    }
  | "cancel";

/** The Player's store and its locks, as the engine meets them. */
export class FakePlayer {
  readonly files = new Map<string, { readonly kind: StoredFileKind; readonly content: string }>();
  readonly locks = new Map<string, FakeLock>();
  /** Each lock's public keys, and its content key as a keyholder sends it back: `key 1` for the first lock. */
  readonly publicKeys = new Map<string, readonly string[]>();
  readonly keys = new Map<string, string>();
  /** What the dialogs answer, in order: what the player typed, or a cancel. */
  readonly dialogs: DialogAnswer[] = [];
  /** Whether the typed answer is lost before the step after the dialog, as on a reload. */
  forget = false;
  #typed: Exclude<DialogAnswer, "cancel"> | null = null;
  #next = 1;

  readonly admission = {
    holds: (reference: string, kind: StoredFileKind) => this.files.get(reference)?.kind === kind,
  };

  /** The moment the Player's time service gives when it opens: the session's clock, moving with scene time. */
  nowMs(action: RuntimeLockActionSnapshot): number {
    return WALL_CLOCK_MS + action.createdAtMs;
  }

  keep(type: string, content: string): string {
    const reference = `stored:${this.#next++}`;
    this.files.set(reference, { kind: storedFileKind(type), content });
    return reference;
  }

  /** A made-up lock as standard Base64, unique per lock. */
  #lock(lock: FakeLock): string {
    const text = Buffer.from(`lock ${this.#next++}`).toString("base64");
    this.locks.set(text, lock);
    return text;
  }

  answer(action: RuntimeLockActionSnapshot) {
    if (action.phase === "ask") {
      const dialog = this.dialogs.shift() ?? {};
      if (dialog === "cancel") return { kind: "cancelled" };
      this.#typed = this.forget ? null : dialog;
      return { kind: "submitted" };
    }
    const typed = action.dialogActionId === null ? null : this.#typed;
    this.#typed = null;
    if (action.call === "encryptText" || action.call === "encryptFile") {
      if (action.dialogActionId !== null && typed === null) return { kind: "ask" };
      // The password field and the openers the player chose come from what was typed, the others from the call.
      const lock: FakeLock = {
        content:
          action.call === "encryptText" ? action.value : this.files.get(action.value)!.content,
        password:
          action.passwordField !== null || action.choices.includes("password")
            ? (typed?.password ?? null)
            : action.password,
        timeLockMs: action.choices.includes("timeLock")
          ? (typed?.timeLockMs ?? null)
          : action.timeLockMs,
      };
      const text = this.#lock(lock);
      this.publicKeys.set(
        text,
        action.choices.includes("publicKey") ? (typed?.publicKeys ?? []) : action.publicKeys,
      );
      this.keys.set(text, `key ${this.keys.size + 1}`);
      return action.call === "encryptText"
        ? { kind: "locked", text }
        : { kind: "locked", file: this.keep("application/octet-stream", text) };
    }
    if (action.dialogActionId !== null && action.passwordField !== null && typed === null)
      return { kind: "ask" };
    const text =
      action.call === "decryptText" ? action.value : this.files.get(action.value)?.content;
    const lock = text === undefined ? undefined : this.locks.get(text);
    if (lock === undefined) return { kind: "notOpened" };
    // A written password or key gives the default, also a password from the password field; so does a lock with
    // nothing else to try. The dialog gives a key or a password.
    const written =
      action.password !== null || action.key !== null || action.passwordField !== null;
    const key = action.key ?? typed?.key ?? null;
    const password = typed?.password ?? action.password;
    const passed = lock.timeLockMs !== null && lock.timeLockMs <= this.nowMs(action);
    const lockKey = text === undefined ? undefined : this.keys.get(text);
    if (key !== null && key !== lockKey && !written) return { kind: "ask", notice: "wrongKey" };
    const opens =
      key !== null && key === lockKey
        ? true
        : password !== null
          ? password === lock.password
          : key === null && passed;
    if (!opens) {
      if (written || (lock.password === null && passed)) return { kind: "notOpened" };
      return password === null ? { kind: "ask" } : { kind: "ask", notice: "wrongPassword" };
    }
    return action.call === "decryptText"
      ? { kind: "opened", text: lock.content }
      : { kind: "opened", file: this.keep("image/png", lock.content), type: "image/png" };
  }
}

export interface Played {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[];
  /** The lock steps, in order. */
  readonly steps: RuntimeLockActionSnapshot[];
}

/**
 * Runs `source` until it ends, answering each lock step from `player` and letting each wait's time pass. It restores a
 * checkpoint of the state at every boundary first, so that each pending step and each handed-off answer is also carried
 * by a checkpoint.
 */
export function play(
  source: string,
  player = new FakePlayer(),
  options: Pick<FreshRuntimeOptions, "storedFiles" | "wallClockMs"> = {
    wallClockMs: WALL_CLOCK_MS,
  },
): Played {
  const plan = compileValidPlan(source);
  assert.equal(validateInstructionPlan(plan).valid, true);
  const restored = (snapshot: RuntimeSnapshot): RuntimeSnapshot => {
    assert.deepEqual(validateRuntimeSnapshot(snapshot, plan).errors, []);
    const json = serializeCheckpoint(createCheckpoint(plan, snapshot));
    const checkpoint = deserializeCheckpoint(json);
    assert.equal(serializeCheckpoint(checkpoint), json);
    return checkpoint.snapshot;
  };
  const events: InterpreterEvent[] = [];
  const steps: RuntimeLockActionSnapshot[] = [];
  let result = run(plan, createImmediatePacingRuntimeSnapshot(plan, options));
  events.push(...result.events);
  for (let guard = 0; result.snapshot.status === "waiting"; guard += 1) {
    assert.ok(guard < 50, "the script keeps waiting");
    const snapshot = restored(result.snapshot);
    const action = snapshot.foregroundAction!;
    if (action.kind === "delay") {
      const observed = observeTime(plan, snapshot, action.deadlineMs);
      events.push(...observed.events);
      result = run(plan, restored(observed.snapshot));
      events.push(...result.events);
      continue;
    }
    assert.equal(action.kind, "lock");
    steps.push(action);
    const completed = completeAction(
      plan,
      snapshot,
      { actionId: action.actionId, actionKind: "lock", payload: player.answer(action) },
      { capturedMedia: player.admission },
    );
    assert.equal(completed.outcome.kind, "completed", JSON.stringify(completed.outcome));
    events.push(...completed.events);
    result = run(plan, restored(completed.snapshot));
    events.push(...result.events);
  }
  return { plan, snapshot: result.snapshot, events, steps };
}

/** The lock step a state waits for. */
export function lockStep(snapshot: RuntimeSnapshot): RuntimeLockActionSnapshot {
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "lock");
  return action;
}

export function failure(played: Played): { code: string; message: string } {
  const failed = played.snapshot.failure;
  assert.notEqual(failed, null);
  return { code: failed!.code, message: failed!.message };
}
