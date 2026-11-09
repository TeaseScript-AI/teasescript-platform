import assert from "node:assert/strict";

import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { InstructionPlan } from "../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";

// The JSON writer as this module loaded, so that a test that counts the writes of a plan does not count the text this
// gives its host: the same text the engine's writer gives for an ordinary plan.
const stringify = JSON.stringify;

/** `plan`'s JSON; a plan nested deeper than the native writer goes takes the engine's iterative writer. */
function planText(plan: InstructionPlan): string {
  try {
    return stringify(plan);
  } catch {
    return serializeValidatedRuntimeJson(plan);
  }
}

/** `plan`, prepared in the host of `bridge` as published plan text, as a host's `prepare` does; resolves with its token. */
export async function preparedPlan(
  bridge: Promise<PlayerBridge>,
  plan: InstructionPlan,
): Promise<string> {
  const reply = await (
    await bridge
  ).client.request("prepare", { source: { kind: "plan", text: planText(plan) } });
  const result = reply.result;
  assert.ok(
    typeof result === "object" &&
      result !== null &&
      "kind" in result &&
      result.kind === "prepared" &&
      "plan" in result &&
      typeof result.plan === "string",
    "the host prepared the plan",
  );
  return result.plan;
}
