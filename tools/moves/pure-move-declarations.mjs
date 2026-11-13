// The pure-move check's inputs: the `--declare` file's line and whole-file declarations and the `--renames` map, each
// checked, and the error that stops the check (exit 2).

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
