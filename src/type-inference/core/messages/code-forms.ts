import { parse } from "../../../parser.js";
import type { SourceSite } from "../../graph.js";
import { TEXT_METHODS } from "../../../text-operations.js";
import { VALUE_KIND_NAMES, VALUE_KINDS } from "../../../value-kinds.js";
import { fits } from "../admission.js";
import type { ItemTag } from "../items.js";
import type { Presence, SiteExpectation } from "../result.js";
import { expressionKind, OPERANDS, ownText, POSTFIX } from "./words.js";

// The code forms a fix offers (TABLE r4.151): where each stands, and whether its code holds there.

/**
 * What one operation of a code form takes of a subject: the subject's kinds, each of which it must take; `held`, a
 * value it holds (a list's element), whose structure must fit too.
 */
export interface Takes {
  readonly subject: readonly ItemTag[];
  readonly takes: readonly ItemTag[];
  readonly held: boolean;
}

/** The kinds whose structure a kind alone does not say: an object's properties, a collection's elements. */
const STRUCTURED: ReadonlySet<ItemTag> = new Set(["object", "list", "set", "dict"]);

/**
 * A diagnostic's facts a code form reads: whether the values it names are there, and whether its program runs; and
 * whether an author's text lies clear of the analysis's other diagnostics (`alone`, `MessageSource.alone`).
 */
export interface Diagnosed {
  readonly present: Presence;
  readonly severity: "error" | "warning";
  readonly alone: (held: SourceSite, rulesOut: ((kind: ItemTag) => boolean) | null) => boolean;
}

/**
 * A code form a fix offers, every fact stated (TABLE r4.162): its code; what each of its operations takes (fact 1);
 * its diagnostic's facts (`diagnosed`), and whether the values it reads are the site's own, read once where they stand
 * (`own`), it reads them again or elsewhere (`added`), or it adds none (`none`: a type, a literal of its own, a
 * declaration restated with its start value as written); the author's texts it holds (`holds`: the diagnosed value, a
 * statement, a declaration), each clear of the analysis's other diagnostics but one at the diagnosed site of only the
 * types it rules out (`rulesOut`: a check's test, the types a value it writes in place of the diagnosed one lacks,
 * `unlike`); the kinds its value has (fact 2), with a collection's elements' kinds (none for a scalar); and whether it
 * writes a value of its own (a fallback's), which the script never held.
 */
interface CodeForm {
  readonly code: string;
  readonly takes: readonly Takes[];
  readonly diagnosed: Diagnosed;
  readonly reads: "own" | "added" | "none";
  readonly holds: readonly SourceSite[];
  readonly rulesOut: ((kind: ItemTag) => boolean) | null;
  readonly gives: readonly ItemTag[];
  readonly elements: readonly ItemTag[] | "unproved";
  readonly writes: boolean;
}

/** A site no fact describes: no value is proved to fit it. */
export const UNPROVED: SiteExpectation = {
  takes: [],
  binds: "whole",
  elements: "unproved",
  divides: "unproved",
};

/**
 * A site that holds no value, where a form stands as the language's grammar takes it there: a line of its own (a
 * statement), a function's parameter, a written type.
 */
type Position = "statement" | "parameter" | "type";

/**
 * The types a value a form computes in place of the diagnosed one, from its parts, does not have: a diagnostic at the
 * site of only those is the replaced value's own, which the form's result decides instead (`codeAt`'s fact 2), as a
 * failed call's value the script cannot know. Not for a form that keeps the diagnosed value, whose site's diagnostics
 * are of the text it holds.
 */
export const unlike =
  (gives: readonly ItemTag[]) =>
  (kind: ItemTag): boolean =>
    !gives.includes(kind);

/** The kinds `${...}` shows (V30 §8), which `join` joins. */
export const SHOWN_KINDS_ALL: readonly ItemTag[] = VALUE_KIND_NAMES.filter(
  (kind) => VALUE_KINDS[kind].shown !== null,
);

