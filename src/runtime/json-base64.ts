import type { RuntimeErrorCode } from "../diagnostic-codes.js";
import { WRITABLE_JSON_FIX } from "../conversions.js";
import type { PlanSourceLocation } from "../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../source.js";
import {
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  formatIsoTimestamp,
} from "../temporal.js";
import { collectionTooLong, MAX_COLLECTION_LENGTH } from "./collection-size.js";
import { RuntimeFault } from "./errors.js";
import { copySpan } from "./operations/support.js";
import type {
  SerializableRuntimeDict,
  SerializableRuntimeList,
  SerializableRuntimeProperty,
  SerializableRuntimeValue,
  SerializableSpeakerReference,
} from "./serializable-values.js";
import { binaryFromBase64 } from "./stored-files.js";
import { checkTextLength, textTooLong } from "./text-length.js";
import { describeValue, unwritableJsonReason, VALUE_KINDS, valueKindOf } from "../value-kinds.js";

// `toJson`, `fromJson`, `toBase64`, and `fromBase64` (V30 §13), which exchange data with other programs as text. Native
// JSON writes and reads each text and number, and native Base64 and UTF-8 do the rest; the structure is walked here,
// without native recursion, so that keys keep their order and deep values neither overflow the stack nor depend on the
// browser.

type SourceSpan = RichSourceSpan | PlanSourceLocation;

/** The work of `toJson`: a value to write, written text, or the end of a speaker's properties. */
type JsonWork =
  | { readonly value: SerializableRuntimeValue; readonly nested: boolean }
  | { readonly text: string }
  | { readonly speakerEnd: number };

/**
 * The compact JSON text of `value`: text, numbers, `true`, `false`, and `null` as they are; a list or set as an array, a
 * set in its order; a dict, an object, and a speaker's properties as an object in key order; a date or time as its ISO
 * text, an absolute one in UTC; a duration as its milliseconds; and an angle as its degrees. Any other value fails with `TSR059`, and a text
 * longer than a text can be with `TSR084`. `storedFile` may give the JSON to write in place of a text, in the order the
 * texts are written; keys are never given to it.
 */
export function jsonText(
  value: SerializableRuntimeValue,
  speakerProperties: (
    speaker: SerializableSpeakerReference,
  ) => readonly SerializableRuntimeProperty[],
  span: SourceSpan,
  storedFile?: (text: string) => string | undefined,
): string {
  const out: string[] = [];
  let length = 0;
  const write = (text: string) => {
    length += text.length;
    checkTextLength(length, "toJson(...)", span);
    out.push(text);
  };
  // A speaker whose properties are being written; meeting it again inside them would never end.
  const writing = new Set<number>();
  const work: JsonWork[] = [{ value, nested: false }];
  const pushEntries = (
    entries: readonly { readonly key: string; readonly value: SerializableRuntimeValue }[],
  ) => {
    work.push({ text: "}" });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      work.push({ value: entry.value, nested: true });
      work.push({ text: `${index === 0 ? "" : ","}${jsonString(entry.key, span)}:` });
    }
    work.push({ text: "{" });
  };
  while (work.length > 0) {
    const item = work.pop()!;
    if ("text" in item) {
      write(item.text);
      continue;
    }
    if ("speakerEnd" in item) {
      writing.delete(item.speakerEnd);
      continue;
    }
    const current = item.value;
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      write(String(current));
      continue;
    }
    if (typeof current === "string") {
      write(storedFile?.(current) ?? jsonString(current, span));
      continue;
    }
    if (VALUE_KINDS[valueKindOf(current)].json === null)
      throw fault("TSR059", unwritableMessage(current, item.nested), span);
    switch (current.kind) {
      case "list":
      case "set": {
        work.push({ text: "]" });
        for (let index = current.items.length - 1; index >= 0; index -= 1) {
          work.push({ value: current.items[index]!, nested: true });
          if (index > 0) work.push({ text: "," });
        }
        work.push({ text: "[" });
        continue;
      }
      case "dict":
        pushEntries(current.entries);
        continue;
      case "object":
        pushEntries(current.properties.map(({ name, value }) => ({ key: name, value })));
        continue;
      case "speakerReference": {
        if (writing.has(current.speakerId))
          throw fault(
            "TSR059",
            `toJson(...) cannot write speaker '${current.identifier}' inside its own properties, as the text would never end. Write the speaker's name in its place instead.`,
            span,
          );
        writing.add(current.speakerId);
        work.push({ speakerEnd: current.speakerId });
        pushEntries(speakerProperties(current).map(({ name, value }) => ({ key: name, value })));
        continue;
      }
      case "date":
        write(`"${formatIsoDate(current)}"`);
        continue;
      case "time":
        write(`"${formatIsoTime(current)}"`);
        continue;
      case "datetime":
        write(`"${formatIsoDateTime(current)}"`);
        continue;
      case "absoluteDateTime":
        write(`"${formatIsoTimestamp(current.epochMilliseconds)}"`);
        continue;
      case "duration":
        write(String(current.milliseconds));
        continue;
      case "angle":
        write(String(current.degrees));
        continue;
      default:
        throw new Error(`toJson(...) has no JSON form for ${describeValue(current)}.`);
    }
  }
  return out.join("");
}

