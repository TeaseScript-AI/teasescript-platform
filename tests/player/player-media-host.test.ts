import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, shallowRef, type Ref } from "vue";

import type * as CompileProject from "../../player/runtime/compile-project.js";
import type * as InProcess from "../../player/engine-bridge/in-process.js";
import type { BridgeClient } from "../../player/engine-bridge/client.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type {
  PlayerRuntimeSession,
  PlayerRuntimeSessionOptions,
} from "../../player/runtime/runtime-adapter.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { loadPlayerModule } from "../helpers/player-modules.js";

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
  prepare(create: (recording: PlayerRuntimeSessionOptions) => PlayerRuntimeSession): void;
  activate(): Promise<void>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly resolveAsset: (path: string) => string | null;
}) => MediaHost;
let usePlanPhotoPreload: (
  shown: () => PlanPhotoSource | null,
  resolveAsset: (path: string) => string | null,
  preload: (sources: readonly string[]) => () => void,
) => void;
let facade: typeof InProcess;
let compiler: typeof CompileProject;

before(async () => {
  const module = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is its host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  const photos = await loadPlayerModule("player/vue/src/stage/stagePhotos.ts");
  assert.equal(typeof photos.usePlanPhotoPreload, "function");
  // EVIDENCE: validation: the real module's export, checked callable just above.
  usePlanPhotoPreload = photos.usePlanPhotoPreload as typeof usePlanPhotoPreload;
  // EVIDENCE: validation: the bundle the composable runs in, whose host it uses.
  facade = (await loadPlayerModule("player/engine-bridge/in-process.ts")) as typeof facade;
  // EVIDENCE: validation: the bundle's compiler module, from the same module graph.
  compiler = (await loadPlayerModule("player/runtime/compile-project.ts")) as typeof compiler;
});

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const later = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** Audio elements the composable made, which a test makes load. */
type FakeAudio = EventTarget & { src: string; duration: number };

/** The real composable on an in-process host that replies after `delayMs`, in a surface with fake audio. */
async function mount(context: TestContext, delayMs: number) {
  const elements: FakeAudio[] = [];
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class extends EventTarget {
      src = "";
      preload = "";
      volume = 1;
      duration = 3;
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
  // Every request the Player posts, as posted.
  const posted: { readonly op: string; readonly session: string | null }[] = [];
  const clone = globalThis.structuredClone;
  context.after(() => void (globalThis.structuredClone = clone));
  globalThis.structuredClone = <T>(value: T, options?: StructuredSerializeOptions): T => {
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "request" &&
      "op" in value &&
      typeof value.op === "string" &&
      "session" in value
    )
      posted.push({
        op: value.op,
        session: typeof value.session === "string" ? value.session : null,
      });
    return clone(value, options);
  };
  const bridge = facade.createInProcessBackend(BUILD, { delayMs });
  const scope = effectScope();
  const player = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(bridge),
      debugHistorySpill: async () => null,
      resolveAsset: (path) => `https://fixture/${path}`,
    }),
  )!;
  context.after(() => {
    scope.stop();
    bridge.client.terminate();
  });
  await player.bridge;
  const start = async (script: string) => {
    player.prepare((recording) =>
      compiler.createPlayerRuntimeSession(script, { ...recording, wallClockMs: 0 }),
    );
    await player.activate();
  };
  const reports = () => posted.filter((request) => request.op === "reportMediaLoad");
  return { player, elements, start, reports };
}

const transcript = (player: MediaHost) =>
  player.session.value?.transcriptEntries.map((entry) => entry.text) ?? [];

for (const delayMs of [0, 50, 250])
  test(`a medium's load report goes over the bridge once and the script goes on (${delayMs} ms late)`, async (context) => {
    const { player, elements, start, reports } = await mount(context, delayMs);
    await start('playAudio async "bell.mp3"\nsay "after", instant\nshowButton "Done"\nexit');
    for (let turn = 0; !elements.some((element) => element.src.endsWith("bell.mp3")); turn++) {
      assert.ok(turn < 200, "the medium did not start");
      await later();
    }
    elements
      .find((element) => element.src.endsWith("bell.mp3"))!
      .dispatchEvent(new Event("loadedmetadata"));
    for (let turn = 0; !transcript(player).includes("after"); turn++) {
      assert.ok(turn < 400, "the script did not go on");
      await later();
    }
    await later(delayMs + 20);
    assert.equal(reports().length, 1, "one report, delivered once");
  });

test("a replaced session's load report never reaches the session that replaced it", async (context) => {
  const { player, elements, start, reports } = await mount(context, 50);
  await start('playAudio async "old.mp3"\nshowButton "Old"\nexit');
  for (let turn = 0; !elements.some((element) => element.src.endsWith("old.mp3")); turn++) {
    assert.ok(turn < 200, "the old medium did not start");
    await later();
  }
  const old = elements.find((element) => element.src.endsWith("old.mp3"))!;
  // The new session's medium has the same media ID as the old one's, as IDs restart per session.
  await start('playAudio async "new.mp3"\nsay "new after", instant\nshowButton "New"\nexit');
  const replacing = player.session.value!.id;
  old.dispatchEvent(new Event("loadedmetadata"));
  for (let turn = 0; !elements.some((element) => element.src.endsWith("new.mp3")); turn++) {
    assert.ok(turn < 200, "the new medium did not start");
    await later();
  }
  elements
    .find((element) => element.src.endsWith("new.mp3"))!
    .dispatchEvent(new Event("loadedmetadata"));
  for (let turn = 0; !transcript(player).includes("new after"); turn++) {
    assert.ok(turn < 400, "the new session did not go on");
    await later();
  }
  await later(80);
  assert.deepEqual(
    reports().map((request) => request.session),
    [replacing],
    "only the new session's own report",
  );
});

/** A host whose `planMetadata` replies wait for the test, and records what was preloaded and released. */
function preloadHost() {
  const replies: { readonly plan: string; readonly reply: (images: string[] | null) => void }[] =
    [];
  const connection = (name: string): PlanPhotoSource["connection"] => ({
    client: {
      request: (_op, args) =>
        new Promise((resolve) =>
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
    },
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
