import {
  BridgeLostError,
  BridgeRequestError,
  type BridgeClient,
  type BridgeResult,
  type SectionSend,
} from "./engine-bridge/client.js";
import type { StartOptions } from "./engine-bridge/ops/session.js";
import type { Introduction, Publication } from "./engine-bridge/session-protocol.js";
import type { PlayerSession } from "./runtime-view.js";
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
 * What a service's chain gets in its section of the published session (`section` of the service hosts): an
 * observation inside the section, as `observeForInput` makes one, and the section's requests.
 */
export interface ServiceSection {
  /** The clock's now and media samples, observed (`observeTime`), with the stop checked before and after. */
  observe(): Promise<PlayerSession | null>;
  /**
   * One op of the section's session from `basis`; resolves with its result once its publication applied and shows
   * (`publishOwned`).
   */
  send<R>(op: string, args: unknown, basis: number): Promise<R>;
}

/** A section of one session: requests that other requests of the session wait behind (`BridgeClient.section`). */
export interface SessionSection {
  /** Sends `op` from `basis`, the store's revision by default; resolves with its result once its publication applied. */
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

  /** The store of `session`, or `null` once it was released. */
  store(session: PlayerSession | string): SessionStore | null {
    const id = typeof session === "string" ? session : session.id;
    return this.#stores.get(id)?.deref() ?? null;
  }

  /** The store's latest publication of `session`, or `null` once it was released. */
  latest(session: PlayerSession): PlayerSession | null {
    return this.store(session)?.session ?? null;
  }

  /** Starts a session of the held plan `plan`; resolves with its first publication. */
  async start(plan: string, options: StartOptions, recording: boolean): Promise<PlayerSession> {
    const reply = await this.#client.request("start", { plan, options, recording });
    // EVIDENCE: validation: `start` replies from the same build with the new session and its introduction.
    return this.open(reply.session!, reply.view as Introduction);
  }

  /** Sends one op of `session` from its store's revision (or `basis`); resolves with its result once applied. */
  async request<R = unknown>(
    session: PlayerSession,
    op: string,
    args: unknown,
    options: { readonly basis?: number; readonly publish?: PublishHook } = {},
  ): Promise<R> {
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

  /** Runs `body` as one exclusive section of `session`; see `SessionSection`. */
  section<T>(session: PlayerSession, body: (section: SessionSection) => Promise<T>): Promise<T> {
    return this.#client.section(session.id, (send: SectionSend) => {
      const bridge = this;
      return body({
        send: (op, args, options = {}) =>
          bridge.#send(
            session.id,
            (onReply) =>
              send(
                op,
                args,
                options.basis ?? bridge.latest(session)?.revision ?? session.revision,
                onReply,
              ),
            options.publish,
          ),
        get session() {
          return bridge.latest(session) ?? session;
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
   * Stops `session` at a Player error. The host refuses whatever the session has not run (`halt`), so late answers and
   * reports are dropped; the store still applies the replies to ops the host ran, which arrive before the host's
   * acknowledgement, and freezes there. What is shown is then what the host ran, which its recording and export hold.
   * Resolves once frozen: at once in-process, a round trip later with a Worker.
   */
  halt(session: PlayerSession): Promise<void> {
    const store = this.store(session);
    if (store === null || store.halted) return Promise.resolve();
    store.stopping();
    const acknowledged = this.#client
      .signal("halt", null, session.id, () => store.freeze())
      .then(
        () => {},
        () => store.freeze(),
      );
    this.deliverInTransit?.(session.id);
    return acknowledged;
  }

  /** Whether `session`'s store froze at a stop, as it does at once in-process. */
  frozen(session: PlayerSession): boolean {
    return this.store(session)?.halted ?? true;
  }

  /** Releases `session` in the host now; its store goes with it. */
  release(session: PlayerSession): void {
    const store = this.store(session);
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
