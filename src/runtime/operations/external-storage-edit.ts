import { captureExternalData } from "../../external-data-capture.js";
import type { InstructionPlan } from "../../plan/model.js";
import type { ScriptStorageEditedEvent } from "../events.js";
import { validateScriptStorageEntries, writeScriptStorage } from "../script-storage.js";
import type { SerializableRuntimeValue } from "../serializable-values.js";
import type { RuntimeSnapshot } from "../state.js";
import type { PendingActionOperationResult } from "./model.js";
import { captureExecutableData, isPlainRecord, pendingResult, takeSequence } from "./support.js";

export type ExternalStorageEditOutcome =
  | { readonly kind: "applied"; readonly key: string; readonly operation: "set" | "delete" }
  | { readonly kind: "invalidEdit"; readonly message: string }
  /** An ended or failed session accepts no edit. */
  | { readonly kind: "invalidState"; readonly status: RuntimeSnapshot["status"] }
  /** The script's own write waits for the host; acknowledge it first, then edit before the script continues. */
  | { readonly kind: "storageWritePending"; readonly actionId: number };

/**
 * Changes one key of the session's script-storage view on behalf of a debugging tool (DEBUGGER.md "Player Debug"):
 * `{ key, value }` stores a copy of a persistable value, and `{ key, value: null }` removes the key. The edit applies
 * at the current instruction boundary, also while scene time trails the observed time or a block is due, so the next
 * `load` the script evaluates returns it; values already loaded stay as they are. It runs no instruction, changes
 * nothing else, and emits one `scriptStorageEdited` event. Durable storage is the host's: it persists the edit first
 * and calls this only once that succeeded.
 */
export function applyExternalStorageEdit(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  edit: unknown,
): PendingActionOperationResult<ExternalStorageEditOutcome> {
  const captured = captureExecutableData(plan, snapshot);
  const current = captured.snapshot;
  const refuse = (outcome: ExternalStorageEditOutcome) => pendingResult(current, [], outcome);
  const input = captureExternalData(edit);
  if (
    !input.ok ||
    !isPlainRecord(input.value) ||
    Object.keys(input.value).length !== 2 ||
    !Object.hasOwn(input.value, "key") ||
    !Object.hasOwn(input.value, "value")
  )
    return refuse({ kind: "invalidEdit", message: "A storage edit must be { key, value }." });
  const { key, value } = input.value;
  if (typeof key !== "string")
    return refuse({ kind: "invalidEdit", message: "A storage edit's key must be a string." });
  if (value !== null) {
    const problem = validateScriptStorageEntries([{ key, value }], "edit");
    if (problem !== null) return refuse({ kind: "invalidEdit", message: problem });
  }
  if (current.status === "halted" || current.status === "failed")
    return refuse({ kind: "invalidState", status: current.status });
  if (current.foregroundAction?.kind === "storageWrite")
    return refuse({ kind: "storageWritePending", actionId: current.foregroundAction.actionId });

  const operation = value === null ? "delete" : "set";
  const event: ScriptStorageEditedEvent = Object.freeze({
    kind: "scriptStorageEdited",
    sequence: takeSequence(current),
    key,
    operation,
    currentSessionTimeMs: current.currentSessionTimeMs,
    observedSessionTimeMs: current.observedSessionTimeMs,
  });
  // EVIDENCE: validation: validateScriptStorageEntries accepted a non-null value above; null removes the key.
  writeScriptStorage(current, key, value as SerializableRuntimeValue);
  return pendingResult(current, [event], { kind: "applied", key, operation } as const);
}
