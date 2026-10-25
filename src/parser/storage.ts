import { parseChild, type ParseTask } from "../parse-continuation.js";
import type { Expression, DeleteStatement, LoadExpression, SaveStatement } from "../ast.js";
import { startsCallForm } from "../language-facts.js";
import { TokenKind } from "../token.js";
import type { Parser } from "../parser.js";
import { parserDiagnosticCode } from "./diagnostic-codes.js";
import { copySpan, spanFrom } from "./tokens.js";

// Storage: `save`, `delete`, and `load`, and the delimiters that end a storage operand.

export type StorageDelimiter = "as" | "default";

export const NO_STORAGE_DELIMITERS: ReadonlySet<StorageDelimiter> = new Set();

const SAVE_VALUE_DELIMITERS: ReadonlySet<StorageDelimiter> = new Set(["as"]);

/** `save <value> as <key>`; both operands are full expressions. */
export function parseSaveStatement(parser: Parser): SaveStatement | null {
  const command = parser.advance();
  const value = parser.parseStorageOperand(SAVE_VALUE_DELIMITERS);
  if (value === null) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedExpression,
      "Expected a value to save after 'save'.",
    );
    parser.synchronizeStatement(true);
    return null;
  }
  if (!parser.match(TokenKind.KeywordAs)) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedStorageKey,
      "Expected 'as' and a storage key, such as 'save score as \"player.score\"'.",
    );
    parser.synchronizeStatement(true);
    return null;
  }
  const key = parser.parseStorageOperand(NO_STORAGE_DELIMITERS);
  if (key === null) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedStorageKey,
      "Expected a storage key after 'as'.",
    );
    parser.synchronizeStatement(true);
    return null;
  }
  return Object.freeze({
    kind: "saveStatement",
    value,
    key,
    span: spanFrom(command.span, key.span),
  });
}

export function parseDeleteStatement(parser: Parser): DeleteStatement | null {
  const command = parser.advance();
  const key = parser.parseStorageOperand(NO_STORAGE_DELIMITERS);
  if (key === null) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedStorageKey,
      "Expected a storage key after 'delete'.",
    );
    parser.synchronizeStatement(true);
    return null;
  }
  return Object.freeze({ kind: "deleteStatement", key, span: spanFrom(command.span, key.span) });
}

/**
 * `load(<key>[, default: <value>])`, or the compact `load <key>[, default: <value>]`, whose operands are full
 * expressions, so `(load "k") == null` needs parentheses. Like the prefill of an ask, the compact `, default:` binds to
 * the nearest `load` before it. The default is evaluated only when the key holds no value that fits the load's type.
 */
export function* parseLoadExpression(parser: Parser): ParseTask<LoadExpression | null> {
  const command = parser.advance();
  // Whitespace does not matter: `load ("k")` is the bounded form too, so its `)` ends the load.
  if (startsCallForm(command, parser.peek())) {
    const call = yield* parseChild(
      parser.withinDelimiters(parser.finishCall(parser.identifier(command), parser.advance())),
    );
    const parts = parser.boundedArguments(
      command,
      call,
      ["default"],
      parserDiagnosticCode.invalidLoadForm,
    );
    if (parts === null) return null;
    if (parts.value === null) {
      parser.reportSpan(
        parserDiagnosticCode.expectedStorageKey,
        "Expected a storage key in 'load(...)', such as 'load(\"name\", default: \"\")'.",
        call.span,
      );
      return null;
    }
    return Object.freeze({
      kind: "loadExpression",
      key: parts.value,
      defaultValue: parts.options.get("default") ?? null,
      span: copySpan(call.span),
    });
  }
  // The key ends at a bare `default`, the earlier fallback form, so that the message below names the fix.
  const enclosing = parser.storageDelimiters;
  parser.storageDelimiters = new Set([...enclosing, "default"]);
  const key = yield* parseChild(parser.parseOr());
  parser.storageDelimiters = enclosing;
  if (key === null) {
    parser.reportInsertion(
      parserDiagnosticCode.expectedStorageKey,
      "Expected a storage key after 'load'.",
    );
    return null;
  }
  let defaultOffset = parser.offsetAfterComma();
  if (defaultOffset === null && parser.checkIdentifier("default")) {
    // The removed V30 form `load "k" default v`, or a missing comma before `default:`.
    parser.reportToken(
      parserDiagnosticCode.expectedDelimiter,
      "Write a fallback for load as 'load key, default: value', with a comma and a colon.",
      parser.peek(),
    );
    // Recover with the fallback as written, so the rest of the statement parses normally.
    defaultOffset = parser.peek(1).kind === TokenKind.Colon ? 0 : -1;
  }
  let defaultValue: Expression | null = null;
  if (defaultOffset === -1) {
    parser.advance();
    defaultValue = yield* parseChild(parser.parseOr());
  } else if (defaultOffset !== null && parser.atNamedDefault(defaultOffset)) {
    for (let skipped = 0; skipped < defaultOffset + 2; skipped += 1) parser.advance();
    defaultValue = yield* parseChild(parser.parseColonValueTask(false));
    if (defaultValue === null) {
      parser.reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected a fallback value after 'default:'.",
      );
      if (parser.previous().kind === TokenKind.Newline && parser.atStatementStart())
        parser.recoveredAtStatementBoundary = true;
    }
  }
  return Object.freeze({
    kind: "loadExpression",
    key,
    defaultValue,
    span: spanFrom(command.span, (defaultValue ?? key).span),
  });
}
