import { preparePlayerMessageMarkup } from "../player/message-markup.js";
import { normalizeColor } from "../src/color.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  compileSource,
  createFreshRuntimeSnapshot,
  run,
  createCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
} from "../src/index.js";

import {
  activatePlayerRuntimeButton,
  activePlayerRuntimeCapture,
  answerPlayerRuntimeCapture,
  completePlayerRuntimeStorageWrite,
  pendingPlayerRuntimeStorageWrite,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeDeadlines,
  playerRuntimeForeground,
  playerRuntimeMedia,
  playerRuntimePacingGate,
  playerRuntimeTimers,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSession,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimePacing,
  submitPlayerRuntimeComposer,
} from "../player/runtime-adapter.js";

test("runtime adapter delivers resolved authored presentation and preserves it on restore", () => {
  const session = createPlayerRuntimeSession(`
speaker guide {
  font: "Georgia"
  color: "red"
  prose: { align: "left" }
}
say as guide prose(position: "right", background: "ivory") "A letter", instant
showButton "Continue"
`);
  const entry = session.transcriptEntries[0];
  if (entry?.kind !== "message") throw new Error("Expected a runtime message.");
  assert.deepEqual(entry.presentation, {
    kind: "prose",
    position: "right",
    align: "left",
    font: "Georgia",
    color: normalizeColor("red"),
    background: normalizeColor("ivory"),
  });
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
});

test("speaker identity remains stable when authored presentation changes", () => {
  const session = createPlayerRuntimeSession(`
speaker guide { displayName: "Guide" }
say as guide "First", instant
guide.displayName = "Captain"
say as guide "Second", instant
exit
`);
  const entries = session.transcriptEntries;
  const first = entries[0];
  const second = entries[1];
  if (first?.kind !== "message" || second?.kind !== "message") {
    throw new Error("Expected two runtime messages.");
  }
  // The earlier message keeps the name it was said with; both share the identity that selects the avatar colour.
  assert.equal(session.speakers[first.speakerId]?.name, "Guide");
  assert.equal(session.speakers[second.speakerId]?.name, "Captain");
  assert.equal(session.speakers[first.speakerId]?.identityId, "guide");
  assert.equal(session.speakers[second.speakerId]?.identityId, "guide");
});

test("runtime adapter preserves omitted alignment separately from explicit center through restore", () => {
  const session = createPlayerRuntimeSession(`
say "Default bubble", instant
say prose "Default prose", instant
say prose(position: "center", align: "center") "Explicit center", instant
showButton "Continue"
`);
  const positions = session.transcriptEntries.map((entry) => {
    if (entry.kind !== "message") throw new Error("Expected a runtime message.");
    return [entry.presentation?.position, entry.presentation?.align];
  });
  assert.deepEqual(positions, [
    [null, null],
    [null, null],
    ["center", "center"],
  ]);
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
});

test("runtime adapter separates authored avatar images from the letter fallback", () => {
  const session = createPlayerRuntimeSession(`
speaker vera {
  firstName: "Vera"
  avatar: "avatars/vera.jpg"
}
speaker guide { title: "guide" }
say as vera "Hello.", instant
say as guide "Welcome.", instant
exit
`);
  const speakers = session.transcriptEntries.map((entry) =>
    entry.kind === "message" ? session.speakers[entry.speakerId] : undefined,
  );
  assert.deepEqual(
    speakers.map((speaker) => [speaker?.avatar, speaker?.avatarImage]),
    [
      ["V", "avatars/vera.jpg"],
      ["G", undefined],
    ],
  );
});

