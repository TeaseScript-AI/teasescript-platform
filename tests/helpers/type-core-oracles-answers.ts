// What a program's analysis answers, as the oracles publish it, under the questions' bound (units, heap room and the
// work reported), and the lists the tests read off its answers and items.
import { getHeapStatistics } from "node:v8";
import type { AdmittedType, Answers, CorePass } from "../../src/type-inference/core/answers.js";
import { BudgetExhausted } from "../../src/type-inference/core/budget.js";
import { asked, checkedResult } from "../../src/type-inference/core/check-result/check-result.js";
import type { FlowNode } from "../../src/type-inference/core/flow-graph.js";
import {
  ingressLeaves,
  type Item,
  itemsSignature,
  spellingIdentity,
  writerKey,
} from "../../src/type-inference/core/items.js";
import { coreMessage, messageSource } from "../../src/type-inference/core/messages.js";
import { type CoreAnalysisRequest, propertyStep } from "../../src/type-inference/core/program.js";
import { coreRecord } from "../../src/type-inference/core/result.js";
import type { PlaceId } from "../../src/type-inference/graph.js";
import { itemScope } from "./type-core-items.js";

/** Two sites as (file index, start, end), in source order. */
function compareSites(a: readonly number[], b: readonly number[]): number {
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

/**
 * One analysis's part: its answers (the outcome and diagnostics with the checks that owe the runtime nothing,
 * `checkedResult`, and the checks) and every binding's admitted types at its root and its element (`text`); the record
 * alone, its answers and the same serialized (`record`); and whether each of its lists is in source order of its sites.
 * The admitted types are the oracle's own questions (`Questions`, two cells a binding; `questions`, a
 * publication's meter, else one of their own): where they stop, it throws `AnswersStopped`, never publishing answers
 * asked again on a stopped analysis. The answers and the checks are the backend's questions, which stop past the
 * finished analysis's allowance as the backend's do (`asked`).
 */
export function publishedAnswers(
  answers: Answers,
  bindings: readonly PlaceId[],
  request: CoreAnalysisRequest,
  questions = new Questions(),
): { readonly text: string; readonly record: string; readonly sited: boolean } {
  return asked(answers, (answers) => {
    const admitted: unknown[] = [];
    for (const [index, place] of bindings.entries())
      try {
        admitted.push(
          questions.ask(
            answers,
            () => [
              place,
              answers.place(place, []).admitted,
              answers.place(place, ["element"]).admitted,
            ],
            () => 2,
          ),
        );
      } catch (error) {
        throw new AnswersStopped(
          { reason: stopOf(answers, error), binding: place },
          bindings.length - index,
        );
      }
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

/** `publishedAnswers`' own questions stopped (`by`), with `left` bindings unanswered. */
export class AnswersStopped extends Error {
  public constructor(
    public readonly by: UnansweredBy,
    public readonly left: number,
  ) {
    super(`The published answers' questions stopped (${by.reason}).`);
    this.name = "AnswersStopped";
  }
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
 * Why a publication's oracle left questions unanswered (`answeredOccurrences`, `publishedAnswers`), and the first
 * node it left, or the binding where its answers' own questions stopped (then every node is left too): the families
 * runner counts each reason apart (`tests/families/README.md`); a reason a tree's oracle does not give is `unknown` there.
 */
export type UnansweredBy =
  | { readonly reason: QuestionStop; readonly node: number }
  | { readonly reason: QuestionStop; readonly binding: PlaceId };

/**
 * Why the oracle's own questions stopped: `questions` past their bound (`Questions`) or the analysis's work, `memory`
 * past their room in the heap, `read-depth` past the read-depth limit, after an analysis that finished each way;
 * `stopped` where the analysis itself stopped in one of its phases (`budget.stoppedIn`, not `questions`).
 */
type QuestionStop = "questions" | "memory" | "read-depth" | "stopped";

/**
 * #1837: K, the units the oracle's own questions may spend per cell they return (an occurrence's answer, its element's
 * and each property's) beyond the program's allowance. About 1.3× the largest measured (49.83, `r3-root-copies` at
 * k = 512), whose per-cell cost still rises by a log factor (#1941).
 *
 * @public (the families runner reads it from a built tree, not by an import: its grant to a publication run)
 */
export const QUESTION_UNITS_PER_CELL = 64;

/**
 * #1837: the heap the core keeps per cell the oracle's questions return (its memo of the answers), as the oracle counts
 * it: about 1.4× the largest measured live heap per answered cell (453.7 bytes, `W24-varied` at k = 1,024; flat over k
 * 256 → 1,024 on the three families measured, so linear in the output, as the units are).
 */
export const QUESTION_BYTES_PER_CELL = 640;

/**
 * The heap the oracle's questions leave to the analysis, the route and what V8 has yet to collect: 1.5 GiB. The
 * analysis finishes before any question is asked, so the oracle cannot cap its heap; with sharing off it grows about
 * ×3.6 a doubling (#1603), to 1,089 MiB at `W19-sources` k = 1,024, and V8 needs room beyond it to collect.
 */
const QUESTION_HEAP_RESERVE = 1_536 * 2 ** 20;

/**
 * A process's heap as the room reads it: V8's figures. The room reads only the limit; the heap in use is here so that a
 * test can give a heap that already holds much and show that the room does not follow it.
 */
export interface QuestionHeap {
  readonly statistics: () => { readonly heap_size_limit: number; readonly used_heap_size: number };
}

/**
 * Test-only: the questions' room in `heap` (`heapRoom`): its limit less the reserve, whatever the heap holds when the
 * meter is made, so that a stop lands at the same cell on every run whatever ran before it in the process. What an
 * earlier run left can outlast several collections, by V8's timing, so a room taken from the heap in use moved from
 * run to run (#2518).
 */
export function questionRoomOf(heap: QuestionHeap): number {
  return heap.statistics().heap_size_limit - QUESTION_HEAP_RESERVE;
}

/**
 * The questions' room in this process's heap, taken when a publication's meter is made, before its analysis
 * (`Questions`; `questionRoomOf`): its V8 heap limit is fixed by its `--max-old-space-size`, as the families runner sets
 * it. Or a test's (`withQuestionMemory`).
 */
let questionRoom: number | null = null;
function heapRoom(): number {
  return questionRoom ?? questionRoomOf({ statistics: getHeapStatistics });
}

/** Test-only: `run` with the oracle's questions given `room` bytes of heap. */
export function withQuestionMemory<T>(room: number, run: () => T): T {
  const outer = questionRoom;
  questionRoom = room;
  try {
    return run();
  } finally {
    questionRoom = outer;
  }
}

/** The oracle's own questions' bound: the program's allowance (`null`) or a test's, and K (`withQuestionBound`). */
let questionBound: { readonly allowance: number | null; readonly perCell: number } = {
  allowance: null,
  perCell: QUESTION_UNITS_PER_CELL,
};

/** Test-only: `run` with the oracle's questions bounded by `allowance` plus `perCell` per cell returned. */
export function withQuestionBound<T>(allowance: number | null, perCell: number, run: () => T): T {
  const outer = questionBound;
  questionBound = { allowance, perCell };
  try {
    return run();
  } finally {
    questionBound = outer;
  }
}

/** What the latest publication's questions spent and returned so far (`questionWork`). */
let questionsSoFar = { units: 0, cells: 0 };

/**
 * The units the latest publication's own questions spent apart and the cells they returned, so far: the families
 * runner grants a publication run `QUESTION_UNITS_PER_CELL` per cell reported here beyond its limit (#1837).
 *
 * @public (the families runner reads it from a built tree, not by an import)
 */
export function questionWork(): { readonly units: number; readonly cells: number } {
  return questionsSoFar;
}

/** The oracle's own questions stopped (`Questions`), and why. */
class QuestionsStopped extends Error {
  public constructor(public readonly reason: "questions" | "memory" | "read-depth") {
    super(`The oracle's questions stopped (${reason}).`);
    this.name = "QuestionsStopped";
  }
}

/**
 * #1837: the oracle's own questions to a finished analysis, each run apart (`Answers.apart`: finishing work, which never
 * stops the analysis nor counts to its allowance) and metered on their own. They stop (`QuestionsStopped`) at the
 * question after which the units they spent pass the bound: the program's allowance plus K per cell returned so far
 * (`withQuestionBound`); or where `QUESTION_BYTES_PER_CELL` per cell returned passes their room in the heap
 * (`memory`), so that they end before V8 runs out of it. Checked between questions, so no question is cut midway; the
 * families runner's limit bounds one question's own cost. A question that passes the read-depth limit or the analysis's work (a decision's restart)
 * stops them there too. Each publication's questions are one meter (`questionWork`).
 */
export class Questions {
  #units = 0;
  #cells = 0;
  /** The questions' room in the heap, taken before the analysis (`heapRoom`). */
  readonly #room = heapRoom();

  public constructor() {
    questionsSoFar = { units: 0, cells: 0 };
  }

  /** `question`'s answer, asked apart, with its cells (`cells`) counted: `QuestionsStopped` past the bound. */
  public ask<T>(answers: Answers, question: () => T, cells: (answer: T) => number): T {
    // (the budget's record is brought up to date by each `apart`: what came between two questions is not theirs)
    answers.apart(() => undefined);
    const before = answers.budget.finishing;
    let answer: T;
    try {
      answer = answers.apart(question);
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      throw new QuestionsStopped(error.limit === "read-depth" ? "read-depth" : "questions");
    }
    this.#units += answers.budget.finishing - before;
    this.#cells += cells(answer);
    questionsSoFar = { units: this.#units, cells: this.#cells };
    const allowance = questionBound.allowance ?? answers.budget.allowance;
    if (this.#units > allowance + questionBound.perCell * this.#cells)
      throw new QuestionsStopped("questions");
    if (QUESTION_BYTES_PER_CELL * this.#cells > this.#room) throw new QuestionsStopped("memory");
    return answer;
  }
}

/** Why the oracle's questions to `answers` stopped at `error` (`QuestionStop`); any other error is thrown again. */
function stopOf(answers: Answers, error: unknown): QuestionStop {
  if (!(error instanceof QuestionsStopped)) throw error;
  // (stopped only where the analysis itself stopped in a phase of its own; one that finished, a limit such as
  // nesting reached or not, has no such phase, and its later questions are the oracle's)
  const phase = answers.budget.stoppedIn;
  return phase === null || phase === "questions" ? error.reason : "stopped";
}

/** An occurrence answer's cells: its own, its element's and each property's (`occurrenceAnswer`). */
const cellsOf = (answer: unknown[] | null): number =>
  answer === null
    ? 0
    : 1 + (answer[5] === null ? 0 : 1) + (Array.isArray(answer[6]) ? answer[6].length : 0);

/**
 * Every occurrence's answer (`occurrenceAnswer`, its items in their order), each mapped by `each` as it is made, up to
 * the node at which the oracle's own questions stop (`Questions`), not the analysis. That node and every one after it
 * stay unanswered (`unanswered`, their count), never asked again on the stopped answers, whose `unknown` answers would
 * agree wherever both trees stop alike; why (`unansweredBy`, `QuestionStop`), with the first node unanswered.
 */
export function answeredOccurrences<Occurrence>(
  answers: Answers,
  questions: Questions,
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
      answer = questions.ask(answers, () => occurrenceAnswer(answers, node, items), cellsOf);
    } catch (error) {
      return {
        occurrences,
        unanswered: nodes.length - index,
        unansweredBy: { reason: stopOf(answers, error), node: node.id },
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
 * What a program publishes with two orders set aside
 * (docs/specifications/type-inference-accepted-record/oracles.md#r4-185, G5's stops whose own entries merge into one):
 * the order of the items in an answer and of the kinds in a decided admitted type. Every binding's admitted type and
 * decider site at its root, its element and each known property two levels down; every occurrence's answer
 * (`occurrences`, its items sorted). Test-only, for small sources (`oracles/type-core-oracles-questions.test.ts`,
 * `type-core-contract.test.ts`), never a publication the families runner reads; their questions are not under the
 * oracle's own bound (`Questions`): past the finished analysis's allowance they are asked again on the stopped analysis
 * (`asked`), so the text holds the stopped answers with no mark of the stop.
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
 * in the order given, and every diagnostic's message. For small sources: their questions are not under the oracle's own
 * bound (`Questions`): past the finished analysis's allowance they are asked again on the stopped analysis (`asked`),
 * so the text holds the stopped answers with no mark of the stop.
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
 * obligations and items whole, each with its ingress leaves), in their order. For small sources: their questions are
 * not under the oracle's own bound (`Questions`): past the finished analysis's allowance they are asked again on the
 * stopped analysis (`asked`), so the text holds the stopped answers with no mark of the stop.
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
 * whatever order the leaves are found in), one line per node. For small sources: their questions are not under the
 * oracle's own bound (`Questions`): past the finished analysis's allowance they are asked again on the stopped analysis
 * (`asked`), so the text holds the stopped answers with no mark of the stop.
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
