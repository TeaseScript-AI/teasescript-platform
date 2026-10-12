import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import {
  activatePlayerRuntimeButton,
  adoptPlayerRuntimeCatchUp,
  beginPlayerRuntimeCatchUp,
  completePlayerRuntimeStorageWrite,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeSnapshot,
  skipPlayerRuntimePacing,
  stepPlayerRuntimeCatchUp,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { DebugRecorder, DebugRecording } from "../player/debug-recorder.js";
import { rebuildRecordedSession } from "../player/debug-export.js";
import type { RandomControlOptions } from "../src/index.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

// The Player catches up a late time observation on a copy of the session, one timed event at a time, so it can give
// the browser a turn between tasks, and the session adopts the copy in one publication. One observation of the same
// scene time is the oracle: a script plays the same however late or often the Player observes time (V30 §Time), and
// what the Player shows is what one late observation shows, only without the freeze.

const sessionOptions: PlayerRuntimeSessionOptions = { wallClockMs: Date.UTC(2026, 0, 1) };

/** The canonical result of a session, without the adapter's presentation cache. */
function canonical(session: PlayerRuntimeSession) {
  return { snapshot: playerRuntimeSnapshot(session), events: session.events };
}

/** One late observation of `atMs`. */
function observedLate(source: string, atMs: number, options = sessionOptions) {
  return observePlayerRuntimeTime(createPlayerRuntimeSession(source, options), atMs).session;
}

/** Catches up to `targetMs` one step per call, as a Player that gives the browser a turn after every step. */
function caughtUpInSteps(session: PlayerRuntimeSession, targetMs: number) {
  const catchUp = beginPlayerRuntimeCatchUp(session, targetMs);
  let steps = 0;
  for (; stepPlayerRuntimeCatchUp(catchUp, () => false) === "more"; steps += 1) {
    assert.equal(session.state.observedSessionTimeMs, 0, "the session stays as it is meanwhile");
  }
  return { session: adoptPlayerRuntimeCatchUp(session, catchUp)!, steps };
}

test("a catch-up in steps gives the session that one late observation gives", () => {
  const scripts = [
    'say "a", instant\nwait 1 s\nlet t = timer async 2 s { say "block", instant }\nwait 3 s\nsay "b", instant\nt.stop()\nwait 1 s\nexit',
    'timer async 3 s { say "three", instant }\nlet e = showButton "Done", timeout: 5 s\nsay "after ${e}", instant\ntimer async 2 s { say "late", instant }\nlet f = showButton "More"\nexit',
    'let t = timer(duration: 1 s, async: true, repeat: true)\ntimer async 2 s { t.repeatDuration = 10 s }\nwait 5 s\nsay "${t.remaining} ${t.elapsed}", instant\nexit',
    'say "First", 2 s\nsay "Second", 3 s\nsay "Third", instant\nexit',
    'repeat 4 {\n  wait (1..=2) s\n  say "${randomInteger(1..=6)}", instant\n}\nexit',
    // Silent rounds that draw their lengths settle one by one, so each is a step.
    'let t = timer(duration: (1..=2) ms, async: true, repeat: true)\nwait 50 ms\nsay "${t.elapsed}", instant\nt.stop()\nexit',
    // Issue #841's shape: work, then a short rest, over and over.
    'let n = 0\nrepeat 50 {\n  repeat 100 {}\n  n += 1\n  wait 1 ms\n}\nsay "${n}", instant\nexit',
  ];
  for (const source of scripts) {
    const { session, steps } = caughtUpInSteps(
      createPlayerRuntimeSession(source, sessionOptions),
      12_000,
    );
    assert.ok(steps > 2, `${steps} steps: ${source}`);
    assert.equal(session.state.observedSessionTimeMs, 12_000, source);
    assert.deepEqual(canonical(session), canonical(observedLate(source, 12_000)), source);
  }
});

test("a save during a catch-up waits for the host at the scene time one late observation gives", () => {
  const source =
    'timer async 2 s {\n  save 1 as "seen"\n  say "saved", instant\n}\nwait 1 s\nsay "one", instant\nwait 5 s\nsay "end", instant\nexit';
  const storage = { ...sessionOptions, scriptStorage: [], persistentScriptStorage: true };
  const acknowledged = (session: PlayerRuntimeSession) => {
    const write = pendingPlayerRuntimeStorageWrite(session.state);
    assert.ok(write, "the block's save waits for the host");
    return completePlayerRuntimeStorageWrite(session, write.actionId, true).session;
  };
  const { session } = caughtUpInSteps(createPlayerRuntimeSession(source, storage), 12_000);
  assert.equal(session.state.observedSessionTimeMs, 12_000);
  assert.deepEqual(
    canonical(acknowledged(session)),
    canonical(acknowledged(observedLate(source, 12_000, storage))),
  );
});

// The Vue session host and its scene clock, loaded through the build tool like the Player loads them.
interface SessionHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  prepare(
    create: (recording: {
      readonly recorder: DebugRecorder;
      readonly debugMode: boolean;
    }) => PlayerRuntimeSession,
  ): void;
  activate(): Promise<void>;
  observe(): PlayerRuntimeSession | null;
  update(next: PlayerRuntimeSession): void;
  setDebugTracing(on: boolean): void;
  setRandomControl(control: RandomControlOptions | null): void;
  resolveRandomDraw(drawId: number, outcome: "natural"): void;
  debugRecording(): DebugRecording | null;
}
let usePlayerSession: () => SessionHost;

