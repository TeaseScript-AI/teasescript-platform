import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleDebugExport,
  chooseDebugCategory,
  chooseDebugPhoto,
  debugPhotoUses,
  NO_PERSONAL_CONTENT,
  type DebugCategory,
  type DebugExportCandidate,
  type DebugExportChoices,
} from "../player/debug-export-assembly.js";
import { debugExportFile, parseDebugExport, replayDebugExport } from "../player/debug-export.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import {
  activePlayerRuntimeLock,
  answerPlayerRuntimeLock,
  activatePlayerRuntimeButton,
  advancePlayerRuntimeTime,
  answeredByPlayerInput,
  answerPlayerRuntimeImage,
  applyPlayerRuntimeStorageEdit,
  beginPlayerRuntimeRecording,
  completePlayerRuntimeStorageWrite,
  createPlayerRuntimeSession,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
  playerRuntimeSnapshotJson,
  restorePlayerRuntimeSessionAt,
  selectPlayerRuntimeChoice,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";

const reference = "captured-media:11111111-1111-4111-8111-111111111111:1";
const photoBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const SECRET = "marker-only-in-personal-content";

/** A session that saves an answer and a photo, says them, and fails dividing by zero. */
function failedSession(answer = SECRET): {
  session: PlayerRuntimeSession;
  recorder: DebugRecorder;
} {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    [
      'let name = askText "Name"',
      'save name as "name"',
      'let picture = askImage("Picture", allowCamera: false)',
      'save picture as "picture"',
      'say "Hello ${name}"',
      "let zero = 0",
      "let result = 1 / zero",
      "exit",
    ].join("\n"),
    { recorder },
  );
  session = answeredByPlayerInput(session, "send", () =>
    submitPlayerRuntimeComposer(session, answer),
  )!.session;
  session = answerPlayerRuntimeImage(session, reference, {
    holds: (asked) => asked === reference,
  })!.session;
  // The greeting is read before the division fails.
  session = advancePlayerRuntimeTime(session, 60_000);
  assert.equal(session.state.status, "failed");
  return { session, recorder };
}

function candidate(
  session: PlayerRuntimeSession,
  recorder: DebugRecorder,
  read: () => Promise<Uint8Array<ArrayBuffer> | null> = async () => photoBytes,
): DebugExportCandidate {
  const frozen: Omit<DebugExportCandidate, "photos"> = {
    build: { commit: "abc", dirty: false, mode: "production", appVersion: "0.0.0" },
    package: { id: "development-package:test", version: null },
    session: {
      plan: session.plan,
      snapshot: playerRuntimeSnapshot(session),
      events: session.events,
      transcriptEntries: session.transcriptEntries,
    },
    recording: recorder.recording(),
    hostError: null,
    editedWhileDebugging: null,
    rewoundWhileDebugging: null,
    player: { viewportWidth: 390, userAgent: "Test Browser" },
    host: {
      stage: { status: "unresolved", path: "images/missing-room.png" },
      media: [
        { mediaId: 1, media: "audio", loaded: true, state: "running", source: "sounds/theme.mp3" },
      ],
      notices: [
        {
          key: "unusable-media:sounds/gone.mp3",
          level: "warning",
          message: "Audio not found: sounds/gone.mp3",
        },
        { key: "audio-blocked", level: "warning", message: "The browser blocked audio." },
      ],
      debugLog: ["Skipped the wait at main.tease:3"],
    },
  };
  return {
    ...frozen,
    photos: [...debugPhotoUses(frozen)].map(([photo, usedBy]) => ({
      reference: photo,
      mimeType: "image/png",
      byteLength: photoBytes.length,
      width: 2,
      height: 1,
      usedBy,
      read,
    })),
  };
}

/** The photos a candidate offers, with their uses. */
function offered(frozen: DebugExportCandidate) {
  return frozen.photos.map((photo) => [photo.reference, photo.usedBy] as const);
}

