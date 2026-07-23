import type { SourceSpan } from "./source.js";

export interface Program {
  readonly kind: "program";
  readonly statements: readonly Statement[];
  readonly span: SourceSpan;
}

export type Statement =
  | SpeakerDeclaration
  | SpeakerSetterStatement
  | SayStatement
  | ExitStatement
  | LetStatement
  | AssignmentStatement
  | IfStatement
  | RepeatStatement
  | ForStatement
  | WhileStatement
  | BreakStatement
  | ContinueStatement
  | ExpressionStatement;

export interface Block {
  readonly kind: "block";
  readonly statements: readonly Statement[];
  readonly span: SourceSpan;
}

export interface SpeakerDeclaration {
  readonly kind: "speakerDeclaration";
  readonly name: Identifier;
  readonly properties: readonly SpeakerProperty[];
  readonly span: SourceSpan;
}

export interface SpeakerProperty {
  readonly kind: "speakerProperty";
  readonly name: Identifier;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface SpeakerSetterStatement {
  readonly kind: "speakerSetterStatement";
  readonly speaker: Identifier;
  readonly span: SourceSpan;
}

export interface SayStatement {
  readonly kind: "sayStatement";
  readonly speaker: Identifier | null;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface ExitStatement {
  readonly kind: "exitStatement";
  readonly span: SourceSpan;
}

export interface LetStatement {
  readonly kind: "letStatement";
  readonly name: Identifier;
  readonly typeAnnotation: TypeAnnotation | null;
  readonly initializer: Expression;
  readonly span: SourceSpan;
}

export type ScalarTypeName =
  | "string"
  | "boolean"
  | "integer"
  | "number"
  | "date"
  | "time"
  | "datetime"
  | "duration";

export interface TypeAnnotation {
  readonly kind: "typeAnnotation";
  readonly name: ScalarTypeName;
  readonly collection: "list" | "set" | null;
  readonly optional: boolean;
  readonly span: SourceSpan;
}

export type AssignmentTarget =
  | Identifier
  | PropertyAccessExpression
  | IndexExpression;

export interface AssignmentStatement {
  readonly kind: "assignmentStatement";
  readonly target: AssignmentTarget;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface IfStatement {
  readonly kind: "ifStatement";
  readonly condition: Expression;
  readonly thenBlock: Block;
  readonly elseBlock: Block | IfStatement | null;
  readonly span: SourceSpan;
}

export interface RepeatStatement {
  readonly kind: "repeatStatement";
  readonly count: Expression;
  readonly body: Block;
  readonly span: SourceSpan;
}

export interface ForStatement {
  readonly kind: "forStatement";
  readonly variable: Identifier;
  readonly iterable: Expression;
  readonly body: Block;
  readonly span: SourceSpan;
}

export interface WhileStatement {
  readonly kind: "whileStatement";
  readonly condition: Expression;
  readonly body: Block;
  readonly span: SourceSpan;
}

export interface BreakStatement {
  readonly kind: "breakStatement";
  readonly span: SourceSpan;
}

export interface ContinueStatement {
  readonly kind: "continueStatement";
  readonly span: SourceSpan;
}

export interface ExpressionStatement {
  readonly kind: "expressionStatement";
  readonly expression: CallExpression;
  readonly span: SourceSpan;
}

export type Expression =
  | Identifier
  | BooleanLiteral
  | NullLiteral
  | NumberLiteral
  | StringLiteral
  | TemplateLiteral
  | ListLiteral
  | ObjectLiteral
  | SetLiteral
  | ParenthesizedExpression
  | PropertyAccessExpression
  | IndexExpression
  | CallExpression
  | UnaryExpression
  | BinaryExpression
  | RangeExpression;

/** Kept as a compatibility alias for the initial parser POC public API. */
export type StringExpression = StringLiteral | TemplateLiteral;

/** Kept as a compatibility alias; interpolation now accepts all expressions. */
export type InterpolationExpression = Expression;

export interface Identifier {
  readonly kind: "identifier";
  readonly name: string;
  readonly span: SourceSpan;
}

export interface BooleanLiteral {
  readonly kind: "booleanLiteral";
  readonly value: boolean;
  readonly span: SourceSpan;
}

export interface NullLiteral {
  readonly kind: "nullLiteral";
  readonly value: null;
  readonly span: SourceSpan;
}

export interface NumberLiteral {
  readonly kind: "numberLiteral";
  readonly raw: string;
  readonly value: number;
  readonly numericType: "integer" | "number";
  readonly span: SourceSpan;
}

export interface StringLiteral {
  readonly kind: "stringLiteral";
  readonly raw: string;
  readonly value: string;
  readonly span: SourceSpan;
}

export interface TemplateLiteral {
  readonly kind: "templateLiteral";
  readonly parts: readonly TemplatePart[];
  readonly span: SourceSpan;
}

export type TemplatePart = TemplateText | TemplateInterpolation;

export interface TemplateText {
  readonly kind: "templateText";
  readonly raw: string;
  readonly value: string;
  readonly span: SourceSpan;
}

export interface TemplateInterpolation {
  readonly kind: "templateInterpolation";
  readonly expression: Expression;
  readonly span: SourceSpan;
}

export interface ListLiteral {
  readonly kind: "listLiteral";
  readonly elements: readonly Expression[];
  readonly span: SourceSpan;
}

export interface ObjectLiteral {
  readonly kind: "objectLiteral";
  readonly properties: readonly ObjectProperty[];
  readonly span: SourceSpan;
}

export interface ObjectProperty {
  readonly kind: "objectProperty";
  readonly name: Identifier;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface SetLiteral {
  readonly kind: "setLiteral";
  readonly elements: readonly Expression[];
  readonly span: SourceSpan;
}

export interface ParenthesizedExpression {
  readonly kind: "parenthesizedExpression";
  readonly expression: Expression;
  readonly span: SourceSpan;
}

export interface PropertyAccessExpression {
  readonly kind: "propertyAccessExpression";
  readonly object: Expression;
  readonly property: Identifier;
  readonly span: SourceSpan;
}

export interface IndexExpression {
  readonly kind: "indexExpression";
  readonly object: Expression;
  readonly index: Expression;
  readonly span: SourceSpan;
}

export interface CallExpression {
  readonly kind: "callExpression";
  readonly callee: Expression;
  readonly arguments: readonly CallArgument[];
  readonly argumentStyle: "none" | "positional" | "named";
  readonly span: SourceSpan;
}

export type CallArgument = PositionalArgument | NamedArgument;

export interface PositionalArgument {
  readonly kind: "positionalArgument";
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface NamedArgument {
  readonly kind: "namedArgument";
  readonly name: Identifier;
  readonly value: Expression;
  readonly span: SourceSpan;
}

export interface UnaryExpression {
  readonly kind: "unaryExpression";
  readonly operator: "+" | "-" | "not";
  readonly operand: Expression;
  readonly span: SourceSpan;
}

export interface BinaryExpression {
  readonly kind: "binaryExpression";
  readonly operator:
    | "*"
    | "/"
    | "%"
    | "+"
    | "-"
    | "=="
    | "!="
    | "<"
    | "<="
    | ">"
    | ">="
    | "and"
    | "or";
  readonly left: Expression;
  readonly right: Expression;
  readonly span: SourceSpan;
}

export interface RangeExpression {
  readonly kind: "rangeExpression";
  readonly start: Expression;
  readonly end: Expression;
  readonly inclusive: boolean;
  readonly span: SourceSpan;
}
