import { createHash } from "node:crypto";
import type { InstructionPlan } from "../../../src/plan/model.js";

// The digests `tests/type-core/type-core-declared-escapes.test.ts` compares the head with main's recorded values by
// (#2116's declared difference under #2080): pure, so the same functions read main's tree when the values are recorded.

/**
 * A plan's digest with each object type's properties in name order: a `typeCheck` type lists them in the order a pass
 * met them, and the runtime reads them by name (`matchStep` in `src/runtime/values/value-types.ts`), so two plans
 * apart only in that order check alike.
 */
export function planDigest(plan: InstructionPlan | null): string {
  return digest(
    JSON.stringify(plan, (key, value) =>
      key === "properties" && Array.isArray(value)
        ? [...value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        : value,
    ),
  );
}

/** One run of a plan: what it said and where it failed, as the runtime reported it. */
export interface RunResult {
  readonly said: readonly string[];
  readonly code: string | null;
  readonly span: readonly [number, number] | null;
  readonly message: string | null;
}

/**
 * The runs' digest with the property a TSR058 message names masked: where several properties of a stored object do not
 * fit, the message names the first in the plan's order (`matchStep`), which is the only part of a run that order moves.
 */
export function runsDigest(runs: readonly RunResult[]): string {
  return digest(
    JSON.stringify(
      runs.map((r) => ({
        ...r,
        message: r.message?.replace(/ at \.[^\s.,]+(?:\.[^\s.,]+)*/g, " at .*") ?? null,
      })),
    ),
  );
}

/** A text's digest, as the plan's and the runs' are made: sha256, its first 16 hex digits. */
export const textDigest = (text: string): string => digest(text);

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
