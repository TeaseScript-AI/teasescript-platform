import assert from "node:assert/strict";
import { effectScope, nextTick, watch, type Ref } from "vue";

import type { BridgeResult } from "../../../player/engine-bridge/client.js";
import type { UntypedSend } from "./untyped.js";
import type { Publication } from "../../../player/engine-bridge/session-protocol.js";
import type { PlayerBridge, PublishHook } from "../../../player/runtime/player-bridge.js";
import {
  activatePlayerRuntimeButton,
  answeredByPlayerInput,
  applyPlayerRuntimeStorageEdit,
  answerPlayerRuntimeCapture,
  answerPlayerRuntimeFileStore,
  answerPlayerRuntimeLock,
  cancelPlayerRuntimeForm,
  stepPlayerRuntimeFormField,
  closePlayerRuntimeExport,
  closePlayerRuntimePopup,
  completePlayerRuntimeStorageWrite,
  observePlayerRuntimeTime,
  openPlayerRuntimeUrl,
  playerRuntimeSnapshot,
  pressPlayerRuntimePermanentButton,
  reportPlayerRuntimeMediaLoad,
  restorePlayerRuntimeSessionAt,
  selectPlayerRuntimeChoice,
  skipPlayerRuntimeImage,
  skipPlayerRuntimePacing,
  stepPlayerRuntimeTime,
  submitPlayerRuntimeComposer,
  submitPlayerRuntimeForm,
  type PlayerCaptureAnswer,
  type PlayerFileStoreAnswer,
  type PlayerLockAnswer,
  type PlayerRuntimeSession,
} from "../../../player/runtime/runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimePacingGate,
} from "../../../player/runtime/runtime-view.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import type { MediaLoadReport } from "../../../src/runtime/operations/media-reports.js";
import type { DebugAnswerInput } from "../../../player/debug/debug-export.js";
import type { MediaProgressReport } from "../../../src/playback.js";
import type { PlayerSession } from "../../../player/runtime/runtime-view.js";
import type { CapturedMediaStore } from "../../../player/media/captured-media.js";
import {
  LiveHostEffects,
  type EffectSample,
  type FakeMedium,
  type LiveHostOptions,
} from "../live-host-effects.js";
import { compareStructures, renderPath } from "../runtime-state-comparison.js";
import type { ClockTicket } from "../../../player/runtime/clock-ticket.js";
import { untypedClient } from "./untyped.js";

/*
 * The shared replay harness (#1919; docs/TESTING.md "Replay through the bridge"): a complete, cursor-based trace of the
 * publications a session's store applies after a quiescent cut; an independent oracle of the same trace, the adapter
 * restored at the cut and given the live run's requests after it, whatever sent them; and a live host, the real
 * composable, that observes every publication and settles before the next, with its effects sampled after each step and
 * every judgment made while it lives.
 */

/**
 * The fields a publication may carry, and whether the trace compares each. A publication with another field, or
 * without one of these, fails the trace: a new field (such as L5h.3's `historyPoint`) is declared here, compared or not.
 * `instructions` and `callView` are L5f's, with no source independent of the host; the trace does not compare them.
 * `marks` are Debug's metadata for a debug export, which no engine call changes; a restore at the cut takes none, and
 * `history` is Debug's rewind timeline, which follows no history across the cut.
 */
const PUBLICATION_FIELDS: Readonly<Record<keyof Publication, "compared" | "not compared">> = {
  revision: "compared",
  state: "compared",
  from: "compared",
  eventsThrough: "compared",
  events: "compared",
  instructions: "not compared",
  callView: "not compared",
  marks: "not compared",
  diagnostic: "compared",
  incident: "compared",
  history: "not compared",
};

/** One publication after the cut, by value, its revision and cursors relative to the publication before the cut. */
export interface TraceEntry {
  /** Whether the store applied it; every publication after a cut must be applied. */
  readonly applied: boolean;
  readonly revision: number;
  readonly from: number;
  readonly through: number;
  readonly events: readonly unknown[];
  readonly state: unknown;
  /**
   * What the store holds once it applied the publication: its session's state, and every event it accumulated since the
   * cut, by value. A store that applies a publication otherwise than it arrived differs here.
   */
  readonly held: ConsumerValue | null;
}

/** What a consumer of publications holds at one of them: the state, and the events since the cut, by value. */
export interface ConsumerValue {
  readonly state: unknown;
  readonly events: readonly unknown[];
}

