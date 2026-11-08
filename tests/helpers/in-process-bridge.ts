import { createInProcessBackend, introduceNow } from "../../player/engine-bridge/in-process.js";
import type { PlayerBridge } from "../../player/player-bridge.js";
import type { PlayerRuntimeSession } from "../../player/runtime-adapter.js";
import type { PlayerSession } from "../../player/runtime-view.js";
import { NO_MARKS } from "../../player/debug-history-marks.js";

export { hatch } from "../../player/engine-bridge/in-process.js";

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };

/** The in-process backend, as the Player starts it; with `delayMs`, its replies arrive that much later. */
export function inProcessBridge(delayMs?: number): Promise<PlayerBridge> {
  return Promise.resolve(createInProcessBackend(BUILD, delayMs === undefined ? {} : { delayMs }));
}

/** `session`, an adapter session a test made, as a session the in-process host now holds. */
export function introduced(bridge: PlayerBridge, session: PlayerRuntimeSession): PlayerSession {
  return introduceNow(bridge, () => session, NO_MARKS);
}
