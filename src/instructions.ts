import type {
  Block,
  CallArgument,
  Expression,
  FunctionDeclaration,
  Program,
  Statement,
} from "./ast.js";
import { createSourceSpan, type SourceSpan } from "./source.js";

export const INSTRUCTION_PLAN_FORMAT = "teasescript-instruction-plan";
export const INSTRUCTION_PLAN_VERSION = 3;

export interface InstructionPlan {
  readonly format: typeof INSTRUCTION_PLAN_FORMAT;
  readonly version: typeof INSTRUCTION_PLAN_VERSION;
  readonly sourceSpan: SourceSpan;
  readonly rootEndInstruction: number;
  readonly temporaryCount: number;
  readonly functions: readonly CompiledFunctionDefinition[];
  readonly instructions: readonly Instruction[];
}

export interface CompiledFunctionParameter {
  readonly name: string;
  readonly index: number;
  readonly hasDefault: boolean;
  readonly declarationSpan: SourceSpan;
  readonly defaultSpan: SourceSpan | null;
}

export interface CompiledFunctionDefinition {
  readonly id: number;
  readonly name: string;
  readonly declarationSpan: SourceSpan;
  readonly parameters: readonly CompiledFunctionParameter[];
  readonly entryInstruction: number;
  readonly bodyEntryInstruction: number;
  readonly implicitReturnInstruction: number;
  readonly endInstruction: number;
  readonly bodySpan: SourceSpan;
}

export type Instruction =
  | DeclareSpeakerInstruction
  | SetDeclaredSpeakerPropertyInstruction
  | SetDefaultSpeakerInstruction
  | EnterScopeInstruction
  | LeaveScopeInstruction
  | DeclareBindingInstruction
  | PrepareReferenceInstruction
  | ValidateAssignmentTargetInstruction
  | AssignInstruction
  | ValidateCallReceiverInstruction
  | EvaluateInstruction
  | JumpIfFalseInstruction
  | JumpInstruction
  | LoopStartInstruction
  | LoopControlInstruction
  | StoreTemporaryInstruction
  | ClearTemporaryInstruction
  | CallFunctionInstruction
  | BindSuppliedParameterInstruction
  | BeginFunctionDefaultsInstruction
  | PrepareParameterDefaultInstruction
  | BindDefaultParameterInstruction
  | EnterFunctionBodyInstruction
  | ReturnValueInstruction
  | ReturnVoidInstruction
  | SayInstruction
  | ExitInstruction;

interface InstructionBase {
  readonly span: SourceSpan;
}

export interface DeclareSpeakerInstruction extends InstructionBase {
  readonly kind: "declareSpeaker";
  readonly name: string;
  readonly properties: readonly PlannedProperty[];
}

export interface SetDeclaredSpeakerPropertyInstruction extends InstructionBase {
  readonly kind: "setDeclaredSpeakerProperty";
  readonly speaker: string;
  readonly name: string;
  readonly value: ExpressionPlan;
}

export interface SetDefaultSpeakerInstruction extends InstructionBase {
  readonly kind: "setDefaultSpeaker";
  readonly name: string;
}

export interface EnterScopeInstruction extends InstructionBase {
  readonly kind: "enterScope";
}

export interface LeaveScopeInstruction extends InstructionBase {
  readonly kind: "leaveScope";
}

export interface DeclareBindingInstruction extends InstructionBase {
  readonly kind: "declareBinding";
  readonly name: string;
  readonly value: ExpressionPlan;
}

export interface AssignInstruction extends InstructionBase {
  readonly kind: "assign";
  readonly target: AssignmentTargetPlan;
  readonly value: ExpressionPlan;
}

export interface ValidateAssignmentTargetInstruction extends InstructionBase {
  readonly kind: "validateAssignmentTarget";
  readonly target: AssignmentTargetPlan;
}

export interface PrepareReferenceInstruction extends InstructionBase {
  readonly kind: "prepareReference";
  readonly expression: ExpressionPlan;
  readonly destinationTemporary: number;
}

export interface ValidateCallReceiverInstruction extends InstructionBase {
  readonly kind: "validateCallReceiver";
  readonly receiver: ExpressionPlan;
  readonly method: string;
}

export interface EvaluateInstruction extends InstructionBase {
  readonly kind: "evaluate";
  readonly expression: ExpressionPlan;
}

export interface JumpIfFalseInstruction extends InstructionBase {
  readonly kind: "jumpIfFalse";
  readonly condition: ExpressionPlan;
  readonly target: number;
}

export interface JumpInstruction extends InstructionBase {
  readonly kind: "jump";
  readonly target: number;
}

export type LoopStartInstruction =
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "repeat";
      readonly loopId: number;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    })
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "for";
      readonly loopId: number;
      readonly variable: string;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    })
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "while";
      readonly loopId: number;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    });

export interface LoopControlInstruction extends InstructionBase {
  readonly kind: "loopControl";
  readonly action: "break" | "continue";
  readonly loopId: number;
  readonly target: number;
}

export interface StoreTemporaryInstruction extends InstructionBase {
  readonly kind: "storeTemporary";
  readonly temporaryId: number;
  readonly value: ExpressionPlan;
  readonly expectBoolean: boolean;
}

export interface ClearTemporaryInstruction extends InstructionBase {
  readonly kind: "clearTemporary";
  readonly temporaryId: number;
}

export interface PreparedCallArgument {
  readonly parameterName: string;
  readonly temporaryId: number;
  readonly span: SourceSpan;
}

export interface CallFunctionInstruction extends InstructionBase {
  readonly kind: "callFunction";
  readonly functionId: number;
  readonly arguments: readonly PreparedCallArgument[];
  readonly destinationTemporary: number;
  readonly returnInstruction: number;
}

interface FunctionParameterInstructionBase extends InstructionBase {
  readonly functionId: number;
  readonly parameterIndex: number;
}

export interface BindSuppliedParameterInstruction extends FunctionParameterInstructionBase {
  readonly kind: "bindSuppliedParameter";
}

export interface BeginFunctionDefaultsInstruction extends InstructionBase {
  readonly kind: "beginFunctionDefaults";
  readonly functionId: number;
}

export interface PrepareParameterDefaultInstruction extends FunctionParameterInstructionBase {
  readonly kind: "prepareParameterDefault";
  readonly target: number;
}

export interface BindDefaultParameterInstruction extends FunctionParameterInstructionBase {
  readonly kind: "bindDefaultParameter";
  readonly value: ExpressionPlan;
}

export interface EnterFunctionBodyInstruction extends InstructionBase {
  readonly kind: "enterFunctionBody";
  readonly functionId: number;
}

export interface ReturnValueInstruction extends InstructionBase {
  readonly kind: "returnValue";
  readonly value: ExpressionPlan;
}

export interface ReturnVoidInstruction extends InstructionBase {
  readonly kind: "returnVoid";
}

export interface SayInstruction extends InstructionBase {
  readonly kind: "say";
  readonly speaker: string | null;
  readonly value: ExpressionPlan;
}

export interface ExitInstruction extends InstructionBase {
  readonly kind: "exit";
}

export interface PlannedProperty {
  readonly name: string;
  readonly value: ExpressionPlan;
  readonly span: SourceSpan;
}

export type AssignmentTargetPlan =
  | IdentifierExpressionPlan
  | PropertyExpressionPlan
  | IndexExpressionPlan;

export type ExpressionPlan =
  | LiteralExpressionPlan
  | IdentifierExpressionPlan
  | ListExpressionPlan
  | ObjectExpressionPlan
  | SetExpressionPlan
  | GroupExpressionPlan
  | TemplateExpressionPlan
  | PropertyExpressionPlan
  | IndexExpressionPlan
  | CallExpressionPlan
  | UnaryExpressionPlan
  | BinaryExpressionPlan
  | RangeExpressionPlan
  | TemporaryExpressionPlan
  | PreparedReferenceExpressionPlan;

interface ExpressionPlanBase {
  readonly span: SourceSpan;
}

export interface LiteralExpressionPlan extends ExpressionPlanBase {
  readonly kind: "literal";
  readonly value: string | number | boolean | null;
}

export interface IdentifierExpressionPlan extends ExpressionPlanBase {
  readonly kind: "identifier";
  readonly name: string;
}

export interface TemporaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "temporary";
  readonly temporaryId: number;
}

export interface PreparedReferenceExpressionPlan extends ExpressionPlanBase {
  readonly kind: "preparedReference";
  readonly temporaryId: number;
}

export interface ListExpressionPlan extends ExpressionPlanBase {
  readonly kind: "list";
  readonly elements: readonly ExpressionPlan[];
}

export interface ObjectExpressionPlan extends ExpressionPlanBase {
  readonly kind: "object";
  readonly properties: readonly PlannedProperty[];
}

export interface SetExpressionPlan extends ExpressionPlanBase {
  readonly kind: "set";
  readonly elements: readonly ExpressionPlan[];
}

export interface GroupExpressionPlan extends ExpressionPlanBase {
  readonly kind: "group";
  readonly expression: ExpressionPlan;
}

export type TemplatePartPlan =
  | {
      readonly kind: "text";
      readonly value: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "expression";
      readonly expression: ExpressionPlan;
      readonly span: SourceSpan;
    };

