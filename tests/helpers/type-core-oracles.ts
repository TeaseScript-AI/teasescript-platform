import { createHash } from "node:crypto";

import { compileProjectWithBackend } from "../../src/compiler.js";
import { keyIdPath } from "../../src/type-inference/core/contract/key-ids.js";
import { stepsOf } from "../../src/type-inference/core/contract/literal-index.js";
import type { Diagnostic } from "../../src/diagnostics.js";
import type { InstructionPlan, PartCheckPlan, PartStep, TypePlan } from "../../src/plan/model.js";
import { Admission } from "../../src/type-inference/core/admission.js";
import {
  type AdmittedType,
  analyseCore,
  type Answers,
  type CorePass,
  coreResult,
  type DecisionWork,
} from "../../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { BudgetExhausted, withTestDemandAllowance } from "../../src/type-inference/core/budget.js";
import { asked, checkedResult } from "../../src/type-inference/core/consumer.js";
import { Consumers, withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import type { FlowNode } from "../../src/type-inference/core/flow-graph.js";
import {
  ingressLeaves,
  type Item,
  itemsSignature,
  spellingIdentity,
  writerKey,
} from "../../src/type-inference/core/items.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import {
  type CoreAnalysisRequest,
  CoreProgram,
  propertyStep,
} from "../../src/type-inference/core/program.js";
import {
  type CheckedDiagnostic,
  type CoreDiagnostic,
  coreRecord,
} from "../../src/type-inference/core/result.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";
import type { PlaceId } from "../../src/type-inference/graph.js";
import { planSiteKey } from "./site-keys.js";
import { coreRequest, type SourceFile } from "./type-core-analysis.js";
import { itemScope } from "./type-core-items.js";

/*
 * The type core's oracles, one library for the tests and for the generator corpus (`tests/families/`): the
 * diagnostics' identity a stop keeps (`stopIdentity`, `keptErrors`) and the merged stops' (`mergedIdentity`); what a
 * program publishes, exactly (`publishedAnswers`, `publishedRoute`, `publication`) and with two orders set aside
 * (`publishedUpToOrder`, TABLE r4.185); the four modes they are compared in (`MODES`, `inMode`); which decisions
 * stop and when (`stopSet`); a compile's decision records, its receiving completion's included (`decisionRecords`); and a
 * stopped plan's part checks against the natural plan's (`partProblems`, #1682). A test or generator that needs another
 * projection adds it here.
 */

/**
 * A diagnostic as a stop must keep it, its identity: without the facts its fix's code forms read (`expects`,
 * `present`), which a stop never proves, so a fix there may be words (TABLE r4.162). The stop tests compare these.
 */
export function stopIdentity(
  diagnostic: CoreDiagnostic | CheckedDiagnostic,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(diagnostic).filter(([key]) => key !== "expects" && key !== "present"),
  );
}

/** A message's sentences, split where a sentence ends and the next starts with a capital or a quote. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.?])\s+(?=[A-Z'"])/);
}

/**
 * The errors of `source`'s analysis as a stop keeps them: each error's identity and its message's first sentence. A
 * stop proves nothing of a fix's code, so the fix after that sentence may be words (TABLE r4.162).
 */
export function keptErrors(
  answers: Answers,
  source: string,
): readonly Readonly<Record<string, unknown>>[] {
  const text = messageSource([source], answers.diagnostics);
  return answers.diagnostics
    .filter((d) => d.class === "compile-error")
    .map((d) => ({ ...stopIdentity(d), message: sentences(coreMessage(d, text))[0] }));
}

/**
 * The record with the route as the merged stops pin it (TABLE r4.185): each diagnostic by its identity
 * (`stopIdentity`) without the other facts only its fix reads, the kinds its site's other diagnostics report
 * (`besides`) and its store root's declaration, and each of the route's (`publishedRoute`'s text) by its severity, code
 * and span, without its message.
 */
