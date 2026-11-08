import {
  BridgeLostError,
  BridgeRequestError,
  type BridgeClient,
  type BridgeResult,
  type SectionSend,
} from "./engine-bridge/client.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import type { HistoryTimeline } from "./engine-bridge/history/core.js";
import type { HistoryOpened, HistoryOpResult } from "./engine-bridge/ops/history.js";
import type { KeptRestore } from "./engine-bridge/ops/persistence.js";
import type { StartOptions, StartRandom } from "./engine-bridge/ops/session.js";
import type {
  CallViewReply,
  Introduction,
  Publication,
  ReadOp,
  ReadOps,
  StopReply,
  ExportCaptureReply,
} from "./engine-bridge/session-protocol.js";
import type { PreparedExport } from "./engine-bridge/recording/export-replay.js";
import type { StopArguments } from "./engine-bridge/recording/export-observation.js";
import type { PlayerSession } from "./runtime-view.js";
import type { HistoryMarks } from "./debug-history-marks.js";
import { SessionStore } from "./session-store.js";

/** How a request's publication reaches the UI: in place of the store's listener, in the same tick (see `apply`). */
export type PublishHook = (next: PlayerSession) => void;

/** What a reply to a request whose session the Player stopped is rejected with: nothing after the stop shows. */
function haltedError(): BridgeRequestError {
  return new BridgeRequestError({
    kind: "bridge",
    class: "BridgeRefusal",
    code: "halted",
    message: "The Player stopped this session.",
    ended: false,
  });
}

/**
 * The code of a refusal by the host, which changed nothing (`basis`, `session`, `halted`, ...), or `null` for any other
 * error, such as what an op threw.
 */
export function refusalCode(error: unknown): string | null {
  return error instanceof BridgeRequestError && error.kind === "bridge" ? error.code : null;
}

/**
 * Whether a request ended because its session or its Worker can take nothing more: refused as stopped (`halted`), or
 * lost with the Worker. Its caller then ends quietly: the stop or `bridgeLost` reports it once, and the caller's own
 * cleanup still runs.
 */
export function endsQuietly(error: unknown): boolean {
  return error instanceof BridgeLostError || refusalCode(error) === "halted";
}

/**
 * What a bridge throws when it is given a session handle of another bridge: session IDs restart per connection, so the
 * handle's ID would select one of this bridge's sessions instead. A string ID is always this connection's own.
 */
export class ForeignSessionError extends Error {
  constructor() {
    super("This Player session belongs to another engine bridge.");
    this.name = "ForeignSessionError";
  }
}

/**
 * What a service's chain gets in its section of the published session (`section` of the service hosts): an
 * observation inside the section, as `observeForInput` makes one, and the section's requests.
 */
export interface ServiceSection {
  /** The clock's now and media samples, observed (`observeTime`), with the stop checked before and after. */
  observe(): Promise<PlayerSession | null>;
  /**
   * One op of the section's session from `basis`; resolves with its result once its publication is applied to the
   * session's store. It shows only while this session owns the UI (`publishOwned`), so recheck that after the await.
   * `R` is the caller's unchecked assertion of the op's result.
   */
  send<R>(op: string, args: unknown, basis: number): Promise<R>;
}

/** A section of one session: requests that other requests of the session wait behind (`BridgeClient.section`). */
export interface SessionSection {
  /**
   * Sends `op` from `basis`, the store's revision by default; resolves with its result once its publication applied.
   * `R` is the caller's unchecked assertion of the op's result.
   */
  send<R = unknown>(
    op: string,
    args: unknown,
    options?: { readonly basis?: number; readonly publish?: PublishHook },
  ): Promise<R>;
  /** The session's latest publication in its store. */
  readonly session: PlayerSession;
}

/**
 * The Player's side of the engine bridge: the sessions it holds, each with its store, and the requests that operate
 * them. Every reply's publication goes to its session's store as it arrives (`ReplyHook`), so the store applies
 * publications in the host's order also when a transport delivers some early (the in-process facade's flush).
 */