export interface TemplateExpressionPlan extends ExpressionPlanBase {
  readonly kind: "template";
  readonly parts: readonly TemplatePartPlan[];
}

export interface PropertyExpressionPlan extends ExpressionPlanBase {
  readonly kind: "property";
  readonly object: ExpressionPlan;
  readonly name: string;
}

export interface IndexExpressionPlan extends ExpressionPlanBase {
  readonly kind: "index";
  readonly object: ExpressionPlan;
  readonly index: ExpressionPlan;
}

export type ArgumentPlan =
  | {
      readonly kind: "positional";
      readonly value: ExpressionPlan;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "named";
      readonly name: string;
      readonly value: ExpressionPlan;
      readonly span: SourceSpan;
    };

export interface CallExpressionPlan extends ExpressionPlanBase {
  readonly kind: "call";
  readonly callee: ExpressionPlan;
  readonly arguments: readonly ArgumentPlan[];
}

export interface UnaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "unary";
  readonly operator: "+" | "-" | "not";
  readonly operand: ExpressionPlan;
}

export interface BinaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "binary";
  readonly operator:
    | "*"
    | "/"
    | "%"
    | "+"
    | "-"
    | "=="
    | "!="
    | "<"
    | "<="
    | ">"
    | ">="
    | "and"
    | "or";
  readonly left: ExpressionPlan;
  readonly right: ExpressionPlan;
}

export interface RangeExpressionPlan extends ExpressionPlanBase {
  readonly kind: "range";
  readonly start: ExpressionPlan;
  readonly end: ExpressionPlan;
  readonly inclusive: boolean;
}

export interface PlanValidationError {
  readonly code: "TSC001" | "TSC002";
  readonly message: string;
  readonly path: string;
}

export interface PlanValidationResult {
  readonly valid: boolean;
  readonly errors: readonly PlanValidationError[];
}

export function compileProgram(program: Program): InstructionPlan {
  const declarations = program.statements.filter(
    (statement): statement is FunctionDeclaration =>
      statement.kind === "functionDeclaration",
  );
  const compiler = new InstructionCompiler(declarations);
  compiler.compileStatements(
    program.statements.filter(
      (statement) => statement.kind !== "functionDeclaration",
    ),
  );
  const rootEndInstruction = compiler.instructions.length;
  compiler.compileFunctions();
  return deepFreeze({
    format: INSTRUCTION_PLAN_FORMAT,
    version: INSTRUCTION_PLAN_VERSION,
    sourceSpan: copySpan(program.span),
    rootEndInstruction,
    temporaryCount: compiler.temporaryCount,
    functions: compiler.functions,
    instructions: compiler.instructions,
  });
}

export function validateInstructionPlan(value: unknown): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const jsonFailure = findJsonSafetyFailure(value, "$", new Set<object>());
  if (jsonFailure !== null) {
    return invalidPlan("TSC002", jsonFailure.message, jsonFailure.path);
  }
  if (!isRecord(value)) {
    return invalidPlan("TSC002", "Instruction plan must be an object.", "$.");
  }
  if (value.format !== INSTRUCTION_PLAN_FORMAT) {
    errors.push(planError("TSC001", "Unsupported instruction-plan format.", "$.format"));
  }
  if (value.version !== INSTRUCTION_PLAN_VERSION) {
    errors.push(planError("TSC001", "Unsupported instruction-plan version.", "$.version"));
  }
  validateSpan(value.sourceSpan, "$.sourceSpan", errors);
  const temporaryCount = nonNegativeInteger(value.temporaryCount)
    ? value.temporaryCount
    : -1;
  if (temporaryCount < 0) {
    errors.push(planError("TSC002", "temporaryCount must be a non-negative integer.", "$.temporaryCount"));
  }
  if (!Array.isArray(value.instructions)) {
    errors.push(planError("TSC002", "Instructions must be an array.", "$.instructions"));
  } else {
    if (
      !nonNegativeInteger(value.rootEndInstruction) ||
      value.rootEndInstruction > value.instructions.length
    ) {
      errors.push(planError("TSC002", "Root execution boundary is invalid.", "$.rootEndInstruction"));
    }
    const functionIds = collectFunctionIds(value.functions);
    for (let index = 0; index < value.instructions.length; index += 1) {
      validateInstruction(
        value.instructions[index],
        `$.instructions[${index}]`,
        value.instructions.length,
        index,
        temporaryCount,
        functionIds,
        errors,
      );
    }
    validateLoopStructure(value.instructions, errors);
    validatePreparedReferenceStructure(value.instructions, errors);
    validateFunctionDefinitions(
      value.functions,
      value.instructions,
      value.rootEndInstruction,
      errors,
    );
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

function validatePreparedReferenceStructure(
  instructions: readonly unknown[],
  errors: PlanValidationError[],
): void {
  const producers = new Map<number, number>();
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction)) continue;
    if (
      instruction.kind === "prepareReference" &&
      Number.isInteger(instruction.destinationTemporary)
    ) {
      const temporaryId = instruction.destinationTemporary as number;
      if (producers.has(temporaryId)) {
        errors.push(planError(
          "TSC002",
          "Prepared-reference temporary is produced more than once.",
          `$.instructions[${index}].destinationTemporary`,
        ));
      }
      producers.set(temporaryId, index);
    }
  }
  for (let index = 0; index < instructions.length; index += 1) {
    const referenced = new Set<number>();
    collectPreparedReferenceIds(instructions[index], referenced);
    for (const temporaryId of referenced) {
      const producer = producers.get(temporaryId);
      if (producer === undefined) {
        errors.push(planError(
          "TSC002",
          "Prepared-reference expression has no matching producer.",
          `$.instructions[${index}]`,
        ));
        continue;
      }
      if (producer >= index) {
        errors.push(planError(
          "TSC002",
          "Prepared-reference producer must precede its use.",
          `$.instructions[${index}]`,
        ));
      }
    }
  }
}

function collectPreparedReferenceIds(
  value: unknown,
  output: Set<number>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPreparedReferenceIds(item, output);
    return;
  }
  if (!isRecord(value)) return;
  if (value.kind === "preparedReference" && Number.isInteger(value.temporaryId)) {
    output.add(value.temporaryId as number);
    return;
  }
  for (const nested of Object.values(value)) {
    collectPreparedReferenceIds(nested, output);
  }
}

function validateLoopStructure(
  instructions: readonly unknown[],
  errors: PlanValidationError[],
): void {
  const starts = new Map<number, { index: number; target: number; continueTarget: number }>();
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction) || instruction.kind !== "loopStart") continue;
    if (
      !Number.isInteger(instruction.loopId) ||
      !Number.isInteger(instruction.target) ||
      !Number.isInteger(instruction.continueTarget)
    ) continue;
    const loopId = instruction.loopId as number;
    if (starts.has(loopId)) {
      errors.push(planError("TSC002", "Loop IDs must be unique.", `$.instructions[${index}].loopId`));
    } else {
      starts.set(loopId, {
        index,
        target: instruction.target as number,
        continueTarget: instruction.continueTarget as number,
      });
    }
    if ((instruction.target as number) <= index) {
      errors.push(planError("TSC002", "Loop exit target must follow its start.", `$.instructions[${index}].target`));
    }
    if (
      (instruction.loopKind === "while" && (instruction.continueTarget as number) > index) ||
      (instruction.loopKind !== "while" && instruction.continueTarget !== index)
    ) {
      errors.push(planError("TSC002", "Loop continue target is invalid.", `$.instructions[${index}].continueTarget`));
    }
  }
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction) || instruction.kind !== "loopControl") continue;
    if (!Number.isInteger(instruction.loopId) || !Number.isInteger(instruction.target)) continue;
    const start = starts.get(instruction.loopId as number);
    if (start === undefined) {
      errors.push(planError("TSC002", "Loop control refers to an unknown loop.", `$.instructions[${index}].loopId`));
      continue;
    }
    const expected = instruction.action === "continue" ? start.continueTarget : start.target;
    if (instruction.target !== expected || index <= start.index || index >= start.target) {
      errors.push(planError("TSC002", "Loop-control target does not match its loop.", `$.instructions[${index}].target`));
    }
  }
}

