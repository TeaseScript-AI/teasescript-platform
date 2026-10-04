import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ProjectImageFile } from "../src/image-catalog.js";
import { packageAssetPathProblem } from "../src/project-paths.js";
import {
  readImageXmpKeywords,
  readXmpPacketKeywords,
  type XmpKeywordsResult,
} from "../src/xmp-keywords.js";

/** The file types the development image folder offers, by lowercase extension. */
export const IMAGE_FOLDER_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".svg",
]);

/** An SVG image's tags come from its sidecar only. */
const SIDECAR_ONLY: XmpKeywordsResult = { kind: "none" };

export interface ImageFolderCatalog {
  readonly images: readonly ProjectImageFile[];
  /** Images whose tags could not be read, each listed without tags, or that were skipped, with the reason. */
  readonly problems: readonly { readonly path: string; readonly message: string }[];
}

/**
 * The temporary development image folder of #572: a folder on the server whose images a session may show and pick by
 * tag, until Laravel stores uploaded images and their tags. Each scan reads the folder again; the keywords of a file
 * whose identity, size, and change time are unchanged are reused.
 */
export class ImageFolder {
  readonly #cache = new Map<
    string,
    { readonly version: string; readonly result: XmpKeywordsResult }
  >();

  public constructor(readonly root: string) {}

  /**
   * Every readable image below the folder, by its path relative to it, in path order, with the keywords of its
   * sidecar named after the whole file (`room.jpg.xmp`) when it has one, and otherwise of its embedded XMP. What
   * cannot be read is listed in `problems` instead.
   */
  public async scan(): Promise<ImageFolderCatalog> {
    const problems: { path: string; message: string }[] = [];
    const files = await listFiles(this.root, problems);
    const present = new Set(files);
    for (const path of this.#cache.keys()) if (!present.has(path)) this.#cache.delete(path);
    const images: ProjectImageFile[] = [];
    for (const path of files) {
      if (!IMAGE_FOLDER_EXTENSIONS.has(extname(path).toLowerCase())) continue;
      const problem = packageAssetPathProblem(path);
      if (problem !== null) {
        problems.push({ path, message: `Skipped: ${problem}.` });
        continue;
      }
      const sidecar = `${path}.xmp`;
      let result: XmpKeywordsResult;
      try {
        result = present.has(sidecar)
          ? await this.#read(sidecar, readXmpPacketKeywords)
          : extname(path).toLowerCase() === ".svg"
            ? SIDECAR_ONLY
            : await this.#read(path, readImageXmpKeywords);
      } catch (error) {
        problems.push({ path, message: `Skipped: it cannot be read${errorCode(error)}.` });
        continue;
      }
      images.push({ path, keywords: result.kind === "keywords" ? result.keywords : [] });
      if (result.kind === "unsupported" || result.kind === "invalid") {
        problems.push({ path, message: result.reason });
      }
    }
    return { images, problems };
  }

  async #read(
    path: string,
    reader: (bytes: Uint8Array) => XmpKeywordsResult,
  ): Promise<XmpKeywordsResult> {
    const file = join(this.root, path);
    const information = await stat(file);
    // An editor may keep the modification time and size; the change time and inode still change.
    const version = `${information.ino}:${information.size}:${information.mtimeMs}:${information.ctimeMs}`;
    const cached = this.#cache.get(path);
    if (cached?.version === version) return cached.result;
    const result = reader(await readFile(file));
    this.#cache.set(path, { version, result });
    return result;
  }
}

/**
 * The regular files below `root`, by `/`-separated relative path, in UTF-16 order; hidden entries and links are left
 * out. A folder that cannot be read is reported in `problems`; `.` stands for the root.
 */
async function listFiles(
  root: string,
  problems: { path: string; message: string }[],
): Promise<string[]> {
  const files: string[] = [];
  const folders = [""];
  while (folders.length > 0) {
    const folder = folders.pop()!;
    let entries;
    try {
      entries = await readdir(join(root, folder), { withFileTypes: true });
    } catch (error) {
      problems.push({
        path: folder === "" ? "." : folder,
        message: `The folder cannot be read${errorCode(error)}.`,
      });
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) folders.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The system error code, such as ` (EACCES)`, or nothing. */
function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? ` (${error.code})`
    : "";
}
