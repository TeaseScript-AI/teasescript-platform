import assert from "node:assert/strict";
import test from "node:test";

import { CapturedMediaStore } from "../player/captured-media.js";
import { rebuildRecordedSession } from "../player/debug-export.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import { loadAge, loadTlock, readLock, type LockServices } from "../player/encryption/lock.js";
import { roundTimeMs } from "../player/encryption/drand.js";
import { LockService, type LockDialog, type LockDialogInput } from "../player/lock-service.js";
import {
  activePlayerRuntimeLock,
  answerPlayerRuntimeLock,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeSnapshot,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
} from "../player/runtime-adapter.js";
import { bytesFromBase64 } from "../player/stored-files.js";
import type { SerializableRuntimeValue } from "../src/index.js";
import { fromBase64, openAge, sshIdentity, x25519Identity } from "./helpers/age-keyholder.js";

/*
 * The Player's lock service (V30 §13): it answers each lock step with real locks, presents the lock and unlock dialogs,
 * and keeps what the player types out of the engine. drand's relays are answered from recorded beacons.
 */

const ROUND_1 = {
  round: 1,
  randomness: "1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a",
  signature:
    "b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b",
};
const LATEST = {
  round: 33_045_040,
  randomness: "60013860a3dbfc4462654b0392a44c31f085c7aef2c41fd2d476d3d7195d92af",
  signature:
    "999d2976ae6302c825c14db2a9becdbd491cb1ab042286fe0d7b04eb1acf550e9238eecab3edd47a5c3247c3b00ab763",
};
/** The device clock of these tests: just after the latest recorded round. */
const NOW_MS = roundTimeMs(LATEST.round) + 1_000;
const urls = { create: (data: Blob) => `blob:${data.type}`, revoke: () => {} };

/** Relays that answer the recorded beacons, or none at all when `down`. */
function relays(down: () => boolean): typeof fetch {
  return async (input) => {
    if (down()) throw new TypeError("Failed to fetch");
    const url = String(input instanceof Request ? input.url : input);
    const round = url.slice(url.lastIndexOf("/") + 1);
    const beacon =
      round === "latest" ? LATEST : [ROUND_1, LATEST].find((one) => String(one.round) === round);
    return beacon === undefined
      ? new Response("Requested future beacon", { status: 425 })
      : Response.json(beacon);
  };
}

/** A Player around one session: it services lock steps and records the dialogs it shows. */
class Harness {
  session: PlayerRuntimeSession;
  readonly media: CapturedMediaStore;
  readonly dialogs: ({ readonly dialog: LockDialog; readonly busy: boolean } | null)[] = [];
  readonly diagnostics: unknown[] = [];
  relaysDown = false;
  /** The device clock, which a test may move on. */
  nowMs = NOW_MS;
  /** The wakes the service asked for, with their delays; a test fires them, as no timer runs by itself. */
  readonly wakes: { readonly delayMs: number; readonly task: () => void }[] = [];
  readonly service: LockService;

  constructor(
    source: string,
    options: {
      readonly subtle?: SubtleCrypto | undefined;
      readonly media?: CapturedMediaStore;
      readonly files?: readonly string[];
      readonly recorder?: DebugRecorder;
      /** Whether the service starts at once; a test may first answer a step itself. */
      readonly start?: boolean;
    } = {},
  ) {
    this.media = options.media ?? new CapturedMediaStore(null, urls, "locks");
    this.session = createPlayerRuntimeSession(source, {
      wallClockMs: NOW_MS,
      storedFiles: options.files ?? [],
      ...(options.recorder ? { recorder: options.recorder } : {}),
    });
    const services: LockServices = {
      tlock: loadTlock,
      age: loadAge,
      fetch: relays(() => this.relaysDown),
      nowMs: () => this.nowMs,
    };
    this.service = new LockService({
      session: () => this.session,
      generation: () => 1,
      observe: () => this.session,
      publish: (next) => {
        this.session = next;
        this.service.request();
      },
      media: this.media,
      diagnostic: (diagnostic) => this.diagnostics.push(diagnostic),
      dialog: (dialog, busy) => this.dialogs.push(dialog === null ? null : { dialog, busy }),
      later: (task) => setTimeout(task, 0),
      after: (delayMs, task) => {
        const wake = { delayMs, task };
        this.wakes.push(wake);
        return () => this.wakes.splice(this.wakes.indexOf(wake) >>> 0, 1);
      },
      subtle: "subtle" in options ? options.subtle : crypto.subtle,
      crypto: services,
    });
    if (options.start !== false) this.service.request();
  }

