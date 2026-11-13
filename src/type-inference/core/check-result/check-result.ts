import type { Statement, CallExpression, Expression, BinaryExpression } from "../../../ast.js";
import { isConversion, type Conversion, CONVERSIONS } from "../../../conversions.js";
import { type Diagnostic, createDiagnostic, DiagnosticSeverity } from "../../../diagnostics.js";
import { isRepeatCount } from "../../../loop-rules.js";
import { isRegex } from "../../../runtime/values/value-predicates.js";
import {
  isTextMethod,
  TEXT_METHODS,
  type DomainValue,
  takesText,
  takesRegex,
  stringLength,
} from "../../../text-operations.js";
import { literalRange } from "../../../switch-cases.js";
import { type TypePlan } from "../../../plan/model.js";
import { createSourceSpan, type SourcePosition, createSourcePosition } from "../../../source.js";
import {
  type KnownValue,
  KnownValues,
  findVisibleOverflows,
  isStaticDuration,
} from "../../../static-evaluation.js";
import { isCalendar, unitValue } from "../../../duration.js";
import { type StaticType, members, UNKNOWN_TYPE, union, openType } from "../../../static-types.js";
import { typeFromAnnotation } from "../../../static-types/annotations.js";
import { typeKey } from "../../../storage-types.js";
import { placeKey } from "../../../way-facts.js";
import type { TypeCheckResult, SolvedTypeFacts, FactSite } from "../../backend.js";
import type { SourceSite, PlaceId } from "../../graph.js";
import { type Answers, coreResult } from "../answers.js";
import { BudgetExhausted } from "../budget.js";
import {
  type ContractResult,
  levelWalk,
  levelProof,
  typeOfLevels,
  SliceDepth,
  COLLECTIONS,
  typeOfKinds,
} from "../contract-descriptors.js";
import { leftOutCompletion } from "../consumers.js";
import { withoutEmpty } from "../exact-path.js";
import { otherwiseChains, provesNonNull, unusedFallbackRule } from "./otherwise.js";
import { literalTruth, literalRounds, type FlowNode } from "../flow-graph.js";
import { type ItemTag } from "../items.js";
import { type CoreAnalysisRequest, propertyStep } from "../program.js";
import {
  type MessageSource,
  coreMessage,
  coreMessageInWords,
  messageSource,
  staticCode,
} from "../messages.js";
import {
  type CheckedDiagnostic,
  type CoreResult,
  outcomeOf,
  type StaticDiagnostic,
  type StaticRule,
  type CoreDiagnostic,
} from "../result.js";
import {
  OutsideContract,
  SliceIndex,
  declarations,
  factSite,
  nodeOf,
  outsideStructure,
  siteKey,
  unwrap,
} from "./slice-index.js";
import { lostCheck, runtimeChecks } from "./runtime-plan.js";
import { Contracts } from "./store-contracts.js";

/*
 * The consumer of the coarse core (the port plan's S5, completed in S9b): one walk over the source with the core's
 * answers, which makes what the compiler consumes, `TypeCheckResult`, and the facts the analysis settled on. Here for
 * the slice `CORE_BACKEND` accepts (`backend.ts`): the core's C1 and C2 diagnostics with their codes, the runtime checks
 * their obligations and C9's boundary checks owe, the ways and the code that never runs from the flow graph's literal
 * facts (P7), the known values, and the checks that owe the runtime nothing (`staticDiagnostics`). The slice has no
 * form, speaker property or storage key, so those outputs are empty.
 */

/** Whether each core diagnostic a compile reports carries its message in words too (`withMessagesInWords`). */
let messagesInWords = false;

/**
 * Test-only: runs `callback` with each core diagnostic a compile inside it reports carrying `words`, its message with every
 * fix in words (`coreMessageInWords`), which the stop oracle compares with a stop's (#1449).
 */
export function withMessagesInWords<T>(callback: () => T): T {
  if (messagesInWords) throw new Error("Messages in words are already on.");
  messagesInWords = true;
  try {
    return callback();
  } finally {
    messagesInWords = false;
  }
}

/**
 * A diagnostic of the core as the compiler reports it: its rule's code (D3 (a)), the severity of its class ("not
 * checked (budget)" at the editor's information level), its sentences (`messages.ts`, D1) and its site's
 * span (D2); under `withMessagesInWords` also its message in words. `moved` is the plan's checks a stop moved to the
 * runtime (`movedChecks`), which the stop's warning counts.
 */