test("runtime adapter delegates interaction normalization, transcript, and continuation to the engine", () => {
  let session = createPlayerRuntimeSession(`
speaker guide {
  title: "Guide"
  color: "#b784ff"
}
say as guide "**Ready?**", instant
showButton as guide "Continue"
let text = askText as guide "Text"
let amount = askNumber as guide "Number"
let choice = choose as guide first: "Same", second: "Same"
say as guide "${"${text}"} / ${"${amount}"} / ${"${choice}"}", instant
exit
`);
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Ready?"],
  );
  const firstEntry = session.transcriptEntries[0];
  if (firstEntry?.kind !== "message") throw new Error("Expected a runtime message.");
  const guide = session.speakers[firstEntry.speakerId];
  assert.deepEqual(guide, {
    identityId: "guide",
    name: "Guide",
    accent: normalizeColor("#b784ff"),
    avatar: "G",
    fontFamily: "inherit",
  });
  assert.equal(firstEntry.content?.visibleText, "Ready?");
  assert.deepEqual(
    firstEntry.content?.blocks[0]?.kind === "paragraph"
      ? firstEntry.content.blocks[0].lines[0]?.spans.map((span) => span.kind)
      : [],
    ["bold"],
  );

  const buttonSnapshot = structuredClone(session.snapshot);
  assert.equal(submitPlayerRuntimeComposer(session, "continue"), null);
  assert.equal(submitPlayerRuntimeComposer(session, "Continue "), null);
  assert.equal(submitPlayerRuntimeComposer(session, ""), null);
  assert.deepEqual(session.snapshot, buttonSnapshot);
  const buttonRestorePoint = createPlayerRuntimeRestorePoint(session);
  const button = submitPlayerRuntimeComposer(session, "Continue");
  assert.equal(button?.outcome.kind, "completed");
  const clickedButton = activatePlayerRuntimeButton(
    restorePlayerRuntimeSession(buttonRestorePoint),
  );
  assert.deepEqual(button?.outcome, clickedButton?.outcome);
  assert.deepEqual(button?.session.snapshot, clickedButton?.session.snapshot);
  assert.deepEqual(button?.session.transcriptEntries, clickedButton?.session.transcriptEntries);
  session = button!.session;

  const invalidText = submitPlayerRuntimeComposer(session, " \t ");
  assert.equal(invalidText?.outcome.kind, "invalidPayload");
  assert.deepEqual(
    invalidText?.session.snapshot.foregroundAction,
    session.snapshot.foregroundAction,
  );
  const text = submitPlayerRuntimeComposer(session, "  A\r\nB\r  ");
  assert.equal(text?.outcome.kind, "completed");
  session = text!.session;

  const invalidNumber = submitPlayerRuntimeComposer(session, "not a number");
  assert.equal(invalidNumber?.outcome.kind, "invalidPayload");
  const number = submitPlayerRuntimeComposer(session, "  -0e2  ");
  assert.equal(number?.outcome.kind, "completed");
  session = number!.session;

  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  if (foreground?.kind !== "choose") throw new Error("Expected choice presentation.");
  assert.deepEqual(
    foreground.options.map((option) => option.label),
    ["Same", "Same"],
  );
  const ambiguous = submitPlayerRuntimeComposer(session, "Same");
  assert.equal(ambiguous?.outcome.kind, "invalidPayload");
  assert.deepEqual(ambiguous?.session.snapshot.foregroundAction, session.snapshot.foregroundAction);

  const selected = selectPlayerRuntimeChoice(session, foreground.options[1]!.id);
  assert.equal(selected?.outcome.kind, "completed");
  session = selected!.session;
  assert.equal(session.snapshot.status, "halted");
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Ready?", "Continue", "  A\nB\n  ", "-0e2", "Same", "  A\nB\n   / 0 / second"],
  );
  const transcriptIds = session.transcriptEntries.map((entry) => entry.id);
  assert.equal(new Set(transcriptIds).size, transcriptIds.length);
  assert.equal(
    session.transcriptEntries[0]?.kind === "message" &&
      session.transcriptEntries[0].content !== undefined,
    true,
  );
  assert.equal(
    session.transcriptEntries[1]?.kind === "message" &&
      session.transcriptEntries[1].content === undefined,
    true,
  );
  assert.equal(
    session.transcriptEntries[5]?.kind === "message" &&
      session.transcriptEntries[5].content !== undefined,
    true,
  );
});

