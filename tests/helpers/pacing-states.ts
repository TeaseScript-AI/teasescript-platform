import assert from "node:assert/strict";

import type { InstructionPlan } from "../../src/plan/model.js";
import type {
  RuntimeChatPacingGateActionSnapshot,
  RuntimeDelayActionSnapshot,
} from "../../src/runtime/actions/model.js";
import { run, type RuntimeOperationResult } from "../../src/runtime/engine.js";
import { observeTime } from "../../src/runtime/operations/observe-time.js";
import { createFreshRuntimeSnapshot, type RuntimeSnapshot } from "../../src/runtime/state.js";
import { compileValidPlan } from "./compile-valid-plan.js";

/**
 * A wait replaces the reading time before it, so a reading time runs beside a wait only when a block's message starts
 * it: here a timer block says `message` at `atMs` while the script waits, and `rest` follows the wait.
 */
export function blockMessageDuringWait(
  wait: string,
  message: string,
  atMs: number,
  rest = "exit",
): {
  readonly compiled: InstructionPlan;
  readonly waiting: RuntimeOperationResult;
  readonly delay: RuntimeDelayActionSnapshot;
  readonly gate: RuntimeChatPacingGateActionSnapshot;
} {
  const compiled = compileValidPlan(
    `timer async ${atMs} ms {\n    ${message}\n}\n${wait}\n${rest}`,
  );
  const started = run(compiled, createFreshRuntimeSnapshot(compiled));
  const waiting = run(compiled, observeTime(compiled, started.snapshot, atMs).snapshot);
  const delay = waiting.snapshot.foregroundAction;
  const gate = waiting.snapshot.backgroundActions.find(
    (action) => action.kind === "chatPacingGate",
  );
  assert.equal(delay?.kind, "delay");
  assert.equal(gate?.kind, "chatPacingGate");
  return { compiled, waiting, delay, gate };
}

/** The pacing gate that holds the session's next output in the foreground. */
export function heldGate(snapshot: RuntimeSnapshot): RuntimeChatPacingGateActionSnapshot {
  const gate = snapshot.foregroundAction;
  if (gate?.kind !== "chatPacingGate")
    throw new Error("Expected output held behind a pacing gate.");
  return gate;
}
