import type { PlaceId } from "../../graph.js";
import type { Contract } from "../contract.js";
import { keyOf } from "../definitions.js";
import { propertyStep } from "../program.js";
import { writtenOf } from "./terms.js";

// G3 stage 1: the facts of the program that leave a binding a wrapper possible, read and charged nothing, so a key's
// lane (`lanes.ts`) and the marks (`marks.ts`) can ask them at any time.

/**
 * Whether the program's facts leave a binding a wrapper possible at `step` (any step where `null`), read and charged
 * nothing: an unwritten binding (no host, no speaker) whose one definition is its declaration's literal, every object
 * that literal is holding at `step` a cell a read of a binding is stored in. Each is a condition of
 * `wrapperShape` (its literal's step, `literalHop`), so where one fails its answer is `null` and the family's lane
 * text, no shape asked: a family that cannot be a wrapper never builds the indexes a shape reads.
 */
export function wrapperFacts(
  contract: Contract,
  binding: PlaceId,
  step: string | null = null,
): boolean {
  const { program, definitions } = contract.pass;
  const place = program.places[binding];
  if (
    place === undefined ||
    place.kind.kind !== "binding" ||
    writtenOf(place.kind) !== null ||
    program.isHost(binding) ||
    program.speakerPlaces.has(binding)
  )
    return false;
  const defs = definitions.byKey.get(keyOf(binding, [])) ?? [];
  const d = defs[0];
  if (
    defs.length !== 1 ||
    d === undefined ||
    d.how !== "initializer" ||
    d.kind !== "whole" ||
    d.value === undefined ||
    !program.hasOf.has(d.value)
  )
    return false;
  if (step === null) return true;
  return program.hasOf.get(d.value)!.every(({ type }) => {
    if (type.kind !== "object") return false;
    const property = (type.properties ?? []).find((each) => propertyStep(each.name) === step);
    if (property === undefined || property.type.kind !== "ref") return false;
    return (definitions.cellDefs.get(property.type.place) ?? []).some(
      ({ value }) =>
        value !== undefined && program.occurrenceOf.has(value) && !program.projOf.has(value),
    );
  });
}
