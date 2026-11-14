import { PlanControlFlow } from "../../plan/control-flow.js";
import type { InstructionPlan, PlanSourceLocation } from "../../plan/model.js";
import { planWaits } from "../../plan/waits.js";
import {
  GENERATED_TABLE_FORMAT,
  GENERATED_TABLE_VERSION,
  GENERATOR_VERSION,
  type GeneratedPlace,
  type GeneratedTable,
  type PlaceId,
} from "./model.js";

/**
 * The table of one generated program. The places of its files, functions, blocks, speakers and globals are registered
 * first, in that order and in plan order within each, so their IDs do not depend on the code generated; places the
 * code names follow as it registers them. Equal plans and equal registrations give equal tables.
 */
export class ProgramTable {
  readonly #plan: InstructionPlan;
  readonly #planSha256: string;
  readonly #flow: PlanControlFlow;
  readonly #places: GeneratedPlace[] = [];
  /** Place IDs by instruction and span offsets: one place per span of an instruction. */
  readonly #placeIds = new Map<string, PlaceId>();
  readonly #files: GeneratedTable["files"];
  readonly #functions: GeneratedTable["functions"];
  readonly #blocks: GeneratedTable["blocks"];
  readonly #speakers: GeneratedTable["speakers"];
  readonly #globals: GeneratedTable["globals"];

  /** `plan` is a validated plan; `planSha256` is its digest as `validatedPlanSha256` gives it. */
  public constructor(plan: InstructionPlan, planSha256: string, flow = new PlanControlFlow(plan)) {
    this.#plan = plan;
    this.#planSha256 = planSha256;
    this.#flow = flow;
    const waits = planWaits(plan, this.#flow);
    this.#files = plan.files.map((file) => ({
      path: file.path,
      start: this.place(file.startInstruction),
      entry: this.place(file.entryInstruction),
      labels: file.labels.map((label) => ({
        name: label.name,
        place: this.place(label.instruction),
      })),
    }));
    this.#functions = plan.functions
      .filter((definition) => definition.handler === null)
      .map((definition) => ({
        id: definition.id,
        name: definition.name,
        file: this.#flow.fileOf(definition.entryInstruction),
        entry: this.place(definition.entryInstruction),
        global: definition.global,
        mayWait: waits.functionMayWait(definition.id),
      }));
    const creators = blockCreators(this.#flow);
    this.#blocks = plan.functions.flatMap((definition) =>
      definition.handler === null
        ? []
        : [
            {
              id: definition.id,
              handler: definition.handler,
              file: this.#flow.fileOf(definition.entryInstruction),
              entry: this.place(definition.entryInstruction),
              createdBy: (creators.get(definition.id) ?? []).map((index) => this.place(index)),
              mayWait: waits.functionMayWait(definition.id),
            },
          ],
    );
    const speakers: { name: string; file: number; place: PlaceId }[] = [];
    const globals: { name: string; file: number; place: PlaceId }[] = [];
    plan.instructions.forEach((instruction, index) => {
      if (instruction.kind === "declareSpeaker")
        speakers.push({ name: instruction.name, file: instruction.file, place: this.place(index) });
    });
    plan.instructions.forEach((instruction, index) => {
      if (instruction.kind === "declareGlobal")
        globals.push({ name: instruction.name, file: instruction.file, place: this.place(index) });
    });
    this.#speakers = speakers;
    this.#globals = globals;
  }

  /** The place of `span` in instruction `index`, by default the instruction's own span; registered once. */
  public place(
    index: number,
    span: PlanSourceLocation = this.#plan.instructions[index]!.span,
  ): PlaceId {
    const key = `${index} ${span.so} ${span.eo}`;
    let id = this.#placeIds.get(key);
    if (id === undefined) {
      id = this.#places.length;
      this.#places.push({ instruction: index, file: this.#flow.fileOf(index), span });
      this.#placeIds.set(key, id);
    }
    return id;
  }

  /** The table with the places registered so far. */
  public table(): GeneratedTable {
    return {
      format: GENERATED_TABLE_FORMAT,
      version: GENERATED_TABLE_VERSION,
      generator: GENERATOR_VERSION,
      planSha256: this.#planSha256,
      places: [...this.#places],
      files: this.#files,
      functions: this.#functions,
      blocks: this.#blocks,
      speakers: this.#speakers,
      globals: this.#globals,
      storageTypes: this.#plan.storageTypes,
    };
  }
}

/** The instructions that register each block, by block ID, in plan order. */
function blockCreators(flow: PlanControlFlow): Map<number, number[]> {
  const creators = new Map<number, number[]>();
  for (let index = 0; index < flow.plan.instructions.length; index += 1) {
    for (const block of flow.handlersOf(index)) {
      const list = creators.get(block);
      if (list === undefined) creators.set(block, [index]);
      else if (list.at(-1) !== index) list.push(index);
    }
  }
  return creators;
}
