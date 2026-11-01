import type { CompilationResult } from "../../src/compiler.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import type { Answers } from "../../src/type-inference/core/answers.js";
import type { Omission } from "../../src/type-inference/core/consumers.js";
import type { CoreDiagnostic, Obligation } from "../../src/type-inference/core/result.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";

/*
 * The stop oracle (D4 a′, TABLE r4.99, r4.100, r4.108): a compile stopped at some unit against the unstopped compile,
 * whole. One function for `tests/type-core-stop.test.ts` and the every-unit sweep kept outside CI.
 */

/** A plan's globals for one run. */
export type Globals = Readonly<Record<string, SerializableRuntimeValue>>;

/** A compile's diagnostics and plan. */
type Compiled = Pick<CompilationResult, "diagnostics" | "plan">;

/** A compile of one source and its analysis at the same allowance, in the same mode. */
export interface StopRun {
  readonly result: Compiled;
  readonly answers: Answers;
  /** The compile and its analysis again under `withoutRecords(omit)`; `key` names the omission (for a cache). */
  readonly without: (
    omit: Omission,
    key: string,
  ) => { readonly result: Compiled; readonly answers: Answers };
}

export interface StopCase {
  readonly unstopped: StopRun;
  readonly stopped: StopRun;
  readonly fitting: readonly Globals[];
  readonly violating: readonly Globals[];
}

/** A site's offsets. */
interface Span {
  readonly start: number;
  readonly end: number;
}

/** Where two plans differ: the path of the differing value, and the innermost plan node with a span holding it. */
interface PlanDifference {
  readonly path: string;
  readonly node: Span | null;
}

/** The parts of a plain value: an array's items, an object's fields; none for anything else. */
function partsOf(value: unknown): Map<string, unknown> | null {
  if (Array.isArray(value)) return new Map(value.map((item, index) => [String(index), item]));
  return value !== null && typeof value === "object" ? new Map(Object.entries(value)) : null;
}

/** A plan node's span as the plan serializes it (an instruction's compact `so`/`eo`, else its offsets), or `null`. */
function spanOf(value: unknown): Span | null {
  const parts = partsOf(partsOf(value)?.get("span"));
  if (parts === null) return null;
  if (parts.has("so")) return { start: Number(parts.get("so")), end: Number(parts.get("eo")) };
  const offset = (end: string): number => Number(partsOf(parts.get(end))?.get("offset"));
  return { start: offset("start"), end: offset("end") };
}

/** Every place two plans differ: each value's path where one has what the other lacks or another value. */
function planDifferences(
  want: unknown,
  got: unknown,
  node: Span | null = null,
  path = "",
  out: PlanDifference[] = [],
): PlanDifference[] {
  if (JSON.stringify(want) === JSON.stringify(got)) return out;
  const here = spanOf(want) ?? spanOf(got) ?? node;
  const [w, g] = [partsOf(want), partsOf(got)];
  if (
    w !== null &&
    g !== null &&
    Array.isArray(want) === Array.isArray(got) &&
    (!Array.isArray(want) || w.size === g.size)
  ) {
    for (const key of new Set([...w.keys(), ...g.keys()]))
      planDifferences(w.get(key), g.get(key), here, `${path}/${key}`, out);
    return out;
  }
  out.push({ path: path || "/", node: here });
  return out;
}

/** A run of a plan to its end with `globals`: what it said and where it failed. */
function ranWith(
  plan: InstructionPlan,
  globals: Globals,
): { readonly said: readonly string[]; readonly failure: (Span & { code: string }) | null } {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    said: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    failure:
      failure?.kind === "runtimeFailure"
        ? { code: failure.code, start: failure.span.start.offset, end: failure.span.end.offset }
        : null,
  };
}

/** A record's code and site, `code start:end`. */
function recordOf(code: string, site: Span): string {
  return `${code} ${site.start}:${site.end}`;
}

/**
 * What to leave out of a compile (`StopRun.without`): the warnings and marks with the records `records` names (each
 * `code start:end`), and the boundary checks within `spans`, with its key.
 */
