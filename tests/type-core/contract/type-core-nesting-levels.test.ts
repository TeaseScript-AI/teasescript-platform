import assert from "node:assert/strict";
import test from "node:test";

import { CONVERSIONS } from "../../../src/conversions.js";
import { DICT_METHODS, DICT_PROPERTIES } from "../../../src/dict-operations.js";
import { isListMethod, LIST_METHODS, LIST_PROPERTIES } from "../../../src/list-methods.js";
import {
  CALENDAR_DURATION_PARTS,
  CLOCK_CONTRACTS,
  TEMPORAL_FIELDS,
  TEMPORAL_METHODS,
} from "../../../src/temporal-builtins.js";
import { TEXT_METHODS } from "../../../src/text-operations.js";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { withoutNestingCut } from "../../../src/type-inference/core/indexes/nesting.js";
import { kindLevel } from "../../../src/type-inference/core/indexes/nesting/levels.js";
import {
  clockResult,
  conversionCategory,
  declaredMethod,
  declaredProperty,
  declaredResult,
  dictList,
  kindElement,
  measuresLength,
  memberResult,
  methodCategory,
  selectsElement,
} from "../../../src/type-inference/core/method-categories.js";
import { OPERATOR_ROWS } from "../../../src/type-inference/core/operator-table.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { VALUE_KIND_NAMES } from "../../../src/value-kinds.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";

/*
 * #2764: the level a value brings into a cycle is never below what the analysis knows of it. Each way a value enters
 * with a level (`indexes/nesting/levels.ts`, the routes in `nesting/routes.ts`) gives sources, made from the language's
 * tables, that put such a value `a0` into a wrap cycle. Each is analysed without the cut (`withoutNestingCut`) and with
 * it, in every order and sharing: at each element level of `a1` down to one below the deepest at which the uncut
 * analysis knows `a0` (what enters the cycle, ADR 0021 rule 1.1), wherever the uncut answer holds a known kind, the
 * cut's answer is the same.
 */

const WRAP = "function wrap(x) {\n  return [x]\n}\n";
const DEEPEST = 4;

/** The kinds whose values hold declared elements (`kindElement`): a range's whole numbers. */
const DECLARING = VALUE_KIND_NAMES.filter((kind) => kindElement(kind) !== undefined);

/** A list method's call with each required argument `1`. */
function listCall(name: keyof typeof LIST_METHODS): string {
  const parameters: readonly object[] = LIST_METHODS[name].parameters;
  const required = parameters.filter(
    (parameter) => !("optional" in parameter) || parameter.optional !== true,
  );
  return `${name}(${required.map(() => "1").join(", ")})`;
}

/** The methods that copy their receiver's elements, a kind's declared ones among them (`methodCategory`). */
const COPIES = Object.keys(LIST_METHODS)
  .filter(isListMethod)
  .filter((name) => methodCategory(name)?.gives.kind === "copy");

/** The written types the rows put at a variable, a parameter and a result. */
function writtenTerms(): string[] {
  // (and the collections written without their elements: those hold a level of values the compiler cannot know)
  return ["list", "list[]", "set", "dict"].concat(
    [...DECLARING, "integer"].flatMap((base) => [
      base,
      `${base}[]`,
      `${base}[][]`,
      `${base}[] set`,
      `${base}[][] | string`,
      `${base}[]?`,
    ]),
  );
}

/** `a0` read from a value of written type `type`, at a variable, a parameter or a result; `expose` reads it. */
function writtenSeeds(type: string, expose: (value: string) => string): string[] {
  return [
    `let w: ${type} = hostValue\nlet a0 = ${expose("w")}`,
    `function seed(w: ${type}) {\n  return ${expose("w")}\n}\nlet a0 = seed(hostValue)`,
    `function seed(v): ${type} {\n  return v\n}\nlet a0 = ${expose("seed(hostValue)")}`,
    `let w: ${type} = load("k", default: hostValue)\nlet a0 = ${expose("w")}`,
  ];
}

/** The dict members that list a dict's keys or values (`dictList`), read below any path. */
const MEMBERS = Object.keys(DICT_PROPERTIES).filter((name) => dictList(name) !== undefined);

