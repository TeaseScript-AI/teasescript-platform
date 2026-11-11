import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { computed, effectScope, nextTick, ref, shallowRef, watch, type Ref } from "vue";
import { memoryKeptSessionStore } from "../../player/persistence/kept-sessions.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  playerRuntimeForeground,
  playerRuntimeForm,
  playerRuntimeInteractionActionIds,
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
  end(): void;
  release(): void;
  owns(): boolean;
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
  origin(): { readonly action: number; readonly keeps: boolean } | undefined;
  pending(action: number): boolean;
  keep(action: number, text: string): void;
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
  /** What a debug export reads: only serialized here, to count a text in it. */
  debugExportCandidate(details: () => object, wanted: AbortSignal): Promise<object | null>;
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
 * presented action and of the text. `flight: false` is a Player without a flight, the reference. `section` stands in for
 * the composable's input section: `null` for none, as before a session is prepared. A lock's password field, which the
 * Player's lock service shows, is not modelled.
 */
function composer(
  host: SessionHost,
  {
    flight: holds,
    section = host.inputSection,
  }: { readonly flight: boolean; readonly section?: unknown },
) {
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
  // The composer's field, as `RuntimeInteraction.vue`'s `composerField`: a lock's password field is not modelled.
  const fieldKind = () => {
    const ask = foreground();
    if (ask?.kind === "ask-password") return "password";
    return ask !== null &&
      ["ask-date", "ask-time", "ask-datetime"].includes(ask.kind) &&
      !("isoText" in ask && ask.isoText)
      ? "picker"
      : "text";
  };
  const writeField = (text: string) => {
    if (interceptor) interceptor(text);
    else field.value = text;
  };
  // As `RuntimeInteraction.vue`'s `keepsTyped`: a question that is no form and no password keeps its typed text.
  const keepsTyped = () => {
    const shown = session();
    return !(shown && playerRuntimeForm(shown)) && foreground()?.kind !== "ask-password";
  };
  const keepTyped = (text: string) => {
    const id = actionId.value;
    if (id !== undefined && keepsTyped()) kept.set(id, text);
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
      // As `RuntimeInteraction.vue`'s: the plain text field, with no form editor.
      holds: () => {
        const shown = session();
        return (
          holds &&
          !disabled() &&
          fieldKind() === "text" &&
          !(shown && playerRuntimeForm(shown)?.editor)
        );
      },
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
      origin: () => {
        const action = actionId.value;
        return action === undefined ? undefined : { action, keeps: keepsTyped() };
      },
      pending: (action) => {
        const shown = session();
        return !!shown && playerRuntimeInteractionActionIds(shown.state).includes(action);
      },
      keep: (action, text) => void kept.set(action, text),
      clearFeedback: () => void (notice.value = ""),
    });
    // Only the questions that can still be answered keep their text, as `RuntimeInteraction.vue`'s watch prunes it.
    watch(actionId, () => {
      const shown = session();
      const pending = new Set(shown ? playerRuntimeInteractionActionIds(shown.state) : []);
      for (const id of kept.keys()) if (!pending.has(id)) kept.delete(id);
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
      if (!owned.owns()) keepTyped(text);
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
      if ((ready !== true && !(await ready)) || section === null) {
        settled = "refused";
        await nextTick();
        return;
      }
      const before = actionId.value;
      const result = await input.runInput(section, presented, targetId, intent);
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
    // A password field has one line: Shift+Enter is Enter there.
    if (key === "Enter" || (key === "Shift+Enter" && fieldKind() === "password"))
      return submit("input");
    const readOnly = submitting.value && !flight.holding.value;
    if (key === "Shift+Enter") {
      if (!readOnly && fieldKind() === "text") field.value += "\n";
      return;
    }
    if (key === "Backspace") {
      if (!readOnly && fieldKind() !== "picker") field.value = field.value.slice(0, -1);
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
      if (!readOnly && fieldKind() !== "picker") field.value += key;
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
  picker: { script: 'let a = askDate "When?"', aside: "2024-01-02" },
  unselected: { script: 'let a = askChoice "Yes", "No thanks"', aside: "Not an option" },
  preselected: {
    script: 'let a = askChoice "Yes", "No thanks", prefill: "Yes"',
    aside: "Not an option",
  },
  unavailable: { script: 'let a = showButton "Go", timeout: 60 s', aside: "Go" },
} as const;
// What a completed answer presents next: Space's outcome in the empty composer follows from it.
const NEXT = {
  text: 'let b = askText "Next?"\nshowButton "Done"',
  prefill: 'let b = askText "Next?", prefill: "Ada"\nshowButton "Done"',
  unselected: 'let b = askChoice "Red", "Blue"\nshowButton "Done"',
  preselected: 'let b = askChoice "Red", "Blue", prefill: "Blue"\nshowButton "Done"',
  pacing: 'say "Wait."\nlet b = askText "Next?"\nshowButton "Done"',
  password: 'let b = askPassword "Next?"\nshowButton "Done"',
  picker: 'let b = askDate "Next?"\nshowButton "Done"',
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
  "shift-enter": ["Shift+Enter"],
} as const satisfies Record<string, readonly string[]>;
// The text typed last, after every command: whether the player changed the field there. `edit` deletes within the
// flight, where it does not reach the text the settlement puts in the field (#2463, residual 1): its rows are recorded.
const HISTORY = {
  none: [],
  undone: ["y", "Backspace"],
  stays: ["y"],
  edit: ["Backspace"],
} as const;
const DOMAINS = {
  settle: ["completed", "prefill", "refused", "unavailable", "unprepared"],
  // The field the answer was given in, of each kind the composer shows: the plain text field, a password field, or a
  // date control.
  departs: ["text", "password", "picker"],
  // The interaction the composer serves once the answer settled, a refused one's own: in the plain text field, or a
  // question in a password field or a date control.
  presents: ["text", "unselected", "preselected", "pacing", "password", "picker"],
  // What the composer held at Enter: the answer's text, or nothing.
  aside: ["typed", "empty"],
  queue: Object.keys(QUEUES),
  history: Object.keys(HISTORY),
};

/** Whether the flight's domain holds the row: it departs from the plain text field and settles in it. */
const inDomain = (row: Coordinates) =>
  row.departs === "text" && row.presents !== "password" && row.presents !== "picker";

/** Whether a row can be produced: each settlement presents what its scripts can present, from what Enter can send. */
function feasible(row: Coordinates): boolean {
  // Outside the domain, a completed answer goes from each field kind to each, and a refused one presents its own;
  // the keys typed last stay, so what was typed is there to drop.
  if (!inDomain(row))
    return (
      row.aside === "typed" &&
      row.history === "stays" &&
      ["text", "password", "picker"].includes(row.presents!) &&
      (row.settle === "completed" || (row.settle === "unprepared" && row.presents === row.departs))
    );
  if (row.settle === "completed") return row.aside === "typed";
  // Enter on the empty composer refuses only where no button is preselected.
  if (row.settle === "refused")
    return (
      row.presents === "unselected" || (row.presents === "preselected" && row.aside === "typed")
    );
  return row.presents === "text" && row.aside === "typed";
}

/** The rows, built settlement by settlement: `feasible` checks that none is missing. */
function family(): Coordinates[] {
  const rows: Coordinates[] = [];
  const each = (base: Coordinates) => {
    for (const queue of Object.keys(QUEUES))
      for (const history of Object.keys(HISTORY)) rows.push({ ...base, queue, history });
  };
  const typed = { aside: "typed", departs: "text" };
  for (const presents of ["text", "unselected", "preselected", "pacing"])
    each({ settle: "completed", presents, ...typed });
  each({ settle: "prefill", presents: "text", ...typed });
  each({ settle: "refused", presents: "unselected", ...typed });
  each({ settle: "refused", presents: "unselected", aside: "empty", departs: "text" });
  each({ settle: "refused", presents: "preselected", ...typed });
  each({ settle: "unavailable", presents: "text", ...typed });
  each({ settle: "unprepared", presents: "text", ...typed });
  // Outside the domain: from each field kind to each, and a refused answer in a password field or a date control.
  for (const departs of ["text", "password", "picker"])
    for (const presents of ["text", "password", "picker"]) {
      const base = { aside: "typed", departs, presents };
      const settles = presents === departs ? ["completed", "unprepared"] : ["completed"];
      if (departs === "text" && presents === "text") continue;
      for (const settle of settles)
        for (const queue of Object.keys(QUEUES))
          rows.push({ ...base, settle, queue, history: "stays" });
    }
  return rows;
}

function scriptOf(row: Coordinates): { readonly script: string; readonly aside: string } {
  // EVIDENCE: invariant: `feasible` gives a refused row a choice that `FIRST` and a completed one a next that `NEXT` holds.
  const presents = row.presents as keyof typeof NEXT;
  // EVIDENCE: invariant: `DOMAINS.departs` holds only `text`, `password` and `picker`.
  const departs = row.departs as "text" | "password" | "picker";
  const first =
    departs !== "text"
      ? FIRST[departs]
      : row.settle === "refused"
        ? presents === "preselected"
          ? FIRST.preselected
          : FIRST.unselected
        : row.settle === "unavailable"
          ? FIRST.unavailable
          : FIRST.text;
  const next =
    row.settle === "prefill" || row.settle === "unavailable"
      ? NEXT.prefill
      : row.settle === "completed"
        ? NEXT[presents]
        : NEXT.text;
  return {
    script: `${first.script}\n${next}\nexit`,
    aside: row.aside === "empty" ? "" : first.aside,
  };
}

const prefillOf = (session: PlayerSession | null) => {
  const shown = session ? playerRuntimeForeground(session) : null;
  return shown !== null && "prefill" in shown ? (shown.prefill ?? "") : "";
};

const occurrences = (text: string | undefined, part: string) => (text ?? "").split(part).length - 1;

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
    // How often the password is in a text the composer keeps, and in what a debug export reads.
    password: [...ui.kept.values()].filter((text) => text.includes("hunter2")).length,
    exported: occurrences(
      JSON.stringify(
        await at.host.debugExportCandidate(() => ({}), new AbortController().signal),
        (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value),
      ),
      "hunter2",
    ),
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
  assert.equal(
    ui.flight.holding.value,
    row.departs === "text",
    "the flight holds the plain text field",
  );
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
    assert.deepEqual(
      coverageGaps(product(DOMAINS).filter(feasible), family(), { tuples: true }),
      [],
    );
    for (const row of family()) {
      // EVIDENCE: invariant: `family` takes each row's queue and history from the keys of `QUEUES` and `HISTORY`.
      const keys = [
        ...QUEUES[row.queue as keyof typeof QUEUES],
        ...HISTORY[row.history as keyof typeof HISTORY],
      ];
      // Outside the domain, nothing typed or given in the flight takes effect: the row ends as the answer alone does.
      const expected = await reference(at, row, inDomain(row) ? keys : []);
      // A preparation that refuses posts nothing to hold, nor does an answer no longer available past its observation;
      // a queue that holds an answer also runs with the first answer's own reply held.
      const phases =
        row.settle === "unprepared"
          ? ["prepare"]
          : row.settle === "unavailable" || !row.queue!.includes("submit")
            ? ["observeInput"]
            : ["observeInput", "submitComposer"];
      for (const phase of phases) {
        const actual = await inFlight(at, row, keys, phase);
        const where = `${JSON.stringify(row)} holding ${phase}`;
        // An edit within the flight does not reach text the settlement puts in the field (#2463, residual 1): only the
        // answers posted and where the session went are compared.
        if (row.history === "edit") {
          assert.deepEqual([actual.posts, actual.status], [expected.posts, expected.status], where);
        } else assert.deepEqual(actual, expected, where);
      }
      // Outcomes written down from the Player's keyboard contract and `main`'s measured rows, not computed by the
      // predicate under test. Outside the domain, a completed answer leaves the next field empty, with no notice.
      if (!inDomain(row) && row.settle === "completed")
        assert.deepEqual([expected.field, expected.notice], ["", ""], JSON.stringify(row));
      if (inDomain(row) && row.queue === "held-space" && row.history !== "edit") {
        const last = row.history === "stays" ? "y" : "";
        if (row.settle === "completed" && row.presents === "unselected")
          assert.equal(expected.field, last, "Space types nothing");
        if (row.settle === "completed" && row.presents === "preselected")
          assert.equal(
            expected.posts.at(-1)?.[0],
            "selectChoice",
            "Space activates the preselected button",
          );
        if (row.settle === "completed" && row.presents === "pacing")
          assert.ok(
            expected.posts.some(([op]) => op === "skipPacing"),
            "Space skips the pause",
          );
        if (row.settle === "completed" && row.presents === "text")
          assert.equal(expected.field, ` ${last}`, "Space types a space");
        // Enter on the empty composer refused, then Space on the unselected choices: the notice stays (#2463, round 1).
        if (row.settle === "refused" && row.aside === "empty") {
          assert.equal(expected.field, last);
          assert.equal(expected.notice, row.history === "none" ? "invalidPayload" : "");
        }
        if (row.settle === "refused" && row.aside === "typed")
          assert.equal(
            expected.field,
            `Not an option ${last}`,
            "Space types after the refused text",
          );
      }
      ran.push(row);
    }
    assert.deepEqual(coverageGaps(family(), ran, { tuples: true }), []);
  });