test("runtime adapter preserves unlabelled choice order and rendered-selection semantics", () => {
  let session = createPlayerRuntimeSession(
    'let choice = choose "First", "Second"\nsay choice, instant',
  );
  const foreground = playerRuntimeForeground(session);
  assert.equal(foreground?.kind, "choose");
  if (foreground?.kind !== "choose") throw new Error("Expected choice presentation.");
  assert.deepEqual(
    foreground.options.map((option) => option.label),
    ["First", "Second"],
  );
  const selected = selectPlayerRuntimeChoice(session, foreground.options[1]!.id);
  assert.equal(selected?.outcome.kind, "completed");
  session = selected!.session;
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["Second", "Second"],
  );
});

test("runtime adapter routes pacing skip and explicit time through canonical operations", () => {
  let session = createPlayerRuntimeSession(
    'say unskippable "First", 10\nsay skippable "Second", 10\nwait 20 s',
  );
  const firstGate = playerRuntimePacingGate(session);
  assert.equal(firstGate?.skippable, false);
  const beforeRejectedSkip = structuredClone(session.snapshot);
  const rejected = skipPlayerRuntimePacing(session);
  assert.equal(rejected?.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected?.session.snapshot, beforeRejectedSkip);

  const observed = observePlayerRuntimeTime(session, firstGate!.deadlineMs);
  assert.equal(observed.outcome.kind, "observed");
  session = observed.session;
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["First", "Second"],
  );
  assert.equal(playerRuntimePacingGate(session)?.skippable, true);

  const skipped = skipPlayerRuntimePacing(session);
  assert.equal(skipped?.outcome.kind, "completed");
  assert.equal(playerRuntimePacingGate(skipped!.session), null);
  assert.equal(skipped?.session.snapshot.foregroundAction?.kind, "delay");
});

test("runtime checkpoint restore reconstructs presentation without replay or completion", () => {
  let session = createPlayerRuntimeSession(
    'say "Question", instant\nlet answer = choose one: "One", two: "Two"\nsay answer, instant',
  );
  const before = playerRuntimeForeground(session);
  const restorePoint = createPlayerRuntimeRestorePoint(session);
  const roundTrippedCheckpoint = deserializeCheckpoint(restorePoint.checkpointJson);
  assert.deepEqual(roundTrippedCheckpoint.snapshot, session.snapshot);

  if (before?.kind !== "choose") throw new Error("Expected choice presentation.");
  session = selectPlayerRuntimeChoice(session, before.options[0]!.id)!.session;
  assert.equal(session.snapshot.status, "halted");

  const restored = restorePlayerRuntimeSession(restorePoint);
  assert.deepEqual(playerRuntimeForeground(restored), before);
  assert.deepEqual(
    restored.transcriptEntries.map((entry) => entry.text),
    ["Question"],
  );
  assert.equal(restored.snapshot.status, "waiting");
  assert.equal(restored.events.length, restorePoint.events.length);
});

test("runtime checkpoint restore preserves a paced history and its continuation", () => {
  let session = createPlayerRuntimeSession('repeat 4 { say "x" }');
  for (let index = 0; index < 2; index++) session = skipPlayerRuntimePacing(session)!.session;
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.events, session.events);
  assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
  const resumed = skipPlayerRuntimePacing(restored)!.session;
  const direct = skipPlayerRuntimePacing(session)!.session;
  assert.deepEqual(resumed.snapshot, direct.snapshot);
  assert.deepEqual(resumed.transcriptEntries, direct.transcriptEntries);
});

test("runtime checkpoint restore handles retained event histories above the native spread limit", () => {
  // Size is the regression input: spreading this many arguments exceeded the supported Node stack.
  const count = 150_000;
  const { plan } = compileSource(`repeat ${count} { say "x", instant }`);
  assert.ok(plan);
  const result = run(plan, createFreshRuntimeSnapshot(plan), {}, { instructionBudget: count * 20 });
  assert.equal(result.snapshot.status, "halted");
  const restored = restorePlayerRuntimeSession({
    checkpointJson: serializeCheckpoint(createCheckpoint(plan, result.snapshot)),
    events: result.events,
  });
  assert.deepEqual(restored.events, result.events);
  assert.equal(restored.transcriptEntries.length, count);
  assert.equal(new Set(restored.transcriptEntries.map((entry) => entry.id)).size, count);
  assert.equal(restored.transcriptEntries[0]?.text, "x");
  assert.equal(restored.transcriptEntries.at(-1)?.text, "x");
  assert.deepEqual(restored.snapshot, result.snapshot);
});

