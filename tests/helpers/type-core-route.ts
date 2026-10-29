import type {
  ExpressionPlan,
  Instruction,
  InstructionPlan,
  TypePlan,
} from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { RuntimeScriptStorageEntrySnapshot } from "../../src/runtime/host-data/script-storage.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";
import {
  defaultSites,
  derivedText,
  repairsRecord,
  type DerivedContent,
  type DerivedStore,
  type PredictedRun,
} from "./type-core-derived.js";

// The candidate route's plan and runs as the derived oracle compares them (S6-CARRIERS §5.2, TABLE r4.59).

/**
 * A run of `plan` to its end with the host globals' values, and the script's stored values where given: its status, its
 * failure and what it said, with offsets.
 */
export function runGlobals(
  plan: InstructionPlan,
  globals: Readonly<Record<string, SerializableRuntimeValue>>,
  scriptStorage?: readonly RuntimeScriptStorageEntrySnapshot[],
): PredictedRun {
  const result = run(
    plan,
    createImmediatePacingRuntimeSnapshot(plan, {
      globals,
      ...(scriptStorage === undefined ? {} : { scriptStorage }),
    }),
  );
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    status: result.snapshot.status === "halted" ? "halted" : "failed",
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
    said: result.events.flatMap((event) =>
      event.kind === "say" ? [{ text: event.text, at: event.span.start.offset }] : [],
    ),
  };
}

/** A checked type in full, its unions' members sorted: the plan's side of `derivedText`. */
function planText(type: TypePlan | null): string {
  if (type === null) return "any";
  if (type.kind === "union") return type.members.map(planText).sort().join("|");
  if (type.kind === "list" || type.kind === "set" || type.kind === "dict")
    return `${type.kind}<${planText(type.element)}>`;
  if (type.kind === "object")
    return `{${[...type.properties.map(({ name, type: of }) => `${name}: ${planText(of)}`), ...(type.keepExtra === true ? ["..."] : [])].join(", ")}}`;
  return type.kind;
}

function targetName(target: ExpressionPlan, plan: InstructionPlan): string {
  if (target.kind === "identifier") return target.name;
  if (target.kind === "property") return `${targetName(target.object, plan)}.${target.name}`;
  if (target.kind === "preparedReference") {
    const prepared = plan.instructions.find(
      (instruction) =>
        instruction.kind === "prepareReference" &&
        instruction.destinationTemporary === target.temporaryId,
    );
    if (prepared?.kind === "prepareReference") return targetName(prepared.expression, plan);
  }
  throw new Error(`An unmapped plan store target: ${target.kind}`);
}

/** A plan's checked stores as `derive` gives them: target, statement span, value span, whole type. */
export function plannedStores(plan: InstructionPlan): string[] {
  return plan.instructions.flatMap((instruction) =>
    (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
    instruction.typeCheck !== undefined
      ? [
          `${instruction.kind === "declareBinding" ? instruction.name : targetName(instruction.target, plan)} ` +
            `${instruction.span.so}:${instruction.span.eo} ${instruction.value.span.so}:${instruction.value.span.eo} ` +
            planText(instruction.typeCheck.type),
        ]
      : [],
  );
}

/** All S7 content, including lazy expression plans and instruction-lowered defaults. No expected content is read. */
export function plannedContent(plan: InstructionPlan, source: string): string[] {
  const out: string[] = [];
  const defaults = defaultSites(source);
  const at = (node: { readonly span: { readonly so: number; readonly eo: number } }): string =>
    `${node.span.so}:${node.span.eo}`;
  const visit = (node: Instruction | ExpressionPlan): void => {
    if (node.kind === "assign" && node.requireExisting === true)
      out.push(`requireExisting ${at(node)} ${targetName(node.target, plan)}`);
    if (node.kind === "call" && node.indexCheck === true) out.push(`indexCheck ${at(node)}`);
    if (
      (node.kind === "binary" || node.kind === "call" || node.kind === "storeTemporary") &&
      node.fallbackCheck !== undefined
    ) {
      const owner =
        node.kind === "storeTemporary"
          ? defaults.find((entry) => entry.site === at(node.value) || entry.written === at(node))
              ?.owner
          : at(node);
      if (owner === undefined)
        throw new Error(`A fallback check with no source owner at ${at(node)}`);
      out.push(`fallbackCheck ${owner} ${planText(node.fallbackCheck.type)}`);
    }
    if ((node.kind === "call" || node.kind === "fileStore") && node.expected !== undefined)
      out.push(`expected ${at(node)} ${planText(node.expected)}`);
    if (node.kind === "storageLoad")
      out.push(`load ${at(node)} ${planText(node.type)} repair=${node.repair === true}`);
    if (node.kind === "storeTemporary" && node.repair !== undefined) {
      const owner = defaults.find(
        (entry) => entry.site === at(node.value) || entry.written === at(node),
      )?.owner;
      if (owner === undefined)
        throw new Error(`A repairing store with no source owner at ${at(node)}`);
      out.push(`repair ${owner} ${planText(node.repair)}`);
    }
  };
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (
      "span" in value &&
      "kind" in value &&
      ["assign", "call", "binary", "storeTemporary", "storageLoad", "fileStore"].includes(
        String(value.kind),
      )
    ) {
      // EVIDENCE: invariant: these tags identify instructions or expressions in the trusted plan.
      visit(value as Instruction | ExpressionPlan);
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(plan.instructions);
  return out.sort();
}

export function derivedContent(content: DerivedContent, source: string): string[] {
  const defaults = defaultSites(source);
  return [
    ...content.requireExisting.map((entry) => `requireExisting ${entry.site} ${entry.target}`),
    ...content.indexes.map((owner) => `indexCheck ${owner}`),
    ...content.fallbacks.map((entry) => `fallbackCheck ${entry.owner} ${derivedText(entry.type)}`),
    ...content.expected.map((entry) => `expected ${entry.owner} ${derivedText(entry.type)}`),
    ...content.loads.map(
      (entry) =>
        `load ${entry.owner} ${entry.type === null ? "any" : derivedText(entry.type)} repair=${entry.repair}`,
    ),
    ...[
      ...content.expected,
      ...content.loads
        .filter((entry) => entry.type !== null)
        .map((entry) => ({ owner: entry.owner, type: entry.type! })),
    ]
      .filter(
        (entry) =>
          repairsRecord(entry.type) &&
          defaults.some((fallback) => fallback.owner === entry.owner && fallback.lowered),
      )
      .map((entry) => `repair ${entry.owner} ${derivedText(entry.type)}`),
  ].sort();
}

export function derivedStores(stores: readonly DerivedStore[]): string[] {
  return stores.map(
    (store) =>
      `${store.target} ${store.so}:${store.eo} ${store.valueSo}:${store.valueEo} ${derivedText(store.type)}`,
  );
}

/** The host values a run's inputs take (§5.2's derived domain): a whole number, text, a truth value, a fraction, null. */
const DOMAIN: readonly SerializableRuntimeValue[] = [2, "text", true, 2.5, null];

/** Every assignment of the domain's values to the globals. */
export function assignments(
  globals: readonly string[],
): Readonly<Record<string, SerializableRuntimeValue>>[] {
  return globals.reduce<Record<string, SerializableRuntimeValue>[]>(
    (partial, name) =>
      partial.flatMap((assigned) => DOMAIN.map((value) => ({ ...assigned, [name]: value }))),
    [{}],
  );
}
