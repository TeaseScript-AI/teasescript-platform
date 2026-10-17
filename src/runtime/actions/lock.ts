import type { LockCall, LockInstruction } from "../../plan/model.js";
import { interactionStringFits } from "../../interaction-limits.js";
import { internalFault, RuntimeFault } from "../errors.js";
import { type Evaluator, USE_DEFAULT } from "../evaluator.js";
import type { ActionRequestedEvent, InterpreterEvent } from "../events.js";
import {
  assertEventSequenceCapacity,
  copySpan,
  isPlainRecord,
  requiredFutureActionCompletionEvents,
  setCapturedTemporary,
  takeSequence,
} from "../operations/support.js";
import type { SerializableRuntimeValue } from "../serializable-values.js";
import { currentTemporalContext, type RuntimeSnapshot } from "../state.js";
import {
  base64FromBinary,
  binaryFromBase64,
  holdsStoredFile,
  isRecognizedFileType,
  isStandardBase64,
  OCTET_STREAM,
  storedFileKind,
} from "../stored-files.js";
import { temporalCaptureAt, wallClockAt } from "../temporal-captures.js";
import { checkTextLength, messageText } from "../text-length.js";
import { fieldText } from "../value-text.js";
import { describeRuntimeValue } from "../value-predicates.js";
import type { CapturedMediaAdmission } from "./capture.js";
import type {
  RuntimeLockActionSnapshot,
  RuntimeLockChoice,
  RuntimeLockNotice,
  RuntimeLockOutcome,
} from "./model.js";

// The calls that lock and open text and stored files (V30 §13). A `lock` instruction asks the Player and waits, and runs
// again with each answer, which the completion hands off: in its `work` phase the Player locks or opens with what it has;
// when it must ask the player, the instruction waits again in an `ask` phase, which its dialog or, for
// `password: askPassword(...)`, its password field answers, and then works again with what the player typed, which never
// reaches the engine. Every run reads the same operands. A decrypt call's `default:` runs only when it is used, as the
// instructions after it.

/** The moment the lock dialog suggests for its time lock: 7 days from now (owner decisions, 2026-10-13 and 2026-10-14). */
const SUGGESTED_TIME_LOCK_MS = 7 * 24 * 60 * 60 * 1000;

/** The openers of an encrypt call, in the order the lock dialog shows them. */
const LOCK_CHOICES: readonly RuntimeLockChoice[] = ["timeLock", "password"];

/** The operands of a run: the text, Base64 lock, or stored file, and the written options. */
interface LockOperands {
  readonly value: SerializableRuntimeValue;
  readonly password: SerializableRuntimeValue | undefined;
  /** The password field of `password: askPassword(...)`, with its hint as text, or `null`. */
  readonly passwordField: RuntimeLockActionSnapshot["passwordField"];
  readonly timeLock: SerializableRuntimeValue | undefined;
}

/**
 * An encrypt call's openers: the password and the time lock's moment it gives, and those the player chooses in the lock
 * dialog, written `true` or, without any written, all of them. A password field gives its password when the call locks.
 */
interface EncryptOpeners {
  readonly password: string | null;
  readonly timeLockMs: number | null;
  readonly choices: readonly RuntimeLockChoice[];
}

/** What a run asks the Player for, or the result it gives at once, which may be that the call needs its default. */
type LockStep =
  | { readonly result: SerializableRuntimeValue | typeof USE_DEFAULT }
  | {
      readonly phase: RuntimeLockActionSnapshot["phase"];
      readonly value: string;
      readonly password: string | null;
      readonly timeLockMs: number | null;
      readonly choices: readonly RuntimeLockChoice[];
      readonly dialogActionId: number | null;
      readonly notice: RuntimeLockNotice | null;
      readonly passwordField: RuntimeLockActionSnapshot["passwordField"];
    };

/** Whether a call locks; the others open. */
function locks(call: LockCall): boolean {
  return call === "encryptText" || call === "encryptFile";
}

