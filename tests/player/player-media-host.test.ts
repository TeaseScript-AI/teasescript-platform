import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, shallowRef, type Ref } from "vue";

import type { BridgeClient } from "../../player/engine-bridge/client.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { runtimeInput, presentedAction } from "../helpers/player/player-input.js";
import { rebuildRecordedSession } from "../../player/debug/debug-export.js";
import type { DebugRecording } from "../../player/debug/debug-recorder.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import type { BridgeResult } from "../../player/engine-bridge/client.js";
import { sourceStart, type PlanStart } from "../helpers/prepared-plan.js";
import { serializeCheckpoint } from "../../src/runtime/snapshot/checkpoint.js";
import {
  loadTopology,
  rerunRegistry,
  TOPOLOGIES,
  topologyBridge,
  type Topology,
  withinHostTime,
} from "../helpers/player/worker-topology.js";

/*
 * L5d in the Player: its media load reports over the bridge, through the real composable on a host that replies late,
 * and the Stage photo preload, which reads the plan's images from the host by token.
 */

/** What the Stage preload reads of the shown session, as `stagePhotos.ts`'s `PlanPhotoSource`. */
interface PlanPhotoSource {
  readonly connection: { readonly client: Pick<BridgeClient, "request"> };
  readonly planToken: string;
}

interface MediaHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  readonly inputSection: import("../../player/vue/src/session/runtime-input.js").InputSectionHost;
  debugRecording(): Promise<import("../../player/debug/debug-recorder.js").DebugRecording | null>;
  prepare(create: PlanStart): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly resolveAsset: (path: string) => string | null;
}) => MediaHost;
let usePlanPhotoPreload: (
  shown: () => PlanPhotoSource | null,
  resolveAsset: (path: string) => string | null,
  preload: (sources: readonly string[]) => () => void,
) => void;

before(async () => {
  await loadTopology();
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  const photos = await loadPlayerModule("player/vue/src/stage/stagePhotos.ts");
  assert.equal(typeof photos.usePlanPhotoPreload, "function");
  // EVIDENCE: validation: the real module's export, checked callable just above.
  usePlanPhotoPreload = photos.usePlanPhotoPreload as typeof usePlanPhotoPreload;
});

const later = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** Audio elements the composable made, which a test makes load. */
type FakeAudio = EventTarget & {
  src: string;
  duration: number;
  currentTime: number;
  paused: boolean;
};

/** The real composable on `topology`, in a surface with fake audio. */
async function mount(context: TestContext, topology: Topology) {
  const elements: FakeAudio[] = [];
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class extends EventTarget {
      src = "";
      preload = "";
      volume = 1;
      duration = 30;
      paused = true;
      ended = false;
      currentTime = 0;
      constructor() {
        super();
        elements.push(this);
      }
      play = async () => {
        this.paused = false;
      };
      pause() {
        this.paused = true;
      }
      load() {}
      removeAttribute() {
        this.src = "";
      }
    },
  };
  for (const [name, value] of Object.entries(surface)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const transport = await topologyBridge(context, topology);
  const bridge = transport.bridge;
  const queued = { current: 0, maximum: 0 };
  const openSection = bridge.client.section.bind(bridge.client);
  context.mock.method(bridge.client, "section", (...args: Parameters<typeof openSection>) => {
    const [id, ticket, body] = args;
    queued.current += 1;
    const result = openSection(id, ticket, (send) => {
      queued.current -= 1;
      return body(send);
    });
    queued.maximum = Math.max(queued.maximum, queued.current);
    return result;
  });
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(bridge),
      resolveAsset: (path) => `https://fixture/${path}`,
    }),
  )!;
  context.after(() => scope.stop());
  await player.bridge;
  transport.assertTopology();
  // Every request the Player posts, as it reached the port.
  const posted = transport.posts;
  const start = async (script: string) => {
    player.prepare(await sourceStart(player.bridge, script, () => ({ wallClockMs: 0 })));
    await player.activate();
  };
  const reports = () => posted.filter((request) => request.op === "reportMediaLoad");
  return { player, elements, start, reports, posted, queued };
}

const transcript = (player: MediaHost) =>
  player.session.value?.transcriptEntries.map((entry) => entry.text) ?? [];

/* The rows on a Worker, whose replies come as they come (L5i.7). The file's end checks every registered row ran. */
const RERUN = rerunRegistry({
  "load report": TOPOLOGIES,
  "replaced session's report": TOPOLOGIES,
  "scene time": TOPOLOGIES,
});

