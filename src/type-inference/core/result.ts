import type { StoredCalendarDuration } from "../../duration.js";
import type { ConversionName } from "../../language-facts.js";
import type { ValueKind } from "../../value-kinds.js";
import type { SourceSite } from "../graph.js";
import {
  firstContext,
  ownContext,
  type ContextWord,
  type Item,
  type ItemTag,
  type Writer,
} from "./items.js";
import type { BudgetLimit } from "./budget.js";
import { propertyName } from "./program.js";

/*
 * The core's result: its outcome, its diagnostics (each with its class, kind, site, code and rule, what its sentences
 * name, and a warning's writers, context word and obligation) and the runtime checks no diagnostic owns; and its record
 * (`coreRecord`), the result as JSON-safe data, which holds no sentence.
 */

/** An error, a warning with a runtime check, a warning the runtime owes nothing for (`StaticDiagnostic`), a stop's mark. */
export type DiagnosticClass =
  "compile-error" | "warning-runtime-check" | "warning" | "not-checked-budget";

/**
 * The consumer a diagnostic belongs to: a store into a typed place (and a fallback, C10), a member or element
 * selection, a count or index, an operand (C3, C4, C11, C12).
 */
export type DiagnosticKind = "written-target" | "member-read" | "integer-use" | "operator";

export type ObligationKind =
  "copy-type" | "null-check" | "operand" | "integer-check" | "empty-check";

/**
 * The worst diagnostic's class, or `valid` without one: an error, then a warning with a runtime check, then a warning
 * without one. A stop of the analysis is a warning with a runtime check (`BudgetStop`, D4), never an outcome of its
 * own; its marks (`not-checked-budget`) set none.
 */
export type CoreOutcome = "valid" | "compile-error" | "warning-runtime-check" | "warning";

/**
 * A kind an obligation requires: a value kind; `unknown`, any value the runtime can represent (a boundary check with no
 * other contract, C9); or `non-null`, a member's receiver (C5).
 */
export type RequiredKind = ValueKind | "unknown" | "non-null";

export interface Obligation {
  readonly kind: ObligationKind;
  /** What the check reads: a key path (`targetName`), or the offending operand's or the operation's text. */
  readonly target: string;
  /** The kinds the target must have: the destination's own, never widened by the offending value (C1, C9). */
  readonly against: readonly RequiredKind[];
  /** What the check does, in words. */
  readonly on: string;
  readonly site: SourceSite;
  /** Whether it validates external data where it came in (C9, the reason `external-data`). */
  readonly boundary: boolean;
}

export interface Provenance {
  /** The writer of the item that explains the offending kind, when it has one (F28). */
  readonly writers: readonly Writer[];
  readonly context: ContextWord;
  /** What the context word's sentence names, where the core knows it at the warning (`messages.ts`, D1). */
  readonly detail: ContextDetail;
}

/**
 * What a context word's sentence names beside the warned expression's own text (D1), each where the warning's own site
 * shows it, else `null`: whether the value comes from outside the script (`unknown`, a word warnings without another
 * one carry too), the function the expression is in (`call`), the label its line is entered at (`label`), the block it
 * is in (`handler`), the place a later store decides and that store (`later`), and the receiver it reads a member of
 * (`member`, `missing`, `unmodelled`).
 */
export interface ContextDetail {
  /**
   * Whether the word is the warned read's own: only then do the details below name what the read itself depends on;
   * else the word came with a value from another line (a copy, a projection, a call) and its sentence speaks of that
   * value's origin.
   */
  readonly direct: boolean;
  /** `unknown`: the value comes from outside the script (host data, a typeless `load` or `fromJson`, F19). */
  readonly outside: boolean;
  readonly callable: string | null;
  readonly label: string | null;
  readonly handler: "button" | "timer" | "media" | null;
  readonly later: {
    readonly place: string;
    readonly kinds: readonly ItemTag[];
    readonly decider: SourceSite;
  } | null;
  readonly receiver: {
    readonly text: string;
    readonly kinds: readonly ItemTag[];
    readonly member: string;
  } | null;
}

