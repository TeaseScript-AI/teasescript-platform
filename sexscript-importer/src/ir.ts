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
  /** Set for a runtime-loaded mixin module, which contributes package code instead of being a script. */
  module?: MixinModuleInfo;
  /** Module directories whose mixin modules this script loads at runtime. */
  loadsModuleDirectories?: string[];
  /** Functions used as closure-value action IDs (and a marker when actions are called). */
  actions?: string[];
}

export interface MixinModuleInfo {
  sourceName: string;
  /** Package directory the legacy loader lists, such as `toy` for `scripts/toy/*.groovy`. */
  directory: string;
  name: string;
  loadFunction: string;
  setupFunction: string | null;
  /** Functions the module defines, including injected methods. */
  functions: string[];
}

interface IrBase {
  span: SourceSpan | null;
}

export interface IrFunctionParameter {
  name: string;
  defaultValue: IrExpression | null;
}

export type IrStatement =
  | (IrBase & { kind: "say"; value: IrExpression })
  | (IrBase & { kind: "wait"; duration: IrExpression; visible: boolean; unit: "s" | "ms" })
  | (IrBase & { kind: "showButton"; label: IrExpression; timeout: IrExpression | null })
  | (IrBase & { kind: "showPopup"; message: IrExpression })
  | (IrBase & { kind: "showImage"; file: IrExpression })
  | (IrBase & { kind: "hideImage" })
  | (IrBase & {
      kind: "playAudio";
      file: IrExpression;
      async: boolean;
      repeatCount: IrExpression | null;
      /** Declares a variable holding the handle of async media. */
      handle?: string;
    })
  | (IrBase & { kind: "save"; key: IrExpression; value: IrExpression })
  | (IrBase & { kind: "delete"; key: IrExpression })
  | (IrBase & {
      kind: "function";
      name: string;
      parameters: IrFunctionParameter[];
      body: IrStatement[];
      /** Legacy comments that preceded the function declaration. */
      leadingComments?: string[];
    })
  | (IrBase & { kind: "return"; value: IrExpression | null })
  /** `optionalType` (such as `string` or `string[]`) declares a nullable type for a null initializer. */
  | (IrBase & { kind: "let"; name: string; value: IrExpression; optionalType?: string })
  | (IrBase & {
      kind: "assign";
      target: IrExpression;
      operator: "=" | "+=" | "-=";
      value: IrExpression;
    })
  | (IrBase & { kind: "expression"; expression: IrExpression })
  | (IrBase & { kind: "if"; condition: IrExpression; then: IrStatement[]; else: IrStatement[] })
  | (IrBase & { kind: "while"; condition: IrExpression; body: IrStatement[] })
  | (IrBase & { kind: "repeat"; count: IrExpression; body: IrStatement[] })
  | (IrBase & { kind: "for"; variable: string; collection: IrExpression; body: IrStatement[] })
  | (IrBase & {
      kind: "switch";
      value: IrExpression;
      cases: IrSwitchCase[];
      default: IrStatement[];
    })
  | (IrBase & { kind: "break" })
  | (IrBase & { kind: "continue" })
  | (IrBase & { kind: "run"; script: IrExpression })
  | (IrBase & { kind: "end" })
  | (IrBase & { kind: "exit" })
  /** Legacy code that needs manual migration, preserved as commented-out source lines. */
  | (IrBase & { kind: "unsupported"; legacySource: string[] })
  /** Preserved legacy source comment; `trailing` keeps it on the previous statement's line. */
  | (IrBase & { kind: "comment"; text: string; trailing: boolean })
  /** Preserved paragraph break between legacy statements. */
  | (IrBase & { kind: "blank" });

export interface IrSwitchCase {
  span: SourceSpan | null;
  match: IrExpression;
  body: IrStatement[];
}

export type IrExpression =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "variable"; name: string }
  | { kind: "list"; items: IrExpression[] }
  | { kind: "object"; properties: Array<{ name: string; value: IrExpression }> }
  | { kind: "index"; target: IrExpression; index: IrExpression }
  | { kind: "property"; target: IrExpression; name: string }
  | { kind: "methodCall"; target: IrExpression; name: string; arguments: IrExpression[] }
  /** `load key` returns null for a missing key; `defaultValue` replaces that null without writing storage. */
  | { kind: "load"; key: IrExpression; defaultValue?: IrExpression }
  /**
   * Compact `choose`. Without `labels`, numeric labels return the zero-based option index; with `labels`, each
   * option gets the identifier label that `choose` returns.
   */
  | { kind: "choice"; options: IrExpression[]; labels?: string[] }
  /** Compact single-field input whose prompt, if any, was emitted as a preceding `say`. */
  | { kind: "input"; input: "askText" | "askNumber" }
  | { kind: "range"; from: IrExpression; to: IrExpression; inclusive: boolean }
  | { kind: "unary"; operator: "not" | "+" | "-"; value: IrExpression }
  | { kind: "binary"; operator: string; left: IrExpression; right: IrExpression }
  /** `local` marks a call to a function defined in the generated package rather than a TeaseScript built-in. */
  | {
      kind: "call";
      name: string;
      positional: IrExpression[];
      named: Record<string, IrExpression>;
      local?: true;
    }
  /** Interpolated string: literal text segments and `${...}` values in source order. */
  | { kind: "template"; parts: Array<{ text: string } | { value: IrExpression }> };
