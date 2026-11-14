import type { PlanSourceLocation, StorageTypePlan } from "../../plan/model.js";

export const GENERATED_TABLE_FORMAT = "teasescript-generated-table";
export const GENERATED_TABLE_VERSION = 1;
/** The generator's own version: it changes whenever its output for some plan changes. */
export const GENERATOR_VERSION = 1;

/** What the stage gives for one plan. Deterministic: equal plans give byte-equal output. */
export interface GeneratedProgram {
  /** One ES module, whose default export is `program(rt)`, `rt` being one session's runtime library. */
  readonly module: string;
  readonly table: GeneratedTable;
}

/** An index into `GeneratedTable.places`. */
export type PlaceId = number;

/** A source place the module names: `instruction` is the plan's index, `file` the index of the file it stands in. */
export interface GeneratedPlace {
  readonly instruction: number;
  readonly file: number;
  readonly span: PlanSourceLocation;
}

/** JSON-safe; a reader validates it as outside data, since it travels beside the module. */
export interface GeneratedTable {
  readonly format: typeof GENERATED_TABLE_FORMAT;
  readonly version: typeof GENERATED_TABLE_VERSION;
  readonly generator: number;
  /** The plan it was generated from, as Debug's source sidecar binds to it (`validatedPlanSha256`). */
  readonly planSha256: string;
  readonly places: readonly GeneratedPlace[];
  /** In plan order. `start`: the session's first instruction of the file; `entry`: where a goto or call enters it. */
  readonly files: readonly {
    readonly path: string;
    readonly start: PlaceId;
    readonly entry: PlaceId;
    readonly labels: readonly { readonly name: string; readonly place: PlaceId }[];
  }[];
  /** Author functions, by plan function ID. */
  readonly functions: readonly {
    readonly id: number;
    readonly name: string;
    readonly file: number;
    readonly entry: PlaceId;
    readonly global: boolean;
    readonly mayWait: boolean;
  }[];
  /** Timer, media and button blocks, by plan function ID; `createdBy` are the instructions that register them. */
  readonly blocks: readonly {
    readonly id: number;
    readonly handler: "timer" | "media" | "button";
    readonly file: number;
    readonly entry: PlaceId;
    readonly createdBy: readonly PlaceId[];
    readonly mayWait: boolean;
  }[];
  readonly speakers: readonly {
    readonly name: string;
    readonly file: number;
    readonly place: PlaceId;
  }[];
  readonly globals: readonly {
    readonly name: string;
    readonly file: number;
    readonly place: PlaceId;
  }[];
  /** The plan's, which a load of saved values is checked against. */
  readonly storageTypes: readonly StorageTypePlan[];
}