RERUN.rows(
  "load report",
  "a medium's load report goes over the bridge once and the script goes on",
  async (context, topology, end) => {
    const { player, elements, start, reports } = await mount(context, topology);
    await start('playAudio async "bell.mp3"\nsay "after", instant\nshowButton "Done"\nexit');
    for (
      const within = withinHostTime();
      !elements.some((element) => element.src.endsWith("bell.mp3"));
    ) {
      assert.ok(within(), "the medium did not start");
      await later();
    }
    elements
      .find((element) => element.src.endsWith("bell.mp3"))!
      .dispatchEvent(new Event("loadedmetadata"));
    for (const within = withinHostTime(); !transcript(player).includes("after");) {
      assert.ok(within(), "the script did not go on");
      await later();
    }
    await later(70);
    assert.equal(reports().length, 1, "one report, delivered once");
    return end();
  },
);

RERUN.rows(
  "replaced session's report",
  "a replaced session's load report never reaches the session that replaced it",
  async (context, topology, end) => {
    const { player, elements, start, reports } = await mount(context, topology);
    await start('playAudio async "old.mp3"\nshowButton "Old"\nexit');
    for (
      const within = withinHostTime();
      !elements.some((element) => element.src.endsWith("old.mp3"));
    ) {
      assert.ok(within(), "the old medium did not start");
      await later();
    }
    const old = elements.find((element) => element.src.endsWith("old.mp3"))!;
    // The new session's medium has the same media ID as the old one's, as IDs restart per session.
    await start('playAudio async "new.mp3"\nsay "new after", instant\nshowButton "New"\nexit');
    const replacing = player.session.value!.id;
    old.dispatchEvent(new Event("loadedmetadata"));
    for (
      const within = withinHostTime();
      !elements.some((element) => element.src.endsWith("new.mp3"));
    ) {
      assert.ok(within(), "the new medium did not start");
      await later();
    }
    elements
      .find((element) => element.src.endsWith("new.mp3"))!
      .dispatchEvent(new Event("loadedmetadata"));
    for (const within = withinHostTime(); !transcript(player).includes("new after");) {
      assert.ok(within(), "the new session did not go on");
      await later();
    }
    await later(80);
    assert.deepEqual(
      reports().map((request) => request.session),
      [replacing],
      "only the new session's own report",
    );
    return end();
  },
);

/** A host whose `planMetadata` replies wait for the test, and records what was preloaded and released. */
function preloadHost() {
  const replies: { readonly plan: string; readonly reply: (images: string[] | null) => void }[] =
    [];
  const connection = (name: string): PlanPhotoSource["connection"] => ({
    // EVIDENCE: test: a fake of the transport, which answers any op, typed as the client.
    client: {
      request: (_op: string, args: unknown) =>
        new Promise<BridgeResult>((resolve) =>
          replies.push({
            plan: `${name}:${typeof args === "object" && args !== null && "plan" in args ? String(args.plan) : ""}`,
            reply: (images) =>
              resolve({
                session: null,
                revision: null,
                eventsThrough: null,
                result: images === null ? null : { stageImages: images },
                view: null,
              }),
          }),
        ),
    } as Pick<BridgeClient, "request">,
  });
  const log: string[] = [];
  const preload = (sources: readonly string[]) => {
    log.push(`preload ${sources.join(",")}`);
    return () => log.push(`release ${sources.join(",")}`);
  };
  return { replies, connection, log, preload };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a Stage preload whose reply comes after an unmount or another plan preloads nothing", async () => {
  const { replies, connection, log, preload } = preloadHost();
  const a = connection("A");
  const b = connection("B");
  const shown = shallowRef<PlanPhotoSource | null>({ connection: a, planToken: "p1" });
  const scope = effectScope();
  scope.run(() =>
    usePlanPhotoPreload(
      () => shown.value,
      (path) => `/${path}`,
      preload,
    ),
  );
  assert.deepEqual(
    replies.map((each) => each.plan),
    ["A:p1"],
  );
  // Another session of the same plan on the same connection asks nothing again.
  shown.value = { connection: a, planToken: "p1" };
  await flush();
  assert.equal(replies.length, 1);
  // Tokens restart per connection: B's p1 is another plan. A's late reply preloads nothing.
  shown.value = { connection: b, planToken: "p1" };
  await flush();
  replies[0]!.reply(["a.jpg"]);
  await flush();
  assert.deepEqual(log, []);
  replies[1]!.reply(["b.jpg"]);
  await flush();
  assert.deepEqual(log, ["preload /b.jpg"]);
  // A newer plan preloads before the previous preload is released.
  shown.value = { connection: b, planToken: "p2" };
  await flush();
  replies[2]!.reply(["c.jpg"]);
  await flush();
  assert.deepEqual(log, ["preload /b.jpg", "preload /c.jpg", "release /b.jpg"]);
  // An unmount while a reply is awaited: it preloads nothing, and the current preload is released.
  shown.value = { connection: b, planToken: "p3" };
  await flush();
  scope.stop();
  replies[3]!.reply(["d.jpg"]);
  await flush();
  assert.deepEqual(log, ["preload /b.jpg", "preload /c.jpg", "release /b.jpg", "release /c.jpg"]);
});

