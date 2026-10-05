import {
  developmentPackageFileUrl,
  loadDevelopmentPackage,
  type PackageProblem,
} from "../../../playground/package-catalog.js";
import type { PlayerProject } from "../../runtime-adapter.js";

// The trusted host for a package of the playground server's development package root (#570), opened with
// `?package=<id>`: it loads the package's `.tease` files, images, audio, and video from the server and resolves the
// package-relative references the script uses to the package's own files. Any other reference does not load.
export function developmentPackageHost(id: string) {
  const files = new Set<string>();
  return {
    // A stable, opaque script-storage scope per package, as for the repository demo.
    storageScope: `development-package:${id}`,
    resolveAsset: (path: string): string | null =>
      files.has(path) ? developmentPackageFileUrl(id, path) : null,
    /** The package as a project, and what the server could not read of it; rejects when it cannot be opened. */
    async load(): Promise<{
      readonly project: PlayerProject;
      readonly problems: readonly PackageProblem[];
    }> {
      const catalog = await loadDevelopmentPackage(id);
      for (const image of catalog.images) files.add(image.path);
      for (const path of catalog.media) files.add(path);
      return {
        project: { files: catalog.sources, images: catalog.images },
        problems: catalog.problems,
      };
    },
  };
}