/** Runs a `lock` instruction, the first time or again with the Player's answer. */
export function executeLock(
  instruction: LockInstruction,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  const span = instruction.span;
  if (snapshot.temporaries.some((temporary) => temporary.id === instruction.destinationTemporary))
    throw new RuntimeFault(
      "TSR050",
      internalFault(`The slot for the result of ${instruction.call}(...) is already in use.`),
      copySpan(span),
    );
  const field = instruction.passwordField;
  const operands: LockOperands = {
    value: evaluator.evaluate(instruction.value),
    password: instruction.password === null ? undefined : evaluator.evaluate(instruction.password),
    passwordField:
      field === null
        ? null
        : {
            hint:
              field.hint === null
                ? null
                : fieldText(evaluator.evaluate(field.hint), span, currentTemporalContext(snapshot)),
          },
    timeLock: instruction.timeLock === null ? undefined : evaluator.evaluate(instruction.timeLock),
  };
  const handoff = snapshot.interactionResultHandoff;
  const step =
    handoff?.actionKind === "lock" && handoff.owningInstruction === snapshot.nextInstruction
      ? nextLockStep(
          instruction,
          operands,
          lockAnswer(handoff.result, span),
          handoff.actionId,
          snapshot,
        )
      : startLock(instruction, operands, snapshot);
  if (!("result" in step)) {
    requestLock(instruction, step, snapshot, events);
    return;
  }
  const needed = step.result === USE_DEFAULT;
  const value = step.result === USE_DEFAULT ? null : step.result;
  setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, value);
  evaluator.trace?.writeTemporary(evaluator.callFrameId(), instruction.destinationTemporary, value);
  if (instruction.defaultTemporary !== null) {
    setCapturedTemporary(snapshot.temporaries, instruction.defaultTemporary, needed);
    evaluator.trace?.writeTemporary(evaluator.callFrameId(), instruction.defaultTemporary, needed);
  }
  snapshot.nextInstruction += 1;
}

/** An answer a completion handed off: how the step ended, and the result text, file, or notice it carries. */
interface LockAnswer {
  readonly outcome: RuntimeLockOutcome;
  readonly detail: string | null;
}

/** The answer the completion handed off as a list of one or two texts. */
function lockAnswer(result: SerializableRuntimeValue, span: LockInstruction["span"]): LockAnswer {
  const items =
    result !== null && typeof result === "object" && result.kind === "list" ? result.items : [];
  const outcome = items[0];
  const detail = items.length === 2 ? items[1] : null;
  if (
    !isLockOutcome(outcome) ||
    items.length > 2 ||
    (detail !== null && typeof detail !== "string")
  )
    throw new RuntimeFault(
      "TSR050",
      internalFault("The answer of a lock is malformed."),
      copySpan(span),
    );
  return { outcome, detail };
}