// Text typed in the flight of an answer whose settle shows a password field was typed in clear, and may be what the
// player meant as the password: once the flight ends it is in no text the composer holds or keeps, nor in what a debug
// export reads (the session's state, recording and transcript).
for (const topology of TOPOLOGIES)
  test(`text typed in a flight that settles into a password field is kept nowhere (${topology})`, async (context) => {
    const at = await page(context, topology);
    const clear = "plain4secret";
    await at.start(`${FIRST.text.script}\n${NEXT.password}\nexit`);
    const ui = composer(at.host, { flight: true });
    ui.field.value = FIRST.text.aside;
    at.transport.hold("observeInput");
    const answering = ui.press("Enter");
    await at.transport.held();
    await ui.type([...clear]);
    assert.equal(ui.field.value, clear, "typed in the plain text field during the flight");
    at.transport.release();
    await answering;
    const seen = await observe(at, ui, 0);
    assert.equal(
      at.host.session.value && playerRuntimeForeground(at.host.session.value)?.kind,
      "ask-password",
    );
    assert.equal(seen.field, "");
    assert.deepEqual(
      [...ui.kept.values()].filter((text) => text.includes(clear)),
      [],
      "in no text kept for a question",
    );
    assert.equal(
      occurrences(
        JSON.stringify(
          await at.host.debugExportCandidate(() => ({}), new AbortController().signal),
          (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value),
        ),
        clear,
      ),
      0,
      "in no debug export",
    );
    ui.unmount();
  });