/** Why `toJson` cannot write `value`, which it holds or is. */
function unwritableMessage(value: SerializableRuntimeValue, nested: boolean): string {
  const kind = describeValue(value);
  const reason = unwritableJsonReason(valueKindOf(value));
  return nested
    ? `toJson(...) cannot write this value: it holds ${kind}, which ${reason}. ${WRITABLE_JSON_FIX}`
    : `toJson(...) cannot write ${kind}, which ${reason}. ${WRITABLE_JSON_FIX}`;
}

/** `text` as a JSON string, as native JSON writes it, or `TSR084` when that would be longer than a text can be. */
function jsonString(text: string, span: SourceSpan): string {
  try {
    return JSON.stringify(text);
  } catch (error) {
    if (error instanceof RangeError) throw textTooLong("toJson(...)", span, null);
    throw error;
  }
}

/**
 * An array or object that `valueFromJson` is reading, with the key of the value it reads next in an object, and the
 * number of its elements or keys so far; those past `MAX_COLLECTION_LENGTH` are counted but not kept.
 */
type OpenJson =
  | { readonly list: SerializableRuntimeList; length: number }
  | {
      readonly dict: SerializableRuntimeDict;
      /**
       * The position of each key, so a repeated key replaces the value at its first position; a key past the limit has a
       * position past the last entry.
       */
      readonly positions: Map<string, number>;
      key: string;
      length: number;
    };

const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

/**
 * The runtime value of JSON `text` (RFC 8259), or `undefined` when it is not JSON or holds a number too large to
 * represent. An object becomes a dict in source order; a repeated key keeps its first position with its last value. An
 * array becomes a list, and a whole number an integer. JSON with an array or object of more elements or keys than a
 * list or dict can hold fails with `TSR088`, naming how many the first one to end has.
 */
