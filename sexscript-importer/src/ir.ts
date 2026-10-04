import type { SourceSpan } from "./ast.ts";
import type { ProposalId } from "./proposals.ts";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface MigrationDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  span: SourceSpan | null;
  /** The file the span refers to when it is not the program's own source, as for a composed module. */
  sourceName?: string;
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
  /** Methods the module injects into the script object; a later module may replace them. */
  injected: string[];
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
  /**
   * `type` is a written annotation such as `number`, `string?`, or `string[]?`. `integer` marks a variable Groovy
   * declared with an integer type (`int`, `long`, ...), which truncates every number stored in it.
   */
  | (IrBase & { kind: "let"; name: string; value: IrExpression; type?: string; integer?: true })
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

/**
 * One option of a `choose` with list options (V30 §19, PR #515): a written option, with its numeric value or
 * without one (the button text is the value), or a list whose elements are texts or, with `records`,
 * `{ value, text }` choice objects.
 */
export type IrListChoiceOption =
  | { kind: "option"; value: number | null; text: IrExpression }
  | { kind: "list"; list: IrExpression; records: boolean };

export interface IrSwitchCase {
  span: SourceSpan | null;
  /** The case's values (several per case, #528) or ranges. */
  matches: IrExpression[];
  body: IrStatement[];
}

export type IrExpression =
  /** `action` marks the ID of a function kept as a value; renaming the function renames the ID. */
  | { kind: "literal"; value: string | number | boolean | null; action?: true }
  | { kind: "variable"; name: string }
  | { kind: "list"; items: IrExpression[] }
  /** A property with `key` (proposed dictionaries) has a computed key, written `[key]: value`; `name` is unused. */
  | { kind: "object"; properties: Array<{ name: string; value: IrExpression; key?: IrExpression }> }
  | { kind: "index"; target: IrExpression; index: IrExpression; proposed?: ProposalId }
  /**
   * `proposed` marks a member that only a proposed language change defines (see proposals.ts); `pending` marks an
   * accepted text operation or list `join` that main does not implement yet (V30 §8 and §16 as accepted in PR #518).
   */
  | { kind: "property"; target: IrExpression; name: string; proposed?: ProposalId; pending?: true }
  | {
      kind: "methodCall";
      target: IrExpression;
      name: string;
      arguments: IrExpression[];
      proposed?: ProposalId;
      pending?: true;
    }
  /** `load key` returns null for a missing key; `defaultValue` replaces that null without writing storage. */
  | { kind: "load"; key: IrExpression; defaultValue?: IrExpression }
  /**
   * Compact `choose`. Without `labels`, numeric labels return the zero-based option index; with `labels`, each
   * option gets the identifier label that `choose` returns.
   */
  | { kind: "choice"; options: IrExpression[]; labels?: string[] }
  /**
   * `choose` whose options may mix written values with options without one, and whose list options give one button
   * per element (V30 §19 as accepted in PR #515, not implemented on main yet).
   */
  | { kind: "listChoice"; options: IrListChoiceOption[] }
  /**
   * Compact single-field input whose prompt, if any, was emitted as a preceding `say`. `defaultValue` prefills the
   * field, written `askText default: value` (V30 §20).
   */
  | { kind: "input"; input: "askText" | "askNumber"; defaultValue?: IrExpression }
  | { kind: "range"; from: IrExpression; to: IrExpression; inclusive: boolean }
  /** An elapsed duration literal such as `1 s`. */
  | { kind: "duration"; value: number; unit: "s" | "ms" }
  /** `showButton label, timeout: t` used as a value: the elapsed duration until the click or the timeout (#531). */
  | { kind: "button"; label: IrExpression; timeout: IrExpression | null }
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
