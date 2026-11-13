import { createHash } from "node:crypto";
import type { InstructionPlan } from "../../../../src/plan/model.js";

// The digests `tests/type-core/stop/type-core-declared-escapes.test.ts` compares the head with main's recorded values by
// (#2116's declared difference under #2080): pure, so the same functions read main's tree when the values are recorded.

/** A plan's digest: its serialized JSON, as it is. */
export function planDigest(plan: InstructionPlan | null): string {
  return digest(JSON.stringify(plan));
}

/** One run of a plan: what it said and where it failed, as the runtime reported it. */
export interface RunResult {
  readonly said: readonly string[];
  readonly code: string | null;
  readonly span: readonly [number, number] | null;
  readonly message: string | null;
}

/** The runs' digest: each run as it is, its runtime failure's message whole. */
export function runsDigest(runs: readonly RunResult[]): string {
  return digest(JSON.stringify(runs));
}

/** A text's digest, as the plan's and the runs' are made: sha256, its first 16 hex digits. */
export const textDigest = (text: string): string => digest(text);

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
