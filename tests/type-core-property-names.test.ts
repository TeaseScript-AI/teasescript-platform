import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { Expression } from "../src/ast.js";

import { analyseCore } from "../src/type-inference/core/answers.js";
import {
  BudgetExhausted,
  withTestAllowance,
  withTestDemandAllowance,
} from "../src/type-inference/core/budget.js";
import { coreMessage, messageSource } from "../src/type-inference/core/messages.js";
import { propertyStep } from "../src/type-inference/core/program.js";
import { withNameRecords } from "../src/type-inference/core/property-names.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { MODES, inMode } from "./helpers/type-core-oracles.js";

/*
 * #1493: a property-name search follows a value's copied sources. A copy fed back into the object it came from
 * (`w = r.z`, with `r` holding copies of `w`) gave the search a key one step longer on every turn, its identity never seen
 * before, so it never ended and its pending keys and paths filled the heap. It ends now at a pump: a task of an earlier
 * one's place whose path inserts steps above a tail no step between them touched, the turn the search would repeat
 * forever. A search that ended before ends as before, whatever the answers at its keys, stopped or not.
 */

/** The copies of `w` fed back into it through `r.z`, at width `k`: the issue's shape (#1493). */
function feedback(k: number): string {
  const fields = (prefix: string, value: string) =>
    Array.from({ length: k }, (_, i) => `${prefix}${i}:${value}`).join(",");
  return [
    `let w={${fields("f", "1")},${fields("h", "null")},z:null}`,
    ...Array.from({ length: k }, (_, i) => `let s${i}=w\ns${i}.h${i}=1`),
    `let r={${fields("f", "null")},z:null}`,
    ...Array.from({ length: k }, (_, i) => `r=s${i}`),
    "w=r.z",
    "let c=r",
    "exit",
  ].join("\n");
}

/** The property names of the first read of `name` in `source`, in `mode`, and whether the analysis stopped and settled. */
function namesOf(source: string, name: string, mode = MODES[0]!) {
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null, source);
  return inMode(mode, () => {
    const answers = analyseCore(request);
    const node = answers.graph.nodes.find(
      (found) => found.expression?.kind === "identifier" && found.expression.name === name,
    );
    assert.ok(node !== undefined, `${name} is read`);
    return {
      names: [...answers.properties(node).keys()].sort(),
      stopped: answers.budget.exhausted !== null,
      settled: answers.budget.settled,
    };
  });
}

/** The variable and the properties a read names (`b.p`), else `null`. */
function readChain(expression: Expression | undefined): readonly string[] | null {
  if (expression?.kind === "identifier") return [expression.name];
  if (expression?.kind !== "propertyAccessExpression") return null;
  const above = readChain(expression.object);
  return above === null ? null : [...above, expression.property.name];
}

test("a copy fed back into the object it came from ends its property-name search, in every mode (#1493)", () => {
  const k8 = [
    ...Array.from({ length: 8 }, (_, i) => `f${i}`),
    ...Array.from({ length: 8 }, (_, i) => `h${i}`),
    "z",
  ].sort();
  for (const mode of MODES) {
    assert.deepEqual(namesOf(feedback(8), "w", mode).names, k8, JSON.stringify(mode));
    // (a source reaches the same search through `toJson`, inside the analysis)
    assert.deepEqual(
      namesOf(feedback(8).replace("\nexit", "\nlet text=toJson(s0)\nexit"), "w", mode).names,
      k8,
      JSON.stringify(mode),
    );
  }
  // (an object stored into its own property, directly and through a copy)
  assert.deepEqual(namesOf("let w={f:1,z:null}\nw.z=w\nlet s=w\nexit", "w").names, ["f", "z"]);
  assert.deepEqual(
    namesOf("let w={f:1,z:null}\nlet s=w\ns.z=w\nlet r=s.z\nw=r\nlet text=toJson(w)\nexit", "w")
      .names,
    ["f", "z"],
  );
  // (a copy fed back below a property, `w.a = r.a.q` with `r` a copy of `w`: each turn inserts `q` between the head
  // `a` and the tail `t`, `w|a.t`, `w|a.q.t`, ...; asked by the place, in every mode)
  const below = "let w={a:{t:{k:1},q:{t:{k:2}}}}\nlet r=w\nw.a=r.a.q\nsay w\nexit";
  const request = coreRequest([{ path: "main.tease", source: below }], ["hostValue"]);
  assert.ok(request !== null);
  for (const mode of MODES)
    assert.deepEqual(
      inMode(mode, () => {
        const answers = analyseCore(request);
        const node = answers.graph.nodes.find(
          (each) => each.expression?.kind === "identifier" && each.expression.name === "w",
        );
        const place = node === undefined ? null : answers.at(node)?.place;
        assert.ok(place !== null && place !== undefined);
        return [...answers.placeProperties(place.id, ["a", "t"].map(propertyStep))].sort();
      }),
      ["k"],
      JSON.stringify(mode),
    );
});