export function mergedIdentity(answers: Answers, route: string): string {
  const identity = (diagnostic: CoreDiagnostic): Readonly<Record<string, unknown>> => {
    const { besides: _, ...kept } = stopIdentity(diagnostic);
    return "rule" in diagnostic && diagnostic.rule.rule === "store" && diagnostic.rule.root !== null
      ? {
          ...kept,
          rule: {
            ...diagnostic.rule,
            root: { kind: diagnostic.rule.root.kind, name: diagnostic.rule.root.name },
          },
        }
      : kept;
  };
  // EVIDENCE: invariant: `publishedRoute` writes a plan with the compiler's diagnostics, or the construct it rejects.
  const routed = JSON.parse(route) as { readonly diagnostics?: readonly Diagnostic[] };
  return JSON.stringify({
    outcome: answers.outcome,
    diagnostics: answers.diagnostics.map(identity),
    checks: answers.checks,
    serialized: coreRecord(coreResult(answers), ["main.tease"]),
    route:
      routed.diagnostics === undefined
        ? routed
        : {
            ...routed,
            diagnostics: routed.diagnostics.map(({ severity, code, span }) => ({
              severity,
              code,
              span,
            })),
          },
  });
}

/** One of the four modes an analysis is compared in: the consumers' and the worklist's order, and the sharing. */
export interface Mode {
  readonly reversed: boolean;
  readonly unshared: boolean;
}

/** The four modes: source order and reversed, each with the sharing on and off. */
export const MODES: readonly Mode[] = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);

/** `run` in the consumers' and the solver's worklist's reversed order, or as it is. */
export function inOrder<T>(reversed: boolean, run: () => T): T {
  return reversed
    ? withConsumerOrder(
        (list) => [...list].reverse(),
        () => withSolverSeam({ reverseWorklist: true }, run),
      )
    : run();
}

/** `run` in `mode`. */
export function inMode<T>(mode: Mode, run: () => T): T {
  const ordered = (): T => inOrder(mode.reversed, run);
  return mode.unshared ? withoutSharing(ordered) : ordered();
}

