/**
 * Where a name refers to, resolved once at preparation, in the order today's lookup searches (`findBindingLocation`):
 * the running activation's scopes from the innermost down to its first, then for a function that is not global its
 * file's root, then the session's globals.
 */
export type NameLocation =
  | { readonly kind: "local"; readonly depth: number; readonly slot: number }
  | { readonly kind: "root"; readonly slot: number }
  | { readonly kind: "global"; readonly index: number };

/** A name the native engine cannot resolve statically; preparation refuses the plan. */
export class NativePreparationError extends Error {
  public constructor(message: string) {
    super(`native preparation: ${message}`);
    this.name = "NativePreparationError";
  }
}

/** Every global name of a plan, each with its index in a session's global slots, in the order they were first named. */
export class GlobalNames {
  readonly #indexes = new Map<string, number>();

  public index(name: string): number {
    let index = this.#indexes.get(name);
    if (index === undefined) {
      index = this.#indexes.size;
      this.#indexes.set(name, index);
    }
    return index;
  }

  public get size(): number {
    return this.#indexes.size;
  }

  public entries(): IterableIterator<[string, number]> {
    return this.#indexes.entries();
  }
}

/**
 * The scopes open at one point of a region while preparation walks it in instruction order: each scope's names in
 * declaration order, which are its slots. A name declared later in a scope is not yet visible, as at run time.
 */
export class ScopeTracker {
  readonly #scopes: string[][] = [[]];

  public constructor(
    /** The root scope's names for a function that sees its file's root, or `null` for the root region itself. */
    private readonly root: readonly string[] | null,
    private readonly globals: GlobalNames,
  ) {}

  public get depth(): number {
    return this.#scopes.length - 1;
  }

  public push(names: readonly string[] = []): void {
    this.#scopes.push([...names]);
  }

  public pop(): void {
    if (this.#scopes.length === 1) throw new NativePreparationError("a scope leaves the region's first scope");
    this.#scopes.pop();
  }

  /** Unwinds to `depth` open scopes above the first, as a loop's break or continue does. */
  public unwindTo(depth: number): void {
    if (depth > this.depth) throw new NativePreparationError("a jump enters a scope");
    this.#scopes.length = depth + 1;
  }

  /** Declares a name in the innermost scope and returns its slot. */
  public declare(name: string): number {
    const scope = this.#scopes.at(-1)!;
    if (scope.includes(name)) throw new NativePreparationError(`'${name}' is declared twice in one scope`);
    scope.push(name);
    return scope.length - 1;
  }

  public resolve(name: string): NameLocation {
    for (let depth = this.#scopes.length - 1; depth >= 0; depth -= 1) {
      const slot = this.#scopes[depth]!.indexOf(name);
      if (slot >= 0) return { kind: "local", depth, slot };
    }
    if (this.root !== null) {
      const slot = this.root.indexOf(name);
      if (slot >= 0) return { kind: "root", slot };
    }
    return { kind: "global", index: this.globals.index(name) };
  }

  /** The names of the first scope, which for the root region are its file's top-level variables. */
  public get firstScope(): readonly string[] {
    return this.#scopes[0]!;
  }
}
