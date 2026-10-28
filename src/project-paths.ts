/** The fixed entry file of every project (ADR 0022). */
export const MAIN_FILE_PATH = "main.tease";

/**
 * A package file or folder that the host could not load (#595), with `reason`: sentences that name it, say what is
 * wrong, and what to do, which are the message of its `TSC011`.
 */
export interface UnreadablePackageFile {
  readonly path: string;
  /** A folder, whose files the host could not list; `.` is the package root. */
  readonly folder?: boolean;
  readonly reason: string;
}

const TEASE_EXTENSION = ".tease";

/**
 * Why `path` is not a package path, or `null` when it is one: a path relative to the package root that separates
 * folders with `/` and names a `.tease` file. `*` is reserved for globs.
 */
export function packagePathProblem(path: string): string | null {
  if (!path.endsWith(TEASE_EXTENSION) || path.split("/").at(-1) === TEASE_EXTENSION) {
    return "the path does not name a .tease file";
  }
  return packageAssetPathProblem(path);
}

/** Why `path` is not a path of a package file, such as an image, or `null` when it is one; as for `.tease` files. */
export function packageAssetPathProblem(path: string): string | null {
  for (const segment of path.split("/")) {
    if (segment === "")
      return "the path has an empty folder name. Separate folders with a single '/'";
    if (segment === "." || segment === "..")
      return "paths start at the package root and use no '.' or '..'";
  }
  if (path.includes("\\")) return "folders are separated with '/', not '\\'";
  if (path.includes("*")) return "'*' is only allowed in a glob";
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return "the path contains a control character";
  }
  return null;
}

/**
 * Why a `goto` cannot go to `path`, a file of declarations only, which runs nothing on its own (V30 §29): one text for
 * the compile error and the runtime check.
 */
export function declarationsOnlyMessage(path: string): string {
  return `'${path}' holds declarations only and runs nothing, so going there would end nowhere. Use its global functions, speakers, and globals in any file without going there.`;
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
  const segments = pattern.split("/");
  return [...paths]
    .filter((path) => {
      const parts = path.split("/");
      return (
        parts.length === segments.length &&
        parts.every((part, index) => segmentMatches(segments[index]!, part))
      );
    })
    .sort(compareProjectPaths);
}

/** Whether `path`, written out, names the file the host could not load, or lies in the folder (#595). */
export function liesIn(path: string, entry: UnreadablePackageFile): boolean {
  return entry.folder === true
    ? entry.path === "." || path.startsWith(`${entry.path}/`)
    : path === entry.path;
}

/** Whether a glob matches the file the host could not load, or may match a path in the folder. */
export function globMayReach(pattern: string, entry: UnreadablePackageFile): boolean {
  if (entry.folder !== true) return globMatches(pattern, [entry.path]).length > 0;
  if (entry.path === ".") return true;
  const segments = pattern.split("/");
  const parts = entry.path.split("/");
  return (
    parts.length < segments.length &&
    parts.every((part, index) => segmentMatches(segments[index]!, part))
  );
}

/**
 * Whether a text with `${...}`, given as the texts around its `${...}`, may give `path`: it starts with the first text,
 * ends with the last, and holds the ones between in order, whatever the values give between them.
 */
export function textsMayName(texts: readonly string[], path: string): boolean {
  if (texts.length === 1) return path === texts[0];
  const first = texts[0]!;
  const last = texts.at(-1)!;
  if (path.length < first.length + last.length || !path.startsWith(first) || !path.endsWith(last))
    return false;
  let at = first.length;
  const end = path.length - last.length;
  for (let index = 1; index < texts.length - 1; index += 1) {
    const text = texts[index]!;
    const found = path.indexOf(text, at);
    if (found < 0 || found + text.length > end) return false;
    at = found + text.length;
  }
  return true;
}

/** Whether a text with `${...}`, as in {@link textsMayName}, may give the file the host could not load, or a path in the folder. */
export function textsMayReach(texts: readonly string[], entry: UnreadablePackageFile): boolean {
  if (texts.length === 1) return liesIn(texts[0]!, entry);
  if (entry.folder !== true) return textsMayName(texts, entry.path);
  if (entry.path === ".") return true;
  // A value may give the rest of the folder's path after a shorter first text.
  const folder = `${entry.path}/`;
  const first = texts[0]!;
  return first.length < folder.length ? folder.startsWith(first) : first.startsWith(folder);
}

/**
 * Whether one folder or file name matches a glob segment, where `*` stands for any characters. Each `*` resumes from
 * the latest one only, so the work stays proportional to the two lengths' product, without backtracking blowup.
 */
function segmentMatches(pattern: string, text: string): boolean {
  let patternIndex = 0;
  let textIndex = 0;
  let star = -1;
  let resume = 0;
  while (textIndex < text.length) {
    if (pattern[patternIndex] === "*") {
      star = patternIndex;
      patternIndex += 1;
      resume = textIndex;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === text[textIndex]) {
      patternIndex += 1;
      textIndex += 1;
    } else if (star >= 0) {
      patternIndex = star + 1;
      resume += 1;
      textIndex = resume;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}