function diagnosticOf(
  diagnostic: CheckedDiagnostic,
  source: MessageSource,
  moved: number,
): Diagnostic {
  const shown = createDiagnostic(
    diagnostic.class === "compile-error"
      ? DiagnosticSeverity.Error
      : diagnostic.class === "not-checked-budget"
        ? DiagnosticSeverity.Info
        : DiagnosticSeverity.Warning,
    diagnostic.code,
    coreMessage(diagnostic, source, moved),
    createSourceSpan(
      positionAt(source, diagnostic.site.file, diagnostic.site.start),
      positionAt(source, diagnostic.site.file, diagnostic.site.end),
    ),
  );
  return messagesInWords
    ? Object.freeze({ ...shown, words: coreMessageInWords(diagnostic, source, moved) })
    : shown;
}

/** A source position at an offset of a file, its line and column from the source's line index (each file's once). */
function positionAt(source: MessageSource, file: number, offset: number): SourcePosition {
  const site = { file, start: offset, end: offset };
  return createSourcePosition(offset, source.line(site) - 1, source.column(site));
}

/** What the compiler consumes of the analysis of a program inside the slice. */
export function coreCheckResult(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): TypeCheckResult {
  const diagnostics: Diagnostic[][] = request.files.map(() => []);
  const { checks, core, contracts, moved } = runtimeChecks(answers, index, request);
  const expected = (call: CallExpression) => core.expected.get(call);
  const known = knownValues(answers, index, expected);
  // (on known values of its own, so the known-value work its walk spends is not the checks')
  const refused = knownAmountRefused(index, knownValuesOf(answers, index, expected), request);
  if (refused !== null)
    throw new OutsideContract(refused, `this ${KIND_WORDS[refused.kind] ?? "calculation"}`);
  const fallbacks = fallbackUses(answers, index);
  const result = checkedOf(answers, index, known, fallbacks);
  // (a program the analysis rejects has no plan to let a value through: nothing to decline)
  if (!result.diagnostics.some((diagnostic) => diagnostic.class === "compile-error"))
    lostCheck(answers, index, contracts, checks, core);
  const source = messageSource(
    request.files.map((file) => file.source),
    result.diagnostics,
    (base) => answers.keptName(base),
    (units) => answers.messageWork(units),
  );
  const shown = new Set(reportedDiagnostics(answers, result.diagnostics));
  for (const diagnostic of result.diagnostics)
    if (shown.has(diagnostic))
      diagnostics[diagnostic.site.file]!.push(diagnosticOf(diagnostic, source, moved));
  const paths = new Map<Statement, readonly boolean[]>();
  for (const statement of index.statements)
    if (statement.kind === "ifStatement" || statement.kind === "whileStatement") {
      // P7: a literal condition takes one branch, or runs the body never or until a `break` (the flow graph's own rule)
      const truth = literalTruth(statement.condition);
      paths.set(statement, [truth !== false, truth !== true]);
    } else if (statement.kind === "switchStatement") {
      // every case, and no case: these ways do not read the values the subject's type holds, so none is ruled out
      // (#2660)
      paths.set(statement, [...statement.cases.map(() => true), true]);
    } else if (statement.kind === "repeatStatement") {
      // P7: whether the body runs, and whether it may run not at all
      const rounds = literalRounds(statement.count);
      paths.set(statement, rounds === null ? [true, true] : [rounds !== "none", rounds === "none"]);
    }
  // by site, so a file's order does not follow the core's consumer order (a receiver's and a member's warnings start alike)
  for (const list of diagnostics)
    list.sort(
      (a, b) =>
        a.span.start.offset - b.span.start.offset ||
        a.span.end.offset - b.span.end.offset ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
        (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
    );
  return {
    diagnostics,
    runtimeChecks: checks,
    coreChecks: core,
    formShapes: new Map(),
    ways: { paths, operands: operandWays(index, fallbacks) },
    unreachable: unreachable(answers, index),
    speakerFlow: { reads: new Map(), stores: new Map() },
    storageTypes: [],
    known,
  };
}

/** The known values of a program (S3 §2, group V), shared with the answers. */
function knownValues(
  answers: Answers,
  index: SliceIndex,
  expected: (call: CallExpression) => TypePlan | undefined,
): (expression: Expression) => KnownValue | undefined {
  const values = knownValuesOf(answers, index, expected);
  const known = (expression: Expression) => values.known(expression);
  answers.shareKnown(known);
  return known;
}

/** A program's known values, not shared with the answers. */
function knownValuesOf(
  answers: Answers,
  index: SliceIndex,
  expected: (call: CallExpression) => TypePlan | undefined,
): KnownValues {
  return new KnownValues(
    (identifier) => {
      const initializer = answers.initializers.get(
        siteKey(index.fileOf(identifier), identifier.span),
      );
      return initializer === undefined ? undefined : index.expressionAt(initializer);
    },
    expected,
    // (the branch's narrowing at each read the walk evaluates, an operand's included, #1073 PR 2: where it admits no
    // kind of the value, as `n` under `if n is integer` with `n = 1.5`, the read never runs with it, so a dead branch is
    // no static error; constant work per read, inside the walk's own iteration, Codex r1 and r2 on #1884)
    (identifier, value) => {
      const node = answers.graph.expressionAt(index.site(identifier));
      const read = node === undefined ? undefined : answers.at(node);
      if (read === undefined || read === null) return true;
      const kinds = withoutEmpty(read.items).map((item) => item.tag);
      return kinds.includes("unknown") || admitsKnown(kinds, value);
    },
  );
}

/** A step `knownAmountRefused` refuses, in words. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  unitExpression: "unit expression",
  angleExpression: "angle expression",
};

/** The first step whose known operands give no value a run can hold, or `null`. */
function knownAmountRefused(
  index: SliceIndex,
  values: KnownValues,
  request: CoreAnalysisRequest,
): Expression | null {
  for (const [file, { program }] of request.files.entries()) {
    const overflow = findVisibleOverflows(program, values)[0];
    if (overflow !== undefined)
      return index.expressionAt({
        file,
        start: overflow.span.start.offset,
        end: overflow.span.end.offset,
      });
  }
  for (const unit of index.units) {
    if (unit.kind !== "unitExpression" || !unit.calendar) continue;
    const amount = values.quantity(unit.operand);
    if (typeof amount === "number" && typeof unitValue(amount, unit) === "string") return unit;
  }
  return null;
}

/**
 * Whether a read's kinds admit a known scalar: `null`, text, a boolean, a whole number as an `integer` or a `number`, a
 * fraction as a `number`.
 */
function admitsKnown(kinds: readonly string[], value: KnownValue): boolean {
  if (value === null) return kinds.includes("null");
  if (typeof value === "number")
    return kinds.includes("number") || (Number.isInteger(value) && kinds.includes("integer"));
  if (typeof value === "string") return kinds.includes("string");
  if (typeof value === "boolean") return kinds.includes("boolean");
  // (a structured value: its kinds are not decided here, so it keeps its known value)
  return true;
}

/**
 * The core's result with the checks that owe the runtime nothing (`StaticDiagnostic`, the lead's decision 3 on #1072):
 * the one list of diagnostics its record (`coreRecord`) and the compiler's diagnostics are both made from.
 */
function checkedOf(
  answers: Answers,
  index: SliceIndex,
  known: (expression: Expression) => KnownValue | undefined,
  fallbacks: FallbackUses,
): CoreResult {
  // (each in the analysis's site order, before the first diagnostic of a later site: a record's lists are in source
  // order)
  const found = staticDiagnostics(answers, index, known, fallbacks).sort((a, b) =>
    siteOrder(a.site, b.site),
  );
  // (a known calendar offset is one problem with one diagnostic, the runtime's sentence: the analysis's own warning of
  // the operation at that site, a hedge beside it, goes, decision 6)
  const at = (site: SourceSite): string => `${site.file}:${site.start}:${site.end}`;
  const offsets = new Set(
    found.filter((d) => d.rule.rule === "calendar-offset").map((d) => at(d.site)),
  );
  const analysed = answers.diagnostics.filter(
    (d) =>
      !(d.class === "warning-runtime-check" && d.kind === "operator" && offsets.has(at(d.site))),
  );
  const diagnostics: CheckedDiagnostic[] = [];
  let next = 0;
  for (const diagnostic of analysed) {
    while (next < found.length && siteOrder(found[next]!.site, diagnostic.site) < 0)
      diagnostics.push(found[next++]!);
    diagnostics.push(diagnostic);
  }
  diagnostics.push(...found.slice(next));
  return { outcome: outcomeOf(diagnostics), diagnostics, checks: coreResult(answers).checks };
}

/**
 * V30 §18 (#1072): each chain of `otherwise` with the first link whose left side is never `null` (`provesNonNull` of
 * the core's answer at that read, through the one read route, `Answers.at`), `null` for none: the one decision the
 * warning that its fallbacks are never used (TSV062) and the ways the plan's checks follow (`operandWays`) both read,
 * made once. A link's left side is read only while no earlier link proved its own: a chain is decided at its first.
 */
type FallbackUses = readonly {
  readonly chain: readonly BinaryExpression[];
  readonly first: number | null;
}[];

function fallbackUses(answers: Answers, index: SliceIndex): FallbackUses {
  return otherwiseChains(index.expressions)
    .map((chain) => ({
      chain,
      first: chain.findIndex((link) =>
        provesNonNull(answers.at(nodeOf(answers, index, link.left))?.items ?? null),
      ),
    }))
    .map(({ chain, first }) => ({ chain, first: first < 0 ? null : first }));
}

/**
 * The ways of each `otherwise` the plan's checks follow (`WayFacts.operands`), from the one decision (`fallbackUses`):
 * from a chain's first link whose left side is never `null` on, the fallback never runs and the value is always kept.
 */
function operandWays(index: SliceIndex, fallbacks: FallbackUses): Map<string, readonly boolean[]> {
  const ways = new Map<string, readonly boolean[]>();
  for (const { chain, first } of fallbacks)
    if (first !== null)
      for (const link of chain.slice(first))
        ways.set(placeKey(index.fileOf(link), link.span), [false, true]);
  return ways;
}

/** Two sites in source order: by file, start and end. */
function siteOrder(a: SourceSite, b: SourceSite): number {
  return a.file - b.file || a.start - b.start || a.end - b.end;
}

/**
 * What `ask` makes of a finished analysis's answers, its questions spending the analysis's allowance: one past
 * it stops there, the finished analysis's findings and decisions standing, and what is asked from then on answers
 * `STOPPED` (D4 a′). Where nothing stopped, the receiving completion runs then, after everything that can stop, and
 * asks again with its completed contracts within its own allowance (`Answers.completed`, #1526 phase C); where it keeps
 * no result, what was asked first stands, asked once more as finishing work where obligations were left without results,
 * so that the publication's gate reads them and may decline the program (#1526 decision 2). The backend's outcome and
 * the test-only checked result (`checkedResult`) both ask so.
 */
export function asked<T>(answers: Answers, ask: (answers: Answers) => T): T {
  let first: T;
  try {
    first = ask(answers);
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    return ask(answers.stoppedAt(error.limit));
  }
  // (a test that leaves the completion's checks out leaves the completion out: phase B's answers)
  if (leftOutCompletion()) return first;
  const again = answers.completed(() => ask(answers));
  if (again !== null) return again;
  // (#1526 decision 2, condition 1: a completion that kept no result, past its allowance even before it found its
  // obligations, leaves the settled pass's publication, which was asked before the registry was made; asked once more
  // apart, its gate reads the obligations left without results)
  return (answers.budget.closure?.counts.capped ?? 0) > 0 ||
    answers.receiving.some(({ result }) => result === null)
    ? answers.apart(() => ask(answers))
    : first;
}

/**
 * Test-only: the core's result for a request, with its checks that owe the runtime nothing, as the compiler reads it
 * (`checkedOf`, `asked`), also for a program outside the candidate's slice: a typed parse the slice does not follow
 * there reads its JSON without its expected type. `request` is not read: the answers keep the identity view the analysis
 * read (#2493); it stays for the 23 calls of this test-only reader, which pass the request they analysed.
 */
export function checkedResult(answers: Answers, request: CoreAnalysisRequest): CoreResult {
  void request;
  // (the analysis read the request through its identity view, which its answers keep)
  const viewed = answers.identity.request;
  const index = new SliceIndex(viewed.files.map((file) => file.program));
  return asked(answers, (answers) => {
    let contracts: Contracts | null = null;
    const expected = (call: CallExpression): TypePlan | undefined => {
      contracts ??= new Contracts(answers, index, declarations(answers, index));
      try {
        return contracts.expected(call) ?? undefined;
      } catch (error) {
        if (error instanceof OutsideContract) return undefined;
        throw error;
      }
    };
    return checkedOf(
      answers,
      index,
      knownValues(answers, index, expected),
      fallbackUses(answers, index),
    );
  });
}

/**
 * The checks of known values that owe the runtime nothing (S3 §2, group V), each where the core finds its value's kinds
 * fine (no diagnostic of the analysis at its site): a `repeat` count's known value outside its domain (`loop-rules.ts`),
 * a conversion of known text it cannot convert (V30 §13, #1105), and a written range that holds no number (V30 §6, an
 * ordinary warning).
 */
function staticDiagnostics(
  answers: Answers,
  index: SliceIndex,
  known: (expression: Expression) => KnownValue | undefined,
  fallbacks: FallbackUses,
): StaticDiagnostic[] {
  const sited = new Set<string>();
  for (const diagnostic of answers.diagnostics)
    if (diagnostic.kind !== "budget")
      sited.add(`${diagnostic.site.file}:${diagnostic.site.start}:${diagnostic.site.end}`);
  const found: StaticDiagnostic[] = [];
  const report = (site: SourceSite, rule: StaticRule): void => {
    found.push({ class: "compile-error", kind: "static", code: staticCode(rule), site, rule });
  };
  for (const statement of index.statements)
    if (statement.kind === "repeatStatement") {
      const count = unwrap(statement.count);
      if (sited.has(siteKey(index.fileOf(statement), count.span))) continue;
      const value = known(statement.count);
      if (typeof value === "number" && !isRepeatCount(value))
        report(index.site(statement.count), { rule: "repeat-count", value });
    }
  for (const call of index.calls) {
    const conversion = knownConversionError(answers, index, call);
    if (conversion !== null) report(index.site(conversion.value), conversion.rule);
    // (an argument the analysis found a problem with is not read: its own diagnostic stands)
    const diagnosed = (argument: Expression): boolean =>
      sited.has(siteKey(index.fileOf(argument), unwrap(argument).span));
    for (const found of knownTextArguments(answers, index, call, known, diagnosed))
      report(index.site(found.at), { rule: "text-argument", message: found.message });
  }
  // V30 §18 (#1072): a chain's fallbacks from its first link whose left side is never `null` on never run, an ordinary
  // warning with no runtime check, from the one decision (`fallbackUses`); they stay checked (ADR 0021 1.8)
  for (const { chain, first } of fallbacks) {
    if (first === null) continue;
    const link = chain[first]!;
    found.push({
      class: "warning",
      kind: "static",
      code: "TSV062",
      site: {
        file: index.fileOf(link),
        start: link.operatorSpan.start.offset,
        end: chain.at(-1)!.span.end.offset,
      },
      rule: unusedFallbackRule(chain, first, (object) => {
        const kinds = withoutEmpty(answers.at(nodeOf(answers, index, object))?.items ?? []);
        return kinds.length > 0 && kinds.every((item) => item.tag === "list")
          ? "list"
          : kinds.length > 0 && kinds.every((item) => item.tag === "dict")
            ? "dict"
            : null;
      }),
    });
  }
  // V30 §6: a written range that holds no number, an ordinary warning where a loop or `toList()` reads it
  const empty = (range: Expression, use: "loop" | "list"): void => {
    const bounds = literalRange(range);
    if (
      bounds === undefined ||
      ![bounds.startText, bounds.endText].every((text) => /^-?\d+$/.test(text)) ||
      (bounds.inclusive ? bounds.end >= bounds.start : bounds.end > bounds.start)
    )
      return;
    found.push({
      class: "warning",
      kind: "static",
      code: "TSV046",
      site: index.site(range),
      rule: {
        rule: "empty-range",
        use,
        start: bounds.startText,
        end: bounds.endText,
        inclusive: bounds.inclusive,
      },
    });
  };
  // ADR 0026 §5, decision 6 on #1072: a date or a local date and time moved by a known calendar duration with an exact
  // offset, beside the operation's own check (F16), the binary form at its operation and the compound one at its statement
  const offset = (target: readonly ItemTag[], operand: Expression, site: SourceSite): void => {
    const kinds = target.filter((tag) => tag !== "empty");
    const moved =
      kinds.length > 0 && kinds.every((tag) => tag === "date")
        ? "date"
        : kinds.length > 0 && kinds.every((tag) => tag === "datetime")
          ? "datetime"
          : null;
    const value = known(operand);
    if (
      moved === null ||
      !isStaticDuration(value) ||
      !isCalendar(value) ||
      value.milliseconds === 0
    )
      return;
    report(site, { rule: "calendar-offset", target: moved, duration: value });
  };
  for (const expression of index.expressions)
    if (
      expression.kind === "binaryExpression" &&
      (expression.operator === "+" || expression.operator === "-")
    )
      offset(
        (answers.at(nodeOf(answers, index, expression.left))?.items ?? []).map((item) => item.tag),
        expression.right,
        index.site(expression),
      );
  for (const statement of index.statements)
    if (statement.kind === "assignmentStatement" && statement.operator !== "=") {
      // (the target's current value, read before the operand as the compound operation reads it, `collector.ts`: a
      // variable's read, or its root's value below its properties and elements)
      const file = index.fileOf(statement);
      const steps: string[] = [];
      let root: Expression = statement.target;
      for (;;)
        if (root.kind === "propertyAccessExpression") {
          steps.unshift(propertyStep(root.property.name));
          root = root.object;
        } else if (root.kind === "indexExpression") {
          steps.unshift("element");
          root = root.object;
        } else if (root.kind === "parenthesizedExpression") root = root.expression;
        else break;
      const read = answers.graph.expressionAt({
        file,
        start: root.span.start.offset,
        end: root.span.end.offset,
      });
      if (read !== undefined)
        offset(
          answers.valueAt(read, steps).items.map((item) => item.tag),
          statement.value,
          index.site(statement),
        );
    }
  for (const statement of index.statements)
    if (statement.kind === "forStatement") empty(statement.iterable, "loop");
  for (const call of index.calls)
    if (call.callee.kind === "propertyAccessExpression" && call.callee.property.name === "toList")
      empty(call.callee.object, "list");
  return found;
}

/**
 * V30 §8 (#1701): "a visibly negative, out-of-range, or empty argument" of a method of text is a compile error. Each
 * argument domain of the method (`TextDomain`) whose values are all known, the receiver's text where it reads its
 * length, is checked in the method's order with the runtime's sentence, and reported at the last argument it reads (its
 * content, inside parentheses, §3.4); an argument the analysis or an earlier domain found a problem with is not read,
 * as the current checker does (`operation-checks.ts`). Every argument positional, and the receiver text as the core
 * answers it or as the place it reads is admitted (the invariant below).
 */
function knownTextArguments(
  answers: Answers,
  index: SliceIndex,
  call: CallExpression,
  known: (expression: Expression) => KnownValue | undefined,
  diagnosed: (argument: Expression) => boolean,
): { readonly at: Expression; readonly message: string }[] {
  const callee = call.callee;
  if (callee.kind !== "propertyAccessExpression" || !isTextMethod(callee.property.name)) return [];
  const method = TEXT_METHODS[callee.property.name];
  if (
    call.arguments.length > method.parameters.length ||
    call.arguments.some((argument) => argument.kind !== "positionalArgument")
  )
    return [];
  const receiver = answers.at(nodeOf(answers, index, callee.object));
  if (receiver === null) return [];
  // (the invariant: a method's argument domains apply only where the receiver is answered text, or the place it reads
  // is admitted text, `empty`, an element read's own concern, ignored; nothing else, so a receiver that may be null or
  // of another kind keeps its own check first, and one that only a fallback or a call proves text is #1727's)
  const text = (kinds: readonly ItemTag[]): boolean => {
    const present = kinds.filter((tag) => tag !== "empty");
    return present.length > 0 && present.every((tag) => tag === "string");
  };
  const admitted =
    receiver.place === null ? null : answers.place(receiver.place.id, receiver.place.path).admitted;
  if (
    !text(receiver.items.map((item) => item.tag)) &&
    !(admitted !== null && "kinds" in admitted && text(admitted.kinds))
  )
    return [];
  const receiverText = known(callee.object);
  const values: (DomainValue | undefined | null)[] = call.arguments.map((argument, position) => {
    if (diagnosed(argument.value)) return null;
    const parameter = method.parameters[position]!;
    const value = known(argument.value);
    if (!takesText(parameter) && !takesRegex(parameter))
      return typeof value === "number" ? value : undefined;
    return (takesText(parameter) && typeof value === "string") ||
      (takesRegex(parameter) && value !== undefined && isRegex(value))
      ? value
      : undefined;
  });
  const found: { at: Expression; message: string }[] = [];
  for (const domain of method.domains) {
    const read: DomainValue[] = [];
    for (const position of domain.reads) {
      const value =
        position === "length"
          ? typeof receiverText === "string"
            ? stringLength(receiverText)
            : undefined
          : values[position];
      if (value === undefined || value === null) break;
      read.push(value);
    }
    if (read.length !== domain.reads.length) continue;
    const message = domain.problem(read, method);
    if (message === undefined) continue;
    for (const position of domain.reads) if (position !== "length") values[position] = null;
    const last = Math.max(
      ...domain.reads.map((position) => (position === "length" ? -1 : position)),
    );
    found.push({ at: unwrap(call.arguments[last]!.value), message });
  }
  return found;
}

/**
 * V30 §13: a conversion of a value the compiler knows and the conversion cannot convert is a compile error, also with a
 * `default:` (#1105). The value is the argument's known value through its view, never the call's, which the default
 * would give. A value of a type the conversion does not take, and the parts of `toDateTime(date, time)`, are the
 * built-in signature check's (C13, S9b); the conversions of text keep their fallback for content they cannot read.
 */
function knownConversionError(
  answers: Answers,
  index: SliceIndex,
  call: CallExpression,
): { readonly value: Expression; readonly rule: StaticRule } | null {
  if (call.callee.kind !== "identifier" || !isConversion(call.callee.name)) return null;
  const name = call.callee.name;
  const conversion: Conversion = CONVERSIONS[name];
  const positional = call.arguments.filter((argument) => argument.kind === "positionalArgument");
  if (
    conversion.takes !== "value" ||
    positional.length !== 1 ||
    call.arguments.some(
      (argument) => argument.kind === "namedArgument" && argument.name.name !== "default",
    )
  )
    return null;
  const value = positional[0]!.value;
  const text = answers.view(nodeOf(answers, index, value)).known;
  return typeof text === "string" && conversion.textProblem(text) !== undefined
    ? { value, rule: { rule: "conversion", conversion: name, text } }
    : null;
}

/**
 * Test-only: each checked store's contract result (`ContractDescriptors`), by the store's site (`file:start:end`), as
 * the compiler's checks read them (`asked`). `request` is not read: the answers keep the identity view the analysis read
 * (#2493); it stays for the 10 calls of this test-only reader, which pass the request they analysed.
 */
export function storeContracts(
  answers: Answers,
  request: CoreAnalysisRequest,
): ReadonlyMap<string, ContractResult> {
  void request;
  // (the analysis read the request through its identity view, which its answers keep)
  const viewed = answers.identity.request;
  const index = new SliceIndex(viewed.files.map((file) => file.program));
  return asked(answers, (answers) => {
    const out = new Map<string, ContractResult>();
    for (const [store, result] of runtimeChecks(answers, index, viewed).contracts)
      out.set(`${index.fileOf(store)}:${store.span.start.offset}:${store.span.end.offset}`, result);
    return out;
  });
}

/**
 * The diagnostics the compiler reports (#1195): every one but a warning whose expression never runs once its file,
 * function or block runs, as code after an `exit` or the right side of `false and …`, which the warning for code that
 * never runs (TSV065) reports; an error there stays (ADR 0021 rule 1.8). An expression the flow graph has no node for
 * runs with its statement.
 */
export function reportedDiagnostics(answers: Answers): CoreDiagnostic[];

export function reportedDiagnostics(
  answers: Answers,
  diagnostics: readonly CheckedDiagnostic[],
): CheckedDiagnostic[];

export function reportedDiagnostics(
  answers: Answers,
  diagnostics: readonly CheckedDiagnostic[] = answers.diagnostics,
): CheckedDiagnostic[] {
  const { graph } = answers;
  let reached: Set<FlowNode> | null = null;
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.class === "compile-error") return true;
    // the nodes a way over live edges reaches from their region's entry, once
    if (reached === null) {
      reached = new Set(graph.regions.map((region) => region.entry));
      const pending = [...reached];
      for (let node = pending.pop(); node !== undefined; node = pending.pop())
        for (const next of node.successors)
          if (!reached.has(next) && !graph.isDeadEdge(node, next)) {
            reached.add(next);
            pending.push(next);
          }
    }
    const node = graph.expressionAt(diagnostic.site) ?? graph.statementAt(diagnostic.site);
    return node === undefined || reached.has(node);
  });
}

