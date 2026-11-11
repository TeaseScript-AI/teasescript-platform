import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { computed, effectScope, nextTick, ref, shallowRef, watch, type Ref } from "vue";
import { memoryKeptSessionStore } from "../../player/persistence/kept-sessions.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  playerRuntimeForeground,
  playerRuntimePacingGate,
  type PlayerSession,
  type PlayerSessionView,
} from "../../player/runtime/runtime-view.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import { reportsInto } from "../helpers/player/rewind-host.js";
import { sourceStart, type PlanStart } from "../helpers/prepared-plan.js";
import {
  presentedAction,
  runtimeInput,
  type Intent,
  type RuntimeInput,
} from "../helpers/player/player-input.js";
import {
  loadTopology,
  topologyConnections,
  TOPOLOGIES,
  until,
  type Topology,
} from "../helpers/player/worker-topology.js";

/*
 * The composer while an answer is in flight (#2430): what is typed and given during the flight ends as if it came after
 * the answer settled, as on a Player whose answers settle at once. Each row runs the real session composable and the
 * real flight owner (`useAnswerFlight`) on both bridge topologies, through a model of how `RuntimeInteraction.vue` and
 * `Composer.vue` call them, twice: once with the keys pressed while the answer's reply is held, and once, as the
 * reference, with no flight and every key pressed after the answer settled. The browser kit's `keys` scenario witnesses
 * the components themselves.
 */

type Source = "input" | "button";
type Outcome = "skip" | "activate" | "consume" | "type";
type Owner = { readonly connection: unknown; readonly id: string; readonly reset: number } | null;
interface Flight {
  readonly holding: Readonly<Ref<boolean>>;
  begin(): void;
  submit(source: Source): boolean;
  hold(key: string, fresh: boolean): void;
  noteChange(): boolean;
  settle(settlement: "completed" | "refused"): void;
  release(): void;
  fail(): void;
}
let useAnswerFlight: (host: {
  owner(): Owner;
  text(): string;
  writeField(text: string): void;
  interceptInput(take: (text: string) => void): { write(text: string): void; release(): void };
  holds(): boolean;
  disabled(): boolean;
  shortcuts(): { pacing: boolean; preselected: boolean; buttonsOnly: boolean };
  submit(source: Source, text: string): void;
  skip(): void;
  activate(): void;
  keepTyped(text: string): void;
  clearFeedback(): void;
}) => Flight;
let shortcutOutcome: (
  key: string,
  state: {
    empty: boolean;
    fresh: boolean;
    pacing: boolean;
    preselected: boolean;
    buttonsOnly: boolean;
  },
) => Outcome;
interface SessionHost {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly stopped: Readonly<Ref<boolean>>;
  /** What the stop after a lost engine connection offers (#2382), `null` without one. */
  readonly recovery: Readonly<Ref<object | null>>;
  readonly bridge: Promise<PlayerBridge>;
  readonly inputSection: unknown;
  prepare(start: PlanStart): void;
  activate(): Promise<void>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): object;
  prepareScriptSource(script: string): Promise<{ readonly result: { readonly plan?: string } }>;
  prepareScript(plan: string, start: PlanStart): Promise<void>;
}
let usePlayerSession: (options: {
  readonly bridge: Promise<PlayerBridge>;
  readonly debugHistorySpill: () => Promise<null>;
  readonly nextConnection: () => Promise<PlayerBridge>;
  readonly scriptStorage?: object;
  readonly keptSessions?: object;
}) => SessionHost;
let input: RuntimeInput;

