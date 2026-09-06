import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function lintFiles() {
  return globSync(["**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}"], {
    cwd: repositoryRoot,
    exclude: ["node_modules/**", "dist/**", "coverage/**", ".git/**"],
  }).sort();
}