/** A count or an index (C2): what uses it. */
export type CountUse = "repeat" | "range" | "index" | "get" | "removeAt" | "take" | "takeLast";

/**
 * The rule a diagnostic's consumer applies, with what its sentence names, in the source's own text (D2: the
 * target names stay in the obligation).
 */
export type DiagnosticRule =
  /** C1, C7, A8, A9: a store, an argument or a return into `into`, of a written or a decided type. */
  | {
      readonly rule: "store";
      readonly into: string;
      readonly type: readonly ItemTag[];
      readonly written: boolean;
      /** The store that decided the type (A2), where none is written. */
      readonly decider: SourceSite | null;
      /** A2's deferred field (ADR 0021 rule 1.1): the copy or store that brought the value of another kind. */
      readonly brought: SourceSite | null;
      /** The variable, parameter or function result the place is or lies in, which a fix declares (rule 1.1). */
      readonly root: StoreRoot | null;
      /** The steps from the root to the place: a property, or the collection an element or a dict value is in. */
      readonly steps: readonly StoreStep[];
    }
  /**
   * C10: a fallback (`otherwise`) or a default against the kinds of the value it stands in for, and the variable or
   * parameter that value lands in directly, whose written union may hold both (ADR 0021 rule 7.3).
   */
  | {
      readonly rule: "fallback";
      readonly fallback: boolean;
      readonly type: readonly ItemTag[];
      readonly root: StoreRoot | null;
    }
  | { readonly rule: "count"; readonly use: CountUse }
  /** C3: a condition (`operator` null), or an operand of `and`, `or`, `not`. */
  | { readonly rule: "boolean"; readonly operator: string | null }
  /**
   * C4: an operand of an operator, with the kinds it takes there, or the operation where no operand alone offends; the
   * operation's operands, which a fix rewrites (a date and time through a conversion), and where the operation offends as
   * a whole the kinds of its operands there (`pair`, one per operand).
   */
  | {
      readonly rule: "operator";
      readonly operator: string;
      readonly operand: boolean;
      readonly domain: readonly ItemTag[];
      readonly operands: readonly SourceSite[];
      readonly pair: readonly ItemTag[];
      /** An error's list operand of `+`: its elements' type's kinds, which a fix's list must hold. */
      readonly elements?: readonly ItemTag[];
    }
  /**
   * C11: a value `${...}` shows, or an element of a list it shows; an object's first property, a fix shows instead;
   * `elements`, the kinds of a set's elements and a dict's values it may be, which a fix may join only where `${...}`
   * shows each, as `join()` takes them (V30 §16, #1268).
   */
  | {
      readonly rule: "shown";
      readonly element: boolean;
      readonly property: string | null;
      readonly elements: readonly ItemTag[];
    }
  /** C12: a dict key. */
  | { readonly rule: "key" }
  /**
   * C13: an argument of a built-in method, `parameter` of `callee`, with the kinds it takes there (its contract's, on
   * every kind its receiver may be) and what its contract calls them (`takes`), which a fix converts to.
   */
  | {
      readonly rule: "argument";
      readonly callee: string;
      readonly parameter: string;
      readonly domain: readonly ItemTag[];
      readonly takes: "text" | "regex" | "textOrRegex" | "integer" | "list" | "collection";
    }
  /**
   * C13: the elements of `receiver` that `callee` reads, `join` each one `${...}` shows, `sort` of one
   * ordered type (`orderedFamily`); `families`, the ordered types they may hold where they mix them.
   */
  | {
      readonly rule: "elements";
      readonly callee: "join" | "sort";
      readonly receiver: string;
      readonly families: readonly ItemTag[];
    }
  /**
   * C13: a value `toJson` cannot write (`VALUE_KINDS`' `json`), its argument's own or one it holds below it
   * (`nested`), in a value of one kind (`holder`), which the runtime's sentence names.
   */
  | { readonly rule: "json"; readonly holder: ItemTag | null; readonly nested: boolean }
  /**
   * TSV029 (V30 §19): what a button returns, a choice value (`value`), an option of `askChoice` (`option`)
   * or an element of a list or set option (`element`).
   */
  | {
      readonly rule: "choice";
      readonly part: "value" | "option" | "element";
      /**
       * A choice object the options hold: the property its button returns (`value`, else `text`), and whether the object
       * is an element of the option (`within`); the sentence names that property, never its holder.
       */
      readonly member?: "value" | "text";
      readonly within?: boolean;
    }
  /** C13: the iterable of a `for`, with a key and a value variable (`entries`) or one. */
  | { readonly rule: "iterable"; readonly entries: boolean }
  /** C5a–c, F19a, ADR 1.5: a member of `receiver` (`.n`, `.add()`, `[...]`) at a read, a call or a store. */
  | {
      readonly rule: "member";
      readonly receiver: string;
      readonly member: string;
      readonly use: "read" | "call" | "store";
      /** A list's `join` read: its elements' type's kinds, which decide whether a fix's call is valid. */
      readonly elements?: readonly ItemTag[];
    }
  /**
   * C5c, ADR 1.4: a property no source of `receiver` has: a read's at the read; a store's at the object that lacks it,
   * `store` the store through the member.
   */
  | {
      readonly rule: "absent";
      readonly receiver: string;
      readonly property: string;
      readonly store: SourceSite | null;
      /** The properties the receiver's objects have, which a read's sentence names (ADR 1.8). */
      readonly properties: readonly string[];
    }
  /** C6: an element selection (`.first`, `.removeLast()`, `${...}`) of `collection`. */
  | { readonly rule: "selection"; readonly collection: string; readonly member: string }
  /**
   * ADR 0021 1.3, A8: a literal's elements, at `path` below them (key steps), of one type: the earliest element's; or a
   * run of list joins' (`operator`, `+` or `+=`), the earliest operand's elements (#1272).
   */
  | {
      readonly rule: "mixed";
      readonly collection: "list" | "set" | "dict";
      readonly path: readonly string[];
      /** The earliest element's own kinds there (a whole number as such). */
      readonly type: readonly ItemTag[];
      /**
       * The variable whose start value the literal is, which a fix declares; `null` for any other literal. For a join,
       * the first of its two operands that reads a variable or a parameter (a `+=`'s target only).
       */
      readonly root: StoreRoot | null;
      readonly operator?: "+" | "+=";
      /**
       * A join's elements at each list level from its elements down to `path`, every kind its operands bring there
       * (`null` and numbers kept): the type a fix writes; `null` below a property.
       */
      readonly levels?: readonly (readonly ItemTag[])[] | null;
      /**
       * Whether each collection layer strictly between the elements (or `path`'s last property) and the leaf may hold
       * `null`, the earliest element's (`type`) and the other's (`kinds`), outermost first: the sentence's written
       * types (#1765); absent where none may.
       */
      readonly optional?: { readonly type: readonly boolean[]; readonly kinds: readonly boolean[] };
      /**
       * #1762, #1825: each side's `path` as its sentence writes it, a dict's layer its `entry` step and a set's its
       * `member` step, a sentence's word that no path, check or key holds: the earliest element's (`type`) and the
       * other's (`kinds`); absent where both are `path`.
       */
      readonly shown?: MixedSteps;
    }
  /**
   * V30 §19: an `askChoice` whose buttons return values of more than one type (the diagnostic's kinds), stored in
   * `into`, whose type would be inferred (#1352): its root, which a fix declares, the steps below it, the types `into`
   * takes (the union to declare), and whether a collection root holds null too.
   */
  | {
      readonly rule: "mixed-choice";
      readonly into: string;
      readonly root: StoreRoot | null;
      readonly steps: readonly StoreStep[];
      readonly type: readonly ItemTag[];
      readonly optional?: true;
    };

