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
  | ExitStatement;

export interface SpeakerDeclaration {
  readonly kind: "speakerDeclaration";
  readonly name: Identifier;
  readonly properties: readonly SpeakerProperty[];
  readonly span: SourceSpan;
}

export interface SpeakerProperty {
  readonly kind: "speakerProperty";
  readonly name: Identifier;
  readonly value: StringExpression;
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
  readonly value: StringExpression;
  readonly span: SourceSpan;
}

export interface ExitStatement {
  readonly kind: "exitStatement";
  readonly span: SourceSpan;
}

export type StringExpression = StringLiteral | TemplateLiteral;

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
  readonly expression: InterpolationExpression;
  readonly span: SourceSpan;
}

export type InterpolationExpression = Identifier | PropertyAccessExpression;

export interface Identifier {
  readonly kind: "identifier";
  readonly name: string;
  readonly span: SourceSpan;
}

export interface PropertyAccessExpression {
  readonly kind: "propertyAccessExpression";
  readonly object: InterpolationExpression;
  readonly property: Identifier;
  readonly span: SourceSpan;
}