// The end table of design round 2 (#2463), where a timer's block suspends the question whose answer is in flight: the
// answer, sent after the block's due time, reaches it suspended. Each block is answered, and the question returns.
const BLOCKS = {
  text: { script: 'let b = askText "B?"', answer: () => input.intents.composer("B", "enter") },
  password: {
    script: 'let b = askPassword "B?"',
    answer: () => input.intents.composer("pw", "enter"),
  },
  date: {
    script: 'let b = askDate "B?"',
    answer: () => input.intents.composer("2024-01-02", "enter"),
  },
  popup: { script: 'showPopup "B"', answer: () => input.intents.popupClose("button") },
  form: {
    script: 'let b = askForm("B", fields: { name: "Ada" }, submit: "Continue")',
    answer: () => input.intents.formSubmit(undefined, "button"),
  },
} as const;
// What is typed in the flight: the native tail, an Enter's segment before it, or a held Space (a command, not text).
const TYPED = {
  tail: ["T", "A", "I", "L"],
  segment: ["M", "I", "D", "Enter", "T", "A", "I", "L"],
  space: [" ", "T", "A", "I", "L"],
} as const;
/** The end table's rule, written apart from the composable: what stays with the suspended question. */
const unsentOf = (sent: string, typed: string) =>
  sent + (typed === "segment" ? "MID" : "") + "TAIL";