/** A tap on one session's store: the publications it applied from the cut, and the fields it did not expect. */
export interface PublicationTap {
  readonly entries: readonly TraceEntry[];
  /** Each publication's fields that `PUBLICATION_FIELDS` does not declare, or declares and it lacked. */
  readonly undeclared: readonly string[];
  /** Removes the tap; the store applies as before. */
  stop(): void;
}

/** What the tap reads of a session's publication: its revision and the events its store holds. */
export interface TappedSession {
  readonly revision: number;
  readonly state: unknown;
  readonly events: readonly unknown[];
}

/** What the tap needs of a bridge: the test build's `PlayerBridge`, or the Player bundle's, the same class. */
export interface TappedBridge<S extends TappedSession> {
  store(session: S): { apply(view: Publication | null, publish?: PublishHook): boolean } | null;
  latest(session: S): S | null;
}

/**
 * Taps the store of `session`, from its latest publication on (the cut): every publication it is given is recorded by
 * value, relative to that publication's revision and event cursor, whether or not it applies. Both producers reach the
 * store here: replies, and the in-process backend's facade.
 */
export function tapPublications<S extends TappedSession>(
  bridge: TappedBridge<NoInfer<S>>,
  session: S,
): PublicationTap {
  const store = bridge.store(session);
  const cut = bridge.latest(session);
  assert.ok(store !== null && cut !== null, "the session is held");
  const r0 = cut.revision;
  const c0 = cut.events.length;
  const entries: TraceEntry[] = [];
  const undeclared: string[] = [];
  const apply = store.apply.bind(store);
  const declared = Object.keys(PUBLICATION_FIELDS);
  store.apply = (view, publish) => {
    if (view !== null) {
      const keys = Object.keys(view);
      for (const key of keys) if (!declared.includes(key)) undeclared.push(`unexpected '${key}'`);
      for (const key of declared) if (!keys.includes(key)) undeclared.push(`missing '${key}'`);
    }
    const applied = apply(view, publish);
    if (view !== null) {
      const held = applied ? bridge.latest(session) : null;
      entries.push({
        applied,
        revision: view.revision - r0,
        from: view.from - c0,
        through: view.eventsThrough - c0,
        events: structuredClone(view.events),
        state: structuredClone(view.state),
        held:
          held === null
            ? null
            : {
                state: structuredClone(held.state),
                events: structuredClone(held.events.slice(c0)),
              },
      });
    }
    return applied;
  };
  return {
    entries,
    undeclared,
    stop: () => {
      Reflect.deleteProperty(store, "apply");
    },
  };
}

/** One request a bridge's client sent, by value, and how it ended. */
export interface LoggedRequest {
  readonly session: string | null;
  readonly op: string;
  readonly args: unknown;
  /** Its reply's result; a refusal by the bridge (which changed nothing) or what the op threw; `null` while in flight. */
  ended:
    | { readonly ok: true; readonly result: unknown }
    | { readonly ok: false; readonly name: string; readonly refused: boolean }
    | null;
}

/**
 * The requests a bridge's client sends, of every producer (the test's steps and the composable's own work): their log,
 * in the order sent, which per session is the order the host applies them, and how many are in flight.
 */
export interface RequestTracker {
  readonly log: readonly LoggedRequest[];
  inFlight(): number;
  /** Ends the count; the client sends as before. */
  stop(): void;
}