class InstructionCompiler {
  public readonly instructions: Instruction[] = [];
  public readonly functions: CompiledFunctionDefinition[] = [];
  readonly #loops: Array<{
    readonly loopId: number;
    readonly continueTarget: number;
    readonly breaks: number[];
  }> = [];
  readonly #functionByName: ReadonlyMap<
    string,
    { readonly id: number; readonly declaration: FunctionDeclaration }
  >;
  #nextLoopId = 1;
  #nextTemporaryId = 1;

  public constructor(private readonly declarations: readonly FunctionDeclaration[]) {
    this.#functionByName = new Map(
      declarations.map((declaration, index) => [
        declaration.name.name,
        { id: index + 1, declaration },
      ]),
    );
  }

  public get temporaryCount(): number {
    return this.#nextTemporaryId - 1;
  }

  public compileFunctions(): void {
    for (const declaration of this.declarations) {
      this.#compileFunction(declaration);
    }
  }

  public compileStatements(statements: readonly Statement[]): void {
    for (const statement of statements) this.#compileStatement(statement);
  }

  #compileStatement(statement: Statement): void {
    switch (statement.kind) {
      case "speakerDeclaration":
        if (statement.properties.some((property) => this.#containsUserCall(property.value))) {
          this.instructions.push({
            kind: "declareSpeaker",
            name: statement.name.name,
            properties: [],
            span: copySpan(statement.span),
          });
          for (const property of statement.properties) {
            const lowered = this.#lowerExpression(property.value);
            this.instructions.push({
              kind: "setDeclaredSpeakerProperty",
              speaker: statement.name.name,
              name: property.name.name,
              value: lowered.plan,
              span: copySpan(property.span),
            });
            this.#emitTemporaryCleanup(lowered.temporaryIds, property.span);
          }
          return;
        }
        this.instructions.push({
          kind: "declareSpeaker",
          name: statement.name.name,
          properties: statement.properties.map((property) => ({
            name: property.name.name,
            value: compileExpression(property.value),
            span: copySpan(property.span),
          })),
          span: copySpan(statement.span),
        });
        return;
      case "speakerSetterStatement":
        this.instructions.push({
          kind: "setDefaultSpeaker",
          name: statement.speaker.name,
          span: copySpan(statement.span),
        });
        return;
      case "sayStatement":
        {
        const lowered = this.#lowerExpression(statement.value);
        this.instructions.push({
          kind: "say",
          speaker: statement.speaker?.name ?? null,
          value: lowered.plan,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
        }
      case "exitStatement":
        this.instructions.push({ kind: "exit", span: copySpan(statement.span) });
        return;
      case "letStatement":
        {
        const lowered = this.#lowerExpression(statement.initializer);
        this.instructions.push({
          kind: "declareBinding",
          name: statement.name.name,
          value: lowered.plan,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
        }
      case "assignmentStatement":
        {
        const target = this.#lowerAssignmentTarget(statement.target);
        if (target.plan.kind !== "identifier") {
          this.instructions.push({
            kind: "validateAssignmentTarget",
            target: target.plan,
            span: copySpan(statement.target.span),
          });
        }
        const value = this.#lowerExpression(statement.value);
        this.instructions.push({
          kind: "assign",
          target: target.plan,
          value: value.plan,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(
          [...target.temporaryIds, ...value.temporaryIds],
          statement.span,
        );
        return;
        }
      case "expressionStatement":
        {
        const lowered = this.#lowerExpression(statement.expression);
        this.instructions.push({
          kind: "evaluate",
          expression: lowered.plan,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
        }
      case "ifStatement":
        this.#compileIf(statement);
        return;
      case "repeatStatement":
        this.#compileLoop("repeat", statement.count, statement.body, null, statement.span);
        return;
      case "forStatement":
        this.#compileLoop(
          "for",
          statement.iterable,
          statement.body,
          statement.variable.name,
          statement.span,
        );
        return;
      case "whileStatement":
        this.#compileLoop("while", statement.condition, statement.body, null, statement.span);
        return;
      case "breakStatement":
      case "continueStatement": {
        const loop = this.#loops.at(-1);
        if (loop === undefined) {
          throw new TypeError("Semantically invalid loop control reached compilation.");
        }
        const index = this.instructions.length;
        this.instructions.push({
          kind: "loopControl",
          action: statement.kind === "breakStatement" ? "break" : "continue",
          loopId: loop.loopId,
          target:
            statement.kind === "breakStatement" ? -1 : loop.continueTarget,
          span: copySpan(statement.span),
        });
        if (statement.kind === "breakStatement") loop.breaks.push(index);
        return;
      }
      case "returnStatement": {
        if (statement.value === null) {
          this.instructions.push({ kind: "returnVoid", span: copySpan(statement.span) });
          return;
        }
        const lowered = this.#lowerExpression(statement.value);
        this.instructions.push({
          kind: "returnValue",
          value: lowered.plan,
          span: copySpan(statement.span),
        });
        return;
      }
      case "functionDeclaration":
        throw new TypeError("Nested function declaration reached compilation.");
    }
  }

  #compileIf(statement: Extract<Statement, { kind: "ifStatement" }>): void {
    const lowered = this.#lowerExpression(statement.condition);
    const conditional = this.instructions.length;
    this.instructions.push({
      kind: "jumpIfFalse",
      condition: lowered.plan,
      target: -1,
      span: copySpan(statement.condition.span),
    });
    this.#emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
    this.#compileBlock(statement.thenBlock);
    if (statement.elseBlock === null) {
      const falseCleanup = this.instructions.length;
      this.instructions[conditional] = {
        ...(this.instructions[conditional] as JumpIfFalseInstruction),
        target: falseCleanup,
      };
      this.#emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
      return;
    }

    const jump = this.instructions.length;
    this.instructions.push({
      kind: "jump",
      target: -1,
      span: copySpan(statement.span),
    });
    const falseCleanup = this.instructions.length;
    this.instructions[conditional] = {
      ...(this.instructions[conditional] as JumpIfFalseInstruction),
      target: falseCleanup,
    };
    this.#emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
    if (statement.elseBlock.kind === "ifStatement") {
      this.#compileIf(statement.elseBlock);
    } else {
      this.#compileBlock(statement.elseBlock);
    }
    this.instructions[jump] = {
      ...(this.instructions[jump] as JumpInstruction),
      target: this.instructions.length,
    };
  }

  #compileBlock(block: Block): void {
    this.instructions.push({ kind: "enterScope", span: copySpan(block.span) });
    this.compileStatements(block.statements);
    this.instructions.push({ kind: "leaveScope", span: copySpan(block.span) });
  }

  #compileLoop(
    loopKind: "repeat" | "for" | "while",
    expression: Expression,
    body: Block,
    variable: string | null,
    span: SourceSpan,
  ): void {
    const loopId = this.#nextLoopId;
    this.#nextLoopId += 1;
    const continueTarget = this.instructions.length;
    const lowered = this.#lowerExpression(expression);
    const start = this.instructions.length;
    const loopContinueTarget = loopKind === "while" ? continueTarget : start;
    const instruction: LoopStartInstruction = loopKind === "for"
      ? {
          kind: "loopStart",
          loopKind,
          loopId,
          variable: variable!,
          expression: lowered.plan,
          continueTarget: loopContinueTarget,
          target: -1,
          span: copySpan(span),
        }
      : {
          kind: "loopStart",
          loopKind,
          loopId,
          expression: lowered.plan,
          continueTarget: loopContinueTarget,
          target: -1,
          span: copySpan(span),
        };
    this.instructions.push(instruction);
    this.#emitTemporaryCleanup(lowered.temporaryIds, expression.span);
    const context = {
      loopId,
      continueTarget: instruction.continueTarget,
      breaks: [] as number[],
    };
    this.#loops.push(context);
    this.compileStatements(body.statements);
    this.instructions.push({
      kind: "loopControl",
      action: "continue",
      loopId,
      target: context.continueTarget,
      span: copySpan(body.span),
    });
    this.#loops.pop();
    const falseCleanup = this.instructions.length;
    this.instructions[start] = { ...instruction, target: falseCleanup };
    this.#emitTemporaryCleanup(lowered.temporaryIds, expression.span);
    const exit = this.instructions.length;
    for (const index of context.breaks) {
      this.instructions[index] = {
        ...(this.instructions[index] as LoopControlInstruction),
        target: exit,
      };
    }
  }

  #compileFunction(declaration: FunctionDeclaration): void {
    const registered = this.#functionByName.get(declaration.name.name);
    if (registered === undefined) {
      throw new TypeError("Semantically invalid function reached compilation.");
    }
    const entryInstruction = this.instructions.length;
    declaration.parameters.forEach((parameter, parameterIndex) => {
      this.instructions.push({
        kind: "bindSuppliedParameter",
        functionId: registered.id,
        parameterIndex,
        span: copySpan(parameter.span),
      });
    });
    this.instructions.push({
      kind: "beginFunctionDefaults",
      functionId: registered.id,
      span: copySpan(declaration.span),
    });
    declaration.parameters.forEach((parameter, parameterIndex) => {
      const prepareIndex = this.instructions.length;
      this.instructions.push({
        kind: "prepareParameterDefault",
        functionId: registered.id,
        parameterIndex,
        target: -1,
        span: copySpan(parameter.span),
      });
      if (parameter.defaultValue !== null) {
        const lowered = this.#lowerExpression(parameter.defaultValue);
        this.instructions.push({
          kind: "bindDefaultParameter",
          functionId: registered.id,
          parameterIndex,
          value: lowered.plan,
          span: copySpan(parameter.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, parameter.span);
      }
      this.instructions[prepareIndex] = {
        ...(this.instructions[prepareIndex] as PrepareParameterDefaultInstruction),
        target: this.instructions.length,
      };
    });
    this.instructions.push({
      kind: "enterFunctionBody",
      functionId: registered.id,
      span: copySpan(declaration.body.span),
    });
    const bodyEntryInstruction = this.instructions.length;
    this.compileStatements(declaration.body.statements);
    const implicitReturnInstruction = this.instructions.length;
    this.instructions.push({
      kind: "returnVoid",
      span: copySpan(declaration.body.span),
    });
    const endInstruction = this.instructions.length;
    this.functions.push({
      id: registered.id,
      name: declaration.name.name,
      declarationSpan: copySpan(declaration.span),
      parameters: declaration.parameters.map((parameter, index) => ({
        name: parameter.name.name,
        index,
        hasDefault: parameter.defaultValue !== null,
        declarationSpan: copySpan(parameter.span),
        defaultSpan:
          parameter.defaultValue === null
            ? null
            : copySpan(parameter.defaultValue.span),
      })),
      entryInstruction,
      bodyEntryInstruction,
      implicitReturnInstruction,
      endInstruction,
      bodySpan: copySpan(declaration.body.span),
    });
  }

  #lowerExpression(expression: Expression): LoweredExpression {
    if (
      expression.kind === "callExpression" &&
      expression.callee.kind === "identifier" &&
      this.#functionByName.has(expression.callee.name)
    ) {
      return this.#lowerUserFunctionCall(expression);
    }
    if (
      expression.kind === "binaryExpression" &&
      (expression.operator === "and" || expression.operator === "or") &&
      this.#containsUserCall(expression)
    ) {
      return this.#lowerLogicalExpression(expression);
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "stringLiteral":
      case "identifier":
        return { plan: compileExpression(expression), temporaryIds: [] };
      case "parenthesizedExpression": {
        const nested = this.#lowerExpression(expression.expression);
        return {
          plan: { kind: "group", expression: nested.plan, span: copySpan(expression.span) },
          temporaryIds: nested.temporaryIds,
        };
      }
      case "listLiteral":
      case "setLiteral": {
        const lowered = this.#lowerOrderedExpressions(expression.elements);
        return {
          plan: {
            kind: expression.kind === "listLiteral" ? "list" : "set",
            elements: lowered.map((item) => item.plan),
            span: copySpan(expression.span),
          },
          temporaryIds: lowered.flatMap((item) => item.temporaryIds),
        };
      }
      case "objectLiteral": {
        const values = this.#lowerOrderedExpressions(
          expression.properties.map((property) => property.value),
        );
        const lowered = expression.properties.map((property, index) => ({
          property,
          lowered: values[index]!,
        }));
        return {
          plan: {
            kind: "object",
            properties: lowered.map(({ property, lowered: value }) => ({
              name: property.name.name,
              value: value.plan,
              span: copySpan(property.span),
            })),
            span: copySpan(expression.span),
          },
          temporaryIds: lowered.flatMap((item) => item.lowered.temporaryIds),
        };
      }
      case "templateLiteral": {
        const ids: number[] = [];
        const interpolations = expression.parts
          .filter((part) => part.kind === "templateInterpolation")
          .map((part) => part.expression);
        const loweredInterpolations = this.#lowerOrderedExpressions(interpolations);
        let interpolationIndex = 0;
        const parts = expression.parts.map((part): TemplatePartPlan => {
          if (part.kind === "templateText") {
            return { kind: "text", value: part.value, span: copySpan(part.span) };
          }
          const lowered = loweredInterpolations[interpolationIndex++]!;
          ids.push(...lowered.temporaryIds);
          return {
            kind: "expression",
            expression: lowered.plan,
            span: copySpan(part.span),
          };
        });
        return { plan: { kind: "template", parts, span: copySpan(expression.span) }, temporaryIds: ids };
      }
      case "propertyAccessExpression": {
        const object = this.#lowerExpression(expression.object);
        return {
          plan: { kind: "property", object: object.plan, name: expression.property.name, span: copySpan(expression.span) },
          temporaryIds: object.temporaryIds,
        };
      }
      case "indexExpression": {
        let object = this.#lowerExpression(expression.object);
        if (this.#containsUserCall(expression.index)) {
          object = this.#prepareReferenceExpression(object, expression.object.span);
        }
        const index = this.#lowerExpression(expression.index);
        return {
          plan: { kind: "index", object: object.plan, index: index.plan, span: copySpan(expression.span) },
          temporaryIds: [...object.temporaryIds, ...index.temporaryIds],
        };
      }
      case "callExpression": {
        let callee: LoweredExpression;
        if (expression.callee.kind === "propertyAccessExpression") {
          let receiver = this.#lowerExpression(expression.callee.object);
          if (expression.arguments.some((argument) => this.#containsUserCall(argument.value))) {
            receiver = this.#prepareReferenceExpression(
              receiver,
              expression.callee.object.span,
            );
            this.instructions.push({
              kind: "validateCallReceiver",
              receiver: receiver.plan,
              method: expression.callee.property.name,
              span: copySpan(expression.callee.span),
            });
          }
          callee = {
            plan: {
              kind: "property",
              object: receiver.plan,
              name: expression.callee.property.name,
              span: copySpan(expression.callee.span),
            },
            temporaryIds: receiver.temporaryIds,
          };
        } else {
          callee = this.#lowerExpression(expression.callee);
        }
        const loweredArguments = this.#lowerOrderedExpressions(
          expression.arguments.map((argument) => argument.value),
        );
        const argumentsList = expression.arguments.map((argument, index) => ({
          argument,
          lowered: loweredArguments[index]!,
        }));
        return {
          plan: {
            kind: "call",
            callee: callee.plan,
            arguments: argumentsList.map(({ argument, lowered }) =>
              argument.kind === "positionalArgument"
                ? { kind: "positional", value: lowered.plan, span: copySpan(argument.span) }
                : { kind: "named", name: argument.name.name, value: lowered.plan, span: copySpan(argument.span) },
            ),
            span: copySpan(expression.span),
          },
          temporaryIds: [
            ...callee.temporaryIds,
            ...argumentsList.flatMap((item) => item.lowered.temporaryIds),
          ],
        };
      }
      case "unaryExpression": {
        const operand = this.#lowerExpression(expression.operand);
        return {
          plan: { kind: "unary", operator: expression.operator, operand: operand.plan, span: copySpan(expression.span) },
          temporaryIds: operand.temporaryIds,
        };
      }
      case "binaryExpression": {
        const [left, right] = this.#lowerOrderedExpressions([
          expression.left,
          expression.right,
        ]);
        return {
          plan: { kind: "binary", operator: expression.operator, left: left!.plan, right: right!.plan, span: copySpan(expression.span) },
          temporaryIds: [...left!.temporaryIds, ...right!.temporaryIds],
        };
      }
      case "rangeExpression": {
        const [start, end] = this.#lowerOrderedExpressions([
          expression.start,
          expression.end,
        ]);
        return {
          plan: { kind: "range", start: start!.plan, end: end!.plan, inclusive: expression.inclusive, span: copySpan(expression.span) },
          temporaryIds: [...start!.temporaryIds, ...end!.temporaryIds],
        };
      }
    }
  }

  #lowerAssignmentTarget(expression: Expression): {
    readonly plan: AssignmentTargetPlan;
    readonly temporaryIds: readonly number[];
  } {
    if (expression.kind === "identifier") {
      return {
        plan: { kind: "identifier", name: expression.name, span: copySpan(expression.span) },
        temporaryIds: [],
      };
    }
    if (expression.kind === "propertyAccessExpression") {
      const object = this.#lowerAssignmentObject(expression.object);
      return {
        plan: {
          kind: "property",
          object: object.plan,
          name: expression.property.name,
          span: copySpan(expression.span),
        },
        temporaryIds: object.temporaryIds,
      };
    }
    if (expression.kind === "indexExpression") {
      const object = this.#lowerAssignmentObject(expression.object);
      const index = this.#materializeExpression(
        this.#lowerExpression(expression.index),
        expression.index.span,
      );
      return {
        plan: {
          kind: "index",
          object: object.plan,
          index: index.plan,
          span: copySpan(expression.span),
        },
        temporaryIds: [...object.temporaryIds, ...index.temporaryIds],
      };
    }
    throw new TypeError("AST assignment target is not assignable.");
  }

  #lowerAssignmentObject(expression: Expression): LoweredExpression {
    const lowered = this.#lowerExpression(expression);
    return this.#prepareReferenceExpression(lowered, expression.span);
  }

  #materializeExpression(
    lowered: LoweredExpression,
    span: SourceSpan,
  ): LoweredExpression {
    const temporaryId = this.#allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId,
      value: lowered.plan,
      expectBoolean: false,
      span: copySpan(span),
    });
    return {
      plan: { kind: "temporary", temporaryId, span: copySpan(span) },
      temporaryIds: [...lowered.temporaryIds, temporaryId],
    };
  }

  #prepareReferenceExpression(
    lowered: LoweredExpression,
    span: SourceSpan,
  ): LoweredExpression {
    if (lowered.plan.kind === "preparedReference") return lowered;
    const temporaryId = this.#allocateTemporary();
    this.instructions.push({
      kind: "prepareReference",
      expression: lowered.plan,
      destinationTemporary: temporaryId,
      span: copySpan(span),
    });
    return {
      plan: {
        kind: "preparedReference",
        temporaryId,
        span: copySpan(span),
      },
      temporaryIds: [...lowered.temporaryIds, temporaryId],
    };
  }

  #lowerOrderedExpressions(
    expressions: readonly Expression[],
  ): LoweredExpression[] {
    const lowered: LoweredExpression[] = [];
    for (let index = 0; index < expressions.length; index += 1) {
      const expression = expressions[index]!;
      let item = this.#lowerExpression(expression);
      const laterEmitsInstructions = expressions
        .slice(index + 1)
        .some((later) => this.#containsUserCall(later));
      if (laterEmitsInstructions) {
        item = item.plan.kind === "temporary"
          ? item
          : this.#materializeExpression(item, expression.span);
      }
      lowered.push(item);
    }
    return lowered;
  }

  #lowerUserFunctionCall(
    expression: Extract<Expression, { kind: "callExpression" }>,
  ): LoweredExpression {
    const name = (expression.callee as Extract<Expression, { kind: "identifier" }>).name;
    const registered = this.#functionByName.get(name)!;
    const temporaryIds: number[] = [];
    const prepared: PreparedCallArgument[] = [];
    expression.arguments.forEach((argument, index) => {
      const lowered = this.#lowerExpression(argument.value);
      temporaryIds.push(...lowered.temporaryIds);
      const temporaryId = this.#allocateTemporary();
      temporaryIds.push(temporaryId);
      this.instructions.push({
        kind: "storeTemporary",
        temporaryId,
        value: lowered.plan,
        expectBoolean: false,
        span: copySpan(argument.span),
      });
      const parameterName =
        argument.kind === "namedArgument"
          ? argument.name.name
          : registered.declaration.parameters[index]!.name.name;
      prepared.push({
        parameterName,
        temporaryId,
        span: copySpan(argument.span),
      });
    });
    const destinationTemporary = this.#allocateTemporary();
    temporaryIds.push(destinationTemporary);
    const callIndex = this.instructions.length;
    this.instructions.push({
      kind: "callFunction",
      functionId: registered.id,
      arguments: prepared,
      destinationTemporary,
      returnInstruction: callIndex + 1,
      span: copySpan(expression.span),
    });
    return {
      plan: {
        kind: "temporary",
        temporaryId: destinationTemporary,
        span: copySpan(expression.span),
      },
      temporaryIds,
    };
  }

  #lowerLogicalExpression(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
  ): LoweredExpression {
    const left = this.#lowerExpression(expression.left);
    const resultTemporary = this.#allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: left.plan,
      expectBoolean: true,
      span: copySpan(expression.left.span),
    });
    const condition: TemporaryExpressionPlan = {
      kind: "temporary",
      temporaryId: resultTemporary,
      span: copySpan(expression.left.span),
    };
    if (expression.operator === "and") {
      const conditional = this.instructions.length;
      this.instructions.push({
        kind: "jumpIfFalse",
        condition,
        target: -1,
        span: copySpan(expression.span),
      });
      const right = this.#lowerExpression(expression.right);
      this.instructions.push({
        kind: "storeTemporary",
        temporaryId: resultTemporary,
        value: right.plan,
        expectBoolean: true,
        span: copySpan(expression.right.span),
      });
      this.instructions[conditional] = {
        ...(this.instructions[conditional] as JumpIfFalseInstruction),
        target: this.instructions.length,
      };
      return {
        plan: { ...condition, span: copySpan(expression.span) },
        temporaryIds: [...left.temporaryIds, ...right.temporaryIds, resultTemporary],
      };
    }
    const conditional = this.instructions.length;
    this.instructions.push({
      kind: "jumpIfFalse",
      condition,
      target: -1,
      span: copySpan(expression.span),
    });
    const skipRight = this.instructions.length;
    this.instructions.push({ kind: "jump", target: -1, span: copySpan(expression.span) });
    this.instructions[conditional] = {
      ...(this.instructions[conditional] as JumpIfFalseInstruction),
      target: this.instructions.length,
    };
    const right = this.#lowerExpression(expression.right);
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: right.plan,
      expectBoolean: true,
      span: copySpan(expression.right.span),
    });
    this.instructions[skipRight] = {
      ...(this.instructions[skipRight] as JumpInstruction),
      target: this.instructions.length,
    };
    return {
      plan: { ...condition, span: copySpan(expression.span) },
      temporaryIds: [...left.temporaryIds, ...right.temporaryIds, resultTemporary],
    };
  }

  #containsUserCall(expression: Expression): boolean {
    if (
      expression.kind === "callExpression" &&
      expression.callee.kind === "identifier" &&
      this.#functionByName.has(expression.callee.name)
    ) {
      return true;
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "stringLiteral":
      case "identifier":
        return false;
      case "parenthesizedExpression":
        return this.#containsUserCall(expression.expression);
      case "listLiteral":
      case "setLiteral":
        return expression.elements.some((item) => this.#containsUserCall(item));
      case "objectLiteral":
        return expression.properties.some((item) => this.#containsUserCall(item.value));
      case "templateLiteral":
        return expression.parts.some((part) =>
          part.kind === "templateInterpolation" && this.#containsUserCall(part.expression)
        );
      case "propertyAccessExpression":
        return this.#containsUserCall(expression.object);
      case "indexExpression":
        return this.#containsUserCall(expression.object) || this.#containsUserCall(expression.index);
      case "callExpression":
        return this.#containsUserCall(expression.callee) ||
          expression.arguments.some((argument) => this.#containsUserCall(argument.value));
      case "unaryExpression":
        return this.#containsUserCall(expression.operand);
      case "binaryExpression":
        return this.#containsUserCall(expression.left) || this.#containsUserCall(expression.right);
      case "rangeExpression":
        return this.#containsUserCall(expression.start) || this.#containsUserCall(expression.end);
    }
  }

  #allocateTemporary(): number {
    const id = this.#nextTemporaryId;
    this.#nextTemporaryId += 1;
    return id;
  }

  #emitTemporaryCleanup(ids: readonly number[], span: SourceSpan): void {
    for (const temporaryId of new Set(ids)) {
      this.instructions.push({
        kind: "clearTemporary",
        temporaryId,
        span: copySpan(span),
      });
    }
  }
}