const markers = (text: string) => ["MID", "TAIL"].filter((marker) => text.includes(marker));

for (const topology of TOPOLOGIES)
  test(`a block that suspends the answer's question keeps the unsent text with it (${topology})`, async (context) => {
    const at = await page(context, topology);
    for (const [name, block] of Object.entries(BLOCKS))
      for (const sent of ["", "SENT"])
        for (const [typed, keys] of Object.entries(TYPED)) {
          const where = JSON.stringify({ block: name, sent, typed });
          await at.start(`timer async hidden 60 s { ${block.script} }\nlet a = askText "A?"\nexit`);
          const ui = composer(at.host, { flight: true });
          const from = at.transport.posts.length;
          const original = ui.actionId.value!;
          ui.field.value = sent;
          await nextTick();
          const before = JSON.stringify([...ui.kept]);
          at.transport.hold("observeInput");
          at.elapse(61_000);
          const answering = ui.press("Enter");
          await at.transport.held();
          await ui.type(keys);
          assert.equal(
            JSON.stringify([...ui.kept]),
            before,
            `${where}: no record changes in the flight`,
          );
          at.transport.release();
          await answering;
          await ui.idle();
          const shown = ui.actionId.value;
          assert.notEqual(shown, original, `${where}: the block is presented`);
          assert.equal(ui.field.value, "", `${where}: the block's field shows its own text`);
          assert.equal(ui.kept.get(original), unsentOf(sent, typed), where);
          for (const [action, text] of ui.kept)
            if (action !== original)
              assert.deepEqual(markers(text), [], `${where}: in no other record`);
          const posts = at.transport.posts.slice(from).filter((post) => post.op !== "observeInput");
          assert.deepEqual(
            markers(JSON.stringify(posts)),
            [],
            `${where}: no command acts on the block`,
          );
          const exported = await at.host.debugExportCandidate(
            () => ({}),
            new AbortController().signal,
          );
          assert.ok(exported !== null, where);
          const serialized = JSON.stringify(exported, (_key, value: unknown) =>
            typeof value === "bigint" ? String(value) : value,
          );
          assert.deepEqual(markers(serialized), [], `${where}: in no export`);
          await ui.complete(block.answer());
          await ui.idle();
          assert.equal(ui.actionId.value, original, `${where}: the question returns`);
          assert.equal(ui.field.value, unsentOf(sent, typed), `${where}: with its unsent text`);
          ui.unmount();
        }
  });

