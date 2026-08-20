import type {
  Expression,
  InteractionExpression,
  Program,
  SayStatement,
  ShowButtonStatement,
  Statement,
} from "./ast.js";
import { compileSource } from "./compiler.js";
import type { Diagnostic } from "./diagnostics.js";
import { lex } from "./lexer.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourcePosition,
  type SourceSpan,
} from "./source.js";
import { TokenKind, type Token } from "./token.js";

export interface LanguageDocument {
  readonly uri: string;
  readonly text: string;
}

export type LanguagePosition = SourcePosition;
export type LanguageRange = SourceSpan;
export type LanguageDiagnostic = Diagnostic;

export type LanguageCompletionKind = "keyword" | "command" | "speaker" | "modifier" | "value";

export interface LanguageCompletionItem {
  readonly label: string;
  readonly kind: LanguageCompletionKind;
  readonly detail: string;
  readonly insertText: string;
}

export interface LanguageContextHelp {
  readonly command: "showButton" | "askText" | "askNumber" | "choose" | "say";
  readonly summary: string;
  readonly syntax: string;
}

export interface LanguageHover {
  readonly range: LanguageRange;
  readonly contents: readonly string[];
}

export interface LanguageSignatureHelp {
  readonly label: string;
  readonly documentation: string;
  readonly activeParameter: number;
  readonly parameters: readonly string[];
}

export interface LanguageTextEdit {
  readonly range: LanguageRange;
  readonly newText: string;
}

export interface LanguageFormatResult {
  readonly edits: readonly LanguageTextEdit[];
  readonly text: string;
}

const HELP = Object.freeze({
  showButton: Object.freeze({
    command: "showButton" as const,
    summary: "Shows one foreground button and waits for activation. It does not produce a useful script result and has no timeout/cancellation result in the current compact form.",
    syntax: 'showButton [as speaker] label',
  }),
  askText: Object.freeze({
    command: "askText" as const,
    summary: "Waits for submitted text. Line endings are normalized while other whitespace is preserved; whitespace-only input is rejected and retried. The optional hint is UI guidance, not transcript text.",
    syntax: "askText [as speaker] [hint]",
  }),
  askNumber: Object.freeze({
    command: "askNumber" as const,
    summary: "Waits for numeric text, trims surrounding whitespace, accepts the TeaseScript numeric grammar, requires a finite value, and preserves negative zero.",
    syntax: "askNumber [as speaker] [hint]",
  }),
  choose: Object.freeze({
    command: "choose" as const,
    summary: "Waits for one choice. Options may be unlabelled or consistently identifier-labelled or number-labelled; labelled results use the exact label value.",
    syntax: "choose [as speaker] [label:] option, [label:] option, ...",
  }),
  say: Object.freeze({
    command: "say" as const,
    summary: "Emits visible chat text. Current pacing supports smart pacing by default, an exact non-negative seconds expression including 0, or instant; skip policy may be skippable or unskippable.",
    syntax: "say [as speaker] [skippable|unskippable] text [, pacing|instant]",
  }),
});

export function createLanguageDocument(uri: string, text: string): LanguageDocument {
  return Object.freeze({ uri, text });
}

export function languagePositionAt(document: LanguageDocument, offset: number): LanguagePosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > document.text.length) {
    throw new RangeError("Language document offset is outside the document.");
  }
  let line = 0;
  let column = 0;
  let index = 0;
  while (index < offset) {
    const code = document.text.charCodeAt(index);
    if (code === 13) {
      if (index + 1 < offset && document.text.charCodeAt(index + 1) === 10) index += 1;
      line += 1;
      column = 0;
    } else if (code === 10) {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
    index += 1;
  }
  return createSourcePosition(offset, line, column);
}

export function languageDiagnostics(document: LanguageDocument): readonly LanguageDiagnostic[] {
  return compileSource(document.text).diagnostics;
}

