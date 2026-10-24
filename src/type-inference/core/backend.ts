import type { Block, Expression, Program, Statement, TypeAnnotation } from "../../ast.js";
import type { SourceSpan } from "../../source.js";
import type { TypeAnalysisBackend, TypeAnalysisOutcome, TypeAnalysisRequest } from "../backend.js";
import type { SourceSite } from "../graph.js";
import { analyseCore, type Answers } from "./answers.js";
import { BudgetExhausted } from "./budget.js";
import {
  coreCheckResult,
  coreFacts,
  declarations,
  nodeOf,
  SLICE_DEPTH,
  SliceIndex,
} from "./consumer.js";
import { withoutEmpty } from "./exact-path.js";
import type { CoreAnalysisRequest, CoreFile } from "./program.js";

/*
 * The coarse core as a type analysis backend (the port plan's S5): complete for a stated slice of the language and
 * reached only through the test-only candidate compile route (`compileSourceWithBackend` in `src/compiler.ts`), never
 * by a production compile. A program outside the slice throws `CandidateOutsideSlice` at its first construct outside
 * it, before or after the analysis: a test-time signal, never a diagnostic, since no author can reach the route; the
 * slice grows step by step until the consumer is complete (S9b).
 *
 * The slice: `let` with or without a written type (a named type, `T?` and `T[]` of them; no written union, whose
 * required checks come with narrowing, S10), assignment of a variable, `if` and `else`, `repeat` with a count, `say`
 * of plain text, and `exit`; number, boolean, null and plain text literals, variables, host values, list literals,
 * index reads and parentheses. Its consumers are C1 (a store into a written place) and C2 (a repeat count, an index);
 * its ingress is a host value stored into a written place, with C9's boundary check there. Rejected after the
 * analysis: any other consumer's diagnostic, a warning about a possible `null` (narrowing's required check, S10), a
 * variable without a written type whose kinds are no settled family or that copies a variable with one (admission,
 * S6), a host value read anywhere else or stored as a whole collection (S6's boundaries), lists nested `SLICE_DEPTH`
 * deep, and the work allowance (S8).
 */

/** Test-only: a program outside the candidate's slice, at its first construct outside it (see above). */
export class CandidateOutsideSlice extends Error {
  public constructor(
    /** The project path of the construct's file. */
    readonly path: string,
    /** The construct's site: its file's index in the project and its span's offsets. */
    readonly site: SourceSite,
    /** The construct in words, as the message names it. */
    readonly what: string,
  ) {
    super(
      `The candidate type analysis does not cover ${what} yet (${path}, offset ${site.start}).`,
    );
    this.name = "CandidateOutsideSlice";
  }
}

/** The coarse core's backend, for the stated slice (see above). */
export const CORE_BACKEND: TypeAnalysisBackend = {
  name: "core",
  analyze(request: TypeAnalysisRequest): TypeAnalysisOutcome {
    const core = coreRequest(request);
    const globals = new Set(request.options.globals ?? []);
    const before = outsideSyntax(core.files, globals);
    if (before !== null) throw outsideSlice(core, before);
    const index = new SliceIndex(core.files.map((file) => file.program));
    const answers = analyseCore(core);
    try {
      const after = outsideAnswers(answers, index, core.files, globals);
      if (after !== null) throw outsideSlice(core, after);
      const checked = coreCheckResult(answers, index, core);
      // computed here, so that a question past the allowance rejects the program instead of failing a later caller
      const facts = coreFacts(answers, index, core);
      return { checked, facts: () => facts };
    } catch (error) {
      // the questions after the analysis spend the same allowance (TABLE §8); its fallback is S8's
      if (!(error instanceof BudgetExhausted)) throw error;
      throw outsideSlice(core, overAllowance(core.files));
    }
  },
};

/** The request with what the core reads beside the programs; the compiler gives both for every file. */
function coreRequest(request: TypeAnalysisRequest): CoreAnalysisRequest {
  const files = request.files.map((file): CoreFile => {
    if (file.source === undefined || file.picks === undefined)
      throw new Error(`The coarse core needs the source and the picks of '${file.path}'.`);
    return { ...file, source: file.source, picks: file.picks };
  });
  return { ...request, files };
}

/** A construct outside the slice: where it stands and what it is. */
interface Outside {
  readonly file: number;
  readonly span: SourceSpan;
  readonly what: string;
}

/** The signal of a program outside the slice. */
function outsideSlice(request: CoreAnalysisRequest, outside: Outside): CandidateOutsideSlice {
  return new CandidateOutsideSlice(
    request.files[outside.file]!.path,
    { file: outside.file, start: outside.span.start.offset, end: outside.span.end.offset },
    outside.what,
  );
}

// ------------------------------------------------------------------------------------------------- the syntax

