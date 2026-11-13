import type { CallArgument, CallExpression, Expression, InteractionExpression } from "../../ast.js";
import { MAX_INTERACTION_OPTION_ENTRIES } from "../../interaction-limits.js";
import { unwrap } from "../../expression-children.js";
import { CONVERSIONS, isConversion, type Conversion } from "../../conversions.js";
import { BUILT_IN_SPEAKER_PROPERTIES } from "../../speaker-terms.js";
import type { TypeAnalysisBackend, TypeAnalysisOutcome, TypeAnalysisRequest } from "../backend.js";
import type { SourceSite } from "../graph.js";
import { analyseCore, type Answers } from "./answers.js";
import { asked, coreCheckResult, coreFacts } from "./check-result/check-result.js";
import {
  LIMIT_REASONS,
  nodeOf,
  SliceIndex,
  OutsideContract,
  SLICE_DEPTH,
} from "./check-result/slice-index.js";
import { oneType } from "./consumers/kinds.js";
import { checkedOnSource, identityView, type IdentityView } from "./identity-view.js";
import { REASON, type Item, type ItemTag } from "./items.js";
import type { CoreAnalysisRequest, CoreFile } from "./program.js";
import {
  commandOperands,
  operandRules,
  type OperandRule,
  outsideSyntax,
  sliceCall,
  transferCall,
  type OperandCheck,
  type Outside,
} from "./slice-syntax.js";

/*
 * The coarse core as a type analysis backend (the port plan's S5): complete for a stated slice of the language and
 * reached only through the test-only candidate compile route (`compileSourceWithBackend` in `src/compiler.ts`), never
 * by a production compile. A program outside the slice throws `CandidateOutsideSlice` at the first refusal the route
 * establishes, before, during or after the analysis (its syntax's first construct outside the slice, the capture's
 * depth exit, then the answers' first, below): a test-time signal, never a diagnostic, since no author can reach the
 * route; the slice grows step by step until the consumer is complete (S9b).
 *
 * The slice: `let` with or without a written type (a named type, `T?` and `T[]` of them; no written union, whose
 * required checks come with narrowing, S10), assignment of a variable or of a property, `if` and `else`, `repeat` with
 * a count, `for` with one or two variables, `say` of plain text or of a value, also `as` a speaker, a speaker's
 * declaration (never a speaker's name as a value), a call as a statement, and `exit`; the asks `SLICE_ASKS` holds,
 * also `as` a speaker, with no prefill or a literal one the request takes (`askPrefillAdmitted`);
 * number, boolean, null, regex and plain text literals, variables, host values, list and object literals, index and
 * property reads, ranges, `otherwise`, a list's `get` with its `default:`, a method of text, a list, a set or a dict that
 * changes nothing in its receiver and a list's `sort`, `toJson` of a value, the conversions of a value with their `default:`, `fromJson`, `fileFromBase64`,
 * `decryptText` and `decryptFile`, a `load` with a default that is no `null` of a key written as text once in the project
 * or of a computed key (external data, F19), and parentheses (S7: the constructs of the discharge map's new rows). Its consumers are C1 (a store into a
 * place with a written or decided type, A1–A9, with A6's rejections and a literal's elements of one type), C2 (a repeat
 * count, an index), C5 (a member of a receiver at a read or a store), C10 (a fallback or a default) and C13 (a `for`
 * loop's iterable, a method's arguments and the elements `join` and `sort` read); its ingresses are a host value, a load
 * and a parse, with C9's boundary check where it enters (the store's destination's admitted type) or where it is read.
 * Rejected after the analysis: any other consumer's diagnostic, a property read of a value that may be no object, a
 * value `say` may not show, a built-in speaker field's value that may not fit it (`SPEAKER_FIELD_KINDS`), an
 * `askChoice` whose buttons may return more than one type, an argument
 * of another kind than a built-in function takes (the built-in signature check C13, S9b), and lists nested
 * `SLICE_DEPTH` deep. A possible `null` is the route rule's (AD-1): a compile error where a route to the use has no
 * check, else a warning whose use the runtime checks.
 * Refused during it: a value whose structure the slice does not follow, at the store whose capture established it
 * (`leftSlice`), the analysis ended there. A stop compiles with its warning and its checks at runtime (D4 a′), but a
 * store whose check the stop leaves uncarried or undecided declines the program (#1526 decision 2, condition 1,
 * `check-result/runtime-plan.ts` `lostCheck`): where admission settled, "a store whose check was lost at the budget";
 * where it had not, "a store whose check was left undecided at the budget" (#2080). These, the unestablished checks
 * and rule (R)'s open typed default carry `limit` (`LIMIT_REASONS`); a refusal made from a diagnostic or a contract a
 * stop shaped carries its coverage reason and does not, since nothing here tells it from the same refusal without a stop
 * (#2236).
 */