before(async () => {
  await loadTopology();
  input = await runtimeInput();
  const flight = await loadPlayerModule("player/vue/src/interaction/useAnswerFlight.ts");
  const keys = await loadPlayerModule("player/vue/src/interaction/playerKeys.ts");
  const session = await loadPlayerModule("player/vue/src/session/usePlayerSession.ts");
  assert.equal(typeof flight.useAnswerFlight, "function");
  assert.equal(typeof keys.shortcutOutcome, "function");
  assert.equal(typeof session.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source modules, and each export is a function, checked above.
  useAnswerFlight = flight.useAnswerFlight as typeof useAnswerFlight;
  // EVIDENCE: validation: as above.
  shortcutOutcome = keys.shortcutOutcome as typeof shortcutOutcome;
  // EVIDENCE: validation: as above.
  usePlayerSession = session.usePlayerSession as typeof usePlayerSession;
});

/**
 * A Player page on `topology`: the session composable, and a scene clock the test can move forward. A `recoverable` one
 * prepares its script itself and keeps its sessions, as the hosted Player does, so a lost connection offers recovery.
 */
async function page(context: TestContext, topology: Topology, { recoverable = false } = {}) {
  const surface = {
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    window: new EventTarget(),
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
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
  const now = performance.now.bind(performance);
  let skew = 0;
  context.mock.method(performance, "now", () => now() + skew);
  // A fresh connection after a loss, as the Player opens one for its recovery (#2382).
  const connections = await topologyConnections(context, topology);
  const transport = connections.first;
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: Promise.resolve(transport.bridge),
      debugHistorySpill: async () => null,
      nextConnection: () => connections.next(),
      ...(recoverable && {
        scriptStorage: {
          scope: "answer-flight",
          load: async () => [],
          write: async () => {},
          replace: async () => {},
          clear: async () => {},
        },
        keptSessions: memoryKeptSessionStore(),
      }),
    }),
  )!;
  context.after(() => scope.stop());
  await host.bridge;
  if (recoverable) await host.loadScriptStorage();
  const starts = new Map<string, PlanStart>();
  return {
    host,
    transport,
    /** Moves the scene clock `ms` ahead, for the next observation. */
    elapse: (ms: number) => void (skew += ms),
    async start(script: string) {
      if (recoverable) {
        const plan = (await host.prepareScriptSource(script)).result.plan;
        assert.ok(plan !== undefined, "the script was prepared");
        await host.prepareScript(plan, {
          plan,
          options: () => ({ ...host.scriptStorageOptions(), wallClockMs: 0 }),
        });
        await host.activate();
        await until(
          () => host.session.value !== null && presentedAction(host.session.value) !== undefined,
          "presented",
        );
        return;
      }
      let start = starts.get(script);
      if (start === undefined) {
        start = await sourceStart(host.bridge, script, () => ({ wallClockMs: 0 }));
        starts.set(script, start);
      }
      host.prepare(start);
      await host.activate();
      await until(
        () => host.session.value !== null && presentedAction(host.session.value) !== undefined,
        "presented",
      );
    },
  };
}
type Page = Awaited<ReturnType<typeof page>>;

/**
 * The composer as `RuntimeInteraction.vue` and `Composer.vue` run it, with what they call of the flight: the composer's
 * text, its notice, the text kept per question, `complete` and `submit`, the key handler, and the watches of the
 * presented action and of the text. `flight: false` is a Player without a flight, the reference.
 */
