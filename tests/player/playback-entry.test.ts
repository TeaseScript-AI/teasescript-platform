import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/*
 * Playback needs no compiler (docs/RUNTIME.md "Canonical source-to-runtime route"): importing the playback entry loads
 * none of the modules that compile, parse or lex source, which the authoring entry adds.
 */

/** Modules of the compiler and the language tools, by their path under `dist/src/`. */
const AUTHORING_MODULE =
  /\/dist\/src\/(compiler|parser|lexer|semantic|type-checker|language-tooling|source-debug-sidecar|static-types|ast-validation)(\.js$|\/)|\/dist\/src\/(type-inference|editor)\//;

/** Every module URL that importing `entry` loads, recorded by a resolve hook in a fresh process. */
function loadedModules(entry: string): string[] {
  const url = new URL(entry, import.meta.url).href;
  const script = [
    'import { registerHooks } from "node:module";',
    "const loaded = new Set();",
    "registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.add(result.url); return result; } });",
    `await import(${JSON.stringify(url)});`,
    "process.stdout.write(JSON.stringify([...loaded]));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
  });
  assert.equal(child.status, 0, child.stderr);
  // EVIDENCE: fixture: the child script writes the JSON of a list of URLs.
  return JSON.parse(child.stdout) as string[];
}

test("the playback entry loads no compiler, parser or language-tooling module; the authoring entry does", () => {
  const played = loadedModules("../../src/playback.js");
  assert.ok(played.some((url) => url.endsWith("/dist/src/runtime/session.js")));
  assert.deepEqual(
    played.filter((url) => AUTHORING_MODULE.test(url)),
    [],
  );
  const authored = loadedModules("../../src/index.js");
  for (const module of ["compiler.js", "parser.js", "lexer.js", "language-tooling.js"])
    assert.ok(
      authored.some((url) => url.endsWith(`/dist/src/${module}`)),
      module,
    );
});
