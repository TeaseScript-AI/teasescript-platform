import { parseChild, type ParseTask } from "../parse-continuation.js";
import type {
  CallExpression,
  Expression,
  Identifier,
  ObjectLiteral,
  FormArgument,
  InteractionExpression,
  InteractionChoiceOption,
} from "../ast.js";
import type { SourceSpan } from "../source.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, isExpressionStart, spanFrom } from "./tokens.js";
import { requireExactDuration } from "./units.js";
import { atSayModeBeforeBoundedText, parseSayPresentation, peekAfterSayMode } from "./say.js";

// Asks: the compact and bounded forms of each ask, their named arguments, and a question's presentation and image.

/** The modes of a message, `bubble` and `prose`, which a `say` or an ask's question may write. */
export const PRESENTATION_MODES: ReadonlySet<string> = new Set(["bubble", "prose"]);
/** Tokens that may start an expression but also continue the one before them, as `(` calls and `-` subtracts. */
const EXPRESSION_CONTINUATIONS: ReadonlySet<TokenKind> = new Set([
  TokenKind.LeftParenthesis,
  TokenKind.LeftBracket,
  TokenKind.Plus,
  TokenKind.Minus,
]);
/** The named arguments of each basic ask and of `askForm`, in the order the message suggests them. */
const ASK_OPTIONS: readonly string[] = ["prefill", "hint"];
const FORM_OPTIONS: readonly string[] = [
  "fields",
  "hint",
  "submit",
  "cancel",
  "outro",
  "timeout",
  "onTimeout",
];
/** The asks that name every argument other than the question, with their names; the question may be `message:`. */
const NAMED_ASK_OPTIONS: ReadonlyMap<InteractionExpression["interactionKind"], readonly string[]> =
  new Map([
    ["form", FORM_OPTIONS],
    ["boolean", ["yesText", "noText", "prefill", "message"]],
    ["booleans", ["texts", "prefill", "cancel", "message"]],
  ]);
/** The one named argument of `askChoice`, written once after its options. */
const CHOICE_OPTIONS: readonly string[] = ["prefill"];
/** The one named argument of `askPassword`: a password is never suggested, so it has no `prefill:`. */
const PASSWORD_OPTIONS: readonly string[] = ["hint"];

/** The named arguments of an ask, such as `prefill:` and `hint:` of `askText`, as the parser accepts them. */
export function askOptionNames(kind: InteractionExpression["interactionKind"]): readonly string[] {
  if (kind === "choice") return CHOICE_OPTIONS;
  return kind === "password" ? PASSWORD_OPTIONS : (NAMED_ASK_OPTIONS.get(kind) ?? ASK_OPTIONS);
}

/** The named arguments that an ask needs: `fields:` of `askForm`, and `texts:` and `prefill:` of `askBooleans`. */
export function requiredAskOptionNames(
  kind: InteractionExpression["interactionKind"],
): readonly string[] {
  return kind === "form" ? ["fields"] : kind === "booleans" ? ["texts", "prefill"] : [];
}

/** The named arguments the parser reads for an ask: its own, and for `askPassword` a `prefill:` the type check refuses. */
function readAskOptionNames(kind: InteractionExpression["interactionKind"]): readonly string[] {
  return kind === "password" ? READ_PASSWORD_OPTIONS : askOptionNames(kind);
}
const READ_PASSWORD_OPTIONS: readonly string[] = [...PASSWORD_OPTIONS, "prefill"];
/**
 * The earlier name of an ask's `prefill:`, which is a compile error that names the fix (owner decision on #512,
 * 2026-10-08): `default:`, or `defaults:` for `askBooleans`.
 */
function removedPrefillName(kind: InteractionExpression["interactionKind"]): string | null {
  if (kind === "booleans") return "defaults";
  // askPassword came after the rename and never had one.
  return kind === "choice" || kind === "form" || kind === "password" ? null : "default";
}

