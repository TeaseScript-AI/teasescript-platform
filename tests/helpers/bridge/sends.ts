import type { TestContext } from "node:test";

import type {
  BridgeClient,
  BridgeResult,
  PostDisposition,
  RequestOptions,
} from "../../../player/engine-bridge/client.js";
import { untypedClient } from "./untyped.js";

/**
 * A test's view of one request the Player sends: its op, its arguments, and `send`, which sends it as it was and gives
 * the host's reply.
 */
export type Intercept = (
  op: string,
  args: unknown,
  send: () => Promise<BridgeResult>,
) => Promise<BridgeResult>;

/**
 * Routes every request `client` sends through `intercept`, by `request` or by `post`. A request `post` sends counts as
 * posted; it reaches the host when `intercept` calls `send`, and one the client does not post rejects there.
 */
export function interceptSends(
  context: TestContext,
  client: BridgeClient,
  intercept: Intercept,
): void {
  const raw = untypedClient(client);
  const request = raw.request.bind(raw);
  const post = raw.post.bind(raw);
  context.mock.method(raw, "request", (op: string, args: unknown, options?: RequestOptions) =>
    intercept(op, args, () => request(op, args, options)),
  );
  context.mock.method(raw, "post", (op: string, args: unknown): PostDisposition => ({
    posted: true,
    reply: intercept(op, args, () => {
      const sent = post(op, args);
      return sent.posted ? sent.reply : Promise.reject(sent.error);
    }),
  }));
}
