// Source-to-target conversion examples: real Groovy 2.5.21 parsing, importer lowering, and the real
// TeaseScript compiler. Each `fixtures/<group>/NAME.groovy` has the expected idiomatic `NAME.tease`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadRepositoryCompiler,
  loadRepositoryProjectCompiler,
  type TeaseCompiler,
  type TeaseProjectCompiler,
} from "../src/compile-check.ts";
import { emitTease } from "../src/emit-tease.ts";
import type { IrExpression, IrStatement, MigrationProgram } from "../src/ir.ts";
import {
  lowerPackage,
  lowerSelfContainedPackage,
  packageOutputs,
  type PackageOptions,
} from "../src/package.ts";
import { helperStatements } from "../src/helpers.ts";
import { imageCatalog, pathTag } from "../src/image-tags.ts";
import { pendingHostFunctions, shimPendingCapabilities } from "../src/pending.ts";
import { ACCEPTED_FORMS } from "../src/workarounds.ts";
import { analyzeFeasibility } from "../src/report.ts";
import {
  loadRepositoryProjectRunner,
  loadRepositoryRunner,
  type HostFunction,
  type TeaseProjectRunner,
  type TeaseRunner,
} from "../src/runtime-check.ts";
import { parseGroovySource } from "../src/source-parser.ts";
import { lowerParsedFile } from "../src/lower.ts";
import { repositoryBuildUrl } from "../src/repository-build.ts";

const parserUnavailable = groovyParserUnavailableReason();
const compilerResult = await loadRepositoryCompiler().then(
  (compiler): { compiler: TeaseCompiler } | { reason: string } => ({ compiler }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);
const runnerResult = await loadRepositoryRunner().then(
  (runner): { runner: TeaseRunner } | { reason: string } => ({ runner }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);
// The package gate and smoke runs compile and run a package as one project (ADR 0022).
const projectResult = await Promise.all([
  loadRepositoryProjectCompiler(),
  loadRepositoryProjectRunner(),
]).then(
  ([compiler, runner]):
    { compiler: TeaseProjectCompiler; runner: TeaseProjectRunner } | { reason: string } => ({
    compiler,
    runner,
  }),
  (error: unknown) => ({ reason: error instanceof Error ? error.message : String(error) }),
);

// Output that uses only implemented TeaseScript must compile as generated.
registerFixtures("conversion", false);
// The accepted forms the importer otherwise replaces with workarounds (popups, boolean lists, URLs, files), which the
// current compiler does not implement yet, must compile once they are replaced by placeholder calls, so everything
// except the pending capabilities is compiler-checked.
registerFixtures("conversion-accepted", true, { accepted: new Set(ACCEPTED_FORMS) });

function registerFixtures(
  directoryName: string,
  usesPendingCapabilities: boolean,
  options: PackageOptions = {},
): void {
  const directory = fileURLToPath(new URL(`./fixtures/${directoryName}/`, import.meta.url));
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".groovy"))
    .map((name) => name.slice(0, -".groovy".length))
    .sort();
  for (const name of names) {
    const sourcePath = path.join(directory, `${name}.groovy`);
    const expected = readFileSync(path.join(directory, `${name}.tease`), "utf8");

    test(
      `converts ${directoryName}/${name}.groovy to the expected TeaseScript`,
      { skip: parserUnavailable },
      async () => {
        assert.equal(emitTease(await convert(sourcePath, options)), expected);
      },
    );

    const compilerSkip = "reason" in projectResult ? projectResult.reason : false;
    test(
      usesPendingCapabilities
        ? `${directoryName}/${name} output compiles apart from pending TeaseScript capabilities`
        : `expected ${directoryName}/${name}.tease compiles with the TeaseScript compiler`,
      { skip: compilerSkip || (usesPendingCapabilities && parserUnavailable) },
      async () => {
        if (!("compiler" in projectResult)) return;
        let source = expected;
        let builtins: string[] = [];
        if (usesPendingCapabilities) {
          const shim = shimPendingCapabilities(await convert(sourcePath, options));
          assert.ok(shim.capabilities.size > 0, "fixture group expects pending capabilities");
          source = shim.source;
          builtins = shim.builtins;
        }
        const result = projectResult.compiler(withTransferTargets(source), builtins);
        assert.deepEqual(
          result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
          [],
        );
        assert.equal(result.compiled, true);
      },
    );

    // One deterministic path through the output runs in the real runtime; pending capabilities use small host
    // stand-ins.
    const runnerSkip = "reason" in projectResult ? projectResult.reason : false;
    test(
      `${directoryName}/${name} output runs to the end in the TeaseScript runtime`,
      { skip: runnerSkip || (usesPendingCapabilities && parserUnavailable) },
      async () => {
        if (!("runner" in projectResult)) return;
        let source = expected;
        let builtins: Record<string, HostFunction> = {};
        if (usesPendingCapabilities) {
          const shim = shimPendingCapabilities(await convert(sourcePath, options));
          source = shim.source;
          builtins = pendingHostFunctions(shim);
        }
        const result = projectResult.runner(withTransferTargets(source), builtins);
        assert.deepEqual(
          { status: result.status, failure: result.failure },
          { status: "halted", failure: null },
        );
      },
    );
  }
}