/**
 * The statements that never run once their file, function or block runs (S3 §2, group W, as `TypeCheckResult` states
 * it): those no way over the flow graph's live edges reaches from that region's entry or from a label, a call counting
 * as returning (ADR 0022 §4.3). Every file, function and block is asked on its own, whether or not anything enters it. A statement runs when control reaches its start: a statement
 * of a statement list is decided where it stands (`placeOf`), not by its own node, which may lie after a call that never
 * returns; a label by its own node, which a `goto` enters as well; an `else if`, which stands in no list, by its
 * condition's. A function's declaration is never one: it runs nothing where it stands.
 */
function unreachable(answers: Answers, index: SliceIndex): Set<Statement> {
  const { graph } = answers;
  // a call counts as returning, also of a callee that never does (ADR 0022 §4.3): its call-in reaches its call-out
  const returns = new Map(graph.sites.map((site) => [site.callIn, site.callOut] as const));
  const reached = new Set<FlowNode>();
  // the entry of every region but startup, and every label, which a `goto` can reach whatever comes before it
  const pending = [
    ...graph.regions.flatMap((region) => (region.kind === "startup" ? [] : [region.entry])),
    ...graph.nodes.filter((node) => node.statement?.kind === "labelStatement"),
  ];
  for (const root of pending) reached.add(root);
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const returned = returns.get(node);
    for (const next of returned === undefined ? node.successors : [...node.successors, returned])
      if (!reached.has(next) && (next === returned || !graph.isDeadEdge(node, next))) {
        reached.add(next);
        pending.push(next);
      }
  }
  return new Set(
    index.statements.filter((statement) => {
      if (statement.kind === "functionDeclaration") return false;
      const place =
        statement.kind === "labelStatement" ? undefined : graph.placeOf(index.site(statement));
      if (place === undefined) return !reached.has(nodeOf(answers, index, statement));
      return place === null || !reached.has(place);
    }),
  );
}

