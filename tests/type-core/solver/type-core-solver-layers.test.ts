// A layer's summary and a copy's value demand, named by origin and path: solved alike from each entry, asked again in a
// fresh pass by name and packet alone, and keeping a written value's spelling (#1466, #1398, #1857).

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore, solveDemands } from "../../../src/type-inference/core/answers.js";
import { joinParts } from "../../../src/type-inference/core/budget.js";
import { exportNames } from "../../../src/type-inference/core/contract/key-ids.js";
import { keyOf } from "../../../src/type-inference/core/definitions.js";
import { type Item } from "../../../src/type-inference/core/items.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { narrowingPass } from "../../helpers/type-core/type-core-narrowing.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import {
  answer,
  componentDifferences,
  layerRequest,
} from "../../helpers/type-core/type-core-solver-setup.js";

/**
 * #1466 (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-227): a layer's summary is a demand
 * named by its layer's origin and the path (`protoLayer|alias|<place>||<path>`,
 * `protoLayer|projected|<place>|<projection>|<path>` as their texts), never by a number its pass allocated: Astra's B1
 * witness and sibling, and Sol's copy cycles through a list element, of nested copies and below a projected prefix,
 * each a component holding one.
 */
const LAYER_CYCLES: readonly string[] = [
  "let a = {g: hostValue}\nlet b = a\nb.g = a.g\na = b\nrepeat a.g {}\nexit",
  "let a = {g: hostValue}\nlet b = a\nlet c = b\na = c\nb.g = c.g\nc.g = a.g\nrepeat b.g {}\nexit",
  "let a = [{g: hostValue}]\nlet b = a\nb[0].g = a[0].g\na = b\nrepeat a[0].g {}\nexit",
  "let a = {g: {g: hostValue}}\nlet b = a\nlet c = b\nb.g.g = c.g.g\na = c\nrepeat a.g.g {}\nexit",
  "let root = {box: {g: 1}}\nroot.box.g = hostValue\nlet a = root.box\nlet b = a\nb.g = a.g\na = b\nrepeat a.g {}\nexit",
];

test("a layer's summary in a copy cycle is solved alike from each member as the entry and in either order (#1466)", () => {
  // (a cycle whose read one source answers asks it by reference, no summary made: its component is solved
  // alike too; the others' components hold a layer's summary)
  const layered = LAYER_CYCLES.filter((source) => {
    const found = componentDifferences(source, layerRequest(source));
    assert.deepEqual(found.differing, [], source);
    return found.layered > 0;
  });
  assert.ok(layered.length > 0, "a cycle's component holds a layer's summary");
});

/**
 * #1466: every finished layer summary is asked again in a fresh pass from its name and packet alone (`exportNames`,
 * `solveDemands`): its layer found again by its origin through that pass's own stores, after the producing pass met
 * other paths first, so no id of the one pass names anything in the other. A name of no origin kind and an origin
 * without a layer (the host value's place) are rejected, never answered by a guess.
 */
test("every finished layer summary is asked again in a fresh pass by its name and packet alone (#1466)", () => {
  const kinds = new Set<string>();
  const sources = [
    ...LAYER_CYCLES,
    "let d0 = {f: hostValue, g: 1}\nlet l0 = d0\nlet r0 = d0\nl0.g = hostValue\nlet d1 = l0\nd1 = r0\nlet l1 = d1\nlet r1 = d1\nl1.g = hostValue\nlet d2 = l1\nd2 = r1\nrepeat d2.g {}\nexit",
  ];
  for (const source of sources) {
    const request = layerRequest(source);
    const pass = narrowingPass(request);
    // (the producing pass's arena made other paths first)
    pass.contract.pathIdOf(["shifted", "first"]);
    for (const place of pass.program.places)
      if (place.kind.kind === "binding")
        for (const path of [["g"], ["element", "g"], ["g", "g"]])
          pass.solver.run(pass.contract.contractOf(keyOf(place.id, path)));
    for (const { key } of pass.solver.demandWork()) {
      if (!key.startsWith("protoLayer|")) continue;
      kinds.add(key.split("|")[1]!);
      const exported = exportNames(pass.contract, [key])!;
      const packet: unknown = JSON.parse(JSON.stringify(exported.packet));
      assert.equal(
        answer(solveDemands(request, exported.names, packet)[0]!),
        answer(pass.solver.answer(key)!),
        `${source}: ${key}`,
      );
      const [, kind, origin, path] = exported.names[0]!.split("|");
      assert.throws(
        () => solveDemands(request, [joinParts("protoLayer", "copied", origin!, path!)], packet),
        /No layer is written/,
      );
      // (the host value's place: no store makes a layer of it)
      const host = pass.program.places.find((place) => pass.program.isHost(place.id))!.id;
      assert.throws(
        () =>
          solveDemands(request, [joinParts("protoLayer", kind!, `${host}#0`, ".1")], {
            nodes: [[-1, "g"]],
            keys: [
              [host, -1],
              [0, 0],
            ],
          }),
        /No layer comes from/,
      );
    }
  }
  assert.deepEqual([...kinds].sort(), ["alias", "projected"]);
});

