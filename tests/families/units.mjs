// A set's sources by its name, as the plans comparison (`plans.mjs`) and the stop runs (`stop-runs.mjs`) read a set:
// corpus (CASES_JSON), fixture (the base tree's tools/corpus/fixture), held (the base tree's `heldFamily()`), or an
// area's folder (its generators' sources at their own sizes, by the head tree's `sources.mjs`).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distOf = (root) => (existsSync(path.join(root, "dist")) ? path.join(root, "dist") : root);

/** The set's sources, each `{ name, files, globals, single, held? }`, the same list in every worker. */
export async function unitsOf(set, baseRoot, headRoot) {
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
