import type { RuntimePlayerProfileInput } from "../src/runtime/host-data/player-profile.js";

/**
 * The fixed player profile that tests, the Player's development scenarios, and packages of the playground server pass
 * until the Player has profile settings (V30 §37, "Name lists"); a normal Player session passes none.
 */
export const DEMO_PLAYER_PROFILE: RuntimePlayerProfileInput = Object.freeze({
  title: "Mr",
  firstName: "Alex",
  lastName: "Morgan",
  displayName: "Alex",
  alias: "pup",
  gender: "male",
  petNames: Object.freeze(["puppy", "pet"]),
  degradingNames: Object.freeze(["toy", "plaything"]),
  lovingNames: Object.freeze(["darling", "sweetheart"]),
});
