import type { ContractRef } from "../graph.js";
import * as clockTemporal from "./clock-temporal.js";
import * as conversions from "./conversions.js";
import * as interactions from "./interactions.js";
import * as listFunctions from "./list-functions.js";
import { methodRelation } from "./members.js";
import * as numeric from "./numeric.js";
import * as operators from "./operators.js";
import * as random from "./random.js";
import type { OperationRelation, OperationRelations } from "./relation.js";
import { dynamicResult } from "./views.js";

/**
 * The relations of every contract family the collector emits (O4 stage 2b), by the family and name of the
 * `ContractRef` of an `operation` constraint. A family that answers on a receiver (`method`) is composed by
 * `members.ts` from the member rules of the receiver kinds; an injected host builtin, which no contract module
 * knows, gives a result the compiler cannot know.
 */
const FREE_STANDING: ReadonlyMap<
  ContractRef["family"],
  ReadonlyMap<string, OperationRelation>
> = new Map([
  ["operator", operators.RELATIONS],
  ["unary", operators.RELATIONS],
  ["logic", operators.RELATIONS],
  ["comparison", operators.RELATIONS],
  ["typeTest", operators.RELATIONS],
  ["interpolation", operators.RELATIONS],
  ["angle", operators.RELATIONS],
  ["range", operators.RELATIONS],
  ["conversion", conversions.RELATIONS],
  ["builtin", conversions.RELATIONS],
  ["numeric", numeric.RELATIONS],
  ["random", random.RELATIONS],
  ["clock", clockTemporal.RELATIONS],
  ["listFunction", listFunctions.RELATIONS],
  ["interaction", interactions.RELATIONS],
  ["say", interactions.RELATIONS],
  ["showButton", interactions.RELATIONS],
  ["popup", interactions.RELATIONS],
  ["timer", interactions.RELATIONS],
  ["camera", interactions.RELATIONS],
  ["capture", interactions.RELATIONS],
  ["tagQuery", interactions.RELATIONS],
]);

/** An injected host builtin: the compiler knows nothing of its result (the legacy's `UNKNOWN_TYPE`). */
function hostBuiltin(name: string): OperationRelation {
  return { contract: { family: "builtin", name }, result: () => dynamicResult("unknown callee") };
}

const RELATIONS: OperationRelations = Object.freeze({
  relation(contract: ContractRef): OperationRelation | undefined {
    if (contract.family === "method") return methodRelation(contract.name);
    if (contract.family === "unit") return operators.unitRelation(contract.name);
    if (contract.family === "builtin" && !conversions.RELATIONS.has(contract.name))
      return hostBuiltin(contract.name);
    // A media handle whatever the media, and a speaker field by its name.
    if (contract.family === "media" || contract.family === "speakerField")
      return interactions.relationOf(contract.family, contract.name);
    const family = FREE_STANDING.get(contract.family);
    // A module that serves several families keys by `<family>.<name>`; one that serves one by the name; a family
    // whose names are open, such as `angle.<unit>` or `speakerField.playerProfile.<name>`, by `<family>.*`.
    return (
      family?.get(`${contract.family}.${contract.name}`) ??
      family?.get(contract.name) ??
      family?.get(`${contract.family}.*`)
    );
  },
});

/** The relations table, built once. */
export function operationRelations(): OperationRelations {
  return RELATIONS;
}

/** Reading a property on a receiver kind, for stage 3: a held part, a computed result, or no such member. */
export { memberOf } from "./members.js";