/**
 * What the place a diagnosed value lands in takes, read from the constraint that consumes it
 * (`CoreProgram.consumersOf`): its kinds (`null`, any value: a place nothing restricts, or one nothing reads; none, where
 * no kind is proved), and how a value binds there (`whole`, as an operand of an operator, or as a member's receiver). A
 * value nothing consumes (a bare `say`) takes the shown kinds; a value an operator or a member consumes, only kinds whose
 * result the operator's or member's own site takes in turn. Every fact is stated, `unproved` where no fact proves it,
 * which gives words.
 */
export interface SiteExpectation {
  readonly takes: readonly ItemTag[] | null;
  readonly binds: "whole" | "operand" | "receiver";
  /** A collection's elements' kinds there (`null`, any). */
  readonly elements: readonly ItemTag[] | null | "unproved";
  /**
   * Whether the value divides, as a divisor or through an operation, a member or a literal that gives one, where a zero
   * stops the run.
   */
  readonly divides: boolean | "unproved";
}

/**
 * Whether every value a diagnosed expression reads is there when the script runs (#1296): an
 * element read by its index or a dict's value by its key may be absent, which no fact proves.
 */
export type Presence = true | "unproved";

/** A store's root (`DiagnosticRule` `store`): how it is declared, its name, and its declaration, which a fix rewrites. */
export interface StoreRoot {
  readonly kind: "let" | "global" | "parameter" | "result";
  readonly name: string;
  /** The declaration as written: a variable's `let` or `global` statement, a parameter with its type and default. */
  readonly site: SourceSite | null;
}