test("a key's own stores name their properties whatever its answer, its copies reach them whatever theirs (#1493)", () => {
  // (data from outside the script keeps a property the script stores into it)
  assert.deepEqual(namesOf("let w=hostValue\nw.extra=1\nexit", "w").names, ["extra"]);
  // (an object beside data from outside: the object's properties)
  assert.deepEqual(namesOf("let w=hostValue\nw={extra:1}\nlet s=w\nexit", "w").names, ["extra"]);
  // (data from outside alone: no property known)
  assert.deepEqual(namesOf("let w=hostValue\nlet s=w\nexit", "w").names, []);
  // (a copy of a copy of an object: its properties, through each copy's source)
  assert.deepEqual(namesOf("let a={x:1}\nlet b=a\nb.y=2\nlet c=b\nexit", "b").names, ["x", "y"]);
  // Codex r1's B1: a store reached through a copy whose answer holds no object (data from outside, an opaque value), at
  // the copy and below a property, a copy of a property, and a property copied from another of the same variable's;
  // by the read itself (`b`, `b.p`) and by its place, in every mode
  for (const [source, name, steps, names] of [
    ["let a=hostValue\na.extra=1\nlet b=a\nsay b\nexit", "b", [], ["extra"]],
    ["let a={x:1}.first\na.extra=1\nlet b=a\nsay b\nexit", "b", [], ["extra"]],
    ["let a={p:hostValue}\na.p.extra=1\nlet b=a\nsay b.p\nexit", "b", ["p"], ["extra"]],
    ["let a={p:hostValue}\na.p.extra=1\nlet b=a.p\nsay b\nexit", "b", [], ["extra"]],
    [
      "let t=hostValue\nt.k=1\nlet p={a:hostValue,x:{y:hostValue}}\np.x.y=t\np.a=p.x.y\nlet r=p.a\nsay r\nexit",
      "r",
      [],
      ["k"],
    ],
  ] as const)
    for (const mode of MODES) {
      const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
      assert.ok(request !== null, source);
      const found = inMode(mode, () => {
        const answers = analyseCore(request);
        const node = answers.graph.nodes.find(
          (each) => each.expression?.kind === "identifier" && each.expression.name === name,
        );
        const place = node === undefined ? null : answers.at(node)?.place;
        assert.ok(node !== undefined && place !== null && place !== undefined, source);
        // (the read itself: the variable's, or its property's, `b.p`)
        const read = answers.graph.nodes.find((each) => {
          const chain = readChain(each.expression);
          return chain !== null && isDeepStrictEqual(chain, [name, ...steps]);
        });
        assert.ok(read !== undefined, `${source}: the read of ${[name, ...steps].join(".")}`);
        return {
          read: [...answers.properties(read).keys()].sort(),
          place: [
            ...answers.placeProperties(place.id, [...place.path, ...steps.map(propertyStep)]),
          ].sort(),
        };
      });
      assert.deepEqual(found, { read: names, place: names }, `${source} ${JSON.stringify(mode)}`);
    }
});

