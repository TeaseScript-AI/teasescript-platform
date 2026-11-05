import { isOneOf, isRecord } from "../validation-support.js";
import { explicitInstructionTargets, producedTemporaryIds } from "./instruction-facts.js";

/**
 * Facts that several stream checks read from every instruction, gathered in one pass per validation and then shared,
 * each with the predicate its checks used when they gathered it themselves. It reports nothing: every diagnostic stays
 * in its own check, in its own order. Like the region index, it belongs to one validation only.
 */
export interface InstructionSummary {
  /** The instructions that produce each temporary, ascending, one entry per production. */
  readonly producers: ReadonlyMap<number, readonly number[]>;
  /** Every safe-integer instruction target, in range or not. */
  readonly explicitTargets: ReadonlySet<number>;
  /** The instructions that are a `goto` or a transfer. */
  readonly gotoSources: ReadonlySet<number>;
  /** Whether a say names a prepared speaker, contextual speaker, or text. */
  readonly hasPreparedSay: boolean;
  /** The instructions the function checks can act on, ascending: every other instruction is a no-op for them. */
  readonly functionSites: readonly number[];
  /** The in-range target of each target-to-source pair, in source order; with `incomingPairSources`. */
  readonly incomingPairTargets: readonly number[];
  readonly incomingPairSources: readonly number[];
}

/** The kinds that may only stand in a function region. */
export const FUNCTION_ONLY_KINDS = [
  "bindSuppliedParameter",
  "beginFunctionDefaults",
  "prepareParameterDefault",
  "bindDefaultParameter",
  "enterFunctionBody",
  "returnValue",
  "returnVoid",
] as const;

export function summarizeInstructions(instructions: readonly unknown[]): InstructionSummary {
  const producers = new Map<number, number[]>();
  const explicitTargets = new Set<number>();
  const gotoSources = new Set<number>();
  const functionSites: number[] = [];
  const incomingPairTargets: number[] = [];
  const incomingPairSources: number[] = [];
  let hasPreparedSay = false;
  instructions.forEach((instruction, instructionIndex) => {
    if (!isRecord(instruction)) return;
    if (
      instruction.kind === "say" &&
      (Number.isSafeInteger(instruction.speakerTemporary) ||
        Number.isSafeInteger(instruction.contextualSpeakerTemporary) ||
        Number.isSafeInteger(instruction.textTemporary))
    ) {
      hasPreparedSay = true;
    }
    for (const temporaryId of producedTemporaryIds(instruction)) {
      const entries = producers.get(temporaryId) ?? [];
      entries.push(instructionIndex);
      producers.set(temporaryId, entries);
    }
    for (const target of explicitInstructionTargets(instruction)) {
      if (!Number.isSafeInteger(target)) continue;
      // EVIDENCE: validation: Number.isSafeInteger proved the numeric target above.
      const targetIndex = target as number;
      explicitTargets.add(targetIndex);
      if (targetIndex >= 0 && targetIndex < instructions.length) {
        incomingPairTargets.push(targetIndex);
        incomingPairSources.push(instructionIndex);
      }
    }
    if (instruction.kind === "goto" || instruction.kind === "transfer")
      gotoSources.add(instructionIndex);
    // Each guard of the function checks' per-instruction loop is one of these.
    if (
      isOneOf(instruction.kind, FUNCTION_ONLY_KINDS) ||
      instruction.kind === "callFunction" ||
      instruction.kind === "startTimer" ||
      instruction.kind === "showPermanentButton" ||
      instruction.kind === "playMedia" ||
      "functionId" in instruction
    )
      functionSites.push(instructionIndex);
  });
  return {
    producers,
    explicitTargets,
    gotoSources,
    hasPreparedSay,
    functionSites,
    incomingPairTargets,
    incomingPairSources,
  };
}

/** The sources of each in-range target, ascending and with repeats, as offsets into one array of sources. */
export interface IncomingSources {
  /** The sources of target `t` are `sources[offsets[t]]` up to, not including, `sources[offsets[t + 1]]`. */
  readonly offsets: Int32Array;
  readonly sources: Int32Array;
}

/** Sorts the summary's pairs by target, keeping source order within each target. */
export function incomingSources(summary: InstructionSummary, count: number): IncomingSources {
  const targets = summary.incomingPairTargets;
  const offsets = new Int32Array(count + 1);
  for (const target of targets) offsets[target + 1] = offsets[target + 1]! + 1;
  for (let target = 0; target < count; target += 1)
    offsets[target + 1] = offsets[target + 1]! + offsets[target]!;
  const next = offsets.slice(0, count);
  const sources = new Int32Array(targets.length);
  for (let pair = 0; pair < targets.length; pair += 1) {
    const target = targets[pair]!;
    sources[next[target]!] = summary.incomingPairSources[pair]!;
    next[target] = next[target]! + 1;
  }
  return { offsets, sources };
}
