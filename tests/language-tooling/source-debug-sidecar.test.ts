import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTokens,
  compileProject,
  createSourceDebugSidecar,
  loadInstructionPlan,
  loadSourceDebugSidecar,
  parse,
  sourceEnclosingSpans,
  type InstructionPlan,
  type ProjectSourceFile,
  type SourceDebugSidecar,
  type SourceSpan,
} from "../../src/index.js";
import {
  ARRAY_ITERATOR_PROTOTYPE,
  type PrototypeChange,
  withPrototypeChange,
} from "../helpers/prototype-changes.js";

/*
 * The source debug sidecar (docs/DEBUGGER.md "Random draws") carries what a source view shows of each plan file, for a
 * playback that does not parse source: it loads only for the exact plan it was made for, and gives what parsing and
 * classifying that file give (`classifyTokens`, `sourceEnclosingSpans`).
 */

const FILES: readonly ProjectSourceFile[] = [
  {
    path: "main.tease",
    source: [
      "/* a block",
      "   comment */",
      "function pick(items: integer[]): integer {",
      "    if items.length > 1 {",
      "        if items[0] > 0 {",
      "            return items.random",
      "        }",
      "    }",
      "    return 0",
      "}",
      'say "😀 ${pick([1, 2, 3])}"',
      'say """',
      "    block ${pick([4])}",
      '    """',
      'call "rooms/hall.tease"',
      "exit",
    ].join("\r\n"),
  },
  { path: "rooms/hall.tease", source: 'say "hall"\nend\n' },
];

function compiled(files: readonly ProjectSourceFile[]): InstructionPlan {
  const result = compileProject(files);
  assert.deepEqual(result.diagnostics, []);
  return result.plan!;
}

const PLAN = compiled(FILES);
const SIDECAR = createSourceDebugSidecar(FILES, PLAN);

function lineSpan(span: SourceSpan) {
  return {
    startLine: span.start.line,
    startColumn: span.start.column,
    endLine: span.end.line,
    endColumn: span.end.column,
  };
}

function loaded(text: unknown, plan: InstructionPlan = PLAN): SourceDebugSidecar {
  const load = loadSourceDebugSidecar(text, plan);
  assert.equal(load.kind, "valid", load.kind === "valid" ? "" : load.message);
  return load.kind === "valid" ? load.sidecar : { files: [] };
}

test("a sidecar gives each plan file's source with the token classes and enclosing spans parsing gives", () => {
  const sidecar = loaded(SIDECAR);
  assert.deepEqual(
    sidecar.files.map((file) => file.path),
    PLAN.files.map((file) => file.path),
  );
  for (const file of sidecar.files) {
    const source = FILES.find((candidate) => candidate.path === file.path)!.source;
    const parsed = parse(source);
    assert.equal(file.source, source);
    assert.deepEqual(
      file.tokens,
      classifyTokens(source, parsed).map((token) => ({
        kind: token.kind,
        start: token.span.start.offset,
        end: token.span.end.offset,
      })),
    );
    const spans = sourceEnclosingSpans(parsed)!;
    assert.deepEqual(file.enclosing, {
      functions: spans.functions.map(lineSpan),
      blocks: spans.blocks.map(lineSpan),
    });
  }
  const main = sidecar.files[0]!;
  assert.equal(main.enclosing.functions.length, 1);
  assert.ok(main.enclosing.blocks.length >= 3, "nested blocks overlap and all load");
  assert.ok(main.tokens.some((token) => token.kind === "comment"));
});

test("a sidecar loads for the same plan however that plan was admitted", () => {
  const load = loadInstructionPlan(JSON.stringify(PLAN));
  assert.equal(load.kind, "valid");
  if (load.kind === "valid") loaded(SIDECAR, load.plan);
  // EVIDENCE: fixture: the plan's JSON; the sidecar loader captures and validates it.
  loaded(SIDECAR, JSON.parse(JSON.stringify(PLAN)) as InstructionPlan);
});

test("a sidecar made for another plan is stale", () => {
  const edited = compiled([
    { ...FILES[0]!, source: FILES[0]!.source.replace("😀", "😃") },
    FILES[1]!,
  ]);
  const renamed = compiled([
    {
      path: "main.tease",
      source: FILES[0]!.source.replace("rooms/hall.tease", "rooms/yard.tease"),
    },
    { path: "rooms/yard.tease", source: FILES[1]!.source },
  ]);
  // EVIDENCE: fixture: SIDECAR is createSourceDebugSidecar's JSON.
  const parsed = JSON.parse(SIDECAR) as { planSha256: string; files: unknown[] };
  const cases: ReadonlyArray<readonly [string, unknown, InstructionPlan]> = [
    ["edited source", SIDECAR, edited],
    ["other files", SIDECAR, renamed],
    ["other digest", JSON.stringify({ ...parsed, planSha256: "0".repeat(64) }), PLAN],
    ["files reordered", JSON.stringify({ ...parsed, files: [...parsed.files].reverse() }), PLAN],
    ["file missing", JSON.stringify({ ...parsed, files: parsed.files.slice(0, 1) }), PLAN],
  ];
  for (const [name, text, plan] of cases)
    assert.equal(loadSourceDebugSidecar(text, plan).kind, "stale", name);
});

