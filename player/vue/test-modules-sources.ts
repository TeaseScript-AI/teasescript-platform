import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Writes `sources.json` into the Player test bundle: the SHA-256 of every repository file the bundle was built from, by
 * its path from the root with `/`, and of the build's configuration file. `tests/helpers/player-modules.ts` refuses a
 * bundle whose sources differ from the checkout's, so a compiled test cannot run against Player or engine code older than
 * its own. A file is hashed as this plugin reads it, before the bundler loads it; dependencies under `node_modules` are
 * not listed. The build fails when a bundled module was not hashed, so no input is left out silently.
 */
export function testModulesSources(): Plugin {
  let root = "";
  let configFile: string | undefined;
  const hashes = new Map<string, string>();
  const source = (id: string) =>
    !id.startsWith("\0") &&
    !id.includes("?") &&
    !id.replaceAll("\\", "/").includes("/node_modules/");
  const hash = (file: string) => {
    hashes.set(
      relative(root, file).replaceAll("\\", "/"),
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    );
  };
  return {
    name: "test-modules-sources",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      configFile = config.configFile;
    },
    buildStart() {
      hashes.clear();
      if (configFile !== undefined) hash(configFile);
    },
    load(id) {
      if (source(id)) hash(id);
      return null;
    },
    // Written by hand: Vite emits no assets from a server-side build.
    writeBundle(options, bundle) {
      if (options.dir === undefined)
        this.error("test-modules-sources: the build has no output folder");
      for (const output of Object.values(bundle))
        if (output.type === "chunk")
          for (const id of output.moduleIds)
            if (source(id) && !hashes.has(relative(root, resolve(id)).replaceAll("\\", "/")))
              this.error(`test-modules-sources: ${id} was bundled without being hashed`);
      const sorted = [...hashes].sort(([a], [b]) => (a < b ? -1 : 1));
      writeFileSync(
        join(options.dir, "sources.json"),
        `${JSON.stringify(Object.fromEntries(sorted), null, 1)}\n`,
      );
    },
  };
}
