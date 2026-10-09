import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { createServer } from "vite";

import {
  activatePlayerRuntimeButton,
  advancePlayerRuntimeTime,
  completePlayerRuntimeStorageWrite,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  nextPlayerRuntimeEventMs,
  observePlayerRuntimeTime,
  pendingPlayerRuntimeStorageWrite,
  playerRuntimeDeadlines,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSession,
  stepPlayerRuntimeTime,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { MediaProgressReport } from "../src/index.js";
import { harness } from "./helpers/player-media.js";

// Development time controls (#615) jump scene time through ordinary observations. A jump must give exactly the
// session that observing the same scene time in real time gives, so its oracles here are independent observation
// schedules: the Player's deadline wake-ups, one late observation, and a fine sampling of 1× media playback.

function said(session: PlayerRuntimeSession): string[] {
  return session.transcriptEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry.text] : [],
  );
}

/** The canonical result of a session, without the adapter's presentation cache. */
function canonical(session: PlayerRuntimeSession) {
  return { snapshot: playerRuntimeSnapshot(session), events: session.events };
}

/** Observes at every deadline the session reports, as the Player's wake-ups do, and finally at `targetMs`. */
function observeEveryDeadline(session: PlayerRuntimeSession, targetMs: number) {
  for (;;) {
    const observedMs = session.state.observedSessionTimeMs;
    const due = playerRuntimeDeadlines(session.state).filter((deadline) => deadline > observedMs);
    const nowMs = Math.min(targetMs, ...due);
    session = observePlayerRuntimeTime(session, nowMs).session;
    if (nowMs >= targetMs) return session;
  }
}

test("a jump gives the session that observing every deadline on time gives", () => {
  const scripts = [
    'say "a"\nwait 1\nlet t = timer async 2 { say "block" }\nwait 3\nsay "b"\nt.stop()\nwait 1\nexit',
    'let t = timer(duration: 1, async: true, repeat: true)\ntimer async 2 { t.repeatDuration = 10 s }\nwait 5\nsay "${t.remaining} ${t.elapsed}"\nexit',
    'let t = timer async 3 { say "too late" }\ntimer async 1 {\n  wait 1\n  t.stop()\n}\nwait 10\nexit',
    'timer async 3 { say "three", instant }\nlet e = showButton "Done", timeout: 5\nsay "after ${e}", instant\ntimer async 2 { say "late", instant }\nlet f = showButton "More"\nexit',
  ];
  for (const source of scripts) {
    // Each run needs its own session: one session's derived sessions share one timeline.
    const onTime = observeEveryDeadline(createPlayerRuntimeSession(source), 12_000);
    const late = observePlayerRuntimeTime(createPlayerRuntimeSession(source), 12_000).session;
    const jumped = advancePlayerRuntimeTime(createPlayerRuntimeSession(source), 12_000);
    let skipped = createPlayerRuntimeSession(source);
    for (let next = nextPlayerRuntimeEventMs(skipped.state); next !== null && next < 12_000;) {
      skipped = advancePlayerRuntimeTime(skipped, next);
      next = nextPlayerRuntimeEventMs(skipped.state);
    }
    skipped = advancePlayerRuntimeTime(skipped, 12_000);
    assert.deepEqual(canonical(jumped), canonical(onTime), `jump: ${source}`);
    assert.deepEqual(canonical(late), canonical(onTime), `late: ${source}`);
    assert.deepEqual(canonical(skipped), canonical(onTime), `skips: ${source}`);
  }
});