/** The first run: checks the operands and asks the Player, or gives the default at once for text that is not Base64. */
function startLock(
  instruction: LockInstruction,
  operands: LockOperands,
  snapshot: RuntimeSnapshot,
): LockStep {
  const { value, password, passwordField } = operands;
  const span = instruction.span;
  const call = instruction.call;
  if (!locks(call) && password !== undefined && typeof password !== "string")
    throw new RuntimeFault(
      "TSR059",
      `'password:' of ${call}(...) takes text (string), not ${describeRuntimeValue(password)}.`,
      copySpan(span),
    );
  const written = typeof password === "string" ? password : null;
  if (call === "decryptText") {
    if (typeof value !== "string")
      throw new RuntimeFault(
        "TSR059",
        `decryptText(...) opens locked text (string), not ${describeRuntimeValue(value)}.`,
        copySpan(span),
      );
    // Text that is not Base64 is no lock, as for `fromBase64`.
    const binary = binaryFromBase64(value);
    if (binary === undefined) return { result: USE_DEFAULT };
    const lock = base64FromBinary(binary);
    return passwordField === null ? workStep(lock, written, null) : fieldStep(lock, passwordField);
  }
  if (call === "decryptFile") {
    const file = storedFile(call, value, snapshot, span);
    return passwordField === null ? workStep(file, written, null) : fieldStep(file, passwordField);
  }
  const openers = encryptOpeners(call, operands, span);
  const text = call === "encryptText" ? value : storedFile(call, value, snapshot, span);
  if (typeof text !== "string")
    throw new RuntimeFault(
      "TSR059",
      `encryptText(...) locks text (string), not ${describeRuntimeValue(text)}.`,
      copySpan(span),
    );
  if (
    openers.choices.length === 0 &&
    openers.password === null &&
    passwordField === null &&
    openers.timeLockMs === null
  )
    throw new RuntimeFault(
      "TSR059",
      `${call}(...) has no way to open, because 'password:' and 'timeLock:' are both false, so nothing could ever open it. Give one of them a value, or true to let the player choose.`,
      copySpan(span),
    );
  // An opener written `true`, or each without any written, is chosen by the player in the Player's lock dialog, after
  // the password field of `password: askPassword(...)` asked for its password.
  if (openers.choices.length > 0 || passwordField !== null)
    return dialogStep(call, text, openers, passwordField, snapshot, span);
  return workStep(text, openers.password, openers.timeLockMs);
}

/**
 * The checked openers of an encrypt call: `password:` takes text, `timeLock:` a moment, and each also `true`, which lets
 * the player choose it, or `false`, which leaves it out. A call writes each opener or none (plan validation).
 */
function encryptOpeners(
  call: LockCall,
  { password, passwordField, timeLock }: LockOperands,
  span: LockInstruction["span"],
): EncryptOpeners {
  if (password !== undefined && typeof password !== "string" && typeof password !== "boolean")
    throw new RuntimeFault(
      "TSR059",
      `'password:' of ${call}(...) takes text (string), true, or false, not ${describeRuntimeValue(password)}.`,
      copySpan(span),
    );
  if (timeLock !== undefined && typeof timeLock !== "boolean" && !isAbsoluteDateTime(timeLock))
    throw new RuntimeFault(
      "TSR059",
      `'timeLock:' of ${call}(...) takes a moment (absoluteDateTime), true, or false, not ${describeRuntimeValue(timeLock)}.`,
      copySpan(span),
    );
  const written = password !== undefined || passwordField !== null || timeLock !== undefined;
  const chosen = { password, timeLock };
  return {
    password: typeof password === "string" ? password : null,
    timeLockMs: typeof timeLock === "object" ? timeLock.epochMilliseconds : null,
    choices: LOCK_CHOICES.filter((choice) => !written || chosen[choice] === true),
  };
}

function workStep(value: string, password: string | null, timeLockMs: number | null): LockStep {
  return {
    phase: "work",
    value,
    password,
    timeLockMs,
    choices: [],
    dialogActionId: null,
    notice: null,
    passwordField: null,
  };
}

/** The password field of a decrypt call's `password: askPassword(...)`, which asks before the call opens. */
function fieldStep(
  value: string,
  passwordField: NonNullable<RuntimeLockActionSnapshot["passwordField"]>,
): LockStep {
  return {
    phase: "ask",
    value,
    password: null,
    timeLockMs: null,
    choices: [],
    dialogActionId: null,
    notice: null,
    passwordField,
  };
}

/**
 * An encrypt call's password field, of `password: askPassword(...)`, and the lock dialog, which asks the player for the
 * openers they choose, a chosen time lock suggested 7 days from now. The step after them locks with the openers the call
 * gives and what the player gave.
 */
function dialogStep(
  call: LockCall,
  value: string,
  { password, timeLockMs, choices }: EncryptOpeners,
  passwordField: RuntimeLockActionSnapshot["passwordField"],
  snapshot: RuntimeSnapshot,
  span: LockInstruction["span"],
): LockStep {
  return {
    phase: "ask",
    value,
    password,
    timeLockMs: choices.includes("timeLock")
      ? suggestedTimeLockMs(call, snapshot, span)
      : timeLockMs,
    choices,
    dialogActionId: null,
    notice: null,
    passwordField,
  };
}

