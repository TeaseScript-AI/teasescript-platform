import type { Block, Expression, Program, Statement } from "../../ast.js";
import { parse } from "../../parser.js";
import { someNode } from "../../project-globals.js";
import {
  changesAnything,
  type EffectFacts,
  functionEffects,
  methodEffects,
} from "../../runtime/evaluation/effect-facts.js";
import type { SourceSpan } from "../../source.js";
import type { SourceSite } from "../graph.js";
import { angleUnit } from "../../angle.js";
import { CONVERSIONS, conversionTo } from "../../conversions.js";
import { DICT_METHODS, DICT_PROPERTIES, dictMethod } from "../../dict-operations.js";
import { elapsedDurationUnit, UNIT_OPERANDS } from "../../duration.js";
import { expressionParts, statementExpressions } from "../../expression-children.js";
import { listDraw, listMethod } from "../../list-methods.js";
import { FOR_SOURCE_RULE, REPEAT_COUNT_RULE, ROUND_COUNT_FIX } from "../../loop-rules.js";
import { LIST_INDEX_RULE, logicalOperandRule } from "../../operand-rules.js";
import { misspelledPropertyHint, nameList } from "../../object-properties.js";
import { PERSON_FIELDS, PLAYER } from "../../speaker-terms.js";
import {
  CALENDAR_DURATION_PARTS,
  hasTemporalField,
  isTemporalKind,
} from "../../temporal-builtins.js";
import {
  isTextMember,
  isTextMethod,
  TEXT_METHODS,
  textMemberSuggestion,
} from "../../text-operations.js";
import { hasIdentity, VALUE_KIND_NAMES, VALUE_KINDS } from "../../value-kinds.js";
import { fits } from "./admission.js";
import { REFERENCE } from "./contract.js";
import { propertyName } from "./program.js";
import type { ContextWord, ItemTag } from "./items.js";
import type {
  BudgetStop,
  ContextDetail,
  CoreCode,
  CoreDiagnostic,
  DiagnosticRule,
  NotChecked,
  Presence,
  SiteExpectation,
  StoreRoot,
  WorkPlace,
  WrittenTypeError,
} from "./result.js";

/*
 * The sentences of the coarse core's diagnostics (the port plan's D1–D3, TABLE r4.53): each diagnostic's code is its
 * rule's (D3: one code, both severities where the rule warns), and its message is a first sentence per consumer and
 * obligation, in the source's own text (D2), and the fix the current checker gives (#1195). A warning says what may go
 * wrong, that the Tease then stops at its line, the fix, and a last sentence per context word (§3.4) that says in the
 * author's terms why the value may be of another type; the word itself is never shown. Single quotes for code, no
 * semicolons, no implementation terms, and "type", never "kind" (`docs/DIAGNOSTICS.md`, "Messages").
 */

/**
 * How a message names the source and what it knows of the analysis: the text at a site, the line it starts on
 * (1-based), its column (0-based), the statement a check may hold, and whether code a fix writes from the author's text
 * is proved where it is pasted, for the diagnostic the source is taken `of`.
 */
export interface MessageSource {
  readonly text: (site: SourceSite) => string;
  readonly line: (site: SourceSite) => number;
  readonly column: (site: SourceSite) => number;
  /**
   * The statement a check may hold, as in `if n != null { say n + 1 }`, for the use at `use` of the value at `read`
   * inside it: the innermost statement around the use that is one of a block's or a file's statements, on one line,
   * where a check before it still holds at the use (`evaluation`); else `null`.
   */
  readonly statement: (use: SourceSite, read: SourceSite) => SourceSite | null;
  /**
   * TABLE r4.162's default for every fix that writes code from the author's own text: it is proved where it is pasted
   * only where no other diagnostic of the analysis lies in that text, nor a region a stop left unchecked (its "not
   * checked" mark's), apart from one at the same site whose every type the fix's test rules out, and where the code's
   * result fits its use (`Proof`); an unproved fact gives words. Never proved without a diagnostic.
   */
  readonly proves: (proof?: Proof) => boolean;
  /** This source for one diagnostic of the analysis, whose fix `proves` judges. */
  readonly of: (diagnostic: CoreDiagnostic) => MessageSource;
}

/** What a fix's code must be proved of where it is pasted (`MessageSource.proves`). */
interface Proof {
  /** The author's text the code holds: the diagnostic's site unless given. */
  readonly embedded?: SourceSite;
  /** Whether the fix's test rules out a type, so that a diagnostic at the same site of only such types is its own. */
  readonly rulesOut?: (kind: ItemTag) => boolean;
  /**
   * Where the code replaces an expression the analysis gave no result for (an error's), so no use of it was checked:
   * the result the code gives there, a value `say` shows, text, or true or false. The use must then take it as written:
   * what a `say` shows or a `${...}` holds, or for true or false an `if`'s or a `while`'s condition, through parentheses
   * and, for text, `+` of a text after it (Codex r6). `operand`: the diagnostic's site is an operand of the expression.
   */
  readonly replaces?: { readonly result: "value" | "text" | "boolean"; readonly operand?: boolean };
}

/** An object of a parsed program: a node with a kind, read by key. */
type AstNode = Readonly<Record<string, unknown>> & { readonly kind: string };

/**
 * The statements a check may not hold: a name or a label one declares would end with the check's block, a return
 * there could end its function without a value, and a `while` tests its condition again after each pass, where a check
 * before it no longer holds.
 */
const UNGUARDED: ReadonlySet<Statement["kind"]> = new Set([
  "letStatement",
  "globalStatement",
  "functionDeclaration",
  "speakerDeclaration",
  "labelStatement",
  "returnStatement",
  "whileStatement",
]);

/** A line's statements on one line: in start order, the outer first, each with the index of the next one around it. */
interface LineStatements {
  readonly statements: Statement[];
  readonly around: number[];
}

/** Whether a span holds a site. */
const holds = ({ start, end }: SourceSpan, site: SourceSite): boolean =>
  start.offset <= site.start && site.end <= end.offset;

/** A site's key among a statement's nodes. */
const spanKey = (start: number, end: number): string => `${start}:${end}`;

/**
 * What a statement evaluates, in evaluation order (`expression-children.ts`), each node after its parts: whether a run
 * may skip it, whether it may change or draw anything itself (`acts`), and where its own parts begin. Prepared once per
 * statement, for each of its uses.
 */
interface Evaluation {
  readonly lazy: boolean[];
  readonly first: number[];
  /** How many nodes before each index act. */
  readonly acting: number[];
  /** The last node at each site. */
  readonly at: Map<string, number>;
}

const EVALUATIONS = new WeakMap<Statement, Evaluation>();

function evaluation(statement: Statement): Evaluation {
  const known = EVALUATIONS.get(statement);
  if (known !== undefined) return known;
  const lazy: boolean[] = [];
  const first: number[] = [];
  const acting = [0];
  const at = new Map<string, number>();
  const add = (node: Expression, skipped: boolean, start: number): void => {
    const index = lazy.length;
    lazy.push(skipped);
    first.push(start);
    acting.push(acting[index]! + (acts(node) ? 1 : 0));
    at.set(spanKey(node.span.start.offset, node.span.end.offset), index);
  };
  type Work =
    | { readonly node: Expression; readonly lazy: boolean; readonly parts: true }
    | {
        readonly node: Expression;
        readonly lazy: boolean;
        readonly parts: false;
        readonly start: number;
      };
  const work: Work[] = statementExpressions(statement)
    .map((node): Work => ({ node, lazy: false, parts: true }))
    .reverse();
  for (let entry = work.pop(); entry !== undefined; entry = work.pop()) {
    if (!entry.parts) {
      add(entry.node, entry.lazy, entry.start);
      continue;
    }
    const { node } = entry;
    const start = lazy.length;
    work.push({ node, lazy: entry.lazy, parts: false, start });
    for (const part of partsOf(node, entry.lazy).toReversed()) work.push({ ...part, parts: true });
  }
  // (a store through a member or an index takes effect after its value)
  if (statement.kind === "assignmentStatement" && statement.target.kind !== "identifier")
    add(statement.target, false, 0);
  const prepared = { lazy, first, acting, at };
  EVALUATIONS.set(statement, prepared);
  return prepared;
}

/**
 * Whether a check before `statement` still holds at the use at `use` of the value at `read` (#1268, Codex r4 and r5):
 * the statement evaluates the use whenever it runs (not after `and`, `or` or `otherwise`, nor in a `default:`), and
 * nothing it evaluates before the use, apart from the value read, may change or draw anything (`effect-facts.ts`), so
 * the check sees what the use sees and a value kept before it is the one the use would read. A value read that may
 * itself change or draw, the read included, is kept before the statement only where it is the first thing evaluated, so
 * that no draw or read before it, a text's placeholder's included, moves behind it.
 */
function guards(statement: Statement, use: SourceSite, read: SourceSite): boolean {
  const { lazy, first, acting, at } = evaluation(statement);
  const used = at.get(spanKey(use.start, use.end));
  const value = at.get(spanKey(read.start, read.end));
  if (used === undefined || value === undefined || lazy[used]) return false;
  // (the value read, its parts first, inside the use's own)
  const from = first[value]!;
  if (from < first[used]! || value > used) return false;
  // (before the value, and between it and the use, which evaluates its other parts there)
  const between = used > value ? acting[used]! - acting[value + 1]! : 0;
  const kept = acting[value + 1]! - acting[from]!;
  return (
    acting[from]! + between === 0 && (kept === 0 || from + Math.max(used - value - 1, 0) === 0)
  );
}

/** The operators whose right operand only some runs evaluate. */
const LAZY_RIGHT: ReadonlySet<string> = new Set(["and", "or", "otherwise"]);

/**
 * The parts of an expression in evaluation order (`expressionParts`), each with whether a run may skip it: the right
 * operand of `and`, `or` and `otherwise`, a `default:`.
 */