/** A variable or parameter with its own written type (#2289): its name, its declaration as written, its type. */
export interface DeclaredBinding {
  readonly name: string;
  readonly site: SourceSite;
  readonly type: readonly ItemTag[];
}

/** #1762: each side's steps of a mixed rule as its sentence writes them (`shown`). */
export interface MixedSteps {
  readonly type: readonly string[];
  readonly kinds: readonly string[];
}

/** A step below a store's root: a property by its name, or the collection whose element or dict value comes next. */
export type StoreStep =
  { readonly property: string } | { readonly collection: "list" | "set" | "dict" };

/**
 * A written type that V30 §13 does not allow: a union that holds a whole list, set or dict beside another type
 * (`written.ts`). It is the written type's own error, so no consumer owns it.
 */
export interface WrittenTypeError {
  readonly class: "compile-error";
  readonly kind: "written-type";
  readonly code: CoreCode;
  /** The whole written type. */
  readonly site: SourceSite;
  /** The offending union, the first in source order. */
  readonly union: SourceSite;
  /** The type V30 suggests in the union's place (`(integer | string)[]` for `integer | string[]`), or `null`. */
  readonly suggestion: string | null;
}

/**
 * A check that owes the runtime nothing (#1072): a known value outside the domain its use
 * takes, which the runtime would reject as it does, or a fact no run can change. An error, or a warning with no runtime
 * check (`warning`); never an obligation. Its rule names what its sentence says.
 */
export interface StaticDiagnostic {
  readonly class: "compile-error" | "warning";
  readonly kind: "static";
  readonly code: CoreCode;
  readonly site: SourceSite;
  readonly rule: StaticRule;
}

/** The rule of a `StaticDiagnostic`, with the facts its sentence names. */
export type StaticRule =
  /**
   * V30 §8 (#1701): a text method's argument domain (`TextDomain`) broken by known values, the receiver's text where it
   * reads its length: the runtime's sentence.
   */
  | { readonly rule: "text-argument"; readonly message: string }
  /** A `repeat` count whose known value is no whole number of at least 0 (`loop-rules.ts`). */
  | { readonly rule: "repeat-count"; readonly value: number }
  /** A conversion of known text it cannot convert (V30 §13, #1105), `default:` or not. */
  | { readonly rule: "conversion"; readonly conversion: ConversionName; readonly text: string }
  /**
   * ADR 0026 §5 (#1072): a date or a local date and time moved by a known calendar duration
   * with an exact offset, `+` or `-`, compound or not, beside the operation's own operand check (F16).
   */
  | {
      readonly rule: "calendar-offset";
      readonly target: "date" | "datetime";
      readonly duration: StoredCalendarDuration;
    }
  /**
   * V30 §6: a range written with whole-number literals that holds no number, as a `for` loop's iterable (`loop`) or
   * `toList()`'s receiver (`list`): its bounds as written, an ordinary warning.
   */
  | {
      readonly rule: "empty-range";
      readonly use: "loop" | "list";
      readonly start: string;
      readonly end: string;
      readonly inclusive: boolean;
    }
  /**
   * V30 §18 (#1072): the fallbacks of a chain of `otherwise` from its first link whose left side is never `null`, which
   * never run: that side and each fallback as code (`null` where a message cannot show it), and for an element read by
   * index there, the collection's kind and its parts as code, so the warning names `get` with a `default:`.
   */
  | {
      readonly rule: "unused-fallback";
      readonly subject: string | null;
      readonly fallbacks: readonly (string | null)[];
      readonly read: {
        readonly kind: "list" | "dict" | null;
        readonly object: string | null;
        readonly index: string | null;
      } | null;
    };