test("invalid dynamic markup colours preserve enclosing colours in delivered pieces", () => {
  const session = createPlayerRuntimeSession(`
let bad = "invalid"
say "[color=red][bg=ivory]outer [color=\${bad}][bg=\${bad}]inner **bold**[/bg][/color] outer[/bg][/color] [color=\${bad}][bg=\${bad}]plain[/bg][/color]", instant
`);
  const entry = session.transcriptEntries[0];
  if (entry?.kind !== "message" || entry.content === undefined) throw new Error("Expected markup.");
  const block = preparePlayerMessageMarkup(entry.content)[0];
  if (block?.kind !== "paragraph") throw new Error("Expected paragraph.");
  const pieces = block.lines[0]!.pieces;
  const text = (selected: typeof pieces) => selected.map((piece) => piece.text).join("");
  assert.equal(text(pieces), "outer inner bold outer plain");
  const coloured = pieces.filter(
    (piece) => piece.style.color !== undefined || piece.style.backgroundColor !== undefined,
  );
  assert.equal(text(coloured), "outer inner bold outer");
  for (const piece of coloured) {
    assert.equal(piece.style.color, normalizeColor("red"), piece.text);
    assert.equal(piece.style.backgroundColor, normalizeColor("ivory"), piece.text);
  }
  assert.equal(text(pieces.filter((piece) => !coloured.includes(piece))).trim(), "plain");
});

test("response presentation distinguishes choices and buttons from typed answers after restore", () => {
  let session = createPlayerRuntimeSession(`
let reply = askText "Reply"
let answer = choose left: "Left", right: "Right"
showButton "Continue"
exit
`);
  session = submitPlayerRuntimeComposer(session, "Hello")!.session;
  session = submitPlayerRuntimeComposer(session, "Left")!.session;
  session = activatePlayerRuntimeButton(session)!.session;
  const kinds = (value: typeof session) =>
    value.transcriptEntries.map((entry) =>
      entry.kind === "message" ? entry.responseKind : undefined,
    );
  assert.deepEqual(kinds(session), [undefined, "choice", "button"]);
  assert.deepEqual(
    kinds(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session))),
    kinds(session),
  );
});