/** A media store that holds `stored` only. */
function admits(stored: string) {
  return { holds: (asked: string) => asked === stored };
}

/** `session` as Continue goes on with it after a reload: restored from its state and events, recording from there. */
function continued(session: PlayerRuntimeSession): {
  session: PlayerRuntimeSession;
  recorder: DebugRecorder;
} {
  const recorder = new DebugRecorder();
  const restored = restorePlayerRuntimeSessionAt(
    session.plan,
    playerRuntimeSnapshotJson(session),
    session.events,
    recorder,
  );
  beginPlayerRuntimeRecording(restored, recorder);
  return { session: restored, recorder };
}

/** The file with every category and `photos` chosen, read back; it replays. */
async function exportedWith(frozen: DebugExportCandidate, photos: readonly string[]) {
  let choices = all(frozen);
  for (const photo of photos) choices = chooseDebugPhoto(choices, photo, true);
  const read = parseDebugExport(
    await fileText((await assembleDebugExport(frozen, choices)).exported),
  );
  assert.equal(replayDebugExport(read).kind, "reproduced");
  return read;
}

async function fileText(exported: Parameters<typeof debugExportFile>[0]): Promise<string> {
  return (await debugExportFile(exported, false)).text();
}

function all(frozen: DebugExportCandidate): DebugExportChoices {
  let choices = NO_PERSONAL_CONTENT;
  for (const category of [
    "savedValues",
    "answers",
    "sessionText",
    "replay",
    "photos",
    "player",
  ] as const)
    choices = chooseDebugCategory(choices, frozen, category, true);
  return choices;
}

test("by default an export holds the technical report and no personal content", async () => {
  const { session, recorder } = failedSession();
  const { exported, parts } = await assembleDebugExport(
    candidate(session, recorder),
    NO_PERSONAL_CONTENT,
  );
  const text = await fileText(exported);
  assert.ok(!text.includes(SECRET), "no answer, saved value, or message text");
  assert.ok(!text.includes(reference), "no photo reference");
  assert.ok(!text.includes("Test Browser"), "no browser details");
  for (const scriptText of ["missing-room", "theme.mp3", "gone.mp3", "Skipped the wait"])
    assert.ok(!text.includes(scriptText), `no ${scriptText}`);
  assert.equal(exported.checkpoint, null);
  assert.equal(exported.replay, null);
  assert.deepEqual(exported.photos, []);
  assert.deepEqual(Object.keys(exported.sections), ["eventsTail", "media", "errors"]);
  // What the Player observed is in the technical report as states and kinds.
  assert.deepEqual(exported.sections["media"], {
    stage: { status: "unresolved" },
    media: [{ mediaId: 1, media: "audio", loaded: true, state: "running" }],
  });
  assert.deepEqual(exported.sections["errors"], [
    { kind: "unusable-media", level: "warning" },
    { kind: "audio-blocked", level: "warning" },
  ]);
  const tail = exported.sections["eventsTail"];
  assert.ok(
    Array.isArray(tail) && tail.every((event) => Object.keys(event).join() === "sequence,kind"),
  );
  assert.equal(exported.incident.kind, "runtimeFailure");
  assert.equal(exported.incident.code, session.state.failure?.code);
  assert.equal(exported.incident.line, 7);
  assert.deepEqual(
    parts.map((part) => part.name),
    ["Technical report"],
  );
  // The file is a valid export.
  assert.equal(parseDebugExport(text).selection.replay, false);
});

test("a session Debug's storage editor changed or its rewind restored is marked in the export, without personal content", async () => {
  const { session, recorder } = failedSession();
  const editedWhileDebugging = { firstEditSceneTimeMs: 123.5, editCount: 2 };
  const rewoundWhileDebugging = { restoredSceneTimeMs: 40.5, rewindCount: 1 };
  const { exported } = await assembleDebugExport(
    { ...candidate(session, recorder), editedWhileDebugging, rewoundWhileDebugging },
    NO_PERSONAL_CONTENT,
  );
  const parsed = parseDebugExport(await fileText(exported));
  assert.deepEqual(parsed.editedWhileDebugging, editedWhileDebugging);
  assert.deepEqual(parsed.rewoundWhileDebugging, rewoundWhileDebugging);
});