/** Two sites as (file index, start, end), in source order. */
function compareSites(a: readonly number[], b: readonly number[]): number {
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

/**
 * One analysis's part: its answers (the outcome and diagnostics with the checks that owe the runtime nothing,
 * `checkedResult`, and the checks) and every binding's admitted types at its root and its element (`text`); the record
 * alone, its answers and the same serialized (`record`); and whether each of its lists is in source order of its sites
 * (r4.86 (1)).
 */
export function publishedAnswers(
  answers: Answers,
  bindings: readonly PlaceId[],
  request: CoreAnalysisRequest,
): { readonly text: string; readonly record: string; readonly sited: boolean } {
  // (every question past the finished analysis's allowance stops there, as the backend's do: `asked`)
  return asked(answers, (answers) => {
    const admitted = bindings.map((place) => [
      place,
      answers.place(place, []).admitted,
      answers.place(place, ["element"]).admitted,
    ]);
    // (with the checks that owe the runtime nothing, as the compiler reads them)
    const checked = checkedResult(answers, request);
    const paths = request.files.map((file) => file.path);
    const record = {
      outcome: checked.outcome,
      diagnostics: checked.diagnostics,
      checks: answers.checks,
    };
    const serialized = coreRecord(checked, paths);
    const sitesOf = (
      list: readonly {
        readonly site: { readonly file: number; readonly start: number; readonly end: number };
      }[],
    ) => list.map(({ site }) => [site.file, site.start, site.end]);
    const recordSites = (
      list: readonly {
        readonly site: { readonly file: string; readonly offset: number; readonly end: number };
      }[],
    ) => list.map(({ site }) => [paths.indexOf(site.file), site.offset, site.end]);
    const sited = [
      sitesOf(checked.diagnostics),
      sitesOf(answers.checks),
      recordSites(serialized.diagnostics),
      recordSites(serialized.runtimeChecks),
    ].every((sites) =>
      sites.every((site, index) => index === 0 || compareSites(sites[index - 1]!, site) <= 0),
    );
    return {
      text: JSON.stringify({ ...record, admitted }),
      record: JSON.stringify({ record, serialized }),
      sited,
    };
  });
}

/** An item with all its marks, writer, context and ingress leaves. */
export function itemText(item: Item): string {
  return [
    item.tag,
    item.cert,
    item.reasons,
    item.writer === null ? "" : writerKey(item.writer),
    item.context ?? "",
    item.word ?? "",
    `${item.guarded === true ? "g" : ""}${item.called === true ? "c" : ""}${item.loose === true ? "l" : ""}${item.extOnly === true ? "e" : ""}`,
    item.fan ?? "",
    item.ingress === undefined ? "" : ingressLeaves(item.ingress).map(writerKey).join("+"),
  ].join("|");
}

/**
 * `node`'s occurrence answer (each item by `itemText`, as `items` lists them), route, place and obligations, with its
 * element's and its properties' answers where it holds a collection or an object; `null` where it is no occurrence.
 */
function occurrenceAnswer(
  answers: Answers,
  node: FlowNode,
  items: (list: readonly Item[]) => string[],
): unknown[] | null {
  const at = answers.at(node);
  if (at === null) return null;
  const tags = new Set(at.items.map((item) => item.tag));
  return [
    node.id,
    at.route,
    at.place,
    items(at.items),
    at.obligations,
    tags.has("list") || tags.has("set") || tags.has("dict")
      ? items(answers.project(node, "element"))
      : null,
    tags.has("object")
      ? [...answers.properties(node)].map(([name, answer]) => [name, items(answer)])
      : null,
  ];
}

/** Every occurrence's answer (`occurrenceAnswer`, its items in `order`): one at a time, as asked. */
function* occurrenceAnswers(
  answers: Answers,
  order: (items: string[]) => string[],
): Generator<unknown> {
  const items = (list: readonly Item[]): string[] => order(list.map(itemText));
  for (const node of answers.graph.nodes) {
    const answer = occurrenceAnswer(answers, node, items);
    if (answer !== null) yield answer;
  }
}

/**
 * Why a publication's oracle left nodes unanswered (`answeredOccurrences`), and the first node it left: the families
 * runner counts each reason apart (`tests/families/README.md`); a reason a tree's oracle does not give is `unknown` there.
 */
export interface UnansweredBy {
  readonly reason: "questions" | "stopped";
  readonly node: number;
}

/**
 * Every occurrence's answer (`occurrenceAnswer`, its items in their order), each mapped by `each` as it is made, up to
 * the node whose questions pass the analysis's allowance after it finished: the oracle's own stop (#1499 charges its
 * property-name walk), not the analysis's. That node and every one after it stay unanswered (`unanswered`, their
 * count), never asked again on the stopped answers, whose `unknown` answers would agree wherever both trees stop alike.
 * Why (`unansweredBy`): `questions` where the analysis had finished and its later questions exhausted the allowance,
 * `stopped` where the analysis's own budget had stopped it (`budget.exhausted`), each with the first node unanswered.
 */
function answeredOccurrences<Occurrence>(
  answers: Answers,
  each: (text: string) => Occurrence,
): {
  readonly occurrences: readonly Occurrence[];
  readonly unanswered: number;
  readonly unansweredBy?: UnansweredBy;
} {
  const nodes = answers.graph.nodes;
  const items = (list: readonly Item[]): string[] => list.map(itemText);
  const occurrences: Occurrence[] = [];
  for (const [index, node] of nodes.entries()) {
    let answer: unknown[] | null;
    try {
      answer = occurrenceAnswer(answers, node, items);
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      const reason = answers.budget.exhausted === null ? "questions" : "stopped";
      return {
        occurrences,
        unanswered: nodes.length - index,
        unansweredBy: { reason, node: node.id },
      };
    }
    if (answer !== null) occurrences.push(each(JSON.stringify(answer)));
  }
  return { occurrences, unanswered: 0 };
}

/** Every occurrence's answer (`occurrenceAnswers`), all of them. */
export function occurrences(answers: Answers, order: (items: string[]) => string[]): unknown[] {
  return [...occurrenceAnswers(answers, order)];
}

/**
 * What a program publishes with two orders set aside (TABLE r4.185, G5's stops whose own entries merge into one): the
 * order of the items in an answer and of the kinds in a decided admitted type. Every binding's admitted type and decider
 * site at its root, its element and each known property two levels down; every occurrence's answer (`occurrences`, its
 * items sorted). Its questions spend the analysis's allowance and stop there (`asked`).
 */
export function publishedUpToOrder(answers: Answers, bindings: readonly PlaceId[]): string {
  return asked(answers, (answers) => upToOrder(answers, bindings));
}

function upToOrder(answers: Answers, bindings: readonly PlaceId[]): string {
  const admitted = (place: PlaceId, path: readonly string[]): AdmittedType => {
    const type = answers.place(place, path).admitted;
    return type.by === "decided"
      ? {
          by: type.by,
          kinds: [...type.kinds].sort(),
          decider: type.decider,
          inherited: type.inherited,
        }
      : type;
  };
  const places = bindings.map((place) => {
    const below: [string, AdmittedType][] = [];
    for (const first of [...answers.placeProperties(place, [])].sort()) {
      const one = [propertyStep(first)];
      below.push([first, admitted(place, one)]);
      for (const second of [...answers.placeProperties(place, one)].sort())
        below.push([`${first}.${second}`, admitted(place, [...one, propertyStep(second)])]);
    }
    return [place, admitted(place, []), admitted(place, ["element"]), below];
  });
  return JSON.stringify({ places, occurrences: occurrences(answers, (items) => items.sort()) });
}

/**
 * #1610's identity, the order of property names being author-facing (an absent property's message lists them as the
 * search finds them, `toJson` walks them so): each binding's property names two levels down in that order, the bindings
 * in the order given, and every diagnostic's message. Its questions spend the analysis's allowance and stop there
 * (`asked`).
 */
export function orderedNames(
  answers: Answers,
  request: CoreAnalysisRequest,
  bindings: readonly PlaceId[],
): string {
  return asked(answers, (answers) => {
    const text = messageSource(
      request.files.map((file) => file.source),
      answers.diagnostics,
    );
    return JSON.stringify({
      places: bindings.map((place) => {
        const first = [...answers.placeProperties(place, [])];
        return [
          place,
          first,
          first.map((name) => [...answers.placeProperties(place, [propertyStep(name)])]),
        ];
      }),
      messages: answers.diagnostics.map((diagnostic) => coreMessage(diagnostic, text)),
    });
  });
}

/**
 * A program's outcome, diagnostics and checks, and every expression occurrence's answer (its offset, route, place,
 * obligations and items whole, each with its ingress leaves), in their order. Its questions spend the analysis's
 * allowance and stop there (`asked`).
 */
export function everyAnswer(answers: Answers): string {
  return asked(answers, allAnswers);
}

function allAnswers(answers: Answers): string {
  const occurrences = answers.graph.nodes.flatMap((node) => {
    const at = node.kind === "expression" ? answers.at(node) : null;
    if (at === null) return [];
    const items = at.items.map((item) => ({
      ...item,
      ingress: item.ingress === undefined ? [] : ingressLeaves(item.ingress).map(writerKey),
    }));
    return [[node.span?.start.offset, at.route, at.place, at.obligations, items]];
  });
  const { outcome, diagnostics, checks } = answers;
  return JSON.stringify({ outcome, diagnostics, checks, occurrences });
}

/**
 * Every occurrence's items with their writers and their ingress leaves sorted (#1196: each ingress names its own leaf,
 * whatever order the leaves are found in), one line per node. Its questions spend the analysis's allowance and stop
 * there (`asked`).
 */
export function ingressAnswers(answers: Answers): string {
  return asked(answers, ingressLines);
}

function ingressLines(answers: Answers): string {
  const itemText = ({ ingress, writer, ...rest }: Item): string =>
    JSON.stringify({
      ...rest,
      writer: writer === null ? null : writerKey(writer),
      leaves: ingress === undefined ? [] : ingressLeaves(ingress).map(writerKey).sort(),
    });
  return answers.graph.nodes
    .flatMap((node) => {
      const answer = answers.at(node);
      return answer === null ? [] : [`${node.id} ${answer.items.map(itemText).join(" ")}`];
    })
    .join("\n");
}

/**
 * An answer's items in their order, each with every field it carries, its writer and its ingress leaves by their keys:
 * where an answer's order, certainty, reasons, context and writers all count (#1384: a publication's hashes sort some
 * answers' items).
 */
export function orderedItems(items: readonly Item[]): string[] {
  return items.map((item) =>
    JSON.stringify({
      ...item,
      writer: item.writer === null ? null : writerKey(item.writer),
      ingress: item.ingress === undefined ? undefined : ingressLeaves(item.ingress).map(writerKey),
    }),
  );
}

/** An answer as a replay compares it: its items' signature, their order aside, and their ingress stores. */
export function replayAnswer(items: readonly Item[]): string {
  const stores = items.map((item) =>
    item.ingress === undefined ? "" : ingressLeaves(item.ingress).map(writerKey).join(","),
  );
  return `${itemsSignature(items, itemScope())} ${stores.sort().join(";")}`;
}

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
  /** `publishedAnswers`'s text and record. */
  readonly answers: string;
  readonly record: string;
  /** Every occurrence's answer, one part each, in their order, up to the oracle's own stop (`unanswered`). */
  readonly occurrences: readonly string[];
  /** The candidate route's plan or rejection. */
  readonly route: string;
  /**
   * The nodes the oracle's own questions left unanswered (`answeredOccurrences`), apart from the parts: 0 when it
   * answered all. How the families runner compares a publication with any: `tests/families/README.md`.
   */
  readonly unanswered: number;
  /** Why, where `unanswered` is not 0 (`answeredOccurrences`). */
  readonly unansweredBy?: UnansweredBy;
}

