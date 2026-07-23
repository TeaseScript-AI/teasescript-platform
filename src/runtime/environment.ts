import type { RuntimeValue } from "./values.js";

export class Environment {
  readonly #values = new Map<string, RuntimeValue>();

  public constructor(private readonly parent: Environment | null = null) {}

  public hasVisible(name: string): boolean {
    return this.#values.has(name) || (this.parent?.hasVisible(name) ?? false);
  }

  public declare(name: string, value: RuntimeValue): boolean {
    if (this.hasVisible(name)) return false;
    this.#values.set(name, value);
    return true;
  }

  public get(name: string): RuntimeValue | undefined {
    if (this.#values.has(name)) return this.#values.get(name);
    return this.parent?.get(name);
  }

  public assign(name: string, value: RuntimeValue): boolean {
    if (this.#values.has(name)) {
      this.#values.set(name, value);
      return true;
    }
    return this.parent?.assign(name, value) ?? false;
  }
}