/** A function whose result holds its argument's loop values, each wrapped once. */
const FILL =
  "function fill(d) {\n  let out = []\n  for value in d {\n    out = [value]\n  }\n  return out\n}\n";

/** Each way a value enters with a level, by where `levels.ts` or the routes read it; each row's sources set `a0`. */
const ROWS: readonly { readonly row: string; readonly seeds: readonly string[] }[] = [
  { row: "a written type", seeds: writtenTerms().flatMap((type) => writtenSeeds(type, (v) => v)) },
  {
    row: "a kind's declared elements, copied",
    seeds: [
      ...DECLARING.flatMap((kind) =>
        COPIES.flatMap((name) => writtenSeeds(kind, (v) => `${v}.${listCall(name)}`)),
      ),
      ...COPIES.map((name) => `let a0 = (1..3).${listCall(name)}`),
    ],
  },
  {
    row: "a loop's value",
    seeds: [
      ...DECLARING.flatMap((kind) => writtenSeeds(kind, (v) => `fill(${v})`)).map(
        (seed) => FILL + seed,
      ),
      `${FILL}let a0 = fill(1..3)`,
      `${FILL}let a0 = fill(dict{})`,
      `${FILL}let pool = dict{}\npool["k"] = [1]\nlet a0 = fill(pool)`,
      `${FILL}let a0 = fill([[1]])`,
      `${FILL}let a0 = fill(set[[1]])`,
    ],
  },
  {
    row: "a dict's member list",
    seeds: Object.keys(DICT_PROPERTIES)
      .filter((name) => dictList(name) !== undefined)
      .flatMap((name) => [
        `let a0 = dict{}.${name}`,
        `let d = dict{}\nd["k"] = [1]\nlet a0 = d.${name}`,
      ]),
  },
  {
    // (a list method's result or a length, on a list with elements and on one without; host data; a call)
    row: "an expression's value, a kind at its root",
    seeds: [
      ...Object.keys(LIST_METHODS)
        .filter(isListMethod)
        .filter((name) => methodCategory(name) !== undefined)
        .flatMap((name) => [
          `let a0 = [[1].${listCall(name)}]`,
          `let xs = []\nlet a0 = [xs.${listCall(name)}]`,
        ]),
      ...Object.keys(LIST_PROPERTIES)
        .filter((name) => measuresLength(name))
        .map((name) => `let a0 = [[1].${name}]`),
      "let a0 = [hostValue]",
      "function same(v) {\n  return v\n}\nlet a0 = [same(1)]",
      "let c = askChoice 5, 10\nlet a0 = [c]",
      ...MEMBERS.map((name) => `let a0 = [dict{}.${name}]`),
      ...Object.keys(LIST_PROPERTIES)
        .filter((name) => selectsElement(name))
        .map((name) => `let xs = []\nlet a0 = [xs.${name}]`),
    ],
  },
  {
    row: "a fixed value: a function's null, a dict loop's key",
    seeds: [
      'function f {\n  say "x"\n}\nlet a0 = [f()]',
      'let pool = dict{}\npool["k"] = 1\nlet a0 = []\nfor key, value in pool {\n  a0 = [key]\n}',
    ],
  },
  {
    row: "a store in code that never runs",
    seeds: [
      "let a0 = []\nfor value in dict{} {\n  a0 = [value]\n}",
      "let a0 = []\nfor value in dict{} {\n  a0 = [[[value]]]\n}",
    ],
  },
  {
    row: "a literal",
    seeds: [
      "let a0 = [[1]]",
      "let a0 = [[[1]]]",
      "let a0 = set[[1]]",
      "let a0 = [1..3]",
      "let a0 = [dict{}]",
      "let a0 = [[dict{}]]",
      "let a0 = {v: [[1]]}",
      'let d = dict{}\nd["k"] = [[1]]\nlet a0 = d',
    ],
  },
];

/**
 * The paths each analysis is asked at, with their element levels: `k` element steps, and each dict member's elements
 * below them, a dict's values at its elements' level, its keys, a list it makes, at its own.
 */
