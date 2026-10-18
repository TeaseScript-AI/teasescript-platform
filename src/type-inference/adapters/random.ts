import { RANDOM_CONTRACTS, type RandomFunction } from "../../random-functions.js";
import {
  BOOLEAN_TYPE,
  INTEGER_TYPE,
  NUMBER_TYPE,
  STRING_TYPE,
  valueKindOfType,
} from "../../static-types.js";
import type { OperationInputs, OperationRelation, OperationResult } from "./relation.js";
import {
  argument,
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
          // The call's shape first (`shape`): a name the contract does not take, or another count, is reported and
          // the call has no value.
          if (
            [...inputs.named.keys()].some((name) => !contract.shape.names.includes(name)) ||
            inputs.arguments.length !== contract.shape.count
          )
            return INVALID;
          const source = inputs.arguments[0]!;
          if (isBottom(source)) return UNCONSTRAINED;
          // A source that may also be one the compiler cannot know is not known (`forUse` on unknown).
          if (source.dynamic !== null) return dynamicFrom(source, "unknown member");
          // The members for use: without null, which is reported, unless null is all there is.
          const all = viewMembers(source);
          const used = all.filter((member) => member.kind !== "null");
          const kinds = new Set((used.length === 0 ? all : used).map(valueKindOfType));
          // One kind of source: a dict gives one of its keys, a list a copy of one of its elements.
          if (kinds.size !== 1) return INVALID;
          const [kind] = kinds;
          if (kind === "dict") return typeResult(STRING_TYPE);
          return kind === "list" ? projectionOf(argument(0), "element") : INVALID;
        }
      }
    },
  };
}

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map(
  Object.entries(RANDOM_CONTRACTS).map(([name, contract]) => [name, relation(name, contract)]),
);
