import type {
  AssignmentStatement,
  AssignmentTarget,
  BinaryExpression,
  Block,
  CallArgument,
  CallExpression,
  BreakStatement,
  ContinueStatement,
  Expression,
  ExpressionStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionParameter,
  Identifier,
  IfStatement,
  LetStatement,
  NamedArgument,
  ObjectLiteral,
  ObjectProperty,
  ParenthesizedExpression,
  PositionalArgument,
  Program,
  PropertyAccessExpression,
  ScalarTypeName,
  SayStatement,
  RepeatStatement,
  ReturnStatement,
  SetLiteral,
  SpeakerDeclaration,
  SpeakerProperty,
  SpeakerSetterStatement,
  Statement,
  TemplateInterpolation,
  TemplateLiteral,
  TemplatePart,
  TemplateText,
  TypeAnnotation,
  UnaryExpression,
  WhileStatement,
} from "./ast.js";
import {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
import { lex } from "./lexer.js";
import {
  createSourcePosition,
  createSourceSpan,
  type SourceSpan,
} from "./source.js";
import { TokenKind, type Token } from "./token.js";

export interface ParseResult {
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
}

const parserDiagnosticCode = {
  expectedStatement: "TSP001",
  expectedStatementEnd: "TSP002",
  expectedSpeakerIdentifier: "TSP003",
  expectedPropertyName: "TSP004",
  expectedColon: "TSP005",
  expectedString: "TSP006",
  expectedRightBrace: "TSP007",
  expectedTemplateExpression: "TSP008",
  unsupportedTemplateExpression: "TSP009",
  expectedPropertyAfterDot: "TSP010",
  expectedPropertyEnd: "TSP011",
  expectedExpression: "TSP012",
  expectedIdentifier: "TSP013",
  expectedEqual: "TSP014",
  invalidAssignmentTarget: "TSP015",
  invalidExpressionStatement: "TSP016",
  expectedDelimiter: "TSP017",
  expectedBlock: "TSP018",
  mixedArguments: "TSP019",
  chainedComparison: "TSP020",
  invalidType: "TSP021",
  chainedRange: "TSP022",
  expectedIn: "TSP023",
  expectedFunctionName: "TSP024",
  expectedParameter: "TSP025",
  emptyFunctionParameters: "TSP026",
} as const;

/** Parses the accepted core-language milestone. */
export function parse(source: string): ParseResult {
  const lexResult = lex(source);
  const parser = new Parser(lexResult.tokens);
  const program = parser.parseProgram();

  return Object.freeze({
    program,
    diagnostics: Object.freeze([
      ...lexResult.diagnostics,
      ...parser.diagnostics,
    ]),
  });
}

class Parser {
  readonly #diagnostics: Diagnostic[] = [];
  #current = 0;
  #recoveredAtStatementBoundary = false;

  public constructor(private readonly tokens: readonly Token[]) {}

  public get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  public parseProgram(): Program {
    const statements: Statement[] = [];
    this.#skipNewlines();
    while (!this.#check(TokenKind.EndOfFile)) {
      const startIndex = this.#current;
      const statement = this.#parseStatement();
      if (statement !== null) statements.push(statement);
      if (this.#current === startIndex) this.#advance();

      if (this.#recoveredAtStatementBoundary) {
        this.#recoveredAtStatementBoundary = false;
      } else {
        this.#finishStatement(false);
      }
      this.#skipNewlines();
    }

    return Object.freeze({
      kind: "program",
      statements: Object.freeze(statements),
      span: createSourceSpan(
        createSourcePosition(0, 0, 0),
        this.#peek().span.end,
      ),
    });
  }

  #parseStatement(): Statement | null {
    switch (this.#peek().kind) {
      case TokenKind.KeywordSpeaker:
        return this.#parseSpeakerStatement();
      case TokenKind.KeywordSay:
        return this.#parseSayStatement();
      case TokenKind.KeywordExit:
        return this.#parseExitStatement();
      case TokenKind.KeywordLet:
        return this.#parseLetStatement();
      case TokenKind.KeywordIf:
        return this.#parseIfStatement();
      case TokenKind.KeywordRepeat:
        return this.#parseRepeatStatement();
      case TokenKind.KeywordFor:
        return this.#parseForStatement();
      case TokenKind.KeywordWhile:
        return this.#parseWhileStatement();
      case TokenKind.KeywordBreak:
        return this.#parseLoopControl("breakStatement");
      case TokenKind.KeywordContinue:
        return this.#parseLoopControl("continueStatement");
      case TokenKind.KeywordFunction:
        return this.#parseFunctionDeclaration();
      case TokenKind.KeywordReturn:
        return this.#parseReturnStatement();
      default:
        if (isExpressionStart(this.#peek())) {
          return this.#parseAssignmentOrExpressionStatement();
        }
        this.#reportToken(
          parserDiagnosticCode.expectedStatement,
          "Expected a supported TeaseScript statement.",
          this.#peek(),
        );
        this.#synchronizeStatement();
        return null;
    }
  }

  #parseSpeakerStatement():
    | SpeakerDeclaration
    | SpeakerSetterStatement
    | null {
    const keyword = this.#advance();
    if (!this.#check(TokenKind.Identifier)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedSpeakerIdentifier,
        "Expected a speaker identifier after 'speaker'.",
      );
      if (this.#check(TokenKind.LeftBrace)) this.#skipMalformedBlock();
      else this.#synchronizeStatement();
      return null;
    }

    const name = this.#identifier(this.#advance());
    if (this.#match(TokenKind.LeftBrace)) {
      return this.#parseSpeakerDeclaration(keyword, name);
    }
    return Object.freeze({
      kind: "speakerSetterStatement",
      speaker: name,
      span: spanFrom(keyword.span, name.span),
    });
  }

  #parseSpeakerDeclaration(
    keyword: Token,
    name: Identifier,
  ): SpeakerDeclaration {
    const leftBrace = this.#previous();
    const properties: SpeakerProperty[] = [];
    let lastSpan = leftBrace.span;

    while (!this.#check(TokenKind.EndOfFile)) {
      this.#skipNewlines();
      if (this.#match(TokenKind.RightBrace)) {
        return this.#speakerDeclaration(
          keyword,
          name,
          properties,
          this.#previous().span,
        );
      }
      if (this.#isRecoveredTopLevelStatement()) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedRightBrace,
          "Expected '}' to close the speaker declaration.",
        );
        this.#recoveredAtStatementBoundary = true;
        return this.#speakerDeclaration(keyword, name, properties, lastSpan);
      }

      const property = this.#parseSpeakerProperty();
      if (property !== null) {
        properties.push(property);
        lastSpan = property.span;
      }
      if (
        !this.#check(TokenKind.Newline) &&
        !this.#check(TokenKind.RightBrace) &&
        !this.#check(TokenKind.EndOfFile)
      ) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyEnd,
          "Expected a newline or '}' after the speaker property.",
        );
        this.#synchronizeProperty();
      }
    }

    this.#reportInsertion(
      parserDiagnosticCode.expectedRightBrace,
      "Expected '}' to close the speaker declaration.",
    );
    return this.#speakerDeclaration(keyword, name, properties, lastSpan);
  }

  #parseSpeakerProperty(): SpeakerProperty | null {
    if (!isPropertyName(this.#peek())) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedPropertyName,
        "Expected a speaker property name.",
      );
      this.#synchronizeProperty();
      return null;
    }
    const name = this.#identifier(this.#advance());
    if (!this.#match(TokenKind.Colon)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedColon,
        "Expected ':' after the speaker property name.",
      );
      this.#synchronizeProperty();
      return null;
    }
    const value = this.#parseExpression();
    if (value === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedString,
        "Expected a string or template for the speaker property.",
      );
      this.#synchronizeProperty();
      return null;
    }
    return Object.freeze({
      kind: "speakerProperty",
      name,
      value,
      span: spanFrom(name.span, value.span),
    });
  }

  #parseSayStatement(): SayStatement | null {
    const keyword = this.#advance();
    let speaker: Identifier | null = null;
    if (this.#match(TokenKind.KeywordAs)) {
      if (!this.#check(TokenKind.Identifier)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedSpeakerIdentifier,
          "Expected a speaker identifier after 'as'.",
        );
        this.#synchronizeStatement();
        return null;
      }
      speaker = this.#identifier(this.#advance());
    }

    const valueStart = this.#peek().kind;
    const value = this.#parseExpression();
    if (value === null) {
      if (valueStart === TokenKind.TemplateStart) {
        this.#synchronizeStatement();
        return null;
      }
      this.#reportInsertion(
        parserDiagnosticCode.expectedString,
        "Expected a string or template after 'say'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    return Object.freeze({
      kind: "sayStatement",
      speaker,
      value,
      span: spanFrom(keyword.span, value.span),
    });
  }

  #parseExitStatement(): Statement {
    const keyword = this.#advance();
    return Object.freeze({
      kind: "exitStatement",
      span: copySpan(keyword.span),
    });
  }

  #parseLetStatement(): LetStatement | null {
    const keyword = this.#advance();
    if (!this.#check(TokenKind.Identifier)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIdentifier,
        "Expected a variable identifier after 'let'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const name = this.#identifier(this.#advance());
    let typeAnnotation: TypeAnnotation | null = null;
    if (this.#match(TokenKind.Colon)) {
      typeAnnotation = this.#parseTypeAnnotation();
      if (typeAnnotation === null) {
        this.#synchronizeStatement();
        return null;
      }
    }
    if (!this.#match(TokenKind.Equal)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedEqual,
        "Expected '=' in the variable declaration.",
      );
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const initializer = this.#parseRequiredExpression();
    if (initializer === null) {
      this.#synchronizeStatement();
      return null;
    }
    return Object.freeze({
      kind: "letStatement",
      name,
      typeAnnotation,
      initializer,
      span: spanFrom(keyword.span, initializer.span),
    });
  }

  #parseTypeAnnotation(): TypeAnnotation | null {
    const token = this.#peek();
    if (token.kind !== TokenKind.Identifier || !isScalarType(token.lexeme)) {
      this.#reportToken(
        parserDiagnosticCode.invalidType,
        "Expected an accepted scalar type name.",
        token,
      );
      return null;
    }
    this.#advance();
    let collection: "list" | "set" | null = null;
    let end = token.span;
    if (this.#match(TokenKind.LeftBracket)) {
      if (!this.#match(TokenKind.RightBracket)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ']' in the list type annotation.",
        );
        return null;
      }
      collection = "list";
      end = this.#previous().span;
    } else if (this.#match(TokenKind.KeywordSet)) {
      collection = "set";
      end = this.#previous().span;
    }
    let optional = false;
    if (this.#match(TokenKind.Question)) {
      optional = true;
      end = this.#previous().span;
    }
    return Object.freeze({
      kind: "typeAnnotation",
      name: token.lexeme as ScalarTypeName,
      collection,
      optional,
      span: spanFrom(token.span, end),
    });
  }

  #parseIfStatement(): IfStatement | null {
    const keyword = this.#advance();
    const condition = this.#parseRequiredExpression();
    if (condition === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const thenBlock = this.#parseBlock();
    if (thenBlock === null) return null;

    const beforePotentialElse = this.#current;
    this.#skipNewlines();
    let elseBlock: Block | IfStatement | null = null;
    if (this.#match(TokenKind.KeywordElse)) {
      this.#skipContinuationNewlines();
      elseBlock = this.#check(TokenKind.KeywordIf)
        ? this.#parseIfStatement()
        : this.#parseBlock();
      if (elseBlock === null) return null;
    } else {
      this.#current = beforePotentialElse;
    }
    return Object.freeze({
      kind: "ifStatement",
      condition,
      thenBlock,
      elseBlock,
      span: spanFrom(keyword.span, (elseBlock ?? thenBlock).span),
    });
  }

  #parseRepeatStatement(): RepeatStatement | null {
    const keyword = this.#advance();
    const count = this.#parseRequiredExpression();
    if (count === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = this.#parseBlock();
    if (body === null) return null;
    return Object.freeze({
      kind: "repeatStatement",
      count,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  #parseForStatement(): ForStatement | null {
    const keyword = this.#advance();
    if (!this.#check(TokenKind.Identifier)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIdentifier,
        "Expected a loop-variable identifier after 'for'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const variable = this.#identifier(this.#advance());
    if (!this.#match(TokenKind.KeywordIn)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedIn,
        "Expected 'in' after the loop variable.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const iterable = this.#parseRequiredExpression();
    if (iterable === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = this.#parseBlock();
    if (body === null) return null;
    return Object.freeze({
      kind: "forStatement",
      variable,
      iterable,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  #parseWhileStatement(): WhileStatement | null {
    const keyword = this.#advance();
    const condition = this.#parseRequiredExpression();
    if (condition === null) {
      this.#synchronizeStatement();
      return null;
    }
    this.#skipContinuationNewlines();
    const body = this.#parseBlock();
    if (body === null) return null;
    return Object.freeze({
      kind: "whileStatement",
      condition,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  #parseLoopControl(
    kind: "breakStatement" | "continueStatement",
  ): BreakStatement | ContinueStatement {
    const keyword = this.#advance();
    return Object.freeze({ kind, span: copySpan(keyword.span) });
  }

  #parseFunctionDeclaration(): FunctionDeclaration | null {
    const keyword = this.#advance();
    if (!this.#check(TokenKind.Identifier)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedFunctionName,
        "Expected a function identifier after 'function'.",
      );
      this.#synchronizeStatement();
      return null;
    }
    const name = this.#identifier(this.#advance());
    const parameters: FunctionParameter[] = [];
    if (this.#match(TokenKind.LeftParenthesis)) {
      this.#skipNewlines();
      if (this.#check(TokenKind.RightParenthesis)) {
        this.#reportToken(
          parserDiagnosticCode.emptyFunctionParameters,
          "Parentheses are omitted when a function has no parameters.",
          this.#peek(),
        );
      }
      while (
        !this.#check(TokenKind.RightParenthesis) &&
        !this.#check(TokenKind.EndOfFile)
      ) {
        const parameter = this.#parseFunctionParameter();
        if (parameter !== null) parameters.push(parameter);
        this.#skipNewlines();
        if (!this.#match(TokenKind.Comma)) break;
        this.#skipNewlines();
        if (this.#check(TokenKind.RightParenthesis)) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedParameter,
            "Expected a function parameter after ','.",
          );
          break;
        }
      }
      if (!this.#match(TokenKind.RightParenthesis)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ')' after the function parameters.",
        );
        this.#synchronizeStatement();
        return null;
      }
    }

    let returnTypeAnnotation: TypeAnnotation | null = null;
    if (this.#match(TokenKind.Colon)) {
      returnTypeAnnotation = this.#parseTypeAnnotation();
      if (returnTypeAnnotation === null) {
        this.#synchronizeStatement();
        return null;
      }
    }
    this.#skipContinuationNewlines();
    const body = this.#parseBlock();
    if (body === null) return null;
    return Object.freeze({
      kind: "functionDeclaration",
      name,
      parameters: Object.freeze(parameters),
      returnTypeAnnotation,
      body,
      span: spanFrom(keyword.span, body.span),
    });
  }

  #parseFunctionParameter(): FunctionParameter | null {
    if (!this.#check(TokenKind.Identifier)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedParameter,
        "Expected a function parameter identifier.",
      );
      this.#synchronizeParameter();
      return null;
    }
    const name = this.#identifier(this.#advance());
    let typeAnnotation: TypeAnnotation | null = null;
    let end = name.span;
    if (this.#match(TokenKind.Colon)) {
      typeAnnotation = this.#parseTypeAnnotation();
      if (typeAnnotation === null) {
        this.#synchronizeParameter();
        return null;
      }
      end = typeAnnotation.span;
    }
    let defaultValue: Expression | null = null;
    if (this.#match(TokenKind.Equal)) {
      this.#skipContinuationNewlines();
      defaultValue = this.#parseRequiredExpression();
      if (defaultValue === null) {
        this.#synchronizeParameter();
        return null;
      }
      end = defaultValue.span;
    }
    return Object.freeze({
      kind: "functionParameter",
      name,
      typeAnnotation,
      defaultValue,
      span: spanFrom(name.span, end),
    });
  }

  #parseReturnStatement(): ReturnStatement | null {
    const keyword = this.#advance();
    if (
      this.#check(TokenKind.Newline) ||
      this.#check(TokenKind.RightBrace) ||
      this.#check(TokenKind.EndOfFile)
    ) {
      return Object.freeze({
        kind: "returnStatement",
        value: null,
        span: copySpan(keyword.span),
      });
    }
    const value = this.#parseRequiredExpression();
    if (value === null) {
      this.#synchronizeStatement();
      return null;
    }
    return Object.freeze({
      kind: "returnStatement",
      value,
      span: spanFrom(keyword.span, value.span),
    });
  }

  #parseBlock(): Block | null {
    if (!this.#match(TokenKind.LeftBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedBlock,
        "Expected '{' to start the block.",
      );
      return null;
    }
    const leftBrace = this.#previous();
    const statements: Statement[] = [];
    this.#skipNewlines();
    while (
      !this.#check(TokenKind.RightBrace) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      const startIndex = this.#current;
      const statement = this.#parseStatement();
      if (statement !== null) statements.push(statement);
      if (this.#current === startIndex) this.#advance();
      this.#finishStatement(true);
      this.#skipNewlines();
    }
    if (!this.#match(TokenKind.RightBrace)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedRightBrace,
        "Expected '}' to close the block.",
      );
      return null;
    }
    return Object.freeze({
      kind: "block",
      statements: Object.freeze(statements),
      span: spanFrom(leftBrace.span, this.#previous().span),
    });
  }

  #parseAssignmentOrExpressionStatement():
    | AssignmentStatement
    | ExpressionStatement
    | null {
    const expression = this.#parseExpression();
    if (expression === null) {
      this.#synchronizeStatement();
      return null;
    }
    if (this.#match(TokenKind.Equal)) {
      this.#skipContinuationNewlines();
      const value = this.#parseRequiredExpression();
      if (value === null) {
        this.#synchronizeStatement();
        return null;
      }
      if (!isAssignmentTarget(expression)) {
        this.#reportSpan(
          parserDiagnosticCode.invalidAssignmentTarget,
          "The left side of an assignment must be a variable, property, or index.",
          expression.span,
        );
        return null;
      }
      return Object.freeze({
        kind: "assignmentStatement",
        target: expression,
        value,
        span: spanFrom(expression.span, value.span),
      });
    }
    if (expression.kind !== "callExpression") {
      if (expression.kind === "identifier") {
        this.#reportSpan(
          parserDiagnosticCode.expectedStatement,
          "Expected a supported TeaseScript statement.",
          expression.span,
        );
        this.#synchronizeStatement();
        return null;
      }
      this.#reportSpan(
        parserDiagnosticCode.invalidExpressionStatement,
        "Only function or method calls may be used as expression statements.",
        expression.span,
      );
      return null;
    }
    return Object.freeze({
      kind: "expressionStatement",
      expression,
      span: copySpan(expression.span),
    });
  }

  #parseRequiredExpression(): Expression | null {
    const expression = this.#parseExpression();
    if (expression === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected an expression.",
      );
    }
    return expression;
  }

  #parseExpression(): Expression | null {
    return this.#parseOr();
  }

  #parseOr(): Expression | null {
    let expression = this.#parseAnd();
    while (expression !== null && this.#match(TokenKind.KeywordOr)) {
      const operator = this.#previous();
      this.#skipContinuationNewlines();
      const right = this.#parseAnd();
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after 'or'.",
        );
        return null;
      }
      expression = this.#binary(expression, operator, right, "or");
    }
    return expression;
  }

  #parseAnd(): Expression | null {
    let expression = this.#parseNot();
    while (expression !== null && this.#match(TokenKind.KeywordAnd)) {
      const operator = this.#previous();
      this.#skipContinuationNewlines();
      const right = this.#parseNot();
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after 'and'.",
        );
        return null;
      }
      expression = this.#binary(expression, operator, right, "and");
    }
    return expression;
  }

  #parseNot(): Expression | null {
    if (this.#match(TokenKind.KeywordNot)) {
      const operator = this.#previous();
      this.#skipContinuationNewlines();
      const operand = this.#parseNot();
      if (operand === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after 'not'.",
        );
        return null;
      }
      return this.#unary(operator, operand, "not");
    }
    return this.#parseComparison();
  }

  #parseComparison(): Expression | null {
    const left = this.#parseRange();
    if (left === null || !isComparisonKind(this.#peek().kind)) return left;
    const operator = this.#advance();
    this.#skipContinuationNewlines();
    const right = this.#parseRange();
    if (right === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected an expression after the comparison operator.",
      );
      return null;
    }
    const expression = this.#binary(
      left,
      operator,
      right,
      binaryOperator(operator),
    );
    if (isComparisonKind(this.#peek().kind)) {
      this.#reportToken(
        parserDiagnosticCode.chainedComparison,
        "Comparisons may not be chained.",
        this.#peek(),
      );
      while (isComparisonKind(this.#peek().kind)) {
        this.#advance();
        this.#skipContinuationNewlines();
        this.#parseRange();
      }
    }
    return expression;
  }

  #parseRange(): Expression | null {
    const left = this.#parseAdditive();
    if (
      left === null ||
      (!this.#check(TokenKind.RangeExclusive) &&
        !this.#check(TokenKind.RangeInclusive))
    ) {
      return left;
    }
    const operator = this.#advance();
    this.#skipContinuationNewlines();
    const right = this.#parseAdditive();
    if (right === null) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedExpression,
        "Expected an expression after the range operator.",
      );
      return null;
    }
    const expression: Expression = Object.freeze({
      kind: "rangeExpression",
      start: left,
      end: right,
      inclusive: operator.kind === TokenKind.RangeInclusive,
      span: spanFrom(left.span, right.span),
    });
    if (
      this.#check(TokenKind.RangeExclusive) ||
      this.#check(TokenKind.RangeInclusive)
    ) {
      this.#reportToken(
        parserDiagnosticCode.chainedRange,
        "Ranges may not be chained.",
        this.#peek(),
      );
      while (
        this.#check(TokenKind.RangeExclusive) ||
        this.#check(TokenKind.RangeInclusive)
      ) {
        this.#advance();
        this.#skipContinuationNewlines();
        this.#parseAdditive();
      }
    }
    return expression;
  }

  #parseAdditive(): Expression | null {
    let expression = this.#parseMultiplicative();
    while (
      expression !== null &&
      (this.#check(TokenKind.Plus) || this.#check(TokenKind.Minus))
    ) {
      const operator = this.#advance();
      this.#skipContinuationNewlines();
      const right = this.#parseMultiplicative();
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after the arithmetic operator.",
        );
        return null;
      }
      expression = this.#binary(
        expression,
        operator,
        right,
        binaryOperator(operator),
      );
    }
    return expression;
  }

  #parseMultiplicative(): Expression | null {
    let expression = this.#parseUnaryArithmetic();
    while (
      expression !== null &&
      (this.#check(TokenKind.Star) ||
        this.#check(TokenKind.Slash) ||
        this.#check(TokenKind.Percent))
    ) {
      const operator = this.#advance();
      this.#skipContinuationNewlines();
      const right = this.#parseUnaryArithmetic();
      if (right === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after the arithmetic operator.",
        );
        return null;
      }
      expression = this.#binary(
        expression,
        operator,
        right,
        binaryOperator(operator),
      );
    }
    return expression;
  }

  #parseUnaryArithmetic(): Expression | null {
    if (this.#check(TokenKind.Plus) || this.#check(TokenKind.Minus)) {
      const operator = this.#advance();
      this.#skipContinuationNewlines();
      const operand = this.#parseUnaryArithmetic();
      if (operand === null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an expression after the unary operator.",
        );
        return null;
      }
      return this.#unary(operator, operand, operator.lexeme as "+" | "-");
    }
    return this.#parsePostfix();
  }

  #parsePostfix(): Expression | null {
    let expression = this.#parsePrimary();
    while (expression !== null) {
      if (this.#match(TokenKind.Dot)) {
        if (!isPropertyName(this.#peek())) {
          this.#reportInsertion(
            parserDiagnosticCode.expectedPropertyAfterDot,
            "Expected a property name after '.'.",
          );
          return expression;
        }
        const property = this.#identifier(this.#advance());
        expression = Object.freeze({
          kind: "propertyAccessExpression",
          object: expression,
          property,
          span: spanFrom(expression.span, property.span),
        } satisfies PropertyAccessExpression);
        continue;
      }
      if (this.#match(TokenKind.LeftBracket)) {
        const start = expression;
        this.#skipNewlines();
        const index = this.#parseRequiredExpression();
        this.#skipNewlines();
        if (index === null || !this.#match(TokenKind.RightBracket)) {
          if (index !== null) {
            this.#reportInsertion(
              parserDiagnosticCode.expectedDelimiter,
              "Expected ']' after the index expression.",
            );
          }
          return expression;
        }
        expression = Object.freeze({
          kind: "indexExpression",
          object: start,
          index,
          span: spanFrom(start.span, this.#previous().span),
        });
        continue;
      }
      if (this.#match(TokenKind.LeftParenthesis)) {
        expression = this.#finishCall(expression, this.#previous());
        continue;
      }
      break;
    }
    return expression;
  }

  #finishCall(callee: Expression, left: Token): CallExpression {
    const argumentsList: CallArgument[] = [];
    let style: "none" | "positional" | "named" = "none";
    this.#skipNewlines();
    while (
      !this.#check(TokenKind.RightParenthesis) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      let argument: CallArgument | null = null;
      if (isPropertyName(this.#peek()) && this.#peek(1).kind === TokenKind.Colon) {
        const name = this.#identifier(this.#advance());
        this.#advance();
        this.#skipContinuationNewlines();
        const value = this.#parseRequiredExpression();
        if (value !== null) {
          argument = Object.freeze({
            kind: "namedArgument",
            name,
            value,
            span: spanFrom(name.span, value.span),
          } satisfies NamedArgument);
        }
        if (style === "positional") this.#reportMixedArguments(name.span);
        style = "named";
      } else {
        const value = this.#parseRequiredExpression();
        if (value !== null) {
          argument = Object.freeze({
            kind: "positionalArgument",
            value,
            span: copySpan(value.span),
          } satisfies PositionalArgument);
        }
        if (style === "named" && value !== null) {
          this.#reportMixedArguments(value.span);
        }
        style = "positional";
      }
      if (argument !== null) argumentsList.push(argument);
      this.#skipNewlines();
      if (!this.#match(TokenKind.Comma)) break;
      this.#skipNewlines();
      if (this.#check(TokenKind.RightParenthesis)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected an argument after ','.",
        );
        break;
      }
    }

    let end = left.span;
    if (this.#match(TokenKind.RightParenthesis)) end = this.#previous().span;
    else {
      this.#reportInsertion(
        parserDiagnosticCode.expectedDelimiter,
        "Expected ')' after the function arguments.",
      );
      if (argumentsList.length > 0) end = argumentsList.at(-1)!.span;
    }
    return Object.freeze({
      kind: "callExpression",
      callee,
      arguments: Object.freeze(argumentsList),
      argumentStyle: style,
      span: spanFrom(callee.span, end),
    });
  }

  #parsePrimary(): Expression | null {
    const token = this.#peek();
    if (this.#match(TokenKind.NumberLiteral)) {
      return Object.freeze({
        kind: "numberLiteral",
        raw: token.lexeme,
        value: Number(token.lexeme),
        numericType: /[.eE]/u.test(token.lexeme) ? "number" : "integer",
        span: copySpan(token.span),
      });
    }
    if (this.#match(TokenKind.StringLiteral)) return this.#stringLiteral(token);
    if (this.#match(TokenKind.KeywordTrue)) {
      return Object.freeze({
        kind: "booleanLiteral",
        value: true,
        span: copySpan(token.span),
      });
    }
    if (this.#match(TokenKind.KeywordFalse)) {
      return Object.freeze({
        kind: "booleanLiteral",
        value: false,
        span: copySpan(token.span),
      });
    }
    if (this.#match(TokenKind.KeywordNull)) {
      return Object.freeze({
        kind: "nullLiteral",
        value: null,
        span: copySpan(token.span),
      });
    }
    if (
      this.#match(TokenKind.Identifier) ||
      this.#match(TokenKind.KeywordSpeaker)
    ) {
      return this.#identifier(token);
    }
    if (this.#match(TokenKind.TemplateStart)) {
      return this.#parseTemplateLiteral(token);
    }
    if (this.#match(TokenKind.LeftParenthesis)) {
      return this.#parseParenthesized(token);
    }
    if (this.#match(TokenKind.LeftBracket)) {
      return this.#parseListLiteral(token);
    }
    if (this.#match(TokenKind.LeftBrace)) {
      return this.#parseObjectLiteral(token);
    }
    if (this.#match(TokenKind.KeywordSet)) {
      if (!this.#match(TokenKind.LeftBracket)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected '[' after 'set'.",
        );
        return null;
      }
      return this.#parseSetLiteral(token);
    }
    return null;
  }

  #parseParenthesized(start: Token): ParenthesizedExpression | null {
    this.#skipNewlines();
    const expression = this.#parseRequiredExpression();
    this.#skipNewlines();
    if (expression === null || !this.#match(TokenKind.RightParenthesis)) {
      if (expression !== null) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedDelimiter,
          "Expected ')' after the expression.",
        );
      }
      return null;
    }
    return Object.freeze({
      kind: "parenthesizedExpression",
      expression,
      span: spanFrom(start.span, this.#previous().span),
    });
  }

  #parseListLiteral(start: Token): Expression {
    const elements = this.#parseDelimitedElements(TokenKind.RightBracket);
    const end = this.#consumeClosingDelimiter(
      TokenKind.RightBracket,
      "Expected ']' after the list literal.",
    );
    return Object.freeze({
      kind: "listLiteral",
      elements: Object.freeze(elements),
      span: spanFrom(start.span, end),
    });
  }

  #parseSetLiteral(start: Token): SetLiteral {
    const elements = this.#parseDelimitedElements(TokenKind.RightBracket);
    const end = this.#consumeClosingDelimiter(
      TokenKind.RightBracket,
      "Expected ']' after the set literal.",
    );
    return Object.freeze({
      kind: "setLiteral",
      elements: Object.freeze(elements),
      span: spanFrom(start.span, end),
    });
  }

  #parseDelimitedElements(closing: TokenKind): Expression[] {
    const elements: Expression[] = [];
    this.#skipNewlines();
    while (!this.#check(closing) && !this.#check(TokenKind.EndOfFile)) {
      const value = this.#parseRequiredExpression();
      if (value === null) {
        this.#synchronizeDelimited(closing);
      } else {
        elements.push(value);
      }
      this.#skipNewlines();
      if (!this.#match(TokenKind.Comma)) break;
      this.#skipNewlines();
      if (this.#check(closing)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedExpression,
          "Expected a collection element after ','.",
        );
        break;
      }
    }
    return elements;
  }

  #parseObjectLiteral(start: Token): ObjectLiteral {
    const properties: ObjectProperty[] = [];
    this.#skipNewlines();
    while (
      !this.#check(TokenKind.RightBrace) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      if (!isPropertyName(this.#peek())) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyName,
          "Expected an object property name.",
        );
        this.#synchronizeDelimited(TokenKind.RightBrace);
        break;
      }
      const name = this.#identifier(this.#advance());
      if (!this.#match(TokenKind.Colon)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedColon,
          "Expected ':' after the object property name.",
        );
        this.#synchronizeDelimited(TokenKind.RightBrace);
        break;
      }
      this.#skipContinuationNewlines();
      const value = this.#parseRequiredExpression();
      if (value === null) break;
      properties.push(
        Object.freeze({
          kind: "objectProperty",
          name,
          value,
          span: spanFrom(name.span, value.span),
        }),
      );
      this.#skipNewlines();
      if (!this.#match(TokenKind.Comma)) break;
      this.#skipNewlines();
      if (this.#check(TokenKind.RightBrace)) {
        this.#reportInsertion(
          parserDiagnosticCode.expectedPropertyName,
          "Expected an object property after ','.",
        );
        break;
      }
    }
    const end = this.#consumeClosingDelimiter(
      TokenKind.RightBrace,
      "Expected '}' after the object literal.",
    );
    return Object.freeze({
      kind: "objectLiteral",
      properties: Object.freeze(properties),
      span: spanFrom(start.span, end),
    });
  }

  #parseTemplateLiteral(start: Token): TemplateLiteral | null {
    const parts: TemplatePart[] = [];
    let valid = true;
    while (
      !this.#check(TokenKind.TemplateEnd) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      if (this.#match(TokenKind.TemplateText)) {
        parts.push(this.#templateText(this.#previous()));
        continue;
      }
      if (this.#match(TokenKind.InterpolationStart)) {
        const interpolation = this.#parseTemplateInterpolation(this.#previous());
        if (interpolation === null) valid = false;
        else parts.push(interpolation);
        continue;
      }
      this.#reportToken(
        parserDiagnosticCode.unsupportedTemplateExpression,
        "Unexpected token in template string.",
        this.#peek(),
      );
      valid = false;
      this.#advance();
    }
    if (!this.#match(TokenKind.TemplateEnd)) return null;
    if (!valid) return null;
    return Object.freeze({
      kind: "templateLiteral",
      parts: Object.freeze(parts),
      span: spanFrom(start.span, this.#previous().span),
    });
  }

  #parseTemplateInterpolation(start: Token): TemplateInterpolation | null {
    if (this.#check(TokenKind.InterpolationEnd)) {
      this.#reportInsertion(
        parserDiagnosticCode.expectedTemplateExpression,
        "Expected an expression inside the template interpolation.",
      );
      this.#advance();
      return null;
    }
    if (
      this.#check(TokenKind.TemplateEnd) ||
      this.#check(TokenKind.EndOfFile)
    ) {
      return null;
    }
    const diagnosticCount = this.#diagnostics.length;
    const expression = this.#parseExpression();
    if (expression === null) {
      this.#reportToken(
        parserDiagnosticCode.unsupportedTemplateExpression,
        "Expected a supported expression inside the template interpolation.",
        this.#peek(),
      );
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }
    if (this.#diagnostics.length !== diagnosticCount) {
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }
    if (!this.#match(TokenKind.InterpolationEnd)) {
      if (
        !this.#check(TokenKind.TemplateEnd) &&
        !this.#check(TokenKind.EndOfFile)
      ) {
        const message = this.#check(TokenKind.Colon)
          ? "Only identifiers and chained property access are supported in template interpolation."
          : "Only one complete expression is allowed in template interpolation.";
        this.#reportToken(
          parserDiagnosticCode.unsupportedTemplateExpression,
          message,
          this.#peek(),
        );
      }
      this.#synchronizeInterpolation();
      this.#match(TokenKind.InterpolationEnd);
      return null;
    }
    return Object.freeze({
      kind: "templateInterpolation",
      expression,
      span: spanFrom(start.span, this.#previous().span),
    });
  }

  #binary(
    left: Expression,
    _operatorToken: Token,
    right: Expression,
    operator: BinaryExpression["operator"],
  ): BinaryExpression {
    return Object.freeze({
      kind: "binaryExpression",
      operator,
      left,
      right,
      span: spanFrom(left.span, right.span),
    });
  }

  #unary(
    operatorToken: Token,
    operand: Expression,
    operator: UnaryExpression["operator"],
  ): UnaryExpression {
    return Object.freeze({
      kind: "unaryExpression",
      operator,
      operand,
      span: spanFrom(operatorToken.span, operand.span),
    });
  }

  #speakerDeclaration(
    keyword: Token,
    name: Identifier,
    properties: readonly SpeakerProperty[],
    end: SourceSpan,
  ): SpeakerDeclaration {
    return Object.freeze({
      kind: "speakerDeclaration",
      name,
      properties: Object.freeze([...properties]),
      span: spanFrom(keyword.span, end),
    });
  }

  #identifier(token: Token): Identifier {
    return Object.freeze({
      kind: "identifier",
      name: token.lexeme,
      span: copySpan(token.span),
    });
  }

  #stringLiteral(token: Token): Expression {
    return Object.freeze({
      kind: "stringLiteral",
      raw: token.lexeme,
      value: tokenValue(token),
      span: copySpan(token.span),
    });
  }

  #templateText(token: Token): TemplateText {
    return Object.freeze({
      kind: "templateText",
      raw: token.lexeme,
      value: tokenValue(token),
      span: copySpan(token.span),
    });
  }

  #consumeClosingDelimiter(kind: TokenKind, message: string): SourceSpan {
    this.#skipNewlines();
    if (this.#match(kind)) return this.#previous().span;
    this.#reportInsertion(parserDiagnosticCode.expectedDelimiter, message);
    return this.#previous().span;
  }

  #finishStatement(inBlock: boolean): void {
    if (this.#check(TokenKind.Newline)) {
      this.#skipNewlines();
      return;
    }
    if (
      this.#check(TokenKind.EndOfFile) ||
      (inBlock && this.#check(TokenKind.RightBrace))
    ) {
      return;
    }
    this.#reportInsertion(
      parserDiagnosticCode.expectedStatementEnd,
      "Expected a newline after the statement.",
    );
    this.#synchronizeStatement(inBlock);
  }

  #skipMalformedBlock(): void {
    let depth = 0;
    while (!this.#check(TokenKind.EndOfFile)) {
      if (this.#match(TokenKind.LeftBrace)) depth += 1;
      else if (this.#match(TokenKind.RightBrace)) {
        depth -= 1;
        if (depth === 0) return;
      } else this.#advance();
    }
  }

  #synchronizeStatement(stopAtRightBrace = false): void {
    while (
      !this.#check(TokenKind.Newline) &&
      !this.#check(TokenKind.EndOfFile) &&
      !(stopAtRightBrace && this.#check(TokenKind.RightBrace))
    ) {
      this.#advance();
    }
  }

  #synchronizeProperty(): void {
    while (
      !this.#check(TokenKind.Newline) &&
      !this.#check(TokenKind.RightBrace) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #synchronizeDelimited(closing: TokenKind): void {
    while (
      !this.#check(TokenKind.Comma) &&
      !this.#check(closing) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #synchronizeParameter(): void {
    while (
      !this.#check(TokenKind.Comma) &&
      !this.#check(TokenKind.RightParenthesis) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #synchronizeInterpolation(): void {
    while (
      !this.#check(TokenKind.InterpolationEnd) &&
      !this.#check(TokenKind.TemplateEnd) &&
      !this.#check(TokenKind.EndOfFile)
    ) {
      this.#advance();
    }
  }

  #isRecoveredTopLevelStatement(): boolean {
    return (
      isStatementStart(this.#peek().kind) &&
      this.#peek(1).kind !== TokenKind.Colon
    );
  }

  #skipNewlines(): void {
    while (this.#match(TokenKind.Newline)) {
      // Newline tokens delimit statements unless a caller explicitly skips them.
    }
  }

  #skipContinuationNewlines(): void {
    this.#skipNewlines();
  }

  #reportMixedArguments(span: SourceSpan): void {
    this.#reportSpan(
      parserDiagnosticCode.mixedArguments,
      "Positional and named arguments may not be mixed in one call.",
      span,
    );
  }

  #reportInsertion(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
  ): void {
    const position = this.#peek().span.start;
    this.#diagnostics.push(
      createDiagnostic(
        DiagnosticSeverity.Error,
        code,
        message,
        createSourceSpan(position, position),
      ),
    );
  }

  #reportToken(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
    token: Token,
  ): void {
    this.#reportSpan(code, message, token.span);
  }

  #reportSpan(
    code: (typeof parserDiagnosticCode)[keyof typeof parserDiagnosticCode],
    message: string,
    span: SourceSpan,
  ): void {
    this.#diagnostics.push(
      createDiagnostic(DiagnosticSeverity.Error, code, message, span),
    );
  }

  #match(kind: TokenKind): boolean {
    if (!this.#check(kind)) return false;
    this.#advance();
    return true;
  }

  #check(kind: TokenKind): boolean {
    return this.#peek().kind === kind;
  }

  #advance(): Token {
    const token = this.#peek();
    if (token.kind !== TokenKind.EndOfFile) this.#current += 1;
    return token;
  }

  #peek(distance = 0): Token {
    return this.tokens[
      Math.min(this.#current + distance, this.tokens.length - 1)
    ]!;
  }

  #previous(): Token {
    return this.tokens[this.#current - 1]!;
  }
}

