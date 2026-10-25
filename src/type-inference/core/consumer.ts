import type {
  AssignmentStatement,
  Expression,
  Identifier,
  LetStatement,
  ListLiteral,
  Program,
  Statement,
} from "../../ast.js";
import { messageColorDiagnostics } from "../../authored-presentation.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "../../diagnostics.js";
import {
  isRepeatCount,
  REPEAT_COUNT_RULE,
  repeatCountFix,
  repeatCountMessage,
} from "../../loop-rules.js";
import type { TypeCheckPlan } from "../../plan/model.js";
import type { SourceSpan } from "../../source.js";
import { KnownValues } from "../../static-evaluation.js";
import { members, openType, union, UNKNOWN_TYPE, type StaticType } from "../../static-types.js";
import { typeFromAnnotation } from "../../static-types/annotations.js";
import { typeKey } from "../../storage-types.js";
import { typePlan } from "../../type-plans.js";
import { VALUE_KINDS } from "../../value-kinds.js";
import type { FactSite, RuntimeCheckSite, SolvedTypeFacts, TypeCheckResult } from "../backend.js";
import type { PlaceId, SourceSite } from "../graph.js";
import { closedType, type Answers } from "./answers.js";
import { literalRounds, literalTruth, type FlowNode } from "./flow-graph.js";
import type { Item, ItemTag } from "./items.js";
import type { CoreAnalysisRequest } from "./program.js";
import type { CoreDiagnostic, Obligation } from "./result.js";

/*
 * The consumer of the coarse core (the port plan's S5, completed in S9b): one walk over the source with the core's
 * answers, which makes what the compiler consumes, `TypeCheckResult`, and the facts the analysis settled on. Here for
 * the slice `CORE_BACKEND` accepts (`backend.ts`): the core's C1 and C2 diagnostics with their codes, the runtime checks
 * their obligations and C9's boundary checks owe, the ways and the code that never runs from the flow graph's literal
 * facts (P7), the known values, and the kept checks the slice reaches (a `say`'s markup colours, a known repeat
 * count). The slice has no form, speaker property or storage key, so those outputs are empty.
 */

/** The store statement of the slice that brings an expression into its place. */
type Store = LetStatement | AssignmentStatement;

function siteKey(file: number, span: SourceSpan): string {
  return `${file}:${span.start.offset}:${span.end.offset}`;
}

function factSite(file: number, span: SourceSpan): FactSite {
  return { file, start: span.start.offset, end: span.end.offset };
}

/** The source of a program inside the slice, walked once: its statements, its expressions and what each belongs to. */
export class SliceIndex {
  readonly lets: LetStatement[] = [];
  readonly statements: Statement[] = [];
  /** Every expression the analysis answers: all but an assignment's target. */
  readonly expressions: Expression[] = [];
  readonly lists: ListLiteral[] = [];
  /** The reads of variables and host values. */
  readonly reads: Identifier[] = [];
  readonly #file = new Map<object, number>();
  readonly #bySite = new Map<string, Expression>();
  readonly #statementsBySite = new Map<string, Statement>();
  readonly #store = new Map<Expression, Store>();
  /** The expressions a store brings whole into its place: its value, and the elements of a list literal there. */
  readonly #whole = new Set<Expression>();
  readonly #role = new Map<Expression, "count" | "index">();

