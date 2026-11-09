/** The plan's fields that each hold a check the script runs (`src/plan/model.ts`). */
const CHECK_FIELDS = new Set([
  "typeCheck",
  "indexCheck",
  "fallbackCheck",
  "expected",
  "repair",
  "requireExisting",
  "partChecks",
]);

/**
 * The checks a plan runs (#2081): each check field of every instruction once, and each part check. An explicit stack,
 * so a plan nested deeper than a recursive walk can follow is counted too. Read by `tests/type-core/type-core-budget.test.ts` and,
 * from a built tree, by `tools/compiler-replay.mjs`.
 */
export function planChecks(plan: unknown): number {
  let count = 0;
  const pending: unknown[] = [plan];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) for (const each of value) pending.push(each);
    else if (typeof value === "object" && value !== null)
      for (const [key, each] of Object.entries(value)) {
        if (CHECK_FIELDS.has(key) && each !== undefined && each !== false)
          count += Array.isArray(each) ? each.length : 1;
        pending.push(each);
      }
  }
  return count;
}
