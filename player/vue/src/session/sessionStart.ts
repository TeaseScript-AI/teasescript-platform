import type { StartOptions } from "../../../engine-bridge/ops/session.js";

/*
 * A Start's own type, apart from the composable: it imports no component, so the test loaders, which the TypeScript
 * program builds without the Player's components, take the production type (`tests/helpers/prepared-plan.ts`).
 */

/**
 * Creates a new session at Start: a held plan with the options its Start reads then, which starts over the bridge
 * (`start`). The host runs it with the connection's value trace and random control, and records it for a debug export.
 */
export interface PlayerSessionStart {
  /** The host's token for the plan. */
  readonly plan: string;
  /** The Start's data options, read at activation; Player Debug supplies `debugMode` (`setDebugMode`). */
  readonly options: () => Omit<StartOptions, "debugMode">;
}
