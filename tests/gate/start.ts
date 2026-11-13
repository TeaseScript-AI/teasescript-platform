import { DEMO_PLAYER_PROFILE } from "../../player/demo-player-profile.js";
import type { StartOptions } from "../../player/engine-bridge/ops/session.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { TAPE_WALL_CLOCK_MS } from "./candidates.js";

/**
 * The Start every tape makes, as a hosted Player starts a development package: the pinned moment and temporal context,
 * persistent script storage with nothing stored, and the package host's player profile. The seed and pacing are the
 * hosted Player's own (the bridge's `start` takes neither).
 */
export const TAPE_START: StartOptions = Object.freeze({
  wallClockMs: TAPE_WALL_CLOCK_MS,
  temporalContext: DEFAULT_TEMPORAL_CONTEXT,
  scriptStorage: [],
  persistentScriptStorage: true,
  playerProfile: DEMO_PLAYER_PROFILE,
});
