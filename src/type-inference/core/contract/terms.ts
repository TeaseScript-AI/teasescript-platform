import type { TypeAnnotation } from "../../../ast.js";
import { VALUE_KIND_NAMES } from "../../../value-kinds.js";
import type { PlaceId, PlaceKind, TypeTerm } from "../../graph.js";
import type { CorePass } from "../answers.js";
import { makeItem, spelledBy, type Item, type ItemTag } from "../items.js";
import { propertyStep, type ValueConstraint } from "../program.js";
import type { TypeAt } from "./model.js";

// Written types as terms: their kinds, their term at a path, a value's written type, its default and the default's
// written type.

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
 * `T | null`), as a type test's narrowed kinds keep them (#1398). One ordered worklist: each node of
 * the annotation and each kind it gives handled once, however deeply its unions and optionals nest (Codex r7 on #1558).
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

/**
 * A typed parse's or load's default at `rest` by its written type (ADR 0021 rule 2.6, "its default's type"; #1072),
 * read from syntax alone, so the same in every mode, order and budget; `null` where the syntax gives none, and the
 * default's demands (`dk`, `vdk`) then read the value it holds at the call. The forms it admits, a closed set:
 * - a read of a binding or parameter with a written type: that type at the level;
 * - a read of an unwritten binding whose declaration has a start value: that value, at the same level;
 * - a list, set, dict or object literal above the level: its cells at the next step, which all give the same kinds.
 * Anything else gives `null`: another expression, a binding without a start value (a loop variable, an unwritten
 * parameter), a step the written type does not reach, a level whose kinds hold `unknown`, cells that disagree or a
 * literal without cells. Each binding followed and each literal's cell charges a unit. One item per kind, spelled as
 * written (#1398) and certain, as the finishing read gives a written type's kinds (`typedRead`).
 */
export function writtenDefault(
  pass: CorePass,
  fallback: PlaceId,
  rest: readonly string[],
): readonly Item[] | null {
  const { program, definitions } = pass;
  let kinds: readonly ItemTag[] | null = null;
  let frontier: PlaceId[] = [fallback];
  for (let level = 0; frontier.length > 0; level += 1) {
    // (the literals at this level, each walked once however many reads reach it)
    const literals = new Set<PlaceId>();
    for (const value of frontier) {
      // (a cell's own visit is charged with its store below; a default that is neither a read nor a literal costs none)
      const start = startOf(pass, value);
      if (start === null) return null;
      if (typeof start === "number") {
        if (level === rest.length) return null;
        literals.add(start);
        continue;
      }
      const at = typeAtPath(start, rest, level);
      if (at === null || !("term" in at)) return null;
      const own = typeKinds(at.term);
      if (own.includes("unknown")) return null;
      if (
        kinds !== null &&
        (own.length !== kinds.length || own.some((tag, i) => tag !== kinds![i]))
      )
        return null;
      kinds = own;
    }
    frontier = [];
    for (const literal of literals)
      for (const has of program.hasOf.get(literal) ?? []) {
        program.work.charge("invSteps");
        const cell = typeAtPath(has.type, [rest[level]!]);
        if (cell === null || !("place" in cell) || cell.rest.length > 0) return null;
        const stores = definitions.cellDefs.get(cell.place) ?? [];
        if (stores.length === 0) return null;
        for (const d of stores) {
          program.work.charge("invSteps");
          if (d.value === undefined) return null;
          frontier.push(d.value);
        }
      }
  }
  if (kinds === null) return null;
  const spelled = spelledBy(kinds);
  if (kinds.length === 1) return [makeItem(kinds[0]!, null, { cert: "def", ...spelled })];
  // (a written `T?` or union is a type a read can narrow at the call, ADR 0021 rules 5.1 and 5.2: whether rule 2.6's
  // "its default's type" is then the written or the narrowed type is an open owner question, and this clause reads the
  // written one)
  return kinds.map((tag) => makeItem(tag, null, { cert: "def", ...spelled }));
}

/**
 * What a default's value is by its syntax (`writtenDefault`): a written binding's type, through unwritten bindings'
 * start values; a collection or object literal's own value; `null` for anything else.
 */
function startOf(pass: CorePass, value: PlaceId): TypeTerm | PlaceId | null {
  const { program, definitions } = pass;
  let binding = program.occurrenceOf.get(value);
  if (binding === undefined) return program.hasOf.has(value) ? value : null;
  // (a chain of copies, followed in a loop; a binding met twice gives none)
  const met = new Set<PlaceId>();
  while (!met.has(binding)) {
    program.work.charge("invSteps");
    met.add(binding);
    const written = writtenOf(program.place(binding).kind);
    if (written !== null) return written;
    const d = definitions.declOf.get(binding);
    if (
      d === undefined ||
      d.how !== "initializer" ||
      d.kind !== "whole" ||
      d.path.length > 0 ||
      d.value === undefined
    )
      return null;
    const next = program.occurrenceOf.get(d.value);
    if (next === undefined) return program.hasOf.has(d.value) ? d.value : null;
    binding = next;
  }
  return null;
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