function composer(host: SessionHost, { flight: holds }: { readonly flight: boolean }) {
  const scope = effectScope();
  const field = ref("");
  const notice = ref("");
  const submitting = ref(false);
  const kept = new Map<number, string>();
  const stopped = ref(false);
  const reset = ref(0);
  // A replaced session, as the flight sees it: the owner's session ID changes.
  const replaced = ref(false);
  let interceptor: ((text: string) => void) | null = null;
  /** The flight's own writes, for the exits' rows. */
  const flightWrites: string[] = [];
  /** When the flight ran each queued command, and the hook after an answer's reply, for the scheduling row. */
  const ran: number[] = [];
  let afterReply: (() => void) | null = null;
  let prepare: (() => Promise<boolean>) | null = null;
  // The parent publishes the answer's session (`update:session`), and the composable every other.
  const published = shallowRef<PlayerSession | null>(host.session.value);
  const session = () => (stopped.value || host.stopped.value ? null : published.value);
  const foreground = () => {
    const shown = session();
    return shown ? playerRuntimeForeground(shown) : null;
  };
  const pacing = () => {
    const shown = session();
    const gate = shown ? playerRuntimePacingGate(shown) : null;
    return gate?.skippable ? gate : null;
  };
  const preselected = () => {
    const shown = foreground();
    if (shown?.kind === "show-button") return null;
    if (shown?.kind !== "choose") return undefined;
    return shown.options.find((option) => option.preselected)?.id;
  };
  const disabled = () =>
    (!foreground() && !pacing()) ||
    foreground()?.kind === "popup" ||
    foreground()?.kind === "export-text" ||
    foreground()?.kind === "open-url";
  const shortcuts = () => ({
    pacing: !foreground() && !!pacing(),
    preselected: preselected() !== undefined,
    buttonsOnly: foreground()?.kind === "choose" || foreground()?.kind === "show-button",
  });
  const writeField = (text: string) => {
    if (interceptor) interceptor(text);
    else field.value = text;
  };
  const keepTyped = (text: string) => {
    const id = actionId.value;
    if (id !== undefined && foreground()?.kind !== "ask-password") kept.set(id, text);
  };
  const actionId = computed(() => {
    const shown = session();
    return shown ? presentedAction(shown) : undefined;
  });
  const flight = scope.run(() => {
    watch(host.session, (shown) => (published.value = shown), { flush: "sync" });
    const owned = useAnswerFlight({
      owner: () => {
        const shown = session();
        return (
          shown && {
            connection: shown.connection,
            id: replaced.value ? `${shown.id}, replaced` : shown.id,
            reset: reset.value,
          }
        );
      },
      text: () => field.value,
      writeField,
      interceptInput(take) {
        interceptor = take;
        return {
          write(text) {
            flightWrites.push(text);
            field.value = text;
          },
          release() {
            if (interceptor === take) interceptor = null;
          },
        };
      },
      holds: () => holds && !disabled(),
      disabled,
      shortcuts,
      submit(source, text) {
        ran.push(performance.now());
        void submit(source, text);
      },
      skip() {
        ran.push(performance.now());
        void skip();
      },
      activate() {
        ran.push(performance.now());
        void activate();
      },
      keepTyped,
      clearFeedback: () => void (notice.value = ""),
    });
    watch(actionId, () => {
      const id = actionId.value;
      const shown = foreground();
      const typed = id === undefined ? undefined : kept.get(id);
      writeField(typed ?? (shown !== null && "prefill" in shown ? (shown.prefill ?? "") : ""));
      notice.value = "";
    });
    watch(field, (text) => {
      if (owned.noteChange()) notice.value = "";
      keepTyped(text);
    });
    return owned;
  })!;

  async function complete(intent: Intent, target: "interaction" | "pacing" = "interaction") {
    const shown = session();
    if (!shown || submitting.value) return;
    submitting.value = true;
    flight.begin();
    let settled: "completed" | "refused" | null = null;
    try {
      const targetId = (current: PlayerSessionView) =>
        target === "pacing" ? playerRuntimePacingGate(current)?.actionId : presentedAction(current);
      const presented = targetId(shown);
      const ready = prepare?.() ?? true;
      prepare = null;
      if (ready !== true && !(await ready)) {
        settled = "refused";
        await nextTick();
        return;
      }
      const before = actionId.value;
      const result = await input.runInput(host.inputSection, presented, targetId, intent);
      afterReply?.();
      if (result.kind === "retired") {
        flight.release();
        return;
      }
      settled = "refused";
      if (result.kind === "unavailable" || result.kind === "unanswered") {
        if (target === "interaction") notice.value = result.kind;
        await nextTick();
        return;
      }
      // As `complete` publishes it (`update:session`).
      // EVIDENCE: invariant: the input chain answers with the section's session, a `PlayerSession`.
      published.value = result.session as PlayerSession;
      const kind = result.outcome!.kind;
      if (kind === "completed" || kind === "updated" || kind === "unchanged") {
        settled = "completed";
        if (kind !== "completed" || actionId.value === before) writeField("");
        notice.value = "";
      } else notice.value = kind;
      await nextTick();
    } catch (error) {
      flight.fail();
      throw error;
    } finally {
      submitting.value = false;
      if (settled !== null) flight.settle(settled);
    }
  }
  function submit(source: Source, text = field.value) {
    if (flight.submit(source)) return;
    return complete(input.intents.composer(text, source === "input" ? "enter" : "send"));
  }
  function skip() {
    if (pacing()) return complete(input.intents.pacing, "pacing");
  }
  function activate() {
    const target = preselected();
    if (target !== undefined) return complete(input.intents.choice(target, "preselectedKey"));
  }
  /** A key in the composer's field, as `Composer.vue`'s key handler and the browser take it. */
  function press(key: string): Promise<void> | void {
    if (disabled()) return;
    if (key === "Enter") return submit("input");
    const readOnly = submitting.value && !flight.holding.value;
    if (key === "Backspace") {
      if (!readOnly) field.value = field.value.slice(0, -1);
      return;
    }
    const empty = field.value === "";
    const outcome = flight.holding.value
      ? shortcutOutcome(key, {
          empty,
          fresh: true,
          pacing: true,
          preselected: true,
          buttonsOnly: true,
        })
      : shortcutOutcome(key, { empty, fresh: true, ...shortcuts() });
    if (outcome === "type") {
      if (!readOnly) field.value += key;
    } else if (flight.holding.value) flight.hold(key, true);
    else if (outcome === "skip") return skip();
    else if (outcome === "activate") return activate();
  }
  /** Keys pressed during a flight, each in a task of its own, whose flush follows it, as in a browser. */
  async function type(keys: readonly string[]) {
    for (const key of keys) {
      void press(key);
      await nextTick();
    }
  }
  /** Until no answer is in flight and no flight holds the composer. */
  async function idle() {
    for (let calm = 0; calm < 5;) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      calm = submitting.value || flight.holding.value ? 0 : calm + 1;
    }
  }
  return {
    field,
    notice,
    kept,
    actionId,
    flight,
    flightWrites,
    ran,
    press,
    type,
    complete,
    idle,
    stop: () => void (stopped.value = true),
    reset: () => void (reset.value += 1),
    replace: () => void (replaced.value = true),
    unmount: () => scope.stop(),
    onReply: (hook: () => void) => void (afterReply = hook),
    prepareWith: (ready: () => Promise<boolean>) => void (prepare = ready),
    isIntercepted: () => interceptor !== null,
  };
}

