import {
  BRIDGE_VERSION,
  type BridgeError,
  type BridgeReply,
  type BridgeRequest,
  type BuildIdentity,
  readRequest,
  refusal,
} from "./protocol.js";

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
}

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
  /** Keeps `session` under a new ID, which it returns. */
  add(session: HostSession): string;
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
  /** Whether an error the op threw ends its session; never by default. */
  readonly ends?: (error: unknown) => boolean;
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
 * Serves `ops` on `port`: announces `ready`, then handles requests one at a time in arrival order, awaiting each op
 * before the next. A request is refused, without effect, when its version, envelope, op, arguments, order, session or
 * basis is wrong. Every error an op throws becomes an `engine` error reply; nothing is retried.
 */
export function startBridgeHost(port: HostPort, ops: BridgeOps, build: BuildIdentity): void {
  const table: BridgeOps = { ...ops, ...HOST_OPS };
  const held = new Map<string, HostSession>();
  let nextSession = 1;
  const sessions: HostSessions = {
    get: (id) => held.get(id),
    add: (session) => {
      const id = `s${nextSession++}`;
      held.set(id, session);
      return id;
    },
    delete: (id) => void held.delete(id),
    clear: () => held.clear(),
  };
  let lastId = 0;
  let queue: Promise<void> = Promise.resolve();

  const reply = (request: { id: number; session: string | null }, body: ReplyBody): void => {
    const envelope = { v: BRIDGE_VERSION, kind: "reply", id: request.id, session: request.session };
    try {
      port.post({ ...envelope, ...body });
    } catch (error) {
      // A result that cannot cross (a DataCloneError) still answers the request.
      port.post({ ...envelope, ok: false, error: engineError(error, false) });
    }
  };
  const refuse = (request: { id: number; session: string | null }, error: BridgeError): void =>
    reply(request, { ok: false, error });

  async function handle(data: unknown): Promise<void> {
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
    if (request.id <= lastId) {
      refuse(request, refusal("order", `Request ${request.id} does not follow request ${lastId}.`));
      return;
    }
    lastId = request.id;
    try {
      await dispatch(request);
    } catch (error) {
      // Whatever goes wrong in dispatch, the request still gets its reply.
      refuse(request, engineError(error, false));
    }
  }

  async function dispatch(request: BridgeRequest): Promise<void> {
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
    let outcome: OpOutcome;
    try {
      outcome = await op.run(request.args, sessions, session);
    } catch (error) {
      const ended = op.ends?.(error) ?? false;
      if (ended && session !== null) held.delete(session.id);
      return refuse(request, engineError(error, ended));
    }
    const named = outcome.session ?? session?.id ?? null;
    const current = named === null ? undefined : held.get(named);
    reply(
      { id: request.id, session: named },
      {
        ok: true,
        revision: current?.revision ?? null,
        eventsThrough: outcome.eventsThrough ?? null,
        result: outcome.result,
        view: outcome.view ?? null,
      },
    );
  }

  port.listen((data) => {
    // `handle` answers every readable request itself, also when its op throws; a fault posting even the error reply
    // must not stop the requests after it.
    queue = queue.then(() => handle(data)).catch(() => {});
  });
  port.post({ v: BRIDGE_VERSION, kind: "ready", build });
}
