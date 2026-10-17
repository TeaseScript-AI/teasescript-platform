import { isPure } from "./dead-code.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "./ir.ts";
import { keysRead } from "./profile.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * Keys under which legacy scripts read a player setting that the importer's profile (profile.ts) saves under another
 * (coordinator decisions 2026-10-16):
 * - the desktop distribution 1.2 renamed the toy chest's `toys.clothpins` to `toys.clothespins` ("Clothings - mistake
 *   … clothpins/clothespins");
 * - other menu distributions kept the player's own settings under `user.*`: gender, attractions and first name.
 *
 * A package that saves none of a group's old keys itself reads the profile's keys instead, so the profile asks them.
 * A package with its own `user.*` setup, such as SexScriptsEnhancedMenu, keeps its keys. Only literal saves count: the
 * corpus's computed toy saves (`toys.${it}` in Domme3 and DW_intro) go over lists without an old key.
 */
const GROUPS: ReadonlyArray<ReadonlyMap<string, string>> = [
  new Map([["toys.clothpins", "toys.clothespins"]]),
  new Map([
    ["user.female", "intro.female"],
    ["user.likefemale", "intro.likefemale"],
    ["user.likemale", "intro.likemale"],
    ["user.firstname", "intro.name"],
    // The player's gender term, which the profile sets from intro.female (below).
    ["user.boygirl", ""],
  ]),
];

/** The legacy load helpers whose first argument is the key; sexscriptLegacyLoadFirstTrue takes a list of keys. */
const KEY_HELPERS = new Set([
  "sexscriptLegacyLoad",
  "sexscriptLegacyLoadFloat",
  "sexscriptLegacyLoadInteger",
  "sexscriptLegacyLoadIntegerOr",
]);

export function withProfileKeys(programs: readonly MigrationProgram[]): MigrationProgram[] {
  const saved = new Set(programs.flatMap((program) => [...savedKeys(program.statements)]));
  const renamed = new Map(
    GROUPS.filter((group) => ![...group.keys()].some((key) => saved.has(key))).flatMap((group) => [
      ...group,
    ]),
  );
  if (renamed.size === 0) return [...programs];
  // `user.boygirl` reads `player.boyGirl` where the profile gives the player a gender: where the package reads
  // intro.female, once the user.* keys read the profile's, and does not save it itself.
  let gendered = false;
  const key = (value: IrExpression): IrExpression => {
    if (value.kind !== "literal" || typeof value.value !== "string") return value;
    const to = renamed.get(value.value);
    return to === undefined || to === "" ? value : { ...value, value: to };
  };
  const rewrite = (value: IrExpression): IrExpression => {
    const next = mapChildren(value, rewrite);
    if (next.kind === "load") {
      if (
        gendered &&
        renamed.has("user.boygirl") &&
        next.key.kind === "literal" &&
        next.key.value === "user.boygirl"
      )
        return {
          kind: "property",
          target: { kind: "variable", name: "player", builtin: true },
          name: "boyGirl",
        };
      return { ...next, key: key(next.key) };
    }
    if (next.kind === "call" && KEY_HELPERS.has(next.name) && next.positional.length > 0)
      return { ...next, positional: [key(next.positional[0]!), ...next.positional.slice(1)] };
    if (next.kind === "call" && next.name === "sexscriptLegacyLoadFirstTrue") {
      const [list, ...rest] = next.positional;
      if (list?.kind === "list") {
        // A key that the old and the new name both gave is tested once: the first that holds is the same.
        const items = list.items
          .map(key)
          .filter(
            (item, index, all) =>
              all.findIndex((other) => JSON.stringify(other) === JSON.stringify(item)) === index,
          );
        return { ...next, positional: [{ ...list, items }, ...rest] };
      }
    }
    // A test that read the old key beside the new one, `load("intro.female") or load("user.female")`, reads it once.
    if (
      next.kind === "binary" &&
      (next.operator === "or" || next.operator === "and") &&
      JSON.stringify(next) !== JSON.stringify(value) &&
      JSON.stringify(next.left) === JSON.stringify(next.right) &&
      isPure(next.left)
    )
      return next.left;
    return next;
  };
  const block = (items: IrStatement[]): IrStatement[] =>
    items.map((item) => mapOwnExpressions(withNestedBlocks(item, block), rewrite));
  const rewritten = programs.map((program) => ({
    ...program,
    statements: block(program.statements),
  }));
  if (!renamed.has("user.boygirl") || saved.has("intro.female")) return rewritten;
  gendered = rewritten.some((program) => keysRead(program).has("intro.female"));
  return gendered
    ? rewritten.map((program) => ({ ...program, statements: block(program.statements) }))
    : rewritten;
}

/** The literal keys the statements save or delete. */
function savedKeys(statements: readonly IrStatement[]): Set<string> {
  const keys = new Set<string>();
  const visit = (items: IrStatement[]): IrStatement[] => {
    for (const item of items) {
      if (
        (item.kind === "save" || item.kind === "delete") &&
        item.key.kind === "literal" &&
        typeof item.key.value === "string"
      )
        keys.add(item.key.value);
      withNestedBlocks(item, visit);
    }
    return items;
  };
  visit([...statements]);
  return keys;
}
