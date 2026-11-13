import type { OwnedDiagnosticCode } from "../../diagnostic-codes.js";
import { createCapturedArray } from "../../external-data-capture.js";
import { MAX_TEXT_LENGTH } from "../values/text-length.js";

// The checkpoint format's identity, its error, and the JSON writer of validated runtime data: what saving needs, without
// the validation that restoring a checkpoint runs (`checkpoint.ts`).

export const CHECKPOINT_FORMAT = "teasescript-checkpoint";
export const CHECKPOINT_VERSION = 132;

export interface CheckpointErrorInfo {
  readonly code: OwnedDiagnosticCode<"checkpoint">;
  readonly message: string;
  readonly path: string;
}

export class CheckpointError extends Error {
  public constructor(readonly info: CheckpointErrorInfo) {
    super(info.message);
    this.name = "CheckpointError";
  }
}

/**
 * JSON of plain runtime data that checkpoint validation produced, such as a checkpoint or one of its snapshots, without
 * validating it again. Native JSON writes it as the iterative writer does, unless a host hook could apply or the data is
 * deeper than the host stack allows. JSON longer than a text can be (`MAX_TEXT_LENGTH`) fails with `TSK004` in every
 * host, as V8 cannot build it.
 */
export function serializeValidatedRuntimeJson(value: unknown): string {
  return serializeValidatedRuntimeJsonWithin(value, MAX_TEXT_LENGTH);
}

/** `serializeValidatedRuntimeJson` with `limit` as the longest JSON it writes; tests give a small one. */
export function serializeValidatedRuntimeJsonWithin(value: unknown, limit: number): string {
  if (!inheritsToJson()) {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      if (isStringLengthExhaustion(error)) throw stateTooLarge();
      if (!isStackExhaustion(error)) throw error;
    }
    if (json !== undefined) {
      if (json.length > limit) throw stateTooLarge();
      return json;
    }
  }
  return serializeJsonIterative(value, limit);
}

/** V8's failure to build a string longer than it holds. */
function isStringLengthExhaustion(error: unknown): boolean {
  return error instanceof RangeError && error.message === "Invalid string length";
}

/** `TSK004`: a state, or a text built from one such as an export, would be longer than a text can be. */
export function stateTooLarge(): CheckpointError {
  return checkpointError(
    "TSK004",
    `The state is too large to save: as text it would be longer than the limit of ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
    "$",
  );
}

/**
 * Whether native `JSON.stringify` would consult a `toJSON` that validated checkpoint data inherits. Its containers are
 * plain data whose prototype is `Object.prototype`, `Array.prototype`, the frozen prototype of captured arrays, or
 * null. `in` on these ordinary objects runs no getter.
 */
function inheritsToJson(): boolean {
  return (
    Object.getPrototypeOf(Array.prototype) !== Object.prototype ||
    "toJSON" in Array.prototype ||
    "toJSON" in createCapturedArray(0)
  );
}

/** A native stack overflow: a `RangeError` in V8 and JavaScriptCore, an `InternalError` in SpiderMonkey. */
function isStackExhaustion(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error.name === "RangeError" && /call stack/i.test(error.message)) ||
      (error.name === "InternalError" && /recursion/i.test(error.message)))
  );
}

/**
 * The writer used where native JSON could consult a hook: its own arrays are on capture's prototype, so a replaced
 * `Array.prototype` method, iterator or index setter cannot change the JSON it writes.
 */
function serializeJsonIterative(value: unknown, limit: number): string {
  const out = createCapturedArray<string>(0);
  // Counted as it grows, so JSON too long to join fails before the join.
  let length = 0;
  const write = (piece: string) => {
    length += piece.length;
    if (length > limit) throw stateTooLarge();
    out.push(piece);
  };
  const stack = createCapturedArray<
    { value: unknown; state: "value" } | { value: string; state: "close" }
  >(0);
  stack.push({ value, state: "value" });
  while (stack.length > 0) {
    // EVIDENCE: stack is non-empty because the loop condition was checked immediately before pop.
    const frame = stack.pop()!;
    if (frame.state === "close") {
      write(frame.value);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current !== "object") {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(current);
      } catch (error) {
        throw isStringLengthExhaustion(error) ? stateTooLarge() : error;
      }
      if (encoded === undefined) throw new TypeError("Checkpoint contains a non-JSON-safe value.");
      write(encoded);
      continue;
    }
    if (Array.isArray(current)) {
      write("[");
      stack.push({ value: "]", state: "close" });
      for (let i = current.length - 1; i >= 0; i--) {
        if (i < current.length - 1) stack.push({ value: ",", state: "close" });
        stack.push({ value: current[i], state: "value" });
      }
      continue;
    }
    // EVIDENCE: validated checkpoint containers are plain JSON objects at this boundary.
    const keys = Object.keys(current as Record<string, unknown>);
    write("{");
    stack.push({ value: "}", state: "close" });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      if (i < keys.length - 1) stack.push({ value: ",", state: "close" });
      // EVIDENCE: validated checkpoint containers are plain JSON objects at this boundary.
      const entry = (current as Record<string, unknown>)[key];
      stack.push({ value: entry, state: "value" });
      stack.push({ value: ":", state: "close" });
      stack.push({ value: JSON.stringify(key), state: "close" });
    }
  }
  return out.join("");
}

export function checkpointError(
  code: CheckpointErrorInfo["code"],
  message: string,
  path: string,
): CheckpointError {
  return new CheckpointError(Object.freeze({ code, message, path }));
}
