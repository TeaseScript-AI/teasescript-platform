import type { InstructionPlan } from "../../src/plan/model.js";
import { PlanControlFlow } from "../../src/plan/control-flow.js";
import type { FlowGraph, FunctionRegion } from "../../src/type-inference/core/flow-graph/model.js";
import type { SourceSite } from "../../src/type-inference/graph.js";

/*
 * A site's identity for the test oracles, the compiler's own: its file and its offsets, never its offsets alone, as
 * every file counts its offsets from 0 (Astra's B1 on #1690, Codex r5's item 2 on #1687; #1700). An oracle that keys a
 * map by a site keys it by these; `tools/oxlint/type-core/check-site-keys.mjs` refuses a map key with an offset and no file.
 */

/** A source site's key, `file:start:end`, as the compiler writes it. */
export { siteKey } from "../../src/type-inference/core/program.js";

/** Each plan's control flow, which knows each instruction's file (`PlanControlFlow.fileOf`), made once a plan. */
const flows = new WeakMap<InstructionPlan, PlanControlFlow>();

/**
 * The index of the file a plan's instruction comes from (`PlanControlFlow.fileOf`: a file's instruction range, a start
 * value its own file), as a source site's `file` counts it; throws for an instruction outside every file's range.
 */
export function planFileOf(plan: InstructionPlan, index: number): number {
  const inside =
    Number.isInteger(index) &&
    plan.files.some((file) => index >= file.startInstruction && index < file.endInstruction);
  if (!inside) throw new Error(`Instruction ${index} lies outside every file of the plan.`);
  let flow = flows.get(plan);
  if (flow === undefined) flows.set(plan, (flow = new PlanControlFlow(plan)));
  return flow.fileOf(index);
}

/** A plan instruction's site key, `file:so:eo` (`planFileOf` and its span), as `siteKey` spells a source site's. */
export function planSiteKey(plan: InstructionPlan, index: number): string {
  const file = planFileOf(plan, index);
  const { so, eo } = plan.instructions[index]!.span;
  return `${file}:${so}:${eo}`;
}

/** The innermost function whose declaration holds `site` in the site's own file, or `null`. */
export function enclosingFunction(graph: FlowGraph, site: SourceSite): FunctionRegion | null {
  let found: FunctionRegion | null = null;
  for (const region of graph.regions) {
    if (region.kind !== "function" || region.file !== site.file) continue;
    const { start, end } = region.declaration.span;
    if (start.offset > site.start || site.end > end.offset) continue;
    const width = (each: FunctionRegion): number =>
      each.declaration.span.end.offset - each.declaration.span.start.offset;
    if (found === null || width(region) < width(found)) found = region;
  }
  return found;
}
