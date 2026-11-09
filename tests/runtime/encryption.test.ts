import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeLockActionSnapshot } from "../../src/runtime/actions/model.js";
import { createCheckpoint, serializeCheckpoint } from "../../src/runtime/snapshot/checkpoint.js";
import { run } from "../../src/runtime/engine.js";
import { completeAction } from "../../src/runtime/operations/complete-action.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { compileValidPlan } from "../helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { validateRuntimeSnapshot } from "../../src/runtime/snapshot/snapshot-validation.js";
import {
  WALL_CLOCK_MS,
  AGE_KEY,
  SSH_KEY,
  DAY_MS,
  FakePlayer,
  Played,
  play,
  lockStep,
  failure,
} from "../helpers/runtime/encryption-host.js";

function variables(played: Played): Record<string, SerializableRuntimeValue> {
  assert.equal(played.snapshot.failure, null, JSON.stringify(played.snapshot.failure));
  return Object.fromEntries(
    played.snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
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
      'let locked = encryptText("corner time", password: "corner", publicKey: false, timeLock: false)',
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
      'let timed = encryptText("a", password: false, publicKey: false, timeLock: getAbsoluteDateTime() + 3 days)',
      'let both = encryptText("b", password: "p", publicKey: false, timeLock: friday)',
      'let passwordOnly = encryptText("c", password: "p", publicKey: false, timeLock: false)',
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
      'let locked = encryptText("later", password: false, publicKey: false, timeLock: getAbsoluteDateTime() + 1 hour)',
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
  const both = ["timeLock", "password", "publicKey"];
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
      'let a = encryptText("a", password: "given", publicKey: false, timeLock: true)',
      'let b = encryptText("b", password: true, publicKey: false, timeLock: toAbsoluteDateTime("2026-10-16T18:00:00Z"))',
      "let wanted = 1 < 2",
      'let c = encryptText("c", password: wanted, publicKey: false, timeLock: false)',
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
      'let locked = encryptText("secret", password: "right", publicKey: false, timeLock: false)',
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
      'let locked = encryptText("corner time", password: askPassword("Choose a code", hint: "The code"), publicKey: false, timeLock: getAbsoluteDateTime() + 7 days)',
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
    [
      'let both = encryptText("both", password: askPassword("Code?"), publicKey: false, timeLock: true)',
      "exit",
    ].join("\n"),
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
    'let both = encryptText("both", password: askPassword("Code?"), publicKey: false, timeLock: true)\nexit',
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
    'let locked = encryptText("x", password: askPassword("New code"), publicKey: false, timeLock: false)',
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

test("publicKey: takes one key, a list, or true for the dialog, and key: opens with the unlock key sent back", () => {
  const player = new FakePlayer();
  player.dialogs.push(
    { password: "" },
    { publicKeys: [SSH_KEY] },
    { key: "key 9" },
    { key: "key 3" },
  );
  const played = play(
    [
      `let one = encryptText("one", password: false, publicKey: "${AGE_KEY}", timeLock: getAbsoluteDateTime() + 7 days)`,
      `let keys = ["${AGE_KEY}", "  ${SSH_KEY}  "]`,
      'let both = encryptText("both", password: false, publicKey: keys, timeLock: false)',
      'let dialog = encryptText("by the dialog")',
      'let chosen = encryptText("chosen", password: "p", publicKey: true, timeLock: false)',
      'let opened = decryptText(both, key: "key 2", default: null)',
      'let wrong = decryptText(both, key: "key 1", default: "closed")',
      'let asked = decryptText(dialog, default: "closed")',
      "exit",
    ].join("\n"),
    player,
  );
  const { one, both, chosen, opened, wrong, asked: byKey } = variables(played);
  assert.deepEqual([opened, wrong, byKey], ["both", "closed", "by the dialog"]);
  // The public keys as written, each trimmed; a public key written true is chosen in the dialog.
  assert.deepEqual(
    played.steps
      .filter((step) => step.call === "encryptText")
      .map((step) => [step.phase, step.publicKeys, step.timeLockMs, step.choices]),
    [
      ["work", [AGE_KEY], WALL_CLOCK_MS + 7 * DAY_MS, []],
      ["work", [AGE_KEY, SSH_KEY], null, []],
      ["ask", [], WALL_CLOCK_MS + 7 * DAY_MS, ["timeLock", "password", "publicKey"]],
      ["work", [], null, ["timeLock", "password", "publicKey"]],
      ["ask", [], null, ["publicKey"]],
      ["work", [], null, ["publicKey"]],
    ],
  );
  assert.deepEqual(player.publicKeys.get(String(one)), [AGE_KEY]);
  assert.deepEqual(player.publicKeys.get(String(chosen)), [SSH_KEY]);
  assert.deepEqual(player.locks.get(String(chosen))?.password, "p");
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

test("encryptFile locks a stored file into a locked file, and decryptFile opens it into a file of its type", () => {
  const player = new FakePlayer();
  const photo = player.keep("image/png", "PNG bytes");
  const played = play(
    [
      `let photo = "${photo}"`,
      'let locked = encryptFile(photo, password: "p", publicKey: false, timeLock: false)',
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
      'let locked = encryptText("spaced", password: "p", publicKey: false, timeLock: false)',
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
      'let locked = encryptText("inside", password: "p", publicKey: false, timeLock: false)',
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

test("an encrypt call fails at runtime without a way to open, with an argument of the wrong kind, or without a clock", () => {
  const failures = [
    [
      'let off = fromJson("false", default: true)',
      'let a = encryptText("x", password: off, publicKey: false, timeLock: off)',
      "exit",
    ],
    [
      'let amount = fromJson("4", default: null)',
      'let a = encryptText("x", password: amount, publicKey: false, timeLock: false)',
      "exit",
    ],
    [
      'let amount = fromJson("4", default: null)',
      'let a = encryptText("x", password: false, publicKey: false, timeLock: amount)',
      "exit",
    ],
    [
      'let nothing = fromJson("null", default: 1)',
      'let a = encryptText("x", password: "p", publicKey: false, timeLock: nothing)',
      "exit",
    ],
    [
      'let a = encryptFile("images/a.jpg", password: "p", publicKey: false, timeLock: false)',
      "exit",
    ],
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
      code: "TSV043",
      message:
        "encryptText(...) has no way to open, because 'password:', 'publicKey:', and 'timeLock:' are all false, so nothing could ever open it. Give one of them a value, or true to let the player choose.",
    },
    {
      code: "TSV043",
      message:
        "'password:' of encryptText(...) takes text (string), true, or false, not a whole number (integer).",
    },
    {
      code: "TSV043",
      message:
        "'timeLock:' of encryptText(...) takes a moment (absoluteDateTime), true, or false, not a whole number (integer).",
    },
    {
      code: "TSV043",
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
    {
      code: "TSV043",
      message: "decryptText(...) opens locked text (string), not a whole number (integer).",
    },
  ]);
  // Only a time lock the player chooses needs the clock, to suggest its moment.
  assert.deepEqual(
    failure(
      play(
        'let a = encryptText("x", password: "p", publicKey: false, timeLock: true)\nexit',
        new FakePlayer(),
        {},
      ),
    ),
    {
      code: "TSR064",
      message:
        "encryptText(...) needs the current time to suggest a time lock, but this Player supplied no clock when the session started or continued.",
    },
  );
  assert.equal(
    typeof variables(
      play(
        'let a = encryptText("x", password: "p", publicKey: false, timeLock: false)\nexit',
        new FakePlayer(),
        {},
      ),
    ).a,
    "string",
  );
});