export function languageCompletions(
  document: LanguageDocument,
  position: LanguagePosition,
): readonly LanguageCompletionItem[] {
  const offset = position.offset;
  if (offset < 0 || offset > document.text.length) return Object.freeze([]);
  const prefix = document.text.slice(0, offset);
  const tokens = lex(prefix).tokens.filter((token) => token.kind !== TokenKind.EndOfFile);
  const significant = tokens.filter((token) => token.kind !== TokenKind.Newline);
  const last = significant.at(-1);
  const lineTokens = tokensAfterLastNewline(tokens);
  const items: LanguageCompletionItem[] = [];

  const statementStart = lineTokens.length === 0 || isStatementBoundary(last);
  if (statementStart) {
    items.push(command("showButton", "Compact foreground button interaction"));
    items.push(command("say", "Emit chat text with optional speaker, skip policy, and pacing"));
  }

  if (isExpressionCompletionContext(last, lineTokens)) {
    items.push(command("askText", "Compact text-input expression"));
    items.push(command("askNumber", "Compact numeric-input expression"));
    items.push(command("choose", "Compact choice expression"));
  }

  const compact = compactCommandContext(lineTokens);
  if (compact !== null) {
    if (compact.stage === "afterCommand") {
      items.push(keyword("as", "Optional speaker clause"));
      if (compact.command === "say") {
        items.push(modifier("skippable", "Allow the current pacing gate to be skipped"));
        items.push(modifier("unskippable", "Do not allow the current pacing gate to be skipped"));
      }
    }
    if (compact.stage === "afterAs") {
      for (const speaker of declaredSpeakers(document.text)) {
        items.push(Object.freeze({ label: speaker, kind: "speaker", detail: "Declared speaker", insertText: speaker }));
      }
    }
    if (compact.command === "say" && compact.stage === "afterComma") {
      items.push(value("instant", "Disable pacing delay"));
      items.push(value("0", "Exact zero-second pacing"));
    }
  }

  return dedupe(items);
}

export function languageContextHelp(
  document: LanguageDocument,
  position: LanguagePosition,
): LanguageContextHelp | null {
  const located = locateCompactCommand(document, position.offset);
  return located === null ? null : HELP[located.command];
}

export function languageHover(
  document: LanguageDocument,
  position: LanguagePosition,
): LanguageHover | null {
  const located = locateCompactCommand(document, position.offset);
  if (located === null) return null;
  const help = HELP[located.command];
  return Object.freeze({
    range: located.range,
    contents: Object.freeze([`**${help.command}**`, help.summary, `Syntax: \`${help.syntax}\``]),
  });
}

export function languageSignatureHelp(
  document: LanguageDocument,
  position: LanguagePosition,
): LanguageSignatureHelp | null {
  const located = locateCompactCommand(document, position.offset);
  if (located === null) return null;
  const help = HELP[located.command];
  const parameters = signatureParameters(located.command);
  return Object.freeze({
    label: help.syntax,
    documentation: help.summary,
    activeParameter: activeParameterFor(document.text, located.command, located.range.start.offset, position.offset),
    parameters,
  });
}

export function formatLanguageDocument(document: LanguageDocument): LanguageFormatResult {
  const compilation = compileSource(document.text);
  if (compilation.plan === null || compilation.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return Object.freeze({ edits: Object.freeze([]), text: document.text });
  }

  const rawEdits: OffsetEdit[] = [];
  visitProgram(compilation.program, {
    showButton(node) { formatShowButton(document.text, node, rawEdits); },
    interaction(node) { formatInteraction(document.text, node, rawEdits); },
    say(node) { formatSay(document.text, node, rawEdits); },
  });
  const normalized = normalizeOffsetEdits(rawEdits);
  const edits = Object.freeze(normalized.map((edit) => Object.freeze({
    range: createSourceSpan(languagePositionAt(document, edit.start), languagePositionAt(document, edit.end)),
    newText: edit.newText,
  })));
  return Object.freeze({ edits, text: applyLanguageTextEdits(document, edits) });
}

export function applyLanguageTextEdits(
  document: LanguageDocument,
  edits: readonly LanguageTextEdit[],
): string {
  const ordered = [...edits].sort((left, right) => right.range.start.offset - left.range.start.offset);
  let text = document.text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    if (edit.range.end.offset > previousStart) throw new RangeError("Language text edits overlap.");
    text = text.slice(0, edit.range.start.offset) + edit.newText + text.slice(edit.range.end.offset);
    previousStart = edit.range.start.offset;
  }
  return text;
}

function command(label: string, detail: string): LanguageCompletionItem {
  return Object.freeze({ label, kind: "command", detail, insertText: label });
}
function keyword(label: string, detail: string): LanguageCompletionItem {
  return Object.freeze({ label, kind: "keyword", detail, insertText: label });
}
function modifier(label: string, detail: string): LanguageCompletionItem {
  return Object.freeze({ label, kind: "modifier", detail, insertText: label });
}
function value(label: string, detail: string): LanguageCompletionItem {
  return Object.freeze({ label, kind: "value", detail, insertText: label });
}