export function* parseInteractionExpression(
  parser: Parser,
  interactionKind: InteractionExpression["interactionKind"],
): ParseTask<InteractionExpression | null> {
  const command = parser.advance();
  if (parser.check(TokenKind.LeftParenthesis) && interactionKind !== "choice")
    return yield* parseChild(parseBoundedAsk(parser, command, interactionKind, null, null, null));
  if (parser.check(TokenKind.LeftParenthesis)) {
    parser.reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      "Parenthesized askChoice arguments are not supported in the compact interaction syntax.",
      parser.peek().span,
    );
    parser.synchronizeStatement();
    return null;
  }
  let asSpan: SourceSpan | null = null;
  let speaker: Identifier | null = null;
  if (!parser.atStorageDelimiter() && parser.match(TokenKind.KeywordAs)) {
    asSpan = copySpan(parser.previous().span);
    if (!parser.check(TokenKind.Identifier)) {
      parser.reportMissingSpeakerAfterAs();
      return null;
    }
    speaker = parser.identifier(parser.advance());
  }
  if (parser.check(TokenKind.LeftParenthesis) && interactionKind !== "choice")
    return yield* parseChild(
      parseBoundedAsk(parser, command, interactionKind, asSpan, speaker, null),
    );
  // The question's mode, as `say` writes it after its speaker (#832); `askChoice` has no question to show.
  let presentation: ObjectLiteral | null = null;
  if (atQuestionPresentation(parser)) {
    const mode = parser.peek();
    presentation = yield* parseChild(parseSayPresentation(parser));
    if (interactionKind === "choice") {
      parser.reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        `askChoice has no question, so it takes no '${mode.lexeme}'. Say the question before it, as in 'say ${mode.lexeme} "Which one?"'.`,
        presentation.span,
      );
      presentation = null;
    }
  }
  if (parser.check(TokenKind.LeftParenthesis) && interactionKind !== "choice")
    return yield* parseChild(
      parseBoundedAsk(parser, command, interactionKind, asSpan, speaker, presentation),
    );
  if (parser.check(TokenKind.LeftParenthesis)) {
    parser.reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      "Parenthesized askChoice arguments are not supported in the compact interaction syntax.",
      parser.peek().span,
    );
    parser.synchronizeStatement();
    return null;
  }

  if (interactionKind !== "choice") {
    const names = readAskOptionNames(interactionKind);
    // The earlier name of the prefill is read as an option too, so its error names the fix wherever it is written.
    const removed = removedPrefillName(interactionKind);
    const recognized = removed === null ? names : [...names, removed];
    // Before a `/`, a mode word is the question only where the question parses from it without errors, as for `say`
    // (see `#canParseCompleteSayValue`): otherwise a regex may start at the `/`, as in `askText prose /[/*]/`, which
    // the parse looks for again (see `parse`). A word whose question parses divides, as in `askNumber prose / 2`, also
    // where a regex that the question holds is found first and the parse with it decides again, as in
    // `askNumber prose / (say prose /x/).text.length`.
    const slash =
      presentation === null &&
      parser.check(TokenKind.Identifier) &&
      PRESENTATION_MODES.has(parser.peek().lexeme)
        ? peekAfterSayMode(parser)
        : null;
    const diagnosticCount = parser.diagnostics.length;
    const regexStartCount = parser.regexStarts.length;
    const question =
      isExpressionStart(parser.peek()) &&
      !(parser.blockEndsCompactInteraction && parser.check(TokenKind.LeftBrace)) &&
      !parser.atStorageDelimiter() &&
      askOptionAt(parser, 0, recognized) === null
        ? yield* parseChild(parser.parseOr())
        : null;
    if (
      slash?.kind === TokenKind.Slash &&
      parser.diagnostics.length > diagnosticCount &&
      parser.regexStarts.length === regexStartCount
    )
      parser.regexStarts.push(slash.span.start.offset);
    // The named options follow in any order, each after a comma, or first without a question.
    const named: FormArgument[] = [];
    let end = question?.span ?? speaker?.span ?? command.span;
    let offset = question === null ? 0 : parser.offsetAfterComma();
    for (;;) {
      if (offset === null && askOptionAt(parser, 0, recognized) !== null) {
        parser.reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          `Expected ',' before '${parser.peek().lexeme}:'.`,
        );
        offset = 0;
      }
      const option = offset === null ? null : askOptionAt(parser, offset, recognized);
      if (option === null) {
        // A form names every argument, as do askBoolean and askBooleans, so another `name:` after a comma is a
        // misspelled one.
        const unknown = offset === null ? null : parser.peek(offset);
        if (
          NAMED_ASK_OPTIONS.has(interactionKind) &&
          unknown?.kind === TokenKind.Identifier &&
          parser.peek(offset! + 1).kind === TokenKind.Colon
        ) {
          parser.reportSpan(
            parserDiagnosticCode.unsupportedInteractionForm,
            `Unknown ${command.lexeme} option '${unknown.lexeme}'. Use ${names.map((known) => `'${known}:'`).join(", ")}.`,
            unknown.span,
          );
          parser.synchronizeStatement();
        }
        break;
      }
      for (let skipped = 0; skipped < offset!; skipped += 1) parser.advance();
      const name = renamedAskOption(
        parser,
        command,
        interactionKind,
        parser.identifier(parser.advance()),
      );
      parser.advance();
      const mark = parser.mark();
      const value = yield* parseChild(parser.parseColonValueTask(false));
      if (value === null) {
        parser.reportMissing(
          mark,
          parserDiagnosticCode.expectedInteractionText,
          name.name === "prefill"
            ? "Expected a prefill value after 'prefill:'."
            : name.name === "hint"
              ? "Expected hint text after 'hint:'."
              : `Expected a value after '${name.name}:'.`,
        );
        if (parser.previous().kind === TokenKind.Newline && parser.atStatementStart())
          parser.recoveredAtStatementBoundary = true;
        break;
      }
      if (named.some((argument) => argument.name.name === name.name)) {
        parser.reportSpan(
          parserDiagnosticCode.unsupportedInteractionForm,
          `Duplicate ${command.lexeme} option '${name.name}'.`,
          name.span,
        );
      } else named.push(Object.freeze({ name, value }));
      end = value.span;
      offset = parser.offsetAfterComma();
    }
    if (parser.check(TokenKind.KeywordAs) && !parser.atStorageDelimiter()) {
      parser.reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        `The 'as speaker' clause must appear immediately after '${command.lexeme}'.`,
        parser.peek().span,
      );
      parser.synchronizeStatement();
    }
    return askExpression(
      parser,
      command,
      interactionKind,
      asSpan,
      speaker,
      presentation,
      question,
      named,
      spanFrom(command.span, end),
    );
  }

  const options: InteractionChoiceOption[] = [];
  let prefill: Expression | null = null;
  let missingChoiceOptionWasReported = false;
  while (!isInteractionChoiceTerminator(parser)) {
    // `prefill:` names the preselected button's value once, after the options, so no option is labelled `prefill`.
    if (askOptionAt(parser, 0, askOptionNames("choice")) !== null) {
      const name = parser.advance();
      parser.advance();
      const mark = parser.mark();
      prefill = yield* parseChild(parser.parseColonValueTask(false));
      if (prefill === null) {
        parser.reportMissing(
          mark,
          parserDiagnosticCode.expectedInteractionText,
          "Expected a prefill value after 'prefill:'.",
        );
        if (parser.previous().kind === TokenKind.Newline && parser.atStatementStart())
          parser.recoveredAtStatementBoundary = true;
        break;
      }
      if (options.length === 0) {
        missingChoiceOptionWasReported = true;
        parser.reportSpan(
          parserDiagnosticCode.expectedChoiceOption,
          "askChoice takes one 'prefill:', after its options, as in 'askChoice 5, 10, prefill: 10'.",
          name.span,
        );
        parser.skipInteractionRest();
      } else if (
        !isInteractionChoiceTerminator(parser) &&
        !(parser.blockEndsCompactInteraction && parser.check(TokenKind.LeftBrace))
      ) {
        parser.reportSpan(
          parserDiagnosticCode.unsupportedInteractionForm,
          "askChoice takes one 'prefill:', after its options, as in 'askChoice 5, 10, prefill: 10'.",
          parser.peek().span,
        );
        parser.skipInteractionRest();
      }
      break;
    }
    const optionValue =
      (parser.check(TokenKind.Identifier) || parser.check(TokenKind.NumberLiteral)) &&
      parser.peek(1).kind === TokenKind.Colon
        ? interactionChoiceValue(parser, parser.advance())
        : null;
    let colonSpan: SourceSpan | null = null;
    if (optionValue !== null) {
      parser.advance();
      colonSpan = copySpan(parser.previous().span);
    }
    const mark = parser.mark();
    const expression = yield* parseChild(
      optionValue === null ? parser.parseOr() : parser.parseColonValueTask(false),
    );
    if (expression === null) {
      missingChoiceOptionWasReported = true;
      parser.reportMissing(
        mark,
        parserDiagnosticCode.expectedChoiceOption,
        optionValue === null
          ? "Expected at least one choice option."
          : "Expected a choice option expression after ':'.",
      );
      if (parser.atStatementStart()) {
        parser.recoveredAtStatementBoundary = true;
      }
      break;
    }
    let separatorSpan: SourceSpan | null = null;
    // As for a prefill, inside delimiters a comma on the next line continues the options.
    const commaOffset = parser.offsetAfterComma();
    if (commaOffset !== null) {
      while (parser.check(TokenKind.Newline)) parser.advance();
      parser.advance();
      separatorSpan = copySpan(parser.previous().span);
    }
    options.push(
      Object.freeze({
        kind: "interactionChoiceOption",
        value: optionValue,
        colonSpan,
        expression,
        separatorSpan,
        span: spanFrom(optionValue?.span ?? expression.span, expression.span),
      }),
    );
    if (separatorSpan === null) {
      if (
        !isInteractionChoiceTerminator(parser) &&
        !parser.recoveredAtStatementBoundary &&
        !(parser.blockEndsCompactInteraction && parser.check(TokenKind.LeftBrace))
      ) {
        if (parser.check(TokenKind.KeywordAs)) {
          parser.reportSpan(
            parserDiagnosticCode.unsupportedInteractionForm,
            "The 'as speaker' clause must appear immediately after 'askChoice'.",
            parser.peek().span,
          );
        } else {
          parser.reportSpan(
            parserDiagnosticCode.expectedChoiceSeparator,
            "Expected ',' or the end of the statement after a choice option.",
            parser.peek().span,
          );
        }
        parser.synchronizeStatement();
      }
      break;
    }
    parser.skipContinuationNewlines();
    if (isInteractionChoiceTerminator(parser)) {
      missingChoiceOptionWasReported = true;
      parser.reportInsertion(
        parserDiagnosticCode.expectedChoiceOption,
        "Expected a choice option after ','.",
      );
      break;
    }
  }
  if (options.length === 0 && !missingChoiceOptionWasReported) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedChoiceOption,
      "Expected at least one choice option.",
    );
  }
  const end = prefill?.span ?? options.at(-1)?.expression.span ?? speaker?.span ?? command.span;
  return Object.freeze({
    kind: "interactionExpression",
    interactionKind,
    commandSpan: copySpan(command.span),
    asSpan,
    speaker,
    presentation: null,
    question: null,
    hint: null,
    prefill,
    options: Object.freeze(options),
    formArguments: Object.freeze([]),
    span: spanFrom(command.span, end),
  });
}