/** The moment the lock dialog suggests: 7 days after the current moment, as `getAbsoluteDateTime()` gives it. */
function suggestedTimeLockMs(
  call: LockCall,
  snapshot: RuntimeSnapshot,
  span: LockInstruction["span"],
): number {
  const now = snapshot.currentSessionTimeMs;
  const epochMs = wallClockAt(temporalCaptureAt(snapshot.temporalCaptures, now), now);
  if (epochMs === undefined)
    throw new RuntimeFault(
      "TSR064",
      `${call}(...) needs the current time to suggest a time lock, but this Player supplied no clock when the session started or continued.`,
      copySpan(span),
    );
  return epochMs + SUGGESTED_TIME_LOCK_MS;
}

/**
 * A later run, with the answer to the step that `actionId` asked for: the result, the default, a failure, or the next
 * step, which asks the player, or works with what they typed.
 */
function nextLockStep(
  instruction: LockInstruction,
  operands: LockOperands,
  { outcome, detail }: LockAnswer,
  actionId: number,
  snapshot: RuntimeSnapshot,
): LockStep {
  const span = instruction.span;
  const call = instruction.call;
  switch (outcome) {
    case "locked":
    case "opened":
      if (detail === null) throw malformed(call, span);
      if (call === "encryptText" || call === "decryptText")
        checkTextLength(detail.length, `${call}(...)`, span);
      return { result: detail };
    case "notOpened":
    case "cancelled":
      return { result: USE_DEFAULT };
    case "unreadable":
      throw new RuntimeFault(
        "TSR085",
        `${call}(...) could not read the stored file it ${locks(call) ? "locks" : "opens"}, because this browser no longer has it or could not read it. Take, choose, or store the file again.`,
        copySpan(span),
      );
    case "failed":
      throw new RuntimeFault(
        "TSR086",
        `${call}(...) could not ${locks(call) ? "lock" : "open"} here, because this browser cannot encrypt on this page or could not keep the result. Open the Player over https, and make sure the browser has room to store files.`,
        copySpan(span),
      );
    case "ask":
    case "submitted": {
      // The operands were checked when the first run asked.
      const value = startValue(call, operands.value);
      const field = operands.passwordField;
      if (!locks(call)) {
        if (outcome === "submitted")
          return { ...workStep(value, null, null), dialogActionId: actionId, passwordField: field };
        // The password field asks again for a password that this Player no longer has.
        if (field !== null) return fieldStep(value, field);
        return {
          phase: "ask",
          value,
          password: null,
          timeLockMs: null,
          choices: [],
          dialogActionId: null,
          notice: detail === "wrongPassword" || detail === "unreachable" ? detail : null,
          passwordField: null,
        };
      }
      const openers = encryptOpeners(call, operands, span);
      // The step after the dialog locks with what the player gave there, instead of the moment it suggested.
      if (outcome === "submitted")
        return {
          phase: "work",
          value,
          password: openers.password,
          timeLockMs: openers.choices.includes("timeLock") ? null : openers.timeLockMs,
          choices: openers.choices,
          dialogActionId: actionId,
          notice: null,
          passwordField: field,
        };
      // The password field and the lock dialog ask again, a chosen time lock suggested from now.
      return dialogStep(call, value, openers, field, snapshot, span);
    }
  }
}

/** The value a later step asks for: the text or file as the first run passed it on, Base64 lock text standard again. */
function startValue(call: LockCall, value: SerializableRuntimeValue): string {
  if (typeof value !== "string") throw new TypeError(`${call}(...) asked again without its value.`);
  if (call !== "decryptText") return value;
  const binary = binaryFromBase64(value);
  if (binary === undefined) throw new TypeError("decryptText(...) asked again without its lock.");
  return base64FromBinary(binary);
}

function malformed(call: LockCall, span: LockInstruction["span"]): RuntimeFault {
  return new RuntimeFault(
    "TSR050",
    internalFault(`The answer of the Player does not fit ${call}(...).`),
    copySpan(span),
  );
}