function dedupe(items: readonly LanguageCompletionItem[]): readonly LanguageCompletionItem[] {
  const seen = new Set<string>();
  return Object.freeze(items.filter((item) => {
    if (seen.has(item.label)) return false;
    seen.add(item.label);
    return true;
  }));
}

function tokensAfterLastNewline(tokens: readonly Token[]): readonly Token[] {
  let index = tokens.length;
  while (index > 0 && tokens[index - 1]?.kind !== TokenKind.Newline) index -= 1;
  return tokens.slice(index);
}

function isStatementBoundary(token: Token | undefined): boolean {
  return token?.kind === TokenKind.RightBrace;
}

function isExpressionCompletionContext(last: Token | undefined, lineTokens: readonly Token[]): boolean {
  if (lineTokens.length === 0) return false;
  if (last === undefined) return false;
  return last.kind === TokenKind.Equal ||
    last.kind === TokenKind.KeywordReturn ||
    last.kind === TokenKind.LeftParenthesis ||
    last.kind === TokenKind.LeftBracket ||
    last.kind === TokenKind.Colon ||
    last.kind === TokenKind.Comma;
}

type CompactCommand = "showButton" | "askText" | "askNumber" | "choose" | "say";
type CompactStage = "afterCommand" | "afterAs" | "afterComma" | "other";

function compactCommandContext(tokens: readonly Token[]): { command: CompactCommand; stage: CompactStage } | null {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    const command = tokenToCompactCommand(token);
    if (command === null) continue;
    const tail = tokens.slice(index + 1);
    if (tail.length === 0) return { command, stage: "afterCommand" };
    if (tail.at(-1)?.kind === TokenKind.KeywordAs) return { command, stage: "afterAs" };
    if (command === "say" && tail.at(-1)?.kind === TokenKind.Comma) return { command, stage: "afterComma" };
    return { command, stage: "other" };
  }
  return null;
}

function tokenToCompactCommand(token: Token): CompactCommand | null {
  if (token.kind === TokenKind.KeywordSay) return "say";
  if (token.kind !== TokenKind.Identifier) return null;
  if (token.lexeme === "showButton" || token.lexeme === "askText" || token.lexeme === "askNumber" || token.lexeme === "choose") {
    return token.lexeme;
  }
  return null;
}

function declaredSpeakers(source: string): readonly string[] {
  const speakers = compileSource(source).program.statements.flatMap((statement) =>
    statement.kind === "speakerDeclaration" ? [statement.name.name] : []);
  return Object.freeze([...new Set(speakers)]);
}

function locateCompactCommand(
  document: LanguageDocument,
  offset: number,
): { command: CompactCommand; range: LanguageRange } | null {
  const compilation = compileSource(document.text);
  let best: { command: CompactCommand; range: LanguageRange } | null = null;
  visitProgram(compilation.program, {
    showButton(node) {
      if (containsOffset(node.span, offset)) best = { command: "showButton", range: node.commandSpan };
    },
    interaction(node) {
      if (!containsOffset(node.span, offset)) return;
      const command = node.interactionKind === "text" ? "askText" : node.interactionKind === "number" ? "askNumber" : "choose";
      best = { command, range: node.commandSpan };
    },
    say(node) {
      if (!containsOffset(node.span, offset)) return;
      const start = node.span.start;
      best = { command: "say", range: createSourceSpan(start, createSourcePosition(start.offset + 3, start.line, start.column + 3)) };
    },
  });
  if (best !== null) return best;

  const tokens = lex(document.text).tokens;
  for (const token of tokens) {
    const command = tokenToCompactCommand(token);
    if (command !== null && offset >= token.span.start.offset && offset <= token.span.end.offset) {
      return { command, range: token.span };
    }
  }
  const before = tokens.filter((token) => token.span.start.offset <= offset && token.kind !== TokenKind.Newline && token.kind !== TokenKind.EndOfFile);
  const contextual = compactCommandContext(tokensAfterLastNewline(before));
  if (contextual === null) return null;
  const token = [...before].reverse().find((candidate) => tokenToCompactCommand(candidate) === contextual.command);
  return token === undefined ? null : { command: contextual.command, range: token.span };
}