interface LoweredExpression {
  readonly plan: ExpressionPlan;
  readonly temporaryIds: readonly number[];
}

function compileExpression(expression: Expression): ExpressionPlan {
  switch (expression.kind) {
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
    case "stringLiteral":
      return { kind: "literal", value: expression.value, span: copySpan(expression.span) };
    case "identifier":
      return { kind: "identifier", name: expression.name, span: copySpan(expression.span) };
    case "listLiteral":
      return {
        kind: "list",
        elements: expression.elements.map(compileExpression),
        span: copySpan(expression.span),
      };
    case "objectLiteral":
      return {
        kind: "object",
        properties: expression.properties.map((property) => ({
          name: property.name.name,
          value: compileExpression(property.value),
          span: copySpan(property.span),
        })),
        span: copySpan(expression.span),
      };
    case "setLiteral":
      return {
        kind: "set",
        elements: expression.elements.map(compileExpression),
        span: copySpan(expression.span),
      };
    case "parenthesizedExpression":
      return {
        kind: "group",
        expression: compileExpression(expression.expression),
        span: copySpan(expression.span),
      };
    case "templateLiteral":
      return {
        kind: "template",
        parts: expression.parts.map((part) =>
          part.kind === "templateText"
            ? { kind: "text", value: part.value, span: copySpan(part.span) }
            : {
                kind: "expression",
                expression: compileExpression(part.expression),
                span: copySpan(part.span),
              },
        ),
        span: copySpan(expression.span),
      };
    case "propertyAccessExpression":
      return {
        kind: "property",
        object: compileExpression(expression.object),
        name: expression.property.name,
        span: copySpan(expression.span),
      };
    case "indexExpression":
      return {
        kind: "index",
        object: compileExpression(expression.object),
        index: compileExpression(expression.index),
        span: copySpan(expression.span),
      };
    case "callExpression":
      return {
        kind: "call",
        callee: compileExpression(expression.callee),
        arguments: expression.arguments.map(compileArgument),
        span: copySpan(expression.span),
      };
    case "unaryExpression":
      return {
        kind: "unary",
        operator: expression.operator,
        operand: compileExpression(expression.operand),
        span: copySpan(expression.span),
      };
    case "binaryExpression":
      return {
        kind: "binary",
        operator: expression.operator,
        left: compileExpression(expression.left),
        right: compileExpression(expression.right),
        span: copySpan(expression.span),
      };
    case "rangeExpression":
      return {
        kind: "range",
        start: compileExpression(expression.start),
        end: compileExpression(expression.end),
        inclusive: expression.inclusive,
        span: copySpan(expression.span),
      };
  }
}