test("replay data needs its prerequisites, and turning one off turns it off", () => {
  const { session, recorder } = failedSession();
  const frozen = candidate(session, recorder);
  let choices = chooseDebugCategory(NO_PERSONAL_CONTENT, frozen, "replay", true);
  assert.equal(choices.replay, false, "not without saved values, answers, and session text");
  for (const prerequisite of ["savedValues", "answers", "sessionText"] as const)
    choices = chooseDebugCategory(choices, frozen, prerequisite, true);
  choices = chooseDebugCategory(choices, frozen, "replay", true);
  assert.equal(choices.replay, true);
  assert.equal(chooseDebugCategory(choices, frozen, "answers", false).replay, false);
  // Photos start with the ones a recorded call used; each can be left out.
  const withPhotos = chooseDebugCategory(choices, frozen, "photos", true);
  assert.deepEqual([...withPhotos.photoReferences], [reference]);
  assert.deepEqual([...chooseDebugPhoto(withPhotos, reference, false).photoReferences], []);
  assert.deepEqual(
    [...chooseDebugCategory(withPhotos, frozen, "photos", false).photoReferences],
    [],
  );
});

test("a saved photo only the replay's state holds is offered too, and a saved photo counts once", () => {
  const recorder = new DebugRecorder();
  // Saved under two keys when the recording begins, the photo is deleted before the state shown.
  const session = createPlayerRuntimeSession(
    'delete "picture"\ndelete "copy"\nshowButton "Done"\nexit',
    {
      recorder,
      scriptStorage: [
        { key: "picture", value: reference },
        { key: "copy", value: reference },
      ],
    },
  );
  assert.deepEqual(playerRuntimeSnapshot(session).scriptStorage, []);
  assert.deepEqual(offered(candidate(session, recorder)), [
    [reference, [{ relation: "savedValue", operation: null, actionId: null }]],
  ]);
});

test("a photo the replay's state holds without a recorded use is offered without one, and the file restores it", async () => {
  // Answered before a reload, the photo is in a variable and on the Stage of the state the replay starts from.
  let session = createPlayerRuntimeSession(
    'let picture = askImage("Picture")\nshowImage picture\nshowButton "First"\nexit',
  );
  session = answerPlayerRuntimeImage(session, reference, admits(reference))!.session;
  const reloaded = continued(session);
  const frozen = candidate(reloaded.session, reloaded.recorder);
  assert.deepEqual(offered(frozen), [[reference, []]]);
  // Photos on starts with the photos a recorded call used; the player can add this one.
  assert.deepEqual([...all(frozen).photoReferences], []);
  const read = await exportedWith(frozen, [reference]);
  assert.equal(read.checkpoint?.snapshot.stageImage, reference);
  assert.deepEqual(
    read.photos.map((photo) => [photo.reference, photo.data, photo.usedBy]),
    [[reference, photoBytes, []]],
  );
});

test("the photos are found in the export's states as they are, so a state too long to write as one text still opens", (context) => {
  let session = createPlayerRuntimeSession(
    'let picture = askImage("Picture")\nshowButton "First"\nexit',
  );
  session = answerPlayerRuntimeImage(session, reference, admits(reference))!.session;
  const reloaded = continued(session);
  const frozen = candidate(reloaded.session, reloaded.recorder);
  // As V8 refuses a text longer than it can hold, which a valid state of large texts can need.
  context.mock.method(JSON, "stringify", () => {
    throw new RangeError("Invalid string length");
  });
  assert.deepEqual(new Map(debugPhotoUses(frozen)), new Map([[reference, []]]));
});

