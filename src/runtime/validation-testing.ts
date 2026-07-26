/** Test-only validation instrumentation. This module is intentionally not exported by src/index.ts. */
export interface ValidationTestStatistics {
  readonly counts: Readonly<Record<string, number>>;
}

let active: Record<string, number> | null = null;

export function beginValidationTestStatistics(): () => ValidationTestStatistics {
  active = Object.create(null) as Record<string, number>;
  return () => {
    const counts = Object.freeze({ ...(active ?? {}) });
    active = null;
    return Object.freeze({ counts });
  };
}

export function recordValidationTestWork(name: string, amount = 1): void {
  if (active !== null) active[name] = (active[name] ?? 0) + amount;
}
