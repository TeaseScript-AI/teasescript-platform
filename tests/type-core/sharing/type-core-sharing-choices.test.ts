// A list's choices of one mixed class: one node per order, class work independent of their size, and walks, checks and
// copies that move no stop (#1573, #1703).

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../../../src/type-inference/core/answers.js";
import { Contract } from "../../../src/type-inference/core/contract.js";
import { ingressLeaves, type Item } from "../../../src/type-inference/core/items.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { withoutSharing } from "../../../src/type-inference/core/sharing.js";
import type { PlaceId } from "../../../src/type-inference/graph.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { inOrder, MODES, publication, stopSet } from "../../helpers/type-core-oracles.js";
import { GLOBALS } from "../../helpers/type-core/type-core-sharing-setup.js";

/** #1573's programs: `n` bindings of choices of `k` reads of one host global's properties, read in `lists`. */
function choicesInLists(n: number, k: number, lists: readonly (readonly number[])[]): string {
  const options = Array.from({ length: k }, (_, r) => `{text: "${r}", value: hostValue.p${r}}`);
  return [
    ...Array.from({ length: n }, (_, j) => `let p${j} = askChoice ${options.join(", ")}`),
    ...lists.map(
      (list, i) =>
        `let xs${i} = [${list.map((j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
    ),
    "exit\n",
  ].join("\n");
}

/**
 * #1573: the choices of four bindings are one class mixed by their leaves, so a list's contract reads one member (the
 * first binding) and names the others' leaves (`othersLeaves`) through one node per sequence of other members as the
 * list holds them, each member's leaves its own: lists of all four with the other three in three orders, one of them
 * twice, and of three, whose other members are distinct sets of two (one of them with another read member). In both
 * orders with the sharing on, the two lists of one order name one node, the lists name no more nodes than with the
 * sharing off, and each list's leaves are its members', as with the sharing off.
 */
test("a list's other members of one mixed class name one node per order, each its own leaves, in both orders (#1573)", () => {
  const lists = [
    [0, 1, 2, 3],
    [0, 3, 2, 1],
    [3, 1, 0, 2],
    [0, 1, 2, 3],
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 1],
    [1, 2, 3],
  ];
  const source = choicesInLists(4, 2, lists);
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, "the program parses and resolves");
  const places = new CoreProgram(request).places;
  const external = (answers: Answers): Item[] =>
    lists.map((_, i) => {
      const id = places.find(({ kind }) => kind.kind === "binding" && kind.name === `xs${i}`)!.id;
      const items = answers.place(id, ["element"]).contract.kinds;
      assert.deepEqual(
        items.map((item) => item.tag),
        ["unknown"],
        `xs${i}`,
      );
      return items[0]!;
    });
  const leaves = (items: readonly Item[]): string[] =>
    items.map((item) =>
      ingressLeaves(item.ingress!)
        .map(({ start }) => start)
        .join(","),
    );
  // (each member's options read `hostValue` at these offsets, on its own line)
  const lines = source.split("\n");
  const members = [0, 1, 2, 3].map((j) => {
    const at = lines.slice(0, j).reduce((sum, line) => sum + line.length + 1, 0);
    return [...lines[j]!.matchAll(/hostValue/g)].map((match) => at + match.index);
  });
  const expected = lists.map((list) =>
    list
      .flatMap((j) => members[j]!)
      .sort((a, b) => a - b)
      .join(","),
  );
  for (const reversed of [false, true]) {
    const shared: Item[] = inOrder(reversed, () => external(analyseCore(request)));
    const unshared: Item[] = inOrder(reversed, () =>
      withoutSharing(() => external(analyseCore(request))),
    );
    assert.deepEqual(leaves(shared), expected, `reversed: ${reversed}`);
    assert.deepEqual(leaves(unshared), expected, `reversed: ${reversed}, unshared`);
    const nodes = shared.map((item) => item.ingress!);
    assert.ok(nodes[3] === nodes[0], `reversed: ${reversed}: one order's node`);
    assert.ok(
      new Set(nodes).size <= new Set(unshared.map((item) => item.ingress!)).size,
      `reversed: ${reversed}: no more nodes than with the sharing off`,
    );
  }
});

/**
 * #1573: a further list of the same bindings reads their choices' leaves from one walk of each choice's options, never
 * walking them again (`leafRoles`), so the class work a list adds is the same whatever the choices' size: the steps of
 * every class walk (`classMixed`'s calls) and the contract's steps (`invSteps`) that one more list of two of them adds,
 * at 2 and at 8 options.
 */
test("a further list of choices of one class adds class work independent of the choices' size (#1573)", () => {
  let calls = 0;
  const original = Contract.prototype.classMixed;
  Contract.prototype.classMixed = function (this: Contract, value: PlaceId, exact: boolean) {
    calls += 1;
    return original.call(this, value, exact);
  };
  try {
    const added = (k: number): readonly [number, number] => {
      const [two, three] = [2, 3].map((n) => {
        const source = choicesInLists(
          2,
          k,
          Array.from({ length: n }, () => [0, 1]),
        );
        const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
        assert.ok(request !== null, source);
        calls = 0;
        const steps = analyseCore(request).budget.counts.get("invSteps") ?? 0;
        return [calls, steps] as const;
      });
      return [three![0] - two![0], three![1] - two![1]];
    };
    assert.deepEqual(added(8), added(2));
  } finally {
    Contract.prototype.classMixed = original;
  }
});