function partsOf(
  node: Expression,
  lazy: boolean,
): { readonly node: Expression; readonly lazy: boolean }[] {
  if (node.kind === "callExpression")
    return [
      { node: node.callee, lazy },
      ...(node.presentation === undefined ? [] : [{ node: node.presentation, lazy }]),
      ...node.arguments.map((argument) => ({
        node: argument.value,
        lazy: lazy || (argument.kind === "namedArgument" && argument.name.name === "default"),
      })),
    ];
  if (node.kind === "binaryExpression" && LAZY_RIGHT.has(node.operator))
    return [
      { node: node.left, lazy },
      { node: node.right, lazy: true },
    ];
  if (node.kind === "loadExpression")
    return [
      { node: node.key, lazy },
      ...(node.defaultValue === null ? [] : [{ node: node.defaultValue, lazy: true }]),
    ];
  return expressionParts(node).map((part) => ({ node: part, lazy }));
}
/**
 * Whether evaluating `node` itself may change or draw anything, as `effect-facts.ts` decides it for the runtime: a call
 * by its function or method, a read of a list's `random`, a text with values in it, a tag query; an ask, a say or
 * another command; anything else, a read, is pure.
 */
function acts(node: Expression): boolean {
  const effects = (facts: EffectFacts): boolean => changesAnything(facts) || facts.draws;
  switch (node.kind) {
    case "callExpression":
      return node.callee.kind === "identifier"
        ? effects(functionEffects(node.callee.name))
        : node.callee.kind === "propertyAccessExpression"
          ? effects(methodEffects(node.callee.property.name))
          : true;
    case "propertyAccessExpression":
      return listDraw(node.property.name, "property") !== undefined;
    case "stringLiteral":
      return node.parts.some((part) => part.kind === "stringInterpolation");
    case "identifier":
    case "numberLiteral":
    case "booleanLiteral":
    case "nullLiteral":
    case "durationLiteral":
    case "regexLiteral":
    case "parenthesizedExpression":
    case "listLiteral":
    case "setLiteral":
    case "objectLiteral":
    case "dictLiteral":
    case "indexExpression":
    case "unaryExpression":
    case "unitExpression":
    case "angleExpression":
    case "binaryExpression":
    case "rangeExpression":
    case "typeTestExpression":
    case "loadExpression":
      return false;
    default:
      return true;
  }
}

/**
 * The message source of a project's files and of their analysis's diagnostics: each file's text, its lines counted
 * once, its statements on one line by their line, each parsed once, and its diagnostics' sites in start order, each
 * on first need.
 */
export function messageSource(
  sources: readonly string[],
  diagnostics: readonly CoreDiagnostic[],
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
  // each file's nodes by their site, the innermost of a site, and what holds each node under which key
  const holders = new Map<
    number,
    {
      readonly at: Map<string, AstNode>;
      readonly holder: Map<AstNode, { readonly node: AstNode; readonly key: string }>;
    }
  >();
  const holdersOf = (file: number) => {
    let found = holders.get(file);
    if (found === undefined) {
      found = { at: new Map(), holder: new Map() };
      const { at, holder } = found;
      const work: {
        readonly value: unknown;
        readonly holds: AstNode | null;
        readonly key: string;
      }[] = [{ value: programOf(file), holds: null, key: "" }];
      for (let entry = work.pop(); entry !== undefined; entry = work.pop()) {
        const { value, holds, key } = entry;
        if (value === null || typeof value !== "object") continue;
        if (Array.isArray(value)) {
          for (const item of value) work.push({ value: item, holds, key });
          continue;
        }
        if (!("kind" in value) || typeof value.kind !== "string") continue;
        // EVIDENCE: invariant: a non-array object of the parsed program with a string `kind` is a node, read by key.
        const node = value as AstNode;
        if (holds !== null) holder.set(node, { node: holds, key });
        // EVIDENCE: invariant: a node of the parsed program has its span.
        const { start, end } = node["span"] as SourceSpan;
        at.set(spanKey(start.offset, end.offset), node);
        for (const [field, nested] of Object.entries(node))
          if (field !== "span") work.push({ value: nested, holds: node, key: field });
      }
      holders.set(file, found);
    }
    return found;
  };
  // (an inner node of the same site is taken after its holder, so `at` keeps the innermost)
  const takes = (
    site: SourceSite,
    result: "value" | "text" | "boolean",
    operand: boolean,
  ): boolean => {
    const { at, holder } = holdersOf(site.file);
    let node = at.get(spanKey(site.start, site.end));
    let held = node === undefined ? undefined : holder.get(node);
    const out = (): void => {
      node = held?.node;
      held = node === undefined ? undefined : holder.get(node);
    };
    while (held?.node.kind === "parenthesizedExpression") out();
    if (operand) {
      if (held?.node.kind !== "binaryExpression") return false;
      out();
    }
    // (text joined to a text after it stays text)
    const joinsText = (): boolean => {
      const right = held?.node["right"];
      return (
        result === "text" &&
        held?.node.kind === "binaryExpression" &&
        held.node["operator"] === "+" &&
        held.key === "left" &&
        typeof right === "object" &&
        right !== null &&
        "kind" in right &&
        right.kind === "stringLiteral"
      );
    };
    while (held?.node.kind === "parenthesizedExpression" || joinsText()) out();
    if (held === undefined) return false;
    return (
      (held.node.kind === "sayStatement" && held.key === "value") ||
      held.node.kind === "stringInterpolation" ||
      (result === "boolean" &&
        (held.node.kind === "ifStatement" || held.node.kind === "whileStatement") &&
        held.key === "condition")
    );
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
  // what each diagnostic covers for a proof: its site; a "not checked (budget)" mark's whole region, the stop's unchecked
  // code, where the checks it moved to the runtime stand unreported (Astra r3); a stop's own warning, which claims no
  // region, nothing. Each file's in start order, with the furthest end among those before each.
  type Covered = {
    readonly diagnostic: CoreDiagnostic;
    readonly start: number;
    readonly end: number;
  };
  const sites = new Map<number, { readonly sorted: Covered[]; readonly reach: number[] }>();
  const sitesOf = (file: number): { readonly sorted: Covered[]; readonly reach: number[] } => {
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
      for (const { end } of sorted) reach.push(Math.max(reach.at(-1)!, end));
      found = { sorted, reach };
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
  const of = (self: CoreDiagnostic | null): MessageSource => ({
    text: (site) => (sources[site.file] ?? "").slice(site.start, site.end),
    line,
    column: (site) => site.start - linesOf(site.file)[lineIndex(site)]!,
    statement,
    proves: ({ embedded = self?.site, rulesOut = () => false, replaces } = {}) => {
      if (self === null || embedded === undefined) return false;
      if (replaces !== undefined && !takes(self.site, replaces.result, replaces.operand === true))
        return false;
      const { sorted, reach } = sitesOf(embedded.file);
      // (one that starts before the text and reaches into it, then those that start in it, until another)
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle]!.start < embedded.start) low = middle + 1;
        else high = middle;
      }
      if (reach[low]! > embedded.start) return false;
      for (let at = low; at < sorted.length && sorted[at]!.start < embedded.end; at += 1) {
        const other = sorted[at]!.diagnostic;
        const ruledOut =
          other === self ||
          (other.site.start === self.site.start &&
            other.site.end === self.site.end &&
            other.kind !== "written-type" &&
            other.kind !== "budget" &&
            other.kinds.length > 0 &&
            other.kinds.every(rulesOut));
        if (!ruledOut) return false;
      }
      return true;
    },
    of,
  });
  return of(null);
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
    default:
      return "TSV043";
  }
}

