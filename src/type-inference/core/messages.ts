import type { Block, Program } from "../../ast.js";
import { parse } from "../../parser.js";
import { someNode } from "../../project-globals.js";
import type { SourceSite } from "../graph.js";
import { CONVERSIONS } from "../../conversions.js";
import { localCalendarOffsetMessage } from "../../duration.js";
import { repeatCountFix, repeatCountMessage } from "../../loop-rules.js";
import { cannotConvert, describeShownValue } from "../../runtime/values/value-types.js";
import { REFERENCE } from "./contract.js";
import type { ContextWord, ItemTag } from "./items.js";
import type {
  CheckedDiagnostic,
  ContextDetail,
  CoreCode,
  DiagnosticRule,
  StaticRule,
} from "./result.js";
import {
  type Given,
  givenBy,
  guards,
  holds,
  inTarget,
  type Landing,
  landingOf,
  type LineStatements,
  type MessageSource,
  UNGUARDED,
} from "./messages/site.js";
import { described, isLiteral, setsProperty } from "./messages/words.js";
import type { Diagnosed } from "./messages/code-forms.js";
import { errorSentence, writtenTypeMessage } from "./messages/errors.js";
import { budgetMessage, warningFix, warningSentence } from "./messages/warnings.js";
export type { Landing, MessageSource } from "./messages/site.js";
export { pathPhrase } from "./messages/words.js";

/*
 * The sentences of the coarse core's diagnostics (the port plan's D1–D3, TABLE r4.53): each diagnostic's code is its
 * rule's (D3: one code, both severities where the rule warns), and its message is a first sentence per consumer and
 * obligation, in the source's own text (D2), and the fix the current checker gives (#1195). A warning says what may go
 * wrong, that the Tease then stops at its line, the fix, and a last sentence per context word (§3.4) that says in the
 * author's terms why the value may be of another type; the word itself is never shown. Single quotes for code, no
 * semicolons, no implementation terms, and "type", never "kind" (`docs/DIAGNOSTICS.md`, "Messages").
 */