// The answer each settlement starts from, and the script that gives it.
const FIRST = {
  text: { script: 'let a = askText "First?"', aside: "Stay" },
  password: { script: 'let a = askPassword "Secret?"', aside: "hunter2" },
  refused: { script: 'let a = askChoice "Yes", "No thanks"', aside: "Not an option" },
  unavailable: { script: 'let a = showButton "Go", timeout: 60 s', aside: "Go" },
} as const;
// What the answer presents next: Space's outcome in the empty composer follows from it.
const NEXT = {
  text: 'let b = askText "Next?"\nshowButton "Done"',
  prefill: 'let b = askText "Next?", prefill: "Ada"\nshowButton "Done"',
  consume: 'let b = askChoice "Red", "Blue"\nshowButton "Done"',
  activate: 'let b = askChoice "Red", "Blue", prefill: "Blue"\nshowButton "Done"',
  skip: 'say "Wait."\nlet b = askText "Next?"\nshowButton "Done"',
  ended: 'say "Bye.", instant',
} as const;
const QUEUES = {
  nothing: [],
  text: ["x"],
  submit: ["Enter"],
  "text-submit": ["x", "Enter"],
  "two-submits": ["Enter", "Enter"],
  "held-space": [" "],
  "space-after-text": ["x", " "],
} as const satisfies Record<string, readonly string[]>;
// The text typed last, after every command: whether the player changed the field there.
const HISTORY = { none: [], undone: ["y", "Backspace"], stays: ["y"] } as const;
const SETTLES = ["completed", "prefill", "refused", "unavailable", "unprepared"];

