import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import {
  activatePlayerRuntimeButton as rawActivatePlayerRuntimeButton,
  advancePlayerRuntimeTime,
  createPlayerRuntimeRestorePoint,
  playerRuntimeSnapshotJson,
  restorePlayerRuntimeSession,
  resumePlayerRuntimeRandomDraw,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../../player/runtime/runtime-adapter.js";
import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import { preparedPlan } from "../helpers/prepared-plan.js";
import { playerRuntimeAwaitsHost, type PlayerSession } from "../../player/runtime/runtime-view.js";
import {
  memoryKeptRoomStore,
  memoryKeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import type { DebugRecorder } from "../../player/debug/debug-recorder.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import {
  listRandomSites,
  type InstructionPlan,
  type RandomControlOptions,
  type RandomDrawView,
  type RandomOutcome,
  type RandomSite,
  type RuntimeScriptStorageEntrySnapshot,
} from "../../src/index.js";
import { coverageGaps, product } from "../helpers/family-coverage.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { drawCode, fileCode, outcomeLines } from "../../player/debug/random-draw-code.js";
import { loadSourceDebugSidecar } from "../../src/runtime/debug/source-sidecar.js";
import { createSourceDebugSidecar } from "../../src/index.js";
import { NO_MARKS } from "../../player/debug/debug-history-marks.js";
import { loadHostFacade, onHost } from "../helpers/player/host-sessions.js";
import { clockTicket } from "../helpers/clock-ticket.js";

// The button press on a session the composable's host holds (`OnHost`).
const activatePlayerRuntimeButton = onHost(rawActivatePlayerRuntimeButton);

// Debug's random draws (DEBUGGER.md "Random draws") through the real Vue session host and engine: with Choose outcomes
// on in the debug room, a session pauses at every draw and goes on with the outcome the picker gives; Next time and
// Least tried decide from what each site took; turning the feature off goes on naturally. The picker's code and
// outcome presentation comes from the compiler's own lexer and parser.
interface RandomHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly rooms: { readonly current: Readonly<Ref<"normal" | "debug">> };
  readonly bridge: Promise<PlayerBridge>;
  prepareScript(
    plan: string,
    create:
      | ((recording: {
          readonly recorder: DebugRecorder;
          readonly debugMode: boolean;
          readonly randomControl?: RandomControlOptions;
        }) => PlayerRuntimeSession)
      | { readonly plan: string; readonly options: () => object },
  ): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  activate(): Promise<void>;
  showSession(next: PlayerRuntimeSession | PlayerSession): void;
  prepareInput(): true | Promise<boolean>;
  update(session: PlayerRuntimeSession): void;
  prepareRestore(restored: PlayerRuntimeSession | PlayerSession): void;
  randomTried(
    site: string,
  ): Promise<{
    readonly history: readonly string[];
    readonly first: number;
    readonly counts: readonly (readonly [string, number])[];
    readonly revision: number;
  } | null>;
}
interface DebugRandom {
  readonly enabled: Ref<boolean>;
  readonly draw: Readonly<Ref<RandomDrawView | null>>;
  setNext(site: string, next: "ask" | "random" | "untried"): void;
  resolve(outcome: RandomOutcome | "natural"): Promise<boolean>;
  resolveLeastTried(): Promise<boolean>;
  readonly sites: Readonly<Ref<ReadonlyMap<string, RandomSite>>>;
  readonly code: Readonly<Ref<{ readonly lines: readonly CodeLine[] } | null>>;
  readonly historyLines: Readonly<Ref<readonly CodeLine[]>>;
  tried(site: string): {
    readonly history: readonly string[];
    readonly first: number;
    readonly counts: ReadonlyMap<string, number>;
  };
}
interface CodeLine {
  readonly number: number;
  readonly segments: readonly {
    readonly text: string;
    readonly kind: string | null;
    readonly mark: boolean;
  }[];
}
interface Presentation {
  /** The picker's code for `site` in `source`, made as the Worker makes it: from the plan's source debug sidecar. */
  randomDrawCode(
    source: string,
    site: RandomSite,
  ): {
    readonly lines: readonly CodeLine[];
    readonly enclosing: {
      readonly kind: string;
      readonly from: number;
      readonly to: number;
    } | null;
  } | null;
  outcomeLines(outcomes: readonly string[], first?: number): readonly CodeLine[];
  randomDrawChoices(
    draw: RandomDrawView,
  ):
    | {
        readonly kind: "buttons";
        readonly outcomes: readonly { readonly outcome: RandomOutcome; readonly label: string }[];
      }
    | {
        readonly kind: "number";
        readonly hint: string;
        readonly refusal: (value: number) => string | null;
      }
    | { readonly kind: "order"; readonly items: readonly string[] };
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  keptSessions: ReturnType<typeof memoryKeptSessionStore>;
  debugRooms: ReturnType<typeof memoryKeptRoomStore>;
  room: "debug";
}) => RandomHost;
let useDebugRandom: (player: RandomHost) => DebugRandom;
/** Debug's rewind, as the Player's Debug features run it (`useDebugRewind.ts`). */
interface DebugRewind {
  readonly state: Readonly<Ref<{ readonly points: readonly { readonly id: number }[] }>>;
  back(point: number): Promise<boolean>;
}
let useDebugRewind: (player: RandomHost) => DebugRewind;
let presentation: Presentation;

