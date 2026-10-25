import type {
  ForStatement,
  FunctionParameter,
  GlobalStatement,
  Identifier,
  LetStatement,
  SpeakerDeclaration,
} from "../ast.js";

// What a number derives from (ADR 0021 rule 1.2): the variables without a type annotation and the parts inside them.

/**
 * What a number may derive from (ADR 0021 rule 1.2): a variable without a type annotation, or an element or property
 * inside one.
 */
export type Origin = Declaration | PartOrigin;

/**
 * The declaration of a variable without a type annotation: `let`, `global`, a parameter with a default, or a loop
 * variable: the `for` statement for its first variable, and the identifier of a pair loop's value variable. A speaker's
 * declaration stands for the object of its custom properties (V30 §37).
 */
export type Declaration =
  | LetStatement
  | GlobalStatement
  | FunctionParameter
  | ForStatement
  | Identifier
  | SpeakerDeclaration;

/**
 * An element or property inside a variable without a type annotation, which a number may derive from: the variable and
 * the steps to the part, each a property name or `[]` for the elements of a list or set.
 */
export interface PartOrigin {
  readonly root: Declaration;
  readonly path: readonly string[];
}

/**
 * What a number derives from: origins that merge without copying, so a long sum stays cheap, and that keep every
 * origin they merged, so no dependency of a widening is lost.
 */
export class Origins implements Iterable<Origin> {
  /** The origin of a group of one. */
  readonly origin: Origin | undefined;
  /** The groups this one merged. */
  readonly parts: readonly Origins[];

  private constructor(origin: Origin | undefined, parts: readonly Origins[]) {
    this.origin = origin;
    this.parts = parts;
  }

  static of(origin: Origin): Origins {
    return new Origins(origin, []);
  }

  /** These origins and the other ones. */
  merge(other: Origins | undefined): Origins {
    return other === undefined || other === this ? this : new Origins(undefined, [this, other]);
  }

  /** Each origin once, also when merged groups share parts. */
  *[Symbol.iterator](): Iterator<Origin> {
    const seen = new Set<Origins>();
    const found = new Set<Origin>();
    const pending: Origins[] = [this];
    while (pending.length > 0) {
      const group = pending.pop()!;
      if (seen.has(group)) continue;
      seen.add(group);
      if (group.origin !== undefined && !found.has(group.origin)) {
        found.add(group.origin);
        yield group.origin;
      }
      for (const part of group.parts) pending.push(part);
    }
  }
}

export function mergedOrigins(
  left: Origins | undefined,
  right: Origins | undefined,
): Origins | undefined {
  return left === undefined ? right : left.merge(right);
}