/** The rows: every settlement, queue and history; Space's outcome where the queue holds Space. */
function family(): Coordinates[] {
  return product({
    settle: [...SETTLES],
    queue: Object.keys(QUEUES),
    history: Object.keys(HISTORY),
    kind: ["text", "password"],
  }).flatMap((row) => {
    // A password is a question of its own, answered or not taken; the others take a text the composer types.
    if (row.kind === "password" && !["completed", "unprepared"].includes(row.settle!)) return [];
    // A refusal, a prefill and a taken text leave text in the field, where Space types; only an empty field has
    // Space's other outcomes.
    const outcomes =
      row.settle === "completed" && row.queue === "held-space"
        ? ["type", "consume", "activate", "skip"]
        : ["type"];
    return outcomes.map((space) => ({ ...row, space }));
  });
}

function scriptOf(row: Coordinates): { readonly script: string; readonly aside: string } {
  const first =
    row.kind === "password"
      ? FIRST.password
      : row.settle === "refused"
        ? FIRST.refused
        : row.settle === "unavailable"
          ? FIRST.unavailable
          : FIRST.text;
  // EVIDENCE: invariant: `family` gives Space's outcome one of `type`, `consume`, `activate`, `skip`.
  const space = row.space as "type" | "consume" | "activate" | "skip";
  const next =
    row.settle === "prefill" || row.settle === "unavailable"
      ? NEXT.prefill
      : space === "type"
        ? NEXT.text
        : NEXT[space];
  return { script: `${first.script}\n${next}\nexit`, aside: first.aside };
}

const prefillOf = (session: PlayerSession | null) => {
  const shown = session ? playerRuntimeForeground(session) : null;
  return shown !== null && "prefill" in shown ? (shown.prefill ?? "") : "";
};

/** What a row ends with: the field, the notice, the answers posted after the first, and the text kept for the question. */
async function observe(at: Page, ui: ReturnType<typeof composer>, from: number) {
  await ui.idle();
  const posts = at.transport.posts
    .slice(from)
    .filter((post) => post.op !== "observeInput")
    .map((post) => [post.op, JSON.stringify(post.args)]);
  const id = ui.actionId.value;
  return {
    field: ui.field.value,
    notice: ui.notice.value,
    posts,
    status: at.host.session.value?.state.status,
    // What the question shows if it returns after a block interrupted it: the text kept for it, else its prefill.
    kept: id === undefined ? null : (ui.kept.get(id) ?? prefillOf(at.host.session.value)),
  };
}

/** The reference: the answer settles, then each key is pressed after the one before settled. */
async function reference(at: Page, row: Coordinates, keys: readonly string[]) {
  const { script, aside } = scriptOf(row);
  await at.start(script);
  const ui = composer(at.host, { flight: false });
  const from = at.transport.posts.length;
  ui.field.value = aside;
  if (row.settle === "unprepared") ui.prepareWith(async () => false);
  if (row.settle === "unavailable") at.elapse(61_000);
  await ui.press("Enter");
  for (const key of keys) {
    await ui.press(key);
    await ui.idle();
  }
  const seen = await observe(at, ui, from);
  ui.unmount();
  return seen;
}

/** The keys pressed while the answer's reply (or its preparation) is held. */
async function inFlight(at: Page, row: Coordinates, keys: readonly string[], phase: string) {
  const { script, aside } = scriptOf(row);
  await at.start(script);
  const ui = composer(at.host, { flight: true });
  const from = at.transport.posts.length;
  ui.field.value = aside;
  let prepared: (ready: boolean) => void = () => {};
  if (row.settle === "unprepared")
    ui.prepareWith(() => new Promise<boolean>((resolve) => (prepared = resolve)));
  else at.transport.hold(phase);
  if (row.settle === "unavailable") at.elapse(61_000);
  const answering = ui.press("Enter");
  if (row.settle !== "unprepared") await at.transport.held();
  assert.equal(ui.flight.holding.value, true, "the flight holds the composer");
  await ui.type(keys);
  if (row.settle === "unprepared") prepared(false);
  else at.transport.release();
  await answering;
  const seen = await observe(at, ui, from);
  ui.unmount();
  return seen;
}