export function messageSource(
  sources: readonly string[],
  diagnostics: readonly CheckedDiagnostic[],
): MessageSource {
  const starts = new Map<number, number[]>();
  const programs = new Map<number, Program>();
  const programOf = (file: number): Program => {
    let found = programs.get(file);
    if (found === undefined) {
      found = parse(sources[file] ?? "").program;
      programs.set(file, found);
    }
    return found;
  };
  const statements = new Map<number, Map<number, LineStatements>>();
  const statementsOf = (file: number): Map<number, LineStatements> => {
    let found = statements.get(file);
    if (found === undefined) {
      found = new Map<number, LineStatements>();
      const byLine = found;
      someNode(programOf(file), (node) => {
        if (node.kind !== "program" && node.kind !== "block") return false;
        // EVIDENCE: invariant: a parser-owned node whose kind is `program` or `block` holds its statements.
        for (const statement of (node as Program | Block).statements) {
          const { start, end } = statement.span;
          if (start.line !== end.line) continue;
          const line = byLine.get(start.line);
          if (line === undefined) byLine.set(start.line, { statements: [statement], around: [] });
          else line.statements.push(statement);
        }
        return false;
      });
      for (const line of byLine.values()) {
        line.statements.sort(
          (a, b) =>
            a.span.start.offset - b.span.start.offset || b.span.end.offset - a.span.end.offset,
        );
        // (statements nest: the next one around each is on the stack of those it starts inside)
        const open: number[] = [];
        line.statements.forEach((statement, index) => {
          while (
            open.length > 0 &&
            line.statements[open.at(-1)!]!.span.end.offset < statement.span.end.offset
          )
            open.pop();
          line.around.push(open.at(-1) ?? -1);
          open.push(index);
        });
      }
      statements.set(file, found);
    }
    return found;
  };
  // what each diagnostic covers for `alone`: its site; a "not checked (budget)" mark's whole region, the stop's
  // unchecked code, where the checks it moved to the runtime stand unreported (Astra r3); a stop's own warning, which
  // claims no region, nothing. Each file's in start order, with the furthest end among those before each.
  type Covered = {
    readonly diagnostic: CheckedDiagnostic;
    readonly start: number;
    readonly end: number;
  };
  // (with the furthest end before each and the one that reaches it, and the furthest of the others, so that a text in
  // `self`'s own site, as an operand of it, is judged by the others)
  type Index = {
    readonly sorted: Covered[];
    readonly reach: number[];
    readonly reacher: number[];
    readonly next: number[];
  };
  const sites = new Map<number, Index>();
  const sitesOf = (file: number): Index => {
    let found = sites.get(file);
    if (found === undefined) {
      const sorted = diagnostics
        .flatMap((diagnostic): Covered[] => {
          const covers =
            diagnostic.kind !== "budget"
              ? diagnostic.site
              : diagnostic.class === "not-checked-budget"
                ? diagnostic.place.lines
                : null;
          return covers === null || covers.file !== file
            ? []
            : [{ diagnostic, start: covers.start, end: covers.end }];
        })
        .sort((a, b) => a.start - b.start);
      const reach = [-1];
      const reacher = [-1];
      const next = [-1];
      sorted.forEach(({ end }, at) => {
        const furthest = reach.at(-1)!;
        reach.push(Math.max(furthest, end));
        reacher.push(end > furthest ? at : reacher.at(-1)!);
        next.push(end > furthest ? furthest : Math.max(next.at(-1)!, end));
      });
      found = { sorted, reach, reacher, next };
      sites.set(file, found);
    }
    return found;
  };
  const linesOf = (file: number): number[] => {
    let found = starts.get(file);
    if (found === undefined) {
      found = [0];
      const text = sources[file] ?? "";
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
        found.push(at + 1);
      starts.set(file, found);
    }
    return found;
  };
  // the index of the last line start at or before the site, by binary search
  const lineIndex = (site: SourceSite): number => {
    const lines = linesOf(site.file);
    let low = 0;
    let high = lines.length;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (lines[middle]! <= site.start) low = middle;
      else high = middle;
    }
    return low;
  };
  const line = (site: SourceSite): number => lineIndex(site) + 1;
  const statement = (use: SourceSite, read: SourceSite): SourceSite | null => {
    const found = statementsOf(use.file).get(line(use) - 1);
    if (found === undefined) return null;
    // the innermost around the use: from the last that starts at or before it, out through those around that one
    let low = 0;
    let high = found.statements.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (found.statements[middle]!.span.start.offset <= use.start) low = middle + 1;
      else high = middle;
    }
    let at = low - 1;
    while (at !== -1 && !holds(found.statements[at]!.span, use)) at = found.around[at]!;
    const held = at === -1 ? undefined : found.statements[at];
    return held === undefined || UNGUARDED.has(held.kind) || !guards(held, use, read)
      ? null
      : { file: use.file, start: held.span.start.offset, end: held.span.end.offset };
  };
  // the values statements give their variables, each file's in start order, gathered once
  const givens = new Map<number, Given[]>();
  const givensOf = (file: number): Given[] => {
    let found = givens.get(file);
    if (found === undefined) {
      const list: Given[] = [];
      someNode(programOf(file), (node) => {
        if (node.kind !== "program" && node.kind !== "block") return false;
        // EVIDENCE: invariant: a parser-owned node whose kind is `program` or `block` holds its statements.
        for (const statement of (node as Program | Block).statements)
          // (a global with `default:` gives its value through the assignment it holds)
          for (const each of statement.kind === "globalStatement" && statement.assignment !== null
            ? [statement, statement.assignment]
            : [statement]) {
            const given = givenBy(each);
            if (given !== null) list.push(given);
          }
        return false;
      });
      list.sort((a, b) => a.value.span.start.offset - b.value.span.start.offset);
      givens.set(file, (found = list));
    }
    return found;
  };
  const landing = (site: SourceSite): Landing | null => landingOf(givensOf(site.file), site);
  return {
    text: (site) => (sources[site.file] ?? "").slice(site.start, site.end),
    landing,
    target: (site) =>
      statementsOf(site.file)
        .get(line(site) - 1)
        ?.statements.some((statement) => inTarget(statement, site)) === true,
    line,
    column: (site) => site.start - linesOf(site.file)[lineIndex(site)]!,
    statement,
    alone: (self, held, rulesOut) => {
      const { sorted, reach, reacher, next } = sitesOf(held.file);
      // (one that starts before the text and reaches into it, then those that start in it, until another)
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle]!.start < held.start) low = middle + 1;
        else high = middle;
      }
      if ((sorted[reacher[low]!]?.diagnostic === self ? next[low]! : reach[low]!) > held.start)
        return false;
      for (let at = low; at < sorted.length && sorted[at]!.start < held.end; at += 1) {
        const other = sorted[at]!.diagnostic;
        const ruledOut =
          other === self ||
          (rulesOut !== null &&
            other.site.start === self.site.start &&
            other.site.end === self.site.end &&
            other.kind !== "written-type" &&
            other.kind !== "budget" &&
            other.kind !== "static" &&
            other.kinds.length > 0 &&
            other.kinds.every(rulesOut));
        if (!ruledOut) return false;
      }
      return true;
    },
  };
}

