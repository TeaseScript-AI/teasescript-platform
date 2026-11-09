// A generator's sources as the runner (`run.mjs`) runs them and the check (`check.mjs`) compares them, and the folders
// that hold generators, as the check and the baselines (`baselines.mjs`) find them.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The host globals a source may read, unless its case or its generator gives its own (`globals`). */
export const GLOBALS = ["hostValue", "hostOther", "hostInit", "otherHost"];

/**
 * A generator's sources: its fixed `cases` (`[name, source or files, globals?]`), and each of its `shapes` at each size
 * (`sizes`, else its own), each with the globals it runs with: its case's, else its generator's, else the default.
 */
export function sourcesOf(generator, sizes) {
  const files = (value) =>
    typeof value === "string" ? [{ path: "main.tease", source: value }] : value;
  const globals = generator.globals ?? GLOBALS;
  const cases = (generator.cases ?? []).map(([name, value, own]) => ({
    name,
    files: files(value),
    globals: own ?? globals,
  }));
  const shapes = generator.shapes ?? {};
  const sized = (sizes ?? generator.sizes ?? [4, 8]).flatMap((size) =>
    Object.entries(shapes).map(([name, shape]) => ({
      name: `${name}@${size}`,
      files: files(shape(size)),
      globals,
    })),
  );
  return [...cases, ...sized];
}

/** A source's identity: the sha256 of its files' paths and texts, in their order, and of its globals. */
export function sourceKey({ files, globals }) {
  return createHash("sha256")
    .update(JSON.stringify([files.map((file) => [file.path, file.source]), globals]))
    .digest("hex");
}

/** A set of sources' identity: the sha256 of their sorted keys, one per line. */
export function setKey(keys) {
  return createHash("sha256")
    .update([...keys].sort().join("\n"))
    .digest("hex");
}

/** A source's place in a baseline: its generator, its name and its key, so that an edited source is a new one. */
export const placeOf = (generator, source) =>
  JSON.stringify([generator, source.name, sourceKey(source)]);

/** Whether `folder` holds a generator: a `.mjs` file. A folder of data only holds none. */
export const holdsGenerators = (folder) =>
  existsSync(folder) && readdirSync(folder).some((name) => name.endsWith(".mjs"));

/**
 * The runner's areas under `families` (a tree's `tests/families`): each subfolder that holds a generator, in the order
 * the folder lists them. Every `.mjs` file in such a folder is a generator (`generatorsOf`), so a utility stays outside
 * them (#1786, #1865).
 */
export const generatorFolders = (families) =>
  (existsSync(families) ? readdirSync(families, { withFileTypes: true }) : [])
    .filter((entry) => entry.isDirectory() && holdsGenerators(path.join(families, entry.name)))
    .map((entry) => path.join(families, entry.name));

/**
 * An area folder's generators, each by its id (`name`): its `id` export, which a renamed generator keeps as its old file
 * name so that its sources keep their places in a baseline (`placeOf`), else its file name. In id order, each with its
 * file, its checks and every source (`sourcesOf`); two generators with one id are refused.
 */
export async function generatorsOf(folder, sizes) {
  const generators = [];
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".mjs"))) {
    const generator = await import(pathToFileURL(path.join(folder, file)).href);
    const name = typeof generator.id === "string" && generator.id !== "" ? generator.id : file;
    const checks = generator.checks ?? ["publication"];
    generators.push({ name, file, checks, sources: sourcesOf(generator, sizes) });
  }
  generators.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const [index, generator] of generators.entries())
    if (index > 0 && generators[index - 1].name === generator.name)
      throw new Error(
        `${folder}: ${generators[index - 1].file} and ${generator.file} have one id, ${generator.name}`,
      );
  return generators;
}

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
      pathToFileURL(
        path.join(
          existsSync(path.join(baseRoot, "dist")) ? path.join(baseRoot, "dist") : baseRoot,
          "tests",
          "helpers",
          "type-core-held-host.js",
        ),
      ).href
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
