import type {
  Block,
  CallExpression,
  Expression,
  Program,
  Statement,
  TransferTarget,
} from "../ast.js";
import { isFileStoreCall, isLockCall } from "../capture-call.js";
import { changesEntries } from "../dict-operations.js";
import {
  expressionParts,
  handlerBlocks,
  nestedStatements,
  statementExpressions,
  unwrap,
} from "../expression-children.js";
import { CORE_RUNTIME_BUILTINS, PLATFORM_STANDARD_LIBRARY_PRELUDE } from "../language-facts.js";
import { changesElements } from "../list-methods.js";
import { noteSharing, rootName, type Sharing } from "../operation-checks.js";
import { globMatches, MAIN_FILE_PATH } from "../project-paths.js";
import { placeKey } from "../way-facts.js";

// What the code of a project may change (ADR 0021 rule 5.5): the names that functions and timer, media, and button
// blocks assign or change in place, what each loop may do before its next test, and which files enter main.tease
// again. The type analysis takes narrowing (rule 5.5) and the facts of a loop from these; code found never to run
// changes nothing.

/**
 * What one iteration of a loop may do before the next test: the variables it assigns or changes in place, and whether it
 * may suspend.
 */
export interface LoopEffects {
  readonly writes: ReadonlyMap<string, Sharing>;
  readonly suspends: boolean;
}

const SUSPENDING_STATEMENTS: ReadonlySet<Statement["kind"]> = new Set([
  "sayStatement",
  "showButtonStatement",
  "showPopupStatement",
  "openUrlStatement",
  "exportTextStatement",
  "waitStatement",
  "timerStatement",
  "playMediaStatement",
  "showImageStatement",
  "hideImageStatement",
  "showCameraStatement",
  "hideCameraStatement",
  "stopAudioStatement",
  "saveStatement",
  "deleteStatement",
  // Blocks of the caller keep running while a called file runs.
  "callFileStatement",
]);

/** What a program's loops and functions may change (ADR 0021 rule 5.5). */
export interface ProgramEffects {
  /** Names that function bodies and timer or media blocks assign or change in place. */
  readonly shared: ReadonlyMap<string, Sharing>;
  /** Names that the file's top level assigns or changes, which another file's `call` may run (ADR 0022 §5). */
  readonly rootAssigned: ReadonlyMap<string, Sharing>;
  /** Whether the file calls a file, so another file's top level may run during the call. */
  readonly callsFiles: boolean;
  /** Whether the file enters `main.tease` again at its top, after the start values have run. */
  readonly entersMain: boolean;
  /** The effects of each loop, by its body; a `while` loop includes its condition. */
  readonly loops: ReadonlyMap<Block, LoopEffects>;
}

/**
 * The code that a check found never runs: the statements of a branch or loop body that no value takes or after a
 * statement that never continues, and by place the `and`, `or`, and `otherwise` whose right side never runs.
 */
export interface DeadCode {
  readonly statements: ReadonlySet<Statement>;
  readonly operands: ReadonlySet<string>;
}

/** Whether `found` holds all of `dead`. */
export function coversDeadCode(found: DeadCode, dead: DeadCode): boolean {
  for (const statement of dead.statements) if (!found.statements.has(statement)) return false;
  for (const place of dead.operands) if (!found.operands.has(place)) return false;
  return true;
}

/** What the code of a project may change, as the check uses it. */
export interface ProjectEffects {
  readonly files: readonly ProgramEffects[];
  readonly loops: ReadonlyMap<Block, LoopEffects>;
  /** The globals that a function or a timer or media block of any file assigns or changes in place, with how. */
  readonly sharedGlobals: ReadonlyMap<string, Sharing>;
}

/** What the code of each file may change, leaving out the code that never runs. */
export function projectEffects(programs: readonly Program[], dead: DeadCode): ProjectEffects {
  const files = programs.map((program, file) => programEffects(program, file, dead));
  const sharedGlobals = new Map<string, Sharing>();
  for (const fileEffects of files)
    for (const [name, how] of fileEffects.shared) noteSharing(sharedGlobals, name, how);
  // While a `call` runs, any file's top level may run and assign globals (ADR 0022 §5, §6).
  if (files.some((fileEffects) => fileEffects.callsFiles))
    for (const fileEffects of files)
      for (const [name, how] of fileEffects.rootAssigned) noteSharing(sharedGlobals, name, how);
  return {
    files,
    loops: new Map(files.flatMap((fileEffects) => [...fileEffects.loops])),
    sharedGlobals,
  };
}

