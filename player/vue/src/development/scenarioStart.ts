import { getCurrentScope, onScopeDispose } from "vue";
import { DEMO_PLAYER_PROFILE } from "../../../demo-player-profile.js";
import { endsQuietly } from "../../../runtime/player-bridge.js";
import type { PlayerSessionHost } from "../session/usePlayerSession";

/*
 * The development preview's Start of a fixed scenario: the source compiles in the engine's host at page setup, as a
 * hosted script's does (`prepare`), and Start then reads its options at the click. The preview keeps a Start and no
 * session, so it prepares a Start (`player.prepare`), not a script (`prepareScript`).
 */

/**
 * Prepares Start of `source` on `player`. With `storage`, the script's stored values are read first and the Start reads
 * them, as a script with persistent storage does. A source that does not compile is the Player's error stop; a lost
 * connection ends quietly; a page whose scope ended meanwhile prepares nothing.
 */
export function prepareScenario(
  player: PlayerSessionHost,
  source: string,
  { storage = false }: { readonly storage?: boolean } = {},
): Promise<void> {
  let disposed = false;
  if (getCurrentScope() !== undefined) onScopeDispose(() => (disposed = true));
  return (storage ? player.loadScriptStorage() : Promise.resolve())
    .then(() => player.bridge)
    .then(() => player.prepareScriptSource(source))
    .then((prepared) => {
      if (disposed) return;
      const compilation = prepared.result;
      if (compilation.kind === "notCompiled") {
        const error = compilation.diagnostics.find((each) => each.severity === "error");
        throw new Error(
          `The scenario does not compile${error === undefined ? "" : `: ${error.message}`}.`,
        );
      }
      if (compilation.kind !== "prepared") throw new Error("A source prepared as no compilation.");
      player.prepare({
        plan: compilation.plan,
        // Read at the click: the zone, presentation and clock of the Start's click (`temporalCapture`).
        options: () => ({
          ...(storage ? player.scriptStorageOptions() : {}),
          ...player.temporalCapture(),
          playerProfile: DEMO_PLAYER_PROFILE,
        }),
      });
    })
    .catch((error: unknown) => {
      if (!disposed && !endsQuietly(error)) player.reportHostError(error);
    });
}
