import type {
  Block,
  CallArgument,
  CallExpression,
  Expression,
  Program,
  Statement,
  TypeAnnotation,
} from "../../ast.js";
import { CONVERSIONS, isConversion, type Conversion } from "../../conversions.js";
import { dictMethod } from "../../dict-operations.js";
import { listMethod } from "../../list-methods.js";
import { isTextMethod, TEXT_METHODS } from "../../text-operations.js";
import type { SourceSpan } from "../../source.js";
import type { TypeAnalysisBackend, TypeAnalysisOutcome, TypeAnalysisRequest } from "../backend.js";
import type { SourceSite } from "../graph.js";
import { analyseCore, type Answers } from "./answers.js";
import { methodCategory } from "./method-categories.js";
import { BudgetExhausted } from "./budget.js";
import {
  coreCheckResult,
  coreFacts,
  nodeOf,
  SLICE_DEPTH,
  SliceIndex,
  OutsideContract,
} from "./consumer.js";
import type { CoreAnalysisRequest, CoreFile } from "./program.js";

/*
 * The coarse core as a type analysis backend (the port plan's S5): complete for a stated slice of the language and
 * reached only through the test-only candidate compile route (`compileSourceWithBackend` in `src/compiler.ts`), never
 * by a production compile. A program outside the slice throws `CandidateOutsideSlice` at its first construct outside
 * it, before or after the analysis: a test-time signal, never a diagnostic, since no author can reach the route; the
 * slice grows step by step until the consumer is complete (S9b).
 *
 * The slice: `let` with or without a written type (a named type, `T?` and `T[]` of them; no written union, whose
 * required checks come with narrowing, S10), assignment of a variable or of a property, `if` and `else`, `repeat` with
 * a count, `for` with one or two variables, `say` of plain text or of a value, a call as a statement, and `exit`;
 * number, boolean, null, regex and plain text literals, variables, host values, list and object literals, index and
 * property reads, ranges, `otherwise`, a list's `get` with its `default:`, a method of text, a list, a set or a dict that
 * changes nothing in its receiver and a list's `sort`, `toJson` of a value, the conversions of a value with their `default:`, `fromJson`, `fileFromBase64`,
 * `decryptText` and `decryptFile`, a `load` of a key written as text once in the project with a default that is no
 * `null`, and parentheses (S7: the constructs of the discharge map's new rows). Its consumers are C1 (a store into a
 * place with a written or decided type, A1–A9, with A6's rejections and a literal's elements of one type), C2 (a repeat
 * count, an index), C5 (a member of a receiver at a read or a store), C10 (a fallback or a default) and C13 (a `for`
 * loop's iterable, a method's arguments and the elements `join` and `sort` read); its ingresses are a host value, a load
 * and a parse, with C9's boundary check where it enters (the store's destination's admitted type) or where it is read.
 * Rejected after the analysis: any other consumer's diagnostic, a warning about a possible `null` (narrowing's required
 * check, S10), a property read of a value that may be no object, a value `say` may not show, an argument of another
 * kind than a built-in function takes (the built-in signature check C13, S9b), and lists nested `SLICE_DEPTH` deep. A
 * stop of the analysis is no exclusion: the program compiles with the stop's warning and its checks at runtime (D4 a′).
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
    // the walk of each file once, in project order (S3 §6), where the progress callback hears of it
    const index = new SliceIndex(
      core.files.map((file) => file.program),
      request.onFile,
    );
    const answers = analyseCore(core);
    try {
      return outcomeOf(answers, index, core);
    } catch (error) {
      // the questions after the analysis spend the same allowance (TABLE §8): one past it stops there, the finished
      // analysis's findings and decisions standing, and what is asked from then on answers `STOPPED` (D4 a′)
      if (!(error instanceof BudgetExhausted)) throw error;
      return outcomeOf(answers.stoppedAt(error.limit), index, core);
    }
  },
};

/** The compiler's view of the core's answers to a program inside the slice, the facts computed here, before a caller. */
function outcomeOf(
  answers: Answers,
  index: SliceIndex,
  core: CoreAnalysisRequest,
): TypeAnalysisOutcome {
  try {
    const after = outsideAnswers(answers, index);
    if (after !== null) throw outsideSlice(core, after);
    const checked = coreCheckResult(answers, index, core);
    const facts = coreFacts(answers, index, core);
    return { checked, facts: () => facts };
  } catch (error) {
    if (error instanceof OutsideContract)
      throw outsideSlice(core, {
        file: index.fileOf(error.expression),
        span: error.expression.span,
        what: error.what,
      });
    throw error;
  }
}

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
  // the keys loaded so far, each once in the project: the agreement of a key's loads is S9b's (S3 §3)
  const loaded = new Set<string>();
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
          if (node.operator !== "=") return outside(node.span, "this assignment");
          if (node.target.kind === "identifier") push([node.target, node.value]);
          else if (node.target.kind === "propertyAccessExpression")
            push([node.target.object, node.value]);
          else return outside(node.span, "this assignment");
          break;
        case "ifStatement":
          push([node.condition, node.thenBlock, node.elseBlock]);
          break;
        case "repeatStatement":
          push([node.count, node.body]);
          break;
        case "forStatement":
          push([node.iterable, node.body]);
          break;
        case "sayStatement":
          if (
            node.presentation !== null ||
            node.speaker !== null ||
            node.skipPolicy !== null ||
            node.pacing !== null ||
            (node.value.kind === "stringLiteral" &&
              node.value.parts.some((part) => part.kind !== "stringText"))
          )
            return outside(node.span, "this say");
          if (node.value.kind !== "stringLiteral") push([node.value]);
          break;
        case "expressionStatement":
          // (a call for what it does, such as `xs.sort()`)
          if (node.expression.kind !== "callExpression")
            return outside(node.span, "this expression statement");
          push([node.expression]);
          break;
        case "exitStatement":
        case "numberLiteral":
        case "booleanLiteral":
        case "nullLiteral":
        case "regexLiteral":
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
        case "rangeExpression":
          push([node.start, node.end]);
          break;
        case "parenthesizedExpression":
          push([node.expression]);
          break;
        case "objectLiteral":
          push(node.properties.map((property) => property.value));
          break;
        case "propertyAccessExpression":
          push([node.object]);
          break;
        case "binaryExpression":
          if (node.operator !== "otherwise") return outside(node.span, "this binary expression");
          push([node.left, node.right]);
          break;
        case "callExpression": {
          const call = sliceCall(node);
          if (call === null) return outside(node.span, "this call expression");
          push([
            ...(node.callee.kind === "propertyAccessExpression" ? [node.callee.object] : []),
            ...node.arguments.map((argument) => argument.value),
          ]);
          break;
        }
        case "loadExpression": {
          const key = unwrapped(node.key);
          // the key as the session names it, whatever its spelling
          const name =
            key.kind === "stringLiteral" && key.parts.every((part) => part.kind === "stringText")
              ? key.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("")
              : null;
          if (name === null || node.defaultValue === null || loaded.has(name))
            return outside(node.span, "this load expression");
          loaded.add(name);
          push([node.key, node.defaultValue]);
          break;
        }
        default:
          return outside(node.span, `this ${describe(node.kind)}`);
      }
    }
  }
  return null;
}

