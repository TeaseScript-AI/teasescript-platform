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
import type { MigrationProgram } from "../src/ir.ts";
import { lowerPackage, lowerSelfContainedPackage, type PackageOptions } from "../src/package.ts";
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
        [{ status: "halted", visited: ["main.tease"] }],
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
    ])
      assert.ok(source.includes(`\n${expected}\n`), expected);
    assert.match(source, /NOTE SX_MEDIA_PATH_CASE line 6/u);
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
      // A value that may be a list or one element is reported; a function result is a list.
      assert.match(output, /^ {2}\/\/ TODO SX_LIST_CONCATENATION line 5: /mu);
      assert.match(output, /^ {2}items \+= extra\(\)$/mu);
      // A list literal is checked element by element, as the compiler does; mixed elements need a union.
      assert.match(output, /^let weights: \(integer \| string\)\[\] = \[1, 2\]$/mu);
      // A list case holding a range keeps Groovy's membership test.
      assert.match(output, /\[1\.\.=3, 5\]\.contains\(/u);
      // Legacy showed a number default as text; a map default has no text form.
      assert.match(output, /^let code = askText default: "42"$/mu);
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
      writeFileSync(unreached, 'show("Only isolated")\n');
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
      const entry = lowered.main !== null && "file" in lowered.main ? lowered.main.file : null;
      // Paths start at the scripts' common folder, as convert-package writes them.
      // A helper class writes no file of its own, as in convert-package.
      const outputs = lowered.composed.flatMap(
        (program, index): Array<[string, MigrationProgram]> =>
          files[index]!.root?.kind === "scriptBody"
            ? [
                [
                  index === entry
                    ? "main.tease"
                    : (lowered.paths[index] ?? sources[index]!.replace(/\.groovy$/u, ".tease")),
                  program,
                ],
              ]
            : [],
      );
      if (lowered.main !== null && "menu" in lowered.main)
        outputs.push(["main.tease", lowered.main.menu]);
      const helpers = lowered.globals?.helpers ?? null;
      if (helpers !== null) outputs.push(["helpers.tease", helpers]);
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
        assert.match(emitTease(unit.main.menu), /\ngoto "start\.tease"\n$/u);
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
        // The scripts call the shared functions, which read the shared table and the global each script assigns.
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
              visited: ["main.tease", "rooms/hall.tease", "rooms/garden.tease"],
            },
          ],
        );
        assert.deepEqual(
          {
            promoted: report.globalFunctions?.promoted,
            copiesReplaced: report.globalFunctions?.copiesReplaced,
            globals: report.globalFunctions?.globals,
          },
          {
            promoted: 3,
            copiesReplaced: 7,
            globals: [
              { name: "phrases", kind: "table" },
              { name: "mistress", kind: "reassigned" },
            ],
          },
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
          // The one script in the package root is the entry, main.tease (ADR 0022).
          { entry: "main.tease", isolated: false, status: "halted", visited: ["main.tease"] },
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
          '\tdef neverCalled = { -> new File("debug.txt").delete() }\n\tint rounds = 2',
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
        '{ toy ->\n\tnew File("cache.txt").delete()\n\treturn null\n}\n',
      );
      // Two modules with the same code at the same lines: only the one nothing calls gets notes.
      for (const method of ["idle", "live"]) {
        writeFileSync(
          path.join(scripts, "demo", `${method}.groovy`),
          `{ toy ->\n\ttoy.metaClass.${method} = {\n\t\tnew File("cache.txt").delete()\n\t}\n\treturn null\n}\n`,
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