function omission(
  records: ReadonlySet<string>,
  spans: readonly Span[] = [],
): readonly [Omission, string] {
  return [
    {
      diagnostic: (d: CoreDiagnostic) => records.has(recordOf(d.code, d.site)),
      check: (check: Obligation) =>
        check.boundary && spans.some((span) => within(check.site, span)),
    },
    `${[...records].sort().join("|")}#${spans.map((span) => `${span.start}:${span.end}`).join("|")}`,
  ];
}

/** The items of `list` beyond those of `other`, each as often as `list` has it more (a multiset difference). */
function beyond(list: readonly string[], other: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const item of other) left.set(item, (left.get(item) ?? 0) + 1);
  return list.filter((item) => {
    const count = left.get(item) ?? 0;
    if (count > 0) left.set(item, count - 1);
    return count === 0;
  });
}

/** A diagnostic's offsets. */
function offsets(d: Compiled["diagnostics"][number]): Span {
  return { start: d.span.start.offset, end: d.span.end.offset };
}

/**
 * How the message modules (`src/type-inference/core/messages.ts` and `messages/`) word a diagnostic, as closed lists the
 * oracle's own test checks against every literal text there (#1449): the first word of a fix's sentence (`fix`) and of
 * any other (`prose`), and the last words before a quoted text, which make it code a fix shows (`code`, as in
 * `as in 'if n is integer { … }'`) or a name (`name`; none at a sentence's start or after a colon). A word in no list
 * leaves its sentence or quoted text unknown, and such a sentence is compared exactly.
 */
export const MESSAGE_WORDS = {
  fix:
    "Add|Assign|Call|Check|Combine|Compare|Convert|Copy|Divide|Give|" +
    "Join|Keep|Put|Read|Select|Show|Subtract|To|Use|Write",
  prose: "A|An|Arithmetic|Checking|If|It|Its|Most|The|This",
  code: "as|as in|type|Use|with|Write|write",
  name:
    "A|a|Add|after|an|and|Assign|assign|before|but|by|cannot set|cannot write|change|Check|Checking|Convert|Copy|" +
    "default|Divide|fallback|for|Give|give|in|Keep|method|no|of|outside|parameter|property|same type with|show|so|that|" +
    "to|where|without",
};

const listed = (words: string): ReadonlySet<string> => new Set(words.split("|"));
const [FIX, CODE, NAME] = [
  listed(MESSAGE_WORDS.fix),
  listed(MESSAGE_WORDS.code),
  listed(MESSAGE_WORDS.name),
];

/** What a quoted text is by the words before it in its sentence (`MESSAGE_WORDS`), the longest listed words deciding. */
export function quotedAs(before: string): "code" | "name" | "unknown" {
  const words = before
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => word.replace(/,$/, ""));
  if (words.length === 0 || words.at(-1)!.endsWith(":")) return "name";
  for (let count = Math.min(3, words.length); count > 0; count -= 1) {
    const last = words.slice(-count).join(" ");
    if (CODE.has(last)) return "code";
    if (NAME.has(last)) return "name";
  }
  return "unknown";
}

/** A quoted text as read: the words before it in its sentence, whether a value inserted there stands right before them. */
interface Quoted {
  readonly before: string;
  readonly inserted: boolean;
  readonly text: string;
}

/** A sentence as read: its text, its first word (`null` where a value inserted there starts it), and its quoted texts. */
export interface ReadSentence {
  readonly text: string;
  readonly first: string | null;
  readonly quotes: readonly Quoted[];
}

/**
 * A text's sentences, read from its literal pieces with `null` for each value inserted there (a template's; a rendered
 * message is one piece). A sentence ends at a full stop or question mark outside quoted texts. A quote opens after a space,
 * an opening bracket or the start, and closes before a space, punctuation or the end, outside a text literal it holds
 * (`"…"`, escapes included, whose apostrophes and full stops are its own: Codex r2's F1). `null` where a quote or such a
 * literal is left open: then the quotes can be read more than one way.
 */