before(async () => {
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
});

/**
 * Starts `source` in a Player whose monotonic clock moves on a millisecond at each reading, as if the Player's work
 * took that long, so a catch-up uses up its task after a few steps. Deadline wake-ups fire only when `wakeUp` lets
 * them; a catch-up goes on in tasks of its own. `late` moves the clock on as a page in the background would and lets
 * the page show again.
 */
async function mount(context: TestContext, source: string, randomControl?: RandomControlOptions) {
  // Event targets are the only browser surface these scripts use; no media elements are created.
  for (const name of ["document", "window"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let nowMs = 0;
  context.mock.method(performance, "now", () => (nowMs += 1));
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession())!;
  context.after(() => scope.stop());
  if (randomControl !== undefined) host.setRandomControl(randomControl);
  // Recorded as every Player session is, so the debug export's replay can be checked.
  host.prepare((recording) =>
    createPlayerRuntimeSession(source, { ...sessionOptions, ...recording }),
  );
  await host.activate();
  return {
    host,
    unmount: () => scope.stop(),
    late(milliseconds: number) {
      nowMs += milliseconds;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    wakeUp(milliseconds: number) {
      nowMs += milliseconds;
      context.mock.timers.tick(milliseconds);
    },
  };
}

/** Lets the tasks of a catch-up run until the session has observed `atLeastMs`. */
async function caughtUp(host: SessionHost, atLeastMs: number) {
  for (let round = 0; host.session.value!.state.observedSessionTimeMs < atLeastMs; round += 1) {
    assert.ok(round < 1_000, "the catch-up ends");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Checks that the debug export's recording replays exactly to the session shown. */
function replays(host: SessionHost) {
  const recording = host.debugRecording()!;
  const rebuilt = rebuildRecordedSession(
    recording.plan,
    recording.anchorSnapshot,
    recording.operations,
  );
  assert.deepEqual(rebuilt.exportSnapshot(), playerRuntimeSnapshot(host.session.value!));
}

// A block every 10 ms while the script waits for the player.
const rounds =
  'let rounds = 0\ntimer(duration: 10 ms, async: true, repeat: true, display: "hidden") {\n  rounds += 1\n}\nlet elapsed = showButton "Done"\nsay "${rounds} rounds", instant\nexit';

test("a late observation catches up over several tasks and then shows one late observation's session", async (context) => {
  const { host, late } = await mount(context, rounds);
  const shown = host.session.value;
  late(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.session.value, shown, "another task ran before the catch-up was done");
  await caughtUp(host, 1_000);
  const session = host.session.value!;
  assert.ok(session.state.observedSessionTimeMs >= 1_000);
  assert.deepEqual(
    canonical(session),
    canonical(observedLate(rounds, session.state.observedSessionTimeMs)),
  );
  replays(host);
});

test("in a hidden page, a catch-up a late wake-up starts goes on without timers", async (context) => {
  const { host, wakeUp } = await mount(context, rounds);
  // Hidden pages throttle timers, and animation frames do not run in them at all.
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  const shown = host.session.value;
  wakeUp(1_000);
  assert.equal(host.session.value, shown, "a catch-up is under way");
  // No timer fires from here on.
  await caughtUp(host, 1_000);
  assert.ok(host.session.value!.state.observedSessionTimeMs >= 1_000);
});

test("input during a catch-up lands at the scene time it arrives at, after the whole late observation", async (context) => {
  const { host, late } = await mount(context, rounds);
  late(1_000);
  assert.ok(host.session.value!.state.observedSessionTimeMs < 1_000, "a catch-up is under way");
  // As the Player's interaction does: observe, then answer what is presented.
  const observed = host.observe()!;
  const atMs = observed.state.observedSessionTimeMs;
  assert.ok(atMs >= 1_000);
  host.update(activatePlayerRuntimeButton(observed)!.session);
  await caughtUp(host, 1_000);
  const answered = host.session.value!;
  assert.equal(answered.transcriptEntries.at(-1)?.text, `${Math.floor(atMs / 10)} rounds`);
  assert.deepEqual(
    canonical(answered),
    canonical(activatePlayerRuntimeButton(observedLate(rounds, atMs))!.session),
  );
  replays(host);
});

test("an operation on the session during a catch-up drops the copy, and the session observes in one go", async (context) => {
  const source =
    'let rounds = 0\ntimer(duration: 10 ms, async: true, repeat: true, display: "hidden") {\n  rounds += 1\n}\nsay "Read me", 20 s\nlet elapsed = showButton "Done"\nexit';
  const { host, late } = await mount(context, source);
  late(1_000);
  const shown = host.session.value!;
  assert.equal(shown.state.observedSessionTimeMs, 0, "a catch-up is under way");
  // An operation that does not observe first, as a form draft does, applies to the session as it is shown.
  host.update(skipPlayerRuntimePacing(shown)!.session);
  await caughtUp(host, 1_000);
  const session = host.session.value!;
  const skipped = skipPlayerRuntimePacing(createPlayerRuntimeSession(source, sessionOptions))!;
  assert.deepEqual(
    canonical(session),
    canonical(
      observePlayerRuntimeTime(skipped.session, session.state.observedSessionTimeMs).session,
    ),
  );
  replays(host);
});

test("a script that fails during a catch-up fails as one late observation fails it, also in its recording", async (context) => {
  const source = "wait 10 ms\nsay chance(101), instant\nexit";
  const { host, late } = await mount(context, source);
  late(1_000);
  await caughtUp(host, 1_000);
  const session = host.session.value!;
  assert.equal(session.state.status, "failed");
  assert.deepEqual(
    canonical(session),
    canonical(observedLate(source, session.state.observedSessionTimeMs)),
  );
  replays(host);
});

test("leaving the Player ends a catch-up, also one that several opportunities stepped", async (context) => {
  const { host, late, unmount } = await mount(context, rounds);
  const shown = host.session.value;
  late(1_000);
  window.dispatchEvent(new Event("pageshow"));
  unmount();
  for (let round = 0; round < 50; round += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.session.value, shown);
});

test("while Debug runs, a late observation is one observation", async (context) => {
  const { host, late } = await mount(context, rounds);
  host.setDebugTracing(true);
  late(1_000);
  assert.ok(host.session.value!.state.observedSessionTimeMs >= 1_000);
  replays(host);
});

test("while Debug decides random draws, a late observation pauses at the draw with all of it observed", async (context) => {
  const { host, late } = await mount(
    context,
    'wait 1 s\nlet r = randomInteger(1..=6)\nwait 1 s\nsay "rolled", instant\nlet e = showButton "Done"\nexit',
    {},
  );
  late(10_000);
  const paused = host.session.value!;
  assert.notEqual(paused.state.randomDraw, null);
  assert.equal(paused.state.currentSessionTimeMs, 1_000);
  assert.ok(paused.state.observedSessionTimeMs >= 10_000);
  host.resolveRandomDraw(paused.state.randomDraw!.drawId, "natural");
  await caughtUp(host, 1_000);
  assert.deepEqual(
    host.session.value!.transcriptEntries.map((entry) => entry.text),
    ["rolled"],
  );
});

test("turning Debug's random draws on during a catch-up finishes it first with natural draws", async (context) => {
  const { host, late } = await mount(
    context,
    'repeat 50 {\n  wait 10 ms\n  let r = randomInteger(1..=6)\n}\nlet done = showButton "Done"\nexit',
  );
  late(1_000);
  assert.ok(host.session.value!.state.observedSessionTimeMs < 1_000, "a catch-up is under way");
  let decided = 0;
  host.setRandomControl({
    decide: () => {
      decided += 1;
      return { kind: "suspend" };
    },
  });
  assert.ok(host.session.value!.state.observedSessionTimeMs >= 1_000);
  assert.equal(host.session.value!.state.randomDraw, null);
  assert.equal(decided, 0);
  replays(host);
});
