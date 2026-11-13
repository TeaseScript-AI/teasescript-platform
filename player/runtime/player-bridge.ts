import {
  BridgeLostError,
  BridgeRequestError,
  type BridgeClient,
  type BridgeResult,
  type PostDisposition,
  type ReplyHook,
  type SectionSend,
} from "../engine-bridge/client.js";
import type { OpArgs, OpResult, SessionOp, WorkerOp } from "../engine-bridge/op-catalogue.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import type { ClockTicket } from "./clock-ticket.js";
import type { HistoryTimeline } from "../engine-bridge/history/core.js";
import type {
  HistoryCloseArguments,
  HistoryCloseObligation,
  HistoryOpResult,
  HistoryRenewed,
} from "../engine-bridge/ops/history.js";
import type { StartOptions, StartRandom } from "../engine-bridge/ops/session.js";
import type {
  Introduction,
  Publication,
  ReadOp,
  ReadCall,
  ReadOps,
  ExportCaptureReply,
  ExportIdentity,
} from "../engine-bridge/session-protocol.js";
import type { PreparedExport } from "../engine-bridge/recording/export-replay.js";
import type { RunBegin, StopArguments } from "../engine-bridge/recording/export-observation.js";
import type { PlayerSession } from "./runtime-view.js";
import type { HistoryMarks } from "../debug/debug-history-marks.js";
import { SessionStore } from "../persistence/session-store.js";

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
 * What a service's chain gets in its section of the published session (`section` of the service hosts): the section's
 * requests. The clock observes before the chain runs (its `service` row), and the chain receives that observation.
 */
export interface ServiceSection {
  /**
   * One op of the section's session from `basis`; resolves with its result once its publication is applied to the
   * session's store. It shows only while this session owns the UI (`publishOwned`), so recheck that after the await.
   */
  send<O extends SessionOp>(
    ...call: O extends unknown ? [op: O, args: OpArgs<O>, basis: number] : never
  ): Promise<OpResult<O>>;
}

/** What a session op's request takes besides its op and arguments: its basis, and how its publication shows. */
export interface SessionRequestOptions {
  readonly basis?: number;
  readonly publish?: PublishHook;
}

/** A section of one session: requests that other requests of the session wait behind (`BridgeClient.section`). */
export interface SessionSection {
  /**
   * Sends `op` from `basis`, the store's revision by default; resolves with its result once its publication applied.
   */
  send<O extends SessionOp>(
    ...call: O extends unknown ? [op: O, args: OpArgs<O>, options?: SessionRequestOptions] : never
  ): Promise<OpResult<O>>;
  /** The session's latest publication in its store. */
  readonly session: PlayerSession;
}

