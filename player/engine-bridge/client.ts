import {
  BRIDGE_VERSION,
  type BridgeError,
  type BridgeReply,
  type BuildIdentity,
  readWorkerMessage,
  sameBuild,
} from "./protocol.js";
import type { ClockTicket } from "../runtime/clock-ticket.js";
import type { HaltArgs, HaltResult, OpArgs, OpName, OpResult, RequestOp } from "./op-catalogue.js";
import { decodeMessage, encodeMessage } from "./transport.js";

/** How the Player side reaches its engine Worker, whatever runs it: a browser Worker, a Node worker or a test port. */
export interface ClientPort {
  post(message: unknown): void;
  listen(listener: (data: unknown) => void): void;
  /** Calls `listener` when the Worker reports an uncaught error or a message it could not deserialize. */
  onFailure(listener: (reason: unknown) => void): void;
  terminate(): void;
}

/** A successful reply's data: `R`, the result its op's definition gives (`OpResult`), the same build's, unchecked. */
export interface BridgeResult<R = unknown> {
  readonly session: string | null;
  readonly revision: number | null;
  readonly eventsThrough: number | null;
  readonly result: R;
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

/**
 * Called with a successful reply as it arrives, before the request's promise settles, so a session's store applies the
 * reply's publication in arrival order, also when a transport delivers replies early (`in-process.ts`). A throw rejects
 * the request instead.
 */
export type ReplyHook<R = unknown> = (result: BridgeResult<R>) => void;

/** What a client section sends: a request for the section's session, without waiting for other requests. */
export type SectionSend = <O extends OpName>(
  ...call: O extends unknown
    ? [op: O, args: OpArgs<O>, basis: number | null, onReply?: ReplyHook<OpResult<O>>]
    : never
) => Promise<BridgeResult<OpResult<O>>>;

/** A request's options (`BridgeClient.request`), its hook given its op's result. */
export interface RequestOptions<R = unknown> {
  readonly session?: string | null;
  readonly basis?: number | null;
  readonly onReply?: ReplyHook<R>;
  readonly after?: string;
}

export interface BridgeClient {
  /**
   * Sends one request after every earlier request for the same session (or for the Worker itself) has its reply. With
   * `after`, an op on the Worker itself waits instead for the earlier requests of session `after`, and holds that
   * session's turn: a read of the session that follows what was posted before it.
   */
  request<O extends RequestOp>(
    ...call: O extends unknown
      ? [op: O, args: OpArgs<O>, options?: RequestOptions<OpResult<O>>]
      : never
  ): Promise<BridgeResult<OpResult<O>>>;
  /**
   * Runs `body` as one exclusive section of `session`: other requests for that session wait until it ends, so a
   * dependent chain (observe, main-side checks and effects, then an op) sees what a synchronous chain would. `ticket`
   * is the scene clock's (`ClockTicket`).
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
    session: string,
    ticket: ClockTicket,
    body: (send: SectionSend) => Promise<T>,
  ): Promise<T>;
  /**
   * Sends one request at once, ahead of the requests waiting for its session, as `halt` must be: the host handles it on
   * receipt too.
   */
  signal(
    op: "halt",
    args: HaltArgs,
    session: string,
    onReply?: ReplyHook<HaltResult>,
  ): Promise<BridgeResult<HaltResult>>;
  /** Ends the Worker: pending requests fail with `BridgeLostError`. An intentional end is no loss: no `onLoss` call. */
  terminate(): void;
  /** Calls `listener` once if the Worker is lost: it failed or sent what no host sends, not `terminate()`. */
  onLoss(listener: (error: BridgeLostError) => void): void;
}

/**
 * Connects to the Worker behind `port` once it is ready and of the same build. A Worker that fails before `ready`, or
 * says it is another build, is a startup failure; after `ready`, a reported failure or an unreadable message loses it.
 */
export async function connectBridge(port: ClientPort, build: BuildIdentity): Promise<BridgeClient> {
  const { client, ready } = openBridge(port, build);
  await ready;
  return client;
}

/**
 * The client as its transport carries requests, which `openBridge` implements: any op with any arguments, which the
 * host checks, and a result of no type. Not exported: callers send through `BridgeClient`, whose sends the session-work
 * census walks (`tools/session-work-census.mjs`).
 */
interface Transport {
  request(op: string, args: unknown, options?: RequestOptions): Promise<BridgeResult>;
  section<T>(
    session: string,
    ticket: ClockTicket,
    body: (
      send: (
        op: string,
        args: unknown,
        basis: number | null,
        onReply?: ReplyHook,
      ) => Promise<BridgeResult>,
    ) => Promise<T>,
  ): Promise<T>;
  signal(op: string, args: unknown, session: string, onReply?: ReplyHook): Promise<BridgeResult>;
  terminate(): void;
  onLoss(listener: (error: BridgeLostError) => void): void;
}

/**
 * The client of the Worker behind `port`, at once, and `ready`, which settles as `connectBridge` does. Its requests post
 * at once too; a port that delivers them only once its Worker runs, as a browser's does, keeps them until then.
 */
export function openBridge(
  port: ClientPort,
  build: BuildIdentity,
): { readonly client: BridgeClient; readonly ready: Promise<void> } {
  let opened!: BridgeClient;
  const ready = new Promise<void>((resolveClient, rejectClient) => {
    let announced = false;
    let lost: BridgeLostError | null = null;
    let nextId = 1;
    const pending = new Map<
      number,
      {
        resolve: (result: BridgeResult) => void;
        reject: (error: Error) => void;
        onReply: ReplyHook | undefined;
      }
    >();
    const lossListeners: ((error: BridgeLostError) => void)[] = [];
    const locks = new Map<string, Promise<void>>();

    // Whether the Worker ended by `terminate()`, which rejects what is pending but reports no loss.
    let terminated = false;
    const lose = (message: string, intentional = false): void => {
      if (lost !== null) return;
      lost = new BridgeLostError(message);
      terminated = intentional;
      port.terminate();
      for (const entry of pending.values()) entry.reject(lost);
      pending.clear();
      const listeners = lossListeners.splice(0);
      if (!intentional) for (const listener of listeners) listener(lost);
    };
    const fail = (message: string): void => {
      if (!announced) {
        announced = true;
        lost = new BridgeLostError(message);
        port.terminate();
        // Requests sent before `ready` (`openBridge`) fail with the startup failure too.
        const failure = new BridgeStartupError(message);
        for (const entry of pending.values()) entry.reject(failure);
        pending.clear();
        rejectClient(failure);
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
      const message = readWorkerMessage(decodeMessage(data));
      if (message === null) return fail("The engine Worker sent a message the Player cannot read.");
      if (message.kind === "ready") {
        if (announced) return lose("The engine Worker announced itself twice.");
        if (!sameBuild(message.build, build))
          return fail("The engine Worker belongs to another build of the Player.");
        announced = true;
        resolveClient();
        return;
      }
      settle(message);
    });

    function settle(reply: BridgeReply): void {
      const entry = pending.get(reply.id);
      if (entry === undefined) return;
      pending.delete(reply.id);
      if (!reply.ok) return entry.reject(new BridgeRequestError(reply.error));
      const result: BridgeResult = {
        session: reply.session,
        revision: reply.revision,
        eventsThrough: reply.eventsThrough,
        result: reply.result,
        view: reply.view,
      };
      try {
        entry.onReply?.(result);
      } catch (error) {
        return entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
      entry.resolve(result);
    }

    function send(
      op: string,
      args: unknown,
      session: string | null,
      basis: number | null,
      onReply?: ReplyHook,
    ): Promise<BridgeResult> {
      if (lost !== null) return Promise.reject(lost);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onReply });
        try {
          port.post(
            encodeMessage({ v: BRIDGE_VERSION, kind: "request", id, session, basis, op, args }),
          );
        } catch (error) {
          // Arguments that cannot cross never reach the Worker; the request fails here, without effect.
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }

    /**
     * Runs `body` once every earlier holder of `key` is done, and holds `key` until `body` settles. With no holder,
     * `body` starts at once, so a request posts before `request` returns.
     */
    function exclusive<T>(key: string, body: () => Promise<T>): Promise<T> {
      const before = locks.get(key);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const chain = (before ?? Promise.resolve()).then(() => held);
      locks.set(key, chain);
      const run = async (): Promise<T> => {
        try {
          return await body();
        } finally {
          release();
          if (locks.get(key) === chain) locks.delete(key);
        }
      };
      return before === undefined ? run() : before.then(run);
    }

    const client: Transport = {
      request: (op, args, options = {}) => {
        const session = options.session ?? null;
        return exclusive(session ?? options.after ?? "", () =>
          send(op, args, session, options.basis ?? null, options.onReply),
        );
      },
      section: (session, _ticket, body) =>
        exclusive(session, () =>
          body((op, args, basis, onReply) => send(op, args, session, basis, onReply)),
        ),
      signal: (op, args, session, onReply) => send(op, args, session, null, onReply),
      terminate: () => lose("The engine Worker was terminated.", true),
      onLoss: (listener) => {
        if (lost === null) lossListeners.push(listener);
        else if (!terminated) listener(lost);
      },
    };
    // EVIDENCE: invariant: the transport carries any op, and the host checks it; callers see the catalogue's pairs.
    opened = client as BridgeClient;
  });
  return { client: opened, ready };
}