/** A diagnostic's message: its first sentence, and a warning's consequence, fix and cause after it. */
export function coreMessage(diagnostic: CoreDiagnostic, project: MessageSource): string {
  // (the fix's code judged for this diagnostic, TABLE r4.162)
  const source = project.of(diagnostic);
  if (diagnostic.kind === "written-type") return writtenTypeMessage(diagnostic, source);
  if (diagnostic.kind === "budget") return budgetMessage(diagnostic, source);
  const text = source.text(diagnostic.site);
  const { rule, kinds } = diagnostic;
  // (whether the values it names are there when the script runs, unproved where it does not say, and whether its
  // program runs at all: TABLE r4.162, r4.168)
  const diagnosed: Diagnosed = {
    present: diagnostic.present ?? "unproved",
    severity: diagnostic.class === "compile-error" ? "error" : "warning",
  };
  if (diagnostic.class === "compile-error")
    return errorSentence(rule, text, kinds, source, diagnostic.site, diagnostic.expects, diagnosed);
  const { context, detail } = diagnostic.provenance;
  // a member's context is its receiver's: `value` in `value[0]` comes from outside the script; a selection's, its
  // collection's
  const name =
    rule.rule === "member" ? rule.receiver : rule.rule === "selection" ? rule.collection : text;
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
  if (
    !(context === "unknown" && !detail.outside) &&
    context !== "later" &&
    !missing &&
    !speaker &&
    !literal
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

// ------------------------------------------------------------------------------------------- the kinds in words

type Known = Exclude<ItemTag, "unknown" | "empty">;

function known(kinds: readonly ItemTag[]): Known[] {
  return [...new Set(kinds)].filter(
    (kind): kind is Known => kind !== "unknown" && kind !== "empty",
  );
}

/** Words in a list: `a`, `a or b`, `a, b, or c`. */
function either(words: readonly string[]): string {
  return words.length < 3
    ? words.join(" or ")
    : `${words.slice(0, -1).join(", ")}, or ${words.at(-1)!}`;
}

/** The kinds a sentence names: a whole number among numbers is one of them (V30 §2). */
function named(kinds: readonly ItemTag[]): Known[] {
  const found = known(kinds);
  return found.includes("number") ? found.filter((kind) => kind !== "integer") : found;
}

/** Kinds as one value is described: `a whole number (integer)`, `text (string) or null`. */
function described(kinds: readonly ItemTag[]): string {
  const found = named(kinds);
  return found.length === 0
    ? "a value of another type"
    : either(found.map((kind) => VALUE_KINDS[kind].description));
}

/** Kinds as many values are described: `whole numbers`, `texts or null`. */
function plural(kinds: readonly ItemTag[]): string {
  const found = named(kinds);
  return found.length === 0
    ? "values of one type"
    : either(found.map((kind) => (kind === "null" ? "null" : VALUE_KINDS[kind].plural)));
}

/**
 * Kinds as a written type (V30 §13), as the current checker writes one: `integer`, `integer | string`, `integer?`;
 * `null` where a list, set or dict among them has no written element type.
 */
function typeText(kinds: readonly ItemTag[]): string | null {
  const found = named(kinds);
  const unwritten = (kind: Known): boolean =>
    !VALUE_KINDS[kind].written || (VALUE_KINDS[kind].type === "parts" && kind !== "object");
  if (found.length === 0 || found.some(unwritten)) return null;
  const values = found.filter((kind) => kind !== "null");
  if (values.length === 0) return "null";
  if (values.length < found.length && values.length === 1) return `${values[0]!}?`;
  return [...values, ...(values.length < found.length ? ["null"] : [])].join(" | ");
}

/** A collection's written type of elements of `element` (V30 §13): `integer[]`, `(integer | string) set`. */
function collectionText(collection: "list" | "set" | "dict", element: string): string {
  const written = element.includes(" | ") ? `(${element})` : element;
  return collection === "list" ? `${written}[]` : `${written} ${collection}`;
}

/** The text of a plain variable, which a test narrows (ADR 0021 rule 5), else `null`. */
function variable(text: string): string | null {
  return expressionKind(text) === "identifier" ? text : null;
}

/**
 * Whether a text is a stable path as written, on one line (TABLE §13 N1): a variable followed by properties, fixed
 * indexes or keys, or indexes and keys held in plain variables; not `.random`, a call or a computed index. It is the
 * only subject a fix's example names, so code that reads it again reads the same value (#1195, the lead after Astra r1
 * and r2). Any other subject, a literal or another expression, gets its fix's sentence alone; a name is never taken
 * from another declaration or from the place's facts.
 */
function stablePath(text: string): boolean {
  const fixed = (index: Expression): boolean =>
    index.kind === "identifier" ||
    index.kind === "numberLiteral" ||
    (index.kind === "unaryExpression" &&
      index.operator === "-" &&
      index.operand.kind === "numberLiteral") ||
    (index.kind === "stringLiteral" && index.parts.every((part) => part.kind === "stringText"));
  const stable = (expression: Expression): boolean =>
    expression.kind === "identifier" ||
    (expression.kind === "propertyAccessExpression" &&
      expression.property.name !== "random" &&
      stable(expression.object)) ||
    (expression.kind === "indexExpression" && fixed(expression.index) && stable(expression.object));
  const parsed = parsedExpression(text);
  return parsed !== null && ownText(text) && stable(parsed.expression);
}

/** The literals whose type is their own: a number (also negated), text, `true`/`false`, null, a quantity, a regex. */
const LITERALS: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "stringLiteral",
  "booleanLiteral",
  "nullLiteral",
  "durationLiteral",
  "unitExpression",
  "angleExpression",
  "regexLiteral",
]);

/** Whether a text is a literal, by the language's own parser. */
function isLiteral(text: string): boolean {
  const expression = parsedExpression(text)?.expression;
  if (expression === undefined) return false;
  return expression.kind === "unaryExpression"
    ? expression.operator === "-" && expression.operand.kind === "numberLiteral"
    : LITERALS.has(expression.kind);
}

/** The expressions a member may follow without parentheses. */
const POSTFIX: ReadonlySet<Expression["kind"]> = new Set([
  "identifier",
  "propertyAccessExpression",
  "indexExpression",
  "callExpression",
  "parenthesizedExpression",
  "stringLiteral",
  "booleanLiteral",
  "nullLiteral",
  "listLiteral",
  "objectLiteral",
  "setLiteral",
  "dictLiteral",
]);

/** The expressions an operator may stand beside without parentheses: a postfix one, a number, a quantity. */
const OPERANDS: ReadonlySet<Expression["kind"]> = new Set([
  ...POSTFIX,
  "numberLiteral",
  "durationLiteral",
  "unitExpression",
  "angleExpression",
]);

/** The kind of expression code is, by the language's own parser (its binding, whatever its spacing); `null` if none. */
function expressionKind(code: string): Expression["kind"] | null {
  return parsedExpression(code)?.expression.kind ?? null;
}

/** Code as an operand of an operator or `otherwise` a fix writes: in parentheses unless it binds tighter. */
function operandText(code: string): string {
  const kind = expressionKind(code);
  return kind !== null && OPERANDS.has(kind) ? code : `(${code})`;
}

/**
 * A path below a place in words (D2: source text, never code the source does not hold): its properties as code after
 * the place's own (`'box.a.n'`), and each element or dict value step in words (`'n' of an element of 'xs'`). `root`: the
 * place's code, or words for a place the source has no name for (`its elements`); `steps`: a key's steps, a property
 * named as an internal step quoted (`propertyStep`), so `x.element` stays a property.
 */
export function pathPhrase(
  root: { readonly code: string } | { readonly words: string },
  steps: readonly string[],
): string {
  let phrase = "words" in root ? root.words : null;
  let chain = "code" in root ? root.code : "";
  const named = (): string =>
    chain === "" ? phrase! : phrase === null ? `'${chain}'` : `'${chain}' of ${phrase}`;
  for (const step of steps)
    if (step === "element" || step === "entry") {
      phrase = `${step === "entry" ? "a value" : "an element"} of ${named()}`;
      chain = "";
    } else {
      const name = propertyName(step);
      chain = chain === "" ? name : chain + "." + name;
    }
  return named();
}

/** A member as its sentence names it: `property 'n'`, `method 'add'`, `elements`. */
function memberNoun(member: string): string {
  if (!member.startsWith(".")) return "elements";
  return member.endsWith("()")
    ? `method '${member.slice(1, -2)}'`
    : `property '${member.slice(1)}'`;
}

