import type {
  PlayerBridge,
  ServiceSection,
  UntypedSessionSection,
} from "../../player/runtime/player-bridge.js";
import type { SessionOp } from "../../player/engine-bridge/op-catalogue.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { clockTicket } from "./clock-ticket.js";

/**
 * A service host's `section`, as `usePlayerSession` gives it, over `bridge`: an exclusive section of the session
 * `current()` gives, which observes that session at its own scene time (no clock moves in these tests) before the body,
 * as the clock's `service` row does, and whose sends show their publications through `show`, as `publishOwned` does;
 * none once the session's store froze at a stop. `onSend` sees each request right before it is posted, the
 * observation's included, so a test can act at that moment. `advance` gives how far an observation moves the session's
 * scene time, as the Player's clock does when time passed; none by default.
 */
export function serviceSection(
  bridge: PlayerBridge,
  current: () => PlayerSession | null,
  show: (next: PlayerSession) => void,
  onSend: (op: string, args: unknown) => void = () => {},
  advance: (session: PlayerSession) => number = () => 0,
): <T>(
  body: (section: ServiceSection, observed: PlayerSession | null) => Promise<T>,
) => Promise<T | null> {
  return (body) => {
    const session = current();
    // As once a Player error stopped the session.
    if (session === null || bridge.frozen(session)) return Promise.resolve(null);
    return bridge.section(session, clockTicket(), async (section) => {
      const at = section.session.state.observedSessionTimeMs;
      const args = { atMs: at + advance(section.session), media: [] };
      onSend("observeTime", args);
      await section.send("observeTime", args);
      show(section.session);
      return body(
        // EVIDENCE: invariant: `ServiceSection` pairs each op with its arguments, which this forwards as they are.
        {
          send: (op: SessionOp, args: unknown, basis: number) => {
            onSend(op, args);
            // EVIDENCE: invariant: the pairs `ServiceSection` made, sent on as they are.
            return (section as UntypedSessionSection).send(op, args, { basis, publish: show });
          },
        } as ServiceSection,
        section.session,
      );
    });
  };
}
