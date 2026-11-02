import type { TypeAnnotation } from "../../../ast.js";
import { VALUE_KIND_NAMES } from "../../../value-kinds.js";
import type { PlaceId, PlaceKind, TypeTerm } from "../../graph.js";
import type { ItemTag } from "../items.js";
import { propertyStep, type ValueConstraint } from "../program.js";
import type { TypeAt } from "./model.js";

// Written types as terms: their kinds, their term at a path, a value's written type and its default.

/** The kinds a written type gives (F2): each V30 type its own tag, `unknown` for a type the core does not model. */
export function typeTags(term: TypeTerm): ItemTag[] {
  switch (term.kind) {
    case "atom":
      return [term.name];
    case "list":
    case "set":
    case "dict":
    case "object":
      return [term.kind];
    case "union":
      return term.members.flatMap(typeTags);
    default:
      return ["unknown"];
  }
}

/**
 * A written type annotation's kinds in their written order: those `typeTags` gives the term made of it (`T?` is
 * `T | null`), as a type test's narrowed kinds keep them (#1398, TABLE r4.277 (3)).
 */
export function annotationTags(annotation: TypeAnnotation): ItemTag[] {
  switch (annotation.kind) {
    case "namedType":
      return [annotation.name];
    case "listType":
      return ["list"];
    case "setType":
      return ["set"];
    case "dictType":
      return ["dict"];
    case "optionalType":
      return [...annotationTags(annotation.value), "null"];
    case "unionType":
      return annotation.members.flatMap(annotationTags);
  }
}

/**
 * `typeTags` once each, in written order: the items a written type stands for, where a repeated member of a union adds
 * no alternative (V30 §13), so a read merging them pays for its kinds, never its written members (#1256).
 */
export function typeKinds(term: TypeTerm): ItemTag[] {
  return [...new Set(typeTags(term))];
}

/**
 * The steps every walk of a written type took (`typeAtPath`), uncharged work no ledger reaches: the work test counts
 * them for #1194's gate (`writtenTypeSteps`).
 */
let typeSteps = 0;

/** The steps the walks of written types took so far in this process (`typeAtPath`): the work test's count, #1194. */
export function writtenTypeSteps(): number {
  return typeSteps;
}

/** Steps read by position: an array's, or a cursor's path's as its record keeps them (`PathSteps`). */
export interface StepRead {
  readonly length: number;
  at(index: number): string | undefined;
}

/** The written type at `path` from its step `from` on, a step at a time: no copy of the path's rest per step (#1194). */
export function typeAtPath(term: TypeTerm, path: readonly string[], from = 0): TypeAt | null {
  const at = typeAtStep(term, path, from);
  return at === null || "term" in at ? at : { place: at.place, rest: path.slice(at.below) };
}

/** `typeAtPath` read by position: a ref's rest as the step it starts at. */
function typeAtStep(
  term: TypeTerm,
  path: StepRead,
  from: number,
): { readonly term: TypeTerm } | { readonly place: PlaceId; readonly below: number } | null {
  let at = term;
  for (let index = from; index < path.length; index += 1) {
    typeSteps += 1;
    // an optional or union collection: its members' elements
    if (at.kind === "union") {
      const members = at.members
        .map((member) => typeAtStep(member, path, index))
        .filter((member) => member !== null);
      if (members.length === 1) return members[0]!;
      const terms = members.flatMap((member) => ("term" in member ? [member.term] : []));
      if (members.length > 1 && terms.length === members.length)
        return { term: { kind: "union", members: terms } };
      return null;
    }
    const step = path.at(index)!;
    let below: TypeTerm;
    if ((at.kind === "list" || at.kind === "set" || at.kind === "dict") && step === "element")
      below = at.element;
    else if (at.kind === "object" && at.properties !== null) {
      const property = at.properties.find((candidate) => propertyStep(candidate.name) === step);
      if (property === undefined) return null;
      below = property.type;
    } else return null;
    if (below.kind === "ref") return { place: below.place, below: index + 1 };
    at = below;
  }
  return { term: at };
}

/** The term of a written type at a path, when the path stays in the written type. */
export function termAt(term: TypeTerm, path: StepRead): TypeTerm | null {
  const at = typeAtStep(term, path, 0);
  return at !== null && "term" in at ? at.term : null;
}

/** The written type of a place, when it has one. */
export function writtenOf(kind: PlaceKind): TypeTerm | null {
  return kind.kind === "binding" || kind.kind === "parameter" || kind.kind === "result"
    ? kind.written
    : null;
}

/** The value of a `default:` named argument. */
export function defaultOf(c: ValueConstraint): PlaceId | undefined {
  return "named" in c ? c.named.find((argument) => argument.name === "default")?.value : undefined;
}

/** The kind of a unit literal: `2 s`, `1 calendar day`, `20 deg`. */
export function unitKind(family: "unit" | "angle", name: string): ItemTag {
  if (family === "angle") return "angle";
  return name.startsWith("calendar ") ? "calendarDuration" : "duration";
}

/** A conversion's result as a value kind. */
export function conversionKind(result: string): ItemTag {
  const kind = VALUE_KIND_NAMES.find((candidate) => candidate === result);
  if (kind === undefined) throw new Error(`A conversion gives no value kind '${result}'.`);
  return kind;
}