/** Logs and counts `bridge`'s requests, signals and section sends from now on. */
export function trackRequests(bridge: Pick<PlayerBridge, "client">): RequestTracker {
  // The wrappers forward each op as it is sent, whatever it is: the client as its transport carries requests.
  const client = untypedClient(bridge.client);
  const { request, signal, section } = client;
  const log: LoggedRequest[] = [];
  let open = 0;
  const counted = (
    session: string | null,
    op: string,
    args: unknown,
    send: () => Promise<BridgeResult>,
  ): Promise<BridgeResult> => {
    const entry: LoggedRequest = { session, op, args: structuredClone(args), ended: null };
    log.push(entry);
    open += 1;
    return send().then(
      (reply) => {
        open -= 1;
        entry.ended = { ok: true, result: structuredClone(reply.result) };
        return reply;
      },
      (error: unknown) => {
        open -= 1;
        entry.ended = {
          ok: false,
          name: error instanceof Error ? error.name : String(error),
          refused: error instanceof Error && "kind" in error && error.kind === "bridge",
        };
        throw error;
      },
    );
  };
  client.request = (op, args, options) =>
    counted(options?.session ?? null, op, args, () => request.call(client, op, args, options));
  client.signal = (op, args, session, onReply) =>
    counted(session, op, args, () => signal.call(client, op, args, session, onReply));
  const sectionOf = section.bind(client);
  client.section = <T>(
    id: string,
    ticket: ClockTicket,
    body: (send: UntypedSend) => Promise<T>,
  ): Promise<T> =>
    sectionOf<T>(id, ticket, (send) =>
      body((op, args, basis, onReply) =>
        counted(id, op, args, () => send(op, args, basis, onReply)),
      ),
    );
  return {
    log,
    inFlight: () => open,
    stop: () => {
      client.request = request;
      client.signal = signal;
      client.section = section;
    },
  };
}

/**
 * Waits until `session` is quiescent, as the oracle's cut assumes: no request of the bridge in flight, every reply in
 * transit delivered, and the latest publication unchanged across one more `settle()` (the composable idle).
 */
export async function quiesce(
  bridge: PlayerBridge,
  session: PlayerSession,
  tracker: RequestTracker,
  settle: () => Promise<void>,
): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    bridge.deliverInTransit?.(session.id);
    const revision = bridge.latest(session)?.revision;
    await settle();
    if (tracker.inFlight() === 0 && bridge.latest(session)?.revision === revision) return;
  }
  assert.fail("the session did not settle before the cut");
}

/** One step the test takes after the cut: its request over the bridge, from the shown session. */
export interface ReplayStep {
  readonly name: string;
  request(shown: PlayerSession): { readonly op: string; readonly args: unknown };
}

/**
 * The adapter's call for each op a live run sends after the cut, as the host's op makes it from the same arguments
 * (`ops/session.ts`, `ops/input.ts`). An op without an entry fails the oracle: it is added here.
 */
type AdapterCall = (
  session: PlayerRuntimeSession,
  args: Record<string, unknown>,
) => { readonly session: PlayerRuntimeSession; readonly outcome: unknown } | null;

/**
 * An interaction op as the host's `interactionOp` makes it (`ops/input.ts`): another presented action is refused as
 * `staleAction` without effect, else `answer` runs on the session.
 */
const presented =
  (
    answer: (
      session: PlayerRuntimeSession,
      args: Record<string, unknown>,
    ) => ReturnType<AdapterCall>,
  ): AdapterCall =>
  (session, args) =>
    activePlayerRuntimeInteraction(session.state)?.actionId !== args["actionId"]
      ? { session, outcome: { kind: "staleAction", actionId: args["actionId"] } }
      : answer(session, args);

