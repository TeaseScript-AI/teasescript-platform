import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseGroovySource,
  runCachedGroovyParser,
  type GroovyParserRunner,
} from "../src/source-parser.ts";
import { parseParsedGroovyFile, type ParsedGroovyFile } from "../src/ast.ts";

function parsed(
  mode: "script-body" | "unit",
  diagnostics: ParsedGroovyFile["diagnostics"],
  root: ParsedGroovyFile["root"],
): ParsedGroovyFile {
  return {
    formatVersion: 1,
    sourceName: "fixture.groovy",
    groovyVersion: "2.5.21",
    mode,
    diagnostics,
    root,
  };
}

test("parses a script without its leading byte order mark, as the legacy player read it", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sexscript-bom-test-"));
  try {
    const sourcePath = path.join(directory, "start.groovy");
    writeFileSync(sourcePath, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('show("Hi")\n')]));
    const seen: string[] = [];
    const runner: GroovyParserRunner = async (mode, file) => {
      seen.push(readFileSync(file, "utf8"));
      return { ...parsed(mode, [], null), sourceName: file };
    };
    const result = await parseGroovySource(sourcePath, runner);
    assert.deepEqual(seen, ['show("Hi")\n']);
    assert.equal(result.sourceName, sourcePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps normal SexScript in script-body mode", async () => {
  const calls: string[] = [];
  const runner: GroovyParserRunner = async (mode) => {
    calls.push(mode);
    return parsed("script-body", [], {
      kind: "scriptBody",
      span: null,
      body: { kind: "block", span: null, statements: [] },
    });
  };
  const result = await parseGroovySource("fixture.groovy", runner);
  assert.equal(result.mode, "script-body");
  assert.deepEqual(calls, ["script-body"]);
});

test("falls back to unit mode only for a real auxiliary class unit", async () => {
  const runner: GroovyParserRunner = async (mode) =>
    mode === "script-body"
      ? parsed(mode, [{ code: "GROOVY_PARSE_ERROR", message: "class not allowed here" }], null)
      : parsed(mode, [], {
          kind: "compilationUnit",
          span: null,
          topLevel: { kind: "block", span: null, statements: [] },
          classes: [{ kind: "class", span: null, name: "Helper", methods: [] }],
        });
  const result = await parseGroovySource("Helper.groovy", runner);
  assert.equal(result.mode, "unit");
});

test("does not hide a broken SexScript by accepting generic unit parsing", async () => {
  const scriptFailure = parsed(
    "script-body",
    [{ code: "GROOVY_PARSE_ERROR", message: "broken body" }],
    null,
  );
  const runner: GroovyParserRunner = async (mode) =>
    mode === "script-body"
      ? scriptFailure
      : parsed(mode, [], {
          kind: "compilationUnit",
          span: null,
          topLevel: { kind: "block", span: null, statements: [{ kind: "empty", span: null }] },
          classes: [],
        });
  assert.equal(await parseGroovySource("broken.groovy", runner), scriptFailure);
});

test("rejects malformed parser-helper output instead of trusting its shape", () => {
  const valid = parsed("script-body", [], null);
  assert.deepEqual(parseParsedGroovyFile(JSON.parse(JSON.stringify(valid)), "helper"), {
    ...valid,
    comments: [],
  });
  assert.throws(() => parseParsedGroovyFile({ ...valid, formatVersion: 2 }, "helper"), /format/);
  assert.throws(
    () => parseParsedGroovyFile({ ...valid, root: { span: null } }, "helper"),
    /Malformed/,
  );
  assert.throws(
    () => parseParsedGroovyFile({ ...valid, diagnostics: [{ code: 1 }] }, "helper"),
    /diagnostic/,
  );
});

test("reuses cached parser output for the same content, also at another path", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sexscript-ast-cache-"));
  const previous = process.env.SEXSCRIPT_AST_CACHE;
  process.env.SEXSCRIPT_AST_CACHE = path.join(directory, "cache");
  try {
    const first = path.join(directory, "first.groovy");
    const second = path.join(directory, "second.groovy");
    writeFileSync(first, 'show("Kneel")\n');
    writeFileSync(second, 'show("Kneel")\n');
    const parsedPaths: string[] = [];
    const runner: GroovyParserRunner = async (mode, sourcePath) => {
      parsedPaths.push(sourcePath);
      return { ...parsed(mode, [], null), sourceName: sourcePath };
    };
    await runCachedGroovyParser("script-body", first, runner);
    await runCachedGroovyParser("script-body", first, runner);
    const copy = await runCachedGroovyParser("script-body", second, runner);
    assert.deepEqual(parsedPaths, [first]);
    assert.equal(copy.sourceName, second);
    // Changed content and another mode parse again.
    writeFileSync(first, 'show("Stand")\n');
    await runCachedGroovyParser("script-body", first, runner);
    await runCachedGroovyParser("unit", second, runner);
    assert.deepEqual(parsedPaths, [first, first, second]);
  } finally {
    if (previous === undefined) delete process.env.SEXSCRIPT_AST_CACHE;
    else process.env.SEXSCRIPT_AST_CACHE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
