import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Expression, Statement } from "../../src/ast.js";
import { compileSourceWithBackend } from "../../src/compiler.js";
import { run } from "../../src/runtime/engine.js";
import { CORE_BACKEND } from "../../src/type-inference/core/backend.js";
import { withTestAllowance } from "../../src/type-inference/core/budget.js";
import { messageSource } from "../../src/type-inference/core/messages.js";
import { requiredSentence } from "../../src/type-inference/core/messages/causes.js";
import { RouteHolding } from "../../src/type-inference/core/narrowing/route-holding.js";
import { StatementTree } from "../../src/type-inference/core/narrowing/statement-tree.js";
import { CoreProgram } from "../../src/type-inference/core/program.js";
import type { RequiredCheck } from "../../src/type-inference/core/result.js";
import { createImmediatePacingRuntimeSnapshot } from "../helpers/immediate-pacing-runtime.js";
import { compactAnalysis, coreRequest } from "../helpers/type-core-analysis.js";
import { inMode, MODES } from "../helpers/type-core-oracles.js";
import type { CompactRecord } from "../helpers/type-core-records.js";

/*
 * #2497: the route rule's error where an unchecked route enters the use through a loop's earlier round, a label, a
 * file's start or a block's body (the accepted record's r4-451). The rows are the design's sources and their answers by
 * the text: `error` where some route into the use has no check and the rule proves it; `no-error` where every route has
 * one (the warning may stay), or where no proof of the error is possible (a block that may repair, X7; a check inside a
 * block's body, #2506); `check` where the text asks the error and the rule leaves the warning (a named give-up, or a
 * program the route rule's default holds): a check stands, the warning or the error.
 */

interface Row {
  readonly name: string;
  readonly expect: "error" | "no-error" | "check";
  readonly files: readonly { readonly path: string; readonly lines: readonly string[] }[];
  readonly watch: readonly { readonly path: string; readonly line: number }[];
  /** For an error: the writer's file, or `null` where the route starts at a block's body with no store of its own. */
  readonly writer?: string | null;
}

const ROWS: readonly Row[] = readFileSync(
  new URL("../../../tests/fixtures/type-core/route-entries.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => {
    // EVIDENCE: the fixture is this file's own, generated in this shape; a missing field fails the rows' test.
    const row = JSON.parse(line) as Row;
    return row;
  });

/** The diagnostics of a record at a file's line (1-based) of the row's sources. */
function atLine(row: Row, record: CompactRecord, path: string, line: number) {
  const lines = row.files.find((file) => file.path === path)!.lines;
  const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
  const end = start + lines[line - 1]!.length;
  return record.diagnostics.filter(
    (d) => d.site.file === path && d.site.offset >= start && d.site.offset < end,
  );
}