test("a photo only an event or a call the export carries holds is offered, and the file carries it", async () => {
  const edited = "captured-media:22222222-2222-4222-8222-222222222222:1";
  // The answer's variable is gone, and a later button settled, before a reload.
  let session = createPlayerRuntimeSession(
    'if true {\n    let picture = askImage("Picture")\n}\nshowButton "First"\nshowButton "Second"\ndelete "edited"\nshowButton "Third"\nexit',
  );
  session = answerPlayerRuntimeImage(session, reference, admits(reference))!.session;
  session = activatePlayerRuntimeButton(session)!.session;
  const reloaded = continued(session);
  // After it, Debug's storage editor saves a photo, which the script deletes again.
  session = applyPlayerRuntimeStorageEdit(reloaded.session, {
    key: "edited",
    value: edited,
  }).session;
  session = activatePlayerRuntimeButton(session)!.session;
  assert.deepEqual(playerRuntimeSnapshot(session).scriptStorage, []);
  const frozen = candidate(session, reloaded.recorder);
  assert.deepEqual(
    new Map(offered(frozen)),
    new Map([
      [reference, []],
      [edited, []],
    ]),
  );
  const read = await exportedWith(frozen, [reference, edited]);
  assert.deepEqual(
    new Map(read.photos.map((photo) => [photo.reference, photo.data])),
    new Map([
      [reference, photoBytes],
      [edited, photoBytes],
    ]),
  );
});

test("a photo only a message of the export holds is offered, and one only older events hold is not", async () => {
  // Said as text, then updated messages push the say out of the events the export keeps; the message stays.
  let session = createPlayerRuntimeSession(
    'if true {\n    let picture = askImage("Picture")\n    say "Kept ${picture}", instant\n}\nlet counter = say "Turn 0", instant\nfor turn in 1..=300 {\n    counter.text = "Turn ${turn}"\n}\nshowButton "Next"\nshowButton "Done"\nexit',
  );
  session = answerPlayerRuntimeImage(session, reference, admits(reference))!.session;
  session = activatePlayerRuntimeButton(session)!.session;
  const reloaded = continued(session);
  const frozen = candidate(reloaded.session, reloaded.recorder);
  assert.deepEqual(offered(frozen), [[reference, []]]);
  const read = await exportedWith(frozen, [reference]);
  assert.ok(JSON.stringify(read.sections["transcriptTail"]).includes(reference));
  assert.deepEqual(
    read.photos.map((photo) => [photo.reference, photo.data]),
    [[reference, photoBytes]],
  );

  // An answer more events ago than the export keeps, with a button settled since, is in none of its parts.
  const old = "captured-media:33333333-3333-4333-8333-333333333333:1";
  let long = createPlayerRuntimeSession(
    'if true {\n    let picture = askImage("Picture")\n}\nfor turn in 1..=300 {\n    say "Turn ${turn}", instant\n}\nshowButton "Next"\nshowButton "Done"\nexit',
  );
  long = answerPlayerRuntimeImage(long, old, admits(old))!.session;
  long = activatePlayerRuntimeButton(long)!.session;
  const later = continued(long);
  assert.ok(JSON.stringify(later.session.events).includes(old));
  assert.deepEqual(offered(candidate(later.session, later.recorder)), []);
});