test("blocking timer scenario presents runtime timers, hides waits, and restores the same draw", async () => {
  const source = await readFile(
    resolve(process.cwd(), "tests/fixtures/timers/blocking-timer.tease"),
    "utf8",
  );
  let session = createPlayerRuntimeSession(source);
  const presented: Array<number | null> = [];
  let restoredChecked = false;
  for (let guard = 0; session.snapshot.foregroundAction?.kind === "delay"; guard += 1) {
    assert.ok(guard < 10, "scenario must reach its final button");
    const action = session.snapshot.foregroundAction;
    const now = session.snapshot.currentSessionTimeMs;
    const timers = playerRuntimeTimers(session.snapshot, now);
    if (action.display === "hidden") {
      assert.deepEqual(timers, [], "a hidden wait has no timer presentation");
      presented.push(null);
    } else {
      const total = (action.deadlineMs - action.createdAtMs) / 1000;
      // The entry ID is an opaque key; restore below compares it for equality.
      assert.deepEqual(
        timers.map(({ kind, name, remainingSeconds, totalSeconds }) => ({
          kind,
          name,
          remainingSeconds,
          totalSeconds,
        })),
        [{ kind: "visible", name: undefined, remainingSeconds: total, totalSeconds: total }],
      );
      assert.equal(
        playerRuntimeTimers(session.snapshot, now + 1_250)[0]?.remainingSeconds,
        total - 1.25,
      );
      assert.equal(
        playerRuntimeTimers(session.snapshot, action.deadlineMs + 5_000)[0]?.remainingSeconds,
        0,
      );
      assert.equal(playerRuntimeTimers(session.snapshot, now - 5_000)[0]?.remainingSeconds, total);
      presented.push(total);

      if (!restoredChecked && presented.length === 2) {
        const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
        assert.deepEqual(restored.snapshot, session.snapshot, "restore keeps the drawn duration");
        assert.deepEqual(
          playerRuntimeTimers(restored.snapshot, now + 500),
          playerRuntimeTimers(session.snapshot, now + 500),
        );
        session = restored;
        restoredChecked = true;
      }
    }
    const early = observePlayerRuntimeTime(session, action.deadlineMs - 1);
    assert.equal(early.session.snapshot.foregroundAction?.actionId, action.actionId);
    session = observePlayerRuntimeTime(early.session, action.deadlineMs).session;
    assert.notEqual(
      session.snapshot.foregroundAction?.actionId,
      action.actionId,
      "settled timer is removed",
    );
  }
  assert.ok(restoredChecked);
  assert.equal(presented.length, 5);
  assert.equal(presented[0], 5);
  assert.ok(presented[1]! >= 4 && presented[1]! <= 8);
  assert.equal(presented[2], null);
  assert.ok(presented.slice(3).every((total) => total! >= 3 && total! <= 5));
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");
  assert.deepEqual(
    playerRuntimeTimers(session.snapshot, session.snapshot.currentSessionTimeMs),
    [],
  );
  assert.deepEqual(
    session.transcriptEntries.map((entry) => (entry.kind === "message" ? entry.text : "")).at(-1),
    "Every timer has settled.",
  );
});

test("authored timers scenario presents concurrent timers and interrupts the unanswered question", async () => {
  const source = await readFile(
    resolve(process.cwd(), "tests/fixtures/timers/authored-timers.tease"),
    "utf8",
  );
  const texts = (session: ReturnType<typeof createPlayerRuntimeSession>) =>
    session.transcriptEntries.flatMap((entry) => (entry.kind === "message" ? [entry.text] : []));
  const presented = (session: ReturnType<typeof createPlayerRuntimeSession>, now: number) =>
    playerRuntimeTimers(session.snapshot, now).map((timer) => [
      timer.kind,
      timer.name ?? null,
      timer.remainingSeconds,
    ]);

  let session = createPlayerRuntimeSession(source);
  assert.equal(playerRuntimeForeground(session)?.kind, "ask-text");
  const pulse = presented(session, 0)[0]!;
  assert.deepEqual(presented(session, 0).slice(1), [
    ["mystery", "Secret", 40],
    ["visible", "Answer deadline", 20],
  ]);
  assert.deepEqual(pulse.slice(0, 2), ["visible", "Pulse"], "the hidden reminder is not presented");
  assert.ok(Number(pulse[2]) >= 2 && Number(pulse[2]) <= 4);
  assert.ok(playerRuntimeDeadlines(session.snapshot).includes(6_000));

  session = observePlayerRuntimeTime(session, 6_000).session;
  assert.match(texts(session).at(-1)!, /^A hidden timer just expired\. [1-3] pulses so far\.$/u);
  assert.equal(playerRuntimeForeground(session)?.kind, "ask-text", "the question returns");
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(restored.snapshot, session.snapshot);

  const answered = submitPlayerRuntimeComposer(
    observePlayerRuntimeTime(restored, 8_000).session,
    "Ada",
  );
  assert.equal(answered?.outcome.kind, "completed");
  session = answered!.session;
  assert.ok(texts(session).includes("Thank you, Ada. 12 s were left on the deadline."));
  assert.deepEqual(
    presented(session, 8_000).map(([kind, name]) => [kind, name]),
    [
      ["visible", "Pulse"],
      ["mystery", "Secret"],
    ],
    "the stopped deadline disappears",
  );
  assert.equal(presented(session, 10_000)[1]?.[2], 32, "a paused timer keeps its remaining time");
  session = observePlayerRuntimeTime(session, 11_000).session;
  assert.deepEqual(presented(session, 11_000).at(-2)?.slice(0, 2), ["visible", "Secret"]);
  assert.deepEqual(presented(session, 11_000).at(-1), ["visible", "Final countdown", 3]);
  session = observePlayerRuntimeTime(session, 14_000).session;
  assert.match(texts(session).at(-1)!, /^Done after \d+ pulses\.$/u);
  assert.equal(playerRuntimeForeground(session)?.kind, "show-button");

  let unanswered = createPlayerRuntimeSession(source);
  for (const now of [6_000, 12_000, 20_000]) {
    unanswered = observePlayerRuntimeTime(unanswered, now).session;
  }
  assert.equal(texts(unanswered).at(-1), "Time is up, so the question is cancelled.");
  assert.equal(playerRuntimeForeground(unanswered)?.kind, "show-button");
  unanswered = activatePlayerRuntimeButton(unanswered)!.session;
  assert.equal(unanswered.snapshot.status, "halted");
  assert.deepEqual(playerRuntimeTimers(unanswered.snapshot, 20_000), []);
});