function containsOffset(span: SourceSpan, offset: number): boolean {
  return offset >= span.start.offset && offset <= span.end.offset;
}

function signatureParameters(command: CompactCommand): readonly string[] {
  switch (command) {
    case "showButton": return Object.freeze(["speaker", "label"]);
    case "askText":
    case "askNumber": return Object.freeze(["speaker", "hint"]);
    case "choose": return Object.freeze(["speaker", "options"]);
    case "say": return Object.freeze(["speaker", "skip policy", "text", "pacing"]);
  }
}

function activeParameterFor(source: string, command: CompactCommand, start: number, offset: number): number {
  const text = source.slice(start, Math.max(start, offset));
  if (command === "say") return text.includes(",") ? 3 : text.includes("skippable") || text.includes("unskippable") ? 2 : text.includes(" as ") ? 2 : 2;
  if (command === "choose") return text.includes(" as ") && !text.includes(",") ? 1 : 1;
  return text.includes(" as ") ? 1 : 1;
}

interface Visitor {
  readonly showButton: (node: ShowButtonStatement) => void;
  readonly interaction: (node: InteractionExpression) => void;
  readonly say: (node: SayStatement) => void;
}

function visitProgram(program: Program, visitor: Visitor): void {
  for (const statement of program.statements) visitStatement(statement, visitor);
}

function visitStatement(statement: Statement, visitor: Visitor): void {
  switch (statement.kind) {
    case "showButtonStatement": visitor.showButton(statement); visitExpression(statement.label, visitor); return;
    case "sayStatement": visitor.say(statement); visitExpression(statement.value, visitor); if (statement.pacing !== null && statement.pacing !== "instant") visitExpression(statement.pacing, visitor); return;
    case "letStatement": visitExpression(statement.initializer, visitor); return;
    case "assignmentStatement": visitExpression(statement.target, visitor); visitExpression(statement.value, visitor); return;
    case "expressionStatement": visitExpression(statement.expression, visitor); return;
    case "speakerDeclaration": for (const property of statement.properties) visitExpression(property.value, visitor); return;
    case "ifStatement": visitExpression(statement.condition, visitor); for (const child of statement.thenBlock.statements) visitStatement(child, visitor); if (statement.elseBlock?.kind === "block") for (const child of statement.elseBlock.statements) visitStatement(child, visitor); else if (statement.elseBlock !== null) visitStatement(statement.elseBlock, visitor); return;
    case "repeatStatement": visitExpression(statement.count, visitor); for (const child of statement.body.statements) visitStatement(child, visitor); return;
    case "forStatement": visitExpression(statement.iterable, visitor); for (const child of statement.body.statements) visitStatement(child, visitor); return;
    case "whileStatement": visitExpression(statement.condition, visitor); for (const child of statement.body.statements) visitStatement(child, visitor); return;
    case "functionDeclaration": for (const parameter of statement.parameters) if (parameter.defaultValue !== null) visitExpression(parameter.defaultValue, visitor); for (const child of statement.body.statements) visitStatement(child, visitor); return;
    case "returnStatement": if (statement.value !== null) visitExpression(statement.value, visitor); return;
    case "speakerSetterStatement":
    case "waitStatement":
    case "exitStatement":
    case "breakStatement":
    case "continueStatement": return;
  }
}

function visitExpression(expression: Expression, visitor: Visitor): void {
  switch (expression.kind) {
    case "interactionExpression": visitor.interaction(expression); if (expression.hint !== null) visitExpression(expression.hint, visitor); for (const option of expression.options) visitExpression(option.value, visitor); return;
    case "parenthesizedExpression": visitExpression(expression.expression, visitor); return;
    case "listLiteral": for (const item of expression.elements) visitExpression(item, visitor); return;
    case "setLiteral": for (const item of expression.elements) visitExpression(item, visitor); return;
    case "objectLiteral": for (const property of expression.properties) visitExpression(property.value, visitor); return;
    case "propertyAccessExpression": visitExpression(expression.object, visitor); return;
    case "indexExpression": visitExpression(expression.object, visitor); visitExpression(expression.index, visitor); return;
    case "callExpression": visitExpression(expression.callee, visitor); for (const argument of expression.arguments) visitExpression(argument.value, visitor); return;
    case "unaryExpression": visitExpression(expression.operand, visitor); return;
    case "binaryExpression": visitExpression(expression.left, visitor); visitExpression(expression.right, visitor); return;
    case "rangeExpression": visitExpression(expression.start, visitor); visitExpression(expression.end, visitor); return;
    case "templateLiteral": for (const part of expression.parts) if (part.kind === "templateInterpolation") visitExpression(part.expression, visitor); return;
    case "identifier":
    case "booleanLiteral":
    case "nullLiteral":
    case "numberLiteral":
    case "stringLiteral": return;
  }
}

