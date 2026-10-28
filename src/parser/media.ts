import { parseChild, type ParseTask } from "../parse-continuation.js";
import type {
  Expression,
  HideImageStatement,
  HideCameraStatement,
  CameraPlacement,
  MediaCue,
  MediaHandlers,
  MediaKind,
  MediaParts,
  MediaRepeat,
  StopAudioStatement,
  ShowImageStatement,
  Statement,
} from "../ast.js";
import { startsCallForm } from "../language-facts.js";
import type { SourceSpan } from "../source.js";
import { TokenKind, type Token } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, isExpressionStart, isPropertyName, spanFrom } from "./tokens.js";
import { requireExactDuration } from "./units.js";
import { parseTaggedQuery } from "./tag-queries.js";

// Images, audio, video, and the camera: their commands, the named media form, its handlers, and its cues.

/** The named arguments of the named form of `playAudio` and `playVideo`, which needs `file:` (V30 §22). */
export const MEDIA_ARGUMENTS = ["file", "async", "repeat", "startAt", "endAt", "volume"] as const;

/** `showImage <file>` uses command syntax; the V30 parenthesized layered-image form is not supported. */
export function parseShowImageStatement(parser: Parser): ShowImageStatement | null {
  const command = parser.advance();
  if (
    parser.rejectAdjacentParenthesis(
      command,
      "showImage uses command syntax, such as 'showImage \"room.jpg\"'.",
    )
  )
    return null;
  const tagged = parser.checkIdentifier("tagged");
  const mark = parser.mark();
  const image = tagged ? parseTaggedQuery(parser, "images") : parser.parseExpression();
  if (image === null) {
    if (!tagged) {
      parser.reportMissing(
        mark,
        parserDiagnosticCode.expectedExpression,
        "Expected an image file or null after 'showImage'.",
      );
    }
    // A statement at the start of a continued line, after a trailing comma or option name, is kept.
    if (tagged && parser.previous().kind === TokenKind.Newline && parser.atStatementStart()) {
      parser.recoveredAtStatementBoundary = true;
    } else {
      parser.synchronizeStatement(true);
    }
    return null;
  }
  parser.recordCommand(command, image.span.end.offset, false);
  return Object.freeze({
    kind: "showImageStatement",
    image,
    span: spanFrom(command.span, image.span),
  });
}

/** `showCamera [stage]`: the contextual word `stage` directly after the command places the view over the Stage. */
export function parseShowCameraParts(
  parser: Parser,
): { placement: CameraPlacement; span: SourceSpan } | null {
  const command = parser.advance();
  if (
    parser.rejectAdjacentParenthesis(
      command,
      "showCamera uses command syntax. Write 'showCamera' or 'showCamera stage'.",
    )
  )
    return null;
  if (!parser.checkIdentifier("stage")) {
    parser.recordCommand(command, command.span.end.offset, false);
    return { placement: "window", span: copySpan(command.span) };
  }
  const word = parser.advance();
  parser.recordCommand(command, word.span.end.offset, false);
  return { placement: "stage", span: spanFrom(command.span, word.span) };
}

export function parseHideCameraStatement(parser: Parser): HideCameraStatement | null {
  const command = parser.advance();
  if (
    parser.rejectAdjacentParenthesis(command, "hideCamera takes no arguments. Write 'hideCamera'.")
  )
    return null;
  parser.recordCommand(command, command.span.end.offset, false);
  return Object.freeze({ kind: "hideCameraStatement", span: copySpan(command.span) });
}

export function parseHideImageStatement(parser: Parser): HideImageStatement | null {
  const command = parser.advance();
  if (parser.rejectAdjacentParenthesis(command, "hideImage takes no arguments. Write 'hideImage'."))
    return null;
  parser.recordCommand(command, command.span.end.offset, false);
  return Object.freeze({ kind: "hideImageStatement", span: copySpan(command.span) });
}

/**
 * `stopAudio` stops every sound and takes no arguments. Anything after it on the line is reported and skipped; an
 * enclosing block keeps its closing brace.
 */
