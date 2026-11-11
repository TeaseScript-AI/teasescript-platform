import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { walkSources } from "../../player/vue/test-modules-sources.js";

const bundle = new URL("../../player-test-modules/", import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
let checked: Error | null | undefined;

/**
 * An error naming the paths whose entry in the bundle's `sources.json` differs from the checkout's walk
 * (`player/vue/test-modules-sources.ts`), a path one of them lacks and a path the walk refuses included, or naming why
 * the bundle cannot be checked; `null` when the checkout matches.
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
    return new Error(`${fileURLToPath(bundle)}sources.json is not an object of entries.`);
  const stamped = new Map<string, unknown>(Object.entries(sources));
  // An entry the walk refuses is a change too: no bundle is built while one exists.
  const { stamp: current, refused } = walkSources(root);
  const refusedKeys = new Set(refused.map(([key]) => key));
  const changed = [...new Set([...stamped.keys(), ...current.keys(), ...refusedKeys])]
    .filter((path) => refusedKeys.has(path) || stamped.get(path) !== current.get(path))
    .sort();
  if (changed.length === 0) return null;
  const named = changed.slice(0, 5);
  return new Error(
    `The Player test bundle was built before a file of this checkout changed (${named.join(", ")}${changed.length > 5 ? `, and ${changed.length - 5} more` : ""}): run \`npm run build:player-test-modules\` to rebuild it.`,
  );
}

/**
 * Loads a Player browser-source module, named by its source path such as `player/vue/src/usePlayerSession.ts`, from the
 * server-side bundle that `npm run build` writes (`player/vue/vite.test-modules.config.ts` lists the modules). All
 * modules loaded in one test process share that bundle's module graph, so their classes and state are the same. The
 * first call in a process compares the bundle's stamp with the checkout's files, and every call in that process refuses
 * a bundle built before one of them changed, as one is after any edit that only `npm run build:typescript` followed.
 */
export async function loadPlayerModule(source: string): Promise<Record<string, unknown>> {
  if (checked === undefined) checked = staleBundle();
  if (checked !== null) throw checked;
  const module: Record<string, unknown> = await import(
    new URL(source.replace(/\.ts$/u, ".js"), bundle).href
  );
  return module;
}
