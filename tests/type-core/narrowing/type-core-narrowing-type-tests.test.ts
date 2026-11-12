// A type test in the narrowing index: its spelling read once, its kinds and its classes (#1398); a program without a
// test (#1251).

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { annotationTags } from "../../../src/type-inference/core/contract/terms.js";
import { itemsSignature } from "../../../src/type-inference/core/items.js";
import { siteKey } from "../../../src/type-inference/core/program.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { narrowingAt, narrowingPass, nodeAt } from "../../helpers/type-core/type-core-narrowing.js";
import { readFixture } from "../../helpers/type-core/type-core-fixture.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import { pass, read } from "../../helpers/type-core/type-core-narrowing-setup.js";

/**
 * #1398 (Codex r6 on #1558): a type test's spelling is read once per test and pass, whatever the
 * number of reads it narrows: k stored reads of host data under a test of k alternating members carry one spelling, one
 * array, `[string, integer]`, in the four modes, so the type's walks grow with the test alone.
 */
test("a type test's spelling is read once, for every read it narrows (#1398)", () => {
  for (const k of [8, 16, 32]) {
    const members = Array.from({ length: k }, (_, index) =>
      index % 2 === 0 ? "string" : "integer",
    );
    const stores = Array.from({ length: k }, (_, index) => `  let y${index} = x`);
    const source = `let x = hostValue\nif x is ${members.join(" | ")} {\n${stores.join("\n")}\n}\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, `${k}`);
    const reads = stores.map((line) => source.indexOf(line) + line.length - 1);
    for (const mode of MODES)
      inMode(mode, () => {
        const answers = analyseCore(request);
        const spellings = new Set(
          answers.graph.nodes
            .filter((node) => node.span !== null && reads.includes(node.span.start.offset))
            .flatMap((node) => answers.at(node)?.items ?? [])
            .map((item) => item.spelling),
        );
        assert.equal(spellings.size, 1, `${k} ${JSON.stringify(mode)}`);
        assert.deepEqual([...spellings][0], ["string", "integer"], `${k} ${JSON.stringify(mode)}`);
      });
  }
});

/**
 * #1398 (Codex r7 on #1558): two type tests of one kinds in two written orders narrow host data to two
 * answers, `[string, integer]` and `[integer, string]`, and the value side tells them apart in every identity it reads:
 * their items' signatures and their exact read classes, which take the test's spelling (`Values.narrowingMark`).
 */
test("two type tests of one kinds in two written orders give two read classes (#1398)", () => {
  const source =
    "let x = hostValue\nif x is string | integer | string { let first = x }\n" +
    "if x is integer | string | integer | string { let second = x }\nexit\n";
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
  assert.ok(request !== null);
  const pass = narrowingPass(request);
  const reads = ["first", "second"].map((name) => {
    const node = nodeAt(pass, source.indexOf(`let ${name} = x`) + `let ${name} = `.length);
    const value = pass.program.placeBySite.get(
      siteKey({ file: node.file, start: node.span!.start.offset, end: node.span!.end.offset }),
    )!;
    const items = pass.solver.run(pass.values.valueItems(value, node, []));
    return {
      tags: items.map((item) => item.tag),
      signature: itemsSignature(items, pass.program.scope),
      read: pass.contract.readClass(value, true),
    };
  });
  assert.deepEqual(
    reads.map((read) => read.tags),
    [
      ["string", "integer"],
      ["integer", "string"],
    ],
  );
  assert.notEqual(reads[0]!.signature, reads[1]!.signature);
  assert.notEqual(reads[0]!.read, reads[1]!.read);
});

/**
 * #1398 (Codex r8 on #1558): the narrowing a read takes is part of every exact value class it is
 * given, whichever way the class is joined: two tests of one kinds in two written orders, of a host read, a host
 * property, a host element and their local controls, give the two stored reads two value classes and two bound
 * classes, in the four modes.
 */
test("two type tests of one kinds in two written orders give two value classes, a host read's too (#1398)", () => {
  for (const tested of ["hostValue", "hostValue.x", "hostValue[0]", "x", "x.n", "x[0]"]) {
    const local = tested.startsWith("x") ? "let x = hostValue\n" : "";
    const source =
      `${local}if ${tested} is string | integer | string { let first = ${tested} }\n` +
      `if ${tested} is integer | string | integer | string { let second = ${tested} }\nexit\n`;
    const request = coreRequest([{ path: "main.tease", source }], ["hostValue"]);
    assert.ok(request !== null, tested);
    for (const mode of MODES)
      inMode(mode, () => {
        const pass = narrowingPass(request);
        const reads = ["first", "second"].map((name) => {
          const node = nodeAt(pass, source.indexOf(`let ${name} = `) + `let ${name} = `.length);
          const value = pass.program.placeBySite.get(
            siteKey({
              file: node.file,
              start: node.span!.start.offset,
              end: node.span!.end.offset,
            }),
          )!;
          return {
            tags: pass.solver.run(pass.values.valueItems(value, node, [])).map((item) => item.tag),
            cls: pass.contract.classOf(value, true),
            bound: pass.contract.boundClass(value, true).cls,
          };
        });
        const at = `${tested} ${JSON.stringify(mode)}`;
        assert.notDeepEqual(reads[0]!.tags, reads[1]!.tags, at);
        assert.notEqual(reads[0]!.cls, reads[1]!.cls, at);
        assert.notEqual(reads[0]!.bound, reads[1]!.bound, at);
      });
  }
});

/**
 * #1398 (Codex r7 on #1558): a type's written kinds are read by one walk, each node and each kind it
 * gives once: at depths 32, 64 and 128 of unions nested to the right and to the left, and of optionals, the walk of the
 * test's type as its narrowing holds it gives one kind per name the type writes, in their written order.
 */
test("a type test's written kinds are one kind per name, in written order, however deeply it nests (#1398)", () => {
  const alternate = (at: number): string => (at % 2 === 0 ? "integer" : "string");
  for (const shape of ["right", "left", "optional"])
    for (const k of [32, 64, 128]) {
      let type = "string";
      const kinds: string[] = ["string"];
      for (let at = 0; at < k; at += 1)
        if (shape === "right") {
          type = `${alternate(at)} | (${type})`;
          kinds.unshift(alternate(at));
        } else if (shape === "left") {
          type = `(${type}) | ${alternate(at)}`;
          kinds.push(alternate(at));
        } else {
          type = `${type} ?`;
          kinds.push("null");
        }
      const source = `let x = hostValue\nif x is ${type} {\n  let y = x\n}\nexit\n`;
      const analysed = pass(source);
      const form = narrowingAt(analysed.pass, read(analysed, "x\n}", 0))?.g.form;
      assert.ok(form?.kind === "is" && form.test !== undefined, `${shape} ${k}`);
      assert.deepEqual(annotationTags(form.test), kinds, `${shape} ${k}`);
    }
});

/*
 * #1251: a program without a condition, a `switch` or an `and`/`or` builds no narrowing index (`GuardIndex.testless`,
 * read by `Values.#narrowingOf`): those are the only places the index makes a narrowing definition, so it would list
 * none. Over the fixture, every such program's index is empty.
 */
test("a program without a test lists no narrowing (#1251)", () => {
  let testless = 0;
  for (const record of readFixture()) {
    const request = coreRequest(record.files);
    if (request === null) continue;
    const { guards } = narrowingPass(request);
    if (!guards.testless) continue;
    testless += 1;
    assert.deepEqual(guards.narrowing.all, [], record.name);
  }
  assert.ok(testless > 0, "the fixture has programs without a test");
});

/**
 * #1251, Astra r1's witness: a root tested only in an `or`'s right operand keeps its narrowing for a stored read after
 * the early exit (an integer), with no warning; the test proves a kind, never an ingress, so `b`'s external data keeps
 * its boundary check where it enters (C9, #1073 PR 2), as the fixture's `n1-unknown-positive` records.
 */
test("a root tested in an or's right operand keeps its narrowing for a stored read (#1251)", () => {
  const source = [
    "let a = hostValue",
    "let b = hostOther",
    "if a is not integer or b is not integer { exit }",
    "let n = b + 1",
    "say n",
    "exit",
  ].join("\n");
  const request = coreRequest([{ path: "main.tease", source }], ["hostValue", "hostOther"])!;
  for (const mode of MODES) {
    const answers = inMode(mode, () => analyseCore(request));
    assert.deepEqual(answers.diagnostics, [], JSON.stringify(mode));
    assert.deepEqual(
      answers.checks.map((c) => [c.kind, c.target, c.boundary, c.site.start]),
      [["copy-type", "b", true, source.indexOf("hostOther")]],
      JSON.stringify(mode),
    );
  }
});

test("a program without a test does not pay for the narrowing index; the same with a test does (#1251)", () => {
  // (k copies in a chain and a read, with or without one condition testing another variable)
  const chain = (k: number, test: boolean): string =>
    [
      "let v0 = 1",
      ...Array.from({ length: k }, (_, i) => `let v${i + 1} = v${i} + 1`),
      `say v${k}`,
      ...(test ? ["let t = hostValue", "if t is integer { say 1 }"] : []),
      "exit",
    ].join("\n");
  const request = (source: string) => coreRequest([{ path: "main.tease", source }])!;
  const total = (source: string): number => analyseCore(request(source)).budget.total;
  for (const k of [16, 64]) {
    // the index's build for the program without the test, measured apart: its first ask, charged then
    const { guards, program } = narrowingPass(request(chain(k, false)));
    assert.ok(guards.testless, `k = ${k}: no test`);
    const before = program.work.total;
    assert.deepEqual(guards.narrowing.all, [], `k = ${k}: no narrowing definition`);
    const index = program.work.total - before;
    assert.ok(index > 0, `k = ${k}: the index's build is charged`);
    // the program with the condition pays that build on top of its three more statements
    const [without, withTest] = [total(chain(k, false)), total(chain(k, true))];
    assert.ok(
      withTest - without >= index,
      `k = ${k}: ${without} without the test, ${withTest} with it, index ${index}`,
    );
  }
});
