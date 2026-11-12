import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnTool } from "./runner-test-support.mjs";

// A tool whose entrypoint check compares `process.argv[1]` with `import.meta.url` does nothing when it is run through a
// symbolic link, as the deployed `current` checkout is: Node resolves the link in the module's URL but not in argv, so
// the tool exits 0 without output, which reads as a clean result. `import.meta.main` holds either way. The test finds a
// check written as `import.meta.main`, `require.main`, `process.argv[1]` or `process.argv.at(1)`; a check written in
// any other form (`process.argv` destructured, say) is not found by it (#2566).

const root = fileURLToPath(new URL("..", import.meta.url));
const tools = join(root, "tools");

/** An entrypoint check in the forms the header names. */
const ENTRYPOINT_CHECK =
  /\bimport\.meta\.main\b|\brequire\.main\b|\bprocess\.argv(?:\[1\]|\.at\(1\))/u;

/** The JavaScript files under `tools/`, tests and `node_modules` aside, that hold an entrypoint check. */
function entrypoints(dir = tools) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : entrypoints(path);
    return /\.[cm]?js$/u.test(entry.name) &&
      !/\.test\.[cm]?js$/u.test(entry.name) &&
      ENTRYPOINT_CHECK.test(readFileSync(path, "utf8"))
      ? [path]
      : [];
  });
}

test(
  "every tool with an entrypoint check runs as a command through a symbolic link to the checkout: it prints or refuses, never exits 0 in silence",
  { skip: process.platform === "win32" },
  async (t) => {
    const files = entrypoints();
    assert.ok(files.length > 0, "no tool with an entrypoint check found");
    const scratch = mkdtempSync(join(tmpdir(), "entrypoint-test-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const link = join(scratch, "checkout");
    symlinkSync(root, link);
    const cwd = join(scratch, "empty");
    mkdirSync(cwd);
    // (from an empty folder outside any repository, with an option no tool knows: each refuses or fails at once,
    // before any work; run-parallel passes the option to `npm run`, whose debug log goes to a cache in the scratch)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !["GIT_DIR", "GIT_WORK_TREE", "NPM_CONFIG_CACHE"].includes(name.toUpperCase()),
      ),
    );
    env.npm_config_cache = join(scratch, "npm-cache");
    const runs = await Promise.all(
      files.map(async (file) => {
        const name = relative(root, file);
        const { done } = spawnTool(
          t,
          process.execPath,
          [join(link, name), "--entrypoint-test-unknown-option"],
          { cwd, env },
        );
        const { code, output } = await done;
        return { name, code, output };
      }),
    );
    const silent = runs
      .filter(({ code, output }) => code === 0 && output.trim() === "")
      .map(({ name }) => name);
    assert.deepEqual(silent, [], "exited 0 without output when run through a symbolic link");
  },
);