export const ADAPTER_OPS = {
  observeTime: (session, args) => {
    // EVIDENCE: validation: the host accepted `atMs` as a scene time (`ops/session.ts`).
    const atMs = args["atMs"] as number;
    // EVIDENCE: validation: the host accepted `media` as media progress reports (`ops/session.ts`).
    const media = args["media"] as readonly MediaProgressReport[];
    return observePlayerRuntimeTime(session, atMs, media);
  },
  selectChoice: presented((session, args) => {
    // EVIDENCE: validation: the host accepted `optionId` as a string and `input` as an answer input (`ops/input.ts`).
    const optionId = args["optionId"] as string;
    // EVIDENCE: validation: as above.
    const input = (args["input"] ?? null) as DebugAnswerInput | null;
    const select = (current: PlayerRuntimeSession) => selectPlayerRuntimeChoice(current, optionId);
    return input === null
      ? select(session)
      : answeredByPlayerInput(session, input, () => select(session));
  }),
  // The ops the L5 gate's K/F tapes send (`tests/gate/candidates.ts`), each as its host op calls the adapter, from the
  // arguments the host accepted (`ops/input.ts`, `ops/resources.ts`, `ops/media.ts`, `ops/session.ts`). The tapes send
  // no `input`, so none is recorded as how the player answered.
  submitComposer: presented((session, args) => {
    // EVIDENCE: validation: the host accepted `text` as a string.
    const text = args["text"] as string;
    return submitPlayerRuntimeComposer(session, text);
  }),
  activateButton: presented((session) => activatePlayerRuntimeButton(session)),
  submitForm: presented((session, args) => {
    // EVIDENCE: validation: the host accepted `draft` as a string or null.
    const draft = args["draft"] as string | null;
    return submitPlayerRuntimeForm(session, draft ?? undefined);
  }),
  cancelForm: presented((session) => cancelPlayerRuntimeForm(session)),
  stepFormField: presented((session, args) => {
    // EVIDENCE: validation: the host accepted `fieldId` as a string.
    const fieldId = args["fieldId"] as string;
    // EVIDENCE: validation: the host accepted `draft` as a string or null.
    const draft = args["draft"] as string | null;
    return stepPlayerRuntimeFormField(session, fieldId, draft ?? undefined);
  }),
  skipImage: presented((session) => skipPlayerRuntimeImage(session)),
  openUrl: presented((session) => openPlayerRuntimeUrl(session)),
  closePopup: presented((session) => closePlayerRuntimePopup(session)),
  closeExport: presented((session) => closePlayerRuntimeExport(session)),
  pressPermanentButton: (session, args) => {
    // EVIDENCE: validation: the host accepted `buttonId` as a number.
    const buttonId = args["buttonId"] as number;
    return pressPlayerRuntimePermanentButton(session, buttonId);
  },
  completeStorageWrite: (session, args) => {
    // EVIDENCE: validation: the host accepted `actionId` as a number.
    const actionId = args["actionId"] as number;
    // EVIDENCE: validation: the host accepted `stored` as a boolean.
    const stored = args["stored"] as boolean;
    return completePlayerRuntimeStorageWrite(session, actionId, stored);
  },
  // The tapes' resource answers carry `held: null`, so no captured media is admitted.
  answerCapture: (session, args) => {
    // EVIDENCE: validation: the host accepted `actionId` as a number.
    const actionId = args["actionId"] as number;
    // EVIDENCE: validation: the host accepted a capture answer.
    const answer = args["answer"] as PlayerCaptureAnswer;
    return answerPlayerRuntimeCapture(session, actionId, answer);
  },
  answerFileStore: (session, args) => {
    // EVIDENCE: validation: the host accepted `actionId` as a number.
    const actionId = args["actionId"] as number;
    // EVIDENCE: validation: the host accepted a file-store answer record; the engine validates it.
    const answer = args["answer"] as PlayerFileStoreAnswer;
    return answerPlayerRuntimeFileStore(session, actionId, answer);
  },
  answerLock: (session, args) => {
    // EVIDENCE: validation: the host accepted `actionId` as a number.
    const actionId = args["actionId"] as number;
    // EVIDENCE: validation: the host accepted a lock answer record; the engine validates it.
    const answer = args["answer"] as PlayerLockAnswer;
    return answerPlayerRuntimeLock(session, actionId, answer);
  },
  reportMediaLoad: (session, args) => {
    // EVIDENCE: validation: the host accepted `mediaId` as a number.
    const mediaId = args["mediaId"] as number;
    // EVIDENCE: validation: the host accepted `report` as a record; the engine validates it.
    const report = args["report"] as MediaLoadReport;
    return reportPlayerRuntimeMediaLoad(session, mediaId, report);
  },
  // As `ops/session.ts`: a skip of another gate than the one shown does nothing.
  skipPacing: (session, args) =>
    playerRuntimePacingGate(session)?.actionId === args["actionId"]
      ? skipPlayerRuntimePacing(session)
      : null,
  applyStorageEdit: (session, args) => {
    // EVIDENCE: validation: the host accepted `key` as a string; the engine validates the value.
    const edit = args as { readonly key: string; readonly value: SerializableRuntimeValue };
    return applyPlayerRuntimeStorageEdit(session, edit);
  },
  stepTime: (session, args) => {
    // EVIDENCE: validation: the host accepted `targetMs` as a scene time.
    const next = stepPlayerRuntimeTime(session, args["targetMs"] as number);
    return { session: next, outcome: { moved: next !== session } };
  },
} satisfies Readonly<Record<string, AdapterCall>>;

/** `ADAPTER_OPS` by op name, for a request whose op is a string: `undefined` for an op the oracle has no path for. */
export function adapterCall(op: string): AdapterCall | undefined {
  const calls: Readonly<Record<string, AdapterCall>> = ADAPTER_OPS;
  return Object.hasOwn(calls, op) ? calls[op] : undefined;
}

