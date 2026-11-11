// The scenarios of L5h.3b's export equivalence family (L5h's HEAD 0, family 5), as plain JavaScript over an `api` of the
// Player's modules, so that the same scenarios run on the base's assembler (`generate.mjs`, which writes the fixture) and
// on the head's (`tests/player/player-debug-export-equivalence.test.ts`). Each scenario makes a session, its recording and the
// photo reads, and names its choices; the side's adapter turns them into its candidate.

const PHOTO = "captured-media:11111111-1111-4111-8111-111111111111:1";
const PHOTO_BYTES = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
const SECRET = "marker-only-in-personal-content";
/** The witness's script, which `player-debug-export-worker.test.ts` runs in a Worker. */
export const WITNESS =
  'let name = askText "Name?"\nsave name as "name"\nsay "Hi ${name}", instant\nexit';
const ALL = ["savedValues", "answers", "sessionText", "replay", "photos", "player"];
const FAILING = [
  'let name = askText "Name"',
  'save name as "name"',
  'let picture = askImage("Picture", allowCamera: false)',
  'save picture as "picture"',
  'say "Hello ${name}"',
  "let zero = dynamic(0)",
  "let result = 1 / zero",
  "exit",
  "function dynamic(value) {",
  "    return value",
  "}",
].join("\n");

/** A session that saves an answer and a photo, says them, and fails dividing by zero. */
function failed(api, answer = SECRET, recorder = new api.DebugRecorder()) {
  let session = api.createPlayerRuntimeSession(FAILING, { recorder });
  session = api.answeredByPlayerInput(session, "send", () =>
    api.submitPlayerRuntimeComposer(session, answer),
  ).session;
  session = api.answerPlayerRuntimeImage(session, PHOTO, {
    holds: (asked) => asked === PHOTO,
  }).session;
  session = api.advancePlayerRuntimeTime(session, 60_000);
  return { session, recorder };
}

/** `script` started with its scope IDs used up but `spare`, so that a call throws in the middle of its run. */
function scopesUsedUp(api, script, spare, recorder) {
  const started = api.createPlayerRuntimeSession(script);
  const snapshot = {
    ...api.playerRuntimeSnapshot(started),
    nextScopeId: Number.MAX_SAFE_INTEGER - spare,
  };
  return api.restorePlayerRuntimeSessionAt(
    started.plan,
    JSON.stringify(snapshot),
    started.events,
    recorder,
  );
}

/** While `body` runs, a list of more than 1,000 elements cannot be enumerated, as a huge one cannot in V8. */
function withUnenumerableLists(body) {
  const ownKeys = Reflect.ownKeys;
  Reflect.ownKeys = (target) => {
    if (Array.isArray(target) && target.length > 1_000)
      throw new RangeError("Too many properties to enumerate");
    return ownKeys(target);
  };
  try {
    return body();
  } finally {
    Reflect.ownKeys = ownKeys;
  }
}

/**
 * What a scenario made: the session (`null` for none) with its state as an export takes it, taken now (`null` when it
 * cannot be exported), its recording, how its photo reads go, the Player error, and the rewound mark.
 */
function made(api, session, recording, photoRead, hostError, rewound = null) {
  const snapshot = session === null ? null : api.playerRuntimeSnapshotOrNull(session);
  return { session, snapshot, recording, photoRead, hostError, rewound };
}

/**
 * The scenarios: each `make(api)` gives what it made (`made`), and
 * `choices` names the categories turned on, in order; `repeat` prepares the same candidate again.
 */
