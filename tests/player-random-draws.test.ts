import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";

import {
  advancePlayerRuntimeTime,
  compilePlayerProject,
  createPlayerRuntimeSession,
  playerRuntimeAwaitsHost,
  resumePlayerRuntimeRandomDraw,
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
import { loadPlayerModule } from "./helpers/player-modules.js";

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
  start(next: PlayerRuntimeSession, paused?: boolean): void;
  prepareInput(): true | Promise<boolean>;
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
let presentation: Presentation;

before(async () => {
  const session: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/usePlayerSession.ts",
  );
  const random: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/useDebugRandom.ts",
  );
  const shown: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/randomDrawPresentation.ts",
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

test("a picker answer counts before the draws it lets run, so they decide from it in order", async (context) => {
  const plan = compiled(
    'for turn in 1..=2 {\n    let hit = chance(50)\n    say "${hit}", instant\n}\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  await host.activate();
  await settle(context);
  const site = random.draw.value!.site;
  // An answer the engine refuses counts nothing, and the draw still waits.
  assert.equal(random.resolve({ kind: "number", value: 123 }), false);
  const before = random.tried(site);
  assert.deepEqual(before.history, []);
  assert.equal(before.counts.size, 0);
  // Until the history changes, the picker gets the same object, so it does not render all its outcomes again.
  assert.equal(random.tried(site), before);
  random.setNext(site, "untried");
  assert.equal(random.resolve({ kind: "boolean", value: false }), true);
  assert.deepEqual(said(host), ["false", "true"], "the next draw takes the outcome not taken yet");
  assert.deepEqual(random.tried(site).history, ["false", "true"], "in the order taken");
});

test("a restored state waits at its draw for the picker only once input adopts it", async (context) => {
  const plan = compiled(
    'let hit = chance(50)\nsay "Hit: ${hit}", instant\nlet again = chance(50)\nsay "Again: ${again}", instant\nshowButton "Next"\nexit',
  );
  const { host, random } = await mount(context, plan);
  await host.activate();
  await settle(context);
  const atDraw = host.session.value!;
  // Shown for inspection, as Debug's rewind shows a state it restored: no picker, so the inspection controls work.
  const asked = () => random.draw.value?.drawId ?? null;
  host.start(atDraw, true);
  assert.equal(asked(), null);
  assert.equal(await host.prepareInput(), true);
  assert.equal(asked(), atDraw.state.randomDraw!.drawId);
  assert.equal(random.resolve({ kind: "boolean", value: true }), true);
  assert.deepEqual(said(host), ["Hit: true"]);
  // Adopted after Choose outcomes was turned off, it goes on naturally.
  host.start(host.session.value!, true);
  random.enabled.value = false;
  await settle(context);
  assert.notEqual(host.session.value?.state.randomDraw, null, "an inspected state stays as it was");
  assert.equal(await host.prepareInput(), true);
  assert.equal(host.session.value?.state.randomDraw, null);
  assert.equal(said(host).length, 2);
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
  // A file the lexer has problems with shows as plain text.
  const broken = presentation.randomDrawCode(`${source}\n"unterminated`, site)!;
  assert.ok(broken.lines.every((line) => line.segments.every((segment) => segment.kind === null)));
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