test("a malformed sidecar is rejected as a whole", () => {
  // EVIDENCE: fixture: SIDECAR is createSourceDebugSidecar's JSON.
  const parsed = JSON.parse(SIDECAR) as Record<string, unknown> & {
    files: Array<Record<string, unknown> & { tokens: number[]; enclosing: { blocks: number[] } }>;
  };
  const withFile = (change: (file: (typeof parsed.files)[number]) => void) => {
    const copy = structuredClone(parsed);
    change(copy.files[0]!);
    return JSON.stringify(copy);
  };
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["not a string", parsed],
    ["not JSON", "{"],
    ["unknown field", JSON.stringify({ ...parsed, extra: 1 })],
    ["other revision", JSON.stringify({ ...parsed, version: 2 })],
    ["digest shape", JSON.stringify({ ...parsed, planSha256: "ABC" })],
    ["files not an array", JSON.stringify({ ...parsed, files: {} })],
    ["file field missing", withFile((file) => delete file.source)],
    ["token class out of range", withFile((file) => (file.tokens[0] = 99))],
    ["token triple cut", withFile((file) => file.tokens.pop())],
    ["tokens out of order", withFile((file) => (file.tokens[4] = 0))],
    ["empty token", withFile((file) => (file.tokens[2] = file.tokens[1]!))],
    ["token past the source", withFile((file) => (file.tokens[file.tokens.length - 1] = 1e6))],
    ["span past the last line", withFile((file) => (file.enclosing.blocks[2] = 999))],
    ["span past its line", withFile((file) => (file.enclosing.blocks[3] = 999))],
    [
      "span ends before it starts",
      withFile((file) => {
        const blocks = file.enclosing.blocks;
        const at = blocks.findIndex((value, index) => index % 4 === 0 && value > 0);
        blocks[at + 2] = blocks[at]! - 1;
      }),
    ],
    ["span not an integer", withFile((file) => (file.enclosing.blocks[0] = 0.5))],
    ["enclosing null", withFile((file) => Reflect.set(file, "enclosing", null))],
  ];
  for (const [name, text] of cases)
    assert.equal(loadSourceDebugSidecar(text, PLAN).kind, "invalid", name);
});

test("a sidecar loads and binds as natively when Array.prototype or Object.prototype is changed", () => {
  // EVIDENCE: fixture: SIDECAR is createSourceDebugSidecar's JSON.
  const parsed = JSON.parse(SIDECAR) as {
    files: Array<{ path: string; enclosing: { blocks: number[] } }>;
  };
  const negativeSpan = structuredClone(parsed);
  negativeSpan.files[0]!.enclosing.blocks = [-1, 0, -1, 0];
  const otherPath = structuredClone(parsed);
  otherPath.files[0]!.path = "other.tease";
  // A plan with the same files whose JSON differs, and its genuine sidecar.
  const otherFiles = [{ ...FILES[0]!, source: FILES[0]!.source.replace("😀", "😃") }, FILES[1]!];
  const otherPlan = compiled(otherFiles);
  const otherPlanJson = JSON.stringify(otherPlan);
  const sidecars = [
    SIDECAR,
    createSourceDebugSidecar(otherFiles, otherPlan),
    JSON.stringify(otherPath),
    JSON.stringify(negativeSpan),
  ];
  // A fresh plan identity, so that its digest is computed under the change and kept for it.
  const freshPlan = () => {
    const load = loadInstructionPlan(JSON.stringify(PLAN));
    assert.equal(load.kind, "valid");
    return load.kind === "valid" ? load.plan : PLAN;
  };
  const loadAll = (plan: InstructionPlan) =>
    sidecars.map((text) => loadSourceDebugSidecar(text, plan));
  const native = loadAll(freshPlan());
  assert.deepEqual(
    native.map((load) => load.kind),
    ["valid", "stale", "stale", "invalid"],
  );

  const hook = [
    Array.prototype,
    "toJSON",
    function (this: unknown) {
      return this;
    },
  ] as const;
  // Each change: the properties it sets, and whether it bites. A `toJSON` takes the serializer's hook-free writer.
  const changes: ReadonlyArray<readonly [string, PrototypeChange, () => boolean]> = [
    ["every", [[Array.prototype, "every", () => true]], () => [0].every(() => false)],
    ["some", [[Array.prototype, "some", () => false]], () => ![0].some(() => true)],
    ["toJSON", [[Object.prototype, "toJSON", hook[2]]], () => "toJSON" in []],
    [
      "toJSON, push not adding",
      [
        hook,
        [
          Array.prototype,
          "push",
          function (this: unknown[]) {
            return this.length;
          },
        ],
      ],
      () => [0].push(1) === 1,
    ],
    ["toJSON, empty join", [hook, [Array.prototype, "join", () => ""]], () => [1].join() === ""],
    [
      "toJSON, join giving another plan",
      [hook, [Array.prototype, "join", () => otherPlanJson]],
      () => [1].join() === otherPlanJson,
    ],
    [
      "reverse iterator",
      [
        [
          Array.prototype,
          Symbol.iterator,
          function* (this: unknown[]) {
            for (let index = this.length - 1; index >= 0; index -= 1) yield this[index];
          },
        ],
      ],
      () => new Int32Array([1, 2])[0] === 2,
    ],
    [
      "iterator ending at once",
      [[ARRAY_ITERATOR_PROTOTYPE, "next", () => ({ done: true, value: undefined })]],
      () => [...new Int32Array(1)].length === 0,
    ],
    [
      "toJSON, index setter",
      [hook, [Array.prototype, "0", { set() {} }]],
      () => {
        const array: number[] = [];
        array[0] = 1;
        return array.length === 0;
      },
    ],
  ];
  for (const [name, change, bites] of changes) {
    const plan = freshPlan();
    const { bit, result } = withPrototypeChange(change, bites, () => loadAll(plan));
    assert.ok(bit, `${name} bites`);
    assert.deepEqual(result, native, name);
    // The digest kept for the plan under the change is its own.
    assert.deepEqual(loadAll(plan), native, `${name}, restored`);
  }
});