export class PlayerBridge {
  readonly #client: BridgeClient;
  /**
   * The sessions' stores, held weakly: every publication of a session refers to its store (`lineage`), so a store goes
   * once the Player keeps no publication of its session, and the host then releases the session.
   */
  readonly #stores = new Map<string, WeakRef<SessionStore>>();
  #tracingIntents = 0;

  /**
   * The next serial of a tracing change on this connection (`TracingIntent`), which the host compares with the newest it
   * applied. The connection owns the count, so it rises across the Players that use the connection, one after another.
   */
  nextTracingIntent(): number {
    this.#tracingIntents += 1;
    return this.#tracingIntents;
  }
  /**
   * Whether a tracing serial was ever allocated on this connection (`nextTracingIntent`): true for the connection's
   * lifetime once one was, also for an off intent and for the current Player's own, and with no host acknowledgement.
   * An injected bridge that has one may still hold an earlier Player's tracing work in its queue.
   */
  get hasAllocatedTracingIntent(): boolean {
    return this.#tracingIntents > 0;
  }
  #randomIntents = 0;
  /**
   * The next serial of a random control change on this connection (`RandomIntent`), counted as tracing changes are
   * (`nextTracingIntent`).
   */
  nextRandomIntent(): number {
    this.#randomIntents += 1;
    return this.#randomIntents;
  }
  #historyIntents = 0;
  /** The next serial of a rewind history on this connection (`historyOpen`), counted as tracing changes are. */
  nextHistoryIntent(): number {
    this.#historyIntents += 1;
    return this.#historyIntents;
  }
  #player: symbol | null = null;
  #owners = 0;
  #owner = 0;

  /**
   * Takes the bridge for the live Player that `player` names (`PlayerSessionOptions.bridge`): one live Player per
   * bridge, as the connection's one trace serves one Debug. Returns the Player's generation on this bridge, which its
   * random control carries as its owner (`RandomIntent.owner`). Throws while another Player holds it.
   */
  claim(player: symbol): number {
    if (this.#player === player) return this.#owner;
    if (this.#player !== null)
      throw new Error(
        "One live Player per engine bridge: this bridge already serves a Player. Reuse it after the previous Player scope is disposed.",
      );
    this.#player = player;
    this.#owners += 1;
    this.#owner = this.#owners;
    return this.#owner;
  }
  /** Gives the bridge up for the next Player, when `player` holds it. */
  unclaim(player: symbol): void {
    if (this.#player === player) this.#player = null;
  }
  readonly #collected = new FinalizationRegistry<string>((id) => {
    if (this.#stores.get(id)?.deref() !== undefined) return;
    this.#stores.delete(id);
    void this.#client.request("release", null, { session: id }).catch(() => {});
  });

  constructor(client: BridgeClient) {
    this.#client = client;
  }

  get client(): BridgeClient {
    return this.#client;
  }

  /** Keeps the session `introduction` brings under `id`, which the host gave it, and returns its first publication. */
  open(id: string, introduction: Introduction): PlayerSession {
    const store = new SessionStore(id, this, introduction);
    this.#stores.set(id, new WeakRef(store));
    this.#collected.register(store, id, store);
    return store.session;
  }

  /**
   * `session`, when it is this bridge's; throws `ForeignSessionError` for another bridge's. Every method that takes a
   * `PlayerSession` checks it here first.
   */
  #own(session: PlayerSession): PlayerSession {
    if (session.connection !== this) throw new ForeignSessionError();
    return session;
  }

  /** The store of `session`, or `null` once it was released. A string is an ID on this connection. */
  store(session: PlayerSession | string): SessionStore | null {
    const id = typeof session === "string" ? session : this.#own(session).id;
    return this.#stores.get(id)?.deref() ?? null;
  }

  /** The store's latest publication of `session`, or `null` once it was released. */
  latest(session: PlayerSession): PlayerSession | null {
    return this.store(this.#own(session))?.session ?? null;
  }

  /** Starts a session of the held plan `plan`; resolves with its first publication. */
  async start(
    plan: string,
    options: StartOptions,
    recording: boolean,
    random?: StartRandom,
  ): Promise<PlayerSession> {
    const reply = await this.#client.request("start", {
      plan,
      options,
      recording,
      ...(random === undefined ? {} : { random }),
    });
    // EVIDENCE: validation: `start` replies from the same build with the new session and its introduction.
    return this.open(reply.session!, reply.view as Introduction);
  }