/** Whether `view`, the store's view of a session, is the publication `identity` names, with its stop identity. */
function matches(view: PlayerSession | null, identity: ExportIdentity): boolean {
  return (
    view !== null &&
    view.revision === identity.revision &&
    view.events.length === identity.eventsThrough &&
    view.diagnostic.run === identity.run &&
    view.diagnostic.stop === identity.stop
  );
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
  /** The next serial of a rewind history on this connection (`historyRenew`), counted as tracing changes are. */
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

  /** Starts a session of the held plan `plan` in run `run`; resolves with its first publication. */
  async start(
    plan: string,
    options: StartOptions,
    recording: boolean,
    random?: StartRandom,
    run?: RunBegin,
  ): Promise<PlayerSession> {
    const reply = await this.#client.request("start", {
      plan,
      options,
      recording,
      ...(random === undefined ? {} : { random }),
      ...(run === undefined ? {} : { run }),
    });
    // EVIDENCE: validation: `start` replies from the same build with the new session and its introduction.
    return this.open(reply.session!, reply.view as Introduction);
  }

  /**
   * Reads `session` in the host with the op `op` on the Worker itself, which names the session in its arguments, after
   * the session's earlier requests (`ops/persistence.ts`). It changes no publication, so its reply applies nothing.
   */
  read<O extends ReadOp>(
    session: PlayerSession,
    ...call: ReadCall<O>
  ): Promise<ReadOps[O]["result"]>;
  async read<O extends ReadOp>(
    session: PlayerSession,
    op: O,
    ...[args]: [] | [ReadOps[O]["args"]]
  ): Promise<ReadOps[O]["result"]> {
    this.#own(session);
    const reply = await this.#client.request<ReadOp>(
      // EVIDENCE: invariant: an op of `ReadOps`, sent with its own arguments below.
      op as never,
      // EVIDENCE: invariant: `O`'s arguments, `args` with `session` inserted, which TypeScript does not pair with `O`.
      { ...args, session: session.id } as never,
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
    const outcome = reply.result;
    if (outcome.kind !== "restored") return outcome.kind;
    // EVIDENCE: validation: a restored session's reply carries its id and introduction.
    return this.open(reply.session!, reply.view as Introduction);
  }

  #runs = 0;
  /** The next number of a diagnostic run on this connection (`RunBegin`), counted as rewind histories are. */
  nextRun(): number {
    this.#runs += 1;
    return this.#runs;
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
   * session's earlier requests. In the reply's hook, before the request's promise resolves and before another reply
   * applies, a capture of a session is matched against the store's view of it then: its revision, event boundary and
   * diagnostic identity. One that does not match, as after a publication the page never received, is refused
   * (`identity`) and released. `deliver` then decides the candidate with that view.
   */
  async captureExport<T>(
    session: PlayerSession | null,
    recording: "current" | "none" | { readonly ticket: string },
    deliver: (reply: ExportCaptureReply, shown: PlayerSession | null) => T,
  ): Promise<T> {
    if (session !== null) this.#own(session);
    const delivered: { outcome?: { readonly value: T } } = {};
    await this.#client.request(
      "captureExport",
      { session: session?.id ?? null, recording },
      {
        ...(session === null ? {} : { after: session.id }),
        onReply: (result) => {
          const reply = result.result;
          const view = session === null ? null : this.latest(session);
          if (session !== null && reply.kind === "captured" && !matches(view, reply.identity)) {
            void this.releaseRecording(reply.ticket).catch(() => {});
            delivered.outcome = { value: deliver({ kind: "refused", reason: "identity" }, view) };
          } else delivered.outcome = { value: deliver(reply, view) };
        },
      },
    );
    if (delivered.outcome === undefined)
      throw new Error("The export capture's reply was not delivered.");
    return delivered.outcome.value;
  }

  /** What export `ticket`'s file needs of the engine (`exportPrepare`): its plan's hash, and with `replay`, replay data. */
  async exportPrepare(ticket: string, replay: boolean): Promise<PreparedExport> {
    const reply = await this.#client.request("exportPrepare", { ticket, replay });
    return reply.result;
  }

  /**
   * The recording held under recording `ticket`, or with `null` the recorder's current one (`readRecording`), as the host
   * holds it when it dispatches the read: a copy, in-process as across a Worker. A read for the composable's test API,
   * with no production caller; it rejects when the connection is lost.
   */
  async readRecording(ticket: string | null): Promise<OpResult<"readRecording">> {
    const reply = await this.#client.request("readRecording", { ticket });
    return reply.result;
  }

  /** Lets go of the recording or export held under `ticket` (`releaseRecording`); an unknown one changes nothing. */
  async releaseRecording(ticket: string): Promise<void> {
    await this.#client.request("releaseRecording", { ticket });
  }

  /**
   * Renews Debug's rewind history as `intent` on this connection (`historyRenew`), posted now: it closes `closes` and
   * every older history, opens the new one and enrolls `session` as it is, when one is shown. It carries this bridge's
   * claim generation (`claim`), which only the Player holding the bridge posts with. Whether it was posted is decided
   * before this returns, as `historyClose`'s is, so that its caller can post the closes of one that was not before anything
   * else posts (`rewindControls.ts`). The sessions its closes released are forgotten as its reply settles.
   */
  historyRenew(
    intent: number,
    session: PlayerSession | null,
    closes: readonly HistoryCloseObligation[],
  ): PostDisposition<HistoryRenewed> {
    const target = session === null ? null : this.#own(session).id;
    const sent = this.#client.post("historyRenew", {
      intent,
      owner: this.#owner,
      session: target,
      closes,
    });
    if (!sent.posted) return sent;
    return {
      posted: true,
      reply: sent.reply.then((reply) => {
        if (reply.result.kind !== "stale") this.#forget(reply.result.released);
        return reply;
      }),
    };
  }

  /**
   * Closes a rewind history (`historyClose`), posted now with this bridge's claim generation. Whether it was posted is
   * decided before this returns, so a close that could not be posted blocks the next open before anything else posts.
   * The sessions it released are forgotten as its reply settles.
   */
  historyClose(args: Omit<HistoryCloseArguments, "owner">): PostDisposition<HistoryOpResult> {
    const sent = this.#client.post("historyClose", { ...args, owner: this.#owner });
    if (!sent.posted) return sent;
    return {
      posted: true,
      reply: sent.reply.then((reply) => {
        if (reply.result.kind === "done") this.#forget(reply.result.released);
        return reply;
      }),
    };
  }

  /** The whole timeline of history `history` (`historyTimeline`), or `null` once it closed. */
  async historyTimeline(history: number): Promise<HistoryTimeline | null> {
    const reply = await this.#control("historyTimeline", { history });
    return reply.result;
  }

  /**
   * Sends the rewind or history op `op` (`ops/history.ts`) of no session: the sessions it released are forgotten here,
   * and a session it restored is opened, with its introduction.
   */
  historyStep<O extends HistoryStepOp>(
    ...call: O extends unknown ? [op: O, args: OpArgs<O>] : never
  ): Promise<{ readonly result: HistoryOpResult; readonly restored: PlayerSession | null }>;
  async historyStep(
    op: HistoryStepOp,
    args: unknown,
  ): Promise<{ readonly result: HistoryOpResult; readonly restored: PlayerSession | null }> {
    // EVIDENCE: invariant: the erased overload's body; the overload above pairs `op` with its arguments.
    const reply = await this.#control<HistoryStepOp>(op as never, args as never);
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

  /**
   * Posts history control `op` now (`BridgeClient.post`), in the turn its caller decided it, so the host runs the
   * Player's requests of no session in the order it made them. One that was not posted rejects with its reason.
   */
  #control<O extends WorkerOp>(
    ...call: O extends unknown ? [op: O, args: OpArgs<O>] : never
  ): Promise<BridgeResult<OpResult<O>>> {
    const sent = this.#client.post(...call);
    return sent.posted ? sent.reply : Promise.reject(sent.error);
  }

  /** Forgets the stores of the sessions `ids`, which the host released itself. */
  #forget(ids: readonly string[]): void {
    for (const id of ids) {
      const store = this.store(id);
      if (store !== null) this.#collected.unregister(store);
      this.#stores.delete(id);
    }
  }

  /** Sends one op of `session` from its store's revision (or `basis`); resolves with its result once applied. */
  request<O extends SessionOp>(
    session: PlayerSession,
    ...call: O extends unknown ? [op: O, args: OpArgs<O>, options?: SessionRequestOptions] : never
  ): Promise<OpResult<O>>;
  async request(
    session: PlayerSession,
    op: SessionOp,
    args: unknown,
    options: SessionRequestOptions = {},
  ) {
    this.#own(session);
    return this.#send(
      session.id,
      (onReply) =>
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- EVIDENCE: invariant: the erased overload's body; the overload above pairs `op` with its arguments.
        this.#client.request<SessionOp>(op as never, args as never, {
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
              merged = this.store(session.id)?.mergeCallView(result.result) ?? null;
            },
          },
        ),
      undefined,
    );
    return merged;
  }

  /**
   * Runs `body` as one exclusive section of `session`, under the scene clock's `ticket`; see `SessionSection`.
   *
   * The type decides one thing: a sender passes a `ClockTicket` to either section API; leaving it out fails
   * type-checking in `.ts` and in an SFC. It does not decide where the ticket came from. Code outside the clock gets
   * one in two ways, both deliberately written: by a construct that switches the check off (a cast; `any`, including
   * `JSON.parse`'s; a non-null assertion; a type guard or assertion function; an overload; an ambient declaration; a
   * suppression directive), or by keeping the ticket the clock passes to a `BridgeClient` it implements or wraps (Sol
   * code r1 B1, job 11081923449b44). The ticket guards against a sender that forgets the clock, not against code
   * written to bypass it.
   */
  section<T>(
    session: PlayerSession,
    ticket: ClockTicket,
    body: (section: SessionSection) => Promise<T>,
  ): Promise<T> {
    this.#own(session);
    return this.#client.section(session.id, ticket, (send: SectionSend) => {
      const shown = () => this.latest(session) ?? session;
      // EVIDENCE: invariant: the section's send forwards each op with the arguments `SessionSection` paired with it.
      return body({
        send: (op: SessionOp, args: unknown, options: SessionRequestOptions = {}) =>
          this.#send(
            session.id,
            (onReply) =>
              send<SessionOp>(
                // EVIDENCE: invariant: `SessionSection` pairs each op with its arguments, sent on as they are.
                op as never,
                // EVIDENCE: invariant: the arguments `SessionSection` paired with `op`.
                args as never,
                options.basis ?? this.latest(session)?.revision ?? session.revision,
                onReply,
              ),
            options.publish,
          ),
        get session() {
          return shown();
        },
      } as SessionSection);
    });
  }

  /** Posts a session op by `post`, its reply's publication applied to the store on arrival; resolves with its result. */
  async #send<R>(
    id: string,
    post: (onReply: ReplyHook) => Promise<BridgeResult<R>>,
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
    return reply.result;
  }

  /**
   * Stops `session` at a Player error, `stop` naming the error with its run and stop (`null` for a session that is only
   * superseded). The host refuses whatever the session has not run (`halt`), so late answers and
   * reports are dropped; the store still applies the replies to ops the host ran, which arrive before the host's
   * acknowledgement, and freezes there. What is shown is then what the host ran, which its recording and export hold.
   * Resolves once frozen, a round trip later.
   */
  halt(session: PlayerSession, stop: StopArguments | null = null): Promise<void> {
    const store = this.store(this.#own(session));
    if (store === null || store.halted) return Promise.resolve();
    store.stopping();
    const acknowledged = this.#client
      .signal("halt", stop, session.id, (result) => store.freeze(result.result))
      .then(
        () => {},
        () => store.freeze(),
      );
    return acknowledged;
  }

  /** Whether `session`'s store froze at a stop. */
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

/** The ops `historyStep` sends: the rewind and history ops of no session (`ops/history.ts`). */
type HistoryStepOp =
  "rewindBack" | "rewindForward" | "rewindCommit" | "rewindDrop" | "rewindReturn" | "rewindAdopt";

/** The bridge a main-side session belongs to. */
export function bridgeOf(session: PlayerSession): PlayerBridge {
  return session.connection;
}