/** Whether a member's use sets a property: a store's `use` also marks a method that changes its value, and an element. */
function setsProperty(rule: DiagnosticRule): boolean {
  return (
    rule.rule === "member" &&
    rule.use === "store" &&
    rule.member.startsWith(".") &&
    !rule.member.endsWith("()")
  );
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What `${...}` shows (compile error `TSV042`). */
const SHOWN_RULE =
  "It shows text, numbers, true, false, null, durations, angles, date and time values, script references, and " +
  "regexes, and selects one element of a list.";

/** The rule an operand's kinds break: the first part of its consumer's sentence; `text`, the operand as written. */
function operandRule(rule: DiagnosticRule, text: string): string {
  switch (rule.rule) {
    case "count":
      return rule.use === "repeat"
        ? REPEAT_COUNT_RULE
        : rule.use === "index" || rule.use === "get"
          ? LIST_INDEX_RULE
          : `${rule.use}() needs a whole number (integer)`;
    case "boolean":
      return rule.operator === null
        ? "A condition must be true or false (boolean)"
        : rule.operator === "not"
          ? "'not' needs true or false (boolean)"
          : logicalOperandRule(rule.operator === "and" ? "and" : "or");
    case "operator":
      return `'${rule.operator}' needs ${described(rule.domain)}`;
    case "key":
      return "A dict key is text (string)";
    case "iterable":
      return rule.entries
        ? "A 'for' loop with a key and a value goes through a dict"
        : FOR_SOURCE_RULE;
    // (the operand in its own '${…}', which is no placeholder, #1268)
    case "shown":
      return rule.element
        ? `'\${${text}}' shows one element of a list as text`
        : `'\${${text}}' shows its value as text`;
    default:
      throw new Error(`The rule '${rule.rule}' has no operand rule.`);
  }
}

// ------------------------------------------------------------------------------------------- code forms (TABLE r4.151)

/**
 * What one operation of a code form takes of a subject: the subject's kinds, each of which it must take; `held`, a
 * value it holds (a list's element), whose structure must fit too.
 */
interface Takes {
  readonly subject: readonly ItemTag[];
  readonly takes: readonly ItemTag[];
  readonly held: boolean;
}

/** The kinds whose structure a kind alone does not say: an object's properties, a collection's elements. */
const STRUCTURED: ReadonlySet<ItemTag> = new Set(["object", "list", "set", "dict"]);

/** A diagnostic's facts a code form reads: whether the values it names are there, and whether its program runs. */
interface Diagnosed {
  readonly present: Presence;
  readonly severity: "error" | "warning";
}

/**
 * A code form a fix offers, every fact stated (TABLE r4.162): its code; what each of its operations takes (fact 1);
 * its diagnostic's facts (`diagnosed`), and whether the values it reads are the site's own, read once where they stand
 * (`own`), or it reads them again or elsewhere (`added`); the kinds its value has (fact 2), with a collection's
 * elements' kinds (none for a scalar); and whether it writes a value of its own (a fallback's), which the script never
 * held.
 */
interface CodeForm {
  readonly code: string;
  readonly takes: readonly Takes[];
  readonly diagnosed: Diagnosed;
  readonly reads: "own" | "added";
  readonly gives: readonly ItemTag[];
  readonly elements: readonly ItemTag[] | "unproved";
  readonly writes: boolean;
}

/** A site no fact describes: no value is proved to fit it. */
const UNPROVED: SiteExpectation = {
  takes: [],
  binds: "whole",
  elements: "unproved",
  divides: "unproved",
};

/** A line of its own: a statement, whose value nothing takes or divides. */
const STATEMENT: SiteExpectation = { takes: null, binds: "whole", elements: null, divides: false };

/** The kinds `${...}` shows (V30 §8), which `join` joins. */
const SHOWN_KINDS_ALL: readonly ItemTag[] = VALUE_KIND_NAMES.filter(
  (kind) => VALUE_KINDS[kind].shown !== null,
);

/** The kinds a text method's result has (`TEXT_METHODS`). */
function textResult(result: (typeof TEXT_METHODS)[keyof typeof TEXT_METHODS]["result"]): ItemTag[] {
  const kind: ItemTag =
    result.startsWith("string[") || result.startsWith("string?[")
      ? "list"
      : result.startsWith("string")
        ? "string"
        : result.startsWith("integer")
          ? "integer"
          : "boolean";
  return result.endsWith("?") ? [kind, "null"] : [kind];
}

/**
 * TABLE r4.151: the one test of every code form a fix offers, pasted whole at the site its diagnostic sits on. It holds
 * where (1) each operation takes its subject: every value the form reads there when the script runs, every kind of
 * it known, and one the operation takes, a value it holds of a flat structure; (2) its value fits what the site takes (`site`, read from what
 * consumes the value there: any value where nothing restricts it), a structured value only there or as a collection
 * of scalars against its elements' kinds, and a value the fix writes itself only where the value is proved not to
 * divide; and (3) it binds there: as the site's whole value, or in parentheses where an operand or a receiver binds
 * tighter than its code. A site fact no fact proves gives words, never a form (TABLE r4.162). Its code, so grouped,
 * where it holds; `null` where it does not, and the fix gives its advice in words.
 */
function codeAt(form: CodeForm, site: SiteExpectation): string | null {
  const proved = (kinds: readonly ItemTag[]): boolean =>
    kinds.length > 0 && kinds.every((kind) => kind !== "unknown" && kind !== "empty");
  const fit = (kinds: readonly ItemTag[], takes: readonly ItemTag[]): boolean =>
    proved(kinds) && kinds.every((kind) => takes.some((tag) => fits(kind, tag, true)));
  // (a value held in a place, or landing in one that takes some type, fits by its structure too: the kinds alone prove
  // it only for a scalar, or a collection of scalars against its elements' kinds, Codex r6)
  const flat = (kinds: readonly ItemTag[]): boolean => !kinds.some((kind) => STRUCTURED.has(kind));
  // (the values it reads are there when the script runs: proved, or a warning's own reads, which its program already
  // performs where they stand, wrapped there in place, TABLE r4.168)
  const there =
    form.diagnosed.present === true ||
    (form.diagnosed.severity === "warning" && form.reads === "own");
  if (
    !there ||
    !ownText(form.code) ||
    !form.takes.every(({ subject, takes, held }) => fit(subject, takes) && (!held || flat(subject)))
  )
    return null;
  // (the predicate proves types, not values: a value the fix writes, such as a fallback's `0`, may stop the run where
  // the value divides, Astra on #1273; offered only where a fact proves it does not, TABLE r4.162)
  if (form.writes && site.divides !== false) return null;
  if (site.takes !== null) {
    if (!fit(form.gives, site.takes) || form.gives.includes("object")) return null;
    const collection = form.gives.some((kind) => STRUCTURED.has(kind));
    if (
      collection &&
      site.elements !== null &&
      (site.elements === "unproved" ||
        form.elements === "unproved" ||
        !flat(form.elements) ||
        !fit(form.elements, site.elements))
    )
      return null;
  }
  const kind = expressionKind(form.code);
  if (kind === null) return null;
  const binds = site.binds === "receiver" ? POSTFIX : site.binds === "operand" ? OPERANDS : null;
  return binds === null || binds.has(kind) ? form.code : `(${form.code})`;
}

// ------------------------------------------------------------------------------------------- first sentences

type StoreRule = Extract<DiagnosticRule, { rule: "store" }>;

/**
 * A store's place as its sentence names it: declared with a type, or holding the type a store decided, since that
 * store's line; a collection's element or dict value as the collection itself (#1195), which contains it. `later`: the
 * deciding store comes after the warned line, so the place holds its type because of that line.
 */
function storeSubject(rule: StoreRule, source: MessageSource, later = false): string {
  const line = rule.decider === null ? null : source.line(rule.decider);
  const since = line === null ? "" : later ? ` because of line ${line}` : ` since line ${line}`;
  const collection = elementOf(rule);
  const type = collection === null ? null : typeText(rule.type);
  if (collection !== null && type !== null)
    return `'${collection.name}' holds ${plural(rule.type)} (${collectionText(collection.kind, type)})${since}`;
  if (rule.written) return `${capitalized(rule.into)} is declared as ${described(rule.type)}`;
  return `${capitalized(rule.into)} holds ${described(rule.type)}${since}`;
}

/**
 * The collection a store's place is an element or a dict value of, where the source names it: a variable or parameter,
 * or a property path below one; with its kind, and whether it is the root itself, which a fix declares.
 */
function elementOf(
  rule: StoreRule,
): {
  readonly name: string;
  readonly kind: "list" | "set" | "dict";
  readonly root: boolean;
} | null {
  const last = rule.steps.at(-1);
  if (
    rule.root === null ||
    rule.root.kind === "result" ||
    last === undefined ||
    !("collection" in last)
  )
    return null;
  const names = [rule.root.name];
  for (const step of rule.steps.slice(0, -1)) {
    if (!("property" in step)) return null;
    names.push(step.property);
  }
  return { name: names.join("."), kind: last.collection, root: names.length === 1 };
}

/**
 * How a fix declares a store's root with the type `type` at the root (`declareAs` of the current checker): its whole
 * declaration as the source writes it, with that type, where it is code on one line (#1268, TABLE r4.146); else the
 * declaration and the type in words. `subject`, the root as the sentence names it.
 */
function declaration(
  root: StoreRoot | null,
  type: string,
  source: MessageSource,
  subject = "it",
): string | null {
  if (root === null || root.kind === "result") return null;
  const parameter = root.kind === "parameter";
  const written = root.site === null ? "" : source.text(root.site);
  if (
    root.site === null ||
    written === "" ||
    !ownText(written) ||
    !source.proves({ embedded: root.site })
  )
    return `declare ${parameter ? `the parameter '${root.name}'` : subject} with the type '${type}'`;
  // (the start value from its `=`, which no written type holds: a global's `default:` stays with it)
  const start = written.indexOf("=");
  const declared = `${parameter ? "" : `${root.kind} `}${root.name}: ${type}`;
  return (
    `declare ${parameter ? "the parameter" : subject} as ` +
    `'${start === -1 ? declared : `${declared} ${written.slice(start)}`}'`
  );
}

/**
 * The fix of a store of `kinds` into a place of `type`, as the current checker gives it: rounding a number into a whole
 * number; a conversion into the place's one type; for null a nullable type, else a written union (ADR 0021 rule 1.1),
 * where the place is a variable, a parameter, or an element or dict value of one; else a separate property or
 * collection for a property's or an element's values, or a separate variable.
 */
function storeFix(
  rule: StoreRule,
  kinds: readonly ItemTag[],
  text: string,
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  if (rule.type.includes("integer") && kinds.includes("number")) return ROUND_COUNT_FIX;
  const values = known(kinds);
  const place = known(rule.type).filter((kind) => kind !== "null");
  const conversion = conversionFix(rule, place, values, text, source, diagnosed);
  if (conversion !== "") return conversion;
  const nullOnly = values.length > 0 && values.every((kind) => kind === "null");
  const both = typeText([...rule.type, ...kinds]);
  const collection = elementOf(rule);
  // (a collection a property holds: that property's first value, as the current checker says)
  if (collection !== null && !collection.root && both !== null)
    return (
      ` To allow both, give '${collection.name}' a first value of type '${collectionText(collection.kind, both)}', ` +
      "such as a variable declared with that type."
    );
  if (rule.steps.some((step) => "property" in step))
    return " Use a separate property for a value of another type.";
  if (rule.steps.length > 0 && collection === null) {
    const last = rule.steps.at(-1)!;
    return ` Use a separate ${"collection" in last ? last.collection : "list"} for values of another type.`;
  }
  const written =
    both === null ? null : collection === null ? both : collectionText(collection.kind, both);
  const declared = written === null ? null : declaration(rule.root, written, source);
  // (null into an element widens the element's type, which the current checker calls both)
  if (declared !== null)
    return ` To allow ${nullOnly && collection === null ? "null" : "both"}, ${declared}.`;
  if (rule.root?.kind === "result" && both !== null)
    return ` To return both, declare its result type as '${both}'.`;
  return nullOnly
    ? " Use a separate variable for null."
    : " Use a separate variable for a value of another type.";
}

/**
 * The conversion of a store's value into the place's one type (`place`), as the current checker gives it
 * (`conversionFix`): a number a unit (V30 §13), into an element too; and into a variable, a parameter, a result or a
 * property, text a date or a time with its conversion, and a number or a truth value shown as text; else "". Each code
 * form stands in place of the stored value, where the diagnostic sits, and is offered where `codeAt` proves it there:
 * the value of a kind the conversion takes (a date's text one it reads, Codex r3), and its result one the place takes.
 */
function conversionFix(
  rule: StoreRule,
  place: readonly Known[],
  values: readonly Known[],
  text: string,
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  const [type] = place;
  if (type === undefined || place.length > 1 || values.length === 0) return "";
  // (the place's written or decided type; a conversion writes no value of its own)
  const site: SiteExpectation = {
    takes: rule.type,
    binds: "whole",
    elements: "unproved",
    divides: "unproved",
  };
  const converted = (code: string, subject: readonly ItemTag[], takes: readonly ItemTag[]) =>
    codeAt(
      {
        code,
        takes: [{ subject, takes, held: false }],
        diagnosed,
        reads: "own",
        gives: [type],
        elements: [],
        writes: false,
      },
      site,
    );
  if (
    (type === "duration" || type === "angle") &&
    values.every((kind) => kind === "integer" || kind === "number")
  ) {
    if (!ownText(text)) return " Put the expression in parentheses with a unit after them.";
    const kind = expressionKind(text);
    const operand =
      kind === "numberLiteral" || (kind !== null && UNIT_OPERANDS.has(kind)) ? text : `(${text})`;
    const code = converted(`${operand} ${type === "duration" ? "s" : "deg"}`, values, [
      "integer",
      "number",
    ]);
    return code === null
      ? " Give the number a unit."
      : ` Give the number a unit, such as '${code}'.`;
  }
  const last = rule.steps.at(-1);
  if (last !== undefined && "collection" in last) return "";
  const conversion = isTemporalKind(type) ? conversionTo(type) : undefined;
  if (conversion !== undefined && values.every((kind) => kind === "string")) {
    const entry = CONVERSIONS[conversion];
    const literal = textLiteral(text);
    const reads =
      literal !== null && entry.takes === "value" && entry.textProblem(literal) === undefined;
    const code = converted(`${conversion}(${text})`, reads ? values : [], ["string"]);
    return code === null
      ? ` Convert the text with the ${conversion} function.`
      : ` Convert the text with '${code}'.`;
  }
  if (
    type === "string" &&
    values.every((kind) => kind === "integer" || kind === "number" || kind === "boolean")
  ) {
    // (#1213's decided text: the value in `${...}` in place, read once, where its own text may stand in code and is
    // proved there, else the advice alone, #1268)
    const code =
      ownText(text) && source.proves()
      ? codeAt(
          {
            code: `"\${${text}}"`,
            takes: [{ subject: values, takes: ["integer", "number", "boolean"], held: false }],
            diagnosed,
            reads: "own",
            gives: ["string"],
            elements: [],
            writes: false,
          },
          site,
        )
      : null;
    return code === null
      ? " To show the value as text, put it in a text."
      : ` To show '${text}' as text, write '${code}'.`;
  }
  return "";
}

/**
 * A member's fix where its receiver's kind has no such member (the current checker's, `operation-checks.ts`). Each code
 * form stands in place of the member access the diagnostic sits on, names the receiver where it is a stable path, and
 * is offered where `codeAt` proves it there: the receiver's kinds (`holder`: an error's own, a warning's whole
 * receiver's, none where its facts are lost) ones the member takes, a call's elements of a type it takes, and its value
 * one the access's place takes (`site`); else the member or the step in words (TABLE r4.151); `text`, the access's code.
 */
function memberFix(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  kinds: readonly ItemTag[],
  text: string,
  site: SiteExpectation,
  holder: readonly ItemTag[],
  source: MessageSource,
  diagnosed: Diagnosed,
  fits: readonly ItemTag[] = [],
): string {
  const kind = known(kinds).find((found) => found !== "null");
  if (kind === undefined) return "";
  const receiver = rule.receiver;
  const named = stablePath(receiver);
  // (code on the receiver, where it is written as a stable path: the form `codeAt` tests)
  const on = (
    code: string,
    takes: readonly ItemTag[],
    gives: readonly ItemTag[],
    also: readonly Takes[] = [],
  ) =>
    named
      ? codeAt(
          {
            code,
            takes: [{ subject: holder, takes, held: false }, ...also],
            diagnosed,
            reads: "own",
            gives,
            elements: [],
            writes: false,
          },
          site,
        )
      : null;
  if (!rule.member.startsWith(".")) return kind === "object" ? objectIndexFix(rule, text) : "";
  const method = rule.member.endsWith("()");
  const name = method ? rule.member.slice(1, -2) : rule.member.slice(1);
  if (kind === "string") {
    if (rule.use === "store") return ` Assign a new text to '${receiver}' instead.`;
    if (method && name === "length") {
      const code = on(`${receiver}.length`, ["string"], ["integer"]);
      return code === null
        ? " Read the length property without parentheses."
        : ` Write '${code}' without parentheses.`;
    }
    if (!method && isTextMethod(name)) {
      const signature = TEXT_METHODS[name];
      if (signature.parameters.some((parameter) => !("optional" in parameter)))
        return ` Call the ${name} method with its arguments in parentheses.`;
      const code = on(`${receiver}.${name}()`, ["string"], textResult(signature.result));
      return code === null
        ? ` Call the ${name} method with parentheses.`
        : ` Write '${code}' with parentheses.`;
    }
    const suggestion = textMemberSuggestion(name);
    // (a method's arguments are the script's to choose: the method in words)
    if (suggestion?.endsWith("(...)")) return ` Use the ${suggestion.slice(0, -5)} method.`;
    if (suggestion !== undefined) {
      const member = suggestion.replace("()", "");
      const gives = suggestion.endsWith(")")
        ? isTextMethod(member)
          ? textResult(TEXT_METHODS[member].result)
          : []
        : ["integer" as const];
      const code = on(`${receiver}.${suggestion}`, ["string"], gives);
      return code === null
        ? ` Use the ${member} ${suggestion.endsWith(")") ? "method" : "property"}.`
        : ` Use '${code}'.`;
    }
  }
  if (kind === "dict") {
    if (method)
      return name === "add"
        ? " Assign the value to a key of the dict instead."
        : ` Use one of the dict's methods instead: ${either(Object.keys(DICT_METHODS).map((found) => `'${found}'`))}.`;
    // (a key's value is there only where the dict has the key when the script runs, which no fact here proves, Codex
    // r6: the key in words, for a read and a store)
    return rule.use === "store"
      ? " To store a value by its key, write the key in brackets."
      : ` Use one of the dict's properties instead: ${either(Object.keys(DICT_PROPERTIES).map((found) => `'${found}'`))}.` +
          ` To read a value by its key, write the key in brackets, where '${receiver}' has that key.`;
  }
  // (a property stored on a type without it: a read's repair is no place to store into)
  if (!method && rule.use === "store") return "";
  const angle = method || kind !== "angle" ? undefined : angleUnit(name);
  if (angle !== undefined) {
    const conversion = angle === "deg" ? "toDeg" : "toRad";
    const code = on(`${conversion}(${receiver})`, ["angle"], ["number"]);
    return (
      ` Use ${code === null ? `the ${conversion} function` : `'${code}'`} for its size in ` +
      `${angle === "deg" ? "degrees" : "radians"}.`
    );
  }
  if (!method && kind === "list" && name === "join") {
    // (the join method joins only elements `${...}` shows, V30 §8: its elements' type's kinds)
    const elements = rule.elements ?? [];
    const code = on(
      `${receiver}.join()`,
      ["list"],
      ["string"],
      [{ subject: elements, takes: SHOWN_KINDS_ALL, held: false }],
    );
    if (code !== null) return ` Write '${code}' with parentheses.`;
    const proved =
      elements.length > 0 && elements.every((found) => found !== "unknown" && found !== "empty");
    return !proved
      ? " Call the join method with parentheses, on elements that can be shown as text."
      : elements.every((found) => SHOWN_KINDS_ALL.includes(found))
        ? " Call the join method with parentheses."
        : " The join method joins only elements that can be shown as text, so select an element or a property first.";
  }
  // (code written for the receiver's type only for a property read, whose result `say` shows, where the receiver has no
  // other type the diagnostic names or the member takes and the code is proved where it stands, TABLE r4.162, Codex r6:
  // a method's result is the method's, which the use may not take; else the step in words)
  const only =
    !method &&
    known([...kinds, ...fits]).every((found) => found === kind) &&
    source.proves({ replaces: { result: "value" } });
  const exact = only && named;
  if (!method && kind === "absoluteDateTime" && hasTemporalField("datetime", name))
    return exact
      ? ` Convert '${receiver}' first, as in '${receiver}.toDateTime().${name}'.`
      : ` Convert '${receiver}' with the toDateTime method first.`;
  // (a property read of a stable path whole; else the receiver's conversion in its place, which keeps a call's own
  // arguments, #1268)
  if (kind !== "string" && VALUE_KINDS[kind].type === "scalar" && isTextMember(name))
    return !method && exact
      ? ` Convert '${receiver}' to text first, as in 'toString(${receiver}).${name}'.`
      : only && ownText(receiver)
        ? ` Convert '${receiver}' to text first with 'toString(${receiver})'.`
        : " Convert the value to text first with the toString function.";
  if (!method && kind === "duration") {
    const unit = elapsedDurationUnit(name);
    if (unit !== undefined) {
      const single = name.length > 2 && name.endsWith("s") ? name.slice(0, -1) : name;
      // (in parentheses: the division stands where the member did, which binds tighter, #1268)
      return exact
        ? ` Divide '${receiver}' by a unit, as in '(${receiver} / 1 ${single})'.`
        : only
          ? ` Divide '${receiver}' by a unit, such as '1 ${single}'.`
          : " Divide the duration by a unit of time instead.";
    }
  }
  // (properties named in words: each has its own type, which the read's use may not take, Codex r4)
  if (!method && kind === "calendarDuration")
    return ` Use one of its properties instead: ${either(Object.keys(CALENDAR_DURATION_PARTS))}.`;
  if (method && kind === "set" && listMethod(name)?.notOnSet !== undefined)
    return name === "get"
      ? " Use the contains method instead."
      : ` Copy '${receiver}' into a list with the toList method first.`;
  if (!method && kind === "list" && rule.use === "read")
    return " Use one of its properties instead: length, first, last, or random.";
  return "";
}

/**
 * An object indexed, which V30 §15 forbids, with the current checker's fix: a dict looks up by a name, and a fixed name
 * written as text is the object's property where the object has it, which no fact here proves (Codex r1): in words,
 * naming the receiver where it is a stable path (TABLE r4.151); `text`, the access.
 */
function objectIndexFix(rule: Extract<DiagnosticRule, { rule: "member" }>, text: string): string {
  const access = parsedExpression(text)?.expression;
  const key = access?.kind === "indexExpression" ? textOf(access.index) : null;
  if (key === null || !/^[A-Za-z_]\w*$/.test(key)) return " Use a dict to look up by name.";
  const owner = stablePath(rule.receiver) ? `'${rule.receiver}'` : "the object";
  return ` Use a dict to look up by name. If ${owner} has a property '${key}', use a dot instead of brackets.`;
}

/**
 * The fix of a value that is not true or false where a condition needs one (#1195's decided text): its advice always,
 * its example only of a stable path (the lead after Astra r3) whose every known type, `others` included, the example
 * takes (Codex r4).
 */
function conditionFix(text: string, kinds: readonly ItemTag[], source: MessageSource): string {
  const kind = known(kinds)[0];
  const example = (code: string, ...takes: ItemTag[]): string =>
    stablePath(text) && known(kinds).every((found) => takes.includes(found)) && source.proves()
      ? `, as in '${code}'.`
      : ".";
  if (kind === "integer" || kind === "number")
    return ` Compare it instead${example(`${text} > 0`, "integer", "number")}`;
  if (kind === "string") return ` Compare it instead${example(`${text} != ""`, "string")}`;
  if (kind === "list" || kind === "set" || kind === "dict")
    return ` Check its length instead${example(`${text}.length > 0`, "list", "set", "dict")}`;
  return "";
}

/** The fix of a key that is not text: a number written as text, as the current checker gives it (`dict-operations.ts`). */
function keyFix(text: string, kinds: readonly ItemTag[], source: MessageSource): string {
  if (!kinds.some((kind) => kind === "integer" || kind === "number")) return "";
  // (an example where `${...}` shows every type the diagnostic names, proved at its site, TABLE r4.162)
  return stablePath(text) &&
    known(kinds).every((kind) => kind === "string" || (kind !== "null" && SHOWN_KINDS.has(kind))) &&
    source.proves()
    ? ` Write a number key as text, as in '"\${${text}}"'.`
    : " Write a number key as text.";
}

/** How `${...}` shows a value of each kind it cannot show, where one has a fix (#1195's decided texts). */
function shownFix(
  rule: Extract<DiagnosticRule, { rule: "shown" }>,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
): string {
  const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
  // (in its own '${…}', read once, where its own text may stand in code: a receiver in parentheses unless it binds
  // tighter, #1268)
  // (no receiver form for an element `${...}` selects from a list, whose text names the list; a join only of elements it
  // shows, Codex r2)
  const label = ownText(text) && !rule.element && source.proves() ? operandText(text) : null;
  if (kind === "object")
    return rule.property === null || label === null
      ? "Show one of its properties instead."
      : `Show one of its properties instead, as in '\${${label}.${rule.property}}'.`;
  if (kind === "set")
    return label === null || !rule.joinable
      ? "Show its elements with the toList and join methods instead."
      : `Show all its elements with '\${${label}.toList().join()}'.`;
  return SHOWN_RULE;
}

/** The text a text literal without `${...}` holds, its code on one line, else `null`. */
function textLiteral(code: string): string | null {
  const expression = ownText(code) ? parsedExpression(code)?.expression : undefined;
  return expression === undefined ? null : textOf(expression);
}

/** The text a text literal expression without `${...}` holds, else `null`. */
function textOf(expression: Expression): string | null {
  if (expression.kind !== "stringLiteral") return null;
  let text = "";
  for (const part of expression.parts) {
    if (part.kind !== "stringText") return null;
    text += part.value;
  }
  return text;
}

/** An expression the source parsed from code, read as the initializer of a `let`, with the offset its code starts at. */
function parsedExpression(
  code: string,
): { readonly expression: Expression; readonly at: number } | null {
  const prefix = "let fix = ";
  const parsed = parse(`${prefix}${code}\nexit\n`);
  const statement = parsed.program.statements[0];
  if (parsed.diagnostics.length > 0 || statement?.kind !== "letStatement") return null;
  const { span } = statement.initializer;
  return span.start.offset === prefix.length && span.end.offset === prefix.length + code.length
    ? { expression: statement.initializer, at: prefix.length }
    : null;
}

/**
 * A literal whose elements mix types (ADR 0021 rule 1.3), in the current checker's sentences (#1195, the owner's
 * review): its elements' own types; a nested collection's as its written type (`a list (integer[])`); objects by the
 * property that differs. The fix: a written union where the elements are scalars, declared on the variable whose start
 * value the literal is, else the type alone; one type for the property; values of one type in a nested collection,
 * whose union V30 §13 forbids (rule 3.4).
 */
function mixedSentence(
  rule: Extract<DiagnosticRule, { rule: "mixed" }>,
  kinds: readonly ItemTag[],
  source: MessageSource,
): string {
  const { collection, path } = rule;
  const holds = `A ${collection} holds one type.`;
  // the steps to the property that differs, and the collections below it
  const property = path.findLastIndex((step) => step !== "element" && step !== "entry");
  const below = path.slice(property + 1);
  const nested = (types: readonly ItemTag[]): string => {
    let written = typeText(types);
    for (const step of below.toReversed())
      written =
        written === null ? null : collectionText(step === "entry" ? "dict" : "list", written);
    const outer = below[0] === "entry" ? "dict" : "list";
    return below.length === 0 || written === null
      ? described(types)
      : `${VALUE_KINDS[outer].description} (${written})`;
  };
  if (property >= 0) {
    const name = path
      .slice(0, property + 1)
      .filter((step) => step !== "element" && step !== "entry")
      .map(propertyName)
      .join(".");
    return (
      `This ${collection} mixes objects whose property '${name}' holds ${nested(rule.type)} in one and ` +
      `${nested(kinds)} in another. ${holds} Give '${name}' one type in every ` +
      `${collection === "dict" ? "value" : "element"}.`
    );
  }
  const first = `This ${collection} mixes ${nested(rule.type)} and ${nested(kinds)}. ${holds}`;
  const both = path.length === 0 ? typeText([...rule.type, ...kinds]) : null;
  if (both === null) return `${first} Use values of one type in it.`;
  const written = collectionText(collection, both);
  const { root } = rule;
  const declared =
    root?.kind === "let" || root?.kind === "global" ? declaration(root, written, source) : null;
  return `${first} To allow both, ${declared ?? `declare it as '${written}'`}.`;
}

/** The current checker's fixes of an operator on date and time values (`type-checker.ts`, `operation-checks.ts`). */
function temporalFix(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  kinds: readonly ItemTag[],
  source: MessageSource,
): string {
  const [left, right] = rule.operands.map((site) => source.text(site));
  if (left === undefined || right === undefined) return "";
  const [a, b] = rule.operand ? [undefined, kinds[0]] : rule.pair;
  const { operator } = rule;
  const moves = operator === "+" || operator === "-";
  const compares = ["<", "<=", ">", ">="].includes(operator);
  // (an example only where the value it converts is a variable or a path, and the other operand one or a literal; and
  // where its result, which the failed operation never gave, fits the use, Codex r6)
  const proved = source.proves({
    replaces: { result: compares ? "boolean" : "value", operand: rule.operand },
  });
  const named =
    proved &&
    stablePath(left) &&
    (stablePath(right) || LITERAL_OPERAND.has(expressionKind(right) ?? "identifier"));
  if (moves && a === "absoluteDateTime" && b === "calendarDuration")
    return named
      ? " An absolute date and time has no calendar. Convert it first, as in " +
          `'(${left}.toDateTime() ${operator} ${right}).toAbsoluteDateTime()'.`
      : " An absolute date and time has no calendar. Convert it with the toDateTime method first.";
  if (moves && a === "date" && b === "duration") {
    const amount = /^(\d+) ?(d|day|days|w|week|weeks)$/.exec(right);
    if (amount === null || !proved)
      return " A date moves only by calendar units, such as calendar days.";
    const unit = amount[2]!.startsWith("d") ? "day" : "week";
    return ` A date moves only by calendar units. Write '${amount[1]!} calendar ${unit}${amount[1] === "1" ? "" : "s"}'.`;
  }
  if (moves && a === "datetime" && b === "duration")
    return (
      " A date and time has no time zone, so it cannot move by elapsed time. " +
      (named
        ? `Convert it first, as in '(${left}.toAbsoluteDateTime() ${operator} ${right}).toDateTime()', `
        : "Convert it with the toAbsoluteDateTime method first, ") +
      "or use calendar units to keep the clock time."
    );
  if (operator === "-" && b === "datetime" && rule.domain.includes("calendarDuration"))
    return (
      " A date and time has no time zone, so one cannot be subtracted from another. Subtract their dates with " +
      (proved && stablePath(left) && stablePath(right)
        ? `'toDate(${left}) - toDate(${right})'`
        : "the toDate function") +
      ", or convert both with the toAbsoluteDateTime method for the elapsed time."
    );
  if (moves && b === "time")
    return " Arithmetic on a time is not available. Combine it with a date first, with the toDateTime function.";
  if (compares && a === "date" && b === "datetime")
    return proved && stablePath(right)
      ? ` A date compares only with another date. Compare its date, as in 'toDate(${right})'.`
      : " A date compares only with another date. Compare its date with the toDate function.";
  if ((compares || operator === "/") && a !== undefined && b !== undefined) {
    const pair = new Set([a, b]);
    if (pair.has("calendarDuration") && pair.has("duration"))
      return ` A calendar day or month has no fixed length. ${compares ? "Compare" : "Divide"} two calendar durations, or two durations.`;
  }
  return "";
}

/**
 * The current checker's fix of '+' between a list or a set and a value that is not one (V30 §4): a set's union or copy
 * into a list, in words; a range's numbers as a list; else the value in a list for a new one, or added to the list
 * itself on a line of its own (an `add` gives no list, Astra r1). Each code form stands in place of the diagnosed site,
 * the operation or the one operand it names, writes the list where it is a stable path and the value where its code is
 * on one line, and is offered where `codeAt` proves it there: the list's elements' type takes the value (`elements`),
 * and the new list fits what the site takes (`expects`); else the fix in words (TABLE r4.151). Each side's type: the
 * operand's own at `site` and the other's place (`domain`), or the operation's `pair`.
 */
function listJoinFix(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  kinds: readonly ItemTag[],
  site: SourceSite,
  expects: SiteExpectation,
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  const [leftSite, rightSite] = rule.operands;
  if (rule.operator !== "+" || leftSite === undefined || rightSite === undefined) return "";
  const own = known(kinds);
  const atRight = rule.operand && rightSite.file === site.file && rightSite.start === site.start;
  const sides = !rule.operand
    ? rule.pair.map((kind) => [kind])
    : atRight
      ? [rule.domain, own]
      : [own, rule.domain];
  const [a, b] = sides.every((types) => types.length === 1) ? sides.map(([kind]) => kind) : [];
  if (a === undefined || b === undefined || sides.length !== 2) return "";
  if ((a === "set" || b === "set") && (a === "list" || b === "list" || a === b))
    return " Join sets with the union method, or copy a set into a list with the toList method first.";
  const listLeft = a === "list" && b !== "list";
  if (!listLeft && !(b === "list" && a !== "list" && a !== "string")) return "";
  // (an operand's diagnostic sits on the value beside the list, which the code replaces)
  if (rule.operand && atRight !== listLeft) return "";
  const [list, value] = listLeft
    ? [source.text(leftSite), source.text(rightSite)]
    : [source.text(rightSite), source.text(leftSite)];
  const range = (listLeft ? b : a) === "range";
  const holds: Takes = {
    subject: range ? ["integer"] : [listLeft ? b : a],
    takes: rule.elements ?? [],
    held: true,
  };
  // (the value's new code, and the code at the site: the operation with it, or that operand alone)
  const written = (code: string): string | null =>
    stablePath(list) && ownText(value)
      ? codeAt(
          {
            code: rule.operand ? code : listLeft ? `${list} + ${code}` : `${code} + ${list}`,
            takes: [holds],
            diagnosed,
            reads: "own",
            gives: ["list"],
            elements: rule.elements ?? "unproved",
            writes: false,
          },
          expects,
        )
      : null;
  if (range) {
    const code = written(
      POSTFIX.has(expressionKind(value) ?? "binaryExpression")
        ? `${value}.toList()`
        : `(${value}).toList()`,
    );
    return code === null
      ? " To add the numbers of a range, convert the range with the toList method first."
      : ` Write '${code}' to add the numbers of the range.`;
  }
  const join = written(`[${value}]`);
  // (an add, on a line of its own, where a statement takes any value, and the list itself then where the join stood:
  // the list read again, before the line, TABLE r4.168)
  const itself =
    rule.elements === undefined
      ? null
      : codeAt(
          {
            code: list,
            takes: [],
            diagnosed,
            reads: "added",
            gives: ["list"],
            elements: rule.elements,
            writes: false,
          },
          expects,
        );
  const add =
    listLeft && stablePath(list) && ownText(value) && itself !== null
      ? codeAt(
          {
            code: `${list}.add(${value})`,
            takes: [holds],
            diagnosed,
            reads: "added",
            gives: [],
            elements: [],
            writes: false,
          },
          STATEMENT,
        )
      : null;
  if (!listLeft)
    return join === null
      ? " Put the element in brackets for a new list."
      : ` Write '${join}' for a new list.`;
  return (
    (join === null
      ? " To add one element, put the element in brackets for a new list"
      : ` Write '${join}' for a new list`) +
    (add === null
      ? ", or call the add method on a line of its own."
      : `, or add the element to '${list}' itself with '${add}' on a line of its own.`)
  );
}

function errorSentence(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
  site: SourceSite,
  expects: SiteExpectation | undefined,
  diagnosed: Diagnosed,
): string {
  switch (rule.rule) {
    case "store":
      // ADR 0021 rule 1.1: a property that reached the place only through copies, at its first direct read or store
      if (rule.brought !== null)
        return (
          `${storeSubject(rule, source)}, but '${source.text(rule.brought)}' on line ` +
          `${source.line(rule.brought)} brings ${described(kinds)} into that property. Use a separate property for a ` +
          "value of another type."
        );
      return `${storeSubject(rule, source)}, so it cannot ${elementOf(rule) === null ? "take" : "contain"} ${described(kinds)}.${storeFix(rule, kinds, text, source, diagnosed)}`;
    case "fallback": {
      // ADR 0021 rule 7.3: a written union of the place the value lands in directly holds both
      const both = typeText([...rule.type, ...kinds]);
      const declared =
        both === null || (rule.type.includes("integer") && kinds.includes("number"))
          ? null
          : declaration(rule.root, both, source, `'${rule.root?.name ?? ""}'`);
      return (
        `The ${rule.fallback ? "fallback" : "default"} '${text}' is ${described(kinds)}, but the value it stands ` +
        `in for is ${described(rule.type)}. Use null or a value of that type instead` +
        (declared === null ? "." : `, or to allow both, ${declared}.`)
      );
    }
    case "member": {
      const noun = memberNoun(rule.member);
      if (kinds.length > 0 && kinds.every((kind) => kind === "null"))
        return `'${rule.receiver}' is null here, so it has no ${noun}. Give '${rule.receiver}' a value first.`;
      if (kinds.includes("unknown"))
        return `'${rule.receiver}' has no ${noun}. Add it to the object first.`;
      return `${capitalized(described(kinds))} has no ${noun}, so '${text}' cannot be used.${memberFix(rule, kinds, text, expects ?? UNPROVED, kinds, source, diagnosed)}`;
    }
    case "absent": {
      // (the properties it has, as the current checker names them: a misspelt name's fix, ADR 0021 rule 1.4)
      const others = rule.properties.filter((name) => name !== rule.property);
      const listed =
        others.length === 0
          ? ""
          : ` ${others.length === 1 ? "Its only property is" : "Its properties are"} ${nameList(others)}.`;
      // (the nearest name, as the current checker suggests it)
      const hint = misspelledPropertyHint(rule.property, others);
      if (rule.store === null)
        return `'${rule.receiver}' has no property '${rule.property}'.${listed || ` Add '${rule.property}' to its object first.`}${hint}`;
      return (
        `This object has no property '${rule.property}', so '${source.text(rule.store)}' on line ` +
        `${source.line(rule.store)} cannot set '${rule.property}'.${listed}${hint} Add '${rule.property}' to this ` +
        "object."
      );
    }
    case "selection":
      return `'${rule.collection}' is empty here, so it has no element for '${rule.member}'.`;
    case "mixed":
      return mixedSentence(rule, kinds, source);
    case "operator": {
      const join = joined(rule, text, kinds, [], source);
      if (join !== null)
        return `'+' joins text only with other text, not with ${described(join.other)}. ${joinFix(join.operand, rule, source)}`;
      const fix =
        temporalFix(rule, kinds, source) +
        listJoinFix(rule, kinds, site, expects ?? UNPROVED, source, diagnosed);
      return rule.operand
        ? `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.${fix}`
        : `'${rule.operator}' cannot combine ${kinds.map((kind) => described([kind])).join(" and ")}.${fix}`;
    }
    case "shown": {
      const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
      // (the operand in its own '${…}'; every value in place where its own text may stand in code, #1268)
      if (kind === "dict" && !rule.element)
        return (
          `'\${${text}}' cannot show a dict. Select one value with a key, or show every value ` +
          (ownText(text) && rule.joinable && source.proves()
            ? `with '\${${operandText(text)}.values.join()}'.`
            : "with the values and join methods.")
        );
      return `'\${${text}}' cannot show ${described(kinds)}. ${shownFix(rule, text, kinds, source)}`;
    }
    case "count":
      return (
        `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.` +
        (kinds.includes("number") ? ROUND_COUNT_FIX : " Use a whole number here.")
      );
    case "boolean":
      return `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.${conditionFix(text, kinds, source)}`;
    case "key":
      return `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.${keyFix(text, kinds, source)}`;
    default:
      return `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.`;
  }
}

/**
 * A `+` of text and a value of another kind that `${...}` shows, where none of the operand's kinds fits (`fits`): the kinds
 * the text is joined with, else `null`. An operand that is text where its place takes another kind (`domain`) is joined
 * with that kind; an operand of another kind where its place takes text, with its own; the operation, with the kind of
 * its operand (`pair`) that is not text.
 */
function joined(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  text: string,
  kinds: readonly ItemTag[],
  fits: readonly ItemTag[],
  source: MessageSource,
): { readonly other: Known[]; readonly operand: string | null } | null {
  if (rule.operator !== "+" || fits.length > 0 || rule.operands.length !== 2) return null;
  const texts = rule.operands.map((site) => source.text(site));
  // the combination the operation offends in, one kind per operand: the operand that is not text
  if (rule.pair.length === 2 && rule.pair.includes("string")) {
    const index = rule.pair.findIndex((kind) => kind !== "string");
    const kind = rule.pair[index];
    return index < 0 || kind === undefined || !SHOWN_KINDS.has(kind) || kind === "null"
      ? null
      : { other: known([kind]), operand: texts[index] ?? null };
  }
  const own = known(kinds);
  if (!rule.operand) return null;
  // (an operand whose combination is unknown: text where its place takes another kind, or the other way round)
  const other = own.includes("string")
    ? named(rule.domain).filter((kind) => kind !== "string")
    : rule.domain.includes("string")
      ? own
      : [];
  if (other.length === 0 || other.some((kind) => !SHOWN_KINDS.has(kind) || kind === "null"))
    return null;
  return {
    other,
    operand: own.includes("string") ? (texts.find((found) => found !== text) ?? null) : text,
  };
}

/**
 * The text-join fix (#1195): the operand that is not text, in `${...}` as the source writes it (the owner's review), on
 * one line and without a comment; else the sentence alone. The chain around it is never rebuilt: a rebuilt chain
 * changed what some chains say (S8d's reviews r3 and r4).
 */
function joinFix(
  operand: string | null,
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  source: MessageSource,
): string {
  // (the join's text, which the failed operation never gave, where its use takes it, Codex r6)
  return operand === null ||
    !ownText(operand) ||
    !source.proves({ replaces: { result: "text", operand: rule.operand } })
    ? "Put the value in the text instead."
    : `Put the value in the text as '\${${operand}}' instead.`;
}

/** Whether a subject's own text may stand in a fix's code: on one line, and without a comment. */
function ownText(code: string): boolean {
  return !/[\n\r]|\/\/|\/\*/.test(code);
}

/** The kinds `${...}` shows as text. */
const SHOWN_KINDS: ReadonlySet<ItemTag> = new Set([
  "integer",
  "number",
  "boolean",
  "null",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
]);

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
 * or object, or where the value has another type the use does not take (`besides`, a union), the words say to give one
 * of the same type; none for a handle, which has no value to write.
 */
function fallbackValue(kinds: readonly ItemTag[], besides: readonly ItemTag[]): Fallback {
  const found = known(kinds).filter((kind) => kind !== "null");
  if (found.some((kind) => hasIdentity(kind))) return null;
  // (a fallback for null alone leaves the use invalid beside another type the use does not take, as in a union)
  if (besides.length > 0) return "words";
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

/** A test a check makes of a value: after the value as code (`!= null`, `is integer`), and in words (`is not null`). */
interface Test {
  readonly code: string;
  readonly words: string;
  /** Whether the test rules out a value of the type (`MessageSource.proves`). */
  readonly rulesOut: (kind: ItemTag) => boolean;
}

const NOT_NULL: Test = {
  code: "!= null",
  words: "is not null",
  rulesOut: (kind) => kind === "null",
};

/** A length check, which rules out an empty collection. */
const NOT_EMPTY: Test = {
  code: ".length > 0",
  words: "is not empty",
  rulesOut: (kind) => kind === "empty",
};

/** The type test of `kinds` (ADR 0021 rule 3.5), where a written type names them; else `null`. */
function typeTest(kinds: readonly ItemTag[]): Test | null {
  const type = typeText(kinds);
  return type === null
    ? null
    : {
        code: `is ${type}`,
        words: `is ${described(kinds)}`,
        rulesOut: (kind) => !kinds.includes(kind),
      };
}

/**
 * The statement a check holds, as a fix writes it inside the check (#1268, TABLE r4.146): the statement of the use at
 * `site` (`MessageSource.statement`) where its text is code on one line and proved at its site but for what `test` rules
 * out (TABLE r4.162), with `value` in the place of `subject` where the fix keeps the subject in a new variable first and
 * the statement reads it once (another read would stay unchecked); else `null`, and the fix names the check in words.
 */
function guarded(
  source: MessageSource,
  site: SourceSite,
  subject: string,
  kept: boolean,
  test: Test,
): string | null {
  // (the subject the use reads: its first text inside the use's own, a receiver's or a collection's to the left)
  const read = source.text(site).indexOf(subject);
  if (read === -1) return null;
  const statement = source.statement(site, {
    file: site.file,
    start: site.start + read,
    end: site.start + read + subject.length,
  });
  if (statement === null || !source.proves({ embedded: statement, rulesOut: test.rulesOut }))
    return null;
  const text = source.text(statement);
  if (!ownText(text)) return null;
  if (!kept) return text;
  // (its only text in the statement)
  const at = site.start + read - statement.start;
  return text.indexOf(subject) !== at || text.includes(subject, at + 1)
    ? null
    : `${text.slice(0, at)}value${text.slice(at + subject.length)}`;
}

/**
 * The check that makes a use safe (ADR 0021 rules 1.9 and 3.5): of a variable directly, of any other value kept in a
 * variable first, since only a variable narrows (rule 5), around the use's statement where it holds there (`guarded`),
 * else in words, the kept value's `let` too, which moves its read; for null with a fallback where it has one, written
 * where its site admits it (`codeAt`) and the value is proved at its site (TABLE r4.162), else in words.
 */
function checkFix(
  text: string,
  test: Test,
  fallback: {
    readonly value: Exclude<Fallback, null>;
    readonly site: SiteExpectation;
    readonly diagnosed: Diagnosed;
  } | null,
  use: { readonly source: MessageSource; readonly site: SourceSite } | null,
): string {
  const name = variable(text);
  const statement =
    use !== null && ownText(text) ? guarded(use.source, use.site, text, name === null, test) : null;
  const check =
    name !== null
      ? statement === null
        ? `Check that '${name}' ${test.words} first`
        : `Check '${name}' first, as in 'if ${name} ${test.code} { ${statement} }'`
      : statement === null
        ? `Keep '${text}' in a new variable and check that it ${test.words} first`
        : `Keep '${text}' in a new variable, as in 'let value = ${text}', and check it, as in ` +
          `'if value ${test.code} { ${statement} }'`;
  if (fallback === null || !ownText(text)) return `${check}.`;
  const { value, site, diagnosed } = fallback;
  if (value === "words" || use === null || !use.source.proves())
    return `${check}, or give a fallback of the same type with 'otherwise'.`;
  // (a value the fix writes goes through the predicate, in parentheses where an operand or a receiver binds tighter)
  const fix = codeAt(
    {
      code: `${operandText(text)} otherwise ${value.code}`,
      takes: [],
      diagnosed,
      reads: "own",
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

/** The literals an example may write beside a named value as the source writes them. */
const LITERAL_OPERAND: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "durationLiteral",
  "unitExpression",
  "angleExpression",
  "booleanLiteral",
]);

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
  if (kinds.includes("null")) {
    // (no fallback for a value a store or a method changes in place: the change would be lost)
    const changed =
      rule.rule === "member" &&
      (rule.use === "store" ||
        (rule.use === "call" &&
          (listMethod(rule.member.slice(1, -2))?.changes !== undefined ||
            dictMethod(rule.member.slice(1, -2))?.changes !== undefined)));
    const fallback = changed
      ? null
      : fallbackValue(fits.length > 0 ? fits : ruleKinds(rule), besides);
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
            diagnosed,
          },
      test === null ? null : { source, site },
    );
  }
  switch (rule.rule) {
    case "selection": {
      // (a check of the collection itself only where reading it again gives the same one; any other is kept first, as
      // `groups.random` or a call, so the check and the read see one selection, Astra r2; around the read's statement
      // where it holds there, #1268, the kept value's `let` with it)
      const { collection } = rule;
      if (stablePath(collection)) {
        const statement = guarded(source, site, collection, false, NOT_EMPTY);
        return statement === null
          ? `Check the length of '${collection}' first.`
          : `Check '${collection}.length' first, as in 'if ${collection}.length > 0 { ${statement} }'.`;
      }
      const statement = ownText(collection)
        ? guarded(source, site, collection, true, NOT_EMPTY)
        : null;
      return statement === null
        ? `Keep '${collection}' in a new variable and check its length first.`
        : `Keep '${collection}' in a new variable, as in 'let value = ${collection}', and check its length, as in ` +
            `'if value.length > 0 { ${statement} }'.`;
    }
    case "count":
      if (kinds.includes("number")) return ROUND_COUNT_FIX.trimStart();
      break;
    case "store":
      if (rule.type.includes("integer") && kinds.includes("number"))
        return storeFix(rule, kinds, text, source, diagnosed).trimStart();
      break;
    case "operator": {
      // (the repairs of the error the values would be: a text join, a date and time conversion)
      const join = joined(rule, text, kinds, fits, source);
      if (join !== null) return joinFix(join.operand, rule, source);
      const temporal = temporalFix(rule, kinds, source).trimStart();
      if (temporal !== "" || !rule.operand) return temporal;
      break;
    }
    case "member":
      return memberWarningFix(rule, text, kinds, fits, detail, source, site, diagnosed);
    default:
      break;
  }
  // (a value of a type the script cannot know: tested where a test can name the type; a literal is known, and a
  // property an object may lack fails at its read, before any test)
  if (kinds.includes("unknown") && fits.length === 0) {
    const test = typeTest(ruleKinds(rule));
    return test === null || isLiteral(text) || context === "missing"
      ? ""
      : checkFix(subject, test, null, { source, site });
  }
  // (no test where the read itself stops, a property an object may lack, nor of a literal, whose type is its own)
  if (isLiteral(text) || context === "missing") return "";
  const test = typeTest(fits);
  if (test !== null) return checkFix(subject, test, null, { source, site });
  return errorFix(rule, text, kinds, source, diagnosed).trimStart();
}

