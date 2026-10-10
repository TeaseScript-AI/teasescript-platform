/**
 * Loads a Player browser-source module, named by its source path such as `player/vue/src/usePlayerSession.ts`, from the
 * server-side bundle that `npm run build` writes (`player/vue/vite.test-modules.config.ts` lists the modules). All
 * modules loaded in one test process share that bundle's module graph, so their classes and state are the same.
 */
export async function loadPlayerModule(source: string): Promise<Record<string, unknown>> {
  const url = new URL(
    `../../player-test-modules/${source.replace(/\.ts$/u, ".js")}`,
    import.meta.url,
  );
  const module: Record<string, unknown> = await import(url.href);
  return module;
}
