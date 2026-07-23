import type {
  AssignmentTarget,
  Block,
  CallArgument,
  Expression,
  Program,
  Statement,
} from "./ast.js";
import { createSourceSpan, type SourceSpan } from "./source.js";

export const INSTRUCTION_PLAN_FORMAT = "teasescript-instruction-plan";
export const INSTRUCTION_PLAN_VERSION = 2;

export interface InstructionPlan {
  readonly format: typeof INSTRUCTION_PLAN_FORMAT;
  readonly version: typeof INSTRUCTION_PLAN_VERSION;
  readonly sourceSpan: SourceSpan;
  readonly instructions: readonly Instruction[];
}

export type Instruction =
  | DeclareSpeakerInstruction
  | SetDefaultSpeakerInstruction
  | EnterScopeInstruction
  | LeaveScopeInstruction
  | DeclareBindingInstruction
  | AssignInstruction
  | EvaluateInstruction
  | JumpIfFalseInstruction
  | JumpInstruction
  | LoopStartInstruction
  | LoopControlInstruction
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
      readonly target: number;
    })
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "for";
      readonly loopId: number;
      readonly variable: string;
      readonly expression: ExpressionPlan;
      readonly target: number;
    })
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "while";
      readonly loopId: number;
      readonly expression: ExpressionPlan;
      readonly target: number;
    });

