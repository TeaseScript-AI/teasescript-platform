import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadRepositoryPackageScanner,
  loadRepositoryProjectCompiler,
} from "../src/compile-check.ts";
import { convertUnit, type UnitOptions, type UnitResult } from "../tools/convert-corpus.ts";
import { PatchError, readUnitPatches, sha256 } from "../tools/unit-patches.ts";

const SOURCE = 'show("Helo, " + greetingName())\nwait(1)\nshow("Bye")\n';
const DIFF = `--- a/scripts/start.groovy
+++ b/scripts/start.groovy
@@ -1,3 +1,3 @@
-show("Helo, " + greetingName())
+show("Hello")
 wait(1)
 show("Bye")
`;
const SOURCE_PATCH = {
  id: "greeting",
  layer: "source",
  reason: "The script calls a function no file defines.",
  category: "b",
  diff: "greeting.diff",
};

const XMP_HALL =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:subject><rdf:Bag>' +
  "<rdf:li>hall</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>\n";

// A conversion succeeds only with its report, which needs the repository build.
const unbuilt = await Promise.all([
  loadRepositoryProjectCompiler(),
  loadRepositoryPackageScanner(),
]).then(
  () => false as const,
  (error: unknown) => (error instanceof Error ? error.message : String(error)),
);

/**
 * A corpus with the unit `Walk` (one script and one image tagged `hall` in its sidecar), an empty converted root, and
 * its patch folder.
 */
async function fixture(): Promise<{ work: string; options: UnitOptions }> {
  const work = await mkdtemp(path.join(tmpdir(), "sexscript-patches-"));
  const scripts = path.join(work, "corpus/Walk/scripts");
  await mkdir(path.join(scripts, "images"), { recursive: true });
  await writeFile(path.join(scripts, "start.groovy"), SOURCE);
  await writeFile(path.join(scripts, "images/door.jpg"), "image bytes");
  await writeFile(path.join(scripts, "images/door.jpg.xmp"), XMP_HALL);
  await mkdir(path.join(work, "patches/Walk"), { recursive: true });
  await writeFile(path.join(work, "patches/Walk/greeting.diff"), DIFF);
  return {
    work,
    options: {
      corpusRoot: path.join(work, "corpus"),
      outputRoot: path.join(work, "converted"),
      id: "Walk",
      resources: [],
      patchesRoot: path.join(work, "patches"),
      converter: "test",
    },
  };
}

async function writePatches(work: string, patches: readonly unknown[]): Promise<void> {
  await writeFile(path.join(work, "patches/Walk/patches.json"), JSON.stringify({ patches }));
}

