import type {
  Block,
  CallArgument,
  Expression,
  FunctionDeclaration,
  Statement,
  InteractionExpression,
  ShowButtonStatement,
} from "../../ast.js";
import type { SourceSpan } from "../../source.js";
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
  CallArgumentPlan,
  TemplatePartPlan,
  TemporaryExpressionPlan,
  InteractionUiPayload,
  PreparedInteractionUiPayload,
  PlanSourceLocation,
} from "../../plan/model.js";
import { sourceSpanToPlanLocation } from "../../plan/source-location.js";

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
  #contextualSpeakerTemporary: number | null = null;

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
        const textCanSuspend = this.#containsUserCall(statement.value);
        const pacingCanSuspend = statement.pacing !== null &&
          statement.pacing !== "instant" &&
          this.#containsUserCall(statement.pacing);
        if (!textCanSuspend && !pacingCanSuspend) {
          const lowered = this.#lowerExpression(statement.value);
          const loweredPacing = statement.pacing === null || statement.pacing === "instant"
            ? null
            : this.#lowerExpression(statement.pacing);
          this.instructions.push({
            kind: "say",
            speaker: statement.speaker?.name ?? null,
            value: lowered.plan,
            skipPolicy: statement.skipPolicy,
            pacing: statement.pacing === null
              ? "smart"
              : loweredPacing === null
                ? "instant"
                : loweredPacing.plan,
            span: copySpan(statement.span),
          });
          this.#emitTemporaryCleanup([
            ...lowered.temporaryIds,
            ...(loweredPacing?.temporaryIds ?? []),
          ], statement.span);
          return;
        }
        const speakerTemporary = this.#allocateTemporary();
        this.instructions.push({
          kind: "prepareSaySpeaker",
          speaker: statement.speaker?.name ?? null,
          destinationTemporary: speakerTemporary,
          span: copySpan(statement.span),
        });
        const contextualSpeakerTemporary = this.#allocateTemporary();
        this.instructions.push({
          kind: "prepareSayContextualSpeaker",
          speakerTemporary,
          destinationTemporary: contextualSpeakerTemporary,
          span: copySpan(statement.span),
        });
        const lowered = this.#lowerSayPayload(statement.value, contextualSpeakerTemporary);
        if (!pacingCanSuspend) {
          const loweredPacing = statement.pacing === null || statement.pacing === "instant"
            ? null
            : this.#lowerSayPayload(statement.pacing, contextualSpeakerTemporary);
          this.instructions.push({
            kind: "say",
            speaker: statement.speaker?.name ?? null,
            value: lowered.plan,
            speakerTemporary,
            contextualSpeakerTemporary,
            skipPolicy: statement.skipPolicy,
            pacing: statement.pacing === null
              ? "smart"
              : loweredPacing === null
                ? "instant"
                : loweredPacing.plan,
            span: copySpan(statement.span),
          });
          this.#emitTemporaryCleanup([
            speakerTemporary,
            contextualSpeakerTemporary,
            ...lowered.temporaryIds,
            ...(loweredPacing?.temporaryIds ?? []),
          ], statement.span);
          return;
        }
        const textTemporary = this.#allocateTemporary();
        this.instructions.push({
          kind: "prepareSayText",
          value: lowered.plan,
          destinationTemporary: textTemporary,
          span: copySpan(statement.value.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, statement.value.span);
        const loweredPacing = this.#materializeExpression(
          this.#lowerSayPayload(statement.pacing, contextualSpeakerTemporary),
          statement.pacing.span,
        );
        const pacing = loweredPacing.plan;
        this.instructions.push({
          kind: "say",
          speaker: statement.speaker?.name ?? null,
          value: lowered.plan,
          speakerTemporary,
          contextualSpeakerTemporary,
          textTemporary,
          skipPolicy: statement.skipPolicy,
          pacing,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup([
          speakerTemporary,
          contextualSpeakerTemporary,
          textTemporary,
          ...(loweredPacing?.temporaryIds ?? []),
        ], statement.span);
        return;
        }
      case "showButtonStatement":
        this.#compileShowButton(statement);
        return;
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
    expression = unwrapParentheses(expression);
    if (expression.kind === "interactionExpression") {
      return this.#lowerInteraction(expression);
    }
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
        return { plan: compileExpression(expression), temporaryIds: [] };
      case "identifier":
        if (expression.name === "speaker" && this.#contextualSpeakerTemporary !== null) {
          return {
            plan: { kind: "temporary", temporaryId: this.#contextualSpeakerTemporary, span: copySpan(expression.span) },
            temporaryIds: [],
          };
        }
        return { plan: compileExpression(expression), temporaryIds: [] };
      case "parenthesizedExpression":
        return this.#lowerExpression(expression.expression);
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
          for (const temporaryId of lowered.temporaryIds) ids.push(temporaryId);
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
        const normalized = normalizeUnaryExpression(expression);
        const operand = this.#lowerExpression(normalized.operand);
        let plan = operand.plan;
        for (let index = normalized.operators.length - 1; index >= 0; index -= 1) {
          plan = {
            kind: "unary",
            operator: normalized.operators[index]!,
            operand: plan,
            span: copySpan(expression.span),
          };
        }
        return { plan, temporaryIds: operand.temporaryIds };
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

  #compileShowButton(statement: ShowButtonStatement): void {
    const staticLabel = staticVisibleText(statement.label);
    if (staticLabel !== undefined) {
      this.instructions.push({
        kind: "interaction",
        interactionKind: "button",
        target: "standardChat",
        speaker: statement.speaker?.name ?? null,
        destinationTemporary: null,
        expectedResult: "none",
        ui: {
          kind: "button",
          buttonLabel: staticLabel,
          accessibleName: { kind: "localizedDefault", key: "continue" },
        },
        span: copySpan(statement.span),
      });
      return;
    }

    const speakerTemporary = this.#prepareInteractionSpeaker(
      statement.speaker?.name ?? null,
      statement.asSpan ?? statement.commandSpan,
    );
    const label = this.#materializeDedicatedInteractionValue(
      this.#lowerInteractionPayload(statement.label, speakerTemporary),
      statement.label.span,
    );
    this.instructions.push({
      kind: "interaction",
      interactionKind: "button",
      target: "standardChat",
      speakerTemporary,
      destinationTemporary: null,
      expectedResult: "none",
      preparedUi: {
        kind: "button",
        buttonLabelTemporary: label.temporaryId,
        accessibleName: { kind: "localizedDefault", key: "continue" },
      },
      span: copySpan(statement.span),
    });
    this.#emitTemporaryCleanup([speakerTemporary, label.temporaryId], statement.span);
  }

  #lowerInteraction(expression: InteractionExpression): LoweredExpression {
    const values = expression.interactionKind === "choice"
      ? expression.options.map((option) => option.value)
      : expression.hint === null ? [] : [expression.hint];
    const staticValues = values.map(staticVisibleText);
    const allStatic = staticValues.every((value) => value !== undefined);
    const labelType = interactionLabelType(expression);
    const expectedResult = expression.interactionKind === "number" ||
      (expression.interactionKind === "choice" && labelType === "number")
      ? "number" as const
      : "string" as const;

    if (allStatic) {
      const ui = staticInteractionUi(expression, staticValues as string[], labelType);
      return this.#emitResultInteraction({
        interactionKind: expression.interactionKind,
        target: "standardChat",
        speaker: expression.speaker?.name ?? null,
        expectedResult,
        ui,
        span: copySpan(expression.span),
      }, expression.span);
    }

    const speakerTemporary = this.#prepareInteractionSpeaker(
      expression.speaker?.name ?? null,
      expression.asSpan ?? expression.commandSpan,
    );
    let preparedUi: PreparedInteractionUiPayload;
    const preparedTemporaryIds: number[] = [speakerTemporary];

    if (expression.interactionKind === "text" || expression.interactionKind === "number") {
      const hint = expression.hint === null
        ? null
        : this.#materializeDedicatedInteractionValue(
            this.#lowerInteractionPayload(expression.hint, speakerTemporary),
            expression.hint.span,
          );
      if (hint !== null) preparedTemporaryIds.push(hint.temporaryId);
      preparedUi = {
        kind: expression.interactionKind,
        hintTemporary: hint?.temporaryId ?? null,
        accessibleName: {
          kind: "localizedDefault",
          key: expression.interactionKind === "text" ? "answer" : "number",
        },
      };
    } else {
      const loweredValues = this.#lowerInteractionPayloads(values, speakerTemporary);
      const optionsTemporary = this.#allocateTemporary();
      this.instructions.push({
        kind: "storeTemporary",
        temporaryId: optionsTemporary,
        value: {
          kind: "list",
          elements: loweredValues.map((item) => item.plan),
          span: copySpan(expression.span),
        },
        expectBoolean: false,
        span: copySpan(expression.span),
      });
      this.#emitTemporaryCleanup(
        loweredValues.flatMap((item) => item.temporaryIds),
        expression.span,
      );
      preparedTemporaryIds.push(optionsTemporary);
      preparedUi = {
        kind: "choice",
        labelType,
        optionsTemporary,
        optionCount: expression.options.length,
        labels: labelType === "none"
          ? null
          : expression.options.map((option) => interactionLabelValue(option.label!)),
        accessibleName: { kind: "localizedDefault", key: "chooseOption" },
      };
    }

    const lowered = this.#emitPreparedResultInteraction(
      expression.interactionKind,
      expectedResult,
      speakerTemporary,
      preparedUi,
      expression.span,
    );
    this.#emitTemporaryCleanup(preparedTemporaryIds, expression.span);
    return lowered;
  }

  #emitResultInteraction(
    instruction: Omit<Extract<import("../../plan/model.js").InteractionInstruction, { readonly ui: InteractionUiPayload }>, "kind" | "destinationTemporary">,
    span: SourceSpan,
  ): LoweredExpression {
    const transientTemporary = this.#allocateTemporary();
    this.instructions.push({
      kind: "interaction",
      ...instruction,
      destinationTemporary: transientTemporary,
    });
    return this.#consumeInteractionResult(transientTemporary, span);
  }

  #emitPreparedResultInteraction(
    interactionKind: InteractionExpression["interactionKind"],
    expectedResult: "string" | "number",
    speakerTemporary: number,
    preparedUi: PreparedInteractionUiPayload,
    span: SourceSpan,
  ): LoweredExpression {
    const transientTemporary = this.#allocateTemporary();
    this.instructions.push({
      kind: "interaction",
      interactionKind,
      target: "standardChat",
      speakerTemporary,
      destinationTemporary: transientTemporary,
      expectedResult,
      preparedUi,
      span: copySpan(span),
    });
    return this.#consumeInteractionResult(transientTemporary, span);
  }

  #consumeInteractionResult(transientTemporary: number, span: SourceSpan): LoweredExpression {
    const ordinaryTemporary = this.#allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: ordinaryTemporary,
      value: { kind: "temporary", temporaryId: transientTemporary, span: copySpan(span) },
      expectBoolean: false,
      span: copySpan(span),
    });
    this.instructions.push({
      kind: "clearTemporary",
      temporaryId: transientTemporary,
      span: copySpan(span),
    });
    return {
      plan: { kind: "temporary", temporaryId: ordinaryTemporary, span: copySpan(span) },
      temporaryIds: [ordinaryTemporary],
    };
  }

  #prepareInteractionSpeaker(speaker: string | null, span: SourceSpan): number {
    const destinationTemporary = this.#allocateTemporary();
    this.instructions.push({
      kind: "prepareInteractionSpeaker",
      speaker,
      destinationTemporary,
      span: copySpan(span),
    });
    return destinationTemporary;
  }

  #lowerInteractionPayload(expression: Expression, speakerTemporary: number): LoweredExpression {
    const previous = this.#contextualSpeakerTemporary;
    this.#contextualSpeakerTemporary = speakerTemporary;
    try {
      return this.#lowerExpression(expression);
    } finally {
      this.#contextualSpeakerTemporary = previous;
    }
  }

  #lowerSayPayload(expression: Expression, speakerTemporary: number): LoweredExpression {
    return this.#lowerInteractionPayload(expression, speakerTemporary);
  }

  #lowerInteractionPayloads(
    expressions: readonly Expression[],
    speakerTemporary: number,
  ): LoweredExpression[] {
    const previous = this.#contextualSpeakerTemporary;
    this.#contextualSpeakerTemporary = speakerTemporary;
    try {
      return this.#lowerOrderedExpressions(expressions);
    } finally {
      this.#contextualSpeakerTemporary = previous;
    }
  }

  #materializeDedicatedInteractionValue(
    lowered: LoweredExpression,
    span: SourceSpan,
  ): { readonly temporaryId: number } {
    const temporaryId = this.#allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId,
      value: lowered.plan,
      expectBoolean: false,
      span: copySpan(span),
    });
    this.#emitTemporaryCleanup(lowered.temporaryIds, span);
    return { temporaryId };
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
    materializeInstructionEmitting = false,
  ): LoweredExpression[] {
    const emitsInstructions = expressions.map((expression) =>
      this.#containsUserCall(expression)
    );
    const laterEmitsInstructions = new Array<boolean>(expressions.length);
    let suffixEmitsInstructions = false;
    for (let index = expressions.length - 1; index >= 0; index -= 1) {
      laterEmitsInstructions[index] = suffixEmitsInstructions;
      if (emitsInstructions[index]) suffixEmitsInstructions = true;
    }

    const lowered: LoweredExpression[] = [];
    for (let index = 0; index < expressions.length; index += 1) {
      const expression = expressions[index]!;
      let item = this.#lowerExpression(expression);
      if (
        laterEmitsInstructions[index] ||
        (materializeInstructionEmitting && emitsInstructions[index])
      ) {
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
    const planned: CallArgumentPlan[] = [];
    const loweredArguments = this.#lowerOrderedExpressions(
      expression.arguments.map((argument) => argument.value),
      true,
    );
    expression.arguments.forEach((argument, index) => {
      const lowered = loweredArguments[index]!;
      for (const temporaryId of lowered.temporaryIds) temporaryIds.push(temporaryId);
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
      planned.push({
        parameterName,
        value: lowered.plan,
        span: copySpan(argument.span),
      });
    });
    const destinationTemporary = this.#allocateTemporary();
    const callIndex = this.instructions.length;
    this.instructions.push({
      kind: "callFunction",
      functionId: registered.id,
      arguments: planned,
      destinationTemporary,
      returnInstruction: callIndex + 1,
      span: copySpan(expression.span),
    });
    if (temporaryIds.length > 0) {
      this.instructions.push({
        kind: "clearTemporaries",
        temporaryIds: [...new Set(temporaryIds)],
        span: copySpan(expression.span),
      });
    }
    return {
      plan: {
        kind: "temporary",
        temporaryId: destinationTemporary,
        span: copySpan(expression.span),
      },
      temporaryIds: [destinationTemporary],
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
    const work: Expression[] = [expression];
    while (work.length > 0) {
      const current = work.pop()!;
      if (current.kind === "interactionExpression") return true;
      if (
        current.kind === "callExpression" &&
        current.callee.kind === "identifier" &&
        this.#functionByName.has(current.callee.name)
      ) {
        return true;
      }
      switch (current.kind) {
        case "booleanLiteral":
        case "nullLiteral":
        case "numberLiteral":
        case "stringLiteral":
        case "identifier":
          break;
        case "parenthesizedExpression":
          work.push(current.expression);
          break;
        case "listLiteral":
        case "setLiteral":
          for (const item of current.elements) work.push(item);
          break;
        case "objectLiteral":
          for (const property of current.properties) work.push(property.value);
          break;
        case "templateLiteral":
          for (const part of current.parts) {
            if (part.kind === "templateInterpolation") work.push(part.expression);
          }
          break;
        case "propertyAccessExpression":
          work.push(current.object);
          break;
        case "indexExpression":
          work.push(current.object, current.index);
          break;
        case "callExpression":
          work.push(current.callee);
          for (const argument of current.arguments) work.push(argument.value);
          break;
        case "unaryExpression":
          work.push(current.operand);
          break;
        case "binaryExpression":
          work.push(current.left, current.right);
          break;
        case "rangeExpression":
          work.push(current.start, current.end);
          break;
      }
    }
    return false;
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

function unwrapParentheses(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

function normalizeUnaryExpression(
  expression: Extract<Expression, { kind: "unaryExpression" }>,
): {
  readonly operand: Expression;
  readonly operators: readonly Extract<Expression, { kind: "unaryExpression" }>["operator"][];
} {
  let current: Expression = expression;
  if (expression.operator === "not") {
    let count = 0;
    while (true) {
      current = unwrapParentheses(current);
      if (current.kind !== "unaryExpression" || current.operator !== "not") break;
      count += 1;
      current = current.operand;
    }
    return {
      operand: current,
      operators: count % 2 === 0 ? ["not", "not"] : ["not"],
    };
  }

  let negate = false;
  while (true) {
    current = unwrapParentheses(current);
    if (
      current.kind !== "unaryExpression" ||
      (current.operator !== "+" && current.operator !== "-")
    ) break;
    if (current.operator === "-") negate = !negate;
    current = current.operand;
  }
  return { operand: current, operators: [negate ? "-" : "+"] };
}

function compileExpression(expression: Expression): ExpressionPlan {
  expression = unwrapParentheses(expression);
  switch (expression.kind) {
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
    case "stringLiteral":
      return { kind: "literal", value: expression.value, span: copySpan(expression.span) };
    case "identifier":
      return { kind: "identifier", name: expression.name, span: copySpan(expression.span) };
    case "parenthesizedExpression":
      return compileExpression(expression.expression);
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
    case "unaryExpression": {
      const normalized = normalizeUnaryExpression(expression);
      let plan = compileExpression(normalized.operand);
      for (let index = normalized.operators.length - 1; index >= 0; index -= 1) {
        plan = {
          kind: "unary",
          operator: normalized.operators[index]!,
          operand: plan,
          span: copySpan(expression.span),
        };
      }
      return plan;
    }
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
    case "interactionExpression":
      throw new TypeError("Blocking interactions must be lowered before expression-plan compilation.");
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


function interactionLabelType(expression: InteractionExpression): "none" | "identifier" | "number" {
  const label = expression.options[0]?.label;
  return label === undefined || label === null
    ? "none"
    : label.kind === "identifier"
      ? "identifier"
      : "number";
}

function interactionLabelValue(label: NonNullable<InteractionExpression["options"][number]["label"]>): string | number {
  return label.kind === "identifier"
    ? label.name
    : Object.is(label.value, -0) ? 0 : label.value;
}

function staticInteractionUi(
  expression: InteractionExpression,
  staticValues: readonly string[],
  labelType: "none" | "identifier" | "number",
): InteractionUiPayload {
  if (expression.interactionKind === "text" || expression.interactionKind === "number") {
    return {
      kind: expression.interactionKind,
      hint: staticValues[0] ?? null,
      accessibleName: {
        kind: "localizedDefault",
        key: expression.interactionKind === "text" ? "answer" : "number",
      },
    };
  }
  return {
    kind: "choice",
    labelType,
    options: expression.options.map((option, index) => ({
      text: staticValues[index]!,
      label: option.label === null ? null : interactionLabelValue(option.label),
    })),
    accessibleName: { kind: "localizedDefault", key: "chooseOption" },
  };
}

function staticVisibleText(expression: Expression): string | undefined {
  switch (expression.kind) {
    case "stringLiteral":
      return expression.value;
    case "numberLiteral":
      return Number.isFinite(expression.value)
        ? String(Object.is(expression.value, -0) ? 0 : expression.value)
        : undefined;
    case "booleanLiteral":
      return expression.value ? "true" : "false";
    case "nullLiteral":
      return "null";
    case "parenthesizedExpression":
      return staticVisibleText(expression.expression);
    case "unaryExpression":
    case "binaryExpression": {
      const value = staticNumber(expression);
      return value !== undefined && Number.isFinite(value)
        ? String(Object.is(value, -0) ? 0 : value)
        : undefined;
    }
    case "templateLiteral": {
      const parts: string[] = [];
      for (const part of expression.parts) {
        if (part.kind === "templateText") {
          parts.push(part.value);
          continue;
        }
        const value = staticVisibleText(part.expression);
        if (value === undefined) return undefined;
        parts.push(value);
      }
      return parts.join("");
    }
    default:
      return undefined;
  }
}

function staticNumber(expression: Expression): number | undefined {
  if (expression.kind === "numberLiteral") return expression.value;
  if (expression.kind === "parenthesizedExpression") return staticNumber(expression.expression);
  if (expression.kind === "unaryExpression" && (expression.operator === "+" || expression.operator === "-")) {
    const value = staticNumber(expression.operand);
    return value === undefined ? undefined : expression.operator === "+" ? value : -value;
  }
  if (expression.kind !== "binaryExpression") return undefined;
  const left = staticNumber(expression.left);
  const right = staticNumber(expression.right);
  if (left === undefined || right === undefined) return undefined;
  switch (expression.operator) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return right === 0 ? undefined : left / right;
    case "%": return right === 0 ? undefined : left % right;
    default: return undefined;
  }
}

function copySpan(span: SourceSpan): PlanSourceLocation {
  return sourceSpanToPlanLocation(span);
}