// A legacy image count becomes a tag query: each package image carries a generated tag for its full folder path, so
// the images with the listed folder's tag are exactly its images. A name filter keeps the conversion-time count.
test(
  "counts a listed images folder by the tag of its path",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-images-"));
    try {
      const sourcePath = path.join(directory, "packs.groovy");
      writeFileSync(
        sourcePath,
        [
          "def pack = 2",
          'def count = new File("images/Mistress/Pack ${pack}/").listFiles().size()',
          'def fixed = new File("images/Mistress/Pack 1/").listFiles().size()',
          'def photos = new File("images/Mistress/Pack 1/").listFiles().findAll { it.name ==~ /(?i).*\\.jpg/ }.size()',
          "def one = [1]",
          // Each count is right only if the tags match: a wrong one reads outside the list.
          'show("Pack ${pack}: ${one[count - 1]} ${one[fixed - 2]} ${one[photos - 1]}")',
          "",
        ].join("\n"),
      );
      const media = [
        "Mistress/Pack 1/a.jpg",
        "Mistress/Pack 1/b.png",
        "Mistress/Pack 2/c.JPG",
        "Other/d.jpg",
      ].map((file) => ({ path: file }));
      const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], { media });
      const source = emitTease(program!);
      assert.match(
        source,
        /^let count = findImages\(all: \[sexscriptLegacyPathTag\("images\/Mistress\/Pack \$\{pack\}"\)\]\)\.length$/mu,
      );
      assert.match(
        source,
        /^let fixed = findImages\(all: \["images-mistress-pack-1"\]\)\.length$/mu,
      );
      assert.match(source, /^let photos = 1$/mu);
      assert.match(source, /NOTE SX_IMAGE_TAGS/u);
      assert.match(source, /NOTE SX_IMAGE_COUNT_WORKAROUND/u);
      const result = projectResult.runner(
        [{ path: "main.tease", source }],
        {},
        { images: imageCatalog(media) },
      );
      assert.deepEqual(
        { status: result.status, failure: result.failure },
        { status: "halted", failure: null },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A legacy folder listing becomes the package paths of the folder's images, found by the tag of its path; a missing
// folder, whose listing was null, has no images.
test(
  "lists an images folder as the package paths of its images",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-listing-"));
    try {
      const sourcePath = path.join(directory, "listing.groovy");
      writeFileSync(
        sourcePath,
        [
          "def pick = { name ->",
          '  def folder = new File(System.getProperty("user.dir") + "/images/Mistress/" + name + "/")',
          "  def files = folder.listFiles()",
          '  if (files == null) return "none"',
          "  return files[getRandom(files.length)].toString()",
          "}",
          'save("picked", pick("Pack 2"))',
          'save("missing", pick("Pack 3"))',
          'save("count", new File(getDataFolder() + "images/Mistress/Pack 1").listFiles().length)',
          'def listed = new File("images/Mistress/Pack 1").listFiles()',
          'def names = listed.findAll { f -> f.name.endsWith(".jpg") }.name',
          'names += listed.findAll { f -> f.name.endsWith(".png") }.name',
          'save("names", names.join(","))',
          "",
        ].join("\n"),
      );
      const media = ["Mistress/Pack 1/a.jpg", "Mistress/Pack 1/b.png", "Mistress/Pack 2/c.JPG"].map(
        (file) => ({ path: file }),
      );
      const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], { media });
      const source = emitTease(program!);
      assert.match(
        source,
        /^ {2}let files = findImages\(all: \[sexscriptLegacyPathTag\(folder\)\]\)$/mu,
      );
      assert.match(source, /^ {2}if files\.length == 0 \{$/mu);
      const storage = new Map();
      const result = projectResult.runner(
        [{ path: "main.tease", source }],
        {},
        { images: imageCatalog(media), storage },
      );
      assert.deepEqual(
        { status: result.status, failure: result.failure },
        { status: "halted", failure: null },
      );
      assert.deepEqual(Object.fromEntries(storage), {
        picked: "Mistress/Pack 2/c.JPG",
        missing: "none",
        count: 2,
        names: "a.jpg,b.png",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A walk through an images folder goes through the folder's images; a whole match of a name that ends with digits and
// an extension keeps the images Groovy kept.
test(
  "walks an images folder as its images with a name filter",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-walk-"));
    try {
      const sourcePath = path.join(directory, "walk.groovy");
      writeFileSync(
        sourcePath,
        [
          'def set = "Pack 1"',
          "def names = []",
          'new File("images/Mistress/" + set + "/").eachFile() { file ->',
          "  if (file.isFile() && (file.name ==~ /.*\\d+\\.jpg/ || file.name ==~ /(?i).*\\d+\\.png/)) {",
          "    names << file.name",
          "  }",
          "}",
          'save("names", names.join(","))',
          "",
        ].join("\n"),
      );
      const media = [
        "Mistress/Pack 1/a1.jpg",
        "Mistress/Pack 1/b22.PNG",
        "Mistress/Pack 1/cover.jpg",
      ].map((file) => ({ path: file }));
      const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], { media });
      const source = emitTease(program!);
      assert.match(source, /^for file in findImages\(all: \[sexscriptLegacyPathTag\(/mu);
      const storage = new Map();
      const result = projectResult.runner(
        [{ path: "main.tease", source }],
        {},
        { images: imageCatalog(media), storage },
      );
      assert.deepEqual(
        { status: result.status, failure: result.failure },
        { status: "halted", failure: null },
      );
      assert.equal(storage.get("names"), "a1.jpg,b22.PNG");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// The pathTag helper gives a computed folder at runtime the tag that the sidecars carry from conversion.
test(
  "the runtime path tag of a folder equals its conversion-time tag",
  { skip: "reason" in projectResult ? projectResult.reason : false },
  () => {
    if (!("runner" in projectResult)) return;
    const folders = ["images/Domme3/Pack 2/", "Images\\Bébé  Ünd/x_y", "--a--b--", "images"];
    const literal = (text: string) => JSON.stringify(text);
    const source = [
      emitTease({
        sourceName: "tags.groovy",
        metadata: null,
        statements: helperStatements(new Set(["pathTag"])),
        diagnostics: [],
      }).trimEnd(),
      `let folders = [${folders.map(literal).join(", ")}]`,
      `let tags = [${folders.map((folder) => literal(pathTag(folder))).join(", ")}]`,
      "let none = []",
      "let index = 0",
      "for folder in folders {",
      "  if sexscriptLegacyPathTag(folder) != tags[index] {",
      "    say none[0]",
      "  }",
      "  index += 1",
      "}",
      "exit",
      "",
    ].join("\n");
    const result = projectResult.runner([{ path: "main.tease", source }], {});
    assert.deepEqual(
      { status: result.status, failure: result.failure },
      { status: "halted", failure: null },
    );
    assert.deepEqual(folders.map(pathTag), [
      "images-domme3-pack-2",
      "images-b-b-nd-x-y",
      "a-b",
      "images",
    ]);
  },
);

// A legacy file test reads the package's files at conversion time: a literal path is true or false, a computed one is
// looked up among the files below its fixed beginning, and a program never exists.
test(
  "tests whether a file exists against the package's files",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-files-"));
    try {
      const sourcePath = path.join(directory, "files.groovy");
      writeFileSync(
        sourcePath,
        [
          'def picture = new File("images/Room/bed.jpg")',
          'if (picture.exists()) show("Bed")',
          'if (!new File(getDataFolder() + "/tools/zap.exe").exists()) show("No zapper")',
          "def n = 2",
          'if (new File("images/Room/chair${n}.jpg").exists()) show("Chair")',
          "",
        ].join("\n"),
      );
      const files = [
        "images/Room/bed.jpg",
        "images/Room/chair2.jpg",
        "images/Hall/door.jpg",
        "tools/zap.exe",
      ];
      const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], { files });
      const source = emitTease(program!);
      assert.match(source, /^let picture = "images\/Room\/bed\.jpg"$/mu);
      assert.match(source, /^if true \{\n {2}say "Bed"/mu);
      assert.match(source, /^if not false \{\n {2}say "No zapper"/mu);
      assert.match(
        source,
        /\["images\/room\/chair2\.jpg"\]\.contains\(sexscriptLegacyPackagePath\("images\/Room\/chair\$\{n\}\.jpg"\)\)/u,
      );
      const result = projectResult.runner([{ path: "main.tease", source }], {});
      assert.deepEqual(
        { status: result.status, failure: result.failure },
        { status: "halted", failure: null },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// The legacy player found media files ignoring letter case, around spaces, and below a repeated folder name; the
// converted path names the file, and a MIDI file names the MP3 the package converts it to.
// The smoke run's probe line can add a paragraph break after it; failure lines still name the written file's line.
test(
  "reports a smoke-run failure at the line of the written file below a file header",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-lines-"));
    try {
      const sourcePath = path.join(directory, "start.groovy");
      writeFileSync(
        sourcePath,
        'setInfos(4, "Lines", "A check.", "Me", "v1", 0xFFFFFF, "en", ["test"])\n\n// After a break.\ndef list = []\nshow(list[2])\n',
      );
      const files = [await parseGroovySource(sourcePath)];
      const written = emitTease(lowerSelfContainedPackage(files)[0]!).split("\n");
      const report = analyzeFeasibility(files, {
        compiler: projectResult.compiler,
        runner: projectResult.runner,
      });
      assert.equal(
        report.smokeRuns[0]?.failure?.line,
        written.findIndex((line) => line.startsWith("say listValue[2]")) + 1,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A file with an unconverted statement, kept as a TODO comment, still runs where it compiles, as in the Player.
test(
  "smoke-runs a compiling file that keeps unconverted statements as TODO comments",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-todo-run-"));
    try {
      const sourcePath = path.join(directory, "start.groovy");
      writeFileSync(sourcePath, 'show("Before")\nnew java.awt.Robot().delay(5)\nshow("After")\n');
      const report = analyzeFeasibility([await parseGroovySource(sourcePath)], {
        compiler: projectResult.compiler,
        runner: projectResult.runner,
      });
      assert.equal(report.loweredScriptFileCount, 0);
      assert.deepEqual(
        report.smokeRuns.map(({ status, visited }) => ({ status, visited })),
        [{ status: "halted", visited: ["main.tease", "start.tease"] }],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("names media files as the package holds them", { skip: parserUnavailable }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sexscript-media-"));
  try {
    const sourcePath = path.join(directory, "media.groovy");
    writeFileSync(
      sourcePath,
      [
        'setImage("Peach/One.JPG")',
        'setImage("peach/two.jpg ")',
        'setImage("images/peach/three.jpg")',
        'setImage("peach/peach/four.jpg")',
        'playSound("music/theme.mid")',
        'setImage("room/bed.jpg")',
        'setImage("Domme/Domme43.jpg")',
        'setImage("")',
        "",
      ].join("\n"),
    );
    const files = [
      "images/peach/one.jpg",
      "images/peach/two.jpg",
      "images/peach/three.jpg",
      "images/peach/four.jpg",
      "images/room/Bed.jpg",
      "images/room/bed.JPG",
      "sounds/music/theme.mid",
    ];
    const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], { files });
    const source = emitTease(program!);
    for (const expected of [
      'showImage "peach/one.jpg"',
      'showImage "peach/two.jpg"',
      'showImage "peach/three.jpg"',
      'showImage "peach/four.jpg"',
      'playAudio "music/theme.mp3"',
      'showImage "room/bed.jpg"',
      // A path that no file matches stays as written, with a note; the legacy player found nothing either.
      'showImage "Domme/Domme43.jpg"',
    ])
      assert.ok(source.includes(`\n${expected}\n`), expected);
    assert.match(source, /NOTE SX_MEDIA_PATH_CASE line 6/u);
    assert.match(
      source,
      /NOTE SX_MEDIA_MISSING line 7: No file in the package matches "Domme\/Domme43.jpg"; unless the script creates it/u,
    );
    assert.equal(source.match(/SX_MEDIA_MISSING/gu)?.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// With --accepted=layeredScene, a straight-line image composition becomes the accepted layered scene: the base image as
// the background and each drawn image as an overlay at percentages of the canvas.
test(
  "expresses an image composition as the accepted layered scene when that form is selected",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-scene-"));
    try {
      const sourcePath = path.join(directory, "scene.groovy");
      writeFileSync(
        sourcePath,
        [
          "def compose = { ->",
          '  def room = javax.imageio.ImageIO.read(new File("images/room.jpg"))',
          '  def lady = javax.imageio.ImageIO.read(new File("images/lady.png"))',
          "  def frame = new java.awt.image.BufferedImage(room.getWidth(), room.getHeight(), 6)",
          "  def graphics = frame.createGraphics()",
          "  graphics.drawImage(room, 0, 0, null)",
          "  graphics.drawImage(lady, 200, 100, 100, 200, null)",
          "  def bytes = new java.io.ByteArrayOutputStream()",
          '  javax.imageio.ImageIO.write(frame, "png", bytes)',
          "  setImage(bytes.toByteArray(), 0)",
          "}",
          "compose()",
          "",
        ].join("\n"),
      );
      const media = [
        { path: "room.jpg", tags: [], width: 800, height: 400 },
        { path: "lady.png", tags: [], width: 100, height: 200 },
      ];
      const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], {
        media,
        accepted: new Set(["layeredScene"]),
      });
      const source = emitTease(program!);
      assert.match(source, /showBackgroundImage\(image: "room\.jpg"\)/u);
      assert.match(
        source,
        /showOverlayImage\(image: "lady\.png", x: 25, y: 25, width: 12\.5, height: 50, anchor: "topLeft", relativeTo: "background"\)/u,
      );
      assert.match(source, /NOTE SX_LAYERED_SCENE line 1/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

/** A fixture as the main.tease of a project, with a file that just ends for each file it transfers to. */
function withTransferTargets(source: string): Array<{ path: string; source: string }> {
  const targets = [...source.matchAll(/^\s*goto "([^"]+)"/gmu)].map((match) => match[1]!);
  return [
    { path: "main.tease", source },
    ...[...new Set(targets)].map((target) => ({ path: target, source: "exit\n" })),
  ];
}

// Lone CR line endings cannot live in a committed fixture without tripping whitespace checks.
test(
  "keeps lone-CR legacy line endings aligned with comments",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-cr-"));
    try {
      const sourcePath = path.join(directory, "carriage-return-lines.groovy");
      writeFileSync(sourcePath, '// header\rwait(2)\rshow("done") // trailing\r');
      assert.equal(
        emitTease(await convert(sourcePath)),
        '// header\nwait 2\nsay "done" // trailing\nexit\n',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A Groovy variable that held values of several types becomes a declared union (ADR 0021 §3), also when it starts as
// null or holds a function result; types the importer writes no union for are reported.
test(
  "declares a union for a variable that holds values of several types and reports types without one",
  { skip: parserUnavailable || ("reason" in compilerResult ? compilerResult.reason : false) },
  async () => {
    if (!("compiler" in compilerResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-types-"));
    try {
      const sourcePath = path.join(directory, "type-change.groovy");
      writeFileSync(
        sourcePath,
        [
          'def lines = "One"',
          'if (getBoolean("Long?")) lines = ["One", "Two"]',
          'show("${lines.size()}")',
          "def value = null",
          'value = "text"',
          "value = [1, 2]",
          'def label = { -> return "x" }',
          "def text = label()",
          'if (getBoolean("More?")) text = [1]',
          "show(text)",
          'def span = "a"',
          'if (getBoolean("Range?")) span = 1..3',
          'show("${span}")',
          "",
        ].join("\n"),
      );
      const program = await convert(sourcePath);
      assert.deepEqual(
        program.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map(({ code, span }) => ({ code, line: span?.line })),
        [{ code: "SX_TYPE_CHANGE", line: 11 }],
      );
      const output = emitTease(program);
      assert.match(
        output,
        /^\/\/ NOTE SX_UNION_TYPE line 1: .* declares it 'string \| string\[\]'/mu,
      );
      assert.match(output, /^let lines: string \| string\[\] = "One"$/mu);
      assert.match(output, /^let value: string \| integer\[\] \| null = null$/mu);
      assert.match(output, /^let text: string \| integer\[\] = \w+\(\)$/mu);
      assert.match(
        output,
        /^\/\/ TODO SX_TYPE_CHANGE line 11: 'span' starts as text \(string\), but is later set to a range \(line 12\)\./mu,
      );
      // Only the reported variable fails to compile: the uses of the unions need no type test.
      const errors = compilerResult
        .compiler(output)
        .diagnostics.filter((item) => item.severity === "error");
      assert.ok(errors.length > 0);
      assert.ok(
        errors.every((item) => item.message.includes("'span'")),
        JSON.stringify(errors),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// A dict has one value type, also for property writes and list elements, only a map held in a variable converts to
// one, and a dict never equals an object (#536).
test(
  "reports dicts with mixed values, runtime keys on maps not held in a variable, and dict-object comparisons",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-dict-"));
    try {
      const sourcePath = path.join(directory, "dict.groovy");
      writeFileSync(
        sourcePath,
        [
          "def params = [:]",
          'def key = "level"',
          "params[key] = 3",
          'params["name"] = "Ada"',
          "def holder = [inner: 1]",
          "holder.inner[key] = 1",
          "def scores = [:]",
          "scores[key] = 1",
          'scores.bonus = "text"',
          'def lists = [a: [1], b: ["two"]]',
          'show("${lists[key]}")',
          "def made = { -> return [level: 3] }",
          "def counts = [:]",
          "counts[key] = 1",
          'if (counts == made()) show("Same")',
          "",
        ].join("\n"),
      );
      const program = await convert(sourcePath);
      assert.deepEqual(
        program.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map(({ code, span }) => ({ code, line: span?.line })),
        [
          { code: "SX_DICT_VALUE_TYPE", line: 1 },
          { code: "SX_UNSUPPORTED_DECLARATION_VALUE", line: 1 },
          { code: "SX_DYNAMIC_MAP_ACCESS", line: 6 },
          { code: "SX_UNSUPPORTED_ASSIGNMENT_TARGET", line: 6 },
          // A property write stores text in a dict of numbers.
          { code: "SX_DICT_VALUE_TYPE", line: 7 },
          { code: "SX_UNSUPPORTED_DECLARATION_VALUE", line: 7 },
          // Lists of numbers and lists of text are values of two types.
          { code: "SX_DICT_VALUE_TYPE", line: 10 },
          { code: "SX_UNSUPPORTED_DECLARATION_VALUE", line: 10 },
          { code: "SX_COLLECTION_TEXT", line: 11 },
          { code: "SX_UNSUPPORTED_ARGUMENT", line: 11 },
          { code: "SX_DICT_EQUALITY", line: 15 },
          { code: "SX_UNSUPPORTED_IF", line: 15 },
        ],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// Appends, list literals, list cases, and text defaults whose Groovy meaning depends on a type.
test(
  "converts list appends, list cases, and text defaults only as far as their types are proven",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-proven-"));
    try {
      const sourcePath = path.join(directory, "proven.groovy");
      writeFileSync(
        sourcePath,
        [
          'def extra = { -> return ["b"] }',
          "def build = { more ->",
          '  def items = ["a"]',
          "  items += 1..3",
          "  items += more",
          "  items += extra()",
          "  return items",
          "}",
          "def other = { -> def items = extra(); return items }",
          'def weights = [1, 2]; weights = [3, "four"]',
          "switch (getRandom(9)) { case [1..3, 5]: show('hit'); break; case 7: show('seven') }",
          'def code = getString("Code?", 42)',
          'def answer = getString("Settings?", [level: 2])',
          'showButton("Too late", -1)',
          'show([[1, 2], [3, 4]].join("|"))',
          'def xs = ["a"]',
          "def ys = xs",
          "xs.add([1, 2])",
          'show(ys.join(", "))',
          'def digit = "3"',
          "int code = digit",
          'def zs = ["a"]',
          "def ws = zs",
          "ws.add([1, 2])",
          'show(ws.join("|"))',
          // A function nothing calls only notes its problems.
          "build(5)",
          "",
        ].join("\n"),
      );
      const program = await convert(sourcePath);
      const output = emitTease(program);
      // A range is a list in Groovy, so its elements are appended.
      assert.match(output, /^ {2}items = sexscriptLegacyConcat\(\[items, 1\.\.=3\]\)$/mu);
      // A value that may be a list or one element is decided at runtime; a function result is a list.
      assert.match(output, /^ {2}items \+= sexscriptLegacyListPart\(more\)$/mu);
      assert.match(output, /^ {2}items \+= extra\(\)$/mu);
      // A list literal is checked element by element, as the compiler does; mixed elements need a union.
      assert.match(output, /^let weights: \(integer \| string\)\[\] = \[1, 2\]$/mu);
      // A list case holding a range keeps Groovy's membership test.
      assert.match(output, /\[1\.\.=3, 5\]\.contains\(/u);
      // Legacy showed a number default as text; a map default has no text form.
      assert.match(output, /^let code = askText "Code\?", default: "42"$/mu);
      assert.match(output, /^\/\/ TODO SX_INPUT_PREFILL_VALUE line 13: /mu);
      // A negative button timeout failed in legacy and is rejected by TeaseScript.
      assert.match(output, /^\/\/ TODO SX_BUTTON_TIMEOUT line 14: /mu);
      // join() of nested lists printed them in Groovy and fails in TeaseScript, also through an alias.
      assert.match(output, /^\/\/ TODO SX_LIST_JOIN line 15: /mu);
      assert.match(output, /^\/\/ TODO SX_LIST_JOIN line 19: /mu);
      // Groovy stored a one-character text in an int as its character code.
      assert.match(output, /^\/\/ TODO SX_INTEGER_FROM_TEXT line 21: /mu);
      // Elements added through an alias reach the list it shares.
      assert.match(output, /^\/\/ TODO SX_LIST_JOIN line 25: /mu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "package smoke run follows script transfers with shared storage",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-flow-"));
    try {
      mkdirSync(path.join(directory, "pack"));
      const main = path.join(directory, "main.groovy");
      const next = path.join(directory, "pack", "next.groovy");
      const unreached = path.join(directory, "pack", "unreached.groovy");
      writeFileSync(main, 'save("level", 3)\nreturn "pack/next.groovy"\n');
      // Without the entry's saved level, the comparison would fail at runtime.
      writeFileSync(next, 'if (loadInteger("level") > 2) show("High level")\n');
      // A key that only a loop condition reads is declared in main.tease, which an isolated run keeps.
      writeFileSync(
        unreached,
        'show("Only isolated")\nwhile (loadBoolean("seen") == null) save("seen", true)\n',
      );
      const files = await Promise.all(
        [main, next, unreached].map((file) => parseGroovySource(file)),
      );
      const report = analyzeFeasibility(files, {
        compiler: projectResult.compiler,
        runner: projectResult.runner,
      });
      assert.deepEqual(
        report.smokeRuns.map(({ entry, isolated, status, visited, transfers }) => ({
          entry,
          isolated,
          status,
          visited,
          transfers,
        })),
        [
          {
            entry: "main.tease",
            isolated: false,
            status: "halted",
            visited: ["main.tease", "pack/next.tease"],
            transfers: 1,
          },
          {
            entry: "pack/unreached.tease",
            isolated: true,
            status: "halted",
            visited: ["pack/unreached.tease"],
            transfers: 0,
          },
        ],
      );
      assert.equal(report.smokeRunReachedScriptFileCount, 3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// Legacy chaining becomes file transfers (ADR 0022): a script name is `goto` to that file, a computed one `goto
// script(...)`, and a null or empty one, a missing script, or the end of a script ends the chain with `exit`. A package
// starts at main.tease: its one root script, or a generated menu over the scripts the legacy player listed.
test(
  "converts legacy script chains into goto, goto script(), exit, and one main.tease entry",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    for (const name of [
      "script-chain",
      "single-entry",
      "shared-helpers",
      "lone-script",
      "branches",
      "nested-story",
      "helper-class",
      "other-versions",
      "folder-scripts",
      "global-locals",
      "entries",
      "module-files",
      "entry-hub",
      "entry-own-folder",
    ]) {
      const directory = fileURLToPath(new URL(`./fixtures/packages/${name}/`, import.meta.url));
      const scripts = path.join(directory, "scripts");
      const sources = readdirSync(scripts, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".groovy"))
        .sort();
      const files = await Promise.all(
        sources.map((file) => parseGroovySource(path.join(scripts, file))),
      );
      const lowered = lowerPackage(files);
      // Every generated call resolves to package code or an accepted capability, such as askImage() for getFile().
      assert.deepEqual(
        lowered.composed
          .flatMap((program) => program.diagnostics)
          .filter((diagnostic) => diagnostic.code === "SX_UNRESOLVED_PACKAGE_CALL")
          .map((diagnostic) => diagnostic.message),
        [],
        name,
      );
      // Each file keeps its legacy path from the scripts folder, beside a generated main.tease, as convert-package
      // writes them.
      const outputs = packageOutputs(lowered).map(
        ({ path: file, program }): [string, MigrationProgram] => [file, program],
      );
      const expected = readdirSync(path.join(directory, "expected"), {
        recursive: true,
        encoding: "utf8",
      }).filter((file) => file.endsWith(".tease"));
      assert.deepEqual(outputs.map(([file]) => file).sort(), expected.sort(), name);
      for (const [file, program] of outputs) {
        assert.equal(
          emitTease(program),
          readFileSync(path.join(directory, "expected", file), "utf8"),
          `${name}/${file}`,
        );
      }
      // The generated files compile as one project (ADR 0022), so transfers and global functions resolve.
      const shims = outputs.map(([file, program]) => ({
        path: file,
        shim: shimPendingCapabilities(program),
      }));
      assert.deepEqual(
        projectResult.compiler(
          shims.map(({ path: file, shim }) => ({ path: file, source: shim.source })),
          shims.flatMap(({ shim }) => shim.builtins),
        ).diagnostics,
        [],
        name,
      );
      if (name === "nested-story") {
        // An assembled unit's internal script, such as an add-on, is no entry: the package starts at the story.
        const unit = lowerPackage(files, { internalScripts: ["Story/addon.groovy"] });
        assert.ok(unit.main !== null && "menu" in unit.main);
        // The entry holds the package's global helpers and goes straight to the story, with no menu.
        const menu = emitTease(unit.main.menu);
        assert.ok(menu.endsWith('\ngoto "Story/start.tease"\n') && !menu.includes("choose"), menu);
      }
      if (name === "helper-class") {
        // The scripts call the class's static closures as functions, in both scripts.
        const report = analyzeFeasibility(files, {
          compiler: projectResult.compiler,
          runner: projectResult.runner,
        });
        assert.deepEqual(
          report.smokeRuns.map(({ entry: start, status, visited }) => ({ start, status, visited })),
          [{ start: "main.tease", status: "halted", visited: ["main.tease", "next.tease"] }],
        );
      }
      if (name === "shared-helpers") {
        // The scripts call the shared functions, which read the shared table and the global each script assigns; the
        // cellar keeps its own variable of a global's name, with values of another type.
        const report = analyzeFeasibility(files, {
          compiler: projectResult.compiler,
          runner: projectResult.runner,
        });
        assert.deepEqual(
          report.smokeRuns.map(({ entry: start, status, visited }) => ({ start, status, visited })),
          [
            {
              start: "main.tease",
              status: "halted",
              visited: [
                "main.tease",
                "rooms/hall.tease",
                "rooms/garden.tease",
                "rooms/cellar.tease",
              ],
            },
          ],
        );
        continue;
      }
      if (name !== "script-chain") continue;
      const report = analyzeFeasibility(files, {
        compiler: projectResult.compiler,
        runner: projectResult.runner,
      });
      assert.deepEqual(
        report.smokeRuns
          .filter(({ entry: start }) => ["main.tease", "intro.tease"].includes(start))
          .map(({ entry: start, status, visited }) => ({ start, status, visited })),
        [
          // The menu's first option, then the chain through a stored script reference to its exit.
          { start: "main.tease", status: "halted", visited: ["main.tease", "extra.tease"] },
          {
            start: "intro.tease",
            status: "halted",
            visited: [
              "intro.tease",
              "chapters/first.tease",
              "chapters/second.tease",
              "chapters/last.tease",
            ],
          },
        ],
      );
    }
  },
);

test(
  "package smoke run uses the package root for entries and counts only scripts as reached",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-root-"));
    try {
      mkdirSync(path.join(directory, "sub"));
      const sources: Record<string, string> = {
        "Helper.groovy": "class Helper {\n  static int twice(int x) { return x * 2 }\n}\n",
        "helper.groovy": 'show("Helper script")\n',
        "sub/start.groovy": 'return "sub/next.groovy"\n',
        "sub/next.groovy": 'show("Next")\n',
      };
      for (const [name, source] of Object.entries(sources)) {
        writeFileSync(path.join(directory, name), source);
      }
      const files = await Promise.all(
        Object.keys(sources).map((name) => parseGroovySource(path.join(directory, name))),
      );
      const report = analyzeFeasibility(files, {
        compiler: projectResult.compiler,
        runner: projectResult.runner,
      });
      assert.deepEqual(
        report.smokeRuns.map(({ entry, isolated, status, visited }) => ({
          entry,
          isolated,
          status,
          visited,
        })),
        [
          // The one script in the package root is the main script, which main.tease goes to (ADR 0022).
          {
            entry: "main.tease",
            isolated: false,
            status: "halted",
            visited: ["main.tease", "helper.tease"],
          },
          {
            entry: "sub/start.tease",
            isolated: true,
            status: "halted",
            visited: ["sub/start.tease", "sub/next.tease"],
          },
        ],
      );
      assert.equal(report.smokeRunReachedScriptFileCount, 3);
      const auxiliary = report.files.find((file) => file.sourceName.endsWith("Helper.groovy"));
      assert.equal(auxiliary?.smokeRunReached, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "package smoke run blocks scripts whose paths differ only in case",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-case-"));
    try {
      writeFileSync(path.join(directory, "A.groovy"), 'show("Upper")\n');
      writeFileSync(path.join(directory, "a.groovy"), 'show("Lower")\n');
      const files = await Promise.all(
        ["A.groovy", "a.groovy"].map((name) => parseGroovySource(path.join(directory, name))),
      );
      const report = analyzeFeasibility(files, {
        compiler: projectResult.compiler,
        runner: projectResult.runner,
      });
      assert.deepEqual(
        report.smokeRuns.map(({ entry, status, blockedTarget }) => ({
          entry,
          status,
          blockedTarget,
        })),
        // The generated entry menu offers both scripts; the first one it reaches is ambiguous, since the legacy
        // player's file systems held only one of them.
        [{ entry: "main.tease", status: "blocked", blockedTarget: "A.tease" }],
      );
      assert.equal(report.smokeRunReachedScriptFileCount, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// The smoke runner drives the public runtime API like a Player with deterministic answers.
test(
  "smoke runner plays media in simulated time and reports the last step's outcome",
  { skip: "reason" in runnerResult ? runnerResult.reason : false },
  () => {
    if (!("runner" in runnerResult)) return;
    const run = (source: string, maxSteps?: number): { status: string; code: string | null } => {
      const result = runnerResult.runner(source, {}, maxSteps === undefined ? {} : { maxSteps });
      return { status: result.status, code: result.failure?.code ?? null };
    };
    const halted = { status: "halted", code: null };
    // Background media keeps playing while the script waits.
    assert.deepEqual(
      run(
        'let music = playAudio async "a.wav"\nwhile music.state == "running" {\n  wait 1\n}\nsay "done"\nexit\n',
      ),
      halted,
    );
    // A repeated pass count needs the cumulative progress of all passes.
    assert.deepEqual(
      run('playAudio(file: "a.wav", async: false, repeat: 3 times)\nsay "done"\nexit\n'),
      halted,
    );
    // A runtime failure caused by the last allowed step is still reported.
    assert.deepEqual(run("wait 1\nlet item = [1][5]\nexit\n", 1), {
      status: "failed",
      code: "TSR025",
    });
    // Numbered inputs rotate, so a loop waiting for a larger answer ends.
    assert.deepEqual(run("let n: number = 0\nwhile n < 3 {\n  n = askNumber\n}\nexit\n"), halted);
  },
);

// A package whose script loads `metaClass` mixin modules at runtime, like the Toy package.
test(
  "converts a package with runtime-loaded mixin modules into one runnable script",
  {
    skip:
      parserUnavailable ||
      ("reason" in compilerResult ? compilerResult.reason : false) ||
      ("reason" in runnerResult ? runnerResult.reason : false),
  },
  async () => {
    if (!("compiler" in compilerResult) || !("runner" in runnerResult)) return;
    const directory = fileURLToPath(new URL("./fixtures/packages/mixin-modules/", import.meta.url));
    const sources = [
      "demo.groovy",
      "demo/greeting.groovy",
      "demo/later.groovy",
      "demo/pause.groovy",
    ].map((name) => path.join(directory, "scripts", name));
    const files = await Promise.all(sources.map((source) => parseGroovySource(source)));
    const script = lowerSelfContainedPackage(files)[0];
    assert.ok(script !== undefined);
    const source = emitTease(script);
    assert.equal(source, readFileSync(path.join(directory, "demo.tease"), "utf8"));
    const compiled = compilerResult.compiler(source);
    assert.deepEqual(
      compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
    );
    const run = runnerResult.runner(source, {});
    assert.deepEqual(
      { status: run.status, failure: run.failure },
      { status: "halted", failure: null },
    );
  },
);

// Files converted to stand on their own each declare the storage keys they read where no read of theirs can, also when
// a helper class is converted with them.
test(
  "declares a standalone file's storage key types in that file",
  {
    skip:
      parserUnavailable ||
      ("reason" in compilerResult ? compilerResult.reason : false) ||
      ("reason" in runnerResult ? runnerResult.reason : false),
  },
  async () => {
    if (!("compiler" in compilerResult) || !("runner" in runnerResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-standalone-"));
    try {
      const helper = path.join(directory, "Helper.groovy");
      const main = path.join(directory, "main.groovy");
      writeFileSync(
        helper,
        'class Helper {\n  def static done = { main -> main.show("done") }\n}\n',
      );
      // `and` may skip the read, so it cannot move before its statement to declare the key.
      writeFileSync(
        main,
        'if (false && loadBoolean("k") == null) save("ran", true)\nsave("done", true)\n',
      );
      const files = await Promise.all([helper, main].map((file) => parseGroovySource(file)));
      const source = emitTease(lowerSelfContainedPackage(files)[1]!);
      assert.deepEqual(
        compilerResult.compiler(source).diagnostics.filter(({ severity }) => severity === "error"),
        [],
      );
      const run = runnerResult.runner(source, {});
      assert.deepEqual(
        { status: run.status, failure: run.failure },
        { status: "halted", failure: null },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// Text with line breaks is written as a block string with the same value (V30 §8), also with interpolations and in a
// nested block; text the block form would change or hide stays single-line.
test(
  "writes text with line breaks as block strings with the same value",
  { skip: "reason" in runnerResult ? runnerResult.reason : false },
  () => {
    if (!("runner" in runnerResult)) return;
    const values = [
      'Hello!\n\nThe door "opens".\n',
      "\nstarts with a break",
      "line one\n  indented two\n\tthird",
      'quotes """ and """" inside\n"next"',
      "back\\slash, tab\t, ${literal}\r\nend",
      "  every line\n  indented",
      "trailing space \nnext",
      "spaces only\n   \nnext",
      "\n\n",
      "single line",
    ];
    const literal = (value: string): IrExpression => ({ kind: "literal", value });
    const saves: IrStatement[] = values.map((value, index) => ({
      kind: "save",
      key: literal(`k${index}`),
      value: literal(value),
      span: null,
    }));
    const template: IrExpression = {
      kind: "template",
      parts: [
        { text: "Dear " },
        { value: { kind: "call", name: "toString", positional: [literal("An\nn")], named: {} } },
        { text: ",\n  kneel." },
      ],
    };
    const program: MigrationProgram = {
      sourceName: "blocks.tease",
      metadata: null,
      statements: [
        {
          kind: "if",
          condition: { kind: "literal", value: true },
          then: [...saves, { kind: "save", key: literal("t"), value: template, span: null }],
          else: [],
          span: null,
        },
        { kind: "exit", span: null },
      ],
      diagnostics: [],
    };
    const source = emitTease(program);
    // Five texts and the template become blocks; the interpolated text stays single-line inside its block.
    assert.equal(source.match(/"""\n/gu)?.length, 6);
    assert.match(source, /^ {4}Dear \$\{toString\("An\\nn"\)\},$/mu);
    assert.match(source, /^ {2}""" as "t"$/mu);
    const storage = new Map();
    const run = runnerResult.runner(source, {}, { storage });
    assert.deepEqual(
      { status: run.status, failure: run.failure },
      { status: "halted", failure: null },
    );
    assert.deepEqual(Object.fromEntries(storage), {
      ...Object.fromEntries(values.map((value, index) => [`k${index}`, value])),
      t: "Dear An\nn,\n  kneel.",
    });
  },
);

// A corpus merge puts the releases of a package side by side (`name__sha256_<hash>`): a release's script loads the
// module versions of its own release and the modules of no release; without releases, a script skips other versions.
test(
  "loads only the module versions of a script's own release",
  { skip: parserUnavailable || ("reason" in projectResult ? projectResult.reason : false) },
  async () => {
    if (!("compiler" in projectResult)) return;
    const scripts = fileURLToPath(
      new URL("./fixtures/packages/module-releases/scripts/", import.meta.url),
    );
    const sources = readdirSync(scripts, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".groovy"))
      .sort();
    const files = await Promise.all(
      sources.map((file) => parseGroovySource(path.join(scripts, file))),
    );
    const convert = (releases: string[][], compiles: boolean): Map<string, string> => {
      const lowered = lowerPackage(files, { releases });
      const outputs = packageOutputs(lowered).map(
        ({ path: file, program }): [string, MigrationProgram] => [file, program],
      );
      const shims = outputs.map(([file, program]) => ({
        path: file,
        shim: shimPendingCapabilities(program),
      }));
      if (compiles)
        assert.deepEqual(
          projectResult.compiler(
            shims.map(({ path: file, shim }) => ({ path: file, source: shim.source })),
            shims.flatMap(({ shim }) => shim.builtins),
          ).diagnostics,
          [],
        );
      return new Map(outputs.map(([file, program]) => [file, emitTease(program)]));
    };
    const released = convert(
      [
        ["game.groovy", "game/play.groovy", "game/extra.groovy"],
        [
          "game__sha256_aaaaaaaaaaaa.groovy",
          "game/play__sha256_bbbbbbbbbbbb.groovy",
          "game/extra.groovy",
        ],
      ],
      true,
    );
    const current = released.get("game.tease") ?? "";
    const older = released.get("game__sha256_aaaaaaaaaaaa.tease") ?? "";
    // Both scripts load the modules they share, which the package defines once in helpers.tease.
    for (const name of ["Extra", "Added"]) {
      assert.match(current, new RegExp(`load${name}Module\\(\\)`, "u"));
      assert.match(older, new RegExp(`load${name}Module\\(\\)`, "u"));
    }
    assert.match(current, /say "Play \$\{rounds\}"/u);
    assert.doesNotMatch(current, /Old play/u);
    assert.match(older, /"Old play"/u);
    assert.doesNotMatch(older, /"Play /u);
    const plain = convert([], false).get("game.tease") ?? "";
    assert.doesNotMatch(plain, /Old play/u);
  },
);

// A variable splits by type only in straight-line code of the block that declares it, which no function writes; a
// write through a function, a function value, or a loop with break keeps one variable with a union type.
test(
  "declares a union for variables of several types that functions or loops write",
  { skip: parserUnavailable || ("reason" in runnerResult ? runnerResult.reason : false) },
  async () => {
    if (!("runner" in runnerResult)) return;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-scratch-"));
    try {
      const writer = 'def response = "seed"\ndef writer = { -> response = [1, 2] }\n';
      const cases = [
        {
          name: "wrapper",
          source: `${writer}def wrapper = { -> writer() }\nresponse = "ready"\nwrapper()\nsave("result", response)\n`,
          type: "string | integer[]",
          result: { kind: "list", items: [1, 2] },
        },
        {
          name: "callback",
          source: `${writer}def callback = writer\nresponse = "ready"\ncallback()\nsave("result", response)\n`,
          type: "string | integer[]",
          result: { kind: "list", items: [1, 2] },
        },
        {
          name: "loop",
          source:
            'def response = "seed"\nresponse = 1\nwhile (true) { response = "changed"; break }\nsave("result", response)\n',
          type: "string | integer",
          result: "changed",
        },
        {
          name: "nested",
          source:
            'def response = "seed"\nif (true) { while (false) { break } }\nresponse = 1\nsave("result", response)\n',
          type: "string | integer",
          result: 1,
        },
      ];
      for (const { name, source, type, result } of cases) {
        const sourcePath = path.join(directory, `${name}.groovy`);
        writeFileSync(sourcePath, source);
        const program = await convert(sourcePath);
        assert.deepEqual(
          program.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
          [],
          name,
        );
        assert.ok(emitTease(program).includes(`let response: ${type} = "seed"`), name);
        const storage = new Map();
        const shim = shimPendingCapabilities(program);
        const run = runnerResult.runner(shim.source, pendingHostFunctions(shim), { storage });
        assert.equal(run.status, "halted", name);
        assert.deepEqual(storage.get("result"), result, name);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// The generated values match Groovy's: a destination never holds a partial result, and an effectful fallback runs
// only when Groovy ran it.
test(
  "destinations computed through temporaries keep Groovy's values",
  { skip: parserUnavailable || ("reason" in runnerResult ? runnerResult.reason : false) },
  async () => {
    if (!("runner" in runnerResult)) return;
    const sourcePath = fileURLToPath(
      new URL("./fixtures/conversion/destinations.groovy", import.meta.url),
    );
    const shim = shimPendingCapabilities(await convert(sourcePath));
    const storage = new Map();
    const result = runnerResult.runner(shim.source, pendingHostFunctions(shim), { storage });
    assert.equal(result.status, "halted");
    // The values Groovy 2.5.21 computes for the same script.
    assert.deepEqual(Object.fromEntries(storage), {
      compound: 4,
      shortCircuit: false,
      accumulator: 7,
      readDefault: 3,
      tags: "ab",
      found: "x",
      first: 1,
      indexed: 12,
      receiver: 7,
    });
    const fieldPath = fileURLToPath(
      new URL("./fixtures/conversion/destination-field.groovy", import.meta.url),
    );
    const fieldShim = shimPendingCapabilities(await convert(fieldPath));
    const fieldStorage = new Map();
    const fieldResult = runnerResult.runner(fieldShim.source, pendingHostFunctions(fieldShim), {
      storage: fieldStorage,
    });
    assert.equal(fieldResult.status, "halted");
    assert.deepEqual(Object.fromEntries(fieldStorage), { inner: 1, result: 7 });
  },
);

// A read with a default for a missing key uses get(key, default:) only with a default of the dict's value type.
test(
  "keeps read-then-default code whose default has another type than the dict's values",
  { skip: parserUnavailable },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-default-"));
    try {
      const sourcePath = path.join(directory, "default.groovy");
      writeFileSync(
        sourcePath,
        'def m = [a: "text"]\ndef k = "b"\ndef x = m[k]\nif (x == null) x = 3\nsave("result", x)\n',
      );
      const output = emitTease(await convert(sourcePath));
      assert.doesNotMatch(output, /m\.get\(/u);
      assert.match(output, /^if x == null \{$/mu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// Only a function that nothing references loses its TODOs: module loads and setups count as calls.
test(
  "keeps the diagnostics of module code the loader runs and notes those of unreferenced functions",
  { skip: parserUnavailable },
  async () => {
    const fixture = fileURLToPath(new URL("./fixtures/packages/mixin-modules/", import.meta.url));
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-uncalled-"));
    try {
      // The module loader reads the scripts folder of the package.
      const scripts = path.join(directory, "scripts");
      mkdirSync(path.join(scripts, "demo"), { recursive: true });
      const script = readFileSync(path.join(fixture, "scripts", "demo.groovy"), "utf8")
        .replace(
          "\tint rounds = 2",
          '\tdef neverCalled = { -> new File("debug.txt").lastModified() }\n\tint rounds = 2',
        )
        .replace("\t\tgreet()", "\t\tgreet()\n\t\tlive()");
      writeFileSync(path.join(scripts, "demo.groovy"), script);
      for (const module of ["greeting", "later", "pause"]) {
        writeFileSync(
          path.join(scripts, "demo", `${module}.groovy`),
          readFileSync(path.join(fixture, "scripts", "demo", `${module}.groovy`), "utf8"),
        );
      }
      writeFileSync(
        path.join(scripts, "demo", "broken.groovy"),
        '{ toy ->\n\tnew File("cache.txt").lastModified()\n\treturn null\n}\n',
      );
      // Two modules with the same code at the same lines: only the one nothing calls gets notes.
      for (const method of ["idle", "live"]) {
        writeFileSync(
          path.join(scripts, "demo", `${method}.groovy`),
          `{ toy ->\n\ttoy.metaClass.${method} = {\n\t\tnew File("cache.txt").lastModified()\n\t}\n\treturn null\n}\n`,
        );
      }
      const files = await Promise.all(
        [
          "demo.groovy",
          "demo/broken.groovy",
          "demo/greeting.groovy",
          "demo/idle.groovy",
          "demo/later.groovy",
          "demo/live.groovy",
          "demo/pause.groovy",
        ].map((name) => parseGroovySource(path.join(scripts, name))),
      );
      const program = lowerSelfContainedPackage(files)[0]!;
      const javaCalls = program.diagnostics.filter(
        (diagnostic) => diagnostic.code === "SX_JAVA_OBJECT_CALL",
      );
      assert.deepEqual(
        javaCalls
          .map(({ severity, sourceName }) => ({
            severity,
            source: path.basename(sourceName ?? "demo.groovy"),
          }))
          .sort((left, right) => left.source.localeCompare(right.source)),
        [
          { severity: "error", source: "broken.groovy" },
          { severity: "warning", source: "demo.groovy" },
          { severity: "warning", source: "idle.groovy" },
          { severity: "error", source: "live.groovy" },
        ],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

async function convert(
  sourcePath: string,
  options: PackageOptions = {},
): Promise<MigrationProgram> {
  const [program] = lowerSelfContainedPackage([await parseGroovySource(sourcePath)], options);
  assert.ok(program !== undefined);
  return program;
}

// With the Player's default pacing, a text said at once (`instant`) ends the reading time of the text before it, so a
// text whose legacy wait the reading time replaced is read in full on every path: after other statements, across a
// call, after an ask that a condition may skip, on a loop's next pass after `continue`, where computing a text, a wait,
// a value after an ask, or what media show says it, and before a beat, which keeps its timing (docs/RUNTIME.md "Pacing
// gate").
test(
  "a reading time that replaced a legacy wait runs in full before the next text",
  { skip: parserUnavailable },
  async () => {
    const runtime: unknown = await import(repositoryBuildUrl("src/index.js").href);
    assert.ok(typeof runtime === "object" && runtime !== null);
    // EVIDENCE: the repository build's index exports these runtime functions (src/index.ts), which the probes use.
    const { compileSource, createFreshRuntimeSnapshot, run, observeTime, completeAction } =
      runtime as PacedRuntime;
    const sources = {
      statement: 'show("Good.")\nwait(1)\nint n = 20\nshow("Hold.")\nwait(20)',
      call: 'def hold = { show("Hold."); wait(20) }\nshow("Good.")\nwait(1)\nhold()',
      values:
        'def t = "a b c d e f g h i j"\nshow(t)\nwait(1)\nint x = 1\nwait(2)\nshow("Hold.")\nwait(20)',
      skippedAsk:
        'show("Good.")\nwait(1)\nif (false && getFile(null) != null) { show("No.") }\nshow("Hold.")\nwait(20)',
      continued:
        'for (int i = 0; i < 2; i++) {\n show("Hold " + i)\n wait(20)\n show("Good.")\n wait(1)\n if (i == 0) continue\n wait(10)\n}',
      computedText:
        'def content = { show("Good."); wait(1); return "Hold." }\nshowButton("Start")\nshow(content())\nwait(20)',
      computedWait:
        'def delay = { show("Good."); wait(1); return 1 }\nshowButton("Start")\nshow("Hold.")\nwait(delay())\nshow("Next.")\nwait(20)',
      beat: 'show("Good.")\nwait(1)\nfor (int i = 3; i > 0; i--) {\n show("Starting in " + i)\n wait(1)\n}',
      longBeat: 'show("Good.")\nwait(1)\nshow("3")\nwait(3)',
      number: 'show("Good.")\nwait(1)\nshow(3)\nwait(1)',
      animation: 'show("Good.")\nwait(1)\nshow("Wait.")\nwait(1)\nshow("Wait..")\nwait(1)',
      splitBeat: 'show("Good.")\nwait(1)\nshow("!\\n\\n?")\nwait(1)',
      splitTick:
        'for (int i = 3; i > 0; i--) {\n show("First part.\\n\\nSecond part.\\n\\nStarting in " + i)\n wait(1)\n}',
      media:
        'def image = { show("Good."); wait(1); return "test.jpg" }\nshowButton("Start")\nsetImage(image())\nshow("Hold.")\nwait(20)',
      askThenText:
        'def content = { show("Good."); wait(1); return true }\nshowButton("Start")\ndef same = getBoolean("Ready?") == content()\nshow("Hold.")\nwait(20)',
    };
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-reading-"));
    try {
      for (const [name, source] of Object.entries(sources)) {
        const file = path.join(directory, `${name}.groovy`);
        writeFileSync(file, `${source}\n`);
        const tease = emitTease(lowerParsedFile(await parseGroovySource(file)));
        const { plan } = compileSource(tease);
        assert.ok(plan !== undefined, name);
        const cut: string[] = [];
        const note = (events: readonly PacedEvent[]): void => {
          for (const event of events)
            if (event.settlement?.settlementKind === "supersededByInstantOutput") cut.push(name);
        };
        let step = run(plan, createFreshRuntimeSnapshot(plan, { seed: 1 }));
        note(step.events);
        for (let turn = 0; turn < 40 && step.snapshot.status === "waiting"; turn += 1) {
          const action = step.snapshot.foregroundAction;
          // A button is pressed and a choice takes its first option at once; time runs to the next deadline.
          const answered =
            action?.kind === "interaction"
              ? completeAction(plan, step.snapshot, {
                  actionId: action.actionId,
                  actionKind: "interaction",
                  interactionKind: action.interactionKind,
                  payload:
                    action.interactionKind === "button"
                      ? { kind: "activate" }
                      : { kind: "selectedOption", optionIndex: 0 },
                })
              : observeTime(plan, step.snapshot, action?.deadlineMs ?? NaN);
          note(answered.events);
          step = run(plan, answered.snapshot);
          note(step.events);
        }
        assert.equal(step.snapshot.status, "halted", name);
        assert.deepEqual(cut, [], tease);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

// Legacy loadInteger() and loadFloat() parsed the stored text, loadInteger() dropping the fraction toward zero, and left
// the stored text as it was; a value the script used for a missing key stays as it is. Half of a whole number keeps
// its fraction through a later subtraction (RCA 2026-10-07 #1, #2, #4).
test(
  "typed storage reads give the values legacy gave and keep what is stored",
  { skip: parserUnavailable },
  async () => {
    const runtime: unknown = await import(repositoryBuildUrl("src/index.js").href);
    assert.ok(typeof runtime === "object" && runtime !== null);
    // EVIDENCE: the repository build's index exports these runtime functions (src/index.ts), which the probes use.
    const { compileSource, createFreshRuntimeSnapshot, run, observeTime } = runtime as PacedRuntime;
    const directory = mkdtempSync(path.join(tmpdir(), "sexscript-loads-"));
    try {
      const file = path.join(directory, "loads.groovy");
      writeFileSync(
        file,
        [
          'save("game.version", "5.1")',
          'show("" + loadInteger("game.version") + " " + loadFloat("game.version") + " " + loadString("game.version"))',
          'save("game.points", 100.5)',
          "def points = 80",
          'if (loadInteger("game.points") != null) points = loadInteger("game.points")',
          'def missing = loadInteger("game.missing")',
          "if (missing == null) missing = 0.5",
          'save("game.total", 13)',
          'def s1 = loadInteger("game.total")',
          "def s2 = 0",
          "def s3 = 0",
          "s2 = s1 / 2",
          "s3 = s1 - s2",
          "def zero = 0",
          'def kept = loadInteger("game.points")',
          "if (kept == null) kept = 1 / zero",
          'show("" + points + " " + missing + " " + s2 + " " + s3 + " " + kept)',
          "def unset = null",
          "def ratio = 0",
          'ratio = loadFloat("game.ratio")',
          "if (ratio == null) ratio = unset",
          'if (ratio == null) show("no ratio")',
          "def reads = 0",
          'def keyOf = { reads++; return "game.points" }',
          "def counted = loadInteger(keyOf())",
          "if (counted == null) counted = 1 + 1",
          'def total = loadInteger("game.total")',
          'def version = loadFloat("game.version")',
          "if (version == null) version = total",
          'show("" + counted + " " + reads + " " + (version + 1))',
          "",
        ].join("\n"),
      );
      const tease = emitTease(lowerParsedFile(await parseGroovySource(file)));
      const { plan } = compileSource(tease);
      assert.ok(plan !== undefined, tease);
      const said: string[] = [];
      const note = (events: readonly PacedEvent[]): void => {
        for (const event of events)
          if (event.kind === "say" && event.text !== undefined) said.push(event.text);
      };
      let step = run(plan, createFreshRuntimeSnapshot(plan, { seed: 1 }));
      note(step.events);
      for (let turn = 0; turn < 20 && step.snapshot.status === "waiting"; turn += 1) {
        const observed = observeTime(
          plan,
          step.snapshot,
          step.snapshot.foregroundAction?.deadlineMs ?? NaN,
        );
        note(observed.events);
        step = run(plan, observed.snapshot);
        note(step.events);
      }
      assert.equal(step.snapshot.status, "halted", tease);
      assert.deepEqual(said, ["5 5.1 5.1", "100 0.5 6.5 6.5 100", "no ratio", "100 1 6.1"], tease);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

interface PacedEvent {
  kind?: string;
  text?: string;
  settlement?: { settlementKind?: string };
}
interface PacedSnapshot {
  status: string;
  foregroundAction?: {
    kind?: string;
    actionId?: number;
    interactionKind?: string;
    deadlineMs?: number;
  } | null;
}
interface PacedCompletion {
  actionId?: number | undefined;
  actionKind: "interaction";
  interactionKind?: string | undefined;
  payload: { kind: "activate" } | { kind: "selectedOption"; optionIndex: number };
}
interface PacedRuntime {
  compileSource(source: string): { plan?: unknown };
  createFreshRuntimeSnapshot(plan: unknown, options: { seed: number }): PacedSnapshot;
  run(plan: unknown, snapshot: PacedSnapshot): { snapshot: PacedSnapshot; events: PacedEvent[] };
  observeTime(
    plan: unknown,
    snapshot: PacedSnapshot,
    now: number,
  ): { snapshot: PacedSnapshot; events: PacedEvent[] };
  completeAction(
    plan: unknown,
    snapshot: PacedSnapshot,
    completion: PacedCompletion,
  ): { snapshot: PacedSnapshot; events: PacedEvent[] };
}

function groovyParserUnavailableReason(): string | false {
  if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
    return "Java is not available for the Groovy 2.5.21 parser helper.";
  }
  const maven = path.join(homedir(), ".m2/repository/org/codehaus/groovy");
  const jars = [
    process.env.SEXSCRIPT_GROOVY_JAR ?? path.join(maven, "groovy/2.5.21/groovy-2.5.21.jar"),
    process.env.SEXSCRIPT_GROOVY_JSON_JAR ??
      path.join(maven, "groovy-json/2.5.21/groovy-json-2.5.21.jar"),
  ];
  const missing = jars.find((jar) => !existsSync(jar));
  return missing === undefined ? false : `Groovy 2.5.21 JAR not found: ${missing}`;
}