/** The written types of the slice: named types, `T?` and `T[]` of them. */
function annotationOutside(annotation: TypeAnnotation): TypeAnnotation | null {
  const pending: [TypeAnnotation, number][] = [[annotation, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [type, depth] = next;
    switch (type.kind) {
      case "namedType":
        break;
      case "optionalType":
        pending.push([type.value, depth]);
        break;
      case "listType":
        // a list at the facts' deepest depth (`SLICE_DEPTH`)
        if (depth + 1 >= SLICE_DEPTH) return type;
        pending.push([type.element, depth + 1]);
        break;
      default:
        return type;
    }
  }
  return null;
}

/**
 * The first construct of the files outside the slice's syntax, in source order: a statement, an expression, a written
 * type, or a name that is neither one of its file's variables nor a host value (a built-in, a speaker).
 */
function outsideSyntax(files: readonly CoreFile[], globals: ReadonlySet<string>): Outside | null {
  for (const [file, { program }] of files.entries()) {
    const lets = letNames(program);
    const outside = (span: SourceSpan, what: string): Outside => ({ file, span, what });
    const pending: (Statement | Expression)[] = [...program.statements].reverse();
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      // children are pushed last to first, so they are visited in source order
      const push = (children: readonly (Statement | Expression | Block | null)[]): void => {
        for (let position = children.length - 1; position >= 0; position -= 1) {
          const child = children[position];
          if (child === null || child === undefined) continue;
          if (child.kind === "block")
            for (let at = child.statements.length - 1; at >= 0; at -= 1)
              pending.push(child.statements[at]!);
          else pending.push(child);
        }
      };
      switch (node.kind) {
        case "letStatement": {
          const written =
            node.typeAnnotation === null ? null : annotationOutside(node.typeAnnotation);
          if (written !== null) return outside(written.span, "this written type");
          push([node.initializer]);
          break;
        }
        case "assignmentStatement":
          if (node.operator !== "=" || node.target.kind !== "identifier")
            return outside(node.span, "this assignment");
          push([node.target, node.value]);
          break;
        case "ifStatement":
          push([node.condition, node.thenBlock, node.elseBlock]);
          break;
        case "repeatStatement":
          push([node.count, node.body]);
          break;
        case "sayStatement":
          if (
            node.presentation !== null ||
            node.speaker !== null ||
            node.skipPolicy !== null ||
            node.pacing !== null ||
            node.value.kind !== "stringLiteral" ||
            node.value.parts.some((part) => part.kind !== "stringText")
          )
            return outside(node.span, "this say");
          break;
        case "exitStatement":
        case "numberLiteral":
        case "booleanLiteral":
        case "nullLiteral":
          break;
        case "stringLiteral":
          if (node.parts.some((part) => part.kind !== "stringText"))
            return outside(node.span, "text with interpolation");
          break;
        case "identifier":
          if (!lets.has(node.name) && !globals.has(node.name))
            return outside(node.span, `the name '${node.name}'`);
          break;
        case "listLiteral":
          push(node.elements);
          break;
        case "indexExpression":
          push([node.object, node.index]);
          break;
        case "parenthesizedExpression":
          push([node.expression]);
          break;
        default:
          return outside(node.span, `this ${describe(node.kind)}`);
      }
    }
  }
  return null;
}

