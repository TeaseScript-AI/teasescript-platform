import type {
  Block,
  Expression,
  TimerParts,
  MediaParts,
  FunctionDeclaration,
  GlobalStatement,
  ListLiteral,
  NamedArgument,
  ObjectLiteral,
  SetLiteral,
  Statement,
  InteractionExpression,
  ShowPermanentButtonParts,
  SpeakerDeclaration,
  IfStatement,
  SwitchCase,
  SwitchStatement,
  FileTarget,
  ScriptTarget,
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
  StoreTemporaryInstruction,
  MediaCuePlan,
  JumpInstruction,
  LockInstruction,
  LoopControlInstruction,
  LoopStartInstruction,
  PrepareParameterDefaultInstruction,
  CallArgumentPlan,
  TemplatePartPlan,
  TemporaryExpressionPlan,
  TypeCheckPlan,
  PreparedFormShape,
  PlanLabel,
} from "../../plan/model.js";
import { copiesPlayerProfile } from "../../project-globals.js";
import {
  isAskImageCall,
  isFileStoreCall,
  directPasswordField,
  isLockCall,
  isTakePhotoCall,
} from "../../capture-call.js";
import { isConversion, takesDefault, takesFiles } from "../../conversions.js";
import { lazyDefaultArgument } from "../../lazy-defaults.js";
import { boundParameterName } from "../../function-arguments.js";
import type { RuntimeCheckSite } from "../../type-inference/backend.js";
import { runCompileTask, compileChild, type CompileTask } from "../continuation.js";
import {
  expressionChildren as instructionEmissionChildren,
  mediaHandlerBlocks,
  mediaOperands,
  tagQueryOperands,
  timerOperands,
} from "../../expression-children.js";
import {
  lowerShowButtonTask,
  lowerShowPopupTask,
  lowerOpenUrlTask,
  lowerExportTextTask,
  consumeInteractionResult,
  prepareInteractionSpeaker,
} from "./interactions.js";
import { lowerInteractionTask, lowerAskQuestionTask, lowerAskImageTask } from "./asks.js";
import { lowerSayTask } from "./say.js";
import {
  isPlayerProfile,
  unwrapParentheses,
  normalizeUnaryExpression,
  compileExpression,
  withTypeCheck,
  unitOf,
  copySpan,
  tagQueryPlan,
  typeTestPlan,
} from "./expression-plans.js";

/**
 * What the lowering tells an analysis that reads the plan back as source; not part of the plan. `origins` holds the
 * source construct of each `jumpIfFalse` and `loopStart`, by instruction, and `statements` the instructions of each
 * statement: from `start` up to `end` in the region where it stands, none for a declaration that runs nothing there.
 */
export interface LoweringTrace {
  readonly origins: Map<number, ControlOrigin>;
  readonly statements: Map<Statement, { readonly start: number; readonly end: number }>;
}

/**
 * The source construct that a `jumpIfFalse` or `loopStart` decides, for an analysis that reads the plan's ways back
 * as source: an `if`, one `case` of a `switch`, a loop, the right side of `and`, `or`, or `otherwise` that runs as
 * instructions, or a `default:` of a `load` or a call that runs as instructions.
 */
export type ControlOrigin =
  | { readonly kind: "if"; readonly statement: IfStatement }
  | { readonly kind: "case"; readonly statement: SwitchStatement; readonly index: number }
  | { readonly kind: "loop"; readonly statement: LoopStatement }
  | {
      readonly kind: "operand";
      readonly expression: Extract<Expression, { kind: "binaryExpression" }>;
    }
  | {
      readonly kind: "default";
      readonly expression: Extract<Expression, { kind: "loadExpression" | "callExpression" }>;
    };

export type LoopStatement = Extract<
  Statement,
  { kind: "repeatStatement" | "forStatement" | "whileStatement" }
>;

/** A transfer at `instruction` whose destination is a file, from its entry. */
export interface PendingDestination {
  readonly instruction: number;
  /** The file, or for a glob the files to pick from. */
  readonly paths: readonly string[];
  readonly pick: boolean;
}

/** Plan-wide numbering shared by the compilers of a project's files: loop and temporary IDs are unique in a plan. */
export interface LoweringCounters {
  nextLoopId: number;
  nextTemporaryId: number;
}

/** What the compilers of a project's files share about its global functions. */
export interface ProjectFunctions {
  /** The global functions of every file, by name. */
  readonly global: ReadonlyMap<string, FunctionDeclaration>;
  /**
   * The calls of a global function of another file, by instruction index. Its ID is known only once every file before
   * it is lowered, so the call gets it then.
   */
  readonly foreignCalls: { readonly instruction: number; readonly name: string }[];
}

/** A timer expiry block, media cue block, or permanent button block, compiled after the file's functions. */
interface RegisteredHandler {
  readonly block: Block;
  readonly owner: "timer" | "media" | "button";
  readonly selfHandle: string | null;
  /** Whether it is in a global function, directly or through other blocks. */
  readonly global: boolean;
}