/** What `${...}` takes of the value it holds (V30 §8): a value it shows, whole within its braces. */
export const SHOWN_SITE: SiteExpectation = {
  takes: SHOWN_KINDS_ALL,
  binds: "whole",
  elements: null,
  divides: false,
};

/** The kinds a text method's result has (`TEXT_METHODS`). */
export function textResult(
  result: (typeof TEXT_METHODS)[keyof typeof TEXT_METHODS]["result"],
): ItemTag[] {
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

/** Whether code is, by the language's own parser, exactly one construct of a position on one line. */
function standsAt(code: string, position: Position): boolean {
  const [prefix, suffix] =
    position === "statement"
      ? ["", "\nexit\n"]
      : position === "parameter"
        ? ["function fix(", ") {\n}\nexit\n"]
        : ["let fix: ", " = null\nexit\n"];
  const parsed = parse(`${prefix}${code}${suffix}`);
  const statement = parsed.program.statements[0];
  if (parsed.diagnostics.length > 0 || statement === undefined) return false;
  const span =
    position === "statement"
      ? statement.span
      : position === "parameter"
        ? statement.kind === "functionDeclaration" && statement.parameters.length === 1
          ? statement.parameters[0]!.span
          : null
        : statement.kind === "letStatement"
          ? statement.typeAnnotation?.span
          : null;
  return (
    span !== null &&
    span !== undefined &&
    span.start.offset === prefix.length &&
    span.end.offset === prefix.length + code.length
  );
}

/**
 * TABLE r4.151: the one test of every code form a fix offers, pasted whole at the site its diagnostic sits on or the
 * position its sentence names. It holds where (1) each operation takes its subject: every value the form reads there
 * when the script runs, every kind of it known, and one the operation takes, a value it holds of a flat structure;
 * every author's text it holds clear of the analysis's other diagnostics, and of any region a stop left unchecked
 * (TABLE r4.162, Astra r3 on #1273); (2) its value fits what the site takes (`site`, read from what consumes the value
 * there: any value where nothing restricts it), a structured value only there or as a collection of scalars against its
 * elements' kinds, and a value the fix writes itself only where the value is proved not to divide; and (3) it binds
 * there: as the site's whole value, or in parentheses where an operand or a receiver binds tighter than its code; at a
 * position as one statement, parameter or type (TABLE r4.171). A site fact no fact proves gives words, never a form
 * (TABLE r4.162). Its code, so grouped, where it holds; `null` where it does not, and the fix gives its advice in
 * words.
 */
export function codeAt(form: CodeForm, site: SiteExpectation | Position): string | null {
  const proved = (kinds: readonly ItemTag[]): boolean =>
    kinds.length > 0 && kinds.every((kind) => kind !== "unknown" && kind !== "empty");
  const fit = (kinds: readonly ItemTag[], takes: readonly ItemTag[]): boolean =>
    proved(kinds) && kinds.every((kind) => takes.some((tag) => fits(kind, tag, true)));
  // (a value held in a place, or landing in one that takes some type, fits by its structure too: the kinds alone prove
  // it only for a scalar, or a collection of scalars against its elements' kinds, Codex r6)
  const flat = (kinds: readonly ItemTag[]): boolean => !kinds.some((kind) => STRUCTURED.has(kind));
  // (the values it reads are there when the script runs: none read, proved, or a warning's own reads, which its program
  // already performs where they stand, wrapped there in place, TABLE r4.168)
  const there =
    form.reads === "none" ||
    form.diagnosed.present === true ||
    (form.diagnosed.severity === "warning" && form.reads === "own");
  if (
    !there ||
    !ownText(form.code) ||
    !form.takes.every(
      ({ subject, takes, held }) => fit(subject, takes) && (!held || flat(subject)),
    ) ||
    !form.holds.every((held) => form.diagnosed.alone(held, form.rulesOut))
  )
    return null;
  if (typeof site === "string") return standsAt(form.code, site) ? form.code : null;
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
