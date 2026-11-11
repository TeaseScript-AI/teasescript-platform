// What a program publishes, exactly: its answers' JSON text, its route, and the publication whole, in parts or hashed.
import { createHash } from "node:crypto";
import { compileProjectWithBackend } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { analyseCore } from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { type CoreAnalysisRequest, CoreProgram } from "../../src/type-inference/core/program.js";
import type { PlaceId } from "../../src/type-inference/graph.js";
import { coreRequest, type SourceFile } from "./type-core-analysis.js";
import { inMode, type Mode } from "./type-core-oracles-modes.js";
import {
  answeredOccurrences,
  AnswersStopped,
  occurrences,
  publishedAnswers,
  Questions,
  type UnansweredBy,
} from "./type-core-oracles-answers.js";

/** An array or an object `jsonText` walks: an array by index to its length on entry, an object by its own keys. */
type Walked =
  | { readonly array: readonly unknown[]; readonly length: number; next: number; written: number }
  | {
      readonly object: Readonly<Record<string, unknown>>;
      readonly keys: Iterator<string>;
      written: number;
    };

/** The tags of the objects outside `jsonText`'s data, a primitive's wrapper (`Object(1)`), which no plan holds. */
const WRAPPERS = new Set([
  "[object Number]",
  "[object String]",
  "[object Boolean]",
  "[object BigInt]",
]);

/**
 * How `JSON.stringify` writes `value` as the member `key`: its text, no text (`null`: an object leaves the member out,
 * an array writes `null`), or a walk of its members. A BigInt throws, as `JSON.stringify` does without a
 * `BigInt.prototype.toJSON`; a primitive's wrapper or a raw JSON value throws, outside the data `jsonText` writes.
 */
