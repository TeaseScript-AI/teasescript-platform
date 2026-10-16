import type {
  AssignmentStatement,
  Block,
  CallExpression,
  Expression,
  FunctionDeclaration,
  IfStatement,
  Program,
  PropertyAccessExpression,
  Statement,
  SwitchStatement,
  TransferTarget,
} from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import {
  askOperands,
  expressionChildren,
  mediaHandlerBlocks,
  mediaOperands,
  sayOperands,
  showButtonOptions,
} from "./expression-children.js";
import { copiesAccount, runsOnItsOwn, sessionDeclarations } from "./project-globals.js";
import { globMatches, isPathGlob } from "./project-paths.js";
import type { SourceSpan } from "./source.js";
import { PERSON_FIELDS, PLAYER } from "./speaker-terms.js";

/** A read of a speaker's property through the speaker's name, or as `speaker` where `as` names it (V30 §37). */
export interface SpeakerFlowRead {
  readonly speaker: string;
  readonly name: string;
  /** Whether the property is a built-in field, term, or name list rather than a custom property. */
  readonly field: boolean;
  /** The properties of which the speaker needs one for the read to find a value, the property first. */
  readonly sources: readonly string[];
}

/** A store `name.property = ...` through a speaker's name. */
export interface SpeakerFlowStore {
  readonly speaker: string;
  readonly name: string;
}

/** What the flow check of speaker properties takes from the type check (see `TypeChecker.speakerFlowInput`). */
export interface SpeakerFlowInput {
  /** The reads to follow: a declaration or a store somewhere in the package gives the speaker a source of each. */
  readonly reads: ReadonlyMap<PropertyAccessExpression, SpeakerFlowRead>;
  readonly stores: ReadonlyMap<AssignmentStatement, SpeakerFlowStore>;
  /** The author function that each call calls. */
  readonly calls: ReadonlyMap<CallExpression, FunctionDeclaration>;
  /**
   * Which ways through a branch or loop the type check found possible: for an `if` its `then` and its `else` (also
   * without one), for a `switch` each case and then no case, for a `while` its body and its end, and for a `repeat` or
   * `for` its body and no run of it.
   */
  readonly paths: ReadonlyMap<Statement, readonly boolean[]>;
  /** For `and`, `or`, and `otherwise`: whether the right side may run, and whether it may be skipped. */
  readonly operands: ReadonlyMap<Expression, readonly boolean[]>;
}

/** How a way enters a node, to name the way that misses a store. */
type Way =
  | { readonly kind: "then" | "else" | "noElse"; readonly at: SourceSpan; readonly file: number }
  | { readonly kind: "case" | "default" | "noCase"; readonly at: SourceSpan; readonly file: number }
  | { readonly kind: "loopFirst" | "loopNever"; readonly loop: SourceSpan; readonly file: number }
  | { readonly kind: "labelFall"; readonly label: string }
  | {
      readonly kind: "operand";
      readonly operator: "and" | "or" | "otherwise" | "default";
      readonly at: SourceSpan;
      readonly file: number;
    }
  | { readonly kind: "goto" | "call"; readonly at: SourceSpan; readonly file: number }
  | {
      readonly kind: "functionCall" | "partialCall";
      readonly name: string;
      readonly at: SourceSpan;
      readonly file: number;
    }
  | { readonly kind: "start" };

/** A way into a node: from the end of `from`, or from its event `at`, as a call or transfer leaves. */
interface Incoming {
  readonly from: FlowNode;
  readonly at: number | null;
  readonly way: Way | null;
}

type FlowEvent =
  | {
      readonly kind: "read";
      readonly read: PropertyAccessExpression;
      readonly info: SpeakerFlowRead;
      /** Whether a read that comes too early is reported: not in code that never runs, nor in a parameter default. */
      readonly reported: boolean;
    }
  | { readonly kind: "store"; readonly bits: bigint }
  | {
      readonly kind: "call";
      readonly fn: FunctionUnit;
      readonly site: CallExpression;
      /** The parameter defaults that the call runs: those of the arguments it leaves out. */
      readonly defaults: readonly Unit[];
    }
  | { readonly kind: "block"; readonly unit: Unit }
  /** A parameter default, which runs only for a call that leaves its argument out. */
  | { readonly kind: "default"; readonly unit: Unit }
  | {
      readonly kind: "transfer";
      readonly call: boolean;
      /** The entries it enters, or `null` for a target that the compiler cannot know. */
      readonly targets: readonly FlowNode[] | null;
      /** For a file `call` with known targets, the files it runs before it returns. */
      readonly files: readonly FileUnit[];
      readonly way: Way;
    }
  | { readonly kind: "end" };

interface FlowNode {
  readonly id: number;
  readonly file: number;
  readonly events: FlowEvent[];
  readonly next: FlowNode[];
  readonly into: Incoming[];
}

/** A file's top level, a function, or a timer, media, or button block: code that something else starts. */
interface Unit {
  readonly entry: FlowNode;
  /** What the unit may store itself. */
  own: bigint;
  /** What the unit and what it runs may store, once known. */
  summary: bigint;
  /** The functions, blocks, and files the unit may run. */
  readonly runs: Set<Unit>;
  /** The functions the unit calls. */
  readonly calls: Set<FunctionUnit>;
  /** Whether the unit may `call` a file that the compiler cannot know, which may be any file. */
  callsAnyFile: boolean;
}

interface FunctionUnit extends Unit {
  readonly declaration: FunctionDeclaration;
  readonly exit: FlowNode;
  /** Whether a way through the function reaches its end or a `return`, once known. */
  returns: boolean;
  /** What every way through the function to its end or a `return` assigns, once known. */
  gains: bigint;
  /** What some way through the function to its end or a `return` may assign, once known. */
  mayGains: bigint;
  /** The unit of each parameter's default, or `null` for a parameter without one. */
  readonly defaults: readonly (Unit | null)[];
}

interface FileUnit extends Unit {
  readonly path: string;
  readonly labels: ReadonlyMap<string, FlowNode>;
  /** Whether the file runs something on its own, so a glob may pick it. */
  readonly runsSomething: boolean;
}

interface Loop {
  readonly breakTo: FlowNode;
  readonly continueTo: FlowNode;
}

/**
 * What the messages of one check share: the `must` states, the way found to miss a bit for each node, and the store
 * that a message names for a property.
 */
interface Known {
  readonly must: readonly (bigint | null)[];
  readonly ways: Map<bigint, Map<FlowNode, Way | null>>;
  readonly named: Map<string, NamedStore | null>;
  /** For a node, its `must` state before each event and after the last. */
  readonly states: Map<FlowNode, (bigint | null)[]>;
}

/** The store that a message names, with the source it assigns (`null` for a copy) and where it can come from. */
interface NamedStore {
  readonly source: string | null;
  readonly place: Place;
  readonly runs: boolean;
  readonly reaching: ReadonlySet<FlowNode>;
}

/** A store's place in the source, to name in a message, and the node and event it runs as. */
interface Place {
  readonly file: number;
  readonly span: SourceSpan;
  readonly node: FlowNode;
  readonly event: number;
}

