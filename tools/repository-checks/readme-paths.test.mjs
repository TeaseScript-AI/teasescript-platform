import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isolateGit } from "../fixture-git.mjs";
import { DOCUMENTS, checkDocument, trackedPaths } from "./readme-paths.mjs";

isolateGit();

const tool = fileURLToPath(new URL("./readme-paths.mjs", import.meta.url));
const documentAt = (path) => DOCUMENTS.find((document) => document.path === path);
const PLAYER = documentAt("player/README.md");
const ROUTER = documentAt("docs/agents/README.md");
const OWNERSHIP = documentAt("docs/ORCHESTRATION.md");

/** The spans of `markdown` in `document` that resolve to none of the tracked `files`, as `line: text`. */
function problems(document, markdown, files) {
  return checkDocument(trackedPaths(files), document, markdown).problems.map(
    ({ line, text }) => `${line}: ${text}`,
  );
}

const ownership = (text) => `# Orchestration\n\n## Repository ownership\n\n${text}\n`;

test("a Player README's path resolves from its folder or the top folder; a stale or bare one fails", () => {
  const files = ["player/runtime/runtime-adapter.ts", "tools/debug-export.mjs"];
  const markdown = [
    "`runtime/runtime-adapter.ts`, `tools/debug-export.mjs`, `runtime/`, `vue/` and `../`",
    "`runtime-adapter.ts` and `runtime/gone.ts`",
  ].join("\n\n");
  assert.deepEqual(problems(PLAYER, markdown, [...files, "player/vue/x.vue"]), [
    "3: runtime-adapter.ts",
    "3: runtime/gone.ts",
  ]);
});

test("a Player README checks no identifier, script name, URL route, package, command, link text or fence", () => {
  const markdown = [
    "`PlayerSession`, `askImage(...)`, `main.tease`, `/player/`, `@vueuse/core`, `npm run ./gone.ts`",
    "[`DEBUGGER.md`](../docs/DEBUGGER.md#rewind) and [`absent.ts`][ref]",
    "[ref]: README.md",
    "```md\n`gone.ts`\n```",
  ].join("\n\n");
  assert.deepEqual(problems(PLAYER, markdown, ["player/README.md"]), []);
});

test("a false name on the route and ownership documents fails, with its whole text", () => {
  const files = [
    "tests/families/run.mjs",
    "src/plan/model.ts",
    "src/runtime/model.ts",
    "tools/real.mjs",
  ];
  assert.deepEqual(
    problems(
      OWNERSHIP,
      ownership(
        "The families runner (`tests/families/run.mjs`, `area.sh`, `stalls.mjs#runner`), `model.ts`, " +
          "`tools/gone/`, `nowhere/*.ts` and [`missing.mjs`](../tools/real.mjs).",
      ),
      files,
    ),
    [
      "5: area.sh",
      "5: stalls.mjs#runner",
      "5: model.ts",
      "5: tools/gone/",
      "5: nowhere/*.ts",
      "5: missing.mjs",
    ],
  );
});

test("a path, a unique bare name, a glob and a fragment resolve on the route documents", () => {
  const files = ["tests/families/stalls.mjs", "docs/agents/DIRECT-REPOSITORY.md", "AGENTS.md"];
  const markdown =
    "`stalls.mjs#runner`, `tests/families/*`, `*.mjs`, `tests/`, `DIRECT-REPOSITORY.md`, " +
    "`../../AGENTS.md`, `AGENTS.md` and `docs/agents/README.md#heading`";
  assert.deepEqual(problems(ROUTER, markdown, [...files, "docs/agents/README.md"]), []);
});

test("a bare name resolves under any folder an earlier span of its block named, at any depth", () => {
  const files = [
    "src/plan/model.ts",
    "src/plan/validation/index.ts",
    "src/runtime/model.ts",
    "src/runtime/validation/index.ts",
    "tests/plan/one.test.ts",
  ];
  for (const folder of ["src/plan/", "./src/plan/", "src/plan/#map"])
    assert.deepEqual(
      problems(
        OWNERSHIP,
        ownership(
          `- \`${folder}\` (\`validation/\`, \`model.ts\`, \`index.ts\`, \`*.ts\`), as \`tests/plan/\` holds \`one.test.ts\`.`,
        ),
        files,
      ),
      [],
      folder,
    );
  const table = "| Owner | Files |\n| --- | --- |\n| plan | `src/plan/` and `model.ts` |";
  assert.deepEqual(problems(ROUTER, table, files), []);
});

test("folder context ends with its paragraph, heading or table cell and reaches no earlier name", () => {
  const files = ["src/plan/model.ts", "src/runtime/model.ts"];
  const markdown = [
    "`model.ts` before `src/plan/`.",
    "`src/plan/` in one paragraph; `model.ts` in the next:",
    "`model.ts`",
    "## `src/plan/`",
    "`model.ts`",
    "| a | b |\n| --- | --- |\n| `src/plan/` | `model.ts` |",
  ].join("\n\n");
  assert.deepEqual(problems(ROUTER, markdown, files), [
    "1: model.ts",
    "5: model.ts",
    "9: model.ts",
    "13: model.ts",
  ]);
});

test("in docs/ORCHESTRATION.md only Repository ownership and its subsections are read, without commands or URLs", () => {
  const markdown = [
    "## Elsewhere",
    "`untracked.mjs`",
    "## Repository ownership",
    "`git diff -M`, `check-changed`, `node tools/absent.mjs`, `https://example.test/absent.md`, `~/notes.md`, `/opt/x.md`",
    "### Child",
    "`tools/absent.mjs`",
    "## After",
    "`other.sh`",
  ].join("\n\n");
  assert.deepEqual(problems(OWNERSHIP, markdown, []), ["11: tools/absent.mjs"]);
});

/** A committed Git checkout holding `files` (path to text); its folder. */
function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), "readme-paths-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "files"], { cwd: root });
  return root;
}

test("the check reads Git's tracked files and exits 0, 1 with each problem, or 2 when it cannot run", () => {
  const documents = Object.fromEntries(DOCUMENTS.map(({ path }) => [path, ""]));
  const cases = [
    {
      files: { "docs/ORCHESTRATION.md": ownership("`tools/real.mjs`"), "tools/real.mjs": "" },
      status: 0,
    },
    {
      files: { "docs/ORCHESTRATION.md": ownership("`area.sh`") },
      status: 1,
      stderr: /^docs\/ORCHESTRATION\.md:5: `area\.sh` names no tracked file or folder$/mu,
    },
    {
      files: { "docs/ORCHESTRATION.md": "# Orchestration\n" },
      status: 2,
      stderr: /has no heading/u,
    },
    {
      files: { "docs/ORCHESTRATION.md": ownership(""), "player/README.md": undefined },
      status: 2,
      stderr: /cannot read player\/README\.md/u,
    },
  ];
  for (const { files, status, stderr } of cases) {
    const merged = { ...documents, ...files };
    const root = checkout(
      Object.fromEntries(Object.entries(merged).filter(([, text]) => text !== undefined)),
    );
    try {
      const run = spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8" });
      assert.equal(run.status, status, run.stdout + run.stderr);
      if (stderr !== undefined) assert.match(run.stderr, stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
