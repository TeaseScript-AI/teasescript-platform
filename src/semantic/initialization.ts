import type { Program, Statement } from "../ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "../diagnostics.js";
import type { StatementFlow } from "../reachability.js";
import type { SemanticValidator } from "../semantic.js";
import { semanticCode } from "./diagnostics.js";

// The initialization check (TSV054): a use of a top-level variable that a goto can make miss its `let`.

/** Where code runs, for the initialization check: a top-level statement, a function, or a handler and its origin. */
export type FlowContext =
  | { readonly kind: "root"; readonly statement: number }
  | { readonly kind: "function"; readonly name: string }
  /** A block runs where its timer or media started: in `origin`, when `created` runs. */
  | { readonly kind: "handler"; readonly origin: FlowContext; readonly created: Statement };

/**
 * A goto can reach a label without running the top-level `let`s between the place it starts and the label. A use of
 * a variable of the file is an error when a goto can make it miss its `let`: it has a value on every way there
 * without gotos, but not on every way with them. A goto has run what came before the statement it stands in, or
 * before the call of its function or the start of its handler. Which statements run and continue is the flow of the
 * type check, so this check and the ending check agree. A file starts at its top, so only a goto within it reaches a
 * label (V30 §26). Other early uses, such as a function called before the `let`, are checked when they run.
 */
export function checkInitialization(
  validator: SemanticValidator,
  program: Program,
  flow: StatementFlow,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (validator.gotos.length === 0 || validator.rootAccesses.length === 0) return diagnostics;
  // Only the variables that are used need following.
  const used = new Set(validator.rootAccesses.map((access) => access.name));
  const withGotos = initializedVariables(validator, program, flow, used, true);
  const withoutGotos = initializedVariables(validator, program, flow, used, false);
  const reported = new Set<string>();
  for (const access of validator.rootAccesses) {
    if (flow.unreachable.has(access.statement)) continue;
    const known = withGotos(access.context);
    const knownWithoutGotos = withoutGotos(access.context);
    if (
      known === null ||
      known.has(access.name) ||
      (knownWithoutGotos !== null && !knownWithoutGotos.has(access.name))
    )
      continue;
    const key = `${access.span.start.offset}:${access.name}`;
    if (reported.has(key)) continue;
    reported.add(key);
    diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Error,
        semanticCode.skippedInitialization,
        `A goto can reach this line without running 'let ${access.name}' first, so ${access.name} may have no value here. Move the label that the goto jumps to before 'let ${access.name}', or set ${access.name} on every way here.`,
        access.span,
      ),
    );
  }
  return diagnostics;
}

/**
 * The top-level variables that have a value wherever code of a context runs, following gotos or not. `null` stands
 * for "every variable": no way there is known, so nothing is missing.
 */
function initializedVariables(
  validator: SemanticValidator,
  program: Program,
  flow: StatementFlow,
  used: ReadonlySet<string>,
  followGotos: boolean,
): (context: FlowContext) => ReadonlySet<string> | null {
  type Known = ReadonlySet<string> | null;
  const statements = program.statements;
  const meet = (left: Known, right: Known): Known =>
    left === null
      ? right
      : right === null
        ? left
        : new Set([...left].filter((name) => right.has(name)));
  // Function declarations run nothing; the file starts at its first other statement.
  const order = statements.flatMap((statement, index) =>
    statement.kind === "functionDeclaration" ? [] : [index],
  );
  const before: Known[] = statements.map((_, index) => (index === order[0] ? new Set() : null));
  const after = (index: number): Known => {
    const known = before[index]!;
    const statement = statements[index]!;
    return known !== null &&
      statement.kind === "letStatement" &&
      used.has(statement.name.name) &&
      !known.has(statement.name.name)
      ? new Set([...known, statement.name.name])
      : known;
  };
  const functionStart = new Map<string, Known>();
  // A handler starts with what ran where it was created; handlers nest without limit, so this is a loop.
  const atContext = (start: FlowContext): Known => {
    let context = start;
    while (context.kind === "handler") {
      if (flow.unreachable.has(context.created)) return null;
      context = context.origin;
    }
    return context.kind === "root"
      ? before[context.statement]!
      : (functionStart.get(context.name) ?? null);
  };
  const calls = validator.calls.filter((call) => !flow.unreachable.has(call.statement));
  const gotos = validator.gotos.filter((goto) => !flow.unreachable.has(goto.statement));
  for (let changed = true; changed;) {
    changed = false;
    // A function starts with what every call of it has run; one never called adds nothing.
    for (let functionsChanged = true; functionsChanged;) {
      functionsChanged = false;
      const starts = new Map<string, Known>();
      for (const call of calls) {
        starts.set(
          call.name,
          starts.has(call.name)
            ? meet(starts.get(call.name)!, atContext(call.context))
            : atContext(call.context),
        );
      }
      for (const [name, known] of starts) {
        if (!sameKnown(functionStart.get(name) ?? null, known)) {
          functionStart.set(name, known);
          functionsChanged = true;
        }
      }
    }
    for (let position = 1; position < order.length; position += 1) {
      const index = order[position]!;
      const previous = order[position - 1]!;
      let known: Known = flow.continuing.has(statements[previous]!) ? after(previous) : null;
      const statement = statements[index]!;
      if (followGotos && statement.kind === "labelStatement") {
        for (const goto of gotos) {
          if (goto.label === statement.name.name) known = meet(known, atContext(goto.context));
        }
      }
      if (!sameKnown(before[index]!, known)) {
        before[index] = known;
        changed = true;
      }
    }
  }
  return atContext;
}

function sameKnown(left: ReadonlySet<string> | null, right: ReadonlySet<string> | null): boolean {
  if (left === null || right === null) return left === right;
  return left.size === right.size && [...left].every((name) => right.has(name));
}
