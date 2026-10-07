import assert from "node:assert/strict";
import test from "node:test";

import { debugStageImageStatus } from "../player/presentation.js";
import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  playerRuntimeDebugNow,
  reportPlayerRuntimeMediaLoad,
  type PlayerRuntimeSession,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";

// Player Debug's Now view (DEBUGGER.md "Player Debug") locates the session from canonical state: package paths with
// every folder, one-based lines of the authored source, calls innermost first, and every timer, hidden ones included.

function observe(session: PlayerRuntimeSession, atMs: number): PlayerRuntimeSession {
  const observed = observePlayerRuntimeTime(session, atMs);
  assert.equal(observed.outcome.kind, "observed");
  return observed.session;
}

function press(session: PlayerRuntimeSession): PlayerRuntimeSession {
  const pressed = activatePlayerRuntimeButton(session);
  assert.equal(pressed?.outcome.kind, "completed");
  return pressed.session;
}

const location = (path: string, line: number) => ({ path, line });

// The shape of the Domme3 case: the entry script goes to a nested folder, which calls another file and a function.
const project = {
  files: [
    { path: "main.tease", source: 'goto "Domme3/maintenance.tease"\n' },
    {
      path: "Domme3/maintenance.tease",
      source:
        'say "Maintenance", instant\ncall "Domme3/spanking.tease"\nlet done = showButton "Done"\nexit\n',
    },
    {
      path: "Domme3/spanking.tease",
      source: [
        "function punish {",
        '  showImage "Domme/Domme43.jpg"',
        '  let first = showButton "Next"',
        "}",
        "timer async hidden 600 s",
        "punish()",
        "wait 5 s",
        "end",
        "",
      ].join("\n"),
    },
  ],
};

test("Now names the next statement, the wait's statement, and the calls across nested files", () => {
  let session = createPlayerRuntimeSession(project);
  let now = playerRuntimeDebugNow(session, 0);
  assert.deepEqual(now.next, location("Domme3/spanking.tease", 3));
  assert.deepEqual(now.waitingAt, { kind: "button", at: location("Domme3/spanking.tease", 3) });
  assert.deepEqual(now.calls, [
    { kind: "function", name: "punish", from: location("Domme3/spanking.tease", 6) },
    { kind: "file", name: "Domme3/spanking.tease", from: location("Domme3/maintenance.tease", 2) },
  ]);
  // The hidden async timer is listed, with its remaining time at the display estimate.
  assert.deepEqual(
    now.timers.map(({ blocking, display, state, remainingMs, startedAt }) => ({
      blocking,
      display,
      state,
      remainingMs,
      startedAt,
    })),
    [
      {
        blocking: false,
        display: "hidden",
        state: "running",
        remainingMs: 600_000,
        startedAt: location("Domme3/spanking.tease", 5),
      },
    ],
  );
  assert.equal(playerRuntimeDebugNow(session, 1_500).timers[0]?.remainingMs, 598_500);

  session = press(session);
  now = playerRuntimeDebugNow(session, 0);
  assert.deepEqual(now.waitingAt, { kind: "wait", at: location("Domme3/spanking.tease", 7) });
  assert.deepEqual(
    now.calls.map((call) => call.kind),
    ["file"],
  );

  session = press(observe(session, 5_000));
  assert.equal(session.state.status, "halted");
  now = playerRuntimeDebugNow(session, 6_000);
  assert.deepEqual(now, { next: null, waitingAt: null, calls: [], timers: [], media: [] });
});

test("Now lists blocking, suspended and paused timers and the block that interrupted the script", () => {
  let session = createPlayerRuntimeSession(
    [
      'let paused = timer(duration: 30, async: true, label: "Paused")',
      "paused.pause()",
      "timer async 1 {",
      "  wait 5",
      "}",
      'timer(duration: 10, display: "visible", label: "Blocking")',
      "exit",
    ].join("\n"),
  );
  let now = playerRuntimeDebugNow(session, 0);
  assert.deepEqual(
    now.timers.map(({ label, blocking, state }) => ({ label, blocking, state })),
    [
      { label: "Paused", blocking: false, state: "paused" },
      { label: null, blocking: false, state: "running" },
      { label: "Blocking", blocking: true, state: "running" },
    ],
  );
  assert.deepEqual(now.waitingAt, { kind: "timer", at: location("main.tease", 6) });

  session = observe(session, 1_000);
  now = playerRuntimeDebugNow(session, 1_000);
  assert.deepEqual(now.waitingAt, { kind: "wait", at: location("main.tease", 4) });
  assert.equal(now.calls[0]?.kind, "timer");
  assert.deepEqual(now.calls[0]?.from, location("main.tease", 6));
  assert.deepEqual(
    now.timers.map(({ label, state, remainingMs }) => ({ label, state, remainingMs })),
    [
      { label: "Paused", state: "paused", remainingMs: 30_000 },
      { label: "Blocking", state: "suspended", remainingMs: 9_000 },
    ],
  );
});

test("the Stage image state follows the resolved source and what the Stage reports for it", () => {
  const stage = {
    image: "a.png",
    source: "/a.png",
    overridden: false,
    covered: false,
    loaded: null,
    failed: null,
  };
  assert.equal(debugStageImageStatus({ ...stage, image: null, source: null }), "hidden");
  assert.equal(debugStageImageStatus({ ...stage, source: null }), "unresolved");
  assert.equal(debugStageImageStatus(stage), "loading");
  assert.equal(debugStageImageStatus({ ...stage, loaded: "/a.png" }), "displayed");
  assert.equal(debugStageImageStatus({ ...stage, failed: "/a.png" }), "failed");
  // A report about another source, such as the image this one replaced, does not count.
  assert.equal(debugStageImageStatus({ ...stage, loaded: "/old.png" }), "loading");
  assert.equal(debugStageImageStatus({ ...stage, loaded: "/a.png", covered: true }), "covered");
  // A development Stage fixture shows instead: its own load says nothing about the session's image.
  assert.equal(debugStageImageStatus({ ...stage, overridden: true }), "overridden");
});

test("Now lists each active sound with the statement that started it", () => {
  let session = createPlayerRuntimeSession({
    files: [
      {
        path: "main.tease",
        source: 'call "rooms/hall.tease"\nlet done = showButton "Done"\nexit\n',
      },
      {
        path: "rooms/hall.tease",
        source:
          'playAudio(file: "sounds/a.wav", async: true, repeat: true)\nplayAudio(file: "sounds/b.wav", async: true)\nend\n',
      },
    ],
  });
  const sounds = () =>
    playerRuntimeDebugNow(session, 0).media.map(({ source, loaded, startedAt }) => ({
      source,
      loaded,
      startedAt,
    }));
  // An async play waits for its load before the next statement runs.
  assert.deepEqual(sounds(), [
    { source: "sounds/a.wav", loaded: false, startedAt: location("rooms/hall.tease", 1) },
  ]);
  const loaded = reportPlayerRuntimeMediaLoad(
    session,
    playerRuntimeSnapshot(session).nextMediaId - 1,
    { kind: "loaded", durationMs: 10_000 },
  );
  assert.equal(loaded.outcome.kind, "accepted");
  session = loaded.session;
  assert.deepEqual(sounds(), [
    { source: "sounds/a.wav", loaded: true, startedAt: location("rooms/hall.tease", 1) },
    { source: "sounds/b.wav", loaded: false, startedAt: location("rooms/hall.tease", 2) },
  ]);
});
