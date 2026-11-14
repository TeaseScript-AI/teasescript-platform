// The values stored into a function's places (`Transfer`): the declaration a check of one reads, and the words the plan
// labels its place with.
import type { Declaration, SliceIndex, Transfer } from "./slice-index.js";

/** A transfer's place as its check reads it: its declaration, and the place in the plan's words. */
export interface TransferTarget {
  /** A parameter, or the function's result as its name and written result type; `undefined` for an argument no parameter takes. */
  readonly declaration: Declaration | undefined;
  /** `parameter 'x' of 'f'`, or `the result of 'f'`, as today's checker labels the same place. */
  readonly label: string;
}

/** The place a transfer stores into: the parameter an argument fills, a default's parameter, a `return`'s result. */
export function transferTarget(index: SliceIndex, store: Transfer): TransferTarget {
  if (store.kind === "returnStatement") {
    const fn = index.functionOf(store);
    return {
      declaration:
        fn === undefined
          ? undefined
          : { kind: "functionResult", name: fn.name, typeAnnotation: fn.returnTypeAnnotation },
      label: `the result of '${fn?.name.name ?? ""}'`,
    };
  }
  const owner =
    store.kind === "functionParameter"
      ? { fn: index.functionOf(store), parameter: store }
      : index.parameterOf(store);
  return {
    declaration: owner?.parameter,
    label: `parameter '${owner?.parameter?.name.name ?? ""}' of '${owner?.fn?.name.name ?? ""}'`,
  };
}