/**
 * `askText [as speaker] [mode] ([question][, hint: text][, prefill: value])` and the other basic asks: the parentheses
 * hold the arguments of the compact form, so `)` ends the ask and both forms give the same interaction.
 */
function* parseBoundedAsk(
  parser: Parser,
  command: Token,
  interactionKind: Exclude<InteractionExpression["interactionKind"], "choice">,
  asSpan: SourceSpan | null,
  speaker: Identifier | null,
  presentation: ObjectLiteral | null,
): ParseTask<InteractionExpression | null> {
  const written = yield* parseChild(
    parser.withinDelimiters(parser.finishCall(parser.identifier(command), parser.advance())),
  );
  const call: CallExpression = Object.freeze({
    ...written,
    arguments: Object.freeze(
      written.arguments.map((argument) =>
        argument.kind === "namedArgument"
          ? Object.freeze({
              ...argument,
              name: renamedAskOption(parser, command, interactionKind, argument.name),
            })
          : argument,
      ),
    ),
  });
  const parts = parser.boundedArguments(
    command,
    call,
    readAskOptionNames(interactionKind),
    parserDiagnosticCode.unsupportedInteractionForm,
  );
  if (parser.check(TokenKind.KeywordAs) && !parser.atStorageDelimiter()) {
    parser.reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      `The 'as speaker' clause must appear immediately after '${command.lexeme}'.`,
      parser.peek().span,
    );
    parser.synchronizeStatement();
  }
  if (parts === null) return null;
  // The arguments were checked to be known and unique, so the named ones are the options in written order.
  const named = call.arguments.flatMap((argument) =>
    argument.kind === "namedArgument"
      ? [Object.freeze({ name: argument.name, value: argument.value })]
      : [],
  );
  return askExpression(
    parser,
    command,
    interactionKind,
    asSpan,
    speaker,
    presentation,
    parts.value,
    named,
    spanFrom(command.span, call.span),
  );
}

