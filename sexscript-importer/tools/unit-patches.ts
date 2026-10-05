/**
 * Manual patches of one converted unit: script-specific fixes that the converter must not contain (owner decision
 * 2026-10-05). They live in `patches/<unit>/patches.json`, apart from the generated package, so every reconversion
 * applies them again instead of overwriting them.
 *
 * Source patches are the default layer: unified diffs of the legacy files with paths from the unit folder
 * (`a/scripts/start.groovy`), applied before conversion by GNU patch without fuzz. Output edits are for additions that
 * have no legacy form: each replaces anchors in one generated file, names the hash of that file as the converter
 * generated it, and states how often each anchor occurs, so a converter change to the file or a moved anchor stops the
 * unit for review instead of patching the wrong place.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PATCH_MANIFEST = "patches.json";

export interface SourcePatch {
  readonly id: string;
  readonly layer: "source";
  readonly reason: string;
  readonly category?: string;
  /** The diff file in the unit's patch folder. */
  readonly diff: string;
}

export interface OutputEdit {
  readonly find: string;
  readonly replace: string;
  /** How often `find` occurs in the file at this point; every occurrence is replaced. */
  readonly count: number;
}

export interface OutputPatch {
  readonly id: string;
  readonly layer: "output";
  readonly reason: string;
  readonly category?: string;
  /** The generated file, by its path in the package. */
  readonly file: string;
  /** SHA-256 of the file as the converter generated it, before any output patch. */
  readonly baseHash: string;
  readonly edits: readonly OutputEdit[];
}

export type UnitPatch = SourcePatch | OutputPatch;

export interface UnitPatches {
  readonly folder: string;
  /** In manifest order; source patches apply before conversion and output patches after it, each in this order. */
  readonly patches: readonly UnitPatch[];
  /** SHA-256 of each patch by id: its diff file, or its manifest entry. */
  readonly hashes: ReadonlyMap<string, string>;
}

/** A patch that is invalid, stale, or does not apply. */
export class PatchError extends Error {}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The unit's patches, or null when it has no patch folder or manifest. */
export async function readUnitPatches(
  patchesRoot: string,
  unit: string,
): Promise<UnitPatches | null> {
  const folder = path.resolve(patchesRoot, unit);
  let text: string;
  try {
    text = await readFile(path.join(folder, PATCH_MANIFEST), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const where = `${path.join(unit, PATCH_MANIFEST)}`;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new PatchError(`${where} is not JSON: ${String(error)}`);
  }
  if (!isRecord(manifest) || !onlyKeys(manifest, ["patches"]) || !Array.isArray(manifest.patches))
    throw new PatchError(`${where} must be an object with a "patches" list`);
  const patches: UnitPatch[] = [];
  const hashes = new Map<string, string>();
  for (const [index, entry] of manifest.patches.entries()) {
    const patch = validPatch(entry, `${where} patch ${index + 1}`);
    if (hashes.has(patch.id)) throw new PatchError(`${where} repeats the patch id "${patch.id}"`);
    if (patch.layer === "source") {
      const diff = await readFile(path.join(folder, patch.diff)).catch(() => null);
      if (diff === null)
        throw new PatchError(`${where}: ${patch.diff} of "${patch.id}" is missing`);
      sourcePatchPaths(diff.toString("utf8"), `${unit}/${patch.diff}`);
      hashes.set(patch.id, sha256(diff));
    } else hashes.set(patch.id, sha256(JSON.stringify(entry)));
    patches.push(patch);
  }
  return { folder, patches, hashes };
}

/** The unit files a diff changes, by their paths from the unit folder. */
export function sourcePatchPaths(diff: string, where: string): string[] {
  const paths = new Set<string>();
  const lines = diff.split(/\r?\n/u);
  // A file header is a `---` line followed by a `+++` line; inside a hunk, such a pair would be a removed `-- `
  // line followed by an added `++ ` line.
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index]!.startsWith("--- ") || !lines[index + 1]!.startsWith("+++ ")) continue;
    for (const header of [lines[index]!, lines[index + 1]!]) {
      const name = header.slice(4).split("\t")[0]!.trim();
      if (name === "/dev/null") continue;
      const parts = name.split("/").slice(1);
      if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === ".."))
        throw new PatchError(`${where} names a path outside the unit: ${name}`);
      paths.add(parts.join("/"));
    }
    index += 1;
  }
  if (paths.size === 0) throw new PatchError(`${where} is not a unified diff`);
  return [...paths].sort();
}

/** Applies the source patches to a staged copy of the unit, whose patched files are copies of their own. */
export async function applySourcePatches(unitRoot: string, patches: UnitPatches): Promise<void> {
  for (const patch of patches.patches) {
    if (patch.layer !== "source") continue;
    const { exitCode, output } = await runPatch([
      "--batch",
      "--forward",
      "--fuzz=0",
      "--no-backup-if-mismatch",
      "--reject-file=-",
      "-p1",
      "-d",
      path.resolve(unitRoot),
      "-i",
      path.join(patches.folder, patch.diff),
    ]);
    if (exitCode !== 0)
      throw new PatchError(`source patch "${patch.id}" does not apply: ${output.trim()}`);
  }
}

