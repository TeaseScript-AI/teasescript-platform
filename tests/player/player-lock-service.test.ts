import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, shallowRef, type Ref } from "vue";

import { CapturedMediaStore } from "../../player/media/captured-media.js";
import { rebuildRecordedSession } from "../../player/debug/debug-export.js";
import { DebugRecorder } from "../../player/debug/debug-recorder.js";
import {
  loadAge,
  loadTlock,
  readLock,
  type LockServices,
} from "../../player/encryption/content-lock.js";
import { roundTimeMs } from "../../player/encryption/drand.js";
import {
  LockService,
  type LockDialog,
  type LockDialogInput,
} from "../../player/encryption/lock-service.js";
import {
  answerPlayerRuntimeLock,
  createPlayerRuntimeRestorePoint,
  playerRuntimeSnapshot,
  restorePlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerDiagnostic } from "../../player/media/session-camera.js";
import { activePlayerRuntimeLock, type PlayerSession } from "../../player/runtime/runtime-view.js";
import { bytesFromBase64 } from "../../player/media/stored-files.js";
import type { SerializableRuntimeValue } from "../../src/index.js";
import {
  fromBase64,
  openAge,
  sshIdentity,
  x25519Identity,
} from "../helpers/player/age-keyholder.js";
import { hatch, inProcessBridge, introduced } from "../helpers/in-process-bridge.js";
import { serviceSection } from "../helpers/service-section.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { preparedSource, type PlanStart } from "../helpers/prepared-plan.js";
import {
  loadTopology,
  rerunRegistry,
  TOPOLOGIES,
  topologyBridge,
  until,
  type Topology,
} from "../helpers/player/worker-topology.js";