/**
 * A publication's elements as JSON texts, each occurrence's text mapped by `each` as it is made, so that a caller who
 * keeps less than the text never holds them all. The answers' questions to the finished analysis spend its allowance and
 * stop there (`asked`), as the backend's do; the occurrences' questions end at the oracle's own stop
 * (`answeredOccurrences`). `null` when the files do not parse or resolve.
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
    const answers = analyseCore(request);
    const published = publishedAnswers(answers, bindings, request);
    const route = publishedRoute(files, globals);
    const { occurrences, unanswered, unansweredBy } = answeredOccurrences(answers, each);
    return {
      answers: JSON.stringify(published.text),
      record: JSON.stringify(published.record),
      occurrences,
      route: JSON.stringify(route.text),
      unanswered,
      ...(unansweredBy === undefined ? {} : { unansweredBy }),
    };
  });
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
 * stopped (`answeredOccurrences`), so that text never equals a publication answered in full; `null` when the files do
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

/**
 * #1655: every demand a pass's solver settled, by its key, its answer's items by `itemText` and their spelling: what each raw read answers,
 * where a publication shows only what the checks and the occurrences take of it.
 */
export function settledAnswers(pass: CorePass): Map<string, string> {
  const answers = new Map<string, string>();
  for (const { key } of pass.solver.demandWork())
    answers.set(
      key,
      (pass.solver.answer(key) ?? [])
        .map((item) => `${itemText(item)}|${spellingIdentity(item.spelling)}`)
        .join(" "),
    );
  return answers;
}