const scalarTypes = new Set<ScalarTypeName>([
  "string",
  "boolean",
  "integer",
  "number",
  "date",
  "time",
  "datetime",
  "duration",
]);

function isScalarType(value: string): value is ScalarTypeName {
  return scalarTypes.has(value as ScalarTypeName);
}

function isPropertyName(token: Token): boolean {
  return token.kind === TokenKind.Identifier || token.kind.startsWith("keyword");
}

function isExpressionStart(token: Token): boolean {
  return (
    token.kind === TokenKind.Identifier ||
    token.kind === TokenKind.NumberLiteral ||
    token.kind === TokenKind.StringLiteral ||
    token.kind === TokenKind.TemplateStart ||
    token.kind === TokenKind.KeywordSpeaker ||
    token.kind === TokenKind.KeywordTrue ||
    token.kind === TokenKind.KeywordFalse ||
    token.kind === TokenKind.KeywordNull ||
    token.kind === TokenKind.KeywordSet ||
    token.kind === TokenKind.KeywordNot ||
    token.kind === TokenKind.LeftParenthesis ||
    token.kind === TokenKind.LeftBracket ||
    token.kind === TokenKind.LeftBrace ||
    token.kind === TokenKind.Plus ||
    token.kind === TokenKind.Minus
  );
}

