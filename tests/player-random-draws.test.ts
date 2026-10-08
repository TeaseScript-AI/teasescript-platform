import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { createServer } from "vite";

import {
  advancePlayerRuntimeTime,
  compilePlayerProject,
  createPlayerRuntimeSession,
  playerRuntimeAwaitsHost,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import { memoryKeptRoomStore, memoryKeptSessionStore } from "../player/kept-sessions.js";
import type { DebugRecorder } from "../player/debug-recorder.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import {
  listRandomSites,
  type InstructionPlan,
  type RandomControlOptions,
  type RandomDrawView,
  type RandomOutcome,
  type RandomSite,
  type RuntimeScriptStorageEntrySnapshot,
} from "../src/index.js";

// Debug's random draws (DEBUGGER.md "Random draws") through the real Vue session host and engine: with Choose outcomes
// on in the debug room, a session pauses at every draw and goes on with the outcome the picker gives; Next time and
// Least tried decide from what each site took; turning the feature off goes on naturally. The picker's code and
// outcome presentation comes from the compiler's own lexer and parser.
interface RandomHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly rooms: { readonly current: Readonly<Ref<"normal" | "debug">> };
  prepareScript(
    plan: InstructionPlan,
    create: (recording: {
      readonly recorder: DebugRecorder;
      readonly debugMode: boolean;
      readonly randomControl?: RandomControlOptions;
    }) => PlayerRuntimeSession,
  ): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  activate(): Promise<void>;
}
interface DebugRandom {
  readonly enabled: Ref<boolean>;
  readonly draw: Readonly<Ref<RandomDrawView | null>>;
  setNext(site: string, next: "ask" | "random" | "untried"): void;
  resolve(outcome: RandomOutcome | "natural"): boolean;
  resolveLeastTried(): boolean;
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
    | { readonly kind: "buttons"; readonly outcomes: readonly { readonly label: string }[] }
    | { readonly kind: "number"; readonly accepts: (value: number) => boolean }
    | { readonly kind: "order"; readonly items: readonly string[] };
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  keptSessions: ReturnType<typeof memoryKeptSessionStore>;
  debugRooms: ReturnType<typeof memoryKeptRoomStore>;
  room: "debug";
}) => RandomHost;
let useDebugRandom: (player: RandomHost) => DebugRandom;
let presentation: Presentation;

before(async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    // No HMR websocket: parallel test runs must not compete for its default port.
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const session: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerSession.ts",
    );
    const random: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/useDebugRandom.ts",
    );
    const shown: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/randomDrawPresentation.ts",
    );
    assert.equal(typeof session.usePlayerSession, "function");
    assert.equal(typeof random.useDebugRandom, "function");
    assert.equal(typeof shown.randomDrawCode, "function");
    assert.equal(typeof shown.outcomeLines, "function");
    assert.equal(typeof shown.randomDrawChoices, "function");
    // EVIDENCE: validation: Vite loaded the real source modules and the exports are callable; this is their tested API.
    usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
    // EVIDENCE: validation: as above.
    useDebugRandom = random.useDebugRandom as typeof useDebugRandom;
    presentation = {
      // EVIDENCE: validation: as above.
      randomDrawCode: shown.randomDrawCode as Presentation["randomDrawCode"],
      // EVIDENCE: validation: as above.
      outcomeLines: shown.outcomeLines as Presentation["outcomeLines"],
      // EVIDENCE: validation: as above.
      randomDrawChoices: shown.randomDrawChoices as Presentation["randomDrawChoices"],
    };
  } finally {
    await server.close();
  }
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
    return { host, random: useDebugRandom(host) };
  })!;
  context.after(() => scope.stop());
  await mounted.host.loadScriptStorage();
  await mounted.host.prepareScript(plan, (recording) =>
    createPlayerRuntimeSession(plan, { ...recording, ...mounted.host.scriptStorageOptions() }),
  );
  await settle(context);
  mounted.random.enabled.value = true;
  return mounted;
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

  assert.equal(random.resolve({ kind: "number", value: 6 }), true);
  assert.deepEqual(said(host), ["Roll: 6"]);
  assert.equal(random.draw.value?.site, hitSite);
  assert.equal(random.resolve("natural"), true);
  assert.equal(random.draw.value, null);
  assert.equal(said(host).length, 2);
  assert.deepEqual(random.tried(rollSite!).history, ["6"]);
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
  const untried = random.tried(hitSite!);
  // Each of the two outcomes is taken once before either is taken again.
  assert.equal(untried.history.length, 4);
  assert.notEqual(untried.history[0], untried.history[1]);
  assert.notEqual(untried.history[2], untried.history[3]);
  assert.deepEqual([...untried.counts.values()].sort(), [2, 2]);
  assert.equal(random.tried(pickSite!).history.length, 4);
});