function unwrapped(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

/** The calls of the slice, by what each is (see the module's comment); `null` for any other call. */
type SliceCall =
  "get" | "conversion" | "fromJson" | "fileFromBase64" | "decrypt" | "method" | "toJson";

/**
 * A method of text, a list, a set or a dict that changes nothing in its receiver, and a list's `sort`, called with as
 * many positional arguments as one of its contracts takes and no named one: the methods whose arguments and elements C13
 * checks (`signatures.ts`); a call's shape is the argument rules' (TSV020, S9b). A method that adds to its receiver
 * stores its argument, whose check has no place in the plan yet; one that removes, reorders or copies the receiver's
 * elements is the slice's when the runs the route's tests derive follow it.
 */
function sliceMethod(call: CallExpression): boolean {
  if (call.callee.kind !== "propertyAccessExpression") return false;
  const name = call.callee.property.name;
  if (call.arguments.some((argument) => argument.kind === "namedArgument")) return false;
  const list = listMethod(name);
  const dict = dictMethod(name);
  if ((list?.changes !== undefined && name !== "sort") || dict?.changes !== undefined) return false;
  // (a copy of the receiver's elements carries them, F10, which the runs the route's tests derive do not follow yet)
  if (methodCategory(name)?.gives.kind === "copy") return false;
  const parameters = [
    isTextMethod(name) ? TEXT_METHODS[name].parameters : null,
    list === undefined || list.named !== undefined ? null : list.parameters,
    dict === undefined || dict.named !== undefined ? null : dict.parameters,
  ];
  return parameters.some(
    (taken) =>
      taken !== null &&
      call.arguments.length <= taken.length &&
      call.arguments.length >=
        taken.filter((parameter) => !("optional" in parameter && parameter.optional === true))
          .length,
  );
}

/**
 * A call of the slice: a list's `get` with an index and its `default:`; a conversion of a value with its `default:`;
 * `fromJson` with its text, `default:` and maybe `files: false`; `fileFromBase64` with its text and `default:`;
 * `decryptText` or `decryptFile` with its value, `default:` and `password:` or `key:`. Any other is `null`.
 */
function sliceCall(call: CallExpression): SliceCall | null {
  const positional = call.arguments.filter((argument) => argument.kind === "positionalArgument");
  const named = new Map(
    call.arguments.flatMap((argument) =>
      argument.kind === "namedArgument" ? [[argument.name.name, argument.value] as const] : [],
    ),
  );
  if (call.callee.kind === "propertyAccessExpression" && call.callee.property.name !== "get")
    return sliceMethod(call) ? "method" : null;
  // `toJson` of a value, whose files the slice writes as their text (C13: what it writes, `signatures.ts`)
  if (call.callee.kind === "identifier" && call.callee.name === "toJson")
    return positional.length === 1 && named.size === 0 ? "toJson" : null;
  if (positional.length !== 1 || !named.has("default")) return null;
  const others = [...named.keys()].filter((name) => name !== "default");
  if (call.callee.kind === "propertyAccessExpression") return others.length === 0 ? "get" : null;
  if (call.callee.kind !== "identifier") return null;
  const name = call.callee.name;
  if (name === "fromJson") {
    const files = named.get("files");
    return others.every((other) => other === "files") &&
      (files === undefined || (files.kind === "booleanLiteral" && !files.value))
      ? "fromJson"
      : null;
  }
  if (name === "fileFromBase64") return others.length === 0 ? "fileFromBase64" : null;
  if (name === "decryptText" || name === "decryptFile")
    return others.length === 1 && (others[0] === "password" || others[0] === "key")
      ? "decrypt"
      : null;
  if (!isConversion(name)) return null;
  const conversion: Conversion = CONVERSIONS[name];
  return conversion.takes === "value" && conversion.kinds !== "shown" && others.length === 0
    ? "conversion"
    : null;
}

/**
 * The kinds a call's arguments may have without the built-in signature check (C13, S9b) having anything to say, or
 * `null` for any: a conversion's value one of its kinds or text and its default one of its result's, also `null` where
 * it takes one (`fitsDefault`'s domain, which the core's C10 does not check yet); every other argument text; an unknown,
 * which the runtime checks.
 */
function argumentKinds(call: CallExpression, argument: CallArgument): readonly string[] | null {
  const kind = sliceCall(call);
  const named = argument.kind === "namedArgument" ? argument.name.name : null;
  if (
    kind === "conversion" &&
    call.callee.kind === "identifier" &&
    isConversion(call.callee.name)
  ) {
    const conversion: Conversion = CONVERSIONS[call.callee.name];
    if (conversion.takes !== "value" || conversion.kinds === "shown") return [];
    if (named === "default")
      return conversion.fallback?.type === "any"
        ? null
        : [
            conversion.result,
            ...(conversion.fallback?.type === "optional" ? ["null"] : []),
            "unknown",
          ];
    return [...conversion.kinds, "string", "unknown"];
  }
  if (named === "default") return null;
  if (named === "files") return ["boolean"];
  if (kind === "get") return named === null ? null : [];
  // (a method's arguments and what `toJson` writes are C13's, `signatures.ts`)
  if (kind === "method" || kind === "toJson") return null;
  return ["string", "unknown"];
}

/** A node kind in words: `ifStatement` is "if statement". */
function describe(kind: string): string {
  return kind.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/** The names a file's `let` statements and `for` loops declare, at any depth. */
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
        case "forStatement":
          names.add(statement.variable.name);
          if (statement.valueVariable !== null) names.add(statement.valueVariable.name);
          pending.push(statement.body.statements);
          break;
      }
  return names;
}