/**
 * #1398: a written value read through a layer's summary keeps its spelling: the summary's items carry
 * it, a fresh pass asked by the summary's name and packet alone gives them again with it, and the summary that merges
 * both layers' leaves stands in the direct read's order, in the four modes. Of a written value in both copies' stores,
 * and beside a whole number it spells.
 */
test("a layer's summary of a written value keeps its spelling, asked again from its packet, in the four modes (#1398)", () => {
  const written = "let w: string | integer = fromJson(hostValue)\n";
  const copies = (first: string): string =>
    `${written}let d0 = {f: hostValue, g: w}\nlet l0 = d0\nlet r0 = d0\nl0.g = ${first}\nlet d1 = l0\nd1 = r0\n` +
    "let l1 = d1\nlet r1 = d1\nl1.g = w\nlet d2 = l1\nd2 = r1\nrepeat d2.g {}\nexit";
  const shown = (items: readonly Item[]): string =>
    items
      .map(
        (item) => `${item.tag}${item.spelling === undefined ? "" : `(${item.spelling.join("|")})`}`,
      )
      .join(",");
  for (const source of [copies("w"), copies("1")]) {
    const request = layerRequest(source);
    const read = source.lastIndexOf("d2.g");
    for (const mode of MODES)
      inMode(mode, () => {
        const pass = narrowingPass(request);
        pass.contract.pathIdOf(["shifted", "first"]);
        for (const place of pass.program.places)
          if (place.kind.kind === "binding")
            pass.solver.run(pass.contract.contractOf(keyOf(place.id, ["g"])));
        const summaries: string[] = [];
        for (const { key } of pass.solver.demandWork()) {
          if (!key.startsWith("protoLayer|")) continue;
          const exported = exportNames(pass.contract, [key])!;
          const packet: unknown = JSON.parse(JSON.stringify(exported.packet));
          const again = solveDemands(request, exported.names, packet)[0]!;
          summaries.push(shown(pass.solver.answer(key)!));
          assert.equal(shown(again), summaries.at(-1), `${JSON.stringify(mode)} ${key}`);
        }
        const answers = analyseCore(request);
        const node = answers.graph.nodes.find(
          (found) => found.span?.start.offset === read && found.span.end.offset === read + 4,
        )!;
        const direct = answers.at(node)!.items.map((item) => item.tag);
        assert.deepEqual(direct, ["string", "integer"], JSON.stringify(mode));
        assert.ok(
          summaries.includes("string(string|integer),integer(string|integer)"),
          `${JSON.stringify(mode)}: ${summaries.join(" ; ")}`,
        );
      });
  }
});

test("a copy's value demand below its root is asked again in a fresh pass from its name and packet alone (#1857)", () => {
  // (a copy carries its path as the arena's steps, so its demand is named by the path's id: `op|<result>|.<id>`)
  for (const source of [
    'let a = [1]\nlet b = ["bad"]\nlet xs = [a.take(1), b.take(1)]\nexit',
    "let xs = [{p: 1}]\nlet ys = xs.take(1)\nlet n: integer = ys.p\nexit",
  ]) {
    const request = coreRequest([{ path: "main.tease", source }])!;
    const pass = narrowingPass(request);
    const copies = [...pass.program.opOf].filter(
      ([, c]) => c.kind === "operation" && c.contract.family === "method",
    );
    assert.ok(copies.length > 0, source);
    for (const [result] of copies)
      pass.solver.run(pass.values.valueItems(result, null, ["element"]));
    const keys = pass.solver
      .demandWork()
      .map((demand) => demand.key)
      .filter((key) => key.startsWith("op|") && key.split("|")[2] !== "");
    assert.ok(keys.length > 0, source);
    for (const key of keys) {
      const exported = exportNames(pass.contract, [key]);
      const again = solveDemands(
        request,
        exported?.names ?? [key],
        exported === null ? undefined : JSON.parse(JSON.stringify(exported.packet)),
      )[0]!;
      assert.deepEqual(
        again.map((item) => item.tag),
        pass.solver.answer(key)!.map((item) => item.tag),
        `${source}: ${key}`,
      );
    }
  }
});