test("Least tried resolves a paused draw with the outcome its site took least, the natural one on a tie", async (context) => {
  const plan = compiled(
    'for turn in 1..=2 {\n    let hit = chance(50)\n    say "Hit: ${hit}", instant\n}\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  await host.activate();
  await settle(context);
  const first = random.draw.value!;
  assert.equal(random.resolveLeastTried(), true);
  assert.ok(first.natural.kind === "boolean");
  assert.deepEqual(said(host), [`Hit: ${first.natural.value}`]);
  assert.equal(random.resolveLeastTried(), true);
  const [taken, then] = said(host);
  assert.notEqual(taken, then, "the second takes the outcome not taken yet");
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
  const tried = random.tried(site!);
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
  // A file the lexer has problems with shows as plain text.
  const broken = presentation.randomDrawCode(`${source}\n"unterminated`, site)!;
  assert.ok(broken.lines.every((line) => line.segments.every((segment) => segment.kind === null)));
});

test("earlier outcomes read like code, and each kind of draw offers its outcomes as its support allows", () => {
  const [order] = presentation.outcomeLines(['["red", "blue"]']);
  assert.deepEqual(
    order!.segments.filter((segment) => segment.kind === "string").map((segment) => segment.text),
    ['"', "red", '"', '"', "blue", '"'],
  );
  const view = (
    support: RandomDrawView["support"],
    natural: RandomDrawView["natural"],
  ): RandomDrawView => ({ drawId: 1, site: "main.tease:1:1", kind: "random", support, natural });
  const labels = (draw: RandomDrawView) => {
    const choices = presentation.randomDrawChoices(draw);
    return choices.kind === "buttons"
      ? choices.outcomes.map((outcome) => outcome.label)
      : choices.kind;
  };
  const number = { kind: "number", value: 0.5 } as const;
  assert.deepEqual(
    labels(view({ kind: "chance", percent: 25 }, { kind: "boolean", value: true })),
    ["true", "false"],
  );
  assert.deepEqual(
    labels(view({ kind: "chance", percent: 0 }, { kind: "boolean", value: false })),
    ["false"],
  );
  assert.deepEqual(labels(view({ kind: "integer", min: 1, max: 3 }, number)), ["1", "2", "3"]);
  assert.equal(labels(view({ kind: "integer", min: 1, max: 100 }, number)), "number");
  assert.deepEqual(
    labels(
      view(
        { kind: "weighted", candidates: ["a", "b", "c"], weights: [1, 0, 2] },
        { kind: "index", index: 0 },
      ),
    ),
    ['"a"', '"c"'],
    "a weight of 0 is no outcome",
  );
  const unit = presentation.randomDrawChoices(view({ kind: "unit" }, number));
  assert.ok(unit.kind === "number" && unit.accepts(0) && !unit.accepts(1));
  const normal = presentation.randomDrawChoices(
    view({ kind: "normal", mean: 30, spread: 5 }, number),
  );
  assert.ok(normal.kind === "number" && normal.accepts(-1e6) && !normal.accepts(Infinity));
  assert.deepEqual(labels(view({ kind: "normal", mean: 30, spread: 0 }, number)), ["30"]);
  assert.equal(
    labels(view({ kind: "order", items: ["x", "y"] }, { kind: "order", order: [1, 0] })),
    "order",
  );
});
