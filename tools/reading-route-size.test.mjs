import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ROUTE, sectionsOf, workflowSections } from "./reading-route-size.mjs";
import { isolateGit } from "./fixture-git.mjs";

isolateGit();

const tool = fileURLToPath(new URL("./reading-route-size.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const listed = [
  ...ROUTE.everyTask,
  ROUTE.workflow.path,
  ...ROUTE.whenNeeded.map((document) => document.path),
  ...ROUTE.notRead.map((document) => document.path),
];

test("every document the route lists exists in this checkout", () => {
  assert.deepEqual(
    listed.filter((path) => !existsSync(join(root, path))),
    [],
    "listed in ROUTE (tools/reading-route-size.mjs) but missing",
  );
});

test("the route table names each workflow section once, so none is renamed or added without a row", () => {
  const rows = workflowSections(readFileSync(join(root, ROUTE.workflow.router), "utf8"));
  const sections = sectionsOf(readFileSync(join(root, ROUTE.workflow.path), "utf8"));
  assert.deepEqual(rows.map(({ anchor }) => anchor).sort(), [...sections.keys()].sort());
});

/** A repository holding `files` (path → text or Buffer) in one commit; its directory and that commit. */
function repository(files) {
  const directory = mkdtempSync(join(tmpdir(), "reading-route-size-"));
  spawnSync("git", ["init", "-q", directory]);
  return { directory, commit: commit(directory, files) };
}

function commit(directory, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  spawnSync("git", ["-C", directory, "add", "-A"]);
  spawnSync("git", ["-C", directory, "commit", "-q", "--allow-empty", "-m", "c"]);
  return spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
}

function run(directory, args = []) {
  const result = spawnSync(process.execPath, [tool, ...args], { cwd: directory, encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr };
}

const INTRO = "# Workflow\n\n";
const BUILD = "## Build\n\né😀\n\n```md\n# Fenced, not a heading\n```\n\n";
const CHILD = "### Child\n\nconditional\n\n";
const REVIEW = "## Review\n\nr\n";
const WORKFLOW = INTRO + BUILD + CHILD + REVIEW;
const ROUTER = [
  "# Capabilities",
  "",
  "## Workflow reading before starting",
  "",
  "| Workflow section | Startup roles |",
  "| --- | --- |",
  "| [Workflow](../DEVELOPMENT-WORKFLOW.md#workflow) | A B R F C |",
  "| [Build](../DEVELOPMENT-WORKFLOW.md#build) | A B |",
  "| [Child](../DEVELOPMENT-WORKFLOW.md#child) | — |",
  "| [Review](../DEVELOPMENT-WORKFLOW.md#review) | R F C |",
  "",
].join("\n");

const allRouted = () => ({
  ...Object.fromEntries(
    [...ROUTE.everyTask, ...ROUTE.whenNeeded.map((document) => document.path)].map((p) => [p, "a"]),
  ),
  [ROUTE.workflow.path]: WORKFLOW,
  [ROUTE.workflow.router]: ROUTER,
});

const commonSize = (files) =>
  ROUTE.everyTask.reduce((total, path) => total + [...(files[path] ?? "")].length, 0);
const workflowSize = (role) => [...(INTRO + ("AB".includes(role) ? BUILD : REVIEW))].length;
const roleTotal = (out, role) =>
  Number(out.match(new RegExp(`^  ${role} [^\\n]*?: (\\d+)`, "mu"))?.[1]);

/** The size column (and the difference column, when present) of the line ending in `name`. */
function columns(out, name) {
  const line = out
    .split("\n")
    .find((text) => text.trimEnd().endsWith(` ${name}`) || text.includes(` ${name}: `));
  assert.ok(line !== undefined, `no line for ${name} in:\n${out}`);
  return line.trim().split(/\s+/u).slice(0, -1);
}

test(
  "startup sizes count committed Unicode text, the role's sections, and no child or conditional document",
  { timeout: 30_000 },
  () => {
    const [first, second] = ROUTE.everyTask;
    const conditional = ROUTE.whenNeeded[0].path;
    const files = {
      ...allRouted(),
      [first]: "﻿é😀\n", // a byte-order mark, a two-byte and a four-byte character, a newline: 4 code points
      [conditional]: "x".repeat(1000),
    };
    const { directory } = repository(files);
    try {
      writeFileSync(join(directory, second), "uncommitted text is not read");
      const { status, out } = run(directory);
      assert.equal(status, 0, out);
      assert.deepEqual(columns(out, first), ["4"]);
      assert.deepEqual(columns(out, second), ["1"]);
      for (const role of Object.keys(ROUTE.roles))
        assert.equal(roleTotal(out, role), commonSize(files) + workflowSize(role));
      assert.deepEqual(columns(out, conditional).slice(0, 1), ["1000"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "--base gives each document's difference, `new` where the base lacks it, and the total's",
  { timeout: 30_000 },
  () => {
    const [first, second] = ROUTE.everyTask;
    const routed = allRouted();
    delete routed[second];
    const { directory, commit: base } = repository(routed);
    try {
      commit(directory, { [first]: "abc", [second]: "xy" });
      const { status, out } = run(directory, ["--base", base]);
      assert.equal(status, 0, out);
      assert.deepEqual(columns(out, first), ["3", "+2"]);
      assert.deepEqual(columns(out, second), ["2", "new"]);
      assert.deepEqual(columns(out, ROUTE.everyTask[2]), [
        String([...routed[ROUTE.everyTask[2]]].length),
        "0",
      ]);
      for (const role of Object.keys(ROUTE.roles)) {
        assert.equal(
          roleTotal(out, role),
          commonSize({ ...routed, [first]: "abc", [second]: "xy" }) + workflowSize(role),
        );
        assert.match(
          out,
          new RegExp(
            `^  ${role} .*\\(before ${commonSize(routed) + workflowSize(role)}, change 4\\)$`,
            "mu",
          ),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a listed document or a named workflow section missing at the revision is named, left out of the totals, and exits 1",
  { timeout: 30_000 },
  () => {
    const routed = allRouted();
    const absent = ROUTE.everyTask.at(-1);
    delete routed[absent];
    const { directory } = repository(routed);
    try {
      const { status, out } = run(directory);
      assert.equal(status, 1, out);
      assert.match(out, new RegExp(`missing  ${absent.replaceAll(".", "\\.")}`, "u"));
      assert.equal(roleTotal(out, "A"), commonSize(routed) + workflowSize("A"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    for (const title of ["Build", "Child"]) {
      const { directory: renamed } = repository({
        ...allRouted(),
        [ROUTE.workflow.path]: WORKFLOW.replace(`# ${title}\n`, "# Renamed\n"),
      });
      try {
        const { status, out } = run(renamed);
        assert.equal(status, 1, out);
        assert.match(out, new RegExp(`^missing at HEAD: .*#${title.toLowerCase()}`, "mu"));
      } finally {
        rmSync(renamed, { recursive: true, force: true });
      }
    }
  },
);

test("a section missing at the base is printed and left out of its totals, without changing the exit", () => {
  const files = allRouted();
  const { directory, commit: base } = repository({
    ...files,
    [ROUTE.workflow.path]: WORKFLOW.replace("## Build", "## Renamed"),
  });
  try {
    commit(directory, { [ROUTE.workflow.path]: WORKFLOW });
    const { status, out } = run(directory, ["--base", base]);
    assert.equal(status, 0, out);
    assert.match(out, /^missing at [0-9a-f]+, left out of its totals: .*#build$/mu);
    assert.match(
      out,
      new RegExp(
        `^  A .*: ${commonSize(files) + workflowSize("A")} \\(before ${commonSize(files) + [...INTRO].length}, `,
        "mu",
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a route table without its heading, a heading without a table, or a row naming an unknown or repeated role exits 2", () => {
  for (const router of [
    ROUTER.replace(ROUTE.workflow.heading, "Renamed"),
    ROUTER.replace("| Workflow section |", "| Section |"),
    ROUTER.replace("A B |", "X |"),
    ROUTER.replace("A B |", "A A |"),
  ]) {
    const { directory } = repository({ ...allRouted(), [ROUTE.workflow.router]: router });
    try {
      const { status, out } = run(directory);
      assert.equal(status, 2, out);
      assert.match(
        out,
        /^reading-route-size: (route table without|no route table|unreadable route table row)/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("--base measures the earlier whole-workflow route and each later role's section route", () => {
  const files = { ...allRouted(), [ROUTE.workflow.router]: "# Capabilities\n" };
  const { directory, commit: base } = repository(files);
  try {
    commit(directory, { [ROUTE.workflow.router]: ROUTER });
    const { status, out } = run(directory, ["--base", base]);
    assert.equal(status, 0, out);
    const before = commonSize(files) + [...WORKFLOW].length;
    for (const role of Object.keys(ROUTE.roles)) {
      const after = commonSize({ ...files, [ROUTE.workflow.router]: ROUTER }) + workflowSize(role);
      assert.equal(roleTotal(out, role), after);
      assert.match(
        out,
        new RegExp(`^  ${role} .*\\(before ${before}, change ${after - before}\\)$`, "mu"),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "a revision that is no commit, a file that is not UTF-8 and an unknown argument exit 2",
  { timeout: 30_000 },
  () => {
    const { directory } = repository({
      ...allRouted(),
      [ROUTE.everyTask[0]]: Buffer.from([0xff, 0xfe, 0x41]),
    });
    try {
      for (const args of [["--rev", "no-such-revision"], [], ["--base"], ["--other"]]) {
        const { status, out } = run(directory, args);
        assert.equal(status, 2, `${args.join(" ")}: ${out}`);
        assert.match(out, /^reading-route-size: /u);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a .md name in the route statements that no list holds is printed as not classified, without changing the exit",
  { timeout: 30_000 },
  () => {
    const { directory } = repository({
      ...allRouted(),
      "AGENTS.md":
        "Read `docs/NEW.md`, `README-FIRST.md`, [the guide](docs/agents/DIRECT-REPOSITORY.md), `GONE.md` " +
        "and `docs/PATCH-PUBLICATION.md`, which is classified though this commit lacks it.",
      "docs/agents/DIRECT-REPOSITORY.md": "`CONNECTOR-LOCAL.md`, `../NEW.md`, `PHASE-STATUS.md`",
      "docs/NEW.md": "n",
      "docs/agents/CONNECTOR-LOCAL.md": "c",
    });
    try {
      const { status, out } = run(directory);
      assert.equal(status, 0, out);
      assert.deepEqual(
        out.split("\n").filter((line) => line.startsWith("not classified")),
        [
          "not classified: docs/NEW.md (named in AGENTS.md)",
          "not classified: GONE.md (named in AGENTS.md; no such file)",
          "not classified: docs/NEW.md (named in docs/agents/DIRECT-REPOSITORY.md)",
        ],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
