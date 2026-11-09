import { WorkLedger, type WorkCounter } from "../../../src/type-inference/core/budget.js";

/*
 * Where a ledger's units are charged (#1710): the units of one counter each core function charges itself while `run`
 * runs, by the function in the first stack frame below `WorkLedger.charge`. A debit a work site owes is then observed
 * at its site, apart from every other charge of the analysis, so a test that the site charges never pins a total.
 */

/** A stack frame's function name (`at name (…)`, `at Class.name (…)`), or `null` for an anonymous one. */
function frameName(line: string): string | null {
  const found = /^\s*at (?:async )?([^\s(]+) \(/.exec(line);
  if (found === null) return null;
  const name = found[1]!;
  return name.slice(name.lastIndexOf(".") + 1);
}

/** `run`'s result and, by the function that charged them, the units of `counter` charged while it ran. */
export function chargesBySite<T>(
  counter: WorkCounter,
  run: () => T,
): { readonly result: T; readonly bySite: ReadonlyMap<string, number> } {
  const bySite = new Map<string, number>();
  const charge = WorkLedger.prototype.charge;
  WorkLedger.prototype.charge = function (this: WorkLedger, charged: WorkCounter, units = 1): void {
    if (charged === counter) {
      // (frame 0 the error, 1 this wrapper, 2 the charging function)
      const name = frameName(new Error().stack?.split("\n")[2] ?? "") ?? "(anonymous)";
      bySite.set(name, (bySite.get(name) ?? 0) + units);
    }
    charge.call(this, charged, units);
  };
  try {
    return { result: run(), bySite };
  } finally {
    WorkLedger.prototype.charge = charge;
  }
}
