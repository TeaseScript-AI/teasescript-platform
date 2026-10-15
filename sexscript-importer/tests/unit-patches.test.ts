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
import { isRecord } from "../src/ast.ts";
import {
  loadRepositoryPackageScanner,
  loadRepositoryProjectCompiler,
} from "../src/compile-check.ts";
import { convertUnit, type UnitOptions, type UnitResult } from "../tools/convert-corpus.ts";
import { patchedLine, PatchError, readUnitPatches, sha256 } from "../tools/unit-patches.ts";

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
      const main = path.join(options.outputRoot, "Walk/start.tease");
      const generated = await readFile(main, "utf8");
      assert.match(
        generated,
        /say prose "Hello", instant\nwait 1 s\nsay prose "Bye", instant\nexit/u,
      );

      const outputPatch = {
        id: "farewell",
        layer: "output",
        reason: "The ending says goodbye.",
        file: "start.tease",
        baseHash: sha256(generated),
        edits: [
          {
            find: 'say prose "Bye", instant\nexit',
            replace: 'showImage tagged "hall"\nsay prose "Goodbye", instant\nexit',
            count: 1,
          },
        ],
      };
      await writePatches(work, [SOURCE_PATCH, outputPatch]);
      const { record } = converted(await convertUnit(options));
      const final = await readFile(main, "utf8");
      assert.equal(
        final,
        generated.replace('say prose "Bye"', 'showImage tagged "hall"\nsay prose "Goodbye"'),
      );
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
        files: [
          { path: "main.tease", sha256: sha256('goto "start.tease"\n') },
          { path: "start.tease", sha256: sha256(final) },
        ],
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
          file: "start.tease",
          baseHash: sha256("an older start.tease"),
          edits: [{ find: 'say prose "Bye"', replace: 'say prose "Goodbye"', count: 1 }],
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
          file: "start.tease",
          baseHash: sha256(await readFile(path.join(published, "start.tease"), "utf8")),
          edits: [{ find: 'say prose "Bye"', replace: 'say prose "Goodbye"', count: 2 }],
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