test("+10 s at a button runs timers and its timeout in scene-time order and shows in elapsed time", () => {
  let session = advancePlayerRuntimeTime(
    createPlayerRuntimeSession(
      'timer async 3 { say "three", instant }\nlet e = showButton "Done", timeout: 5\nsay "after ${e}", instant\ntimer async 2 { say "late", instant }\nlet f = showButton "More"\nexit',
    ),
    10_000,
  );
  assert.deepEqual(said(session), ["three", "after 5 seconds", "late"]);
  assert.deepEqual(
    session.events.flatMap((event) =>
      event.kind === "actionCompleted" && event.settlement.actionKind === "timer"
        ? [event.settlement.completedAtMs]
        : [],
    ),
    [3_000, 7_000],
  );
  assert.equal(session.state.observedSessionTimeMs, 10_000);
  assert.equal(session.state.foregroundAction?.kind, "interaction", "More waits for the player");

  // A jump is real scene time: a button's elapsed result and timestamp differences include it.
  session = advancePlayerRuntimeTime(
    createPlayerRuntimeSession(
      'let before = getAbsoluteDateTime()\nlet elapsed = showButton "Done"\nlet after = getAbsoluteDateTime()\nsay "${elapsed} ${after - before}", instant\nexit',
      { wallClockMs: Date.UTC(2026, 0, 1) },
    ),
    10_000,
  );
  session = advancePlayerRuntimeTime(session, 70_000);
  assert.deepEqual(said(activatePlayerRuntimeButton(session)!.session), [
    "Done",
    "1 minute 10 seconds 1 minute 10 seconds",
  ]);
});

test("a jump waits for a write a block makes, and checkpoints before and after it restore normally", () => {
  const source =
    'timer async 2 {\n  save 1 as "seen"\n  say "saved", instant\n}\nlet elapsed = showButton "Done"\nsay "Waited ${elapsed}", instant\nexit';
  const options: PlayerRuntimeSessionOptions = { scriptStorage: [], persistentScriptStorage: true };
  const finish = (session: PlayerRuntimeSession) => {
    const write = pendingPlayerRuntimeStorageWrite(session.state)!;
    session = completePlayerRuntimeStorageWrite(session, write.actionId, true).session;
    session = advancePlayerRuntimeTime(session, 10_000);
    const restored = restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(session));
    return [session, restored].map(
      (current) => activatePlayerRuntimeButton(advancePlayerRuntimeTime(current, 15_000))!.session,
    );
  };

  // The block's write holds the jump at the block's scene time, where the host answers it.
  const held = advancePlayerRuntimeTime(createPlayerRuntimeSession(source, options), 10_000);
  assert.equal(held.state.observedSessionTimeMs, 2_000);
  assert.ok(pendingPlayerRuntimeStorageWrite(held.state));
  assert.equal(advancePlayerRuntimeTime(held, 10_000), held, "no time passes before the answer");

  const [continued, restoredAfter] = finish(held);
  const [restoredBefore] = finish(
    restorePlayerRuntimeSession(
      createPlayerRuntimeRestorePoint(
        advancePlayerRuntimeTime(createPlayerRuntimeSession(source, options), 10_000),
      ),
    ),
  );
  assert.deepEqual(canonical(restoredBefore!), canonical(continued!));
  assert.deepEqual(canonical(restoredAfter!), canonical(continued!));
  assert.equal(continued!.state.status, "halted");
  assert.deepEqual(
    continued!.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["saved", "Waited 15 seconds"],
  );
  assert.deepEqual(
    continued!.events.flatMap((event) =>
      event.kind === "actionCompleted" && event.settlement.actionKind === "storageWrite"
        ? [event.settlement.completedAtMs]
        : [],
    ),
    [2_000],
  );
});

