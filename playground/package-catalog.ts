import type { ProjectSourceFile } from "../src/compiler.js";
import type { ProjectImageFile } from "../src/image-catalog.js";

/**
 * What the playground server lists of a development package: its images, its audio and video files, its `.tease`
 * files, and what it skipped.
 */
export interface PackageCatalog {
  readonly images: readonly ProjectImageFile[];
  /** Every audio and video file, by its path. */
  readonly media: readonly string[];
  /** Every `.tease` file; `compileProject` reports a path that is not a package path. */
  readonly sources: readonly ProjectSourceFile[];
  /** Files and folders that could not be read, and images whose tags could not be read, with the reason. */
  readonly problems: readonly PackageProblem[];
}

export interface PackageProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * The URL of a development package route, `catalog.json` or `files/<path>`: of the package `id` of the server's
 * package root, or of its single package folder when `id` is `null`.
 */
function developmentPackageUrl(id: string | null, route: string): string {
  return `/dev-package/${id === null ? "" : `${encodeURIComponent(id)}/`}${route}`;
}

/** The URL at which the server offers a package image, audio, or video file, by its package path. */
export function developmentPackageFileUrl(id: string | null, path: string): string {
  return developmentPackageUrl(id, `files/${path.split("/").map(encodeURIComponent).join("/")}`);
}

/**
 * Loads the catalog of a development package, or `null` when the server offers no such package. Other failures reject
 * with a message that says why.
 */
export async function fetchDevelopmentPackage(id: string | null): Promise<PackageCatalog | null> {
  const response = await fetch(developmentPackageUrl(id, "catalog.json"), { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`The package request failed with HTTP ${response.status}.`);
  const catalog = packageCatalog(await response.json());
  if (catalog === null) throw new Error("The server's package catalog is malformed.");
  return catalog;
}

/** Loads the catalog of the package `id` of the server's package root; a missing package rejects too. */
export async function loadDevelopmentPackage(id: string): Promise<PackageCatalog> {
  const catalog = await fetchDevelopmentPackage(id);
  if (catalog === null) throw new Error(`The server has no package '${id}'.`);
  return catalog;
}

/** The catalog the server sent, or `null` when it does not have the expected shape. */
function packageCatalog(value: unknown): PackageCatalog | null {
  if (!isRecord(value)) return null;
  const { images, media, sources, problems } = value;
  if (
    !Array.isArray(images) ||
    !Array.isArray(media) ||
    !Array.isArray(sources) ||
    !Array.isArray(problems)
  )
    return null;
  if (!media.every((path) => typeof path === "string")) return null;
  const parsedImages: ProjectImageFile[] = [];
  for (const image of images) {
    if (!isRecord(image)) return null;
    const { path, keywords } = image;
    if (typeof path !== "string" || !Array.isArray(keywords)) return null;
    if (!keywords.every((keyword) => typeof keyword === "string")) return null;
    parsedImages.push({ path, keywords });
  }
  const parsedSources: ProjectSourceFile[] = [];
  for (const file of sources) {
    if (!isRecord(file)) return null;
    const { path, source } = file;
    if (typeof path !== "string" || typeof source !== "string") return null;
    parsedSources.push({ path, source });
  }
  const parsedProblems: PackageProblem[] = [];
  for (const problem of problems) {
    if (!isRecord(problem)) return null;
    const { path, message } = problem;
    if (typeof path !== "string" || typeof message !== "string") return null;
    parsedProblems.push({ path, message });
  }
  return {
    images: parsedImages,
    media: [...media],
    sources: parsedSources,
    problems: parsedProblems,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