/** Which admission decisions an analysis stops, and when; its restarts and how it ended. */
export interface StopSet {
  /** Each decision stop: the pass (from 1), the place's label, the key's path and the decision's ordinal in its pass. */
  readonly stops: readonly (readonly [number, string, string, number])[];
  readonly passes: number;
  readonly restarts: number;
  readonly outcome: Answers["outcome"];
  readonly exhausted: Answers["budget"]["exhausted"];
  /** What it publishes at that allowance (`stoppedRecord`). */
  readonly record: string;
}

/**
 * What an analysis publishes at a stop, as the stop-set comparison compares it at every allowance: each diagnostic by
 * its identity (`stopIdentity`: its code, site, rule and offending kinds, without the fix facts a stop never proves),
 * the checks, and both serialized.
 */
export function stoppedRecord(answers: Answers, paths: readonly string[]): string {
  return JSON.stringify({
    diagnostics: answers.diagnostics.map(stopIdentity),
    checks: answers.checks,
    serialized: coreRecord(coreResult(answers), paths),
  });
}

/**
 * Which decisions stop and when, per source and mode (#1405's stop-set comparison): `files` analysed in `mode` at the
 * test demand `allowance`, or at the natural one (`null`), with each pass's start, decision and decision stop traced,
 * and what it publishes there (`stoppedRecord`); `null` when the files do not parse or resolve. The trace keeps each
 * analysis's events apart by its program and reports this analysis's own, so an analysis run inside one of its
 * callbacks changes nothing.
 *
 * @public (the generator corpus's runner reads it from a built tree, not by an import)
 */