/**
 * Reports a read of a speaker's property where the speaker cannot have it yet (V30 §37). A custom property must have
 * been declared on every way to the read: by the speaker's declaration or an assignment through its name. A built-in
 * field, term, or name list needs a source on some way to the read: its declaration, an assignment, or for `player` a
 * copy of the account. The ways follow the control flow that the type check decided, through files, labels, functions,
 * and the start values. What the compiler cannot follow counts as having stored what it may store: a block that runs
 * later, a called file, a computed target, and a fallback. Returns the diagnostics of each file.
 */
export function speakerFlowDiagnostics(
  files: readonly { readonly path: string; readonly program: Program }[],
  input: SpeakerFlowInput,
  unreachable: ReadonlySet<Statement>,
): Diagnostic[][] {
  const result: Diagnostic[][] = files.map(() => []);
  if (input.reads.size === 0) return result;
  new SpeakerFlow(files, input, unreachable).report(result);
  for (const diagnostics of result)
    diagnostics.sort((left, right) => left.span.start.offset - right.span.start.offset);
  return result;
}

/**
 * The flow of a package as a graph of nodes, each a run of events in evaluation order, with two analyses over it: what
 * every way to a node stored (`must`), following only ways the compiler is sure of, and what some way may have stored
 * (`may`), following every way. Each followed property of a speaker is one bit of a state.
 */