function writing(value: unknown, key: string): { readonly text: string } | Walked | null {
  let current = value;
  // (`toJSON` first, read and called as `JSON.stringify` reads and calls it, on an object or a function)
  if ((typeof current === "object" && current !== null) || typeof current === "function") {
    // EVIDENCE: invariant: any object's property may be read, and `toJSON` is called only where it is a function.
    const toJSON = (current as { readonly toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") current = Function.prototype.call.call(toJSON, current, key);
  }
  if (current === null) return { text: "null" };
  switch (typeof current) {
    case "boolean":
      return { text: String(current) };
    case "string":
      return { text: JSON.stringify(current) };
    case "number":
      return { text: Number.isFinite(current) ? String(current) : "null" };
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "object": {
      if (Array.isArray(current))
        return { array: current, length: current.length, next: 0, written: 0 };
      if (WRAPPERS.has(Object.prototype.toString.call(current)))
        throw new TypeError("jsonText writes plan data, not a primitive's wrapper object.");
      if ("isRawJSON" in JSON && typeof JSON.isRawJSON === "function" && JSON.isRawJSON(current))
        throw new TypeError("jsonText writes plan data, not a raw JSON value.");
      // EVIDENCE: invariant: JSON.stringify reads a non-array object by its own enumerable string keys, as this does.
      const object = current as Readonly<Record<string, unknown>>;
      return { object, keys: Object.keys(object)[Symbol.iterator](), written: 0 };
    }
    default:
      return null;
  }
}

/**
 * `JSON.stringify(value)` without its recursion, for the data a plan and its diagnostics hold: objects of any class
 * (their own enumerable string keys, and their `toJSON`), arrays, strings, numbers, booleans and `null`, a member
 * without text (`undefined`, a function, a symbol) left out of an object or `null` in an array. The same text, with an
 * explicit stack, so a plan nested deeper than its recursion reaches (a 4,096-wide fan-out's, #1503) still has one; a
 * cycle or a BigInt throws as it does, and a primitive's wrapper (known by its tag) or a raw JSON value, which no plan
 * holds, throws.
 *
 * @public (the desktop corpus's kits read it from a built tree, not by an import)
 */
export function jsonText(value: unknown): string | undefined {
  const top = writing(value, "");
  if (top === null) return undefined;
  if ("text" in top) return top.text;
  const text: string[] = [];
  const open = new Set<unknown>();
  const stack: Walked[] = [];
  const enter = (walked: Walked): void => {
    const container = "array" in walked ? walked.array : walked.object;
    if (open.has(container)) throw new TypeError("Converting circular structure to JSON");
    open.add(container);
    text.push("array" in walked ? "[" : "{");
    stack.push(walked);
  };
  enter(top);
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    let key: string;
    let member: unknown;
    if ("array" in frame) {
      if (frame.next === frame.length) {
        text.push("]");
        open.delete(frame.array);
        stack.pop();
        continue;
      }
      key = String(frame.next);
      member = frame.array[frame.next];
      frame.next += 1;
    } else {
      const next = frame.keys.next();
      if (next.done === true) {
        text.push("}");
        open.delete(frame.object);
        stack.pop();
        continue;
      }
      key = next.value;
      member = frame.object[key];
    }
    const own = writing(member, key);
    // (an object leaves out a member without text, an array writes `null` for it)
    if (own === null && !("array" in frame)) continue;
    if (frame.written > 0) text.push(",");
    frame.written += 1;
    if (!("array" in frame)) text.push(JSON.stringify(key), ":");
    if (own === null) text.push("null");
    else if ("text" in own) text.push(own.text);
    else enter(own);
  }
  return text.join("");
}

/** The candidate route's part: its plan and diagnostics of `files`, or the construct it rejects them at (`text`). */
export function publishedRoute(
  files: readonly SourceFile[],
  globals: readonly string[],
): { readonly plan: InstructionPlan | null | "outside"; readonly text: string } {
  try {
    const { plan, diagnostics } = compileProjectWithBackend(files, { globals }, CORE_BACKEND);
    // (a plan may nest deeper than `JSON.stringify` can follow: `jsonText`)
    const text = jsonText({ plan, diagnostics });
    if (text === undefined) throw new Error("A route's plan and diagnostics have no JSON text.");
    return { plan, text };
  } catch (error) {
    if (!(error instanceof CandidateOutsideSlice)) throw error;
    return { plan: "outside", text: JSON.stringify({ outside: error.what }) };
  }
}

/** A publication's parts (`publicationParts`), each the JSON text of its element of the whole, in the whole's order. */
export interface PublicationParts {
  /** `publishedAnswers`'s text and record; `null`'s text where its own questions stopped. */
  readonly answers: string;
  readonly record: string;
  /** Every occurrence's answer, one part each, in their order, up to the oracle's own stop (`unanswered`). */
  readonly occurrences: readonly string[];
  /** The candidate route's plan or rejection. */
  readonly route: string;
  /**
   * What the oracle's own questions left unanswered (`Questions`), apart from the parts: the nodes from the first left,
   * after the bindings left where the answers' questions stopped; 0 when it answered all. How the families runner
   * compares a publication with any: `tests/families/README.md`.
   */
  readonly unanswered: number;
  /** Why, where `unanswered` is not 0 (`answeredOccurrences`, `publishedAnswers`). */
  readonly unansweredBy?: UnansweredBy;
}

/**
 * A publication's elements as JSON texts, each occurrence's text mapped by `each` as it is made, so that a caller who
 * keeps less than the text never holds them all. The backend's questions to the finished analysis spend its allowance
 * and stop there (`asked`), as the backend's do; the oracle's own, the admitted types' and the occurrences', run apart
 * and end at their own stop (`Questions`). `null` when the files do not parse or resolve.
 */
function publishedElements<Occurrence>(
  files: readonly SourceFile[],
  mode: Mode,
  globals: readonly string[],
  each: (text: string) => Occurrence,
): {
  readonly answers: string;
  readonly record: string;
  readonly occurrences: readonly Occurrence[];
  readonly route: string;
  readonly unanswered: number;
  readonly unansweredBy?: UnansweredBy;
} | null {
  const request = coreRequest(files, globals);
  if (request === null) return null;
  const bindings = new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => place.id);
  return inMode(mode, () => {
    // (the analysis's parts first, its answers dropped when they end; then the route's compile, so that the oracle never
    // holds both analyses' answers: with sharing off each can take a gigabyte, #1603)
    const analysed = analysedElements(request, bindings, each);
    const route = JSON.stringify(publishedRoute(files, globals).text);
    return { ...analysed, route };
  });
}

