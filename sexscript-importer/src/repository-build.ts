import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A file of the repository build (`npm run build:typescript`) that the importer loads the compiler and runtime from:
 * this checkout's `dist/`, or the folder that `TEASESCRIPT_DIST` names, such as another build to compare against.
 */
export function repositoryBuildUrl(file: string): URL {
  const override = process.env.TEASESCRIPT_DIST;
  const root =
    override === undefined || override === ""
      ? new URL("../../dist/", import.meta.url)
      : pathToFileURL(`${path.resolve(override)}/`);
  return new URL(file, root);
}