function compileArgument(argument: CallArgument): ArgumentPlan {
  return argument.kind === "positionalArgument"
    ? {
        kind: "positional",
        value: compileExpression(argument.value),
        span: copySpan(argument.span),
      }
    : {
        kind: "named",
        name: argument.name.name,
        value: compileExpression(argument.value),
        span: copySpan(argument.span),
      };
}

function validateInstruction(
  value: unknown,
  path: string,
  instructionCount: number,
  instructionIndex: number,
  temporaryCount: number,
  functionIds: ReadonlySet<number>,
  errors: PlanValidationError[],
): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push(planError("TSC002", "Instruction must be an object with a kind.", path));
    return;
  }
  validateSpan(value.span, `${path}.span`, errors);
  switch (value.kind) {
    case "declareSpeaker":
      requireString(value.name, `${path}.name`, errors);
      validateProperties(value.properties, `${path}.properties`, errors, temporaryCount);
      return;
    case "setDeclaredSpeakerProperty":
      requireString(value.speaker, `${path}.speaker`, errors);
      requireString(value.name, `${path}.name`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "setDefaultSpeaker":
      requireString(value.name, `${path}.name`, errors);
      return;
    case "enterScope":
    case "leaveScope":
    case "exit":
      return;
    case "declareBinding":
      requireString(value.name, `${path}.name`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "prepareReference":
      validateExpression(
        value.expression,
        `${path}.expression`,
        errors,
        false,
        temporaryCount,
      );
      validateTemporaryId(
        value.destinationTemporary,
        `${path}.destinationTemporary`,
        temporaryCount,
        errors,
      );
      return;
    case "validateAssignmentTarget":
      validateExpression(value.target, `${path}.target`, errors, true, temporaryCount);
      validatePreparedAssignmentTarget(value.target, `${path}.target`, errors);
      return;
    case "assign":
      validateExpression(value.target, `${path}.target`, errors, true, temporaryCount);
      validatePreparedAssignmentTarget(value.target, `${path}.target`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "validateCallReceiver":
      validateExpression(value.receiver, `${path}.receiver`, errors, false, temporaryCount);
      requireString(value.method, `${path}.method`, errors);
      return;
    case "evaluate":
      validateExpression(value.expression, `${path}.expression`, errors, false, temporaryCount);
      return;
    case "jumpIfFalse":
      validateExpression(value.condition, `${path}.condition`, errors, false, temporaryCount);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "jump":
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "loopStart":
      if (!["repeat", "for", "while"].includes(String(value.loopKind))) {
        errors.push(planError("TSC002", "Invalid loop kind.", `${path}.loopKind`));
      }
      requirePositiveInteger(value.loopId, `${path}.loopId`, errors);
      if (value.loopKind === "for") requireString(value.variable, `${path}.variable`, errors);
      validateExpression(value.expression, `${path}.expression`, errors, false, temporaryCount);
      validateJumpTarget(value.continueTarget, `${path}.continueTarget`, instructionCount, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "loopControl":
      if (!["break", "continue"].includes(String(value.action))) {
        errors.push(planError("TSC002", "Invalid loop-control action.", `${path}.action`));
      }
      requirePositiveInteger(value.loopId, `${path}.loopId`, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "storeTemporary":
      validateTemporaryId(value.temporaryId, `${path}.temporaryId`, temporaryCount, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      if (typeof value.expectBoolean !== "boolean") {
        errors.push(planError("TSC002", "Temporary boolean expectation must be boolean.", `${path}.expectBoolean`));
      }
      return;
    case "clearTemporary":
      validateTemporaryId(value.temporaryId, `${path}.temporaryId`, temporaryCount, errors);
      return;
    case "callFunction":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      validatePreparedArguments(value.arguments, `${path}.arguments`, temporaryCount, errors);
      validateTemporaryId(value.destinationTemporary, `${path}.destinationTemporary`, temporaryCount, errors);
      if (
        Number.isInteger(value.destinationTemporary) &&
        Array.isArray(value.arguments) &&
        value.arguments.some(
          (argument) =>
            isRecord(argument) &&
            argument.temporaryId === value.destinationTemporary,
        )
      ) {
        errors.push(planError(
          "TSC002",
          "Function result destination must not alias an argument temporary.",
          `${path}.destinationTemporary`,
        ));
      }
      validateJumpTarget(value.returnInstruction, `${path}.returnInstruction`, instructionCount, errors);
      if (value.returnInstruction !== instructionIndex + 1) {
        errors.push(planError("TSC002", "Function return target must be the instruction after the call.", `${path}.returnInstruction`));
      }
      return;
    case "bindSuppliedParameter":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      requireNonNegativeInteger(value.parameterIndex, `${path}.parameterIndex`, errors);
      return;
    case "beginFunctionDefaults":
    case "enterFunctionBody":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      return;
    case "prepareParameterDefault":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      requireNonNegativeInteger(value.parameterIndex, `${path}.parameterIndex`, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      if (typeof value.target === "number" && value.target <= instructionIndex) {
        errors.push(planError("TSC002", "Parameter-default target must move forward.", `${path}.target`));
      }
      return;
    case "bindDefaultParameter":
      validateFunctionId(value.functionId, `${path}.functionId`, functionIds, errors);
      requireNonNegativeInteger(value.parameterIndex, `${path}.parameterIndex`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "returnValue":
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    case "returnVoid":
      return;
    case "say":
      if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
      validateExpression(value.value, `${path}.value`, errors, false, temporaryCount);
      return;
    default:
      errors.push(planError("TSC002", `Unknown instruction kind '${value.kind}'.`, `${path}.kind`));
  }
}

function validateExpression(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  assignmentTarget = false,
  temporaryCount = -1,
): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push(planError("TSC002", "Expression must be an object with a kind.", path));
    return;
  }
  validateSpan(value.span, `${path}.span`, errors);
  if (assignmentTarget && !["identifier", "property", "index"].includes(value.kind)) {
    errors.push(planError("TSC002", "Invalid assignment target plan.", path));
  }
  switch (value.kind) {
    case "literal":
      if (!isScalar(value.value)) {
        errors.push(planError("TSC002", "Literal value must be a finite JSON scalar.", `${path}.value`));
      }
      return;
    case "identifier":
      requireString(value.name, `${path}.name`, errors);
      return;
    case "temporary":
    case "preparedReference":
      validateTemporaryId(value.temporaryId, `${path}.temporaryId`, temporaryCount, errors);
      return;
    case "list":
    case "set":
      validateExpressionArray(value.elements, `${path}.elements`, errors, temporaryCount);
      return;
    case "object":
      validateProperties(value.properties, `${path}.properties`, errors, temporaryCount);
      return;
    case "group":
      validateExpression(value.expression, `${path}.expression`, errors, false, temporaryCount);
      return;
    case "template":
      validateTemplateParts(value.parts, `${path}.parts`, errors, temporaryCount);
      return;
    case "property":
      validateExpression(value.object, `${path}.object`, errors, false, temporaryCount);
      requireString(value.name, `${path}.name`, errors);
      return;
    case "index":
      validateExpression(value.object, `${path}.object`, errors, false, temporaryCount);
      validateExpression(value.index, `${path}.index`, errors, false, temporaryCount);
      return;
    case "call":
      validateExpression(value.callee, `${path}.callee`, errors, false, temporaryCount);
      validateArguments(value.arguments, `${path}.arguments`, errors, temporaryCount);
      return;
    case "unary":
      if (!["+", "-", "not"].includes(String(value.operator))) {
        errors.push(planError("TSC002", "Invalid unary operator.", `${path}.operator`));
      }
      validateExpression(value.operand, `${path}.operand`, errors, false, temporaryCount);
      return;
    case "binary":
      if (!binaryOperators.has(String(value.operator))) {
        errors.push(planError("TSC002", "Invalid binary operator.", `${path}.operator`));
      }
      validateExpression(value.left, `${path}.left`, errors, false, temporaryCount);
      validateExpression(value.right, `${path}.right`, errors, false, temporaryCount);
      return;
    case "range":
      validateExpression(value.start, `${path}.start`, errors, false, temporaryCount);
      validateExpression(value.end, `${path}.end`, errors, false, temporaryCount);
      if (typeof value.inclusive !== "boolean") {
        errors.push(planError("TSC002", "Range inclusivity must be boolean.", `${path}.inclusive`));
      }
      return;
    default:
      errors.push(planError("TSC002", `Unknown expression kind '${value.kind}'.`, `${path}.kind`));
  }
}

function validatePreparedAssignmentTarget(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!isRecord(value)) return;
  if (value.kind === "identifier") return;
  if (value.kind === "property") {
    if (!isRecord(value.object) || value.object.kind !== "preparedReference") {
      errors.push(planError(
        "TSC002",
        "Assignment receivers must be captured before the right-hand value.",
        `${path}.object`,
      ));
    }
    return;
  }
  if (value.kind === "index") {
    if (!isRecord(value.index) || value.index.kind !== "temporary") {
      errors.push(planError(
        "TSC002",
        "Assignment indexes must be prepared in a temporary before the right-hand value.",
        `${path}.index`,
      ));
    }
    if (!isRecord(value.object) || value.object.kind !== "preparedReference") {
      errors.push(planError(
        "TSC002",
        "Assignment receivers must be captured before the right-hand value.",
        `${path}.object`,
      ));
    }
  }
}

function validateProperties(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Properties must be an array.", path));
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const property = value[index];
    const propertyPath = `${path}[${index}]`;
    if (!isRecord(property)) {
      errors.push(planError("TSC002", "Property must be an object.", propertyPath));
      continue;
    }
    requireString(property.name, `${propertyPath}.name`, errors);
    validateExpression(property.value, `${propertyPath}.value`, errors, false, temporaryCount);
    validateSpan(property.span, `${propertyPath}.span`, errors);
  }
}

function validateExpressionArray(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Expression list must be an array.", path));
    return;
  }
  value.forEach((item, index) =>
    validateExpression(item, `${path}[${index}]`, errors, false, temporaryCount)
  );
}

function validateTemplateParts(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Template parts must be an array.", path));
    return;
  }
  value.forEach((part, index) => {
    const partPath = `${path}[${index}]`;
    if (!isRecord(part)) {
      errors.push(planError("TSC002", "Template part must be an object.", partPath));
      return;
    }
    validateSpan(part.span, `${partPath}.span`, errors);
    if (part.kind === "text") requireString(part.value, `${partPath}.value`, errors);
    else if (part.kind === "expression") {
      validateExpression(part.expression, `${partPath}.expression`, errors, false, temporaryCount);
    } else {
      errors.push(planError("TSC002", "Unknown template part kind.", `${partPath}.kind`));
    }
  });
}

function validateArguments(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
  temporaryCount: number,
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Arguments must be an array.", path));
    return;
  }
  value.forEach((argument, index) => {
    const argumentPath = `${path}[${index}]`;
    if (!isRecord(argument)) {
      errors.push(planError("TSC002", "Argument must be an object.", argumentPath));
      return;
    }
    validateSpan(argument.span, `${argumentPath}.span`, errors);
    if (argument.kind === "named") requireString(argument.name, `${argumentPath}.name`, errors);
    else if (argument.kind !== "positional") {
      errors.push(planError("TSC002", "Unknown argument kind.", `${argumentPath}.kind`));
    }
    validateExpression(argument.value, `${argumentPath}.value`, errors, false, temporaryCount);
  });
}