/** The registry codes the core's diagnostics carry (D3: a rule's one code, with both severities where it warns). */
export type CoreCode =
  | "TSV010"
  | "TSV011"
  | "TSV012"
  | "TSV029"
  | "TSV041"
  | "TSV042"
  | "TSV043"
  | "TSV044"
  | "TSV046"
  | "TSV062"
  | "TSV075"
  | "TSV076";

/** A place the analysis counts work to and names: a function, or a file's top level, with its lines' site. */
export interface WorkPlace {
  /** The function's name, or `null` for a file's top level. */
  readonly name: string | null;
  /** The file's project path. */
  readonly path: string;
  /** The function's whole declaration, or the file's top-level code. */
  readonly lines: SourceSite;
}

/**
 * The analysis stopped proving (D4): past the work allowance, at a read chain past its
 * depth (`read-depth`), or at statements nested past the nesting limit (`nesting`). One warning, at the heaviest place
 * (the deepest nesting for `nesting`): the warnings of the checks it moved to the runtime, `deferred` in number,
 * several of which one check at a store may carry.
 */
export interface BudgetStop {
  readonly class: "warning-runtime-check";
  readonly kind: "budget";
  readonly code: "TSV076";
  readonly site: SourceSite;
  readonly limit: BudgetLimit;
  readonly place: WorkPlace;
  readonly deferred: number;
}

/** "Not checked (budget)": a function, or a file's top level, some of whose checks run when it runs. */
export interface NotChecked {
  readonly class: "not-checked-budget";
  readonly kind: "budget";
  readonly code: "TSV076";
  readonly site: SourceSite;
  readonly place: WorkPlace;
}

/**
 * N10's payload of the route rule's error (N3, N10; AD-1, #1073): the rule, the writer whose value
 * brings the offending kind to the use by a route without a check, and the tests that route lacks, in the order the
 * message offers them.
 */
export interface RequiredCheck {
  readonly rule: "N3";
  /**
   * The writer, or `null` where the unchecked route starts at a block's body, which inherits no check (ADR 0021 rule
   * 5.5), with no store of its own before the use: then `block` names the statement registering that body.
   */
  readonly writer: SourceSite | null;
  /** The writer's file's path where it is not the use's file (its line is named in that file), else `null`. */
  readonly writerFile: string | null;
  /** The statement registering the block whose body the route starts in, exactly where `writer` is `null`. */
  readonly block: SourceSite | null;
  readonly missingTests: readonly string[];
  /** The read the tests name, in the source's text (not recorded). */
  readonly subject: string;
  /** The warning the route rule's error stands in for: its kinds that fit and its provenance, which its fix reads. */
  readonly fits: readonly ItemTag[];
  readonly provenance: Provenance;
}

/**
 * An error, or a warning with its explanation and its one obligation, each a consumer's with its rule's code, the rule
 * and the offending kinds (an error's every kind; a warning's explaining item's); a written type's error, which no
 * consumer owns (`WrittenTypeError`); or a stop's warning or mark (`BudgetStop`, `NotChecked`).
 */
