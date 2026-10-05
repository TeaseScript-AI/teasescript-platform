import type { InstructionPlan } from "../plan/model.js";
import { isValidSessionTime } from "./actions/delay.js";
import { rootFitsFunction, serializedRootFiles } from "./activation-validation.js";

/** Restore validation for permanent buttons, their identifiers, and their queued or running blocks. */

const ACTION_KEYS = [
  "kind",
  "actionId",
  "owningInstruction",
  "createdAtMs",
  "requestEventSequence",
  "button",
] as const;

const BUTTON_KEYS = ["buttonId", "text", "persist", "handlerFunctionId", "rootScopeId"] as const;

const INVOCATION_KEYS = [
  "buttonId",
  "handlerFunctionId",
  "rootScopeId",
  "dueAtMs",
  "count",
] as const;

/** A shown button, shown by its own `showPermanentButton` in an activation of that instruction's file. */
export function validPermanentButtonAction(
  action: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  plan: InstructionPlan | undefined,
): boolean {
  const button = action.button;
  if (
    !hasExactKeys(action, ACTION_KEYS) ||
    !positiveSafeInteger(action.actionId) ||
    !positiveSafeInteger(snapshot.nextActionId) ||
    action.actionId >= snapshot.nextActionId ||
    !positiveSafeInteger(action.requestEventSequence) ||
    !positiveSafeInteger(snapshot.nextEventSequence) ||
    action.requestEventSequence >= snapshot.nextEventSequence ||
    !isValidSessionTime(action.createdAtMs) ||
    !isValidSessionTime(snapshot.currentSessionTimeMs) ||
    action.createdAtMs > snapshot.currentSessionTimeMs ||
    !nonNegativeSafeInteger(action.owningInstruction) ||
    !isPlainRecord(button) ||
    !hasExactKeys(button, BUTTON_KEYS) ||
    !positiveSafeInteger(button.buttonId) ||
    !positiveSafeInteger(snapshot.nextPermanentButtonId) ||
    button.buttonId >= snapshot.nextPermanentButtonId ||
    typeof button.text !== "string" ||
    typeof button.persist !== "boolean" ||
    !positiveSafeInteger(button.handlerFunctionId) ||
    !rootFitsFunction(
      plan,
      serializedRootFiles(snapshot),
      button.rootScopeId,
      button.handlerFunctionId,
    )
  ) {
    return false;
  }
  if (plan === undefined) return true;
  const owner = plan.instructions[action.owningInstruction];
  return (
    owner?.kind === "showPermanentButton" &&
    owner.handlerFunctionId === button.handlerFunctionId &&
    owner.persist === button.persist
  );
}

/**
 * Buttons have unique identifiers in the order they were shown, and identifiers refer to issued buttons. A click is
 * queued once, only for a shown button, and never while its block runs; a running block may belong to a button removed
 * since.
 */
export function validatePermanentButtonState(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  handleIds: ReadonlySet<number>,
  errors: string[],
): void {
  const next = value.nextPermanentButtonId;
  if (!positiveSafeInteger(next)) {
    errors.push("Runtime nextPermanentButtonId must be a positive safe integer.");
    return;
  }
  const shown = new Map<
    number,
    { readonly createdAtMs: unknown; readonly button: Record<string, unknown> }
  >();
  let previousId = 0;
  for (const action of Array.isArray(value.backgroundActions) ? value.backgroundActions : []) {
    if (
      !isPlainRecord(action) ||
      action.kind !== "permanentButton" ||
      !isPlainRecord(action.button)
    )
      continue;
    const id = action.button.buttonId;
    if (!positiveSafeInteger(id) || id <= previousId) {
      errors.push("Runtime permanent buttons must keep the order they were shown in.");
      continue;
    }
    previousId = id;
    shown.set(id, { createdAtMs: action.createdAtMs, button: action.button });
  }
  if (shown.size > 0 && (value.status === "halted" || value.status === "ready")) {
    errors.push("Runtime permanent buttons require an active session.");
  }
  for (const id of handleIds) {
    if (id >= next) {
      errors.push("Runtime permanent button identifier refers to an unissued button.");
      break;
    }
  }
  const queued = new Set<number>();
  for (const invocation of Array.isArray(value.pendingTimerHandlers)
    ? value.pendingTimerHandlers
    : []) {
    if (!isPlainRecord(invocation) || !Object.hasOwn(invocation, "buttonId")) continue;
    const id = invocation.buttonId;
    const entry = positiveSafeInteger(id) ? shown.get(id) : undefined;
    if (
      !positiveSafeInteger(id) ||
      entry === undefined ||
      !hasExactKeys(invocation, INVOCATION_KEYS) ||
      invocation.handlerFunctionId !== entry.button.handlerFunctionId ||
      invocation.rootScopeId !== entry.button.rootScopeId ||
      invocation.count !== 1 ||
      typeof invocation.dueAtMs !== "number" ||
      typeof entry.createdAtMs !== "number" ||
      invocation.dueAtMs < entry.createdAtMs ||
      queued.has(id)
    ) {
      errors.push("Runtime pending permanent button block does not belong to a shown button.");
      continue;
    }
    queued.add(id);
  }
  if (!Array.isArray(value.callFrames)) return;
  for (const frame of value.callFrames) {
    if (
      !isPlainRecord(frame) ||
      !isPlainRecord(frame.timerInterruption) ||
      !Object.hasOwn(frame.timerInterruption, "buttonId")
    )
      continue;
    const id = frame.timerInterruption.buttonId;
    const button = positiveSafeInteger(id) ? shown.get(id)?.button : undefined;
    const definition =
      plan !== undefined && positiveSafeInteger(frame.functionId)
        ? plan.functions[frame.functionId - 1]
        : undefined;
    if (
      !positiveSafeInteger(id) ||
      id >= next ||
      queued.has(id) ||
      (plan !== undefined && definition?.handler !== "button") ||
      (button !== undefined &&
        (button.handlerFunctionId !== frame.functionId || button.rootScopeId !== frame.rootScopeId))
    ) {
      errors.push("Runtime permanent button block frame does not belong to its button.");
    }
  }
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
