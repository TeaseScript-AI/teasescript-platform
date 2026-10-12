import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import {
  activatePlayerRuntimeButton,
  catchUpPlayerRuntimeTime,
  compilePlayerProject,
  completePlayerRuntimeStorageWrite,
  createPlayerRuntimeSession,
  observePlayerRuntimeTime,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeSnapshot,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import { memoryKeptSessionStore, type KeptSessionStore } from "../player/kept-sessions.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { InstructionPlan, RandomControlOptions, RuntimeSnapshot } from "../src/index.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

// The Player catches up a late time observation in steps, one timed event at a time, so it can give the browser a turn
// between tasks. One observation of the same scene time is the oracle: a script plays the same however late or often
// the Player observes time (V30 §Time), and the steps must keep that, also for input that arrives meanwhile.

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
  let steps = 0;
  for (let next = catchUpPlayerRuntimeTime(session, targetMs, () => false); next !== session;) {
    session = next;
    steps += 1;
    next = catchUpPlayerRuntimeTime(session, targetMs, () => false);
  }
  return { session, steps };
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

test("a save during a catch-up is answered at the scene time one late observation gives", () => {
  const source =
    'timer async 2 s {\n  save 1 as "seen"\n  say "saved", instant\n}\nwait 1 s\nsay "one", instant\nwait 5 s\nsay "end", instant\nexit';
  const storage = { ...sessionOptions, scriptStorage: [], persistentScriptStorage: true };
  const acknowledged = (session: PlayerRuntimeSession) => {
    const write = pendingPlayerRuntimeStorageWrite(session.state);
    return write === null
      ? session
      : completePlayerRuntimeStorageWrite(session, write.actionId, true).session;
  };
  // The host answers as soon as the Player gives it a turn, between two steps.
  let session = createPlayerRuntimeSession(source, storage);
  for (let steps = 0; session.state.observedSessionTimeMs < 12_000; steps += 1) {
    assert.ok(steps < 10, "the catch-up makes progress");
    session = acknowledged(catchUpPlayerRuntimeTime(session, 12_000, () => false));
  }
  // The step that saves observes the rest at once, so the block goes on at 12 s, as after one late observation.
  assert.deepEqual(
    canonical(session),
    canonical(acknowledged(observedLate(source, 12_000, storage))),
  );
  assert.equal(session.transcriptEntries.map((entry) => entry.text).join(", "), "one, saved");
});

// The Vue session host and its scene clock, loaded through the build tool like the Player loads them.
interface SessionHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string }[]>>;
  prepare(create: () => PlayerRuntimeSession): void;
  prepareScript(plan: InstructionPlan, create: () => PlayerRuntimeSession): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  activate(): Promise<void>;
  observe(): PlayerRuntimeSession | null;
  update(next: PlayerRuntimeSession): void;
  setRandomControl(control: RandomControlOptions | null): void;
  resolveRandomDraw(drawId: number, outcome: "natural"): void;
  debugExportCandidate(shown: {
    readonly player: Record<string, never>;
    readonly host: {
      readonly stage: { readonly status: "hidden"; readonly path: null };
      readonly media: readonly [];
      readonly notices: readonly [];
      readonly debugLog: null;
    };
  }): Promise<{ readonly session: { readonly snapshot: RuntimeSnapshot } | null }>;
}
let usePlayerSession: (options: {
  scriptStorage?: ScriptStorageProvider;
  keptSessions?: KeptSessionStore;
}) => SessionHost;

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
 * the page show again. With `keptSessions`, the script keeps its session, as one with saved data does.
 */