test("runtime adapter forwards media reports, projects a live seek, and restores pending samples", () => {
  let session = createPlayerRuntimeSession(
    [
      'showImage "images/room.jpg"',
      'let music = playAudio async "music.mp3" {',
      "  at 1 s {",
      "    music.position = 3 s",
      "  }",
      "}",
      "wait 10",
      'say "done ${music.position} ${music.elapsed}", instant',
    ].join("\n"),
  );
  assert.deepEqual(playerRuntimeMedia(session.snapshot).stage, {
    image: "images/room.jpg",
    videoMediaId: null,
  });
  assert.equal(playerRuntimeMedia(session.snapshot).media[0]?.loaded, false);
  const loaded = reportPlayerRuntimeMediaLoad(session, 1, { kind: "loaded", durationMs: 10_000 });
  assert.equal(loaded.outcome.kind, "accepted");
  session = observePlayerRuntimeTime(loaded.session, 1_500, [
    { mediaId: 1, segment: 1, progressMs: 1_500 },
  ]).session;
  // The cue at 1 s seeked to 3 s: a new segment starts there.
  let [media] = playerRuntimeMedia(session.snapshot).media;
  assert.deepEqual(
    { segment: media?.segment, playheadMs: media?.playheadMs, reported: media?.reportedProgressMs },
    { segment: 2, playheadMs: 3_000, reported: 0 },
  );
  session = observePlayerRuntimeTime(session, 2_000, [
    { mediaId: 1, segment: 2, progressMs: 500 },
  ]).session;
  const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
  assert.deepEqual(playerRuntimeMedia(restored.snapshot), playerRuntimeMedia(session.snapshot));
  [media] = playerRuntimeMedia(restored.snapshot).media;
  assert.deepEqual(
    { playheadMs: media?.playheadMs, reported: media?.reportedProgressMs },
    { playheadMs: 3_500, reported: 500 },
  );
  const finished = observePlayerRuntimeTime(restored, 10_000, [
    { mediaId: 1, segment: 2, progressMs: 8_500 },
  ]).session;
  assert.equal(finished.snapshot.status, "halted");
  const last = finished.transcriptEntries.at(-1);
  assert.equal(last?.kind === "message" ? last.text : undefined, "done 10 s 8 s");
});