test("a jump plays running audio on at 1× through cues, seeks, pauses, and resumes", () => {
  const source = [
    'let music = playAudio async repeat "loop.mp3" {',
    "  at 0 s {",
    '    say "start ${music.elapsed}"',
    "  }",
    "  at 1 s {",
    '    say "cue ${music.elapsed}"',
    "    music.position = 0 s",
    "  }",
    "}",
    'timer async 1.5 {\n  music.pause()\n  say "paused ${music.position}"\n}',
    'timer async 2.5 {\n  music.resume()\n  say "resumed ${music.position}"\n}',
    'let e = showButton "Done"',
    "exit",
  ].join("\n");
  const loaded = () =>
    reportPlayerRuntimeMediaLoad(createPlayerRuntimeSession(source), 1, {
      kind: "loaded",
      durationMs: 4_000,
    }).session;
  // A Player that samples every 10 ms while the audio plays at exactly 1×.
  let sampled = loaded();
  for (let nowMs = 10; nowMs <= 3_600; nowMs += 10) {
    const reports: MediaProgressReport[] = [];
    for (const action of sampled.state.backgroundActions) {
      if (action.kind !== "media" || action.media.state !== "running") continue;
      const last = action.media.points.at(-1)!;
      reports.push({
        mediaId: action.media.mediaId,
        segment: action.media.segment,
        progressMs: last.progressMs + (nowMs - last.atMs),
      });
    }
    sampled = observePlayerRuntimeTime(sampled, nowMs, reports).session;
  }
  const jumped = advancePlayerRuntimeTime(loaded(), 3_600);
  assert.deepEqual(said(jumped), [
    "start 0 seconds",
    "cue 1 second",
    "start 1 second",
    "paused 500 milliseconds",
    "resumed 500 milliseconds",
    "cue 2 seconds",
    "start 2 seconds",
  ]);
  assert.deepEqual(canonical(jumped), canonical(sampled));
});

test("Skip goes to the end of blocking audio once it loaded; loading audio has no timed event", () => {
  let session = createPlayerRuntimeSession('playAudio "voice.mp3"\nsay "after", instant\nexit');
  assert.equal(nextPlayerRuntimeEventMs(session.state), null);
  session = observePlayerRuntimeTime(session, 300).session;
  session = reportPlayerRuntimeMediaLoad(session, 1, { kind: "loaded", durationMs: 4_000 }).session;
  assert.equal(nextPlayerRuntimeEventMs(session.state), 4_300);
  session = advancePlayerRuntimeTime(session, nextPlayerRuntimeEventMs(session.state)!);
  assert.deepEqual(said(session), ["after"]);
  assert.equal(session.state.status, "halted");
});

test("a jump passes silent timer rounds and cue-free media passes like one late observation", () => {
  const source = [
    "timer(duration: 0.001 ms, async: true, repeat: true)",
    'playAudio(file: "tick.mp3", async: true, repeat: 3000 times) {',
    "  finish {",
    '    say "ticks done", instant',
    "  }",
    "}",
    'let e = showButton "Done"',
    "exit",
  ].join("\n");
  // Rounds of a repeating timer without a block and passes without cues run nothing; only the audio's end is an event.
  assert.equal(nextPlayerRuntimeEventMs(createPlayerRuntimeSession(source).state), null);
  const loaded = () =>
    reportPlayerRuntimeMediaLoad(createPlayerRuntimeSession(source), 1, {
      kind: "loaded",
      durationMs: 2,
    }).session;
  let jumped = loaded();
  const steps: number[] = [];
  for (let next = stepPlayerRuntimeTime(jumped, 10_000); next !== jumped;) {
    jumped = next;
    steps.push(jumped.state.observedSessionTimeMs);
    // Bounded, so observing each round or pass fails here instead of running for hours.
    assert.ok(steps.length <= 2, `steps at ${steps.slice(0, 5).join(", ")}`);
    next = stepPlayerRuntimeTime(jumped, 10_000);
  }
  assert.deepEqual(steps, [6_000, 10_000]);
  const late = loaded();
  const media = late.state.backgroundActions.find((action) => action.kind === "media");
  assert.ok(media?.kind === "media");
  const observed = observePlayerRuntimeTime(late, 10_000, [
    { mediaId: media.media.mediaId, segment: media.media.segment, progressMs: 10_000 },
  ]).session;
  assert.deepEqual(said(jumped), ["ticks done"]);
  assert.deepEqual(canonical(jumped), canonical(observed));
});