/** Whether two sets of effects give a check the same facts. */
export function sameProjectEffects(left: ProjectEffects, right: ProjectEffects): boolean {
  const sameSharing = (
    one: ReadonlyMap<string, Sharing>,
    other: ReadonlyMap<string, Sharing>,
  ): boolean => one.size === other.size && [...one].every(([name, how]) => other.get(name) === how);
  return (
    sameSharing(left.sharedGlobals, right.sharedGlobals) &&
    left.files.every(
      (fileEffects, file) =>
        fileEffects.entersMain === right.files[file]!.entersMain &&
        sameSharing(fileEffects.shared, right.files[file]!.shared),
    ) &&
    [...left.loops].every(([body, loop]) => {
      const other = right.loops.get(body);
      return (
        other !== undefined &&
        loop.suspends === other.suspends &&
        sameSharing(loop.writes, other.writes)
      );
    })
  );
}

interface LoopNode {
  readonly body: Block;
  readonly parent: LoopNode | null;
  readonly writes: Map<string, Sharing>;
  suspends: boolean;
}

/** A node to walk, with the innermost loop around it, whether it stands in a function or block, and whether it runs. */
type EffectWork = {
  readonly loop: LoopNode | null;
  readonly inside: boolean;
  readonly runs: boolean;
} & ({ readonly statement: Statement } | { readonly expression: Expression });

/**
 * Collects in one pass the names that functions and blocks assign, and the effects of every loop. A loop's effects
 * include those of the loops inside it, but not those of timer or media blocks it starts, which run later. Code that
 * `dead` holds never runs, so it changes nothing; a loop in it has effects of its own, for the check of its body.
 */