test("with everything chosen, the export replays the failure and carries the photo and its use", async () => {
  const { session, recorder } = failedSession();
  const frozen = candidate(session, recorder);
  const { exported, parts } = await assembleDebugExport(frozen, all(frozen));
  const read = parseDebugExport(await fileText(exported));
  const result = replayDebugExport(read);
  assert.ok(result.kind === "reproduced" && result.failure?.code === session.state.failure?.code);
  assert.equal(read.photos.length, 1);
  assert.deepEqual(read.photos[0]?.data, photoBytes);
  assert.deepEqual(
    read.photos[0]?.usedBy.map((use) => use.relation),
    ["imageAnswer", "savedValue"],
  );
  assert.ok(JSON.stringify(read.sections["answers"]).includes(SECRET));
  // How each answer was given, where the Player knows it.
  const answers = read.sections["answers"];
  assert.ok(Array.isArray(answers));
  assert.deepEqual(
    answers.map((answer: { input?: unknown }) => answer.input),
    ["send", null],
  );
  assert.ok(JSON.stringify(read.sections["transcriptTail"]).includes(`Hello ${SECRET}`));
  assert.equal(read.sections["player"] !== undefined, true);
  assert.deepEqual(
    parts.map((part) => part.name),
    [
      "Technical report",
      "Session text",
      "Debug log",
      "Saved script values",
      "Submitted answers",
      "Player and browser details",
      "Engine replay data",
      "Photos",
    ],
  );
  assert.match(read.package.contentHash ?? "", /^[0-9a-f]{64}$/u);

  // A photo whose bytes cannot be read is listed without them, and the export says so.
  const unreadable = await assembleDebugExport(
    candidate(session, recorder, async () => null),
    all(frozen),
  );
  assert.equal(unreadable.exported.photos[0]?.data, null);
  assert.ok(unreadable.exported.omissions.some((omission) => omission.includes(reference)));
});

test("credential- and path-like text is removed from readable sections, and replay data containing it is left out", async () => {
  const { session, recorder } = failedSession(
    "/home/player/notes.txt ghp_abcdefghijklmnopqrstuvwx",
  );
  const frozen = candidate(session, recorder);
  const { exported } = await assembleDebugExport(frozen, all(frozen));
  const text = await fileText(exported);
  assert.ok(!text.includes("/home/player"), "no path");
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwx"), "no token");
  assert.equal(exported.checkpoint, null);
  assert.equal(exported.replay, null);
  assert.ok(
    exported.omissions.some((omission) => /looks like a credential or a file path/.test(omission)),
  );
  assert.ok(JSON.stringify(exported.sections["answers"]).includes("[removed]"));
});

test("a state that cannot be checkpointed is exported as the last good state, which replays", async () => {
  const recorder = new DebugRecorder();
  const session = createPlayerRuntimeSession('let name = askText "Name"\nexit', { recorder });
  const recording = recorder.recording()!;
  const frozen: DebugExportCandidate = {
    ...candidate(session, recorder),
    // A Player defect left a state the engine's validation refuses.
    recording: { ...recording, endSnapshot: { ...recording.endSnapshot, nextInstruction: -1 } },
    hostError: "TypeError",
  };
  const { exported } = await assembleDebugExport(frozen, all(frozen));
  assert.equal(exported.checkpointRole, "lastGood");
  assert.equal(exported.incident.kind, "hostError");
  assert.equal(replayDebugExport(parseDebugExport(await fileText(exported))).kind, "reproduced");
});