  /** The dialog shown now, not busy, once one is. */
  async dialog(): Promise<LockDialog> {
    await this.until(() => {
      const shown = this.dialogs.at(-1);
      return shown !== undefined && shown !== null && !shown.busy;
    });
    return this.dialogs.at(-1)!.dialog;
  }

  answer(input: LockDialogInput): void {
    this.service.submit(input);
  }

  async ended(): Promise<Record<string, SerializableRuntimeValue>> {
    await this.until(
      () => this.session.state.status === "halted" || this.session.state.status === "failed",
    );
    const snapshot = playerRuntimeSnapshot(this.session);
    assert.equal(snapshot.failure, null, JSON.stringify(snapshot.failure));
    return Object.fromEntries(
      snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
    );
  }

  async until(done: () => boolean): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!done()) {
      assert.ok(Date.now() < deadline, `timed out at ${this.session.state.status}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  stop(): void {
    this.service.stop();
  }
}

test("locks with a written password and time lock open with the password, and once passed with the time lock", async () => {
  const player = new Harness(
    [
      'let friday = toAbsoluteDateTime("2023-08-23T15:09:27Z")',
      'let locked = encryptText("corner time", password: "corner", timeLock: friday)',
      'let byPassword = decryptText(locked, password: "corner", default: null)',
      'let wrong = decryptText(locked, password: "Corner", default: "no")',
      "let byTime = decryptText(locked, default: null)",
      'let notALock = decryptText("aGVsbG8=", default: "none")',
      "exit",
    ].join("\n"),
  );
  const values = await player.ended();
  player.stop();
  assert.equal(values.byPassword, "corner time");
  assert.equal(values.wrong, "no");
  assert.equal(values.byTime, "corner time");
  assert.equal(values.notALock, "none");
  assert.deepEqual(
    player.dialogs.filter((shown) => shown !== null),
    [],
  );
});

test("the lock dialog asks for each opener, suggests 7 days, locks with what the player chose, and the unlock dialog asks again after a wrong password", async () => {
  const player = new Harness(
    [
      'let locked = encryptText("chosen")',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  const lock = await player.dialog();
  assert.equal(lock.kind, "lock");
  assert.deepEqual(lock.kind === "lock" && [lock.choices, lock.suggestedTimeLockMs, lock.given], [
    ["timeLock", "password"],
    NOW_MS + 7 * 24 * 60 * 60 * 1000,
    { password: false, timeLock: false },
  ]);
  const moment = NOW_MS + 3_600_000;
  player.answer({ password: "secret words", timeLockMs: moment });
  const unlock = await player.dialog();
  assert.equal(unlock.kind, "unlock");
  assert.deepEqual(unlock.kind === "unlock" && [unlock.password, unlock.notice], [true, null]);
  // Its time lock opens at the first round at or after the chosen moment.
  assert.ok(
    unlock.kind === "unlock" && unlock.moments[0]! >= moment && unlock.moments[0]! < moment + 3_000,
  );
  player.answer({ password: "not the password 7", timeLockMs: null });
  const again = await player.dialog();
  assert.deepEqual(again.kind === "unlock" && again.notice, "wrongPassword");
  player.answer({ password: "secret words", timeLockMs: null });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "chosen");
  // The dialog stayed, busy, while the Player locked or opened with what was typed.
  assert.ok(player.dialogs.some((shown) => shown?.busy === true));
  // What the player typed reached neither the state nor an event.
  const recorded = JSON.stringify([playerRuntimeSnapshot(player.session), player.session.events]);
  assert.ok(!recorded.includes("secret words"));
  assert.ok(!recorded.includes("not the password 7"));
});

test("the lock dialog's time lock may be switched off: the lock opens only with its password, and replays and restores without it", async () => {
  const recorder = new DebugRecorder();
  const player = new Harness(
    [
      'let locked = encryptText("no time")',
      'let opened = decryptText(locked, default: "closed")',
      'let written = decryptText(locked, password: "only words", default: "closed")',
      "exit",
    ].join("\n"),
    { recorder },
  );
  assert.equal((await player.dialog()).kind, "lock");
  player.answer({ password: "only words", timeLockMs: null });
  // Its unlock dialog has a password field and no moment, and waits for nothing to open it by itself.
  const unlock = await player.dialog();
  assert.deepEqual(unlock.kind === "unlock" && [unlock.password, unlock.moments], [true, []]);
  assert.deepEqual(player.wakes, []);
  const waiting = playerRuntimeSnapshot(player.session);
  assert.deepEqual(
    playerRuntimeSnapshot(
      restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(player.session)),
    ),
    waiting,
  );
  player.answer({ password: "only words", timeLockMs: null });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "no time");
  assert.equal(values.written, "no time");
  const read = readLock(bytesFromBase64(String(values.locked))!);
  assert.deepEqual([read?.passwords.length, read?.times.length], [1, 0]);
  // The recorded calls reach the same state again without the password, the relays, or the Player's locks.
  const recording = recorder.recording()!;
  assert.equal(recording.complete, true);
  assert.deepEqual(
    rebuildRecordedSession(
      recording.plan,
      recording.anchorSnapshot,
      recording.operations,
    ).exportSnapshot(),
    playerRuntimeSnapshot(player.session),
  );
});

test("the lock dialog asks only for the openers written true, and locks with the call's own openers too", async () => {
  const player = new Harness(
    [
      'let given = encryptText("given", password: "words", timeLock: true)',
      'let opened = decryptText(given, password: "words", default: "closed")',
      'let typed = encryptText("typed", password: true, timeLock: false)',
      "exit",
    ].join("\n"),
  );
  const timeOnly = await player.dialog();
  assert.deepEqual(timeOnly.kind === "lock" && [timeOnly.choices, timeOnly.given], [
    ["timeLock"],
    { password: true, timeLock: false },
  ]);
  // Switched off, the time lock leaves the call's password.
  player.answer({ password: null, timeLockMs: null });
  const passwordOnly = await player.dialog();
  assert.deepEqual(
    passwordOnly.kind === "lock" && [
      passwordOnly.choices,
      passwordOnly.suggestedTimeLockMs,
      passwordOnly.given,
    ],
    [["password"], null, { password: false, timeLock: false }],
  );
  player.answer({ password: "chosen words", timeLockMs: null });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "given");
  for (const [locked, passwords, times] of [
    [values.given, 1, 0],
    [values.typed, 1, 0],
  ] as const) {
    const read = readLock(bytesFromBase64(String(locked))!);
    assert.deepEqual([read?.passwords.length, read?.times.length], [passwords, times]);
  }
});

test("password: askPassword(...) asks in the password field, locks with the typed password and its time lock, and a wrong one gives the default", async () => {
  const player = new Harness(
    [
      'let locked = encryptText("fielded", password: askPassword("Choose a code", hint: "The code"), timeLock: getAbsoluteDateTime() + 7 days)',
      'let opened = decryptText(locked, password: askPassword("Your code?"), default: "closed")',
      'let wrong = decryptText(locked, password: askPassword("Again?"), default: "closed")',
      'let timed = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  const field = await player.dialog();
  // The encrypt call's field has a "Repeat password"; the decrypt calls' have one field.
  assert.deepEqual(field.kind === "password" && [field.repeat, field.hint], [true, "The code"]);
  player.answer({ password: "field words", timeLockMs: null });
  const open = await player.dialog();
  assert.deepEqual(open.kind === "password" && [open.repeat, open.hint], [false, null]);
  player.answer({ password: "field words", timeLockMs: null });
  const again = await player.dialog();
  assert.equal(again.kind, "password");
  player.answer({ password: "not field words", timeLockMs: null });
  // The lock also has its time lock, 7 days ahead, which the unlock dialog shows.
  const unlock = await player.dialog();
  assert.ok(
    unlock.kind === "unlock" &&
      unlock.password &&
      Math.abs(unlock.moments[0]! - (NOW_MS + 7 * 24 * 60 * 60 * 1000)) < 4_000,
  );
  player.service.cancel();
  const values = await player.ended();
  player.stop();
  assert.deepEqual([values.opened, values.wrong, values.timed], ["fielded", "closed", "closed"]);
  const recorded = JSON.stringify([playerRuntimeSnapshot(player.session), player.session.events]);
  assert.ok(!recorded.includes("field words"));
});

test("an encrypt call's password field asks first, then the lock dialog for the openers written true, and the lock has both", async () => {
  const player = new Harness(
    [
      'let both = encryptText("both", password: askPassword("Code?"), timeLock: true)',
      'let opened = decryptText(both, password: askPassword("Again?"), default: "closed")',
      "exit",
    ].join("\n"),
  );
  const field = await player.dialog();
  assert.deepEqual(field.kind === "password" && field.repeat, true);
  player.answer({ password: "both words", timeLockMs: null });
  // The same step's lock dialog follows, with the field's password as an opener the call gives.
  const dialog = await player.dialog();
  assert.deepEqual(
    dialog.kind === "lock" && [dialog.actionId === field.actionId, dialog.choices, dialog.given],
    [true, ["timeLock"], { password: true, timeLock: false }],
  );
  const moment = NOW_MS + 3_600_000;
  player.answer({ password: null, timeLockMs: moment });
  const open = await player.dialog();
  assert.equal(open.kind, "password");
  player.answer({ password: "both words", timeLockMs: null });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "both");
  const read = readLock(bytesFromBase64(String(values.both))!);
  assert.deepEqual([read?.passwords.length, read?.times.length], [1, 1]);
  const recorded = JSON.stringify([playerRuntimeSnapshot(player.session), player.session.events]);
  assert.ok(!recorded.includes("both words"));
});

test("a password field whose typed password was lost, as on a reload, asks again", async () => {
  const player = new Harness(
    [
      'let locked = encryptText("again", password: askPassword("Code?"), timeLock: false)',
      "exit",
    ].join("\n"),
    { start: false },
  );
  // Another Player answered the field and was reloaded: this one has nothing typed for the step after it.
  const field = activePlayerRuntimeLock(player.session.state)!;
  assert.deepEqual([field.phase, field.passwordField], ["ask", { hint: null }]);
  player.session = answerPlayerRuntimeLock(
    player.session,
    field.actionId,
    { kind: "submitted" },
    player.media,
  ).session;
  player.service.request();
  const again = await player.dialog();
  assert.deepEqual(again.kind === "password" && again.actionId > field.actionId, true);
  player.answer({ password: "kept words", timeLockMs: null });
  const values = await player.ended();
  player.stop();
  assert.equal(typeof values.locked, "string");
});

/** The age file in the armor that the unlock dialog shows the player for their keyholder. */
function unarmored(armor: string): Uint8Array {
  return fromBase64(
    armor
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("-----"))
      .join(""),
  );
}

test("the lock dialog takes keyholders' public keys, and the unlock dialog sends the age file and opens with the key sent back", async () => {
  const keyholder = x25519Identity();
  const player = new Harness(
    [
      'let locked = encryptText("kept for her")',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  assert.equal((await player.dialog()).kind, "lock");
  player.answer({
    password: null,
    openAtMs: NOW_MS + 3_600_000,
    publicKeys: [keyholder.recipient, sshIdentity().recipient],
  });
  const unlock = await player.dialog();
  assert.ok(unlock.kind === "unlock" && unlock.ageText !== null && !unlock.password);
  // The keyholder opens the age file with their identity and sends back the key it holds.
  const key = new TextDecoder().decode(openAge(unarmored(unlock.ageText), keyholder)!);
  player.answer({
    password: null,
    openAtMs: null,
    key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  });
  const again = await player.dialog();
  assert.deepEqual(again.kind === "unlock" && again.notice, "wrongKey");
  player.answer({ password: null, openAtMs: null, key });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "kept for her");
  // The key never reached the state or an event.
  const recorded = JSON.stringify([playerRuntimeSnapshot(player.session), player.session.events]);
  assert.ok(!recorded.includes(key.trim()));
});

test("the lock dialog's time lock may be switched off with only a keyholder's public key, which then alone opens the lock", async () => {
  const keyholder = x25519Identity();
  const player = new Harness(
    [
      'let locked = encryptText("only hers")',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  assert.equal((await player.dialog()).kind, "lock");
  player.answer({ password: null, openAtMs: null, publicKeys: [keyholder.recipient] });
  // Its unlock dialog sends the age file, has no password field and no moment, and waits for nothing by itself.
  const unlock = await player.dialog();
  assert.ok(unlock.kind === "unlock" && unlock.ageText !== null && !unlock.password);
  assert.deepEqual(unlock.moments, []);
  assert.deepEqual(player.wakes, []);
  const key = new TextDecoder().decode(openAge(unarmored(unlock.ageText), keyholder)!);
  player.answer({ password: null, openAtMs: null, key });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "only hers");
  const read = readLock(bytesFromBase64(String(values.locked))!);
  assert.deepEqual([read?.passwords.length, read?.times.length, read?.ages.length], [0, 0, 1]);
});

test("publicKey: written in the script locks for the keyholders, and key: opens, while a wrong key gives the default", async () => {
  const keyholder = sshIdentity();
  const locking = new Harness(
    [
      `let locked = encryptText("written", publicKey: ["${keyholder.recipient}"], openAt: null)`,
      "exit",
    ].join("\n"),
  );
  const { locked } = await locking.ended();
  locking.stop();
  const bytes = fromBase64(String(locked));
  const read = readLock(bytes)!;
  assert.deepEqual([read.passwords.length, read.times.length, read.ages.length], [0, 0, 1]);
  const key = new TextDecoder().decode(openAge(read.ages[0]!, keyholder)!).trim();
  const opening = new Harness(
    [
      `let opened = decryptText("${String(locked)}", key: "${key}", default: "closed")`,
      `let wrong = decryptText("${String(locked)}", key: "${key.replace(/^./u, key.startsWith("A") ? "B" : "A")}", default: "closed")`,
      "exit",
    ].join("\n"),
  );
  const values = await opening.ended();
  opening.stop();
  assert.deepEqual([values.opened, values.wrong], ["written", "closed"]);
  // A call that writes its key shows no dialog.
  assert.ok(opening.dialogs.every((shown) => shown === null));
});

test("a password field with a written key asks again for a password the Player lost, and the lock dialog asks again for more keys than a lock holds", async () => {
  const locking = new Harness(
    'let locked = encryptText("both", password: "corner", openAt: null)\nexit',
  );
  const { locked } = await locking.ended();
  locking.stop();
  const player = new Harness(
    [
      `let opened = decryptText("${String(locked)}", password: askPassword("Code?"), key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", default: "closed")`,
      'let many = encryptText("many")',
      "exit",
    ].join("\n"),
    { start: false },
  );
  // Another Player answered the field and was reloaded.
  const field = activePlayerRuntimeLock(player.session.state)!;
  player.session = answerPlayerRuntimeLock(
    player.session,
    field.actionId,
    { kind: "submitted" },
    player.media,
  ).session;
  player.service.request();
  const again = await player.dialog();
  assert.deepEqual(again.kind === "password" && again.actionId > field.actionId, true);
  player.answer({ password: "corner", openAtMs: null });
  const lock = await player.dialog();
  assert.equal(lock.kind, "lock");
  // 595 keys do not fit into a lock: the dialog asks again rather than failing.
  const keyholder = sshIdentity().recipient;
  player.answer({
    password: null,
    openAtMs: NOW_MS + 3_600_000,
    publicKeys: Array.from({ length: 595 }, () => keyholder),
  });
  const fewer = await player.dialog();
  assert.ok(fewer.kind === "lock" && fewer.key !== lock.key);
  player.answer({ password: null, openAtMs: NOW_MS + 3_600_000, publicKeys: [keyholder] });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "both");
  assert.equal(typeof values.many, "string");
  assert.deepEqual(player.diagnostics, []);
});

