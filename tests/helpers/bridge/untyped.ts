import type {
  BridgeClient,
  BridgeLostError,
  BridgeResult,
  PostDisposition,
  ReplyHook,
  RequestOptions,
} from "../../../player/engine-bridge/client.js";
import type { ClockTicket } from "../../../player/runtime/clock-ticket.js";
import type { OpResult, SessionOp } from "../../../player/engine-bridge/op-catalogue.js";
import type { PlayerBridge, SessionRequestOptions } from "../../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../../player/runtime/runtime-view.js";

/*
 * The escapes from the op catalogue's types (`op-catalogue.ts`) for tests: an op chosen at run time, an op of a test's
 * own host, or arguments malformed on purpose, which the host checks and refuses. Each is named where it is used.
 */

/** A client section's send without the catalogue's types (`UntypedClient`). */
export type UntypedSend = (
  op: string,
  args: unknown,
  basis: number | null,
  onReply?: ReplyHook,
) => Promise<BridgeResult>;

/** A client without the catalogue's types, as its transport carries requests (`untypedClient`). */
export interface UntypedClient {
  request(op: string, args: unknown, options?: RequestOptions): Promise<BridgeResult>;
  section<T>(
    session: string,
    ticket: ClockTicket,
    body: (send: UntypedSend) => Promise<T>,
  ): Promise<T>;
  post(op: string, args: unknown): PostDisposition;
  signal(op: string, args: unknown, session: string, onReply?: ReplyHook): Promise<BridgeResult>;
  terminate(): void;
  onLoss(listener: (error: BridgeLostError) => void): void;
}

/** A bridge's session request without the catalogue's types (`untypedBridge`). */
export interface UntypedBridge {
  request(
    session: PlayerSession,
    op: string,
    args: unknown,
    options?: SessionRequestOptions,
  ): Promise<OpResult<SessionOp>>;
}

/** `bridge`'s session requests for any op and arguments. */
export function untypedBridge(bridge: PlayerBridge): UntypedBridge {
  // EVIDENCE: test: the same bridge, whose host checks what the types no longer do.
  return bridge as UntypedBridge;
}

/** `client` for any op and arguments, as its transport carries them. */
export function untypedClient(client: BridgeClient): UntypedClient {
  // EVIDENCE: test: the same client, whose host checks what the types no longer do.
  return client as UntypedClient;
}

/** `args`, malformed on purpose, as any op's arguments: the host refuses them. */
export function asMalformed(args: unknown): never {
  // EVIDENCE: test: arguments the host refuses, sent to show it does.
  return args as never;
}
