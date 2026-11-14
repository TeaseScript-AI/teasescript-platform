import { PlanControlFlow } from "../../plan/control-flow.js";
import type { InstructionPlan } from "../../plan/model.js";
// The one import of the stage from `src/runtime/`: the plan's digest as Debug's source sidecar binds to it. Nothing
// else of the runtime is imported here.
import { validatedPlanSha256 } from "../../runtime/debug/source-sidecar.js";
import { writeJson } from "./json.js";
import type { GeneratedProgram, GeneratedTable } from "./model.js";
import { planNames, type PlanNames } from "./names.js";
import { ProgramTable } from "./places.js";
import { GenerationRefused } from "./refusal.js";

/** What generating one plan's code reads and adds to. */
interface Generation {
  readonly plan: InstructionPlan;
  readonly names: PlanNames;
  readonly table: ProgramTable;
  /** The constant pool, `K` in the module. */
  readonly constants: unknown[];
}

/**
 * The JavaScript program of a validated plan: an ES module and its table, from the plan alone, so equal plans give
 * byte-equal output. A plan form outside the set the stage admits throws `GenerationRefused`; any other exception is
 * a defect.
 */
export function generateJavaScript(plan: InstructionPlan): GeneratedProgram {
  const flow = new PlanControlFlow(plan);
  const generation: Generation = {
    plan,
    names: planNames(plan, flow),
    table: new ProgramTable(plan, validatedPlanSha256(plan), flow),
    constants: [],
  };
  const body = plan.files
    .map((file) => regionCode(generation, file.startInstruction, file.rootEndInstruction))
    .join("\n");
  const table = generation.table.table();
  return { module: programModule(table, generation.constants, body), table };
}

function regionCode(generation: Generation, start: number, end: number): string {
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) lines.push(instructionCode(generation, index));
  return lines.join("\n");
}

/** The closed set of instructions the stage admits, which is empty: each is refused by its kind's name. */
function instructionCode(generation: Generation, index: number): string {
  throw new GenerationRefused(`instruction:${generation.plan.instructions[index]!.kind}`, index);
}

/**
 * The module around a program's code. `body` declares `file<i>` for each of the table's files, `f<id>` for each author
 * function and `b<id>` for each block; `program(rt)` returns them. The constant pool is JSON text, which engines parse
 * faster than an object literal; generated code never changes it. Nothing outside `program(rt)` holds state, so two
 * sessions share no variable.
 */
export function programModule(
  table: GeneratedTable,
  constants: readonly unknown[],
  body: string,
): string {
  const files = table.files.map((_, index) => `file${index}`).join(", ");
  const functions = table.functions.map(({ id }) => `${id}: f${id}`).join(", ");
  const blocks = table.blocks.map(({ id }) => `${id}: b${id}`).join(", ");
  return [
    `// TeaseScript program. Generator ${table.generator}. Plan sha256 ${table.planSha256}.`,
    `const K = JSON.parse(${JSON.stringify(writeJson(constants))});`,
    "export default function program(rt) {",
    body,
    `  return { files: [${files}], functions: { ${functions} }, blocks: { ${blocks} } };`,
    "}",
    "",
  ].join("\n");
}