/**
 * #1573 (Codex r1's B1 on #1628): a reader of a choice walked once (`leafRoles`) or of a read choice checked once
 * (`heldLeaves`) counts to its demand what the walk or the check charged (`WorkLedger.repeat`), as when each list made
 * its own, so no list's decision stops elsewhere than it did: two classes of choices (of `hostValue`'s and of
 * `hostOther`'s properties) read in four lists of all four bindings, and two choices of 17 properties read in three
 * lists. At the test demand allowance 256, in the four modes, the stops and exhaustion are those of each list making
 * its own (where a second decision stopping in a second pass ends the analysis), a regression oracle of
 * these sources.
 */
test("a choice's walk or check shared by its lists moves no decision's stop at 256, in the four modes (#1573)", () => {
  const choice = (host: string, k: number): string =>
    `askChoice ${Array.from({ length: k }, (_, r) => `{text: "${r}", value: ${host}.p${r}}`).join(", ")}`;
  const program = (hosts: readonly string[], k: number, lists: number): string =>
    [
      ...hosts.map((host, j) => `let p${j} = ${choice(host, k)}`),
      ...Array.from(
        { length: lists },
        (_, i) =>
          `let xs${i} = [${hosts.map((_, j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
      ),
      "exit\n",
    ].join("\n");
  const at = (pass: number, label: string, path: string, ordinal: number) =>
    [pass, label, path, ordinal] as const;
  const element = (pass: number, list: number, ordinal: number) =>
    at(pass, `xs${list}`, "element", ordinal);
  const cases = [
    {
      // (the walk: one other member of each class per list)
      source: program(["hostValue", "hostOther", "hostValue", "hostOther"], 2, 4),
      modes: [
        [[element(1, 0, 6), element(1, 1, 9), element(1, 2, 12), element(1, 3, 15)], null],
        [[element(1, 0, 6), element(2, 1, 8)], "work"],
        [[element(1, 3, 9), element(2, 2, 11)], "work"],
        [[], null],
      ],
    },
    {
      // (the check: the read choice's answer, 33 nodes, checked for each list)
      source: program(["hostValue", "hostValue"], 17, 3),
      modes: [
        [
          [
            at(1, "p0", "", 1),
            at(1, "p1", "", 2),
            element(1, 0, 4),
            element(1, 1, 7),
            element(2, 2, 6),
          ],
          "work",
        ],
        [[at(1, "p0", "", 1), element(1, 0, 4), at(2, "p1", "", 1)], "work"],
        [[element(1, 2, 21), element(1, 1, 24), element(1, 0, 27), at(2, "p1", "", 26)], "work"],
        [[element(1, 2, 21), element(2, 1, 23)], "work"],
      ],
    },
  ] as const;
  const modes = [
    { reversed: false, unshared: false },
    { reversed: false, unshared: true },
    { reversed: true, unshared: false },
    { reversed: true, unshared: true },
  ];
  for (const { source, modes: expected } of cases)
    for (const [index, mode] of modes.entries()) {
      const found = stopSet(
        [{ path: "main.tease", source }],
        mode,
        ["hostValue", "hostOther"],
        256,
      );
      const [stops, exhausted] = expected[index]!;
      assert.deepEqual(
        { stops: found?.stops, exhausted: found?.exhausted },
        { stops, exhausted },
        `${JSON.stringify(mode)}: ${source.slice(0, 60)}`,
      );
    }
});

/**
 * #1703: copies of a deep written list (`out = typed`) are one alias class with the sharing on, whose eligibility index
 * holds the pass's demanded paths; built inside the first decision that asked, it stopped that decision at its demand
 * allowance (one `budget` warning per copy instead of one per element, and from depth 18 in the reversed order a
 * stopped analysis). At the first depths that reproduced it, 18 (reversed) and 21 (source order), no decision stops
 * and the four modes publish the same.
 */
test("copies of a deep written list stop no decision and publish the same in the four modes (#1703)", () => {
  for (const depth of [18, 21]) {
    const files = [
      {
        path: "main.tease",
        source: `let typed:integer${"[]".repeat(depth)}=hostValue\nlet out=typed\nout=typed\nout=hostValue\nexit\n`,
      },
    ];
    const [first, ...others] = MODES.map((mode) => publication(files, mode, GLOBALS));
    assert.ok(first !== null && others.every((other) => other === first), `depth ${depth}`);
    for (const mode of MODES)
      assert.deepEqual(
        stopSet(files, mode, GLOBALS, null)?.stops,
        [],
        `depth ${depth}: ${JSON.stringify(mode)}`,
      );
  }
});
