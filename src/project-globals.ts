import type {
  CallExpression,
  Expression,
  ExpressionStatement,
  GlobalStatement,
  Identifier,
  Program,
  SpeakerDeclaration,
  Statement,
} from "./ast.js";
import { createSourcePosition, createSourceSpan } from "./source.js";
import { PLAYER } from "./speaker-terms.js";

/** A declaration that a session initializes before its story runs: a global or a speaker (ADR 0022 §6). */
export interface SessionDeclaration {
  /** The index of its file in project order: `main.tease` first, then the others by path. */
  readonly file: number;
  readonly declaration: GlobalStatement | SpeakerDeclaration;
}

const START = createSourceSpan(createSourcePosition(0, 0, 0), createSourcePosition(0, 0, 0));

/**
 * The built-in speaker `player` (V30 §37), which a session sets up first, without properties, as a speaker that
 * `main.tease` declares at its start; no script declares it. Only code that names `player` can reach it, so a project
 * that never names it does not set it up.
 */
export const PLAYER_DECLARATION: SpeakerDeclaration = Object.freeze({
  kind: "speakerDeclaration",
  name: Object.freeze({ kind: "identifier", name: PLAYER, span: START }),
  properties: Object.freeze([]),
  span: START,
});

/** What a file holds for the session start, found in one walk over it (see {@link fileSurvey}). */
interface FileSurvey {
  /** Its globals and speakers by source position. */
  readonly declarations: readonly (GlobalStatement | SpeakerDeclaration)[];
  readonly namesPlayer: boolean;
  /** Its first `player.copyFrom(account)` statement in walk order: its call. */
  readonly accountCopy: CallExpression | undefined;
  readonly setsDefaultSpeaker: boolean;
}

/** The survey of each file, so a compile walks a file once for all its validations, checks, and its lowering. */
const surveys = new WeakMap<Program, FileSurvey>();

function fileSurvey(program: Program): FileSurvey {
  const known = surveys.get(program);
  if (known !== undefined) return known;
  const declarations: (GlobalStatement | SpeakerDeclaration)[] = [];
  let namesPlayer = false;
  let copy: CallExpression | undefined;
  let setsDefault = false;
  someNode(program, (node) => {
    if (node.kind === "globalStatement" || node.kind === "speakerDeclaration")
      // EVIDENCE: invariant: the parser gives these two kinds only to global and speaker declarations.
      declarations.push(node as GlobalStatement | SpeakerDeclaration);
    else if (node.kind === "identifier")
      // EVIDENCE: invariant: the parser gives this kind only to identifiers, each with its name.
      namesPlayer ||= (node as Identifier).name === PLAYER;
    else if (node.kind === "speakerSetterStatement") setsDefault = true;
    else if (node.kind === "expressionStatement" && copy === undefined) {
      // EVIDENCE: invariant: the parser gives this kind only to expression statements.
      const { expression } = node as ExpressionStatement;
      if (copiesAccount(expression)) copy = expression;
    }
    return false;
  });
  const survey: FileSurvey = Object.freeze({
    declarations: Object.freeze(
      declarations.sort((left, right) => left.span.start.offset - right.span.start.offset),
    ),
    namesPlayer,
    accountCopy: copy,
    setsDefaultSpeaker: setsDefault,
  });
  surveys.set(program, survey);
  return survey;
}

/**
 * The globals and speakers of a project, in the order a session initializes them: the built-in `player` when a file
 * names it, then those of the files by file and source position. They may stand anywhere, also inside blocks,
 * functions, and timer or media blocks.
 */
export function sessionDeclarations(programs: readonly Program[]): readonly SessionDeclaration[] {
  const surveyed = programs.map(fileSurvey);
  const declared = surveyed.flatMap(({ declarations }, file) =>
    declarations.map((declaration) => ({ file, declaration })),
  );
  return surveyed.some((survey) => survey.namesPlayer)
    ? [{ file: 0, declaration: PLAYER_DECLARATION }, ...declared]
    : declared;
}

/** Whether `expression` is `player.copyFrom(account)`, the one form of `copyFrom` (V30 §37). */
export function copiesAccount(expression: Expression): expression is CallExpression {
  if (expression.kind !== "callExpression" || expression.arguments.length !== 1) return false;
  const { callee } = expression;
  const argument = expression.arguments[0]!;
  return (
    callee.kind === "propertyAccessExpression" &&
    callee.property.name === "copyFrom" &&
    callee.object.kind === "identifier" &&
    callee.object.name === PLAYER &&
    argument.kind === "positionalArgument" &&
    argument.value.kind === "identifier" &&
    argument.value.name === "account"
  );
}

/**
 * A `player.copyFrom(account)` statement in a file of the project, wherever it stands, or `undefined` without one: its
 * call.
 */
export function accountCopy(programs: readonly Program[]): CallExpression | undefined {
  for (const program of programs) {
    const copy = fileSurvey(program).accountCopy;
    if (copy !== undefined) return copy;
  }
  return undefined;
}

/** Whether a statement of the project sets the default speaker, as `speaker vera` does, wherever it stands. */
export function setsDefaultSpeaker(programs: readonly Program[]): boolean {
  return programs.some((program) => fileSurvey(program).setsDefaultSpeaker);
}

/** An object of a parser-owned AST: a node with a kind, or a span or position without one. */
interface AstObject {
  readonly kind?: unknown;
}

/** Whether `test` holds for a node of a parser-owned AST, also inside blocks, functions, and expressions. */
export function someNode(
  root: Program | Statement | Expression,
  test: (node: AstObject) => boolean,
): boolean {
  const work: unknown[] = [root];
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) work.push(item);
      continue;
    }
    // EVIDENCE: invariant: an object of a parser-owned AST is a node with a kind, or a span or position without one.
    const node = value as AstObject;
    // Spans and positions hold no statements.
    if (node.kind === undefined) continue;
    if (test(node)) return true;
    for (const nested of Object.values(value)) work.push(nested);
  }
  return false;
}

/**
 * Whether a top-level statement runs anything where it stands. A speaker, or a global without `default:`, is set up at
 * the start of the session instead; a function only runs when called.
 */
export function runsOnItsOwn(statement: Statement): boolean {
  return !(
    statement.kind === "functionDeclaration" ||
    statement.kind === "speakerDeclaration" ||
    (statement.kind === "globalStatement" && statement.assignment === null)
  );
}
