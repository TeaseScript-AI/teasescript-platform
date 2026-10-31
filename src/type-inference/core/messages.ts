import type { Block, Program } from "../../ast.js";
import { parse } from "../../parser.js";
import { someNode } from "../../project-globals.js";
import type { SourceSite } from "../graph.js";
import { CONVERSIONS, WRITABLE_JSON_FIX } from "../../conversions.js";
import { dictMethod } from "../../dict-operations.js";
import { localCalendarOffsetMessage } from "../../duration.js";
import { listMethod } from "../../list-methods.js";
import { repeatCountFix, repeatCountMessage, ROUND_COUNT_FIX } from "../../loop-rules.js";
import { cannotConvert, describeShownValue } from "../../runtime/values/value-types.js";
import { JOIN_FIX } from "../../shown-text-rules.js";
import { PERSON_FIELDS, PLAYER } from "../../speaker-terms.js";
import { hasIdentity } from "../../value-kinds.js";
import { originOf } from "./consumers/origins.js";
import { REFERENCE } from "./contract.js";
import type { ContextWord, ItemTag } from "./items.js";
import type {
  BudgetStop,
  CheckedDiagnostic,
  ContextDetail,
  CoreCode,
  DiagnosticRule,
  NotChecked,
  SiteExpectation,
  StaticRule,
  StoreStep,
  WorkPlace,
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
import {
  argumentFixOf,
  capitalized,
  choiceSubject,
  described,
  isLiteral,
  known,
  memberNoun,
  mixedTypes,
  operandRule,
  operandText,
  ownText,
  pathPhrase,
  plural,
  setsProperty,
  SORT_ONE_TYPE,
  stablePath,
  typeText,
  variable,
} from "./messages/words.js";
import { codeAt, type Diagnosed, UNPROVED } from "./messages/code-forms.js";
import { storeFix, type StoreRule, storeSubject } from "./messages/stores.js";
import {
  choiceFix,
  conditionFix,
  errorSentence,
  joined,
  joinFix,
  keyFix,
  memberFix,
  temporalFix,
  writtenTypeMessage,
} from "./messages/errors.js";
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

/** The consequence of a warning's check failing, after the warning's first sentence. */
const STOPS = "the Tease stops with an error at this line.";

function warningSentence(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
  context: ContextWord,
  detail: ContextDetail,
): string {
  const may = `may be ${described(kinds)} here. If it is, ${STOPS}`;
  switch (rule.rule) {
    case "store":
      return `${storeSubject(rule, source, context === "later")}, but '${text}' ${may}`;
    case "fallback":
      return (
        `The ${rule.fallback ? "fallback" : "default"} '${text}' stands in for ${described(rule.type)}, but ` +
        `'${text}' ${may}`
      );
    case "member": {
      const noun = memberNoun(rule.member);
      if (kinds.includes("null")) return `'${rule.receiver}' may be null here. If it is, ${STOPS}`;
      if (kinds.length > 0 && kinds.every((kind) => kind !== "unknown" && !REFERENCE.has(kind)))
        return `'${rule.receiver}' may be ${described(kinds)} here, which has no ${noun}. If it is, ${STOPS}`;
      if (context === "missing")
        return `'${rule.receiver}' may hold an object without ${noun} here. If it does, ${STOPS}`;
      // (only a property is set by a store: a method is called, an element stored at its index)
      const settable = setsProperty(rule);
      // a property store into a speaker gives it the property when the script runs; one into an object without it stops
      const holder = detail.receiver?.kinds ?? kinds;
      if (settable && (kinds.includes("speaker") || holder.includes("speaker")))
        return holder.every((kind) => kind === "speaker")
          ? `'${rule.receiver}' may not have ${noun} here. A speaker takes the property when the script runs.`
          : `'${rule.receiver}' may not have ${noun} here. If it is an object without '${rule.member.slice(1)}', ` +
              `${STOPS} A speaker takes the property.`;
      return `'${rule.receiver}' may not have ${noun}${settable ? " that can be set" : ""} here. If it does not, ${STOPS}`;
    }
    case "selection":
      return `'${rule.collection}' may be empty here. If it is, ${STOPS}`;
    case "operator":
      return rule.operand
        ? `${operandRule(rule, text)}, but '${text}' ${may}`
        : `'${rule.operator}' may not take the values in '${text}' here. If it does not, ${STOPS}`;
    case "json":
      return `'${text}' may ${rule.nested ? "hold" : "be"} ${described(kinds)} here, which toJson(...) cannot write. If it ${rule.nested ? "does" : "is"}, ${STOPS}`;
    case "choice":
      return `${operandRule(rule, text)}, but ${choiceSubject(rule, text)} ${may}`;
    case "elements":
      return rule.families.length > 1
        ? `${SORT_ONE_TYPE}, but '${rule.receiver}' may hold ${mixedTypes(rule.families)} here. If it does, ${STOPS}`
        : `${operandRule(rule, text)}, but '${rule.receiver}' may hold ${known(kinds).length > 0 ? plural(kinds) : "values of another type"} here. If it does, ${STOPS}`;
    case "absent":
    case "mixed":
      throw new Error(`The rule '${rule.rule}' gives errors only.`);
    default:
      return `${operandRule(rule, text)}, but '${text}' ${may}`;
  }
}

/** The fallback a null check names beside it: code to write, a fallback of the value's type in words, or none. */
type Fallback = { readonly code: string } | "words" | null;

/**
 * The fallback a null check names beside it (ADR 0021 rule 1.9, owner decisions on #850 and #1268), of the value's
 * types that fit its use (`fits`), so that `otherwise` takes it (V30 §18) and the use too, else of the types the use
 * takes: `0` for numbers, `""` for text, `false` for true or false. Where none can be written, as for a list, set, dict
 * or object, or where the value has another type the use does not take (`besides`, a union) or another problem in its
 * text (not `alone`), the words say to give one of the same type; none for a handle, which has no value to write.
 */
function fallbackValue(
  kinds: readonly ItemTag[],
  besides: readonly ItemTag[],
  alone: boolean,
): Fallback {
  const found = known(kinds).filter((kind) => kind !== "null");
  if (found.some((kind) => hasIdentity(kind))) return null;
  // (a fallback for null alone leaves the use invalid beside another type the use does not take, as in a union, or
  // beside another problem of the value there, another diagnostic in its text)
  if (besides.length > 0 || !alone) return "words";
  const every = (...names: ItemTag[]): boolean =>
    found.length > 0 && found.every((kind) => names.includes(kind));
  return every("integer", "number")
    ? { code: "0" }
    : every("string")
      ? { code: '""' }
      : every("boolean")
        ? { code: "false" }
        : "words";
}

/** A test a check makes of a value: as code of the value (`n != null`, `n is integer`), and in words (`is not null`). */
interface Test {
  readonly code: (value: string) => string;
  readonly words: string;
  /** Whether the test rules out a value of the type (`MessageSource.alone`). */
  readonly rulesOut: (kind: ItemTag) => boolean;
}

const NOT_NULL: Test = {
  code: (value) => `${value} != null`,
  words: "is not null",
  rulesOut: (kind) => kind === "null",
};

/** A length check, which rules out an empty collection. */
const NOT_EMPTY: Test = {
  code: (value) => `${value}.length > 0`,
  words: "is not empty",
  rulesOut: (kind) => kind === "empty",
};

/** The type test of `kinds` (ADR 0021 rule 3.5), where a written type names them; else `null`. */
function typeTest(kinds: readonly ItemTag[]): Test | null {
  const type = typeText(kinds);
  return type === null
    ? null
    : {
        code: (value) => `${value} is ${type}`,
        words: `is ${described(kinds)}`,
        rulesOut: (kind) => !kinds.includes(kind),
      };
}

/** The use a check makes safe: the diagnostic's site and facts, and the source that finds the statement around it. */
interface Use {
  readonly source: MessageSource;
  readonly site: SourceSite;
  readonly diagnosed: Diagnosed;
}

/**
 * The statement a check holds (#1268, TABLE r4.146): the statement of the use at `site` (`MessageSource.statement`),
 * with the subject's read in it (`read`), and its text as the check holds it: with `value` in the place of `subject`
 * where the fix keeps the subject in a new variable first and the statement reads it once (another read would stay
 * unchecked); else `null`.
 */
function guarded(
  source: MessageSource,
  site: SourceSite,
  subject: string,
  kept: boolean,
): { readonly statement: SourceSite; readonly read: SourceSite; readonly text: string } | null {
  // (the subject the use reads: its first text inside the use's own, a receiver's or a collection's to the left)
  const at = source.text(site).indexOf(subject);
  if (at === -1) return null;
  const read = { file: site.file, start: site.start + at, end: site.start + at + subject.length };
  const statement = source.statement(site, read);
  if (statement === null) return null;
  const text = source.text(statement);
  if (!kept) return { statement, read, text };
  // (the place a store changes, a compound assignment's target among them, is no value a kept one may replace: G2)
  if (source.target(read)) return null;
  // (its only text in the statement)
  const from = read.start - statement.start;
  return text.indexOf(subject) !== from || text.includes(subject, from + 1)
    ? null
    : { statement, read, text: `${text.slice(0, from)}value${text.slice(from + subject.length)}` };
}

/**
 * The check `test` of `subject` around the statement of the use (`guarded`), and where `kept` the subject's `let` on a
 * line before it, which moves its read there: each where `codeAt` proves it in a statement's place, its text clear of
 * the other diagnostics but those of only the types the test rules out (TABLE r4.162); else `null`, and the fix names
 * the check in words. The statement's own reads stay where they stand, the kept one first of all it evaluates
 * (`guards`), so a warning's reads are its own (TABLE r4.168).
 */
function guardForms(
  use: Use,
  subject: string,
  kept: boolean,
  test: Test,
): { readonly check: string; readonly keep: string | null } | null {
  const held = ownText(subject) ? guarded(use.source, use.site, subject, kept) : null;
  if (held === null) return null;
  const form = (code: string, holds: SourceSite): string | null =>
    codeAt(
      {
        code,
        takes: [],
        diagnosed: use.diagnosed,
        reads: "own",
        holds: [holds],
        rulesOut: test.rulesOut,
        gives: [],
        elements: [],
        writes: false,
      },
      "statement",
    );
  const check = form(`if ${test.code(kept ? "value" : subject)} { ${held.text} }`, held.statement);
  const keep = kept ? form(`let value = ${subject}`, held.read) : null;
  return check === null || (kept && keep === null) ? null : { check, keep };
}

/**
 * The check that makes a use safe (ADR 0021 rules 1.9 and 3.5): of a variable directly, of any other value kept in a
 * variable first, since only a variable narrows (rule 5), around the use's statement where `codeAt` proves it there
 * (`guardForms`), the kept value's `let` too, which moves its read; else in words, as where no test is written (`use`,
 * `null`). For null with a fallback where it has one, written where `codeAt` proves it in the subject's place, else in
 * words: of the same type where no value of one type makes the use valid (`words`, V30 §18).
 */
function checkFix(
  text: string,
  test: Test,
  fallback: {
    readonly value: Exclude<Fallback, null>;
    readonly site: SiteExpectation;
    readonly at: SourceSite;
    readonly diagnosed: Diagnosed;
  } | null,
  use: Use | null,
): string {
  const name = variable(text);
  const forms = use === null ? null : guardForms(use, text, name === null, test);
  const check =
    name !== null
      ? forms === null
        ? `Check that '${name}' ${test.words} first`
        : `Check '${name}' first, as in '${forms.check}'`
      : forms === null
        ? `Keep '${text}' in a new variable and check that it ${test.words} first`
        : `Keep '${text}' in a new variable, as in '${forms.keep!}', and check it, as in '${forms.check}'`;
  if (fallback === null || !ownText(text)) return `${check}.`;
  const { value, site, at, diagnosed } = fallback;
  if (value === "words") return `${check}, or give a fallback of the same type with 'otherwise'.`;
  // (a value the fix writes in the subject's place, in parentheses where an operand or a receiver binds tighter, and
  // only where it does not divide: `codeAt`)
  const fix = codeAt(
    {
      code: `${operandText(text)} otherwise ${value.code}`,
      takes: [],
      diagnosed,
      reads: "own",
      holds: [at],
      rulesOut: null,
      gives: [],
      elements: [],
      writes: true,
    },
    site,
  );
  if (fix !== null) return `${check}, or give a fallback, as in '${fix}'.`;
  return site.divides === true
    ? `${check}, or give a fallback after 'otherwise' that does not lead to a division by zero.`
    : `${check}, or give a fallback after 'otherwise'.`;
}

/**
 * #1468: the fix of a store's place below the warned value, a property of what the value holds (ADR 0021 rule 1.4), in
 * words by construction, with no form and no value of its own (the lead's ruling after Codex r2). Where the checker's
 * definitions prove the value a load with a default (`originOf`, `loadOrigin`), that load's default given the
 * property by its way from the load, of the place's type, which its reader then takes where the stored property misfits
 * or is missing; anything else
 * gives no check that discharges the warning (a property's check does not reach a copy of the whole object, Astra r1's
 * A1, #1496), so the words say where the type must come from. `null` where the place is the value itself or its
 * element, whose own check is the fix.
 */
function propertyFix(
  rule: StoreRule,
  text: string,
  site: SourceSite,
  source: MessageSource,
): string | null {
  if (!rule.steps.some((step) => "property" in step)) return null;
  const type = described(rule.type);
  const otherwise = `Give ${rule.into} ${type} where '${text}' gets its value.`;
  const landing = source.landing(site);
  const above = landing?.steps ?? [];
  const same = (a: StoreStep, b: StoreStep): boolean =>
    "property" in a
      ? "property" in b && a.property === b.property
      : "collection" in b && a.collection === b.collection;
  if (
    landing === null ||
    rule.root === null ||
    rule.root.kind === "result" ||
    landing.root !== rule.root.name ||
    above.length > rule.steps.length ||
    !above.every((step, index) => same(step, rule.steps[index]!))
  )
    return otherwise;
  const below = rule.steps.slice(above.length);
  if (!below.some((step) => "property" in step)) return null;
  const found = originOf(rule);
  // (a type with null takes no default that discharges yet: a value of its other type narrows what the place takes,
  // and a default's `null` does not yet prove the property, #1470)
  if (found === undefined || rule.type.includes("null")) return otherwise;
  // (the property by its way below the load where only properties lead there, else by its way from the variable that
  // holds the load)
  const named = pathPhrase(
    {
      code: found.path.every((step) => step !== "element" && step !== "entry") ? "" : found.holder,
    },
    found.path,
  );
  return `Give ${named} ${type} in the default of '${source.text(found.load)}'.`;
}

/** The kinds a rule takes, where a value's own kinds that fit are not known (an unknown value). */
function ruleKinds(rule: DiagnosticRule): readonly ItemTag[] {
  switch (rule.rule) {
    case "count":
      return ["integer"];
    case "boolean":
      return ["boolean"];
    case "key":
      return ["string"];
    case "store":
    case "fallback":
      return rule.type.filter((kind) => kind !== "null");
    case "operator":
    case "argument":
      return rule.domain;
    default:
      return [];
  }
}

/**
 * A warning's fix: a null check for null, the count's rounding for a number (S8c's), the selection's length check; a
 * type test where the value has other kinds that fit or is unknown; else the fix of the error the kind would be.
 */
function warningFix(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  fits: readonly ItemTag[],
  besides: readonly ItemTag[],
  detail: ContextDetail,
  context: ContextWord,
  source: MessageSource,
  site: SourceSite,
  expects: SiteExpectation | undefined,
  diagnosed: Diagnosed,
): string {
  const subject = rule.rule === "member" ? rule.receiver : text;
  // (the elements a call reads, and what toJson writes below its argument: no test of the value read fixes them; join's
  // elements of a known type are selected from)
  if (rule.rule === "elements")
    return rule.callee === "join" && known(kinds).length > 0 && !kinds.includes("unknown")
      ? JOIN_FIX
      : "";
  if (rule.rule === "json" && rule.nested) return WRITABLE_JSON_FIX;
  // (a store's place that is no variable, a compound assignment's target among them, is checked where it stands, in
  // words: a new variable would take the change instead, G2)
  const inPlace = (test: Test): string | null =>
    source.target(site) && variable(subject) === null
      ? `Check that '${subject}' ${test.words} first.`
      : null;
  if (kinds.includes("null")) {
    // (no fallback for a value a store or a method changes in place, a compound assignment's target among them: the
    // change would be lost)
    const changed =
      source.target(site) ||
      (rule.rule === "member" &&
        (rule.use === "store" ||
          (rule.use === "call" &&
            (listMethod(rule.member.slice(1, -2))?.changes !== undefined ||
              dictMethod(rule.member.slice(1, -2))?.changes !== undefined))));
    // (another diagnostic in the value's text is another problem of it at this use, beside which a fallback for null
    // alone leaves the use invalid, as `besides` says of one at its own site: V30 §18's words of the same type)
    const fallback = changed
      ? null
      : fallbackValue(
          fits.length > 0 ? fits : ruleKinds(rule),
          besides,
          diagnosed.alone(site, null),
        );
    // (a fallback of the value's own kinds that the rule takes, rule 1.9, fits where the value does: its site adds how
    // it binds there and whether the value divides)
    const binds =
      rule.rule === "operator" || (rule.rule === "boolean" && rule.operator !== null)
        ? "operand"
        : rule.rule === "member"
          ? "receiver"
          : "whole";
    // (beside another type the use does not take, a null check alone leaves the use invalid: the type test of the
    // value's types the use takes rules out both, else the check in words, #1268 after Codex r4)
    const test = besides.every((kind) => fits.includes(kind)) ? NOT_NULL : typeTest(fits);
    const placed = inPlace(test ?? NOT_NULL);
    if (placed !== null) return placed;
    return checkFix(
      subject,
      test ?? NOT_NULL,
      fallback === null
        ? null
        : {
            value: fallback,
            site: {
              takes: null,
              binds,
              elements: "unproved",
              divides: expects?.divides ?? "unproved",
            },
            at: site,
            diagnosed,
          },
      test === null ? null : { source, site, diagnosed },
    );
  }
  switch (rule.rule) {
    case "selection": {
      // (a check of the collection itself only where reading it again gives the same one; any other is kept first, as
      // `groups.random` or a call, so the check and the read see one selection, Astra r2; around the read's statement
      // where it holds there, #1268, the kept value's `let` with it)
      const { collection } = rule;
      const stable = stablePath(collection);
      const forms = guardForms({ source, site, diagnosed }, collection, !stable, NOT_EMPTY);
      if (stable)
        return forms === null
          ? `Check the length of '${collection}' first.`
          : `Check '${collection}.length' first, as in '${forms.check}'.`;
      return forms === null
        ? `Keep '${collection}' in a new variable and check its length first.`
        : `Keep '${collection}' in a new variable, as in '${forms.keep!}', and check its length, as in ` +
            `'${forms.check}'.`;
    }
    case "count":
      if (kinds.includes("number")) return ROUND_COUNT_FIX.trimStart();
      break;
    case "store":
      if (rule.type.includes("integer") && kinds.includes("number"))
        return storeFix(rule, kinds, text, site, source, diagnosed).trimStart();
      break;
    case "operator": {
      // (the repairs of the error the values would be: a text join, a date and time conversion)
      const join = joined(rule, text, kinds, fits, source);
      if (join !== null) return joinFix(join, site, !rule.operand, expects ?? UNPROVED, diagnosed);
      const temporal = temporalFix(
        rule,
        kinds,
        source,
        site,
        expects ?? UNPROVED,
        diagnosed,
      ).trimStart();
      if (temporal !== "" || !rule.operand) return temporal;
      break;
    }
    case "member":
      return memberWarningFix(rule, text, kinds, fits, detail, source, site, diagnosed);
    default:
      break;
  }
  // (a button's value from outside the script: a test of the types the other buttons' values hold is narrower than the
  // rule, and a kept option does not narrow its property)
  if (rule.rule === "choice" && kinds.includes("unknown")) return "";
  // (a value of a type the script cannot know: tested where a test can name the type; a literal is known, and a
  // property an object may lack fails at its read, before any test)
  if (kinds.includes("unknown") && fits.length === 0) {
    const test = typeTest(ruleKinds(rule));
    // (a store's place below the value, a property of what it holds: that property's fix, #1468)
    const property =
      rule.rule === "store" && !isLiteral(text) && context !== "missing"
        ? propertyFix(rule, text, site, source)
        : null;
    if (property !== null) return property;
    return test === null || isLiteral(text) || context === "missing"
      ? ""
      : (inPlace(test) ?? checkFix(subject, test, null, { source, site, diagnosed }));
  }
  // (no test where the read itself stops, a property an object may lack, nor of a literal, whose type is its own)
  if (isLiteral(text) || context === "missing") return "";
  const test = typeTest(fits);
  if (test !== null)
    return inPlace(test) ?? checkFix(subject, test, null, { source, site, diagnosed });
  return errorFix(rule, text, kinds, site, source, diagnosed).trimStart();
}

/** The fix of the error a value of `kinds` would be, for a warning whose value has no kind that fits. */
function errorFix(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  site: SourceSite,
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  switch (rule.rule) {
    case "store":
      return storeFix(rule, kinds, text, site, source, diagnosed);
    case "boolean":
      return conditionFix(rule, text, kinds, site, diagnosed);
    case "key":
      return keyFix(text, kinds, site, diagnosed);
    case "argument":
      return argumentFixOf(rule, kinds, text);
    case "elements":
      return rule.callee === "join" ? ` ${JOIN_FIX}` : "";
    case "json":
      return ` ${WRITABLE_JSON_FIX}`;
    case "choice":
      return choiceFix(rule, kinds, text);
    default:
      return "";
  }
}

/**
 * A member warning's fix: a type test for a receiver of another kind beside kinds that have the member, the member's
 * own fix where none has it; for a speaker's property the current checker's: assign it, or copy the player profile.
 */
function memberWarningFix(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  text: string,
  kinds: readonly ItemTag[],
  fits: readonly ItemTag[],
  detail: ContextDetail,
  source: MessageSource,
  site: SourceSite,
  diagnosed: Diagnosed,
): string {
  // (the warning's own reference kind: one warning per reference kind of a union)
  const speaker =
    (kinds.find((kind) => REFERENCE.has(kind)) ??
      detail.receiver?.kinds.find((kind) => REFERENCE.has(kind))) === "speaker";
  if (speaker && rule.member.startsWith(".")) {
    const name = rule.member.slice(1);
    if (rule.member.endsWith("()"))
      // (no property named: a speaker has those its script gives it, Codex r4)
      return "A speaker has no methods. Use one of its properties instead.";
    if (rule.use !== "read") return "";
    // (the value to assign is the author's own: no placeholder, #1268; the copy on a line of its own, where the player
    // and the player profile are always there)
    const copy =
      rule.receiver === PLAYER && PERSON_FIELDS.has(name)
        ? codeAt(
            {
              code: "player.copyFrom(playerProfile)",
              takes: [],
              diagnosed: { ...diagnosed, present: true },
              reads: "added",
              holds: [],
              rulesOut: null,
              gives: [],
              elements: [],
              writes: false,
            },
            "statement",
          )
        : null;
    if (rule.receiver === PLAYER && PERSON_FIELDS.has(name))
      return copy === null
        ? `Copy the player profile at the start of the script, or assign 'player.${name}' first.`
        : `Copy the player profile before this line, as in '${copy}' at the start of the script, or assign ` +
            `'player.${name}' first.`;
    return stablePath(rule.receiver)
      ? `Assign '${rule.receiver}.${name}' before this line.`
      : "Assign the property before this line.";
  }
  // (a reference's own members are the runtime's: no test narrows them)
  const lacking = known(kinds);
  if (lacking.length === 0 || lacking.some((kind) => REFERENCE.has(kind))) return "";
  const test = typeTest(fits.filter((kind) => !kinds.includes(kind)));
  return test !== null
    ? checkFix(rule.receiver, test, null, { source, site, diagnosed })
    : memberFix(
        rule,
        kinds,
        text,
        site,
        UNPROVED,
        detail.receiver?.kinds ?? [],
        diagnosed,
      ).trimStart();
}

/** A place the stop names, with its lines: `'tally' (lines 3–9)`, `the top level of 'main.tease' (lines 1–40)`. */
function placeText(place: WorkPlace, source: MessageSource): string {
  const first = source.line(place.lines);
  const last = source.line({
    ...place.lines,
    start: Math.max(place.lines.start, place.lines.end - 1),
  });
  const lines = first === last ? `line ${first}` : `lines ${first}–${last}`;
  return `${place.name === null ? `the top level of '${place.path}'` : `'${place.name}'`} (${lines})`;
}

/**
 * The stop's warning and its "not checked (budget)" mark (the owner's D4, TABLE r4.54: the warning as the owner's
 * example words it; the nesting limit's in the same form).
 */
function budgetMessage(diagnostic: BudgetStop | NotChecked, source: MessageSource): string {
  const place = placeText(diagnostic.place, source);
  if (diagnostic.class === "not-checked-budget")
    return `${capitalized(place)} is not checked completely before the script plays, so its checks run while it plays.`;
  const count = diagnostic.deferred;
  const moved =
    count === 0
      ? ""
      : ` ${count} ${count === 1 ? "check runs" : "checks run"} while it plays instead.`;
  return diagnostic.limit === "nesting"
    ? `This script nests statements too deeply to check completely before it plays.${moved} The deepest nesting is ` +
        `in ${place}.`
    : `This script is too large to check completely before it plays.${moved} Most of the work went to ${place}.`;
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