/** The code of a rule (D3): its one code in the registry, an error where proved and a warning where checked. */
export function codeOf(rule: DiagnosticRule): CoreCode {
  switch (rule.rule) {
    case "store":
    case "fallback":
      return "TSV041";
    case "count":
      return rule.use === "repeat" ? "TSV011" : "TSV043";
    case "shown":
      return "TSV042";
    case "iterable":
      return "TSV012";
    case "mixed":
      return "TSV044";
    case "choice":
      return "TSV029";
    case "elements":
      return rule.callee === "join" ? "TSV042" : "TSV043";
    default:
      return "TSV043";
  }
}

/**
 * The code of a check that owes the runtime nothing (`StaticRule`): the code its kept sentence has under the current
 * checker and the runtime.
 */
export function staticCode(rule: StaticRule): CoreCode {
  switch (rule.rule) {
    case "repeat-count":
      return "TSV011";
    case "conversion":
      return "TSV043";
    case "empty-range":
      return "TSV046";
    case "calendar-offset":
      return "TSV043";
  }
}

/** The message of a check that owes the runtime nothing: its rule's sentence, the one the runtime's check gives. */
function staticMessage(rule: StaticRule): string {
  switch (rule.rule) {
    case "repeat-count":
      return repeatCountMessage("this", describeShownValue(rule.value), repeatCountFix(rule.value));
    case "conversion": {
      const conversion = CONVERSIONS[rule.conversion];
      if (conversion.takes !== "value") throw new Error(`${rule.conversion} converts no value.`);
      return cannotConvert(rule.conversion, conversion, rule.text);
    }
    case "calendar-offset":
      return localCalendarOffsetMessage(rule.target, rule.duration);
    case "empty-range": {
      // (the current checker's sentence, V30 §6)
      const { start, end, inclusive } = rule;
      const operator = inclusive ? "..=" : "..";
      const reason =
        start === end
          ? `'${start}${operator}${end}' excludes its end. Write '${start}..=${end}' for the single number ${start}.`
          : `a range never counts down. Write '${end}${operator}${start}' to count up.`;
      return `This range contains no numbers, so ${rule.use === "loop" ? "the loop never runs" : "toList() returns []"}: ${reason}`;
    }
  }
}