  /** `onFile` hears of each file as the walk enters it (S3 §6 keeps the request's progress callback). */
  public constructor(programs: readonly Program[], onFile: (file: number) => void = () => {}) {
    type Entry =
      | { readonly statement: Statement }
      | { readonly expression: Expression; readonly store: Store | null; readonly whole: boolean };
    programs.forEach((program, file) => {
      onFile(file);
      const pending: Entry[] = program.statements.map((statement) => ({ statement })).reverse();
      const statements = (list: readonly Statement[]): void => {
        for (let at = list.length - 1; at >= 0; at -= 1) pending.push({ statement: list[at]! });
      };
      for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
        if ("statement" in entry) {
          const statement = entry.statement;
          this.#file.set(statement, file);
          this.statements.push(statement);
          const key = siteKey(file, statement.span);
          if (!this.#statementsBySite.has(key)) this.#statementsBySite.set(key, statement);
          switch (statement.kind) {
            case "letStatement":
              this.lets.push(statement);
              pending.push({ expression: statement.initializer, store: statement, whole: true });
              break;
            case "assignmentStatement":
              pending.push({ expression: statement.value, store: statement, whole: true });
              break;
            case "ifStatement":
              if (statement.elseBlock?.kind === "block") statements(statement.elseBlock.statements);
              else if (statement.elseBlock !== null)
                pending.push({ statement: statement.elseBlock });
              statements(statement.thenBlock.statements);
              pending.push({ expression: statement.condition, store: null, whole: false });
              break;
            case "repeatStatement":
              statements(statement.body.statements);
              this.#role.set(statement.count, "count");
              pending.push({ expression: statement.count, store: null, whole: false });
              break;
            case "sayStatement":
              pending.push({ expression: statement.value, store: null, whole: false });
              break;
          }
          continue;
        }
        const { expression, store, whole } = entry;
        this.#file.set(expression, file);
        this.expressions.push(expression);
        const key = siteKey(file, expression.span);
        if (!this.#bySite.has(key)) this.#bySite.set(key, expression);
        if (store !== null) this.#store.set(expression, store);
        if (whole) this.#whole.add(expression);
        switch (expression.kind) {
          case "identifier":
            this.reads.push(expression);
            break;
          case "listLiteral":
            this.lists.push(expression);
            for (let at = expression.elements.length - 1; at >= 0; at -= 1)
              pending.push({ expression: expression.elements[at]!, store, whole });
            break;
          case "indexExpression":
            this.#role.set(expression.index, "index");
            pending.push({ expression: expression.index, store, whole: false });
            pending.push({ expression: expression.object, store, whole: false });
            break;
          case "parenthesizedExpression": {
            // a count or an index in parentheses: its content is where the core's diagnostic stands (§3.4)
            const role = this.#role.get(expression);
            if (role !== undefined) this.#role.set(expression.expression, role);
            pending.push({ expression: expression.expression, store, whole });
            break;
          }
        }
      }
    });
  }

  public fileOf(node: Statement | Expression): number {
    const file = this.#file.get(node);
    if (file === undefined) throw new Error(`The slice's source has no ${node.kind} there.`);
    return file;
  }

  /** The expression at a site of the analysis. */
  public expressionAt(site: SourceSite): Expression {
    const found = this.#bySite.get(`${site.file}:${site.start}:${site.end}`);
    if (found === undefined)
      throw new Error(`The slice's source has no expression at ${site.file}:${site.start}.`);
    return found;
  }

  /** The `let` or assignment whose stored value holds `expression`, if any. */
  public storeOf(expression: Expression): Store | undefined {
    return this.#store.get(expression);
  }

  /** The span of the expression or statement at a site of the analysis. */
  public spanAt(site: SourceSite): SourceSpan {
    const key = `${site.file}:${site.start}:${site.end}`;
    const found = this.#bySite.get(key) ?? this.#statementsBySite.get(key);
    if (found === undefined)
      throw new Error(`The slice's source has nothing at ${site.file}:${site.start}.`);
    return found.span;
  }

  /** Whether a store brings `expression` whole into its place (not as an operand of an index read). */
  public storedWhole(expression: Expression): boolean {
    return this.#whole.has(expression);
  }

  /** Whether `expression` is a `repeat` count or an index. */
  public roleOf(expression: Expression): "count" | "index" | undefined {
    return this.#role.get(expression);
  }

  public site(node: Statement | Expression): SourceSite {
    return { file: this.fileOf(node), start: node.span.start.offset, end: node.span.end.offset };
  }
}

/**
 * The flow graph's node of a statement or an expression of the slice: an `if`'s is its condition's and a `repeat`'s its
 * count's, which run first; parentheses have their content's.
 */
export function nodeOf(
  answers: Answers,
  index: SliceIndex,
  node: Statement | Expression,
): FlowNode {
  let current: Statement | Expression = node;
  for (;;) {
    if (current.kind === "ifStatement") current = current.condition;
    else if (current.kind === "repeatStatement") current = current.count;
    const site = index.site(current);
    const found = current.kind.endsWith("Statement")
      ? answers.graph.statementAt(site)
      : answers.graph.expressionAt(site);
    if (found !== undefined) return found;
    if (current.kind !== "parenthesizedExpression")
      throw new Error(`The flow graph has no node for this ${current.kind}.`);
    current = current.expression;
  }
}

/** The `let` that declares each variable of the slice, by its place. */
export function declarations(answers: Answers, index: SliceIndex): Map<PlaceId, LetStatement> {
  const found = new Map<PlaceId, LetStatement>();
  for (const statement of index.lets) {
    const place = answers.at(nodeOf(answers, index, statement))?.place;
    if (place !== null && place !== undefined) found.set(place.id, statement);
  }
  return found;
}

/** The variable a store writes: its declaration, through the place the analysis reads at the store. */
function declarationOf(
  answers: Answers,
  index: SliceIndex,
  lets: ReadonlyMap<PlaceId, LetStatement>,
  store: Store,
): LetStatement {
  if (store.kind === "letStatement") return store;
  const place = answers.at(nodeOf(answers, index, store))?.place;
  const declaration = place === null || place === undefined ? undefined : lets.get(place.id);
  if (declaration === undefined)
    throw new Error("An assignment of the slice stores into no variable.");
  return declaration;
}

/** The kinds of these items as text, for a message: `a number`, `text (string) or null`. */
function kindsText(items: readonly Item[]): string {
  const tags = [...new Set(items.map((item) => item.tag))].filter(
    (tag): tag is Exclude<ItemTag, "unknown" | "empty"> => tag !== "unknown" && tag !== "empty",
  );
  return tags.length === 0
    ? "not one"
    : tags.map((tag) => VALUE_KINDS[tag].description).join(" or ");
}

/**
 * A diagnostic of the core with its code (D3 (a): a runtime-checked warning keeps its rule's code). The sentences are
 * provisional, neutral texts until the owner decides them (D1, S8); the sites are the structured record's (D2).
 */
function diagnosticOf(
  diagnostic: CoreDiagnostic,
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): Diagnostic {
  const expression = index.expressionAt(diagnostic.site);
  const text = request.files[diagnostic.site.file]!.source.slice(
    diagnostic.site.start,
    diagnostic.site.end,
  );
  const severity =
    diagnostic.class === "compile-error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
  if (diagnostic.kind === "written-target") {
    const store = index.storeOf(expression);
    const name =
      store === undefined
        ? "the place"
        : store.kind === "letStatement"
          ? store.name.name
          : store.target.kind === "identifier"
            ? store.target.name
            : "the place";
    return createDiagnostic(
      severity,
      "TSV041",
      diagnostic.class === "compile-error"
        ? `'${text}' does not fit the type written for '${name}'.`
        : `The compiler cannot prove that '${text}' fits the type written for ` +
            `'${diagnostic.obligation.target}', so the script checks it when it runs.`,
      expression.span,
    );
  }
  // a count is TSV011's rule, a list index TSV043's (D3 (a): each rule's existing code)
  const listIndex = index.roleOf(expression) === "index";
  const rule = listIndex ? "A list index must be a whole number (integer)" : REPEAT_COUNT_RULE;
  return createDiagnostic(
    severity,
    listIndex ? "TSV043" : "TSV011",
    diagnostic.class === "compile-error"
      ? `${rule}, but '${text}' is ${kindsText(
          (answers.at(nodeOf(answers, index, expression))?.items ?? []).filter(
            (item) => item.tag !== "integer",
          ),
        )}.`
      : `${rule}, and the compiler cannot prove that '${text}' is one here, so the script checks it when ` +
          "it runs.",
    expression.span,
  );
}

/** What the compiler consumes of the analysis of a program inside the slice. */
export function coreCheckResult(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): TypeCheckResult {
  const diagnostics: Diagnostic[][] = request.files.map(() => []);
  const sited = new Set<string>();
  for (const diagnostic of answers.diagnostics) {
    if (diagnostic.kind !== "written-target" && diagnostic.kind !== "integer-use")
      throw new Error(`The slice has no ${diagnostic.kind} diagnostic.`);
    sited.add(`${diagnostic.site.file}:${diagnostic.site.start}:${diagnostic.site.end}`);
    diagnostics[diagnostic.site.file]!.push(diagnosticOf(diagnostic, answers, index, request));
  }
  const values = new KnownValues((identifier) => {
    const initializer = answers.initializers.get(
      siteKey(index.fileOf(identifier), identifier.span),
    );
    return initializer === undefined ? undefined : index.expressionAt(initializer);
  });
  const known = (expression: Expression) => values.known(expression);
  const paths = new Map<Statement, readonly boolean[]>();
  for (const statement of index.statements)
    if (statement.kind === "ifStatement") {
      // P7: a literal condition takes one branch (the flow graph's own rule)
      const truth = literalTruth(statement.condition);
      paths.set(statement, [truth !== false, truth !== true]);
    } else if (statement.kind === "repeatStatement") {
      // P7: whether the body runs, and whether it may run not at all
      const rounds = literalRounds(statement.count);
      paths.set(statement, rounds === null ? [true, true] : [rounds !== "none", rounds === "none"]);
      // the kept check of a known count's value (`loop-rules.ts`), where the core finds the count's kinds fine
      let count: Expression = statement.count;
      while (count.kind === "parenthesizedExpression") count = count.expression;
      if (!sited.has(siteKey(index.fileOf(statement), count.span))) {
        const value = known(statement.count);
        if (typeof value === "number" && !isRepeatCount(value))
          diagnostics[index.fileOf(statement)]!.push(
            createDiagnostic(
              DiagnosticSeverity.Error,
              "TSV011",
              repeatCountMessage("this", String(value), repeatCountFix(value)),
              statement.count.span,
            ),
          );
      }
    } else if (statement.kind === "sayStatement")
      diagnostics[index.fileOf(statement)]!.push(...messageColorDiagnostics(statement.value));
  for (const list of diagnostics) list.sort((a, b) => a.span.start.offset - b.span.start.offset);
  return {
    diagnostics,
    runtimeChecks: runtimeChecks(answers, index),
    formShapes: new Map(),
    ways: { paths, operands: new Map() },
    unreachable: unreachable(answers, index),
    speakerFlow: { reads: new Map(), stores: new Map() },
    storageTypes: [],
    known,
  };
}

/**
 * The runtime checks the core's C1 obligations and C9's boundary checks owe (S3 §4, `copy-type` and the boundary
 * rows): the destination's written type, checked where the store's instruction stores the value. One store owes one
 * check, whatever the obligations inside its value.
 */
function runtimeChecks(answers: Answers, index: SliceIndex): Map<RuntimeCheckSite, TypeCheckPlan> {
  const owed: Obligation[] = [
    ...answers.diagnostics.flatMap((diagnostic) =>
      diagnostic.class === "warning-runtime-check" && diagnostic.kind === "written-target"
        ? [diagnostic.obligation]
        : [],
    ),
    ...answers.checks.filter((check) => check.boundary),
  ];
  const lets = declarations(answers, index);
  const checks = new Map<RuntimeCheckSite, TypeCheckPlan>();
  for (const obligation of owed) {
    const store = index.storeOf(index.expressionAt(obligation.site));
    if (store === undefined) throw new Error("A check of the slice belongs to no store.");
    if (checks.has(store)) continue;
    const declaration = declarationOf(answers, index, lets, store);
    if (declaration.typeAnnotation === null)
      throw new Error("A check of the slice stores into a variable without a written type.");
    const type = typePlan(typeFromAnnotation(declaration.typeAnnotation));
    if (type !== null) checks.set(store, { type, place: `'${declaration.name.name}'` });
  }
  return checks;
}

/**
 * The statements that never run once their file runs (S3 §2, group W): those no way over the flow graph's live edges
 * reaches from the file's entry. Every file is asked on its own, whether or not the session enters it.
 */
function unreachable(answers: Answers, index: SliceIndex): Set<Statement> {
  const { graph } = answers;
  const reached = new Set<FlowNode>();
  for (const region of graph.regions)
    if (region.kind === "file") {
      const pending = [region.entry];
      reached.add(region.entry);
      for (let node = pending.pop(); node !== undefined; node = pending.pop())
        for (const next of node.successors)
          if (!reached.has(next) && !graph.isDeadEdge(node, next)) {
            reached.add(next);
            pending.push(next);
          }
    }
  return new Set(
    index.statements.filter((statement) => !reached.has(nodeOf(answers, index, statement))),
  );
}

/**
 * A type of these kinds for the facts: each kind's closed type (`closedType`), a collection's with `element` as its
 * element type; no kind is `?`. The slice's variables hold one kind or one numeric family, so one element type serves.
 */
function typeOfKinds(tags: readonly ItemTag[], element: StaticType): StaticType {
  const kinds = [...new Set(tags)].filter((tag) => tag !== "empty");
  if (kinds.length === 0) return openType();
  return union(
    kinds.map((tag): StaticType =>
      tag === "list" || tag === "set" || tag === "dict"
        ? { kind: tag, element }
        : (closedType(tag) ?? UNKNOWN_TYPE),
    ),
  );
}

/** The element type of a collection type: the union of its collection members' elements, `unknown` without one. */
function elementOf(type: StaticType): StaticType {
  const elements = members(type).flatMap((part) =>
    part.kind === "list" || part.kind === "set" || part.kind === "dict" ? [part.element] : [],
  );
  return elements.length === 0 ? UNKNOWN_TYPE : union(elements);
}

const COLLECTIONS: ReadonlySet<ItemTag> = new Set(["list", "set", "dict"]);

/**
 * The deepest nesting of collections whose element types the slice's facts follow: a place or a written type with a
 * collection at this depth is outside the slice (`backend.ts` rejects it), so no fact is cut short.
 */
export const SLICE_DEPTH = 256;

/** A place's type at a path: its contract's kinds, and a collection's elements' below it, built from the deepest up. */
function placeType(answers: Answers, id: PlaceId, path: readonly string[]): StaticType {
  const levels: ItemTag[][] = [];
  for (let at = [...path]; ; at = [...at, "element"]) {
    const tags = answers.place(id, at).contract.kinds.map((item) => item.tag);
    levels.push(tags);
    if (!tags.some((tag) => COLLECTIONS.has(tag))) break;
    if (at.length + 1 >= SLICE_DEPTH)
      throw new Error("A place of the slice holds collections deeper than its facts follow.");
  }
  let type: StaticType = openType();
  for (let depth = levels.length - 1; depth >= 0; depth -= 1)
    type = typeOfKinds(levels[depth]!, type);
  return type;
}

/** The facts the core settled on for a program inside the slice, by source site (see `SolvedTypeFacts`). */
export function coreFacts(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): SolvedTypeFacts {
  void request;
  // each expression's type after its operands' (the walk's order reversed), so nesting needs no native recursion: the
  // occurrence's kinds, a collection's element type from its literal, its place, or the list its index reads
  const types = new Map<Expression, StaticType>();
  const typeOf = (expression: Expression): StaticType => types.get(expression) ?? UNKNOWN_TYPE;
  for (const expression of [...index.expressions].reverse()) {
    if (expression.kind === "parenthesizedExpression") {
      types.set(expression, typeOf(expression.expression));
      continue;
    }
    const answer = answers.at(nodeOf(answers, index, expression));
    // a read of a place with a written type holds that type: every store into it is checked against it (C1, A1)
    const place = answer?.place ?? null;
    if (place !== null && answers.place(place.id, place.path).admitted.by === "written") {
      types.set(expression, placeType(answers, place.id, place.path));
      continue;
    }
    const tags = answer?.items.map((item) => item.tag) ?? ["unknown"];
    let element: StaticType = UNKNOWN_TYPE;
    if (tags.some((tag) => COLLECTIONS.has(tag)))
      if (expression.kind === "listLiteral")
        element =
          expression.elements.length === 0 ? openType() : union(expression.elements.map(typeOf));
      else if (expression.kind === "indexExpression")
        element = elementOf(elementOf(typeOf(expression.object)));
      else if (place !== null) element = placeType(answers, place.id, [...place.path, "element"]);
    types.set(expression, typeOfKinds(tags, element));
  }
  const lets = declarations(answers, index);
  const bySite = (a: { readonly site: FactSite }, b: { readonly site: FactSite }): number =>
    a.site.file - b.site.file || a.site.start - b.site.start || a.site.end - b.site.end;
  const bindings = index.lets
    .map((statement) => {
      const place = answers.at(nodeOf(answers, index, statement))?.place ?? null;
      const type =
        statement.typeAnnotation !== null
          ? typeFromAnnotation(statement.typeAnnotation)
          : place === null
            ? UNKNOWN_TYPE
            : placeType(answers, place.id, place.path);
      return {
        site: factSite(index.fileOf(statement), statement.span),
        kind: statement.kind,
        name: statement.name.name,
        type: typeKey(type, true, true),
      };
    })
    .sort(bySite);
  const reads = index.reads
    .map((read) => {
      const place = answers.at(nodeOf(answers, index, read))?.place ?? null;
      const declaration = place === null ? undefined : lets.get(place.id);
      return {
        site: factSite(index.fileOf(read), read.span),
        name: read.name,
        binding:
          declaration === undefined ? null : factSite(index.fileOf(declaration), declaration.span),
      };
    })
    .sort(bySite);
  const values = index.expressions
    .map((expression) => ({
      site: factSite(index.fileOf(expression), expression.span),
      kind: expression.kind,
      type: typeKey(typeOf(expression), true, true),
    }))
    .sort((a, b) => bySite(a, b) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return {
    bindings,
    values,
    reads,
    functions: [],
    speakers: [],
    uncheckedProperties: [],
    storage: [],
  };
}