export function parseStopAudioStatement(parser: Parser): StopAudioStatement | null {
  const command = parser.advance();
  let braces = 0;
  const atEnd = () =>
    parser.check(TokenKind.Newline) ||
    parser.check(TokenKind.EndOfFile) ||
    (braces === 0 && parser.check(TokenKind.RightBrace));
  if (atEnd()) {
    parser.recordCommand(command, command.span.end.offset, false);
    return Object.freeze({ kind: "stopAudioStatement", span: copySpan(command.span) });
  }
  const first = parser.peek();
  let last = first;
  while (!atEnd()) {
    last = parser.advance();
    if (last.kind === TokenKind.LeftBrace) braces += 1;
    else if (last.kind === TokenKind.RightBrace) braces -= 1;
  }
  parser.reportSpan(
    parserDiagnosticCode.invalidMediaForm,
    "stopAudio takes no arguments. To stop one sound, keep its handle and call stop() on it.",
    spanFrom(first.span, last.span),
  );
  return null;
}

/**
 * Parses `playAudio|playVideo [async] [repeat] <file> [{ ... }]` or `playAudio|playVideo(name: value, ...) [{ ... }]`.
 * `async` and `repeat` are recognized only directly after the command; `playAudio (async)` uses a variable.
 */
export function* parseMediaParts(parser: Parser): ParseTask<MediaParts | null> {
  const command = parser.advance();
  const media: MediaKind = command.lexeme === "playAudio" ? "audio" : "video";
  if (startsCallForm(command, parser.peek())) {
    return yield* parseChild(parser.withinDelimiters(parseNamedMedia(parser, command, media)));
  }
  const async = parser.checkIdentifier("async");
  if (async) parser.advance();
  let repeat: MediaRepeat | null = null;
  if (parser.check(TokenKind.KeywordRepeat)) {
    repeat = Object.freeze({ kind: "indefinite", span: copySpan(parser.advance().span) });
  }
  const mark = parser.mark();
  const file = yield* parseChild(parser.parseOr());
  if (file === null) {
    parser.reportMissing(
      mark,
      parserDiagnosticCode.expectedExpression,
      `Expected a media file such as "sounds/bell.mp3" after '${command.lexeme}'.`,
    );
    parser.synchronizeStatement(true);
    return null;
  }
  parser.recordCommand(command, file.span.end.offset, true);
  const handlers = yield* parseChild(parseMediaHandlers(parser));
  if (handlers === false) return null;
  return {
    media,
    form: "short",
    async,
    file,
    repeat,
    startAt: null,
    endAt: null,
    volume: null,
    handlers,
    commandSpan: copySpan(command.span),
    span: spanFrom(command.span, handlers === null ? file.span : mediaHandlersSpan(handlers)),
  };
}