export type CoreDiagnostic =
  | BudgetStop
  | NotChecked
  | {
      readonly class: "compile-error";
      readonly kind: DiagnosticKind;
      readonly code: CoreCode;
      readonly site: SourceSite;
      readonly rule: DiagnosticRule;
      readonly kinds: readonly ItemTag[];
      /** A member's or an operation's error: what the place its value lands in takes, which a fix's code must fit. */
      readonly expects?: SiteExpectation;
      /** Whether the values it names are there when the script runs (`unproved` where it does not say). */
      readonly present?: Presence;
      /** N10: the required check a route to the use lacks (AD-1), where the error is the route rule's. */
      readonly requiredCheck?: RequiredCheck;
      /** The route rule's error: what a new variable keeping its subject declares, as the warning's (`keeps`). */
      readonly keeps?: readonly ItemTag[] | "unproved";
    }
  | WrittenTypeError
  | {
      readonly class: "warning-runtime-check";
      readonly kind: DiagnosticKind;
      readonly code: CoreCode;
      readonly site: SourceSite;
      readonly rule: DiagnosticRule;
      readonly kinds: readonly ItemTag[];
      readonly provenance: Provenance;
      readonly obligation: Obligation;
      /**
       * The value's other known kinds that the rule takes: what a type test narrows it to (ADR 0021 rule 3.5) and what
       * a fallback stands in for (rule 1.9). None where every known kind offends, which takes the error's fix.
       */
      readonly fits: readonly ItemTag[];
      /** A null value's operation or member: what the place its value lands in takes, which a fallback must fit. */
      readonly expects?: SiteExpectation;
      /** Whether the values it names are there when the script runs (`unproved` where it does not say). */
      readonly present?: Presence;
      /**
       * The value's other known kinds that the site's other diagnostics of the rule report, each a problem of its own:
       * beside them a fix of this kind alone, such as a fallback for null, leaves the use invalid (#1268).
       */
      readonly besides: readonly ItemTag[];
      /**
       * What a new variable keeping the warned value declares (`keptTypes`): a mixed `askChoice` answer's types (V30
       * §19, #1352); `unproved` where the value is not found, so no kept form is proved; absent for a plain `let`, which
       * a warning whose facts were asked (`present`) proves.
       */
      readonly keeps?: readonly ItemTag[] | "unproved";
    };

/** A diagnostic the core reports: the analysis's own (`CoreDiagnostic`), or a check's that owes the runtime nothing. */
export type CheckedDiagnostic = CoreDiagnostic | StaticDiagnostic;

export interface CoreResult {
  readonly outcome: CoreOutcome;
  readonly diagnostics: readonly CheckedDiagnostic[];
  /**
   * The checks no shown diagnostic owns: the boundary checks (C9), then the obligations of the warnings a stop moved to
   * the runtime.
   */
  readonly checks: readonly Obligation[];
}

/** The outcome of these diagnostics: the worst class among them, or `valid`. */
export function outcomeOf(diagnostics: readonly CheckedDiagnostic[]): CoreOutcome {
  for (const outcome of ["compile-error", "warning-runtime-check", "warning"] as const)
    if (diagnostics.some((diagnostic) => diagnostic.class === outcome)) return outcome;
  return "valid";
}

/**
 * The context word of a warning about `item`: A7's `later` for a copy checked against a later decider, whatever
 * word its item carries; else an unknown's reasons' word (`reasonContext`); any other item's own word, a null's
 * ingress word, or `unknown`.
 */
export function contextOf(item: Item): ContextWord {
  if (item.context === "later") return "later";
  return ownContext(item) ?? item.word ?? "unknown";
}

/**
 * The item that explains an obligation several items owe (F28): of the unknowns the one whose word comes first,
 * since the reasons' words come before any condition's; without an unknown, the first item.
 */
export function explainingItem(items: readonly Item[]): Item | undefined {
  const unknowns = items.filter((item) => item.tag === "unknown");
  if (unknowns.length === 0) return items[0];
  return unknowns.reduce((first, item) =>
    firstContext(contextOf(first), contextOf(item)) === contextOf(first) ? first : item,
  );
}

