import {
  BRIDGE_VERSION,
  type BridgeError,
  type BridgeReply,
  type BridgeRequest,
  type BuildIdentity,
  readRequest,
  refusal,
} from "./protocol.js";
import { type Delivery, type DeliveryOwner, deliveryOwner, OwnedMap } from "./delivery.js";
import { decodeMessage, encodeMessage } from "./transport.js";

/** How the Worker side sends and receives messages, whatever runs it: a browser Worker, a Node worker or a test port. */
export interface HostPort {
  post(message: unknown): void;
  listen(listener: (data: unknown) => void): void;
}

/** A session the Worker holds for a client. */
export interface HostSession {
  /** Whether an op made from the session's revision `basis` may run (`null`: the op read no revision). */
  accepts(basis: number | null): boolean;
  /** The session's revision now. */
  readonly revision: number;
  /** What `halt`'s acknowledgement carries for the session, when its kind of session gives anything. */
  atStop?(args: unknown): StopPayload;
  /** Whether a halt's non-null arguments are this session's stop arguments; a halt without arguments is a plain stop. */
  checkStop?(args: unknown): boolean;
  /**
   * A halt with arguments `args` arrived for the session, before the work running at it settled: whether the session
   * admits it. A refused stop changed nothing, and the halt is refused before it halts the session.
   */
  stopRequested?(args: unknown): boolean;
}

/** What a session's stop acknowledgement carries: its kind of session defines it, and that kind's client reads it. */
export type StopPayload = OpOutcome["result"];

/** What an op returns: its result, and for a session op the session's revision and view after it. */
export interface OpOutcome {
  readonly result: unknown;
  /** The session an op on the Worker created, which the reply names. */
  readonly session?: string;
  readonly eventsThrough?: number | null;
  readonly view?: unknown;
}

export interface HostSessions {
  get(id: string): HostSession | undefined;
  /**
   * Keeps `session` under a new ID, which it returns, owned by `delivery` (the innermost open one by default) until it
   * is posted (`delivery.ts`).
   */
  add(session: HostSession, delivery?: Delivery): string;
  delete(id: string): void;
  clear(): void;
}

/**
 * One op: whether it works on a session (and then reads a basis), how its arguments are checked, and what it does. A
 * session op receives its session; an op on the Worker itself receives `null`.
 */
export interface BridgeOp {
  readonly session: "none" | "existing";
  /** Whether a session op acts on what its caller saw, and so needs a basis the session accepts; yes by default. */
  readonly readsBasis?: boolean;
  readonly checkArguments: (args: unknown) => boolean;
  readonly run: (
    args: unknown,
    sessions: HostSessions,
    session: { readonly id: string; readonly value: HostSession } | null,
  ) => OpOutcome | Promise<OpOutcome>;
  /** Whether an error the op threw ends its session, which the host then deletes; never by default. */
  readonly ends?: (error: unknown) => boolean;
  /**
   * Whether an error the op threw left its session's runner ended, reported in the error's `ended` without deleting the
   * session, which can still recover; `ends` decides by default.
   */
  readonly ended?: (error: unknown, session: HostSession | null) => boolean;
}

export type BridgeOps = Readonly<Record<string, BridgeOp>>;

/** A reply's fields after its envelope: a success with its data, or an error. */
type ReplyBody =
  | Omit<Extract<BridgeReply, { ok: true }>, "v" | "kind" | "id" | "session">
  | Omit<Extract<BridgeReply, { ok: false }>, "v" | "kind" | "id" | "session">;

/**
 * What an op threw, as data: the class name, and the code and details it had, whether it holds them itself (as a
 * `RuntimeDataError`'s `code`) or in its `info` (as a `CheckpointError`'s diagnostic).
 */
function engineError(error: unknown, ended: boolean): BridgeError {
  if (!(error instanceof Error))
    return { kind: "engine", class: "Error", code: null, message: String(error), ended };
  const info =
    "info" in error && typeof error.info === "object" && error.info !== null ? error.info : null;
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : info !== null && "code" in info && typeof info.code === "string"
        ? info.code
        : null;
  const path = "path" in error && typeof error.path === "string" ? error.path : undefined;
  const details = info ?? (path === undefined ? undefined : { path });
  return {
    kind: "engine",
    class: error.name,
    code,
    message: error.message,
    ...(details === undefined ? {} : { info: details }),
    ended,
  };
}

/** The ops every host has: releasing a session the client no longer holds. */
const HOST_OPS: BridgeOps = {
  release: {
    session: "existing",
    readsBasis: false,
    checkArguments: (args) => args === null,
    run: (_args, sessions, session) => {
      sessions.delete(session!.id);
      return { result: null };
    },
  },
};