/** Asks the Player to lock or open, or its dialog to ask the player, and waits with this instruction as continuation. */
function requestLock(
  instruction: LockInstruction,
  step: Exclude<LockStep, { readonly result: unknown }>,
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
): void {
  const span = instruction.span;
  if (
    !Number.isSafeInteger(snapshot.nextActionId) ||
    snapshot.nextActionId >= Number.MAX_SAFE_INTEGER
  )
    throw new RuntimeFault(
      "TSR051",
      internalFault("The session has used up its action numbers."),
      copySpan(span),
    );
  // The request and the completion, besides what active actions reserve.
  assertEventSequenceCapacity(snapshot, 2 + requiredFutureActionCompletionEvents(snapshot), span);
  const sequence = takeSequence(snapshot);
  const action: RuntimeLockActionSnapshot = Object.freeze({
    kind: "lock",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    destinationTemporary: instruction.destinationTemporary,
    createdAtMs: snapshot.currentSessionTimeMs,
    requestEventSequence: sequence,
    call: instruction.call,
    phase: step.phase,
    value: step.value,
    password: step.password,
    timeLockMs: step.timeLockMs,
    choices: step.choices,
    dialogActionId: step.dialogActionId,
    notice: step.notice,
    passwordField: step.passwordField,
    resumes: 0,
  });
  snapshot.nextActionId += 1;
  snapshot.foregroundAction = action;
  snapshot.status = "waiting";
  events.push(
    Object.freeze({
      kind: "actionRequested",
      sequence,
      action: { ...action },
      span: copySpan(span),
    } satisfies ActionRequestedEvent),
  );
}

/** The stored file of `encryptFile` or `decryptFile`, which must be one this session knows. */
function storedFile(
  call: "encryptFile" | "decryptFile",
  value: SerializableRuntimeValue,
  snapshot: RuntimeSnapshot,
  span: LockInstruction["span"],
): string {
  if (typeof value === "string" && holdsStoredFile(snapshot.storedFiles, value)) return value;
  throw new RuntimeFault(
    "TSR059",
    `${call}(...) ${call === "encryptFile" ? "locks" : "opens"} a stored file, ${
      typeof value === "string"
        ? `but ${JSON.stringify(messageText(value))} is not one`
        : `not ${describeRuntimeValue(value)}`
    }. Pass the text that takePhoto(), askImage(...), fileFromBase64(...), or encryptFile(...) gave for a file.`,
    copySpan(span),
  );
}

function isAbsoluteDateTime(
  value: SerializableRuntimeValue,
): value is { readonly kind: "absoluteDateTime"; readonly epochMilliseconds: number } {
  return value !== null && typeof value === "object" && value.kind === "absoluteDateTime";
}

const LOCK_OUTCOMES: readonly RuntimeLockOutcome[] = [
  "locked",
  "opened",
  "notOpened",
  "unreadable",
  "failed",
  "ask",
  "submitted",
  "cancelled",
];

export function isLockOutcome(value: unknown): value is RuntimeLockOutcome {
  return LOCK_OUTCOMES.some((outcome) => outcome === value);
}