/** Applies the output patches to a converted package, after checking every patched file against its base hash. */
export async function applyOutputPatches(packageRoot: string, patches: UnitPatches): Promise<void> {
  const output = patches.patches.filter((patch): patch is OutputPatch => patch.layer === "output");
  const texts = new Map<string, string>();
  for (const patch of output) {
    if (!texts.has(patch.file)) {
      const text = await readFile(path.join(packageRoot, patch.file), "utf8").catch(() => null);
      if (text === null)
        throw new PatchError(
          `output patch "${patch.id}" edits ${patch.file}, which the converter no longer generates`,
        );
      texts.set(patch.file, text);
    }
    const generated = sha256(texts.get(patch.file)!);
    if (generated !== patch.baseHash)
      throw new PatchError(
        `output patch "${patch.id}" was written for another version of ${patch.file} (now ${generated}); review it and update its baseHash`,
      );
  }
  for (const patch of output) {
    let text = texts.get(patch.file)!;
    for (const edit of patch.edits) {
      const found = text.split(edit.find).length - 1;
      if (found !== edit.count)
        throw new PatchError(
          `output patch "${patch.id}" expects ${edit.count} of ${JSON.stringify(edit.find)} in ${patch.file}, found ${found}`,
        );
      text = text.split(edit.find).join(edit.replace);
    }
    texts.set(patch.file, text);
  }
  for (const [file, text] of texts) await writeFile(path.join(packageRoot, file), text);
}

function validPatch(entry: unknown, where: string): UnitPatch {
  if (!isRecord(entry)) throw new PatchError(`${where} must be an object`);
  const { id, layer, reason, category } = entry;
  if (typeof id !== "string" || id === "") throw new PatchError(`${where} needs an "id"`);
  if (typeof reason !== "string" || reason === "")
    throw new PatchError(`${where} ("${id}") needs a "reason"`);
  if (category !== undefined && typeof category !== "string")
    throw new PatchError(`${where} ("${id}") has a "category" that is not text`);
  const common = { id, reason, ...(category === undefined ? {} : { category }) };
  if (layer === "source") {
    if (!onlyKeys(entry, ["id", "layer", "reason", "category", "diff"]))
      throw new PatchError(`${where} ("${id}") has fields a source patch does not use`);
    if (typeof entry.diff !== "string" || !isInside(entry.diff))
      throw new PatchError(`${where} ("${id}") needs a "diff" file inside the unit's patch folder`);
    return { ...common, layer, diff: entry.diff };
  }
  if (layer !== "output")
    throw new PatchError(`${where} ("${id}") needs the layer "source" or "output"`);
  if (!onlyKeys(entry, ["id", "layer", "reason", "category", "file", "baseHash", "edits"]))
    throw new PatchError(`${where} ("${id}") has fields an output patch does not use`);
  const { file, baseHash, edits } = entry;
  if (typeof file !== "string" || !isInside(file) || !file.endsWith(".tease"))
    throw new PatchError(`${where} ("${id}") needs a generated .tease "file" inside the package`);
  if (typeof baseHash !== "string" || !/^[0-9a-f]{64}$/u.test(baseHash))
    throw new PatchError(`${where} ("${id}") needs the SHA-256 "baseHash" of the generated file`);
  if (!Array.isArray(edits) || edits.length === 0)
    throw new PatchError(`${where} ("${id}") needs a list of "edits"`);
  return {
    ...common,
    layer,
    file,
    baseHash,
    edits: edits.map((edit, index) => validEdit(edit, `${where} ("${id}") edit ${index + 1}`)),
  };
}

function validEdit(edit: unknown, where: string): OutputEdit {
  if (!isRecord(edit) || !onlyKeys(edit, ["find", "replace", "count"]))
    throw new PatchError(`${where} must be an object with "find", "replace", and "count"`);
  const { find, replace, count } = edit;
  if (typeof find !== "string" || typeof replace !== "string")
    throw new PatchError(`${where} needs "find" and "replace" text`);
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1)
    throw new PatchError(`${where} needs the expected "count" of its anchor`);
  // Generated notes and TODO lines move as the converter changes, so an anchor needs code of its own.
  const anchored = find
    .split("\n")
    .some((line) => line.trim() !== "" && !/^\s*\/\/\s*(?:NOTE|TODO)\b/u.test(line));
  if (!anchored)
    throw new PatchError(`${where} needs an anchor with code, not only notes or TODOs`);
  return { find, replace, count };
}

/** A relative path that stays inside its folder. */
function isInside(file: string): boolean {
  const parts = file.split("/");
  return (
    !path.isAbsolute(file) &&
    !file.includes("\\") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runPatch(args: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile("patch", args, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ exitCode: code, output: `${stdout}${stderr}` || String(error ?? "") });
    });
  });
}