test("a cancelled unlock dialog gives the default, and a passed time lock out of reach asks only when a password can open it", async () => {
  const cancelled = new Harness(
    [
      'let locked = encryptText("x", password: "p", timeLock: getAbsoluteDateTime() + 7 days)',
      'let opened = decryptText(locked, default: "default")',
      "exit",
    ].join("\n"),
  );
  const dialog = await cancelled.dialog();
  assert.deepEqual(dialog.kind === "unlock" && dialog.moments.length, 1);
  cancelled.service.cancel();
  assert.equal((await cancelled.ended()).opened, "default");
  cancelled.stop();

  // Locking needs no network; opening a passed time lock does.
  const past = 'let past = toAbsoluteDateTime("2023-08-23T15:09:27Z")';
  const unreachable = new Harness(
    [
      past,
      'let both = encryptText("x", password: "p", timeLock: past)',
      'let opened = decryptText(both, default: "default")',
      "exit",
    ].join("\n"),
  );
  unreachable.relaysDown = true;
  const asked = await unreachable.dialog();
  assert.deepEqual(asked.kind === "unlock" && asked.notice, "unreachable");
  // "Try again" with the relays back opens it.
  unreachable.relaysDown = false;
  unreachable.answer({ password: null, timeLockMs: null });
  assert.equal((await unreachable.ended()).opened, "x");
  unreachable.stop();

  const timeOnly = new Harness(
    [
      past,
      'let locked = encryptText("y", password: false, timeLock: past)',
      'let opened = decryptText(locked, default: "default")',
      "exit",
    ].join("\n"),
  );
  timeOnly.relaysDown = true;
  assert.equal((await timeOnly.ended()).opened, "default");
  timeOnly.stop();
  assert.deepEqual(
    timeOnly.dialogs.filter((shown) => shown !== null),
    [],
  );
});