/** A lock completion the engine accepts: how the step ended, and the text, file, or notice it carries. */
export type LockCompletion =
  | {
      readonly ok: true;
      readonly outcome: RuntimeLockOutcome;
      readonly detail: string | null;
      /** The stored file the Player kept: a locked file, or an opened file of its type's kind. */
      readonly stored: string | null;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Resolves a lock completion payload for the action's call and phase. In `work`: `{ kind: "locked", text }` with the
 * standard Base64 lock of `encryptText`, `{ kind: "locked", file }` with the locked stored file of `encryptFile`,
 * `{ kind: "opened", text }` of `decryptText`, `{ kind: "opened", file, type }` of `decryptFile`, whose type its bytes
 * give and whose file the trusted host vouches for with that type's kind, `{ kind: "notOpened" }` when a decrypt call
 * does not open, `{ kind: "failed", reason: "unreadable" | "unavailable" }`, or `{ kind: "ask", notice? }` when the Player
 * must ask the player: for a decrypt call without `password:`, or when the typed answer of the dialog or password field
 * was lost. In `ask`: `{ kind: "submitted" }`, or `{ kind: "cancelled" }` for the unlock dialog.
 */
export function resolveLockCompletion(
  payload: unknown,
  action: RuntimeLockActionSnapshot,
  admission: CapturedMediaAdmission | undefined,
): LockCompletion {
  if (!isPlainRecord(payload)) return invalidLockPayload();
  const keys = Object.keys(payload).sort().join(",");
  const encrypts = locks(action.call);
  const ok = (
    outcome: RuntimeLockOutcome,
    detail: string | null = null,
    stored: string | null = null,
  ) => ({ ok: true, outcome, detail, stored }) as const;
  if (action.phase === "ask") {
    if (payload.kind === "submitted" && keys === "kind") return ok("submitted");
    // The unlock dialog has Cancel; the password field, like any ask, has none.
    if (
      payload.kind === "cancelled" &&
      keys === "kind" &&
      !encrypts &&
      action.passwordField === null
    )
      return ok("cancelled");
    return invalidLockPayload();
  }
  switch (payload.kind) {
    case "locked":
      if (!encrypts) break;
      if (action.call === "encryptText") {
        if (
          keys !== "kind,text" ||
          typeof payload.text !== "string" ||
          !isStandardBase64(payload.text)
        )
          break;
        return ok("locked", payload.text);
      }
      if (keys !== "file,kind" || !storedReference(payload.file)) break;
      if (admission?.holds(payload.file, "file") !== true)
        return { ok: false, message: "The locked file is not stored media of this host." };
      return ok("locked", payload.file, payload.file);
    case "opened":
      if (encrypts) break;
      if (action.call === "decryptText") {
        if (keys !== "kind,text" || typeof payload.text !== "string") break;
        return ok("opened", payload.text);
      }
      if (
        keys !== "file,kind,type" ||
        !storedReference(payload.file) ||
        typeof payload.type !== "string" ||
        !(isRecognizedFileType(payload.type) || payload.type === OCTET_STREAM)
      )
        break;
      if (admission?.holds(payload.file, storedFileKind(payload.type)) !== true)
        return { ok: false, message: "The opened file is not stored media of this host." };
      return ok("opened", payload.file, payload.file);
    case "notOpened":
      if (encrypts || keys !== "kind") break;
      return ok("notOpened");
    case "failed":
      if (
        keys !== "kind,reason" ||
        (payload.reason !== "unavailable" &&
          (payload.reason !== "unreadable" ||
            action.call === "encryptText" ||
            action.call === "decryptText"))
      )
        break;
      return ok(payload.reason === "unreadable" ? "unreadable" : "failed");
    case "ask": {
      // Only the dialog's own call asks: a decrypt call without `password:`, or one whose typed answer was lost. The
      // password field asks again only for a password this Player no longer has.
      if (encrypts ? action.dialogActionId === null : action.password !== null) break;
      if (keys === "kind") return ok("ask");
      if (
        encrypts ||
        action.passwordField !== null ||
        keys !== "kind,notice" ||
        (payload.notice !== "unreachable" &&
          (payload.notice !== "wrongPassword" || action.dialogActionId === null))
      )
        break;
      return ok("ask", payload.notice);
    }
  }
  return invalidLockPayload();
}

function storedReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && interactionStringFits(value);
}

function invalidLockPayload(): LockCompletion {
  return {
    ok: false,
    message:
      "Lock completion payload must be { kind: 'locked', text | file }, { kind: 'opened', text | file, type }, { kind: 'notOpened' }, { kind: 'failed', reason }, or { kind: 'ask', notice? } for a step, or { kind: 'submitted' } or { kind: 'cancelled' } for a dialog.",
  };
}
