import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

/** The source forms the stamp covers: a plain file that the bundler reads as it is. */
const ADMITTED = /\.(?:[cm]?ts|[cm]?js|json)$/u;

/**
 * Writes `sources.json` into the Player test bundle: by its path from the root with `/`, the SHA-256 of each file the
 * bundle was built from, or `null` for a file whose absence it depended on. `tests/helpers/player-modules.ts` refuses a
 * bundle whose stamp differs from the checkout, so a compiled test cannot run against Player or engine code older than
 * its own. The stamp holds:
 * - every bundled repository module, hashed as this plugin reads it, before the bundler does;
 * - for each, the `tsconfig.json` and `package.json` of its folder and of every folder above it up to the root, which
 *   decide how it is compiled and resolved;
 * - the build's configuration file and the files it imports, and the `.env` files Vite reads for the build's mode.
 *
 * Symlinks are kept as paths (`resolve.preserveSymlinks`), so a retargeted link changes the content its path hashes to.
 * The build fails on a bundled module of another form (a query such as `?raw`, another file type) and on a bundled
 * module not hashed, so nothing is left out silently. Dependencies under `node_modules`, and the bundler's own virtual
 * modules (`\0`), are not stamped.
 */
export function testModulesSources(): Plugin {
  let config: ResolvedConfig;
  const hashes = new Map<string, string | null>();
  const key = (file: string) => relative(config.root, file).replaceAll("\\", "/");
  const stamp = (file: string) => {
    hashes.set(
      key(file),
      existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null,
    );
  };
  const stamped = (id: string) =>
    !id.startsWith("\0") && !id.replaceAll("\\", "/").includes("/node_modules/");
  return {
    name: "test-modules-sources",
    enforce: "pre",
    config: () => ({ resolve: { preserveSymlinks: true } }),
    configResolved(resolved) {
      config = resolved;
    },
    buildStart() {
      hashes.clear();
      // The configuration file is the first of these.
      for (const file of config.configFileDependencies) stamp(file);
      if (config.envDir !== false)
        for (const name of [
          ".env",
          ".env.local",
          `.env.${config.mode}`,
          `.env.${config.mode}.local`,
        ])
          stamp(join(config.envDir, name));
    },
    load(id) {
      if (!stamped(id)) return null;
      if (id.includes("?") || !ADMITTED.test(id))
        this.error(`test-modules-sources: ${id} is a form the stamp does not cover`);
      stamp(id);
      for (let folder = dirname(id); ; folder = dirname(folder)) {
        stamp(join(folder, "tsconfig.json"));
        stamp(join(folder, "package.json"));
        if (key(folder) === "" || dirname(folder) === folder) break;
      }
      return null;
    },
    // Written by hand, as Vite emits no assets from a server-side build, and last, after any other stamping plugin.
    writeBundle: {
      order: "post",
      sequential: true,
      handler(options, bundle) {
        if (options.dir === undefined)
          this.error("test-modules-sources: the build has no output folder");
        for (const output of Object.values(bundle))
          if (output.type === "chunk")
            for (const id of output.moduleIds)
              if (stamped(id) && !hashes.has(key(id)))
                this.error(`test-modules-sources: ${id} was bundled without being hashed`);
        const sorted = [...hashes].sort(([a], [b]) => (a < b ? -1 : 1));
        writeFileSync(
          join(options.dir, "sources.json"),
          `${JSON.stringify(Object.fromEntries(sorted), null, 1)}\n`,
        );
      },
    },
  };
}