/** A diagnostic's message: its first sentence, and a warning's consequence, fix and cause after it. */
export function coreMessage(diagnostic: CheckedDiagnostic, source: MessageSource): string {
  // (whether the values it names and its store's declaration reads are there when the script runs, unproved where it
  // does not say; whether its program runs at all; and whether an author's text a form holds lies clear of the other
  // diagnostics: TABLE r4.162, r4.168)
  const alone = (held: SourceSite, rulesOut: ((kind: ItemTag) => boolean) | null): boolean =>
    source.alone(diagnostic, held, rulesOut);
  if (diagnostic.kind === "written-type")
    return writtenTypeMessage(diagnostic, source, {
      present: "unproved",
      severity: "error",
      alone,
    });
  if (diagnostic.kind === "budget") return budgetMessage(diagnostic, source);
  if (diagnostic.kind === "static") return staticMessage(diagnostic.rule);
  const text = source.text(diagnostic.site);
  const { rule, kinds } = diagnostic;
  const diagnosed: Diagnosed = {
    present: diagnostic.present ?? "unproved",
    severity: diagnostic.class === "compile-error" ? "error" : "warning",
    alone,
  };
  if (diagnostic.class === "compile-error")
    return errorSentence(rule, text, kinds, source, diagnostic.site, diagnostic.expects, diagnosed);
  const { context, detail } = diagnostic.provenance;
  // a member's context is its receiver's: `value` in `value[0]` comes from outside the script; a selection's, its
  // collection's
  const name =
    rule.rule === "member" || rule.rule === "elements"
      ? rule.receiver
      : rule.rule === "selection"
        ? rule.collection
        : rule.rule === "choice" && rule.member !== undefined && rule.within !== true
          ? `${text}.${rule.member}`
          : text;
  const sentences = [
    warningSentence(rule, text, kinds, source, context, detail),
    warningFix(
      rule,
      text,
      kinds,
      diagnostic.fits,
      diagnostic.besides,
      detail,
      context,
      source,
      diagnostic.site,
      diagnostic.expects,
      diagnosed,
    ),
  ];
  // a warning whose value has no word of its own (an exact value the rule still checks) has no cause; `later`'s first
  // sentence names the deciding line, and a member's missing property is its first sentence
  // (a member's missing property is its first sentence, and another rule's at that read repeats the member's warning)
  const missing = context === "missing" && (rule.rule === "member" || detail.direct);
  // (a literal subject has no origin of its own: its warning is its receiver's, `0` in `value.get(0, ...)`)
  const literal = rule.rule !== "member" && isLiteral(text);
  // (a speaker alone: a property store's first sentence says what happens, and a method call's fix that a speaker has
  // none, which no cause changes; Astra r3, Sol r7)
  const holder = detail.receiver?.kinds ?? kinds;
  const speaker =
    rule.rule === "member" &&
    (setsProperty(rule) || rule.member.endsWith("()")) &&
    holder.length > 0 &&
    holder.every((kind) => kind === "speaker");
  // (the elements a call reads have their own origins, which the receiver's name does not carry)
  if (
    !(context === "unknown" && !detail.outside) &&
    context !== "later" &&
    !missing &&
    !speaker &&
    !literal &&
    rule.rule !== "elements"
  )
    // a word that came with a value from another line speaks of that value's origin, never of this line's names
    sentences.push(
      detail.direct
        ? contextSentence(context, name, detail, rule.rule === "selection" ? ["empty"] : kinds)
        : // (a member's `missing` is the member's own value, from a property read elsewhere)
          originSentence(context, context === "missing" ? text : name),
    );
  return sentences.filter((sentence) => sentence !== "").join(" ");
}

// ------------------------------------------------------------------------------------------- causes

const HANDLER_RUNS: Readonly<Record<NonNullable<ContextDetail["handler"]>, string>> = {
  button: "the button is pressed",
  timer: "its timer expires",
  media: "its media ends or reaches its cue",
};

/**
 * The cause of a warning whose word came with its value from another line (a copy, a projection, a call, an
 * operation): where that value comes from, by the word, never naming this line's read as the word's own subject.
 */
