import type { FileStoreInstruction } from "../../plan/model.js";
import { internalFault, RuntimeFault } from "../errors.js";
import type { Evaluator } from "../evaluator.js";
import type { ActionRequestedEvent, InterpreterEvent } from "../events.js";
import { readExpected, replaceKeptTexts } from "../values/expected-reading.js";
import { jsonText, valueFromJson } from "../values/json-base64.js";
import { emitDeveloperWarning } from "../operations/media-lifecycle.js";
import {
  assertEventSequenceCapacity,
  requiredFutureActionCompletionEvents,
  setCapturedTemporary,
  takeSequence,
} from "../operations/support.js";
import type {
  SerializableRuntimeDict,
  SerializableRuntimeList,
  SerializableRuntimeValue,
} from "../values/serializable-values.js";
import type { RuntimeSnapshot } from "../snapshot/state.js";
import {
  base64FileType,
  base64FromBinary,
  base64Length,
  binaryFromBase64,
  binaryFromDataUrl,
  fileType,
  holdsStoredFile,
  isDataUrl,
  isRecognizedFileType,
  isStandardBase64,
  storedFileKind,
} from "../host-data/stored-files.js";
import { interactionStringFits } from "../../interaction-limits.js";
import { isSha256Hex } from "../values/sha256.js";
import { checkTextLength, messageText } from "../values/text-length.js";
import type { CapturedMediaAdmission } from "./capture.js";
import {
  ACTION_COMPLETION_EVENTS,
  type RuntimeFileStoreActionSnapshot,
  type RuntimeFileToStore,
} from "./model.js";
import { filesOptionMessage } from "../../conversions.js";
import { storedFileFix, textOperandMessage } from "../../text-operand-rules.js";
import { describeValue } from "../../value-kinds.js";
import { copySpan } from "../../plan/source-location.js";
import { isPlainRecord } from "../values/plain-data.js";
import { USE_DEFAULT } from "../evaluation/support.js";

// The calls that may use the Player's file store (V30 §13 and §33). A `fileStore` instruction first works out which files
// to store, read, or hash. Without any it gives the result at once; otherwise it asks the Player and waits, and runs
// again with the Player's answer, which the completion hands off, to give the result. Both runs read the same operands,
// so they find the same files in the same order. A `default:` runs only when it is used, as the instructions after it.

/**
 * The Player's answer as the instruction reads it: the stored files' references, the read files' Base64, or the hashed
 * files' SHA-256, in request order, or `null` when the Player could not store, read, or hash them.
 */
type FileStoreAnswer = readonly string[] | null;

/** What the first run found: the result, the files to store, read, or hash, or that the call needs its default. */
type FileStoreRequest =
  | { readonly result: SerializableRuntimeValue | typeof USE_DEFAULT }
  | { readonly store: readonly RuntimeFileToStore[] }
  | { readonly read: readonly string[] }
  | { readonly hash: readonly string[] };

interface FileStoreOperands {
  readonly value: SerializableRuntimeValue;
  readonly files: boolean;
}

/** Runs a `fileStore` instruction, the first time or again with the Player's answer. */
export function executeFileStore(
  instruction: FileStoreInstruction,
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
  const operands: FileStoreOperands = {
    value: evaluator.evaluate(instruction.value),
    files:
      instruction.files === null
        ? true
        : filesOperand(instruction.call, evaluator.evaluate(instruction.files), span),
  };
  const handoff = snapshot.interactionResultHandoff;
  let result: SerializableRuntimeValue | typeof USE_DEFAULT;
  if (
    handoff?.actionKind === "fileStore" &&
    handoff.owningInstruction === snapshot.nextInstruction
  ) {
    result = finishFileStore(
      instruction,
      operands,
      fileStoreAnswer(handoff.result, span),
      snapshot,
      evaluator,
      events,
    );
  } else {
    const request = startFileStore(instruction, operands, snapshot, evaluator);
    if (!("result" in request)) {
      requestFileStore(instruction, request, snapshot, events);
      return;
    }
    result = request.result;
  }
  let needed = result === USE_DEFAULT;
  let value = result === USE_DEFAULT ? null : result;
  // the JSON read as the call's expected type: a record with fields the default supplies waits for it in the result
  if (instruction.expected !== undefined && result !== USE_DEFAULT)
    ({ needed, value } = evaluator.readJson(result, instruction.expected, copySpan(span)));
  setCapturedTemporary(snapshot.temporaries, instruction.destinationTemporary, value);
  evaluator.trace?.writeTemporary(evaluator.callFrameId(), instruction.destinationTemporary, value);
  if (instruction.defaultTemporary !== null) {
    setCapturedTemporary(snapshot.temporaries, instruction.defaultTemporary, needed);
    evaluator.trace?.writeTemporary(evaluator.callFrameId(), instruction.defaultTemporary, needed);
  }
  snapshot.nextInstruction += 1;
}

