import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import type { RuntimeLockActionSnapshot } from "../src/runtime/actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { SerializableRuntimeValue } from "../src/runtime/serializable-values.js";
import {
  validateRuntimeSnapshot,
  type FreshRuntimeOptions,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { storedFileKind, type StoredFileKind } from "../src/runtime/stored-files.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

/*
 * encryptText, encryptFile, decryptText, and decryptFile (V30 §13), from source through the engine's lock steps, which a
 * fake Player answers here: it keeps what each lock holds under a made-up Base64 lock or locked file, and opens it with
 * the right password, or with its time lock once its moment has passed. The real locks are tested with the Player.
 */

const WALL_CLOCK_MS = Date.UTC(2026, 9, 14, 12, 0, 0);
/** Keyholders' public keys: an age recipient and an OpenSSH Ed25519 key. */
const AGE_KEY = "age1szy34zwzdlhaxywum5gj5pvjp9z5auwqjl9m3kmv3gmz7t5tg9uqx4gu67";
const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEa/HNw9HfBfxM2AimkF4iqPUNEnLALWhpLl/NrvV/61 keyholder";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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
class FakePlayer {
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
      this.publicKeys.set(text, typed === null ? action.publicKeys : (typed.publicKeys ?? []));
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

interface Played {
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
function play(
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
function lockStep(snapshot: RuntimeSnapshot): RuntimeLockActionSnapshot {
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "lock");
  return action;
}

function variables(played: Played): Record<string, SerializableRuntimeValue> {
  assert.equal(played.snapshot.failure, null, JSON.stringify(played.snapshot.failure));
  return Object.fromEntries(
    played.snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
}

function failure(played: Played): { code: string; message: string } {
  const failed = played.snapshot.failure;
  assert.notEqual(failed, null);
  return { code: failed!.code, message: failed!.message };
}

function diagnostics(source: string): [string, string][] {
  return compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
  ]);
}

/**
 * What each step asked for: its call, phase, password, time lock, whether a dialog came first, its notice, and the
 * openers the player chooses.
 */
const asked = (played: Played) =>
  played.steps.map((step) => [
    step.call,
    step.phase,
    step.password,
    step.timeLockMs,
    step.dialogActionId !== null,
    step.notice,
    step.choices,
  ]);

test("encryptText locks with a written password and no time lock, and decryptText opens it", () => {
  const played = play(
    [
      'let locked = encryptText("corner time", password: "corner", timeLock: false)',
      'let opened = decryptText(locked, password: "corner", default: null)',
      'let wrong = decryptText(locked, password: "Corner", default: "no")',
      "exit",
    ].join("\n"),
  );
  const { locked, opened, wrong } = variables(played);
  assert.equal(typeof locked, "string");
  assert.equal(opened, "corner time");
  assert.equal(wrong, "no");
  assert.deepEqual(asked(played), [
    ["encryptText", "work", "corner", null, false, null, []],
    ["decryptText", "work", "corner", null, false, null, []],
    ["decryptText", "work", "Corner", null, false, null, []],
  ]);
  assert.equal(played.steps[0]!.value, "corner time");
  assert.equal(played.steps[1]!.value, locked);
});

test("timeLock: gives the time lock's moment, and false leaves an opener out", () => {
  const played = play(
    [
      'let friday = toAbsoluteDateTime("2026-10-16T18:00:00Z")',
      'let timed = encryptText("a", password: false, timeLock: getAbsoluteDateTime() + 3 days)',
      'let both = encryptText("b", password: "p", timeLock: friday)',
      'let passwordOnly = encryptText("c", password: "p", timeLock: false)',
      "exit",
    ].join("\n"),
  );
  variables(played);
  assert.deepEqual(
    asked(played).map((step) => step.slice(1, 4)),
    [
      ["work", null, WALL_CLOCK_MS + 3 * DAY_MS],
      ["work", "p", Date.UTC(2026, 9, 16, 18)],
      ["work", "p", null],
    ],
  );
});

test("a time lock opens without asking once its moment passed, and the unlock dialog asks before", () => {
  const player = new FakePlayer();
  player.dialogs.push("cancel");
  const played = play(
    [
      'let locked = encryptText("later", password: false, timeLock: getAbsoluteDateTime() + 1 hour)',
      'let early = decryptText(locked, default: "not yet")',
      "wait 2 h",
      'let late = decryptText(locked, default: "not yet")',
      "exit",
    ].join("\n"),
    player,
  );
  const { early, late } = variables(played);
  assert.equal(early, "not yet");
  assert.equal(late, "later");
  assert.deepEqual(
    asked(played).map((step) => step.slice(0, 2)),
    [
      ["encryptText", "work"],
      ["decryptText", "work"],
      ["decryptText", "ask"],
      ["decryptText", "work"],
    ],
  );
});

test("without any opener written the lock dialog asks for each, suggesting 7 days, and the Player locks with what the player chose", () => {
  const player = new FakePlayer();
  player.dialogs.push({ password: "typed" }, { password: "typed" });
  const played = play(
    [
      'let locked = encryptText("chosen")',
      "let opened = decryptText(locked, default: null)",
      "exit",
    ].join("\n"),
    player,
  );
  const { locked, opened } = variables(played);
  assert.equal(opened, "chosen");
  assert.ok(typeof locked === "string");
  assert.deepEqual(player.locks.get(locked), {
    content: "chosen",
    password: "typed",
    timeLockMs: null,
  });
  const both = ["timeLock", "password"];
  assert.deepEqual(asked(played), [
    ["encryptText", "ask", null, WALL_CLOCK_MS + 7 * DAY_MS, false, null, both],
    ["encryptText", "work", null, null, true, null, both],
    ["decryptText", "work", null, null, false, null, []],
    ["decryptText", "ask", null, null, false, null, []],
    ["decryptText", "work", null, null, true, null, []],
  ]);
  // The typed password never reaches the engine.
  assert.ok(!JSON.stringify([played.snapshot, played.events]).includes("typed"));
});

test("an opener written true is chosen in the lock dialog, which asks for those only, and the call's own openers stay", () => {
  const player = new FakePlayer();
  const friday = Date.UTC(2026, 9, 16, 18);
  player.dialogs.push(
    { timeLockMs: WALL_CLOCK_MS + 2 * DAY_MS },
    { password: "typed" },
    { password: "late" },
  );
  const played = play(
    [
      'let a = encryptText("a", password: "given", timeLock: true)',
      'let b = encryptText("b", password: true, timeLock: toAbsoluteDateTime("2026-10-16T18:00:00Z"))',
      "let wanted = 1 < 2",
      'let c = encryptText("c", password: wanted, timeLock: false)',
      "exit",
    ].join("\n"),
    player,
  );
  const { a, b, c } = variables(played);
  assert.deepEqual(
    [a, b, c].map((locked) => player.locks.get(String(locked))),
    [
      { content: "a", password: "given", timeLockMs: WALL_CLOCK_MS + 2 * DAY_MS },
      { content: "b", password: "typed", timeLockMs: friday },
      { content: "c", password: "late", timeLockMs: null },
    ],
  );
  assert.deepEqual(asked(played), [
    ["encryptText", "ask", "given", WALL_CLOCK_MS + 7 * DAY_MS, false, null, ["timeLock"]],
    ["encryptText", "work", "given", null, true, null, ["timeLock"]],
    ["encryptText", "ask", null, friday, false, null, ["password"]],
    ["encryptText", "work", null, friday, true, null, ["password"]],
    ["encryptText", "ask", null, null, false, null, ["password"]],
    ["encryptText", "work", null, null, true, null, ["password"]],
  ]);
});

test("a wrong password in the unlock dialog asks again with a notice, and a cancel gives the default", () => {
  const player = new FakePlayer();
  player.dialogs.push({ password: "wrong" }, "cancel");
  const played = play(
    [
      'let locked = encryptText("secret", password: "right", timeLock: false)',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
    player,
  );
  assert.equal(variables(played).opened, "closed");
  assert.deepEqual(
    asked(played)
      .slice(1)
      .map((step) => [step[1], step[4], step[5]]),
    [
      ["work", false, null],
      ["ask", false, null],
      ["work", true, null],
      ["ask", false, "wrongPassword"],
    ],
  );
});

test("a lock dialog whose typed answer was lost, as on a reload, asks again", () => {
  /** Forgets the first dialog's answer, and keeps the second's. */
  class ForgetfulPlayer extends FakePlayer {
    override answer(action: RuntimeLockActionSnapshot) {
      if (action.phase === "ask" && this.dialogs.length === 0) {
        this.forget = false;
        this.dialogs.push({ timeLockMs: WALL_CLOCK_MS + DAY_MS });
      }
      return super.answer(action);
    }
  }
  const player = new ForgetfulPlayer();
  player.forget = true;
  player.dialogs.push({ password: "lost" });
  const played = play(['let locked = encryptText("again")', "exit"].join("\n"), player);
  variables(played);
  assert.deepEqual(
    asked(played).map((step) => [step[1], step[4]]),
    [
      ["ask", false],
      ["work", true],
      ["ask", false],
      ["work", true],
    ],
  );
});

test("password: askPassword(...) asks in the password field, says its question, and keeps the typed text out", () => {
  const player = new FakePlayer();
  player.dialogs.push(
    { password: "s3cret pass" },
    { password: "s3cret pass" },
    { password: "xyzzy" },
  );
  const played = play(
    [
      'let locked = encryptText("corner time", password: askPassword("Choose a code", hint: "The code"), timeLock: getAbsoluteDateTime() + 7 days)',
      'let opened = decryptText(locked, password: askPassword "Your code?", default: null)',
      'let wrong = decryptText(locked, password: (askPassword("Again?")), default: "no")',
      "exit",
    ].join("\n"),
    player,
  );
  const { locked, opened, wrong } = variables(played);
  assert.equal(opened, "corner time");
  assert.equal(wrong, "no");
  // An encrypt call keeps its time lock; the field asks first, and the step after it works with its password.
  const moment = WALL_CLOCK_MS + 7 * DAY_MS;
  assert.deepEqual(asked(played), [
    ["encryptText", "ask", null, moment, false, null, []],
    ["encryptText", "work", null, moment, true, null, []],
    ["decryptText", "ask", null, null, false, null, []],
    ["decryptText", "work", null, null, true, null, []],
    ["decryptText", "ask", null, null, false, null, []],
    ["decryptText", "work", null, null, true, null, []],
  ]);
  assert.deepEqual(
    played.steps.map((step) => step.passwordField),
    [
      { hint: "The code" },
      { hint: "The code" },
      { hint: null },
      { hint: null },
      { hint: null },
      { hint: null },
    ],
  );
  assert.deepEqual(player.locks.get(String(locked)), {
    content: "corner time",
    password: "s3cret pass",
    timeLockMs: moment,
  });
  // Each question is said as an ask says it; nothing typed reaches the events, the state, or a checkpoint.
  assert.deepEqual(
    played.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["Choose a code", "Your code?", "Again?"],
  );
  assert.ok(!played.events.some((event) => event.kind === "playerTranscript"));
  const kept = JSON.stringify([
    played.events,
    serializeCheckpoint(createCheckpoint(played.plan, played.snapshot)),
  ]);
  assert.ok(!kept.includes("s3cret") && !kept.includes("xyzzy"));
});

test("a password field and the openers written true ask in one step, and the lock takes both answers", () => {
  const player = new FakePlayer();
  player.dialogs.push({ password: "typed words", timeLockMs: WALL_CLOCK_MS + 2 * DAY_MS });
  const played = play(
    ['let both = encryptText("both", password: askPassword("Code?"), timeLock: true)', "exit"].join(
      "\n",
    ),
    player,
  );
  assert.deepEqual(player.locks.get(String(variables(played).both)), {
    content: "both",
    password: "typed words",
    timeLockMs: WALL_CLOCK_MS + 2 * DAY_MS,
  });
  assert.deepEqual(asked(played), [
    ["encryptText", "ask", null, WALL_CLOCK_MS + 7 * DAY_MS, false, null, ["timeLock"]],
    ["encryptText", "work", null, null, true, null, ["timeLock"]],
  ]);
  assert.deepEqual(
    played.steps.map((step) => step.passwordField),
    [{ hint: null }, { hint: null }],
  );
  // The password is the field's, so the dialog never chooses it, and the step keeps its field.
  const plan = compileValidPlan(
    'let both = encryptText("both", password: askPassword("Code?"), timeLock: true)\nexit',
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  ).snapshot;
  const step = lockStep(started);
  for (const change of [{ choices: ["timeLock", "password"] }, { passwordField: null }])
    assert.notDeepEqual(
      validateRuntimeSnapshot({ ...started, foregroundAction: { ...step, ...change } }, plan)
        .errors,
      [],
      JSON.stringify(change),
    );
});

test("a password field says its question where password: stands, and asks again for a password the Player lost", () => {
  const source = [
    "function shown(text: string): string {",
    "    say text, instant",
    "    return text",
    "}",
    'let opened = decryptText(shown("bG9jaw=="), password: askPassword(shown("Code?")), default: shown("none"))',
    'let locked = encryptText("x", password: askPassword("New code"), timeLock: false)',
    "exit",
  ].join("\n");
  /** Forgets the first password typed, and keeps the second. */
  class ForgetfulPlayer extends FakePlayer {
    override answer(action: RuntimeLockActionSnapshot) {
      if (action.phase === "ask" && this.dialogs.length === 0) {
        this.forget = false;
        this.dialogs.push({ password: "b" });
      }
      return super.answer(action);
    }
  }
  const player = new ForgetfulPlayer();
  player.forget = true;
  player.dialogs.push({ password: "a" });
  const lost = play(source.replace(/\nlet locked.*/u, ""), player);
  // The arguments in written order, the question where `password:` stands; text that is no lock gives the default.
  assert.deepEqual(
    lost.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["bG9jaw==", "Code?", "Code?", "none"],
  );
  // The typed password was lost, so the field asked again.
  assert.deepEqual(
    asked(lost).map((step) => step.slice(0, 2)),
    [
      ["decryptText", "ask"],
      ["decryptText", "work"],
      ["decryptText", "ask"],
      ["decryptText", "work"],
    ],
  );
  assert.equal(variables(lost).opened, "none");
  // The field has no Cancel.
  const plan = compileValidPlan(
    'let opened = decryptText("bG9jaw==", password: askPassword("Code?"), default: null)\nexit',
  );
  const started = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  const field = lockStep(started);
  assert.equal(
    completeAction(plan, started, {
      actionId: field.actionId,
      actionKind: "lock",
      payload: { kind: "cancelled" },
    }).outcome.kind,
    "invalidPayload",
  );
  // With a password field, `timeLock: false` leaves the password alone.
  const kept = new FakePlayer();
  kept.dialogs.push({ password: "a" }, { password: "b" });
  const played = play(source, kept);
  assert.deepEqual(kept.locks.get(String(variables(played).locked)), {
    content: "x",
    password: "b",
    timeLockMs: null,
  });
});

test("publicKey: takes one key or a list, and key: opens with the key a keyholder sent back", () => {
  const player = new FakePlayer();
  player.dialogs.push({ password: "" }, { key: "key 9" }, { key: "key 3" });
  const played = play(
    [
      `let one = encryptText("one", publicKey: "${AGE_KEY}")`,
      `let keys = ["${AGE_KEY}", "  ${SSH_KEY}  "]`,
      'let both = encryptText("both", publicKey: keys, openAt: null)',
      'let dialog = encryptText("by the dialog")',
      'let opened = decryptText(both, key: "key 2", default: null)',
      'let wrong = decryptText(both, key: "key 1", default: "closed")',
      'let asked = decryptText(dialog, default: "closed")',
      "exit",
    ].join("\n"),
    player,
  );
  const { one, both, opened, wrong, asked: byKey } = variables(played);
  assert.deepEqual([opened, wrong, byKey], ["both", "closed", "by the dialog"]);
  // The public keys as written, each trimmed, with the default time lock unless `openAt:` says otherwise.
  assert.deepEqual(
    played.steps
      .filter((step) => step.call === "encryptText")
      .map((step) => [step.phase, step.publicKeys, step.openAtMs]),
    [
      ["work", [AGE_KEY], WALL_CLOCK_MS + 7 * DAY_MS],
      ["work", [AGE_KEY, SSH_KEY], null],
      ["ask", [], WALL_CLOCK_MS + 7 * DAY_MS],
      ["work", [], null],
    ],
  );
  assert.deepEqual(player.publicKeys.get(String(one)), [AGE_KEY]);
  assert.deepEqual(player.keys.get(String(both)), "key 2");
  // A written key is tried alone; the dialog's wrong key asks again with a notice.
  assert.deepEqual(
    played.steps
      .filter((step) => step.call === "decryptText")
      .map((step) => [step.phase, step.key, step.notice]),
    [
      ["work", "key 2", null],
      ["work", "key 1", null],
      ["work", null, null],
      ["ask", null, null],
      ["work", null, null],
      ["ask", null, "wrongKey"],
      ["work", null, null],
    ],
  );
});

test("the option labels stay ordinary names: a script may name its own values password, publicKey, key, or openAt", () => {
  assert.deepEqual(
    diagnostics(
      [
        "let publicKey = null",
        'let password = "p"',
        'let key = "k"',
        "let openAt = getAbsoluteDateTime()",
        'let locked = encryptText("x", password: password, openAt: openAt)',
        "let opened = decryptText(locked, key: key, default: publicKey)",
        "let fields = { password: 1, publicKey: 2, key: 3, openAt: 4 }",
      ].join("\n"),
    ),
    [],
  );
});

test("public keys and keys are checked when they compile and when they run", () => {
  const problems = [
    'let a = encryptText("x", publicKey: "age1nothing")',
    `let a = encryptText("x", publicKey: ["${AGE_KEY}", "ssh-rsa AAAAB3NzaC1yc2E"])`,
    'let a = encryptText("x", publicKey: [("age1nothing")])',
    'let a = encryptText("x", publicKey: 4)',
    'let a = decryptText("x", key: 4, default: null)',
    'let a = decryptText("x", publicKey: "k", default: null)',
  ].map((source) => diagnostics(source).map(([, message]) => message));
  assert.deepEqual(problems, [
    [
      `'publicKey:' takes keyholders' public keys, such as "age1…" or "ssh-ed25519 AAAA…", but this is neither.`,
    ],
    [
      `'publicKey:' takes keyholders' public keys, such as "age1…" or "ssh-ed25519 AAAA…", but this is neither.`,
    ],
    [
      `'publicKey:' takes keyholders' public keys, such as "age1…" or "ssh-ed25519 AAAA…", but this is neither.`,
    ],
    ["'publicKey:' takes a public key (string) or a list of them, not a whole number (integer)."],
    ["'key:' takes the key from a keyholder as text (string), not a whole number (integer)."],
    [
      "decryptText(...) has no parameter 'publicKey'. Its named arguments are 'password:', 'key:', and 'default:'.",
    ],
  ]);
  // A public key alone is a way to open.
  assert.deepEqual(
    diagnostics(`let a = encryptText("x", publicKey: "${SSH_KEY}", openAt: null)`),
    [],
  );
  const failures = [
    [
      'let saved = fromJson("[\\"age1nothing\\"]", default: null)',
      'let a = encryptText("x", publicKey: saved)',
    ],
    ['let saved = fromJson("[4]", default: null)', 'let a = encryptText("x", publicKey: saved)'],
    [
      'let saved = fromJson("4", default: null)',
      'let a = decryptText("AAAA", key: saved, default: 1)',
    ],
    [
      'let saved = fromJson("[]", default: null)',
      'let a = encryptText("x", publicKey: saved, openAt: null)',
    ],
    [
      "let keys: string[] = []",
      `for index in 1..=595 {\n    keys.add("${AGE_KEY}")\n}`,
      'let a = encryptText("x", publicKey: keys)',
    ],
  ].map((lines) => failure(play([...lines, "exit"].join("\n"))));
  assert.deepEqual(failures, [
    {
      code: "TSR059",
      message: `'publicKey:' of encryptText(...) takes keyholders' public keys, such as "age1…" or "ssh-ed25519 AAAA…", but "age1nothing" is neither.`,
    },
    {
      code: "TSR059",
      message:
        "'publicKey:' of encryptText(...) takes a public key (string) or a list of them, but its list holds a number.",
    },
    {
      code: "TSR059",
      message:
        "'key:' of decryptText(...) takes the key from a keyholder as text (string), not a number.",
    },
    {
      code: "TSR059",
      message:
        "encryptText(...) has no way to open, because 'openAt:' is null and there is no 'password:' or public key. Give a 'password:', a 'publicKey:', or a moment in 'openAt:'.",
    },
    {
      code: "TSR059",
      message:
        "'publicKey:' of encryptText(...) has 595 public keys, but a lock holds at most 594.",
    },
  ]);
});

test("encryptFile locks a stored file into a locked file, and decryptFile opens it into a file of its type", () => {
  const player = new FakePlayer();
  const photo = player.keep("image/png", "PNG bytes");
  const played = play(
    [
      `let photo = "${photo}"`,
      'let locked = encryptFile(photo, password: "p", timeLock: false)',
      'let opened = decryptFile(locked, password: "p", default: null)',
      'let wrong = decryptFile(locked, password: "q", default: null)',
      "exit",
    ].join("\n"),
    player,
    { wallClockMs: WALL_CLOCK_MS, storedFiles: [photo] },
  );
  const { locked, opened, wrong } = variables(played);
  assert.ok(typeof locked === "string" && typeof opened === "string");
  assert.equal(player.files.get(locked)?.kind, "file");
  assert.equal(player.files.get(opened)?.kind, "image");
  assert.equal(player.files.get(opened)?.content, "PNG bytes");
  assert.equal(wrong, null);
  assert.deepEqual(played.snapshot.storedFiles, [photo, locked, opened].sort());
});

test("decryptText of text that is no Base64 gives the default at once, and a lock reads Base64 as fromBase64 does", () => {
  const player = new FakePlayer();
  const played = play(
    [
      'let locked = encryptText("spaced", password: "p", timeLock: false)',
      'let spaced = locked.replace("=", "") + " \\n"',
      'let opened = decryptText(spaced, password: "p", default: null)',
      'let none = decryptText("not base64!", password: "p", default: "default")',
      "exit",
    ].join("\n"),
    player,
  );
  const { opened, none } = variables(played);
  assert.equal(opened, "spaced");
  assert.equal(none, "default");
  assert.deepEqual(
    played.steps.map((step) => step.call),
    ["encryptText", "decryptText"],
  );
});

test("a decrypt call's default runs last, and only when the lock does not open", () => {
  const played = play(
    [
      "function instead(name: string) {",
      '    say "default ${name}"',
      "    return name",
      "}",
      'let locked = encryptText("inside", password: "p", timeLock: false)',
      'let opened = decryptText(locked, password: "p", default: askText "Never asked")',
      'let wrong = decryptText(locked, password: "q", default: instead("wrong"))',
      'let none = decryptText("not base64!", default: instead("none"))',
      "exit",
    ].join("\n"),
  );
  const { opened, wrong, none } = variables(played);
  assert.deepEqual([opened, wrong, none], ["inside", "wrong", "none"]);
  // The ask never ran, and each default ran after its call's lock step.
  assert.deepEqual(
    played.events.flatMap((event) =>
      event.kind === "say"
        ? [event.text]
        : event.kind === "actionRequested" && event.action.kind === "lock"
          ? [event.action.call]
          : [],
    ),
    ["encryptText", "decryptText", "decryptText", "default wrong", "default none"],
  );
});

test("the encrypt and decrypt calls check their arguments when they compile", () => {
  assert.deepEqual(diagnostics('let a = decryptText("x", password: "p")'), [
    [
      "TSV020",
      "'decryptText(text, default: value)' needs a 'default:' for when it does not open, such as with a wrong password. Add one, such as 'default: null'.",
    ],
  ]);
  const problems = [
    'let a = encryptText("x", key: "k")',
    'let a = decryptText("x", timeLock: getAbsoluteDateTime(), default: null)',
    'let a = encryptText("x", password: 4, timeLock: false)',
    'let a = encryptText("x", password: false, timeLock: toDateTime("2026-10-16T18:00"))',
    'let a = encryptText("x", password: "p", timeLock: null)',
    'let a = decryptText("x", password: true, default: null)',
    'let a = encryptText("x", password: "p")',
    'let a = encryptFile("x", timeLock: true)',
    'let a = encryptText("x", password: false, timeLock: (false))',
    "let a = encryptText(4)",
    'let a = encryptFile(4, password: "p", timeLock: false)',
    'let a = encryptText("x", "y")',
    'function f(a: string = encryptText("x")) {\n}',
  ].map((source) => diagnostics(source).map(([, message]) => message));
  assert.deepEqual(problems, [
    [
      "encryptText(...) has no parameter 'key'. Its named arguments are 'password:', 'publicKey:', and 'timeLock:'.",
    ],
    [
      "decryptText(...) has no parameter 'timeLock'. Its named arguments are 'password:', 'key:', and 'default:'.",
    ],
    ["'password:' takes text (string), true, or false, not a whole number (integer)."],
    ["'timeLock:' takes a moment (absoluteDateTime), true, or false, not a date and time."],
    ["'timeLock:' takes a moment (absoluteDateTime), true, or false, not null."],
    ["'password:' takes text (string), not true or false (boolean)."],
    [
      "encryptText(...) gives 'password:' but not 'timeLock:'. Once a call gives one of 'password:' and 'timeLock:', it must give each, so no way to open it is left out by mistake. Add 'timeLock:' with a value, true to let the player choose, or false to leave it out.",
    ],
    [
      "encryptFile(...) gives 'timeLock:' but not 'password:'. Once a call gives one of 'password:' and 'timeLock:', it must give each, so no way to open it is left out by mistake. Add 'password:' with a value, true to let the player choose, or false to leave it out.",
    ],
    [
      "encryptText(...) has no way to open, because 'password:' and 'timeLock:' are both false, so nothing could ever open it. Give one of them a value, or true to let the player choose.",
    ],
    problems[9]!,
    problems[10]!,
    ["encryptText(...) takes 1 argument (text), received 2."],
    [
      "encryptText(...) is not supported in function parameter defaults, because it may ask the player. Call it in the function's body.",
    ],
  ]);
  assert.match(problems[9]![0]!, /encryptText\(\.\.\.\) locks text \(string\)/);
  assert.match(problems[10]![0]!, /encryptFile\(\.\.\.\) locks a stored file/);
  // An option known only when the script runs compiles, and so does a boolean that may be true.
  assert.deepEqual(
    diagnostics(
      [
        'let saved = fromJson("{}", default: null)',
        "let wanted = 1 < 2",
        'let a = encryptText("x", password: saved, timeLock: saved)',
        'let b = encryptText("x", password: wanted, timeLock: false)',
        'let c = decryptText(a, password: saved, default: "")',
      ].join("\n"),
    ),
    [],
  );
});

test("an encrypt call fails at runtime without a way to open, with an argument of the wrong kind, or without a clock", () => {
  const failures = [
    [
      'let off = fromJson("false", default: true)',
      'let a = encryptText("x", password: off, timeLock: off)',
      "exit",
    ],
    [
      'let amount = fromJson("4", default: null)',
      'let a = encryptText("x", password: amount, timeLock: false)',
      "exit",
    ],
    [
      'let amount = fromJson("4", default: null)',
      'let a = encryptText("x", password: false, timeLock: amount)',
      "exit",
    ],
    [
      'let nothing = fromJson("null", default: 1)',
      'let a = encryptText("x", password: "p", timeLock: nothing)',
      "exit",
    ],
    ['let a = encryptFile("images/a.jpg", password: "p", timeLock: false)', "exit"],
    ['let a = decryptFile("images/a.jpg", default: null)', "exit"],
    // A value of no known type that is not text is a wrong argument, not a lock that does not open.
    [
      'let amount = fromJson("42", default: null)',
      'let a = decryptText(amount, default: "d")',
      "exit",
    ],
  ].map((lines) => failure(play(lines.join("\n"))));
  assert.deepEqual(failures, [
    {
      code: "TSR059",
      message:
        "encryptText(...) has no way to open, because 'password:', 'publicKey:', and 'timeLock:' are all false, so nothing could ever open it. Give one of them a value, or true to let the player choose.",
    },
    {
      code: "TSR059",
      message: "'password:' of encryptText(...) takes text (string), true, or false, not a number.",
    },
    {
      code: "TSR059",
      message:
        "'timeLock:' of encryptText(...) takes a moment (absoluteDateTime), true, or false, not a number.",
    },
    {
      code: "TSR059",
      message:
        "'timeLock:' of encryptText(...) takes a moment (absoluteDateTime), true, or false, not null.",
    },
    {
      code: "TSR059",
      message:
        'encryptFile(...) locks a stored file, but "images/a.jpg" is not one. Pass the text that takePhoto(), askImage(...), fileFromBase64(...), or encryptFile(...) gave for a file.',
    },
    {
      code: "TSR059",
      message:
        'decryptFile(...) opens a stored file, but "images/a.jpg" is not one. Pass the text that takePhoto(), askImage(...), fileFromBase64(...), or encryptFile(...) gave for a file.',
    },
    { code: "TSR059", message: "decryptText(...) opens locked text (string), not a number." },
  ]);
  // Only a time lock the player chooses needs the clock, to suggest its moment.
  assert.deepEqual(
    failure(
      play('let a = encryptText("x", password: "p", timeLock: true)\nexit', new FakePlayer(), {}),
    ),
    {
      code: "TSR064",
      message:
        "encryptText(...) needs the current time to suggest a time lock, but this Player supplied no clock when the session started or continued.",
    },
  );
  assert.equal(
    typeof variables(
      play('let a = encryptText("x", password: "p", timeLock: false)\nexit', new FakePlayer(), {}),
    ).a,
    "string",
  );
});

test("a due expiry block interrupts a lock dialog, which asks again afterwards, but waits for a lock step", () => {
  const plan = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant\n wait 2 s }',
      'let locked = encryptText("x")',
      "exit",
    ].join("\n"),
  );
  let result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  const dialog = lockStep(result.snapshot);
  assert.deepEqual([dialog.kind, dialog.phase], ["lock", "ask"]);
  // The block interrupts the dialog: while it waits, the dialog is suspended, also through a checkpoint, and a
  // completion of it is refused.
  result = observeTime(plan, result.snapshot, 1000);
  result = run(plan, result.snapshot);
  assert.ok(result.events.some((event) => event.kind === "say" && event.text === "Time is up"));
  assert.equal(result.snapshot.foregroundAction?.kind, "delay");
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, result.snapshot)),
  ).snapshot;
  assert.equal(
    completeAction(plan, restored, {
      actionId: dialog.actionId,
      actionKind: "lock",
      payload: { kind: "submitted" },
    }).outcome.kind,
    "suspendedAction",
  );
  // Once the block returns, the dialog asks again.
  result = observeTime(plan, restored, 3000);
  result = run(plan, result.snapshot);
  assert.deepEqual(validateRuntimeSnapshot(result.snapshot, plan).errors, []);
  const again = lockStep(result.snapshot);
  assert.deepEqual([again.actionId, again.phase], [dialog.actionId, "ask"]);

  const working = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant }',
      'let locked = encryptText("x", password: "p", timeLock: false)',
      "exit",
    ].join("\n"),
  );
  let step = run(
    working,
    createImmediatePacingRuntimeSnapshot(working, { wallClockMs: WALL_CLOCK_MS }),
  );
  const work = lockStep(step.snapshot);
  assert.equal(work.phase, "work");
  step = observeTime(working, step.snapshot, 1000);
  step = run(working, step.snapshot);
  assert.ok(!step.events.some((event) => event.kind === "say"));
  assert.equal(step.snapshot.foregroundAction?.actionId, work.actionId);
  // Once the step settles, the block runs before the script goes on.
  const completed = completeAction(working, step.snapshot, {
    actionId: work.actionId,
    actionKind: "lock",
    payload: { kind: "locked", text: "AAAA" },
  });
  assert.equal(completed.outcome.kind, "completed");
  const after = run(working, completed.snapshot);
  assert.ok(after.events.some((event) => event.kind === "say" && event.text === "Time is up"));
  assert.equal(after.snapshot.status, "halted");

  // The password field of `password: askPassword(...)` is interrupted as the dialog is, and asks anew afterwards.
  const asking = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant\n wait 2 s }',
      'let locked = encryptText("x", password: askPassword("Code?"), timeLock: false)',
      "exit",
    ].join("\n"),
  );
  let field = run(
    asking,
    createImmediatePacingRuntimeSnapshot(asking, { wallClockMs: WALL_CLOCK_MS }),
  );
  const first = lockStep(field.snapshot);
  assert.deepEqual([first.phase, first.passwordField, first.resumes], ["ask", { hint: null }, 0]);
  field = run(asking, observeTime(asking, field.snapshot, 1000).snapshot);
  assert.equal(field.snapshot.foregroundAction?.kind, "delay");
  field = run(asking, observeTime(asking, field.snapshot, 3000).snapshot);
  assert.deepEqual(validateRuntimeSnapshot(field.snapshot, asking).errors, []);
  const anew = lockStep(field.snapshot);
  assert.deepEqual(
    [anew.actionId, anew.phase, anew.passwordField, anew.resumes],
    [first.actionId, "ask", { hint: null }, 1],
  );
});

