import type { SourceSpan } from "./ast.ts";

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
  /** Fields setInfos() computed at runtime, by name, with their legacy source, which no header can hold. */
  computed?: Array<{ field: string; source: string }>;
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
  /** The source name of the mixin module a composed statement comes from, which writes it to its own file. */
  origin?: string;
}

export interface IrFunctionParameter {
  name: string;
  defaultValue: IrExpression | null;
}

export type IrStatement =
  /**
   * `instant` shows the text without reading time (`say text, instant`); `speaker` says it `as` that speaker, and
   * `prose` shows it as prose rather than a speech bubble (V30 §17).
   */
  | (IrBase & { kind: "say"; value: IrExpression; instant?: true; speaker?: string; prose?: true })
  /** A speaker declaration, global in the package (V30 §37). */
  | (IrBase & {
      kind: "speaker";
      name: string;
      properties: Array<{ name: string; value: IrExpression }>;
    })
  | (IrBase & { kind: "wait"; duration: IrExpression; visible: boolean; unit: "s" | "ms" })
  | (IrBase & { kind: "showButton"; label: IrExpression; timeout: IrExpression | null })
  | (IrBase & { kind: "showPopup"; message: IrExpression })
  /**
   * `target = showPermanentButton label { }` (V30 §28): a button without an action, its ID kept in `target`; `persist`
   * keeps it across files until `exit`.
   */
  | (IrBase & {
      kind: "permanentButton";
      target: IrExpression;
      label: IrExpression;
      persist: boolean;
      /** What a click runs. */
      body?: IrStatement[];
    })
  | (IrBase & { kind: "showImage"; file: IrExpression })
  | (IrBase & { kind: "hideImage" })
  | (IrBase & {
      kind: "playAudio";
      file: IrExpression;
      /** `playVideo` instead of `playAudio`. */
      video?: true;
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
      /** Diagnostics of the legacy function body, which become notes if nothing references it (uncalledCode). */
      ownDiagnostics?: MigrationDiagnostic[];
      /** A `global function`, callable from every file of the package (#570). */
      global?: true;
      /** The declared result type, where returns mix types or a value and null (V30 §17). */
      returnType?: string;
    })
  | (IrBase & { kind: "return"; value: IrExpression | null })
  /**
   * `type` is a written annotation such as `number`, `string?`, or `string[]?`. `integer` marks a variable Groovy
   * declared with an integer type (`int`, `long`, ...), which truncates every number stored in it.
   */
  | (IrBase & {
      kind: "let";
      name: string;
      value: IrExpression;
      type?: string;
      /** A Groovy integer variable (`int`, `long`, ...), which stores whole numbers. */
      integer?: true;
      /** The Groovy value may be text, which an integer variable stored as a character code. */
      maybeText?: true;
      /** A `global`, visible in every file of the package and initialized at session start (ADR 0022 §6). */
      global?: true;
      /** The counter a C-style `for` declared, which Groovy scoped to its loop. */
      loopCounter?: true;
    })
  | (IrBase & {
      kind: "assign";
      target: IrExpression;
      operator: "=" | "+=" | "-=";
      value: IrExpression;
      /** The Groovy value may be text (see the `let` statement). */
      maybeText?: true;
    })
  | (IrBase & { kind: "expression"; expression: IrExpression })
  | (IrBase & {
      kind: "if";
      condition: IrExpression;
      then: IrStatement[];
      else: IrStatement[];
      /** `prompt` marks the importer's test that a legacy input's question is not null before it is shown. */
      guard?: "prompt";
    })
  | (IrBase & { kind: "while"; condition: IrExpression; body: IrStatement[] })
  | (IrBase & { kind: "repeat"; count: IrExpression; body: IrStatement[] })
  /** `dict` marks a loop over the keys of a dict (#536). */
  | (IrBase & {
      kind: "for";
      variable: string;
      collection: IrExpression;
      body: IrStatement[];
      dict?: true;
    })
  | (IrBase & {
      kind: "switch";
      value: IrExpression;
      cases: IrSwitchCase[];
      default: IrStatement[];
    })
  | (IrBase & { kind: "break" })
  | (IrBase & { kind: "continue" })
  /**
   * A transfer to another file of the package (ADR 0022 §2): a path relative to the package root, or a script reference
   * computed at runtime, `goto script(path)`.
   */
  | (IrBase & { kind: "goto"; target: IrGotoTarget })
  /** `returned` marks the end of a legacy script chain, a script-level `return` without a script name. */
  | (IrBase & { kind: "exit"; returned?: true })
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

export type IrGotoTarget = { kind: "file"; path: string } | { kind: "script"; path: IrExpression };

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
  /** `set` marks a set literal `set[...]` (V30 §16). */
  | { kind: "list"; items: IrExpression[]; set?: true }
  /**
   * An object literal, or with `dict` a dict literal `dict{ ... }` (#536). A property with `key` has a key that is
   * computed or not a name, written `[key]: value` or `"key": value`; `name` is unused then.
   */
  | {
      kind: "object";
      properties: Array<{ name: string; value: IrExpression; key?: IrExpression }>;
      dict?: true;
    }
  /** `dict` marks a dict lookup, whose missing key is an error (#536). */
  | { kind: "index"; target: IrExpression; index: IrExpression; dict?: true }
  /** `dict` marks a member of a dict (#536). */
  | { kind: "property"; target: IrExpression; name: string; dict?: true }
  /** `value is type`, a type test (#530). */
  | { kind: "typeTest"; value: IrExpression; type: string }
  /** A dict `get` has the key and the default as its arguments: `dict.get(key, default: value)` (#536). */
  | {
      kind: "methodCall";
      target: IrExpression;
      name: string;
      arguments: IrExpression[];
      dict?: true;
    }
  /**
   * `load key` returns null for a missing key; `defaultValue` replaces that null without writing storage, written
   * `load key, default: value` (#541). `integer` marks a legacy `loadInteger()`, which read a whole number.
   */
  | { kind: "load"; key: IrExpression; defaultValue?: IrExpression; integer?: true }
  /**
   * Compact `choose`. Without `labels`, numeric labels return the zero-based option index; with `labels`, each
   * option gets the identifier label that `choose` returns.
   */
  | { kind: "choice"; options: IrExpression[]; labels?: string[] }
  /**
   * `choose` whose options may mix written values with options without one, and whose list options give one button
   * per element (V30 §19, #515).
   */
  | { kind: "listChoice"; options: IrListChoiceOption[] }
  /**
   * Compact single-field input whose prompt, if any, was emitted as a preceding `say`. `defaultValue` prefills the
   * field, written `askText default: value` (V30 §20).
   */
  | {
      kind: "input";
      input: "askText" | "askNumber" | "askInteger";
      defaultValue?: IrExpression;
      /** Asks `as` this speaker. */
      speaker?: string;
    }
  | { kind: "range"; from: IrExpression; to: IrExpression; inclusive: boolean }
  /** A duration literal: exact (`1 s`, `1 min`, `1 h`) or calendar (`1 day`, `1 week`, `1 month`, `1 year`). */
  | {
      kind: "duration";
      value: number;
      unit: "s" | "ms" | "min" | "h" | "day" | "week" | "month" | "year";
    }
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