class SpeakerFlow {
  readonly #files: readonly { readonly path: string; readonly program: Program }[];
  readonly #input: SpeakerFlowInput;
  readonly #unreachable: ReadonlySet<Statement>;
  readonly #bits = new Map<string, bigint>();
  readonly #all: bigint;
  readonly #nodes: FlowNode[] = [];
  readonly #fileUnits: FileUnit[] = [];
  readonly #filesByPath = new Map<string, FileUnit>();
  readonly #functions = new Map<FunctionDeclaration, FunctionUnit>();
  readonly #blocks: Unit[] = [];
  /** The blocks and parameter defaults still to build, each with the file it stands in. */
  readonly #pending: {
    readonly unit: Unit;
    readonly code: Block | Expression;
    readonly file: number;
  }[] = [];
  /** For the entry of a block or a parameter default, the nodes that start it; for a hub, the nodes that enter it. */
  readonly #startedBy = new Map<FlowNode, FlowNode[]>();
  /** For each file, the nodes with an `end` in its code, which return to the file's caller. */
  readonly #ends: FlowNode[][] = [];
  /** For each parameter default, the node where its value is done, which returns to the call. */
  readonly #lastOf = new Map<Unit, FlowNode>();
  /** Where the session starts: the first start value, or main.tease's top. */
  readonly #start: FlowNode;
  /** Where a target the compiler cannot know leads: on to every file's top and label. Only `may` enters it. */
  readonly #anywhere: FlowNode;
  /** Where an `end` that no call waits for continues: on to every fallback destination. Only `may` enters it. */
  readonly #fallback: FlowNode;
  /** The calls and transfers into each entry of a function, file, or label. */
  readonly #entered = new Map<FlowNode, Incoming[]>();
  /** For each followed speaker property, its assignments in project order. */
  readonly #stores = new Map<string, Place[]>();
  /** The copies of the account into the player, in project order. */
  readonly #copies: Place[] = [];
  /** The `may` states, to tell a store that no way runs. */
  #may: readonly (bigint | null)[] = [];
  #everyFile = 0n;

  // The state of a build.
  #file = 0;
  #unit: Unit | null = null;
  #current: FlowNode | null = null;
  #loops: Loop[] = [];
  /** Above 0 while the build is in code whose reads are not reported. */
  #quiet = 0;
  #function: FunctionUnit | null = null;
  /** The steps of the build still to take, the next one last, so nesting needs no native recursion. */
  readonly #work: (() => void)[] = [];

  constructor(
    files: readonly { readonly path: string; readonly program: Program }[],
    input: SpeakerFlowInput,
    unreachable: ReadonlySet<Statement>,
  ) {
    this.#files = files;
    this.#input = input;
    this.#unreachable = unreachable;
    for (const read of input.reads.values())
      for (const source of read.field ? read.sources : [read.name]) {
        const key = `${read.speaker}.${source}`;
        if (!this.#bits.has(key)) this.#bits.set(key, 1n << BigInt(this.#bits.size));
      }
    this.#all = (1n << BigInt(this.#bits.size)) - 1n;
    // Every file with its labels and functions first, so a transfer or call anywhere finds them.
    for (const [file, { path, program }] of files.entries()) {
      this.#file = file;
      const labels = new Map<string, FlowNode>();
      for (const statement of program.statements)
        if (statement.kind === "labelStatement") labels.set(statement.name.name, this.#node());
      const unit: FileUnit = {
        ...this.#newUnit(),
        path,
        labels,
        runsSomething: program.statements.some(runsOnItsOwn),
      };
      this.#fileUnits.push(unit);
      this.#filesByPath.set(path, unit);
      for (const declaration of functionDeclarations(program)) {
        const defaults = declaration.parameters.map((parameter) => {
          if (parameter.defaultValue === null) return null;
          const unit = this.#newUnit();
          this.#blocks.push(unit);
          this.#pending.push({ unit, code: parameter.defaultValue, file });
          return unit;
        });
        const fn: FunctionUnit = {
          ...this.#newUnit(),
          declaration,
          exit: this.#node(),
          returns: false,
          gains: 0n,
          mayGains: 0n,
          defaults,
        };
        for (const unit of defaults) if (unit !== null) fn.runs.add(unit);
        this.#functions.set(declaration, fn);
      }
    }
    this.#file = 0;
    this.#start = this.#node();
    this.#anywhere = this.#node();
    this.#fallback = this.#node();
    this.#startedBy.set(this.#anywhere, []);
    this.#startedBy.set(this.#fallback, []);
    for (const file of this.#fileUnits)
      for (const entry of [file.entry, ...file.labels.values()]) this.#edge(this.#anywhere, entry);
    this.#build();
  }

  #newUnit(): Unit {
    return {
      entry: this.#node(),
      own: 0n,
      summary: 0n,
      runs: new Set(),
      calls: new Set(),
      callsAnyFile: false,
    };
  }

  /** The bit of a speaker's property, or 0 when no read follows it. */
  #bit(speaker: string, name: string): bigint {
    return this.#bits.get(`${speaker}.${name}`) ?? 0n;
  }

  report(result: Diagnostic[][]): void {
    this.#summarize();
    this.#findReturns();
    this.#findGains("must");
    this.#findGains("may");
    const must = this.#solve("must");
    const may = this.#solve("may");
    this.#may = may;
    const known: Known = { must, ways: new Map(), named: new Map(), states: new Map() };
    for (const node of this.#nodes) {
      let mustState = must[node.id] ?? null;
      let mayState = may[node.id] ?? null;
      // The calls so far in the node of functions that assign something on only some of their ways.
      const partial: Extract<FlowEvent, { kind: "call" }>[] = [];
      for (const event of node.events) {
        if (event.kind === "call" && (event.fn.mayGains & ~event.fn.gains) !== 0n)
          partial.push(event);
        if (event.kind === "read" && event.reported && mustState !== null && mayState !== null) {
          const message = this.#message(event, node, partial, mustState, mayState, known);
          if (message !== null)
            result[node.file]!.push(
              createDiagnostic(
                DiagnosticSeverity.Error,
                "TSV043",
                message,
                event.read.property.span,
              ),
            );
        }
        if (mustState !== null) mustState = this.#apply("must", event, mustState, noJoin);
        if (mayState !== null) mayState = this.#apply("may", event, mayState, noJoin);
      }
    }
  }

  // Building ---------------------------------------------------------------------------------------------------------

  #node(): FlowNode {
    const node: FlowNode = {
      id: this.#nodes.length,
      file: this.#file,
      events: [],
      next: [],
      into: [],
    };
    this.#nodes.push(node);
    return node;
  }

  #edge(from: FlowNode | null, to: FlowNode, way: Way | null = null): void {
    if (from === null) return;
    from.next.push(to);
    to.into.push({ from, at: null, way });
  }

  #event(event: FlowEvent): void {
    this.#current ??= this.#node();
    this.#current.events.push(event);
  }

  /** Takes the steps in order, before the steps planned earlier; a step may plan steps of its own. */
  #sequence(steps: readonly (() => void)[]): void {
    for (let index = steps.length - 1; index >= 0; index -= 1) this.#work.push(steps[index]!);
  }

  #runWork(): void {
    for (let step = this.#work.pop(); step !== undefined; step = this.#work.pop()) step();
  }

  #build(): void {
    // The session sets up the globals and speakers in order, then runs main.tease from its top.
    this.#unit = this.#fileUnits[0]!;
    this.#current = this.#start;
    for (const { file, declaration } of sessionDeclarations(
      this.#files.map((entry) => entry.program),
    )) {
      // Each start value runs in the node of its own file, so a message names its line there.
      this.#file = file;
      if (this.#current!.file !== file) {
        const next = this.#node();
        this.#edge(this.#current, next);
        this.#current = next;
      }
      if (declaration.kind === "globalStatement") this.#expression(declaration.initial);
      else for (const property of declaration.properties) this.#expression(property.value);
    }
    this.#file = 0;
    this.#edge(this.#current, this.#fileUnits[0]!.entry, { kind: "start" });
    for (const [file, { program }] of this.#files.entries()) {
      this.#enter(this.#fileUnits[file]!, file);
      this.#statements(program.statements);
      this.#runWork();
    }
    for (const fn of this.#functions.values()) {
      this.#enter(fn, fn.entry.file);
      this.#function = fn;
      // A parameter default runs first, but only for a call that leaves its argument out.
      for (const unit of fn.defaults) if (unit !== null) this.#event({ kind: "default", unit });
      this.#sequence([
        () => this.#statements(fn.declaration.body.statements),
        () => this.#edge(this.#current, fn.exit),
      ]);
      this.#runWork();
    }
    for (let pending = this.#pending.pop(); pending !== undefined; pending = this.#pending.pop()) {
      this.#enter(pending.unit, pending.file);
      if (pending.code.kind === "block") this.#statements(pending.code.statements);
      else this.#expression(pending.code);
      this.#runWork();
      if (pending.code.kind !== "block") this.#lastOf.set(pending.unit, this.#current!);
    }
    for (const from of this.#nodes)
      for (const [at, event] of from.events.entries()) {
        if (event.kind === "call") {
          const way: Way = {
            kind: "functionCall",
            name: event.fn.declaration.name.name,
            at: event.site.span,
            file: from.file,
          };
          this.#enteredBy(event.fn.entry, { from, at, way });
          for (const unit of event.defaults) this.#enteredBy(unit.entry, { from, at, way });
        } else if (event.kind === "transfer" && event.targets !== null)
          for (const target of event.targets) this.#enteredBy(target, { from, at, way: event.way });
      }
  }

  #enter(unit: Unit, file: number): void {
    this.#unit = unit;
    this.#file = file;
    this.#current = unit.entry;
    this.#loops = [];
    this.#quiet = 0;
    this.#function = null;
  }

  #enteredBy(node: FlowNode, incoming: Incoming): void {
    const known = this.#entered.get(node);
    if (known === undefined) this.#entered.set(node, [incoming]);
    else known.push(incoming);
  }

  /**
   * A timer, media, or button block, which runs at a time that the code around it cannot tell: a unit of its own, built
   * after the code that creates it, which starts with everything.
   */
  #block(block: Block): void {
    const unit = this.#newUnit();
    this.#blocks.push(unit);
    this.#pending.push({ unit, code: block, file: this.#file });
    this.#unit!.runs.add(unit);
    this.#event({ kind: "block", unit });
    this.#startedBy.set(unit.entry, [this.#current!]);
  }

  #statements(statements: readonly Statement[]): void {
    for (let index = statements.length - 1; index >= 0; index -= 1) {
      const statement = statements[index]!;
      this.#work.push(() => this.#statement(statement));
    }
  }

  #body(block: Block | IfStatement): void {
    if (block.kind === "block") this.#statements(block.statements);
    else this.#statement(block);
  }

  #statement(statement: Statement): void {
    if (statement.kind === "functionDeclaration") return;
    if (statement.kind === "labelStatement") {
      const label = this.#fileUnits[this.#file]!.labels.get(statement.name.name)!;
      this.#edge(this.#current, label, { kind: "labelFall", label: statement.name.name });
      this.#current = label;
      return;
    }
    // Code that no way reaches still gets nodes, which no way enters.
    this.#current ??= this.#node();
    if (!this.#unreachable.has(statement)) {
      this.#statementKind(statement);
      return;
    }
    this.#quiet += 1;
    this.#sequence([
      () => this.#statementKind(statement),
      () => {
        this.#quiet -= 1;
      },
    ]);
  }

  #statementKind(statement: Exclude<Statement, { kind: "labelStatement" }>): void {
    switch (statement.kind) {
      case "letStatement":
        this.#expression(statement.initializer);
        return;
      case "assignmentStatement":
        this.#assignment(statement);
        return;
      case "globalStatement":
        // Its start value runs at the session's start; with `default:`, the assignment runs here.
        if (statement.assignment !== null) this.#assignment(statement.assignment);
        return;
      case "expressionStatement":
        if (copiesAccount(statement.expression)) this.#copy(statement.expression.span);
        else this.#expression(statement.expression);
        return;
      case "functionDeclaration":
      case "speakerDeclaration":
      case "speakerSetterStatement":
      case "hideImageStatement":
      case "showCameraStatement":
      case "hideCameraStatement":
      case "stopAudioStatement":
        return;
      case "sayStatement":
        this.#expressions(sayOperands(statement));
        return;
      case "showButtonStatement":
        this.#expression(statement.label);
        this.#expressions(showButtonOptions(statement).map((option) => option.value));
        return;
      case "waitStatement":
        this.#expression(statement.duration);
        return;
      case "timerStatement":
        if (typeof statement.display === "object" && statement.display !== null)
          this.#expression(statement.display);
        this.#expression(statement.duration);
        if (statement.label !== null) this.#expression(statement.label);
        if (statement.handler !== null) this.#block(statement.handler);
        return;
      case "showPermanentButtonStatement":
        this.#expression(statement.text);
        this.#block(statement.handler);
        return;
      case "playMediaStatement":
        this.#expressions(mediaOperands(statement));
        for (const block of mediaHandlerBlocks(statement)) this.#block(block);
        return;
      case "showImageStatement":
        this.#expression(statement.image);
        return;
      case "showPopupStatement":
      case "openUrlStatement":
      case "exportTextStatement":
        this.#expressions(statement.arguments.map((argument) => argument.value));
        return;
      case "saveStatement":
        this.#expression(statement.value);
        this.#expression(statement.key);
        return;
      case "deleteStatement":
        this.#expression(statement.key);
        return;
      case "ifStatement":
        this.#if(statement);
        return;
      case "switchStatement":
        this.#switch(statement);
        return;
      case "whileStatement":
        this.#while(statement);
        return;
      case "repeatStatement":
        this.#expression(statement.count);
        this.#loop(statement, statement.body);
        return;
      case "forStatement":
        this.#expression(statement.iterable);
        this.#loop(statement, statement.body);
        return;
      case "breakStatement":
      case "continueStatement": {
        const loop = this.#loops.at(-1);
        if (loop !== undefined)
          this.#edge(
            this.#current,
            statement.kind === "breakStatement" ? loop.breakTo : loop.continueTo,
          );
        this.#current = null;
        return;
      }
      case "returnStatement":
        if (statement.value !== null) this.#expression(statement.value);
        if (this.#function !== null) this.#edge(this.#current, this.#function.exit);
        this.#current = null;
        return;
      case "exitStatement":
        this.#current = null;
        return;
      case "endStatement":
        this.#event({ kind: "end" });
        this.#startedBy.get(this.#fallback)!.push(this.#current!);
        (this.#ends[this.#file] ??= []).push(this.#current!);
        this.#current = null;
        return;
      case "gotoStatement":
        this.#transfer(statement.target, false, statement.span);
        this.#current = null;
        return;
      case "callFileStatement":
        this.#transfer(statement.target, true, statement.span);
        return;
      case "fallbackStatement": {
        if (statement.target === null) return;
        if (statement.target.kind === "scriptTarget") this.#expression(statement.target.expression);
        const targets = this.#targets(statement.target).entries;
        if (targets === null) this.#edge(this.#fallback, this.#anywhere);
        else for (const target of targets) this.#edge(this.#fallback, target);
        return;
      }
      default:
        statement satisfies never;
    }
  }

  #assignment(statement: AssignmentStatement): void {
    const target = statement.target;
    if (target.kind === "propertyAccessExpression") this.#expression(target.object);
    else if (target.kind === "indexExpression") {
      this.#expression(target.object);
      this.#expression(target.index);
    }
    this.#expression(statement.value);
    // `+=` and `-=` read the property first; the read follows the value, whose calls may store it.
    if (statement.operator !== "=" && target.kind === "propertyAccessExpression")
      this.#read(target);
    const store = this.#input.stores.get(statement);
    if (store === undefined) return;
    const bit = this.#bit(store.speaker, store.name);
    if (bit === 0n) return;
    const key = `${store.speaker}.${store.name}`;
    const place = this.#store(bit, statement.span);
    const known = this.#stores.get(key);
    if (known === undefined) this.#stores.set(key, [place]);
    else known.push(place);
  }

  /** `player.copyFrom(account)`, which gives the player every person field. */
  #copy(span: SourceSpan): void {
    let bits = 0n;
    for (const name of PERSON_FIELDS) bits |= this.#bit(PLAYER, name);
    if (bits !== 0n) this.#copies.push(this.#store(bits, span));
  }

  #store(bits: bigint, span: SourceSpan): Place {
    this.#unit!.own |= bits;
    this.#event({ kind: "store", bits });
    return {
      file: this.#file,
      span,
      node: this.#current!,
      event: this.#current!.events.length - 1,
    };
  }

  #read(read: PropertyAccessExpression): void {
    const info = this.#input.reads.get(read);
    if (info !== undefined) this.#event({ kind: "read", read, info, reported: this.#quiet === 0 });
  }

  #if(statement: IfStatement): void {
    this.#expression(statement.condition);
    const [thenWay, elseWay] = this.#input.paths.get(statement) ?? [true, true];
    const start = this.#current!;
    const join = this.#node();
    const at = statement.span;
    const file = this.#file;
    const elseBlock = statement.elseBlock;
    this.#sequence([
      () => {
        this.#current = thenWay === true ? this.#branch(start) : this.#node();
        this.#body(statement.thenBlock);
      },
      () => {
        if (thenWay === true) this.#edge(this.#current, join, { kind: "then", at, file });
        if (elseBlock === null) {
          if (elseWay === true) this.#edge(start, join, { kind: "noElse", at, file });
          return;
        }
        this.#current = elseWay === true ? this.#branch(start) : this.#node();
        this.#body(elseBlock);
      },
      () => {
        if (elseBlock !== null && elseWay === true)
          this.#edge(this.#current, join, { kind: "else", at, file });
        this.#current = join.into.length > 0 ? join : null;
      },
    ]);
  }

  #branch(start: FlowNode): FlowNode {
    const node = this.#node();
    this.#edge(start, node);
    return node;
  }

  #switch(statement: SwitchStatement): void {
    this.#expression(statement.subject);
    for (const switchCase of statement.cases) this.#expressions(switchCase.values);
    const paths = this.#input.paths.get(statement);
    const start = this.#current!;
    const join = this.#node();
    const file = this.#file;
    const rest = paths?.[statement.cases.length] ?? true;
    const defaultBlock = statement.defaultBlock;
    this.#sequence([
      ...statement.cases.flatMap((switchCase, index) => {
        const taken = paths?.[index] ?? true;
        return [
          () => {
            this.#current = taken ? this.#branch(start) : this.#node();
            this.#body(switchCase.body);
          },
          () => {
            if (taken) this.#edge(this.#current, join, { kind: "case", at: switchCase.span, file });
          },
        ];
      }),
      () => {
        if (defaultBlock === null) {
          if (rest) this.#edge(start, join, { kind: "noCase", at: statement.span, file });
          return;
        }
        this.#current = rest ? this.#branch(start) : this.#node();
        this.#body(defaultBlock);
      },
      () => {
        if (defaultBlock !== null && rest)
          this.#edge(this.#current, join, { kind: "default", at: defaultBlock.span, file });
        this.#current = join.into.length > 0 ? join : null;
      },
    ]);
  }

  /** A `while` loop: its condition runs before each run of the body, and once more before it ends. */
  #while(statement: Extract<Statement, { kind: "whileStatement" }>): void {
    const [bodyWay, endWay] = this.#input.paths.get(statement) ?? [true, true];
    const head = this.#node();
    this.#edge(this.#current, head, { kind: "loopFirst", loop: statement.span, file: this.#file });
    this.#current = head;
    this.#expression(statement.condition);
    const tested = this.#current;
    const after = this.#node();
    this.#loops.push({ breakTo: after, continueTo: head });
    this.#current = bodyWay === true ? this.#branch(tested) : this.#node();
    this.#sequence([
      () => this.#statements(statement.body.statements),
      () => {
        this.#edge(this.#current, head);
        this.#loops.pop();
        if (endWay === true) this.#edge(tested, after);
        this.#current = after.into.length > 0 ? after : null;
      },
    ]);
  }

  /** A `repeat` or `for` loop, whose body runs any number of times unless the type check found otherwise. */
  #loop(statement: Statement, body: Block): void {
    const [bodyWay, noneWay] = this.#input.paths.get(statement) ?? [true, true];
    const start = this.#current!;
    const again = this.#node();
    const after = this.#node();
    const file = this.#file;
    this.#loops.push({ breakTo: after, continueTo: again });
    if (bodyWay === true) {
      const first = this.#node();
      this.#edge(start, first, { kind: "loopFirst", loop: statement.span, file });
      this.#edge(again, first);
      this.#current = first;
    } else this.#current = this.#node();
    this.#sequence([
      () => this.#statements(body.statements),
      () => {
        this.#edge(this.#current, again);
        this.#loops.pop();
        if (noneWay === true)
          this.#edge(start, after, { kind: "loopNever", loop: statement.span, file });
        if (again.into.length > 0) this.#edge(again, after);
        this.#current = after.into.length > 0 ? after : null;
      },
    ]);
  }

  /** A `goto` or file `call`: a transfer to the entries its target may enter. */
  #transfer(target: TransferTarget, call: boolean, span: SourceSpan): void {
    if (target.kind === "scriptTarget") this.#expression(target.expression);
    const { entries, files } = this.#targets(target);
    if (call && entries === null) this.#unit!.callsAnyFile = true;
    if (entries === null)
      this.#startedBy.get(this.#anywhere)!.push((this.#current ??= this.#node()));
    for (const file of files) this.#unit!.runs.add(file);
    this.#event({
      kind: "transfer",
      call,
      targets: entries,
      files: call ? files : [],
      way: { kind: call ? "call" : "goto", at: span, file: this.#file },
    });
  }

  /**
   * The entries a target enters: a label of the running file, a file at its top or a label, each file a glob may pick,
   * or the file and label that a `script(...)` of literal text names; `null` for a target the compiler cannot know.
   */
  #targets(target: TransferTarget): {
    readonly entries: FlowNode[] | null;
    readonly files: FileUnit[];
  } {
    const own = this.#fileUnits[this.#file]!;
    if (target.kind === "labelTarget") {
      const label = own.labels.get(target.label.name);
      return { entries: label === undefined ? [] : [label], files: [own] };
    }
    const named =
      target.kind === "fileTarget"
        ? { path: target.path, label: target.label?.name ?? null }
        : literalScript(target.expression);
    if (named === null) return { entries: null, files: [] };
    const { path, label } = named;
    // A glob picks only files that run something and have the label; a named file is the file it names.
    const glob = isPathGlob(path);
    const files = (glob ? globMatches(path, this.#filesByPath.keys()) : [path])
      .map((matched) => this.#filesByPath.get(matched))
      .filter(
        (file): file is FileUnit =>
          file !== undefined &&
          (!glob || file.runsSomething) &&
          (label === null || file.labels.has(label)),
      );
    return {
      entries: files.map((file) => (label === null ? file.entry : file.labels.get(label)!)),
      files,
    };
  }

  #expressions(expressions: readonly Expression[]): void {
    for (const expression of expressions) this.#expression(expression);
  }

  /**
   * The events of an expression in evaluation order, walked with a stack of its own. The right side of `and`, `or`,
   * and `otherwise`, and the `default:` of a `load`, run only on some ways: a branch that the type check found possible
   * runs them, and another goes past them.
   */
  #expression(root: Expression): void {
    type Frame =
      | { readonly expression: Expression; readonly step: "operands" | "after" | "optional" }
      | {
          readonly step: "joined";
          readonly operand: Way;
          readonly start: FlowNode;
          readonly skips: boolean;
        }
      | { readonly step: "skipped"; readonly start: FlowNode };
    const stack: Frame[] = [{ expression: root, step: "operands" }];
    for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
      if (frame.step === "joined") {
        const join = this.#node();
        this.#edge(this.#current, join);
        if (frame.skips) this.#edge(frame.start, join, frame.operand);
        this.#current = join;
        continue;
      }
      if (frame.step === "skipped") {
        this.#current = frame.start;
        continue;
      }
      const { expression } = frame;
      if (frame.step === "after") {
        this.#after(expression);
        continue;
      }
      const optional = optionalOperand(expression);
      if (frame.step === "optional" && optional !== null) {
        const [runs, skips] = this.#input.operands.get(expression) ?? [true, true];
        const start = (this.#current ??= this.#node());
        const operand: Way = {
          kind: "operand",
          operator: optional.operator,
          at: optional.at,
          file: this.#file,
        };
        // A side that never runs is still built, but no way enters it.
        stack.push(
          runs === true
            ? { step: "joined", operand, start, skips: skips === true }
            : { step: "skipped", start },
        );
        this.#current = runs === true ? this.#branch(start) : this.#node();
        stack.push({ expression: optional.operand, step: "operands" });
        continue;
      }
      stack.push({ expression, step: optional === null ? "after" : "optional" });
      const operands = optional === null ? expressionOperands(expression) : optional.first;
      for (let index = operands.length - 1; index >= 0; index -= 1)
        stack.push({ expression: operands[index]!, step: "operands" });
    }
  }

  /** What an expression does once its operands are evaluated. */
  #after(expression: Expression): void {
    switch (expression.kind) {
      case "propertyAccessExpression":
        this.#read(expression);
        return;
      case "callExpression": {
        const declaration = this.#input.calls.get(expression);
        const fn = declaration === undefined ? undefined : this.#functions.get(declaration);
        if (fn === undefined) return;
        this.#unit!.runs.add(fn);
        this.#unit!.calls.add(fn);
        this.#event({
          kind: "call",
          fn,
          site: expression,
          defaults: omittedDefaults(fn, expression),
        });
        return;
      }
      case "timerExpression":
        if (expression.handler !== null) this.#block(expression.handler);
        return;
      case "showPermanentButtonExpression":
        this.#block(expression.handler);
        return;
      case "playMediaExpression":
        for (const block of mediaHandlerBlocks(expression)) this.#block(block);
        return;
      default:
        return;
    }
  }

  // Summaries --------------------------------------------------------------------------------------------------------

  /** What each unit may store, with what the functions, blocks, and files it runs may store. */
  #summarize(): void {
    const units: Unit[] = [...this.#fileUnits, ...this.#functions.values(), ...this.#blocks];
    const runBy = new Map<Unit, Unit[]>();
    for (const unit of units) {
      unit.summary = unit.own;
      for (const run of unit.runs) {
        const known = runBy.get(run);
        if (known === undefined) runBy.set(run, [unit]);
        else known.push(unit);
      }
    }
    const anyFile = units.filter((unit) => unit.callsAnyFile);
    const files = new Set<Unit>(this.#fileUnits);
    this.#everyFile = this.#fileUnits.reduce((bits, file) => bits | file.own, 0n);
    const work = new Set(units);
    for (const unit of work) {
      work.delete(unit);
      let summary = unit.own;
      for (const run of unit.runs) summary |= run.summary;
      if (unit.callsAnyFile) summary |= this.#everyFile;
      if (summary === unit.summary) continue;
      unit.summary = summary;
      for (const by of runBy.get(unit) ?? []) work.add(by);
      if (files.has(unit)) {
        this.#everyFile |= summary;
        for (const by of anyFile) work.add(by);
      }
    }
  }

  /** Which functions can return to their caller: some way through the body reaches its end or a `return`. */
  #findReturns(): void {
    const callers = this.#callers();
    const work = new Set(this.#functions.values());
    for (const fn of work) {
      work.delete(fn);
      if (fn.returns || !this.#reachesExit(fn)) continue;
      fn.returns = true;
      for (const caller of callers.get(fn) ?? []) if (!caller.returns) work.add(caller);
    }
  }

  /** The functions that call each function. */
  #callers(): Map<FunctionUnit, FunctionUnit[]> {
    const callers = new Map<FunctionUnit, FunctionUnit[]>();
    for (const caller of this.#functions.values())
      for (const called of caller.calls) {
        const known = callers.get(called);
        if (known === undefined) callers.set(called, [caller]);
        else known.push(caller);
      }
    return callers;
  }

  #reachesExit(fn: FunctionUnit): boolean {
    const seen = new Set([fn.entry]);
    const work = [fn.entry];
    for (let node = work.pop(); node !== undefined; node = work.pop()) {
      if (node === fn.exit) return true;
      if (node.events.some((event) => event.kind === "call" && !event.fn.returns)) continue;
      for (const next of node.next)
        if (!seen.has(next)) {
          seen.add(next);
          work.push(next);
        }
    }
    return false;
  }

  /**
   * What each function that returns assigns on every way to its end or a `return` (`must`), or on some way (`may`): a
   * call in it gives what the called function gains, a block or a file `call` whatever it may store, and a parameter
   * default its stores only for `may`. A way ends at an `end`, a `goto`, or for `must` a call that never returns.
   * `must` starts from everything and only shrinks, so recursion keeps what its other ways assign; `may` starts from
   * nothing and only grows.
   */
  #findGains(mode: "must" | "may"): void {
    const callers = this.#callers();
    const returning = [...this.#functions.values()].filter((fn) => fn.returns);
    for (const fn of returning) {
      if (mode === "must") fn.gains = this.#all;
      else fn.mayGains = 0n;
    }
    const work = new Set(returning);
    for (const fn of work) {
      work.delete(fn);
      const states = new Map<FlowNode, bigint>([[fn.entry, 0n]]);
      const nodes = [fn.entry];
      for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
        let state: bigint | null = states.get(node)!;
        for (const event of node.events) {
          state = this.#apply(mode, event, state, noJoin);
          if (state === null) break;
        }
        if (state === null) continue;
        for (const next of node.next) {
          const known = states.get(next);
          const joined =
            known === undefined ? state : mode === "must" ? known & state : known | state;
          if (joined === known) continue;
          states.set(next, joined);
          nodes.push(next);
        }
      }
      const exit = states.get(fn.exit);
      if (mode === "must") {
        const gains = exit ?? this.#all;
        if (gains === fn.gains) continue;
        fn.gains = gains;
      } else {
        const gains = exit ?? 0n;
        if (gains === fn.mayGains) continue;
        fn.mayGains = gains;
      }
      for (const caller of callers.get(fn) ?? []) if (caller.returns) work.add(caller);
    }
  }

  // Solving ----------------------------------------------------------------------------------------------------------

  /**
   * The state where each node starts, or `null` where no way reaches it. The session starts with the properties that
   * speaker declarations list. A block starts with everything, as it may run after any store.
   */
  #solve(mode: "must" | "may"): (bigint | null)[] {
    const states: (bigint | null)[] = this.#nodes.map(() => null);
    const queued = new Set<FlowNode>();
    const join = (node: FlowNode, state: bigint): void => {
      const known = states[node.id]!;
      const joined = known === null ? state : mode === "must" ? known & state : known | state;
      if (joined === known) return;
      states[node.id] = joined;
      queued.add(node);
    };
    join(this.#start, this.#startState());
    for (const node of queued) {
      queued.delete(node);
      let state: bigint | null = states[node.id]!;
      for (const event of node.events) {
        state = this.#apply(mode, event, state, join);
        if (state === null) break;
      }
      if (state !== null) for (const next of node.next) join(next, state);
    }
    return states;
  }

  #startState(): bigint {
    let bits = 0n;
    for (const { declaration } of sessionDeclarations(this.#files.map((file) => file.program)))
      if (declaration.kind === "speakerDeclaration")
        for (const property of declaration.properties)
          bits |= this.#bit(declaration.name.name, property.name.name);
    return bits;
  }

  /**
   * The state after `event`, or `null` when the way ends there, giving `join` what the event enters. `must` follows
   * only ways the compiler is sure of: it skips computed targets and fallbacks, takes from a function call what every
   * way through it assigns, and ends at a call that never returns. `may` follows every way.
   */
  #apply(
    mode: "must" | "may",
    event: FlowEvent,
    state: bigint,
    join: (node: FlowNode, state: bigint) => void,
  ): bigint | null {
    switch (event.kind) {
      case "read":
        return state;
      case "store":
        return state | event.bits;
      case "call":
        join(event.fn.entry, state);
        for (const unit of event.defaults) join(unit.entry, state);
        if (mode === "may") return state | event.fn.mayGains;
        return event.fn.returns ? state | event.fn.gains : null;
      case "block":
        join(event.unit.entry, this.#all);
        return state | event.unit.summary;
      case "default":
        return mode === "may" ? state | event.unit.summary : state;
      case "transfer":
        if (event.targets !== null) for (const target of event.targets) join(target, state);
        else if (mode === "may") join(this.#anywhere, state);
        if (!event.call) return null;
        // A file `call` returns once that file, or one it went on to, ends.
        if (event.targets === null) return state | this.#everyFile;
        return event.files.reduce((bits, file) => bits | file.summary, state);
      case "end":
        if (mode === "may") join(this.#fallback, state);
        return null;
    }
  }

  // Reporting --------------------------------------------------------------------------------------------------------

  /** The message for a read where the speaker cannot have the property yet, or `null`. */
  #message(
    event: Extract<FlowEvent, { kind: "read" }>,
    node: FlowNode,
    partial: readonly Extract<FlowEvent, { kind: "call" }>[],
    mustState: bigint,
    mayState: bigint,
    known: Known,
  ): string | null {
    const { speaker, name, field, sources } = event.info;
    let some = 0n;
    for (const source of field ? sources : [name]) some |= this.#bit(speaker, source);
    if ((mayState & some) === 0n) return this.#tooEarly(event.info, node, known);
    const bit = this.#bit(speaker, name);
    if (field || (mustState & bit) !== 0n) return null;
    // The nearest call before the read that may leave it out, or else a way into the read's node.
    let way: Way | null = null;
    for (let index = partial.length - 1; index >= 0 && way === null; index -= 1)
      way = this.#partialCall(partial[index]!, bit, node.file);
    way ??= this.#missingWay(node, bit, known);
    return someWaysMessage(
      speaker,
      name,
      way === null ? null : this.#describe(way, node.file, event.read),
    );
  }

  /**
   * A way to `start` that misses `bit`, searched back from it: a way into a node that misses the bit where another way
   * into it has it, or a call of a function that assigns it on only some of its ways. `null` when none is found. The
   * answer is kept for each node between the way found and `start`, or for every node searched when none is found, so a
   * later search stops at the first node it already knows.
   */
  #missingWay(start: FlowNode, bit: bigint, known: Known): Way | null {
    let found = known.ways.get(bit);
    if (found === undefined) {
      found = new Map();
      known.ways.set(bit, found);
    }
    const lacks = (state: bigint | null): boolean => state !== null && (state & bit) === 0n;
    const parents = new Map<FlowNode, FlowNode | null>([[start, null]]);
    const work = [start];
    let way: Way | null = null;
    let at: FlowNode | null = null;
    for (let index = 0; index < work.length && at === null; index += 1) {
      const node = work[index]!;
      const kept = found.get(node);
      if (kept !== undefined) {
        // A node searched before: its way leads here too, or nothing behind it misses the bit where another way has it.
        if (kept === null) continue;
        way = kept;
        at = node;
        break;
      }
      const ways = [...node.into, ...(this.#entered.get(node) ?? [])];
      const states = ways.map((incoming) => this.#stateAt(incoming, known));
      if (states.some((state) => state !== null && !lacks(state)))
        way =
          ways.find((incoming, entry) => incoming.way !== null && lacks(states[entry]!))?.way ??
          null;
      for (const [entry, incoming] of ways.entries()) {
        if (way !== null) break;
        if (!lacks(states[entry]!)) continue;
        const events = incoming.from.events;
        for (let event = (incoming.at ?? events.length) - 1; event >= 0 && way === null; event -= 1)
          way = this.#partialCall(events[event]!, bit, incoming.from.file);
        if (!parents.has(incoming.from)) {
          parents.set(incoming.from, node);
          work.push(incoming.from);
        }
      }
      if (way !== null) at = node;
    }
    if (at === null) for (const node of parents.keys()) found.set(node, null);
    else
      for (let node: FlowNode | null = at; node !== null; node = parents.get(node)!)
        found.set(node, way);
    return way;
  }

  /** The `must` state where a way into a node leaves its node. */
  #stateAt(incoming: Incoming, known: Known): bigint | null {
    let states = known.states.get(incoming.from);
    if (states === undefined) {
      // The node's `must` state before each event and after its last, worked out once.
      states = [known.must[incoming.from.id] ?? null];
      for (const event of incoming.from.events) {
        const state = states.at(-1)!;
        states.push(state === null ? null : this.#apply("must", event, state, noJoin));
      }
      known.states.set(incoming.from, states);
    }
    return states[incoming.at ?? incoming.from.events.length]!;
  }

  /** A call of a function that may assign `bit` but does not on every way, as a way that misses it. */
  #partialCall(event: FlowEvent, bit: bigint, file: number): Way | null {
    if (event.kind !== "call" || (event.fn.mayGains & bit) === 0n || (event.fn.gains & bit) !== 0n)
      return null;
    return { kind: "partialCall", name: event.fn.declaration.name.name, at: event.site.span, file };
  }

  /**
   * The message for a read that no way to it gives a source of the property first. It names one store: for the
   * player's field a copy of the account, else an assignment of a source, preferring one that runs, and says whether
   * it comes later, runs only on a way that does not reach the read, or never runs.
   */
  #tooEarly(read: SpeakerFlowRead, node: FlowNode, known: Known): string {
    const { speaker, name, field, sources } = read;
    const copy = speaker === PLAYER && field && this.#copies.length > 0;
    const key = `${speaker}.${copy ? "copy" : sources.join(".")}`;
    let store = known.named.get(key);
    if (store === undefined) {
      const stores = copy
        ? this.#copies.map((place) => ({ source: null, place }))
        : sources.flatMap((source) =>
            (this.#stores.get(`${speaker}.${source}`) ?? []).map((place) => ({ source, place })),
          );
      const runs = (place: Place): boolean => (this.#may[place.node.id] ?? null) !== null;
      stores.sort(
        (left, right) =>
          Number(runs(right.place)) - Number(runs(left.place)) ||
          comparePlaces(left.place, right.place),
      );
      const first = stores[0];
      store =
        first === undefined
          ? null
          : { ...first, runs: runs(first.place), reaching: this.#reaching(first.place) };
      known.named.set(key, store);
    }
    let named = "";
    if (store !== null) {
      const when = !store.runs
        ? "never"
        : store.place.node === node || store.reaching.has(node)
          ? "later"
          : "elsewhere";
      const line = this.#line(store.place, node.file);
      named =
        store.source === null
          ? ` The copy on ${line} ${when === "never" ? "never runs" : when === "later" ? "comes only later" : "runs only on a way that does not reach this line"}.`
          : ` ${capitalize(line)} assigns ${sources.length === 1 ? "it" : `'${store.source}'`}, but ${when === "never" ? "that line never runs" : when === "later" ? "only later" : "only on a way that does not reach this line"}.`;
    }
    if (!field)
      return `Speaker '${speaker}' has no '${name}' yet here: nothing assigns it before this line runs.${named} ${
        speaker === PLAYER
          ? `Assign it before this line, as in 'player.${name} = ...'.`
          : `Give it a start value, as in 'speaker ${speaker} { ${name}: ... }', or assign it before this line.`
      }`;
    const quoted = alternatives(sources);
    if (speaker === PLAYER)
      return `Speaker 'player' has no '${name}' yet here: nothing copies the account or assigns ${quoted} before this line runs.${named} Copy the account before this line, as in 'player.copyFrom(account)' at the start of the script, or assign ${sources.includes("gender") ? `'player.gender' or 'player.${name}'` : `'player.${name}'`} first.`;
    return `Speaker '${speaker}' has no '${name}' yet here: nothing assigns ${quoted} before this line runs.${named} ${
      sources.includes("gender")
        ? `Give it a gender, as in 'speaker ${speaker} { gender: "female" }', or assign it before this line.`
        : `Give it a start value, as in 'speaker ${speaker} { ${name}: ... }', or assign it before this line.`
    }`;
  }

  /**
   * The nodes from which some way leads to the store at `target`: back through edges, calls and transfers into an
   * entry, the code that starts a block or a parameter default, and the code that enters a hub, and from a call before
   * it, back from the end of the function or the `end`s of the files it runs.
   */
  #reaching(target: Place): ReadonlySet<FlowNode> {
    // For each node, how many of its events lead on to the store.
    const upTo = new Map<FlowNode, number>([[target.node, target.event]]);
    const work = [target.node];
    const visit = (node: FlowNode, events: number): void => {
      if ((upTo.get(node) ?? -1) >= events) return;
      upTo.set(node, events);
      work.push(node);
    };
    for (let node = work.pop(); node !== undefined; node = work.pop()) {
      const events = upTo.get(node)!;
      for (const event of node.events.slice(0, events))
        if (event.kind === "call") {
          visit(event.fn.exit, 0);
          for (const unit of event.defaults) {
            const last = this.#lastOf.get(unit)!;
            visit(last, last.events.length);
          }
        } else if (event.kind === "transfer" && event.call)
          for (const file of event.files)
            for (const end of this.#ends[file.entry.file] ?? []) visit(end, end.events.length);
      for (const incoming of [...node.into, ...(this.#entered.get(node) ?? [])])
        visit(incoming.from, incoming.at ?? incoming.from.events.length);
      for (const from of this.#startedBy.get(node) ?? []) visit(from, from.events.length);
    }
    return new Set(upTo.keys());
  }

  #line(place: Pick<Place, "file" | "span">, from: number): string {
    const line = `line ${place.span.start.line + 1}`;
    return place.file === from ? line : `${line} of '${this.#files[place.file]!.path}'`;
  }

  /** The way as a phrase that ends before ", nothing assigns it", and the fix that fits it. */
  #describe(way: Way, from: number, read: PropertyAccessExpression): WayText {
    const line = (at: SourceSpan, file: number): string => this.#line({ file, span: at }, from);
    switch (way.kind) {
      case "then":
        return {
          phrase: `when the 'if' on ${line(way.at, way.file)} is true`,
          fix: "on that way too",
        };
      case "noElse":
        return {
          phrase: `when the 'if' on ${line(way.at, way.file)} is false`,
          fix: "on that way too, as in an 'else'",
        };
      case "else":
        return {
          phrase: `through the 'else' of the 'if' on ${line(way.at, way.file)}`,
          fix: "on that way too",
        };
      case "case":
        return {
          phrase: `through the 'case' on ${line(way.at, way.file)}`,
          fix: "on that way too",
        };
      case "default":
        return {
          phrase: `through the 'default' on ${line(way.at, way.file)}`,
          fix: "on that way too",
        };
      case "noCase":
        return {
          phrase: `when no 'case' of the 'switch' on ${line(way.at, way.file)} matches`,
          fix: "on that way too, as in a 'default'",
        };
      case "loopFirst":
      case "loopNever": {
        const inside =
          way.kind === "loopFirst" &&
          way.file === from &&
          read.span.start.offset >= way.loop.start.offset &&
          read.span.end.offset <= way.loop.end.offset;
        return {
          phrase: inside
            ? `on the first run of the loop on ${line(way.loop, way.file)}`
            : `when the loop on ${line(way.loop, way.file)} does not run`,
          fix: "before the loop",
        };
      }
      case "labelFall":
        return {
          phrase: `when the script runs into 'label ${way.label}' from the line before it`,
          fix: `before 'label ${way.label}'`,
        };
      case "goto":
        return {
          phrase: `after the 'goto' on ${line(way.at, way.file)}`,
          fix: "before that 'goto'",
        };
      case "call":
        return {
          phrase: `through the 'call' on ${line(way.at, way.file)}`,
          fix: "before that 'call'",
        };
      case "functionCall":
        return {
          phrase: `when ${line(way.at, way.file)} calls '${way.name}'`,
          fix: "before that call",
        };
      case "partialCall":
        return {
          phrase: `${line(way.at, way.file)} calls '${way.name}', which assigns it on only some of its ways`,
          fix: `on every way through '${way.name}'`,
          complete: true,
        };
      case "operand":
        return {
          phrase: `when ${
            way.operator === "otherwise"
              ? "the fallback after 'otherwise'"
              : way.operator === "default"
                ? "the 'default:' of the 'load'"
                : `the right side of the '${way.operator}'`
          } on ${line(way.at, way.file)} does not run`,
          fix: null,
        };
      case "start":
        return { phrase: "from the start of the session", fix: null };
    }
  }
}

function noJoin(): void {}

/** The operands of an expression in evaluation order. */
function expressionOperands(expression: Expression): readonly Expression[] {
  switch (expression.kind) {
    case "interactionExpression":
      return [...askOperands(expression), ...expression.options.map((option) => option.expression)];
    case "showButtonExpression":
      return [expression.label, ...showButtonOptions(expression).map((option) => option.value)];
    case "sayExpression":
      return sayOperands(expression);
    default:
      return expressionChildren(expression);
  }
}

/** The default units of the parameters whose argument a call leaves out. */
function omittedDefaults(fn: FunctionUnit, call: CallExpression): Unit[] {
  const positional = call.arguments.filter(
    (argument) => argument.kind === "positionalArgument",
  ).length;
  const named = new Set(
    call.arguments.flatMap((argument) =>
      argument.kind === "namedArgument" ? [argument.name.name] : [],
    ),
  );
  return fn.defaults.flatMap((unit, index) =>
    unit === null || index < positional || named.has(fn.declaration.parameters[index]!.name.name)
      ? []
      : [unit],
  );
}

/** The part of an expression that runs only on some ways, the operands before it, and where to name it. */
function optionalOperand(
  expression: Expression,
): {
  readonly first: readonly Expression[];
  readonly operand: Expression;
  readonly operator: "and" | "or" | "otherwise" | "default";
  readonly at: SourceSpan;
} | null {
  if (
    expression.kind === "binaryExpression" &&
    (expression.operator === "and" ||
      expression.operator === "or" ||
      expression.operator === "otherwise")
  )
    return {
      first: [expression.left],
      operand: expression.right,
      operator: expression.operator,
      at: expression.operatorSpan,
    };
  if (expression.kind === "loadExpression" && expression.defaultValue !== null)
    return {
      first: [expression.key],
      operand: expression.defaultValue,
      operator: "default",
      at: expression.defaultValue.span,
    };
  return null;
}

/** The file and label of `script(path)` or `script(path, label: name)` with literal text, or `null`. */
function literalScript(expression: Expression): { path: string; label: string | null } | null {
  let node = expression;
  while (node.kind === "parenthesizedExpression") node = node.expression;
  if (
    node.kind !== "callExpression" ||
    node.callee.kind !== "identifier" ||
    node.callee.name !== "script"
  )
    return null;
  const [first, ...rest] = node.arguments;
  if (first === undefined || first.kind !== "positionalArgument") return null;
  const path = literalText(first.value);
  if (path === null || isPathGlob(path)) return null;
  let label: string | null = null;
  for (const argument of rest) {
    if (argument.kind !== "namedArgument" || argument.name.name !== "label") return null;
    label = literalText(argument.value);
    if (label === null) return null;
  }
  return { path, label };
}

function literalText(expression: Expression): string | null {
  if (expression.kind !== "stringLiteral") return null;
  let text = "";
  for (const part of expression.parts) {
    if (part.kind === "stringInterpolation") return null;
    text += part.value;
  }
  return text;
}

/** The message for a read of a custom property that some ways to it assign and others do not. */
/**
 * A way that misses a store, as a phrase before ", nothing assigns it before this line", or a complete clause, and how
 * to assign it on that way.
 */
interface WayText {
  readonly phrase: string;
  readonly fix: string | null;
  readonly complete?: boolean;
}

function someWaysMessage(speaker: string, name: string, way: WayText | null): string {
  const missing =
    way === null
      ? "not every way to this line assigns it"
      : way.complete === true
        ? way.phrase
        : `${way.phrase}, nothing assigns it before this line`;
  const fix = `Assign it ${way?.fix ?? "on every way to this line"}`;
  return `Speaker '${speaker}' may have no '${name}' here: ${missing}. ${
    speaker === PLAYER
      ? `${fix}.`
      : `${fix}, or give it a start value, as in 'speaker ${speaker} { ${name}: ... }'.`
  }`;
}

/** Names in quotes as alternatives, as in `'a' or 'b'` and `'a', 'b', or 'c'`. */
function alternatives(names: readonly string[]): string {
  const quoted = names.map((name) => `'${name}'`);
  return quoted.length <= 2
    ? quoted.join(" or ")
    : `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function comparePlaces(left: Place, right: Place): number {
  return left.file - right.file || left.span.start.offset - right.span.start.offset;
}

/** The function declarations of a file, also those inside blocks and other functions. */
function functionDeclarations(program: Program): FunctionDeclaration[] {
  const found: FunctionDeclaration[] = [];
  const work: unknown[] = [program.statements];
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) work.push(item);
      continue;
    }
    // EVIDENCE: invariant: an object of a parser-owned AST is a node with a kind, or a span or position without one.
    const node = value as { readonly kind?: unknown };
    if (node.kind === undefined) continue;
    if (node.kind === "functionDeclaration")
      // EVIDENCE: invariant: the parser gives this kind only to function declarations.
      found.push(value as FunctionDeclaration);
    for (const nested of Object.values(value)) work.push(nested);
  }
  return found;
}