test("a stopped analysis's property-name search ends with names its own stores and literals give (#1493)", () => {
  const source = feedback(8);
  const full = namesOf(source, "w").names;
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null);
  const total = analyseCore(request).budget.total;
  // (a stop before admission settled, its units finished afresh, and one in the settled walk)
  for (const [allowance, settled] of [
    [2_000, false],
    [total - 1, true],
  ] as const) {
    const stopped = withTestAllowance(allowance, () => namesOf(source, "w"));
    assert.ok(stopped.stopped, `the analysis stops at ${allowance}`);
    assert.equal(stopped.settled, settled);
    assert.ok(
      stopped.names.every((name) => full.includes(name)),
      `${JSON.stringify(stopped.names)} within ${JSON.stringify(full)}`,
    );
  }
});

test("a demand stop with a question stop after it ends the search, its names within the unstopped ones (#1493)", () => {
  // Codex r1's B2: the decisions of `w` and `r` stop at their demand allowance, every key below them unknown by budget;
  // the question about `s` passes the program's allowance, and is asked again of the stopped answers
  const source = "let w={f:1,z:null}\nlet s=w\nlet r={f:null,z:null}\nr=s\nw=r.z\nlet c=r\nexit";
  const full = namesOf(source, "s").names;
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null);
  let retried = 0;
  for (const mode of MODES) {
    const found = inMode(mode, () =>
      withTestDemandAllowance(16, () =>
        withTestAllowance(4000, () => {
          let answers = analyseCore(request);
          assert.ok(answers.budget.decisions.some((decision) => decision.stopped));
          const node = answers.graph.nodes.find(
            (each) => each.expression?.kind === "identifier" && each.expression.name === "s",
          );
          assert.ok(node !== undefined);
          try {
            return [...answers.properties(node).keys()];
          } catch (error) {
            if (!(error instanceof BudgetExhausted)) throw error;
            retried += 1;
            answers = answers.stoppedAt(error.limit);
            return [...answers.properties(node).keys()];
          }
        }),
      ),
    );
    assert.ok(
      found.every((name) => full.includes(name)),
      `${JSON.stringify(found)} within ${JSON.stringify(full)} ${JSON.stringify(mode)}`,
    );
  }
  assert.ok(retried > 0, "a question stops and is asked again");
});