export function readSentences(pieces: readonly (string | null)[]): ReadSentence[] | null {
  const out: ReadSentence[] = [];
  let [text, before, quoted, last] = ["", "", "", " "];
  let [inside, literal, escaped, inserted] = [false, false, false, false];
  let first: string | null | undefined;
  let quotes: Quoted[] = [];
  const end = (): void => {
    if (text.trim() !== "") out.push({ text: text.trim(), first: first ?? null, quotes });
    [text, before, quotes, first, inserted] = ["", "", [], undefined, false];
  };
  for (const piece of pieces) {
    // (a quote right after an inserted value opens with no words before it, which only the value could decide)
    if (piece === null) {
      if (!inside)
        [before, inserted, first, last] = ["", true, first === undefined ? null : first, " "];
      continue;
    }
    for (let index = 0; index < piece.length; index += 1) {
      const [here, next] = [piece[index]!, piece[index + 1] ?? " "];
      text += here;
      if (inside && literal) {
        if (escaped) escaped = false;
        else if (here === "\\") escaped = true;
        else if (here === '"') literal = false;
        quoted += here;
      } else if (inside && here === "'" && /[\s.,;:!?)\]]/.test(next)) {
        quotes.push({ before, inserted, text: quoted });
        [inside, before, inserted] = [false, "", false];
      } else if (inside) {
        if (here === '"') literal = true;
        quoted += here;
      } else if (here === "'" && /[\s([]/.test(last)) {
        if (first === undefined) first = "";
        [inside, quoted] = [true, ""];
      } else {
        if (first === undefined && /\w/.test(here)) first = /^\w+/.exec(piece.slice(index))![0];
        else if (first === undefined && /\S/.test(here)) first = "";
        before += here;
        if ((here === "." || here === "?") && /\s/.test(next)) end();
      }
      last = here;
    }
  }
  if (inside) return null;
  end();
  return out;
}

/** A message's sentence: its text, whether it starts as a fix does, and its quoted texts, each with what it is. */
interface Sentence {
  readonly text: string;
  readonly fix: boolean;
  readonly quotes: readonly { readonly as: ReturnType<typeof quotedAs>; readonly text: string }[];
}

/** A rendered message's sentences (`readSentences`), or `null` where its quotes can be read more than one way. */
function spoken(message: string): Sentence[] | null {
  return (
    readSentences([message])?.map((sentence) => ({
      text: sentence.text,
      fix: FIX.has(sentence.first ?? ""),
      quotes: sentence.quotes.map((quote) => ({ as: quotedAs(quote.before), text: quote.text })),
    })) ?? null
  );
}

/**
 * Whether a stopped diagnostic is the unstopped one as a stop keeps it: the same severity, code and span, and the same
 * message but for a fix a stop's unchecked region gives in words where the unstopped compile shows code (TABLE r4.162):
 * a sentence that starts as a fix both times, the unstopped one showing code and the stopped one quoting only names the
 * unstopped message quotes, as they stand there. A message whose quotes can be read more than one way is compared whole.
 */
function keeps(
  want: Compiled["diagnostics"][number],
  got: Compiled["diagnostics"][number],
): boolean {
  const { message: before, ...wanted } = want;
  const { message: after, ...found } = got;
  if (JSON.stringify(wanted) !== JSON.stringify(found)) return false;
  if (before === after) return true;
  const [was, is] = [spoken(before), spoken(after)];
  if (was === null || is === null || was.length !== is.length) return false;
  const named = new Set(
    was.flatMap((sentence) =>
      sentence.quotes.filter((quote) => quote.as === "name").map((quote) => quote.text),
    ),
  );
  return was.every((code, index) => {
    const words = is[index]!;
    return (
      code.text === words.text ||
      (code.fix &&
        words.fix &&
        code.quotes.some((quote) => quote.as === "code") &&
        words.quotes.every((quote) => quote.as === "name" && named.has(quote.text)))
    );
  });
}

