import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleDebugExport,
  chooseDebugCategory,
  chooseDebugPhoto,
  debugPhotoUses,
  NO_PERSONAL_CONTENT,
  type DebugExportCandidate,
  type DebugExportChoices,
} from "../player/debug-export-assembly.js";
import { debugExportFile, parseDebugExport, replayDebugExport } from "../player/debug-export.js";
import { DebugRecorder } from "../player/debug-recorder.js";
import {
  answerPlayerRuntimeImage,
  createPlayerRuntimeSession,
  submitPlayerRuntimeComposer,
  type PlayerRuntimeSession,
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
  assert.equal(session.snapshot.status, "failed");
  return { session, recorder };
}

function candidate(
  session: PlayerRuntimeSession,
  recorder: DebugRecorder,
  read: () => Promise<Uint8Array<ArrayBuffer> | null> = async () => photoBytes,
): DebugExportCandidate {
  const recording = recorder.recording();
  const uses = debugPhotoUses(recording, session.snapshot.scriptStorage);
  return {
    build: { commit: "abc", dirty: false, mode: "production", appVersion: "0.0.0" },
    package: { id: "development-package:test", version: null },
    session: {
      plan: session.plan,
      snapshot: session.snapshot,
      events: session.events,
      transcriptEntries: session.transcriptEntries,
    },
    recording,
    hostError: null,
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
  assert.equal(exported.checkpoint, null);
  assert.equal(exported.replay, null);
  assert.deepEqual(exported.photos, []);
  assert.deepEqual(Object.keys(exported.sections), ["eventsTail"]);
  const tail = exported.sections["eventsTail"];
  assert.ok(
    Array.isArray(tail) && tail.every((event) => Object.keys(event).join() === "sequence,kind"),
  );
  assert.equal(exported.incident.kind, "runtimeFailure");
  assert.equal(exported.incident.code, session.snapshot.failure?.code);
  assert.equal(exported.incident.line, 7);
  assert.deepEqual(
    parts.map((part) => part.name),
    ["Technical report"],
  );
  // The file is a valid export.
  assert.equal(parseDebugExport(text).selection.replay, false);
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
  assert.ok(
    result.kind === "reproduced" && result.failure?.code === session.snapshot.failure?.code,
  );
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