const PATHS: readonly { readonly steps: readonly string[]; readonly level: number }[] = Array.from(
  { length: DEEPEST + 1 },
  (_, k) => {
    const elements = Array.from({ length: k }, () => "element");
    return [
      { steps: elements, level: k },
      ...(k < DEEPEST
        ? MEMBERS.map((name) => ({
            steps: [...elements, name, "element"],
            level: dictList(name) === "values" ? k + 1 : k,
          }))
        : []),
    ];
  },
).flat();

/** `name`'s kinds at each of `PATHS`, as tags with their contexts, for each of `names`. */
function levels(source: string, names: readonly string[]): readonly (readonly string[][])[] {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null, source);
  const program = new CoreProgram(request);
  const answers = analyseCore(request);
  return names.map((name) => {
    const place = program.places.find(
      (candidate) => candidate.kind.kind === "binding" && candidate.kind.name === name,
    )!;
    return PATHS.map(({ steps }) =>
      answers
        .place(place.id, steps)
        .contract.kinds.map((item) => `${item.tag}/${item.context ?? ""}`),
    );
  });
}

/** Whether an answer holds a known kind: neither unknown nor `empty`. */
function known(items: readonly string[]): boolean {
  return items.some((item) => !item.startsWith("unknown/") && !item.startsWith("empty/"));
}

for (const { row, seeds } of ROWS)
  test(`the cut keeps every level the analysis knows of ${row}, in every order and sharing`, () => {
    for (const seed of seeds) {
      const source = `${WRAP}${seed}\nlet a1 = wrap(a0)\nlet a2 = wrap(a1)\n`;
      // (what enters the cycle, `a0`, is known to `entering` levels without the cut; the cycle's values one level
      // deeper, ADR 0021 rule 1.1: there, the cut's answer is the uncut one)
      const [a0, a1] = withoutNestingCut(() => levels(source, ["a0", "a1"]));
      const entering = Math.max(
        0,
        ...a0!.flatMap((items, at) => (known(items) ? [PATHS[at]!.level] : [])),
      );
      assert.ok(entering < DEEPEST, source);
      for (const mode of MODES) {
        const [cut] = inMode(mode, () => levels(source, ["a1"]));
        PATHS.forEach(({ steps, level }, at) => {
          if (level <= entering + 1 && known(a1![at]!))
            assert.deepEqual(
              cut![at],
              a1![at],
              `${source}\n(a1 at ${steps.join(".")}, ${JSON.stringify(mode)})`,
            );
        });
      }
    }
  });

test("no built-in's declared result holds declared elements but the range operator's", () => {
  // (a declared result of level 0 is never below what the analysis knows: a cycle's entering level is at least 0. One
  // that holds declared elements needs its row above)
  const methods = [
    ...Object.keys(LIST_METHODS),
    ...Object.keys(DICT_METHODS),
    ...Object.keys(TEXT_METHODS),
    ...Object.keys(TEMPORAL_METHODS),
  ];
  const properties = [
    ...Object.keys(LIST_PROPERTIES),
    ...Object.keys(DICT_PROPERTIES),
    ...Object.keys(TEMPORAL_FIELDS),
    ...Object.keys(CALENDAR_DURATION_PARTS),
  ];
  const declared = [
    ...methods.flatMap((name) => {
      const gives = methodCategory(name)?.gives;
      return gives?.kind === "declared" ? declaredResult(name, gives.kinds, "unknown") : [];
    }),
    ...VALUE_KIND_NAMES.flatMap((kind) =>
      methods.flatMap((name) => declaredMethod(kind, name) ?? []),
    ),
    ...VALUE_KIND_NAMES.flatMap((kind) =>
      properties.flatMap((name) => declaredProperty(kind, name) ?? []),
    ),
    ...properties.flatMap((name) => memberResult(name) ?? []),
    ...Object.keys(CLOCK_CONTRACTS).flatMap((name) => clockResult(name) ?? []),
    ...Object.keys(CONVERSIONS).flatMap((name) => {
      const conversion = conversionCategory(name);
      return conversion?.kind === "converts" ? [conversion.result] : [];
    }),
    ...OPERATOR_ROWS.map((row) => row.result),
  ];
  assert.deepEqual(
    [...new Set(declared)].filter((kind) => kindLevel(kind) > 0),
    [],
  );
});