function programEffects(program: Program, file: number, dead: DeadCode): ProgramEffects {
  const shared = new Map<string, Sharing>();
  const rootAssigned = new Map<string, Sharing>();
  let callsFiles = false;
  let entersMain = false;
  const nodes: LoopNode[] = [];
  const work: EffectWork[] = [];
  const enter = (
    statements: readonly Statement[],
    loop: LoopNode | null,
    inside: boolean,
    runs: boolean,
  ): void => {
    for (let index = statements.length - 1; index >= 0; index -= 1)
      work.push({ statement: statements[index]!, loop, inside, runs });
  };
  const loopNode = (body: Block, parent: LoopNode | null): LoopNode => {
    const node: LoopNode = { body, parent, writes: new Map(), suspends: false };
    nodes.push(node);
    return node;
  };
  enter(program.statements, null, false, true);
  while (work.length > 0) {
    const item = work.pop()!;
    // Code that never runs is part of no loop around it.
    const runs = item.runs && !("statement" in item && dead.statements.has(item.statement));
    const loop = runs === item.runs ? item.loop : null;
    const { inside } = item;
    const write = (name: string, how: Sharing): void => {
      if (runs) noteSharing(inside ? shared : rootAssigned, name, how);
      if (loop !== null) noteSharing(loop.writes, name, how);
    };
    const handlers = (node: Statement | Expression): void => {
      for (const block of handlerBlocks(node)) enter(block.statements, null, true, runs);
    };
    if ("expression" in item) {
      const expression = item.expression;
      if (
        loop !== null &&
        (expression.kind === "interactionExpression" ||
          expression.kind === "sayExpression" ||
          expression.kind === "showButtonExpression" ||
          expression.kind === "showPopupExpression" ||
          expression.kind === "timerExpression" ||
          expression.kind === "playMediaExpression" ||
          expression.kind === "showCameraExpression" ||
          (expression.kind === "callExpression" && !isPureBuiltinCall(expression)))
      )
        loop.suspends = true;
      // A method that changes a list, set, or dict changes the variable that holds it, also called in parentheses.
      const callee = expression.kind === "callExpression" ? unwrap(expression.callee) : null;
      if (
        callee?.kind === "propertyAccessExpression" &&
        (changesElements(callee.property.name) || changesEntries(callee.property.name))
      ) {
        const root = rootName(callee.object);
        if (root !== null) write(root, "changes");
      }
      handlers(expression);
      // The right side of an `and`, `or`, or `otherwise` that never runs changes nothing.
      const skipped =
        expression.kind === "binaryExpression" &&
        (expression.operator === "and" ||
          expression.operator === "or" ||
          expression.operator === "otherwise") &&
        dead.operands.has(placeKey(file, expression.span))
          ? expression.right
          : null;
      for (const part of expressionParts(expression))
        work.push(
          part === skipped
            ? { expression: part, loop: null, inside, runs: false }
            : { expression: part, loop, inside, runs },
        );
      continue;
    }
    const statement = item.statement;
    if (loop !== null && SUSPENDING_STATEMENTS.has(statement.kind)) loop.suspends = true;
    if (runs && statement.kind === "callFileStatement") callsFiles = true;
    if (
      runs &&
      (statement.kind === "gotoStatement" || statement.kind === "callFileStatement") &&
      entersMainAtTop(statement.target)
    )
      entersMain = true;
    // The `default:` form of a global assigns it where the declaration runs.
    if (runs && statement.kind === "globalStatement" && statement.assignment !== null)
      noteSharing(inside ? shared : rootAssigned, statement.name.name, "assigns");
    if (statement.kind === "assignmentStatement") {
      // A store into an element or property changes the variable that holds it in place, too.
      const root = rootName(statement.target);
      if (root !== null)
        write(root, statement.target.kind === "identifier" ? "assigns" : "changes");
      // A timer or media property write may run a block at once.
      if (statement.target.kind !== "identifier" && loop !== null) loop.suspends = true;
    }
    handlers(statement);
    switch (statement.kind) {
      case "functionDeclaration":
        enter(statement.body.statements, null, true, runs);
        // A parameter default runs in the function too, and the blocks it shows run later.
        for (const parameter of statement.parameters)
          if (parameter.defaultValue !== null)
            work.push({ expression: parameter.defaultValue, loop: null, inside: true, runs });
        continue;
      case "whileStatement": {
        const node = loopNode(statement.body, loop);
        enter(statement.body.statements, node, inside, runs);
        work.push({ expression: statement.condition, loop: node, inside, runs });
        continue;
      }
      case "repeatStatement":
      case "forStatement":
        enter(statement.body.statements, loopNode(statement.body, loop), inside, runs);
        break;
      default:
        enter(nestedStatements(statement), loop, inside, runs);
    }
    for (const expression of statementExpressions(statement))
      work.push({ expression, loop, inside, runs });
  }
  // Inner loops come after the loops around them, so walking backwards adds each loop's effects to its parent.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    if (node.parent === null) continue;
    for (const [name, how] of node.writes) noteSharing(node.parent.writes, name, how);
    node.parent.suspends ||= node.suspends;
  }
  return {
    shared,
    rootAssigned,
    callsFiles,
    entersMain,
    loops: new Map(
      nodes.map((node) => [node.body, { writes: node.writes, suspends: node.suspends }]),
    ),
  };
}

/**
 * Whether a target may enter main.tease at its top: a file target naming it or a glob that may pick it, and any computed
 * target but a `script(...)` whose literal path names another file.
 */
function entersMainAtTop(target: TransferTarget): boolean {
  if (target.kind === "labelTarget") return false;
  if (target.kind === "fileTarget") return globMatches(target.path, [MAIN_FILE_PATH]).length > 0;
  const reference = unwrap(target.expression);
  const path =
    reference.kind === "callExpression" &&
    reference.callee.kind === "identifier" &&
    reference.callee.name === "script"
      ? reference.arguments.find((argument) => argument.kind === "positionalArgument")?.value
      : undefined;
  const literal = path === undefined ? null : unwrap(path);
  const text =
    literal?.kind === "stringLiteral" && literal.parts.every((part) => part.kind === "stringText")
      ? literal.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("")
      : null;
  // Only a literal path is known, and only one to another file stays out of main.tease.
  return text === null || text === MAIN_FILE_PATH;
}

const PURE_BUILTINS: ReadonlySet<string> = new Set([
  ...CORE_RUNTIME_BUILTINS,
  ...PLATFORM_STANDARD_LIBRARY_PRELUDE,
]);

/** A call of a built-in without effects on script variables or time. */
function isPureBuiltinCall(expression: CallExpression): boolean {
  const callee = expression.callee;
  return (
    callee.kind === "identifier" &&
    PURE_BUILTINS.has(callee.name) &&
    !isFileStoreCall(expression) &&
    !isLockCall(expression)
  );
}