/** A node kind in words: `ifStatement` is "if statement". */
function describe(kind: string): string {
  return kind.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/** The names a file's `let` statements declare, at any depth. */
function letNames(program: Program): Set<string> {
  const names = new Set<string>();
  const pending: (readonly Statement[])[] = [program.statements];
  for (let list = pending.pop(); list !== undefined; list = pending.pop())
    for (const statement of list)
      switch (statement.kind) {
        case "letStatement":
          names.add(statement.name.name);
          break;
        case "ifStatement":
          pending.push(statement.thenBlock.statements);
          if (statement.elseBlock !== null)
            pending.push(
              statement.elseBlock.kind === "block"
                ? statement.elseBlock.statements
                : [statement.elseBlock],
            );
          break;
        case "repeatStatement":
          pending.push(statement.body.statements);
          break;
      }
  return names;
}

// ------------------------------------------------------------------------------------------------- the answers

/** The integer and number family (A3): one kind, or `integer` with `number`, with or without `null`. */
function settledFamily(tags: readonly string[]): boolean {
  const kinds = new Set(tags.filter((tag) => tag !== "null"));
  return kinds.size <= 1 || (kinds.size === 2 && kinds.has("integer") && kinds.has("number"));
}

/** A program whose analysis crossed the work allowance (S8's fallback). */
function overAllowance(files: readonly CoreFile[]): Outside {
  return {
    file: 0,
    span: files[0]!.program.span,
    what: "a program over the analysis's work allowance",
  };
}

/** The first answer of the analysis that leaves the slice (see the module's comment), or `null`. */
function outsideAnswers(
  answers: Answers,
  index: SliceIndex,
  files: readonly CoreFile[],
  globals: ReadonlySet<string>,
): Outside | null {
  const at = (site: { readonly file: number; readonly start: number; readonly end: number }) =>
    index.spanAt(site);
  if (answers.outcome === "budget-error") return overAllowance(files);
  for (const diagnostic of answers.diagnostics) {
    if (diagnostic.kind === "member-read" || diagnostic.kind === "operator")
      return {
        file: diagnostic.site.file,
        span: at(diagnostic.site),
        what: diagnostic.kind === "member-read" ? "this member or element read" : "this operand",
      };
    if (diagnostic.class === "warning-runtime-check" && diagnostic.obligation.kind === "null-check")
      return {
        file: diagnostic.site.file,
        span: at(diagnostic.site),
        what: "a value that may be null here",
      };
  }
  // admission (S6): a variable without a written type that copies a variable with a written type, or a part of one, is
  // decided by that type (A4), which the slice does not carry; such a copy is outside it
  const lets = declarations(answers, index);
  for (const statement of index.statements) {
    if (statement.kind !== "letStatement" && statement.kind !== "assignmentStatement") continue;
    const destination = answers.at(nodeOf(answers, index, statement))?.place;
    const declaration =
      destination === null || destination === undefined ? undefined : lets.get(destination.id);
    if (declaration === undefined || declaration.typeAnnotation !== null) continue;
    // the reads whose value the store carries: through parentheses, list elements and the lists an index reads
    const pending: Expression[] = [
      statement.kind === "letStatement" ? statement.initializer : statement.value,
    ];
    for (let value = pending.pop(); value !== undefined; value = pending.pop())
      if (value.kind === "parenthesizedExpression") pending.push(value.expression);
      else if (value.kind === "indexExpression") pending.push(value.object);
      else if (value.kind === "listLiteral")
        for (const element of value.elements) pending.push(element);
      else if (value.kind === "identifier") {
        const read = answers.at(nodeOf(answers, index, value))?.place;
        const source = read === null || read === undefined ? undefined : lets.get(read.id);
        if (source !== undefined && source.typeAnnotation !== null)
          return {
            file: index.fileOf(value),
            span: value.span,
            what: `this copy of '${value.name}', which has a written type, into '${declaration.name.name}', which has none`,
          };
      }
  }
  // admission (S6): a variable without a written type takes one settled family, without external data, at every depth
  // (A3)
  for (const statement of index.lets)
    if (statement.typeAnnotation === null) {
      const place = answers.at(nodeOf(answers, index, statement))?.place;
      if (place === null || place === undefined) continue;
      for (let path: string[] = [...place.path]; ; path = [...path, "element"]) {
        const kinds = withoutEmpty([...answers.place(place.id, path).contract.kinds]);
        const tags = kinds.map((item) => item.tag);
        if (tags.includes("unknown") || !settledFamily(tags))
          return {
            file: index.fileOf(statement),
            span: statement.name.span,
            what: `the variable '${statement.name.name}', whose stores do not settle one type`,
          };
        if (!tags.includes("list")) break;
        if (path.length + 1 >= SLICE_DEPTH)
          return {
            file: index.fileOf(statement),
            span: statement.name.span,
            what: `the variable '${statement.name.name}', whose lists nest deeper than the slice follows`,
          };
      }
    }
  // A8 (S6): a list literal that no store brings whole into a written place holds one settled family
  for (const list of index.lists)
    if (!storedIntoWritten(answers, index, list)) {
      const tags = withoutEmpty([...answers.project(nodeOf(answers, index, list), "element")])
        .map((item) => item.tag)
        .filter((tag) => tag !== "unknown");
      if (!settledFamily(tags))
        return {
          file: index.fileOf(list),
          span: list.span,
          what: "a list whose elements do not settle one type",
        };
    }
  // C9 (S6): a host value is read only where a store brings it into a written place, which checks it there; stored
  // whole as a collection, what its elements owe beside the boundary check is admission's
  const boundaries = new Set<string>();
  for (const check of answers.checks)
    if (check.boundary) {
      if (check.against.some((kind) => kind === "list" || kind === "set" || kind === "dict"))
        return {
          file: check.site.file,
          span: index.spanAt(check.site),
          what: "external data stored as a whole collection",
        };
      boundaries.add(`${check.site.file}:${check.site.start}:${check.site.end}`);
    }
  for (const read of index.reads)
    if (globals.has(read.name)) {
      const file = index.fileOf(read);
      if (!boundaries.has(`${file}:${read.span.start.offset}:${read.span.end.offset}`))
        return {
          file,
          span: read.span,
          what: "a host value read outside a store into a typed variable",
        };
    }
  return null;
}

/** Whether a store brings `expression` whole into a variable with a written type, whose C1 checks it (A1, A8). */
function storedIntoWritten(answers: Answers, index: SliceIndex, expression: Expression): boolean {
  const store = index.storeOf(expression);
  if (store === undefined || !index.storedWhole(expression)) return false;
  const place = answers.at(nodeOf(answers, index, store))?.place;
  return (
    place !== null &&
    place !== undefined &&
    answers.place(place.id, place.path).admitted.by === "written"
  );
}