/** The fix of the error a value of `kinds` would be, for a warning whose value has no kind that fits. */
function errorFix(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  switch (rule.rule) {
    case "store":
      return storeFix(rule, kinds, text, source, diagnosed);
    case "boolean":
      return conditionFix(text, kinds, source);
    case "key":
      return keyFix(text, kinds, source);
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
    // (the value to assign is the author's own: no placeholder, #1268)
    return rule.receiver === PLAYER && PERSON_FIELDS.has(name)
      ? "Copy the player profile before this line, as in 'player.copyFrom(playerProfile)' at the start of the " +
          `script, or assign 'player.${name}' first.`
      : stablePath(rule.receiver)
        ? `Assign '${rule.receiver}.${name}' before this line.`
        : "Assign the property before this line.";
  }
  // (a reference's own members are the runtime's: no test narrows them)
  const lacking = known(kinds);
  if (lacking.length === 0 || lacking.some((kind) => REFERENCE.has(kind))) return "";
  const test = typeTest(fits.filter((kind) => !kinds.includes(kind)));
  return test !== null
    ? checkFix(rule.receiver, test, null, { source, site })
    : memberFix(
        rule,
        kinds,
        text,
        UNPROVED,
        detail.receiver?.kinds ?? [],
        source,
        diagnosed,
        fits,
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

/** V30 §13: a union that holds a whole collection beside another type, with V30's suggestion where it has one. */
function writtenTypeMessage(error: WrittenTypeError, source: MessageSource): string {
  return (
    `A union cannot hold a whole list, set, or dict beside another type, but '${source.text(error.union)}' does. ` +
    (error.suggestion === null
      ? "Write the union inside the collection instead."
      : `Write '${error.suggestion}' instead.`)
  );
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