/** The texts of the answer a completion handed off, or `null` for a failure. */
function fileStoreAnswer(
  result: SerializableRuntimeValue,
  span: FileStoreInstruction["span"],
): FileStoreAnswer {
  if (result === null) return null;
  const texts: string[] = [];
  if (typeof result === "object" && result.kind === "list")
    for (const item of result.items) if (typeof item === "string") texts.push(item);
  if (typeof result !== "object" || result.kind !== "list" || texts.length !== result.items.length)
    throw new RuntimeFault(
      "TSR050",
      internalFault("The answer of the file store is malformed."),
      copySpan(span),
    );
  return texts;
}

/** The files a call needs stored, read, or hashed, or its result when it needs none. */
function startFileStore(
  instruction: FileStoreInstruction,
  { value, files }: FileStoreOperands,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): FileStoreRequest {
  const span = instruction.span;
  switch (instruction.call) {
    case "fileFromBase64": {
      if (typeof value !== "string") return { result: USE_DEFAULT };
      const binary = binaryFromDataUrl(value) ?? binaryFromBase64(value);
      if (binary === undefined) return { result: USE_DEFAULT };
      checkTextLength(base64Length(binary.length), "fileFromBase64(...)", span);
      return { store: [{ type: fileType(binary), base64: base64FromBinary(binary) }] };
    }
    case "fileToBase64":
      return { read: [storedFileOperand(instruction.call, value, snapshot, span)] };
    case "hashFile":
      return { hash: [storedFileOperand(instruction.call, value, snapshot, span)] };
    case "toJson": {
      const references: string[] = [];
      const found = new Set<string>();
      const text = jsonText(
        value,
        (speaker) => evaluator.speakerById(speaker.speakerId, span).properties,
        span,
        files
          ? (written) => {
              if (!found.has(written) && holdsStoredFile(snapshot.storedFiles, written)) {
                found.add(written);
                references.push(written);
              }
              return undefined;
            }
          : undefined,
      );
      return references.length === 0 ? { result: text } : { read: references };
    }
    case "fromJson": {
      const read = typeof value === "string" ? valueFromJson(value, span) : undefined;
      if (read === undefined) return { result: USE_DEFAULT };
      // JSON of another kind than the call expects gives its default before any file is stored
      if (
        instruction.expected !== undefined &&
        readExpected(read, instruction.expected, true).kind === "none"
      ) {
        evaluator.readJson(read, instruction.expected, copySpan(span));
        return { result: USE_DEFAULT };
      }
      if (!files) return { result: read };
      const store: RuntimeFileToStore[] = [];
      const found = new Set<string>();
      replaceJsonFiles(read, instruction, (file) => {
        if (!found.has(file.base64)) {
          found.add(file.base64);
          store.push(file);
        }
        return undefined;
      });
      return store.length === 0 ? { result: read } : { store };
    }
  }
}

/** The result of a call once the Player stored, read, or hashed its files, or could not. */
function finishFileStore(
  instruction: FileStoreInstruction,
  { value }: FileStoreOperands,
  answer: FileStoreAnswer,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): SerializableRuntimeValue | typeof USE_DEFAULT {
  const span = instruction.span;
  const call = instruction.call;
  if (answer === null) {
    if (call === "fileToBase64" || call === "hashFile" || call === "toJson")
      throw new RuntimeFault(
        "TSR085",
        `${call}(...) could not read a stored file it needs, because this browser no longer has it or could not read it. Take, choose, or store the file again.`,
        copySpan(span),
      );
    emitDeveloperWarning(
      snapshot,
      events,
      "TSW019",
      `The Player could not keep the ${call === "fromJson" ? "files of this JSON" : "file"}, so ${call}(...) gave its default.`,
      span,
    );
    return USE_DEFAULT;
  }
  const malformed = () =>
    new RuntimeFault(
      "TSR050",
      internalFault(`The answer of the file store does not fit ${call}(...).`),
      copySpan(span),
    );
  switch (call) {
    case "fileFromBase64":
    case "fileToBase64":
    case "hashFile":
      if (answer.length !== 1) throw malformed();
      return answer[0]!;
    case "toJson": {
      const written = new Map<string, string>();
      const text = jsonText(
        value,
        (speaker) => evaluator.speakerById(speaker.speakerId, span).properties,
        span,
        (reference) => {
          if (!holdsStoredFile(snapshot.storedFiles, reference)) return undefined;
          let dataUrl = written.get(reference);
          if (dataUrl === undefined) {
            const base64 = answer[written.size];
            if (base64 === undefined) throw malformed();
            // Standard Base64 and a type of the fixed list need no escapes in JSON.
            dataUrl = `"data:${base64FileType(base64)};base64,${base64}"`;
            written.set(reference, dataUrl);
          }
          return dataUrl;
        },
      );
      if (written.size !== answer.length) throw malformed();
      return text;
    }
    case "fromJson": {
      const read = typeof value === "string" ? valueFromJson(value, span) : undefined;
      if (read === undefined) throw malformed();
      const references = new Map<string, string>();
      const result = replaceJsonFiles(read, instruction, (file) => {
        let reference = references.get(file.base64);
        if (reference === undefined) {
          reference = answer[references.size];
          if (reference === undefined) throw malformed();
          references.set(file.base64, reference);
        }
        return reference;
      });
      if (references.size !== answer.length) throw malformed();
      return result;
    }
  }
}

