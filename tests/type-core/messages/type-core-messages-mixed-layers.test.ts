// A mixed element's type names its set and dict layers as sets and dicts.

import assert from "node:assert/strict";
import test from "node:test";
import { analyseCore } from "../../../src/type-inference/core/answers.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import { reported, main } from "../../helpers/type-core/type-core-messages-setup.js";

/**
 * #1825: a mixed error names each set layer of its elements' type as a set, as the current checker's first sentence
 * does: directly, inside a dict and around one, inside a list, in a join, below a property, a written copy and a
 * nullable one, and each side by its own values where a set and a list meet (in both orders; the second error there is
 * #2007's count difference, which this test does not pin). A nested list and a dict of lists stay as they were. In
 * four modes.
 */
test("a mixed element's type names its set layers as sets (#1825)", () => {
  const ONE = "A list holds one type. Use values of one type in it.";
  const cases: readonly (readonly [source: string, message: string])[] = [
    [
      'let xs=[set[[1]],set[["x"]]]\nexit\n',
      `This list mixes a set (integer[] set) and a set (string[] set). ${ONE}`,
    ],
    [
      'let xs=[dict {k:set[[1]]},dict {k:set[["x"]]}]\nexit\n',
      `This list mixes a dict (integer[] set dict) and a dict (string[] set dict). ${ONE}`,
    ],
    [
      'let xs=[set[dict {k:1}],set[dict {k:"x"}]]\nexit\n',
      `This list mixes a set (integer dict set) and a set (string dict set). ${ONE}`,
    ],
    [
      'let xs=[[set[1]],[set["x"]]]\nexit\n',
      `This list mixes a list (integer set[]) and a list (string set[]). ${ONE}`,
    ],
    [
      'let xs=[set[[1]]]+[set[["x"]]]\nexit\n',
      "'+' would mix a set (integer[] set) and a set (string[] set). A list holds one type. Use values of one type in both lists.",
    ],
    [
      'let xs=[set[1]]+[set["x"]]\nexit\n',
      "'+' would mix a set (integer set) and a set (string set). A list holds one type. Use values of one type in both lists.",
    ],
    [
      'let xs=[{f:set[[1]]},{f:set[["x"]]}]\nexit\n',
      "This list mixes objects whose property 'f' holds a set (integer[] set) in one and a set (string[] set) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let a:integer[] set=set[[1]]\nlet b:string[] set=set[["x"]]\nlet xs=[a,b]\nexit\n',
      `This list mixes a set (integer[] set) and a set (string[] set). ${ONE}`,
    ],
    [
      'let n:integer[]? set=set[[1]]\nlet xs=[n,set[["x"]]]\nexit\n',
      `This list mixes a set (integer[]? set) and a set (string[] set). ${ONE}`,
    ],
    [
      'let xs=[set[[1]],[["x"]]]\nexit\n',
      `This list mixes a set (integer[] set) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[[["x"]],set[[1]]]\nexit\n',
      `This list mixes a list (string[][]) and a set (integer[] set). ${ONE}`,
    ],
    // (an `otherwise` names the set its operand gives, its fallback only where the operand may be null)
    [
      'let a:integer[][]=[[1]]\nlet xs=[(a otherwise set[[2]]),set[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a set (string[] set). ${ONE}`,
    ],
    [
      'let a:integer[] set=set[[1]]\nlet xs=[(a otherwise [[2]]),[["x"]]]\nexit\n',
      `This list mixes a set (integer[] set) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[] set=set[[1]]\nlet xs=[{p:(a otherwise [[2]])},{p:set[["x"]]}]\nexit\n',
      "This list mixes objects whose property 'p' holds a set (integer[] set) in one and a set (string[] set) in " +
        "another. A list holds one type. Give 'p' one type in every element.",
    ],
    // (controls: a nested list and a dict of lists)
    [
      'let xs=[[[1]],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[dict {k:[1]},dict {k:["x"]}]\nexit\n',
      `This list mixes a dict (integer[] dict) and a dict (string[] dict). ${ONE}`,
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.code === "TSV044" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
      // (a set's `member` is the sentence's word alone: never a step of the rule's path, which rejects and checks)
      const request = coreRequest(main(source));
      assert.ok(request !== null);
      const paths = inMode(mode, () => analyseCore(request).diagnostics).flatMap((each) =>
        "rule" in each && each.rule.rule === "mixed" ? [each.rule.path] : [],
      );
      assert.ok(
        paths.length > 0 && paths.every((path) => !path.includes("member")),
        `${JSON.stringify(mode)} ${source}: ${JSON.stringify(paths)}`,
      );
    }
});

/**
 * #1825: a growing join's every sentence names its set layers as sets: the set walk's answers are kept apart from the
 * dict walk's, which a later join over the same operands would otherwise read (Codex r1 on #2017). Every TSV044's
 * description is checked; their count is not pinned (the checker reports the first join only). In four modes.
 */
test("a growing join names its set layers as sets in every sentence (#1825)", () => {
  for (const [source, sides] of [
    [
      'let a=[set[1]]\nlet b=[set["x"]]\nlet xs=a+b+b\nexit\n',
      "a set (integer set) and a set (string set)",
    ],
    [
      'let a=[set[[1]]]\nlet b=[set[["x"]]]\nlet xs=a+b+b\nexit\n',
      "a set (integer[] set) and a set (string[] set)",
    ],
  ] as const)
    for (const mode of MODES) {
      const sentences = inMode(mode, () => reported(main(source)))
        .filter((each) => each.code === "TSV044")
        .map((each) => each.message.split(". ")[0]!);
      assert.ok(sentences.length > 0, `${JSON.stringify(mode)} ${source}`);
      for (const sentence of sentences)
        assert.equal(sentence, `'+' would mix ${sides}`, `${JSON.stringify(mode)} ${source}`);
    }
});

/**
 * #1762: a mixed error names a dict layer of its elements' type as a dict, as the current checker's first sentence does:
 * a written copy's (one that may be null too), a literal's, below a list, below a property, two deep, and a join's;
 * each side by its own values where a list and a dict meet. In four modes.
 */
test("a mixed element's type names its dict layers as dicts (#1762)", () => {
  const ONE = "A list holds one type. Use values of one type in it.";
  const cases: readonly (readonly [source: string, message: string])[] = [
    [
      'let a:integer?[] dict=dict {}\nlet xs=[a,dict {k: ["x"]}]\nexit\n',
      `This list mixes a dict (integer?[] dict) and a dict (string[] dict). ${ONE}`,
    ],
    // (a written copy that may be null: a dict still)
    [
      'let a:integer[] dict?=dict {}\nlet xs=[a,dict {k: ["x"]}]\nexit\n',
      `This list mixes a dict (integer[] dict) and a dict (string[] dict). ${ONE}`,
    ],
    // (an `otherwise` whose dict fallback never runs is its operand, a list, both orders; Codex r5 on #1814)
    [
      'let xs=[([[1]] otherwise dict {k:[2]}),[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[[["x"]],([[1]] otherwise dict {k:[2]})]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    // (nor an operand proved null: the fallback is the value; Codex r6 on #1814)
    [
      'let a:integer[] dict?=null\nlet xs=[(a otherwise [[1]]),[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[] dict?=null\nlet xs=[[["x"]],(a otherwise [[1]])]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    // (nor below its own level: the dict a proved-null operand's written type has deeper is not followed either, both
    // orders, below a property, through a join; Codex r7 on #1814)
    [
      'let a:integer dict[]?=null\nlet xs=[(a otherwise [[1]]),[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer dict[]?=null\nlet xs=[[["x"]],(a otherwise [[1]])]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    [
      'let a:integer[] dict dict?=null\nlet xs=[{f:(a otherwise [[[1]]])},{f:[[["x"]]]}]\nexit\n',
      "This list mixes objects whose property 'f' holds a list (integer[][][]) in one and a list (string[][][]) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let a:integer[] dict dict?=null\nlet xs=[(a otherwise [[[1]]])]+[[[["x"]]]]\nexit\n',
      "'+' would mix a list (integer[][][]) and a list (string[][][]). A list holds one type. To allow both, declare " +
        "the list as 'let xs: (integer | string)[][][][] =[(a otherwise [[[1]]])]+[[[[\"x\"]]]]'.",
    ],
    // (#1838, a known difference, the lead's ruling (A): an inferred copy of an `otherwise` keeps the dict its operand,
    // proved null, cannot give, as its items keep a never-run fallback's null; the current checker names a list. The
    // row turns with #1838's repair at admission)
    [
      'let a:integer[] dict?=dict {k:[1]}\na=null\nlet copy=(a otherwise [[1]])\nlet xs=[copy,[["x"]]]\nexit\n',
      `This list mixes a dict (integer[] dict) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[dict {k: [1]},dict {k: ["x"]}]\nexit\n',
      `This list mixes a dict (integer[] dict) and a dict (string[] dict). ${ONE}`,
    ],
    [
      'let a:integer[] dict=dict {}\nlet xs=[[a],[dict {k: ["x"]}]]\nexit\n',
      `This list mixes a list (integer[] dict[]) and a list (string[] dict[]). ${ONE}`,
    ],
    [
      'let xs=[dict {k: dict {j: [1]}},dict {k: dict {j: ["x"]}}]\nexit\n',
      `This list mixes a dict (integer[] dict dict) and a dict (string[] dict dict). ${ONE}`,
    ],
    [
      'let xs=[{f: dict {k: [1]}},{f: dict {k: ["x"]}}]\nexit\n',
      "This list mixes objects whose property 'f' holds a dict (integer[] dict) in one and a dict (string[] dict) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    // (a list and a dict at one path: each side by its own values, Codex r1 on #1814)
    [
      'let xs=[[[1]],dict {k:["x"]}]\nexit\n',
      `This list mixes a list (integer[][]) and a dict (string[] dict). ${ONE}`,
    ],
    [
      'let xs=[dict {k:[1]},[["x"]]]\nexit\n',
      `This list mixes a dict (integer[] dict) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[a,dict {k:["x"]}]\nexit\n',
      `This list mixes a list (integer[][]) and a dict (string[] dict). ${ONE}`,
    ],
    [
      'let xs=[{f:[[1]]},{f:dict {k:["x"]}}]\nexit\n',
      "This list mixes objects whose property 'f' holds a list (integer[][]) in one and a dict (string[] dict) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    // (a host-assigned written dict carried through `otherwise`: its written dict, through the carrier, also below a
    // property and through an intermediate copy; Astra r1 on #1814)
    [
      'let a:integer[] dict?=null\na=hostValue\nlet xs=[(a otherwise dict {}),dict {k:["x"]}]\nexit\n',
      `This list mixes a dict (integer[] dict) and a dict (string[] dict). ${ONE}`,
    ],
    [
      'let a:integer[] dict?=null\na=hostValue\nlet xs=[{f:(a otherwise dict {})},{f:dict {k:["x"]}}]\nexit\n',
      "This list mixes objects whose property 'f' holds a dict (integer[] dict) in one and a dict (string[] dict) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let a:integer[] dict?=null\na=hostValue\nlet b=a otherwise dict {}\nlet xs=[b,dict {k:["x"]}]\nexit\n',
      `This list mixes a dict (integer[] dict) and a dict (string[] dict). ${ONE}`,
    ],
    [
      'let a:integer[] dict?=null\na=hostValue\nlet xs=[a otherwise dict {k:[1]}]+[dict {k:["x"]}]\nexit\n',
      "'+' would mix a dict (integer[] dict) and a dict (string[] dict). A list holds one type. Use values of one " +
        "type in both lists.",
    ],
    // (a host-assigned written dict through a default, its own read: a `load`'s, on either side and below a property,
    // and a `get`'s; Codex r8 on #1814)
    [
      'let a:integer[] dict=dict {k:[1]}\na=hostValue\nlet xs=[load("key",default:a)]+[dict {k:["x"]}]\nexit\n',
      "'+' would mix a dict (integer[] dict) and a dict (string[] dict). A list holds one type. Use values of one " +
        "type in both lists.",
    ],
    [
      'let a:integer[] dict=dict {k:[1]}\na=hostValue\nlet xs=[dict {k:["x"]}]+[load("key",default:a)]\nexit\n',
      "'+' would mix a dict (string[] dict) and a dict (integer[] dict). A list holds one type. Use values of one " +
        "type in both lists.",
    ],
    [
      'let a:integer[] dict=dict {k:[1]}\na=hostValue\nlet xs=[{f:load("key",default:a)}]+[{f:dict {k:["x"]}}]\nexit\n',
      "'+' would mix objects whose property 'f' holds a dict (integer[] dict) in one and a dict (string[] dict) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let a:integer[] dict=dict {k:[1]}\na=hostValue\nlet xs=[[].get(0,default:a)]+[dict {k:["x"]}]\nexit\n',
      "'+' would mix a dict (integer[] dict) and a dict (string[] dict). A list holds one type. Use values of one " +
        "type in both lists.",
    ],
    // (a list of dicts at the leaf: a list, as before)
    [
      'let xs=[[dict {k: 1}],[dict {k: "x"}]]\nexit\n',
      `This list mixes a list (integer dict[]) and a list (string dict[]). ${ONE}`,
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.code === "TSV044" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
  // (a dict copy that may hold null there: a dict; the element's own null is #1753's, so only the type's text)
  for (const mode of MODES) {
    const [mixed] = inMode(mode, () =>
      reported(
        main('let a:integer[] dict?=dict {}\na=hostValue\nlet xs=[a,dict {k: ["x"]}]\nexit\n'),
      ),
    ).filter((each) => each.code === "TSV044");
    assert.match(
      mixed?.message ?? "",
      /^This list mixes a dict \(integer\[\] dict\)/u,
      JSON.stringify(mode),
    );
  }
  // (a join's, its fix as the join's)
  for (const mode of MODES) {
    const [mixed] = inMode(mode, () =>
      reported(main('let xs=[dict {k: [1]}]+[dict {k: ["x"]}]\nexit\n')),
    ).filter((each) => each.code === "TSV044");
    assert.match(
      mixed?.message ?? "",
      /^'\+' would mix a dict \(integer\[\] dict\) and a dict \(string\[\] dict\)\. /u,
      JSON.stringify(mode),
    );
  }
});