test("session text shows what the player saw; values that were never said need their own categories", async () => {
  const hidden = "private-value-never-said";
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    [
      'let secret = load("private", default: "")',
      'let pick = askChoice [{ text: "Pick", value: secret }]',
      'let typed = askText("Name", prefill: secret)',
      'save "kept" as secret',
      'say "Done"',
      "exit",
    ].join("\n"),
    { recorder, persistentScriptStorage: true, scriptStorage: [{ key: "private", value: hidden }] },
  );
  const choices = playerRuntimeForeground(session);
  if (choices?.kind !== "choose") throw new Error("Expected choices");
  session = selectPlayerRuntimeChoice(session, choices.options[0]!.id)!.session;
  session = submitPlayerRuntimeComposer(session, "Typed by the player")!.session;
  session = completePlayerRuntimeStorageWrite(
    session,
    pendingPlayerRuntimeStorageWrite(session.state)!.actionId,
    true,
  ).session;
  session = advancePlayerRuntimeTime(session, 60_000);
  assert.equal(session.state.status, "halted");
  const frozen = candidate(session, recorder);
  const exported = async (categories: readonly DebugCategory[]) => {
    let chosen = NO_PERSONAL_CONTENT;
    for (const category of categories) chosen = chooseDebugCategory(chosen, frozen, category, true);
    const result = (await assembleDebugExport(frozen, chosen)).exported;
    return { file: await fileText(result), events: JSON.stringify(result.sections["eventsTail"]) };
  };
  // The choice's value, the default, and the storage key all hold the value; none of them was said.
  const textOnly = await exported(["sessionText"]);
  assert.ok(!textOnly.file.includes(hidden), "the whole file");
  assert.ok(textOnly.events.includes("Typed by the player") && textOnly.events.includes("Done"));
  for (const categories of [
    ["sessionText", "savedValues"],
    ["sessionText", "answers"],
  ] as const)
    assert.ok(!(await exported(categories)).events.includes(hidden), categories.join(", "));
  assert.ok((await exported(["sessionText", "savedValues", "answers"])).events.includes(hidden));
});

test("a lock's text and password never show in readable sections, and its steps replay without the network or a password", async () => {
  const text = "private-note-only-in-the-lock";
  const password = "corner-password-only-in-the-script";
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    [
      `let locked = encryptText("${text}", password: "${password}", timeLock: false)`,
      'let opened = decryptText(locked, default: "closed")',
      'say "Done"',
      "exit",
    ].join("\n"),
    { recorder, wallClockMs: Date.UTC(2026, 9, 14) },
  );
  // The lock, the unlock dialog that the player answers, and the opening, as the Player answers them.
  for (const answer of [
    { kind: "locked", text: "VFNMSwEBAgAA" },
    { kind: "ask" },
    { kind: "submitted" },
    { kind: "opened", text },
  ] as const) {
    const action = activePlayerRuntimeLock(session.state);
    assert.ok(action, answer.kind);
    session = answerPlayerRuntimeLock(session, action.actionId, answer).session;
  }
  session = advancePlayerRuntimeTime(session, 60_000);
  assert.equal(session.state.status, "halted");
  const frozen = candidate(session, recorder);
  const read = await exportedWith(frozen, []);
  const readable = JSON.stringify(read.sections);
  assert.ok(readable.includes("encryptText") && readable.includes("decryptText"));
  assert.ok(!readable.includes(text) && !readable.includes(password));
});

test("credentials and rooted paths are removed from every readable section, and replay data with one is left out", async () => {
  const recorder = new DebugRecorder();
  const session = createPlayerRuntimeSession('let name = askText "Name"\nexit', {
    recorder,
    scriptStorage: [{ key: "notes", value: "/srv/private/notes.txt" }],
  });
  const frozen: DebugExportCandidate = {
    ...candidate(session, recorder),
    player: { userAgent: "ReviewBrowser ghp_abcdefghijklmnopqrstuvwx /data/private/agent" },
  };
  const { exported } = await assembleDebugExport(frozen, all(frozen));
  const text = await fileText(exported);
  for (const removed of ["ghp_abcdefghijklmnopqrstuvwx", "/data/private", "/srv/private"])
    assert.ok(!text.includes(removed), removed);
  assert.equal(exported.replay, null);
  assert.match(JSON.stringify(exported.sections["player"]), /ReviewBrowser +\[removed\]/u);
});

