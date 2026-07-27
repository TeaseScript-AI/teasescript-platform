/** Test-only validation instrumentation. This module is intentionally not exported by src/index.ts. */
export interface ValidationTestStatistics {
  readonly counts: Readonly<Record<string, number>>;
}

let active: Record<string, number> | null = null;
let detailedValidationWorkLimit: number | null = null;
let interactionControlFlowWorkLimit: number | null = null;

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

/** Test-only override; it never reaches a supported runtime API or serialized data. */
export function withDetailedValidationWorkLimitForTesting<T>(
  limit: number,
  callback: () => T,
): T {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("The detailed validation test work limit must be a non-negative safe integer.");
  }
  if (detailedValidationWorkLimit !== null) {
    throw new Error("A detailed validation test work limit is already active.");
  }
  detailedValidationWorkLimit = limit;
  try {
    return callback();
  } finally {
    detailedValidationWorkLimit = null;
  }
}

export function detailedValidationWorkLimitForTesting(): number | null {
  return detailedValidationWorkLimit;
}

/** Test-only override for instruction-plan interaction CFG validation. */
export function withInteractionControlFlowWorkLimitForTesting<T>(
  limit: number,
  callback: () => T,
): T {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("The interaction control-flow test work limit must be a non-negative safe integer.");
  }
  if (interactionControlFlowWorkLimit !== null) {
    throw new Error("An interaction control-flow test work limit is already active.");
  }
  interactionControlFlowWorkLimit = limit;
  try {
    return callback();
  } finally {
    interactionControlFlowWorkLimit = null;
  }
}

export function interactionControlFlowWorkLimitForTesting(): number | null {
  return interactionControlFlowWorkLimit;
}

export function recordValidationTestWork(name: string, amount = 1): void {
  if (active !== null) active[name] = (active[name] ?? 0) + amount;
}