export const SCENARIOS = [
  {
    // #1966's witness (`player-debug-export-worker.test.ts`) makes this session in a Worker and compares its file here.
    name: "witness: a recorded answer, with replay",
    choices: ["savedValues", "answers", "sessionText", "replay"],
    make: (api) => {
      const recorder = new api.DebugRecorder();
      // As the witness's Start: its wall clock at 0.
      const asking = api.createPlayerRuntimeSession(WITNESS, { recorder, wallClockMs: 0 });
      const session = api.submitPlayerRuntimeComposer(asking, "Ann").session;
      return made(api, session, recorder.recording(), "none", null);
    },
  },
  ...[[], ["savedValues"], ["answers"], ["sessionText"], ["photos"], ["player"], ALL].map(
    (choices) => ({
      name: `selection ${choices.length === 0 ? "none" : choices.length === ALL.length ? "all" : choices[0]}`,
      choices,
      make: (api) => {
        const { session, recorder } = failed(api);
        return made(api, session, recorder.recording(), "ok", null);
      },
    }),
  ),
  {
    // Replay alone is refused until its prerequisites are on: the normalized choices hold none of it.
    name: "selection replay without its prerequisites",
    choices: ["replay"],
    make: (api) => {
      const { session, recorder } = failed(api);
      return made(api, session, recorder.recording(), "ok", null);
    },
  },
  {
    name: "tape end versus the shown state, after continued play",
    choices: ALL,
    make: (api) => {
      const { session, recorder } = failed(api);
      const later = api.observePlayerRuntimeTime(session, 120_000).session;
      return made(api, later, recorder.recording(), "ok", null);
    },
  },
  {
    name: "no session",
    choices: ALL,
    make: (api) => {
      const { recorder } = failed(api);
      return made(api, null, recorder.recording(), "ok", null);
    },
  },
  {
    name: "no recording, with a Player error",
    choices: ALL,
    make: (api) => {
      const { session } = failed(api);
      return made(api, session, null, "ok", "TypeError");
    },
  },
  {
    name: "an unavailable end with its failure",
    choices: ALL,
    make: (api) =>
      withUnenumerableLists(() => {
        const recorder = new api.DebugRecorder();
        const waiting = api.createPlayerRuntimeSession(
          "let xs = (1..=1500).toList()\nwait 1 s\nlet zero = dynamic(0)\nlet result = 1 / zero\nexit\nfunction dynamic(value) {\n    return value\n}",
          { recorder },
        );
        const session = api.advancePlayerRuntimeTime(waiting, 5_000);
        return made(api, session, recorder.recording(), "none", null);
      }),
  },
  {
    name: "an unavailable end without a failure",
    choices: ALL,
    make: (api) =>
      withUnenumerableLists(() => {
        const recorder = new api.DebugRecorder();
        const waiting = api.createPlayerRuntimeSession(
          'let xs = (1..=1500).toList()\nwait 1 s\nlet name = askText "Name"\nexit',
          { recorder },
        );
        const session = api.advancePlayerRuntimeTime(waiting, 5_000);
        return made(api, session, recorder.recording(), "none", null);
      }),
  },
  {
    // The recording up to a Player error, kept while Debug's rewind shows an earlier state of the session.
    name: "the first failure's recording with a rewound state shown",
    choices: ALL,
    make: (api) => {
      const { recorder } = failed(api);
      const atError = recorder.recording();
      let earlier = api.createPlayerRuntimeSession(FAILING);
      earlier = api.answeredByPlayerInput(earlier, "send", () =>
        api.submitPlayerRuntimeComposer(earlier, SECRET),
      ).session;
      const shown = api.restorePlayerRuntimeSessionAt(
        earlier.plan,
        JSON.stringify(api.playerRuntimeSnapshot(earlier)),
        earlier.events,
        new api.DebugRecorder(),
      );
      return made(api, shown, atError, "ok", "TypeError", {
        restoredSceneTimeMs: shown.state.observedSessionTimeMs,
        rewindCount: 1,
      });
    },
  },
  {
    name: "a skip freeze",
    choices: ALL,
    make: (api) => {
      const recorder = api.smallRecorder(50);
      const asking = api.createPlayerRuntimeSession(
        'let name = askText "Name"\nsay "Hi ${name}"\nexit',
        { recorder },
      );
      const session = api.submitPlayerRuntimeComposer(asking, "x".repeat(100)).session;
      return made(api, session, recorder.recording(), "none", null);
    },
  },
  {
    name: "a direct-throw freeze",
    choices: ALL,
    make: (api) => {
      const recorder = new api.DebugRecorder();
      const session = scopesUsedUp(
        api,
        [
          "let go = true",
          "timer async 1 s {",
          '  say "before", instant',
          "  if go {",
          '    say "deep", instant',
          "  }",
          "}",
          'let pick = askChoice again: "Again"',
          "exit",
        ].join("\n"),
        1,
        recorder,
      );
      try {
        api.observePlayerRuntimeTime(session, 1_000);
      } catch {
        // The call threw; the session shows the state before it.
      }
      return made(api, session, recorder.recording(), "none", "TypeError");
    },
  },
  {
    name: "the last good state, when the current one cannot be checkpointed",
    choices: ALL,
    make: (api) => {
      const recorder = new api.DebugRecorder();
      const session = api.createPlayerRuntimeSession('let name = askText "Name"\nexit', {
        recorder,
      });
      const recording = recorder.recording();
      void session;
      const broken = {
        ...recording,
        endSnapshot: { ...recording.endSnapshot, nextInstruction: -1 },
      };
      return made(api, null, broken, "none", "TypeError");
    },
  },
  {
    name: "scrubbing: an answer that looks like a path or a credential",
    choices: ALL,
    make: (api) => {
      const { session, recorder } = failed(api, "/home/someone/.ssh/id_rsa password=hunter2");
      return made(api, session, recorder.recording(), "ok", null);
    },
  },
  {
    name: "answer forms: a choice and a composer",
    choices: ALL,
    make: (api) => {
      const recorder = new api.DebugRecorder();
      let session = api.createPlayerRuntimeSession(
        'let pick = askChoice ["One", "Two"]\nlet name = askText "Name"\nsay "${pick} ${name}"\nexit',
        { recorder },
      );
      const options = api.playerRuntimeForeground(session).options;
      session = api.answeredByPlayerInput(session, "button", () =>
        api.selectPlayerRuntimeChoice(session, options[1].id),
      ).session;
      session = api.answeredByPlayerInput(session, "enter", () =>
        api.submitPlayerRuntimeComposer(session, "Ann"),
      ).session;
      return made(api, session, recorder.recording(), "none", null);
    },
  },
  {
    name: "a photo whose bytes cannot be read",
    choices: ALL,
    make: (api) => {
      const { session, recorder } = failed(api);
      return made(api, session, recorder.recording(), "fails", null);
    },
  },
  {
    name: "repeated preparations from one candidate",
    choices: ALL,
    repeat: 2,
    make: (api) => {
      const { session, recorder } = failed(api);
      return made(api, session, recorder.recording(), "ok", null);
    },
  },
];

