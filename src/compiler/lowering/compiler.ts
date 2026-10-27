import type {
  Block,
  Expression,
  MediaParts,
  FunctionDeclaration,
  GlobalStatement,
  ListLiteral,
  ObjectLiteral,
  SetLiteral,
  Statement,
  InteractionExpression,
  SpeakerDeclaration,
  IfStatement,
  SwitchStatement,
  FileTarget,
  ScriptTarget,
} from "../../ast.js";
import type { SourceSpan } from "../../source.js";
import type {
  AssignmentTargetPlan,
  CompiledFunctionDefinition,
  ExpressionPlan,
  Instruction,
  PrepareParameterDefaultInstruction,
  TemplatePartPlan,
  TypeCheckPlan,
  PreparedFormShape,
  PlanLabel,
} from "../../plan/model.js";
import { copiesPlayerProfile } from "../../project-globals.js";
import {
  isAskImageCall,
  isFileStoreCall,
  isLockCall,
  isTakePhotoCall,
} from "../../capture-call.js";
import { lazyDefaultArgument } from "../../lazy-defaults.js";
import {
  NO_CORE_CHECKS,
  type CoreRuntimeChecks,
  type RuntimeCheckSite,
} from "../../type-inference/backend.js";
import { runCompileTask, compileChild, type CompileTask } from "../continuation.js";
import {
  expressionChildren as instructionEmissionChildren,
  tagQueryOperands,
} from "../../expression-children.js";
import {
  lowerShowButtonTask,
  lowerShowPopupTask,
  lowerOpenUrlTask,
  lowerExportTextTask,
  consumeInteractionResult,
} from "./interactions.js";
import { lowerInteractionTask, lowerAskImageTask } from "./asks.js";
import { lowerSayTask } from "./say.js";
import { lowerTimerTask, lowerPermanentButtonTask, lowerMediaTask } from "./background.js";
import {
  lowerUserFunctionCallTask,
  lowerCallTask,
  lowerLazyDefaultTask,
  lowerLoadTask,
} from "./calls.js";
import { lowerFileStoreTask, lowerLockTask } from "./file-store-and-lock.js";
import {
  compileIf,
  compileSwitch,
  compileLoop,
  lowerFallbackTask,
  lowerLogicalExpressionTask,
} from "./control-flow.js";
import {
  isPlayerProfile,
  unwrapParentheses,
  normalizeUnaryExpression,
  compileExpression,
  withTypeCheck,
  withFallbackCheck,
  repairedBy,
  unitOf,
  planSpan,
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
  public readonly loops: Array<{
    readonly loopId: number;
    readonly continueTarget: number;
    readonly breaks: number[];
  }> = [];

  /** The functions this file may call: its own, with their IDs, and the global functions of other files. */
  public readonly functionByName: ReadonlyMap<
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
      const lowered = this.lowerExpression(target.expression);
      this.instructions.push({
        kind: "transfer",
        mode,
        destination: { value: lowered.plan },
        span: planSpan(span),
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
      span: planSpan(span),
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
    public readonly typeChecks: ReadonlyMap<RuntimeCheckSite, TypeCheckPlan> = new Map(),
    public readonly instructions: Instruction[] = [],
    public readonly functions: CompiledFunctionDefinition[] = [],
    public readonly counters: LoweringCounters = { nextLoopId: 1, nextTemporaryId: 1 },
    public readonly project: ProjectFunctions = { global: new Map(), foreignCalls: [] },
    /** The files each glob target may pick, from semantic validation. */
    private readonly picks: ReadonlyMap<FileTarget, readonly string[]> = new Map(),
    /** The variables each timer, media, or button block shares with the code that created it. */
    public readonly captures: ReadonlyMap<Block, readonly string[]> = new Map(),
    /** The result shape of each `askForm`, from the type check. */
    public readonly formShapes: ReadonlyMap<InteractionExpression, PreparedFormShape> = new Map(),
    /** Receives the trace of the lowering, when an analysis asks for it. */
    private readonly trace: LoweringTrace | null = null,
    /** The runtime checks only the coarse core owes, which legacy results do not have. */
    public readonly coreChecks: CoreRuntimeChecks = NO_CORE_CHECKS,
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
    this.functionByName = functionByName;
  }

  public originate(instruction: number, origin: ControlOrigin): void {
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
        value: compileExpression(declaration.initial, this.typeChecks, this.coreChecks),
        ...withTypeCheck(this.typeChecks.get(declaration)),
        file,
        span: planSpan(declaration.span),
      });
      return;
    }
    this.instructions.push({
      kind: "declareSpeaker",
      name: declaration.name.name,
      properties: declaration.properties.map((property) => ({
        name: property.name.name,
        value: compileExpression(property.value, this.typeChecks, this.coreChecks),
        span: planSpan(property.span),
      })),
      file,
      span: planSpan(declaration.span),
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

  /**
   * Timer expiry blocks, media cue blocks, and permanent-button blocks, compiled after the user functions in
   * registration order.
   */
  readonly #handlers: RegisteredHandler[] = [];

  /** The `let` name that a media initializer binds in its own blocks. */
  public readonly selfHandleByInitializer = new Map<MediaParts, string>();

  public compileStatements(statements: readonly Statement[]): void {
    runCompileTask(this.compileStatementsTask(statements));
  }

  public *compileStatementsTask(statements: readonly Statement[]): CompileTask<void> {
    for (const statement of statements) yield* compileChild(this.compileStatement(statement));
  }

  public *compileStatement(statement: Statement): CompileTask<void> {
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
          yield* compileChild(this.compileStatement(statement.assignment));
        return;
      case "speakerSetterStatement":
        this.instructions.push({
          kind: "setDefaultSpeaker",
          name: statement.speaker.name,
          span: planSpan(statement.span),
        });
        return;
      case "sayStatement":
        yield* compileChild(lowerSayTask(this, statement, false));
        return;
      case "showButtonStatement":
        yield* compileChild(lowerShowButtonTask(this, statement, false));
        return;
      case "waitStatement": {
        const lowered = this.lowerExpression(statement.duration);
        this.instructions.push({
          kind: "wait",
          command: "wait",
          duration: lowered.plan,
          unit: statement.unit,
          display: "hidden",
          label: null,
          span: planSpan(statement.span),
        });
        this.emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "timerStatement":
        yield* compileChild(lowerTimerTask(this, statement, false));
        return;
      case "showPermanentButtonStatement":
        yield* compileChild(lowerPermanentButtonTask(this, statement, false));
        return;
      case "playMediaStatement":
        yield* compileChild(lowerMediaTask(this, statement, false));
        return;
      case "stopAudioStatement":
        this.instructions.push({ kind: "stopAudio", span: planSpan(statement.span) });
        return;
      case "showImageStatement": {
        const lowered = this.lowerExpression(statement.image);
        this.instructions.push({
          kind: "showImage",
          image: lowered.plan,
          span: planSpan(statement.span),
        });
        this.emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "hideImageStatement":
        this.instructions.push({ kind: "showImage", image: null, span: planSpan(statement.span) });
        return;
      case "showCameraStatement":
        this.#lowerShowCamera(statement.placement, false, statement.span);
        return;
      case "hideCameraStatement":
        this.instructions.push({ kind: "hideCamera", span: planSpan(statement.span) });
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
          span: planSpan(statement.span),
        });
        this.emitTemporaryCleanup([...value!.temporaryIds, ...key!.temporaryIds], statement.span);
        return;
      }
      case "deleteStatement": {
        const key = this.lowerExpression(statement.key);
        this.instructions.push({
          kind: "storageWrite",
          value: null,
          key: key.plan,
          span: planSpan(statement.span),
        });
        this.emitTemporaryCleanup(key.temporaryIds, statement.span);
        return;
      }
      case "exitStatement":
        this.instructions.push({ kind: "exit", span: planSpan(statement.span) });
        return;
      case "endStatement":
        this.instructions.push({ kind: "end", span: planSpan(statement.span) });
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
          this.instructions.push({ kind: "goto", target: -1, span: planSpan(statement.span) });
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
          this.selfHandleByInitializer.set(initializer, statement.name.name);
        }
        const lowered = this.lowerExpression(statement.initializer);
        this.instructions.push({
          kind: "declareBinding",
          name: statement.name.name,
          value: lowered.plan,
          ...withTypeCheck(this.typeChecks.get(statement)),
          span: planSpan(statement.span),
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
            span: planSpan(statement.target.span),
          });
        }
        // A compound assignment reads the current value before any instruction-emitting operand runs. `+=` reads it
        // through a reference, which holds a list until something may change it, so that a list nothing changed is
        // joined in place instead of copied (`currentValueTemporaries` of the runtime).
        const current =
          statement.operator === "=" || !this.emitsInstructions(statement.value)
            ? null
            : statement.operator === "+="
              ? this.prepareReferenceExpression(
                  { plan: target.plan, temporaryIds: [] },
                  statement.target.span,
                )
              : this.materializeExpression(
                  { plan: target.plan, temporaryIds: [] },
                  statement.target.span,
                );
        const value = this.lowerExpression(statement.value);
        const assigned: ExpressionPlan =
          statement.operator === "="
            ? value.plan
            : {
                kind: "binary",
                operator: statement.operator === "+=" ? "+" : "-",
                left: current?.plan ?? target.plan,
                right: value.plan,
                span: planSpan(statement.span),
              };
        this.instructions.push({
          kind: "assign",
          target: target.plan,
          value: assigned,
          ...withTypeCheck(this.typeChecks.get(statement)),
          ...(this.coreChecks.requireExisting.has(statement)
            ? { requireExisting: true as const }
            : {}),
          span: planSpan(statement.span),
        });
        this.emitTemporaryCleanup(
          [...target.temporaryIds, ...(current?.temporaryIds ?? []), ...value.temporaryIds],
          statement.span,
        );
        return;
      }
      case "expressionStatement": {
        if (copiesPlayerProfile(statement.expression)) {
          this.instructions.push({ kind: "copyPlayerProfile", span: planSpan(statement.span) });
          return;
        }
        const lowered = this.lowerExpression(statement.expression);
        this.instructions.push({
          kind: "evaluate",
          expression: lowered.plan,
          span: planSpan(statement.span),
        });
        this.emitTemporaryCleanup(lowered.temporaryIds, statement.span);
        return;
      }
      case "ifStatement":
        yield* compileChild(compileIf(this, statement));
        return;
      case "switchStatement":
        yield* compileChild(compileSwitch(this, statement));
        return;
      case "repeatStatement":
        yield* compileChild(
          compileLoop(
            this,
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
          compileLoop(
            this,
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
          compileLoop(
            this,
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
        const loop = this.loops.at(-1);
        if (loop === undefined) {
          throw new TypeError("Semantically invalid loop control reached compilation.");
        }
        const index = this.instructions.length;
        this.instructions.push({
          kind: "loopControl",
          action: statement.kind === "breakStatement" ? "break" : "continue",
          loopId: loop.loopId,
          target: statement.kind === "breakStatement" ? -1 : loop.continueTarget,
          span: planSpan(statement.span),
        });
        if (statement.kind === "breakStatement") loop.breaks.push(index);
        return;
      }
      case "returnStatement": {
        if (statement.value === null) {
          this.instructions.push({ kind: "returnVoid", span: planSpan(statement.span) });
          return;
        }
        const lowered = this.lowerExpression(statement.value);
        this.instructions.push({
          kind: "returnValue",
          value: lowered.plan,
          ...withTypeCheck(this.typeChecks.get(statement)),
          span: planSpan(statement.span),
        });
        return;
      }
      case "functionDeclaration":
        throw new TypeError("Nested function declaration reached compilation.");
    }
    statement satisfies never;
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
      span: planSpan(span),
    });
    return destinationTemporary === null
      ? null
      : {
          plan: { kind: "temporary", temporaryId: destinationTemporary, span: planSpan(span) },
          temporaryIds: [destinationTemporary],
        };
  }

  /** Reserves the next function ID; the region is compiled after all user functions. */
  public registerHandler(
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
      span: planSpan(handler.span),
    });
    this.instructions.push({
      kind: "enterFunctionBody",
      functionId: id,
      span: planSpan(handler.span),
    });
    const bodyEntryInstruction = this.instructions.length;
    this.compileStatements(handler.statements);
    const implicitReturnInstruction = this.instructions.length;
    this.instructions.push({ kind: "returnVoid", span: planSpan(handler.span) });
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
      declarationSpan: planSpan(handler.span),
      parameters: [],
      entryInstruction,
      bodyEntryInstruction,
      implicitReturnInstruction,
      endInstruction: this.instructions.length,
      bodySpan: planSpan(handler.span),
    });
  }

  #compileFunction(declaration: FunctionDeclaration): void {
    const own = this.functionByName.get(declaration.name.name);
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
        span: planSpan(parameter.span),
      });
    });
    this.instructions.push({
      kind: "beginFunctionDefaults",
      functionId: registered.id,
      span: planSpan(declaration.span),
    });
    declaration.parameters.forEach((parameter, parameterIndex) => {
      const prepareIndex = this.instructions.length;
      const prepareInstruction: PrepareParameterDefaultInstruction = {
        kind: "prepareParameterDefault",
        functionId: registered.id,
        parameterIndex,
        target: -1,
        span: planSpan(parameter.span),
      };
      this.instructions.push(prepareInstruction);
      if (parameter.defaultValue !== null) {
        const lowered = this.lowerExpression(parameter.defaultValue);
        this.instructions.push({
          kind: "bindDefaultParameter",
          functionId: registered.id,
          parameterIndex,
          value: lowered.plan,
          ...withTypeCheck(this.typeChecks.get(parameter)),
          span: planSpan(parameter.span),
        });
        this.emitTemporaryCleanup(lowered.temporaryIds, parameter.span);
      }
      this.instructions[prepareIndex] = { ...prepareInstruction, target: this.instructions.length };
    });
    this.instructions.push({
      kind: "enterFunctionBody",
      functionId: registered.id,
      span: planSpan(declaration.body.span),
    });
    const bodyEntryInstruction = this.instructions.length;
    this.compileStatements(declaration.body.statements);
    const implicitReturnInstruction = this.instructions.length;
    this.instructions.push({ kind: "returnVoid", span: planSpan(declaration.body.span) });
    const endInstruction = this.instructions.length;
    this.functions.push({
      id: registered.id,
      handler: null,
      global: declaration.global,
      selfHandle: null,
      name: declaration.name.name,
      declarationSpan: planSpan(declaration.span),
      parameters: declaration.parameters.map((parameter, index) => ({
        name: parameter.name.name,
        index,
        hasDefault: parameter.defaultValue !== null,
        declarationSpan: planSpan(parameter.span),
        defaultSpan: parameter.defaultValue === null ? null : planSpan(parameter.defaultValue.span),
      })),
      entryInstruction,
      bodyEntryInstruction,
      implicitReturnInstruction,
      endInstruction,
      bodySpan: planSpan(declaration.body.span),
    });
  }

  public lowerExpression(expression: Expression): LoweredExpression {
    return runCompileTask(this.lowerExpressionTask(expression));
  }

  public *lowerExpressionTask(expression: Expression): CompileTask<LoweredExpression> {
    expression = unwrapParentheses(expression);
    if (this.contextualSpeakerTemporary === null && !this.emitsInstructions(expression))
      return {
        plan: compileExpression(expression, this.typeChecks, this.coreChecks),
        temporaryIds: [],
      };
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
      const lowered = yield* compileChild(lowerTimerTask(this, expression, true));
      if (lowered === null) throw new TypeError("A blocking timer reached value lowering.");
      return lowered;
    }
    if (expression.kind === "playMediaExpression") {
      const lowered = yield* compileChild(lowerMediaTask(this, expression, true));
      if (lowered === null) throw new TypeError("Blocking media reached value lowering.");
      return lowered;
    }
    if (expression.kind === "showCameraExpression") {
      const lowered = this.#lowerShowCamera(expression.placement, true, expression.span);
      if (lowered === null) throw new TypeError("A camera view lowered without a handle.");
      return lowered;
    }
    if (expression.kind === "showPermanentButtonExpression") {
      const lowered = yield* compileChild(lowerPermanentButtonTask(this, expression, true));
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
        span: planSpan(expression.span),
      });
      const result = consumeInteractionResult(this, transientTemporary, expression.span);
      if (tags !== null) this.emitTemporaryCleanup(tags.temporaryIds, expression.span);
      return result;
    }
    if (isFileStoreCall(expression) && expression.kind === "callExpression") {
      return yield* compileChild(lowerFileStoreTask(this, expression));
    }
    if (isLockCall(expression) && expression.kind === "callExpression") {
      return yield* compileChild(lowerLockTask(this, expression));
    }
    if (
      expression.kind === "callExpression" &&
      expression.callee.kind === "identifier" &&
      this.functionByName.has(expression.callee.name)
    ) {
      return yield* compileChild(lowerUserFunctionCallTask(this, expression));
    }
    if (expression.kind === "loadExpression") {
      return yield* compileChild(lowerLoadTask(this, expression));
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
      return yield* compileChild(lowerLogicalExpressionTask(this, expression));
    }
    if (
      expression.kind === "binaryExpression" &&
      expression.operator === "otherwise" &&
      this.emitsInstructions(expression.right)
    ) {
      return yield* compileChild(lowerFallbackTask(this, expression));
    }
    switch (expression.kind) {
      case "booleanLiteral":
      case "nullLiteral":
      case "numberLiteral":
      case "durationLiteral":
      case "regexLiteral":
        return {
          plan: compileExpression(expression, this.typeChecks, this.coreChecks),
          temporaryIds: [],
        };
      case "stringLiteral": {
        const interpolations = expression.parts
          .filter((part) => part.kind === "stringInterpolation")
          .map((part) => part.expression);
        if (interpolations.length === 0) {
          return {
            plan: compileExpression(expression, this.typeChecks, this.coreChecks),
            temporaryIds: [],
          };
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
              : [{ kind: "text", value: part.value, span: planSpan(part.span) }];
          }
          const lowered = loweredInterpolations[interpolationIndex++]!;
          for (const temporaryId of lowered.temporaryIds) ids.push(temporaryId);
          return [{ kind: "expression", expression: lowered.plan, span: planSpan(part.span) }];
        });
        return {
          plan: { kind: "template", parts, span: planSpan(expression.span) },
          temporaryIds: ids,
        };
      }
      case "identifier":
        if (expression.name === "speaker" && this.contextualSpeakerTemporary !== null) {
          return {
            plan: {
              kind: "temporary",
              temporaryId: this.contextualSpeakerTemporary,
              span: planSpan(expression.span),
            },
            temporaryIds: [],
          };
        }
        return {
          plan: compileExpression(expression, this.typeChecks, this.coreChecks),
          temporaryIds: [],
        };
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
              span: planSpan(entry.span),
            })),
            span: planSpan(expression.span),
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
              span: planSpan(expression.span),
            },
            temporaryIds: [],
          };
        const object = yield* compileChild(this.lowerExpressionTask(expression.object));
        return {
          plan: {
            kind: "property",
            object: object.plan,
            name: expression.property.name,
            span: planSpan(expression.span),
          },
          temporaryIds: object.temporaryIds,
        };
      }
      case "indexExpression": {
        let object = yield* compileChild(this.lowerExpressionTask(expression.object));
        if (this.emitsInstructions(expression.index)) {
          object = this.prepareReferenceExpression(object, expression.object.span);
        }
        const index = yield* compileChild(this.lowerExpressionTask(expression.index));
        return {
          plan: {
            kind: "index",
            object: object.plan,
            index: index.plan,
            span: planSpan(expression.span),
          },
          temporaryIds: [...object.temporaryIds, ...index.temporaryIds],
        };
      }
      case "callExpression": {
        const lazy = lazyDefaultArgument(expression);
        // A `default:` that runs as instructions runs after the call, and only when the call needs it.
        if (lazy === null || !this.emitsInstructions(lazy.argument.value))
          return yield* compileChild(lowerCallTask(this, expression, null));
        const call = yield* compileChild(lowerCallTask(this, expression, lazy.argument));
        const span = planSpan(expression.span);
        const lowered = yield* compileChild(
          lowerLazyDefaultTask(
            this,
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
            {
              defaultOf: lazy.operation,
              ...withTypeCheck(this.typeChecks.get(expression)),
              ...withFallbackCheck(this.coreChecks.fallbackChecks.get(expression)),
              ...repairedBy(this.coreChecks.expected.get(expression)),
            },
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
            span: planSpan(expression.span),
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
            span: planSpan(expression.span),
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
            span: planSpan(expression.span),
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
          return {
            plan: compileExpression(expression, this.typeChecks, this.coreChecks),
            temporaryIds: [],
          };
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
            ...withFallbackCheck(this.coreChecks.fallbackChecks.get(expression)),
            span: planSpan(expression.span),
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
            span: planSpan(expression.span),
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

  #lowerAssignmentTarget(expression: Expression): {
    readonly plan: AssignmentTargetPlan;
    readonly temporaryIds: readonly number[];
  } {
    if (expression.kind === "identifier") {
      return {
        plan: { kind: "identifier", name: expression.name, span: planSpan(expression.span) },
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
          span: planSpan(expression.span),
        },
        temporaryIds: object.temporaryIds,
      };
    }
    if (expression.kind === "indexExpression") {
      const object = this.#lowerAssignmentObject(expression.object);
      const index = this.materializeExpression(
        this.lowerExpression(expression.index),
        expression.index.span,
      );
      return {
        plan: {
          kind: "index",
          object: object.plan,
          index: index.plan,
          span: planSpan(expression.span),
        },
        temporaryIds: [...object.temporaryIds, ...index.temporaryIds],
      };
    }
    throw new TypeError("AST assignment target is not assignable.");
  }

  #lowerAssignmentObject(expression: Expression): LoweredExpression {
    const lowered = this.lowerExpression(expression);
    return this.prepareReferenceExpression(lowered, expression.span);
  }

  public materializeExpression(lowered: LoweredExpression, span: SourceSpan): LoweredExpression {
    const temporaryId = this.allocateTemporary();
    this.instructions.push({
      kind: "storeTemporary",
      temporaryId,
      value: lowered.plan,
      expectBoolean: false,
      span: planSpan(span),
    });
    return {
      plan: { kind: "temporary", temporaryId, span: planSpan(span) },
      temporaryIds: [...lowered.temporaryIds, temporaryId],
    };
  }

  public prepareReferenceExpression(
    lowered: LoweredExpression,
    span: SourceSpan,
  ): LoweredExpression {
    if (lowered.plan.kind === "preparedReference") return lowered;
    const temporaryId = this.allocateTemporary();
    this.instructions.push({
      kind: "prepareReference",
      expression: lowered.plan,
      destinationTemporary: temporaryId,
      span: planSpan(span),
    });
    return {
      plan: { kind: "preparedReference", temporaryId, span: planSpan(span) },
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
                span: planSpan(property.span),
              })),
              span: planSpan(root.span),
            }
          : {
              kind: root.kind === "listLiteral" ? "list" : "set",
              elements: elements.map((item) => item.plan),
              span: planSpan(root.span),
            },
      temporaryIds: elements.flatMap((item) => item.temporaryIds),
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
          this.functionByName.has(current.expression.callee.name))
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
      this.instructions.push({ kind: "clearTemporary", temporaryId, span: planSpan(span) });
    }
  }
}

export interface LoweredExpression {
  readonly plan: ExpressionPlan;
  readonly temporaryIds: readonly number[];
}