interface OffsetEdit { readonly start: number; readonly end: number; readonly newText: string; }

function whitespaceEdit(source: string, start: number, end: number, desired: string, edits: OffsetEdit[]): void {
  if (end < start) return;
  const current = source.slice(start, end);
  if (!/^\s*$/u.test(current) || current === desired) return;
  edits.push({ start, end, newText: desired });
}

function formatShowButton(source: string, node: ShowButtonStatement, edits: OffsetEdit[]): void {
  let cursor = node.commandSpan.end.offset;
  if (node.asSpan !== null && node.speaker !== null) {
    whitespaceEdit(source, cursor, node.asSpan.start.offset, " ", edits);
    whitespaceEdit(source, node.asSpan.end.offset, node.speaker.span.start.offset, " ", edits);
    cursor = node.speaker.span.end.offset;
  }
  whitespaceEdit(source, cursor, node.label.span.start.offset, " ", edits);
}

function formatInteraction(source: string, node: InteractionExpression, edits: OffsetEdit[]): void {
  let cursor = node.commandSpan.end.offset;
  if (node.asSpan !== null && node.speaker !== null) {
    whitespaceEdit(source, cursor, node.asSpan.start.offset, " ", edits);
    whitespaceEdit(source, node.asSpan.end.offset, node.speaker.span.start.offset, " ", edits);
    cursor = node.speaker.span.end.offset;
  }
  if (node.interactionKind !== "choice") {
    if (node.hint !== null) whitespaceEdit(source, cursor, node.hint.span.start.offset, " ", edits);
    return;
  }
  const first = node.options[0];
  if (first !== undefined) whitespaceEdit(source, cursor, first.span.start.offset, " ", edits);
  for (const option of node.options) {
    if (option.label !== null && option.colonSpan !== null) {
      whitespaceEdit(source, option.label.span.end.offset, option.colonSpan.start.offset, "", edits);
      whitespaceEdit(source, option.colonSpan.end.offset, option.value.span.start.offset, " ", edits);
    }
    if (option.separatorSpan !== null) {
      whitespaceEdit(source, option.value.span.end.offset, option.separatorSpan.start.offset, "", edits);
      const next = node.options[node.options.indexOf(option) + 1];
      if (next !== undefined) whitespaceEdit(source, option.separatorSpan.end.offset, next.span.start.offset, " ", edits);
    }
  }
}

function formatSay(source: string, node: SayStatement, edits: OffsetEdit[]): void {
  const tokens = lex(source.slice(node.span.start.offset, node.span.end.offset)).tokens.filter((token) => token.kind !== TokenKind.EndOfFile && token.kind !== TokenKind.Newline);
  const absolute = (token: Token) => ({ start: token.span.start.offset + node.span.start.offset, end: token.span.end.offset + node.span.start.offset });
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const left = tokens[index]!;
    const right = tokens[index + 1]!;
    const l = absolute(left); const r = absolute(right);
    if (left.kind === TokenKind.Comma) whitespaceEdit(source, l.end, r.start, " ", edits);
    else if (right.kind === TokenKind.Comma) whitespaceEdit(source, l.end, r.start, "", edits);
    else if (left.kind === TokenKind.KeywordSay || left.kind === TokenKind.KeywordAs || tokenIsSayModifier(left)) whitespaceEdit(source, l.end, r.start, " ", edits);
  }
}

function tokenIsSayModifier(token: Token): boolean {
  return token.kind === TokenKind.Identifier && (token.lexeme === "skippable" || token.lexeme === "unskippable");
}

function normalizeOffsetEdits(edits: readonly OffsetEdit[]): readonly OffsetEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: OffsetEdit[] = [];
  for (const edit of sorted) {
    const previous = result.at(-1);
    if (previous !== undefined && edit.start < previous.end) continue;
    if (previous !== undefined && edit.start === previous.start && edit.end === previous.end) continue;
    result.push(edit);
  }
  return Object.freeze(result);
}
