import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The files `npm run lint` lints: the code files, `.vue` included, whose `<script>` blocks oxlint reads. */
export function lintFiles() {
  return globSync(["**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs,vue}"], {
    cwd: repositoryRoot,
    exclude: ["node_modules/**", "dist/**", "coverage/**", ".git/**"],
  }).sort();
}

/** The options `npm run lint` (`run.mjs`) runs oxlint with, before the files: the type-aware rules included. */
export const OXLINT_OPTIONS = [
  "--config",
  ".oxlintrc.json",
  "--disable-nested-config",
  "--type-aware",
  "--report-unused-disable-directives-severity",
  "error",
];