/** The element type of a collection type: the union of its collection members' elements, `unknown` without one. */
function elementOf(type: StaticType): StaticType {
  const elements = members(type).flatMap((part) =>
    part.kind === "list" || part.kind === "set" || part.kind === "dict" ? [part.element] : [],
  );
  return elements.length === 0 ? UNKNOWN_TYPE : union(elements);
}

/**
 * A place's type at a path: its contract's kinds, and a collection's elements' below it (`levelWalk`); where they nest
 * deeper than the facts follow, the program leaves the slice at `site` (`a.f=[a.f]` failed the compile, #1646).
 */
function placeType(
  answers: Answers,
  id: PlaceId,
  path: readonly string[],
  site: Expression,
): StaticType {
  return factLevels(
    () => levelWalk((at) => answers.place(id, at).contract.kinds.map((item) => item.tag), path),
    site,
  );
}

/**
 * A place's admitted type at a path (A1–A9): per level its written or decided kinds, a place admission never decided its
 * contract's kinds, and a collection's elements' below it (`levelWalk`, `levelProof`); the slice left at `site` as
 * `placeType` leaves it.
 */
function admittedType(
  answers: Answers,
  id: PlaceId,
  path: readonly string[],
  site: Expression,
): StaticType {
  return factLevels(
    () =>
      levelWalk((at) => {
        const place = answers.place(id, at);
        return levelProof(place.admitted, () => place.contract.kinds).tags;
      }, path),
    site,
  );
}