/** The host diagnostics and Player details every scenario's candidate carries. */
export const SHOWN = {
  player: { viewportWidth: 390, userAgent: "Test Browser" },
  host: {
    stage: { status: "unresolved", path: "images/missing-room.png" },
    media: [
      { mediaId: 1, media: "audio", loaded: true, state: "running", source: "sounds/theme.mp3" },
    ],
    notices: [{ key: "audio-blocked", level: "warning", message: "The browser blocked audio." }],
    debugLog: ["Skipped the wait at main.tease:3"],
  },
};
export const BUILD = { commit: "abc", dirty: false, mode: "production", appVersion: "0.0.0" };
export const PACKAGE = { id: "development-package:equivalence", version: null };

/**
 * Runs `scenario` on `api`: `candidateOf(made)` is the side's candidate without photos; this adds the photos and the
 * choices, assembles, and returns each preparation's file text.
 */
export async function exportFiles(api, scenario, candidateOf) {
  const made = scenario.make(api);
  const frozen = candidateOf(made);
  const read =
    made.photoRead === "fails"
      ? async () => {
          throw new Error("The photo's bytes are gone.");
        }
      : async () => Uint8Array.from(PHOTO_BYTES);
  const candidate = {
    ...frozen,
    photos:
      made.photoRead === "none"
        ? []
        : [...api.debugPhotoUses(frozen)].map(([reference, usedBy]) => ({
            reference,
            mimeType: "image/png",
            byteLength: PHOTO_BYTES.length,
            width: 2,
            height: 1,
            usedBy,
            read,
          })),
  };
  let choices = api.NO_PERSONAL_CONTENT;
  for (const category of scenario.choices)
    choices = api.chooseDebugCategory(choices, candidate, category, true);
  const files = [];
  for (let at = 0; at < (scenario.repeat ?? 1); at += 1) {
    const { exported, parts } = await api.assembleDebugExport(candidate, choices);
    // The file's text, byte for byte.
    const text = await (await api.debugExportFile(exported, false)).text();
    files.push({ file: text, parts });
  }
  return files;
}