export interface LoopControlInstruction extends InstructionBase {
  readonly kind: "loopControl";
  readonly action: "break" | "continue";
  readonly loopId: number;
  readonly target: number;
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
  | RangeExpressionPlan;

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
  const compiler = new InstructionCompiler();
  compiler.compileStatements(program.statements);
  return deepFreeze({
    format: INSTRUCTION_PLAN_FORMAT,
    version: INSTRUCTION_PLAN_VERSION,
    sourceSpan: copySpan(program.span),
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
  if (!Array.isArray(value.instructions)) {
    errors.push(planError("TSC002", "Instructions must be an array.", "$.instructions"));
  } else {
    for (let index = 0; index < value.instructions.length; index += 1) {
      validateInstruction(
        value.instructions[index],
        `$.instructions[${index}]`,
        value.instructions.length,
        errors,
      );
    }
    validateLoopStructure(value.instructions, errors);
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

function validateLoopStructure(
  instructions: readonly unknown[],
  errors: PlanValidationError[],
): void {
  const starts = new Map<number, { index: number; target: number }>();
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!isRecord(instruction) || instruction.kind !== "loopStart") continue;
    if (!Number.isInteger(instruction.loopId) || !Number.isInteger(instruction.target)) continue;
    const loopId = instruction.loopId as number;
    if (starts.has(loopId)) {
      errors.push(planError("TSC002", "Loop IDs must be unique.", `$.instructions[${index}].loopId`));
    } else {
      starts.set(loopId, { index, target: instruction.target as number });
    }
    if ((instruction.target as number) <= index) {
      errors.push(planError("TSC002", "Loop exit target must follow its start.", `$.instructions[${index}].target`));
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
    const expected = instruction.action === "continue" ? start.index : start.target;
    if (instruction.target !== expected || index <= start.index || index >= start.target) {
      errors.push(planError("TSC002", "Loop-control target does not match its loop.", `$.instructions[${index}].target`));
    }
  }
}

class InstructionCompiler {
  public readonly instructions: Instruction[] = [];
  readonly #loops: Array<{
    readonly loopId: number;
    readonly continueTarget: number;
    readonly breaks: number[];
  }> = [];
  #nextLoopId = 1;

  public compileStatements(statements: readonly Statement[]): void {
    for (const statement of statements) this.#compileStatement(statement);
  }

  #compileStatement(statement: Statement): void {
    switch (statement.kind) {
      case "speakerDeclaration":
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
        this.instructions.push({
          kind: "say",
          speaker: statement.speaker?.name ?? null,
          value: compileExpression(statement.value),
          span: copySpan(statement.span),
        });
        return;
      case "exitStatement":
        this.instructions.push({ kind: "exit", span: copySpan(statement.span) });
        return;
      case "letStatement":
        this.instructions.push({
          kind: "declareBinding",
          name: statement.name.name,
          value: compileExpression(statement.initializer),
          span: copySpan(statement.span),
        });
        return;
      case "assignmentStatement":
        this.instructions.push({
          kind: "assign",
          target: compileAssignmentTarget(statement.target),
          value: compileExpression(statement.value),
          span: copySpan(statement.span),
        });
        return;
      case "expressionStatement":
        this.instructions.push({
          kind: "evaluate",
          expression: compileExpression(statement.expression),
          span: copySpan(statement.span),
        });
        return;
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
    }
  }

  #compileIf(statement: Extract<Statement, { kind: "ifStatement" }>): void {
    const conditional = this.instructions.length;
    this.instructions.push({
      kind: "jumpIfFalse",
      condition: compileExpression(statement.condition),
      target: -1,
      span: copySpan(statement.condition.span),
    });
    this.#compileBlock(statement.thenBlock);
    if (statement.elseBlock === null) {
      this.instructions[conditional] = {
        ...(this.instructions[conditional] as JumpIfFalseInstruction),
        target: this.instructions.length,
      };
      return;
    }

    const jump = this.instructions.length;
    this.instructions.push({
      kind: "jump",
      target: -1,
      span: copySpan(statement.span),
    });
    this.instructions[conditional] = {
      ...(this.instructions[conditional] as JumpIfFalseInstruction),
      target: this.instructions.length,
    };
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
    const start = this.instructions.length;
    const instruction: LoopStartInstruction = loopKind === "for"
      ? {
          kind: "loopStart",
          loopKind,
          loopId,
          variable: variable!,
          expression: compileExpression(expression),
          target: -1,
          span: copySpan(span),
        }
      : {
          kind: "loopStart",
          loopKind,
          loopId,
          expression: compileExpression(expression),
          target: -1,
          span: copySpan(span),
        };
    this.instructions.push(instruction);
    const context = { loopId, continueTarget: start, breaks: [] as number[] };
    this.#loops.push(context);
    this.compileStatements(body.statements);
    this.instructions.push({
      kind: "loopControl",
      action: "continue",
      loopId,
      target: start,
      span: copySpan(body.span),
    });
    this.#loops.pop();
    const exit = this.instructions.length;
    this.instructions[start] = { ...instruction, target: exit };
    for (const index of context.breaks) {
      this.instructions[index] = {
        ...(this.instructions[index] as LoopControlInstruction),
        target: exit,
      };
    }
  }
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

function compileAssignmentTarget(target: AssignmentTarget): AssignmentTargetPlan {
  const plan = compileExpression(target);
  if (plan.kind !== "identifier" && plan.kind !== "property" && plan.kind !== "index") {
    throw new TypeError("AST assignment target is not assignable.");
  }
  return plan;
}

function validateInstruction(
  value: unknown,
  path: string,
  instructionCount: number,
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
      validateProperties(value.properties, `${path}.properties`, errors);
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
      validateExpression(value.value, `${path}.value`, errors);
      return;
    case "assign":
      validateExpression(value.target, `${path}.target`, errors, true);
      validateExpression(value.value, `${path}.value`, errors);
      return;
    case "evaluate":
      validateExpression(value.expression, `${path}.expression`, errors);
      return;
    case "jumpIfFalse":
      validateExpression(value.condition, `${path}.condition`, errors);
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
      validateExpression(value.expression, `${path}.expression`, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "loopControl":
      if (!["break", "continue"].includes(String(value.action))) {
        errors.push(planError("TSC002", "Invalid loop-control action.", `${path}.action`));
      }
      requirePositiveInteger(value.loopId, `${path}.loopId`, errors);
      validateJumpTarget(value.target, `${path}.target`, instructionCount, errors);
      return;
    case "say":
      if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
      validateExpression(value.value, `${path}.value`, errors);
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
    case "list":
    case "set":
      validateExpressionArray(value.elements, `${path}.elements`, errors);
      return;
    case "object":
      validateProperties(value.properties, `${path}.properties`, errors);
      return;
    case "group":
      validateExpression(value.expression, `${path}.expression`, errors);
      return;
    case "template":
      validateTemplateParts(value.parts, `${path}.parts`, errors);
      return;
    case "property":
      validateExpression(value.object, `${path}.object`, errors);
      requireString(value.name, `${path}.name`, errors);
      return;
    case "index":
      validateExpression(value.object, `${path}.object`, errors);
      validateExpression(value.index, `${path}.index`, errors);
      return;
    case "call":
      validateExpression(value.callee, `${path}.callee`, errors);
      validateArguments(value.arguments, `${path}.arguments`, errors);
      return;
    case "unary":
      if (!["+", "-", "not"].includes(String(value.operator))) {
        errors.push(planError("TSC002", "Invalid unary operator.", `${path}.operator`));
      }
      validateExpression(value.operand, `${path}.operand`, errors);
      return;
    case "binary":
      if (!binaryOperators.has(String(value.operator))) {
        errors.push(planError("TSC002", "Invalid binary operator.", `${path}.operator`));
      }
      validateExpression(value.left, `${path}.left`, errors);
      validateExpression(value.right, `${path}.right`, errors);
      return;
    case "range":
      validateExpression(value.start, `${path}.start`, errors);
      validateExpression(value.end, `${path}.end`, errors);
      if (typeof value.inclusive !== "boolean") {
        errors.push(planError("TSC002", "Range inclusivity must be boolean.", `${path}.inclusive`));
      }
      return;
    default:
      errors.push(planError("TSC002", `Unknown expression kind '${value.kind}'.`, `${path}.kind`));
  }
}

function validateProperties(value: unknown, path: string, errors: PlanValidationError[]): void {
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
    validateExpression(property.value, `${propertyPath}.value`, errors);
    validateSpan(property.span, `${propertyPath}.span`, errors);
  }
}

function validateExpressionArray(value: unknown, path: string, errors: PlanValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push(planError("TSC002", "Expression list must be an array.", path));
    return;
  }
  value.forEach((item, index) => validateExpression(item, `${path}[${index}]`, errors));
}

function validateTemplateParts(value: unknown, path: string, errors: PlanValidationError[]): void {
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
      validateExpression(part.expression, `${partPath}.expression`, errors);
    } else {
      errors.push(planError("TSC002", "Unknown template part kind.", `${partPath}.kind`));
    }
  });
}

function validateArguments(value: unknown, path: string, errors: PlanValidationError[]): void {
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
    validateExpression(argument.value, `${argumentPath}.value`, errors);
  });
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