test("encryptFile locks a stored file into a locked file, and decryptFile opens it into an image again", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const media = new CapturedMediaStore(null, urls, "locks");
  const photo = media.add("image", new Blob([png], { type: "image/png" })).reference;
  const player = new Harness(
    [
      `let photo = "${photo}"`,
      'let locked = encryptFile(photo, password: "p", timeLock: false)',
      'let opened = decryptFile(locked, password: "p", default: null)',
      'let wrong = decryptFile(locked, password: "q", default: null)',
      "exit",
    ].join("\n"),
    { media, files: [photo] },
  );
  const values = await player.ended();
  player.stop();
  const { locked, opened, wrong } = values;
  assert.ok(typeof locked === "string" && typeof opened === "string");
  assert.equal(wrong, null);
  assert.equal(media.holds(locked, "file"), true);
  assert.equal(media.holds(opened, "image"), true);
  const record = await media.read(opened);
  assert.deepEqual(new Uint8Array(await record!.data.arrayBuffer()), png);
  assert.equal(record!.data.type, "image/png");
  // The locked file is the lock's bytes: its content is not the photo's.
  const lockedBytes = new Uint8Array(await (await media.read(locked))!.data.arrayBuffer());
  assert.deepEqual([...lockedBytes.subarray(0, 4)], [0x54, 0x53, 0x4c, 0x4b]);
});