/** A facts walk's type (`levelWalk`), or the program out of the slice at `site` where the walk passed its depth. */
function factLevels(walk: () => (readonly ItemTag[])[], site: Expression): StaticType {
  try {
    return typeOfLevels(walk());
  } catch (error) {
    if (!(error instanceof SliceDepth)) throw error;
    return outsideStructure(site);
  }
}

/**
 * Each expression's type as the facts give it (`coreFacts`' `values`), read after its operands' (the walk's order
 * reversed), so nesting needs no native recursion: a read of a place with a written type has that type, else the
 * occurrence's kinds, a collection's element type from its literal, its place, or the list its index reads; an
 * expression the index does not hold is `unknown`.
 */
export function expressionTypes(
  answers: Answers,
  index: SliceIndex,
): (expression: Expression) => StaticType {
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
      types.set(expression, placeType(answers, place.id, place.path, expression));
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
      else if (place !== null)
        element = placeType(answers, place.id, [...place.path, "element"], expression);
    types.set(expression, typeOfKinds(tags, element));
  }
  return typeOf;
}

/** The facts the core settled on for a program inside the slice, by source site (see `SolvedTypeFacts`). */
export function coreFacts(
  answers: Answers,
  index: SliceIndex,
  request: CoreAnalysisRequest,
): SolvedTypeFacts {
  void request;
  const typeOf = expressionTypes(answers, index);
  const lets = declarations(answers, index);
  const bySite = (a: { readonly site: FactSite }, b: { readonly site: FactSite }): number =>
    a.site.file - b.site.file || a.site.start - b.site.start || a.site.end - b.site.end;
  const bindings = index.lets
    .map((statement) => {
      const place = answers.at(nodeOf(answers, index, statement))?.place ?? null;
      // a binding's type: its written type, else its admitted type (every store into it is checked against it)
      const type =
        statement.typeAnnotation !== null
          ? typeFromAnnotation(statement.typeAnnotation)
          : place === null
            ? UNKNOWN_TYPE
            : admittedType(answers, place.id, place.path, statement.initializer);
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