/**
 * `publishedElements`' parts of the analysis of `request`: its answers and record (`publishedAnswers`) and every
 * occurrence's answer up to the oracle's own stop, its answers held only while they are asked.
 */
function analysedElements<Occurrence>(
  request: CoreAnalysisRequest,
  bindings: readonly PlaceId[],
  each: (text: string) => Occurrence,
): {
  readonly answers: string;
  readonly record: string;
  readonly occurrences: readonly Occurrence[];
  readonly unanswered: number;
  readonly unansweredBy?: UnansweredBy;
} {
  // (one meter for the publication's own questions, reported from before its analysis: `questionWork`)
  const questions = new Questions();
  const answers = analyseCore(request);
  let published: ReturnType<typeof publishedAnswers>;
  try {
    published = publishedAnswers(answers, bindings, request, questions);
  } catch (error) {
    if (!(error instanceof AnswersStopped)) throw error;
    // (its answers' questions stopped: no answers nor record, and every node unanswered after the bindings left)
    return {
      answers: "null",
      record: "null",
      occurrences: [],
      unanswered: error.left + answers.graph.nodes.length,
      unansweredBy: error.by,
    };
  }
  const { occurrences, unanswered, unansweredBy } = answeredOccurrences(answers, questions, each);
  return {
    answers: JSON.stringify(published.text),
    record: JSON.stringify(published.record),
    occurrences,
    unanswered,
    ...(unansweredBy === undefined ? {} : { unansweredBy }),
  };
}

/**
 * What `files` publish in `mode`, part by part (`publication` joins them): a publication too large for one string is
 * still had, each part on its own (#1503). `null` when the files do not parse or resolve.
 */
export function publicationParts(
  files: readonly SourceFile[],
  mode: Mode,
  globals: readonly string[],
): PublicationParts | null {
  return publishedElements(files, mode, globals, (text) => text);
}

/** A text's sha256, in hexadecimal. */
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A publication's parts by their hashes (`publicationHashes`), with the nodes its oracle left unanswered apart. */
export interface PublicationHashes {
  readonly parts: readonly string[];
  /** `PublicationParts`'s `unanswered` and `unansweredBy`. */
  readonly unanswered: number;
  readonly unansweredBy?: UnansweredBy;
}

/**
 * What `files` publish in `mode` (`publicationParts`), each part by its sha256 in the whole's order, an occurrence's
 * hashed as it is made: no more than one occurrence's text is held, so a publication of any size is compared part by
 * part (#1503). `null` when the files do not parse or resolve.
 *
 * @public (the generator corpus's runner reads it from a built tree, not by an import)
 */
export function publicationHashes(
  files: readonly SourceFile[],
  mode: Mode,
  globals: readonly string[],
): PublicationHashes | null {
  const elements = publishedElements(files, mode, globals, sha256);
  return elements === null
    ? null
    : {
        parts: [
          sha256(elements.answers),
          sha256(elements.record),
          ...elements.occurrences,
          sha256(elements.route),
        ],
        unanswered: elements.unanswered,
        ...(elements.unansweredBy === undefined ? {} : { unansweredBy: elements.unansweredBy }),
      };
}

/**
 * What `files` publish in `mode`, exactly (the G3 and #1405 evidence's publication): the answers (`publishedAnswers`'s
 * text and record), every occurrence's answer in its order, and the candidate route's plan or rejection, as one JSON
 * array (`publicationParts` joined), with a fifth element `{"unanswered": <count>}` where the oracle's own questions
 * stopped (`Questions`), so that text never equals a publication answered in full; `null` when the files do
 * not parse or resolve.
 *
 * @public (the generator corpus's runner reads it from a built tree, not by an import)
 */
export function publication(
  files: readonly SourceFile[],
  mode: Mode,
  globals: readonly string[],
): string | null {
  const parts = publicationParts(files, mode, globals);
  if (parts === null) return null;
  const unanswered = parts.unanswered === 0 ? "" : `,{"unanswered":${parts.unanswered}}`;
  return `[${parts.answers},${parts.record},[${parts.occurrences.join(",")}],${parts.route}${unanswered}]`;
}
