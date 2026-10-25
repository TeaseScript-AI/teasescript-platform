import type {
  ForStatement,
  FunctionDeclaration,
  FunctionParameter,
  Identifier,
  LetStatement,
} from "../ast.js";
import type { SourceSpan } from "../source.js";

// What a name stands for, and the scopes in which the name pass looks it up.

/** `global` is a name the host configures; a `global` declared in a script is a project `variable`. */
export type BindingKind = "variable" | "speaker" | "global" | "function";

export interface Binding {
  readonly kind: BindingKind;
  /** The declaration of a function. */
  readonly declaration?: FunctionDeclaration;
  /** Where the project declares a global, a speaker, or a global function, which every file sees. */
  readonly project?: ProjectDeclaration;
  /** The declaration of a function, loop, or block variable. */
  site?: VariableSite;
}

/**
 * The declaration of a function, loop, or block variable: its `let`, its `for` (the key of a pair loop), the value name
 * of a pair loop, or its parameter.
 */
export type VariableSite = LetStatement | ForStatement | Identifier | FunctionParameter;

export interface ProjectDeclaration {
  readonly file: number;
  readonly span: SourceSpan;
  readonly description: "global" | "speaker" | "global function";
  /** The position of a global or speaker in the order a session initializes them; a global function has none. */
  readonly order: number | null;
}

export class SemanticScope {
  readonly bindings = new Map<string, Binding>();

  /**
   * For the scope of the locals a timer, media, or button block shares with the code that created it: the names the
   * block uses from it, in the order of first use.
   */
  readonly captured: Set<string> | null;

  public constructor(
    readonly parent: SemanticScope | null = null,
    captures = false,
  ) {
    this.captured = captures ? new Set() : null;
  }

  public resolve(name: string): Binding | undefined {
    let scope: SemanticScope | null = this;
    while (scope !== null) {
      const binding = scope.bindings.get(name);
      if (binding !== undefined) {
        if (binding.kind === "variable") scope.captured?.add(name);
        return binding;
      }
      scope = scope.parent;
    }
    return undefined;
  }

  /** The declaration of the variable `name` when it is one that a block shares with the code that created it. */
  public sharedSite(name: string): VariableSite | undefined {
    for (let scope: SemanticScope | null = this; scope !== null; scope = scope.parent) {
      const binding = scope.bindings.get(name);
      if (binding !== undefined) return scope.captured === null ? undefined : binding.site;
    }
    return undefined;
  }

  /** The binding of `name`, without counting it as a use of a variable that a block shares. */
  public lookup(name: string): Binding | undefined {
    for (let scope: SemanticScope | null = this; scope !== null; scope = scope.parent) {
      const binding = scope.bindings.get(name);
      if (binding !== undefined) return binding;
    }
    return undefined;
  }

  /** Whether `name` is a variable that a block shares with the code that created it. */
  public isShared(name: string): boolean {
    for (let scope: SemanticScope | null = this; scope !== null; scope = scope.parent)
      if (scope.bindings.has(name)) return scope.captured !== null;
    return false;
  }

  public declare(name: string, binding: Binding): boolean {
    if (this.resolve(name) !== undefined) return false;
    this.bindings.set(name, binding);
    return true;
  }
}