// The engine's host the Player's sessions live in, as in production until the L5 series activates the Worker.
let bridge: PlayerBridge;
before(async () => {
  bridge = await inProcessBridge();
});

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
  session: PlayerSession;
  /** The published session's generation; a test that replaces the session advances it. */
  generation = 1;
  /** Runs when the service reads the published session, as it does first in each service. */
  onSession: (() => void) | null = null;
  /** Whether the Player holds the session from its services for now, as during a paused random draw. */
  held = false;
  /** Starts a new session of the same script under a new generation, as Start or Debug's rewind does. */
  readonly replace: () => void;
  readonly media: CapturedMediaStore;
  readonly dialogs: ({ readonly dialog: LockDialog; readonly busy: boolean } | null)[] = [];
  readonly diagnostics: PlayerDiagnostic[] = [];
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
      /** The engine's host, the shared in-process one by default. */
      readonly bridge?: PlayerBridge;
      /** Sees each request the service's sections post, right before it is posted. */
      readonly onSend?: (op: string, args: unknown) => void;
    } = {},
  ) {
    const host = options.bridge ?? bridge;
    this.media = options.media ?? new CapturedMediaStore(null, urls, "locks");
    const start = () =>
      introduced(
        host,
        createPlayerRuntimeSession(source, {
          wallClockMs: NOW_MS,
          storedFiles: options.files ?? [],
          ...(options.recorder ? { recorder: options.recorder } : {}),
        }),
      );
    this.session = start();
    this.replace = () => {
      this.generation += 1;
      this.session = start();
    };
    const services: LockServices = {
      tlock: loadTlock,
      age: loadAge,
      fetch: relays(() => this.relaysDown),
      nowMs: () => this.nowMs,
    };
    this.service = new LockService({
      session: () => {
        this.onSession?.();
        return this.held ? null : this.session;
      },
      generation: () => this.generation,
      section: serviceSection(
        host,
        () => this.session,
        (next) => {
          this.session = next;
          this.service.request();
        },
        options.onSend,
      ),
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
    const snapshot = hatch(this.session, playerRuntimeSnapshot);
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
      'let locked = encryptText("corner time", password: "corner", publicKey: false, timeLock: friday)',
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
    ["timeLock", "password", "publicKey"],
    NOW_MS + 7 * 24 * 60 * 60 * 1000,
    { password: false, timeLock: false, publicKeys: 0 },
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
  const recorded = JSON.stringify([
    hatch(player.session, playerRuntimeSnapshot),
    player.session.events,
  ]);
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
  const waiting = hatch(player.session, playerRuntimeSnapshot);
  assert.deepEqual(
    playerRuntimeSnapshot(
      restorePlayerRuntimeSession(hatch(player.session, createPlayerRuntimeRestorePoint)),
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
    hatch(player.session, playerRuntimeSnapshot),
  );
});

test("the lock dialog asks only for the openers written true, and locks with the call's own openers too", async () => {
  const player = new Harness(
    [
      'let given = encryptText("given", password: "words", publicKey: false, timeLock: true)',
      'let opened = decryptText(given, password: "words", default: "closed")',
      'let typed = encryptText("typed", password: true, publicKey: false, timeLock: false)',
      "exit",
    ].join("\n"),
  );
  const timeOnly = await player.dialog();
  assert.deepEqual(timeOnly.kind === "lock" && [timeOnly.choices, timeOnly.given], [
    ["timeLock"],
    { password: true, timeLock: false, publicKeys: 0 },
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
    [["password"], null, { password: false, timeLock: false, publicKeys: 0 }],
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
      'let locked = encryptText("fielded", password: askPassword("Choose a code", hint: "The code"), publicKey: false, timeLock: getAbsoluteDateTime() + 7 days)',
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
  const recorded = JSON.stringify([
    hatch(player.session, playerRuntimeSnapshot),
    player.session.events,
  ]);
  assert.ok(!recorded.includes("field words"));
});

test("an encrypt call's password field asks first, then the lock dialog for the openers written true, and the lock has both", async () => {
  const player = new Harness(
    [
      'let both = encryptText("both", password: askPassword("Code?"), publicKey: false, timeLock: true)',
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
    [true, ["timeLock"], { password: true, timeLock: false, publicKeys: 0 }],
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
  const recorded = JSON.stringify([
    hatch(player.session, playerRuntimeSnapshot),
    player.session.events,
  ]);
  assert.ok(!recorded.includes("both words"));
});

test("a password field whose typed password was lost, as on a reload, asks again", async () => {
  const player = new Harness(
    [
      'let locked = encryptText("again", password: askPassword("Code?"), publicKey: false, timeLock: false)',
      "exit",
    ].join("\n"),
    { start: false },
  );
  // Another Player answered the field and was reloaded: this one has nothing typed for the step after it.
  const field = activePlayerRuntimeLock(player.session.state)!;
  assert.deepEqual([field.phase, field.passwordField], ["ask", { hint: null }]);
  player.session = hatch(player.session, (held) =>
    answerPlayerRuntimeLock(held, field.actionId, { kind: "submitted" }, player.media),
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

test("the lock dialog takes public keys, and the unlock dialog sends the unlock request and opens with the unlock key sent back", async () => {
  const keyholder = x25519Identity();
  const player = new Harness(
    [
      'let locked = encryptText("kept for her")',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  const lock = await player.dialog();
  assert.deepEqual(lock.kind === "lock" && lock.choices, ["timeLock", "password", "publicKey"]);
  player.answer({
    password: null,
    timeLockMs: NOW_MS + 3_600_000,
    publicKeys: [keyholder.recipient, sshIdentity().recipient],
  });
  const unlock = await player.dialog();
  assert.ok(unlock.kind === "unlock" && unlock.ageText !== null && !unlock.password);
  // The owner of the private key opens the unlock request with it and sends back the unlock key it holds.
  const key = new TextDecoder().decode(openAge(unarmored(unlock.ageText), keyholder)!);
  player.answer({
    password: null,
    timeLockMs: null,
    key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  });
  const again = await player.dialog();
  assert.deepEqual(again.kind === "unlock" && again.notice, "wrongKey");
  player.answer({ password: null, timeLockMs: null, key });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "kept for her");
  // The key never reached the state or an event.
  const recorded = JSON.stringify([
    hatch(player.session, playerRuntimeSnapshot),
    player.session.events,
  ]);
  assert.ok(!recorded.includes(key.trim()));
});

test("the lock dialog's time lock may be switched off with only a public key, whose private key then alone opens the lock", async () => {
  const keyholder = x25519Identity();
  const player = new Harness(
    [
      'let locked = encryptText("only hers")',
      'let opened = decryptText(locked, default: "closed")',
      "exit",
    ].join("\n"),
  );
  assert.equal((await player.dialog()).kind, "lock");
  player.answer({ password: null, timeLockMs: null, publicKeys: [keyholder.recipient] });
  // Its unlock dialog sends the unlock request, has no password field and no moment, and waits for nothing by itself.
  const unlock = await player.dialog();
  assert.ok(unlock.kind === "unlock" && unlock.ageText !== null && !unlock.password);
  assert.deepEqual(unlock.moments, []);
  assert.deepEqual(player.wakes, []);
  const key = new TextDecoder().decode(openAge(unarmored(unlock.ageText), keyholder)!);
  player.answer({ password: null, timeLockMs: null, key });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "only hers");
  const read = readLock(bytesFromBase64(String(values.locked))!);
  assert.deepEqual([read?.passwords.length, read?.times.length, read?.ages.length], [0, 0, 1]);
});

test("publicKey: written in the script locks for its private keys, and key: opens, while a wrong key gives the default; publicKey: true asks for keys alone", async () => {
  const keyholder = sshIdentity();
  const locking = new Harness(
    [
      `let locked = encryptText("written", password: false, publicKey: ["${keyholder.recipient}"], timeLock: false)`,
      'let chosen = encryptText("chosen", password: "corner", publicKey: true, timeLock: false)',
      "exit",
    ].join("\n"),
  );
  // The dialog of `publicKey: true` asks for public keys alone, the call's password being an opener it gives.
  const dialog = await locking.dialog();
  assert.deepEqual(dialog.kind === "lock" && [dialog.choices, dialog.given], [
    ["publicKey"],
    { password: true, timeLock: false, publicKeys: 0 },
  ]);
  locking.answer({ password: null, timeLockMs: null, publicKeys: [keyholder.recipient] });
  const { locked, chosen } = await locking.ended();
  locking.stop();
  const chosenRead = readLock(fromBase64(String(chosen)))!;
  assert.deepEqual(
    [chosenRead.passwords.length, chosenRead.times.length, chosenRead.ages.length],
    [1, 0, 1],
  );
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
    'let locked = encryptText("both", password: "corner", publicKey: false, timeLock: false)\nexit',
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
  player.session = hatch(player.session, (held) =>
    answerPlayerRuntimeLock(held, field.actionId, { kind: "submitted" }, player.media),
  ).session;
  player.service.request();
  const again = await player.dialog();
  assert.deepEqual(again.kind === "password" && again.actionId > field.actionId, true);
  player.answer({ password: "corner", timeLockMs: null });
  const lock = await player.dialog();
  assert.equal(lock.kind, "lock");
  // 595 keys do not fit into a lock: the dialog asks again rather than failing.
  const keyholder = sshIdentity().recipient;
  player.answer({
    password: null,
    timeLockMs: NOW_MS + 3_600_000,
    publicKeys: Array.from({ length: 595 }, () => keyholder),
  });
  const fewer = await player.dialog();
  assert.ok(fewer.kind === "lock" && fewer.key !== lock.key);
  player.answer({ password: null, timeLockMs: NOW_MS + 3_600_000, publicKeys: [keyholder] });
  const values = await player.ended();
  player.stop();
  assert.equal(values.opened, "both");
  assert.equal(typeof values.many, "string");
  assert.deepEqual(player.diagnostics, []);
});

test("a cancelled unlock dialog gives the default, and a passed time lock out of reach asks only when a password can open it", async () => {
  const cancelled = new Harness(
    [
      'let locked = encryptText("x", password: "p", publicKey: false, timeLock: getAbsoluteDateTime() + 7 days)',
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
      'let both = encryptText("x", password: "p", publicKey: false, timeLock: past)',
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
      'let locked = encryptText("y", password: false, publicKey: false, timeLock: past)',
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
      'let locked = encryptFile(photo, password: "p", publicKey: false, timeLock: false)',
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
    [
      'let locked = encryptText("x", password: "p", publicKey: false, timeLock: false)',
      "exit",
    ].join("\n"),
    { subtle: undefined },
  );
  await player.until(() => player.session.state.status === "failed");
  player.stop();
  const failure = hatch(player.session, playerRuntimeSnapshot).failure;
  assert.equal(failure?.code, "TSR086");
});

test("a dialog waits for a distant time lock in bounded wakes, and none opens it early", async () => {
  const player = new Harness(
    [
      'let locked = encryptText("x", password: false, publicKey: false, timeLock: getAbsoluteDateTime() + 30 days)',
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
      'let locked = encryptText("empty", password: "", publicKey: false, timeLock: false)',
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
      'let locked = encryptText("y", password: false, publicKey: false, timeLock: getAbsoluteDateTime() + 1 min)',
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

test("what the player types in a dialog, and the Player's own objects, never reach the engine's host", async (context) => {
  // Every message of the in-process backend, as it is posted, before cloning could change what it is.
  const messages: unknown[] = [];
  const clone = globalThis.structuredClone;
  context.after(() => void (globalThis.structuredClone = clone));
  globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => {
    if (typeof value === "object" && value !== null && "v" in value) messages.push(value);
    return clone(value, options);
  };
  const typed = "typed words 7f3a";
  const player = new Harness(
    [
      'let locked = encryptText("fielded", password: askPassword("Choose a code"), publicKey: false, timeLock: false)',
      'let opened = decryptText(locked, password: askPassword("Your code?"), default: "closed")',
      "exit",
    ].join("\n"),
    { bridge: await inProcessBridge() },
  );
  await player.dialog();
  player.answer({ password: typed, timeLockMs: null });
  await player.dialog();
  player.answer({ password: typed, timeLockMs: null });
  assert.equal((await player.ended()).opened, "fielded");
  player.stop();
  assert.ok(messages.some((message) => JSON.stringify(message).includes("answerLock")));
  assert.equal(messages.filter((message) => JSON.stringify(message).includes(typed)).length, 0);
  // Only plain data crosses: no Blob, stream track, key, function or other class instance.
  const plain = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return typeof value !== "function";
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
      return false;
    return Object.values(value).every(plain);
  };
  assert.ok(messages.every(plain));
});

for (const stops of [false, true])
  test(`a locked file the store does not vouch for fails the step${stops ? ", unless the Player stopped while its reply came" : ""}`, async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const media = new CapturedMediaStore(null, urls, "locks");
    const photo = media.add("image", new Blob([png], { type: "image/png" })).reference;
    // The store keeps the locked file but does not vouch for it.
    media.holds = () => false;
    const host = await inProcessBridge(stops ? 50 : undefined);
    const sent: string[] = [];
    const player: Harness = new Harness(
      [
        `let photo = "${photo}"`,
        'let locked = encryptFile(photo, password: "p", publicKey: false, timeLock: false)',
        "exit",
      ].join("\n"),
      {
        media,
        files: [photo],
        bridge: host,
        onSend: (op, args) => {
          if (op !== "answerLock") return;
          const answer =
            typeof args === "object" && args !== null && "answer" in args ? args.answer : null;
          sent.push(
            typeof answer === "object" && answer !== null && "kind" in answer
              ? String(answer.kind)
              : "",
          );
          // The Player error stop while the refusal's reply is in transit: the store froze at once in-process, and the
          // stop then resets the service in the same tick.
          if (stops)
            queueMicrotask(() => {
              void host.halt(player.session);
              player.service.reset();
            });
        },
      },
    );
    await player.until(
      () => sent.length > 0 && (stops || player.session.state.status !== "waiting"),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    player.stop();
    const answers = sent;
    assert.deepEqual(answers, stops ? ["locked"] : ["locked", "failed"]);
    assert.deepEqual(
      player.diagnostics.map((diagnostic) => diagnostic.code),
      stops ? [] : ["lock-rejected"],
    );
    if (!stops) assert.equal(player.session.state.status, "failed");
  });

/**
 * Lets queued service tasks and their microtasks run out: reading a lock and loading its code, once loaded, wait for no
 * I/O, so a few zero-delay task turns settle them.
 */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A lock that opens with "p" or, 7 days from now, by its time lock, as its Base64 text. */
async function timedLock(): Promise<string> {
  const maker = new Harness(
    'let locked = encryptText("x", password: "p", publicKey: false, timeLock: getAbsoluteDateTime() + 7 days)\nexit',
  );
  const { locked } = await maker.ended();
  maker.stop();
  return String(locked);
}

test("a lock's unlock dialog whose preparation was retired never shows, nor waits for its time lock", async () => {
  // Its unlock dialog shows the time lock's moment and waits for it. Made once; each run below only reads it.
  const source = `let opened = decryptText("${await timedLock()}", default: "closed")\nexit`;
  const control = new Harness(source);
  assert.equal((await control.dialog()).kind, "unlock");
  assert.equal(control.wakes.length, 1, "the uninterrupted dialog waits for its time lock");
  control.stop();
  // Retire the preparation after `hops` microtasks of the service's task: at every await of the preparation in turn.
  const microtasks = async (hops: number) => {
    for (let hop = 0; hop < hops; hop++) await Promise.resolve();
  };
  for (const retire of ["reset", "stop", "replace"] as const) {
    let reached = false;
    for (let hops = 0; hops < 400 && !reached; hops++) {
      const player = new Harness(source, { start: false });
      let retired = -1;
      // Counted from the service's first read of the session at the step's ask, inside the task that prepares its dialog.
      player.onSession = () => {
        if (activePlayerRuntimeLock(player.session.state)?.phase !== "ask") return;
        player.onSession = null;
        void microtasks(hops).then(() => {
          // Once the dialog showed before the retirement, later hops only retire a shown dialog, which reset handles.
          if (player.dialogs.some((shown) => shown !== null)) reached = true;
          retired = player.dialogs.length;
          if (retire === "reset") player.service.reset();
          else if (retire === "stop") player.service.stop();
          else {
            // A replacing session, published and serviced as the Player's watch does, without a reset.
            player.replace();
            player.service.request();
          }
        });
      };
      player.service.request();
      await settled();
      assert.ok(retired >= 0);
      // The retired preparation's own dialog, of the step's key before the retirement. A replacement may present its
      // own dialog, of the new generation's key, as the next service does.
      const after = player.dialogs
        .slice(retired)
        .filter((shown) => shown !== null && shown.dialog.key.startsWith("1:"));
      if (!reached) {
        assert.deepEqual(after, [], `${retire} after ${hops} microtasks: no retired dialog`);
        if (retire === "replace") {
          // The replacing session's own step presents, and waits for its time lock.
          const own = player.dialogs
            .slice(retired)
            .filter((shown) => shown?.dialog.key.startsWith("2:"));
          assert.equal(own.length, 1, `replace after ${hops} microtasks: the new session's dialog`);
          assert.equal(player.wakes.length, 1, `replace after ${hops} microtasks: its wake`);
        } else assert.equal(player.wakes.length, 0, `${retire} after ${hops} microtasks: no wake`);
      }
      player.stop();
    }
    assert.ok(reached, `${retire}: the sweep reached the shown dialog`);
  }
});

/** A Player whose lock file is read only when the test releases each read made while the step asks. */
async function heldFileReads(locked: string) {
  const media = new CapturedMediaStore(null, urls, "locks");
  const file = media.add("file", new Blob([bytesFromBase64(locked)!])).reference;
  const reads: (() => void)[] = [];
  const read = media.read.bind(media);
  let player: Harness | null = null;
  media.read = (reference) => {
    const asking = activePlayerRuntimeLock(player!.session.state)?.phase === "ask";
    if (!asking) return read(reference);
    return new Promise((resolve) => reads.push(() => void read(reference).then(resolve)));
  };
  player = new Harness(`let opened = decryptFile("${file}", default: null)\nexit`, {
    media,
    files: [file],
  });
  const dialogs = () => player!.dialogs.filter((shown) => shown !== null && !shown.busy);
  return { player, reads, dialogs };
}

test("a retired preparation that finishes after a newer one began neither shows nor clears the newer one", async () => {
  const { player, reads, dialogs } = await heldFileReads(await timedLock());
  await player.until(() => reads.length === 1);
  // The first preparation is retired while its read is pending, and a newer one of the same step starts its own.
  player.service.reset();
  player.service.request();
  await player.until(() => reads.length === 2);
  reads[0]!();
  await settled();
  assert.deepEqual(dialogs(), [], "the retired preparation shows nothing");
  assert.equal(player.wakes.length, 0);
  reads[1]!();
  await player.until(() => dialogs().length > 0);
  await settled();
  assert.equal(dialogs().length, 1, "the newer preparation shows its dialog once");
  assert.equal(player.wakes.length, 1, "and waits for its time lock");
  player.stop();
});

test("a session held while its unlock dialog is prepared presents it once published again", async () => {
  const { player, reads, dialogs } = await heldFileReads(await timedLock());
  await player.until(() => reads.length === 1);
  // As during a paused random draw: the same session and step, held from the services, then published again.
  player.held = true;
  reads[0]!();
  await settled();
  assert.deepEqual(dialogs(), []);
  player.held = false;
  player.service.request();
  await player.until(() => reads.length === 2);
  reads[1]!();
  await player.until(() => dialogs().length > 0);
  assert.equal(dialogs()[0]!.dialog.kind, "unlock");
  assert.equal(player.wakes.length, 1);
  player.stop();
});

/*
 * The lock preload (L5i.7, F2): while a script that locks or opens is serviced, the Player loads the lock code its
 * `planMetadata` reply asks for; a reply that arrives for a pair no longer serviced, after the page ended, or not at all
 * loads nothing. The loaders are the injected `lockServices`, counted per call.
 */

/** What the session services read of the Player's session composable (`usePlayerSessionServices.ts`). */
interface ServicesHost {
  readonly camera: { answer(): null };
  readonly capturedMedia: CapturedMediaStore;
  readonly reportDiagnostic: (diagnostic: PlayerDiagnostic) => void;
  readonly servicedSession: Readonly<Ref<PlayerSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  readonly serviceSection: () => Promise<null>;
  readonly options: { readonly lockServices?: LockServices };
}
let usePlayerSessionServices: (host: ServicesHost) => object;
/** The real composable, as far as a lock's dialog and the shown session go. */
interface LockingPlayer {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly hostError: Readonly<Ref<string | null>>;
  readonly bridge: Promise<PlayerBridge>;
  prepare(create: PlanStart): void;
  activate(): Promise<void>;
  readonly lock: {
    readonly dialog: Readonly<Ref<{ readonly dialog: LockDialog; readonly busy: boolean } | null>>;
    submit(input: LockDialogInput): void;
  };
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly lockServices?: LockServices;
}) => LockingPlayer;
before(async () => {
  await loadTopology();
  const services = await loadPlayerModule("player/vue/src/session/usePlayerSessionServices.ts");
  const session = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  assert.equal(typeof services.usePlayerSessionServices, "function");
  assert.equal(typeof session.usePlayerSession, "function");
  // EVIDENCE: validation: checked as a function above; Vite loaded the real source module, and these are its host APIs.
  usePlayerSessionServices = services.usePlayerSessionServices as typeof usePlayerSessionServices;
  // EVIDENCE: validation: checked as a function above, from the same bundle.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
});

/** The page globals the composable reads, for the test. */
function pageSurface(context: TestContext): void {
  const globals = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

/** The real loaders, counted per call. */
function countedLoaders(): { readonly services: LockServices; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    services: {
      tlock: () => (calls.push("tlock"), loadTlock()),
      age: () => (calls.push("age"), loadAge()),
      fetch: relays(() => false),
      nowMs: () => NOW_MS,
    },
  };
}

/** Counts the `planMetadata` replies `bridge`'s client delivers, rejections included. */
function metadataReplies(context: TestContext, bridge: PlayerBridge): () => number {
  let replies = 0;
  const request = bridge.client.request.bind(bridge.client);
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const reply = request(...args);
    return args[0] === "planMetadata" ? reply.finally(() => (replies += 1)) : reply;
  });
  return () => replies;
}

/** A session of `script` started on `bridge`, at its first interaction. */
async function startedAt(bridge: PlayerBridge, script: string): Promise<PlayerSession> {
  return bridge.start(await preparedSource(bridge, script), { wallClockMs: NOW_MS }, false);
}

const SCRIPT_NAMES = ["no lock", "locks", "locks and encrypts"] as const;
/** Each script pauses at a choice before its lock step, so no service runs one. */
const PRELOAD_SCRIPTS: Record<(typeof SCRIPT_NAMES)[number], string> = {
  "no lock": 'let pick = askChoice "Go"\nexit',
  locks: 'let pick = askChoice "Go"\nsay decryptText("x", password: "p", default: "closed")\nexit',
  "locks and encrypts":
    'let pick = askChoice "Go"\nlet locked = encryptText("x", password: "p", publicKey: false, timeLock: false)\nexit',
};
/** What the preload of each script loads once its reply is taken. */
const PRELOADED: Record<(typeof SCRIPT_NAMES)[number], readonly string[]> = {
  "no lock": [],
  locks: ["tlock"],
  "locks and encrypts": ["tlock", "age"],
};
const PRELOAD_REPLIES = [
  "current",
  "another plan shown",
  "another connection shown",
  "unmounted",
  "lost",
] as const;
const preloadCase = (
  script: (typeof SCRIPT_NAMES)[number],
  reply: (typeof PRELOAD_REPLIES)[number],
): string => `preload: ${script}, ${reply}`;
const LOCK_RERUN = rerunRegistry<string>({
  ...Object.fromEntries(
    SCRIPT_NAMES.flatMap((script) =>
      PRELOAD_REPLIES.map((reply) => [preloadCase(script, reply), TOPOLOGIES]),
    ),
  ),
  "real composable lock": TOPOLOGIES,
  "lock before the preload's reply": TOPOLOGIES,
  "preload's reply before the lock is answered": TOPOLOGIES,
});

for (const script of SCRIPT_NAMES)
  for (const reply of PRELOAD_REPLIES)
    LOCK_RERUN.rows(
      preloadCase(script, reply),
      `the lock preload of a script with ${script}, its reply ${reply === "current" ? "taken while its pair is serviced" : `arriving with ${reply}`}, loads ${reply === "current" ? `what the script needs (${PRELOADED[script].join(", ") || "nothing"})` : "nothing"}`,
      async (context, topology, end) => {
        const transport = await topologyBridge(context, topology, { delayMs: 20 });
        transport.assertTopology();
        const replies = metadataReplies(context, transport.bridge);
        const serviced = await startedAt(transport.bridge, PRELOAD_SCRIPTS[script]);
        // The next plan of the same connection, and the first of another, whose token equals the serviced one's.
        const otherPlan =
          reply === "another plan shown"
            ? await startedAt(transport.bridge, PRELOAD_SCRIPTS["no lock"])
            : null;
        const other =
          reply === "another connection shown" ? await topologyBridge(context, topology) : null;
        const otherConnection =
          other === null ? null : await startedAt(other.bridge, PRELOAD_SCRIPTS["no lock"]);
        if (otherConnection !== null) assert.equal(otherConnection.planToken, serviced.planToken);
        const otherReplies = other === null ? () => 0 : metadataReplies(context, other.bridge);
        const loaders = countedLoaders();
        const servicedSession = shallowRef<PlayerSession | null>(null);
        const scope = effectScope();
        scope.run(() =>
          usePlayerSessionServices({
            camera: { answer: () => null },
            capturedMedia: new CapturedMediaStore(null, urls, "locks"),
            reportDiagnostic: (diagnostic) => assert.fail(diagnostic.message),
            servicedSession,
            generation: shallowRef(1),
            serviceSection: async () => null,
            options: { lockServices: loaders.services },
          }),
        );
        context.after(() => scope.stop());
        transport.hold("planMetadata");
        servicedSession.value = serviced;
        await transport.held();
        if (reply === "another plan shown") servicedSession.value = otherPlan;
        if (reply === "another connection shown") servicedSession.value = otherConnection;
        if (reply === "unmounted") scope.stop();
        if (reply === "lost") await transport.lose();
        transport.release();
        // Each `planMetadata` reply delivered, the preload's own callback runs next.
        const expected = reply === "another plan shown" ? 2 : 1;
        await until(
          () => replies() === expected && otherReplies() === (other === null ? 0 : 1),
          "the preload's replies",
          "host",
        );
        await settled();
        assert.deepEqual(loaders.calls, reply === "current" ? PRELOADED[script] : []);
        return end();
      },
    );

/** Waits, in short real-time turns, until `check` holds: a lock's key derivation takes longer than a reply. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `never: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Holds the outcome of `bridge`'s `planMetadata` requests from the caller until `release`; each is posted when made. */
function heldMetadata(context: TestContext, bridge: PlayerBridge) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let delivered = 0;
  const request = bridge.client.request.bind(bridge.client);
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const reply = request(...args);
    return args[0] === "planMetadata"
      ? gate.then(() => reply).finally(() => (delivered += 1))
      : reply;
  });
  return { release, delivered: () => delivered };
}

/** The lock dialog asks for a password; the script then opens its lock with it. */
const ASKS_A_PASSWORD = [
  'let locked = encryptText("chosen", password: true, publicKey: false, timeLock: false)',
  'say decryptText(locked, password: "words", default: "closed"), instant',
  "exit",
].join("\n");

/** The real composable on `topology`, started on `ASKS_A_PASSWORD`, its lock asked through its own dialog. */
async function lockingPlayer(context: TestContext, topology: Topology) {
  pageSurface(context);
  const transport = await topologyBridge(context, topology);
  transport.assertTopology();
  const loaders = countedLoaders();
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(transport.bridge),
      debugHistorySpill: async () => null,
      lockServices: loaders.services,
    }),
  )!;
  context.after(() => scope.stop());
  const start = async () => {
    player.prepare({
      plan: await preparedSource(player.bridge, ASKS_A_PASSWORD),
      options: () => ({ wallClockMs: NOW_MS }),
    });
    await player.activate();
  };
  /** Answers the dialog with a password and waits for the script to say what it opened. */
  const answer = async () => {
    await waitFor(() => player.lock.dialog.value?.busy === false, "the lock dialog");
    const dialog = player.lock.dialog.value!.dialog;
    assert.deepEqual(dialog.kind === "lock" && dialog.choices, ["password"]);
    player.lock.submit({ password: "words", timeLockMs: null });
    await waitFor(() => player.session.value?.state.status === "halted", "the script's end");
    assert.deepEqual(
      player.session.value?.transcriptEntries.map((entry) => entry.text),
      ["chosen"],
    );
  };
  return { transport, player, loaders, start, answer };
}

LOCK_RERUN.rows(
  "real composable lock",
  "a script's lock asked through the composable's dialog locks with the password the player gave",
  async (context, topology, end) => {
    const { player, start, answer } = await lockingPlayer(context, topology);
    await start();
    await answer();
    assert.equal(player.hostError.value, null);
    return end();
  },
);

LOCK_RERUN.rows(
  "lock before the preload's reply",
  "a lock asked and answered while the preload's reply is held completes, and the late reply only preloads",
  async (context, topology, end) => {
    const { transport, player, loaders, start, answer } = await lockingPlayer(context, topology);
    const metadata = heldMetadata(context, transport.bridge);
    await start();
    await answer();
    assert.equal(metadata.delivered(), 0, "the preload's reply is still held");
    const before = loaders.calls.length;
    metadata.release();
    await waitFor(() => metadata.delivered() === 1, "the preload's reply");
    await settled();
    // The injected loaders are plain functions, so the preload calls them again; the modules are evaluated once.
    assert.deepEqual(loaders.calls.slice(before), ["tlock", "age"]);
    assert.equal(player.lock.dialog.value, null, "no dialog again");
    assert.equal(player.session.value?.state.status, "halted");
    assert.equal(player.hostError.value, null);
    return end();
  },
);

LOCK_RERUN.rows(
  "preload's reply before the lock is answered",
  "the preload's reply let go as the session shows, before the lock's dialog is answered, changes nothing",
  async (context, topology, end) => {
    const { transport, player, start, answer } = await lockingPlayer(context, topology);
    const metadata = heldMetadata(context, transport.bridge);
    await start();
    assert.ok(player.session.value !== null, "the session shows");
    metadata.release();
    await answer();
    await waitFor(() => metadata.delivered() === 1, "the preload's reply");
    assert.equal(player.hostError.value, null);
    return end();
  },
);