function collectFunctionIds(value: unknown): ReadonlySet<number> {
  if (!Array.isArray(value)) return new Set<number>();
  return new Set(
    value
      .filter(isRecord)
      .map((item) => item.id)
      .filter((id): id is number => Number.isInteger(id) && (id as number) > 0),
  );
}

function validateFunctionDefinitions(
  value: unknown,
  instructions: readonly unknown[],
  rootEndInstruction: unknown,
  errors: PlanValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Function definitions must be an array.", "$.functions"));
    return;
  }
  const ids = new Set<number>();
  const names = new Set<string>();
  const definitions = new Map<number, Record<string, unknown>>();
  let expectedEntry = nonNegativeInteger(rootEndInstruction)
    ? rootEndInstruction
    : -1;
  value.forEach((definition, definitionIndex) => {
    const path = `$.functions[${definitionIndex}]`;
    if (!isRecord(definition)) {
      errors.push(planError("TSC002", "Function definition must be an object.", path));
      return;
    }
    requirePositiveInteger(definition.id, `${path}.id`, errors);
    requireString(definition.name, `${path}.name`, errors);
    validateSpan(definition.declarationSpan, `${path}.declarationSpan`, errors);
    validateSpan(definition.bodySpan, `${path}.bodySpan`, errors);
    if (typeof definition.id === "number") {
      if (ids.has(definition.id)) {
        errors.push(planError("TSC002", "Function IDs must be unique.", `${path}.id`));
      }
      if (definition.id !== definitionIndex + 1) {
        errors.push(planError("TSC002", "Function IDs must follow deterministic source order.", `${path}.id`));
      }
      ids.add(definition.id);
      definitions.set(definition.id, definition);
    }
    if (typeof definition.name === "string") {
      if (names.has(definition.name)) {
        errors.push(planError("TSC002", "Function names must be unique.", `${path}.name`));
      }
      names.add(definition.name);
    }
    validateFunctionParameters(definition.parameters, `${path}.parameters`, errors);
    const points = [
      definition.entryInstruction,
      definition.bodyEntryInstruction,
      definition.implicitReturnInstruction,
      definition.endInstruction,
    ];
    if (points.some((point) => !nonNegativeInteger(point))) {
      errors.push(planError("TSC002", "Function instruction boundaries must be non-negative integers.", path));
      return;
    }
    const [entry, bodyEntry, implicitReturn, end] = points as [
      number,
      number,
      number,
      number,
    ];
    if (
      entry !== expectedEntry ||
      entry >= bodyEntry ||
      bodyEntry > implicitReturn ||
      implicitReturn + 1 !== end ||
      end > instructions.length
    ) {
      errors.push(planError("TSC002", "Function instruction range is overlapping or impossible.", path));
    }
    const bodyEntryMarker = instructions[bodyEntry - 1];
    if (!isRecord(bodyEntryMarker) || bodyEntryMarker.kind !== "enterFunctionBody") {
      errors.push(planError("TSC002", "Function body entry point is invalid.", `${path}.bodyEntryInstruction`));
    }
    const implicitReturnInstruction = instructions[implicitReturn];
    if (!isRecord(implicitReturnInstruction) || implicitReturnInstruction.kind !== "returnVoid") {
      errors.push(planError("TSC002", "Function implicit-return boundary is invalid.", `${path}.implicitReturnInstruction`));
    }
    validateFunctionPrologue(definition, instructions, path, errors);
    expectedEntry = end;
  });
  if (expectedEntry !== instructions.length) {
    errors.push(planError("TSC002", "Function ranges do not cover the non-root instruction region.", "$.functions"));
  }

  instructions.forEach((instruction, index) => {
    if (!isRecord(instruction)) return;
    const owner = [...definitions.values()].find((definition) =>
      typeof definition.entryInstruction === "number" &&
      typeof definition.endInstruction === "number" &&
      index >= definition.entryInstruction &&
      index < definition.endInstruction
    );
    const functionOnly = [
      "bindSuppliedParameter",
      "beginFunctionDefaults",
      "prepareParameterDefault",
      "bindDefaultParameter",
      "enterFunctionBody",
      "returnValue",
      "returnVoid",
    ].includes(String(instruction.kind));
    if (functionOnly && owner === undefined) {
      errors.push(planError("TSC002", "Function-only instruction appears in root execution.", `$.instructions[${index}]`));
    }
    if (
      owner !== undefined &&
      instruction.kind !== "callFunction" &&
      "functionId" in instruction &&
      instruction.functionId !== owner.id
    ) {
      errors.push(planError("TSC002", "Function prologue instruction has the wrong function ID.", `$.instructions[${index}].functionId`));
    }
    if (instruction.kind === "callFunction" && typeof instruction.functionId === "number") {
      const target = definitions.get(instruction.functionId);
      if (target !== undefined && Array.isArray(target.parameters) && Array.isArray(instruction.arguments)) {
        const parameterNames = new Set(
          target.parameters
            .filter(isRecord)
            .map((parameter) => parameter.name)
            .filter((name): name is string => typeof name === "string"),
        );
        const supplied = new Set<string>();
        instruction.arguments.forEach((argument, argumentIndex) => {
          if (!isRecord(argument) || typeof argument.parameterName !== "string") return;
          if (!parameterNames.has(argument.parameterName)) {
            errors.push(planError("TSC002", "Call refers to an unknown function parameter.", `$.instructions[${index}].arguments[${argumentIndex}].parameterName`));
          }
          if (supplied.has(argument.parameterName)) {
            errors.push(planError("TSC002", "Call supplies a function parameter more than once.", `$.instructions[${index}].arguments[${argumentIndex}].parameterName`));
          }
          supplied.add(argument.parameterName);
        });
        target.parameters.forEach((parameter, parameterIndex) => {
          if (
            isRecord(parameter) &&
            parameter.hasDefault === false &&
            typeof parameter.name === "string" &&
            !supplied.has(parameter.name)
          ) {
            errors.push(planError(
              "TSC002",
              "Call omits a required function parameter.",
              `$.instructions[${index}].arguments[${parameterIndex}]`,
            ));
          }
        });
      }
    }
  });
}