test("the Player answers takePhoto() with a vouched reference or an unavailable camera", () => {
  const session = createPlayerRuntimeSession(
    "let photo = takePhoto()\nshowImage photo\nlet second = takePhoto()",
  );
  const pending = activePlayerRuntimeCapture(session.snapshot);
  assert.ok(pending !== null);
  const reference = "captured-media:session:1";
  const unvouched = answerPlayerRuntimeCapture(session, pending.actionId, {
    kind: "captured",
    reference,
  });
  assert.equal(unvouched.outcome.kind, "invalidPayload");
  const answered = answerPlayerRuntimeCapture(
    session,
    pending.actionId,
    { kind: "captured", reference },
    { holds: (candidate, kind) => candidate === reference && kind === "image" },
  );
  assert.equal(answered.outcome.kind, "completed");
  // The session continued to the next capture and shows the photo.
  assert.equal(playerRuntimeMedia(answered.session.snapshot).stage.image, reference);
  const next = activePlayerRuntimeCapture(answered.session.snapshot);
  assert.ok(next !== null && next.actionId !== pending.actionId);
  const unavailable = answerPlayerRuntimeCapture(answered.session, next.actionId, {
    kind: "unavailable",
    reason: "denied",
  });
  assert.equal(unavailable.outcome.kind, "completed");
  assert.equal(unavailable.session.snapshot.status, "halted");
  assert.ok(
    unavailable.session.events.some(
      (event) => event.kind === "developerWarning" && event.code === "TSW015",
    ),
  );
});

test("runtime adapter leaves evaluated persistent writes pending until acknowledgement", () => {
  const initial = [{ key: "answer.2", value: "previous" }];
  const session = createPlayerRuntimeSession(
    `
let suffix = 2
let replacement = "new"
save "\${replacement} value" as "answer.\${suffix}"
let answer = load "answer.\${suffix}"
say answer, instant
exit
`,
    { scriptStorage: initial, persistentScriptStorage: true },
  );
  const write = pendingPlayerRuntimeStorageWrite(session.snapshot);
  assert.ok(write);
  assert.deepEqual({ key: write.key, value: write.value }, { key: "answer.2", value: "new value" });
  assert.equal(session.snapshot.status, "waiting");
  assert.equal(session.snapshot.scriptStoragePersistent, true);
  assert.deepEqual(session.snapshot.scriptStorage, initial);
  assert.deepEqual(session.transcriptEntries, []);

  const completed = completePlayerRuntimeStorageWrite(session, write.actionId, true);
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(completed.session.snapshot.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(completed.session.snapshot), null);
  assert.deepEqual(completed.session.snapshot.scriptStorage, [
    { key: "answer.2", value: "new value" },
  ]);
  assert.deepEqual(
    completed.session.transcriptEntries.map((entry) => entry.text),
    ["new value"],
  );
});

test("runtime adapter retains the previous value and emits TSW014 after a failed write acknowledgement", () => {
  const session = createPlayerRuntimeSession(
    'save "replacement" as "answer"\nlet answer = load "answer"\nsay answer, instant\nexit',
    { scriptStorage: [{ key: "answer", value: "previous" }], persistentScriptStorage: true },
  );
  const write = pendingPlayerRuntimeStorageWrite(session.snapshot);
  assert.ok(write);
  const completed = completePlayerRuntimeStorageWrite(session, write.actionId, false);
  assert.equal(completed.outcome.kind, "completed");
  assert.equal(completed.session.snapshot.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(completed.session.snapshot), null);
  assert.deepEqual(completed.session.snapshot.scriptStorage, [
    { key: "answer", value: "previous" },
  ]);
  assert.deepEqual(
    completed.session.transcriptEntries.map((entry) => entry.text),
    ["previous"],
  );
  assert.deepEqual(
    completed.session.events
      .filter((event) => event.kind === "developerWarning")
      .map(({ code, message }) => ({ code, message })),
    [{ code: "TSW014", message: 'save could not persist "answer"; the previous value is kept.' }],
  );
});

test("runtime adapter keeps storage session-local by default without pending writes or warnings", () => {
  const session = createPlayerRuntimeSession(
    'save "local" as "answer"\nlet answer = load "answer"\nsay answer, instant\ndelete "old"\nexit',
    { scriptStorage: [{ key: "old", value: "initial" }] },
  );
  assert.equal(session.snapshot.scriptStoragePersistent, false);
  assert.equal(session.snapshot.status, "halted");
  assert.equal(session.snapshot.foregroundAction, null);
  assert.equal(pendingPlayerRuntimeStorageWrite(session.snapshot), null);
  assert.deepEqual(session.snapshot.scriptStorage, [{ key: "answer", value: "local" }]);
  assert.deepEqual(
    session.transcriptEntries.map((entry) => entry.text),
    ["local"],
  );
  assert.deepEqual(
    session.events.filter(
      (event) =>
        event.kind === "developerWarning" ||
        (event.kind === "actionRequested" && event.action.kind === "storageWrite") ||
        (event.kind === "actionCompleted" && event.settlement.actionKind === "storageWrite"),
    ),
    [],
  );
});