export interface OffendingKind {
  /** The item that explains the kind. */
  readonly item: Item;
  /** The kinds it stands for: its own, or each kind the rows of one unknown operand gave. */
  readonly kinds: readonly ItemTag[];
}

/**
 * The offending kinds of these items, one per kind in the order of its first item, since each owes its own diagnostic
 * and obligation: every unknown is one kind, explained by `explainingItem`, and the items that the operator rows
 * of one unknown operand gave are one kind too.
 */
export function offendingKinds(items: readonly Item[]): OffendingKind[] {
  const unknown = explainingItem(items.filter((item) => item.tag === "unknown"));
  const groups = new Map<string, { item: Item; kinds: ItemTag[] }>();
  for (const item of items) {
    const key = item.fan === undefined ? item.tag : `fan ${item.fan}`;
    const group = groups.get(key);
    if (group === undefined)
      groups.set(key, {
        item: item.tag === "unknown" && unknown !== undefined ? unknown : item,
        kinds: [item.tag],
      });
    else if (!group.kinds.includes(item.tag)) group.kinds.push(item.tag);
  }
  return [...groups.values()];
}

/** A warning's provenance (F28): the writer of the item that explains it, its context word and the word's detail. */
export function provenanceOf(item: Item, detail: ContextDetail): Provenance {
  return { writers: item.writer === null ? [] : [item.writer], context: contextOf(item), detail };
}

/**
 * The step a selection or index adds to a target: `entry`, a dict's value, when the receiver is a dict on
 * every run; else `element`, which every list or set element, `first`, `last`, `random`, `get` and `[i]` is.
 */
export function elementStep(receiver: readonly ItemTag[]): "element" | "entry" {
  const kinds = receiver.filter((tag) => tag !== "empty");
  return kinds.length > 0 && kinds.every((tag) => tag === "dict") ? "entry" : "element";
}

/**
 * A key path as an obligation's target: the place's label from the collector (`state`, `use.data`,
 * `packet.result`) and its steps, as `state.party.element.hp`.
 */
export function targetName(label: string, steps: readonly string[]): string {
  return [label, ...steps.map(propertyName)].join(".");
}

/** A site in a record: its file's path and its span's offsets. */
export interface RecordSite {
  readonly file: string;
  readonly offset: number;
  readonly end: number;
}

export interface RecordObligation {
  readonly kind: ObligationKind;
  readonly target: string;
  readonly against: readonly RequiredKind[];
  readonly on: string;
  readonly site: RecordSite;
  readonly boundary?: true;
  readonly reason?: "external-data";
}

export interface RecordDiagnostic {
  readonly class: DiagnosticClass;
  readonly kind: CheckedDiagnostic["kind"];
  readonly site: RecordSite;
  /** A warning's explanation: writer tokens `kind@file:offset`, `more` always `false` (F28). */
  readonly provenance?: {
    readonly writers: readonly string[];
    readonly more: false;
    readonly context: ContextWord;
  };
  readonly obligation?: RecordObligation;
  /** A written type's error: its offending union and V30's suggestion (`WrittenTypeError`). */
  readonly union?: RecordSite;
  readonly suggestion?: string | null;
  /** The copy that brought a copied property's rejected kind (ADR 0021 rule 1.1). */
  readonly related?: RecordSite;
  /** N10's payload of the route rule's error (`RequiredCheck`). */
  readonly requiredCheck?: {
    readonly rule: string;
    /** `null` where the route starts at a block's body with no store of its own (`block` then names the block). */
    readonly writer: RecordSite | null;
    readonly block?: RecordSite;
    readonly missingTests: readonly string[];
  };
}

/**
 * A result as JSON-safe data: sites by file path, writers as tokens, and `runtimeChecks` holding every warning's
 * obligation, one per warning, and every other check once.
 */
export interface CoreRecord {
  readonly outcome: CoreOutcome;
  readonly diagnostics: readonly RecordDiagnostic[];
  readonly runtimeChecks: readonly RecordObligation[];
}