test("replay data is judged by its actual text: escaped whitespace hides nothing, and a URL is no file path", async () => {
  const exportOf = async (saved: string) => {
    const recorder = new DebugRecorder();
    const session = createPlayerRuntimeSession('let name = askText "Name"\nexit', {
      recorder,
      scriptStorage: [{ key: "value", value: saved }],
    });
    const frozen = candidate(session, recorder);
    return (await assembleDebugExport(frozen, all(frozen))).exported;
  };
  for (const saved of [
    "prefix\nghp_abcdefghijklmnopqrstuvwx",
    "prefix\tghp_abcdefghijklmnopqrstuvwx",
    "prefix\n/srv/private/notes.txt",
    "\t/srv/private/notes.txt",
    "file:///home/player/notes.txt",
    "https://example.com/?key=ghp_abcdefghijklmnopqrstuvwx",
    // Each kind of rooted path, also right after a URL.
    "C:\\private\\notes.txt",
    "C:/private/notes.txt",
    "\\\\server\\share\\private.txt",
    "//server/share/private.txt",
    "https://example.com/a/b C:/private/notes.txt",
    "https://example.com/a/b \\\\server\\share\\private.txt",
    "https://example.com/a/b /srv/private/notes.txt",
    "https://example.com/a/b //server/share/private.txt",
    "\\server\\share\\private.txt",
  ]) {
    const exported = await exportOf(saved);
    assert.equal(exported.checkpoint, null, JSON.stringify(saved));
    const text = await fileText(exported);
    for (const part of [
      "ghp_abcdefghijklmnopqrstuvwx",
      "/srv/private",
      "/home/player",
      "private/notes",
      "private\\\\notes",
      "share",
    ])
      assert.ok(!text.includes(part), `${JSON.stringify(saved)} keeps ${part}`);
  }
  for (const saved of [
    "https://example.com/render?file=/album/photo.jpg",
    "See https://example.com/a/b/c.png (the cover)",
    "images/room.png",
  ]) {
    const exported = await exportOf(saved);
    assert.notEqual(exported.checkpoint, null, saved);
    assert.equal(replayDebugExport(parseDebugExport(await fileText(exported))).kind, "reproduced");
    assert.ok(
      JSON.stringify(exported.sections["storage"]).includes(JSON.stringify(saved).slice(1, -1)),
    );
  }
});

test("a recording that stopped early still reports the actual failure, and its incomplete replay says why", async () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'let name = askText "Name"\nlet zero = 0\nlet result = 1 / zero\nexit',
    { recorder },
  );
  // A value the engine refuses, which leaves the recording incomplete.
  session = applyPlayerRuntimeStorageEdit(session, { key: "k", value: Number.NaN }).session;
  session = submitPlayerRuntimeComposer(session, "Ada")!.session;
  assert.equal(session.state.status, "failed");
  const frozen = candidate(session, recorder);
  const byDefault = await assembleDebugExport(frozen, NO_PERSONAL_CONTENT);
  assert.equal(byDefault.exported.incident.kind, "runtimeFailure");
  assert.equal(byDefault.exported.incident.code, session.state.failure?.code);
  const { exported } = await assembleDebugExport(frozen, all(frozen));
  assert.equal(exported.checkpoint?.snapshot.status, "failed");
  assert.equal(exported.replay?.complete, false);
  const replayed = replayDebugExport(parseDebugExport(await fileText(exported)));
  assert.deepEqual(replayed, {
    kind: "incomplete",
    reason: "A call's arguments could not be copied exactly.",
  });
});

test("a wide list a script saved is checked and replays", async () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    'let many = []\nrepeat 150000 { many.add(0) }\nsave many as "wide"\nexit',
    { recorder, persistentScriptStorage: true, scriptStorage: [] },
  );
  session = completePlayerRuntimeStorageWrite(
    session,
    pendingPlayerRuntimeStorageWrite(session.state)!.actionId,
    true,
  ).session;
  assert.equal(session.state.status, "halted");
  const frozen = candidate(session, recorder);
  const { exported } = await assembleDebugExport(frozen, all(frozen));
  assert.notEqual(exported.checkpoint, null);
  assert.equal(replayDebugExport(parseDebugExport(await fileText(exported))).kind, "reproduced");
});

