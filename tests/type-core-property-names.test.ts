import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { withTestAllowance } from "../src/type-inference/core/budget.js";
import { coreMessage, messageSource } from "../src/type-inference/core/messages.js";
import { coreRequest } from "./helpers/type-core-analysis.js";
import { MODES, inMode } from "./helpers/type-core-oracles.js";

/*
 * #1493: a property-name search follows a value's copied sources. A copy fed back into the object it came from
 * (`w = r.z`, with `r` holding copies of `w`) gave the search a key one step longer on every turn, its identity never seen
 * before, so it never ended and its pending keys and paths filled the heap. A key's sources are followed now only where
 * its answer holds an object: its own stores still name their properties first, so data from outside the script keeps a
 * property the script stores into it, and an unknown or stopped answer names its own stores alone.
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
});

test("a key's own stores name their properties whatever its answer, its sources only where it holds an object (#1493)", () => {
  // (data from outside the script keeps a property the script stores into it)
  assert.deepEqual(namesOf("let w=hostValue\nw.extra=1\nexit", "w").names, ["extra"]);
  // (an object beside data from outside: the object's properties)
  assert.deepEqual(namesOf("let w=hostValue\nw={extra:1}\nlet s=w\nexit", "w").names, ["extra"]);
  // (data from outside alone: no property known)
  assert.deepEqual(namesOf("let w=hostValue\nlet s=w\nexit", "w").names, []);
  // (a copy of a copy of an object: its properties, through each copy's source)
  assert.deepEqual(namesOf("let a={x:1}\nlet b=a\nb.y=2\nlet c=b\nexit", "b").names, ["x", "y"]);
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