/** The public members serve `compile-program.ts` and the modules beside this file, and are internal to the compiler. */
export class InstructionCompiler {
  readonly #loops: Array<{
    readonly loopId: number;
    readonly continueTarget: number;
    readonly breaks: number[];
  }> = [];

  /** The functions this file may call: its own, with their IDs, and the global functions of other files. */
  readonly #functionByName: ReadonlyMap<
    string,
    { readonly id: number | null; readonly declaration: FunctionDeclaration }
  >;

  /** Whether the code being compiled is in a global function or one of its timer and media blocks. */
  #global = false;

  readonly #instructionEmissionByExpression = new WeakMap<Expression, boolean>();

  public contextualSpeakerTemporary: number | null = null;

  /** The labels of the file's root region, in source order. */
  public readonly labels: PlanLabel[] = [];

  /** Gotos whose target is set by {@link resolveGotos} once every label of the file has its instruction. */
  readonly #gotos: { readonly instruction: number; readonly label: string }[] = [];

  /** Transfers naming a file, resolved once every file of the project is compiled. */
  readonly #destinations: PendingDestination[] = [];

  /** The pending file destinations of this file's transfers. */
  public get destinations(): readonly PendingDestination[] {
    return this.#destinations;
  }

  #emitTransfer(mode: "goto" | "call", target: FileTarget | ScriptTarget, span: SourceSpan): void {
    if (target.kind === "scriptTarget") {
      const lowered = this.#lowerExpression(target.expression);
      this.instructions.push({
        kind: "transfer",
        mode,
        destination: { value: lowered.plan },
        span: copySpan(span),
      });
      // A call returns here with the temporaries of its target; a goto leaves them behind.
      if (mode === "call") this.emitTemporaryCleanup(lowered.temporaryIds, span);
      return;
    }
    const picks = this.picks.get(target);
    this.#destinations.push({
      instruction: this.instructions.length,
      paths: picks ?? [target.path],
      pick: picks !== undefined,
    });
    this.instructions.push({
      kind: "transfer",
      mode,
      destination: { file: -1, target: -1 },
      span: copySpan(span),
    });
  }

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
    private readonly project: ProjectFunctions = { global: new Map(), foreignCalls: [] },
    /** The files each glob target may pick, from semantic validation. */
    private readonly picks: ReadonlyMap<FileTarget, readonly string[]> = new Map(),
    /** The variables each timer, media, or button block shares with the code that created it. */
    private readonly captures: ReadonlyMap<Block, readonly string[]> = new Map(),
    /** The result shape of each `askForm`, from the type check. */
    public readonly formShapes: ReadonlyMap<InteractionExpression, PreparedFormShape> = new Map(),
    /** Receives the trace of the lowering, when an analysis asks for it. */
    private readonly trace: LoweringTrace | null = null,
  ) {
    this.#functionIdBase = functions.length;
    const functionByName = new Map<
      string,
      { readonly id: number | null; readonly declaration: FunctionDeclaration }
    >([...project.global].map(([name, declaration]) => [name, { id: null, declaration }]));
    declarations.forEach((declaration, index) =>
      functionByName.set(declaration.name.name, {
        id: this.#functionIdBase + index + 1,
        declaration,
      }),
    );
    this.#functionByName = functionByName;
  }

  #originate(instruction: number, origin: ControlOrigin): void {
    this.trace?.origins.set(instruction, origin);
  }

  /** The ID of one of this file's functions. */
  public functionId(declaration: FunctionDeclaration): number {
    return this.#functionIdBase + this.declarations.indexOf(declaration) + 1;
  }

  /**
   * Compiles the start value of a global or a speaker declared in file `file`, which a session sets up before its
   * story runs (ADR 0022 §6). It uses no calls or interactions, so it is one instruction.
   */
  public compileStartValue(declaration: GlobalStatement | SpeakerDeclaration, file: number): void {
    if (declaration.kind === "globalStatement") {
      this.instructions.push({
        kind: "declareGlobal",
        name: declaration.name.name,
        value: compileExpression(declaration.initial, this.typeChecks),
        ...withTypeCheck(this.typeChecks.get(declaration)),
        file,
        span: copySpan(declaration.span),
      });
      return;
    }
    this.instructions.push({
      kind: "declareSpeaker",
      name: declaration.name.name,
      properties: declaration.properties.map((property) => ({
        name: property.name.name,
        value: compileExpression(property.value, this.typeChecks),
        span: copySpan(property.span),
      })),
      file,
      span: copySpan(declaration.span),
    });
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
      this.#global = declaration.global;
      this.#compileFunction(declaration);
      this.#global = false;
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
  readonly #handlers: RegisteredHandler[] = [];

  /** The `let` name that a media initializer binds in its own blocks. */
  readonly #selfHandleByInitializer = new Map<MediaParts, string>();

  public compileStatements(statements: readonly Statement[]): void {
    runCompileTask(this.#compileStatements(statements));
  }

  *#compileStatements(statements: readonly Statement[]): CompileTask<void> {
    for (const statement of statements) yield* compileChild(this.#compileStatement(statement));
  }

  *#compileStatement(statement: Statement): CompileTask<void> {
    const start = this.instructions.length;
    yield* compileChild(this.#compileStatementKind(statement));
    this.trace?.statements.set(statement, { start, end: this.instructions.length });
  }

  *#compileStatementKind(statement: Statement): CompileTask<void> {
    switch (statement.kind) {
      case "speakerDeclaration":
        // A speaker is set up before the story runs, by the start of main.tease.
        return;
      case "globalStatement":
        // A global gets its start value before the story runs; with `default:`, the declaration assigns here.
        if (statement.assignment !== null)
          yield* compileChild(this.#compileStatement(statement.assignment));
        return;
      case "speakerSetterStatement":
        this.instructions.push({
          kind: "setDefaultSpeaker",
          name: statement.speaker.name,
          span: copySpan(statement.span),
        });
        return;
      case "sayStatement":
        yield* compileChild(lowerSayTask(this, statement, false));
        return;
      case "showButtonStatement":
        yield* compileChild(lowerShowButtonTask(this, statement, false));
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
        this.emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "timerStatement":
        yield* compileChild(this.#lowerTimerTask(statement, false));
        return;
      case "showPermanentButtonStatement":
        yield* compileChild(this.#lowerPermanentButtonTask(statement, false));
        return;
      case "playMediaStatement":
        yield* compileChild(this.#lowerMediaTask(statement, false));
        return;
      case "stopAudioStatement":
        this.instructions.push({ kind: "stopAudio", span: copySpan(statement.span) });
        return;
      case "showImageStatement": {
        const lowered = this.#lowerExpression(statement.image);
        this.instructions.push({
          kind: "showImage",
          image: lowered.plan,
          span: copySpan(statement.span),
        });
        this.emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "hideImageStatement":
        this.instructions.push({ kind: "showImage", image: null, span: copySpan(statement.span) });
        return;
      case "showCameraStatement":
        this.#lowerShowCamera(statement.placement, false, statement.span);
        return;
      case "hideCameraStatement":
        this.instructions.push({ kind: "hideCamera", span: copySpan(statement.span) });
        return;
      case "showPopupStatement":
        yield* compileChild(lowerShowPopupTask(this, statement, false));
        return;
      case "openUrlStatement":
        yield* compileChild(lowerOpenUrlTask(this, statement));
        return;
      case "exportTextStatement":
        yield* compileChild(lowerExportTextTask(this, statement));
        return;
      case "saveStatement": {
        const [value, key] = runCompileTask(
          this.lowerOrderedExpressionsTask([statement.value, statement.key]),
        );
        this.instructions.push({
          kind: "storageWrite",
          value: value!.plan,
          key: key!.plan,
          span: copySpan(statement.span),
        });
        this.emitTemporaryCleanup([...value!.temporaryIds, ...key!.temporaryIds], statement.span);
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
        this.emitTemporaryCleanup(key.temporaryIds, statement.span);
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
        if (statement.target.kind === "labelTarget") {
          this.#gotos.push({
            instruction: this.instructions.length,
            label: statement.target.label.name,
          });
          this.instructions.push({ kind: "goto", target: -1, span: copySpan(statement.span) });
          return;
        }
        this.#emitTransfer("goto", statement.target, statement.span);
        return;
      case "callFileStatement":
        // The name pass rejects a call of a label: a call starts another file (V30 §29).
        if (statement.target.kind === "labelTarget")
          throw new TypeError("Semantically invalid call reached compilation.");
        this.#emitTransfer("call", statement.target, statement.span);
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
        this.emitTemporaryCleanup(lowered.temporaryIds, statement.span);
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
        // A compound assignment reads the current value before any instruction-emitting operand runs.
        const current =
          statement.operator === "=" || !this.emitsInstructions(statement.value)
            ? null
            : this.materializeExpression(
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
        this.emitTemporaryCleanup(
          [...target.temporaryIds, ...(current?.temporaryIds ?? []), ...value.temporaryIds],
          statement.span,
        );
        return;
      }
      case "expressionStatement": {
        if (copiesPlayerProfile(statement.expression)) {
          this.instructions.push({ kind: "copyPlayerProfile", span: copySpan(statement.span) });
          return;
        }
        const lowered = this.#lowerExpression(statement.expression);
        this.instructions.push({
          kind: "evaluate",
          expression: lowered.plan,
          span: copySpan(statement.span),
        });
        this.emitTemporaryCleanup(lowered.temporaryIds, statement.span);
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
          this.#compileLoop(
            statement,
            "repeat",
            statement.count,
            statement.body,
            null,
            statement.span,
          ),
        );
        return;
      case "forStatement":
        yield* compileChild(
          this.#compileLoop(
            statement,
            "for",
            statement.iterable,
            statement.body,
            statement.variable.name,
            statement.span,
            statement.valueVariable?.name,
          ),
        );
        return;
      case "whileStatement":
        yield* compileChild(
          this.#compileLoop(
            statement,
            "while",
            statement.condition,
            statement.body,
            null,
            statement.span,
          ),
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
    this.#originate(conditional, { kind: "if", statement });
    this.emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
    yield* compileChild(this.#compileBlock(statement.thenBlock));
    if (statement.elseBlock === null) {
      const falseCleanup = this.instructions.length;
      this.instructions[conditional] = { ...conditionalInstruction, target: falseCleanup };
      this.emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
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
    this.emitTemporaryCleanup(lowered.temporaryIds, statement.condition.span);
    if (statement.elseBlock.kind === "ifStatement") {
      yield* compileChild(this.#compileStatement(statement.elseBlock));
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
    const subjectTemporary = this.allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: subjectTemporary,
      value: subject.plan,
      expectBoolean: false,
      span: copySpan(statement.subject.span),
    });
    this.emitTemporaryCleanup(subject.temporaryIds, statement.subject.span);
    const jumpsToEnd: { readonly index: number; readonly instruction: JumpInstruction }[] = [];
    for (const [index, switchCase] of statement.cases.entries()) {
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
      this.#originate(conditional, { kind: "case", statement, index });
      this.emitTemporaryCleanup([subjectTemporary], valuesSpan);
      yield* compileChild(this.#compileBlock(switchCase.body));
      const jump: JumpInstruction = { kind: "jump", target: -1, span: copySpan(switchCase.span) };
      jumpsToEnd.push({ index: this.instructions.length, instruction: jump });
      this.instructions.push(jump);
      this.instructions[conditional] = {
        ...conditionalInstruction,
        target: this.instructions.length,
      };
    }
    this.emitTemporaryCleanup([subjectTemporary], statement.subject.span);
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
    statement: LoopStatement,
    loopKind: "repeat" | "for" | "while",
    expression: Expression,
    body: Block,
    variable: string | null,
    span: SourceSpan,
    valueVariable?: string,
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
            ...(valueVariable === undefined ? {} : { valueVariable }),
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
    this.#originate(start, { kind: "loop", statement });
    this.emitTemporaryCleanup(lowered.temporaryIds, expression.span);
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
    this.emitTemporaryCleanup(lowered.temporaryIds, expression.span);
    const exit = this.instructions.length;
    for (const index of context.breaks) {
      // EVIDENCE: break indices are recorded only when emitting loopControl instructions above.
      this.instructions[index] = {
        ...(this.instructions[index] as LoopControlInstruction),
        target: exit,
      };
    }
  }

  *#lowerTimerTask(timer: TimerParts, value: boolean): CompileTask<LoweredExpression | null> {
    const dynamicDisplay = typeof timer.display === "object" ? timer.display : null;
    // The instruction's evaluation order; `timerOperands` gives the source order.
    const operands = [timer.duration, dynamicDisplay, timer.label].filter(
      (operand): operand is Expression => operand !== null,
    );
    const sourceOrder = timerOperands(timer);
    const reordered = sourceOrder.some((operand, index) => operand !== operands[index]);
    const lowered = yield* compileChild(this.lowerOrderedExpressionsTask(sourceOrder));
    const planOf = (operand: Expression): LoweredExpression => {
      const item = lowered[sourceOrder.indexOf(operand)]!;
      return reordered && item.plan.kind !== "temporary"
        ? this.materializeExpression(item, operand.span)
        : item;
    };
    // Materialization must follow source order, so resolve every operand before building the instruction.
    const loweredBySource = sourceOrder.map(planOf);
    const plan = (operand: Expression): ExpressionPlan =>
      loweredBySource[sourceOrder.indexOf(operand)]!.plan;
    const temporaryIds = loweredBySource.flatMap((item) => item.temporaryIds);
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
      this.emitTemporaryCleanup(temporaryIds, timer.span);
      return null;
    }
    const destinationTemporary = value ? this.allocateTemporary() : null;
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
      captures: this.#capturesOf(timer.handler === null ? [] : [timer.handler]),
      destinationTemporary,
      span: copySpan(timer.span),
    });
    this.emitTemporaryCleanup(temporaryIds, timer.span);
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
   * `showPermanentButton <text> { ... }` evaluates its text and shows the button; the block becomes a parameterless
   * handler region that a click runs. Used as a value, it gives the button's identifier.
   */
  *#lowerPermanentButtonTask(
    button: ShowPermanentButtonParts,
    value: boolean,
  ): CompileTask<LoweredExpression | null> {
    const text = yield* compileChild(this.lowerExpressionTask(button.text));
    const span = createSourceSpan(button.commandSpan.start, button.text.span.end);
    const destinationTemporary = value ? this.allocateTemporary() : null;
    this.instructions.push({
      kind: "showPermanentButton",
      text: text.plan,
      persist: button.persist,
      handlerFunctionId: this.#registerHandler(button.handler, "button", null),
      captures: this.#capturesOf([button.handler]),
      destinationTemporary,
      span: copySpan(span),
    });
    this.emitTemporaryCleanup(text.temporaryIds, span);
    return destinationTemporary === null
      ? null
      : {
          plan: { kind: "temporary", temporaryId: destinationTemporary, span: copySpan(span) },
          temporaryIds: [destinationTemporary],
        };
  }

  /** Lowers a play command; its operands evaluate in source order. */
  *#lowerMediaTask(media: MediaParts, value: boolean): CompileTask<LoweredExpression | null> {
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
    const lowered = yield* compileChild(this.lowerOrderedExpressionsTask(sourceOrder));
    const loweredByOperand = new Map<Expression, LoweredExpression>();
    sourceOrder.forEach((operand, index) => {
      const item = lowered[index]!;
      loweredByOperand.set(
        operand,
        reordered && item.plan.kind !== "temporary"
          ? this.materializeExpression(item, operand.span)
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
    const destinationTemporary = value ? this.allocateTemporary() : null;
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
      captures: this.#capturesOf(mediaHandlerBlocks(media)),
      destinationTemporary,
      span: copySpan(media.span),
    });
    this.emitTemporaryCleanup(temporaryIds, media.span);
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

  /** `showCamera [stage]` shows the camera view. */
  #lowerShowCamera(
    placement: "window" | "stage",
    value: boolean,
    span: SourceSpan,
  ): LoweredExpression | null {
    const destinationTemporary = value ? this.allocateTemporary() : null;
    this.instructions.push({
      kind: "showCamera",
      placement,
      destinationTemporary,
      span: copySpan(span),
    });
    return destinationTemporary === null
      ? null
      : {
          plan: { kind: "temporary", temporaryId: destinationTemporary, span: copySpan(span) },
          temporaryIds: [destinationTemporary],
        };
  }

  /** The variables that blocks of one resource share with the code that creates it, in the order of first use. */
  #capturesOf(blocks: readonly Block[]): string[] {
    const names = new Set<string>();
    for (const block of blocks) for (const name of this.captures.get(block) ?? []) names.add(name);
    return [...names];
  }

  /** Reserves the next function ID; the region is compiled after all user functions. */
  #registerHandler(
    block: Block,
    owner: "timer" | "media" | "button",
    selfHandle: string | null,
  ): number {
    const id = this.#functionIdBase + this.declarations.length + this.#handlers.length + 1;
    this.#handlers.push({ block, owner, selfHandle, global: this.#global });
    return id;
  }

  #compileHandler(registered: RegisteredHandler, id: number): void {
    this.#global = registered.global;
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
    this.#global = false;
    this.functions.push({
      id,
      handler: registered.owner,
      global: registered.global,
      selfHandle: registered.selfHandle,
      name:
        registered.owner === "timer"
          ? "timer expiry"
          : registered.owner === "media"
            ? "media cue"
            : "permanent button",
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
    const own = this.#functionByName.get(declaration.name.name);
    if (own?.id === null || own?.declaration !== declaration) {
      throw new TypeError("Semantically invalid function reached compilation.");
    }
    const registered = { id: own.id, declaration };
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
        this.emitTemporaryCleanup(lowered.temporaryIds, parameter.span);
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
      global: declaration.global,
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
    return runCompileTask(this.lowerExpressionTask(expression));
  }

  public *lowerExpressionTask(expression: Expression): CompileTask<LoweredExpression> {
    expression = unwrapParentheses(expression);
    if (this.contextualSpeakerTemporary === null && !this.emitsInstructions(expression))
      return { plan: compileExpression(expression, this.typeChecks), temporaryIds: [] };
    if (expression.kind === "interactionExpression") {
      return yield* compileChild(lowerInteractionTask(this, expression));
    }
    if (expression.kind === "showButtonExpression") {
      const lowered = yield* compileChild(lowerShowButtonTask(this, expression, true));
      if (lowered === null) throw new TypeError("A showButton value lowered without a result.");
      return lowered;
    }
    if (expression.kind === "showPopupExpression") {
      const lowered = yield* compileChild(lowerShowPopupTask(this, expression, true));
      if (lowered === null) throw new TypeError("A showPopup value lowered without a result.");
      return lowered;
    }
    if (expression.kind === "sayExpression") {
      const lowered = yield* compileChild(lowerSayTask(this, expression, true));
      if (lowered === null) throw new TypeError("A say value lowered without a handle.");
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
    if (expression.kind === "showCameraExpression") {
      const lowered = this.#lowerShowCamera(expression.placement, true, expression.span);
      if (lowered === null) throw new TypeError("A camera view lowered without a handle.");
      return lowered;
    }
    if (expression.kind === "showPermanentButtonExpression") {
      const lowered = yield* compileChild(this.#lowerPermanentButtonTask(expression, true));
      if (lowered === null)
        throw new TypeError("A permanent button lowered without an identifier.");
      return lowered;
    }
    if (isAskImageCall(expression) && expression.kind === "callExpression") {
      return yield* compileChild(lowerAskImageTask(this, expression));
    }
    if (isTakePhotoCall(expression)) {
      // `takePhoto(tags: …)`: the tags are evaluated first; the capture reads them before it asks the Player.
      const tagsArgument =
        expression.kind === "callExpression" ? expression.arguments[0] : undefined;
      const tags =
        tagsArgument === undefined
          ? null
          : yield* compileChild(this.lowerExpressionTask(tagsArgument.value));
      const transientTemporary = this.allocateTemporary();
      this.instructions.push({
        kind: "capture",
        capture: "photo",
        tags: tags?.plan ?? null,
        destinationTemporary: transientTemporary,
        span: copySpan(expression.span),
      });
      const result = consumeInteractionResult(this, transientTemporary, expression.span);
      if (tags !== null) this.emitTemporaryCleanup(tags.temporaryIds, expression.span);
      return result;
    }
    if (isFileStoreCall(expression) && expression.kind === "callExpression") {
      return yield* compileChild(this.#lowerFileStoreTask(expression));
    }
    if (isLockCall(expression) && expression.kind === "callExpression") {
      return yield* compileChild(this.#lowerLockTask(expression));
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
        this.lowerOrderedExpressionsTask(tagQueryOperands(expression)),
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
      this.emitsInstructions(expression)
    ) {
      return yield* compileChild(this.#lowerLogicalExpressionTask(expression));
    }
    if (
      expression.kind === "binaryExpression" &&
      expression.operator === "otherwise" &&
      this.emitsInstructions(expression.right)
    ) {
      return yield* compileChild(this.#lowerFallbackTask(expression));
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "durationLiteral":
      case "regexLiteral":
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
          this.lowerOrderedExpressionsTask(interpolations),
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
        if (expression.name === "speaker" && this.contextualSpeakerTemporary !== null) {
          return {
            plan: {
              kind: "temporary",
              temporaryId: this.contextualSpeakerTemporary,
              span: copySpan(expression.span),
            },
            temporaryIds: [],
          };
        }
        return { plan: compileExpression(expression, this.typeChecks), temporaryIds: [] };
      case "parenthesizedExpression":
        return yield* compileChild(this.lowerExpressionTask(expression.expression));
      case "listLiteral":
      case "setLiteral":
        return yield* compileChild(this.#lowerCollectionExpressionTask(expression));
      case "objectLiteral":
        return yield* compileChild(this.#lowerCollectionExpressionTask(expression));
      case "dictLiteral": {
        // Each key is evaluated before its value, in source order.
        const parts = yield* compileChild(
          this.lowerOrderedExpressionsTask(
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
        if (isPlayerProfile(expression.object))
          return {
            plan: {
              kind: "playerProfileField",
              name: expression.property.name,
              span: copySpan(expression.span),
            },
            temporaryIds: [],
          };
        const object = yield* compileChild(this.lowerExpressionTask(expression.object));
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
        let object = yield* compileChild(this.lowerExpressionTask(expression.object));
        if (this.emitsInstructions(expression.index)) {
          object = this.#prepareReferenceExpression(object, expression.object.span);
        }
        const index = yield* compileChild(this.lowerExpressionTask(expression.index));
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
        const lazy = lazyDefaultArgument(expression);
        // A `default:` that runs as instructions runs after the call, and only when the call needs it.
        if (lazy === null || !this.emitsInstructions(lazy.argument.value))
          return yield* compileChild(this.#lowerCallTask(expression, null));
        const call = yield* compileChild(this.#lowerCallTask(expression, lazy.argument));
        const span = copySpan(expression.span);
        const lowered = yield* compileChild(
          this.#lowerLazyDefaultTask(
            (temporaryId, defaultTemporary) => {
              this.instructions.push({
                kind: "storeTemporary",
                temporaryId,
                value: call.plan,
                expectBoolean: false,
                defaultTemporary,
                span,
              });
            },
            lazy.argument.value,
            { defaultOf: lazy.operation, ...withTypeCheck(this.typeChecks.get(expression)) },
            expression,
          ),
        );
        return {
          plan: lowered.plan,
          temporaryIds: [...call.temporaryIds, ...lowered.temporaryIds],
        };
      }
      case "unaryExpression": {
        const normalized = normalizeUnaryExpression(expression);
        const operand = yield* compileChild(this.lowerExpressionTask(normalized.operand));
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
      case "unitExpression": {
        const operand = yield* compileChild(this.lowerExpressionTask(expression.operand));
        return {
          plan: {
            kind: "unit",
            operand: operand.plan,
            ...unitOf(expression),
            span: copySpan(expression.span),
          },
          temporaryIds: operand.temporaryIds,
        };
      }
      case "angleExpression": {
        const operand = yield* compileChild(this.lowerExpressionTask(expression.operand));
        return {
          plan: {
            kind: "angleUnit",
            operand: operand.plan,
            unit: expression.unit,
            span: copySpan(expression.span),
          },
          temporaryIds: operand.temporaryIds,
        };
      }
      case "binaryExpression": {
        const leftExpression = expression.left;
        const rightExpression = expression.right;
        if (
          this.contextualSpeakerTemporary === null &&
          !this.emitsInstructions(leftExpression) &&
          !this.emitsInstructions(rightExpression)
        ) {
          return { plan: compileExpression(expression, this.typeChecks), temporaryIds: [] };
        }
        const [left, right] = yield* compileChild(
          this.lowerOrderedExpressionsTask([leftExpression, rightExpression]),
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
          this.lowerOrderedExpressionsTask([expression.start, expression.end]),
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
        const value = yield* compileChild(this.lowerExpressionTask(expression.value));
        return { plan: typeTestPlan(expression, value.plan), temporaryIds: value.temporaryIds };
      }
    }
  }

  /**
   * A call that may use the Player's file store (V30 §13 and §33). Its arguments are evaluated in written order into
   * temporaries, unless they are literals, so that the instruction reads the same values when it runs again with the
   * Player's answer; they are cleared once it gave its result. Its `default:` runs after it, only when it is used.
   */
  *#lowerFileStoreTask(
    expression: Extract<Expression, { kind: "callExpression" }>,
  ): CompileTask<LoweredExpression> {
    if (expression.callee.kind !== "identifier")
      throw new TypeError("A file store call reached lowering without its name.");
    const call = expression.callee.name;
    const conversion = isConversion(call) && takesFiles(call);
    if (call !== "fileFromBase64" && call !== "fileToBase64" && call !== "hashFile" && !conversion)
      throw new TypeError(`'${call}' is not a file store call.`);
    // The default runs only when it is used, as instructions after the call.
    const lazy = lazyDefaultArgument(expression);
    const written = expression.arguments.filter((argument) => argument !== lazy?.argument);
    const lowered = yield* compileChild(
      this.lowerOrderedExpressionsTask(written.map((argument) => argument.value)),
    );
    const operands: Record<"value" | "files", ExpressionPlan | null> = { value: null, files: null };
    const temporaryIds: number[] = [];
    written.forEach((argument, index) => {
      const operand = lowered[index]!;
      temporaryIds.push(...operand.temporaryIds);
      let plan = operand.plan;
      if (plan.kind !== "temporary" && plan.kind !== "literal") {
        const temporaryId = this.allocateTemporary();
        this.instructions.push({
          kind: "storeTemporary",
          temporaryId,
          value: plan,
          expectBoolean: false,
          span: copySpan(argument.value.span),
        });
        temporaryIds.push(temporaryId);
        plan = { kind: "temporary", temporaryId, span: copySpan(argument.value.span) };
      }
      const name = argument.kind === "positionalArgument" ? "value" : argument.name.name;
      if (name !== "value" && name !== "files")
        throw new TypeError(`${call}(...) reached lowering with '${name}:'.`);
      operands[name] = plan;
    });
    const value = operands.value;
    if (value === null) throw new TypeError(`${call}(...) reached lowering without its value.`);
    const store = (destinationTemporary: number, defaultTemporary: number | null): void => {
      this.instructions.push({
        kind: "fileStore",
        call,
        value,
        defaultTemporary,
        files: operands.files,
        destinationTemporary,
        span: copySpan(expression.span),
      });
      this.emitTemporaryCleanup(temporaryIds, expression.span);
    };
    if (lazy !== null)
      return yield* compileChild(
        this.#lowerLazyDefaultTask(
          store,
          lazy.argument.value,
          { defaultOf: lazy.operation },
          expression,
        ),
      );
    if (call === "fileFromBase64" || (conversion && takesDefault(call)))
      throw new TypeError(`${call}(...) reached lowering without its default:.`);
    const destinationTemporary = this.allocateTemporary();
    store(destinationTemporary, null);
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
   * `encryptText`, `encryptFile`, `decryptText`, or `decryptFile` (V30 §13). Like a file store call, its arguments are
   * evaluated in written order into temporaries, unless they are literals, so that every run of the instruction reads the
   * same values; they are cleared once it gave its result. A decrypt call's default runs only when it is used, as
   * instructions after the call.
   */
  *#lowerLockTask(
    expression: Extract<Expression, { kind: "callExpression" }>,
  ): CompileTask<LoweredExpression> {
    if (expression.callee.kind !== "identifier")
      throw new TypeError("A lock call reached lowering without its name.");
    const call = expression.callee.name;
    if (
      call !== "encryptText" &&
      call !== "encryptFile" &&
      call !== "decryptText" &&
      call !== "decryptFile"
    )
      throw new TypeError(`'${call}' is not a lock call.`);
    const lazy = lazyDefaultArgument(expression);
    const written = expression.arguments.filter((argument) => argument !== lazy?.argument);
    const operands: Record<
      "value" | "password" | "publicKey" | "key" | "timeLock",
      ExpressionPlan | null
    > = { value: null, password: null, publicKey: null, key: null, timeLock: null };
    const temporaryIds: number[] = [];
    let passwordField: LockInstruction["passwordField"] = null;
    // A password field written directly says its question where `password:` stands; the arguments before it are kept
    // in temporaries first, and those after it are evaluated after the question.
    const fieldIndex = written.findIndex(
      (argument) =>
        argument.kind === "namedArgument" &&
        argument.name.name === "password" &&
        directPasswordField(argument.value) !== null,
    );
    const groups =
      fieldIndex === -1 ? [written] : [written.slice(0, fieldIndex), written.slice(fieldIndex + 1)];
    for (const [group, part] of groups.entries()) {
      if (group === 1) {
        const field = directPasswordField(written[fieldIndex]!.value)!;
        const speakerTemporary = prepareInteractionSpeaker(
          this,
          field.speaker?.name ?? null,
          field.asSpan ?? field.commandSpan,
        );
        const { hint } = yield* compileChild(lowerAskQuestionTask(this, field, speakerTemporary));
        temporaryIds.push(speakerTemporary, ...(hint === null ? [] : [hint.temporaryId]));
        passwordField = {
          hint:
            hint === null
              ? null
              : {
                  kind: "temporary",
                  temporaryId: hint.temporaryId,
                  span: copySpan(field.hint!.span),
                },
        };
      }
      const lowered = yield* compileChild(
        this.lowerOrderedExpressionsTask(part.map((argument) => argument.value)),
      );
      part.forEach((argument, index) => {
        const operand = lowered[index]!;
        temporaryIds.push(...operand.temporaryIds);
        let plan = operand.plan;
        if (plan.kind !== "temporary" && plan.kind !== "literal") {
          const temporaryId = this.allocateTemporary();
          this.instructions.push({
            kind: "storeTemporary",
            temporaryId,
            value: plan,
            expectBoolean: false,
            span: copySpan(argument.value.span),
          });
          temporaryIds.push(temporaryId);
          plan = { kind: "temporary", temporaryId, span: copySpan(argument.value.span) };
        }
        const name = argument.kind === "positionalArgument" ? "value" : argument.name.name;
        if (
          name !== "value" &&
          name !== "password" &&
          name !== "publicKey" &&
          name !== "key" &&
          name !== "timeLock"
        )
          throw new TypeError(`${call}(...) reached lowering with '${name}:'.`);
        operands[name] = plan;
      });
    }
    const value = operands.value;
    if (value === null) throw new TypeError(`${call}(...) reached lowering without its value.`);
    const lock = (destinationTemporary: number, defaultTemporary: number | null): void => {
      this.instructions.push({
        kind: "lock",
        call,
        value,
        password: operands.password,
        passwordField,
        publicKey: operands.publicKey,
        key: operands.key,
        timeLock: operands.timeLock,
        defaultTemporary,
        destinationTemporary,
        span: copySpan(expression.span),
      });
      this.emitTemporaryCleanup(temporaryIds, expression.span);
    };
    if (lazy !== null)
      return yield* compileChild(
        this.#lowerLazyDefaultTask(
          lock,
          lazy.argument.value,
          { defaultOf: lazy.operation },
          expression,
        ),
      );
    if (call === "decryptText" || call === "decryptFile")
      throw new TypeError(`${call}(...) reached lowering without its default:.`);
    const destinationTemporary = this.allocateTemporary();
    lock(destinationTemporary, null);
    return {
      plan: {
        kind: "temporary",
        temporaryId: destinationTemporary,
        span: copySpan(expression.span),
      },
      temporaryIds: [destinationTemporary],
    };
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
      const index = this.materializeExpression(
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

  public materializeExpression(lowered: LoweredExpression, span: SourceSpan): LoweredExpression {
    const temporaryId = this.allocateTemporary();
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
    const temporaryId = this.allocateTemporary();
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

  public *lowerOrderedExpressionsTask(
    expressions: readonly Expression[],
    materializeInstructionEmitting = false,
  ): CompileTask<LoweredExpression[]> {
    const emitsInstructions = expressions.map((expression) => this.emitsInstructions(expression));
    const laterEmitsInstructions = new Array<boolean>(expressions.length);
    let suffixEmitsInstructions = false;
    for (let index = expressions.length - 1; index >= 0; index -= 1) {
      laterEmitsInstructions[index] = suffixEmitsInstructions;
      if (emitsInstructions[index]) suffixEmitsInstructions = true;
    }

    const lowered: LoweredExpression[] = [];
    for (let index = 0; index < expressions.length; index += 1) {
      const expression = expressions[index]!;
      let item = yield* compileChild(this.lowerExpressionTask(expression));
      if (
        laterEmitsInstructions[index] ||
        (materializeInstructionEmitting && emitsInstructions[index])
      ) {
        item =
          item.plan.kind === "temporary" ? item : this.materializeExpression(item, expression.span);
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
    const elements = yield* compileChild(this.lowerOrderedExpressionsTask(children));
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
      this.lowerOrderedExpressionsTask(
        expression.arguments.map((argument) => argument.value),
        true,
      ),
    );
    expression.arguments.forEach((argument, index) => {
      const lowered = loweredArguments[index]!;
      for (const temporaryId of lowered.temporaryIds) temporaryIds.push(temporaryId);
      const parameterName = boundParameterName(registered.declaration.parameters, argument, index);
      if (parameterName === undefined) {
        throw new InstructionCompilationError(
          "TSC003",
          `Function '${name}' has no parameter for positional argument ${index + 1}.`,
          argument.span,
        );
      }
      planned.push({
        parameterName,
        value: lowered.plan,
        span: copySpan(argument.span),
        ...withTypeCheck(this.typeChecks.get(argument)),
      });
    });
    const destinationTemporary = this.allocateTemporary();
    const callIndex = this.instructions.length;
    if (registered.id === null) this.project.foreignCalls.push({ instruction: callIndex, name });
    this.instructions.push({
      kind: "callFunction",
      functionId: registered.id ?? 0,
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
   * A call of a function or method other than the script's own; `omitted` is a `default:` left out to run after the call
   * as instructions (see `#lowerLazyDefaultTask`).
   */
  *#lowerCallTask(
    expression: Extract<Expression, { kind: "callExpression" }>,
    omitted: NamedArgument | null,
  ): CompileTask<LoweredExpression> {
    const written = expression.arguments.filter((argument) => argument !== omitted);
    let callee: LoweredExpression;
    // Grouping a method does not detach it from its receiver: `(text.trim)()` calls `text.trim()`.
    const method = unwrapParentheses(expression.callee);
    if (method.kind === "propertyAccessExpression") {
      let receiver = yield* compileChild(this.lowerExpressionTask(method.object));
      if (written.some((argument) => this.emitsInstructions(argument.value))) {
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
      callee = yield* compileChild(this.lowerExpressionTask(expression.callee));
    }
    const loweredArguments = yield* compileChild(
      this.lowerOrderedExpressionsTask(written.map((argument) => argument.value)),
    );
    const argumentsList = written.map((argument, index) => ({
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
        // The check of a `get` default goes with the default.
        ...(omitted === null ? withTypeCheck(this.typeChecks.get(expression)) : {}),
        span: copySpan(expression.span),
      },
      temporaryIds: [
        ...callee.temporaryIds,
        ...argumentsList.flatMap((item) => item.lowered.temporaryIds),
      ],
    };
  }

  /**
   * A `default:` that runs instructions, such as an ask, runs only when it is used (owner decision, 2026-10-16). `probe`
   * runs the call or `load` without it, into the result's temporary, and says in the other temporary whether it needs
   * the default. Only then do the default's instructions run, and its value takes the result's place, checked by
   * `accept` as the call checks a default or as the load's result.
   */
  *#lowerLazyDefaultTask(
    probe: (temporaryId: number, defaultTemporary: number) => void,
    defaultValue: Expression,
    accept: Pick<StoreTemporaryInstruction, "defaultOf" | "typeCheck">,
    origin: Extract<ControlOrigin, { kind: "default" }>["expression"],
  ): CompileTask<LoweredExpression> {
    const resultTemporary = this.allocateTemporary();
    const defaultTemporary = this.allocateTemporary();
    probe(resultTemporary, defaultTemporary);
    const span = copySpan(origin.span);
    const conditional = this.instructions.length;
    const conditionalInstruction: JumpIfFalseInstruction = {
      kind: "jumpIfFalse",
      condition: { kind: "temporary", temporaryId: defaultTemporary, span },
      target: -1,
      span,
    };
    this.instructions.push(conditionalInstruction);
    this.#originate(conditional, { kind: "default", expression: origin });
    const lowered = yield* compileChild(this.lowerExpressionTask(defaultValue));
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: lowered.plan,
      expectBoolean: false,
      ...accept,
      span: copySpan(defaultValue.span),
    });
    this.instructions[conditional] = {
      ...conditionalInstruction,
      target: this.instructions.length,
    };
    return {
      plan: { kind: "temporary", temporaryId: resultTemporary, span },
      temporaryIds: [...lowered.temporaryIds, defaultTemporary, resultTemporary],
    };
  }

  /**
   * Lowers `load`. A default that emits instructions runs only when the key is absent, or holds a value that does not
   * fit the load's type. Any other default stays lazy inside the load plan.
   */
  *#lowerLoadTask(
    expression: Extract<Expression, { kind: "loadExpression" }>,
  ): CompileTask<LoweredExpression> {
    const key = yield* compileChild(this.lowerExpressionTask(expression.key));
    const defaultValue = expression.defaultValue;
    const type = this.typeChecks.get(expression)?.type ?? null;
    if (defaultValue === null || !this.emitsInstructions(defaultValue)) {
      const lowered =
        defaultValue === null ? null : yield* compileChild(this.lowerExpressionTask(defaultValue));
      return {
        plan: {
          kind: "storageLoad",
          key: key.plan,
          default: lowered?.plan ?? null,
          type,
          span: copySpan(expression.span),
        },
        temporaryIds: [...key.temporaryIds, ...(lowered?.temporaryIds ?? [])],
      };
    }
    // The default takes the place of the stored value, so it fits the load's type, or is null.
    const check = this.typeChecks.get(expression);
    const lowered = yield* compileChild(
      this.#lowerLazyDefaultTask(
        (temporaryId, defaultTemporary) => {
          this.instructions.push({
            kind: "storeTemporary",
            temporaryId,
            value: {
              kind: "storageLoad",
              key: key.plan,
              default: null,
              type,
              span: copySpan(expression.span),
            },
            expectBoolean: false,
            defaultTemporary,
            span: copySpan(expression.span),
          });
        },
        defaultValue,
        check === undefined
          ? {}
          : {
              typeCheck: {
                type: { kind: "union", members: [check.type, { kind: "null" }] },
                place: check.place,
              },
            },
        expression,
      ),
    );
    return { plan: lowered.plan, temporaryIds: [...key.temporaryIds, ...lowered.temporaryIds] };
  }

  /**
   * `a otherwise b` whose fallback runs as instructions, such as an ask: the value waits in a temporary, and the fallback
   * runs only when it is null and then takes its place, as a `load` default does (V30 §18).
   */
  *#lowerFallbackTask(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
  ): CompileTask<LoweredExpression> {
    const left = yield* compileChild(this.lowerExpressionTask(expression.left));
    const resultTemporary = this.allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: left.plan,
      expectBoolean: false,
      span: copySpan(expression.left.span),
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
    this.#originate(conditional, { kind: "operand", expression });
    const right = yield* compileChild(this.lowerExpressionTask(expression.right));
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId: resultTemporary,
      value: right.plan,
      expectBoolean: false,
      span: copySpan(expression.right.span),
    });
    this.instructions[conditional] = {
      ...conditionalInstruction,
      target: this.instructions.length,
    };
    return {
      plan: result,
      temporaryIds: [...left.temporaryIds, ...right.temporaryIds, resultTemporary],
    };
  }

  *#lowerLogicalExpressionTask(
    expression: Extract<Expression, { kind: "binaryExpression" }>,
  ): CompileTask<LoweredExpression> {
    const left = yield* compileChild(this.lowerExpressionTask(expression.left));
    const resultTemporary = this.allocateTemporary();
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
      this.#originate(conditional, { kind: "operand", expression });
      const right = yield* compileChild(this.lowerExpressionTask(expression.right));
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
    this.#originate(conditional, { kind: "operand", expression });
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
    const right = yield* compileChild(this.lowerExpressionTask(expression.right));
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

  /**
   * Whether `expression` runs instructions, so it cannot be one expression plan: it holds an interaction, a `say`, a
   * button, popup, timer, media, or camera command, a photo or image ask, a file store or lock call, or a call of a user
   * function. Its lowering keeps the operands before it in temporaries and evaluates them in order.
   */
  public emitsInstructions(expression: Expression): boolean {
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
        current.expression.kind === "sayExpression" ||
        current.expression.kind === "showButtonExpression" ||
        current.expression.kind === "showPopupExpression" ||
        current.expression.kind === "timerExpression" ||
        current.expression.kind === "playMediaExpression" ||
        current.expression.kind === "showCameraExpression" ||
        current.expression.kind === "showPermanentButtonExpression"
      ) {
        this.#instructionEmissionByExpression.set(current.expression, true);
        continue;
      }
      if (
        isTakePhotoCall(current.expression) ||
        isAskImageCall(current.expression) ||
        isFileStoreCall(current.expression) ||
        isLockCall(current.expression) ||
        (current.expression.kind === "callExpression" &&
          current.expression.callee.kind === "identifier" &&
          this.#functionByName.has(current.expression.callee.name))
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

  public allocateTemporary(): number {
    const id = this.counters.nextTemporaryId;
    this.counters.nextTemporaryId += 1;
    return id;
  }

  public emitTemporaryCleanup(ids: readonly number[], span: SourceSpan): void {
    for (const temporaryId of new Set(ids)) {
      this.instructions.push({ kind: "clearTemporary", temporaryId, span: copySpan(span) });
    }
  }
}

export interface LoweredExpression {
  readonly plan: ExpressionPlan;
  readonly temporaryIds: readonly number[];
}