test("a network path the script says, as message markup shows it, is removed from session text", async () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession('let name = askText "Name"\nsay "${name}"\nexit', {
    recorder,
  });
  session = submitPlayerRuntimeComposer(
    session,
    "\\\\server\\share\\marker-in-a-path.txt",
  )!.session;
  const said = session.transcriptEntries.at(-1);
  assert.equal(
    said?.kind === "message" ? said.text : null,
    "\\server\\share\\marker-in-a-path.txt",
  );
  const frozen = candidate(session, recorder);
  const choices = chooseDebugCategory(NO_PERSONAL_CONTENT, frozen, "sessionText", true);
  const text = await fileText((await assembleDebugExport(frozen, choices)).exported);
  assert.ok(!text.includes("marker-in-a-path"), "the path is in the file");
});

test("session text adds the Stage path, media sources, notice messages, and the Debug log", async () => {
  const { session, recorder } = failedSession();
  const frozen = candidate(session, recorder);
  const choices = chooseDebugCategory(NO_PERSONAL_CONTENT, frozen, "sessionText", true);
  const { exported, parts } = await assembleDebugExport(frozen, choices);
  assert.deepEqual(exported.sections["media"], {
    stage: frozen.host.stage,
    media: frozen.host.media,
  });
  assert.deepEqual(exported.sections["errors"], frozen.host.notices);
  assert.deepEqual(exported.sections["debugLog"], frozen.host.debugLog);
  assert.ok(parts.some((part) => part.name === "Debug log"));
  // Without the Debug menu there is no Debug log, and the export does not pretend one.
  const withoutLog = await assembleDebugExport(
    { ...frozen, host: { ...frozen.host, debugLog: null } },
    choices,
  );
  assert.equal(withoutLog.exported.sections["debugLog"], undefined);
});

test("a changed message's text is session text, the chat tail shows its current text, and its replay reproduces", async () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    ['let line = say "Waiting", instant', "wait 1 s", `line.text = "${SECRET}"`, "exit"].join("\n"),
    { recorder },
  );
  session = advancePlayerRuntimeTime(session, 60_000);
  assert.equal(session.state.status, "halted");
  const frozen = candidate(session, recorder);
  const withoutText = (await assembleDebugExport(frozen, NO_PERSONAL_CONTENT)).exported;
  assert.ok(!(await fileText(withoutText)).includes(SECRET));
  assert.ok(JSON.stringify(withoutText.sections["eventsTail"]).includes('"messageUpdated"'));

  const everything = (await assembleDebugExport(frozen, all(frozen))).exported;
  assert.deepEqual(everything.sections["transcriptTail"], [{ speaker: "narrator", text: SECRET }]);
  const events = JSON.stringify(everything.sections["eventsTail"]);
  assert.ok(events.includes('"kind":"messageUpdated"') && events.includes(SECRET));
  assert.equal(replayDebugExport(parseDebugExport(await fileText(everything))).kind, "reproduced");
});

test("a removed message leaves the chat tail, its removal is session text, and its replay reproduces", async () => {
  const recorder = new DebugRecorder();
  let session = createPlayerRuntimeSession(
    [
      'let line = say "Waiting", instant',
      'say "Kept", instant',
      "wait 1 s",
      "line.remove()",
      "wait 1 s",
      "exit",
    ].join("\n"),
    { recorder },
  );
  session = advancePlayerRuntimeTime(session, 60_000);
  assert.equal(session.state.status, "halted");
  const frozen = candidate(session, recorder);
  const everything = (await assembleDebugExport(frozen, all(frozen))).exported;
  assert.deepEqual(everything.sections["transcriptTail"], [{ speaker: "narrator", text: "Kept" }]);
  assert.ok(JSON.stringify(everything.sections["eventsTail"]).includes('"kind":"messageRemoved"'));
  assert.equal(replayDebugExport(parseDebugExport(await fileText(everything))).kind, "reproduced");
});
