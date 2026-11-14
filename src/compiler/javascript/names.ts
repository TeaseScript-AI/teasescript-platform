import { PlanControlFlow } from "../../plan/control-flow.js";
import { instructionExpressions } from "../../plan/instruction-expressions.js";
import { expressionPlanChildren } from "../../plan/expression-children.js";
import type { ExpressionPlan, Instruction, InstructionPlan } from "../../plan/model.js";

/**
 * A variable of the program as generated code holds it: one per declaration in the source, whatever number of times
 * the session creates it (each call, loop round and file activation has its own).
 * - `root`: a top-level variable of a file, which the file's functions and blocks see (V30 §14, ADR 0022 §5);
 * - `local`: a `let` in a function, a block, or a nested scope of a file's top level;
 * - `parameter`: a parameter of an author function;
 * - `loop`: a `for` loop's variable, or the value variable of `for key, value`;
 * - `self`: a media block's own handle (`let NAME = play… async { … }`).
 */
export interface Variable {
  /** Unique in the program; ids follow the walk: file roots, then author functions, then blocks. */
  readonly id: number;
  readonly name: string;
  readonly kind: "root" | "local" | "parameter" | "loop" | "self";
  /** The JavaScript identifier generated code gives it. */
  readonly js: string;
}

/** What a name refers to where it is read: a variable, or a global (a `global`, a speaker, or a host value) by name. */
export type NameTarget =
  | { readonly kind: "variable"; readonly variable: Variable }
  | { readonly kind: "global"; readonly name: string };

export interface PlanNames {
  readonly variables: readonly Variable[];
  /**
   * The names instruction `index` may read, each with what it refers to: the identifiers of its expressions (not a
   * call's callee, which names a builtin), an assignment's target name, a speaker it names, and for an instruction
   * that creates a block, the variables the block shares (its `captures`). Read before the instruction declares
   * anything.
   */
  readsAt(index: number): ReadonlyMap<string, NameTarget>;
  /** The variables instruction `index` binds when it runs: a `let`, a loop round's variables, a parameter. */
  declaredAt(index: number): readonly Variable[];
  /** The variables block `id` shares with the code that creates it, by name. */
  sharedBy(block: number): ReadonlyMap<string, Variable>;
  /** A media block's own handle, which the session binds as the block starts. */
  selfHandle(block: number): Variable | null;
}

const NO_READS: ReadonlyMap<string, NameTarget> = new Map();
const NO_VARIABLES: readonly Variable[] = [];

/**
 * Which variable each name of a plan refers to, as the engine finds it (`findBindingLocation`): the scopes of the
 * running function, block or file top level, innermost first; then for a block, the variables it shares; then, outside
 * a global function, the top level of the activation's file; then the globals.
 *
 * The scopes are read from the instruction stream in order: a region starts one, `enterScope` and `leaveScope` open and
 * close one, and a loop's round has one from its `loopStart` to its `target`. A nested scope cannot redeclare a name
 * it sees (V30 §14), so a name refers to the one variable of that name in scope. A top-level `let` that runs again
 * after a `goto` is the same instruction, so it sets the same variable. Each region is walked once, without recursion
 * on nesting.
 */
