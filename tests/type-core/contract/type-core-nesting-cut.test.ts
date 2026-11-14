import assert from "node:assert/strict";
import test from "node:test";

import { DefinitionIndex } from "../../../src/type-inference/core/definitions.js";
import { NestingIndex } from "../../../src/type-inference/core/indexes/nesting.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import type { PlaceId } from "../../../src/type-inference/graph.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";

/*
 * #2764 (B): the nesting cut. A cycle of copies, arguments, results and list literals that nests a value a level deeper
 * on each turn is cut at a depth the program fixes (`M + G`); a cycle that nests nothing deeper, and a place a written
 * type decides, are never cut.
 */

const PART = `function part(value) {
  if value is list {
    return value
  }
  return [value]
}
`;

/** The nesting index of a program's source, every definition live, and its places by name. */
function indexOf(source: string): { readonly cut: (name: string) => number | null } {
  const request = coreRequest([{ path: "main.tease", source }], []);
  assert.ok(request !== null, source);
  const program = new CoreProgram(request);
  program.index();
  const index = new NestingIndex(program, new DefinitionIndex(program), () => true);
  const place = (name: string): PlaceId => {
    const [owner, part] = name.split(".");
    const found = program.places.find((candidate) => {
      const kind = candidate.kind;
      if (part === "result")
        return (
          kind.kind === "result" &&
          program.graph.functions.find((fn) => fn.id === kind.fn)?.name === owner
        );
      if (part !== undefined) return kind.kind === "parameter" && kind.name === part;
      return kind.kind === "binding" && kind.name === owner;
    });
    assert.ok(found !== undefined, `no place ${name}`);
    return found.id;
  };
  return { cut: (name) => index.cutDepth(place(name)) };
}

test("a chain of calls of a helper that wraps its argument is cut one level below what enters it", () => {
  const { cut } = indexOf(`${PART}let v0 = 1\nlet v1 = part(v0)\nlet v2 = part(v1)\n`);
  // M = 0 (an integer enters), G = 1 (the literal `[value]`): known one level deep
  assert.equal(cut("part.value"), 1);
  assert.equal(cut("part.result"), 1);
  assert.equal(cut("v1"), 1);
  // what enters the cycle and what only reads it are outside it
  assert.equal(cut("v0"), null);
  assert.equal(cut("v2"), null);
});

test("a function that returns its argument in a list, called on its own result, is cut", () => {
  const { cut } = indexOf(
    "function wrap(x) {\n  return [x]\n}\nlet v0 = 1\nlet v1 = wrap(v0)\nlet v2 = wrap(v1)\n",
  );
  assert.equal(cut("wrap.x"), 1);
  assert.equal(cut("wrap.result"), 1);
});

test("a list joined with itself in a list is known below its literal's own levels and one turn", () => {
  // #2763's reproduction: `[[]]` enters with one element level (M = 1), the literal `[a]` adds one (G = 1)
  assert.equal(indexOf("let a = [[]]\na = a + [a]\n").cut("a"), 2);
  // a deeper literal keeps its levels known: M = 3
  assert.equal(indexOf("let a = [[[1]]]\na = a + [a]\n").cut("a"), 4);
});

test("a cycle that nests nothing deeper is never cut", () => {
  // whole copies around a ring: weight 0
  const ring = indexOf("let a = [1]\nlet b = a\na = b\n");
  assert.equal(ring.cut("a"), null);
  assert.equal(ring.cut("b"), null);
  // an element taken out and put back in a list: +1 and -1
  assert.equal(indexOf("let xs = [[1]]\nlet p = xs[0]\nxs = [p]\n").cut("xs"), null);
  // an element taken out of a list it was wrapped in, only: -1
  assert.equal(indexOf("let xs = [[1]]\nlet p = xs[0]\nxs = p\n").cut("xs"), null);
});

test("a place a written type decides takes no route into it, so its cycle is not cut", () => {
  assert.equal(indexOf("let a: list[][] = [[]]\na = a + [a]\n").cut("a"), null);
});