function validateFunctionPrologue(
  definition: Record<string, unknown>,
  instructions: readonly unknown[],
  path: string,
  errors: PlanValidationError[],
): void {
  if (
    !Array.isArray(definition.parameters) ||
    !nonNegativeInteger(definition.entryInstruction) ||
    !nonNegativeInteger(definition.bodyEntryInstruction) ||
    !nonNegativeInteger(definition.id)
  ) {
    return;
  }
  let cursor = definition.entryInstruction;
  for (let index = 0; index < definition.parameters.length; index += 1) {
    const instruction = instructions[cursor];
    if (
      !isRecord(instruction) ||
      instruction.kind !== "bindSuppliedParameter" ||
      instruction.functionId !== definition.id ||
      instruction.parameterIndex !== index
    ) {
      errors.push(planError("TSC002", "Function supplied-parameter prologue is malformed.", `${path}.entryInstruction`));
      return;
    }
    cursor += 1;
  }
  const beginDefaults = instructions[cursor];
  if (
    !isRecord(beginDefaults) ||
    beginDefaults.kind !== "beginFunctionDefaults" ||
    beginDefaults.functionId !== definition.id
  ) {
    errors.push(planError("TSC002", "Function default-parameter prologue is missing.", `${path}.entryInstruction`));
    return;
  }
  cursor += 1;
  for (let index = 0; index < definition.parameters.length; index += 1) {
    const parameter = definition.parameters[index];
    const prepare = instructions[cursor];
    if (
      !isRecord(parameter) ||
      !isRecord(prepare) ||
      prepare.kind !== "prepareParameterDefault" ||
      prepare.functionId !== definition.id ||
      prepare.parameterIndex !== index ||
      !nonNegativeInteger(prepare.target) ||
      prepare.target <= cursor ||
      prepare.target >= definition.bodyEntryInstruction
    ) {
      errors.push(planError("TSC002", "Function parameter-default sequence is malformed.", `${path}.parameters[${index}]`));
      return;
    }
    const regionStart = cursor + 1;
    const regionEnd = prepare.target;
    const defaultBindings: Record<string, unknown>[] = [];
    for (let instructionIndex = regionStart; instructionIndex < regionEnd; instructionIndex += 1) {
      const nested = instructions[instructionIndex];
      if (!isRecord(nested)) continue;
      if (nested.kind === "bindDefaultParameter") {
        if (
          nested.functionId !== definition.id ||
          nested.parameterIndex !== index
        ) {
          errors.push(planError(
            "TSC002",
            "Default binding does not match its parameter segment.",
            `$.instructions[${instructionIndex}]`,
          ));
        }
        defaultBindings.push(nested);
        continue;
      }
      if (
        ![
          "storeTemporary",
          "prepareReference",
          "clearTemporary",
          "callFunction",
          "validateCallReceiver",
          "jumpIfFalse",
          "jump",
        ].includes(String(nested.kind))
      ) {
        errors.push(planError(
          "TSC002",
          "Function default-expression region contains an invalid instruction.",
          `$.instructions[${instructionIndex}]`,
        ));
      }
      if (
        (nested.kind === "jump" || nested.kind === "jumpIfFalse") &&
        (!nonNegativeInteger(nested.target) ||
          nested.target <= instructionIndex ||
          nested.target > regionEnd)
      ) {
        errors.push(planError(
          "TSC002",
          "Default-expression jump escapes its parameter segment.",
          `$.instructions[${instructionIndex}].target`,
        ));
      }
    }
    if (
      (parameter.hasDefault === true && defaultBindings.length !== 1) ||
      (parameter.hasDefault === false && regionEnd !== regionStart)
    ) {
      errors.push(planError("TSC002", "Function parameter default does not match its metadata.", `${path}.parameters[${index}]`));
    }
    if (parameter.hasDefault === true && defaultBindings.length === 1) {
      const bindingIndex = instructions.indexOf(defaultBindings[0]);
      for (
        let instructionIndex = regionStart;
        instructionIndex < regionEnd;
        instructionIndex += 1
      ) {
        const nested = instructions[instructionIndex];
        if (!isRecord(nested)) continue;
        if (instructionIndex > bindingIndex && nested.kind !== "clearTemporary") {
          errors.push(planError(
            "TSC002",
            "Only temporary cleanup may follow a default binding.",
            `$.instructions[${instructionIndex}]`,
          ));
        }
        if (
          (nested.kind === "jump" || nested.kind === "jumpIfFalse") &&
          nonNegativeInteger(nested.target) &&
          nested.target > bindingIndex
        ) {
          errors.push(planError(
            "TSC002",
            "Default-expression control flow may not bypass its binding.",
            `$.instructions[${instructionIndex}].target`,
          ));
        }
      }
    }
    cursor = prepare.target;
  }
  const bodyMarker = instructions[cursor];
  if (
    !isRecord(bodyMarker) ||
    bodyMarker.kind !== "enterFunctionBody" ||
    bodyMarker.functionId !== definition.id ||
    cursor + 1 !== definition.bodyEntryInstruction
  ) {
    errors.push(planError("TSC002", "Function body-entry prologue marker is malformed.", `${path}.bodyEntryInstruction`));
  }
  const prologueOnly = new Set([
    "bindSuppliedParameter",
    "beginFunctionDefaults",
    "prepareParameterDefault",
    "bindDefaultParameter",
    "enterFunctionBody",
  ]);
  for (
    let instructionIndex = definition.bodyEntryInstruction;
    instructionIndex < (definition.endInstruction as number);
    instructionIndex += 1
  ) {
    const instruction = instructions[instructionIndex];
    if (isRecord(instruction) && prologueOnly.has(String(instruction.kind))) {
      errors.push(planError(
        "TSC002",
        "Function prologue instruction appears inside the function body.",
        `$.instructions[${instructionIndex}]`,
      ));
    }
  }
}