for (const topology of TOPOLOGIES)
  test(`what is typed while an answer is in flight ends as if typed after it settled (${topology})`, async (context) => {
    const at = await page(context, topology);
    const ran: Coordinates[] = [];
    for (const row of family()) {
      // EVIDENCE: invariant: `family` takes each row's queue and history from the keys of `QUEUES` and `HISTORY`.
      const keys = [
        ...QUEUES[row.queue as keyof typeof QUEUES],
        ...HISTORY[row.history as keyof typeof HISTORY],
      ];
      const expected = await reference(at, row, keys);
      // A preparation that refuses posts nothing to hold; the others hold the observation's reply, then the answer's.
      for (const phase of row.settle === "unprepared"
        ? ["prepare"]
        : row.settle === "unavailable"
          ? ["observeInput"]
          : ["observeInput", "submitComposer"]) {
        const actual = await inFlight(at, row, keys, phase);
        assert.deepEqual(actual, expected, `${JSON.stringify(row)} holding ${phase}`);
      }
      // Space's outcomes, written down from the Player's keyboard contract and `main`'s measured rows (job
      // 11111442067e1a: unselected choices keep the field empty), not computed by the predicate under test.
      if (row.queue === "held-space") {
        const last = row.history === "stays" ? "y" : "";
        if (row.space === "consume") assert.equal(expected.field, last, "Space types nothing");
        if (row.space === "activate")
          assert.deepEqual(
            expected.posts.at(-1)?.[0],
            "selectChoice",
            "Space activates the preselected button",
          );
        if (row.space === "skip")
          assert.ok(
            expected.posts.some(([op]) => op === "skipPacing"),
            "Space skips the pause",
          );
        if (row.space === "type" && row.settle === "completed")
          assert.equal(expected.field, ` ${last}`, "Space types a space");
      }
      // A password is kept nowhere but in its answer.
      if (row.kind === "password")
        assert.ok(!`${expected.notice} ${expected.kept}`.includes("hunter2"));
      ran.push(row);
    }
    assert.deepEqual(coverageGaps(family(), ran, { tuples: true }), []);
  });

// A queued answer whose question the first answer ended: the composer takes no input there, so it is dropped, and the
// flight ends with what the answer wrote. On `main` the same Enter reaches the control that took the focus (residual 6
// of #2430), which this model has no focus to show; the kit's `keys` scenario measures it.
for (const topology of TOPOLOGIES)
  test(`a queued answer whose question the first ended is dropped (${topology})`, async (context) => {
    const at = await page(context, topology);
    for (const next of [
      NEXT.ended,
      'showPopup "Hello"\nshowButton "Done"',
      'exportText("Hello")\nshowButton "Done"',
      'openUrl("https://example.com", alwaysButton: true)\nshowButton "Done"',
    ]) {
      await at.start(`${FIRST.text.script}\n${next}\nexit`);
      const ui = composer(at.host, { flight: true });
      const from = at.transport.posts.length;
      ui.field.value = FIRST.text.aside;
      at.transport.hold("submitComposer");
      const answering = ui.press("Enter");
      await at.transport.held();
      await ui.type(["x", "Enter", "y"]);
      at.transport.release();
      await answering;
      const seen = await observe(at, ui, from);
      assert.deepEqual(
        seen.posts.map(([op]) => op),
        ["submitComposer"],
        `${next}: only the first answer`,
      );
      assert.equal(seen.field, "", next);
      assert.equal(ui.flight.holding.value, false);
      assert.equal(ui.isIntercepted(), false, "the flight released the composer's writer");
      ui.unmount();
    }
  });