/** The named form; `repeat:` also accepts `<count> times`. */
function* parseNamedMedia(
  parser: Parser,
  command: Token,
  media: MediaKind,
): ParseTask<MediaParts | null> {
  const left = parser.advance();
  const values: Partial<Record<(typeof MEDIA_ARGUMENTS)[number], Expression>> = {};
  let repeat: MediaRepeat | null = null;
  let async = false;
  let valid = true;
  parser.skipNewlines();
  while (!parser.check(TokenKind.RightParenthesis) && !parser.check(TokenKind.EndOfFile)) {
    if (!isPropertyName(parser.peek()) || parser.peek(1).kind !== TokenKind.Colon) {
      const value = yield* parseChild(parser.parseRequiredExpressionTask());
      parser.reportSpan(
        parserDiagnosticCode.invalidMediaForm,
        `The parenthesized ${command.lexeme} form uses named arguments, such as '${command.lexeme}(file: "${media === "audio" ? "sounds/bell.mp3" : "videos/intro.mp4"}")'.`,
        value?.span ?? parser.peek().span,
      );
      valid = false;
      if (value === null) break;
    } else {
      const name = parser.identifier(parser.advance());
      parser.advance();
      const value = yield* parseChild(parser.parseColonValueTask(true));
      if (value === null) {
        valid = false;
        break;
      }
      const argument = MEDIA_ARGUMENTS.find((candidate) => candidate === name.name);
      if (argument === undefined) {
        parser.reportSpan(
          parserDiagnosticCode.invalidMediaForm,
          `Unknown ${command.lexeme} argument '${name.name}'. Use ${MEDIA_ARGUMENTS.join(", ")}.`,
          name.span,
        );
        valid = false;
      } else if (Object.hasOwn(values, name.name)) {
        parser.reportSpan(
          parserDiagnosticCode.invalidMediaForm,
          `Duplicate ${command.lexeme} argument '${name.name}'.`,
          name.span,
        );
        valid = false;
      } else {
        values[argument] = value;
        if (argument === "startAt" || argument === "endAt")
          requireExactDuration(parser, value, "A media position");
      }
      if (name.name === "async") {
        if (value.kind !== "booleanLiteral") {
          parser.reportSpan(
            parserDiagnosticCode.invalidMediaForm,
            `${command.lexeme} argument 'async' must be the literal true or false.`,
            value.span,
          );
          valid = false;
        } else {
          async = value.value;
        }
      }
      if (name.name === "repeat") {
        if (parser.checkIdentifier("times")) {
          const times = parser.advance();
          repeat = Object.freeze({
            kind: "times",
            count: value,
            span: spanFrom(value.span, times.span),
          });
        } else {
          repeat = Object.freeze({ kind: "value", value, span: copySpan(value.span) });
          requireExactDuration(parser, value, "A repeat budget");
        }
      }
    }
    parser.skipNewlines();
    if (!parser.match(TokenKind.Comma)) break;
    parser.skipNewlines();
    if (parser.check(TokenKind.RightParenthesis)) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected an argument after ','.",
      );
      valid = false;
      break;
    }
  }
  if (!parser.match(TokenKind.RightParenthesis)) {
    parser.reportMissingCloser(
      parserDiagnosticCode.expectedDelimiter,
      `Expected ')' after the ${command.lexeme} arguments.`,
    );
    parser.synchronizeStatement(true);
    return null;
  }
  const right = parser.previous();
  parser.recordCommand(command, right.span.end.offset, true);
  const file = values.file ?? null;
  if (file === null && valid) {
    parser.reportSpan(
      parserDiagnosticCode.invalidMediaForm,
      `The parenthesized ${command.lexeme} form requires a 'file' argument.`,
      spanFrom(left.span, right.span),
    );
  }
  const handlers = yield* parseChild(parseMediaHandlers(parser));
  if (handlers === false || file === null || !valid) return null;
  return {
    media,
    form: "named",
    async,
    file,
    repeat,
    startAt: values.startAt ?? null,
    endAt: values.endAt ?? null,
    volume: values.volume ?? null,
    handlers,
    commandSpan: copySpan(command.span),
    span: spanFrom(command.span, handlers === null ? right.span : mediaHandlersSpan(handlers)),
  };
}

/**
 * An optional block on the same line. Its top level holds either ordinary statements (a compact block) or cue
 * declarations; `false` reports an already diagnosed failure.
 */
function* parseMediaHandlers(parser: Parser): ParseTask<MediaHandlers | null | false> {
  if (!parser.check(TokenKind.LeftBrace)) return null;
  return yield* parseChild(
    parser.asStatements(parser.parseOnce("mediaBlock", parseMediaHandlerBlock(parser))),
  );
}

function* parseMediaHandlerBlock(parser: Parser): ParseTask<MediaHandlers | false> {
  const leftBrace = parser.advance();
  parser.skipNewlines();
  const cueMode = isMediaCueStart(parser);
  const statements: Statement[] = [];
  const cues: MediaCue[] = [];
  while (!parser.check(TokenKind.RightBrace) && !parser.check(TokenKind.EndOfFile)) {
    const startIndex = parser.current;
    const diagnosticCount = parser.diagnostics.length;
    const cueStart = isMediaCueStart(parser);
    if (cueStart !== cueMode) {
      parser.reportToken(
        parserDiagnosticCode.invalidMediaForm,
        "A media block holds either cue declarations (at, beforeEnd, finish) or ordinary statements, not both.",
        parser.peek(),
      );
    }
    if (cueStart) {
      const cue = yield* parseChild(parseMediaCue(parser));
      if (cue !== null) cues.push(cue);
    } else {
      const statement = yield* parseChild(parser.parseStatement());
      if (statement !== null) statements.push(statement);
    }
    parser.endStatement(startIndex, diagnosticCount, true);
  }
  if (!parser.closeBlock(leftBrace)) return false;
  const span = spanFrom(leftBrace.span, parser.previous().span);
  return cueMode
    ? Object.freeze({ kind: "cues", cues: Object.freeze(cues), span })
    : Object.freeze({
        kind: "compact",
        body: Object.freeze({ kind: "block", statements: Object.freeze(statements), span }),
      });
}

