import type { CallArgument, FunctionParameter } from "./ast.js";

/**
 * The parameter of an author function that an argument of a call binds: a named argument's own name, or for a
 * positional argument the parameter at the argument's place among the call's arguments; `undefined` when the function
 * has no parameter there. The lowering binds arguments by it, and the coarse core's flow graph decides by it which
 * parameter defaults run.
 */
export function boundParameterName(
  parameters: readonly FunctionParameter[],
  argument: CallArgument,
  index: number,
): string | undefined {
  return argument.kind === "namedArgument" ? argument.name.name : parameters[index]?.name.name;
}
