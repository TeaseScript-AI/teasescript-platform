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
  advancePlayerRuntimeTime,
  answerPlayerRuntimeImage,
  applyPlayerRuntimeStorageEdit,
  completePlayerRuntimeStorageWrite,
  createPlayerRuntimeSession,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeForeground,
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
  session = submitPlayerRuntimeComposer(session, answer)!.session;
  session = answerPlayerRuntimeImage(session, reference, {
    holds: (asked) => asked === reference,
  })!.session;
  assert.equal(session.state.status, "failed");
  return { session, recorder };
}

function candidate(
  session: PlayerRuntimeSession,
  recorder: DebugRecorder,
  read: () => Promise<Uint8Array<ArrayBuffer> | null> = async () => photoBytes,
): DebugExportCandidate {
  const recording = recorder.recording();
  const uses = debugPhotoUses(recording, playerRuntimeSnapshot(session).scriptStorage);
  return {
    build: { commit: "abc", dirty: false, mode: "production", appVersion: "0.0.0" },
    package: { id: "development-package:test", version: null },
    session: {
      plan: session.plan,
      snapshot: playerRuntimeSnapshot(session),
      events: session.events,
      transcriptEntries: session.transcriptEntries,
    },
    recording,
    hostError: null,
    editedWhileDebugging: null,
    rewoundWhileDebugging: null,
    photos: [...uses].map(([photo, usedBy]) => ({
      reference: photo,
      mimeType: "image/png",
      byteLength: photoBytes.length,
      width: 2,
      height: 1,
      usedBy,
      read,
    })),
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
      'let pick = choose [{ text: "Pick", value: secret }]',
      'let typed = askText("Name", default: secret)',
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
    "https://example.com/a/b C:/private/notes.txt",
    "https://example.com/a/b \\\\server\\share\\private.txt",
    "https://example.com/a/b /srv/private/notes.txt",
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
