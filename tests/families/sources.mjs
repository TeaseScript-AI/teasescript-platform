// A generator's sources as the runner (`run.mjs`) runs them and the check (`check.mjs`) compares them.
import { createHash } from "node:crypto";

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