function isInteractionChoiceTerminator(parser: Parser): boolean {
  return (
    parser.check(TokenKind.Newline) ||
    parser.check(TokenKind.EndOfFile) ||
    parser.check(TokenKind.RightBrace) ||
    parser.check(TokenKind.RightParenthesis) ||
    parser.check(TokenKind.RightBracket) ||
    parser.check(TokenKind.InterpolationEnd) ||
    parser.atStorageDelimiter()
  );
}

/**
 * `name`, or for the earlier name of the ask's prefill, such as `default:`, the error that names the fix and `prefill`
 * at its place, so that the ask is checked as the author meant it.
 */
function renamedAskOption(
  parser: Parser,
  command: Token,
  interactionKind: InteractionExpression["interactionKind"],
  name: Identifier,
): Identifier {
  if (name.name !== removedPrefillName(interactionKind)) return name;
  parser.reportSpan(
    parserDiagnosticCode.unsupportedInteractionForm,
    `${command.lexeme} has no '${name.name}:'. Use 'prefill:'.`,
    name.span,
  );
  return Object.freeze({ ...name, name: "prefill" });
}

/** The named option of an ask among `names`, such as `hint:` or `prefill:`, at `offset` tokens ahead, or `null`. */
function askOptionAt(parser: Parser, offset: number, names: readonly string[]): string | null {
  const token = parser.peek(offset);
  if (token.kind !== TokenKind.Identifier || parser.peek(offset + 1).kind !== TokenKind.Colon)
    return null;
  return names.includes(token.lexeme) ? token.lexeme : null;
}

