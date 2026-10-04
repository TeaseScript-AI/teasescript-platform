import type {
  Block,
  Expression,
  TimerParts,
  MediaParts,
  FunctionDeclaration,
  ListLiteral,
  ObjectLiteral,
  SetLiteral,
  Statement,
  InteractionExpression,
  ShowButtonParts,
  SwitchCase,
  SwitchStatement,
  TagQueryExpression,
  TypeTestExpression,
} from "../../ast.js";
import { createSourceSpan, type SourceSpan } from "../../source.js";
import { InstructionCompilationError } from "../errors.js";
import type {
  AssignmentTargetPlan,
  CompiledFunctionDefinition,
  ExpressionPlan,
  DelayDisplay,
  Instruction,
  JumpIfFalseInstruction,
  MediaCuePlan,
  JumpInstruction,
  LoopControlInstruction,
  LoopStartInstruction,
  PrepareParameterDefaultInstruction,
  CallArgumentPlan,
  TemplatePartPlan,
  TemporaryExpressionPlan,
  InteractionChoiceOption,
  InteractionKind,
  InteractionResultDomain,
  TypeCheckPlan,
  InteractionUiPayload,
  PreparedInteractionUiPayload,
  PlanSourceLocation,
  PlanLabel,
  TagQueryExpressionPlan,
} from "../../plan/model.js";
import { sourceSpanToPlanLocation } from "../../plan/source-location.js";
import { numberAnswerText } from "../../interaction-answers.js";
import { staticChoiceValue, staticVisibleText } from "../../static-evaluation.js";
import { durationLiteralParts, storedDuration } from "../../duration.js";
import type { RuntimeCheckSite } from "../../type-checker.js";
import { typeFromAnnotation } from "../../static-types.js";
import { typePlan } from "../../type-plans.js";
import { runCompileTask, compileChild, type CompileTask } from "../continuation.js";
import {
  expressionChildren as instructionEmissionChildren,
  mediaOperands,
  showButtonOptions,
  tagQueryOperands,
} from "../../expression-children.js";

/** Plan-wide numbering shared by the compilers of a project's files: loop and temporary IDs are unique in a plan. */
export interface LoweringCounters {
  nextLoopId: number;
  nextTemporaryId: number;
}

export class InstructionCompiler {
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

  #contextualSpeakerTemporary: number | null = null;

  /** The labels of the file's root region, in source order. */
  public readonly labels: PlanLabel[] = [];

  /** Gotos whose target is set by {@link resolveGotos} once every label of the file has its instruction. */
  readonly #gotos: { readonly instruction: number; readonly label: string }[] = [];

  /** Functions of earlier files come first, so this file's IDs continue after theirs. */
  readonly #functionIdBase: number;

  /**
   * Compiles one file. The files of a project share `instructions`, `functions`, and `counters`, and each compiles
   * its root statements and then its functions before the next file starts.
   */
  public constructor(
    private readonly declarations: readonly FunctionDeclaration[],
    private readonly typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> = new Map(),
    public readonly instructions: Instruction[] = [],
    public readonly functions: CompiledFunctionDefinition[] = [],
    private readonly counters: LoweringCounters = { nextLoopId: 1, nextTemporaryId: 1 },
  ) {
    this.#functionIdBase = functions.length;
    this.#functionByName = new Map(
      declarations.map((declaration, index) => [
        declaration.name.name,
        { id: this.#functionIdBase + index + 1, declaration },
      ]),
    );
  }

  public resolveGotos(): void {
    for (const { instruction, label } of this.#gotos) {
      const target = this.labels.find((candidate) => candidate.name === label);
      const goto = this.instructions[instruction];
      if (target === undefined || goto?.kind !== "goto") {
        throw new TypeError("Semantically invalid goto reached compilation.");
      }
      this.instructions[instruction] = { ...goto, target: target.instruction };
    }
  }

