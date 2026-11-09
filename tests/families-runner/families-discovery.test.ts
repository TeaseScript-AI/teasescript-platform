import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// The runner's discovery (`sources.mjs`): an area's generators are its top-level `.mjs` files; an area with none there
// holds groups, one level of subfolders, whose top-level `.mjs` files are its generators (C0).
const sources = pathToFileURL(resolve(process.cwd(), "tests/families/sources.mjs")).href;
const baselines = pathToFileURL(resolve(process.cwd(), "tests/families/baselines.mjs")).href;

type Generator = { name: string; file: string };
type Sources = {
  generatorFiles: (folder: string) => string[];
  generatorsOf: (folder: string) => Promise<Generator[]>;
  holdsGenerators: (folder: string) => boolean;
};

/** A stand-in generator: its cases, and its `id` export where given. */
const generator = (cases: string[], id?: string) =>
  `${id === undefined ? "" : `export const id = ${JSON.stringify(id)};\n`}export const cases = ${JSON.stringify(
    cases.map((name) => [name, `let ${name} = 1\nexit\n`]),
  )};\n`;

/** Writes `files` (paths relative to `area`) and returns `area`. */
const area = (root: string, name: string, files: Record<string, string>) => {
  const folder = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(folder, file, ".."), { recursive: true });
    writeFileSync(join(folder, file), text);
  }
  return folder;
};

const withRoot = async (run: (root: string, s: Sources) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "families-discovery-"));
  try {
    const loaded: Sources = await import(sources);
    await run(root, loaded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("an area of groups is read one level deep, each generator in id order with its path in the area", async () => {
  await withRoot(async (root, { generatorsOf, holdsGenerators }) => {
    const folder = area(root, "grouped", {
      "b-group/x.mjs": generator(["x"]),
      "a-group/z.mjs": generator(["z"]),
      "a-group/y.mjs": generator(["y"]),
    });
    assert.equal(holdsGenerators(folder), true);
    assert.deepEqual(
      (await generatorsOf(folder)).map(({ name, file }) => [name, file]),
      [
        ["x.mjs", "b-group/x.mjs"],
        ["y.mjs", "a-group/y.mjs"],
        ["z.mjs", "a-group/z.mjs"],
      ],
    );
  });
});

test("a group's own subfolder is not read", async () => {
  await withRoot(async (root, { generatorFiles }) => {
    const folder = area(root, "grouped", {
      "group/x.mjs": generator(["x"]),
      "group/deeper/y.mjs": generator(["y"]),
    });
    assert.deepEqual(generatorFiles(folder), ["group/x.mjs"]);
  });
});

test("an area with a top-level generator reads none of its subfolders, as property/'s tool modules", async () => {
  await withRoot(async (root, { generatorFiles, generatorsOf }) => {
    // (a tool module that throws where imported: a subfolder beside a top-level generator is never read)
    const folder = area(root, "tooled", {
      "top.mjs": generator(["top"]),
      "lib/tool.mjs": 'throw new Error("a tool module was imported as a generator");\n',
      "bin/run.mjs": 'throw new Error("a tool module was imported as a generator");\n',
    });
    assert.deepEqual(generatorFiles(folder), ["top.mjs"]);
    assert.deepEqual(
      (await generatorsOf(folder)).map(({ name }) => name),
      ["top.mjs"],
    );
  });
  // the property area itself: its one generator, never its tool modules under lib/, bin/, test/, adapters/, families/
  const { generatorFiles }: Sources = await import(sources);
  assert.deepEqual(generatorFiles(resolve(process.cwd(), "tests/families/property")), [
    "s8-stores.mjs",
  ]);
});

test("a generator moved into a group keeps its sources' places and its area's PLAN, renamed too where its id keeps the old name", async () => {
  const { planOf }: { planOf: (area: string, generators: Generator[], shards: number) => string } =
    await import(baselines);
  await withRoot(async (root, { generatorsOf }) => {
    const flat = area(root, "flat/area", {
      "one.mjs": generator(["a", "b"]),
      "two.mjs": generator(["c", "d", "e"]),
    });
    const grouped = area(root, "grouped/area", {
      "first/one.mjs": generator(["a", "b"]),
      "second/renamed-two.mjs": generator(["c", "d", "e"], "two.mjs"),
    });
    assert.equal(
      planOf("area", await generatorsOf(grouped), 2),
      planOf("area", await generatorsOf(flat), 2),
    );
  });
});

test("two generators with one id in two groups are refused", async () => {
  await withRoot(async (root, { generatorsOf }) => {
    const folder = area(root, "grouped", {
      "a/same.mjs": generator(["x"]),
      "b/same.mjs": generator(["y"]),
    });
    await assert.rejects(
      generatorsOf(folder),
      /a\/same\.mjs and b\/same\.mjs have one id, same\.mjs/u,
    );
  });
});

test("an area that does not exist is refused where it is read, and holds no generator", async () => {
  await withRoot(async (root, { generatorFiles, generatorsOf, holdsGenerators }) => {
    const missing = join(root, "missing");
    assert.equal(holdsGenerators(missing), false);
    assert.throws(() => generatorFiles(missing), /ENOENT/u);
    await assert.rejects(generatorsOf(missing), /ENOENT/u);
  });
});

test("a record made before its generator moved into a group, or was renamed keeping its id, finds its area by that id", async () => {
  await withRoot(async (root, { generatorsOf }) => {
    // (a tree's tools, and its area after the move: `g.mjs` renamed keeping its id, `h.mjs` moved as it was)
    const families = join(root, "tests", "families");
    mkdirSync(families, { recursive: true });
    for (const tool of ["baselines.mjs", "run-contract.mjs", "sources.mjs", "stalls.mjs"])
      cpSync(join("tests", "families", tool), join(families, tool));
    const folder = area(families, "area", {
      "group/renamed.mjs": generator(["s"], "g.mjs"),
      "group/h.mjs": generator(["t"]),
    });
    // an `--out` record from before the move: each stalled source by its generator's id alone, no `file`
    const out = join(root, "out.jsonl");
    const {
      sourcesOf,
    }: { sourcesOf: (generator: unknown) => { name: string; files: unknown; globals: unknown }[] } =
      await import(pathToFileURL(join(families, "sources.mjs")).href);
    const record = [];
    for (const { name, file } of await generatorsOf(folder)) {
      const [source] = sourcesOf(await import(pathToFileURL(join(folder, file)).href));
      record.push(
        JSON.stringify({
          generator: name,
          source: source!.name,
          files: source!.files,
          globals: source!.globals,
          stalled: { head: "units" },
        }),
      );
    }
    writeFileSync(out, `${record.join("\n")}\n`);
    const index = spawnSync(process.execPath, [join(families, "stalls.mjs"), out], {
      encoding: "utf8",
    });
    assert.notEqual(index.status, 2, index.stderr);
    assert.match(index.stdout, /"area":"area","generator":"g\.mjs"/u);
    assert.match(index.stdout, /"area":"area","generator":"h\.mjs"/u);
    // (an id is unique within its area only: where another area holds it too, the record names no area, and is refused)
    area(families, "other", { "group/also.mjs": generator(["u"], "g.mjs") });
    const twice = spawnSync(process.execPath, [join(families, "stalls.mjs"), out], {
      encoding: "utf8",
    });
    assert.equal(twice.status, 2, twice.stderr);
    assert.match(twice.stderr, /the generator g\.mjs is an id in (area and other|other and area)/u);
  });
});
