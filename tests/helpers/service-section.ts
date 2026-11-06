import type { PlayerBridge, ServiceSection } from "../../player/player-bridge.js";
import type { PlayerSession } from "../../player/runtime-view.js";

/**
 * A service host's `section`, as `usePlayerSession` gives it, over `bridge`: an exclusive section of the session
 * `current()` gives, whose observation observes that session at its own scene time (no clock moves in these tests),
 * and whose sends show their publications through `show`, as `publishOwned` does; none once the session's store froze
 * at a stop. `onSend` sees each request right
 * before it is posted, the observation's included, so a test can act at that moment.
 */
export function serviceSection(
  bridge: PlayerBridge,
  current: () => PlayerSession | null,
  show: (next: PlayerSession) => void,
  onSend: (op: string, args: unknown) => void = () => {},
): <T>(body: (section: ServiceSection) => Promise<T>) => Promise<T | null> {
  return (body) => {
    const session = current();
    // As once a Player error stopped the session.
    if (session === null || bridge.frozen(session)) return Promise.resolve(null);
    return bridge.section(session, (section) =>
      body({
        observe: async () => {
          const args = { atMs: section.session.state.observedSessionTimeMs, media: [] };
          onSend("observeTime", args);
          await section.send("observeTime", args);
          show(section.session);
          return section.session;
        },
        send: (op, args, basis) => {
          onSend(op, args);
          return section.send(op, args, { basis, publish: show });
        },
      }),
    );
  };
}
