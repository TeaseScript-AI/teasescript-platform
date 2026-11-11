import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = new URL("../../player-test-modules/", import.meta.url);
const root = new URL("../../../", import.meta.url);
let checked: Error | null | undefined;

/**
 * The files whose content differs from the bundle's `sources.json` (`player/vue/test-modules-sources.ts`), a missing
 * file included, or an error naming why the bundle cannot be checked.
 */
function staleBundle(): Error | null {
  let sources: unknown;
  try {
    sources = JSON.parse(readFileSync(new URL("sources.json", bundle), "utf8"));
  } catch (error) {
    return new Error(
      `${fileURLToPath(bundle)} has no readable sources.json (${error instanceof Error ? error.message : String(error)}): run \`npm run build:player-test-modules\`.`,
      { cause: error },
    );
  }
  if (typeof sources !== "object" || sources === null || Array.isArray(sources))
    return new Error(`${fileURLToPath(bundle)}sources.json is not an object of hashes.`);
  const changed = Object.entries(sources).filter(([path, hash]) => {
    try {
      return (
        createHash("sha256")
          .update(readFileSync(new URL(path, root)))
          .digest("hex") !== hash
      );
    } catch {
      return true;
    }
  });
  if (changed.length === 0) return null;
  const named = changed.slice(0, 5).map(([path]) => path);
  return new Error(
    `The Player test bundle is older than its sources (${named.join(", ")}${changed.length > 5 ? `, and ${changed.length - 5} more` : ""}): run \`npm run build:player-test-modules\`, or \`npm test -- dist/tests/<file>.test.js\`, before a compiled-only run.`,
  );
}

/**
 * Loads a Player browser-source module, named by its source path such as `player/vue/src/usePlayerSession.ts`, from the
 * server-side bundle that `npm run build` writes (`player/vue/vite.test-modules.config.ts` lists the modules). All
 * modules loaded in one test process share that bundle's module graph, so their classes and state are the same. The
 * first call in a process compares the bundle's sources with the checkout's and refuses a bundle built from others, as
 * one is after a Player or engine edit that only `npm run build:typescript` followed.
 */
export async function loadPlayerModule(source: string): Promise<Record<string, unknown>> {
  checked ??= staleBundle();
  if (checked !== null) throw checked;
  const module: Record<string, unknown> = await import(
    new URL(source.replace(/\.ts$/u, ".js"), bundle).href
  );
  return module;
}
