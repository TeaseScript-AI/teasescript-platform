import type { InstructionPlan, RuntimeSnapshot } from "../../src/index.js";
import {
  restorePlayerRuntimeSessionAt,
  type PlayerRuntimeState,
} from "../../player/runtime-adapter.js";

/** What the Player would show for `snapshot`, a state the snapshot API returned, by restoring it as a Player session. */
export function playerStateOf(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): PlayerRuntimeState {
  return restorePlayerRuntimeSessionAt(plan, JSON.stringify(snapshot), []).state;
}
