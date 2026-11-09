import {
  BridgeRequestError,
  type BridgeClient,
  type BridgeResult,
  type UntypedClient,
} from "../../player/engine-bridge/client.js";
import { untypedClient } from "../helpers/bridge/untyped.js";

/*
 * A K/F tape: every request a client sent and the reply it received, in order, as plain JSON. It is recorded on the
 * client (`recordClient`), the same boundary on every backend, since the in-process backend's port is its own: a reply
 * is what the client delivers (session, revision, events cursor, result and the publication's view), a refusal its
 * error. `replayTape` sends the same requests through another client and fails at the first entry whose reply differs.
 */

export type TapeReply =
  | {
      readonly ok: true;
      readonly session: string | null;
      readonly revision: number | null;
      readonly eventsThrough: number | null;
      readonly result: unknown;
      readonly view: unknown;
    }
  | {
      readonly ok: false;
      readonly name: string;
      readonly kind: string | null;
      readonly code: string | null;
      readonly message: string;
      readonly ended: boolean | null;
      /** The error's details, as the client delivers them (`BridgeRequestError.info`). */
      readonly info: unknown;
    };

export interface TapeEntry {
  readonly op: string;
  readonly args: unknown;
  readonly session: string | null;
  readonly basis: number | null;
  readonly after: string | null;
  readonly reply: TapeReply;
}

/** As JSON keeps it: what a tape stores and what a replay compares. */
const asJson = <T>(value: T): T =>
  // EVIDENCE: validation: the round trip keeps `value`'s plain-data shape; JSON drops only what a tape does not keep.
  JSON.parse(JSON.stringify(value ?? null)) as T;

function replyOf(result: BridgeResult): TapeReply {
  return asJson({
    ok: true,
    session: result.session,
    revision: result.revision,
    eventsThrough: result.eventsThrough,
    result: result.result,
    view: result.view,
  });
}

function refusalOf(error: unknown): TapeReply {
  if (error instanceof BridgeRequestError)
    return {
      ok: false,
      name: error.name,
      kind: error.kind,
      code: error.code,
      message: error.message,
      ended: error.ended,
      info: asJson(error.info),
    };
  return {
    ok: false,
    name: error instanceof Error ? error.name : "Error",
    kind: null,
    code: null,
    message: error instanceof Error ? error.message : String(error),
    ended: null,
    info: null,
  };
}

/**
 * Records every request `client` sends from now on into `entries`, in the order they were sent, each with its reply
 * once it arrives. `stop()` restores the client's own `request`.
 */
export function recordClient(client: BridgeClient): {
  readonly entries: TapeEntry[];
  stop(): void;
} {
  const entries: TapeEntry[] = [];
  // The recorder forwards each op as it is sent, whatever it is: the client as its transport carries requests.
  const request = untypedClient(client).request.bind(client);
  const recording: UntypedClient["request"] = async (op, args, options = {}) => {
    const index = entries.length;
    const base = {
      op,
      args: asJson(args),
      session: options.session ?? null,
      basis: options.basis ?? null,
      after: options.after ?? null,
    };
    entries.push({
      ...base,
      reply: {
        ok: false,
        name: "pending",
        kind: null,
        code: null,
        message: "",
        ended: null,
        info: null,
      },
    });
    try {
      const result = await request(op, args, options);
      entries[index] = { ...base, reply: replyOf(result) };
      return result;
    } catch (error) {
      entries[index] = { ...base, reply: refusalOf(error) };
      throw error;
    }
  };
  Object.defineProperty(client, "request", {
    value: recording,
    configurable: true,
    writable: true,
  });
  return {
    entries,
    stop: () =>
      Object.defineProperty(client, "request", {
        value: request,
        configurable: true,
        writable: true,
      }),
  };
}

/** Where a replay first differs from its tape, or `null` when every reply is the tape's. */
export interface ReplayDifference {
  readonly index: number;
  readonly op: string;
  readonly expected: TapeReply;
  readonly actual: TapeReply;
}

/**
 * `reply` with each `historyKey` renamed by its order of first appearance in the tape (`seen`): a history key is a
 * counter of its realm (Debug's rewind histories), so two hosts in different realms number the same histories
 * differently. Every other value is compared as it is.
 */
function canonical(reply: TapeReply, seen: Map<string, string>): string {
  return JSON.stringify(reply, (key, value: unknown) => {
    if (key !== "historyKey" || typeof value !== "string") return value;
    if (!seen.has(value)) seen.set(value, `history ${seen.size + 1}`);
    return seen.get(value);
  });
}

/**
 * Sends `entries` through `client` one at a time, in order, with their recorded session, basis and `after`, and compares
 * each reply with the recorded one as JSON, history keys by their order (`canonical`). Stops at the first difference.
 */
export async function replayTape(
  client: BridgeClient,
  entries: readonly TapeEntry[],
): Promise<ReplayDifference | null> {
  const recorded = new Map<string, string>();
  const replayed = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    let actual: TapeReply;
    try {
      // A tape's op as it was recorded, whatever it is.
      actual = replyOf(
        await untypedClient(client).request(entry.op, entry.args, {
          session: entry.session,
          basis: entry.basis,
          ...(entry.after === null ? {} : { after: entry.after }),
        }),
      );
    } catch (error) {
      actual = refusalOf(error);
    }
    if (canonical(actual, replayed) !== canonical(entry.reply, recorded))
      return { index, op: entry.op, expected: entry.reply, actual };
  }
  return null;
}