/**
 * `at` and `beforeEnd` followed by a cue position and `{`, and `finish` followed by `{`, start a cue declaration. The
 * position may continue across lines like any expression, and a leading `{` belongs to an object-literal position. A
 * call or index written directly after the word, and logical lines without a top-level `{` or with a top-level
 * assignment, such as `at (1)` or `beforeEnd [1] = 2`, stay ordinary statements. The scan is linear in the line and
 * never reparses a cue position.
 */
function isMediaCueStart(parser: Parser): boolean {
  const token = parser.peek();
  if (token.kind !== TokenKind.Identifier) return false;
  const next = parser.peek(1);
  if (token.lexeme === "finish") return next.kind === TokenKind.LeftBrace;
  if (token.lexeme !== "at" && token.lexeme !== "beforeEnd") return false;
  if (!isExpressionStart(next)) return false;
  if (
    next.span.start.offset === token.span.end.offset &&
    (next.kind === TokenKind.LeftParenthesis || next.kind === TokenKind.LeftBracket)
  )
    return false;
  let depth = 0;
  let previous = parser.current;
  for (let index = parser.current + 1; index < parser.tokens.length; index += 1) {
    const kind = parser.tokens[index]!.kind;
    if (kind === TokenKind.EndOfFile) return false;
    if (kind === TokenKind.Newline && parser.continuesAfter(previous)) continue;
    previous = index;
    if (depth === 0) {
      if (kind === TokenKind.LeftBrace && index > parser.current + 1) return true;
      if (
        kind === TokenKind.Newline ||
        kind === TokenKind.RightBrace ||
        kind === TokenKind.Equal ||
        kind === TokenKind.PlusEqual ||
        kind === TokenKind.MinusEqual
      )
        return false;
    }
    if (
      kind === TokenKind.LeftParenthesis ||
      kind === TokenKind.LeftBracket ||
      kind === TokenKind.LeftBrace ||
      kind === TokenKind.InterpolationStart
    ) {
      depth += 1;
    } else if (
      kind === TokenKind.RightParenthesis ||
      kind === TokenKind.RightBracket ||
      kind === TokenKind.RightBrace ||
      kind === TokenKind.InterpolationEnd
    ) {
      depth = Math.max(0, depth - 1);
    }
  }
  return false;
}

function* parseMediaCue(parser: Parser): ParseTask<MediaCue | null> {
  const keyword = parser.advance();
  const kind: MediaCue["kind"] =
    keyword.lexeme === "at" ? "at" : keyword.lexeme === "beforeEnd" ? "beforeEnd" : "finish";
  let offset: Expression | null = null;
  if (kind !== "finish") {
    const enclosing = parser.blockEndsCompactInteraction;
    parser.blockEndsCompactInteraction = true;
    const mark = parser.mark();
    offset = yield* parseChild(parser.parseOr());
    parser.blockEndsCompactInteraction = enclosing;
    if (offset !== null) requireExactDuration(parser, offset, "A cue position");
    if (offset === null) {
      // A position that reported its own error, as `2 s + {`, needs no second one, and its block still parses.
      parser.reportMissing(
        mark,
        parserDiagnosticCode.expectedExpression,
        `Expected a cue position such as '30 s' after '${keyword.lexeme}'.`,
      );
      if (parser.check(TokenKind.LeftBrace)) yield* parseChild(parser.parseBlock());
      else parser.synchronizeStatement(true);
      return null;
    }
  }
  if (!parser.check(TokenKind.LeftBrace)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedBlock,
      `Expected '{' to start the ${keyword.lexeme} cue block.`,
    );
    parser.synchronizeStatement(true);
    return null;
  }
  const body = yield* parseChild(parser.parseBlock());
  if (body === null) return null;
  return Object.freeze({
    kind,
    offset,
    body,
    keywordSpan: copySpan(keyword.span),
    span: spanFrom(keyword.span, body.span),
  });
}

function mediaHandlersSpan(handlers: MediaHandlers): SourceSpan {
  return handlers.kind === "compact" ? handlers.body.span : handlers.span;
}
