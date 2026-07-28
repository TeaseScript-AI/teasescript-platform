import type {
  Block,
  CallArgument,
  Expression,
  FunctionDeclaration,
  Statement,
} from "../../ast.js";
import { createSourceSpan, type SourceSpan } from "../../source.js";
import { InstructionCompilationError } from "../errors.js";
import type {
  ArgumentPlan,
  AssignmentTargetPlan,
  CompiledFunctionDefinition,
  ExpressionPlan,
  Instruction,
  JumpIfFalseInstruction,
  JumpInstruction,
  LoopControlInstruction,
  LoopStartInstruction,
  PrepareParameterDefaultInstruction,
  PreparedCallArgument,
  TemplatePartPlan,
  TemporaryExpressionPlan,
} from "../../plan/model.js";

export class InstructionCompiler {
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
      case "waitStatement": {
        const lowered = this.#lowerExpression(statement.duration);
        this.instructions.push({ kind: "wait", duration: lowered.plan, unit: statement.unit, span: copySpan(statement.span) });
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
      let parameterName: string;
      if (argument.kind === "namedArgument") {
        parameterName = argument.name.name;
      } else {
        const parameter = registered.declaration.parameters[index];
        if (parameter === undefined) {
          throw new InstructionCompilationError(
            "TSC003",
            `Function '${name}' has no parameter for positional argument ${index + 1}.`,
            argument.span,
          );
        }
        parameterName = parameter.name.name;
      }
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


function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}