function validateFunctionParameters(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Function parameters must be an array.", path));
    return;
  }
  const names = new Set<string>();
  let sawDefault = false;
  value.forEach((parameter, index) => {
    const parameterPath = `${path}[${index}]`;
    if (!isRecord(parameter)) {
      errors.push(planError("TSC002", "Function parameter must be an object.", parameterPath));
      return;
    }
    requireString(parameter.name, `${parameterPath}.name`, errors);
    if (typeof parameter.name === "string") {
      if (names.has(parameter.name)) {
        errors.push(planError("TSC002", "Function parameter names must be unique.", `${parameterPath}.name`));
      }
      names.add(parameter.name);
    }
    if (parameter.index !== index) {
      errors.push(planError("TSC002", "Function parameter indexes must be contiguous.", `${parameterPath}.index`));
    }
    if (typeof parameter.hasDefault !== "boolean") {
      errors.push(planError("TSC002", "Function parameter default metadata is malformed.", `${parameterPath}.hasDefault`));
    } else {
      if (!parameter.hasDefault && sawDefault) {
        errors.push(planError("TSC002", "Required parameter follows a defaulted parameter.", parameterPath));
      }
      sawDefault ||= parameter.hasDefault;
    }
    validateSpan(parameter.declarationSpan, `${parameterPath}.declarationSpan`, errors);
    if (parameter.hasDefault === true) {
      validateSpan(parameter.defaultSpan, `${parameterPath}.defaultSpan`, errors);
    } else if (parameter.defaultSpan !== null) {
      errors.push(planError("TSC002", "Required parameter must not have a default span.", `${parameterPath}.defaultSpan`));
    }
  });
}

function validatePreparedArguments(
  value: unknown,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Prepared function arguments must be an array.", path));
    return;
  }
  const temporaryIds = new Set<number>();
  value.forEach((argument, index) => {
    const argumentPath = `${path}[${index}]`;
    if (!isRecord(argument)) {
      errors.push(planError("TSC002", "Prepared function argument must be an object.", argumentPath));
      return;
    }
    requireString(argument.parameterName, `${argumentPath}.parameterName`, errors);
    validateTemporaryId(argument.temporaryId, `${argumentPath}.temporaryId`, temporaryCount, errors);
    if (typeof argument.temporaryId === "number") {
      if (temporaryIds.has(argument.temporaryId)) {
        errors.push(planError(
          "TSC002",
          "Prepared function argument temporary IDs must be unique.",
          `${argumentPath}.temporaryId`,
        ));
      }
      temporaryIds.add(argument.temporaryId);
    }
    validateSpan(argument.span, `${argumentPath}.span`, errors);
  });
}

function validateTemporaryId(
  value: unknown,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > temporaryCount) {
    errors.push(planError("TSC002", "Temporary reference is outside the plan's temporary range.", path));
  }
}

function validateFunctionId(
  value: unknown,
  path: string,
  functionIds: ReadonlySet<number>,
  errors: PlanValidationError[],
): void {
  if (!Number.isInteger(value) || !functionIds.has(value as number)) {
    errors.push(planError("TSC002", "Instruction refers to an unknown function ID.", path));
  }
}

function validateSpan(value: unknown, path: string, errors: PlanValidationError[]): void {
  if (!isRecord(value) || !validPosition(value.start) || !validPosition(value.end)) {
    errors.push(planError("TSC002", "Source span is malformed.", path));
    return;
  }
  const start = value.start as { offset: number };
  const end = value.end as { offset: number };
  if (end.offset < start.offset) {
    errors.push(planError("TSC002", "Source span ends before it starts.", path));
  }
}

function validPosition(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonNegativeInteger(value.offset) &&
    nonNegativeInteger(value.line) &&
    nonNegativeInteger(value.column)
  );
}

function validateJumpTarget(
  value: unknown,
  path: string,
  instructionCount: number,
  errors: PlanValidationError[],
): void {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > instructionCount) {
    errors.push(planError("TSC002", "Jump target is outside the instruction plan.", path));
  }
}

function requireString(value: unknown, path: string, errors: PlanValidationError[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(planError("TSC002", "Expected a non-empty string.", path));
  }
}

function requirePositiveInteger(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    errors.push(planError("TSC002", "Expected a positive integer.", path));
  }
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!nonNegativeInteger(value)) {
    errors.push(planError("TSC002", "Expected a non-negative integer.", path));
  }
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findJsonSafetyFailure(
  value: unknown,
  path: string,
  active: Set<object>,
): { readonly message: string; readonly path: string } | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : { message: "Plan contains a non-finite number.", path };
  }
  if (typeof value !== "object") {
    return { message: "Plan contains a non-JSON-safe value.", path };
  }
  if (active.has(value)) return { message: "Plan contains a cycle.", path };
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return { message: "Plan contains a non-plain object.", path };
  }
  active.add(value);
  try {
    for (const [key, nested] of Object.entries(value)) {
      const failure = findJsonSafetyFailure(nested, `${path}.${key}`, active);
      if (failure !== null) return failure;
    }
  } finally {
    active.delete(value);
  }
  return null;
}

function planError(
  code: PlanValidationError["code"],
  message: string,
  path: string,
): PlanValidationError {
  return Object.freeze({ code, message, path });
}

function invalidPlan(
  code: PlanValidationError["code"],
  message: string,
  path: string,
): PlanValidationResult {
  return Object.freeze({ valid: false, errors: Object.freeze([planError(code, message, path)]) });
}

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

const binaryOperators = new Set([
  "*", "/", "%", "+", "-", "==", "!=", "<", "<=", ">", ">=", "and", "or",
]);