/**
 * A basic ask, `askForm`, `askBoolean`, or `askBooleans` from its question and named options in written order. A basic
 * ask keeps `hint:` and `prefill:`; the others keep every option, and a form needs `fields:`, or `texts:` and
 * `prefill:` for `askBooleans`.
 */
function askExpression(
  parser: Parser,
  command: Token,
  interactionKind: Exclude<InteractionExpression["interactionKind"], "choice">,
  asSpan: SourceSpan | null,
  speaker: Identifier | null,
  presentation: ObjectLiteral | null,
  question: Expression | null,
  named: readonly FormArgument[],
  span: SourceSpan,
): InteractionExpression {
  const keepsArguments = NAMED_ASK_OPTIONS.has(interactionKind);
  const has = (name: string) => named.some((argument) => argument.name.name === name);
  const timeout = named.find((argument) => argument.name.name === "timeout");
  if (interactionKind === "form" && timeout !== undefined)
    requireExactDuration(parser, timeout.value, "An askForm timeout");
  if (presentation !== null && question === null && !(keepsArguments && has("message")))
    reportQuestionlessPresentation(parser, command, presentation);
  for (const required of requiredAskOptionNames(interactionKind))
    if (!has(required))
      parser.reportSpan(
        parserDiagnosticCode.unsupportedInteractionForm,
        interactionKind === "form"
          ? "askForm needs its fields, as in 'fields: { enabled: false }'."
          : `askBooleans needs ${required}:, as in 'askBooleans "Choose", texts: ["A", "B"], prefill: [true, false]'.`,
        command.span,
      );
  if (question !== null && has("message"))
    parser.reportSpan(
      parserDiagnosticCode.unsupportedInteractionForm,
      `${command.lexeme} has a question and 'message:'. Keep one.`,
      named.find((argument) => argument.name.name === "message")!.name.span,
    );
  const option = (name: string) =>
    keepsArguments ? null : (named.find((argument) => argument.name.name === name)?.value ?? null);
  return Object.freeze({
    kind: "interactionExpression",
    interactionKind,
    commandSpan: copySpan(command.span),
    asSpan,
    speaker,
    presentation,
    question,
    hint: option("hint"),
    prefill: option("prefill"),
    options: Object.freeze([]),
    formArguments: Object.freeze(keepsArguments ? [...named] : []),
    span,
  });
}

