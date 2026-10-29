/**
 * What a built-in does with the text it takes, and the message for a value that is not text, which the type checker
 * (`TSV043`) and the runtime both give: the rule, then "not" and the value as `describeValue` describes it (its type at
 * compile time, the value at runtime), then the fix.
 */

import { VALUE_KINDS, type ValueKind } from "./value-kinds.js";

const TEXT_OPERANDS = {
  hashText: "hashes text (string)",
  toBase64: "encodes text (string)",
  escapeMarkup: "takes text (string)",
  encryptText: "locks text (string)",
  decryptText: "opens locked text (string)",
  hashFile: "hashes a stored file, which is text (string)",
  fileToBase64: "reads a stored file, which is text (string)",
  encryptFile: "locks a stored file, which is text (string)",
  decryptFile: "opens a stored file, which is text (string)",
} as const;

export type TextOperandCallee = keyof typeof TEXT_OPERANDS;

/** The callees that take a stored file, with the call that gives one besides those of every file. */
const STORED_FILE_SOURCES = {
  hashFile: "fromJson(...)",
  fileToBase64: "fromJson(...)",
  encryptFile: "encryptFile(...)",
  decryptFile: "encryptFile(...)",
} as const;

export type StoredFileCallee = keyof typeof STORED_FILE_SOURCES;

/**
 * Where the stored file that `callee` takes comes from: the fix after a value that is not text, and after text that is
 * not a stored file this session knows (runtime error `TSR059`).
 */
export function storedFileFix(callee: StoredFileCallee): string {
  return `Pass the text that takePhoto(), askImage(...), fileFromBase64(...), or ${STORED_FILE_SOURCES[callee]} gave for a file.`;
}

function takesStoredFile(callee: TextOperandCallee): callee is StoredFileCallee {
  return Object.hasOwn(STORED_FILE_SOURCES, callee);
}

/** `callee` given a value that is not text, described as `given`, with the fix of a stored file or else `fix`. */
export function textOperandMessage(callee: TextOperandCallee, given: string, fix = ""): string {
  const files = takesStoredFile(callee) ? ` ${storedFileFix(callee)}` : fix;
  return `${callee}(...) ${TEXT_OPERANDS[callee]}, not ${given}.${files}`;
}

/**
 * The fix for `escapeMarkup` of a value of `kind` that is not text: `toString(...)` for a value that text shows, and
 * `join()` for a list whose elements text all shows (`elementsShown`).
 */
export function escapeMarkupFix(kind: ValueKind | undefined, elementsShown: boolean): string {
  if (kind === undefined) return "";
  if (kind !== "null" && VALUE_KINDS[kind].shown !== null)
    return " Convert the value with the toString function first.";
  return kind === "list" && elementsShown
    ? " Call join() on the list to combine its elements as text."
    : "";
}