/** Every file of a folder with its content and inode, to show it was not touched. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(root, file)] = `${(await stat(file)).ino} ${await readFile(file, "utf8")}`;
  }
  return result;
}

function converted(result: UnitResult): Extract<UnitResult, { converted: true }> {
  if (!result.converted) assert.fail(`${result.failure.stage}: ${result.failure.message}`);
  return result;
}

async function noStaging(outputRoot: string): Promise<void> {
  assert.deepEqual(await readdir(path.join(outputRoot, ".staging")).catch(() => []), []);
}

test(
  "a unit's patches apply on every conversion, and its report checks the patched package as written",
  { skip: unbuilt },
  async () => {
    const { work, options } = await fixture();
    try {
      await writePatches(work, [SOURCE_PATCH]);
      converted(await convertUnit(options));
      const main = path.join(options.outputRoot, "Walk/main.tease");
      const generated = await readFile(main, "utf8");
      assert.match(generated, /say "Hello"\nwait 1\nsay "Bye"\nexit/u);

      const outputPatch = {
        id: "farewell",
        layer: "output",
        reason: "The ending says goodbye.",
        file: "main.tease",
        baseHash: sha256(generated),
        edits: [
          {
            find: 'say "Bye"\nexit',
            replace: 'showImage tagged "hall"\nsay "Goodbye"\nexit',
            count: 1,
          },
        ],
      };
      await writePatches(work, [SOURCE_PATCH, outputPatch]);
      const { record } = converted(await convertUnit(options));
      const final = await readFile(main, "utf8");
      assert.equal(final, generated.replace('say "Bye"', 'showImage tagged "hall"\nsay "Goodbye"'));
      // The corpus keeps its own script; the staged copy that was patched is gone.
      assert.equal(
        await readFile(path.join(options.corpusRoot, "Walk/scripts/start.groovy"), "utf8"),
        SOURCE,
      );
      await noStaging(options.outputRoot);
      assert.equal(
        (await stat(path.join(options.outputRoot, "Walk/door.jpg"))).ino,
        (await stat(path.join(options.corpusRoot, "Walk/scripts/images/door.jpg"))).ino,
      );

      assert.deepEqual(
        JSON.parse(await readFile(path.join(options.outputRoot, "Walk/.conversion.json"), "utf8")),
        record,
      );
      assert.equal(record.converter, "test");
      assert.deepEqual(record.inputs, { "scripts/start.groovy": sha256(SOURCE) });
      assert.deepEqual(record.patches, [
        { id: "greeting", layer: "source", sha256: sha256(DIFF) },
        { id: "farewell", layer: "output", sha256: sha256(JSON.stringify(outputPatch)) },
      ]);

      // The report reads the patched sources and checks the files as written, with the package's tagged images.
      const written: unknown = JSON.parse(
        await readFile(path.join(options.outputRoot, "Walk/.report.json"), "utf8"),
      );
      assert.ok(typeof written === "object" && written !== null && "finalPackage" in written);
      assert.equal("migrationCleanFileCount" in written && written.migrationCleanFileCount, 1);
      assert.deepEqual(written.finalPackage, {
        files: [{ path: "main.tease", sha256: sha256(final) }],
        imageCount: 1,
        problems: [],
        compiles: true,
        failingFiles: [],
        errorsByMessage: {},
        run: { status: "halted", failure: null, steps: 1 },
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

test(
  "a stale patch stops its unit, which keeps its previous output",
  { skip: unbuilt },
  async () => {
    const { work, options } = await fixture();
    try {
      await writePatches(work, [SOURCE_PATCH]);
      converted(await convertUnit(options));
      const published = path.join(options.outputRoot, "Walk");
      const before = await snapshot(published);
      const failure = path.join(options.outputRoot, ".failures/Walk.json");

      // The legacy script changed below the diff.
      await writeFile(
        path.join(options.corpusRoot, "Walk/scripts/start.groovy"),
        SOURCE.replace("Helo", "Hi"),
      );
      const staleDiff = await convertUnit(options);
      assert.equal(staleDiff.converted, false);
      assert.equal(!staleDiff.converted && staleDiff.failure.stage, "source patch");
      assert.match(!staleDiff.converted ? staleDiff.failure.message : "", /does not apply/u);
      assert.deepEqual(await snapshot(published), before);
      assert.equal(JSON.parse(await readFile(failure, "utf8")).stage, "source patch");
      await noStaging(options.outputRoot);

      // The converter changed the file an output patch was written for.
      await writeFile(path.join(options.corpusRoot, "Walk/scripts/start.groovy"), SOURCE);
      await writePatches(work, [
        SOURCE_PATCH,
        {
          id: "farewell",
          layer: "output",
          reason: "The ending says goodbye.",
          file: "main.tease",
          baseHash: sha256("an older main.tease"),
          edits: [{ find: 'say "Bye"', replace: 'say "Goodbye"', count: 1 }],
        },
      ]);
      const staleOutput = await convertUnit(options);
      assert.equal(!staleOutput.converted && staleOutput.failure.stage, "output patch");
      assert.match(!staleOutput.converted ? staleOutput.failure.message : "", /another version/u);
      assert.deepEqual(await snapshot(published), before);

      // A conversion that succeeds again clears the failure.
      await writePatches(work, [SOURCE_PATCH]);
      converted(await convertUnit(options));
      assert.equal(await stat(failure).catch(() => null), null);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

test(
  "a failure at the last step before the replacement leaves no partial replacement",
  { skip: unbuilt || (process.getuid?.() === 0 ? "root ignores folder permissions" : false) },
  async () => {
    const { work, options } = await fixture();
    try {
      await writePatches(work, [SOURCE_PATCH]);
      converted(await convertUnit(options));
      const published = path.join(options.outputRoot, "Walk");
      const before = await snapshot(published);
      await writePatches(work, []);
      // The unit is converted, linked, and reported in the staging folder, but the published folder cannot move.
      await mkdir(path.join(options.outputRoot, ".staging"), { recursive: true });
      await mkdir(path.join(options.outputRoot, ".failures"), { recursive: true });
      await chmod(options.outputRoot, 0o555);
      let result: UnitResult;
      try {
        result = await convertUnit(options);
      } finally {
        await chmod(options.outputRoot, 0o755);
      }
      assert.equal(!result.converted && result.failure.stage, "replacement");
      assert.deepEqual(await snapshot(published), before);
      await noStaging(options.outputRoot);

      // An output patch whose anchor count differs fails before anything moves, too.
      await writePatches(work, [
        SOURCE_PATCH,
        {
          id: "farewell",
          layer: "output",
          reason: "The ending says goodbye.",
          file: "main.tease",
          baseHash: sha256(await readFile(path.join(published, "main.tease"), "utf8")),
          edits: [{ find: 'say "Bye"', replace: 'say "Goodbye"', count: 2 }],
        },
      ]);
      const counted = await convertUnit(options);
      assert.equal(!counted.converted && counted.failure.stage, "output patch");
      assert.match(!counted.converted ? counted.failure.message : "", /expects 2 .* found 1/u);
      assert.deepEqual(await snapshot(published), before);

      // A replacement interrupted between its two moves left the previous output in the staging folder; the next
      // conversion restores it, even when that conversion fails.
      await mkdir(path.join(options.outputRoot, ".staging/Walk"), { recursive: true });
      await rename(published, path.join(options.outputRoot, ".staging/Walk/previous"));
      const recovered = await convertUnit(options);
      assert.equal(recovered.converted, false);
      assert.deepEqual(await snapshot(published), before);
      await noStaging(options.outputRoot);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

test("patch manifests are checked before anything is applied", async () => {
  const { work, options } = await fixture();
  try {
    const rejected = async (patch: Record<string, unknown>, message: RegExp) => {
      await writePatches(work, [patch]);
      await assert.rejects(readUnitPatches(options.patchesRoot, "Walk"), (error: unknown) => {
        assert.ok(error instanceof PatchError);
        assert.match(error.message, message);
        return true;
      });
    };
    const output = {
      id: "note",
      layer: "output",
      reason: "r",
      file: "main.tease",
      baseHash: sha256(""),
    };
    await rejected(
      { ...output, edits: [{ find: "// NOTE SX_POPUP_WORKAROUND\n", replace: "", count: 1 }] },
      /not only notes or TODOs/u,
    );
    await rejected({ ...output, edits: [{ find: "say 1", replace: "say 2" }] }, /"count"/u);
    await rejected({ ...SOURCE_PATCH, diff: "../other/greeting.diff" }, /inside the unit's patch/u);
    await rejected({ ...SOURCE_PATCH, edits: [] }, /fields a source patch does not use/u);
    assert.equal(await readUnitPatches(options.patchesRoot, "Elsewhere"), null);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