test("a lock completion must fit its call and step, and its handoff is checked on restore", () => {
  const plan = compileValidPlan(
    'let a = encryptText("x", password: "p", timeLock: false)\nlet b = decryptText(a, default: null)\nexit',
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  const action = lockStep(started.snapshot);
  const complete = (payload: unknown) =>
    completeAction(plan, started.snapshot, {
      actionId: action.actionId,
      actionKind: "lock",
      payload,
    }).outcome.kind;
  for (const payload of [
    { kind: "locked", text: "not base64!" },
    { kind: "locked", text: "AAAA", extra: 1 },
    { kind: "locked", file: "stored:1" },
    { kind: "opened", text: "x" },
    { kind: "notOpened" },
    { kind: "cancelled" },
    { kind: "submitted" },
    // A step with a written password never asks.
    { kind: "ask" },
    { kind: "failed", reason: "unreadable" },
    { kind: "failed" },
  ])
    assert.equal(complete(payload), "invalidPayload", JSON.stringify(payload));
  assert.equal(complete({ kind: "failed", reason: "unavailable" }), "completed");
  const locked = completeAction(plan, started.snapshot, {
    actionId: action.actionId,
    actionKind: "lock",
    payload: { kind: "locked", text: "AAAA" },
  });
  assert.equal(locked.outcome.kind, "completed");
  // The handoff carries the outcome and the lock; another outcome or result is rejected on restore.
  const handoff = locked.snapshot.interactionResultHandoff!;
  assert.deepEqual(handoff.result, { kind: "list", items: ["locked", "AAAA"] });
  for (const result of [
    { kind: "list", items: ["opened", "AAAA"] },
    { kind: "list", items: ["locked"] },
    { kind: "list", items: ["locked", "not base64!"] },
    { kind: "list", items: ["notOpened"] },
  ]) {
    const tampered = { ...locked.snapshot, interactionResultHandoff: { ...handoff, result } };
    assert.notDeepEqual(validateRuntimeSnapshot(tampered, plan).errors, [], JSON.stringify(result));
  }
  // The decrypt step without a password may ask; its dialog may only be submitted or cancelled.
  const decrypting = run(plan, locked.snapshot);
  const unlock = lockStep(decrypting.snapshot);
  assert.deepEqual([unlock.call, unlock.phase, unlock.password], ["decryptText", "work", null]);
  const asks = completeAction(plan, decrypting.snapshot, {
    actionId: unlock.actionId,
    actionKind: "lock",
    payload: { kind: "ask", notice: "unreachable" },
  });
  assert.equal(asks.outcome.kind, "completed");
  // A wrong password needs a password the dialog asked for.
  assert.equal(
    completeAction(plan, decrypting.snapshot, {
      actionId: unlock.actionId,
      actionKind: "lock",
      payload: { kind: "ask", notice: "wrongPassword" },
    }).outcome.kind,
    "invalidPayload",
  );
  const dialog = run(plan, asks.snapshot).snapshot;
  const asking = lockStep(dialog);
  assert.deepEqual([asking.phase, asking.notice], ["ask", "unreachable"]);
  for (const payload of [{ kind: "opened", text: "x" }, { kind: "notOpened" }, { kind: "ask" }])
    assert.equal(
      completeAction(plan, dialog, { actionId: asking.actionId, actionKind: "lock", payload })
        .outcome.kind,
      "invalidPayload",
    );
  // A step is not changed into a dialog or given a password on restore.
  for (const change of [
    { phase: "work" },
    { password: "p" },
    { notice: "nonsense" },
    { value: "*" },
  ]) {
    const tampered = { ...dialog, foregroundAction: { ...asking, ...change } };
    assert.notDeepEqual(validateRuntimeSnapshot(tampered, plan).errors, [], JSON.stringify(change));
  }
});

test("a lock dialog's choices fit the call's openers, and are checked on restore", () => {
  const plan = compileValidPlan(
    'let a = encryptText("x", password: "given", timeLock: true)\nlet b = encryptText("y")\nexit',
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  const asking = lockStep(started.snapshot);
  assert.deepEqual(
    [asking.phase, asking.password, asking.timeLockMs, asking.choices],
    ["ask", "given", WALL_CLOCK_MS + 7 * DAY_MS, ["timeLock"]],
  );
  /** A change to a lock step's fields, some of them to values the engine never gives. */
  type StepChange = Partial<Record<keyof RuntimeLockActionSnapshot, unknown>>;
  const tampered = (snapshot: RuntimeSnapshot, change: StepChange) =>
    validateRuntimeSnapshot(
      { ...snapshot, foregroundAction: { ...lockStep(snapshot), ...change } },
      plan,
    ).errors;
  for (const change of [
    { choices: [] },
    { choices: ["password", "timeLock"] },
    { choices: ["timeLock", "timeLock"] },
    { choices: ["timeLock", "password"] },
    { timeLockMs: null },
    { choices: ["publicKey"] },
  ])
    assert.notDeepEqual(tampered(started.snapshot, change), [], JSON.stringify(change));
  // The step after the dialog takes the chosen time lock from the player's answer.
  const submitted = completeAction(plan, started.snapshot, {
    actionId: asking.actionId,
    actionKind: "lock",
    payload: { kind: "submitted" },
  });
  const working = run(plan, submitted.snapshot).snapshot;
  assert.deepEqual(
    [lockStep(working).phase, lockStep(working).timeLockMs, lockStep(working).choices],
    ["work", null, ["timeLock"]],
  );
  assert.notDeepEqual(tampered(working, { timeLockMs: WALL_CLOCK_MS }), []);
  assert.notDeepEqual(tampered(working, { choices: [] }), []);
  // A call that writes no opener lets the player choose each.
  const next = run(
    plan,
    completeAction(plan, working, {
      actionId: lockStep(working).actionId,
      actionKind: "lock",
      payload: { kind: "locked", text: "AAAA" },
    }).snapshot,
  ).snapshot;
  assert.deepEqual(lockStep(next).choices, ["timeLock", "password"]);
  assert.deepEqual(tampered(next, {}), []);
  assert.notDeepEqual(tampered(next, { choices: ["timeLock"] }), []);
});

test("a late time observation lets a due block interrupt a lock dialog, and the state stays valid until it runs", () => {
  const plan = compileValidPlan(
    [
      'timer async 1 s { say "Time is up", instant\n wait 2 s }',
      'let locked = encryptText("x")',
      "exit",
    ].join("\n"),
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  const dialog = lockStep(started.snapshot);
  // Observed after the block's moment: the state waits for the block, checkpoints, and runs it after a restore.
  const observed = observeTime(plan, started.snapshot, 1500);
  assert.deepEqual(validateRuntimeSnapshot(observed.snapshot, plan).errors, []);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(plan, observed.snapshot)),
  ).snapshot;
  const ran = run(plan, restored);
  assert.ok(ran.events.some((event) => event.kind === "say" && event.text === "Time is up"));
  assert.deepEqual(validateRuntimeSnapshot(ran.snapshot, plan).errors, []);
  const back = run(plan, observeTime(plan, ran.snapshot, 4000).snapshot);
  assert.equal(lockStep(back.snapshot).actionId, dialog.actionId);
});

test("a lock dialog that a block interrupted counts the return, also after a block that returned at once", () => {
  const plan = compileValidPlan(
    ['timer async 1 s { say "due", instant }', 'let locked = encryptText("x")', "exit"].join("\n"),
  );
  const started = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, { wallClockMs: WALL_CLOCK_MS }),
  );
  assert.equal(lockStep(started.snapshot).resumes, 0);
  const back = run(plan, observeTime(plan, started.snapshot, 1000).snapshot);
  assert.ok(back.events.some((event) => event.kind === "say" && event.text === "due"));
  const again = lockStep(back.snapshot);
  assert.deepEqual(
    [again.actionId, again.phase, again.resumes],
    [lockStep(started.snapshot).actionId, "ask", 1],
  );
  assert.deepEqual(validateRuntimeSnapshot(back.snapshot, plan).errors, []);
  // A step is never resumed, and a count is a whole number.
  for (const resumes of [-1, 1.5]) {
    const tampered = { ...back.snapshot, foregroundAction: { ...again, resumes } };
    assert.notDeepEqual(validateRuntimeSnapshot(tampered, plan).errors, []);
  }
});
