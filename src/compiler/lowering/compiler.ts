import type {
  Block,
  Expression,
  FunctionDeclaration,
  ListLiteral,
  ObjectLiteral,
  SetLiteral,
  Statement,
  InteractionExpression,
  ShowButtonStatement,
} from "../../ast.js";
import type { SourceSpan } from "../../source.js";
import { InstructionCompilationError } from "../errors.js";
import type {
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
import { staticVisibleText } from "../../static-evaluation.js";
import { runCompileTask, compileChild, type CompileTask } from "../continuation.js";
import { expressionChildren as instructionEmissionChildren } from "../../expression-children.js";

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

  readonly #instructionEmissionByExpression = new WeakMap<Expression, boolean>();

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
    runCompileTask(this.#compileStatements(statements));
  }

  *#compileStatements(statements: readonly Statement[]): CompileTask<void> {
    for (const statement of statements) yield* compileChild(this.#compileStatement(statement));
  }

  *#compileStatement(statement: Statement): CompileTask<void> {
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
      case "sayStatement": {
        const textCanSuspend = this.#containsUserCall(statement.value);
        const pacingCanSuspend =
          statement.pacing !== null &&
          statement.pacing !== "instant" &&
          this.#containsUserCall(statement.pacing);
        if (!textCanSuspend && !pacingCanSuspend) {
          const lowered = this.#lowerExpression(statement.value);
          const loweredPacing =
            statement.pacing === null || statement.pacing === "instant"
              ? null
              : this.#lowerExpression(statement.pacing);
          this.instructions.push({
            kind: "say",
            speaker: statement.speaker?.name ?? null,
            value: lowered.plan,
            skipPolicy: statement.skipPolicy,
            pacing:
              statement.pacing === null
                ? "smart"
                : loweredPacing === null
                  ? "instant"
                  : loweredPacing.plan,
            span: copySpan(statement.span),
          });
          this.#emitTemporaryCleanup(
            [...lowered.temporaryIds, ...(loweredPacing?.temporaryIds ?? [])],
            statement.span,
          );
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
          const loweredPacing =
            statement.pacing === null || statement.pacing === "instant"
              ? null
              : this.#lowerSayPayload(statement.pacing, contextualSpeakerTemporary);
          this.instructions.push({
            kind: "say",
            speaker: statement.speaker?.name ?? null,
            value: lowered.plan,
            speakerTemporary,
            contextualSpeakerTemporary,
            skipPolicy: statement.skipPolicy,
            pacing:
              statement.pacing === null
                ? "smart"
                : loweredPacing === null
                  ? "instant"
                  : loweredPacing.plan,
            span: copySpan(statement.span),
          });
          this.#emitTemporaryCleanup(
            [
              speakerTemporary,
              contextualSpeakerTemporary,
              ...lowered.temporaryIds,
              ...(loweredPacing?.temporaryIds ?? []),
            ],
            statement.span,
          );
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
        this.#emitTemporaryCleanup(
          [
            speakerTemporary,
            contextualSpeakerTemporary,
            textTemporary,
            ...(loweredPacing?.temporaryIds ?? []),
          ],
          statement.span,
        );
        return;
      }
      case "showButtonStatement":
        this.#compileShowButton(statement);
        return;
      case "waitStatement": {
        const lowered = this.#lowerExpression(statement.duration);
        this.instructions.push({
          kind: "wait",
          duration: lowered.plan,
          unit: statement.unit,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "exitStatement":
        this.instructions.push({ kind: "exit", span: copySpan(statement.span) });
        return;
      case "letStatement": {
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
      case "assignmentStatement": {
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
        this.#emitTemporaryCleanup([...target.temporaryIds, ...value.temporaryIds], statement.span);
        return;
      }
      case "expressionStatement": {
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
        yield* compileChild(this.#compileIf(statement));
        return;
      case "repeatStatement":
        yield* compileChild(
          this.#compileLoop("repeat", statement.count, statement.body, null, statement.span),
        );
        return;
      case "forStatement":
        yield* compileChild(
          this.#compileLoop(
            "for",
            statement.iterable,
            statement.body,
            statement.variable.name,
            statement.span,
          ),
        );
        return;
      case "whileStatement":
        yield* compileChild(
          this.#compileLoop("while", statement.condition, statement.body, null, statement.span),
        );
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
          target: statement.kind === "breakStatement" ? -1 : loop.continueTarget,
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
    statement satisfies never;
  }

  *#compileIf(statement: Extract<Statement, { kind: "ifStatement" }>): CompileTask<void> {
    const lowered = this.#lowerExpression(statement.condition);
    const conditional = this.instructions.length;
    const conditionalInstruction: JumpIfFalseInstruction = {
      kind: "jumpIfFalse",
      condition: lowered.plan,
      target: -1,
      span: copySpan(statement.condition.span),
    };
    this.instructions.push(conditionalInstruction);
    this.#emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
    yield* compileChild(this.#compileBlock(statement.thenBlock));
    if (statement.elseBlock === null) {
      const falseCleanup = this.instructions.length;
      this.instructions[conditional] = { ...conditionalInstruction, target: falseCleanup };
      this.#emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
      return;
    }

    const jump = this.instructions.length;
    const jumpInstruction: JumpInstruction = {
      kind: "jump",
      target: -1,
      span: copySpan(statement.span),
    };
    this.instructions.push(jumpInstruction);
    const falseCleanup = this.instructions.length;
    this.instructions[conditional] = { ...conditionalInstruction, target: falseCleanup };
    this.#emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
    if (statement.elseBlock.kind === "ifStatement") {
      yield* compileChild(this.#compileIf(statement.elseBlock));
    } else {
      yield* compileChild(this.#compileBlock(statement.elseBlock));
    }
    this.instructions[jump] = { ...jumpInstruction, target: this.instructions.length };
  }

  *#compileBlock(block: Block): CompileTask<void> {
    this.instructions.push({ kind: "enterScope", span: copySpan(block.span) });
    yield* compileChild(this.#compileStatements(block.statements));
    this.instructions.push({ kind: "leaveScope", span: copySpan(block.span) });
  }

  *#compileLoop(
    loopKind: "repeat" | "for" | "while",
    expression: Expression,
    body: Block,
    variable: string | null,
    span: SourceSpan,
  ): CompileTask<void> {
    const loopId = this.#nextLoopId;
    this.#nextLoopId += 1;
    const continueTarget = this.instructions.length;
    const lowered = this.#lowerExpression(expression);
    const start = this.instructions.length;
    const loopContinueTarget = loopKind === "while" ? continueTarget : start;
    const instruction: LoopStartInstruction =
      loopKind === "for"
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
    const breaks: number[] = [];
    const context = { loopId, continueTarget: instruction.continueTarget, breaks };
    this.#loops.push(context);
    yield* compileChild(this.#compileStatements(body.statements));
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
      // EVIDENCE: break indices are recorded only when emitting loopControl instructions above.
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
      const prepareInstruction: PrepareParameterDefaultInstruction = {
        kind: "prepareParameterDefault",
        functionId: registered.id,
        parameterIndex,
        target: -1,
        span: copySpan(parameter.span),
      };
      this.instructions.push(prepareInstruction);
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
      this.instructions[prepareIndex] = { ...prepareInstruction, target: this.instructions.length };
    });
    this.instructions.push({
      kind: "enterFunctionBody",
      functionId: registered.id,
      span: copySpan(declaration.body.span),
    });
    const bodyEntryInstruction = this.instructions.length;
    this.compileStatements(declaration.body.statements);
    const implicitReturnInstruction = this.instructions.length;
    this.instructions.push({ kind: "returnVoid", span: copySpan(declaration.body.span) });
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
        defaultSpan: parameter.defaultValue === null ? null : copySpan(parameter.defaultValue.span),
      })),
      entryInstruction,
      bodyEntryInstruction,
      implicitReturnInstruction,
      endInstruction,
      bodySpan: copySpan(declaration.body.span),
    });
  }

  #lowerExpression(expression: Expression): LoweredExpression {
    return runCompileTask(this.#lowerExpressionTask(expression));
  }

  *#lowerExpressionTask(expression: Expression): CompileTask<LoweredExpression> {
    expression = unwrapParentheses(expression);
    if (this.#contextualSpeakerTemporary === null && !this.#containsUserCall(expression))
      return { plan: compileExpression(expression), temporaryIds: [] };
    if (expression.kind === "interactionExpression") {
      return yield* compileChild(this.#lowerInteractionTask(expression));
    }
    if (
      expression.kind === "callExpression" &&
      expression.callee.kind === "identifier" &&
      this.#functionByName.has(expression.callee.name)
    ) {
      return yield* compileChild(this.#lowerUserFunctionCallTask(expression));
    }
    if (
      expression.kind === "binaryExpression" &&
      (expression.operator === "and" || expression.operator === "or") &&
      this.#containsUserCall(expression)
    ) {
      return yield* compileChild(this.#lowerLogicalExpressionTask(expression));
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
        return { plan: compileExpression(expression), temporaryIds: [] };
      case "stringLiteral": {
        const interpolations = expression.parts
          .filter((part) => part.kind === "stringInterpolation")
          .map((part) => part.expression);
        if (interpolations.length === 0) {
          return { plan: compileExpression(expression), temporaryIds: [] };
        }
        const ids: number[] = [];
        const loweredInterpolations = yield* compileChild(
          this.#lowerOrderedExpressionsTask(interpolations),
        );
        let interpolationIndex = 0;
        const parts = expression.parts.flatMap((part): TemplatePartPlan[] => {
          if (part.kind === "stringText") {
            return part.value.length === 0
              ? []
              : [{ kind: "text", value: part.value, span: copySpan(part.span) }];
          }
          const lowered = loweredInterpolations[interpolationIndex++]!;
          for (const temporaryId of lowered.temporaryIds) ids.push(temporaryId);
          return [{ kind: "expression", expression: lowered.plan, span: copySpan(part.span) }];
        });
        return {
          plan: { kind: "template", parts, span: copySpan(expression.span) },
          temporaryIds: ids,
        };
      }
      case "identifier":
        if (expression.name === "speaker" && this.#contextualSpeakerTemporary !== null) {
          return {
            plan: {
              kind: "temporary",
              temporaryId: this.#contextualSpeakerTemporary,
              span: copySpan(expression.span),
            },
            temporaryIds: [],
          };
        }
        return { plan: compileExpression(expression), temporaryIds: [] };
      case "parenthesizedExpression":
        return yield* compileChild(this.#lowerExpressionTask(expression.expression));
      case "listLiteral":
      case "setLiteral":
        return yield* compileChild(this.#lowerCollectionExpressionTask(expression));
      case "objectLiteral":
        return yield* compileChild(this.#lowerCollectionExpressionTask(expression));
      case "propertyAccessExpression": {
        const object = yield* compileChild(this.#lowerExpressionTask(expression.object));
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
      case "indexExpression": {
        let object = yield* compileChild(this.#lowerExpressionTask(expression.object));
        if (this.#containsUserCall(expression.index)) {
          object = this.#prepareReferenceExpression(object, expression.object.span);
        }
        const index = yield* compileChild(this.#lowerExpressionTask(expression.index));
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
      case "callExpression": {
        let callee: LoweredExpression;
        if (expression.callee.kind === "propertyAccessExpression") {
          let receiver = yield* compileChild(this.#lowerExpressionTask(expression.callee.object));
          if (expression.arguments.some((argument) => this.#containsUserCall(argument.value))) {
            receiver = this.#prepareReferenceExpression(receiver, expression.callee.object.span);
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
          callee = yield* compileChild(this.#lowerExpressionTask(expression.callee));
        }
        const loweredArguments = yield* compileChild(
          this.#lowerOrderedExpressionsTask(expression.arguments.map((argument) => argument.value)),
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
                : {
                    kind: "named",
                    name: argument.name.name,
                    value: lowered.plan,
                    span: copySpan(argument.span),
                  },
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
        const operand = yield* compileChild(this.#lowerExpressionTask(normalized.operand));
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
        const leftExpression = expression.left;
        const rightExpression = expression.right;
        if (
          this.#contextualSpeakerTemporary === null &&
          !this.#containsUserCall(leftExpression) &&
          !this.#containsUserCall(rightExpression)
        ) {
          return { plan: compileExpression(expression), temporaryIds: [] };
        }
        const [left, right] = yield* compileChild(
          this.#lowerOrderedExpressionsTask([leftExpression, rightExpression]),
        );
        return {
          plan: {
            kind: "binary",
            operator: expression.operator,
            left: left!.plan,
            right: right!.plan,
            span: copySpan(expression.span),
          },
          temporaryIds: [...left!.temporaryIds, ...right!.temporaryIds],
        };
      }
      case "rangeExpression": {
        const [start, end] = yield* compileChild(
          this.#lowerOrderedExpressionsTask([expression.start, expression.end]),
        );
        return {
          plan: {
            kind: "range",
            start: start!.plan,
            end: end!.plan,
            inclusive: expression.inclusive,
            span: copySpan(expression.span),
          },
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

  *#lowerInteractionTask(expression: InteractionExpression): CompileTask<LoweredExpression> {
    const values =
      expression.interactionKind === "choice"
        ? expression.options.map((option) => option.value)
        : expression.hint === null
          ? []
          : [expression.hint];
    const staticValues = values.map(staticVisibleText);
    const labelType = interactionLabelType(expression);
    const expectedResult =
      expression.interactionKind === "number" ||
      (expression.interactionKind === "choice" && labelType === "number")
        ? ("number" as const)
        : ("string" as const);

    if (staticValues.every((value): value is string => value !== undefined)) {
      const ui = staticInteractionUi(expression, staticValues, labelType);
      return this.#emitResultInteraction(
        {
          interactionKind: expression.interactionKind,
          target: "standardChat",
          speaker: expression.speaker?.name ?? null,
          expectedResult,
          ui,
          span: copySpan(expression.span),
        },
        expression.span,
      );
    }

    const speakerTemporary = this.#prepareInteractionSpeaker(
      expression.speaker?.name ?? null,
      expression.asSpan ?? expression.commandSpan,
    );
    let preparedUi: PreparedInteractionUiPayload;
    const preparedTemporaryIds: number[] = [speakerTemporary];

    if (expression.interactionKind === "text" || expression.interactionKind === "number") {
      const hint =
        expression.hint === null
          ? null
          : this.#materializeDedicatedInteractionValue(
              yield* compileChild(
                this.#lowerInteractionPayloadTask(expression.hint, speakerTemporary),
              ),
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
      const loweredValues = yield* compileChild(
        this.#lowerInteractionPayloadsTask(values, speakerTemporary),
      );
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
        labels:
          labelType === "none"
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
    instruction: Omit<
      Extract<
        import("../../plan/model.js").InteractionInstruction,
        { readonly ui: InteractionUiPayload }
      >,
      "kind" | "destinationTemporary"
    >,
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
    return runCompileTask(this.#lowerInteractionPayloadTask(expression, speakerTemporary));
  }

  *#lowerInteractionPayloadTask(
    expression: Expression,
    speakerTemporary: number,
  ): CompileTask<LoweredExpression> {
    const previous = this.#contextualSpeakerTemporary;
    this.#contextualSpeakerTemporary = speakerTemporary;
    try {
      return yield* compileChild(this.#lowerExpressionTask(expression));
    } finally {
      this.#contextualSpeakerTemporary = previous;
    }
  }

  #lowerSayPayload(expression: Expression, speakerTemporary: number): LoweredExpression {
    return this.#lowerInteractionPayload(expression, speakerTemporary);
  }

  *#lowerInteractionPayloadsTask(
    expressions: readonly Expression[],
    speakerTemporary: number,
  ): CompileTask<LoweredExpression[]> {
    const previous = this.#contextualSpeakerTemporary;
    this.#contextualSpeakerTemporary = speakerTemporary;
    try {
      return yield* compileChild(this.#lowerOrderedExpressionsTask(expressions));
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

  #materializeExpression(lowered: LoweredExpression, span: SourceSpan): LoweredExpression {
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

  #prepareReferenceExpression(lowered: LoweredExpression, span: SourceSpan): LoweredExpression {
    if (lowered.plan.kind === "preparedReference") return lowered;
    const temporaryId = this.#allocateTemporary();
    this.instructions.push({
      kind: "prepareReference",
      expression: lowered.plan,
      destinationTemporary: temporaryId,
      span: copySpan(span),
    });
    return {
      plan: { kind: "preparedReference", temporaryId, span: copySpan(span) },
      temporaryIds: [...lowered.temporaryIds, temporaryId],
    };
  }

  *#lowerOrderedExpressionsTask(
    expressions: readonly Expression[],
    materializeInstructionEmitting = false,
  ): CompileTask<LoweredExpression[]> {
    const emitsInstructions = expressions.map((expression) => this.#containsUserCall(expression));
    const laterEmitsInstructions = new Array<boolean>(expressions.length);
    let suffixEmitsInstructions = false;
    for (let index = expressions.length - 1; index >= 0; index -= 1) {
      laterEmitsInstructions[index] = suffixEmitsInstructions;
      if (emitsInstructions[index]) suffixEmitsInstructions = true;
    }

    const lowered: LoweredExpression[] = [];
    for (let index = 0; index < expressions.length; index += 1) {
      const expression = expressions[index]!;
      let item = yield* compileChild(this.#lowerExpressionTask(expression));
      if (
        laterEmitsInstructions[index] ||
        (materializeInstructionEmitting && emitsInstructions[index])
      ) {
        item =
          item.plan.kind === "temporary"
            ? item
            : this.#materializeExpression(item, expression.span);
      }
      lowered.push(item);
    }
    return lowered;
  }

  *#lowerCollectionExpressionTask(
    root: ListLiteral | SetLiteral | ObjectLiteral,
  ): CompileTask<LoweredExpression> {
    const children =
      root.kind === "objectLiteral"
        ? root.properties.map((property) => property.value)
        : root.elements;
    const elements = yield* compileChild(this.#lowerOrderedExpressionsTask(children));
    return {
      plan:
        root.kind === "objectLiteral"
          ? {
              kind: "object",
              properties: root.properties.map((property, index) => ({
                name: property.name.name,
                value: elements[index]!.plan,
                span: copySpan(property.span),
              })),
              span: copySpan(root.span),
            }
          : {
              kind: root.kind === "listLiteral" ? "list" : "set",
              elements: elements.map((item) => item.plan),
              span: copySpan(root.span),
            },
      temporaryIds: elements.flatMap((item) => item.temporaryIds),
    };
  }

  *#lowerUserFunctionCallTask(
    expression: Extract<Expression, { kind: "callExpression" }>,
  ): CompileTask<LoweredExpression> {
    // EVIDENCE: invariant: the caller selects this path only for a registered identifier callee.
    const name = (expression.callee as Extract<Expression, { kind: "identifier" }>).name;
    const registered = this.#functionByName.get(name)!;
    const temporaryIds: number[] = [];
    const planned: CallArgumentPlan[] = [];
    const loweredArguments = yield* compileChild(
      this.#lowerOrderedExpressionsTask(
        expression.arguments.map((argument) => argument.value),
        true,
      ),
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
      planned.push({ parameterName, value: lowered.plan, span: copySpan(argument.span) });
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

  *#lowerLogicalExpressionTask(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
  ): CompileTask<LoweredExpression> {
    const left = yield* compileChild(this.#lowerExpressionTask(expression.left));
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
      const conditionalInstruction: JumpIfFalseInstruction = {
        kind: "jumpIfFalse",
        condition,
        target: -1,
        span: copySpan(expression.span),
      };
      this.instructions.push(conditionalInstruction);
      const right = yield* compileChild(this.#lowerExpressionTask(expression.right));
      this.instructions.push({
        kind: "storeTemporary",
        temporaryId: resultTemporary,
        value: right.plan,
        expectBoolean: true,
        span: copySpan(expression.right.span),
      });
      this.instructions[conditional] = {
        ...conditionalInstruction,
        target: this.instructions.length,
      };
      return {
        plan: { ...condition, span: copySpan(expression.span) },
        temporaryIds: [...left.temporaryIds, ...right.temporaryIds, resultTemporary],
      };
    }
    const conditional = this.instructions.length;
    const conditionalInstruction: JumpIfFalseInstruction = {
      kind: "jumpIfFalse",
      condition,
      target: -1,
      span: copySpan(expression.span),
    };
    this.instructions.push(conditionalInstruction);
    const skipRight = this.instructions.length;
    const skipRightInstruction: JumpInstruction = {
      kind: "jump",
      target: -1,
      span: copySpan(expression.span),
    };
    this.instructions.push(skipRightInstruction);
    this.instructions[conditional] = {
      ...conditionalInstruction,
      target: this.instructions.length,
    };
    const right = yield* compileChild(this.#lowerExpressionTask(expression.right));
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: right.plan,
      expectBoolean: true,
      span: copySpan(expression.right.span),
    });
    this.instructions[skipRight] = { ...skipRightInstruction, target: this.instructions.length };
    return {
      plan: { ...condition, span: copySpan(expression.span) },
      temporaryIds: [...left.temporaryIds, ...right.temporaryIds, resultTemporary],
    };
  }

  #containsUserCall(expression: Expression): boolean {
    const cached = this.#instructionEmissionByExpression.get(expression);
    if (cached !== undefined) return cached;

    const work: Array<
      | { readonly expression: Expression; readonly children: null }
      | { readonly expression: Expression; readonly children: readonly Expression[] }
    > = [{ expression, children: null }];
    while (work.length > 0) {
      const current = work.pop()!;
      if (this.#instructionEmissionByExpression.has(current.expression)) continue;

      if (current.children !== null) {
        this.#instructionEmissionByExpression.set(
          current.expression,
          current.children.some(
            (child) => this.#instructionEmissionByExpression.get(child) === true,
          ),
        );
        continue;
      }

      if (current.expression.kind === "interactionExpression") {
        this.#instructionEmissionByExpression.set(current.expression, true);
        continue;
      }
      if (
        current.expression.kind === "callExpression" &&
        current.expression.callee.kind === "identifier" &&
        this.#functionByName.has(current.expression.callee.name)
      ) {
        this.#instructionEmissionByExpression.set(current.expression, true);
        continue;
      }

      const children = instructionEmissionChildren(current.expression);
      work.push({ expression: current.expression, children });
      for (const child of children) {
        if (!this.#instructionEmissionByExpression.has(child)) {
          work.push({ expression: child, children: null });
        }
      }
    }
    return this.#instructionEmissionByExpression.get(expression)!;
  }

  #allocateTemporary(): number {
    const id = this.#nextTemporaryId;
    this.#nextTemporaryId += 1;
    return id;
  }

  #emitTemporaryCleanup(ids: readonly number[], span: SourceSpan): void {
    for (const temporaryId of new Set(ids)) {
      this.instructions.push({ kind: "clearTemporary", temporaryId, span: copySpan(span) });
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

function normalizeUnaryExpression(expression: Extract<Expression, { kind: "unaryExpression" }>): {
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
    return { operand: current, operators: count % 2 === 0 ? ["not", "not"] : ["not"] };
  }

  let negate = false;
  while (true) {
    current = unwrapParentheses(current);
    if (
      current.kind !== "unaryExpression" ||
      (current.operator !== "+" && current.operator !== "-")
    )
      break;
    if (current.operator === "-") negate = !negate;
    current = current.operand;
  }
  return { operand: current, operators: [negate ? "-" : "+"] };
}

function compileExpression(expression: Expression): ExpressionPlan {
  const plans = new WeakMap<Expression, ExpressionPlan>();
  const work: { expression: Expression; expanded: boolean }[] = [{ expression, expanded: false }];
  while (work.length) {
    const frame = work.pop()!;
    const current = unwrapParentheses(frame.expression);
    if (frame.expanded) {
      plans.set(current, assembleExpression(current, child));
      continue;
    }
    if (plans.has(current)) continue;
    work.push({ expression: current, expanded: true });
    const children =
      current.kind === "unaryExpression"
        ? [normalizeUnaryExpression(current).operand]
        : instructionEmissionChildren(current);
    for (let i = children.length - 1; i >= 0; i--)
      work.push({ expression: children[i]!, expanded: false });
  }
  return child(expression);
  function child(expression: Expression): ExpressionPlan {
    return plans.get(unwrapParentheses(expression))!;
  }
}

function interactionLabelType(expression: InteractionExpression): "none" | "identifier" | "number" {
  const label = expression.options[0]?.label;
  return label === undefined || label === null
    ? "none"
    : label.kind === "identifier"
      ? "identifier"
      : "number";
}

function interactionLabelValue(
  label: NonNullable<InteractionExpression["options"][number]["label"]>,
): string | number {
  return label.kind === "identifier" ? label.name : Object.is(label.value, -0) ? 0 : label.value;
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

function copySpan(span: SourceSpan): PlanSourceLocation {
  return sourceSpanToPlanLocation(span);
}

function assembleExpression(
  expression: Expression,
  child: (expression: Expression) => ExpressionPlan,
): ExpressionPlan {
  switch (expression.kind) {
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
      return { kind: "literal", value: expression.value, span: copySpan(expression.span) };
    case "stringLiteral":
      return expression.parts.some((part) => part.kind === "stringInterpolation")
        ? {
            kind: "template",
            parts: expression.parts.flatMap((part): TemplatePartPlan[] =>
              part.kind === "stringText"
                ? part.value.length === 0
                  ? []
                  : [{ kind: "text", value: part.value, span: copySpan(part.span) }]
                : [
                    {
                      kind: "expression",
                      expression: child(part.expression),
                      span: copySpan(part.span),
                    },
                  ],
            ),
            span: copySpan(expression.span),
          }
        : {
            kind: "literal",
            value: expression.parts
              .map((part) => (part.kind === "stringText" ? part.value : ""))
              .join(""),
            span: copySpan(expression.span),
          };
    case "identifier":
      return { kind: "identifier", name: expression.name, span: copySpan(expression.span) };
    case "parenthesizedExpression":
      return child(expression.expression);
    case "listLiteral":
    case "setLiteral":
      return {
        kind: expression.kind === "setLiteral" ? "set" : "list",
        elements: expression.elements.map(child),
        span: copySpan(expression.span),
      };
    case "objectLiteral":
      return {
        kind: "object",
        properties: expression.properties.map((property) => ({
          name: property.name.name,
          value: child(property.value),
          span: copySpan(property.span),
        })),
        span: copySpan(expression.span),
      };
    case "propertyAccessExpression":
      return {
        kind: "property",
        object: child(expression.object),
        name: expression.property.name,
        span: copySpan(expression.span),
      };
    case "indexExpression":
      return {
        kind: "index",
        object: child(expression.object),
        index: child(expression.index),
        span: copySpan(expression.span),
      };
    case "callExpression":
      return {
        kind: "call",
        callee: child(expression.callee),
        arguments: expression.arguments.map((argument) =>
          argument.kind === "positionalArgument"
            ? { kind: "positional", value: child(argument.value), span: copySpan(argument.span) }
            : {
                kind: "named",
                name: argument.name.name,
                value: child(argument.value),
                span: copySpan(argument.span),
              },
        ),
        span: copySpan(expression.span),
      };
    case "unaryExpression": {
      const normalized = normalizeUnaryExpression(expression);
      let plan = child(normalized.operand);
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
        left: child(expression.left),
        right: child(expression.right),
        span: copySpan(expression.span),
      };
    case "rangeExpression":
      return {
        kind: "range",
        start: child(expression.start),
        end: child(expression.end),
        inclusive: expression.inclusive,
        span: copySpan(expression.span),
      };
    case "interactionExpression":
      throw new TypeError(
        "Blocking interactions must be lowered before expression-plan compilation.",
      );
  }
}
