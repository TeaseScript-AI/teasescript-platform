import type { SourceSpan } from "./ast.ts";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface MigrationDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  span: SourceSpan | null;
}

export interface LegacyMetadata {
  apiVersion: number | null;
  title: string | null;
  summary: string | null;
  author: string | null;
  status: string | null;
  color: number | null;
  language: string | null;
  tags: string[] | null;
}

export interface MigrationProgram {
  sourceName: string;
  metadata: LegacyMetadata | null;
  statements: IrStatement[];
  diagnostics: MigrationDiagnostic[];
}

interface IrBase {
  span: SourceSpan | null;
}

export type IrStatement =
  | (IrBase & { kind: "say"; value: IrExpression })
  | (IrBase & { kind: "wait"; duration: IrExpression; visible: boolean })
  | (IrBase & { kind: "showButton"; label: IrExpression })
  | (IrBase & { kind: "showPopup"; message: IrExpression })
  | (IrBase & { kind: "showImage"; file: IrExpression })
  | (IrBase & { kind: "hideImage" })
  | (IrBase & {
      kind: "playAudio";
      file: IrExpression;
      async: boolean;
      repeatCount: IrExpression | null;
    })
  | (IrBase & { kind: "save"; key: IrExpression; value: IrExpression })
  | (IrBase & { kind: "let"; name: string; value: IrExpression })
  | (IrBase & { kind: "assign"; target: string; operator: "=" | "+=" | "-="; value: IrExpression })
  | (IrBase & { kind: "expression"; expression: IrExpression })
  | (IrBase & { kind: "if"; condition: IrExpression; then: IrStatement[]; else: IrStatement[] })
  | (IrBase & { kind: "while"; condition: IrExpression; body: IrStatement[] })
  | (IrBase & { kind: "for"; variable: string; collection: IrExpression; body: IrStatement[] })
  | (IrBase & { kind: "switch"; value: IrExpression; cases: IrSwitchCase[]; default: IrStatement[] })
  | (IrBase & { kind: "break" })
  | (IrBase & { kind: "continue" })
  | (IrBase & { kind: "run"; script: IrExpression })
  | (IrBase & { kind: "end" })
  | (IrBase & { kind: "exit" })
  | (IrBase & { kind: "unsupported"; diagnosticCode: string; summary: string });

export interface IrSwitchCase {
  span: SourceSpan | null;
  match: IrExpression;
  body: IrStatement[];
}

export type IrExpression =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "variable"; name: string }
  | { kind: "list"; items: IrExpression[] }
  | { kind: "range"; from: IrExpression; to: IrExpression; inclusive: boolean }
  | { kind: "unary"; operator: "not" | "+" | "-"; value: IrExpression }
  | { kind: "binary"; operator: string; left: IrExpression; right: IrExpression }
  | { kind: "call"; name: string; positional: IrExpression[]; named: Record<string, IrExpression> };