/**
 * The published checks: in source order of their sites, at one site the warnings' obligations in the
 * order of their diagnostics, then the other checks in their own order; the core's record keeps the same order
 * (`coreRecord`).
 */
export function checksBySite(
  owned: readonly Obligation[],
  others: readonly Obligation[],
): Obligation[] {
  const all: { readonly item: Obligation; readonly other: number }[] = [];
  for (const item of owned) all.push({ item, other: 0 });
  for (const item of others) all.push({ item, other: 1 });
  return all
    .sort(
      (a, b) =>
        a.item.site.file - b.item.site.file ||
        a.item.site.start - b.item.site.start ||
        a.item.site.end - b.item.site.end ||
        a.other - b.other,
    )
    .map(({ item }) => item);
}

/** `result` as a record, with `paths` the project's file paths by file index. */
export function coreRecord(result: CoreResult, paths: readonly string[]): CoreRecord {
  const path = (file: number): string => {
    const found = paths[file];
    if (found === undefined) throw new RangeError(`The project has no file ${file}.`);
    return found;
  };
  const site = (at: SourceSite): RecordSite => ({
    file: path(at.file),
    offset: at.start,
    end: at.end,
  });
  const obligation = (check: Obligation): RecordObligation => ({
    kind: check.kind,
    target: check.target,
    against: [...check.against],
    on: check.on,
    site: site(check.site),
    ...(check.boundary ? { boundary: true, reason: "external-data" } : {}),
  });
  const diagnostics = result.diagnostics.map((diagnostic): RecordDiagnostic =>
    // (a stop's warning and marks, and a check that owes the runtime nothing, by their site alone)
    diagnostic.kind === "budget" || diagnostic.kind === "static"
      ? { class: diagnostic.class, kind: diagnostic.kind, site: site(diagnostic.site) }
      : diagnostic.class === "compile-error"
        ? {
            class: diagnostic.class,
            kind: diagnostic.kind,
            site: site(diagnostic.site),
            ...(diagnostic.kind === "written-type"
              ? { union: site(diagnostic.union), suggestion: diagnostic.suggestion }
              : diagnostic.rule.rule === "store" && diagnostic.rule.brought !== null
                ? { related: site(diagnostic.rule.brought) }
                : {}),
            ...(diagnostic.kind !== "written-type" && diagnostic.requiredCheck !== undefined
              ? {
                  requiredCheck: {
                    rule: diagnostic.requiredCheck.rule,
                    writer:
                      diagnostic.requiredCheck.writer === null
                        ? null
                        : site(diagnostic.requiredCheck.writer),
                    ...(diagnostic.requiredCheck.block === null
                      ? {}
                      : { block: site(diagnostic.requiredCheck.block) }),
                    missingTests: [...diagnostic.requiredCheck.missingTests],
                  },
                }
              : {}),
          }
        : {
            class: diagnostic.class,
            kind: diagnostic.kind,
            site: site(diagnostic.site),
            provenance: {
              writers: diagnostic.provenance.writers.map(
                (writer) => `${writer.kind}@${path(writer.file)}:${writer.start}`,
              ),
              more: false,
              context: diagnostic.provenance.context,
            },
            obligation: obligation(diagnostic.obligation),
          },
  );
  // each diagnostic's obligation, also where two read alike (a diagnostic per obligation), then every other check once,
  // in the answers' order (`checksBySite`)
  const owned = result.diagnostics.flatMap((diagnostic) =>
    diagnostic.class === "warning-runtime-check" && diagnostic.kind !== "budget"
      ? [diagnostic.obligation]
      : [],
  );
  const listed = new Set(owned.map((check) => JSON.stringify(obligation(check))));
  const others: Obligation[] = [];
  for (const check of result.checks) {
    const key = JSON.stringify(obligation(check));
    if (listed.has(key)) continue;
    listed.add(key);
    others.push(check);
  }
  const runtimeChecks = checksBySite(owned, others).map(obligation);
  return { outcome: result.outcome, diagnostics, runtimeChecks };
}
