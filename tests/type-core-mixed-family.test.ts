import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../src/compiler.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { coreMessage, messageSource } from "../src/type-inference/core/messages.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { inMode, MODES, sentences } from "./helpers/type-core-oracles.js";

/**
 * #1765's invariant (the lead's family rule on #1789, after Codex r9–r11 and Astra r2): a mixed-list error's type text
 * equals the current checker's first sentence across a generated family of the sides it composes. One side is a
 * literal of whole numbers two or three lists deep, the other its text twin. The whole-number side varies:
 * - its `null` at no layer, at each layer between the element and the leaf, or at the leaf;
 * - at the element or any layer, its value carried: `take`, an index, a `get` default, an `otherwise`'s operand or
 *   fallback, a property, a join, or a written copy narrowed by its value or one that may be null;
 * - the pair as list elements, object properties, or the operands of `+`;
 * - in both orders and four modes.
 * The modes agree on every source. Where both checkers report the error, the first sentences are equal, except the
 * inherited classes below, each the work of its issue:
 * - the later element's own or leaf `null`, #1790 (#1819, stacked on this);
 * - the earliest element's own `or null` (a copy that may be null at the element), #1843.
 * A source only one checker reports on is outside the candidate slice there and is not compared.
 */
const WRAPS: Readonly<Record<string, ((value: string) => string) | "narrowed" | "maybe">> = {
  take: (value) => `(${value}).take(9)`,
  index: (value) => `[${value}][0]`,
  get: (value) => `[].get(0, default: ${value})`,
  operand: (value) => `(${value} otherwise null)`,
  fallback: (value) => `(null otherwise ${value})`,
  property: (value) => `{p:${value}}.p`,
  join: (value) => `(${value})+[]`,
  narrowed: "narrowed",
  maybe: "maybe",
};
const POSITIONS: Readonly<Record<string, (a: string, b: string) => string>> = {
  element: (a, b) => `let xs=[${a},${b}]`,
  property: (a, b) => `let xs=[{f:${a}},{f:${b}}]`,
  join: (a, b) => `let xs=[${a}]+[${b}]`,
};

interface Row {
  readonly source: string;
  readonly depth: number;
  readonly nullAt: number;
  readonly wrapAt: number;
  readonly wrap: string;
  readonly later: boolean;
}

function side(
  leaf: string,
  depth: number,
  nullAt: number,
  wrapAt: number,
  wrap: string,
  declarations: string[],
): string {
  const type = (at: number): string =>
    at === depth
      ? leaf === "1"
        ? "integer"
        : "string"
      : `${type(at + 1)}${nullAt === at + 1 ? "?" : ""}[]`;
  const build = (at: number): string => {
    if (at === depth) return leaf;
    const list = `[${build(at + 1)}${nullAt === at + 1 ? ",null" : ""}]`;
    if (wrapAt !== at) return list;
    const made = WRAPS[wrap]!;
    if (typeof made === "function") return made(list);
    declarations.push(
      `let c:${type(at)}?=${list}\n${made === "maybe" ? "if hostValue == 1 { c=null }\n" : ""}`,
    );
    return "c";
  };
  return build(0);
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const depth of [2, 3])
    for (let nullAt = 0; nullAt <= depth; nullAt += 1)
      for (let wrapAt = -1; wrapAt < depth; wrapAt += 1)
        for (const wrap of wrapAt < 0 ? [""] : Object.keys(WRAPS))
          for (const make of Object.values(POSITIONS))
            for (const later of [false, true]) {
              const declarations: string[] = [];
              const a = side("1", depth, nullAt, wrapAt, wrap, declarations);
              const b = side('"x"', depth, 0, -1, "", []);
              const pair = later ? make(b, a) : make(a, b);
              out.push({
                source: `${declarations.join("")}${pair}\nexit\n`,
                depth,
                nullAt,
                wrapAt,
                wrap,
                later,
              });
            }
  return out;
}

