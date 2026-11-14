import type { TypeAnnotation } from "../../../ast.js";
import { VALUE_KIND_NAMES } from "../../../value-kinds.js";
import type { PlaceId, PlaceKind, TypeTerm } from "../../graph.js";
import type { WorkLedger } from "../budget.js";
import type { ItemTag } from "../items.js";
import { propertyStep, type ValueConstraint } from "../program.js";
import type { TypeAt } from "./model.js";

// Written types as terms: their kinds, their term at a path, a value's written type and its default.

/** The kinds a written type gives: each V30 type its own tag, `unknown` for a type the core does not model. */
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
 * `T | null`), as a type test's narrowed kinds keep them (#1398). One ordered worklist: each node of
 * the annotation and each kind it gives handled once, however deeply its unions and optionals nest (#1558).
 */
export function annotationTags(annotation: TypeAnnotation): ItemTag[] {
  const tags: ItemTag[] = [];
  // (taken from the end: a union's members pushed last first, an optional's `null` below its type, so after it)
  const pending: (TypeAnnotation | "null")[] = [annotation];
  for (let type = pending.pop(); type !== undefined; type = pending.pop()) {
    if (type === "null") {
      tags.push("null");
      continue;
    }
    switch (type.kind) {
      case "namedType":
        tags.push(type.name);
        break;
      case "listType":
        tags.push("list");
        break;
      case "setType":
        tags.push("set");
        break;
      case "dictType":
        tags.push("dict");
        break;
      case "optionalType":
        pending.push("null", type.value);
        break;
      case "unionType":
        for (let at = type.members.length - 1; at >= 0; at -= 1) pending.push(type.members[at]!);
        break;
    }
  }
  return tags;
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

/** The written type at `path`, a step at a time: no copy of the path's rest per step (#1194). */
export function typeAtPath(term: TypeTerm, path: readonly string[]): TypeAt | null {
  const at = typeAtStep(term, path, 0);
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

/** A written type node's openness (#1450): whether it admits every kind, and whether it does at or anywhere below it. */
interface Openness {
  readonly open: boolean;
  readonly below: boolean;
}

const opennessByTerm = new WeakMap<TypeTerm, Openness>();

/** A written type node's parts one level down: a collection's element, an object's properties, a union's members. */
function partsOfTerm(term: TypeTerm): readonly TypeTerm[] {
  if (term.kind === "list" || term.kind === "set" || term.kind === "dict") return [term.element];
  if (term.kind === "object") return term.properties?.map((property) => property.type) ?? [];
  return term.kind === "union" ? term.members : [];
}

/**
 * A written type node's openness, made once per node from its parts' (#1487): `open` is admission's `unrestricted`
 * (`typeTags`' `unknown`: a part the core leaves open; a union's where one of its members is), `below` also where any
 * part is, or an `object`'s properties are unwritten.
 */
export function openness(work: WorkLedger, term: TypeTerm): Openness {
  const known = opennessByTerm.get(term);
  if (known !== undefined) return known;
  const pending = [term];
  while (pending.length > 0) {
    const at = pending.at(-1)!;
    if (opennessByTerm.has(at)) {
      pending.pop();
      continue;
    }
    const parts = partsOfTerm(at);
    const unmade = parts.filter((part) => !opennessByTerm.has(part));
    if (unmade.length > 0) {
      for (const part of unmade) pending.push(part);
      continue;
    }
    pending.pop();
    work.charge("checks", 1 + parts.length);
    const below = parts.map((part) => opennessByTerm.get(part)!);
    // (a scalar restricts to its kind; a collection or an object restricts at its own level)
    const open =
      at.kind === "union"
        ? below.some((part) => part.open)
        : !["atom", "list", "set", "dict", "object"].includes(at.kind);
    opennessByTerm.set(at, {
      open,
      below:
        open ||
        (at.kind === "object" && at.properties === null) ||
        below.some((part) => part.below),
    });
  }
  return opennessByTerm.get(term)!;
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
