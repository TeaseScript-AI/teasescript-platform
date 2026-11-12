// A mixed element's type keeps the null of each layer, element and join leaf it holds.

import assert from "node:assert/strict";
import test from "node:test";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import { reported, main } from "../../helpers/type-core/type-core-messages-setup.js";

/**
 * #1765: a mixed element's written type keeps each layer between the element and its leaf that may hold `null`, on both
 * sides and through a property, a literal's own null and a written copy's type alike, as the current checker's first
 * sentence does; a layer that may not stays plain. The element itself stays as today (#1753). In four modes.
 */
test("a mixed element's type keeps the null of every layer between the element and its leaf (#1765)", () => {
  const ONE = "A list holds one type. Use values of one type in it.";
  const cases: readonly (readonly [source: string, message: string])[] = [
    [
      'let a:integer[]?[]=[[1],null]\nlet xs=[a,[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[[[1],null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[]?[]=[[1],null]\nlet xs=[a,[["x"],null]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[]?[]). ${ONE}`,
    ],
    [
      'let a:integer?[]?[]=[[1],null]\nlet xs=[{f:a},{f:[["x"]]}]\nexit\n',
      "This list mixes objects whose property 'f' holds a list (integer?[]?[]) in one and a list (string[][]) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let a:integer[]?[]=[[1],null]\nlet ys=[a]+[[["x"]]]\nexit\n',
      "'+' would mix a list (integer[]?[]) and a list (string[][]). A list holds one type. To allow both, declare " +
        "the list as 'let ys: ((integer | string)[]?)[][] =[a]+[[[\"x\"]]]'.",
    ],
    // (a written copy's optional layer with no null among its values: its type's)
    [
      'let a:integer[]?[]=[[1]]\nlet xs=[a,[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (an inline join's other operand brings the null a written copy's type lacks: Codex r1's B1)
    [
      'let a:integer[][]=[[1]]\nlet xs=[a+[[1],null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (a plain copy of a written binding is its declared type, whatever a rejected store put there: Codex r2's B1)
    [
      'let a:integer[][]=[[1],null]\nlet xs=[a,[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\na+=[null]\nlet xs=[a,[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    // (an indirect copy, by index or `otherwise`: its declared type too, Codex r3's B1)
    [
      'let a:integer[][][]=[[[1],null]]\nlet xs=[a[0],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1],null]\nlet xs=[a otherwise [[2]],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    // (a nested join of a copy and a literal: the literal's null, the copy's declared type)
    [
      'let a:integer[][]=[[1],null]\nlet xs=[(a+[[1]])+[null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1],null]\nlet xs=[a+[[2]],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    // (a join below a literal, a property, an index, an `otherwise` or a projection: its operand's null, each form by its own
    // rule; Codex r4's B1)
    [
      'let a:integer[][]=[[1]]\nlet xs=[[a+[[2],null]],[[["x"]]]]\nexit\n',
      `This list mixes a list (integer[]?[][]) and a list (string[][][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[{f:a+[[2],null]},{f:[["x"]]}]\nexit\n',
      "This list mixes objects whose property 'f' holds a list (integer[]?[]) in one and a list (string[][]) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[[a+[[2],null]][0],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[(a+[[2],null]) otherwise [[3]],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[({f:a+[[2],null]}).f,[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (an inferred result, and a read of an unwritten binding: their place's admitted type; Codex r4's B2)
    [
      'let a:integer[]?[]=[[1]]\nlet b:string[][]=[["x"]]\nfunction give { return a }\nlet xs=[give(),b]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let b=[[1],null]\nlet xs=[b,[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (a written copy below a literal: its declared type, whatever a rejected store put there)
    [
      'let a:integer[][]=[[1],null]\nlet xs=[[a],[[["x"]]]]\nexit\n',
      `This list mixes a list (integer[][][]) and a list (string[][][]). ${ONE}`,
    ],
    // (an `otherwise`: its fallback only where its operand may be null, its operand's null never at its own level)
    [
      'let a:integer[][]=[[1]]\nlet xs=[a otherwise [[1],null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[null otherwise [[1],null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[]?=null\nlet xs=[[a otherwise [1]],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    // (a carried value, by what it carries: a `get`'s receiver and default, a dict's values, a method's receiver;
    // Codex r5's B1)
    [
      'let a:integer[][]=[[1]]\nlet xs=[[a+[[2],null]].get(0,default: [[3]]),[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[[].get(0,default: a+[[2],null]),[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[(dict {k:a+[[2],null]}).get("k",default: [[3]]),[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[(dict {k:a+[[2],null]}).values[0],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[(dict {k:a+[[2],null]}).values,[[["x"]]]]\nexit\n',
      `This list mixes a list (integer[]?[][]) and a list (string[][][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[(a+[[2],null]).toSet().toList(),[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[(a+[[2],null]).take(1),[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]=[[1]]\nlet xs=[[a+[[2],null]].removeAt(0),[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (a join's sides by the same rule: an inferred result's admitted type, on either side and through `+=`; Codex r5's
    // B2; `xs=[take(a)]` / `xs += …` is #1813's decision)
    [
      'let a:integer[]?[]=[[1]]\nfunction take(v:integer[]?[]) { return v }\nlet xs=[take(a)]+[[["x"]]]\nexit\n',
      "'+' would mix a list (integer[]?[]) and a list (string[][]). A list holds one type. To allow both, declare " +
        "the list as 'let xs: (integer | string)[][][] =[take(a)]+[[[\"x\"]]]'.",
    ],
    [
      'let a:integer[]?[]=[[1]]\nfunction take(v:integer[]?[]) { return v }\nlet xs=[[["x"]]]+[take(a)]\nexit\n',
      "'+' would mix a list (string[][]) and a list (integer[]?[]). A list holds one type. To allow both, declare " +
        "the list as 'let xs: (string | integer)[][][] =[[[\"x\"]]]+[take(a)]'.",
    ],
    [
      'let a:integer[]?[]=[[1]]\nfunction take(v:integer[]?[]) { return v }\nlet xs=[[["x"]]]\nxs += [take(a)]\nexit\n',
      "'+=' would mix a list (string[][]) and a list (integer[]?[]). A list holds one type. To allow both, declare " +
        "the list with the type '(string | integer)[][][]'.",
    ],
    // (an undecided read: its own items, `null` alone settling no type; Codex r5's B3)
    [
      'let a=null\nlet xs=[a otherwise [[1],null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (at its own level, any value by its own items: a method's result is a new list whatever its receiver's null, and a
    // choice's null is its own; Codex r6's B1 and B2)
    [
      'function use(a:integer[]?) {\n  if a != null {\n    let xs=[[a.take(1)],[["x"]]]\n  }\n}\nuse([1])\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[] dict?=dict{k:[1]}\nif a != null {\n  let xs=[[a.values]]+[[[["x"]]]]\n}\nexit\n',
      "'+' would mix a list (integer[][][]) and a list (string[][][]). A list holds one type. To allow both, declare " +
        "the list as 'let xs: (integer | string)[][][][] =[[a.values]]+[[[[\"x\"]]]]'.",
    ],
    [
      'let xs=[(askChoice null) otherwise [[1],null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (an `otherwise` at a layer: its fallback's null only where its operand may be null, on either side; Codex r3 on
    // #1819)
    [
      'let xs=[[["x"]],[([1] otherwise null)]]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    [
      'let xs=[[([1] otherwise null)],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let n:integer[]?=[1]\nif hostValue == 1 { n=null }\nlet xs=[[["x"]],[(n otherwise null)]]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[]?[]). ${ONE}`,
    ],
    // (an operand narrowed where it is read never runs its fallback: by its assignment, at its own level and below it)
    [
      'let n:integer[]?=[1]\nlet xs=[[["x"]],[(n otherwise null)]]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]?=[[1]]\nlet xs=[a otherwise [[1],null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    // (a nested `otherwise`: its own fallback's null only where its operand may be null too; Codex r10's B1)
    [
      'let n:integer[][]?=[[1]]\nlet xs=[(n otherwise null) otherwise [[1],null],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let n:integer[][]?=[[1]]\nlet xs=[[["x"]],(n otherwise null) otherwise [[1],null]]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    // (a direct `otherwise`'s fallback read narrowed too: `m` holds `[1]` here; a fallback that may be null keeps it,
    // Astra r2's B2)
    [
      'let m:integer[]?=[1]\nlet xs=[[(null otherwise m)],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let m:integer[]?=[1]\nlet xs=[[["x"]],[(null otherwise m)]]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    [
      'let m:integer[]?=[1]\nif hostValue == 1 { m=null }\nlet xs=[[(null otherwise m)],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (a value at a layer's own level as it is read: a written copy narrowed by its value holds none, one host-assigned
    // may, and so may an `otherwise`'s host-assigned operand, #1840; the current checker's)
    [
      'let a:integer[]?=[1]\nlet xs=[[["x"]],[a]]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    [
      'let a:integer[]?=hostValue\nlet xs=[[a],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let a:integer[][]?=null\na=hostValue\nlet xs=[[(a otherwise null)],[[["x"]]]]\nexit\n',
      `This list mixes a list (integer[][]?[]) and a list (string[][][]). ${ONE}`,
    ],
    // (a layer that is a copy's own level, held in an inferred one, as it is read there: `n` holds `[2]`; a copy's term
    // only where it decides the layer from above; Codex r5 on #1819)
    [
      'let n:integer[]?=[2]\nlet h={p:[n]}\nlet xs=[h,{p:[["x"]]}]\nexit\n',
      "This list mixes objects whose property 'p' holds a list (integer[][]) in one and a list (string[][]) in " +
        "another. A list holds one type. Give 'p' one type in every element.",
    ],
    [
      'let n:integer[]?=[2]\nlet h={p:[n]}\nlet xs=[{p:[["x"]]},h]\nexit\n',
      "This list mixes objects whose property 'p' holds a list (string[][]) in one and a list (integer[][]) in " +
        "another. A list holds one type. Give 'p' one type in every element.",
    ],
    // (known differences, #1838: an `otherwise` inside a default, `load`, property or index keeps, in admission's items,
    // the null its never-run fallback brings, so the outer `otherwise` counts its own fallback too; the current checker
    // says `integer[][]`. Admission's to repair, not the message layer's; these turn to `integer[][]` with it)
    ...[
      "[].get(0,default: (n otherwise null))",
      'load("key",default: (n otherwise null))',
      "{p:(n otherwise null)}.p",
      "[(n otherwise null)][0]",
    ].map(
      (inner) =>
        [
          `let n:integer[][]?=[[1]]\nlet xs=[(${inner}) otherwise [[1],null],[["x"]]]\nexit\n`,
          `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
        ] as const,
    ),
    // (a join's operand bound to a literal holding null: its place's undecided type, read by its own items; Codex r7)
    [
      'let a=[null]\nlet xs=[a+[[1]],[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (a join's operand admission rejected brings nothing to the join's result, ADR 0021 1.1: inline, through a method
    // and to a later join; Astra r1's B1)
    [
      'let xs=[([[1]]+[["x"],null]),[["y"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[([[1]]+[["x"],null]).take(1),[["y"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[[[1]]]+[[["x"],null]]+[[["y"]]]\nexit\n',
      "'+' would mix a list (integer[][]) and a list (string[][]). A list holds one type. To allow both, declare " +
        "the list with the type '((integer | string)[]?)[][]'.",
    ],
    // (a value with no place, a method's result: its own items)
    [
      'let xs=[[[1],null].take(2),[["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    // (a property read of a literal-bound binding holding no null: plain)
    [
      'let o={p:[[1]]}\nlet xs=[o.p,[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    // (no layer that may hold null: plain)
    [
      'let a:integer[][]=[[1]]\nlet xs=[a,[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let xs=[[[1]],[["x"]]]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.code === "TSV044" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
  // (a dict's value layer that may hold null keeps it too; the container's word is #1762's)
  for (const mode of MODES) {
    const [mixed] = inMode(mode, () =>
      reported(main('let a:integer[]? dict=dict {}\nlet xs=[a,dict {k: [["x"]]}]\nexit\n')),
    ).filter((each) => each.code === "TSV044");
    assert.match(mixed?.message ?? "", /mixes a \w+ \(integer\[\]\?/u, JSON.stringify(mode));
  }
});
/**
 * #1790: a mixed error names the later element's leaf type with the `null` it may hold, as the current checker's first
 * sentence does, by #1765's rule at the leaf: a literal's `null`, a written collection copied whole (also below a
 * property), a typed host value unless a still-valid test excludes `null`, not a narrowed copy at the layer itself. A
 * scalar element is its own leaf, so its `or null` is named too (`[false,b[0]]`). In four modes.
 */
test("a mixed error keeps the later element's null below it (#1790)", () => {
  const ONE = "A list holds one type. Use values of one type in it.";
  const cases: readonly (readonly [source: string, message: string])[] = [
    [
      'let xs=[[1],["x",null]]\nexit\n',
      `This list mixes a list (integer[]) and a list (string?[]). ${ONE}`,
    ],
    [
      'let b:string?[]=["x"]\nlet xs=[[1],b]\nexit\n',
      `This list mixes a list (integer[]) and a list (string?[]). ${ONE}`,
    ],
    [
      'let xs=[[1,null],["x",null]]\nexit\n',
      `This list mixes a list (integer?[]) and a list (string?[]). ${ONE}`,
    ],
    [
      'let xs=[{f:[1]},{f:["x",null]}]\nexit\n',
      "This list mixes objects whose property 'f' holds a list (integer[]) in one and a list (string?[]) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    // (a narrowed copy at a property's scalar: its occurrence's kinds, no null, as the current checker names it)
    [
      "let atom:integer?=61\nlet item={v:atom}\nlet other={v:false}\nlet xs=[other,item]\nexit\n",
      "This list mixes objects whose property 'v' holds true or false (boolean) in one and a whole number (integer) in " +
        "another. A list holds one type. Give 'v' one type in every element.",
    ],
    // (a written collection copied whole below a property: its elements' null, Codex r2 on #1819)
    [
      'let n:string?[]=["s"]\nlet xs=[{f:[1]},{f:n}]\nexit\n',
      "This list mixes objects whose property 'f' holds a list (integer[]) in one and a list (string?[]) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    // (a written copy narrowed as its occurrence is: a type test's kinds, a non-null scalar inside a fresh list; Codex r1
    // on #1819)
    [
      "let n:string | boolean=hostValue\nif n is string { let xs=[1,n] }\nexit\n",
      "This list mixes a whole number (integer) and text (string). A list holds one type. To allow both, declare it as " +
        "'let xs: (integer | string)[] =[1,n]'.",
    ],
    [
      "let n:integer?=1\nlet xs=[{f:[false]},{f:[n]}]\nexit\n",
      "This list mixes objects whose property 'f' holds a list (boolean[]) in one and a list (integer[]) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    // (an `otherwise` whose fallback never runs adds no null: a literal, narrowed by assignment or a test, at a property,
    // deeper and at the element; one whose operand may be null keeps its fallback's; Codex r3 on #1819)
    [
      "let xs=[[false],[(1 otherwise null)]]\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer[]). ${ONE}`,
    ],
    [
      "let xs=[{f:[false]},{f:[(1 otherwise null)]}]\nexit\n",
      "This list mixes objects whose property 'f' holds a list (boolean[]) in one and a list (integer[]) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      "let xs=[[[false]],[[(1 otherwise null)]]]\nexit\n",
      `This list mixes a list (boolean[][]) and a list (integer[][]). ${ONE}`,
    ],
    [
      "let n:integer?=1\nlet xs=[[false],[(n otherwise null)]]\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer[]). ${ONE}`,
    ],
    [
      "let n:integer?=hostValue\nif n is integer { let xs=[[false],[(n otherwise null)]] }\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer[]). ${ONE}`,
    ],
    [
      "let xs=[false,(1 otherwise null)]\nexit\n",
      "This list mixes true or false (boolean) and a whole number (integer). A list holds one type. To allow both, " +
        "declare it as 'let xs: (boolean | integer)[] =[false,(1 otherwise null)]'.",
    ],
    [
      "let m=[1,null]\nlet xs=[[false],[(m[0] otherwise null)]]\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer?[]). ${ONE}`,
    ],
    // (a known difference, #1838: an inferred copy of an `otherwise` keeps, in admission's items, the null its never-run
    // fallback brings (#1836 is its binding form); the current checker says `integer[]`. Admission's to repair, not the
    // message layer's; it turns to `integer[]` with it)
    [
      "let n=1 otherwise null\nlet xs=[[false],[n]]\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer?[]). ${ONE}`,
    ],
    // (a typed host value at the leaf, directly, as a `get` default and as a method's result: `null` unless a test
    // excludes it, and again after a later store; Astra r1 on #1819)
    ...["n", "[].get(0,default:n)", "[n].first"].map(
      (leaf) =>
        [
          `let n:integer?=hostValue\nlet xs=[[false],[2,${leaf}]]\nexit\n`,
          `This list mixes a list (boolean[]) and a list (integer?[]). ${ONE}`,
        ] as const,
    ),
    [
      "let n:integer?=hostValue\nif n is integer {\nlet xs=[[false],[2,n]]\n}\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer[]). ${ONE}`,
    ],
    [
      "let n:integer?=hostValue\nif n != null {\nn=hostValue\nlet xs=[[false],[2,n]]\n}\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer?[]). ${ONE}`,
    ],
    [
      "let n:integer=hostValue\nlet xs=[[false],[2,n]]\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer[]). ${ONE}`,
    ],
    // (a known difference, #1847: a `!= null` test leaves no mark on a typed host value's unknown items, so its `null`
    // stays; the current checker says `integer[]`. The value layer's to repair; it turns to `integer[]` with it)
    [
      "let n:integer?=hostValue\nif n != null {\nlet xs=[[false],[2,n]]\n}\nexit\n",
      `This list mixes a list (boolean[]) and a list (integer?[]). ${ONE}`,
    ],
    // (a scalar element is its own leaf: its `or null` named, as the checker does)
    [
      "let b=[1,null]\nlet xs=[false,b[0]]\nexit\n",
      "This list mixes true or false (boolean) and a whole number (integer) or null. A list holds one type. To allow " +
        "both, declare it as 'let xs: (boolean | integer | null)[] =[false,b[0]]'.",
    ],
    // (no null: plain)
    [
      'let b:string[]=["x"]\nlet xs=[[1],b]\nexit\n',
      `This list mixes a list (integer[]) and a list (string[]). ${ONE}`,
    ],
    [
      'let b:string?="x"\nlet xs=[1,b]\nexit\n',
      "This list mixes a whole number (integer) and text (string). A list holds one type. To allow both, declare " +
        "it as 'let xs: (integer | string)[] =[1,b]'.",
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.code === "TSV044" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
});
/**
 * #1901: a written copy's layer is read by its type where the layer lies below the copy's own level, and by its
 * occurrence where the layer is its own level, whatever binding carries it: an inferred binding of a join keeps the
 * written null of the joined copy's element, while a property holding a narrowed scalar copy names none, also through
 * a copy of that binding and a wrapper's read of it, whichever element comes first. Each as the current checker's first
 * sentence; in four modes.
 */
test("a mixed error reads a copy's layer by its type below the copy's own level, by its occurrence at it (#1901)", () => {
  const ONE = "A list holds one type. Use values of one type in it.";
  const V = "A list holds one type. Give 'v' one type in every element.";
  const cases: readonly (readonly [source: string, message: string])[] = [
    [
      'let d: integer[]?[] = [[1]]\nlet held = d + [[2]]\nlet xs = [held, [["x"]]]\nexit\n',
      `This list mixes a list (integer[]?[]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let d: integer[]?[] = [[1]]\nlet held = d + [[2]]\nlet xs = [{f: held}, {f: [["x"]]}]\nexit\n',
      "This list mixes objects whose property 'f' holds a list (integer[]?[]) in one and a list (string[][]) in " +
        "another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let d: integer?[][] = [[1]]\nlet held = d + [[2]]\nlet xs = [held, [["x"]]]\nexit\n',
      `This list mixes a list (integer?[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let d: integer?[] = [1]\nlet held = d + [2]\nlet xs = [held, ["x"]]\nexit\n',
      `This list mixes a list (integer?[]) and a list (string[]). ${ONE}`,
    ],
    // (a narrowed scalar copy at its own level, through a binding and a copy of it: no null)
    [
      'let atom: string? = "x"\nlet h = {v: atom}\nlet xs = [{v: 1}, h]\nexit\n',
      `This list mixes objects whose property 'v' holds a whole number (integer) in one and text (string) in another. ${V}`,
    ],
    [
      'let atom: string? = "x"\nlet h = {v: atom}\nlet g = h\nlet xs = [{v: 1}, g]\nexit\n',
      `This list mixes objects whose property 'v' holds a whole number (integer) in one and text (string) in another. ${V}`,
    ],
    // (and read through a wrapper, its key's type taken from the wrapper's frontier, `wrapped`: Codex r1)
    [
      'let atom:string?="x"\nlet h={v:atom}\nh={v:atom}\nlet box={q:h}\nlet xs=[{v:1},box.q]\nexit\n',
      `This list mixes objects whose property 'v' holds a whole number (integer) in one and text (string) in another. ${V}`,
    ],
    // (the earliest element's leaf by the same rule as the later one's, both orders: a scalar copy at its own level
    // narrowed, in a binding of it, a copy of that binding, below a property, two lists deep and through a wrapper; Astra
    // r1 on #1908)
    [
      'let atom: string? = "x"\nlet h = {v: atom}\nlet xs = [h, {v: 1}]\nexit\n',
      `This list mixes objects whose property 'v' holds text (string) in one and a whole number (integer) in another. ${V}`,
    ],
    [
      'let atom:string?="x"\nlet h=[atom]\nlet g=h\nlet xs=[g,[1]]\nexit\n',
      `This list mixes a list (string[]) and a list (integer[]). ${ONE}`,
    ],
    [
      'let atom:string?="x"\nlet h=[atom]\nlet g=h\nlet xs=[[1],g]\nexit\n',
      `This list mixes a list (integer[]) and a list (string[]). ${ONE}`,
    ],
    [
      'let atom:string?="x"\nlet h={v:[atom]}\nlet g=h\nlet xs=[g,{v:[1]}]\nexit\n',
      `This list mixes objects whose property 'v' holds a list (string[]) in one and a list (integer[]) in another. ${V}`,
    ],
    [
      'let atom:string?="x"\nlet h={v:[atom]}\nlet g=h\nlet xs=[{v:[1]},g]\nexit\n',
      `This list mixes objects whose property 'v' holds a list (integer[]) in one and a list (string[]) in another. ${V}`,
    ],
    [
      'let atom:string?="x"\nlet h=[[atom]]\nlet g=h\nlet xs=[g,[[1]]]\nexit\n',
      `This list mixes a list (string[][]) and a list (integer[][]). ${ONE}`,
    ],
    [
      'let atom:string?="x"\nlet h=[[atom]]\nlet g=h\nlet xs=[[[1]],g]\nexit\n',
      `This list mixes a list (integer[][]) and a list (string[][]). ${ONE}`,
    ],
    [
      'let atom:string?="x"\nlet h={v:[atom]}\nh={v:[atom]}\nlet box={q:{r:h}}\nlet xs=[box.q.r,{v:[1]}]\nexit\n',
      `This list mixes objects whose property 'v' holds a list (string[]) in one and a list (integer[]) in another. ${V}`,
    ],
    [
      'let atom:string?="x"\nlet h={v:[atom]}\nh={v:[atom]}\nlet box={q:{r:h}}\nlet xs=[{v:[1]},box.q.r]\nexit\n',
      `This list mixes objects whose property 'v' holds a list (integer[]) in one and a list (string[]) in another. ${V}`,
    ],
    // (a written collection below that binding: its own null, and its elements')
    [
      'let atom: string[]? = ["x"]\nlet h = {v: atom}\nlet xs = [{v: [1]}, h]\nexit\n',
      `This list mixes objects whose property 'v' holds a list (integer[]) in one and a list (string[]) in another. ${V}`,
    ],
    [
      'let atom: string?[] = ["x"]\nlet h = {v: atom}\nlet xs = [{v: [1]}, h]\nexit\n',
      `This list mixes objects whose property 'v' holds a list (integer[]) in one and a list (string?[]) in another. ${V}`,
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.code === "TSV044" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
});

/**
 * #1828: a mixed join names its leaf with the null this occurrence may hold, by #1765's walk one depth more, as the
 * current checker's first sentence does: not the null its decided domain allows. In four modes.
 */
test("a mixed join names its leaf null as the occurrence holds it (#1828)", () => {
  const cases: readonly (readonly [source: string, message: string])[] = [
    // (a narrowed nullable scalar names no null, as the current checker's first sentence: both sides, `+` and `+=`, and at the top)
    [
      "let n:integer?=1\nlet xs=[{f:false}]+[{f:n}]\nexit\n",
      "'+' would mix objects whose property 'f' holds true or false (boolean) in one and a whole number (integer) in another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      "let n:integer?=1\nlet xs=[{f:n}]+[{f:false}]\nexit\n",
      "'+' would mix objects whose property 'f' holds a whole number (integer) in one and true or false (boolean) in another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      "let n:integer?=1\nlet xs=[{f:false}]\nxs += [{f:n}]\nexit\n",
      "'+=' would mix objects whose property 'f' holds true or false (boolean) in one and a whole number (integer) in another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      "let n:integer?=1\nlet xs=[{f:n}]\nxs += [{f:false}]\nexit\n",
      "'+=' would mix objects whose property 'f' holds a whole number (integer) in one and true or false (boolean) in another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      "let n:integer?=1\nlet xs=[false]+[n]\nexit\n",
      "'+' would mix true or false (boolean) and a whole number (integer). A list holds one type. To allow both, declare the list as 'let xs: (boolean | integer | null)[] =[false]+[n]'.",
    ],
    // (one that may be null keeps its `or null`: a host value, a narrowed value invalidated by a store)
    [
      "let n:integer?=hostValue\nlet xs=[{f:false}]+[{f:n}]\nexit\n",
      "'+' would mix objects whose property 'f' holds true or false (boolean) in one and a whole number (integer) or null in another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      "let n:integer?=1\nif hostValue == 1 { n=null }\nlet xs=[{f:n}]+[{f:false}]\nexit\n",
      "'+' would mix objects whose property 'f' holds a whole number (integer) or null in one and true or false (boolean) in another. A list holds one type. Give 'f' one type in every element.",
    ],
    [
      "let n:integer?=1\nif hostValue == 1 { n=null }\nlet xs=[{f:false}]\nxs += [{f:n}]\nexit\n",
      "'+=' would mix objects whose property 'f' holds true or false (boolean) in one and a whole number (integer) or null in another. A list holds one type. Give 'f' one type in every element.",
    ],
    // (a copied whole collection keeps its written leaf, a literal's own leaf is narrowed, and a null at an intermediate layer stays there, with a leaf null beside it)
    [
      "let n:integer?[]= [1]\nlet xs=[{f:[false]}]+[{f:n}]\nexit\n",
      "'+' would mix objects whose property 'f' holds a list (boolean[]) in one and a list (integer?[]) in another. A list holds one type. Give 'f' one type in every element.",
    ],
    // (the occurrence's leaf holds no null; the type the fix writes holds the literal's, `integer?` by `n`'s declaration,
    // #2289 B1 rule 4, as a written copy's null is held, A4)
    [
      "let n:integer?=1\nlet xs=[[false]]+[[2,n]]\nexit\n",
      "'+' would mix a list (boolean[]) and a list (integer[]). A list holds one type. To allow both, declare the list as 'let xs: (boolean | integer | null)[][] =[[false]]+[[2,n]]'.",
    ],
    [
      'let xs=[[[1],null]]+[[["x"]]]\nexit\n',
      "'+' would mix a list (integer[]?[]) and a list (string[][]). A list holds one type. To allow both, declare the list as 'let xs: ((integer | string)[]?)[][] =[[[1],null]]+[[[\"x\"]]]'.",
    ],
    [
      'let n:integer?=hostValue\nlet xs=[[[1,n],null]]+[[["x"]]]\nexit\n',
      "'+' would mix a list (integer?[]?[]) and a list (string[][]). A list holds one type. To allow both, declare the list as 'let xs: ((integer | string | null)[]?)[][] =[[[1,n],null]]+[[[\"x\"]]]'.",
    ],
    // (a compound assignment's target read through a property, whose occurrence says nothing at the leaf: its place's
    // admitted null, a literal's and a written copy's, as the current checker names it; the joins area)
    [
      'let box = {first: {items: [1, null]}}\nbox.first.items += ["x"]\nexit\n',
      "'+=' would mix a whole number (integer) or null and text (string). A list holds one type. To allow both, declare the list with the type '(integer | string | null)[]'.",
    ],
    [
      'let typed: (integer | boolean | null)[] = [1]\nlet box = {first: {items: typed}}\nbox.first.items += ["x"]\nexit\n',
      "'+=' would mix a whole number (integer), true or false (boolean), or null and text (string). A list holds one type. To allow both, declare the list with the type '(integer | boolean | string | null)[]'.",
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.code === "TSV044" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
});

/**
 * #1828's known limit: the sentence names the null as admission's occurrence items hold it. Where those items are
 * `unknown` (#2009: a `+=` target read through a property named like a collection member, `first`, `last`, `random`,
 * which admission takes as a member read) or keep a null the value cannot hold (#2011: an index into a list of a copied
 * object), it follows them, as main does, where the current checker names none. Pinned with those reasons, beside a
 * property of another name, which the occurrence reads right. In four modes.
 */
test("a join target whose occurrence items are unknown or keep a stale null names that null (#1828, #2009, #2011)", () => {
  const DECLARE = "A list holds one type. To allow both, declare the list with the type";
  const cases: readonly (readonly [source: string, message: string])[] = [
    // (known wrong, #2009: the checker says `a whole number (integer) and text (string)`)
    [
      'let n:integer?=1\nlet box={first:{items:[n]}}\nbox.first.items += ["x"]\nexit\n',
      `'+=' would mix a whole number (integer) or null and text (string). ${DECLARE} '(integer | string | null)[]'.`,
    ],
    [
      'let n:integer?=hostValue\nif n != null {\nlet box={first:{items:[n]}}\nbox.first.items += ["x"]\n}\nexit\n',
      `'+=' would mix a whole number (integer) or null and text (string). ${DECLARE} '(integer | string | null)[]'.`,
    ],
    // (known wrong, #2009: the checker says `a list (integer[])`)
    [
      'let n:integer?=1\nlet box={first:{items:[[n]]}}\nbox.first.items += [["x"]]\nexit\n',
      `'+=' would mix a list (integer?[]) and a list (string[]). ${DECLARE} '(integer | string | null)[][]'.`,
    ],
    // (known wrong, #2011: the items through the index keep `n`'s null; the checker says `a whole number (integer) and text`)
    [
      'let n:integer?=1\nlet origin={alpha:{items:[n]}}\nlet box=[origin]\nbox[0].alpha.items += ["x"]\nexit\n',
      `'+=' would mix a whole number (integer) or null and text (string). ${DECLARE} '(integer | string | null)[]'.`,
    ],
    // (the boundary: a property of another name, read right, as the checker)
    [
      'let n:integer?=1\nlet box={alpha:{items:[n]}}\nbox.alpha.items += ["x"]\nexit\n',
      `'+=' would mix a whole number (integer) and text (string). ${DECLARE} '(integer | string | null)[]'.`,
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.code === "TSV044" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
});