async function mount(
  context: TestContext,
  source: string,
  options: {
    readonly randomControl?: RandomControlOptions;
    readonly keptSessions?: KeptSessionStore;
  } = {},
) {
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
  const host = scope.run(() =>
    usePlayerSession(
      options.keptSessions === undefined
        ? {}
        : { scriptStorage: savedData(), keptSessions: options.keptSessions },
    ),
  )!;
  context.after(() => scope.stop());
  if (options.randomControl !== undefined) host.setRandomControl(options.randomControl);
  if (options.keptSessions === undefined)
    host.prepare(() => createPlayerRuntimeSession(source, sessionOptions));
  else {
    await host.loadScriptStorage();
    const plan = compilePlayerProject(source).plan;
    assert.ok(plan, "the fixture compiles");
    await host.prepareScript(plan, () =>
      createPlayerRuntimeSession(plan, { ...sessionOptions, ...host.scriptStorageOptions() }),
    );
  }
  await host.activate();
  return {
    host,
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

/** Saved data in memory, which a script needs to keep its session. */
function savedData(): ScriptStorageProvider {
  return {
    scope: "catch-up",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
}

/** Lets the tasks of a catch-up run until the session stays as it is; returns how many sessions they published. */
async function caughtUp(host: SessionHost) {
  let published = 0;
  for (let quiet = 0, last = host.session.value; quiet < 3;) {
    await new Promise((resolve) => setImmediate(resolve));
    if (host.session.value === last) quiet += 1;
    else [quiet, last, published] = [0, host.session.value, published + 1];
  }
  return published;
}

// A block every 10 ms while the script waits for the player.
const rounds =
  'let rounds = 0\ntimer(duration: 10 ms, async: true, repeat: true, display: "hidden") {\n  rounds += 1\n}\nlet elapsed = showButton "Done"\nsay "${rounds} rounds", instant\nexit';

test("a late observation catches up over several tasks and gives the session one late observation gives", async (context) => {
  const { host, late } = await mount(context, rounds);
  late(1_000);
  assert.ok(
    host.session.value!.state.observedSessionTimeMs < 1_000,
    "the first task gives the browser a turn before the catch-up is done",
  );
  assert.ok((await caughtUp(host)) > 1, "later tasks go on");
  const session = host.session.value!;
  assert.ok(session.state.observedSessionTimeMs >= 1_000);
  assert.deepEqual(
    canonical(session),
    canonical(observedLate(rounds, session.state.observedSessionTimeMs)),
  );
});

test("in a hidden page, a catch-up a late wake-up starts goes on without timers", async (context) => {
  const { host, wakeUp } = await mount(context, rounds);
  // Hidden pages throttle timers, and animation frames do not run in them at all.
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  wakeUp(1_000);
  assert.ok(host.session.value!.state.observedSessionTimeMs < 1_000, "a catch-up is under way");
  // No timer fires from here on.
  await caughtUp(host);
  assert.ok(host.session.value!.state.observedSessionTimeMs >= 1_000);
});

test("input during a catch-up finishes it first and lands at the scene time it arrives at", async (context) => {
  const { host, late } = await mount(context, rounds);
  late(1_000);
  assert.ok(host.session.value!.state.observedSessionTimeMs < 1_000, "a catch-up is under way");
  // As the Player's interaction does: observe, then answer what is presented.
  const observed = host.observe()!;
  const atMs = observed.state.observedSessionTimeMs;
  assert.ok(atMs >= 1_000, "the answer comes after the whole catch-up");
  host.update(activatePlayerRuntimeButton(observed)!.session);
  await caughtUp(host);
  const answered = host.session.value!;
  assert.equal(answered.transcriptEntries.at(-1)?.text, `${Math.floor(atMs / 10)} rounds`);
  assert.deepEqual(
    canonical(answered),
    canonical(activatePlayerRuntimeButton(observedLate(rounds, atMs))!.session),
  );
});

test("a debug export asked for during a catch-up finishes it first", async (context) => {
  const { host, late } = await mount(context, rounds);
  late(1_000);
  assert.ok(host.session.value!.state.observedSessionTimeMs < 1_000, "a catch-up is under way");
  const candidate = await host.debugExportCandidate({
    player: {},
    host: { stage: { status: "hidden", path: null }, media: [], notices: [], debugLog: null },
  });
  assert.ok(candidate.session!.snapshot.observedSessionTimeMs >= 1_000);
});

test("what a catch-up shows only on its way is neither kept nor reported", async (context) => {
  const keptMs: number[] = [];
  const store = memoryKeptSessionStore();
  const keptSessions: KeptSessionStore = {
    session: (scope) => store.session(scope),
    discard: (scope) => store.discard(scope),
    media: store.media,
    publish: (scope, update) => {
      // EVIDENCE: the Player keeps the JSON of a snapshot it exported and validated (`playerRuntimeSnapshotJson`).
      const kept = JSON.parse(update.snapshotJson) as RuntimeSnapshot;
      keptMs.push(kept.observedSessionTimeMs);
      return store.publish(scope, update);
    },
  };
  // Timed buttons and a missing Stage image come and go on the way; one late observation shows none of them.
  const { host, late } = await mount(
    context,
    'repeat 20 {\n  let tap = showButton "Tap", timeout: 10 ms\n}\nshowImage "missing.png"\nrepeat 20 {\n  wait 10 ms\n}\nshowImage null\nlet done = showButton "Done"\nexit',
    { keptSessions },
  );
  await caughtUp(host);
  keptMs.length = 0;
  late(1_000);
  assert.ok(host.session.value!.state.observedSessionTimeMs < 1_000, "a catch-up is under way");
  await caughtUp(host);
  assert.ok(host.session.value!.state.observedSessionTimeMs >= 1_000);
  assert.deepEqual(host.notices.value, [], "the image that came and went is not reported");
  assert.ok(keptMs.length > 0, "the session is kept once the catch-up is done");
  assert.ok(
    keptMs.every((ms) => ms >= 1_000),
    `kept at ${keptMs.join(", ")}`,
  );
});

test("while Debug decides random draws, a late observation is one observation", async (context) => {
  const { host, late } = await mount(
    context,
    'wait 1 s\nlet r = randomInteger(1..=6)\nwait 1 s\nsay "rolled", instant\nlet e = showButton "Done"\nexit',
    { randomControl: {} },
  );
  late(10_000);
  const paused = host.session.value!;
  // The draw waits at its own scene time, with the whole late observation behind it, as on main.
  assert.notEqual(paused.state.randomDraw, null);
  assert.equal(paused.state.currentSessionTimeMs, 1_000);
  assert.ok(paused.state.observedSessionTimeMs >= 10_000);
  host.resolveRandomDraw(paused.state.randomDraw!.drawId, "natural");
  await caughtUp(host);
  assert.deepEqual(
    host.session.value!.transcriptEntries.map((entry) => entry.text),
    ["rolled"],
  );
});