// (the inherited classes: a row whose whole-number side holds null where it is the later element's own value or leaf,
// or the earliest element's own value)
function inherited(row: Row): string | null {
  const own = row.wrap === "maybe" && row.wrapAt === 0;
  if (row.later && (row.nullAt === row.depth || own)) return "#1790";
  if (!row.later && own) return "#1843";
  return null;
}

const first = (messages: readonly string[]): string[] =>
  [...new Set(messages.map((message) => sentences(message)[0]!))].sort();

test("a mixed-list error's type text equals the current checker's across the generated family (#1765)", () => {
  const differing: string[] = [];
  let compared = 0;
  let exempt = 0;
  for (const row of rows()) {
    const files = [{ path: "main.tease", source: row.source }];
    const current = first(
      compileProject(files, { globals: ["hostValue"] })
        .diagnostics.filter((each) => each.code === "TSV044")
        .map((each) => each.message),
    );
    const request = coreRequest(files);
    const core = MODES.map((mode) =>
      request === null
        ? []
        : inMode(mode, () => {
            const { diagnostics } = analyseCore(request);
            const text = messageSource([row.source], diagnostics);
            return first(
              diagnostics
                .filter((each) => each.code === "TSV044")
                .map((each) => coreMessage(each, text)),
            );
          }),
    );
    for (const each of core) assert.deepEqual(each, core[0], row.source);
    if (core[0]!.length === 0 || current.length === 0) continue;
    compared += 1;
    if (JSON.stringify(core[0]) === JSON.stringify(current)) continue;
    if (inherited(row) !== null) exempt += 1;
    else
      differing.push(
        `${row.source}\n  core: ${core[0]!.join(" | ")}\n  checker: ${current.join(" | ")}`,
      );
  }
  assert.deepEqual(differing, [], `${compared} compared, ${exempt} inherited`);
  assert.ok(compared > 0);
});

/**
 * #1765's invariant, its work: each carrier kind of the family, deep (a nest of dicts and lists behind it, errors at ever
 * longer paths, ×4.5 per doubling, as the nest alone grows) and wide (k wrapped elements before k disagreeing ones, ×2.5
 * per doubling), at two doublings. One mode: the four-mode growth tests in `type-core-messages.test.ts` cover the
 * evaluator's other dimensions (joins, `otherwise` chains, the wide earliest literal, the nest behind a carrier).
 */
test("a mixed-list error's layers grow linearly behind every carrier kind (#1765)", () => {
  const total = (source: string): number => {
    const request = coreRequest([{ path: "main.tease", source }]);
    assert.ok(request !== null, source);
    const answers = inMode(MODES[0]!, () => analyseCore(request));
    assert.equal(answers.budget.exhausted, null, source);
    return answers.budget.total;
  };
  for (const [kind, made] of Object.entries(WRAPS)) {
    if (typeof made !== "function") continue;
    const deep = [12, 24, 48].map((n) => {
      let first = "[1]";
      let second = '["x"]';
      for (let at = 0; at < n; at += 1) {
        first = `dict {k:[${first}]}`;
        second = `[dict {k:${second}}]`;
      }
      return total(`let xs=[${made(`[${first}]`)},${made(`[${second}]`)}]\nexit\n`);
    });
    const wide = [16, 32, 64].map((k) =>
      total(
        `let xs=[[${Array.from({ length: k }, (_, at) => made(`[${at}]`)).join(",")}],${Array.from({ length: k }, (_, at) => `[["s${at}"]]`).join(",")}]\nexit\n`,
      ),
    );
    for (let at = 1; at < 3; at += 1) {
      assert.ok(deep[at]! <= 4.5 * deep[at - 1]!, `${kind} deep: ${deep.join(", ")}`);
      assert.ok(wide[at]! <= 2.5 * wide[at - 1]!, `${kind} wide: ${wide.join(", ")}`);
    }
  }
});