/*
 * The preload's reply identity, over a declared family: a reply settles before or after the watcher's next run, and
 * meanwhile the shown session moves to another connection, to another plan on the same connection, or the scope ends.
 * In every case the obsolete reply preloads nothing.
 */
const SETTLES = ["before the watcher runs", "after the watcher runs"] as const;
const CHANGES = ["another connection", "another plan", "an unmount"] as const;
const REPLY_CASES = SETTLES.flatMap((settles) =>
  CHANGES.map((change) => ({ settles, change, name: `${settles}, ${change}` })),
);

test("the reply-identity family covers every pair of its axes", () => {
  for (const settles of SETTLES)
    for (const change of CHANGES)
      assert.ok(REPLY_CASES.some((each) => each.name === `${settles}, ${change}`));
  assert.equal(new Set(REPLY_CASES.map((each) => each.name)).size, SETTLES.length * CHANGES.length);
});

for (const { settles, change, name } of REPLY_CASES)
  test(`an obsolete preload reply preloads nothing: ${name}`, async () => {
    const { replies, connection, log, preload } = preloadHost();
    const a = connection("A");
    const shown = shallowRef<PlanPhotoSource | null>({ connection: a, planToken: "p1" });
    const scope = effectScope();
    scope.run(() =>
      usePlanPhotoPreload(
        () => shown.value,
        (path) => `/${path}`,
        preload,
      ),
    );
    assert.equal(replies.length, 1);
    const move = () => {
      if (change === "another connection")
        shown.value = { connection: connection("B"), planToken: "p1" };
      else if (change === "another plan") shown.value = { connection: a, planToken: "p2" };
      else scope.stop();
    };
    if (settles === "before the watcher runs") {
      // The reply settles, then the session moves in the same tick, before Vue runs the watcher again.
      replies[0]!.reply(["old.jpg"]);
      move();
    } else {
      move();
      await flush();
      replies[0]!.reply(["old.jpg"]);
    }
    await flush();
    assert.deepEqual(log, [], "the old plan's images are not preloaded");
    scope.stop();
  });

/** `observeTime`'s arguments, as the clock posts them. */
function observeArgs(args: unknown): { readonly atMs: number; readonly media: readonly unknown[] } {
  // EVIDENCE: fixture: the posts this reads are `observeTime` requests, whose arguments the host checks.
  return args as { readonly atMs: number; readonly media: readonly unknown[] };
}