test("the search charges each task it takes up, each prefix it visits, each entry of its path's index and each step its pump check walks or compares (#1493)", () => {
  // (the uncharged-work probe's gate, kept here: the ledger's `checks` during a search are its tasks, a seen one too,
  // its prefixes, its path's index entries, its pump checks' earlier tasks of their own place and their head steps; the
  // entries stay within 2 + ⌈log₂ D⌉ per task on a chain of D, the earlier tasks within the longest walk per task, and
  // the head steps within the longest path per earlier task walked)
  const nested = (depth: number): string => {
    const path = ".p".repeat(depth);
    return [
      "let t=hostValue",
      "t.k=1",
      `let p=${"{p:".repeat(depth)}{a:hostValue,x:{y:hostValue}}${"}".repeat(depth)}`,
      `p${path}.x.y=t`,
      `p${path}.a=p${path}.x.y`,
      `let r=p${path}.a`,
      "say r",
      "exit",
    ].join("\n");
  };
  const asks: readonly (readonly [string, string, readonly string[] | null])[] = [
    [feedback(8), "w", null],
    [feedback(16), "w", null],
    ["let w={a:{t:{k:1},q:{t:{k:2}}}}\nlet r=w\nw.a=r.a.q\nsay w\nexit", "w", ["a", "t"]],
    ["let a=hostValue\na.extra=1\nlet b=a\nsay b\nexit", "b", null],
    // (Codex r2's witness: a property copied from another of the same variable's, `depth` properties down, whose pump
    // check compares one head as long as that path)
    ...[4, 16, 64].map((depth) => [nested(depth), "r", null] as const),
  ];
  const heads = new Map<string, number[]>();
  for (const [source, name, steps] of asks)
    for (const mode of MODES) {
      const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
      assert.ok(request !== null);
      const records = inMode(mode, () => {
        const answers = analyseCore(request);
        const node = answers.graph.nodes.find(
          (each) => each.expression?.kind === "identifier" && each.expression.name === name,
        );
        const place = node === undefined ? null : answers.at(node)?.place;
        assert.ok(node !== undefined && place !== null && place !== undefined);
        return withNameRecords(() =>
          steps === null
            ? answers.properties(node)
            : answers.placeProperties(place.id, steps.map(propertyStep)),
        ).records;
      });
      const label = `${source.slice(0, 40)} ${JSON.stringify(mode)} ${JSON.stringify(records)}`;
      assert.ok(records.tasks > 0, label);
      assert.equal(
        records.checks,
        records.tasks + records.prefixes + records.entries + records.ancestors + records.heads,
        label,
      );
      assert.ok(
        records.entries <= records.tasks * (2 + Math.ceil(Math.log2(records.chain))),
        label,
      );
      assert.ok(records.ancestors <= records.tasks * records.depth, label);
      assert.ok(records.heads <= records.ancestors * records.longest, label);
      if (name === "r" && source.startsWith("let t=hostValue")) {
        const key = JSON.stringify(mode);
        heads.set(key, [
          ...(heads.get(key) ?? []),
          records.tasks,
          records.ancestors,
          records.depth,
          records.heads,
        ]);
      }
    }
  // (the corpus's mutual feedback through `q`, `a.q=b` and `b.q=a`, asked 64 properties down as the candidate route's
  // descent asks it: each step of its chains is shorter than the one before, so no earlier task can be pumped and the
  // check walks none; walking them made each such search quadratic in its depth, its descent past the allowance)
  const mutual =
    'let typed:object={x:1}\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\na.f=hostValue\nb.q=a\nb=b\na.q=b\nc.f=hostValue\nexit';
  const request = coreRequest([{ path: "main.tease", source: mutual }], ["hostValue"]);
  assert.ok(request !== null);
  for (const mode of MODES) {
    const { result, records } = inMode(mode, () => {
      const answers = analyseCore(request);
      const node = answers.graph.nodes.find(
        (each) => each.expression?.kind === "identifier" && each.expression.name === "a",
      );
      const place = node === undefined ? null : answers.at(node)?.place;
      assert.ok(place !== null && place !== undefined);
      return withNameRecords(() => [
        ...answers.placeProperties(
          place.id,
          Array.from({ length: 64 }, () => propertyStep("q")),
        ),
      ]);
    });
    assert.deepEqual(result.sort(), ["f", "g", "q"], JSON.stringify(mode));
    assert.equal(records.ancestors, 0, `${JSON.stringify(mode)} ${JSON.stringify(records)}`);
  }
  // (a chain whose every task is a new place, `let c(i+1)={p:c(i)}` read `depth` properties down: an index of each
  // chain's kinds and places copied per task made 527,878 entries at 256, quadratic; the depth-first path's stays within
  // 2 + ⌈log₂ D⌉ per task, 9,272 at 256)
  const places = (depth: number): string =>
    [
      "let c0={kept:1}",
      ...Array.from({ length: depth }, (_, index) => `let c${index + 1}={p:c${index}}`),
      `let read=c${depth}${".p".repeat(depth)}`,
      "say read",
      "exit",
    ].join("\n");
  for (const depth of [16, 64, 256]) {
    const request = coreRequest([{ path: "main.tease", source: places(depth) }], ["hostValue"]);
    assert.ok(request !== null);
    for (const mode of MODES) {
      const { result, records } = inMode(mode, () => {
        const answers = analyseCore(request);
        const node = answers.graph.nodes.find(
          (each) => each.expression?.kind === "identifier" && each.expression.name === "read",
        );
        assert.ok(node !== undefined);
        return withNameRecords(() => [...answers.properties(node).keys()]);
      });
      const label = `${depth} ${JSON.stringify(mode)} ${JSON.stringify(records)}`;
      assert.deepEqual(result, ["kept"], label);
      assert.equal(
        records.checks,
        records.tasks + records.prefixes + records.entries + records.ancestors + records.heads,
        label,
      );
      assert.ok(
        records.entries <= records.tasks * (2 + Math.ceil(Math.log2(records.chain))),
        label,
      );
    }
  }
  // (at depths 4, 16 and 64 the tasks, the earlier tasks walked and the longest chain stay the same, and the head steps
  // grow by the path's own growth: the head term grows no faster than the path)
  for (const [mode, [t4, a4, d4, h4, t16, a16, d16, h16, t64, a64, d64, h64]] of heads) {
    assert.deepEqual([t16, a16, d16, t64, a64, d64], [t4, a4, d4, t4, a4, d4], mode);
    assert.deepEqual([h16! - h4!, h64! - h16!], [12, 48], mode);
  }
});

