import type { PlaceId, TypeTerm } from "../../../graph.js";
import type { CarrierKind, Operand } from "../../carriers.js";
import type { Definition, DefinitionIndex } from "../../definitions.js";
import { propertyStep, type CoreProgram } from "../../program.js";

// #2764 (B): the routes of the nesting graph, read from the program's constraints and the pass's definitions.

/**
 * A route into a receiver from a producer: `weight` the element levels the producer's value gains there. A `plain`
 * route moves a value at every property below it alike; a `property` route moves it into a property of the receiver
 * (`to`: a literal's property, a store through one property) or out of one of the producer (`from`: a property's
 * read), the other side its root (`""`); a `loose` route goes through two property steps or more, which the graph does
 * not follow by name.
 */
export type Route =
  | { readonly kind: "plain" | "loose"; readonly producer: PlaceId; readonly weight: number }
  | {
      readonly kind: "property";
      readonly producer: PlaceId;
      readonly weight: number;
      readonly from: string;
      readonly to: string;
    };

/** The type written at a place: a variable's, a parameter's or a result's; `null` where none is written. */
export function writtenAt(program: CoreProgram, place: PlaceId): TypeTerm | null {
  const kind = program.places[place]?.kind;
  if (kind === undefined) return null;
  if (kind.kind === "binding" || kind.kind === "parameter" || kind.kind === "result")
    return kind.written;
  return null;
}

/**
 * How each carrier kind (`carriers.ts`) routes its value, decided here once for every kind, so that a new kind has no
 * route until it is given one: `below`, the value stands at `below` inside its operand, so the route loses `below`'s
 * element steps and reads out of its one property; `none`, no route.
 */
const CARRIED: Readonly<Record<CarrierKind, "below" | "none">> = {
  // an element, an index, a selection (-1) or a property (0, out of it) of the owner; a dict's `values` (0)
  projection: "below",
  // a loop's element (-1)
  iteration: "below",
  // either side (0)
  otherwise: "below",
  // the receiver's element (-1), the default (0)
  get: "below",
  "load default": "below",
  "parse default": "below",
  // `toList`, `toSet`, `take`, `takeLast`: the receiver copied (0)
  copy: "below",
  // `removeAt`, `removeFirst`, a dict's `remove`: the receiver's element (-1)
  removal: "below",
  // a list `+`'s operand (0)
  concatenation: "below",
  // a choice's answer is a scalar button (V30 §19, TSV029): it holds no level an option's could pass on
  choice: "none",
};

/**
 * The graph's routes by receiver, each charged as it is read: 0 for a whole copy, an argument, a return, a read and a
 * call's result; +1 for a list literal's element and an `add`; a store through a path, the path's element steps; a
 * literal's property, 0 into that property. A projection and an operation take the carrier table's routes (`operands`:
 * `carriers.ts`'s `operandsOf`, the one home of which operand an operation's value stands in, and where): the value
 * stands at `below` inside its operand, so the route loses `below`'s element steps and reads out of its property. A
 * place with a written type takes no route: the written type decides it. A form not named here makes no route, so a
 * cycle through it is never cut.
 */
export function routesOf(
  program: CoreProgram,
  definitions: DefinitionIndex,
  live: (d: Definition) => boolean,
  operands: (value: PlaceId) => readonly Operand[],
): Map<PlaceId, Route[]> {
  const work = program.work;
  const into = new Map<PlaceId, Route[]>();
  const add = (receiver: PlaceId, route: Route): void => {
    // a written type decides its place: no route into it counts
    if (writtenAt(program, receiver) !== null) return;
    const list = into.get(receiver);
    if (list === undefined) into.set(receiver, [route]);
    else list.push(route);
  };
  const plain = (receiver: PlaceId, producer: PlaceId, weight: number): void =>
    add(receiver, { kind: "plain", producer, weight });
  const store = (d: Definition): void => {
    work.charge("indexSteps");
    if (d.value === undefined || (d.kind !== "whole" && d.kind !== "add")) return;
    if (!program.live(d.node) || !live(d)) return;
    const elements = d.path.filter((step) => step === "element").length;
    const weight = elements + (d.kind === "add" ? (d.how === "elements" ? 0 : 1) : 0);
    const properties = d.path.filter((step) => step !== "element");
    if (properties.length === 0) plain(d.place, d.value, weight);
    else if (properties.length === 1)
      add(d.place, { kind: "property", producer: d.value, weight, from: "", to: properties[0]! });
    else add(d.place, { kind: "loose", producer: d.value, weight });
  };
  for (const list of definitions.byKey.values()) for (const d of list) store(d);
  for (const list of definitions.cellDefs.values()) for (const d of list) store(d);
  for (const [cell, owner] of program.cellOwner) {
    work.charge("indexSteps");
    const kind = program.places[cell]?.kind;
    if (owner.kind === "cell") plain(owner.owner, cell, 1);
    else if (kind?.kind === "property")
      add(owner.owner, {
        kind: "property",
        producer: cell,
        weight: 0,
        from: "",
        to: propertyStep(kind.name),
      });
  }
  for (const constraint of program.constraints) {
    work.charge("indexSteps");
    switch (constraint.kind) {
      case "read":
        plain(constraint.occurrence, constraint.binding, 0);
        break;
      case "call":
        plain(constraint.result, program.functionOf(constraint.fn).result, 0);
        break;
      default:
        break;
    }
  }
  for (const value of [...program.projOf.keys(), ...program.opOf.keys()])
    for (const { kind, operand, below } of operands(value)) {
      work.charge("indexSteps");
      if (CARRIED[kind] === "none") continue;
      const elements = below.filter((step) => step === "element").length;
      const properties = below.filter((step) => step !== "element");
      if (properties.length === 0) plain(value, operand, -elements);
      else if (properties.length === 1)
        add(value, {
          kind: "property",
          producer: operand,
          weight: -elements,
          from: properties[0]!,
          to: "",
        });
      else add(value, { kind: "loose", producer: operand, weight: -elements });
    }
  return into;
}