test(
  "a stand-alone script that a unit holds back stays out of the start choice",
  { skip: unbuilt },
  async () => {
    const { work, options } = await fixture();
    try {
      const scripts = path.join(options.corpusRoot, "Walk/scripts");
      await writeFile(
        path.join(scripts, "walk.groovy"),
        'setInfos(9, "Walk", "A walk", "Author", "1", 0, "en", [])\nshow("Walk on")\nreturn "start"\n',
      );
      await writeFile(path.join(scripts, "reset.groovy"), 'save("walk.step", null)\n');
      converted(await convertUnit(options));
      const main = path.join(options.outputRoot, "Walk/main.tease");
      assert.match(await readFile(main, "utf8"), /Extra, not part of the story: reset/u);
      await writeFile(
        path.join(work, "patches/Walk/patches.json"),
        JSON.stringify({ heldStandAlone: { "reset.groovy": "A leftover." }, patches: [] }),
      );
      converted(await convertUnit(options));
      assert.doesNotMatch(await readFile(main, "utf8"), /Extra, not part of the story/u);
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
      file: "start.tease",
      baseHash: sha256(""),
    };
    await rejected(
      { ...output, edits: [{ find: "// NOTE SX_POPUP_WORKAROUND\n", replace: "", count: 1 }] },
      /not only notes or TODOs/u,
    );
    await rejected({ ...output, edits: [{ find: "say 1", replace: "say 2" }] }, /"count"/u);
    await rejected({ ...SOURCE_PATCH, diff: "../other/greeting.diff" }, /inside the unit's patch/u);
    await rejected({ ...SOURCE_PATCH, edits: [] }, /fields a source patch does not use/u);
    await writeFile(
      path.join(work, "patches/Walk/patches.json"),
      JSON.stringify({ heldStandAlone: { "reset.groovy": "" }, patches: [] }),
    );
    await assert.rejects(readUnitPatches(options.patchesRoot, "Walk"), /"heldStandAlone"/u);
    assert.equal(await readUnitPatches(options.patchesRoot, "Elsewhere"), null);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

const SPOKEN = [
  'def name = "Vera"',
  'show("Welcome.")',
  'show("She waves.\\n\\nMeryl: Hello.")',
  'name = "Lilith"',
  'show("I am " + name)',
  'show("Oh, Miss.")',
  'show("Bye")',
  "",
].join("\n");
const SPOKEN_DIFF = `--- a/scripts/start.groovy
+++ b/scripts/start.groovy
@@ -2,2 +2,3 @@
-show("Welcome.")
+// Legacy bug: a test edit.
+show("Welcome!")
 show("She waves.\\n\\nMeryl: Hello.")
`;
const SPOKEN_DATA = {
  speakers: { vera: { title: "Mistress", firstName: "Vera" }, meryl: { firstName: "Meryl" } },
  default: "vera",
  prefixes: [{ text: "Meryl", speaker: "meryl" }],
  switches: [
    { message: "scripts/start.groovy:6", speaker: "player" },
    { at: "scripts/start.groovy:7", speaker: "narrator" },
  ],
  names: [
    { variable: "name", files: ["scripts/start.groovy"], speaker: "vera", template: "Mistress {}" },
  ],
};

test(
  "a unit's speaker data names who says each message, at the lines of its patched scripts",
  { skip: unbuilt },
  async () => {
    const { work, options } = await fixture();
    try {
      await writeFile(path.join(options.corpusRoot, "Walk/scripts/start.groovy"), SPOKEN);
      await writeFile(path.join(work, "patches/Walk/welcome.diff"), SPOKEN_DIFF);
      await writePatches(work, [{ ...SOURCE_PATCH, id: "welcome", diff: "welcome.diff" }]);
      const speakers = path.join(work, "patches/Walk/speakers.json");
      await writeFile(speakers, JSON.stringify(SPOKEN_DATA));
      const { record } = converted(await convertUnit(options));
      assert.equal(record.speakers, sha256(JSON.stringify(SPOKEN_DATA)));
      const main = await readFile(path.join(options.outputRoot, "Walk/main.tease"), "utf8");
      assert.match(
        main,
        // The importer's own system speaker is declared only where something says as it.
        /^speaker vera \{\n {2}title: "Mistress"\n {2}firstName: "Vera"\n\}\nspeaker meryl \{\n {2}firstName: "Meryl"\n\}\nspeaker narrator \{\n {2}displayName: "Narrator"\n\}\nspeaker vera\ngoto "start.tease"/u,
      );
      const start = await readFile(path.join(options.outputRoot, "Walk/start.tease"), "utf8");
      for (const expected of [
        // A name that comes out blank names nobody.
        /name = "Lilith"\nif name != null \{\n {2}let shownName = "Mistress \$\{name\}"\.trim\(\)\n {2}if shownName != "" \{\n {4}vera\.displayName = shownName\n {2}\}\n\}/u,
        /say prose "Welcome!", instant\nsay prose "She waves\.", instant\nsay as meryl prose "Hello\.", instant/u,
        /\/\/ SX_PLAYER_LINE: [^\n]*\nsay as player prose "Oh, Miss\.", instant\nspeaker narrator\nsay prose "Bye"/u,
      ])
        assert.match(start, expected);

      // An anchor on a line a source patch changes, or one that matches nothing, fails the unit for review.
      const failed = async (data: unknown, message: RegExp): Promise<void> => {
        await writeFile(speakers, JSON.stringify(data));
        const result = await convertUnit(options);
        assert.ok(!result.converted);
        assert.match(result.failure.message, message);
      };
      await failed(
        { ...SPOKEN_DATA, switches: [{ at: "scripts/start.groovy:2", speaker: "meryl" }] },
        /a source patch changes the line of scripts\/start\.groovy:2/u,
      );
      await failed(
        { ...SPOKEN_DATA, switches: [{ after: "scripts/start.groovy:8", speaker: "meryl" }] },
        /"after": "scripts\/start\.groovy:9" starts no statement/u,
      );
      await failed(
        { ...SPOKEN_DATA, prefixes: [{ text: "Sasha", speaker: "meryl" }] },
        /"Sasha" labels no message/u,
      );
      await failed({ ...SPOKEN_DATA, default: "nobody" }, /unknown speaker "nobody"/u);
      assert.match(
        await readFile(path.join(options.outputRoot, "Walk/start.tease"), "utf8"),
        /say as meryl prose "Hello\.", instant/u,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

test("a line of a legacy script is followed through the diffs that patch it", () => {
  const diff = (file: string, hunks: string): string => `--- a/${file}\n+++ b/${file}\n${hunks}`;
  const changed = diff("scripts/a.groovy", "@@ -3,2 +3,3 @@\n x\n-y\n+y1\n+y2\n");
  const edited = diff("scripts/a.groovy", "@@ -2,3 +2,3 @@\n-p\n-q\n+P\n+Q\n r\n");
  assert.deepEqual(
    [1, 2, 3, 4].map((line) => patchedLine([edited], "scripts/a.groovy", line)),
    [1, 2, 3, 4],
  );
  const added = diff("scripts/a.groovy", "@@ -1,0 +2,2 @@\n+p\n+q\n");
  assert.deepEqual(
    [1, 2, 3, 4, 5, 9].map((line) => patchedLine([changed], "scripts/a.groovy", line)),
    [1, 2, 3, null, 6, 10],
  );
  assert.deepEqual(
    [1, 2, 5].map((line) => patchedLine([added, changed], "scripts/a.groovy", line)),
    [1, null, 8],
  );
  assert.equal(patchedLine([changed], "scripts/b.groovy", 4), 4);
});

test(
  "speaker data switches at pictures, functions, and lines, and names speakers from values, labels, and templates",
  { skip: unbuilt },
  async () => {
    const { work, options } = await fixture();
    try {
      await writeFile(
        path.join(options.corpusRoot, "Walk/scripts/start.groovy"),
        [
          'def titles = ["Miss", "Mistress"]',
          "def sex = 1",
          'def opponent = "Kim"',
          "def greet = {",
          '  show("Hello from the guest.")',
          "}",
          'setImage("door.jpg")',
          'show("Welcome.")',
          "greet()",
          'show("Back.")',
          'show(opponent + ": I play.")',
          'opponent = "Ann"',
          'show("Next.")',
          'if (getBoolean("Kitty: Ready?")) show(opponent + ": Go.")',
          'def again = getBoolean("Play again?")',
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(work, "patches/Walk/speakers.json"),
        JSON.stringify({
          speakers: {
            host: { title: "Host" },
            opp: { displayName: "Opponent" },
            guest: { displayName: "Guest" },
          },
          default: "narrator",
          prefixes: [
            { expression: "opponent", file: "scripts/start.groovy", speaker: "opp" },
            { text: "Kitty", speaker: "host" },
          ],
          switches: [
            { image: "do", speaker: "host" },
            { function: "scripts/start.groovy:greet", speaker: "guest" },
            { after: "scripts/start.groovy:9", speaker: "host" },
            { message: "scripts/start.groovy:15", speaker: "system" },
          ],
          names: [
            {
              variable: "opponent",
              files: ["scripts/start.groovy"],
              speaker: "opp",
              values: { Ann: "Anna" },
              template: "{titles[sex]} {}",
            },
            {
              after: ["scripts/start.groovy:13"],
              files: "all",
              speaker: "guest",
              template: "Guest of {opponent}",
            },
            // A role until the introduction, then the name.
            {
              after: ["scripts/start.groovy:10"],
              files: "all",
              speaker: "host",
              template: "Kitty",
            },
          ],
        }),
      );
      converted(await convertUnit(options));
      const start = await readFile(path.join(options.outputRoot, "Walk/start.tease"), "utf8");
      for (const expected of [
        /function greet \{\n {2}speaker guest\n {2}say prose "Hello from the guest\.", instant\n\}/u,
        /speaker host\nshowImage "door\.jpg"\nsay prose "Welcome\.", instant\ngreet\(\)\nspeaker host\nsay prose "Back\.", instant/u,
        /opp\.displayName = "\$\{opponent\}"\nsay as opp prose "I play\.", instant/u,
        /opponent = "Ann"\nif opponent != null and titles != null \{\n {2}let shownName = "\$\{titles\[sex\]\} \$\{dict\{ Ann: "Anna" \}\.get\(toString\(opponent\), default: opp\.displayName\)\}"\.trim\(\)/u,
        /say prose "Next\.", instant\nif opponent != null \{\n {2}let shownName = "Guest of \$\{opponent\}"\.trim\(\)/u,
        // A labelled question is asked as its speaker.
        /if askBoolean as host prose "Ready\?" \{\n {2}opp\.displayName = "\$\{opponent\}"\n {2}say as opp prose "Go\.", instant\n\}/u,
        /say prose "Back\.", instant\nhost\.displayName = "Kitty"\n/u,
        // An ask on a message switch's line is asked as its speaker.
        /let again = askBoolean as system prose "Play again\?"/u,
      ])
        assert.match(start, expected);
      const report: unknown = JSON.parse(
        await readFile(path.join(options.outputRoot, "Walk/.report.json"), "utf8"),
      );
      assert.ok(isRecord(report) && isRecord(report.finalPackage));
      assert.equal(report.finalPackage.compiles, true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
