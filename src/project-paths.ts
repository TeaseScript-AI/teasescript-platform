/** The fixed entry file of every project (ADR 0022). */
export const MAIN_FILE_PATH = "main.tease";

const TEASE_EXTENSION = ".tease";

/**
 * Why `path` is not a package path, or `null` when it is one: a path relative to the package root that separates
 * folders with `/` and names a `.tease` file. `*` is reserved for globs.
 */
export function packagePathProblem(path: string): string | null {
  if (!path.endsWith(TEASE_EXTENSION) || path.split("/").at(-1) === TEASE_EXTENSION) {
    return "it does not name a .tease file";
  }
  return packageAssetPathProblem(path);
}

/** Why `path` is not a path of a package file, such as an image, or `null` when it is one; as for `.tease` files. */
export function packageAssetPathProblem(path: string): string | null {
  for (const segment of path.split("/")) {
    if (segment === "") return "it has an empty folder name; separate folders with a single /";
    if (segment === "." || segment === "..")
      return "paths start at the package root and use no . or ..";
  }
  if (path.includes("\\")) return "folders are separated with /, not \\";
  if (path.includes("*")) return "* is only allowed in a glob";
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return "it contains a control character";
  }
  return null;
}

/** Orders project files: `main.tease` first, then the other paths by UTF-16 code unit. */
export function compareProjectPaths(left: string, right: string): number {
  if (left === right) return 0;
  if (left === MAIN_FILE_PATH) return -1;
  if (right === MAIN_FILE_PATH) return 1;
  return left < right ? -1 : 1;
}

/** Whether a target path is a glob, where `*` stands for any characters within one folder or file name. */
export function isPathGlob(path: string): boolean {
  return path.includes("*");
}

/** Why a glob is not one of package paths, or `null` when it is one. */
export function packageGlobProblem(pattern: string): string | null {
  return packagePathProblem(pattern.replaceAll("*", "x"));
}

/** The paths a glob matches, in project order. */
export function globMatches(pattern: string, paths: Iterable<string>): string[] {
  const segments = pattern.split("/").map(
    (segment) =>
      new RegExp(
        `^${segment
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
          .join(".*")}$`,
        "su",
      ),
  );
  return [...paths]
    .filter((path) => {
      const parts = path.split("/");
      return (
        parts.length === segments.length &&
        parts.every((part, index) => segments[index]!.test(part))
      );
    })
    .sort(compareProjectPaths);
}
