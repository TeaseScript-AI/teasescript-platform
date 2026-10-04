import type { GlobalStatement, Program, SpeakerDeclaration, Statement } from "./ast.js";

/** A declaration that a session initializes before its story runs: a global or a speaker (ADR 0022 §6). */
export interface SessionDeclaration {
  /** The index of its file in project order: `main.tease` first, then the others by path. */
  readonly file: number;
  readonly declaration: GlobalStatement | SpeakerDeclaration;
}

/**
 * The globals and speakers of a project's files, in the order a session initializes them: by file, then by source
 * position. They may stand anywhere, also inside blocks, functions, and timer or media blocks.
 */
export function sessionDeclarations(programs: readonly Program[]): readonly SessionDeclaration[] {
  return programs.flatMap((program, file) =>
    declarationsOf(program)
      .sort((left, right) => left.span.start.offset - right.span.start.offset)
      .map((declaration) => ({ file, declaration })),
  );
}

function declarationsOf(program: Program): (GlobalStatement | SpeakerDeclaration)[] {
  const found: (GlobalStatement | SpeakerDeclaration)[] = [];
  const work: unknown[] = [program];
  while (work.length > 0) {
    const value = work.pop();
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) work.push(item);
      continue;
    }
    // EVIDENCE: invariant: an object of a parser-owned AST is a node with a kind, or a span or position without one.
    const kind = (value as { readonly kind?: unknown }).kind;
    if (kind === "globalStatement" || kind === "speakerDeclaration")
      // EVIDENCE: invariant: the parser gives these two kinds only to global and speaker declarations.
      found.push(value as GlobalStatement | SpeakerDeclaration);
    // Spans and positions hold no statements.
    if (kind === undefined) continue;
    for (const nested of Object.values(value)) work.push(nested);
  }
  return found;
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