  public compileFunctions(): void {
    for (const declaration of this.declarations) {
      this.#compileFunction(declaration);
    }
    // Handlers found while compiling a handler are appended and compiled in ID order.
    for (let index = 0; index < this.#handlers.length; index += 1) {
      this.#compileHandler(
        this.#handlers[index]!,
        this.#functionIdBase + this.declarations.length + index + 1,
      );
    }
  }

  /** Timer expiry blocks and media cue blocks, compiled after the user functions in registration order. */
  readonly #handlers: {
    readonly block: Block;
    readonly owner: "timer" | "media";
    readonly selfHandle: string | null;
  }[] = [];

  /** A statement-level media control call whose receiver waits at a pacing barrier once it is evaluated. */
  #barrierCall: Expression | null = null;

  /** The `let` name that a media initializer binds in its own blocks. */
  readonly #selfHandleByInitializer = new Map<MediaParts, string>();

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
            value: compileExpression(property.value, this.typeChecks),
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
        const textCanSuspend =
          statement.presentation !== null || this.#containsUserCall(statement.value);
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
            presentation: null,
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
        const loweredPresentation =
          statement.presentation === null
            ? null
            : this.#materializeExpression(
                this.#lowerSayPayload(statement.presentation, contextualSpeakerTemporary),
                statement.presentation.span,
              );
        const lowered = this.#lowerSayPayload(statement.value, contextualSpeakerTemporary);
        if (!pacingCanSuspend) {
          const loweredPacing =
            statement.pacing === null || statement.pacing === "instant"
              ? null
              : this.#lowerSayPayload(statement.pacing, contextualSpeakerTemporary);
          this.instructions.push({
            kind: "say",
            presentation: loweredPresentation?.plan ?? null,
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
              ...(loweredPresentation?.temporaryIds ?? []),
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
          presentation: loweredPresentation?.plan ?? null,
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
            ...(loweredPresentation?.temporaryIds ?? []),
            ...(loweredPacing?.temporaryIds ?? []),
          ],
          statement.span,
        );
        return;
      }
      case "showButtonStatement":
        yield* compileChild(this.#lowerShowButtonTask(statement, false));
        return;
      case "waitStatement": {
        const lowered = this.#lowerExpression(statement.duration);
        this.instructions.push({
          kind: "wait",
          command: "wait",
          duration: lowered.plan,
          unit: statement.unit,
          display: "hidden",
          label: null,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "timerStatement":
        yield* compileChild(this.#lowerTimerTask(statement, false));
        return;
      case "playMediaStatement":
        yield* compileChild(this.#lowerMediaTask(statement, false));
        return;
      case "showImageStatement": {
        this.#emitPacingBarrier(null, statement.span);
        const lowered = this.#lowerExpression(statement.image);
        this.instructions.push({
          kind: "showImage",
          image: lowered.plan,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "hideImageStatement":
        this.#emitPacingBarrier(null, statement.span);
        this.instructions.push({ kind: "showImage", image: null, span: copySpan(statement.span) });
        return;
      case "saveStatement": {
        const [value, key] = runCompileTask(
          this.#lowerOrderedExpressionsTask([statement.value, statement.key]),
        );
        this.instructions.push({
          kind: "storageWrite",
          value: value!.plan,
          key: key!.plan,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup([...value!.temporaryIds, ...key!.temporaryIds], statement.span);
        return;
      }
      case "deleteStatement": {
        const key = this.#lowerExpression(statement.key);
        this.instructions.push({
          kind: "storageWrite",
          value: null,
          key: key.plan,
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(key.temporaryIds, statement.span);
        return;
      }
      case "exitStatement":
        this.instructions.push({ kind: "exit", span: copySpan(statement.span) });
        return;
      case "endStatement":
        this.instructions.push({ kind: "end", span: copySpan(statement.span) });
        return;
      case "labelStatement":
        this.labels.push({ name: statement.name.name, instruction: this.instructions.length });
        return;
      case "gotoStatement":
        this.#gotos.push({ instruction: this.instructions.length, label: statement.label.name });
        this.instructions.push({ kind: "goto", target: -1, span: copySpan(statement.span) });
        return;
      case "letStatement": {
        const initializer = unwrapParentheses(statement.initializer);
        if (initializer.kind === "playMediaExpression") {
          this.#selfHandleByInitializer.set(initializer, statement.name.name);
        }
        const lowered = this.#lowerExpression(statement.initializer);
        this.instructions.push({
          kind: "declareBinding",
          name: statement.name.name,
          value: lowered.plan,
          ...withTypeCheck(this.typeChecks.get(statement)),
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "assignmentStatement": {
        const target = this.#lowerAssignmentTarget(statement.target);
        // The target object is already prepared once; the barrier waits when it holds a media handle.
        if (target.plan.kind === "property" && MEDIA_ASSIGNABLE_PROPERTIES.has(target.plan.name)) {
          this.#emitPacingBarrier(target.plan.object, statement.span);
        }
        if (target.plan.kind !== "identifier") {
          this.instructions.push({
            kind: "validateAssignmentTarget",
            target: target.plan,
            span: copySpan(statement.target.span),
          });
        }
        // A compound assignment reads the current value before any instruction-emitting operand runs.
        const current =
          statement.operator === "=" || !this.#containsUserCall(statement.value)
            ? null
            : this.#materializeExpression(
                { plan: target.plan, temporaryIds: [] },
                statement.target.span,
              );
        const value = this.#lowerExpression(statement.value);
        const assigned: ExpressionPlan =
          statement.operator === "="
            ? value.plan
            : {
                kind: "binary",
                operator: statement.operator === "+=" ? "+" : "-",
                left: current?.plan ?? target.plan,
                right: value.plan,
                span: copySpan(statement.span),
              };
        this.instructions.push({
          kind: "assign",
          target: target.plan,
          value: assigned,
          ...withTypeCheck(this.typeChecks.get(statement)),
          span: copySpan(statement.span),
        });
        this.#emitTemporaryCleanup(
          [...target.temporaryIds, ...(current?.temporaryIds ?? []), ...value.temporaryIds],
          statement.span,
        );
        return;
      }
      case "expressionStatement": {
        const call = unwrapParentheses(statement.expression);
        const method = call.kind === "callExpression" ? unwrapParentheses(call.callee) : call;
        if (
          call.kind === "callExpression" &&
          method.kind === "propertyAccessExpression" &&
          MEDIA_CONTROL_METHODS.has(method.property.name)
        ) {
          this.#barrierCall = call;
        }
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
      case "switchStatement":
        yield* compileChild(this.#compileSwitch(statement));
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
          ...withTypeCheck(this.typeChecks.get(statement)),
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

  /**
   * Evaluates the switched value once into a temporary, then tests the cases in order. The temporary is cleared before
   * any case block runs, so it never stays live across a pause, `return`, `break`, or `continue` in a block.
   */
  *#compileSwitch(statement: SwitchStatement): CompileTask<void> {
    const subject = this.#lowerExpression(statement.subject);
    const subjectTemporary = this.#allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: subjectTemporary,
      value: subject.plan,
      expectBoolean: false,
      span: copySpan(statement.subject.span),
    });
    this.#emitTemporaryCleanup(subject.temporaryIds, statement.subject.span);
    const jumpsToEnd: { readonly index: number; readonly instruction: JumpInstruction }[] = [];
    for (const switchCase of statement.cases) {
      const valuesSpan =
        switchCase.typeTest?.span ??
        createSourceSpan(switchCase.values[0]!.span.start, switchCase.values.at(-1)!.span.end);
      const conditional = this.instructions.length;
      const conditionalInstruction: JumpIfFalseInstruction = {
        kind: "jumpIfFalse",
        condition: this.#caseCondition(switchCase, subjectTemporary, valuesSpan),
        target: -1,
        span: copySpan(valuesSpan),
      };
      this.instructions.push(conditionalInstruction);
      this.#emitTemporaryCleanup([subjectTemporary], valuesSpan);
      yield* compileChild(this.#compileBlock(switchCase.body));
      const jump: JumpInstruction = { kind: "jump", target: -1, span: copySpan(switchCase.span) };
      jumpsToEnd.push({ index: this.instructions.length, instruction: jump });
      this.instructions.push(jump);
      this.instructions[conditional] = {
        ...conditionalInstruction,
        target: this.instructions.length,
      };
    }
    this.#emitTemporaryCleanup([subjectTemporary], statement.subject.span);
    if (statement.defaultBlock !== null) {
      yield* compileChild(this.#compileBlock(statement.defaultBlock));
    }
    const end = this.instructions.length;
    for (const { index, instruction } of jumpsToEnd) {
      this.instructions[index] = { ...instruction, target: end };
    }
  }

  /** `subject == value` for each literal and `subject in range` for each range, or-ed. */
  #caseCondition(
    switchCase: SwitchCase,
    subjectTemporary: number,
    valuesSpan: SourceSpan,
  ): ExpressionPlan {
    if (switchCase.typeTest !== null)
      return typeTestPlan(switchCase.typeTest, {
        kind: "temporary",
        temporaryId: subjectTemporary,
        span: copySpan(valuesSpan),
      });
    const tests = switchCase.values.map((expression): ExpressionPlan => {
      const value = unwrapParentheses(expression);
      const subject = (): ExpressionPlan => ({
        kind: "temporary",
        temporaryId: subjectTemporary,
        span: copySpan(expression.span),
      });
      if (value.kind !== "rangeExpression") {
        return {
          kind: "binary",
          operator: "==",
          left: subject(),
          right: this.#lowerExpression(value).plan,
          span: copySpan(expression.span),
        };
      }
      return {
        kind: "binary",
        operator: "in",
        left: subject(),
        right: this.#lowerExpression(value).plan,
        span: copySpan(expression.span),
      };
    });
    return tests.reduce((left, right): ExpressionPlan => ({
      kind: "binary",
      operator: "or",
      left,
      right,
      span: copySpan(valuesSpan),
    }));
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
    const loopId = this.counters.nextLoopId;
    this.counters.nextLoopId += 1;
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

  /**
   * Lowers a blocking timer to a foreground `wait` delay and an async timer to `startTimer`. The instruction evaluates
   * duration, display, then label; operands written in another order are materialized first in source order.
   */
  *#lowerTimerTask(timer: TimerParts, value: boolean): CompileTask<LoweredExpression | null> {
    const dynamicDisplay = typeof timer.display === "object" ? timer.display : null;
    const operands = [timer.duration, dynamicDisplay, timer.label].filter(
      (operand): operand is Expression => operand !== null,
    );
    const sourceOrder = [...operands].sort(
      (left, right) => left.span.start.offset - right.span.start.offset,
    );
    const reordered = sourceOrder.some((operand, index) => operand !== operands[index]);
    const lowered = yield* compileChild(this.#lowerOrderedExpressionsTask(sourceOrder));
    const planOf = (operand: Expression): LoweredExpression => {
      const item = lowered[sourceOrder.indexOf(operand)]!;
      return reordered && item.plan.kind !== "temporary"
        ? this.#materializeExpression(item, operand.span)
        : item;
    };
    // Materialization must follow source order, so resolve every operand before building the instruction.
    const loweredBySource = sourceOrder.map(planOf);
    const plan = (operand: Expression): ExpressionPlan =>
      loweredBySource[sourceOrder.indexOf(operand)]!.plan;
    const temporaryIds = loweredBySource.flatMap((item) => item.temporaryIds);
    // A display expression in the named form is evaluated after the duration, for blocking and async timers alike.
    const staticDisplay: DelayDisplay =
      typeof timer.display === "string" ? timer.display : "visible";
    const display = dynamicDisplay === null ? staticDisplay : plan(dynamicDisplay);
    if (!timer.async) {
      this.instructions.push({
        kind: "wait",
        command: "timer",
        duration: plan(timer.duration),
        unit: timer.unit,
        display,
        label: timer.label === null ? null : plan(timer.label),
        span: copySpan(timer.span),
      });
      this.#emitTemporaryCleanup(temporaryIds, timer.span);
      return null;
    }
    const destinationTemporary = value ? this.#allocateTemporary() : null;
    this.instructions.push({
      kind: "startTimer",
      duration: plan(timer.duration),
      unit: timer.unit,
      display,
      label: timer.label === null ? null : plan(timer.label),
      repeat: timer.repeat,
      persist: timer.persist,
      handlerFunctionId:
        timer.handler === null ? null : this.#registerHandler(timer.handler, "timer", null),
      destinationTemporary,
      span: copySpan(timer.span),
    });
    this.#emitTemporaryCleanup(temporaryIds, timer.span);
    return destinationTemporary === null
      ? null
      : {
          plan: {
            kind: "temporary",
            temporaryId: destinationTemporary,
            span: copySpan(timer.span),
          },
          temporaryIds: [destinationTemporary],
        };
  }

  /**
   * Lowers a play command. A pacing barrier comes first, so main-story media waits for the previous message's
   * pacing; operands then evaluate in source order.
   */
  *#lowerMediaTask(media: MediaParts, value: boolean): CompileTask<LoweredExpression | null> {
    this.#emitPacingBarrier(null, media.span);
    const repeatOperand =
      media.repeat === null || media.repeat.kind === "indefinite"
        ? null
        : media.repeat.kind === "times"
          ? media.repeat.count
          : media.repeat.value;
    const cues = media.handlers?.kind === "cues" ? media.handlers.cues : [];
    // The instruction's evaluation order; `mediaOperands` gives the source order.
    const operands = [
      media.file,
      repeatOperand,
      media.startAt,
      media.endAt,
      media.volume,
      ...cues.map((cue) => cue.offset),
    ].filter((operand): operand is Expression => operand !== null);
    const sourceOrder = mediaOperands(media);
    const reordered = sourceOrder.some((operand, index) => operand !== operands[index]);
    const lowered = yield* compileChild(this.#lowerOrderedExpressionsTask(sourceOrder));
    const loweredByOperand = new Map<Expression, LoweredExpression>();
    sourceOrder.forEach((operand, index) => {
      const item = lowered[index]!;
      loweredByOperand.set(
        operand,
        reordered && item.plan.kind !== "temporary"
          ? this.#materializeExpression(item, operand.span)
          : item,
      );
    });
    const plan = (operand: Expression): ExpressionPlan => loweredByOperand.get(operand)!.plan;
    const temporaryIds = [...loweredByOperand.values()].flatMap((item) => item.temporaryIds);
    const selfHandle = media.async ? (this.#selfHandleByInitializer.get(media) ?? null) : null;
    const register = (block: Block): number => this.#registerHandler(block, "media", selfHandle);
    const cuePlans: MediaCuePlan[] = [];
    let finishFunctionId: number | null = null;
    if (media.handlers?.kind === "compact") {
      cuePlans.push({
        kind: "beforeEnd",
        offset: { kind: "duration", milliseconds: 0, span: copySpan(media.handlers.body.span) },
        functionId: register(media.handlers.body),
      });
    }
    for (const cue of cues) {
      if (cue.kind === "finish") finishFunctionId = register(cue.body);
      else
        cuePlans.push({
          kind: cue.kind,
          offset: plan(cue.offset!),
          functionId: register(cue.body),
        });
    }
    const destinationTemporary = value ? this.#allocateTemporary() : null;
    this.instructions.push({
      kind: "playMedia",
      media: media.media,
      async: media.async,
      file: plan(media.file),
      repeat:
        media.repeat === null
          ? { kind: "once" }
          : media.repeat.kind === "indefinite"
            ? { kind: "indefinite" }
            : media.repeat.kind === "times"
              ? { kind: "times", count: plan(media.repeat.count) }
              : { kind: "value", value: plan(media.repeat.value) },
      startAt: media.startAt === null ? null : plan(media.startAt),
      endAt: media.endAt === null ? null : plan(media.endAt),
      volume: media.volume === null ? null : plan(media.volume),
      cues: cuePlans,
      finishFunctionId,
      destinationTemporary,
      span: copySpan(media.span),
    });
    this.#emitTemporaryCleanup(temporaryIds, media.span);
    return destinationTemporary === null
      ? null
      : {
          plan: {
            kind: "temporary",
            temporaryId: destinationTemporary,
            span: copySpan(media.span),
          },
          temporaryIds: [destinationTemporary],
        };
  }

  /**
   * Main-story media presentation waits for the previous message's pacing. A handle operation passes its already
   * evaluated receiver; the barrier then waits only for a media handle.
   */
  #emitPacingBarrier(receiver: ExpressionPlan | null, span: SourceSpan): void {
    this.instructions.push({ kind: "pacingBarrier", receiver, span: copySpan(span) });
  }

  /** Reserves the next function ID; the region is compiled after all user functions. */
  #registerHandler(block: Block, owner: "timer" | "media", selfHandle: string | null): number {
    const id = this.#functionIdBase + this.declarations.length + this.#handlers.length + 1;
    this.#handlers.push({ block, owner, selfHandle });
    return id;
  }

  #compileHandler(
    registered: {
      readonly block: Block;
      readonly owner: "timer" | "media";
      readonly selfHandle: string | null;
    },
    id: number,
  ): void {
    const handler = registered.block;
    const entryInstruction = this.instructions.length;
    this.instructions.push({
      kind: "beginFunctionDefaults",
      functionId: id,
      span: copySpan(handler.span),
    });
    this.instructions.push({
      kind: "enterFunctionBody",
      functionId: id,
      span: copySpan(handler.span),
    });
    const bodyEntryInstruction = this.instructions.length;
    this.compileStatements(handler.statements);
    const implicitReturnInstruction = this.instructions.length;
    this.instructions.push({ kind: "returnVoid", span: copySpan(handler.span) });
    this.functions.push({
      id,
      handler: registered.owner,
      selfHandle: registered.selfHandle,
      name: registered.owner === "timer" ? "timer expiry" : "media cue",
      declarationSpan: copySpan(handler.span),
      parameters: [],
      entryInstruction,
      bodyEntryInstruction,
      implicitReturnInstruction,
      endInstruction: this.instructions.length,
      bodySpan: copySpan(handler.span),
    });
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
          ...withTypeCheck(this.typeChecks.get(parameter)),
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
      handler: null,
      selfHandle: null,
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
    if (
      this.#contextualSpeakerTemporary === null &&
      expression !== this.#barrierCall &&
      !this.#containsUserCall(expression)
    )
      return { plan: compileExpression(expression, this.typeChecks), temporaryIds: [] };
    if (expression.kind === "interactionExpression") {
      return yield* compileChild(this.#lowerInteractionTask(expression));
    }
    if (expression.kind === "showButtonExpression") {
      const lowered = yield* compileChild(this.#lowerShowButtonTask(expression, true));
      if (lowered === null) throw new TypeError("A showButton value lowered without a result.");
      return lowered;
    }
    if (expression.kind === "timerExpression") {
      const lowered = yield* compileChild(this.#lowerTimerTask(expression, true));
      if (lowered === null) throw new TypeError("A blocking timer reached value lowering.");
      return lowered;
    }
    if (expression.kind === "playMediaExpression") {
      const lowered = yield* compileChild(this.#lowerMediaTask(expression, true));
      if (lowered === null) throw new TypeError("Blocking media reached value lowering.");
      return lowered;
    }
    if (
      expression.kind === "callExpression" &&
      expression.callee.kind === "identifier" &&
      this.#functionByName.has(expression.callee.name)
    ) {
      return yield* compileChild(this.#lowerUserFunctionCallTask(expression));
    }
    if (expression.kind === "loadExpression") {
      return yield* compileChild(this.#lowerLoadTask(expression));
    }
    if (expression.kind === "tagQueryExpression") {
      // A bound or tag list that calls a function runs as instructions; the earlier operands wait in temporaries.
      const operands = yield* compileChild(
        this.#lowerOrderedExpressionsTask(tagQueryOperands(expression)),
      );
      return {
        plan: tagQueryPlan(
          expression,
          operands.map((operand) => operand.plan),
        ),
        temporaryIds: operands.flatMap((operand) => operand.temporaryIds),
      };
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
      case "durationLiteral":
        return { plan: compileExpression(expression, this.typeChecks), temporaryIds: [] };
      case "stringLiteral": {
        const interpolations = expression.parts
          .filter((part) => part.kind === "stringInterpolation")
          .map((part) => part.expression);
        if (interpolations.length === 0) {
          return { plan: compileExpression(expression, this.typeChecks), temporaryIds: [] };
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
        return { plan: compileExpression(expression, this.typeChecks), temporaryIds: [] };
      case "parenthesizedExpression":
        return yield* compileChild(this.#lowerExpressionTask(expression.expression));
      case "listLiteral":
      case "setLiteral":
        return yield* compileChild(this.#lowerCollectionExpressionTask(expression));
      case "objectLiteral":
        return yield* compileChild(this.#lowerCollectionExpressionTask(expression));
      case "dictLiteral": {
        // Each key is evaluated before its value, in source order.
        const parts = yield* compileChild(
          this.#lowerOrderedExpressionsTask(
            expression.entries.flatMap((entry) => [entry.key, entry.value]),
          ),
        );
        return {
          plan: {
            kind: "dict",
            entries: expression.entries.map((entry, index) => ({
              key: parts[2 * index]!.plan,
              value: parts[2 * index + 1]!.plan,
              span: copySpan(entry.span),
            })),
            span: copySpan(expression.span),
          },
          temporaryIds: parts.flatMap((part) => part.temporaryIds),
        };
      }
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
        // Grouping a method does not detach it from its receiver: `(text.trim)()` calls `text.trim()`.
        const method = unwrapParentheses(expression.callee);
        if (method.kind === "propertyAccessExpression") {
          let receiver = yield* compileChild(this.#lowerExpressionTask(method.object));
          if (expression === this.#barrierCall) {
            this.#barrierCall = null;
            // The receiver is evaluated once; the barrier and the call then use that value.
            if (receiver.plan.kind !== "temporary" && receiver.plan.kind !== "preparedReference") {
              receiver = this.#prepareReferenceExpression(receiver, method.object.span);
            }
            this.#emitPacingBarrier(receiver.plan, expression.span);
          }
          if (expression.arguments.some((argument) => this.#containsUserCall(argument.value))) {
            receiver = this.#prepareReferenceExpression(receiver, method.object.span);
            this.instructions.push({
              kind: "validateCallReceiver",
              receiver: receiver.plan,
              method: method.property.name,
              span: copySpan(method.span),
            });
          }
          callee = {
            plan: {
              kind: "property",
              object: receiver.plan,
              name: method.property.name,
              span: copySpan(method.span),
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
            ...withTypeCheck(this.typeChecks.get(expression)),
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
          return { plan: compileExpression(expression, this.typeChecks), temporaryIds: [] };
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
      case "typeTestExpression": {
        const value = yield* compileChild(this.#lowerExpressionTask(expression.value));
        return { plan: typeTestPlan(expression, value.plan), temporaryIds: value.temporaryIds };
      }
    }
  }

  /**
   * Lowers a `showButton`. A static label without options embeds its UI; otherwise the requesting speaker, the label,
   * and the options are prepared in source order. As a value, the button yields its elapsed waiting time.
   */
  *#lowerShowButtonTask(
    parts: ShowButtonParts,
    valueWanted: boolean,
  ): CompileTask<LoweredExpression | null> {
    const expectedResult = valueWanted ? "duration" : "none";
    const accessibleName = { kind: "localizedDefault", key: "continue" } as const;
    const staticLabel = staticVisibleText(parts.label);
    if (staticLabel !== undefined && parts.background === null && parts.timeout === null) {
      const instruction = {
        interactionKind: "button",
        target: "standardChat",
        speaker: parts.speaker?.name ?? null,
        expectedResult,
        ui: { kind: "button", buttonLabel: staticLabel, accessibleName },
        span: copySpan(parts.span),
      } as const;
      if (valueWanted) return this.#emitResultInteraction(instruction, parts.span);
      this.instructions.push({ kind: "interaction", ...instruction, destinationTemporary: null });
      return null;
    }

    const speakerTemporary = this.#prepareInteractionSpeaker(
      parts.speaker?.name ?? null,
      parts.asSpan ?? parts.commandSpan,
    );
    const label = this.#materializeDedicatedInteractionValue(
      yield* compileChild(this.#lowerInteractionPayloadTask(parts.label, speakerTemporary)),
      parts.label.span,
    );
    const optionTemporaries: { background?: number; timeout?: number } = {};
    for (const option of showButtonOptions(parts)) {
      optionTemporaries[option.name] = this.#materializeDedicatedInteractionValue(
        yield* compileChild(this.#lowerInteractionPayloadTask(option.value, speakerTemporary)),
        option.value.span,
      ).temporaryId;
    }
    const { background, timeout } = optionTemporaries;
    const preparedUi: PreparedInteractionUiPayload = {
      kind: "button",
      buttonLabelTemporary: label.temporaryId,
      ...(background === undefined ? {} : { backgroundTemporary: background }),
      ...(timeout === undefined ? {} : { timeoutTemporary: timeout }),
      accessibleName,
    };
    const preparedTemporaryIds = [
      speakerTemporary,
      label.temporaryId,
      ...Object.values(optionTemporaries),
    ];
    let lowered: LoweredExpression | null = null;
    if (valueWanted) {
      lowered = this.#emitPreparedResultInteraction(
        "button",
        "duration",
        speakerTemporary,
        preparedUi,
        parts.span,
      );
    } else {
      this.instructions.push({
        kind: "interaction",
        interactionKind: "button",
        target: "standardChat",
        speakerTemporary,
        destinationTemporary: null,
        expectedResult: "none",
        preparedUi,
        span: copySpan(parts.span),
      });
    }
    this.#emitTemporaryCleanup(preparedTemporaryIds, parts.span);
    return lowered;
  }

  *#lowerInteractionTask(expression: InteractionExpression): CompileTask<LoweredExpression> {
    const values =
      expression.interactionKind === "choice"
        ? expression.options.map((option) => option.expression)
        : expression.hint === null
          ? []
          : [expression.hint];
    const expectedResult =
      expression.interactionKind === "choice"
        ? ("choice" as const)
        : expression.interactionKind === "number" || expression.interactionKind === "integer"
          ? ("number" as const)
          : expression.interactionKind === "text"
            ? ("string" as const)
            : ("temporal" as const);

    const ui = staticInteractionUi(expression);
    if (ui !== undefined) {
      return this.#emitResultInteraction(
        {
          interactionKind: planInteractionKind(expression),
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

    if (expression.interactionKind !== "choice") {
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
      const prefill =
        expression.defaultValue === null
          ? null
          : this.#materializeDedicatedInteractionValue(
              yield* compileChild(
                this.#lowerInteractionPayloadTask(expression.defaultValue, speakerTemporary),
              ),
              expression.defaultValue.span,
            );
      if (prefill !== null) preparedTemporaryIds.push(prefill.temporaryId);
      preparedUi =
        expression.interactionKind === "text"
          ? {
              kind: "text",
              hintTemporary: hint?.temporaryId ?? null,
              ...(prefill === null ? {} : { prefillTemporary: prefill.temporaryId }),
              accessibleName: { kind: "localizedDefault", key: "answer" },
            }
          : expression.interactionKind === "number" || expression.interactionKind === "integer"
            ? {
                kind: "number",
                hintTemporary: hint?.temporaryId ?? null,
                ...(prefill === null ? {} : { prefillTemporary: prefill.temporaryId }),
                ...(expression.interactionKind === "integer" ? { integer: true as const } : {}),
                accessibleName: { kind: "localizedDefault", key: "number" },
              }
            : {
                kind: "temporal",
                temporalKind: expression.interactionKind,
                hintTemporary: hint?.temporaryId ?? null,
                ...(prefill === null ? {} : { prefillTemporary: prefill.temporaryId }),
                accessibleName: { kind: "localizedDefault", key: "answer" },
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
        optionsTemporary,
        values: expression.options.map((option) =>
          option.value === null ? null : authoredChoiceValue(option.value),
        ),
        accessibleName: { kind: "localizedDefault", key: "chooseOption" },
      };
    }

    const lowered = this.#emitPreparedResultInteraction(
      planInteractionKind(expression),
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
    interactionKind: InteractionKind,
    expectedResult: Exclude<InteractionResultDomain, "none">,
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
      planned.push({
        parameterName,
        value: lowered.plan,
        span: copySpan(argument.span),
        ...withTypeCheck(this.typeChecks.get(argument)),
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

  /**
   * Lowers `load`. A default that emits instructions runs only when the stored value is `null`, which means the key
   * is absent because stored values are never `null`; any other default stays lazy inside the load plan.
   */
  *#lowerLoadTask(
    expression: Extract<Expression, { kind: "loadExpression" }>,
  ): CompileTask<LoweredExpression> {
    const key = yield* compileChild(this.#lowerExpressionTask(expression.key));
    const defaultValue = expression.defaultValue;
    if (defaultValue === null || !this.#containsUserCall(defaultValue)) {
      const lowered =
        defaultValue === null ? null : yield* compileChild(this.#lowerExpressionTask(defaultValue));
      return {
        plan: {
          kind: "storageLoad",
          key: key.plan,
          default: lowered?.plan ?? null,
          span: copySpan(expression.span),
        },
        temporaryIds: [...key.temporaryIds, ...(lowered?.temporaryIds ?? [])],
      };
    }
    const resultTemporary = this.#allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: { kind: "storageLoad", key: key.plan, default: null, span: copySpan(expression.span) },
      expectBoolean: false,
      span: copySpan(expression.span),
    });
    const result: TemporaryExpressionPlan = {
      kind: "temporary",
      temporaryId: resultTemporary,
      span: copySpan(expression.span),
    };
    const conditional = this.instructions.length;
    const conditionalInstruction: JumpIfFalseInstruction = {
      kind: "jumpIfFalse",
      condition: {
        kind: "binary",
        operator: "==",
        left: result,
        right: { kind: "literal", value: null, span: copySpan(expression.span) },
        span: copySpan(expression.span),
      },
      target: -1,
      span: copySpan(expression.span),
    };
    this.instructions.push(conditionalInstruction);
    const lowered = yield* compileChild(this.#lowerExpressionTask(defaultValue));
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: lowered.plan,
      expectBoolean: false,
      span: copySpan(defaultValue.span),
    });
    this.instructions[conditional] = {
      ...conditionalInstruction,
      target: this.instructions.length,
    };
    return {
      plan: result,
      temporaryIds: [...key.temporaryIds, ...lowered.temporaryIds, resultTemporary],
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

      if (
        current.expression.kind === "interactionExpression" ||
        current.expression.kind === "showButtonExpression" ||
        current.expression.kind === "timerExpression" ||
        current.expression.kind === "playMediaExpression"
      ) {
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
    const id = this.counters.nextTemporaryId;
    this.counters.nextTemporaryId += 1;
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

function compileExpression(
  expression: Expression,
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
): ExpressionPlan {
  const plans = new WeakMap<Expression, ExpressionPlan>();
  const work: { expression: Expression; expanded: boolean }[] = [{ expression, expanded: false }];
  while (work.length) {
    const frame = work.pop()!;
    const current = unwrapParentheses(frame.expression);
    if (frame.expanded) {
      plans.set(current, assembleExpression(current, child, typeChecks));
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

/** The value written before `:` in a choice option: an identifier is text, a numeric literal a number. */
function authoredChoiceValue(
  value: NonNullable<InteractionExpression["options"][number]["value"]>,
): string | number {
  return value.kind === "identifier" ? value.name : Object.is(value.value, -0) ? 0 : value.value;
}

/**
 * The prefill text of a literal default answer, or `undefined` when the default is evaluated at runtime, where
 * arithmetic, also inside an interpolation, keeps its ordinary runtime errors. Semantic validation has already rejected
 * literals of the wrong type.
 */
function staticInteractionPrefill(expression: InteractionExpression): string | undefined {
  const kind = expression.interactionKind;
  // A date or time default is a value that the field shows as ISO text when it opens.
  if (kind === "date" || kind === "time" || kind === "datetime") return undefined;
  let literal = expression.defaultValue!;
  let negative = false;
  while (
    literal.kind === "parenthesizedExpression" ||
    (expression.interactionKind !== "text" &&
      literal.kind === "unaryExpression" &&
      (literal.operator === "-" || literal.operator === "+"))
  ) {
    if (literal.kind === "unaryExpression") {
      negative = negative !== (literal.operator === "-");
      literal = literal.operand;
    } else literal = literal.expression;
  }
  if (expression.interactionKind !== "text")
    return literal.kind === "numberLiteral"
      ? numberAnswerText(negative ? -literal.value : literal.value)
      : undefined;
  return literal.kind === "stringLiteral" &&
    literal.parts.every((part) => part.kind === "stringText")
    ? staticVisibleText(literal)
    : undefined;
}

/**
 * `askInteger` runs as a `number` interaction whose UI only accepts whole numbers, and `askDate`, `askTime`, and
 * `askDateTime` as a `temporal` interaction whose UI says what it asks for.
 */
function planInteractionKind(expression: InteractionExpression): InteractionKind {
  switch (expression.interactionKind) {
    case "integer":
      return "number";
    case "date":
    case "time":
    case "datetime":
      return "temporal";
    default:
      return expression.interactionKind;
  }
}

/** The UI of an interaction whose text, values, and default answer are all known at compile time. */
function staticInteractionUi(expression: InteractionExpression): InteractionUiPayload | undefined {
  if (expression.interactionKind !== "choice") {
    const hint = expression.hint === null ? null : staticVisibleText(expression.hint);
    const prefill = expression.defaultValue === null ? null : staticInteractionPrefill(expression);
    if (hint === undefined || prefill === undefined) return undefined;
    return expression.interactionKind === "text"
      ? {
          kind: "text",
          hint,
          ...(prefill === null ? {} : { prefill }),
          accessibleName: { kind: "localizedDefault", key: "answer" },
        }
      : expression.interactionKind === "number" || expression.interactionKind === "integer"
        ? {
            kind: "number",
            hint,
            ...(prefill === null ? {} : { prefill }),
            ...(expression.interactionKind === "integer" ? { integer: true as const } : {}),
            accessibleName: { kind: "localizedDefault", key: "number" },
          }
        : {
            kind: "temporal",
            temporalKind: expression.interactionKind,
            hint,
            ...(prefill === null ? {} : { prefill }),
            accessibleName: { kind: "localizedDefault", key: "answer" },
          };
  }
  const options: InteractionChoiceOption[] = [];
  for (const option of expression.options) {
    const text = staticVisibleText(option.expression);
    const known = option.value === null ? staticChoiceValue(option.expression) : undefined;
    if (text === undefined || (option.value === null && known === undefined)) return undefined;
    options.push({
      text,
      value: option.value === null ? known!.value : authoredChoiceValue(option.value),
    });
  }
  return {
    kind: "choice",
    options,
    accessibleName: { kind: "localizedDefault", key: "chooseOption" },
  };
}

/** The optional `typeCheck` field of a receiving instruction or plan, present only when the value is checked. */
function withTypeCheck(typeCheck: TypeCheckPlan | undefined): { typeCheck?: TypeCheckPlan } {
  return typeCheck === undefined ? {} : { typeCheck };
}

function copySpan(span: SourceSpan): PlanSourceLocation {
  return sourceSpanToPlanLocation(span);
}

const MEDIA_CONTROL_METHODS: ReadonlySet<string> = new Set(["pause", "resume", "stop"]);
const MEDIA_ASSIGNABLE_PROPERTIES: ReadonlySet<string> = new Set([
  "position",
  "remaining",
  "volume",
]);

function assembleExpression(
  expression: Expression,
  child: (expression: Expression) => ExpressionPlan,
  typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan>,
): ExpressionPlan {
  switch (expression.kind) {
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
      return { kind: "literal", value: expression.value, span: copySpan(expression.span) };
    case "durationLiteral": {
      const parts = durationLiteralParts(expression);
      // The type checker rejects a calendar amount that is not whole before lowering.
      if (typeof parts === "string") throw new Error(`Invalid duration literal: ${parts}.`);
      return { ...storedDuration(parts), span: copySpan(expression.span) };
    }
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
    case "dictLiteral":
      return {
        kind: "dict",
        entries: expression.entries.map((entry) => ({
          key: child(entry.key),
          value: child(entry.value),
          span: copySpan(entry.span),
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
        ...withTypeCheck(typeChecks.get(expression)),
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
    case "loadExpression":
      return {
        kind: "storageLoad",
        key: child(expression.key),
        default: expression.defaultValue === null ? null : child(expression.defaultValue),
        span: copySpan(expression.span),
      };
    case "tagQueryExpression":
      return tagQueryPlan(expression, tagQueryOperands(expression).map(child));
    case "interactionExpression":
    case "showButtonExpression":
    case "timerExpression":
    case "playMediaExpression":
      throw new TypeError(
        "Interactions, timers, and media must be lowered before expression-plan compilation.",
      );
    case "typeTestExpression":
      return typeTestPlan(expression, child(expression.value));
  }
}

function tagQueryPlan(
  expression: TagQueryExpression,
  operands: readonly ExpressionPlan[],
): TagQueryExpressionPlan {
  return {
    kind: "tagQuery",
    catalog: expression.catalog,
    select: expression.select,
    operands: [...operands],
    steps: expression.steps.map((step) =>
      step.kind === "tag"
        ? { kind: "tag", name: step.name }
        : step.kind === "tagCompare"
          ? { kind: "tagCompare", name: step.name, operator: step.operator }
          : step.kind === "tagList"
            ? { kind: "tagList", option: step.option }
            : { kind: step.kind },
    ),
    span: copySpan(expression.span),
  };
}

/** A type test; a type the runtime cannot narrow down, which no written type is, makes the test constant. */
/** `value is T` or `value is not T`, from a type test expression or a `case is T`. */
function typeTestPlan(
  expression: Pick<TypeTestExpression, "type" | "negated" | "span">,
  value: ExpressionPlan,
): ExpressionPlan {
  const type = typePlan(typeFromAnnotation(expression.type));
  return type === null
    ? { kind: "literal", value: !expression.negated, span: copySpan(expression.span) }
    : {
        kind: "typeTest",
        value,
        type,
        negated: expression.negated,
        span: copySpan(expression.span),
      };
}