function originSentence(word: ContextWord, name: string): string {
  const from = `'${name}' gets its value from`;
  switch (word) {
    case "label":
      return `${from} a line that is also reached by a 'goto'.`;
    case "later":
    case "unknown":
      return `'${name}' comes from outside the script, so its type is known only when the script runs.`;
    case "missing":
      return `${from} a property that an object may lack.`;
    case "branch":
      return `${from} an 'if' or another branch, so which value it gets depends on which branch runs.`;
    case "call":
      return `${from} a place that a function or a file the script calls may change.`;
    case "dead-code":
      return `${from} a line that never runs.`;
    case "deferred-parameter":
      return `${from} a parameter of a function called from more than one place.`;
    case "handler":
      return `${from} a place that a button, timer, or media block may change.`;
    case "loop":
      return `${from} a variable that may change in an earlier round of a loop.`;
    case "member":
      return `${from} a list element or a part of another value.`;
    // (the word also covers an object's own `first` and opaque operations: no reference is established)
    case "unmodelled":
      return `The type of '${name}' is known only when the script runs.`;
    case "budget":
      return `Checking '${name}' here before the script plays would take too long, so it is checked when the script runs.`;
  }
}

/** A warning's cause: why the value may be of another type at this line (§3.4), its word the read's own. */
function contextSentence(
  word: ContextWord,
  name: string,
  detail: ContextDetail,
  kinds: readonly ItemTag[],
): string {
  switch (word) {
    case "label":
      return detail.label === null
        ? `This line is also reached by a 'goto', and '${name}' may change before that jump.`
        : `This line is also reached by 'goto ${detail.label}', and '${name}' may change before that jump.`;
    case "later":
      return "";
    case "missing":
      return detail.receiver === null
        ? `'${name}' may come from an object that has no such property.`
        : `'${detail.receiver.text}' may hold an object that has no '${detail.receiver.member}' property.`;
    case "branch":
      return (
        `'${name}' is set inside an 'if' or another branch, so which value reaches this line depends on which ` +
        "branch runs."
      );
    case "call":
      return detail.callable === null
        ? `'${name}' may be changed by a function or a file the script calls before this line.`
        : `'${name}' is set outside '${detail.callable}', before '${detail.callable}' is called.`;
    case "dead-code":
      return "This line never runs.";
    case "deferred-parameter":
      return detail.callable === null
        ? `'${name}' is a parameter of a function called from more than one place.`
        : `'${detail.callable}' is called from more than one place, so '${name}' may hold another type in each ` +
            "call.";
    case "handler":
      return detail.handler === null
        ? `A button, timer, or media block may run before this line and change '${name}'.`
        : `This block runs when ${HANDLER_RUNS[detail.handler]}, and '${name}' may change inside it before this ` +
            "line.";
    case "loop":
      return `'${name}' may change in an earlier round of this loop.`;
    case "member": {
      const container = detail.receiver?.kinds.find(
        (kind) => kind === "list" || kind === "set" || kind === "dict",
      );
      if (container === undefined) return "";
      // (a selection's collection: an element that may be empty)
      const may = kinds.includes("empty") ? "empty" : described(kinds);
      return container === "dict"
        ? `'${name}' is a dict value, and any value of the dict may be ${may}.`
        : `'${name}' is a ${container} element, and any element of the ${container} may be ${may}.`;
    }
    case "unknown":
      return `'${name}' comes from outside the script, so its type is known only when the script runs.`;
    case "budget":
      return `Checking '${name}' here before the script plays would take too long, so it is checked when the script runs.`;
    case "unmodelled": {
      // (the warning's own kind where it is a reference: one warning per reference kind of a union)
      const reference =
        kinds.find((kind) => REFERENCE.has(kind)) ??
        detail.receiver?.kinds.find((kind) => REFERENCE.has(kind));
      return reference === undefined || detail.receiver === null
        ? `The type of '${name}' is known only when the script runs.`
        : // (one reference type of several the receiver may hold: it may be that one)
          `'${detail.receiver.text}' ${detail.receiver.kinds.every((kind) => kind === reference) ? "is" : "may be"} ` +
            `${described([reference])}, whose properties are known only when the script runs.`;
    }
  }
}
