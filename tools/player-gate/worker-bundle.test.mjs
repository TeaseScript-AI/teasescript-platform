// The Player's production build, as `npm run build:player` makes it: the engine Worker's bundle is an ES module, and the
// compiler is a chunk of its own outside the Worker's static imports, which only a source preparation loads by `import()`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the Player's build bundles the engine Worker as an ES module whose static imports leave the compiler out", async (context) => {
  const outDir = mkdtempSync(join(tmpdir(), "worker-bundle-"));
  context.after(() => rmSync(outDir, { recursive: true, force: true }));
  /** Each Worker bundle the build writes: its format and chunks. */
  const bundles = [];
  await build({
    configFile: join(root, "player/vue/vite.config.ts"),
    logLevel: "warn",
    build: { outDir, sourcemap: false },
    worker: {
      plugins: () => [
        {
          name: "worker-bundle-shape",
          generateBundle(options, bundle) {
            bundles.push({
              format: options.format,
              chunks: Object.values(bundle).filter((output) => output.type === "chunk"),
            });
          },
        },
      ],
    },
  });
  const engine = bundles.filter(({ chunks }) =>
    chunks.some((chunk) => chunk.isEntry && chunk.facadeModuleId?.endsWith("/engine.worker.ts")),
  );
  assert.equal(engine.length, 1, "one engine Worker bundle");
  const [{ format, chunks }] = engine;
  assert.equal(format, "es");
  const entry = chunks.find((chunk) => chunk.facadeModuleId?.endsWith("/engine.worker.ts"));
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const eager = new Set();
  const visit = (name) => {
    if (eager.has(name)) return;
    eager.add(name);
    for (const next of byName.get(name)?.imports ?? []) visit(next);
  };
  visit(entry.fileName);
  const compiler = chunks.find((chunk) =>
    chunk.moduleIds.some((id) => id.endsWith("/src/index.ts")),
  );
  assert.ok(compiler, "the compiler is a chunk of the Worker's bundle");
  assert.notEqual(compiler.fileName, entry.fileName);
  assert.equal(eager.has(compiler.fileName), false, [...eager].join(", "));
});
