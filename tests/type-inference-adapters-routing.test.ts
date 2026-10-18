import assert from "node:assert/strict";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import { collectGraph } from "../src/type-inference/collector.js";
import type { ContractFamily } from "../src/type-inference/graph.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * Every operation the collector emits has a relation (work note §4); an injected host builtin's gives a result the
 * compiler cannot know. The families below are the ones whose modules are filled in; the set grows
 * with the stage and is complete when 2b lands.
 */
const IMPLEMENTED: ReadonlySet<ContractFamily> = new Set([
  "operator",
  "unary",
  "logic",
  "comparison",
  "typeTest",
  "interpolation",
  "unit",
  "angle",
  "range",
  "random",
  "method",
  "listFunction",
  "builtin",
]);

const SOURCE = [
  'speaker guide {\n displayName: "Guide"\n}',
  "let n = 1",
  "n += 2",
  "let b = n > 1 and not hostFlag or n == 2",
  "let t = hostValue is integer",
  'let s = "${n} items"',
  "let d = 3 s + 1 calendar days",
  "let u = (n + 1) s",
  "let a = 90 deg",
  "let g = 1..4",
  "let c = toInteger(hostText, default: 0)",
  "let f = fromBase64(hostText, default: hostValue)",
  'let h = hashText("x")',
  "let r1 = random() + randomInteger(1..6)",
  'let r2 = randomWeighted(dict { "a": 1 })',
  "let m = abs(-1) + sqrt(4)",
  "let now = getDate()",
  "let xs = [1, 2]",
  "let low = min(xs)",
  "let both = min(1, 2)",
  'let total = sum([{ v: 1 }], by: "v")',
  "xs.add(3)",
  "let got = xs.get(0, default: 1)",
  "let joined = xs.union([4])",
  'let text = "a".trim()',
  'let keys = dict { "k": 1 }.keys',
  "let tm = timer async 1 s",
  "tm.cancel()",
  'let answer = askText "Q?", prefill: "a"',
  'let choice = askChoice back: "Back", "Lines"',
  'let flags = askBooleans("Which?", texts: ["A"], prefill: [false], cancel: "Back")',
  'let yes = askBoolean "Q?"',
  'let form = askForm("Q", fields: { name: "Ada" })',
  'let picture = askImage("Picture", allowSkip: true)',
  'let said = say "hi"',
  'let pressed = showButton "Go", timeout: 5 s',
  'let popup = showPopup(message: "x")',
  'let clip = playAudio async "a.mp3"',
  "let view = showCamera",
  "let photo = takePhoto()",
  'let images = findImages(where: "heat" > 1)',
  "let first = account.firstName",
  "hostFn(1)",
  "switch n {\ncase 1 {\nsay 1\n}\n}",
  "exit",
].join("\n");

test("every emitted operation of an implemented family has a relation", () => {
  const made = request(
    [{ path: "main.tease", source: SOURCE }],
    ["hostValue", "hostFlag", "hostText"],
    ["hostFn"],
  );
  assert.notEqual(made, null, "the routing source parses and resolves");
  const graph = collectGraph(made!);
  const relations = operationRelations();
  const families = new Set<ContractFamily>();
  const missing: string[] = [];
  for (const constraint of graph.constraints) {
    if (constraint.kind !== "operation") continue;
    const { family, name } = constraint.contract;
    families.add(family);
    if (family === "builtin" && name === "hostFn") {
      const host = relations.relation(constraint.contract);
      assert.ok(host !== undefined, "an injected builtin has a relation");
      assert.deepEqual(
        host.result({
          receiver: null,
          arguments: [],
          named: new Map(),
          evidence: undefined,
          view: () => assert.fail("no place"),
        }),
        { kind: "dynamic", why: "unknown callee" },
        "an injected builtin's result cannot be known",
      );
      continue;
    }
    if (!IMPLEMENTED.has(family)) continue;
    if (relations.relation(constraint.contract) === undefined) missing.push(`${family}.${name}`);
  }
  assert.deepEqual(missing, [], "relations for every emitted key of an implemented family");
  // The source reaches every family the collector can emit, so a key the table forgets is seen here.
  const all: ContractFamily[] = [
    "method",
    "operator",
    "unary",
    "comparison",
    "logic",
    "typeTest",
    "interpolation",
    "unit",
    "angle",
    "range",
    "conversion",
    "random",
    "numeric",
    "clock",
    "listFunction",
    "speakerField",
    "interaction",
    "say",
    "showButton",
    "popup",
    "timer",
    "media",
    "camera",
    "tagQuery",
    "capture",
    "builtin",
  ];
  assert.deepEqual(
    all.filter((family) => !families.has(family)),
    [],
    "every family is emitted by the source",
  );
});