export function stopSet(
  files: readonly SourceFile[],
  mode: Mode,
  globals: readonly string[],
  allowance: number | null,
): StopSet | null {
  const request = coreRequest(files, globals);
  if (request === null) return null;
  type Trace = { pass: number; decided: number; stops: [number, string, string, number][] };
  const traces = new Map<CorePass["program"]["flow"], Trace>();
  const traceOf = (pass: CorePass): Trace => {
    let trace = traces.get(pass.program.flow);
    if (trace === undefined)
      traces.set(pass.program.flow, (trace = { pass: 0, decided: 0, stops: [] }));
    return trace;
  };
  const [check, decide, stopDecision] = [
    Consumers.prototype.check,
    Admission.prototype.decide,
    Admission.prototype.stopDecision,
  ];
  Consumers.prototype.check = function (this: Consumers) {
    const trace = traceOf(this.pass);
    trace.pass += 1;
    trace.decided = 0;
    check.call(this);
  };
  Admission.prototype.decide = function (
    this: Admission,
    ...args: Parameters<Admission["decide"]>
  ) {
    traceOf(this.pass).decided += 1;
    return decide.apply(this, args);
  };
  Admission.prototype.stopDecision = function (this: Admission, at) {
    const trace = traceOf(this.pass);
    // (a cursor's steps read from the arena uncharged: the observer changes nothing it observes)
    const path = at.key === undefined ? at.path : stepsOf(this.pass.contract, keyIdPath(at.key));
    trace.stops.push([
      trace.pass,
      this.pass.program.places[at.root]!.label,
      path.join("."),
      trace.decided,
    ]);
    stopDecision.call(this, at);
  };
  try {
    const once = (): Answers => analyseCore(request);
    const answers = inMode(mode, () =>
      allowance === null ? once() : withTestDemandAllowance(allowance, once),
    );
    const trace = traces.get(answers.graph) ?? { pass: 0, decided: 0, stops: [] };
    return {
      stops: trace.stops,
      passes: trace.pass,
      restarts: answers.budget.counts.get("stopPasses") ?? 0,
      outcome: answers.outcome,
      exhausted: answers.budget.exhausted,
      record: stoppedRecord(
        answers,
        request.files.map((file) => file.path),
      ),
    };
  } finally {
    Consumers.prototype.check = check;
    Admission.prototype.decide = decide;
    Admission.prototype.stopDecision = stopDecision;
  }
}

/** A compile's admission decision records (`decisionRecords`), each a copy of its `DecisionWork`. */
export interface DecisionRecords {
  /** Each pass's own decisions (`Consumers.decisions`, as its `check` left them), one list per pass, in their order. */
  readonly ordinary: readonly (readonly DecisionWork[])[];
  /**
   * Each receiving completion's decisions (`Consumers.completion.decisions`, once the compile ended), one list per
   * completion that ran: `allowance` what was left of the program's when it decided, `completion.local` its own.
   */
  readonly completion: readonly (readonly DecisionWork[])[];
  /** The route's plan and diagnostics, or the construct it rejects (`publishedRoute`). */
  readonly text: string;
}

/** The kinds of decision record (`DecisionRecords`). */
export type DecisionRecordKind = "ordinary" | "completion";

/**
 * Throws unless `runs` together hold a record of each of `kinds`: a probe that reads a property the records are not
 * under, or a route that never reaches a completion, then fails instead of comparing empty lists.
 *
 * @public (a probe over many compiles reads it from a built tree, not by an import)
 */
export function requireRecords(
  runs: Iterable<DecisionRecords>,
  kinds: readonly DecisionRecordKind[],
): void {
  const read = new Set<DecisionRecordKind>();
  for (const run of runs)
    for (const kind of kinds) if (run[kind].some((list) => list.length > 0)) read.add(kind);
  const missing = kinds.filter((kind) => !read.has(kind));
  if (missing.length > 0) throw new Error(`No ${missing.join(" or ")} decision record was read.`);
}

/** Whether a `decisionRecords` compile is running: one inside it would record into both (Codex r1's H1 on #1692). */
let recordingDecisions = false;

/**
 * A decision record's key: its place (project-wide, so its file too) and its exact path, step by step. Units, allowance
 * and stop are a record's values, not its key; the mode and the demand allowance are its compile's.
 */
export function decisionKey(decision: Pick<DecisionWork, "place" | "path">): string {
  return JSON.stringify([decision.place, decision.path]);
}

