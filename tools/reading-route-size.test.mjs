import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { entryOf, ROUTE, sectionsOf } from "./reading-route-size.mjs";
import { isolateGit } from "./fixture-git.mjs";

isolateGit();

const tool = fileURLToPath(new URL("./reading-route-size.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const routed = [...ROUTE.everyTask, ...ROUTE.whenNeeded].map(entryOf);
const listed = [...routed, ...ROUTE.notRead].map((entry) => entryOf(entry).path);

test("every document and section the route lists exists in this checkout", () => {
  assert.deepEqual(
    listed.filter((path) => !existsSync(join(root, path))),
    [],
    "listed in ROUTE (tools/reading-route-size.mjs) but missing",
  );
  assert.deepEqual(
    routed
      .filter((entry) => entry.sections !== undefined)
      .flatMap(
        (entry) => sectionsOf(readFileSync(join(root, entry.path), "utf8"), entry.sections).missing,
      ),
    [],
    "a section listed in ROUTE but no heading of its document",
  );
});

test("a section runs from its heading to the next heading of any level, and a fence hides headings", () => {
  const text = "# Top\nintro\n## A\na1\n### B\nb1\n```\n## not a heading\n```\n## C ##\nc1";
  assert.deepEqual(sectionsOf(text, ["A", "C"]), { text: "## A\na1\n## C ##\nc1", missing: [] });
  assert.equal(sectionsOf(text, ["B"]).text, "### B\nb1\n```\n## not a heading\n```");
  assert.deepEqual(sectionsOf(text, ["not a heading", "D"]).missing, ["not a heading", "D"]);
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

/** Every routed document: one character long, or holding each section an entry names as `## name` over `a`. */
const allRouted = () => {
  const files = {};
  for (const entry of routed)
    if (entry.sections === undefined) files[entry.path] ??= "a";
    else
      files[entry.path] =
        `${files[entry.path] ?? ""}${entry.sections.map((name) => `## ${name}\na\n`).join("")}`;
  return files;
};

/** The size `allRouted()` gives an entry: one, or its sections' lines joined by newlines. */
const routedSize = (entry) =>
  entry.sections === undefined
    ? 1
    : [...entry.sections.map((name) => `## ${name}\na`).join("\n")].length;

/** The total `allRouted()` gives the every-task entries but `skip`. */
const routedTotal = (...skip) =>
  ROUTE.everyTask
    .filter((entry) => !skip.includes(entry))
    .reduce((total, entry) => total + routedSize(entryOf(entry)), 0);

/** The size column (and the difference column, when present) of the line ending in `name`. */
function columns(out, name) {
  const line = out
    .split("\n")
    .find((text) => text.trimEnd().endsWith(` ${name}`) || text.includes(` ${name}: `));
  assert.ok(line !== undefined, `no line for ${name} in:\n${out}`);
  return line.trim().split(/\s+/u).slice(0, -1);
}

test(
  "sizes are code points of the committed text; the total holds only the every-task documents",
  { timeout: 30_000 },
  () => {
    const [first, second] = ROUTE.everyTask;
    const conditional = ROUTE.whenNeeded.find((entry) => entry.sections === undefined).path;
    const { directory } = repository({
      ...allRouted(),
      [first]: "﻿é😀\n", // a byte-order mark, a two-byte and a four-byte character, a newline: 4 code points
      [conditional]: "x".repeat(1000),
    });
    try {
      writeFileSync(join(directory, second), "uncommitted text is not read");
      const { status, out } = run(directory);
      assert.equal(status, 0, out);
      assert.deepEqual(columns(out, first), ["4"]);
      assert.deepEqual(columns(out, second), ["1"]);
      assert.deepEqual(columns(out, "total"), [String(4 + routedTotal(first))]);
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
      assert.deepEqual(columns(out, ROUTE.everyTask[2]), ["1", "0"]);
      assert.deepEqual(columns(out, "total"), [String(routedTotal(first, second) + 3 + 2), "+4"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a listed document missing at the revision is named, left out of the total, and exits 1",
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
      assert.deepEqual(columns(out, "total"), [String(routedTotal(absent))]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a sectioned entry counts only its sections, and a section missing at the revision is named and exits 1",
  { timeout: 30_000 },
  () => {
    const entry = ROUTE.everyTask
      .map(entryOf)
      .find((candidate) => candidate.sections !== undefined);
    const [, ...dropped] = entry.sections;
    const files = allRouted();
    const { directory } = repository({
      ...files,
      [entry.path]: `# ${entry.path}\nnot read\n${files[entry.path]}`,
    });
    try {
      const whole = run(directory);
      assert.equal(whole.status, 0, whole.out);
      assert.deepEqual(columns(whole.out, "total"), [String(routedTotal())]);
      commit(directory, {
        [entry.path]: files[entry.path].replace(`## ${dropped[0]}\n`, `## ${dropped[0]} renamed\n`),
      });
      const { status, out } = run(directory);
      assert.equal(status, 1, out);
      assert.match(out, new RegExp(`missing  ${entry.path.replaceAll(".", "\\.")} \\(`, "u"));
      assert.ok(out.includes(`${entry.path} "${dropped[0]}"`), out);
      assert.deepEqual(columns(out, "total"), [
        String(routedTotal(ROUTE.everyTask.find((e) => entryOf(e) === entry))),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

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