test("after a jump the device plays from the jumped playhead and measures on from there", () => {
  const player = harness(
    'let music = playAudio async repeat "loop.mp3" {\n  at 3 s {\n    say "cue ${music.position}"\n  }\n}\nlet e = showButton "Done"\nexit',
  );
  player.start();
  const [element] = player.elements;
  element!.metadata(4);
  player.tick(1_000);
  const segment = player.session.state.backgroundActions.find((action) => action.kind === "media");
  player.jump(3_500);
  assert.deepEqual(player.texts(), ["cue 3 seconds"]);
  // The jump stays in the segment, so only the jump moves the element.
  assert.equal(element!.position, 3.5);
  assert.equal(element!.paused, false);
  player.tick(400);
  const media = player.session.state.backgroundActions.find((action) => action.kind === "media");
  assert.ok(media?.kind === "media" && segment?.kind === "media");
  assert.equal(media.media.segment, segment.media.segment);
  assert.equal(
    media.media.points.at(-1)!.progressMs,
    3_900,
    "the seek is not measured as playback",
  );
});

// The composable, loaded through the build tool like the Player loads it.
interface DevelopmentTimeHost {
  readonly autoSkip: Ref<boolean>;
  readonly canAdvance: Readonly<Ref<boolean>>;
  advanceBy(milliseconds: number): Promise<void>;
}
interface SessionHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  prepare(create: () => PlayerRuntimeSession): void;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): Promise<void>;
  update(next: PlayerRuntimeSession): void;
  observe(): PlayerRuntimeSession | null;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
}
let usePlayerSession: (options: { scriptStorage?: ScriptStorageProvider }) => SessionHost;
let useDevelopmentTime: (
  player: SessionHost,
  initial: { autoSkip: boolean },
  log: (text: string) => void,
) => DevelopmentTimeHost;
interface DebugHost {
  readonly menu: Ref<boolean>;
  readonly active: Ref<boolean>;
  readonly log: Readonly<
    Ref<{ readonly lines: Readonly<Ref<readonly { text: string }[]>> } | null>
  >;
  readonly time: Readonly<Ref<DevelopmentTimeHost | null>>;
  readonly countdownText: Readonly<Ref<string | null>>;
}
let usePlayerDebug: (
  player: SessionHost,
  initial: { menu: boolean; autoSkip: boolean },
) => DebugHost;

before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const session: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerSession.ts",
    );
    const time: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/useDevelopmentTime.ts",
    );
    const debug: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerDebug.ts",
    );
    assert.equal(typeof debug.usePlayerDebug, "function");
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its host API.
    usePlayerDebug = debug.usePlayerDebug as typeof usePlayerDebug;
    assert.equal(typeof session.usePlayerSession, "function");
    assert.equal(typeof time.useDevelopmentTime, "function");
    // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their host API.
    usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
    // EVIDENCE: validation: as above.
    useDevelopmentTime = time.useDevelopmentTime as typeof useDevelopmentTime;
  } finally {
    await server.close();
  }
});

