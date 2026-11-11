import assert from "node:assert/strict";

import type { StartOptions } from "../../player/engine-bridge/ops/session.js";
import type { PlayerSessionStart } from "../../player/vue/src/session/sessionStart.js";
import type { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PlayerProject } from "../../player/runtime/runtime-adapter.js";
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

/**
 * `script`, compiled in the host of `bridge` by a source `prepare`, as a hosted script's is; resolves with its plan
 * token. A script that does not compile rejects with its first error.
 */
export async function preparedSource(
  bridge: PlayerBridge | Promise<PlayerBridge>,
  script: string | PlayerProject,
): Promise<string> {
  const reply = await (
    await bridge
  ).client.request("prepare", { source: { kind: "source", script } });
  const result = reply.result;
  if (result.kind === "notCompiled") {
    const error = result.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    throw new Error(
      error === undefined
        ? "The script did not compile."
        : `${error.path}:${error.line}:${error.column}: ${error.message}`,
    );
  }
  assert.equal(result.kind, "prepared", "the host prepared the script");
  // EVIDENCE: invariant: a source `prepare` that compiled holds the plan under `plan`.
  return (result as { readonly plan: string }).plan;
}

/**
 * A Start as the Player takes it: the production `PlayerSessionStart`, a held plan's token and its Start options. Every
 * test loader's `prepare` takes this type, so a Start the Player would refuse does not compile in a test either.
 */
export type PlanStart = PlayerSessionStart;

/** A Start of `script`, compiled in the host of `bridge`, with `options` read at the activation. */
export async function sourceStart(
  bridge: PlayerBridge | Promise<PlayerBridge>,
  script: string | PlayerProject,
  options: () => Omit<StartOptions, "debugMode"> = () => ({}),
): Promise<PlanStart> {
  return { plan: await preparedSource(bridge, script), options };
}