// ------------------------------------------------------------------------------------------------- the answers

/** The kinds of the values a `say` of the slice shows: the scalars, and an unknown that the runtime shows as it is. */
const SHOWN: readonly string[] = ["string", "integer", "number", "boolean", "null", "unknown"];

/** The first answer of the analysis that leaves the slice (see the module's comment), or `null`. */
function outsideAnswers(answers: Answers, index: SliceIndex): Outside | null {
  const at = (site: { readonly file: number; readonly start: number; readonly end: number }) =>
    index.spanAt(site);
  for (const diagnostic of answers.diagnostics) {
    if (diagnostic.kind === "budget") continue;
    // (C13's operands of the slice: a `for` loop's iterable, a method's argument, what `toJson` writes)
    if (
      diagnostic.kind === "operator" &&
      diagnostic.rule.rule !== "iterable" &&
      diagnostic.rule.rule !== "argument" &&
      diagnostic.rule.rule !== "json"
    )
      return { file: diagnostic.site.file, span: at(diagnostic.site), what: "this operand" };
    // a possible `null` needs narrowing's required check (S10); a member a receiver may lack is C5's own
    if (
      diagnostic.class === "warning-runtime-check" &&
      diagnostic.obligation.kind === "null-check" &&
      (diagnostic.kind !== "member-read" || diagnostic.obligation.on.includes(" is not null "))
    )
      return {
        file: diagnostic.site.file,
        span: at(diagnostic.site),
        what: "a value that may be null here",
      };
  }
  const kindsAt = (expression: Expression): readonly string[] =>
    (answers.at(nodeOf(answers, index, expression))?.items ?? []).map((item) => item.tag);
  const beyond = (expression: Expression, allowed: readonly string[]): boolean =>
    kindsAt(expression).some((tag) => tag !== "empty" && !allowed.includes(tag));
  // a property read of a value that may be a collection, text or another kind: its members are S9b's
  for (const read of index.properties)
    if (beyond(read.object, ["object", "unknown"]))
      return { file: index.fileOf(read), span: read.span, what: "this member or element read" };
  for (const value of index.shown)
    if (beyond(value, SHOWN))
      return { file: index.fileOf(value), span: value.span, what: "this say" };
  // a load whose default is only null: without a declared type, the storage rules' error (F19, S9b's)
  for (const load of index.loads)
    if (
      load.defaultValue !== null &&
      !kindsAt(load.defaultValue).some((tag) => tag !== "null" && tag !== "empty")
    )
      return { file: index.fileOf(load), span: load.span, what: "this load expression" };
  for (const call of index.calls)
    for (const argument of call.arguments) {
      const allowed = argumentKinds(call, argument);
      if (allowed !== null && beyond(argument.value, allowed))
        return {
          file: index.fileOf(call),
          span: argument.value.span,
          what: "an argument that its built-in checks",
        };
    }
  // a variable without a written type whose lists nest deeper than the facts follow
  for (const statement of index.lets)
    if (statement.typeAnnotation === null) {
      const place = answers.at(nodeOf(answers, index, statement))?.place;
      if (place === null || place === undefined) continue;
      for (let path: string[] = [...place.path]; ; path = [...path, "element"]) {
        // (as the facts read it, `admittedType`: the admitted kinds where decided, else the contract's)
        const answer = answers.place(place.id, path);
        const tags =
          answer.admitted.by === "undecided"
            ? answer.contract.kinds.map((item) => item.tag)
            : answer.admitted.kinds;
        if (!tags.includes("list")) break;
        if (path.length + 1 >= SLICE_DEPTH)
          return {
            file: index.fileOf(statement),
            span: statement.name.span,
            what: `the variable '${statement.name.name}', whose lists nest deeper than the slice follows`,
          };
      }
    }
  return null;
}