/** Asks the Player to store, read, or hash files and waits for its answer, with this instruction as the continuation. */
function requestFileStore(
  instruction: FileStoreInstruction,
  request: Exclude<FileStoreRequest, { readonly result: SerializableRuntimeValue }>,
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
  assertEventSequenceCapacity(
    snapshot,
    1 + ACTION_COMPLETION_EVENTS.fileStore + requiredFutureActionCompletionEvents(snapshot),
    span,
  );
  const sequence = takeSequence(snapshot);
  const action: RuntimeFileStoreActionSnapshot = Object.freeze({
    kind: "fileStore",
    actionId: snapshot.nextActionId,
    owningInstruction: snapshot.nextInstruction,
    continuationInstruction: snapshot.nextInstruction,
    ownerCallFrameId: snapshot.callFrames.at(-1)?.id ?? null,
    scopeDepth: snapshot.frames.length,
    loopDepth: snapshot.loopFrames.length,
    destinationTemporary: instruction.destinationTemporary,
    createdAtMs: snapshot.currentSessionTimeMs,
    requestEventSequence: sequence,
    operation: "store" in request ? "store" : "read" in request ? "read" : "hash",
    files: "store" in request ? request.store : [],
    references: "read" in request ? request.read : "hash" in request ? request.hash : [],
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

/** The text of `fileToBase64` or `hashFile`, which must be a stored file this session knows. */
function storedFileOperand(
  call: "fileToBase64" | "hashFile",
  value: SerializableRuntimeValue,
  snapshot: RuntimeSnapshot,
  span: FileStoreInstruction["span"],
): string {
  if (typeof value === "string" && holdsStoredFile(snapshot.storedFiles, value)) return value;
  throw new RuntimeFault(
    typeof value === "string" ? "TSR059" : "TSV043",
    typeof value === "string"
      ? `${call}(...) ${call === "hashFile" ? "hashes" : "reads"} a stored file, but ${JSON.stringify(messageText(value))} is not one. ${storedFileFix(call)}`
      : textOperandMessage(call, describeValue(value)),
    copySpan(span),
  );
}

function filesOperand(
  call: FileStoreInstruction["call"],
  value: SerializableRuntimeValue,
  span: FileStoreInstruction["span"],
): boolean {
  if (typeof value === "boolean") return value;
  throw new RuntimeFault("TSV043", filesOptionMessage(call, describeValue(value)), copySpan(span));
}

/**
 * Visits each text of `value`, which `fromJson` read, that is a data URL of a recognized file type: the value itself, or
 * a list element or dict value at any depth, in reading order. What `replace` gives takes its place, and the value with
 * those changes is returned. A dict's keys stay text.
 */
function replaceFileDataUrls(
  value: SerializableRuntimeValue,
  replace: (file: RuntimeFileToStore) => string | undefined,
): SerializableRuntimeValue {
  if (typeof value === "string") {
    const file = fileInDataUrl(value);
    return (file === undefined ? undefined : replace(file)) ?? value;
  }
  const pending: {
    readonly holder: SerializableRuntimeList | SerializableRuntimeDict;
    readonly index: number;
  }[] = [];
  const enter = (item: SerializableRuntimeValue) => {
    if (item === null || typeof item !== "object" || (item.kind !== "list" && item.kind !== "dict"))
      return;
    // Last first, so that the stack gives them in reading order.
    const length = item.kind === "list" ? item.items.length : item.entries.length;
    for (let index = length - 1; index >= 0; index -= 1) pending.push({ holder: item, index });
  };
  enter(value);
  for (let slot = pending.pop(); slot !== undefined; slot = pending.pop()) {
    const { holder, index } = slot;
    const item = holder.kind === "list" ? holder.items[index]! : holder.entries[index]!.value;
    if (typeof item !== "string") {
      enter(item);
      continue;
    }
    const file = fileInDataUrl(item);
    const replacement = file === undefined ? undefined : replace(file);
    if (replacement === undefined) continue;
    if (holder.kind === "list") holder.items[index] = replacement;
    else holder.entries[index]!.value = replacement;
  }
  return value;
}

/**
 * `replaceFileDataUrls` over what `fromJson` keeps of its JSON: with an expected type (`FileStoreInstruction.expected`),
 * only the parts the reading takes, so that a key the type leaves out or a field the default supplies is never stored
 * (ADR 0021 rule 2.6); else the whole value, as today's plans read it.
 */
function replaceJsonFiles(
  read: SerializableRuntimeValue,
  instruction: FileStoreInstruction,
  replace: (file: RuntimeFileToStore) => string | undefined,
): SerializableRuntimeValue {
  if (instruction.expected === undefined) return replaceFileDataUrls(read, replace);
  return replaceKeptTexts(read, instruction.expected, (text) => {
    const file = fileInDataUrl(text);
    return file === undefined ? undefined : replace(file);
  });
}

/** The file a data URL holds when its bytes are of a recognized type; any other text holds none. */
function fileInDataUrl(text: string): RuntimeFileToStore | undefined {
  if (!isDataUrl(text)) return undefined;
  const binary = binaryFromDataUrl(text);
  if (binary === undefined) return undefined;
  const type = fileType(binary);
  return isRecognizedFileType(type) ? { type, base64: base64FromBinary(binary) } : undefined;
}

/** A file store completion the engine accepts: the outcome, and the answer the instruction runs again with. */
export type FileStoreCompletion =
  | {
      readonly ok: true;
      readonly outcome: "stored" | "read" | "hashed" | "failed";
      readonly answer: FileStoreAnswer;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Resolves a file store completion payload: `{ kind: "stored", references }` with one reference per file to store, each
 * of stored media of the file's kind that the trusted host vouches for and none twice; `{ kind: "read", files }` with
 * the standard Base64 of each file to read; `{ kind: "hashed", hashes }` with the SHA-256 of each file to hash, as 64
 * lowercase hexadecimal digits; or `{ kind: "failed" }` when the Player could not store, read, or hash them.
 */
export function resolveFileStoreCompletion(
  payload: unknown,
  action: RuntimeFileStoreActionSnapshot,
  admission: CapturedMediaAdmission | undefined,
): FileStoreCompletion {
  if (!isPlainRecord(payload)) return invalidFileStorePayload();
  if (payload.kind === "failed")
    return Object.keys(payload).length === 1
      ? { ok: true, outcome: "failed", answer: null }
      : invalidFileStorePayload();
  if (payload.kind === "stored" && action.operation === "store") {
    const stored = texts(payload.references);
    if (
      Object.keys(payload).length !== 2 ||
      stored === null ||
      stored.length !== action.files.length ||
      !stored.every((reference) => reference.length > 0 && interactionStringFits(reference)) ||
      new Set(stored).size !== stored.length
    )
      return invalidFileStorePayload();
    if (
      !stored.every(
        (reference, index) =>
          admission?.holds(reference, storedFileKind(action.files[index]!.type)) === true,
      )
    )
      return { ok: false, message: "A stored file is not stored media of this host." };
    return { ok: true, outcome: "stored", answer: stored };
  }
  if (payload.kind === "read" && action.operation === "read") {
    const files = texts(payload.files);
    if (
      Object.keys(payload).length !== 2 ||
      files === null ||
      files.length !== action.references.length ||
      !files.every(isStandardBase64)
    )
      return invalidFileStorePayload();
    return { ok: true, outcome: "read", answer: files };
  }
  if (payload.kind === "hashed" && action.operation === "hash") {
    const hashes = texts(payload.hashes);
    if (
      Object.keys(payload).length !== 2 ||
      hashes === null ||
      hashes.length !== action.references.length ||
      !hashes.every(isSha256Hex)
    )
      return invalidFileStorePayload();
    return { ok: true, outcome: "hashed", answer: hashes };
  }
  return invalidFileStorePayload();
}

/** `value` when it is a list of texts, else `null`. */
function texts(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const found: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    found.push(item);
  }
  return found;
}

function invalidFileStorePayload(): FileStoreCompletion {
  return {
    ok: false,
    message:
      "File store completion payload must be { kind: 'stored', references } for files to store, { kind: 'read', files } for files to read, { kind: 'hashed', hashes } for files to hash, or { kind: 'failed' }.",
  };
}