/**
 * Serves `ops` on `port`: announces `ready`, then handles requests one at a time in arrival order. A synchronous op runs
 * and its reply is posted before the host returns from the message; an op that returns a promise is awaited, and the
 * requests after it wait, in arrival order. A request is refused, without effect, when its version, envelope, op,
 * arguments, order, session or basis is wrong. Every error an op throws becomes an `engine` error reply; nothing is
 * retried.
 *
 * Each op runs in a delivery of `owner` (`delivery.ts`), the connection's, which a Player host shares with its ops'
 * context: what the op allocates, a session it adds included, is undone when the op throws or its success reply cannot be
 * built, encoded or posted, before the error reply goes. Without its owner, a context's allocations are refused.
 *
 * Returns the host's sessions, which only an in-process backend in the same realm reads (`in-process.ts`).
 *
 * `halt` (a session request) is handled on receipt, ahead of the requests still waiting: from then on every request of
 * that session but `release` is refused as `halted`, so what a Player error stop left queued has no effect. Its reply
 * acknowledges the stop: it follows every reply to an op of the session that ran, as replies are posted in order and one
 * still awaited is answered first.
 */
export function startBridgeHost(
  port: HostPort,
  ops: BridgeOps,
  build: BuildIdentity,
  owner: DeliveryOwner = deliveryOwner(),
): HostSessions {
  const table: BridgeOps = { ...ops, ...HOST_OPS };
  const halted = new Set<string>();
  // A session leaving, however it leaves, takes its stop with it.
  const held = new OwnedMap<string, HostSession>(owner, (_session, id) => halted.delete(id));
  let nextSession = 1;
  const sessions: HostSessions = {
    get: (id) => held.get(id),
    add: (session, delivery) => {
      const id = `s${nextSession++}`;
      held.set(id, session, delivery);
      return id;
    },
    delete: (id) => {
      held.delete(id);
    },
    clear: () => {
      held.clear();
    },
  };
  let lastId = 0;
  /** The awaited op that later requests wait behind, or `null`. */
  let busy: Promise<void> | null = null;
  /** The session of the awaited op, whose reply `halt`'s acknowledgement must follow. */
  let busySession: string | null = null;
  const waiting: Received[] = [];

  const reply = (request: { id: number; session: string | null }, body: ReplyBody): void => {
    const envelope = { v: BRIDGE_VERSION, kind: "reply", id: request.id, session: request.session };
    try {
      port.post(encodeMessage({ ...envelope, ...body }));
    } catch (error) {
      // A result that cannot cross (a DataCloneError) still answers the request.
      port.post(encodeMessage({ ...envelope, ok: false, error: engineError(error, false) }));
    }
  };
  const refuse = (request: { id: number; session: string | null }, error: BridgeError): void =>
    reply(request, { ok: false, error });

  /** A message as received: `previous` is the ID it fails to follow, or `null` when it is in order. */
  interface Received {
    readonly data: unknown;
    readonly previous: number | null;
  }

  function handle({ data, previous }: Received): void | Promise<void> {
    const request = readRequest(data);
    if (typeof request === "string") {
      // A reply needs the request's ID; a message without a readable one gets none.
      const raw: unknown = data;
      const rawId = typeof raw === "object" && raw !== null && "id" in raw ? raw.id : undefined;
      const rawSession =
        typeof raw === "object" && raw !== null && "session" in raw ? raw.session : undefined;
      const id =
        typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0 ? rawId : null;
      if (id !== null)
        refuse(
          { id, session: typeof rawSession === "string" ? rawSession : null },
          refusal(
            request,
            request === "version" ? `Bridge version ${BRIDGE_VERSION} only.` : "Malformed request.",
          ),
        );
      return;
    }
    if (previous !== null) {
      refuse(
        request,
        refusal("order", `Request ${request.id} does not follow request ${previous}.`),
      );
      return;
    }
    // Whatever goes wrong in dispatch, the request still gets its reply.
    const failed = (error: unknown) => refuse(request, engineError(error, false));
    try {
      const pending = dispatch(request);
      if (pending !== undefined) return pending.catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  function dispatch(request: BridgeRequest): void | Promise<void> {
    const op = Object.hasOwn(table, request.op) ? table[request.op] : undefined;
    if (op === undefined) return refuse(request, refusal("unknownOp", `No op '${request.op}'.`));
    let session: { readonly id: string; readonly value: HostSession } | null = null;
    if (op.session === "existing") {
      const value = request.session === null ? undefined : held.get(request.session);
      if (value === undefined)
        return refuse(
          request,
          refusal("session", "The request names no session the Worker holds."),
        );
      if (halted.has(request.session!) && request.op !== "release")
        return refuse(request, refusal("halted", "The Player stopped this session."));
      if (op.readsBasis !== false && !value.accepts(request.basis))
        return refuse(
          request,
          refusal("basis", "The request was made from a revision the session no longer accepts."),
        );
      session = { id: request.session!, value };
    } else if (request.session !== null) {
      return refuse(request, refusal("session", `Op '${request.op}' works on no session.`));
    }
    let wellFormed: boolean;
    try {
      wellFormed = op.checkArguments(request.args);
    } catch {
      wellFormed = false;
    }
    if (!wellFormed)
      return refuse(request, refusal("arguments", `Malformed arguments for '${request.op}'.`));
    const delivery = owner.begin();
    const fail = (error: unknown): void => {
      abort(delivery);
      const ends = op.ends?.(error) ?? false;
      if (ends && session !== null) held.delete(session.id);
      refuse(request, engineError(error, op.ended?.(error, session?.value ?? null) ?? ends));
    };
    let outcome: OpOutcome | Promise<OpOutcome>;
    try {
      outcome = op.run(request.args, sessions, session);
    } catch (error) {
      return fail(error);
    }
    if (outcome instanceof Promise)
      return outcome.then((settled) => answer(request, session, settled, delivery), fail);
    answer(request, session, outcome, delivery);
  }

  /** Undoes `delivery`; an undo that fails is reported by the owner (`delivery.ts`), and the error reply still goes. */
  function abort(delivery: Delivery): void {
    owner.rollback(delivery);
  }

  /**
   * Posts the success reply of `outcome`, built, encoded and posted inside `delivery`: it commits once the post
   * returned. A fault on the way aborts it before the error reply, which names the request's own session, as an
   * allocated one is gone.
   */
  function answer(
    request: BridgeRequest,
    session: { readonly id: string; readonly value: HostSession } | null,
    outcome: OpOutcome,
    delivery: Delivery,
  ): void {
    try {
      const named = outcome.session ?? session?.id ?? null;
      const current = named === null ? undefined : held.get(named);
      port.post(
        encodeMessage({
          v: BRIDGE_VERSION,
          kind: "reply",
          id: request.id,
          session: named,
          ok: true,
          revision: current?.revision ?? null,
          eventsThrough: outcome.eventsThrough ?? null,
          result: outcome.result,
          view: outcome.view ?? null,
        }),
      );
    } catch (error) {
      abort(delivery);
      // A result that cannot cross (a DataCloneError) still answers the request.
      return refuse(request, engineError(error, false));
    }
    // Closed while the op ran, the connection's cleanup already undid the delivery; there is nothing left to commit.
    if (!owner.closed) owner.commit(delivery);
  }

  /** Handles `first`, then each waiting message, until an op is awaited. */
  function drain(first: Received): void {
    for (let next: Received = first, more = true; more;) {
      let pending: void | Promise<void> = undefined;
      const request = readRequest(next.data);
      try {
        pending = handle(next);
      } catch {
        // `handle` answers every readable request itself, also when its op throws; a fault posting even the error
        // reply must not stop the requests after it.
      }
      if (pending !== undefined) {
        busySession = typeof request === "string" ? null : request.session;
        busy = pending
          .catch(() => {})
          .then(() => {
            busy = null;
            busySession = null;
            const after = waiting.shift();
            if (after !== undefined) drain(after);
          });
        return;
      }
      const after = waiting.shift();
      more = after !== undefined;
      if (after !== undefined) next = after;
    }
  }

  /**
   * What the stop of session `id` froze, read once its last op ran (the Player's: the stopped publication's call view).
   * A fault reading it still acknowledges the stop, without it.
   */
  function stopPayload(id: string, args: unknown): StopPayload {
    try {
      return held.get(id)?.atStop?.(args) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Halts the session on receipt: every request of it the host has not dispatched is refused from now on. The
   * acknowledgement follows every reply to an op of the session that ran, so it waits for one still awaited.
   */
  function halt(request: BridgeRequest): void {
    const acknowledge = () => {
      const result = stopPayload(request.session!, request.args);
      try {
        reply(request, { ok: true, revision: null, eventsThrough: null, result, view: null });
      } catch {
        // As in `drain`: a fault posting the reply stops nothing.
      }
    };
    try {
      const value = request.session === null ? undefined : held.get(request.session);
      if (request.args !== null && !(value?.checkStop?.(request.args) ?? false))
        return refuse(request, refusal("arguments", "Malformed arguments for 'halt'."));
      if (value === undefined)
        return refuse(
          request,
          refusal("session", "The request names no session the Worker holds."),
        );
      if (request.args !== null && !(value.stopRequested?.(request.args) ?? true))
        return refuse(request, refusal("session", "The halt names a diagnostic run that ended."));
      halted.add(request.session!);
    } catch {
      return;
    }
    if (busy !== null && busySession === request.session) void busy.then(acknowledge);
    else acknowledge();
  }

  // Request IDs are admitted in receipt order, so a request waiting behind an awaited op keeps its place, and `halt`,
  // handled at once, follows the same order.
  port.listen((raw) => {
    const data = decodeMessage(raw);
    const request = readRequest(data);
    let previous: number | null = null;
    if (typeof request !== "string") {
      if (request.id <= lastId) previous = lastId;
      else lastId = request.id;
      if (request.op === "halt") {
        if (previous === null) return halt(request);
        return refuse(
          request,
          refusal("order", `Request ${request.id} does not follow request ${previous}.`),
        );
      }
    }
    const received = { data, previous };
    if (busy !== null) waiting.push(received);
    else drain(received);
  });
  port.post(encodeMessage({ v: BRIDGE_VERSION, kind: "ready", build }));
  return sessions;
}