function isStatementStart(kind: TokenKind): boolean {
  return (
    kind === TokenKind.KeywordSpeaker ||
    kind === TokenKind.KeywordSay ||
    kind === TokenKind.KeywordExit ||
    kind === TokenKind.KeywordLet ||
    kind === TokenKind.KeywordIf
    || kind === TokenKind.KeywordRepeat
    || kind === TokenKind.KeywordFor
    || kind === TokenKind.KeywordWhile
    || kind === TokenKind.KeywordBreak
    || kind === TokenKind.KeywordContinue
    || kind === TokenKind.KeywordFunction
    || kind === TokenKind.KeywordReturn
  );
}

function isAssignmentTarget(expression: Expression): expression is AssignmentTarget {
  return (
    expression.kind === "identifier" ||
    expression.kind === "propertyAccessExpression" ||
    expression.kind === "indexExpression"
  );
}

function isComparisonKind(kind: TokenKind): boolean {
  return (
    kind === TokenKind.EqualEqual ||
    kind === TokenKind.BangEqual ||
    kind === TokenKind.Less ||
    kind === TokenKind.LessEqual ||
    kind === TokenKind.Greater ||
    kind === TokenKind.GreaterEqual
  );
}

function binaryOperator(token: Token): BinaryExpression["operator"] {
  return token.lexeme as BinaryExpression["operator"];
}

function tokenValue(token: Token): string {
  return "value" in token ? token.value : "";
}

function spanFrom(start: SourceSpan, end: SourceSpan): SourceSpan {
  return createSourceSpan(start.start, end.end);
}

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}
