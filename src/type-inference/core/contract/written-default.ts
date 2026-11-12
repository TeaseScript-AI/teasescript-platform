import type { PlaceId, TypeTerm } from "../../graph.js";
import type { CorePass } from "../answers.js";
import type { DefinitionIndex } from "../definitions.js";
import { makeItem, spelledBy, type Item, type ItemTag } from "../items.js";
import { conversionCategory } from "../method-categories.js";
import { propertyStep, type CoreProgram } from "../program.js";
import { defaultOf, typeAtPath, typeKinds, writtenOf } from "./terms.js";

// A typed parse's or load's default read by its written type (ADR 0021 rule 2.6, "its default's type"; #1072 step 0):
// the rule (`writtenDefault`) and the index of program facts it reads. A variable with a written type gives that type,
// whatever value it holds at the call: no narrowing at the read (rules 5.1, 5.2) enters it.

/** What a value is to the rule: the written type at a read of a written binding, a literal with parts, or nothing. */
type Start = { readonly term: TypeTerm } | { readonly literal: PlaceId } | null;

/** A literal's cells at one step: their written types, each once, and the literals among them, each once. */
interface Cells {
  readonly terms: readonly TypeTerm[];
  readonly literals: readonly PlaceId[];
}

/**
 * The facts of a program the rule reads, built once per pass from syntax alone, before anything is solved: for each
 * typed default, what it starts as, through unwritten bindings' start values; for each literal it reaches, its cells
 * at each step. It holds no answer of the analysis, so it is the same in every mode, order and budget, and its charge
 * (each binding followed, each step and cell entered) is paid where it is built, never by the demand that reads it.
 * A program with no typed default that reads a binding or is a literal builds nothing.
 */
export class WrittenDefaults {
  readonly #starts = new Map<PlaceId, Start>();
  /** Per literal, its cells by step; `null` where a cell gives nothing. */
  readonly #cells = new Map<PlaceId, Map<string, Cells | null>>();

  public constructor(program: CoreProgram, definitions: DefinitionIndex) {
    const pending: PlaceId[] = [];
    const enter = (value: PlaceId): Start => {
      const start = this.#startOf(program, definitions, value);
      if (start !== null && "literal" in start && !this.#cells.has(start.literal)) {
        this.#cells.set(start.literal, new Map());
        pending.push(start.literal);
      }
      return start;
    };
    for (const c of program.constraints) {
      const fallback =
        c.kind === "load"
          ? (c.fallback ?? undefined)
          : c.kind === "operation" &&
              c.contract.family === "conversion" &&
              conversionCategory(c.contract.name)?.kind === "parses"
            ? defaultOf(c)
            : undefined;
      if (fallback !== undefined) enter(fallback);
    }
    // (literals in a worklist, each entered once: a deeply nested default recurses nowhere)
    for (let literal = pending.pop(); literal !== undefined; literal = pending.pop()) {
      const steps = this.#cells.get(literal)!;
      for (const has of program.hasOf.get(literal) ?? [])
        for (const [step, cell] of cellSteps(has.type)) {
          program.work.charge("indexSteps");
          if (steps.get(step) === null) continue;
          const terms = new Set(steps.get(step)?.terms);
          const literals = new Set(steps.get(step)?.literals);
          let found = true;
          for (const d of definitions.cellDefs.get(cell) ?? []) {
            program.work.charge("indexSteps");
            const start = d.value === undefined ? null : enter(d.value);
            if (start === null) found = false;
            else if ("term" in start) terms.add(start.term);
            else literals.add(start.literal);
          }
          steps.set(
            step,
            found && terms.size + literals.size > 0
              ? { terms: [...terms], literals: [...literals] }
              : null,
          );
        }
    }
  }