test("runtime adapter ignores unknown and stale storage action IDs", () => {
  const original = createPlayerRuntimeSession('save 1 as "answer"\nsave 2 as "answer"\nexit', {
    persistentScriptStorage: true,
  });
  const first = pendingPlayerRuntimeStorageWrite(original.snapshot);
  assert.ok(first);
  const unknown = completePlayerRuntimeStorageWrite(original, first.actionId + 100, true);
  assert.notEqual(unknown.outcome.kind, "completed");
  assert.deepEqual(unknown.session, original);

  const completed = completePlayerRuntimeStorageWrite(original, first.actionId, true);
  const second = pendingPlayerRuntimeStorageWrite(completed.session.snapshot);
  assert.ok(second);
  assert.notEqual(second.actionId, first.actionId);
  const stale = completePlayerRuntimeStorageWrite(completed.session, first.actionId, false);
  assert.notEqual(stale.outcome.kind, "completed");
  assert.deepEqual(stale.session, completed.session);
  assert.deepEqual(stale.session.snapshot.scriptStorage, [{ key: "answer", value: 1 }]);
});

test("runtime adapter leaves writes reached after interaction and time observation pending", () => {
  let session = createPlayerRuntimeSession(
    'showButton "Continue"\nsave 2 as "answered"\nwait 1 s\nsave 3 as "observed"\ndelete "answered"\nlet answer = load "answered" default "deleted"\nsay answer, instant\nexit',
    { persistentScriptStorage: true },
  );
  assert.equal(pendingPlayerRuntimeStorageWrite(session.snapshot), null);
  const answered = activatePlayerRuntimeButton(session);
  assert.ok(answered);
  assert.equal(answered.outcome.kind, "completed");
  session = answered.session;
  const interactionWrite = pendingPlayerRuntimeStorageWrite(session.snapshot);
  assert.ok(interactionWrite);
  assert.deepEqual(
    { key: interactionWrite.key, value: interactionWrite.value },
    { key: "answered", value: 2 },
  );
  assert.equal(session.snapshot.status, "waiting");
  assert.deepEqual(session.snapshot.scriptStorage, []);
  session = completePlayerRuntimeStorageWrite(session, interactionWrite.actionId, true).session;
  assert.equal(session.snapshot.foregroundAction?.kind, "delay");

  const observed = observePlayerRuntimeTime(session, 1_000);
  assert.equal(observed.outcome.kind, "observed");
  session = observed.session;
  const timeWrite = pendingPlayerRuntimeStorageWrite(session.snapshot);
  assert.ok(timeWrite);
  assert.deepEqual({ key: timeWrite.key, value: timeWrite.value }, { key: "observed", value: 3 });
  assert.equal(session.snapshot.status, "waiting");
  assert.deepEqual(session.snapshot.scriptStorage, [{ key: "answered", value: 2 }]);
  session = completePlayerRuntimeStorageWrite(session, timeWrite.actionId, true).session;

  const deletion = pendingPlayerRuntimeStorageWrite(session.snapshot);
  assert.ok(deletion);
  assert.deepEqual({ key: deletion.key, value: deletion.value }, { key: "answered", value: null });
  assert.deepEqual(session.snapshot.scriptStorage, [
    { key: "answered", value: 2 },
    { key: "observed", value: 3 },
  ]);
  session = completePlayerRuntimeStorageWrite(session, deletion.actionId, true).session;
  assert.equal(session.snapshot.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(session.snapshot), null);
  assert.deepEqual(session.snapshot.scriptStorage, [{ key: "observed", value: 3 }]);
  assert.equal(session.transcriptEntries.at(-1)?.text, "deleted");
});
