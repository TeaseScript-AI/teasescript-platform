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
import { propertyName } from "./program.js";

/**
 * The structured result of the coarse core (checkpoint 9, TABLE §3.4, §4, §10.5): the outcome, the diagnostics with
 * their writers, context words and obligations, and the runtime checks; and the record the tests compare with the
 * expectation set. A diagnostic carries its class, kind, site, code and rule, with what its sentences name; `messages.ts`
 * composes them (D1–D3). The record the set compares holds no sentence.
 */

export type DiagnosticClass = "compile-error" | "warning-runtime-check";

/**
 * The consumer a diagnostic belongs to (§10.5): a store into a typed place (and a fallback, C10), a member or element
 * selection, a count or index, an operand (C3, C4, C11, C12).
 */
export type DiagnosticKind = "written-target" | "member-read" | "integer-use" | "operator";

export type ObligationKind =
  "copy-type" | "null-check" | "operand" | "integer-check" | "empty-check";

/** The worst diagnostic's class, `valid` without one, or `budget-error` at the emergency stop (TABLE §8, B1). */
export type CoreOutcome = "valid" | DiagnosticClass | "budget-error";

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
 * What a context word's sentence names beside the warned expression's own text (D1, the drafts of
 * `fable-3a-cp9-context-words.md`), each where the warning's own site shows it, else `null`: whether the value comes
 * from outside the script (`unknown`, a word warnings without another one carry too), the function the
 * expression is in (`call`), the label its line is entered at (`label`), the block it is in (`handler`), the place a
 * later store decides and that store (`later`), and the receiver it reads a member of (`member`, `missing`,
 * `unmodelled`).
 */
export interface ContextDetail {
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
export type CountUse = "repeat" | "index" | "get" | "removeAt" | "take" | "takeLast";

/**
 * The rule a diagnostic's consumer applies (TABLE §4), with what its sentence names, in the source's own text (D2: the
 * target names stay in the obligation): `messages.ts` gives each its code and its sentences (D1, D3).
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
    }
  /** C10: a fallback (`otherwise`) or a default against the kinds of the value it stands in for. */
  | { readonly rule: "fallback"; readonly fallback: boolean; readonly type: readonly ItemTag[] }
  | { readonly rule: "count"; readonly use: CountUse }
  /** C3: a condition (`operator` null), or an operand of `and`, `or`, `not`. */
  | { readonly rule: "boolean"; readonly operator: string | null }
  /** C4: an operand of an operator, with the kinds it takes there, or the operation where no operand alone offends. */
  | {
      readonly rule: "operator";
      readonly operator: string;
      readonly operand: boolean;
      readonly domain: readonly ItemTag[];
    }
  /** C11: a value `${...}` shows, or an element of a list it shows. */
  | { readonly rule: "shown"; readonly element: boolean }
  /** C12: a dict key. */
  | { readonly rule: "key" }
  /** C13: the iterable of a `for`, with a key and a value variable (`entries`) or one. */
  | { readonly rule: "iterable"; readonly entries: boolean }
  /** C5a–c, F19a, ADR 1.5: a member of `receiver` (`.n`, `.add()`, `[...]`) at a read, a call or a store. */
  | {
      readonly rule: "member";
      readonly receiver: string;
      readonly member: string;
      readonly use: "read" | "call" | "store";
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
    }
  /** C6: an element selection (`.first`, `.removeLast()`, `${...}`) of `collection`. */
  | { readonly rule: "selection"; readonly collection: string; readonly member: string }
  /** ADR 0021 1.3, A8: a literal's elements, at `path` below them, of one type: the earliest element's, `type`. */
  | {
      readonly rule: "mixed";
      readonly collection: "list" | "set" | "dict";
      readonly path: readonly string[];
      readonly type: readonly ItemTag[];
    };

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

/** The registry codes the core's diagnostics carry (D3: a rule's one code, with both severities where it warns). */
export type CoreCode = "TSV011" | "TSV012" | "TSV041" | "TSV042" | "TSV043" | "TSV044" | "TSV075";

/**
 * An error, a written type's error, or a warning with its explanation and its one obligation (§4); each a consumer's
 * with its rule's code, the rule, and the offending kinds (an error's every kind; a warning's explaining item's).
 */
export type CoreDiagnostic =
  | {
      readonly class: "compile-error";
      readonly kind: DiagnosticKind;
      readonly code: CoreCode;
      readonly site: SourceSite;
      readonly rule: DiagnosticRule;
      readonly kinds: readonly ItemTag[];
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
    };

export interface CoreResult {
  readonly outcome: CoreOutcome;
  readonly diagnostics: readonly CoreDiagnostic[];
  /** The checks that no diagnostic owns: the boundary checks (C9). */
  readonly checks: readonly Obligation[];
}

/** The outcome of these diagnostics: the worst class among them, or `valid`. */
export function outcomeOf(diagnostics: readonly CoreDiagnostic[]): CoreOutcome {
  if (diagnostics.some((diagnostic) => diagnostic.class === "compile-error"))
    return "compile-error";
  return diagnostics.length > 0 ? "warning-runtime-check" : "valid";
}

/**
 * The context word of a warning about `item` (§3.4): A7's `later` for a copy checked against a later decider, whatever
 * word its item carries (r4.10); else an unknown's reasons' word (`reasonContext`); any other item's own word, a null's
 * ingress word, or `unknown`.
 */
export function contextOf(item: Item): ContextWord {
  if (item.context === "later") return "later";
  return ownContext(item) ?? item.word ?? "unknown";
}

/**
 * The item that explains an obligation several items owe (F28, §3.4): of the unknowns the one whose word comes first,
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
  /** The kinds it stands for: its own, or each kind the rows of one unknown operand gave (§4 r4.14). */
  readonly kinds: readonly ItemTag[];
}