  /** What a value starts as (`Start`), through unwritten bindings' start values, each binding followed once. */
  #startOf(program: CoreProgram, definitions: DefinitionIndex, value: PlaceId): Start {
    const known = this.#starts.get(value);
    if (known !== undefined) return known;
    let start: Start = program.hasOf.has(value) ? { literal: value } : null;
    // (a chain of copies, followed in a loop; each read on it given the chain's end; a binding met twice ends it)
    const reads: PlaceId[] = [value];
    const met = new Set<PlaceId>();
    for (let binding = program.occurrenceOf.get(value); binding !== undefined;) {
      program.work.charge("indexSteps");
      if (met.has(binding)) {
        start = null;
        break;
      }
      met.add(binding);
      const written = writtenOf(program.place(binding).kind);
      if (written !== null) {
        start = { term: written };
        break;
      }
      const d = definitions.declOf.get(binding);
      if (
        d === undefined ||
        d.how !== "initializer" ||
        d.kind !== "whole" ||
        d.path.length > 0 ||
        d.value === undefined
      ) {
        start = null;
        break;
      }
      const known = this.#starts.get(d.value);
      if (known !== undefined) {
        start = known;
        break;
      }
      reads.push(d.value);
      start = program.hasOf.has(d.value) ? { literal: d.value } : null;
      binding = program.occurrenceOf.get(d.value);
    }
    for (const read of reads) this.#starts.set(read, start);
    return start;
  }

  /** What a default starts as; `null` for one the index did not enter. */
  public start(value: PlaceId): Start {
    return this.#starts.get(value) ?? null;
  }

  /** A literal's cells at `step`; `null` where it has none or one gives nothing. */
  public cells(literal: PlaceId, step: string): Cells | null {
    return this.#cells.get(literal)?.get(step) ?? null;
  }
}

/** The steps of a literal's own type to its cells: a collection's `element`, an object's properties. */
function cellSteps(type: TypeTerm): [string, PlaceId][] {
  if (type.kind === "list" || type.kind === "set" || type.kind === "dict")
    return type.element.kind === "ref" ? [["element", type.element.place]] : [];
  if (type.kind !== "object") return [];
  return (type.properties ?? []).flatMap((property): [string, PlaceId][] =>
    property.type.kind === "ref" ? [[propertyStep(property.name), property.type.place]] : [],
  );
}

/**
 * A typed parse's or load's default at `rest` by its written type, from the index's program facts
 * (`WrittenDefaults`); `null` where its syntax gives none, and the default's demands (`dk`, `vdk`) then read the value
 * it holds at the call. The forms it admits, a closed set:
 * - a read of a binding or parameter with a written type: that type at the level, whatever value it holds there;
 * - a read of an unwritten binding whose declaration has a start value: that value, at the same level;
 * - a list, set, dict or object literal above the level: its cells at the next step, which all give the same kinds.
 * Anything else gives `null`: another expression, a binding without a start value (a loop variable, an unwritten
 * parameter), a step the written type does not reach, a level whose kinds hold `unknown`, cells that disagree or a
 * literal without cells. Each literal and written type it enters at a level charges a unit, however many cells hold
 * it. One item per kind, spelled as written (#1398) and certain, as the finishing read gives a written type's kinds
 * (`typedRead`).
 */
export function writtenDefault(
  pass: CorePass,
  fallback: PlaceId,
  rest: readonly string[],
): readonly Item[] | null {
  const { program, writtenDefaults } = pass;
  const start = writtenDefaults.start(fallback);
  if (start === null) return null;
  // (the kinds every written type met gives, each read from the level it is met at)
  const met: { kinds: readonly ItemTag[] | null } = { kinds: null };
  const meet = (term: TypeTerm, level: number): boolean => {
    program.work.charge("invSteps");
    const at = typeAtPath(term, rest, level);
    if (at === null || !("term" in at)) return false;
    const own = typeKinds(at.term);
    if (own.includes("unknown")) return false;
    const kinds = met.kinds;
    if (kinds !== null && (own.length !== kinds.length || own.some((tag, i) => tag !== kinds[i])))
      return false;
    met.kinds = own;
    return true;
  };
  if ("term" in start) {
    if (!meet(start.term, 0)) return null;
  } else {
    let literals = new Set<PlaceId>([start.literal]);
    for (let level = 0; literals.size > 0; level += 1) {
      if (level === rest.length) return null;
      const below = new Set<PlaceId>();
      for (const literal of literals) {
        program.work.charge("invSteps");
        const cells = writtenDefaults.cells(literal, rest[level]!);
        if (cells === null) return null;
        for (const term of cells.terms) if (!meet(term, level + 1)) return null;
        for (const each of cells.literals) below.add(each);
      }
      literals = below;
    }
  }
  const { kinds } = met;
  if (kinds === null) return null;
  const spelled = spelledBy(kinds);
  return kinds.map((tag) => makeItem(tag, null, { cert: "def", ...spelled }));
}