/**
 * Fails unless every one of `requests` (a session's after the cut) is an engine input the oracle replays, also when the
 * bridge refused it: a service's completion (`answerCapture`, a storage acknowledgement, a media report) by any route
 * is an effect of the replay.
 */
export function assertEngineInputs(requests: readonly LoggedRequest[]): void {
  for (const request of requests)
    assert.ok(
      Object.hasOwn(ADAPTER_OPS, request.op),
      `'${request.op}' was sent after the cut, which is no engine input the oracle replays (ADAPTER_OPS in tests/helpers/bridge/replay-harness.ts): a service completion, or an input to add there`,
    );
}

/**
 * The oracle of a trace: `restored`, the adapter's session restored at the publication before the cut, given the live
 * run's requests of the session after the cut, in order, whatever sent them (`requests`, from `trackRequests`). A
 * request the bridge refused changed nothing and is skipped; one whose op threw must throw the same on the adapter and
 * leaves its session as it was. Each request that changes the session is one publication, as the host publishes it
 * (`ops/session.ts` `publishing`): its state without the active calls, and the events after the last one's, relative to
 * the restored session. Each result must be the adapter's.
 */
export function adapterReplay(
  restored: PlayerRuntimeSession,
  requests: readonly LoggedRequest[],
): { readonly entries: readonly TraceEntry[]; readonly last: PlayerRuntimeSession } {
  const r0 = restored.revision;
  const e0 = restored.events.length;
  let session = restored;
  let cursor = e0;
  const entries: TraceEntry[] = [];
  for (const [index, request] of requests.entries()) {
    const ended = request.ended;
    assert.ok(ended !== null, `request ${index} (${request.op}) after the cut had not ended`);
    assertEngineInputs([request]);
    const call = adapterCall(request.op)!;
    if (!ended.ok && ended.refused) continue;
    // EVIDENCE: validation: every op the Player sends takes an object of arguments.
    const args = request.args as Record<string, unknown>;
    if (!ended.ok) {
      // On a copy of the session, which the throw leaves unusable; the bridge recovers at the publication before it.
      const copy = restorePlayerRuntimeSessionAt(
        session.plan,
        JSON.stringify(playerRuntimeSnapshot(session)),
        [],
      );
      assert.throws(
        () => call(copy, args),
        (error: unknown) => error instanceof Error && error.name === ended.name,
        `request ${index} (${request.op}) threw ${ended.name} over the bridge`,
      );
      continue;
    }
    const made = call(session, args);
    // An op that does nothing (a mandatory image's skip) returns `null` on both sides: a recorded decline, no publication.
    if (made === null) {
      assert.equal(
        ended.result,
        null,
        `request ${index} (${request.op}) did nothing on the adapter`,
      );
      continue;
    }
    assert.deepEqual(
      ended.result,
      structuredClone(made.outcome),
      `request ${index} (${request.op}): its result differs from the adapter's`,
    );
    const next = made.session;
    if (next === session) continue;
    const { calls: _calls, ...state } = next.state;
    entries.push({
      applied: true,
      revision: next.revision - r0,
      from: cursor - e0,
      through: next.events.length - e0,
      events: structuredClone(next.events.slice(cursor)),
      state: structuredClone(state),
      held: { state: structuredClone(state), events: structuredClone(next.events.slice(e0)) },
    });
    cursor = next.events.length;
    session = next;
  }
  return { entries, last: session };
}

/**
 * Judges a tapped trace against its oracle: every field declared, every publication applied, cursors contiguous from
 * the cut, and the same publications, by value, in the same number. A mismatch names its entry and its first path.
 */
export function assertTrace(tap: PublicationTap, oracle: readonly TraceEntry[]): void {
  assert.deepEqual(
    tap.undeclared,
    [],
    `A publication's fields differ from those declared in tests/helpers/bridge/replay-harness.ts (PUBLICATION_FIELDS): ${[...new Set(tap.undeclared)].join(", ")}. Declare the field there, and whether the trace compares it.`,
  );
  const entries = tap.entries;
  entries.forEach((entry, index) => {
    assert.equal(entry.applied, true, `publication ${index} after the cut was not applied`);
    assert.equal(
      entry.from,
      index === 0 ? 0 : entries[index - 1]!.through,
      `publication ${index}: its cursor does not continue`,
    );
    assert.equal(
      entry.events.length,
      entry.through - entry.from,
      `publication ${index}: its events do not fill its cursor range`,
    );
  });
  assert.equal(
    entries.length,
    oracle.length,
    `${entries.length} publications after the cut, the oracle's ${oracle.length}`,
  );
  oracle.forEach((expected, index) => {
    const comparison = compareStructures(expected, entries[index]);
    const first = comparison.mismatches[0];
    assert.ok(
      comparison.equal,
      first === undefined
        ? `publication ${index} differs`
        : `publication ${index} differs at ${renderPath(first.path)}: oracle ${first.oracle}, bridge ${first.candidate}`,
    );
  });
}