/**
 * One list's records by their keys (`decisionKey`), each key's records in the list's order: a list can hold one place's
 * decision at one path more than once (#1757), so a record is identified by its key and its occurrence there, never
 * overwritten by a later one.
 */
export function decisionsByKey(decisions: readonly DecisionWork[]): Map<string, DecisionWork[]> {
  const keyed = new Map<string, DecisionWork[]>();
  for (const d of decisions) {
    const key = decisionKey(d);
    keyed.set(key, [...(keyed.get(key) ?? []), d]);
  }
  return keyed;
}

/**
 * The one record of `decisions` (one pass's list, or one completion's) at `place` and exactly `path`: a probe that
 * takes the first record of a place, or a path by its joined text, can read another than it means. Throws where the
 * list holds none or several.
 */
export function decisionOf(
  decisions: readonly DecisionWork[],
  at: Pick<DecisionWork, "place" | "path">,
): DecisionWork {
  const key = decisionKey(at);
  const found = decisions.filter((d) => decisionKey(d) === key);
  if (found.length !== 1)
    throw new Error(
      `${found.length === 0 ? "No" : found.length} decision records at ${key}; the list has ${decisions.map(decisionKey).join(", ") || "none"}.`,
    );
  return found[0]!;
}

/**
 * The decision records of `files` compiled through the public route (`publishedRoute`: `compileProjectWithBackend` with
 * the core backend, its receiving completion included, which `analyseCore` alone never runs), in `mode` (the source
 * order with the sharing on by default) at the test demand allowance `demand` (`null`, the default: the natural one).
 * Read where the compiler leaves them, from every pass's walk and every completion, not from one `Answers`. With
 * `require`, the compile must read a record of each kind given (`requireRecords`). Not reentrant: a call while one runs
 * throws, since its walks would be the outer compile's too. The way a probe reads decision records
 * (`tests/families/README.md`).
 *
 * @public (a probe reads it from a built tree, not by an import)
 */
export function decisionRecords(
  files: readonly SourceFile[],
  globals: readonly string[],
  options: {
    readonly mode?: Mode;
    readonly demand?: number | null;
    readonly require?: readonly DecisionRecordKind[];
  } = {},
): DecisionRecords {
  const { mode = MODES[0]!, demand = null, require = [] } = options;
  if (recordingDecisions) throw new Error("decisionRecords is already recording a compile.");
  const copy = (list: readonly DecisionWork[]): DecisionWork[] =>
    list.map((d) => ({ ...d, path: [...d.path] }));
  const ordinary: DecisionWork[][] = [];
  // (each pass's walk: a receiving completion runs on the walk of the pass that settled, `Answers.completed`)
  const walks: Consumers[] = [];
  const check = Consumers.prototype.check;
  Consumers.prototype.check = function (this: Consumers) {
    walks.push(this);
    // (a pass a stop ends keeps the decisions it made, the stopped one included)
    try {
      check.call(this);
    } finally {
      ordinary.push(copy(this.decisions));
    }
  };
  let text: string;
  recordingDecisions = true;
  try {
    const run = (): string => inMode(mode, () => publishedRoute(files, globals).text);
    text = demand === null ? run() : withTestDemandAllowance(demand, run);
  } finally {
    Consumers.prototype.check = check;
    recordingDecisions = false;
  }
  const completion = walks.flatMap(({ completion }) =>
    completion === null ? [] : [copy(completion.decisions)],
  );
  const records = { ordinary, completion, text };
  requireRecords([records], require);
  return records;
}

/**
 * The type a store's whole check checks at `path` below it, as `reaches` in `consumer.ts` reads it: a property's type
 * where an object lists it, a collection's element type, through a union's members at any depth that can hold the step
 * (one member's type, else their union); `null` where the check reaches nothing there (an object without the property, a collection
 * with open elements, no member that holds the step).
 */
