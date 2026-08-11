/** Test-only validation instrumentation. This module is intentionally not exported by src/index.ts. */
export interface ValidationTestStatistics {
  readonly counts: Readonly<Record<string, number>>;
}

let active: Record<string, number> | null = null;

export function beginValidationTestStatistics(): () => ValidationTestStatistics {
  if (active !== null) {
    throw new Error("A validation test statistics session is already active.");
  }
  active = Object.create(null) as Record<string, number>;
  return () => {
    if (active === null) {
      throw new Error("The validation test statistics session has already ended.");
    }
    const counts = Object.freeze({ ...(active ?? {}) });
    active = null;
    return Object.freeze({ counts });
  };
}

/** Runs a synchronous test operation with isolated, automatically cleaned-up statistics. */
export function withValidationTestStatistics<T>(
  callback: (statistics: () => ValidationTestStatistics) => T,
): T {
  const finish = beginValidationTestStatistics();
  try {
    return callback(finish);
  } finally {
    if (active !== null) finish();
  }
}

export function recordValidationTestWork(name: string, amount = 1): void {
  if (active !== null) active[name] = (active[name] ?? 0) + amount;
}

export function recordValidationTestMaximum(name: string, value: number): void {
  if (active !== null) active[name] = Math.max(active[name] ?? 0, value);
}