  /**
   * Reads `session` in the host with the op `op` on the Worker itself, which names the session in its arguments, after
   * the session's earlier requests (`ops/persistence.ts`). It changes no publication, so its reply applies nothing.
   */
  async read<O extends ReadOp>(
    session: PlayerSession,
    op: O,
    ...[args]: ReadOps[O]["args"] extends Record<string, never> ? [] : [ReadOps[O]["args"]]
  ): Promise<ReadOps[O]["result"]> {
    this.#own(session);
    const reply = await this.#client.request(
      op,
      { ...args, session: session.id },
      { after: session.id },
    );
    // EVIDENCE: validation: the result comes from the same build, whose `ReadOps` names this op's result.
    return reply.result as ReadOps[O]["result"];
  }

  /**
   * Restores a kept session in the host against its held plan `plan`; resolves with its first publication, or why it
   * does not go on: another plan, or an ended session. The engine's refusal of the state rejects, with its details.
   */
  async restoreKept(
    plan: string,
    planJson: string,
    snapshotJson: string,
    events: readonly InterpreterEvent[],
    /** The marks the session was kept with; the host validates them, as the rest of the kept state. */
    marks: HistoryMarks,
  ): Promise<PlayerSession | "otherPlan" | "ended"> {
    const reply = await this.#client.request("restoreKept", {
      plan,
      planJson,
      snapshotJson,
      events,
      marks,
    });
    // EVIDENCE: validation: `restoreKept` replies from the same build with its outcome and, restored, the new session.
    const outcome = reply.result as KeptRestore;
    if (outcome.kind !== "restored") return outcome.kind;
    // EVIDENCE: validation: a restored session's reply carries its id and introduction.
    return this.open(reply.session!, reply.view as Introduction);
  }

  #runs = 0;
  /** The next number of a diagnostic run on this connection (`beginRun`), counted as rewind histories are. */
  nextRun(): number {
    this.#runs += 1;
    return this.#runs;
  }

  /**
   * Begins diagnostic run `run` in the host, before the Start or Continue that makes it creates any session, and ends
   * `retires`, the Player's run before it (`ExportObservation`). Ordered before the requests sent after it.
   */
  async beginRun(run: number, retires: number | null): Promise<void> {
    await this.#client.request("beginRun", { run, retires });
  }

  /** Ends diagnostic run `run` (`retireRun`), as the Player that began it is disposed of. */
  async retireRun(run: number): Promise<void> {
    await this.#client.request("retireRun", { run });
  }

  /** Commits a Player error of a run that has no session to stop (`commitIncident`). */
  async commitIncident(stop: StopArguments): Promise<void> {
    await this.#client.request("commitIncident", stop);
  }

  /**
   * Captures a debug export of `session`, or of none, with the recording `recording` selects (`captureExport`), after the
   * session's earlier requests. `deliver` decides the candidate in the reply's hook, with the store's view of the session
   * then: before the request's promise resolves and before another reply applies.
   */
  async captureExport<T>(
    session: PlayerSession | null,
    recording: "current" | { readonly ticket: string },
    deliver: (reply: ExportCaptureReply, shown: PlayerSession | null) => T,
  ): Promise<T> {
    if (session !== null) this.#own(session);
    let delivered: { readonly value: T } | null = null;
    await this.#client.request(
      "captureExport",
      { session: session?.id ?? null, recording },
      {
        ...(session === null ? {} : { after: session.id }),
        onReply: (result) => {
          // EVIDENCE: validation: `captureExport` replies from the same build with `ExportCaptureReply`.
          const reply = result.result as ExportCaptureReply;
          delivered = { value: deliver(reply, session === null ? null : this.latest(session)) };
        },
      },
    );
    if (delivered === null) throw new Error("The export capture's reply was not delivered.");
    return (delivered as { readonly value: T }).value;
  }

  /** What export `ticket`'s file needs of the engine (`exportPrepare`): its plan's hash, and with `replay`, replay data. */
  async exportPrepare(ticket: string, replay: boolean): Promise<PreparedExport> {
    const reply = await this.#client.request("exportPrepare", { ticket, replay });
    // EVIDENCE: validation: `exportPrepare` replies from the same build with `PreparedExport`.
    return reply.result as PreparedExport;
  }

  /** Lets go of the recording or export held under `ticket` (`releaseRecording`); an unknown one changes nothing. */
  async releaseRecording(ticket: string): Promise<void> {
    await this.#client.request("releaseRecording", { ticket });
  }

  /**
   * Opens Debug's rewind history `intent` on this connection (`historyOpen`), unless a newer one is open (`stale`). The
   * sessions an earlier history released with its close are forgotten here.
   */
  async historyOpen(intent: number): Promise<HistoryOpened> {
    const reply = await this.#client.request("historyOpen", { intent });
    // EVIDENCE: validation: `historyOpen` replies from the same build with `HistoryOpened`.
    const opened = reply.result as HistoryOpened;
    if (opened.kind === "opened") this.#forget(opened.released);
    return opened;
  }

  /** The whole timeline of history `history` (`historyTimeline`), or `null` once it closed. */
  async historyTimeline(history: number): Promise<HistoryTimeline | null> {
    const reply = await this.#client.request("historyTimeline", { history });
    // EVIDENCE: validation: `historyTimeline` replies from the same build with a timeline or `null`.
    return reply.result as HistoryTimeline | null;
  }

  /**
   * Sends the rewind or history op `op` (`ops/history.ts`) of no session: the sessions it released are forgotten here,
   * and a session it restored is opened, with its introduction.
   */
  async historyStep(
    op:
      | "historyClose"
      | "rewindBack"
      | "rewindForward"
      | "rewindCommit"
      | "rewindDrop"
      | "rewindReturn"
      | "rewindAdopt",
    args: unknown,
  ): Promise<{ readonly result: HistoryOpResult; readonly restored: PlayerSession | null }> {
    const reply = await this.#client.request(op, args);
    // EVIDENCE: validation: the history ops reply from the same build with a `HistoryOpResult`.
    const result = reply.result as HistoryOpResult;
    if (result.kind === "done") this.#forget(result.released);
    // A prepared step brings its candidate; nothing is released until the page commits or drops it.
    const session = result.kind === "done" || result.kind === "prepared" ? reply.session : null;
    if (session === null) return { result, restored: null };
    // EVIDENCE: validation: a step that restored a session replies with its introduction.
    const introduction = reply.view as Introduction;
    return { result, restored: this.open(session, introduction) };
  }

  /** Forgets the stores of the sessions `ids`, which the host released itself. */
  #forget(ids: readonly string[]): void {
    for (const id of ids) {
      const store = this.store(id);
      if (store !== null) this.#collected.unregister(store);
      this.#stores.delete(id);
    }
  }

  /**
   * Sends one op of `session` from its store's revision (or `basis`); resolves with its result once applied. `R` is the
   * caller's unchecked assertion of the op's result: nothing binds it to `op` (unlike `read`'s `ReadOps`).
   */
  async request<R = unknown>(
    session: PlayerSession,
    op: string,
    args: unknown,
    options: { readonly basis?: number; readonly publish?: PublishHook } = {},
  ): Promise<R> {
    this.#own(session);
    return this.#send(
      session.id,
      (onReply) =>
        this.#client.request(op, args, {
          session: session.id,
          basis: options.basis ?? this.latest(session)?.revision ?? session.revision,
          onReply,
        }),
      options.publish,
    );
  }

  /**
   * Starts (`on`) or ends the call view of `session`'s publications (`viewCalls`). Its reply, the host's latest
   * publication's call view, is merged into the store's publication of the same revision as the reply arrives, before any
   * later reply applies; resolves with that merged session, or `null` when the store holds another revision by then.
   */
  async viewCalls(session: PlayerSession, on: boolean): Promise<PlayerSession | null> {
    this.#own(session);
    let merged: PlayerSession | null = null;
    await this.#send(
      session.id,
      (onReply) =>
        this.#client.request(
          "viewCalls",
          { on },
          {
            session: session.id,
            basis: this.latest(session)?.revision ?? session.revision,
            onReply: (result) => {
              onReply(result);
              // EVIDENCE: validation: `viewCalls` replies from the same build with a `CallViewReply`.
              merged =
                this.store(session.id)?.mergeCallView(result.result as CallViewReply) ?? null;
            },
          },
        ),
      undefined,
    );
    return merged;
  }

  /** Runs `body` as one exclusive section of `session`; see `SessionSection`. */
  section<T>(session: PlayerSession, body: (section: SessionSection) => Promise<T>): Promise<T> {
    this.#own(session);
    return this.#client.section(session.id, (send: SectionSend) => {
      const shown = () => this.latest(session) ?? session;
      return body({
        send: (op, args, options = {}) =>
          this.#send(
            session.id,
            (onReply) =>
              send(
                op,
                args,
                options.basis ?? this.latest(session)?.revision ?? session.revision,
                onReply,
              ),
            options.publish,
          ),
        get session() {
          return shown();
        },
      });
    });
  }

  async #send<R>(
    id: string,
    post: (onReply: (result: BridgeResult) => void) => Promise<BridgeResult>,
    publish: PublishHook | undefined,
  ): Promise<R> {
    let fenced = false;
    const reply = await post((result) => {
      const store = this.store(id);
      // A reply after the stop's acknowledgement is of nothing that ran before the stop: it never shows.
      fenced = store?.halted === true;
      // EVIDENCE: validation: a session op's view is its publication, from the same build, or null.
      store?.apply(result.view as Publication | null, publish);
    });
    if (fenced) throw haltedError();
    // EVIDENCE: validation: the op's result comes from the same build as its caller expects it.
    return reply.result as R;
  }

  /**
   * Delivers the replies of a session still in transit, at once, where the transport can (the in-process backend);
   * `null` with a Worker, whose replies arrive as they do.
   */
  deliverInTransit: ((session: string) => void) | null = null;

  /**
   * Stops `session` at a Player error, `stop` naming the error with its run and stop (`null` for a session that is only
   * superseded). The host refuses whatever the session has not run (`halt`), so late answers and
   * reports are dropped; the store still applies the replies to ops the host ran, which arrive before the host's
   * acknowledgement, and freezes there. What is shown is then what the host ran, which its recording and export hold.
   * Resolves once frozen: at once in-process, a round trip later with a Worker.
   */
  halt(session: PlayerSession, stop: StopArguments | null = null): Promise<void> {
    const store = this.store(this.#own(session));
    if (store === null || store.halted) return Promise.resolve();
    store.stopping();
    const acknowledged = this.#client
      .signal("halt", stop, session.id, (result) =>
        store.freeze(
          // EVIDENCE: validation: a Player session's `halt` acknowledgement carries a `CallViewReply`, a `StopReply` for
          // a Player error stop, or `null`.
          result.result as CallViewReply | StopReply | null,
        ),
      )
      .then(
        () => {},
        () => store.freeze(),
      );
    this.deliverInTransit?.(session.id);
    return acknowledged;
  }

  /** Whether `session`'s store froze at a stop, as it does at once in-process. */
  frozen(session: PlayerSession): boolean {
    return this.store(this.#own(session))?.halted ?? true;
  }

  /** Forgets `session`'s local store now, and queues the host's release after the session's earlier work. */
  release(session: PlayerSession): void {
    const store = this.store(this.#own(session));
    if (store === null) return;
    this.#collected.unregister(store);
    this.#stores.delete(session.id);
    void this.#client.request("release", null, { session: session.id }).catch(() => {});
  }
}

/** The bridge a main-side session belongs to. */
export function bridgeOf(session: PlayerSession): PlayerBridge {
  return session.connection;
}