// An answer the drain sends has its own question: a block that suspends that one keeps the drain's text with it.
for (const topology of TOPOLOGIES)
  test(`a drained answer that a block overtakes keeps its text with its own question (${topology})`, async (context) => {
    const at = await page(context, topology);
    await at.start(
      `let a = askText "A?"\ntimer async hidden 60 s { ${BLOCKS.password.script} }\nlet c = askText "C?"\nexit`,
    );
    const ui = composer(at.host, { flight: true });
    ui.field.value = FIRST.text.aside;
    at.transport.hold("observeInput");
    const answering = ui.press("Enter");
    await at.transport.held();
    await ui.type(["M", "I", "D", "Enter", "T", "A", "I", "L"]);
    at.elapse(61_000);
    at.transport.release();
    await answering;
    await ui.idle();
    const next = [...ui.kept.keys()].find((action) => ui.kept.get(action) === "MIDTAIL");
    assert.ok(next !== undefined, "the drained answer's question keeps its text");
    await ui.complete(BLOCKS.password.answer());
    await ui.idle();
    assert.equal(ui.actionId.value, next);
    assert.equal(ui.field.value, "MIDTAIL");
    ui.unmount();
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
      // A date control in place of the text field: the flight leaves the composer to it.
      'let when = askDate "When?"\nshowButton "Done"',
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
          // The question holds what was left unsent: the answer's text, each later Enter's text, and the text typed
          // last (design round 2's end table, the throw row).
          assert.equal(ui.field.value, `${FIRST.text.aside}xy`);
          assert.equal(ui.kept.get(ui.actionId.value!), `${FIRST.text.aside}xy`);
        } else await answering;
        await ui.idle();
        assert.equal(ui.flight.holding.value, false);
        assert.equal(ui.isIntercepted(), false);
        assert.equal(ui.flightWrites.length, writes, "no write of the flight after it ended");
        // What the flight left unsent goes nowhere when its owner ends: no question keeps the Enter's text.
        if (exit !== "throw")
          assert.deepEqual(
            [...ui.kept.values()].filter((text) => text.includes("x")),
            [],
          );
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

// The exits the input section decides: an answer it retires ends the flight at once, as one whose session is gone; with
// no section, as before a session is prepared, the answer is not taken, and what was typed and given plays as after a
// refusal without a notice: each queued answer is not taken either.
for (const topology of TOPOLOGIES)
  test(`a flight ends with the input section's retirement, or settles without a section (${topology})`, async (context) => {
    const at = await page(context, topology);
    await at.start(`${FIRST.text.script}\n${NEXT.text}\nexit`);
    let retire: () => void = () => {};
    const retiring = new Promise<undefined>((resolve) => (retire = () => resolve(undefined)));
    const retired = composer(at.host, { flight: true, section: () => retiring });
    const from = at.transport.posts.length;
    retired.field.value = FIRST.text.aside;
    const answering = retired.press("Enter");
    await retired.type(["x", "Enter", "y"]);
    const writes = retired.flightWrites.length;
    retire();
    await answering;
    await retired.idle();
    assert.equal(retired.flight.holding.value, false);
    assert.equal(retired.isIntercepted(), false);
    assert.equal(retired.flightWrites.length, writes, "no write of the flight after it ended");
    assert.deepEqual(at.transport.posts.slice(from), [], "no answer posted");
    retired.unmount();

    for (const flight of [false, true]) {
      const none = composer(at.host, { flight, section: null });
      none.field.value = FIRST.text.aside;
      if (flight) {
        const answering = none.press("Enter");
        await none.type(["x", "Enter", "y"]);
        await answering;
      } else
        for (const key of ["Enter", "x", "Enter", "y"]) {
          await none.press(key);
          await none.idle();
        }
      await none.idle();
      assert.equal(none.field.value, `${FIRST.text.aside}xy`, `flight: ${flight}`);
      assert.equal(none.notice.value, "");
      assert.equal(none.isIntercepted(), false);
      none.unmount();
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