/** Test-only: a program outside the candidate's slice, at the first refusal the route establishes (see above). */
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
    this.limit = LIMIT_REASONS.includes(what);
  }
  /** Whether its reason is one the stop's gates or rule (R) decline with (`LIMIT_REASONS`, #2080). */
  readonly limit: boolean;
}

/** The coarse core's backend, for the stated slice (see above). */
export const CORE_BACKEND: TypeAnalysisBackend = {
  name: "core",
  analyze(request: TypeAnalysisRequest): TypeAnalysisOutcome {
    const core = coreRequest(request);
    const globals = new Set(request.options.globals ?? []);
    const before = outsideSyntax(core.files, globals);
    if (before !== null) throw outsideSlice(core, before);
    return coreOutcome(request);
  },
};

/**
 * The core's outcome for a request, past the slice's syntax check (`CORE_BACKEND`'s route after it). Exported only for
 * the tests that read a finished compile of a source the check refuses, as of a function (#2493). `answers: "past"`
 * passes the answers' refusals too (`outsideAnswers`), for a test that runs a source whose values the slice does not
 * cover yet, as an author function's list argument.
 */
export function coreOutcome(
  request: TypeAnalysisRequest,
  answers: "refused" | "past" = "refused",
): TypeAnalysisOutcome {
  const core = coreRequest(request);
  // (the route ends at the first refusal the analysis establishes, the capture's depth exit, at its request's site:
  // never at unfinished work, a stop or a work count)
  const leftSlice = (site: SourceSite): never => {
    throw outsideSlice(core, {
      file: site.file,
      span: index.spanAt(site),
      what: "a value whose structure the slice does not follow",
    });
  };
  // the analysis reads each identity call as its argument (`identity-view.ts`); its sites are the view's
  const view = identityView({ ...core, leftSlice });
  // the walk of each file once, in project order (S3 §6), where the progress callback hears of it
  const index = new SliceIndex(
    view.request.files.map((file) => file.program),
    request.onFile,
  );
  // (the questions after the analysis spend the same allowance: `asked`)
  return asked(analyseCore(view.request), (asked) => outcomeOf(asked, index, view, answers));
}

