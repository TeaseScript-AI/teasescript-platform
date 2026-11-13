// The pure-move check's inputs: the `--declare` file's line and whole-file declarations and the `--renames` map, each
// checked, the line declarations bound to the lines that take them, and the error that stops the check (exit 2).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Why the check cannot be trusted: exit 2. */
export class CannotRun extends Error {}

/** The declarations of `path`, checked. */
export function declarationsOf(path) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CannotRun(
      `pure-move-check: the declarations ${path} cannot be read: ${error.message}`,
    );
  }
  if (!Array.isArray(entries)) throw new CannotRun(`pure-move-check: ${path} is not a JSON array`);
  for (const entry of entries) {
    const whole =
      entry?.whole === true &&
      typeof entry.file === "string" &&
      typeof entry.reason === "string" &&
      entry.reason.trim() !== "" &&
      !entry.reason.includes("\n") &&
      Object.keys(entry).every((key) => ["file", "whole", "reason"].includes(key));
    const ok =
      whole ||
      (entry !== null &&
        typeof entry === "object" &&
        typeof entry.file === "string" &&
        (entry.side === "added" || entry.side === "removed") &&
        typeof entry.text === "string" &&
        !entry.text.includes("\n") &&
        typeof entry.reason === "string" &&
        entry.reason.trim() !== "" &&
        !entry.reason.includes("\n") &&
        Object.keys(entry).every((key) => ["file", "side", "text", "reason"].includes(key)));
    if (entry !== null && typeof entry === "object" && Object.hasOwn(entry, "line"))
      throw new CannotRun(
        `pure-move-check: a declaration names its line by "text" now, not "line": replace "line" with that line's exact text, LF-delimited, in that side's blob (removed: the merge base; added: HEAD), keeping any CR: ${JSON.stringify(entry)}`,
      );
    if (!ok)
      throw new CannotRun(
        `pure-move-check: a declaration is not { file, side: "added" | "removed", text, reason } or { file, whole: true, reason }: ${JSON.stringify(entry)}`,
      );
  }
  return entries;
}

/** The renames of `path`, the move sweep's map: `{ "renames": { "old": "new" | ["new", …] } }`, checked. */
export function renamesOf(path) {
  let map;
  try {
    map = JSON.parse(readFileSync(path, "utf8")).renames;
  } catch (error) {
    throw new CannotRun(`pure-move-check: the renames ${path} cannot be read: ${error.message}`);
  }
  const ok =
    map !== null &&
    typeof map === "object" &&
    !Array.isArray(map) &&
    Object.values(map).every(
      (to) =>
        typeof to === "string" ||
        (Array.isArray(to) && to.length > 0 && to.every((one) => typeof one === "string")),
    );
  if (!ok)
    throw new CannotRun(`pure-move-check: ${path} is not { "renames": { old: new | [new, …] } }`);
  return map;
}

/**
 * The files declared whole (`entries`, each `{ file, whole, reason }`) among the change's `files`, each `{ file, added,
 * removed, reason }`; refused for a file the change adds, deletes or renames, one in the renames map (`renames`), one no
 * file of the change is, or a second entry for a file.
 */
export function wholeFiles(entries, files, renames) {
  // (a map path spelled another way, `./a.ts`, is the same path)
  const mapped = new Set(
    Object.entries(renames ?? {})
      .flatMap(([old, to]) => [old, ...[to].flat()])
      .map((file) => path.posix.normalize(file)),
  );
  const wholes = [];
  for (const { file, reason } of entries) {
    const change = files.find((c) => c.file === file || c.old === file);
    const refusal =
      change === undefined
        ? "matches no file of the change"
        : change.old !== change.file
          ? "is added, deleted or renamed by the change"
          : mapped.has(file)
            ? "is a path of the --renames map"
            : wholes.some((w) => w.file === file)
              ? "is declared whole twice"
              : null;
    if (refusal !== null)
      throw new CannotRun(
        `pure-move-check: ${file}, declared whole, ${refusal}: moved code is never declared away`,
      );
    wholes.push({
      file,
      added: change.addedLines.length,
      removed: change.removedLines.length,
      reason,
    });
  }
  return wholes;
}

/**
 * The line declarations of the change from `mergeBase` to `HEAD` (in `cwd`), each blob one names checked as UTF-8, bound
 * to the lines that take them: `declaredFor(entry)`, asked of a changed unmoved line no form admits, in diff order, binds
 * the first unbound declaration of its file, side and text and gives its reason, or `null`; `cover(refusal)` gives a
 * refused import's covering declaration, `{ reason, taken }` (`taken` when it binds one now), or `null`; `stale()`, the
 * declarations bound to no line.
 */
export function boundDeclarations(declarations, mergeBase, cwd) {
  // a declaration's text is compared exactly, and Git's diff and blobs, read as UTF-8, turn bytes that are not into
  // U+FFFD, which a declaration could then match: each blob a declaration names must decode without loss
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const key of new Set(declarations.map((d) => JSON.stringify([d.file, d.side])))) {
    const [file, side] = JSON.parse(key);
    const read = spawnSync(
      "git",
      ["cat-file", "blob", `${side === "removed" ? mergeBase : "HEAD"}:${file}`],
      { cwd, maxBuffer: 256 * 1024 * 1024 },
    );
    // (a file not on that side has no blob and stays unmatched; a gitlink has none either, but Git's line for it,
    // `Subproject commit …`, can be declared)
    if (read.status !== 0) continue;
    try {
      decoder.decode(read.stdout);
    } catch {
      throw new CannotRun(
        `pure-move-check: ${file} (${side}) is not UTF-8, so a declaration's text cannot be compared with its lines exactly`,
      );
    }
  }
  // each declaration binds to the one line it first matches, by the line's number on its side
  const bound = new Map();
  const declaredFor = (entry) => {
    const index = declarations.findIndex(
      (d, at) =>
        !bound.has(at) &&
        d.file === entry.file &&
        d.side === entry.side &&
        d.text === entry.row.text,
    );
    if (index === -1) return null;
    bound.set(index, entry.row.line);
    return declarations[index].reason;
  };
  // a refusal is declared by the declaration bound to its line, a changed one or not, else by one of its side and its
  // line's text bound to none, which it binds; each is printed with the refusal reason it covers
  const ofSide = (d, refusal) => d.file === refusal.file && d.side === refusal.side;
  const cover = (refusal) => {
    let index = declarations.findIndex(
      (d, at) => ofSide(d, refusal) && bound.get(at) === refusal.line,
    );
    let taken = false;
    if (index === -1) {
      index = declarations.findIndex(
        (d, at) => ofSide(d, refusal) && !bound.has(at) && d.text === refusal.text,
      );
      if (index !== -1) {
        bound.set(index, refusal.line);
        taken = true;
      }
    }
    return index === -1 ? null : { reason: declarations[index].reason, taken };
  };
  const stale = () => declarations.filter((_, at) => !bound.has(at));
  return { declaredFor, cover, stale };
}
