import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ProjectSourceFile } from "../src/compiler.js";
import type { ProjectImageFile } from "../src/image-catalog.js";
import { packageAssetPathProblem } from "../src/project-paths.js";
import {
  readImageXmpKeywords,
  readXmpPacketKeywords,
  type XmpKeywordsResult,
} from "../src/xmp-keywords.js";
import type { PackageCatalog, PackageProblem } from "./package-catalog.js";

/** The image file types of the development package folder, by lowercase extension. */
export const PACKAGE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".svg",
]);

/**
 * The audio and video file types of a development package, by lowercase extension: those the accepted language
 * specification names for audio and video files.
 */
export const PACKAGE_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".webm",
]);

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** An SVG image's tags come from its sidecar only. */
const SIDECAR_ONLY: XmpKeywordsResult = { kind: "none" };

/**
 * The temporary development package folder of #572: the package root on the server (ADR 0022), whose `.tease` files a
 * session runs and whose images it may show and pick by tag, until Laravel stores uploaded packages, images, and their
 * tags. Each scan reads the folder again; the keywords of a file whose identity, size, and change time are unchanged
 * are reused.
 */
export class PackageFolder {
  readonly #cache = new Map<
    string,
    { readonly version: string; readonly result: XmpKeywordsResult }
  >();

  public constructor(readonly root: string) {}

  /**
   * Every readable image, audio or video file, and `.tease` file below the folder, by its path relative to it, in path
   * order. An image has
   * the keywords of its sidecar named after the whole file (`room.jpg.xmp`) when it has one, and otherwise of its
   * embedded XMP. What cannot be read is listed in `problems` instead.
   */
  public async scan(): Promise<PackageCatalog> {
    const problems: PackageProblem[] = [];
    const files = await listFiles(this.root, problems);
    const present = new Set(files);
    for (const path of this.#cache.keys()) if (!present.has(path)) this.#cache.delete(path);
    const images: ProjectImageFile[] = [];
    const media: string[] = [];
    const sources: ProjectSourceFile[] = [];
    for (const path of files) {
      const extension = extname(path).toLowerCase();
      if (extension === ".tease") {
        // A path that is not a package path stays listed: compiling the project reports it.
        try {
          sources.push({ path, source: UTF8.decode(await readFile(join(this.root, path))) });
        } catch (error) {
          problems.push({
            path,
            message:
              error instanceof TypeError
                ? "Skipped: it is not UTF-8 text."
                : `Skipped: it cannot be read${errorCode(error)}.`,
          });
        }
        continue;
      }
      const isMedia = PACKAGE_MEDIA_EXTENSIONS.has(extension);
      if (!isMedia && !PACKAGE_IMAGE_EXTENSIONS.has(extension)) continue;
      const problem = packageAssetPathProblem(path);
      if (problem !== null) {
        problems.push({ path, message: `Skipped: ${problem}.` });
        continue;
      }
      if (isMedia) {
        media.push(path);
        continue;
      }
      const sidecar = `${path}.xmp`;
      let result: XmpKeywordsResult;
      try {
        result = present.has(sidecar)
          ? await this.#read(sidecar, readXmpPacketKeywords)
          : extension === ".svg"
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
    return { images, media, sources, problems };
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
 * A folder of development packages (#570): each direct subfolder that is neither hidden nor a link is one package, by
 * its folder name. Each package has its own `PackageFolder`, so its keyword cache follows its own scans.
 */
export class PackageRoot {
  readonly #packages = new Map<string, PackageFolder>();

  public constructor(readonly root: string) {}

  /** The package `id`, or `null` when the root has no such package. */
  public async package(id: string): Promise<PackageFolder | null> {
    if (!isPackageId(id)) return null;
    const path = join(this.root, id);
    // lstat does not follow a link, so a link is no folder here.
    const information = await lstat(path).catch(() => null);
    if (information?.isDirectory() !== true) {
      this.#packages.delete(id);
      return null;
    }
    let folder = this.#packages.get(id);
    if (folder === undefined) {
      folder = new PackageFolder(path);
      this.#packages.set(id, folder);
    }
    return folder;
  }
}

/** Whether `id` can name a package of a root: one folder name that is not hidden. */
export function isPackageId(id: string): boolean {
  return id !== "" && !id.startsWith(".") && !/[/\\\0]/u.test(id);
}

/**
 * The regular files below `root`, by `/`-separated relative path, in UTF-16 order; hidden entries and links are left
 * out. A folder that cannot be read is reported in `problems`; `.` stands for the root.
 */
async function listFiles(root: string, problems: PackageProblem[]): Promise<string[]> {
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
