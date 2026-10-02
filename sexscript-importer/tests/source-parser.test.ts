import assert from "node:assert/strict";
import test from "node:test";
import { parseGroovySource, type GroovyParserRunner } from "../src/source-parser.ts";
import type { ParsedGroovyFile } from "../src/ast.ts";

function parsed(mode: "script-body" | "unit", diagnostics: ParsedGroovyFile["diagnostics"], root: ParsedGroovyFile["root"]): ParsedGroovyFile {
  return { formatVersion: 1, sourceName: "fixture.groovy", groovyVersion: "2.5.21", mode, diagnostics, root };
}

test("keeps normal SexScript in script-body mode", async () => {
  const calls: string[] = [];
  const runner: GroovyParserRunner = async (mode) => {
    calls.push(mode);
    return parsed("script-body", [], { kind: "scriptBody", span: null, body: { kind: "block", span: null, statements: [] } });
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
  const scriptFailure = parsed("script-body", [{ code: "GROOVY_PARSE_ERROR", message: "broken body" }], null);
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