/** A state of `kept` the host restored and holds, as Debug's rewind restores one there (`restoreKept`'s route). */
async function hostRestored(
  host: RandomHost,
  bridge: PlayerBridge,
  plan: InstructionPlan,
  kept: PlayerRuntimeSession,
): Promise<PlayerSession> {
  const token = await preparedPlan(host.bridge, plan);
  await bridge.client.request("preparePlanText", { plan: token });
  // EVIDENCE: validation: `planText` replies from the same build with the held plan's canonical JSON.
  const json = (await bridge.client.request("planText", { plan: token })).result as string;
  const restored = await bridge.restoreKept(
    token,
    json,
    playerRuntimeSnapshotJson(kept),
    kept.events,
    NO_MARKS,
  );
  assert.ok(typeof restored === "object", "the kept session restores");
  return restored;
}

before(async () => {
  await loadHostFacade();
  const session: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  const random: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/debug/random/useDebugRandom.ts",
  );
  const shown: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/debug/random/randomDrawPresentation.ts",
  );
  const rewinding: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/debug/history/useDebugRewind.ts",
  );
  assert.equal(typeof rewinding.useDebugRewind, "function");
  // EVIDENCE: validation: Vite loaded the real source module and its export is callable; this is its tested API.
  useDebugRewind = rewinding.useDebugRewind as typeof useDebugRewind;
  assert.equal(typeof session.usePlayerSession, "function");
  assert.equal(typeof random.useDebugRandom, "function");
  assert.equal(typeof shown.randomDrawChoices, "function");
  // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their tested API.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
  // EVIDENCE: validation: as above.
  useDebugRandom = random.useDebugRandom as typeof useDebugRandom;
  presentation = {
    randomDrawCode: (source, site) => {
      const plan = compiled(source);
      const load = loadSourceDebugSidecar(
        createSourceDebugSidecar([{ path: "main.tease", source }], plan),
        plan,
      );
      assert.equal(load.kind, "valid");
      return load.kind === "valid" ? drawCode(fileCode(load.sidecar.files[0]!), site) : null;
    },
    outcomeLines,
    // EVIDENCE: validation: as above.
    randomDrawChoices: shown.randomDrawChoices as Presentation["randomDrawChoices"],
  };
});

function savedData(): ScriptStorageProvider {
  let entries: RuntimeScriptStorageEntrySnapshot[] = [];
  return {
    scope: "test",
    load: async () => [...entries],
    write: async (key, value) => {
      entries = entries.filter((entry) => entry.key !== key);
      if (value !== null) entries.push({ key, value });
    },
    replace: async (next) => {
      entries = [...next];
    },
    clear: async () => {
      entries = [];
    },
  };
}

function stubBrowser(context: TestContext) {
  // Event targets are the only browser surface these scripts use; no media elements are created.
  for (const name of ["document", "window"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: class {
      src = "";
      play = () => Promise.resolve();
      pause() {}
      load() {}
      removeAttribute() {}
    },
  });
  context.after(() => {
    if (previousAudio) Object.defineProperty(globalThis, "Audio", previousAudio);
    else Reflect.deleteProperty(globalThis, "Audio");
  });
  context.mock.timers.enable({ apis: ["setTimeout"] });
}

async function settle(context: TestContext) {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(0);
  }
}

/** A debug room host with Debug's random draws, Choose outcomes on, and `plan` prepared. */
async function mount(context: TestContext, plan: InstructionPlan) {
  stubBrowser(context);
  const scope = effectScope();
  const mounted = scope.run(() => {
    const host = usePlayerSession({
      scriptStorage: savedData(),
      keptSessions: memoryKeptSessionStore(),
      debugRooms: memoryKeptRoomStore(),
      room: "debug",
    });
    return { host, random: useDebugRandom(host), rewind: useDebugRewind(host) };
  })!;
  context.after(() => scope.stop());
  await mounted.host.loadScriptStorage();
  await mounted.host.prepareScript(await preparedPlan(mounted.host.bridge, plan), (recording) =>
    createPlayerRuntimeSession(plan, { ...recording, ...mounted.host.scriptStorageOptions() }),
  );
  await settle(context);
  mounted.random.enabled.value = true;
  return mounted;
}

/**
 * Starts `plan` and goes Back to the history's first point, its first interaction: the state Debug's rewind restores
 * there, shown for inspection. A history takes points only at interactions, so an inspected state never waits at a draw.
 */
async function rewound(context: TestContext, mounted: Awaited<ReturnType<typeof mount>>) {
  await mounted.host.activate();
  await settle(context);
  await backToLast(context, mounted);
}

/** Back to the history's last point, which the shown session reached: inspected there. */
async function backToLast(context: TestContext, mounted: Awaited<ReturnType<typeof mount>>) {
  const point = mounted.rewind.state.value.points.at(-1);
  assert.ok(point !== undefined, "the session's interaction is a point");
  assert.equal(await mounted.rewind.back(point.id), true, "Back restores it");
  await settle(context);
}

/** Presses the shown button as the Player's input does: readied first, which adopts an inspected state. */
async function press(context: TestContext, host: RandomHost) {
  assert.equal(await host.prepareInput(), true, "the input is admitted");
  host.update(activatePlayerRuntimeButton(host.session.value!)!.session);
  await settle(context);
}

/** What `site` took, as the host's history of the shown session's Player gives it. */
async function triedOf(host: RandomHost, site: string) {
  const view = await host.randomTried(site);
  assert.ok(view !== null, "the shown session's Player holds the history");
  return { history: view.history, first: view.first, counts: new Map(view.counts) };
}

