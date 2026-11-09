import type { BridgeClient, UntypedClient } from "../../../player/engine-bridge/client.js";
import type { OpResult, SessionOp } from "../../../player/engine-bridge/op-catalogue.js";
import type { PlayerBridge, SessionRequestOptions } from "../../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../../player/runtime/runtime-view.js";

/*
 * The escapes from the op catalogue's types (`op-catalogue.ts`) for tests: an op chosen at run time, an op of a test's
 * own host, or arguments malformed on purpose, which the host checks and refuses. Each is named where it is used.
 */

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