test("no pump fires on a search that ends without the bound, whose least kept since an earlier visit of its place is not the last step's (#1493)", () => {
  // (Astra r1's witness: from `a|x` the store `a.x=b.y.q` keeps none of the path for `b|y.q`, whose copy `a|y.q` keeps
  // both its steps; the least `kept` since `a|x` is the store's none, so `a|y.q` does not pump it, and base ends here)
  const source =
    "let a={x:{y:{kept:1}},y:{q:{other:1}}}\nlet b=a\na.x=b.y.q\nlet read=b.x\nsay read\nexit";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null);
  for (const mode of MODES) {
    const { result, records } = inMode(mode, () => {
      const answers = analyseCore(request);
      const node = answers.graph.nodes.find(
        (each) => each.expression?.kind === "identifier" && each.expression.name === "read",
      );
      assert.ok(node !== undefined);
      return withNameRecords(() => [...answers.properties(node).keys()]);
    });
    assert.deepEqual(result.sort(), ["other", "y"], JSON.stringify(mode));
    assert.equal(records.pumped, 0, `${JSON.stringify(mode)} ${JSON.stringify(records)}`);
  }
});

test("the search makes no uncharged temporary per step beyond a constant, its prefixes the stored keys along the path, and its pump check walks no more earlier tasks than it takes up (#1493)", () => {
  // Astra r1's B1: each prefix rebuilt both halves of its path and its key, uncharged, cubic in a mutual feedback's
  // depth. The walk visits only the stored keys along a path (`definitions.stored`), their text its own, and keeps the
  // rest of the path through `keptSlice`. Here every built-in `slice`, `substring`, `join`, `map` and `concat` result
  // whose first caller past the key and path helpers is the walk, and no kept helper made it, counts as an uncharged
  // temporary (the uncharged-work probe `transient-probe.mjs` adds `split` and `filter`): by the read and by the place,
  // at depths 16, 32 and 64, in every mode
  const mutual = (depth: number): string =>
    [
      "let a={left:1,q:null}",
      "let b={right:2,q:null}",
      "a.q=b",
      "b.q=a",
      `let read=a${".q".repeat(depth)}`,
      "say read",
      "exit",
    ].join("\n");
  const walkFrame = (): boolean => {
    // (past this check, the counter and the built-in's wrapper, here in the test)
    for (const frame of (new Error().stack ?? "").split("\n").slice(4)) {
      if (/\bat kept[A-Z]\w*/.test(frame)) return false;
      if (/node:internal|\/core\/(definitions|budget)\.(js|ts)/.test(frame)) continue;
      return /\/core\/property-names\.(js|ts)/.test(frame);
    }
    return false;
  };
  const observed = <T>(ask: () => T): { readonly result: T; readonly uncharged: number } => {
    let uncharged = 0;
    let counting = true;
    const seen = (size: number): void => {
      if (!counting || size === 0) return;
      counting = false;
      if (walkFrame()) uncharged += size;
      counting = true;
    };
    const arrays = Array.prototype;
    const texts = String.prototype;
    const [slice, join, map, concat] = [arrays.slice, arrays.join, arrays.map, arrays.concat];
    const [textSlice, substring] = [texts.slice, texts.substring];
    arrays.slice = function (this: unknown[], start?: number, end?: number): unknown[] {
      const result = slice.call(this, start, end);
      seen(result.length);
      return result;
    };
    arrays.join = function (this: unknown[], separator?: string): string {
      const result = join.call(this, separator);
      seen(result.length);
      return result;
    };
    arrays.map = function <U>(
      this: unknown[],
      callback: (value: unknown, index: number, array: unknown[]) => U,
    ): U[] {
      // EVIDENCE: `Array.prototype.map` returns an array of the callback's results.
      const result = map.call(this, callback) as U[];
      seen(result.length);
      return result;
    };
    arrays.concat = function (this: unknown[], ...items: unknown[]): unknown[] {
      const result = concat.apply(this, items);
      seen(result.length);
      return result;
    };
    texts.slice = function (this: string, start?: number, end?: number): string {
      const result = textSlice.call(this, start, end);
      seen(result.length);
      return result;
    };
    texts.substring = function (this: string, start: number, end?: number): string {
      const result = substring.call(this, start, end);
      seen(result.length);
      return result;
    };
    try {
      return { result: ask(), uncharged };
    } finally {
      counting = false;
      Object.assign(arrays, { slice, join, map, concat });
      Object.assign(texts, { slice: textSlice, substring });
    }
  };
  for (const query of ["read", "place"] as const)
    for (const mode of MODES) {
      const rows = [16, 32, 64].map((depth) => {
        const source = mutual(depth);
        const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
        assert.ok(request !== null);
        return inMode(mode, () => {
          const answers = analyseCore(request);
          const node = answers.graph.nodes.find(
            (each) =>
              each.expression?.kind === "identifier" &&
              each.expression.name === (query === "read" ? "read" : "a"),
          );
          const place = node === undefined ? null : answers.at(node)?.place;
          assert.ok(node !== undefined && place !== null && place !== undefined);
          const { result, uncharged } = observed(() =>
            withNameRecords(() =>
              query === "read"
                ? [...answers.properties(node).keys()]
                : [
                    ...answers.placeProperties(
                      place.id,
                      Array.from({ length: depth }, () => propertyStep("q")),
                    ),
                  ],
            ),
          );
          return { depth, names: result.result.sort(), records: result.records, uncharged };
        });
      });
      for (const { depth, names, records, uncharged } of rows) {
        const label = `${query} ${depth} ${JSON.stringify(mode)} ${uncharged} ${JSON.stringify(records)}`;
        assert.deepEqual(names, ["left", "q"], label);
        assert.ok(records.prefixes <= records.tasks, label);
        assert.ok(uncharged <= 2 * records.tasks, label);
        // (the pump check walks its own place's earlier tasks only, within the tasks; walking every earlier task made it
        // quadratic, 474, 1,714 and 6,498 by the read; the path's index stays within 2 + ⌈log₂ D⌉ entries per task)
        assert.ok(records.ancestors <= records.tasks, label);
        assert.ok(
          records.entries <= records.tasks * (2 + Math.ceil(Math.log2(records.chain))),
          label,
        );
      }
      for (const [low, high] of [
        [rows[0]!, rows[1]!],
        [rows[1]!, rows[2]!],
      ] as const)
        assert.ok(
          high.uncharged / low.uncharged <= high.records.checks / low.records.checks,
          `${query} ${low.depth} → ${high.depth} ${JSON.stringify(mode)}`,
        );
    }
});

test("the first property `${...}` shows of a copy comes from its source's literal, in every mode (#1493)", () => {
  const source = 'let a = {x: 1, y: 2}\nlet b = a\nb.y = 3\nsay "${b}"\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null);
  for (const mode of MODES) {
    const messages = inMode(mode, () => {
      const answers = analyseCore(request);
      const text = messageSource([source], answers.diagnostics);
      return answers.diagnostics.map((diagnostic) => coreMessage(diagnostic, text));
    });
    assert.deepEqual(
      messages,
      ["'${b}' cannot show an object. Show one of its properties instead, as in '${b.x}'."],
      JSON.stringify(mode),
    );
  }
});
