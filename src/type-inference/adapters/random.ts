import { RANDOM_CONTRACTS, type RandomFunction } from "../../random-functions.js";
import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  NUMBER_TYPE,
  resolved,
  STRING_TYPE,
  union,
} from "../../static-types.js";
import type { OperationInputs, OperationRelation, OperationResult } from "./relation.js";
import {
  dynamicFrom,
  INVALID,
  isBottom,
  projectionOf,
  typeResult,
  UNCONSTRAINED,
  viewMembers,
} from "./views.js";

/**
 * The random functions (O4 stage 2b), as `#randomFunctionType` of the legacy checker gives them: a draw of numbers
 * is a number or a chance, a draw from a range an integer, and `randomWeighted` a key of a dict of weights or a copy
 * of an element of a list with `weight:`. The weights' domains and the arguments' kinds are the visitor's checks;
 * the result stands whatever they report.
 */
function relation(name: string, contract: RandomFunction): OperationRelation {
  return {
    contract: { family: "random", name },
    result(inputs: OperationInputs): OperationResult {
      switch (contract.takes) {
        case "numbers":
          return typeResult(contract.result === "boolean" ? BOOLEAN_TYPE : NUMBER_TYPE);
        case "range":
          return typeResult(INTEGER_TYPE);
        case "choices": {
          // `weightedType`: the call's shape first (a name the contract does not take, another count: no value);
          // then the source for use (`forUse`: without null unless null is all there is): one it cannot know gives
          // unknown; the one resolved type of its members, a dict, gives a key, a list a copy of its element; any
          // other, a union of collections included, is reported and has no value. The `weight:` checks are the
          // visitor's.
          if (
            [...inputs.named.keys()].some((name) => !contract.shape.names.includes(name)) ||
            inputs.arguments.length !== contract.shape.count
          )
            return INVALID;
          const source = inputs.arguments[0]!;
          if (isBottom(source)) return UNCONSTRAINED;
          if (source.dynamic !== null) return dynamicFrom(source, "unknown member");
          const all = viewMembers(source);
          const used = all.filter((member) => member.kind !== "null");
          const value = resolved(union(used.length === 0 ? all : used));
          if (value.kind === "dict") return typeResult(STRING_TYPE);
          // the selected element: a projection of the source's element, parts shared, not its type echoed
          return value.kind === "list" ? projectionOf({ argument: 0 }, "element") : INVALID;
        }
      }
    },
  };
}

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map(
  Object.entries(RANDOM_CONTRACTS).map(([name, contract]) => [name, relation(name, contract)]),
);
