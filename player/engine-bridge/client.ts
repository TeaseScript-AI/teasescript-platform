import {
  BRIDGE_VERSION,
  type BridgeError,
  type BridgeReply,
  type BuildIdentity,
  readWorkerMessage,
  sameBuild,
} from "./protocol.js";

/** How the Player side reaches its engine Worker, whatever runs it: a browser Worker, a Node worker or a test port. */
export interface ClientPort {
  post(message: unknown): void;
  listen(listener: (data: unknown) => void): void;
  /** Calls `listener` when the Worker reports an uncaught error or a message it could not deserialize. */
  onFailure(listener: (reason: unknown) => void): void;
  terminate(): void;
}

/** A successful reply's data. */
export interface BridgeResult {
  readonly session: string | null;
  readonly revision: number | null;
  readonly eventsThrough: number | null;
  readonly result: unknown;
  readonly view: unknown;
}

/** A request the Worker refused or whose op threw; `name` is the class the op's error had. */
export class BridgeRequestError extends Error {
  readonly kind: BridgeError["kind"];
  readonly code: string | null;
  readonly info: unknown;
  /** Whether the session ended, so no later op may use it. */
  readonly ended: boolean;
  constructor(error: BridgeError) {
    super(error.message);
    this.name = error.class;
    this.kind = error.kind;
    this.code = error.code;
    this.info = error.info;
    this.ended = error.ended;
  }
}

/** The Worker could not start: its module did not load, it threw, or it belongs to another build. */
export class BridgeStartupError extends Error {
  override readonly name = "BridgeStartupError";
}

/** The Worker was lost or terminated; its sessions are gone, and no request was repeated. */
export class BridgeLostError extends Error {
  override readonly name = "BridgeLostError";
}

/** What a client section sends: a request for the section's session, without waiting for other requests. */
export type SectionSend = (
  op: string,
  args: unknown,
  basis: number | null,
) => Promise<BridgeResult>;

export interface BridgeClient {
  /** Sends one request after every earlier request for the same session (or for the Worker itself) has its reply. */
  request(
    op: string,
    args: unknown,
    options?: { readonly session?: string | null; readonly basis?: number | null },
  ): Promise<BridgeResult>;
  /**
   * Runs `body` as one exclusive section of `session`: other requests for that session wait until it ends, so a
   * dependent chain (observe, main-side checks and effects, then an op) sees what a synchronous chain would.
   */
  section<T>(session: string, body: (send: SectionSend) => Promise<T>): Promise<T>;
  /** Ends the Worker: pending requests fail with `BridgeLostError`. */
  terminate(): void;
  /** Calls `listener` once if the Worker is lost. */
  onLoss(listener: (error: BridgeLostError) => void): void;
}

/**
 * Connects to the Worker behind `port` once it is ready and of the same build. A Worker that fails before `ready`, or
 * says it is another build, is a startup failure; after `ready`, a reported failure or an unreadable message loses it.
 */
export function connectBridge(port: ClientPort, build: BuildIdentity): Promise<BridgeClient> {
  return new Promise((resolveClient, rejectClient) => {
    let ready = false;
    let lost: BridgeLostError | null = null;
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (result: BridgeResult) => void; reject: (error: Error) => void }
    >();
    const lossListeners: ((error: BridgeLostError) => void)[] = [];
    const locks = new Map<string, Promise<void>>();

    const lose = (message: string): void => {
      if (lost !== null) return;
      lost = new BridgeLostError(message);
      port.terminate();
      for (const entry of pending.values()) entry.reject(lost);
      pending.clear();
      for (const listener of lossListeners) listener(lost);
    };
    const fail = (message: string): void => {
      if (!ready) {
        ready = true;
        lost = new BridgeLostError(message);
        port.terminate();
        rejectClient(new BridgeStartupError(message));
        return;
      }
      lose(message);
    };

    port.onFailure((reason) =>
      fail(
        `The engine Worker failed: ${reason instanceof Error ? reason.message : String(reason)}`,
      ),
    );
    port.listen((data) => {
      const message = readWorkerMessage(data);
      if (message === null) return fail("The engine Worker sent a message the Player cannot read.");
      if (message.kind === "ready") {
        if (ready) return lose("The engine Worker announced itself twice.");
        if (!sameBuild(message.build, build))
          return fail("The engine Worker belongs to another build of the Player.");
        ready = true;
        resolveClient(client);
        return;
      }
      settle(message);
    });

    function settle(reply: BridgeReply): void {
      const entry = pending.get(reply.id);
      if (entry === undefined) return;
      pending.delete(reply.id);
      if (reply.ok)
        entry.resolve({
          session: reply.session,
          revision: reply.revision,
          eventsThrough: reply.eventsThrough,
          result: reply.result,
          view: reply.view,
        });
      else entry.reject(new BridgeRequestError(reply.error));
    }

    function send(
      op: string,
      args: unknown,
      session: string | null,
      basis: number | null,
    ): Promise<BridgeResult> {
      if (lost !== null) return Promise.reject(lost);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          port.post({ v: BRIDGE_VERSION, kind: "request", id, session, basis, op, args });
        } catch (error) {
          // Arguments that cannot cross never reach the Worker; the request fails here, without effect.
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    /** Runs `body` once every earlier holder of `key` is done, and holds `key` until `body` settles. */
    async function exclusive<T>(key: string, body: () => Promise<T>): Promise<T> {
      const before = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const chain = before.then(() => held);
      locks.set(key, chain);
      await before;
      try {
        return await body();
      } finally {
        release();
        if (locks.get(key) === chain) locks.delete(key);
      }
    }

    const client: BridgeClient = {
      request: (op, args, options = {}) => {
        const session = options.session ?? null;
        return exclusive(session ?? "", () => send(op, args, session, options.basis ?? null));
      },
      section: (session, body) =>
        exclusive(session, () => body((op, args, basis) => send(op, args, session, basis))),
      terminate: () => lose("The engine Worker was terminated."),
      onLoss: (listener) => {
        if (lost !== null) listener(lost);
        else lossListeners.push(listener);
      },
    };
  });
}