/** What the live host's composable is, from the Player bundle (`loadPlayerModule`). */
export interface LiveHostModules {
  readonly usePlayerSession: (options: LiveHostOptions<PlayerBridge>) => LiveComposable;
  /** The bundle's captured-media store class, which the composable makes its own store of. */
  readonly capturedMediaStore: { prototype: CapturedMediaStore };
}

/** The composable's host API the harness drives. */
export interface LiveComposable {
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly bridge: Promise<PlayerBridge>;
  loadScriptStorage(): Promise<void>;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): Promise<void>;
  update(next: PlayerSession): void;
}

/** One session the composable showed: its revision, state and every event it held, by value, as it showed them. */
export interface ShownSession {
  readonly revision: number;
  readonly state: unknown;
  readonly events: readonly unknown[];
}

/** A composable that lives while `body` runs, and what the harness gives `body` of it. */
export interface LiveHost {
  readonly player: LiveComposable;
  /** The bridge the composable runs on, its in-process backend. */
  readonly bridge: PlayerBridge;
  /** Hands `next` to the composable in the tick its store applies it: the publish hook of a step's request. */
  readonly show: PublishHook;
  /** Lets the composable's watchers and the work they start run, before the next step. */
  settle(): Promise<void>;
  /** Each recorded host service's state by value and its mutating calls so far (`LiveHostEffects`). */
  effects(): Promise<EffectSample>;
  /** Every session the composable showed, by value, in order, from the start. */
  readonly observed: readonly ShownSession[];
  /** The media elements the composable made. */
  readonly elements: readonly FakeMedium[];
  /** Runs a judgment, only while the composable lives. */
  judge<T>(judgment: () => T): T;
}

/**
 * Runs `body` with a live composable on the in-process backend `bridge`: the host services it is given or makes
 * recorded as `LiveHostEffects` names them, the scene clock standing still, and a fake `Audio` whose elements keep their state as a
 * real element does (a play leaves it playing), so that a publication it observes again does not look like a medium to
 * start again. Every judgment runs inside `body`; the composable stops, and the globals are restored, only after it.
 */
export async function withLiveHost<T>(
  modules: LiveHostModules,
  bridge: PlayerBridge,
  body: (host: LiveHost) => Promise<T>,
): Promise<T> {
  const effects = new LiveHostEffects();
  const surface = {
    document: effects.eventTarget("document", { visibilityState: "visible" }),
    window: effects.eventTarget("window", {}),
    Audio: effects.audio(),
  };
  const previous = Object.keys(surface).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(surface))
    Object.defineProperty(globalThis, name, { configurable: true, value });
  const now = performance.now;
  // The scene clock stands still: only the steps move time.
  performance.now = () => 0;
  effects.install(modules.capturedMediaStore);
  const scope = effectScope();
  let alive = true;
  try {
    const player = scope.run(() =>
      modules.usePlayerSession(effects.options(Promise.resolve(bridge))),
    )!;
    const observed: ShownSession[] = [];
    scope.run(() =>
      watch(
        player.session,
        (next) => {
          if (next !== null)
            observed.push({
              revision: next.revision,
              state: structuredClone(next.state),
              events: structuredClone(next.events),
            });
        },
        { flush: "sync" },
      ),
    );
    return await body({
      player,
      bridge,
      show: (next) => player.update(next),
      settle: async () => {
        await nextTick();
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      effects: () => effects.sample(),
      observed,
      elements: effects.elements,
      judge: (judgment) => {
        assert.ok(alive, "a judgment runs only while the live host lives");
        return judgment();
      },
    });
  } finally {
    alive = false;
    scope.stop();
    effects.uninstall();
    performance.now = now;
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
}
