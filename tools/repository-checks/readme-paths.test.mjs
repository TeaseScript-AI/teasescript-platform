import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isolateGit } from "../fixture-git.mjs";

isolateGit();

// The check over the two Player READMEs, run in a Git checkout that holds them.

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tool = fileURLToPath(new URL("./readme-paths.mjs", import.meta.url));

/** A committed Git checkout holding `files` (path to text), with the repository's `node_modules`; its folder. */
function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), "readme-paths-"));
  for (const [path, text] of Object.entries({ ".gitignore": "node_modules\n", ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "files");
  return root;
}

/** The check run over the Player README `player` and the component map `component`, with the tracked `files`. */
function check({ player = "", component = "" }, files = {}) {
  const root = checkout({
    "player/README.md": player,
    "player/vue/src/README.md": component,
    ...files,
  });
  try {
    const run = spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8" });
    const problems = run.stderr.split("\n").filter((line) => line.includes(": `"));
    return { status: run.status, problems };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FILES = {
  "player/runtime/runtime-adapter.ts": "",
  "player/vue/src/app/PlayerApp.vue": "",
  "tools/debug-export.mjs": "",
};

test("a stale path fails, naming the README, the line and the token", () => {
  const result = check(
    {
      player: "# Player\n\n- `runtime-adapter.ts` translates.\n- `runtime/gone.ts` went.\n",
      component: "`PlayerApp.vue` composes.\n",
    },
    FILES,
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.problems, [
    "player/README.md:3: `runtime-adapter.ts` names no tracked file or folder",
    "player/README.md:4: `runtime/gone.ts` names no tracked file or folder",
    "player/vue/src/README.md:1: `PlayerApp.vue` names no tracked file or folder",
  ]);
});

test("a true path passes, from the README's folder or the top folder, and so does a tracked folder", () => {
  const result = check(
    {
      player:
        "`runtime/runtime-adapter.ts`, `tools/debug-export.mjs`, `runtime/`, `vue/src/` and `../`\n",
      component: "`app/PlayerApp.vue` and `player/runtime/runtime-adapter.ts`\n",
    },
    FILES,
  );
  assert.deepEqual(result, { status: 0, problems: [] });
});

test("a span that is no path, a link's text, and a fenced block are not checked", () => {
  const result = check(
    {
      player: [
        "`restorePlayerRuntimeSessionAt`, `PlayerSession`, `askImage(...)`, `main.tease` and `claim`",
        "`/player/`, `@vueuse/core` and `npm run ./gone.ts`",
        "[`DEBUGGER.md`](../docs/DEBUGGER.md#rewind), [`absent.ts`][ref] and [`gone.md`][]",
        "",
        "[ref]: README.md",
        "[`gone.md`]: README.md",
        "",
        "```md",
        "`gone.ts`",
        "```",
        "",
      ].join("\n"),
    },
    FILES,
  );
  assert.deepEqual(result, { status: 0, problems: [] });
});