/**
 * The offending kinds of these items, one per kind in the order of its first item, since each owes its own diagnostic
 * and obligation (§4): every unknown is one kind, explained by `explainingItem`, and the items that the operator rows
 * of one unknown operand gave are one kind too (r4.14).
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
 * The step a selection or index adds to a target (§10.5 r4.10): `entry`, a dict's value, when the receiver is a dict on
 * every run; else `element`, which every list or set element, `first`, `last`, `random`, `get` and `[i]` is.
 */
export function elementStep(receiver: readonly ItemTag[]): "element" | "entry" {
  const kinds = receiver.filter((tag) => tag !== "empty");
  return kinds.length > 0 && kinds.every((tag) => tag === "dict") ? "entry" : "element";
}

/**
 * A key path as an obligation's target (§10.5 r4.10): the place's label from the collector (`state`, `use.data`,
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
  readonly kind: CoreDiagnostic["kind"];
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
}

/**
 * A result as JSON-safe data in the shape of the expectation set's records (`disposition.md` with TABLE §10.5): sites
 * by file path, writers as tokens, and `runtimeChecks` holding every warning's obligation, one per warning, and every
 * other check once.
 */
export interface CoreRecord {
  readonly outcome: CoreOutcome;
  readonly diagnostics: readonly RecordDiagnostic[];
  readonly runtimeChecks: readonly RecordObligation[];
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
    diagnostic.class === "compile-error"
      ? {
          class: diagnostic.class,
          kind: diagnostic.kind,
          site: site(diagnostic.site),
          ...(diagnostic.kind === "written-type"
            ? { union: site(diagnostic.union), suggestion: diagnostic.suggestion }
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
  // each diagnostic's obligation, also where two read alike (§4: a diagnostic per obligation), then every other check once
  const runtimeChecks = diagnostics.flatMap((diagnostic) =>
    diagnostic.obligation === undefined ? [] : [diagnostic.obligation],
  );
  const listed = new Set(runtimeChecks.map((check) => JSON.stringify(check)));
  for (const check of result.checks.map(obligation)) {
    const key = JSON.stringify(check);
    if (listed.has(key)) continue;
    listed.add(key);
    runtimeChecks.push(check);
  }
  return { outcome: result.outcome, diagnostics, runtimeChecks };
}