// The exits of a flight, each taken while the reply is held: the flight ends at once, and the reply, once it arrives,
// runs none of its commands and writes nothing of its own.
const EXITS = ["stop", "loss", "reset", "replacement", "unmount", "throw"] as const;
for (const topology of TOPOLOGIES)
  for (const exit of EXITS)
    // An answer that throws does so before it posts, so only the observation's reply can be held for it.
    for (const phase of exit === "throw" ? ["observeInput"] : ["observeInput", "submitComposer"])
      test(`a flight ends at once on ${exit}, holding ${phase} (${topology})`, async (context) => {
        const at = await page(context, topology, { recoverable: exit === "loss" });
        await at.start(`${FIRST.text.script}\n${NEXT.text}\nexit`);
        const ui = composer(at.host, { flight: true });
        const from = at.transport.posts.length;
        ui.field.value = FIRST.text.aside;
        at.transport.hold(phase);
        const throwing: Intent = () => {
          throw new Error("injected");
        };
        const answering = exit === "throw" ? ui.complete(throwing) : ui.press("Enter");
        await at.transport.held();
        await ui.type(["x", "Enter", "y"]);
        const writes = ui.flightWrites.length;
        const lost: unknown[] = [];
        if (exit === "stop") ui.stop();
        else if (exit === "reset") ui.reset();
        else if (exit === "unmount") ui.unmount();
        else if (exit === "loss") {
          reportsInto(context, lost);
          await at.transport.lose();
        }
        // The bridge holds every reply, so a real replacement could not publish until the answer's reply arrived.
        else if (exit === "replacement") ui.replace();
        if (exit !== "throw") {
          assert.equal(ui.flight.holding.value, false, "released at once");
          assert.equal(ui.isIntercepted(), false);
        }
        at.transport.release();
        if (exit === "throw") {
          await assert.rejects(Promise.resolve(answering), /injected/u);
          // The field holds the answer's text again, before what was typed meanwhile.
          assert.equal(ui.field.value, `${FIRST.text.aside}y`);
        } else await answering;
        await ui.idle();
        assert.equal(ui.flight.holding.value, false);
        assert.equal(ui.isIntercepted(), false);
        assert.equal(ui.flightWrites.length, writes, "no write of the flight after it ended");
        const answered = at.transport.posts
          .slice(from)
          .filter((post) => post.op === "submitComposer")
          .map((post) => JSON.stringify(post.args));
        assert.ok(!answered.some((args) => args.includes('"x"')), "no queued answer posted");
        assert.equal(
          lost.length,
          exit === "loss" ? 1 : 0,
          "the loss is the Player's one host error",
        );
        // The stop after the loss offers its recovery (#2382): Continue from the point kept at the question.
        if (exit === "loss") {
          await until(() => at.host.recovery.value !== null, "the recovery offer");
          assert.deepEqual(at.host.recovery.value, { offer: "continue", where: "line" });
        }
      });

// The queued commands run as soon as the answer settles: in the microtasks after its reply, before any task, such as
// a zero-delay timer that the reply's arrival scheduled.
for (const topology of TOPOLOGIES)
  test(`the queued commands run before the next task (${topology})`, async (context) => {
    const at = await page(context, topology);
    await at.start(`${FIRST.text.script}\n${NEXT.text}\nexit`);
    const ui = composer(at.host, { flight: true });
    let ranBeforeTimer: boolean | null = null;
    ui.onReply(() => {
      ui.onReply(() => {});
      setTimeout(() => (ranBeforeTimer = ui.ran.length > 0), 0);
    });
    ui.field.value = FIRST.text.aside;
    at.transport.hold("submitComposer");
    const answering = ui.press("Enter");
    await at.transport.held();
    await ui.type(["x", "Enter"]);
    at.transport.release();
    await answering;
    await ui.idle();
    assert.equal(ranBeforeTimer, true);
  });