function projectedType(type: TypePlan, path: readonly PartStep[]): TypePlan | null {
  // (a union's members, a nested union's at any depth, as `reaches` walks them)
  const members = (t: TypePlan): TypePlan[] =>
    t.kind === "union" ? t.members.flatMap(members) : [t];
  let at: readonly TypePlan[] = [type];
  for (const step of path) {
    const next: TypePlan[] = [];
    for (const each of at.flatMap(members))
      if ("property" in step) {
        if (each.kind !== "object") continue;
        const found = each.properties.find((property) => property.name === step.property);
        if (found === undefined) return null;
        next.push(found.type);
      } else if (each.kind === "list" || each.kind === "set" || each.kind === "dict") {
        if (each.element === null) return null;
        next.push(each.element);
      }
    if (next.length === 0) return null;
    at = next;
  }
  return at.length === 1 ? at[0]! : { kind: "union", members: at };
}

/**
 * Whether a check against `wide` accepts every value one against `narrow` does (a type plan's own rules: an object checks
 * only the properties it lists, a collection with open elements accepts any, a union any member's values).
 */
function accepts(wide: TypePlan, narrow: TypePlan): boolean {
  if (JSON.stringify(wide) === JSON.stringify(narrow)) return true;
  if (narrow.kind === "union") return narrow.members.every((member) => accepts(wide, member));
  if (wide.kind === "union") return wide.members.some((member) => accepts(member, narrow));
  if (wide.kind !== narrow.kind) return false;
  if (wide.kind === "object" && narrow.kind === "object")
    return wide.properties.every((property) => {
      const other = narrow.properties.find((candidate) => candidate.name === property.name);
      return other !== undefined && accepts(property.type, other.type);
    });
  if ("element" in wide && "element" in narrow)
    return (
      wide.element === null || (narrow.element !== null && accepts(wide.element, narrow.element))
    );
  return false;
}

/**
 * The invariant of a stopped plan's part checks (#1682, the lead's ruling on HEAD 0): each stopped store's parts are a
 * subsequence of the natural store's (path, type and place equal), except a part whose path the natural store's whole
 * check covers with that same projected type (`projectedType`), or one the part accepts all of (the part is then fewer);
 * never a part the natural plan neither has nor covers, never one narrower than what covers it. `problems`: each a line
 * naming the store (`kind@file:so:eo`, its site the compiler's, `planSiteKey`: a store's offsets are its file's,
 * Astra r1's B1 on #1690) and the part; `covered`: each covered part with `=` (the projected type itself) or
 * `wider`.
 */
export function partProblems(
  natural: InstructionPlan,
  stopped: InstructionPlan,
): { readonly problems: string[]; readonly covered: string[] } {
  type Store = { readonly parts: readonly PartCheckPlan[]; readonly whole: TypePlan | null };
  const stores = (plan: InstructionPlan): Map<string, Store> => {
    const out = new Map<string, Store>();
    plan.instructions.forEach((instruction, index) => {
      if (instruction.kind !== "declareBinding" && instruction.kind !== "assign") return;
      const at = `${instruction.kind}@${planSiteKey(plan, index)}`;
      if (out.has(at)) throw new Error(`Two stores of one plan at ${at}.`);
      out.set(at, {
        parts: instruction.partChecks ?? [],
        whole: instruction.typeCheck?.type ?? null,
      });
    });
    return out;
  };
  const text = (part: PartCheckPlan): string => JSON.stringify([part.path, part.type, part.place]);
  const naturals = stores(natural);
  const problems: string[] = [];
  const covered: string[] = [];
  for (const [at, { parts }] of stores(stopped)) {
    if (parts.length === 0) continue;
    const own = naturals.get(at);
    if (own === undefined) {
      problems.push(`${at}: no such store in the natural plan`);
      continue;
    }
    const expected = own.parts.map(text);
    let cursor = 0;
    for (const part of parts) {
      const found = expected.indexOf(text(part), cursor);
      if (found >= 0) {
        cursor = found + 1;
        continue;
      }
      const projected = own.whole === null ? null : projectedType(own.whole, part.path);
      if (projected !== null && accepts(part.type, projected)) {
        covered.push(
          `${at}: ${text(part)} ${JSON.stringify(part.type) === JSON.stringify(projected) ? "=" : "wider"}`,
        );
        continue;
      }
      problems.push(
        `${at}: ${text(part)} ${
          expected.includes(text(part))
            ? "out of the natural order"
            : projected === null
              ? "neither a natural part nor covered by the natural whole check"
              : `stricter than the natural whole check's ${JSON.stringify(projected)} there`
        }`,
      );
    }
  }
  return { problems, covered };
}
