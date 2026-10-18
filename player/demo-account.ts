import type { RuntimeAccountInput } from "../src/runtime/host-data/account.js";

/**
 * The fixed account that tests, the Player's development scenarios, and packages of the playground server pass until
 * the Player has profile settings (V30 §37, "Name lists"); a normal Player session passes none.
 */
export const DEMO_ACCOUNT: RuntimeAccountInput = Object.freeze({
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