test("each design row gives its answer by the text in the four modes: the error, no error, or a check that stands", () => {
  const wrong: string[] = [];
  for (const row of ROWS) {
    const request = coreRequest(
      row.files.map((file) => ({ path: file.path, source: `${file.lines.join("\n")}\n` })),
    );
    if (request === null) {
      wrong.push(`${row.name}: does not parse or resolve`);
      continue;
    }
    const records = MODES.map((mode) => inMode(mode, () => compactAnalysis(request)));
    for (const other of records.slice(1))
      if (JSON.stringify(other) !== JSON.stringify(records[0]))
        wrong.push(`${row.name}: the modes differ`);
    const record = records[0]!;
    for (const { path, line } of row.watch) {
      const found = atLine(row, record, path, line);
      const errors = found.filter((d) => d.class === "compile-error");
      const required = errors.filter((d) => d.requiredCheck !== undefined);
      const fits =
        row.expect === "error"
          ? required.length > 0 &&
            (row.writer === undefined ||
              required.some((d) =>
                row.writer === null
                  ? d.requiredCheck!.writer === null && d.requiredCheck!.block !== undefined
                  : d.requiredCheck!.writer?.file === row.writer,
              ))
          : row.expect === "no-error"
            ? errors.length === 0
            : errors.length > 0 || found.some((d) => d.class === "warning-runtime-check");
      if (!fits)
        wrong.push(`${row.name} (${row.expect}) at ${path}:${line}: ${JSON.stringify(found)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

/**
 * Where the candidate route takes the program (a loop that `repeat` or `for` makes), source to runtime: the error gives
 * no plan; a check on the round's route keeps the warning, the plan checks the use and the second round stops there; a
 * check that protects the use runs through; a loop with one round gives no error and runs through (its graph keeps a
 * second round, so the forward query's warning may stand).
 */
test("a loop's earlier round, source to runtime on the candidate route", () => {
  const use = "  let whole: integer = n";
  const program = (head: string, ...body: readonly string[]): string =>
    `let n: integer? = 1\n${head} {\n${body.join("\n")}\n  n = null\n}\nexit\n`;
  const rows: readonly (readonly [string, string, "error" | "check" | "valid" | "no-error"])[] = [
    ["a literal count", program("repeat 2", use), "error"],
    ["a variable count", `let k = 2\n${program("repeat k", use)}`, "error"],
    ["a literal list", program("for x in [1, 2]", use), "error"],
    ["a variable list", `let xs = [1, 2]\n${program("for x in xs", use)}`, "error"],
    ["one round", program("for x in [1]", use), "no-error"],
    ["a test before the use (T1)", program("repeat 2", "  let ok = n != null", use), "check"],
    [
      "a type test before the use (T2)",
      program("repeat 2", "  let ok = n is integer", use),
      "check",
    ],
    [
      "a test that protects the use",
      program("repeat 2", "  if n != null {", `  ${use}`, "  }"),
      "valid",
    ],
    ["a store before the use", program("repeat 2", "  n = 2", use), "valid"],
    // (a test of the variable after the round's store, on the seed's way to the loop's head; one in the loop's header)
    [
      "a test after the store",
      `let n: integer? = 1\nrepeat 2 {\n${use}\n  n = null\n  let ok = n != null\n}\nexit\n`,
      "check",
    ],
    [
      "a test in the loop's header",
      `let k = 2\n${program("while n != null or k > 0", "  k -= 1", use)}`,
      "check",
    ],
  ];
  for (const [name, source, expected] of rows) {
    const result = compileSourceWithBackend(source, { globals: ["hostValue"] }, CORE_BACKEND);
    const at = source.split("\n").findIndex((line) => line.includes("let whole")) + 1;
    const codes = result.diagnostics.map((d) => `${d.severity}:${d.code}:${d.span.start.line + 1}`);
    if (expected === "error") {
      assert.ok(codes.includes(`error:TSV041:${at}`), `${name}: ${codes.join(", ")}`);
      assert.equal(result.plan, null, name);
      continue;
    }
    assert.ok(result.plan !== null, `${name}: ${codes.join(", ")}`);
    const ran = run(
      result.plan,
      createImmediatePacingRuntimeSnapshot(result.plan, { globals: { hostValue: 1 } }),
    );
    const failure = ran.events.find((event) => event.kind === "runtimeFailure");
    if (expected === "valid" || expected === "no-error") {
      if (expected === "valid") assert.deepEqual(codes, [], name);
      assert.equal(ran.snapshot.status, "halted", name);
    } else {
      assert.deepEqual(codes, [`warning:TSV041:${at}`], name);
      assert.equal(ran.snapshot.status, "failed", name);
      assert.ok(
        failure?.kind === "runtimeFailure" &&
          failure.code === "TSR058" &&
          failure.span.start.line + 1 === at,
        name,
      );
    }
  }
});

/** The statement tree and the holding index of one file's program. */
function holdingOf(source: string) {
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null, source);
  const program = new CoreProgram(request);
  program.index();
  const tree = new StatementTree(program);
  return { tree, holding: new RouteHolding(program.work, tree, new Set(["fix"])) };
}

/**
 * The design's witnesses (#2497's last check): each a statement that holds `n` by one closer alone, so a change that drops
 * that closer makes the statement hold nothing (and its row's segment open); its control holds nothing.
 */
test("each closer of an entry's segment holds the variable alone in its witness: a test, a store, a hand-off", () => {
  const witnesses: readonly (readonly [string, string, boolean])[] = [
    ["T1", "let ok = n != null", true],
    ["T2", "let ok = n is integer", true],
    ["T3", "let ok = true and n > 0", true],
    ["T4", "if n > 0 { say n }", true],
    ["T5", "switch n { case 1 { say n } }", true],
    ["a store", "box.next = 2", true],
    ["a hand-off", "fix(box)", true],
    ["a plain read", "let copy = n + 1", false],
  ];
  for (const [name, line, held] of witnesses) {
    const source = `function fix(b: object) { b.next = 3 }\nlet n: integer? = 1\nlet box = {n: 1, next: 1}\n${line}\nexit\n`;
    const { tree, holding } = holdingOf(source);
    const statement = tree.statementAt(0, source.indexOf(line));
    assert.ok(statement !== null, name);
    const root = line.startsWith("box") || line.startsWith("fix") ? "box" : "n";
    assert.equal(holding.holds(root, statement), held, name);
  }
});

const TEST = "n != null";
const TEXT = '"${n != null}"';
const COUNT = "[n != null].length";

/**
 * Every expression kind of the grammar, with a template that nests the test in its parts (`null`: a kind with no
 * parts the walk enters, named why).
 */
const EXPRESSIONS: Readonly<Record<Expression["kind"], string | null>> = {
  identifier: null, // (the test's own name)
  booleanLiteral: null, // (no parts)
  nullLiteral: null, // (no parts)
  numberLiteral: null, // (no parts)
  durationLiteral: null, // (no parts)
  regexLiteral: null, // (no parts)
  showCameraExpression: null, // (no parts)
  unitExpression: `let probe = (${COUNT}) s`,
  angleExpression: `let probe = (${COUNT}) deg`,
  stringLiteral: `let probe = ${TEXT}`,
  listLiteral: `let probe = [${TEST}]`,
  objectLiteral: `let probe = {a: ${TEST}}`,
  setLiteral: `let probe = set[${TEST}]`,
  dictLiteral: `let probe = dict{[${TEXT}]: 1}`,
  parenthesizedExpression: `let probe = (${TEST})`,
  propertyAccessExpression: `let probe = ${COUNT}`,
  indexExpression: `let probe = [1][${COUNT} - 1]`,
  callExpression: `let probe = toString(${TEST})`,
  unaryExpression: `let probe = -(${COUNT})`,
  binaryExpression: `let probe = ${COUNT} + 1`,
  rangeExpression: `for probe in 1..${COUNT} { }`,
  interactionExpression: `let probe = askText ${TEXT}`,
  sayExpression: `let probe = say ${TEXT}`,
  showButtonExpression: `let probe = showButton ${TEXT}`,
  showPopupExpression: `let probe = showPopup(${TEXT})`,
  timerExpression: `let probe = timer async 1 s ${TEXT} { }`,
  playMediaExpression: `let probe = playAudio async ${TEXT}`,
  showPermanentButtonExpression: `let probe = showPermanentButton ${TEXT} { }`,
  loadExpression: `let probe = load(${TEXT}, default: 1)`,
  tagQueryExpression: `let probe = findImages(where: "level" >= ${COUNT})`,
  typeTestExpression: `let probe = (${TEST}) is boolean`,
};

/** Every statement kind, with a template that puts the test in its own expressions (`null`: none on a route). */
const STATEMENTS: Readonly<Record<Statement["kind"], string | null>> = {
  speakerDeclaration: `speaker probe { title: ${TEXT} }`,
  speakerSetterStatement: null, // (no expressions: `speaker name` makes a speaker current)
  sayStatement: `say ${TEXT}`,
  showButtonStatement: `showButton ${TEXT}`,
  waitStatement: `wait (${COUNT}) s`,
  timerStatement: `timer async 1 s ${TEXT} { }`,
  showImageStatement: `showImage ${TEXT}`,
  hideImageStatement: null, // (no expressions)
  showCameraStatement: null, // (no expressions)
  hideCameraStatement: null, // (no expressions)
  showPopupStatement: `showPopup ${TEXT}`,
  openUrlStatement: `openUrl(${TEXT})`,
  exportTextStatement: `exportText(${TEXT})`,
  showPermanentButtonStatement: `showPermanentButton ${TEXT} { }`,
  playMediaStatement: `playAudio ${TEXT}`,
  stopAudioStatement: null, // (no expressions)
  saveStatement: `save ${TEST} as "key"`,
  deleteStatement: `delete ${TEXT}`,
  exitStatement: null, // (no expressions; no route goes on past it)
  endStatement: null, // (as `exit`)
  labelStatement: null, // (no expressions)
  gotoStatement: null, // (no route goes on past it to the use)
  callFileStatement: null, // (a file's `call` closes a global's segment whatever it is handed)
  letStatement: `let probe = ${TEST}`,
  globalStatement: `global probe = ${TEST}`,
  assignmentStatement: `let probe = true\nprobe = ${TEST}`,
  ifStatement: `if ${TEST} { }`,
  switchStatement: `switch ${TEST} { default { } }`,
  repeatStatement: `repeat ${COUNT} { }`,
  forStatement: `for probe in [${TEST}] { }`,
  whileStatement: `while ${TEST} and false { }`,
  breakStatement: null, // (no expressions)
  continueStatement: null, // (no expressions)
  functionDeclaration: null, // (its body is a callable of its own, on no route here)
  returnStatement: null, // (no route goes on past it to the use)
  expressionStatement: `toString(${TEST})`,
};

/**
 * The closure (r4-451): a test of the variable anywhere in a statement's own expressions closes an entry's segment, through
 * every kind of the grammar that has parts. Each template stands before the use, in a loop's body whose earlier round
 * stores `null` (a top-level-only statement: in a file another file's `null` jumps to): with the test, no error; with
 * the test's text replaced by one that names no variable (the control), the error, so the template itself closes
 * nothing.
 */
test("a test of the variable in any part of any statement closes an entry's segment (r4-451's holding walk)", () => {
  const control = (template: string): string =>
    template.replaceAll(COUNT, "1").replaceAll(TEXT, '"x"').replaceAll(TEST, "true");
  // (a local, so a call closes only by what it is handed)
  const TOP = new Set(["speakerDeclaration", "globalStatement"]);
  const outcome = (kind: string, template: string): string => {
    const top = TOP.has(kind);
    const head = top ? "" : "let n: integer? = 1\nrepeat 2 {\n";
    const request = coreRequest(
      top
        ? [
            { path: "main.tease", source: 'global n: integer? = 1\ngoto "a.tease"\n' },
            {
              path: "a.tease",
              source: `${template}\nlet whole: integer = n\nn = null\ngoto "a.tease"\n`,
            },
          ]
        : [
            {
              path: "main.tease",
              source: `${head}${template}\nlet whole: integer = n\nn = null\n}\nexit\n`,
            },
          ],
    );
    if (request === null) return "does not parse or resolve";
    const record = compactAnalysis(request);
    const use = head.length + template.length + 1;
    const file = top ? "a.tease" : "main.tease";
    const at = record.diagnostics.filter(
      (d) => d.site.file === file && d.site.offset >= use && d.site.offset < use + 22,
    );
    return at.some((d) => d.class === "compile-error" && d.requiredCheck !== undefined)
      ? "error"
      : "no error";
  };
  const wrong: string[] = [];
  for (const [kind, template] of [...Object.entries(EXPRESSIONS), ...Object.entries(STATEMENTS)]) {
    if (template === null) continue;
    const tested = outcome(kind, template);
    const controlled = outcome(kind, control(template));
    if (tested !== "no error" || controlled !== "error")
      wrong.push(`${kind}: with the test ${tested}, without it ${controlled}`);
  }
  assert.deepEqual(wrong, []);
});

test("a required check names a writer in another file by that file, and a block's body with no store names none", () => {
  const sources = [
    'global n: integer? = 1\ngoto "a.tease"\n',
    "let whole: integer = n\n",
    'n = null\ngoto "a.tease"\n',
  ];
  const source = messageSource(sources, []);
  const required = (writer: RequiredCheck["writer"], writerFile: string | null): RequiredCheck => ({
    rule: "N3",
    writer,
    writerFile,
    block: writer === null ? { file: 0, start: 0, end: 1 } : null,
    missingTests: ["if n != null", "otherwise"],
    subject: "n",
    fits: ["integer"],
    provenance: {
      writers: [],
      context: "call",
      detail: {
        direct: true,
        outside: false,
        callable: null,
        label: null,
        handler: null,
        later: null,
        receiver: null,
      },
    },
  });
  const nullAt = { file: 2, start: 4, end: 8 };
  assert.equal(
    requiredSentence(["null"], required(nullAt, "b.tease"), source),
    "'n' must be checked for null before it is used here: it is set to null on line 1 of 'b.tease'.",
  );
  assert.equal(
    requiredSentence(["null"], required(nullAt, null), source),
    "'n' must be checked for null before it is used here: it is set to null on line 1.",
  );
  assert.equal(
    requiredSentence(["null"], required(null, null), source),
    "'n' must be checked for null before it is used here.",
  );
});

/**
 * A stop inside the entry relation (#2497): with the program's allowance ending in a seed's search (2,141) or in
 * the segment query of a seed (2,200) in every mode (a probe swept every allowance and found the stop there), the use
 * keeps its warning and its check: never an error from part of the relation, never nothing.
 */
test("a stop inside an entry's relation leaves the use its warning and its check in four modes", () => {
  const source = `let n: integer? = 1\nrepeat 2 {\n  repeat n {}\n  n = null\n}\n${'repeat 2 { say "a" }\n'.repeat(8)}exit\n`;
  const use = source.indexOf("repeat n");
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  const wrong: string[] = [];
  for (const allowance of [2_141, 2_200])
    for (const mode of MODES) {
      const record = inMode(mode, () =>
        withTestAllowance(allowance, () => compactAnalysis(request)),
      );
      const atUse = record.diagnostics.filter(
        (d) => d.site.offset >= use && d.site.offset < use + 8,
      );
      if (
        record.diagnostics.some((d) => d.class === "compile-error") ||
        !atUse.some((d) => d.class === "warning-runtime-check") ||
        !record.checks.some((check) => check.kind === "null-check" && check.target === "n")
      )
        wrong.push(`${allowance} in ${JSON.stringify(mode)}: ${JSON.stringify(record)}`);
    }
  assert.deepEqual(wrong, []);
});
