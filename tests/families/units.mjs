// A set's sources by its name, as the plans comparison (`plans.mjs`) and the stop runs (`stop-runs.mjs`) read a set:
// corpus (CASES_JSON), fixture (the base tree's tools/corpus/fixture), held (the base tree's `heldFamily()`), or an
// area's folder (its generators' sources at their own sizes, by the head tree's `sources.mjs`). Each unit carries its
// `key` (`sourceKey`, a baseline's identity of a source), which tells apart two units of one name (#2254).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sourceKey } from "./sources.mjs";

/** A tree's built modules: its `dist`, or the tree itself where it is one. */
export const distOf = (root) =>
  existsSync(path.join(root, "dist")) ? path.join(root, "dist") : root;

/** The set's sources, each `{ name, key, files, globals, single, held? }`, the same list in every worker. */
export async function unitsOf(set, baseRoot, headRoot) {
  return (await listed(set, baseRoot, headRoot)).map((unit) => ({ ...unit, key: sourceKey(unit) }));
}

async function listed(set, baseRoot, headRoot) {
  if (set === "corpus")
    return JSON.parse(readFileSync(process.env.CASES_JSON, "utf8")).map(({ name, files }) => ({
      name,
      files,
      globals: ["hostValue", "hostOther", "hostInit"],
      single: false,
    }));
  if (set === "fixture") {
    const fixture = await import(
      pathToFileURL(path.join(baseRoot, "tools", "corpus", "fixture", "fixture.mjs")).href
    );
    return fixture.cases.map(([name, files]) => ({
      name,
      files,
      globals: fixture.globals,
      single: false,
    }));
  }
  if (set === "held") {
    const held = await import(
      pathToFileURL(path.join(distOf(baseRoot), "tests", "helpers", "type-core-held-host.js")).href
    );
    return held
      .heldFamily()
      .map((c) => ({
        name: c.name,
        files: [{ path: "main.tease", source: c.source }],
        globals: ["hostValue", "hostOther"],
        single: true,
        held: true,
      }));
  }
  const { generatorsOf } = await import(
    pathToFileURL(path.join(headRoot, "tests", "families", "sources.mjs")).href
  );
  const units = [];
  for (const generator of await generatorsOf(set))
    for (const source of generator.sources)
      units.push({
        name: `${generator.name}/${source.name}`,
        files: source.files,
        globals: source.globals,
        single: false,
      });
  return units;
}

/**
 * The unit an item names in the tree at `root` (`stop-runs.mjs`, `differential.mjs`): `{ unit }` for `{files, globals}`, or for
 * `{set, name, key?}` the set's unit of that name and key; `{ keys }` where the units it matches differ.
 */
export function unitResolver(root) {
  // (an area of the tree's tests/families by its name, as `plans.mjs` reads a set)
  const setOf = (set) =>
    ["corpus", "fixture", "held"].includes(set) || set.includes("/")
      ? set
      : path.join(root, "tests", "families", set);
  const units = new Map();
  // (the item's unit, or the keys of every unit it matches when they differ; units with one key are one unit)
  const unitOf = async (item) => {
    if (item.files !== undefined)
      return { unit: { files: item.files, globals: item.globals, key: sourceKey(item) } };
    if (!units.has(item.set)) {
      const byName = new Map();
      for (const unit of await unitsOf(setOf(item.set), root, root))
        byName.set(unit.name, [...(byName.get(unit.name) ?? []), unit]);
      units.set(item.set, byName);
    }
    const matched = (units.get(item.set).get(item.name) ?? []).filter(
      (unit) => item.key === undefined || unit.key === item.key,
    );
    const keys = [...new Set(matched.map((unit) => unit.key))];
    return keys.length > 1 ? { keys } : { unit: matched[0] };
  };
  return unitOf;
}
