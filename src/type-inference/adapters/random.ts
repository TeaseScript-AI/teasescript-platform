import { RANDOM_CONTRACTS, type RandomFunction } from "../../random-functions.js";
import { BOOLEAN_TYPE, INTEGER_TYPE, NUMBER_TYPE, STRING_TYPE } from "../../static-types.js";
import type { OperationInputs, OperationRelation, OperationResult } from "./relation.js";
import {
  argument,
  dynamicFrom,
  INVALID,
  isBottom,
  kindsOf,
  projectionOf,
  typeResult,
  UNCONSTRAINED,
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
          const source = inputs.arguments[0];
          if (source === undefined) return INVALID;
          if (isBottom(source)) return UNCONSTRAINED;
          const kinds = kindsOf(source);
          if (kinds.length === 0) return dynamicFrom(source, "unknown member");
          // One kind of source: a dict gives one of its keys, a list a copy of one of its elements.
          if (kinds.length !== 1) return INVALID;
          if (kinds[0] === "dict") return typeResult(STRING_TYPE);
          return kinds[0] === "list" ? projectionOf(argument(0), "element") : INVALID;
        }
      }
    },
  };
}

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map(
  Object.entries(RANDOM_CONTRACTS).map(([name, contract]) => [name, relation(name, contract)]),
);