/** A mode written for a question that the ask does not have, which would say nothing. */
function reportQuestionlessPresentation(
  parser: Parser,
  command: Token,
  presentation: ObjectLiteral,
): void {
  const mode = staticModeName(presentation);
  parser.reportSpan(
    parserDiagnosticCode.unsupportedInteractionForm,
    `'${mode}' shows the question, but this ${command.lexeme} has none. Write the question after '${mode}', or leave '${mode}' out.`,
    presentation.span,
  );
}

/**
 * Whether `bubble` or `prose` here is the mode of an ask's question rather than the question itself, read as for
 * `say`: the mode is followed by the question, as in `askText prose "Name?"`, or by the ask's parentheses after its
 * options, as in `askText prose() ("Name?")`. Parentheses right after the word that a value follows are its options,
 * as in `prose(align: "center") "Name?"`; otherwise the word starts the question, as `prose` in `askText prose + "?"`
 * or the call in `askText prose("Name?")`. Only tokens are read, so nested asks are not parsed again: before a `/`, the
 * word is the question, and a regex there is found by parsing it (see `#parseInteractionExpression`).
 */
function atQuestionPresentation(parser: Parser): boolean {
  if (!parser.check(TokenKind.Identifier) || !PRESENTATION_MODES.has(parser.peek().lexeme))
    return false;
  if (atSayModeBeforeBoundedText(parser)) return true;
  const next = peekAfterSayMode(parser);
  return (
    next !== null &&
    isExpressionStart(next) &&
    !EXPRESSION_CONTINUATIONS.has(next.kind) &&
    !(parser.blockEndsCompactInteraction && next.kind === TokenKind.LeftBrace)
  );
}

/**
 * `askImage bubble(options) (arguments)` or `askImage prose (arguments)`: the question's mode, as for a basic ask
 * (#832). Parentheses after the mode hold its options only when the arguments follow them.
 */
export function* parseAskImageWithPresentation(parser: Parser): ParseTask<CallExpression | null> {
  const command = parser.advance();
  const closer = parser.closerOf(parser.current + 1);
  const withOptions =
    parser.peek(1).kind === TokenKind.LeftParenthesis &&
    closer !== undefined &&
    parser.tokens[closer + 1]?.kind === TokenKind.LeftParenthesis;
  const presentation = yield* parseChild(parseSayPresentation(parser, withOptions));
  if (!parser.check(TokenKind.LeftParenthesis)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedDelimiter,
      `askImage takes its question in parentheses after '${staticModeName(presentation)}', as in 'askImage ${staticModeName(presentation)} ("Show me")'.`,
    );
    parser.synchronizeStatement();
    return null;
  }
  const call = yield* parseChild(
    parser.withinDelimiters(parser.finishCall(parser.identifier(command), parser.advance())),
  );
  if (
    !call.arguments.some(
      (argument) => argument.kind === "positionalArgument" || argument.name.name === "message",
    )
  )
    reportQuestionlessPresentation(parser, command, presentation);
  return Object.freeze({ ...call, presentation });
}

function interactionChoiceValue(
  parser: Parser,
  token: Token,
): Identifier | import("../ast.js").NumberLiteral {
  if (token.kind === TokenKind.Identifier) return parser.identifier(token);
  return Object.freeze({
    kind: "numberLiteral",
    raw: token.lexeme,
    value: Number(token.lexeme),
    numericType: /[.eE]/u.test(token.lexeme) ? "number" : "integer",
    span: copySpan(token.span),
  });
}

/** The mode a presentation object was written with: its first property, `kind`, holds `bubble` or `prose`. */
function staticModeName(presentation: ObjectLiteral): string {
  const kind = presentation.properties[0]!.value;
  return kind.kind === "stringLiteral" && kind.parts[0]?.kind === "stringText"
    ? kind.parts[0].value
    : "prose";
}
