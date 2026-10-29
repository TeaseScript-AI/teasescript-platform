import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { keep, keptSlice } from "../budget.js";
import { typeTags, writtenOf } from "../contract.js";
import { keptKey } from "../definitions.js";
import { propertyName, propertyStep, type CoreProgram } from "../program.js";
import { copiedAt } from "./decision.js";
import { joinedDomain, permittedAt } from "./permitted.js";

// The complete type a store owes after a stop (S3 §5, TABLE r4.199, r4.200): known without the stopped decision.

/**
 * The complete type a store into `place` at `path` is checked against where a decision at, below or above the path
 * stopped (S3 §5, #1416, #1440), from a proof the stopped decision is no part of, without new solving: the place's
 * written type there (A1); else, at a path no stop lies at or above (`stopped` false), the type a copy decides the path
 * by in this pass's own decision of it, whole below it (A4, `Decided.copied`: a pass in which a decision stops is
 * restarted with it stopped, TABLE r4.180, so that decision never read what the stop took back); else, in a pass whose
 * results may stand (`standing`: not the fresh pass after a stop before admission settled, whose stores into inferred
 * places keep their marks, TABLE r4.135, r4.183), the type the declaration's start value copies there (`initialCopy`).
 * `null` where none proves it: its stores keep their marks, their type undecided. A copy a path above retains proves
 * nothing below it: a store there before that copy decides the path by its own value (`let t = hostValue`,
 * `t[0] = [1.5]`, `t = original`: `t.element` holds numbers).
 */
export function storeRequirement(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
  stopped: boolean,
  standing: boolean,
): TypeTerm | null {
  const written = writtenOf(admission.pass.program.place(place).kind);
  const term = written === null ? null : permittedAt(written, path);
  if (term !== null) return term;
  const copied = stopped ? null : copiedAt(admission, keptKey(admission.work, place, path));
  return copied ?? (written === null && standing ? initialCopy(admission, place, path) : null);
}

/**
 * One step of a declaration's start value through its object literals (`initialCopy`): a direct read of a place with
 * its own written type (`term`, the landing), or an object literal (`value`), its properties' steps made as they are
 * asked, each once in an analysis (`below`, `null` where a step proves nothing).
 */
interface Spine {
  readonly term: TypeTerm | null;
  readonly value: PlaceId;
  readonly below: Map<string, Spine | null>;
}

/** Each program's declarations' spines by place (`null`: no start value proves anything), made as they are asked. */
const SPINES = new WeakMap<CoreProgram, Map<PlaceId, Spine | null>>();

/**
 * The initializer-copy certificate (TABLE r4.200): the written type a store into an unwritten `place` at `path` owes
 * where the place's declaration's start value, through one object literal's property at each step, holds a direct read
 * of a place with its own written type at the path or above it (the landing; the start value itself for no step): the
 * start value comes before every other store into the place (ADR 0021 1.6), each step's one property selects the
 * read with no demand, and that copy decides the landing and each path below it by its written type (A4), down to the
 * path (`permittedAt`), unless that holds `null` alone (`joinedDomain`); an unrestricted part decides that every kind
 * fits, as the decision would. Source structure and written types alone, so no decision at, below or above the path,
 * stopped or not, changes it; each step made once in an analysis, kept apart from its passes. Any other start value
 * (`null`, a literal at the path, a read of an inferred place, a projection, a call, an operation, a list's element)
 * proves nothing: `null`.
 */
export function initialCopy(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): TypeTerm | null {
  const { program, definitions, lists } = admission.pass;
  const work = admission.work;
  const start = definitions.declOf.get(place);
  if (start === undefined || start.how !== "initializer" || !lists.live(start)) return null;
  let spines = SPINES.get(program);
  if (spines === undefined) SPINES.set(program, (spines = new Map()));
  let spine = spines.get(place);
  if (spine === undefined) {
    spine = start.value === undefined ? null : spineOf(admission, start.value);
    keep(work, 2);
    spines.set(place, spine);
  }
  let depth = 0;
  for (; spine !== null && spine.term === null && depth < path.length; depth += 1) {
    work.charge("checks");
    spine = below(admission, spine, path[depth]!);
  }
  if (spine?.term == null) return null;
  work.charge("checks", path.length - depth);
  const term = permittedAt(spine.term, depth === 0 ? path : keptSlice(work, path, depth));
  return term !== null && joinedDomain(typeTags(term)) !== "null" ? term : null;
}

/** A start value's step (`Spine`): a direct read of a written place, or an object literal; `null` for anything else. */
function spineOf(admission: Admission, value: PlaceId): Spine | null {
  const { program } = admission.pass;
  admission.work.charge("indexSteps");
  const binding = program.occurrenceOf.get(value);
  if (binding !== undefined) {
    const term = writtenOf(program.place(binding).kind);
    return term === null ? null : { term, value, below: new Map() };
  }
  const has = program.hasOf.get(value);
  return has?.length === 1 && has[0]!.type.kind === "object"
    ? { term: null, value, below: new Map() }
    : null;
}

/**
 * An object literal's spine at a step: its one property's value there (`literalChildren`), made once; `null` for an
 * element or a selection step, and for a property the literal does not have.
 */
function below(admission: Admission, spine: Spine, step: string): Spine | null {
  const known = spine.below.get(step);
  if (known !== undefined) return known;
  let found: Spine | null = null;
  // (a property's own step alone: an element step, a selection's `#value`, never one of an object literal's)
  if (!step.startsWith("#") && propertyStep(propertyName(step)) === step) {
    const children = admission.literalChildren(spine.value, step);
    const value = children.length === 1 ? children[0]!.value : undefined;
    if (value !== undefined) found = spineOf(admission, value);
  }
  keep(admission.work, 2);
  spine.below.set(step, found);
  return found;
}