// The browser surface the session host uses without a camera.
function stubBrowser(context: TestContext) {
  const values = {
    document: new EventTarget(),
    window: new EventTarget(),
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

async function mount(
  context: TestContext,
  source: string,
  initial: { autoSkip: boolean },
  scriptStorage?: ScriptStorageProvider,
) {
  stubBrowser(context);
  const scope = effectScope();
  const logged: string[] = [];
  const mounted = scope.run(() => {
    const player = usePlayerSession(scriptStorage === undefined ? {} : { scriptStorage });
    const time = useDevelopmentTime(player, initial, (text) => logged.push(text));
    return { player, time, logged, unmount: () => scope.stop() };
  });
  assert.ok(mounted);
  context.after(() => scope.stop());
  await mounted.player.loadScriptStorage();
  mounted.player.prepare(() =>
    createPlayerRuntimeSession(source, mounted.player.scriptStorageOptions()),
  );
  await mounted.player.activate();
  return mounted;
}

const later = () => new Promise((resolve) => setTimeout(resolve, 20));

test("+10 s continues after the host stores a block's write, at the block's scene time", async (context) => {
  const writes: string[] = [];
  const { player, time, logged } = await mount(
    context,
    'timer async 2 {\n  save 1 as "seen"\n  say "saved", instant\n}\nlet elapsed = showButton "Done"\nexit',
    { autoSkip: false },
    {
      scope: "test",
      load: async () => [],
      write: async (key) => void writes.push(key),
      replace: async () => {},
      clear: async () => {},
    },
  );
  await time.advanceBy(10_000);
  const session = player.session.value!;
  assert.deepEqual(writes, ["seen"]);
  assert.deepEqual(said(session), ["saved"]);
  assert.ok(session.state.observedSessionTimeMs >= 10_000);
  assert.deepEqual(
    session.events.flatMap((event) =>
      event.kind === "actionCompleted" && event.settlement.actionKind === "storageWrite"
        ? [event.settlement.completedAtMs]
        : [],
    ),
    [2_000],
  );
  assert.deepEqual(logged, ["⏩ 10 s skipped"]);
});

test("+10 s works during chat pacing, also from a pending save, and not after the session ended", async (context) => {
  let answer = () => {};
  const { player, time, logged } = await mount(
    context,
    'save 1 as "seen"\nsay "First", 20\nsay "Second"\nlet done = showButton "Done"\nexit',
    { autoSkip: false },
    {
      scope: "test",
      load: async () => [],
      write: () => new Promise<void>((resolve) => (answer = resolve)),
      replace: async () => {},
      clear: async () => {},
    },
  );
  // The jump starts while the host stores the save and continues once it answered.
  assert.equal(player.session.value!.state.foregroundAction?.kind, "storageWrite");
  assert.equal(time.canAdvance.value, true);
  const jumped = time.advanceBy(10_000);
  await later();
  answer();
  await jumped;
  let session = player.session.value!;
  assert.ok(session.state.observedSessionTimeMs >= 10_000);
  assert.equal(session.state.foregroundAction?.kind, "chatPacingGate");
  assert.deepEqual(said(session), ["First"], "First paces for 20 s");
  // A jump during the pause passes its end, and the next message follows.
  assert.equal(time.canAdvance.value, true);
  await time.advanceBy(10_000);
  session = player.session.value!;
  assert.deepEqual(said(session), ["First", "Second"]);
  assert.deepEqual(logged, ["⏩ 10 s skipped", "⏩ 10 s skipped"]);
  player.update(activatePlayerRuntimeButton(session)!.session);
  assert.equal(player.session.value!.state.status, "halted");
  assert.equal(time.canAdvance.value, false);
});

test("a jump logs only the scene time it advanced, not real time observed while the host answered", async (context) => {
  let answer = () => {};
  const { player, time, logged } = await mount(
    context,
    'save 1 as "seen"\nsay "First", 20\nlet done = showButton "Done"\nexit',
    { autoSkip: false },
    {
      scope: "test",
      load: async () => [],
      write: () => new Promise<void>((resolve) => (answer = resolve)),
      replace: async () => {},
      clear: async () => {},
    },
  );
  const jumped = time.advanceBy(50);
  // After one task the jump has observed its start and waits for the host to store the save.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const targetMs = player.session.value!.state.observedSessionTimeMs + 50;
  // Ordinary observations, as a timer's wake-up makes, pass that target meanwhile; the jump ends without a step.
  for (let waited = 0; player.session.value!.state.observedSessionTimeMs < targetMs; waited += 10) {
    assert.ok(waited < 5_000, "real time was not observed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    player.observe();
  }
  answer();
  await jumped;
  assert.deepEqual(logged, []);
});

test("auto-skip completes waits but leaves the player's think time and background timers real", async (context) => {
  const { player } = await mount(
    context,
    'wait 30\nlet first = showButton "Done"\ntimer async 5 { say "timer", instant }\nlet second = showButton "Again"\nexit',
    { autoSkip: true },
  );
  await later();
  let session = player.session.value!;
  assert.equal(session.state.foregroundAction?.kind, "interaction");
  const skippedTo = session.state.observedSessionTimeMs;
  assert.ok(skippedTo >= 30_000 && skippedTo < 31_000, `${skippedTo}`);
  player.update(activatePlayerRuntimeButton(session)!.session);
  await later();
  session = player.session.value!;
  assert.deepEqual(said(session), ["Done"], "the timer runs in real time while Again waits");
  assert.ok(session.state.observedSessionTimeMs < skippedTo + 1_000);
});

test("a long jump yields between tasks, and unmounting the Player stops it", async (context) => {
  const { player, time, logged, unmount } = await mount(
    context,
    'timer(duration: 1 ms, async: true, repeat: true) {\n  let x = 1\n}\nlet e = showButton "Done"\nexit',
    { autoSkip: false },
  );
  const fromMs = player.session.value!.state.observedSessionTimeMs;
  let yielded = false;
  setTimeout(() => {
    yielded = true;
    unmount();
  }, 0);
  await time.advanceBy(60_000);
  assert.ok(yielded, "the jump let other tasks run");
  const reachedMs = player.session.value!.state.observedSessionTimeMs;
  assert.ok(reachedMs > fromMs && reachedMs < fromMs + 60_000, `${fromMs} → ${reachedMs}`);
  assert.equal(logged.length, 1, "the part that was jumped is logged");
});

async function mountDebug(
  context: TestContext,
  source: string,
  initial: { menu: boolean; autoSkip: boolean },
) {
  stubBrowser(context);
  const scope = effectScope();
  const mounted = scope.run(() => {
    const player = usePlayerSession({});
    return { player, debug: usePlayerDebug(player, initial) };
  });
  assert.ok(mounted);
  context.after(() => scope.stop());
  mounted.player.prepare(() => createPlayerRuntimeSession(source));
  await mounted.player.activate();
  return mounted;
}

test("Debug off ends auto-skip and a running jump, and Debug on again starts with auto-skip off", async (context) => {
  const { player, debug } = await mountDebug(
    context,
    'timer(duration: 1 ms, async: true, repeat: true) {\n  let x = 1\n}\nlet e = showButton "Done"\nexit',
    { menu: true, autoSkip: true },
  );
  const timeNow = () => debug.time.value;
  const time = timeNow();
  assert.ok(time);
  assert.equal(time.autoSkip.value, true);
  const fromMs = player.session.value!.state.observedSessionTimeMs;
  setTimeout(() => (debug.active.value = false), 0);
  await time.advanceBy(60_000);
  const reachedMs = player.session.value!.state.observedSessionTimeMs;
  assert.ok(
    reachedMs < fromMs + 60_000,
    `the jump went on after Debug off: ${fromMs} → ${reachedMs}`,
  );
  assert.equal(timeNow(), null);
  // The log stays while the menu is on, with the part that was jumped.
  assert.equal(debug.log.value?.lines.value.length, 1);
  debug.active.value = true;
  assert.equal(timeNow()?.autoSkip.value, false);
  // The menu off removes the log too; on again switches Debug on with an empty log.
  debug.active.value = false;
  debug.menu.value = false;
  const logNow = () => debug.log.value;
  assert.equal(logNow(), null);
  debug.menu.value = true;
  assert.equal(debug.active.value, true);
  assert.deepEqual(logNow()?.lines.value, []);
});

test("a countdown shows while Debug runs, not before Continue, and follows display time", async (context) => {
  const { player, debug } = await mountDebug(context, "wait 5 s\nexit", {
    menu: false,
    autoSkip: false,
  });
  assert.equal(debug.countdownText.value, null, "the Debug menu starts off");
  debug.menu.value = true;
  assert.equal(debug.countdownText.value, "Debug · Continues in 5 s");
  player.update(observePlayerRuntimeTime(player.session.value!, 1_200).session);
  assert.equal(debug.countdownText.value, "Debug · Continues in 4 s");
  debug.active.value = false;
  assert.equal(debug.countdownText.value, null);
  debug.active.value = true;
  // A restored session waits for Continue before its countdown shows.
  player.prepareRestore(player.session.value!);
  assert.equal(player.activation.value, "continue");
  assert.equal(debug.countdownText.value, null);
  await player.activate();
  assert.equal(debug.countdownText.value, "Debug · Continues in 4 s");
});
