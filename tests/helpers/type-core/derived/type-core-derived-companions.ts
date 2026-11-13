// The derivation's companions of a record's source (`companions`): variants of the program that keep every span, each
// run by the rules beside the original.

import { Underivable, type Syntax, allStatements, storeOf, unwrap, expressions } from "./type-core-derived.js";

// ------------------------------------------------------------------------------------------------ the companions

/** A companion of a record's source: its text and the host globals it reads, each read its own input. */
export interface Companion {
  readonly label: string;
  readonly source: string;
  readonly globals: readonly string[];
  /** Whether `say "AFTER"` was inserted before the final `exit`: the next effect a fitting run reaches. */
  readonly after: boolean;
}

const HOST = "hostValue";

function replaced(source: string, edits: readonly (readonly [number, number, string])[]): string {
  let out = source;
  for (const [start, end, text] of [...edits].sort((a, b) => b[0] - a[0])) {
    if (text.length !== end - start) throw new Error("a companion keeps every span");
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

/**
 * The derivation's companions, from the source alone: every host read after the first renamed to a same-length global
 * (`hostValu2`, …); every constant index of a list literal given each element index of the same width; every number
 * literal a store writes whole given a same-width whole-valued number spelling, `1.0` for `1.5` (the numeric kind
 * stays `number`, so the record's decisions stay the same); and `say "AFTER"` inserted before
 * a final `exit` where the program does not exit first. The original itself is not a companion: it runs as written.
 */
export function companions({ source, statements }: Syntax): readonly Companion[] {
  const all = expressions(statements);
  const hosts = all.filter(
    (expression) => expression.kind === "identifier" && expression.name === HOST,
  );
  const renames: (readonly [number, number, string])[] = hosts.slice(1).map((host, index) => {
    const name = `hostValu${index + 2}`;
    if (name.length !== HOST.length)
      throw new Underivable("more host reads than same-length names");
    return [host.span.start.offset, host.span.end.offset, name] as const;
  });
  const globals = [HOST, ...renames.map(([, , name]) => name)];
  const choices: (readonly (readonly [number, number, string] | null)[])[] = [];
  for (const expression of all) {
    if (expression.kind !== "indexExpression") continue;
    const list = unwrap(expression.object);
    const index = unwrap(expression.index);
    if (list.kind !== "listLiteral" || index.kind !== "numberLiteral") continue;
    const width = index.span.end.offset - index.span.start.offset;
    choices.push([
      null,
      ...list.elements
        .map((_, position) => String(position))
        .filter((text) => text.length === width && text !== index.raw)
        .map((text) => [index.span.start.offset, index.span.end.offset, text] as const),
    ]);
  }
  for (const expression of all) {
    if (
      expression.kind !== "numberLiteral" ||
      expression.numericType !== "number" ||
      !allStatements(statements).some((statement) => storeOf(statement)?.value === expression)
    )
      continue;
    if (Number.isInteger(expression.value)) continue;
    const spelling = `${Math.trunc(expression.value)}.0`;
    if (spelling.length !== expression.raw.length) continue;
    choices.push([
      null,
      [expression.span.start.offset, expression.span.end.offset, spelling] as const,
    ]);
  }
  const top = statements;
  const last = top.at(-1);
  const after = last?.kind === "exitStatement" && top[0]?.kind !== "exitStatement";
  const out: Companion[] = [];
  const product = (at: number, picked: readonly (readonly [number, number, string])[]): void => {
    if (at === choices.length) {
      let text = replaced(source, [...renames, ...picked]);
      if (after) {
        const exit = last!.span.start.offset;
        text = `${text.slice(0, exit)}say "AFTER"\n${text.slice(exit)}`;
      }
      out.push({
        label:
          [
            ...picked.map(([start, , spelled]) => `${start}:${spelled}`),
            ...(after ? ["AFTER"] : []),
          ].join(" ") || "renamed",
        source: text,
        globals,
        after,
      });
      return;
    }
    for (const choice of choices[at]!)
      product(at + 1, choice === null ? picked : [...picked, choice]);
  };
  product(0, []);
  return out;
}