/** Lets the replies, publications and scheduling a mock-clock step caused run to their end. */
async function drainTasks() {
  for (let n = 0; n < 30; n++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** What the scene time row allows one reply on mock time. */
const REPLY_MS = 50;

RERUN.rows(
  "scene time",
  "with media sampling and replies from a Worker, scene time follows the clock and the session advances",
  async (context, topology, end) => {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let now = 0;
    context.mock.method(performance, "now", () => now);
    const player = await mount(context, topology);
    let started = false;
    // The page's clock when the Start showed, its scene time's 0: after its script's prepare and its `start` reply.
    let startedAt = 0;
    let startError: unknown;
    void player.start('playAudio async "clock.mp3"\nwait 1.5 s\nshowButton "Done"\nexit').then(
      () => {
        started = true;
        startedAt = now;
      },
      (e) => {
        startError = e;
      },
    );
    const advance = async (ms: number) => {
      for (let i = 0; i < ms; i++) {
        now++;
        for (const audio of player.elements) if (!audio.paused) audio.currentTime += 0.001;
        context.mock.timers.tick(1);
        await drainTasks();
      }
    };
    // How long a wait on the host may step the mocked clock: a Worker's replies take real time, which no count of steps
    // bounds and `until` cannot wait on here (the test mocks its timers), so as long as a wait on the host may take.
    const waiting = withinHostTime;
    for (const more = waiting(); !started && !startError && more();) await advance(1);
    if (startError) throw startError;
    assert.equal(started, true, "start reply releases on mock time");
    for (
      const more = waiting();
      !player.elements.some((a) => a.src.endsWith("clock.mp3")) && more();
    )
      await advance(1);
    const audio = player.elements.find((a) => a.src.endsWith("clock.mp3"));
    assert.ok(audio, "audio created");
    audio.dispatchEvent(new Event("loadedmetadata"));
    let buttonAt: number | null = null;
    let waitDeadline: number | null = null;
    for (let n = 0; n < 3500; n++) {
      await advance(1);
      const foreground = player.player.session.value?.state.foregroundAction;
      if (waitDeadline === null && foreground?.kind === "delay")
        waitDeadline = foreground.deadlineMs;
      if (
        buttonAt === null &&
        player.player.session.value?.state.foregroundAction?.kind === "interaction"
      )
        buttonAt = now;
    }
    const shown = player.player.session.value!;
    const observations = player.posted
      .filter((p) => p.op === "observeTime")
      .map((p) => ({ wall: p.at, ...observeArgs(p.args) }));
    const lags = observations.map((p) => p.wall - p.atMs);
    assert.ok(
      observations.filter((p) => p.media.length > 0).length >= 5,
      "multiple loaded-media observations",
    );
    assert.ok(
      buttonAt !== null &&
        waitDeadline !== null &&
        buttonAt - startedAt <= waitDeadline + 3 * REPLY_MS,
      "shown button by wait plus three replies",
    );
    assert.ok(Math.max(...lags) - Math.min(...lags) < 0.001, "turn freshness");
    assert.ok(
      player.queued.maximum <= 2,
      "no periodic backlog beyond startup/media service section",
    );
    // The host's session as shown now, read over the bridge as its checkpoint, and the host's recording: both queued in
    // one turn behind the session's earlier requests, one after the other, so no session work comes between them; both
    // reply on mock time.
    const onMockTime = async <T>(reading: Promise<T>, what: string): Promise<T> => {
      let replied = false;
      void reading.then(
        () => void (replied = true),
        () => void (replied = true),
      );
      for (const more = waiting(); !replied && more();) await advance(1);
      assert.equal(replied, true, `${what} replies on mock time`);
      return reading;
    };
    const bridge = await player.player.bridge;
    const shownNow = player.player.session.value!;
    const checkpointRead = bridge.read(shownNow, "captureCheckpoint");
    const recordingRead = bridge.client.request(
      "readRecording",
      { ticket: null },
      { after: shownNow.id },
    );
    const shownOnHost = await onMockTime(checkpointRead, "the checkpoint's read");
    // EVIDENCE: validation: `readRecording` replies from the same build with the recording or `null`.
    const recording = (await onMockTime(recordingRead, "the recording's read"))
      .result as DebugRecording;
    const rebuilt = rebuildRecordedSession(
      recording.plan,
      recording.anchorSnapshot,
      recording.operations,
    );
    assert.equal(
      serializeCheckpoint(rebuilt.exportCheckpoint()),
      shownOnHost.checkpointJson,
      "delayed loaded-media recording replays",
    );
    const input = await runtimeInput();
    const beganInput = now;
    let inputResult: string | null = null;
    let inputError: unknown;
    void input
      .runInput(
        player.player.inputSection,
        presentedAction(shown),
        presentedAction,
        input.intents.choice(null, "button"),
      )
      .then(
        (result) => {
          inputResult = result.kind;
        },
        (error) => {
          inputError = error;
        },
      );
    for (let i = 0; inputResult === null && !inputError && i < 4 * REPLY_MS; i++) await advance(1);
    if (inputError) throw inputError;
    assert.equal(inputResult, "answered", "real input remains responsive during sampling");
    assert.ok(
      now - beganInput <= 3 * REPLY_MS,
      "input waits at most one periodic reply, its observation, and its answer",
    );
    return end();
  },
);