export function valueFromJson(
  text: string,
  span: SourceSpan,
): SerializableRuntimeValue | undefined {
  const open: OpenJson[] = [];
  let tooLong: OpenJson | undefined;
  let at = 0;
  const skipWhitespace = () => {
    for (; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if (code !== 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) return;
    }
  };
  const readString = (): string | undefined => {
    if (text.charCodeAt(at) !== QUOTE) return undefined;
    const start = at;
    let escaped = false;
    for (at += 1; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if (code === QUOTE) {
        at += 1;
        if (!escaped) return text.slice(start + 1, at - 1);
        // Native JSON checks and decodes the escapes.
        try {
          // EVIDENCE: the slice runs from one quote to the next unescaped one, so native JSON reads it as text or fails.
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return undefined;
        }
      }
      if (code < 0x20) return undefined;
      if (code === BACKSLASH) {
        escaped = true;
        at += 1;
      }
    }
    return undefined;
  };
  // The key of an object's next value, and the colon after it.
  const readKey = (): string | undefined => {
    skipWhitespace();
    const key = readString();
    skipWhitespace();
    if (key === undefined || text.charCodeAt(at) !== COLON) return undefined;
    at += 1;
    return key;
  };
  const digits = () => {
    const start = at;
    while (at < text.length && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x39) at += 1;
    return at > start;
  };
  const readNumber = (): number | undefined => {
    const start = at;
    if (text.charCodeAt(at) === 0x2d) at += 1;
    if (text.charCodeAt(at) === 0x30) at += 1;
    else if (!digits()) return undefined;
    if (text.charCodeAt(at) === 0x2e) {
      at += 1;
      if (!digits()) return undefined;
    }
    if ((text.charCodeAt(at) | 0x20) === 0x65) {
      at += 1;
      if (text.charCodeAt(at) === 0x2b || text.charCodeAt(at) === 0x2d) at += 1;
      if (!digits()) return undefined;
    }
    // Native number reading, as JSON reads it; a number too large to represent has no value.
    const value = Number(text.slice(start, at));
    return Number.isFinite(value) ? (value === 0 ? 0 : value) : undefined;
  };
  const literal = (word: string): boolean => {
    if (!text.startsWith(word, at)) return false;
    at += word.length;
    return true;
  };

  for (;;) {
    // A value starts here: the whole text's, or the next of an array or object.
    skipWhitespace();
    let value: SerializableRuntimeValue | undefined;
    const code = text.charCodeAt(at);
    if (code === OPEN_BRACKET) {
      at += 1;
      skipWhitespace();
      const list: SerializableRuntimeList = { kind: "list", items: [] };
      if (text.charCodeAt(at) !== CLOSE_BRACKET) {
        open.push({ list, length: 0 });
        continue;
      }
      at += 1;
      value = list;
    } else if (code === OPEN_BRACE) {
      at += 1;
      skipWhitespace();
      const dict: SerializableRuntimeDict = { kind: "dict", entries: [] };
      if (text.charCodeAt(at) !== CLOSE_BRACE) {
        const key = readKey();
        if (key === undefined) return undefined;
        open.push({ dict, positions: new Map(), key, length: 0 });
        continue;
      }
      at += 1;
      value = dict;
    } else if (code === QUOTE) value = readString();
    else if (code === 0x2d || (code >= 0x30 && code <= 0x39)) value = readNumber();
    else if (literal("true")) value = true;
    else if (literal("false")) value = false;
    else if (literal("null")) value = null;
    if (value === undefined) return undefined;

    // The value goes into the array or object it belongs to, which it may complete, and so on outwards.
    for (;;) {
      const container = open.at(-1);
      if (container === undefined) {
        skipWhitespace();
        if (at !== text.length) return undefined;
        if (tooLong !== undefined)
          throw collectionTooLong(
            "list" in tooLong ? "list" : "dict",
            "fromJson(...)",
            span,
            tooLong.length,
          );
        return value;
      }
      if ("list" in container) {
        container.length += 1;
        if (container.length <= MAX_COLLECTION_LENGTH) container.list.items.push(value);
      } else {
        const position = container.positions.get(container.key);
        if (position === undefined) {
          container.positions.set(container.key, container.length);
          container.length += 1;
          if (container.length <= MAX_COLLECTION_LENGTH)
            container.dict.entries.push({ key: container.key, value });
        } else if (position < MAX_COLLECTION_LENGTH)
          container.dict.entries[position]!.value = value;
      }
      skipWhitespace();
      const next = text.charCodeAt(at);
      at += 1;
      if (next === COMMA) {
        if ("dict" in container) {
          const key = readKey();
          if (key === undefined) return undefined;
          container.key = key;
        }
        break;
      }
      if (next !== ("list" in container ? CLOSE_BRACKET : CLOSE_BRACE)) return undefined;
      open.pop();
      if (container.length > MAX_COLLECTION_LENGTH) tooLong ??= container;
      value = "list" in container ? container.list : container.dict;
    }
  }
}

/** Base64 works on text of one byte per character, which this many bytes at a time are made into. */
const BYTE_CHUNK = 8_192;
const utf8Encoder = new TextEncoder();
// Invalid UTF-8 is not text, and a leading byte order mark stays part of the text.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `text` in UTF-8, as standard Base64 with padding and without line breaks; `TSR084` when that is too long. */
export function base64Text(text: string, span: SourceSpan): string {
  const bytes = utf8Encoder.encode(text);
  checkTextLength(Math.ceil(bytes.length / 3) * 4, "toBase64(...)", span);
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += BYTE_CHUNK)
    parts.push(String.fromCharCode(...bytes.subarray(start, start + BYTE_CHUNK)));
  return btoa(parts.join(""));
}

/**
 * The UTF-8 text that Base64 `text` holds, or `undefined` when it is not Base64 or its bytes are not UTF-8. Spaces and
 * line breaks are ignored, the URL alphabet (`-` and `_`) is read like the standard one, and padding may be missing.
 */
export function textFromBase64(text: string): string | undefined {
  const binary = binaryFromBase64(text);
  if (binary === undefined) return undefined;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function fault(code: RuntimeErrorCode, message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault(code, message, copySpan(span));
}