export function planNames(plan: InstructionPlan, flow = new PlanControlFlow(plan)): PlanNames {
  const variables: Variable[] = [];
  const reads = new Map<number, Map<string, NameTarget>>();
  const declarations = new Map<number, Variable[]>();
  const shared = new Map<number, Map<string, Variable>>();
  const selfHandles = new Map<number, Variable>();
  const rootsOfFiles = plan.files.map(() => new Map<string, Variable>());
  /** Blocks in the order their creating instructions were walked. */
  const blockQueue: number[] = [];

  const variable = (name: string, kind: Variable["kind"]): Variable => {
    const created: Variable = { id: variables.length, name, kind, js: `v${variables.length}` };
    variables.push(created);
    return created;
  };
  const declare = (index: number, declared: Variable): void => {
    const list = declarations.get(index);
    if (list === undefined) declarations.set(index, [declared]);
    else list.push(declared);
  };

  /** The region from `start` to `end`: a file's root region (`definition` null), or a function's. */
  const walk = (
    start: number,
    end: number,
    file: number,
    definition: InstructionPlan["functions"][number] | null,
  ): void => {
    const root = definition === null ? rootsOfFiles[file]! : null;
    const visible = new Map<string, Variable>();
    // Each scope's names, and the instruction at which a loop round's scope closes.
    const scopes: { readonly names: string[]; readonly closesAt: number | null }[] = [
      { names: [], closesAt: null },
    ];
    const bind = (name: string, kind: Variable["kind"]): Variable => {
      const atRoot = root !== null && scopes.length === 1;
      const created = variable(name, atRoot ? "root" : kind);
      if (atRoot) root.set(name, created);
      scopes.at(-1)!.names.push(name);
      visible.set(name, created);
      return created;
    };
    const parameters = (definition?.parameters ?? []).map((parameter) =>
      bind(parameter.name, "parameter"),
    );
    if (definition?.selfHandle != null)
      selfHandles.set(definition.id, bind(definition.selfHandle, "self"));
    const blockShares = definition === null ? undefined : shared.get(definition.id);
    const fileRoot = definition === null || definition.global ? null : rootsOfFiles[file]!;
    const resolve = (name: string): NameTarget => {
      const found = visible.get(name) ?? blockShares?.get(name) ?? fileRoot?.get(name);
      return found === undefined ? { kind: "global", name } : { kind: "variable", variable: found };
    };
    const close = (): void => {
      for (const name of scopes.pop()!.names) visible.delete(name);
    };

    for (let index = start; index < end; index += 1) {
      while (scopes.at(-1)!.closesAt === index) close();
      const instruction = plan.instructions[index]!;
      const names = namesRead(instruction);
      if (names.length > 0) {
        const read = new Map<string, NameTarget>();
        for (const name of names) read.set(name, resolve(name));
        reads.set(index, read);
      }
      for (const block of flow.handlersOf(index)) {
        const blockShared = new Map<string, Variable>();
        for (const name of capturesOf(instruction)) {
          // The engine looks a shared variable up below the file's top level only (`resolveCaptures`).
          const found = visible.get(name) ?? blockShares?.get(name);
          if (found === undefined || found.kind === "root")
            throw new Error(
              `Instruction ${index} shares '${name}', which no scope there declares.`,
            );
          blockShared.set(name, found);
        }
        shared.set(block, blockShared);
        blockQueue.push(block);
      }
      switch (instruction.kind) {
        case "enterScope":
          scopes.push({ names: [], closesAt: null });
          break;
        case "leaveScope":
          if (scopes.length === 1 || scopes.at(-1)!.closesAt !== null)
            throw new Error(`Instruction ${index} leaves a scope it did not enter.`);
          close();
          break;
        case "declareBinding":
          declare(index, bind(instruction.name, "local"));
          break;
        case "loopStart":
          scopes.push({ names: [], closesAt: instruction.target });
          if (instruction.loopKind === "for") {
            declare(index, bind(instruction.variable, "loop"));
            if (instruction.valueVariable !== undefined)
              declare(index, bind(instruction.valueVariable, "loop"));
          }
          break;
        case "bindSuppliedParameter":
        case "bindDefaultParameter":
          declare(index, parameters[instruction.parameterIndex]!);
          break;
        default:
          break;
      }
    }
  };

  // A block is walked after the region that creates it, so that the variables it shares are known.
  plan.files.forEach((file, index) =>
    walk(file.startInstruction, file.rootEndInstruction, index, null),
  );
  for (const definition of plan.functions)
    if (definition.handler === null) walkFunction(definition);
  const walked = new Set<number>();
  for (let next = 0; next < blockQueue.length; next += 1) {
    walked.add(blockQueue[next]!);
    walkFunction(plan.functions[blockQueue[next]! - 1]!);
  }
  // A block no instruction creates never runs; it is walked without shared variables.
  for (const definition of plan.functions)
    if (definition.handler !== null && !walked.has(definition.id)) walkFunction(definition);

  function walkFunction(definition: InstructionPlan["functions"][number]): void {
    walk(
      definition.entryInstruction,
      definition.endInstruction,
      flow.fileOf(definition.entryInstruction),
      definition,
    );
  }

  return {
    variables,
    readsAt: (index) => reads.get(index) ?? NO_READS,
    declaredAt: (index) => declarations.get(index) ?? NO_VARIABLES,
    sharedBy: (block) => shared.get(block) ?? new Map(),
    selfHandle: (block) => selfHandles.get(block) ?? null,
  };
}

/** The variables the blocks an instruction creates share with the code that creates it. */
function capturesOf(instruction: Instruction): readonly string[] {
  return instruction.kind === "startTimer" ||
    instruction.kind === "showPermanentButton" ||
    instruction.kind === "playMedia"
    ? instruction.captures
    : [];
}

/** The names an instruction reads, in no particular order, each once. */
function namesRead(instruction: Instruction): readonly string[] {
  const names = new Set<string>(namesOutsideExpressions(instruction));
  for (const name of capturesOf(instruction)) names.add(name);
  const pending: ExpressionPlan[] = [...instructionExpressions(instruction)];
  while (pending.length > 0) {
    const expression = pending.pop()!;
    if (expression.kind === "identifier") names.add(expression.name);
    else if (expression.kind === "call") {
      // A callee name is a builtin's, which the engine does not look up among variables.
      if (expression.callee.kind !== "identifier") pending.push(expression.callee);
      for (const argument of expression.arguments) pending.push(argument.value);
    } else for (const child of expressionPlanChildren(expression)) pending.push(child);
  }
  return [...names];
}

/** The names an instruction reads outside its expressions: an assignment's target, a speaker it names. */
function namesOutsideExpressions(instruction: Instruction): readonly string[] {
  switch (instruction.kind) {
    case "assign":
    case "validateAssignmentTarget":
      return instruction.target.kind === "identifier" ? [instruction.target.name] : [];
    case "setDefaultSpeaker":
      return [instruction.name];
    case "say":
    case "prepareSaySpeaker":
    case "prepareInteractionSpeaker":
      return instruction.speaker === null ? [] : [instruction.speaker];
    case "interaction":
      return "speaker" in instruction && instruction.speaker !== null ? [instruction.speaker] : [];
    case "declareGlobal":
    case "declareSpeaker":
    case "copyPlayerProfile":
    case "enterScope":
    case "leaveScope":
    case "declareBinding":
    case "prepareReference":
    case "validateCallReceiver":
    case "evaluate":
    case "jumpIfFalse":
    case "jump":
    case "loopStart":
    case "loopControl":
    case "storeTemporary":
    case "prepareSayContextualSpeaker":
    case "prepareSayText":
    case "clearTemporary":
    case "clearTemporaries":
    case "callFunction":
    case "bindSuppliedParameter":
    case "beginFunctionDefaults":
    case "prepareParameterDefault":
    case "bindDefaultParameter":
    case "enterFunctionBody":
    case "returnValue":
    case "returnVoid":
    case "wait":
    case "startTimer":
    case "showImage":
    case "showCamera":
    case "hideCamera":
    case "showPermanentButton":
    case "storageWrite":
    case "playMedia":
    case "stopAudio":
    case "capture":
    case "fileStore":
    case "lock":
    case "goto":
    case "transfer":
    case "end":
    case "exit":
      return [];
  }
  instruction satisfies never;
  return [];
}