const said = (host: RandomHost) =>
  host.session.value?.transcriptEntries.map((entry) => entry.text) ?? [];

function compiled(source: string): InstructionPlan {
  const plan = compilePlayerProject(source).plan;
  assert.ok(plan, "the fixture compiles");
  return plan;
}

test("with Choose outcomes on, a session pauses at each draw and goes on with the outcome chosen", async (context) => {
  const plan = compiled(
    'let roll = randomInteger(1..=6)\nsay "Roll: ${roll}", instant\nlet hit = chance(50)\nsay "Hit: ${hit}", instant\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  await host.activate();
  await settle(context);
  const siteOf = (kind: string) =>
    listRandomSites(plan).find((site) => site.kinds.some((each) => each === kind))!.id;
  const [rollSite, hitSite] = [siteOf("randomInteger"), siteOf("chance")];
  assert.equal(random.draw.value?.site, rollSite);
  assert.deepEqual(said(host), [], "nothing after the draw runs while it waits");
  // Time cannot run on while the draw waits: a jump stops at once instead of looping.
  const paused = host.session.value!;
  assert.equal(playerRuntimeAwaitsHost(paused.state), true);
  assert.equal(advancePlayerRuntimeTime(paused, 60_000), paused);

  assert.equal(await random.resolve({ kind: "number", value: 6 }), true);
  assert.deepEqual(said(host), ["Roll: 6"]);
  assert.equal(random.draw.value?.site, hitSite);
  assert.equal(await random.resolve("natural"), true);
  assert.equal(random.draw.value, null);
  assert.equal(said(host).length, 2);
  assert.deepEqual((await triedOf(host, rollSite!)).history, ["6"]);
});

test("Next time decides a site's later draws without asking: Random naturally, Prefer untried the least taken", async (context) => {
  const plan = compiled(
    'for turn in 1..=4 {\n    let hit = chance(50)\n    let pick = chance(50)\n}\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  const [hitSite, pickSite] = listRandomSites(plan).map((site) => site.id);
  random.setNext(hitSite!, "untried");
  random.setNext(pickSite!, "random");
  await host.activate();
  await settle(context);
  assert.equal(random.draw.value, null, "no draw asked");
  const untried = await triedOf(host, hitSite!);
  // Each of the two outcomes is taken once before either is taken again.
  assert.equal(untried.history.length, 4);
  assert.notEqual(untried.history[0], untried.history[1]);
  assert.notEqual(untried.history[2], untried.history[3]);
  assert.deepEqual([...untried.counts.values()].sort(), [2, 2]);
  assert.equal((await triedOf(host, pickSite!)).history.length, 4);
});

test("Least tried resolves a paused draw with the outcome its site took least, the natural one on a tie", async (context) => {
  const plan = compiled(
    'for turn in 1..=2 {\n    let hit = chance(50)\n    say "Hit: ${hit}", instant\n}\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  await host.activate();
  await settle(context);
  const first = random.draw.value!;
  assert.equal(await random.resolveLeastTried(), true);
  assert.ok(first.natural.kind === "boolean");
  assert.deepEqual(said(host), [`Hit: ${first.natural.value}`]);
  assert.equal(await random.resolveLeastTried(), true);
  const [taken, then] = said(host);
  assert.notEqual(taken, then, "the second takes the outcome not taken yet");
});

test("a picker answer counts before the draws it lets run, so they decide from it in order", async (context) => {
  const plan = compiled(
    'for turn in 1..=2 {\n    let hit = chance(50)\n    say "${hit}", instant\n}\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  await host.activate();
  await settle(context);
  const site = random.draw.value!.site;
  const unseen = JSON.stringify(await host.randomTried(site));
  await settle(context);
  const shown = random.tried(site);
  // An answer the engine refuses counts nothing, and the draw still waits: the host's history, revision included, is
  // as before, also for a site that took nothing yet.
  assert.equal(await random.resolve({ kind: "number", value: 123 }), false);
  await settle(context);
  assert.equal(JSON.stringify(await host.randomTried(site)), unseen);
  const before = await triedOf(host, site);
  assert.deepEqual(before.history, []);
  assert.equal(before.counts.size, 0);
  // Until the history changes, the picker gets the same object, so it does not render all its outcomes again.
  assert.equal(random.tried(site), shown);
  random.setNext(site, "untried");
  assert.equal(await random.resolve({ kind: "boolean", value: false }), true);
  assert.deepEqual(said(host), ["false", "true"], "the next draw takes the outcome not taken yet");
  assert.deepEqual((await triedOf(host, site)).history, ["false", "true"], "in the order taken");
});

test("a rewound state asks the picker at its next draw only once input adopts it", async (context) => {
  const plan = compiled(
    'showButton "Go"\nlet hit = chance(50)\nsay "Hit: ${hit}", instant\nshowButton "Again"\nlet again = chance(50)\nsay "Again: ${again}", instant\nshowButton "Next"\nexit',
  );
  const mounted = await mount(context, plan);
  const { host, random } = mounted;
  const asked = () => random.draw.value?.drawId ?? null;
  // Inspected at its button, as Debug's rewind restores it: no picker, so the inspection controls work.
  await rewound(context, mounted);
  assert.equal(asked(), null);
  await press(context, host);
  assert.notEqual(asked(), null, "adopted, the picker asks at its next draw");
  assert.equal(await random.resolve({ kind: "boolean", value: true }), true);
  await settle(context);
  // The button's own entry, then the say after the draw.
  assert.deepEqual(said(host), ["Go", "Hit: true"]);
  // Back at the next button, then adopted after Choose outcomes was turned off: it goes on naturally.
  await backToLast(context, mounted);
  random.enabled.value = false;
  await settle(context);
  assert.equal(asked(), null, "an inspected state stays as it was");
  await press(context, host);
  // The host resolves it, one reply later.
  await settle(context);
  assert.equal(host.session.value?.state.randomDraw, null);
  assert.equal(said(host).length, 4);
});

// L5i.4, Sol plan P5, code r1 C3 and r2 (orchestrator 2's ruling (b)), the invariant of Continue's boundary: a session
// takes Debug's random control only from a fresh Start or an explicit adoption, never from a restore, an inspection, a
// settings change, or a Continue before its kept draw went on naturally. Over every way a restore reaches the Player,
// crossed with the settings changes made before it is adopted, with Choose outcomes on and the state kept at the first
// of two draws: an inspected one is no Player's, also after a settings change; Continue finishes both draws naturally,
// then takes the control; input that adopts an inspected one takes it, and the picker asks at its draw.
const RESTORE_PATHS = [
  "a raw restore, Continue",
  "a kept restore, Continue",
  // No "a rewound state, Continue": an inspected state is paused and never kept (`keepSessionLater`), so no Continue
  // restores one; a kept restore's Continue and a rewound state's adoption cover the boundary.
  "a rewound state, input adopts it",
  "a Start's own session, Continue",
] as const;
/** What changes before the restore is adopted: nothing, a site's Next time, or Choose outcomes off and on. */
const TRANSITIONS = ["none", "Next time", "off and on"] as const;
const BOUNDARY_CASES = RESTORE_PATHS.flatMap((path) =>
  TRANSITIONS.map((transition) => ({ path, transition, name: `${path}; settings: ${transition}` })),
);
const TWO_DRAWS =
  'let a = chance(50)\nlet b = chance(50)\nsay "${a} ${b}", instant\nshowButton "Next"\nexit';
/** The same draws after a first interaction, where Debug's rewind takes the point it restores. */
const GO_TWO_DRAWS = `showButton "Go"\n${TWO_DRAWS}`;

test("Continue's boundary covers every restore path with every settings change", () => {
  const observed = BOUNDARY_CASES.map(({ path, transition }) => ({ path, transition }));
  const feasible = product({ path: [...RESTORE_PATHS], transition: [...TRANSITIONS] });
  assert.deepEqual(coverageGaps(feasible, observed, { tuples: true }), []);
  assert.equal(new Set(BOUNDARY_CASES.map((each) => each.name)).size, BOUNDARY_CASES.length);
});

for (const { path, transition, name } of BOUNDARY_CASES)
  test(`Continue's boundary: ${name}`, async (context) => {
    const rewinding = path.startsWith("a rewound state");
    const plan = compiled(rewinding ? GO_TWO_DRAWS : TWO_DRAWS);
    const mounted = await mount(context, plan);
    const { host, random } = mounted;
    const bridge = await host.bridge;
    const sites = listRandomSites(plan).map((each) => each.id);
    const [site = ""] = sites;
    // The settings change, made while the restore is not yet adopted.
    const change = async () => {
      if (transition === "Next time") random.setNext(sites[1] ?? "", "random");
      else if (transition === "off and on") {
        random.enabled.value = false;
        await settle(context);
        random.enabled.value = true;
      }
      await settle(context);
    };
    // Kept at its first draw, as a session the adapter's own control paused there.
    const kept = createPlayerRuntimeSession(plan, { randomControl: {} });
    if (path === "a raw restore, Continue")
      host.prepareRestore(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(kept)));
    else if (path === "a kept restore, Continue")
      host.prepareRestore(await hostRestored(host, bridge, plan, kept));
    else if (path === "a Start's own session, Continue") {
      await host.activate();
      await settle(context);
      assert.notEqual(random.draw.value, null, "the Start waits at its first draw");
      host.prepareRestore(host.session.value!);
    } else {
      // Inspected at its first interaction, before the draws, as Debug's rewind restores it.
      await rewound(context, mounted);
      assert.equal(
        await host.randomTried(site),
        null,
        `${name}: an inspected state is no Player's`,
      );
      await change();
      assert.equal(await host.randomTried(site), null, `${name}: a settings change adopts nothing`);
      await press(context, host);
      assert.notEqual(random.draw.value, null, `${name}: the picker asks at its draw`);
      assert.notEqual(await host.randomTried(site), null, `${name}: adopted`);
      return;
    }
    await change();
    await host.activate();
    await settle(context);
    assert.equal(random.draw.value, null, `${name}: no draw waits: both went on naturally`);
    assert.equal(said(host).length, 1, `${name}: the run after the kept draw finished`);
    assert.notEqual(await host.randomTried(site), null, `${name}: then it takes the control`);
  });

// The ruling's check: a session adopted once needs no other adoption. A settings change while an input-adopted restore
// runs applies to it through its ownership: its second draw goes on by itself, decided and recorded by the new setting.
test("a settings change applies to an input-adopted restore through its ownership", async (context) => {
  const plan = compiled(GO_TWO_DRAWS);
  const mounted = await mount(context, plan);
  const { host, random } = mounted;
  const [, second = ""] = listRandomSites(plan).map((each) => each.id);
  await rewound(context, mounted);
  await press(context, host);
  assert.notEqual(random.draw.value, null, "adopted, it waits at its draw");
  random.setNext(second, "untried");
  assert.equal(await random.resolve("natural"), true);
  await settle(context);
  assert.equal(random.draw.value, null, "the second draw went on by itself");
  assert.equal((await triedOf(host, second)).history.length, 1, "decided under the new setting");
});

// Sol code r1 C2: draw IDs repeat across sessions, so the picker's history is of the shown session's draw.
test("the picker reads a replacement session's history, also at a draw with the same ID", async (context) => {
  const plan = compiled('showButton "Waiting"\nexit');
  const { host, random } = await mount(context, plan);
  const bridge = await host.bridge;
  const prepare = async (source: string) => {
    const reply = await bridge.client.request("prepare", {
      source: { kind: "source", script: source },
    });
    // EVIDENCE: validation: `prepare` replies from the same build with its result.
    return (reply.result as { readonly plan: string }).plan;
  };
  const a = await prepare('let first = chance(50)\nshowButton "Done"\nexit');
  const b = await prepare('let second = chance(50)\nshowButton "Done"\nexit');
  // The second plan's site took an outcome before.
  const seed = await bridge.start(b, {}, false, { owner: 1 });
  await bridge.request(seed, "resolveDraw", {
    drawId: seed.state.randomDraw!.drawId,
    outcome: "natural",
    record: { resetAt: 0 },
  });
  const first = await bridge.start(a, {}, false, { owner: 1 });
  const second = await bridge.start(b, {}, false, { owner: 1 });
  assert.equal(first.state.randomDraw!.drawId, second.state.randomDraw!.drawId);
  host.showSession(first);
  await settle(context);
  host.showSession(second);
  await settle(context);
  const site = second.state.randomDraw!.site;
  const actual = await host.randomTried(site);
  assert.deepEqual(
    random.tried(site).history,
    actual!.history,
    "the replacement's site's history shows",
  );
});

// Final review F1, C2's draw-identity family: the picker's resolution guard is per draw identity, as its cache is. While
// the previous session's resolution waits behind its turn, the replacement's draw with the same ID resolves, and the
// earlier resolution clears only its own guard.
test("a replacement session's draw with the same ID resolves while the previous one's resolution waits", async (context) => {
  const plan = compiled('showButton "Waiting"\nexit');
  const { host, random } = await mount(context, plan);
  const bridge = await host.bridge;
  const prepare = async (source: string) => {
    const reply = await bridge.client.request("prepare", {
      source: { kind: "source", script: source },
    });
    // EVIDENCE: validation: `prepare` replies from the same build with its result.
    return (reply.result as { readonly plan: string }).plan;
  };
  const first = await bridge.start(
    await prepare('let first = chance(50)\nshowButton "Done"\nexit'),
    {},
    false,
    { owner: 1 },
  );
  const second = await bridge.start(
    await prepare('let second = randomInteger(1..=6)\nshowButton "Done"\nexit'),
    {},
    false,
    { owner: 1 },
  );
  assert.equal(first.state.randomDraw!.drawId, second.state.randomDraw!.drawId);
  host.showSession(first);
  await settle(context);
  // The first session's turn is held, so its resolution waits.
  let release = () => {};
  const holding = bridge.section(
    first,
    clockTicket(),
    () => new Promise<void>((done) => (release = done)),
  );
  const earlier = random.resolve("natural");
  host.showSession(second);
  await settle(context);
  assert.equal(random.draw.value?.site, second.state.randomDraw!.site);
  assert.equal(await random.resolve("natural"), true, "the replacement's draw is another draw");
  release();
  await holding;
  assert.equal(
    await earlier,
    false,
    "the earlier session no longer shows, so its resolution ends as nothing",
  );
});

// L5i.4: the history is the host's while the Debug features run. Choose outcomes off and on keeps it; their end forgets it.
test("a site's history lasts through Choose outcomes off and on, and goes when the Debug features end", async (context) => {
  const plan = compiled(
    'for turn in 1..=3 {\n    let hit = chance(50)\n    say "${hit}", instant\n}\nshowButton "Next"\nexit',
  );
  stubBrowser(context);
  const hostScope = effectScope();
  const host = hostScope.run(() =>
    usePlayerSession({
      scriptStorage: savedData(),
      keptSessions: memoryKeptSessionStore(),
      debugRooms: memoryKeptRoomStore(),
      room: "debug",
    }),
  )!;
  context.after(() => hostScope.stop());
  const featureScope = effectScope();
  const random = featureScope.run(() => useDebugRandom(host))!;
  await host.loadScriptStorage();
  await host.prepareScript(await preparedPlan(host.bridge, plan), (recording) =>
    createPlayerRuntimeSession(plan, { ...recording, ...host.scriptStorageOptions() }),
  );
  random.enabled.value = true;
  await settle(context);
  await host.activate();
  await settle(context);
  const [site] = listRandomSites(plan).map((each) => each.id);
  assert.equal(await random.resolve("natural"), true);
  assert.equal((await triedOf(host, site!)).history.length, 1);
  random.enabled.value = false;
  await settle(context);
  random.enabled.value = true;
  await settle(context);
  // Off, the draws went on naturally, unrecorded; the outcome taken before stays.
  assert.equal((await triedOf(host, site!)).history.length, 1, "kept through off and on");
  featureScope.stop();
  await settle(context);
  assert.equal((await triedOf(host, site!)).history.length, 0, "forgotten with the Debug features");
});

test("turning Choose outcomes off goes on from a paused draw with its natural outcome", async (context) => {
  const plan = compiled(
    'let hit = chance(50)\nsay "Hit: ${hit}", instant\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  await host.activate();
  await settle(context);
  const drawn = random.draw.value!.natural;
  assert.ok(drawn.kind === "boolean");
  const natural = drawn.value;
  random.enabled.value = false;
  await settle(context);
  assert.equal(host.session.value?.state.randomDraw, null);
  assert.deepEqual(said(host), [`Hit: ${natural}`]);
});

test("a site keeps its latest outcomes for the picker, numbered from its first draw, and counts every one", async (context) => {
  const plan = compiled(
    'for turn in 1..=1005 {\n    let hit = chance(50)\n}\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  const [site] = listRandomSites(plan).map((each) => each.id);
  random.setNext(site!, "random");
  await host.activate();
  await settle(context);
  const tried = await triedOf(host, site!);
  assert.equal(tried.history.length, 1000);
  assert.equal(tried.first, 6);
  assert.equal(
    [...tried.counts.values()].reduce((sum, count) => sum + count, 0),
    1005,
  );
  assert.deepEqual(
    presentation
      .outcomeLines(tried.history.slice(-2), tried.first + 998)
      .map((line) => line.number),
    [1004, 1005],
  );
});

test("the picker's code is the whole file, its draw marked, with the range Show whole fits around the default lines", () => {
  const source = [
    "// Dice.",
    "",
    "function rollTwice {",
    "    let first = randomInteger(1..=6)",
    '    say "First: ${first}"',
    "    let second = randomInteger(1..=6)",
    '    say "Second: ${second}"',
    "}",
    "",
    "rollTwice()",
    "exit",
  ].join("\n");
  const plan = compiled(source);
  const site = listRandomSites(plan)[0]!;
  const code = presentation.randomDrawCode(source, site)!;
  assert.equal(code.lines.length, 11);
  const draw = code.lines[site.line - 1]!;
  assert.equal(
    draw.segments
      .filter((segment) => segment.mark)
      .map((segment) => segment.text)
      .join(""),
    "randomInteger(1..=6)",
  );
  assert.equal(code.lines[0]!.segments[0]!.kind, "comment", "a comment between tokens");
  assert.equal(draw.segments.find((segment) => segment.text === "let")?.kind, "keyword");
  // The function is lines 3–8; the 7 lines around line 4 begin at line 1, which stays shown.
  assert.deepEqual(code.enclosing, { kind: "function", from: 1, to: 8 });
  // Source nested deeper than a recursive walk could follow still gets its code.
  const depth = 4096;
  const nested = `let value = ${"[".repeat(depth)}chance(50)${"]".repeat(depth)}\nshowButton "Done"\nexit`;
  const deep = presentation.randomDrawCode(nested, listRandomSites(compiled(nested))[0]!)!;
  assert.equal(
    deep.lines[0]!.segments.filter((segment) => segment.mark)
      .map((segment) => segment.text)
      .join(""),
    "chance(50)",
  );
  // Each draw marks only itself, also in a file drawn in before, and leaves the code shown for another draw as it was.
  const second = listRandomSites(plan)[1]!;
  const markedLines = (shown: { readonly lines: readonly CodeLine[] }) =>
    shown.lines
      .filter((line) => line.segments.some((segment) => segment.mark))
      .map((line) => line.number);
  assert.deepEqual(markedLines(presentation.randomDrawCode(source, second)!), [second.line]);
  assert.deepEqual(markedLines(code), [site.line]);
  assert.deepEqual(presentation.randomDrawCode(source, site), code);
});

test("the picker's code has the compiler's classes, lexed as the parser reads the file", () => {
  // After a message mode, a slash starts a regex (V30 §8), which the lexer alone reads as a division and a problem.
  const source = ["say prose /[a-z]+/", "let roll = randomInteger(1..=6)", "exit"].join("\n");
  const [say, roll] = presentation.randomDrawCode(
    source,
    listRandomSites(compiled(source))[0]!,
  )!.lines;
  assert.deepEqual(
    say!.segments.map(({ text, kind }) => [text, kind]),
    [
      ["say", "keyword"],
      [" ", null],
      ["prose", "keyword"],
      [" ", null],
      ["/[a-z]+/", "regex"],
    ],
  );
  // A built-in function is a name: the themes have no colour of their own for it.
  assert.equal(roll!.segments.find((segment) => segment.text === "randomInteger")?.kind, "name");
});

test("Show whole block fits the smallest statement or block around the draw that the default lines do not show whole", () => {
  const say = (count: number, indent = "  ") =>
    Array.from({ length: count }, (_, index) => `${indent}say "Step ${index + 1}", instant`);
  const enclosing = (lines: readonly string[]) => {
    const source = [...lines, "exit"].join("\n");
    return presentation.randomDrawCode(source, listRandomSites(compiled(source))[0]!)!.enclosing;
  };
  // A draw in an `if` block of lines 9–19, inside a `repeat` of lines 1–32.
  const nested = (inside: number) => [
    "repeat 3 {",
    ...say(7),
    "  if true {",
    ...say(inside, "    "),
    "    let hit = chance(50)",
    ...say(inside, "    "),
    "  }",
    ...say(12),
    "}",
  ];
  assert.deepEqual(enclosing(nested(4)), { kind: "block", from: 9, to: 19 });
  // An `if` block of lines 9–13 shows whole in the default lines 8–14, so the `repeat` around it is next.
  assert.deepEqual(enclosing(nested(1)), { kind: "block", from: 1, to: 26 });
  // A block the default lines show whole, with none around it, leaves nothing to show.
  assert.equal(enclosing(["if true {", "  let hit = chance(50)", "}"]), null);
  // A draw in a statement of one line, outside any block, fits the whole file.
  assert.deepEqual(enclosing([...say(10, ""), "let hit = chance(50)", ...say(10, "")]), {
    kind: "file",
    from: 1,
    to: 22,
  });
});

test("earlier outcomes read like code", () => {
  const [order] = presentation.outcomeLines(['["red", "blue"]']);
  assert.deepEqual(
    order!.segments.filter((segment) => segment.kind === "string").map((segment) => segment.text),
    ['"', "red", '"', '"', "blue", '"'],
  );
});

/** A session paused at the first draw of `source`, and that draw. */
function pausedAtDraw(source: string) {
  const session = createPlayerRuntimeSession(`${source}\nexit`, { randomControl: {} });
  const draw = session.state.randomDraw;
  assert.ok(draw !== null, source);
  return { session, draw };
}

test("each kind of draw offers what the engine takes, and a typed outcome it refuses shows the engine's reason", () => {
  const resume = (source: string, outcome: RandomOutcome) => {
    const { session, draw } = pausedAtDraw(source);
    return resumePlayerRuntimeRandomDraw(session, { drawId: draw.drawId, outcome }).outcome;
  };
  const resolved = { kind: "resolved", forced: true };
  // A continuous draw or a large range: a field that takes what the engine takes, and refuses the rest with the message
  // the engine refuses it with. Typed text that is no finite number gets the draw's message too; the engine refuses
  // such a request before it reads the outcome.
  const fields: readonly [source: string, accepted: number[], refused: number[]][] = [
    ["let x = random()", [0, 0.5], [1, -0.5]],
    ["let x = randomInteger(1..=100)", [1, 100], [0, 101, 2.5]],
    ["let x = randomNormal(10, 2)", [-1e6, 10], []],
    ["let x = randomBeta(2, 5)", [0, 1], [1.5, -0.5]],
    ["let x = randomPert(1, 2, 3)", [1, 3], [0.5, 3.5]],
  ];
  for (const [source, accepted, refused] of fields) {
    const choices = presentation.randomDrawChoices(pausedAtDraw(source).draw);
    assert.ok(choices.kind === "number", source);
    for (const value of accepted) {
      assert.equal(choices.refusal(value), null, `${source}: ${value}`);
      assert.deepEqual(resume(source, { kind: "number", value }), resolved, `${source}: ${value}`);
    }
    for (const value of refused) {
      const outcome = resume(source, { kind: "number", value });
      assert.ok(outcome.kind === "invalidOutcome", `${source}: ${value}`);
      assert.equal(choices.refusal(value), outcome.message, `${source}: ${value}`);
    }
    for (const value of [Number.NaN, Infinity])
      assert.equal(
        choices.refusal(value),
        refused.length === 0 ? "randomNormal takes a finite number." : choices.refusal(refused[0]!),
        `${source}: ${value}`,
      );
  }
  // A draw with few outcomes: a button for each the engine takes, and none for an outcome it refuses.
  const buttons: readonly [source: string, labels: string[], refused: RandomOutcome[]][] = [
    ["let x = chance(25)", ["true", "false"], []],
    ["let x = chance(0)", ["false"], [{ kind: "boolean", value: true }]],
    [
      "let x = randomInteger(1..=3)",
      ["1", "2", "3"],
      [
        { kind: "number", value: 0 },
        { kind: "number", value: 4 },
      ],
    ],
    ['let x = ["a", "b", "c"].random', ['"a"', '"b"', '"c"'], [{ kind: "index", index: 3 }]],
    [
      'let x = randomWeighted(dict{ "x": 3, "y": 0, "z": 1 })',
      ['"x"', '"z"'],
      [{ kind: "index", index: 1 }],
    ],
    ["let x = randomNormal(10, 0)", ["10"], [{ kind: "number", value: 11 }]],
  ];
  for (const [source, labels, refused] of buttons) {
    const choices = presentation.randomDrawChoices(pausedAtDraw(source).draw);
    assert.ok(choices.kind === "buttons", source);
    assert.deepEqual(
      choices.outcomes.map((button) => button.label),
      labels,
      source,
    );
    for (const { outcome } of choices.outcomes)
      assert.deepEqual(resume(source, outcome), resolved, `${source}: ${JSON.stringify(outcome)}`);
    for (const outcome of refused)
      assert.equal(
        resume(source, outcome).kind,
        "invalidOutcome",
        `${source}: ${JSON.stringify(outcome)}`,
      );
  }
  // A shuffle: its items to reorder, any order of which the engine takes.
  const shuffle = 'let items = ["a", "b"]\nitems.shuffle()';
  const order = presentation.randomDrawChoices(pausedAtDraw(shuffle).draw);
  assert.ok(order.kind === "order");
  assert.deepEqual(order.items, ['"a"', '"b"']);
  for (const moved of [
    [0, 1],
    [1, 0],
  ])
    assert.deepEqual(resume(shuffle, { kind: "order", order: moved }), resolved);
});

test("a duration draw's field says no unit, as its number counts in the unit the script wrote", () => {
  // A ranged wait and a repeating timer's later rounds draw the number of the unit after the range.
  for (const [unit, unitMs] of [
    ["ms", 1],
    ["s", 1000],
    ["min", 60_000],
  ] as const) {
    const source = `wait (1..=100) ${unit}\nsay "Done", instant`;
    const { session, draw } = pausedAtDraw(source);
    assert.equal(draw.kind, "duration");
    const choices = presentation.randomDrawChoices(draw);
    assert.ok(choices.kind === "number");
    assert.equal(choices.hint, "Whole number from 1 through 100.", unit);
    assert.equal(choices.refusal(101), "This draw takes a whole number from 1 through 100.");
    const resumed = resumePlayerRuntimeRandomDraw(session, {
      drawId: draw.drawId,
      outcome: { kind: "number", value: 20 },
    }).session;
    const waiting = advancePlayerRuntimeTime(resumed, 20 * unitMs - 1);
    assert.deepEqual(waiting.transcriptEntries, [], unit);
    const done = advancePlayerRuntimeTime(waiting, 20 * unitMs);
    assert.deepEqual(
      done.transcriptEntries.map((entry) => entry.text),
      ["Done"],
      unit,
    );
  }
  // A repeating timer draws each later round when the round before it ends.
  const repeating = advancePlayerRuntimeTime(
    createPlayerRuntimeSession(
      "let t = timer(duration: (1..=100) ms, async: true, repeat: true)\nwait 1 s\nexit",
      { randomControl: { filter: { kinds: ["timerRepeat"] } } },
    ),
    1000,
  ).state.randomDraw;
  assert.ok(repeating?.kind === "timerRepeat");
  const choices = presentation.randomDrawChoices(repeating);
  assert.ok(choices.kind === "number" && choices.hint === "Whole number from 1 through 100.");
});

test("the picker's sites and code come from the Worker, which compiled the source, and a late reply for a draw resolved meanwhile is not shown", async (context) => {
  const source =
    'for turn in 1..=3 {\n    let roll = randomInteger(1..=6)\n    say "Roll: ${roll}", instant\n}\nshowButton "Next"\nexit';
  const { host, random } = await mount(context, compiled('showButton "Waiting"\nexit'));
  const bridge = await host.bridge;
  // A source host: the Worker compiles the script and keeps its sources.
  const reply = await bridge.client.request("prepare", {
    source: { kind: "source", script: source },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const token = (reply.result as { readonly plan: string }).plan;
  // Hold the replies to `drawCode` until the test releases them.
  const held: (() => void)[] = [];
  const request = bridge.client.request;
  bridge.client.request = (op, ...rest) => {
    const answer = request(op, ...rest);
    if (op !== "drawCode") return answer;
    return new Promise((resolve, reject) => held.push(() => void answer.then(resolve, reject)));
  };
  await host.prepareScript(token, { plan: token, options: () => host.scriptStorageOptions() });
  await host.activate();
  await settle(context);
  const first = random.draw.value;
  assert.ok(first !== null, "the session pauses at the first draw");
  assert.ok(random.sites.value.has(first.site), "the sites come from the plan's metadata");
  assert.equal(held.length, 1);
  // Resolved before its code arrived: that code, for the draw before, never shows.
  assert.ok(await random.resolve("natural"));
  await settle(context);
  const second = random.draw.value;
  assert.ok(second !== null && second.drawId !== first.drawId);
  held[0]!();
  await settle(context);
  assert.equal(random.code.value, null, "the first draw's code is not shown for the second");
  held[1]!();
  await settle(context);
  const marked = random.code
    .value!.lines.flatMap((line) => line.segments)
    .filter((segment) => segment.mark)
    .map((segment) => segment.text)
    .join("");
  assert.equal(marked, "randomInteger(1..=6)");
  // The first draw's natural outcome is the site's history, as code.
  assert.equal(random.historyLines.value.length, 1);
});

test("a site's earlier outcomes never show at another site's draw, even before its own arrive", async (context) => {
  const source =
    'for turn in 1..=2 {\n    let roll = randomInteger(1..=6)\n    let hit = chance(50)\n    say "${roll} ${hit}", instant\n}\nshowButton "Next"\nexit';
  const { host, random } = await mount(context, compiled('showButton "Waiting"\nexit'));
  const bridge = await host.bridge;
  const reply = await bridge.client.request("prepare", {
    source: { kind: "source", script: source },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const token = (reply.result as { readonly plan: string }).plan;
  // Hold the replies to `codeLines` once the test asks.
  let holding = false;
  const held: (() => void)[] = [];
  const request = bridge.client.request;
  bridge.client.request = (op, ...rest) => {
    const answer = request(op, ...rest);
    if (op !== "codeLines" || !holding) return answer;
    return new Promise((resolve, reject) => held.push(() => void answer.then(resolve, reject)));
  };
  await host.prepareScript(token, { plan: token, options: () => host.scriptStorageOptions() });
  await host.activate();
  await settle(context);
  // The first turn: each site's first draw, so each site has one earlier outcome after it.
  for (let step = 0; step < 2; step += 1) {
    assert.ok(await random.resolve("natural"));
    await settle(context);
  }
  const roll = random.draw.value;
  assert.ok(roll !== null);
  assert.equal(
    random.historyLines.value.length,
    1,
    "the integer site's outcome shows at its second draw",
  );
  holding = true;
  assert.ok(await random.resolve("natural"));
  await settle(context);
  const hit = random.draw.value;
  assert.ok(hit !== null && hit.site !== roll.site);
  assert.equal(
    random.historyLines.value.length,
    0,
    "the integer site's lines went before the chance site's arrive",
  );
  for (const release of held) release();
  await settle(context);
  const text = random.historyLines.value.map((line) =>
    line.segments.map((segment) => segment.text).join(""),
  );
  assert.deepEqual(text, random.tried(hit.site).history);
});