/** The compiler's view of the core's answers to a program inside the slice, the facts computed here, before a caller. */
function outcomeOf(
  answers: Answers,
  index: SliceIndex,
  view: IdentityView,
  refusals: "refused" | "past",
): TypeAnalysisOutcome {
  const core = view.request;
  try {
    const after = refusals === "past" ? null : outsideAnswers(answers, index);
    if (after !== null) throw outsideSlice(core, after);
    // (the facts are by site, which the view keeps: a call read as its argument keeps the call's span)
    const checked = checkedOnSource(view, coreCheckResult(answers, index, core), answers.work);
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

/** The signal of a program outside the slice. */
function outsideSlice(request: CoreAnalysisRequest, outside: Outside): CandidateOutsideSlice {
  return new CandidateOutsideSlice(
    request.files[outside.file]!.path,
    { file: outside.file, start: outside.span.start.offset, end: outside.span.end.offset },
    outside.what,
  );
}

// ------------------------------------------------------------------------------------------------- the calls

/**
 * The kinds a call's arguments may have without the built-in signature check (C13, S9b) having anything to say, or
 * `null` for any: a conversion's value one of its kinds or text and its default one of its result's, also `null` where
 * it takes one (`fitsDefault`'s domain, which the core's C10 does not check yet); every other argument of a slice call
 * text; an unknown, which the runtime checks. A transfer's path (`transferCall`) is a command operand, the table's
 * (`COMMAND_OPERANDS`).
 */
function argumentKinds(call: CallExpression, argument: CallArgument): readonly string[] | null {
  const kind = sliceCall(call);
  if (kind === null)
    // (the syntax table admits no other call outside `sliceCall`, so the empty list is reached by no source today: it
    // refuses every argument of such a call rather than give it another call's rule)
    return transferCall(call) ? null : [];
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

// ------------------------------------------------------------------------------------------------- the answers

/** The kinds of the values a `say` of the slice shows: the scalars, and an unknown that the runtime shows as it is. */
const SHOWN: readonly string[] = ["string", "integer", "number", "boolean", "null", "unknown"];

/**
 * The kinds a built-in field of a speaker declaration takes (V30 §37; the fields today's checker types by their own
 * rules, `BUILT_IN_SPEAKER_PROPERTIES`), and the runtime function that refuses a value of another kind (`check`), where
 * one does: a value that may be of a kind outside `takes` is outside the slice, and so is an unknown one unless it is of
 * an external origin and a function is cited, which refuses it at run time if it does not fit. A built-in field without
 * an entry here is outside for every value.
 */
interface FieldKinds {
  readonly takes: readonly ItemTag[];
  readonly check: OperandCheck | null;
}
const SPEAKER_TEXT_FIELD: FieldKinds = {
  takes: ["string", "integer", "number", "boolean", "null"],
  check: { file: "src/runtime/values/speaker-text.ts", function: "speakerText" },
};
const PRESENTATION_CHECK: OperandCheck = {
  file: "src/runtime/message-presentation.ts",
  function: "resolveMessagePresentation",
};
export const SPEAKER_FIELD_KINDS: ReadonlyMap<string, FieldKinds> = new Map([
  ["displayName", SPEAKER_TEXT_FIELD],
  ["title", SPEAKER_TEXT_FIELD],
  ["shortTitle", SPEAKER_TEXT_FIELD],
  ["firstName", SPEAKER_TEXT_FIELD],
  ["lastName", SPEAKER_TEXT_FIELD],
  [
    "defaultSaySkippable",
    {
      takes: ["boolean"],
      check: { file: "src/runtime/instructions/say.ts", function: "executeDeclareSpeaker" },
    },
  ],
  ["presentation", { takes: ["string", "null"], check: PRESENTATION_CHECK }],
  ["bubble", { takes: ["object", "null"], check: PRESENTATION_CHECK }],
  ["prose", { takes: ["object", "null"], check: PRESENTATION_CHECK }],
  ["font", { takes: ["string", "null"], check: PRESENTATION_CHECK }],
  [
    "avatar",
    {
      takes: ["string", "null"],
      check: { file: "src/runtime/values/speaker-text.ts", function: "optionalSpeakerString" },
    },
  ],
  // (the runtime drops a colour it cannot read, and nothing reads `alias` or `gender` as a kind: no check to cite)
  ["color", { takes: ["string", "null"], check: null }],
  ["alias", { takes: ["string", "null"], check: null }],
  ["gender", { takes: ["string", "null"], check: null }],
]);

/**
 * What the amount of a unit or angle expression takes (`n s`, `n calendar months`, `n deg`; a unit follows a number,
 * ADR 0026 §8): a number, whole or not; `check` names the function that checks the amount as a run evaluates it.
 */
export const UNIT_AMOUNT: { readonly takes: readonly ItemTag[]; readonly check: OperandCheck } = {
  takes: ["integer", "number"],
  check: { file: "src/runtime/evaluator.ts", function: "evaluate" },
};

/**
 * Whether the route admits a unit's or an angle's amount: one the core shows to be a number (`UNIT_AMOUNT`), or an
 * external value the evaluator checks as it runs. Each item the core gives the amount is refused unless its kind is one
 * `UNIT_AMOUNT` takes, or it is an unknown of no reason but a missing property (no value there: its read fails first),
 * or an unknown of an external origin only, read as the host global itself or through a read of a variable or of a
 * path below it (`answer.place`) whose admitted type is undecided or holds only kinds `UNIT_AMOUNT` takes (a typed
 * ingress's read is the unknown its store's check stands for). Any other unknown (one a literal's element, a call or an
 * operation carries, a stop's) is not shown to be a number. An amount with no answer has no item and is admitted. So
 * the route declines an amount that only a narrowing or an `otherwise` shows to be a number: a read of `n: integer?`
 * under `n != null`, `(n otherwise 1) s`.
 */
function amountAdmitted(answers: Answers, index: SliceIndex, amount: Expression): boolean {
  const answer = answers.at(nodeOf(answers, index, amount));
  const read = answer?.place ?? null;
  const admitted = read === null ? null : answers.place(read.id, read.path).admitted;
  return (answer?.items ?? []).every((item) => {
    if (item.tag === "empty") return true;
    if (item.tag !== "unknown") return UNIT_AMOUNT.takes.includes(item.tag);
    const reasons = item.reasons & ~REASON.missing;
    if (reasons === 0) return true;
    if (reasons !== REASON.external) return false;
    if (admitted !== null)
      return (
        admitted.by === "undecided" ||
        admitted.kinds.every((kind) => UNIT_AMOUNT.takes.includes(kind))
      );
    return unwrap(amount).kind === "identifier";
  });
}

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
  // a built-in field's value of a speaker declaration that may not fit it (`SPEAKER_FIELD_KINDS`); a custom property's
  // value matters only to the reads and stores of the speaker, which the slice's syntax refuses
  for (const statement of index.statements)
    if (statement.kind === "speakerDeclaration")
      for (const property of statement.properties) {
        if (!BUILT_IN_SPEAKER_PROPERTIES.has(property.name.name)) continue;
        const field = SPEAKER_FIELD_KINDS.get(property.name.name);
        const items = answers.at(nodeOf(answers, index, property.value))?.items ?? [];
        // (an unknown is admitted only of an external origin, beside the runtime check the row cites; any other, a stop's
        // among them, D4 a′, is not shown to fit, and its check is the runtime's, which no plan carries)
        const admitted = (item: Item): boolean =>
          item.tag === "empty" ||
          (field !== undefined &&
            (field.takes.includes(item.tag) ||
              (item.tag === "unknown" &&
                field.check !== null &&
                item.reasons === REASON.external)));
        if (field === undefined || !items.every(admitted))
          return {
            file: index.fileOf(property.value),
            span: property.value.span,
            what: "this speaker property",
          };
      }
  for (const unit of index.units)
    if (!amountAdmitted(answers, index, unit.operand))
      return {
        file: index.fileOf(unit),
        span: unit.span,
        what: unit.kind === "unitExpression" ? "this unit expression" : "this angle expression",
      };
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
  // (after the values' own refusals) an `askChoice` whose buttons may return values of more than one type (V30 §19: whole
  // numbers with numbers one type, `null` beside a type): today's checker refuses its answer in a typed place (TSV041)
  // where the core only warns
  for (const ask of index.asks)
    if (
      ask.interactionKind === "choice" &&
      !oneType(
        (answers.at(nodeOf(answers, index, ask))?.items ?? [])
          .map((item) => item.tag)
          .filter((tag) => tag !== "unknown" && tag !== "empty"),
      )
    )
      return { file: index.fileOf(ask), span: ask.span, what: "this ask" };
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
  // a command's or an ask's operand that may hold a value its instruction does not take (`COMMAND_OPERANDS`): today's
  // compile error, so today's checker answers (#2488's step 1½); last, after the values' own refusals
  for (const node of [...index.statements, ...index.asks]) {
    const rules = operandRules(node.kind);
    if (rules === undefined) continue;
    for (const [position, operand] of commandOperands(node)) {
      const rule = rules[position];
      // (a position the table has no rule for is outside: none is reached while the table names every position)
      if (rule === undefined || !operandAdmitted(answers, index, operand, rule))
        return {
          file: index.fileOf(operand),
          span: operand.span,
          what: "an operand its instruction does not take",
        };
    }
    // (a choice of more buttons than a request shows: today's TSV029, the request's TSR052 as it opens)
    if (
      node.kind === "interactionExpression" &&
      node.interactionKind === "choice" &&
      choiceButtons(answers, index, node) > MAX_INTERACTION_OPTION_ENTRIES
    )
      return {
        file: index.fileOf(node),
        span: node.span,
        what: "a choice of more buttons than it shows",
      };
  }
  return null;
}

/**
 * The buttons of a choice as today's checker counts them (`MAX_INTERACTION_OPTION_ENTRIES`): each element of a list
 * written in place, and one for each other option of a known kind that is no collection (a computed collection's
 * elements and an unknown option are not counted).
 */
function choiceButtons(answers: Answers, index: SliceIndex, ask: InteractionExpression): number {
  let buttons = 0;
  for (const option of ask.options) {
    const written = unwrap(option.expression);
    if (written.kind === "listLiteral") buttons += written.elements.length;
    else {
      const tags = (answers.at(nodeOf(answers, index, option.expression))?.items ?? []).map(
        (item) => item.tag,
      );
      if (tags.every((tag) => tag !== "unknown" && tag !== "list" && tag !== "set")) buttons += 1;
    }
  }
  return buttons;
}

/**
 * Whether an operand holds only values its rule takes (`OperandRule`): as written, it passes the rule's `form`;
 * each kind the core gives it is one the rule takes; a read of a place whose type is written or decided holds that
 * type's kinds (a typed ingress's read is the unknown its store's check stands for); an unknown is admitted only of an
 * external origin, as the host global itself or a direct read of a place whose type is undecided, beside the
 * instruction's cited check; a missing property is no value there, its read fails first. Any other unknown (one an
 * element, a call or an operation carries, a stop's) is not shown to fit.
 */
function operandAdmitted(
  answers: Answers,
  index: SliceIndex,
  operand: Expression,
  rule: OperandRule,
): boolean {
  if (rule.form !== undefined && !rule.form(operand)) return false;
  const answer = answers.at(nodeOf(answers, index, operand));
  const read = answer?.place ?? null;
  const admitted = read === null ? null : answers.place(read.id, read.path).admitted;
  const unwrappedOperand = unwrap(operand);
  return (answer?.items ?? []).every((item) => {
    if (item.tag === "empty") return true;
    if (item.tag !== "unknown") return rule.takes.includes(item.tag);
    // (a property read that found no such property fails there, before the operand holds a value: `withoutMissing`)
    const reasons = item.reasons & ~REASON.missing;
    if (reasons === 0) return true;
    // (an opaque, deferred or stopped unknown: none reaches an operand inside today's slice, as speakers are refused by
    // the name rule, parameters by the function row and a budget stop by its gate; a test fails when one does)
    if (reasons !== REASON.external) return false;
    if (admitted !== null)
      return (
        admitted.by === "undecided" || admitted.kinds.every((kind) => rule.takes.includes(kind))
      );
    return unwrappedOperand.kind === "identifier";
  });
}