/** Whether `inner` lies within `outer`. */
function within(inner: Span, outer: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * What a stop changed of the unstopped compile that no deferred mark excuses (TABLE r4.99, r4.108–r4.111), none at a
 * sound stop, settled or not. A mark excuses the record with its code at its site and nothing else; before admission
 * settled, a store marked with its type undecided also stands for its records within its value and for the errors it
 * brought, a written store's mark for its records within its value (TABLE r4.152 (1)), and C5's error at a literal for
 * the mark of the store that owes it. The diagnostics, each whole but for a fix the stop gives in words (r4.162), and the
 * checks are compared in their published order (r4.86 (1)) besides those records, what forms only with the marks, and the
 * stop's own warning. The plans are compared whole; a difference stands only inside the plan content of a mark whose
 * obligation is not the unstopped one at its code and site (one that is owes the same check), or of a marked store's
 * records: the content that leaving them out of each compile's analysis and discharge removes. The fitting runs are
 * unchanged; a violating run differs only where the run that stops first fails in a node holding such content.
 */
export function stopProblems(c: StopCase): string[] {
  const { unstopped, stopped } = c;
  const problems: string[] = [];
  const marks = stopped.answers.budget.deferred;
  const [want, got] = [unstopped.result.plan, stopped.result.plan];
  const fitting = (): void =>
    c.fitting.forEach((globals) => {
      const [a, b] = [
        JSON.stringify(ranWith(want!, globals)),
        JSON.stringify(ranWith(got!, globals)),
      ];
      if (a !== b) problems.push(`fitting ${b} against ${a}`);
    });
  const excused = new Set(marks.map((mark) => recordOf(mark.code, mark.site)));
  // before admission settled no decision is read (r4.110 (3)): each store marked with its type undecided stands for its
  // records within its value and for the errors it brought (r4.111), and C5's error at a literal may stand as the mark
  // of the store that owes it, its receiver's shape undecided (r4.108 (2)); a written store's mark stands for its
  // records within its value too (an element its literal holds that admission left undecided), never for one outside
  // it (TABLE r4.152 (1))
  const storeMarks = stopped.answers.budget.settled
    ? []
    : marks.filter((mark) => mark.rule.rule === "store");
  const undecided = (mark: (typeof marks)[number]): boolean =>
    mark.obligation.against.length === 1 && mark.obligation.against[0] === "unknown";
  const stores = storeMarks.filter(undecided).map((mark) => mark.site);
  const values = storeMarks
    .filter((mark) => undecided(mark) || (mark.rule.rule === "store" && mark.rule.written))
    .map((mark) => mark.site);
  const ofStore = (site: Span): boolean => values.some((span) => within(site, span));
  const storeRecords = new Set<string>();
  if (!stopped.answers.budget.settled)
    for (const d of unstopped.answers.diagnostics) {
      if (!("rule" in d)) continue;
      const { rule } = d;
      if (
        ofStore(d.site) ||
        (rule.rule === "store" &&
          rule.brought !== null &&
          stores.some(
            (span) => span.start === rule.brought!.start && span.end === rule.brought!.end,
          )) ||
        (d.class === "compile-error" &&
          rule.rule === "absent" &&
          rule.store !== null &&
          excused.has(recordOf(d.code, rule.store)))
      )
        storeRecords.add(recordOf(d.code, d.site));
    }
  for (const record of storeRecords) excused.add(record);
  // the diagnostics, in their published order, each whole but for its fix in words (r4.162)
  const shown = (each: StopRun) =>
    each.result.diagnostics.filter(
      (d) => d.code !== "TSV076" && !excused.has(recordOf(d.code, offsets(d))),
    );
  const [before, after] = [shown(unstopped), shown(stopped)];
  const text = (list: typeof before): string => list.map((d) => JSON.stringify(d)).join(" | ");
  if (before.length !== after.length || before.some((d, index) => !keeps(d, after[index]!)))
    problems.push(`diagnostics ${text(after)} against ${text(before)}`);
  // the checks, in their published order: an unstopped one a mark's record owns or one of a marked store's records; a
  // stopped one a mark's record owns, one of a marked store's records the unstopped analysis has too (the record kept,
  // on both sides alike, TABLE r4.122), or one that forms only with the marks, their content (r4.110 (a): the stopped
  // analysis without them lacks it); any other stopped check inside a marked store's value is compared
  const marked = new Set<Obligation>(
    [...unstopped.answers.diagnostics, ...stopped.answers.diagnostics, ...marks].flatMap((d) =>
      "obligation" in d && excused.has(recordOf(d.code, d.site)) ? [d.obligation] : [],
    ),
  );
  const ofStores = unstopped.answers.checks
    .filter((check) => !marked.has(check) && ofStore(check.site))
    .map((check) => JSON.stringify(check));
  const owed = unstopped.answers.checks
    .filter((check) => !marked.has(check) && !ofStore(check.site))
    .map((check) => JSON.stringify(check));
  let kept = beyond(
    stopped.answers.checks
      .filter((check) => !marked.has(check))
      .map((check) => JSON.stringify(check)),
    ofStores,
  );
  // (an extra the stopped analysis without its marks lacks is their content; a check both have stays compared)
  const extra = beyond(kept, owed);
  let formed: string[] = [];
  if (extra.length > 0 && marks.length > 0) {
    const without = stopped.without(...omission(excused)).answers.checks;
    formed = beyond(
      extra,
      without.map((check) => JSON.stringify(check)),
    );
    kept = beyond(kept, formed);
  }
  if (JSON.stringify(owed) !== JSON.stringify(kept)) {
    const [lost, extra] = [beyond(owed, kept), beyond(kept, owed)];
    for (const check of lost) problems.push(`lost check ${check}`);
    for (const check of extra) problems.push(`extra check ${check}`);
    if (lost.length + extra.length === 0) problems.push(`checks order ${kept.join(" | ")}`);
  }
  if (want !== null && got === null) problems.push("no plan");
  if (want === null || got === null) return problems;
  // the plans, whole: each difference inside a changing mark's content
  const differences = planDifferences(want, got);
  const obligations = new Map(
    unstopped.answers.diagnostics.flatMap((d) =>
      "obligation" in d ? [[recordOf(d.code, d.site), JSON.stringify(d.obligation)] as const] : [],
    ),
  );
  const changing = new Set(
    marks
      .filter(
        (mark) =>
          obligations.get(recordOf(mark.code, mark.site)) !== JSON.stringify(mark.obligation),
      )
      .map((mark) => recordOf(mark.code, mark.site)),
  );
  const content: PlanDifference[] = [];
  if (differences.length > 0 && changing.size > 0) {
    const own = (each: StopRun): PlanDifference[] =>
      planDifferences(
        each.without(...omission(new Set())).result.plan,
        each.without(...omission(new Set([...changing, ...storeRecords]), stores)).result.plan,
      );
    content.push(...own(unstopped), ...own(stopped));
  }
  // (a boundary check that forms only with the marks, whose own obligations are unchanged, #1448: its own plan content,
  // what leaving that exact check out of the stopped compile's discharge removes, every warning and other check kept)
  const boundaries = new Set(
    stopped.answers.checks
      .filter((check) => check.boundary)
      .map((check) => JSON.stringify(check))
      .filter((text) => formed.includes(text)),
  );
  if (differences.length > 0 && boundaries.size > 0)
    content.push(
      ...planDifferences(
        stopped.without(...omission(new Set())).result.plan,
        stopped.without(
          {
            diagnostic: () => false,
            check: (check: Obligation) => boundaries.has(JSON.stringify(check)),
          },
          `checks#${[...boundaries].sort().join("|")}`,
        ).result.plan,
      ),
    );
  const inContent = (path: string): boolean =>
    content.some((part) => path === part.path || path.startsWith(`${part.path}/`));
  const excusedNodes: Span[] = [];
  for (const difference of differences)
    if (difference.node !== null && inContent(difference.path)) excusedNodes.push(difference.node);
    else problems.push(`plan ${difference.path}`);
  // the runs
  fitting();
  const first = (one: ReturnType<typeof ranWith>, other: ReturnType<typeof ranWith>): boolean =>
    one.failure !== null &&
    excusedNodes.some((node) => within(one.failure!, node)) &&
    one.said.every((text, index) => other.said[index] === text);
  c.violating.forEach((globals) => {
    const [a, b] = [ranWith(want, globals), ranWith(got, globals)];
    if (JSON.stringify(a) !== JSON.stringify(b) && !first(a, b) && !first(b, a))
      problems.push(`violating ${JSON.stringify(b)} against ${JSON.stringify(a)}`);
  });
  return problems;
}
