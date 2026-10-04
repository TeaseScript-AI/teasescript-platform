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
 * tag, until Laravel stores uploaded images and their tags. Each scan reads the folder again; an unchanged file's
 * keywords are reused.
 */
export class ImageFolder {
  readonly #cache = new Map<
    string,
    { readonly modified: number; readonly size: number; readonly result: XmpKeywordsResult }
  >();

  public constructor(readonly root: string) {}

  /**
   * Every image below the folder, by its path relative to it, in path order, with the keywords of its sidecar named
   * after the whole file (`room.jpg.xmp`) when it has one, and otherwise of its embedded XMP.
   */
  public async scan(): Promise<ImageFolderCatalog> {
    const files = await listFiles(this.root);
    const present = new Set(files);
    const images: ProjectImageFile[] = [];
    const problems: { path: string; message: string }[] = [];
    for (const path of files) {
      if (!IMAGE_FOLDER_EXTENSIONS.has(extname(path).toLowerCase())) continue;
      const problem = packageAssetPathProblem(path);
      if (problem !== null) {
        problems.push({ path, message: `Skipped: ${problem}.` });
        continue;
      }
      const sidecar = `${path}.xmp`;
      const result = present.has(sidecar)
        ? await this.#read(sidecar, readXmpPacketKeywords)
        : extname(path).toLowerCase() === ".svg"
          ? SIDECAR_ONLY
          : await this.#read(path, readImageXmpKeywords);
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
    const cached = this.#cache.get(path);
    if (cached?.modified === information.mtimeMs && cached.size === information.size) {
      return cached.result;
    }
    const result = reader(await readFile(file));
    this.#cache.set(path, { modified: information.mtimeMs, size: information.size, result });
    return result;
  }
}

/** The regular files below `root`, by `/`-separated relative path, in UTF-16 order; hidden entries and links are left out. */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const folders = [""];
  while (folders.length > 0) {
    const folder = folders.pop()!;
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) folders.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