test("without WebCrypto, as on a Player page over plain HTTP, a lock fails with TSR086", async () => {
  const player = new Harness(
    ['let locked = encryptText("x", password: "p", timeLock: false)', "exit"].join("\n"),
    { subtle: undefined },
  );
  await player.until(() => player.session.state.status === "failed");
  player.stop();
  const failure = playerRuntimeSnapshot(player.session).failure;
  assert.equal(failure?.code, "TSR086");
});

test("a dialog waits for a distant time lock in bounded wakes, and none opens it early", async () => {
  const player = new Harness(
    [
      'let locked = encryptText("x", password: false, timeLock: getAbsoluteDateTime() + 30 days)',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  const dialog = await player.dialog();
  const step = player.session.state.foregroundAction;
  // Each wake is at most an hour, also for a moment 30 days ahead, and a wake before the moment only waits again.
  for (let wake = 0; wake < 3; wake += 1) {
    await player.until(() => player.wakes.length === 1);
    const next = player.wakes[0]!;
    assert.ok(next.delayMs > 0 && next.delayMs <= 60 * 60 * 1000, String(next.delayMs));
    player.wakes.length = 0;
    next.task();
  }
  assert.equal(player.session.state.foregroundAction, step);
  assert.equal(player.dialogs.at(-1)?.dialog, dialog);
  player.service.cancel();
  assert.equal((await player.ended()).opened, "closed");
  player.stop();
});

test("an empty password is a password: the unlock dialog opens a lock made with one", async () => {
  const player = new Harness(
    [
      'let locked = encryptText("empty", password: "", timeLock: false)',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  const dialog = await player.dialog();
  assert.deepEqual(dialog.kind === "unlock" && [dialog.password, dialog.moments], [true, []]);
  player.answer({ password: "", timeLockMs: null });
  assert.equal((await player.ended()).opened, "empty");
  player.stop();
});

test("a time lock's open dialog offers Try again when its moment comes but the relays are out of reach", async () => {
  const player = new Harness(
    [
      'let locked = encryptText("y", password: false, timeLock: getAbsoluteDateTime() + 1 min)',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  const dialog = await player.dialog();
  assert.deepEqual(dialog.kind === "unlock" && [dialog.password, dialog.notice], [false, null]);
  // The moment comes while the dialog shows, but no relay can be reached.
  player.relaysDown = true;
  player.nowMs = NOW_MS + 5 * 60 * 1000;
  await player.until(() => player.wakes.length > 0);
  player.wakes.splice(0).forEach((wake) => wake.task());
  await player.until(() => {
    const shown = player.dialogs.at(-1);
    return shown?.dialog.kind === "unlock" && shown.dialog.notice === "unreachable";
  });
  player.service.cancel();
  assert.equal((await player.ended()).opened, "closed");
  player.stop();
});
