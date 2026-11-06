import {
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
export function haltedError(): BridgeRequestError {
  return new BridgeRequestError({
    kind: "bridge",
    class: "BridgeRefusal",
    code: "halted",
    message: "The Player stopped this session.",
    ended: false,
  });
}

/**
 * What a service's chain gets in its section of the published session (`section` of the service hosts): an
 * observation inside the section, as `observeForInput` makes one, and the section's requests.
 */
export interface ServiceSection {
  /** The clock's now and media samples, observed (`observeTime`), with the stop checked before and after. */
  observe(): Promise<PlayerSession | null>;
  /** One op of the section's session from `basis`; resolves with its result once its publication applied. */
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
    const reply = await post((result) => {
      // EVIDENCE: validation: a session op's view is its publication, from the same build, or null.
      this.store(id)?.apply(result.view as Publication | null, publish);
    });
    if (this.store(id)?.halted === true) throw haltedError();
    // EVIDENCE: validation: the op's result comes from the same build as its caller expects it.
    return reply.result as R;
  }

  /**
   * Stops `session` at a Player error: its store applies nothing more, and the host refuses whatever the session still
   * has queued (`halt`), so late answers and reports are dropped.
   */
  halt(session: PlayerSession): void {
    const store = this.store(session);
    if (store === null || store.halted) return;
    store.halt();
    void this.#client.signal("halt", null, session.id).catch(() => {});
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
