import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isolateGit } from "../fixture-git.mjs";

isolateGit();

// The maps, ADR index and start/ownership route must reject stale names without treating commands as files.

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

function runCheck(root) {
  const run = spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8" });
  const problems = run.stderr.split("\n").filter((line) => line.includes(": `"));
  return { status: run.status, problems };
}

/** The check run over the Player README `player` and the component map `component`, with the tracked `files`. */
function check({ player = "", component = "" }, files = {}) {
  const root = checkout({
    "player/README.md": player,
    "player/vue/src/README.md": component,
    "README-FIRST.md": "",
    "docs/agents/README.md": "",
    "docs/agents/DIRECT-REPOSITORY.md": "",
    "docs/ORCHESTRATION.md": "# Orchestration\n\n## Repository ownership\n",
    "docs/RUNTIME.md": "# Runtime\n\n## Reading map\n",
    "docs/decisions/README.md": "",
    ...files,
  });
  try {
    return runCheck(root);
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

test("area.sh in ownership and a stale name in each route document fail with their locations", () => {
  const result = check(
    {},
    {
      "docs/ORCHESTRATION.md": "# Orchestration\n\n## Repository ownership\n\n`area.sh`\n",
      "README-FIRST.md": "`docs/absent.md`\n",
      "docs/agents/README.md": "[`missing.mjs`](../../tools/real.mjs)\n",
      "docs/agents/DIRECT-REPOSITORY.md": "`nowhere/*.ts`\n",
      "tools/real.mjs": "",
    },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.problems, [
    "README-FIRST.md:1: `docs/absent.md` names no tracked file or folder",
    "docs/agents/README.md:1: `missing.mjs` names no tracked file or folder",
    "docs/agents/DIRECT-REPOSITORY.md:1: `nowhere/*.ts` names no tracked file or folder",
    "docs/ORCHESTRATION.md:5: `area.sh` names no tracked file or folder",
  ]);
});

test("tracked globs, unique basenames and file fragments resolve", () => {
  const result = check(
    {},
    {
      "README-FIRST.md":
        "`tests/families/*`, `stalls.mjs`, `tests/`, `docs/agents/README.md#heading`\n",
      "tests/families/stalls.mjs": "",
    },
  );
  assert.deepEqual(result, { status: 0, problems: [] });
});

test("stale bare filenames with fragments fail on every extended surface, retaining their full token", () => {
  const result = check(
    {},
    {
      "README-FIRST.md": "`no-first.md#start`\n",
      "docs/agents/README.md": "`no-guide.mjs#start`\n",
      "docs/agents/DIRECT-REPOSITORY.md": "`no-direct.sh#start`\n",
      "docs/ORCHESTRATION.md": "## Repository ownership\n\n`area.sh#start`\n",
    },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.problems, [
    "README-FIRST.md:1: `no-first.md#start` names no tracked file or folder",
    "docs/agents/README.md:1: `no-guide.mjs#start` names no tracked file or folder",
    "docs/agents/DIRECT-REPOSITORY.md:1: `no-direct.sh#start` names no tracked file or folder",
    "docs/ORCHESTRATION.md:3: `area.sh#start` names no tracked file or folder",
  ]);
});

test("file parts with fragments resolve as unique names and globs", () => {
  const result = check(
    {},
    {
      "README-FIRST.md": "`stalls.mjs#runner`\n",
      "docs/agents/README.md": "`helper.mjs#notes`\n",
      "docs/ORCHESTRATION.md": "## Repository ownership\n\n`tests/families/*#helpers`\n",
      "tests/families/stalls.mjs": "",
      "tools/helper.mjs": "",
    },
  );
  assert.deepEqual(result, { status: 0, problems: [] });
});

test("directory context covers depth, ./ and fragments, stays in its paragraph and preserves stale tokens", () => {
  const directories = [
    { span: "src/", folder: "src" },
    { span: "./src/", folder: "src" },
    { span: "src/plan/", folder: "src/plan" },
    { span: "./src/plan/", folder: "src/plan" },
    { span: "src/#map", folder: "src" },
  ];
  const surfaces = [
    { path: "README-FIRST.md", prefix: "", offset: 0 },
    { path: "docs/agents/README.md", prefix: "", offset: 0 },
    { path: "docs/agents/DIRECT-REPOSITORY.md", prefix: "", offset: 0 },
    { path: "docs/ORCHESTRATION.md", prefix: "## Repository ownership\n\n", offset: 2 },
  ];
  for (const { span, folder } of directories) {
    const root = checkout({
      "player/README.md": "",
      "player/vue/src/README.md": "",
      "docs/RUNTIME.md": "## Reading map\n",
      "docs/decisions/README.md": "",
      ...Object.fromEntries(surfaces.map(({ path, prefix }) => [path, prefix])),
      [`${folder}/member.mjs`]: "",
      "elsewhere/member.mjs": "",
      [`${folder}/nested/one.ts`]: "",
      "elsewhere/nested/two.ts": "",
      "empty/keep.ts": "",
    });
    try {
      const cases = [
        {
          name: "last directory resolves",
          text: `\`empty/\` and \`${span}\` are directories; the latter owns \`member.mjs#member\` and \`nested/#members\`.`,
          line: 1,
        },
        {
          name: "ambiguous control",
          text: "`member.mjs#member`",
          token: "member.mjs#member",
          line: 1,
        },
        {
          name: "next paragraph",
          text: `\`${span}\` owns \`member.mjs#member\`.\n\n\`member.mjs#member\``,
          token: "member.mjs#member",
          line: 3,
        },
        {
          name: "stale token",
          text: `\`${span}\` owns \`stale.mjs#missing\`.`,
          token: "stale.mjs#missing",
          line: 1,
        },
      ];
      for (const scenario of cases) {
        for (const { path, prefix } of surfaces)
          writeFileSync(join(root, path), prefix + scenario.text + "\n");
        const problems =
          scenario.token === undefined
            ? []
            : surfaces.map(
                ({ path, offset }) =>
                  `${path}:${offset + scenario.line}: \`${scenario.token}\` names no tracked file or folder`,
              );
        assert.deepEqual(
          runCheck(root),
          { status: scenario.token === undefined ? 0 : 1, problems },
          `${span}: ${scenario.name}`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("ownership checks stop at the next peer heading and exclude commands, URLs and external paths", () => {
  const result = check(
    {},
    {
      "docs/ORCHESTRATION.md": [
        "## Elsewhere",
        "`untracked.mjs`",
        "## Repository ownership",
        "`git diff -M`, `node tools/absent.mjs`, `https://example.test/absent.md`, `~/external.md`, `/opt/external.md`",
        "### Child",
        "`tools/real.mjs`",
        "## After",
        "`other.sh`",
        "",
      ].join("\n"),
      "tools/real.mjs": "",
    },
  );
  assert.deepEqual(result, { status: 0, problems: [] });
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

for (const { path, prefix, suffix, line } of [
  {
    path: "docs/RUNTIME.md",
    prefix: "# Runtime\n\n## Reading map\n\n",
    suffix: "\n## Runtime contract\n`outside-map.md`\n",
    line: 5,
  },
  { path: "docs/decisions/README.md", prefix: "# Decisions\n\n", suffix: "", line: 3 },
]) {
  test(`${path} checks routing names, with Runtime limited to its map`, () => {
    const files = { [path]: `${prefix}\`missing.md#target\`\n${suffix}` };
    assert.deepEqual(check({}, files), {
      status: 1,
      problems: [`${path}:${line}: \`missing.md#target\` names no tracked file or folder`],
    });
    files[path] = `${prefix}\`tools/real.mjs#target\`\n${suffix}`;
    files["tools/real.mjs"] = "";
    assert.deepEqual(check({}, files), { status: 0, problems: [] });
  });
}
