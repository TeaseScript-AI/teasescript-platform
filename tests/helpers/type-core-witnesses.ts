import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";

/*
 * S6-CARRIERS §6's carrier witnesses, each a name, its program before its final `exit` and its exact record: the cells
 * test compares them in both orders, the sharing differential runs them (the cells test's comment lists what each is).
 */
export const CARRIER_WITNESSES: readonly (readonly [string, string, string])[] = (() => {
  const nested = "let raw = hostValue\nlet root = {nested: {f0: [1, raw][1], f1: [1, raw][1]}}\n";
  const copies = `
    D written-target warning 49:52 unknown
    D written-target warning 66:69 unknown
    C copy-type root.nested.f0 [integer] 49:52
    C copy-type root.nested.f1 [integer] 66:69
    B copy-type raw [unknown] 10:19`;
  const conditional = `outcome warning-runtime-check
    D written-target warning 31:75 later
    D written-target warning 66:69 unknown
    D integer-use warning 190:196 unknown
    D integer-use warning 207:213 unknown
    C copy-type root.nested.f0 [integer] 31:75
    C copy-type root.nested.f1 [integer] 66:69
    C integer-check box.f0 [integer] 190:196
    C integer-check box.f1 [integer] 207:213
    B copy-type raw [unknown] 10:19`;
  const use = "function use(r) {\n  let n: integer = r.f\n  return true\n}\n";
  const choices = (call: string): string =>
    `let root = {f: 1}\nfunction bump {\n  root.f = null\n}\nlet a = askChoice {text: "a", value: root.f}\n${call}` +
    'let b = askChoice {text: "b", value: root.f}\nrepeat a {}\nrepeat b {}\n';
  return [
    [
      "the across-function copy",
      "let raw = hostValue\nraw = 1\nlet root = {f: raw}\nlet box = {f: 0}\nbox = root\nfunction copy {\n  box = root\n}\ncopy()\nrepeat box.f {}\n",
      `outcome warning-runtime-check
      D written-target warning 10:19 later
      D written-target warning 100:104 unknown
      D integer-use warning 121:126 unknown
      C copy-type raw [integer] 10:19
      C copy-type box.f [integer] 100:104
      C integer-check box.f [integer] 121:126
      B copy-type raw [integer] 10:19`,
    ],
    [
      "the reversed copy",
      'let raw = hostValue\nraw = 1\nlet root = {f: raw}\nlet box = {f: null}\nfunction copy {\n  box = root\n}\ncopy()\nbox = root\nbox.f = "word"\nrepeat box.f {}\n',
      `outcome compile-error
      D written-target warning 10:19 later
      D written-target warning 92:96 later
      D written-target error 125:131 -
      C copy-type raw [integer] 10:19
      C copy-type box.f [integer] 92:96
      B copy-type raw [integer] 10:19`,
    ],
    [
      "a concatenation's host operand",
      'let out = ([1] + hostValue)[1]\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 17:26 unknown
      D operator warning 17:26 unknown
      C copy-type out [integer] 17:26
      C operand hostValue [list] 17:26
      B copy-type out [integer] 17:26`,
    ],
    [
      "a concatenation's host operand, a later store",
      'let out = ([1] + hostValue)[1]\nout = 1\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 17:26 later
      D operator warning 17:26 unknown
      C copy-type out [integer] 17:26
      C operand hostValue [list] 17:26
      B copy-type out [integer] 17:26`,
    ],
    [
      "an otherwise's host operand",
      'let out = hostValue otherwise 1\nsay "AFTER"\n',
      "outcome valid\nB copy-type out [integer] 10:19",
    ],
    [
      "a choice's host option",
      'let out = askChoice 1, hostValue\nsay "AFTER"\n',
      "outcome valid\nB copy-type out [integer] 23:32",
    ],
    [
      "repeated projected copies",
      `${nested}let box = root.nested\nbox = root.nested\nbox = root.nested\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      `outcome warning-runtime-check${copies}
      D integer-use warning 141:147 unknown
      D integer-use warning 158:164 unknown
      C integer-check box.f0 [integer] 141:147
      C integer-check box.f1 [integer] 158:164`,
    ],
    [
      "once-bound projected copies",
      `${nested}let stable = root.nested\nlet box = stable\nbox = stable\nbox = stable\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      `outcome warning-runtime-check${copies}
      D integer-use warning 151:157 unknown
      D integer-use warning 168:174 unknown
      C integer-check box.f0 [integer] 151:157
      C integer-check box.f1 [integer] 168:174`,
    ],
    [
      "projected copies around a store below them",
      `${nested}let box = root.nested\nbox = root.nested\nroot.nested.f0 = 1\nbox = root.nested\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      `outcome warning-runtime-check
      D written-target warning 31:75 later
      D written-target warning 66:69 unknown
      D written-target warning 86:97 later
      D written-target warning 104:115 later
      D integer-use warning 177:183 unknown
      C copy-type root.nested.f0 [integer] 31:75
      C copy-type root.nested.f1 [integer] 66:69
      C copy-type box.f0 [integer] 86:97
      C copy-type box.f0 [integer] 104:115
      C integer-check box.f1 [integer] 177:183
      B copy-type raw [unknown] 10:19`,
    ],
    [
      "M1, the conditional store before the copies",
      `${nested}let box = {f0: null, f1: null}\nif raw != null {\n  root.nested.f0 = 1\n}\nbox = root.nested\nbox = root.nested\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      conditional,
    ],
    [
      "M1, the conditional store between the copies",
      `${nested}let box = {f0: null, f1: null}\nbox = root.nested\nif raw != null {\n  root.nested.f0 = 1\n}\nbox = root.nested\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      conditional,
    ],
    [
      "F3, two choice reads around an effectful call",
      choices("bump()\n"),
      "outcome warning-runtime-check\nD integer-use warning 168:169 call\nC null-check b [integer] 168:169",
    ],
    ["F3, two choice reads, no call between", choices(""), "outcome valid"],
    [
      "F3, an argument under its operand's guard",
      `let root = {f: 2.5}\n${use}if root != null and use(root) {\n  say "yes"\n}\n`,
      "outcome warning-runtime-check\nD written-target warning 57:60 branch\nC copy-type n [integer] 57:60",
    ],
    [
      "F3, an argument under no guard",
      `let root = {f: 2.5}\n${use}if use(root) {\n  say "yes"\n}\n`,
      "outcome compile-error\nD written-target error 57:60 -",
    ],
    [
      "a named key read before and after a call storing to it, in one literal (TABLE r4.68 (1))",
      "global root = 1\nfunction bump {\n  root = 2.0\n  return 0\n}\nlet box = [root, bump(), root]\nrepeat box[2] {}\n",
      `outcome warning-runtime-check
      D integer-use warning 96:102 call
      C integer-check box.element [integer] 96:102`,
    ],
    [
      "a read after a call registering a handler that stores the key, in one literal (Codex r25 F1)",
      'let n = 1\nfunction register {\n  showPermanentButton "Change" { n = 1.5 }\n  return 0\n}\nlet xs = [n, register(), n]\nrepeat xs[2] {}\n',
      `outcome warning-runtime-check
      D integer-use warning 121:126 member
      C integer-check xs.element [integer] 121:126`,
    ],
    [
      "both reads after the registration (Codex r25 F1's control)",
      'let n = 1\nfunction register {\n  showPermanentButton "Change" { n = 1.5 }\n  return 0\n}\nregister()\nlet xs = [n, 0, n]\nrepeat xs[2] {}\n',
      `outcome warning-runtime-check
      D integer-use warning 123:128 member
      C integer-check xs.element [integer] 123:128`,
    ],
  ];
})();

/** One source of `WRITTEN_COPY_MATRIX`: its place, the domain per level and the host values that fit and misfit. */
export interface WrittenCopyCase {
  readonly name: string;
  readonly source: string;
  /** The binding the host value lands in: the written one itself, or its copy. */
  readonly place: string;
  /** The written domain at each level from the place's root down, `null` included where written. */
  readonly levels: readonly (readonly string[])[];
  /** The checked type of the store bringing the host value, as written. */
  readonly checked: string;
  /** The store bringing the host value: its statement's span, and its value's (where a bad value stops). */
  readonly store: string;
  readonly value: string;
  readonly fits: readonly SerializableRuntimeValue[];
  readonly misfits: readonly SerializableRuntimeValue[];
}

/**
 * External round 7 B1's matrix (the lead's ruling: a place a written type decides, directly or through a copy, admits
 * the written domain at every collection level, `null` included; the kinds stored never narrow it): four scalar kinds
 * × list depths 0–3 × the innermost element nullable or not × the place written, an early copy of a written binding or
 * a later one × the host value direct, named or held at an index (288 sources), beside an empty original, optional
 * inner lists and their optional elements. Each expectation is the declared type's.
 */
export const WRITTEN_COPY_MATRIX: readonly WrittenCopyCase[] = (() => {
  const kinds = {
    integer: { literal: "1", fits: 2, misfits: [2.5, "text"] },
    number: { literal: "1.5", fits: 2.5, misfits: ["text"] },
    string: { literal: '"a"', fits: "b", misfits: [2] },
    boolean: { literal: "true", fits: false, misfits: ["text"] },
  } as const;
  const wrap = (text: string, depth: number): string =>
    "[".repeat(depth) + text + "]".repeat(depth);
  const out: WrittenCopyCase[] = [];
  const add = (
    name: string,
    lines: readonly string[],
    place: string,
    hostLine: string,
    value: string,
    levels: readonly (readonly string[])[],
    checked: string,
    fits: readonly SerializableRuntimeValue[],
    misfits: readonly SerializableRuntimeValue[],
  ): void => {
    const source = `${[...lines, 'say "DONE"', "exit"].join("\n")}\n`;
    const start = source.indexOf(`${hostLine}\n`);
    const end = start + hostLine.length;
    out.push({
      name,
      source,
      place,
      levels,
      checked,
      store: `${start}:${end}`,
      value: `${end - value.length}:${end}`,
      fits,
      misfits,
    });
  };
  for (const [kind, { literal, fits, misfits }] of Object.entries(kinds))
    for (const depth of [0, 1, 2, 3])
      for (const nullable of [true, false])
        for (const decision of ["written", "early copy", "later copy"] as const)
          for (const host of ["direct", "named", "index-held"] as const) {
            const type = `${kind}${nullable ? "?" : ""}${"[]".repeat(depth)}`;
            const value = wrap(
              host === "direct" ? "hostValue" : host === "named" ? "h" : "[hostValue][0]",
              depth,
            );
            const lines = [
              ...(host === "named" ? ["let h = hostValue"] : []),
              `let typed: ${type} = ${wrap(literal, depth)}`,
            ];
            const hostLine =
              decision === "written"
                ? `typed = ${value}`
                : decision === "early copy"
                  ? `copy = ${value}`
                  : `let copy = ${value}`;
            if (decision === "written") lines.push(hostLine);
            else if (decision === "early copy") lines.push("let copy = typed", hostLine);
            else lines.push(hostLine, "copy = typed");
            const scalar = nullable ? [kind, "null"] : [kind];
            add(
              `${type}, ${decision}, ${host}`,
              lines,
              decision === "written" ? "typed" : "copy",
              hostLine,
              value,
              [...Array.from({ length: depth }, () => ["list"]), scalar],
              `${"list<".repeat(depth)}${scalar.join("|")}${">".repeat(depth)}`,
              nullable ? [null, fits] : [fits],
              nullable ? misfits : [null, ...misfits],
            );
          }
  const list = (items: readonly SerializableRuntimeValue[]): SerializableRuntimeValue => ({
    kind: "list",
    items: [...items],
  });
  for (const [order, lines] of [
    ["early copy", ["let copy = typed", "copy = [hostValue]"]],
    ["later copy", ["let copy = [hostValue]", "copy = typed"]],
  ] as const) {
    add(
      `integer?[] from an empty original, ${order}`,
      ["let typed: integer?[] = []", ...lines],
      "copy",
      lines[order === "early copy" ? 1 : 0],
      "[hostValue]",
      [["list"], ["integer", "null"]],
      "list<integer|null>",
      [null, 2],
      [2.5, "text"],
    );
    add(
      `integer[]?[], an optional inner list, ${order}`,
      ["let typed: integer[]?[] = [[1]]", ...lines],
      "copy",
      lines[order === "early copy" ? 1 : 0],
      "[hostValue]",
      [["list"], ["list", "null"], ["integer"]],
      "list<list<integer>|null>",
      [null, list([2])],
      [list([null]), list(["text"]), 2],
    );
    add(
      `integer?[]?[], optional elements of an optional inner list, ${order}`,
      ["let typed: integer?[]?[] = [[1]]", ...lines],
      "copy",
      lines[order === "early copy" ? 1 : 0],
      "[hostValue]",
      [["list"], ["list", "null"], ["integer", "null"]],
      "list<list<integer|null>|null>",
      [null, list([2]), list([null])],
      [list(["text"]), 2],
    );
  }
  return out;
})();

/*
 * #1188's witnesses, each a name, its program before its final `exit` and its exact record: the cells test compares
 * them in both orders, the sharing differential runs them (the cells test's comment lists what each is).
 */
export const HOT_CANDIDATE_WITNESSES: readonly (readonly [string, string, string])[] = [
  [
    "rule (a) form 1: a list whose elements still disagree after a rejected element is ignored",
    "let count:integer=11\n" +
      'let parcel={meta:{score:count},label:"ok"}\n' +
      'let broken=[{meta:{score:false},label:"ok"},parcel]\n' +
      "let capsule={value:broken.first}\n" +
      "let relay=capsule\n" +
      "let picked=relay.value\n" +
      "let final=[picked.meta,parcel.meta]\n",
    `outcome compile-error
    D written-target error 108:114 -
    D written-target error 213:224 -`,
  ],
  [
    "rule (a) form 2: no warning or check about a rejected value",
    "let unit:integer | string=7\n" +
      "let wide={f:unit}\n" +
      "let wide2={f:unit}\n" +
      "let inner=[{f:true},wide]\n" +
      "let result=[inner.first,wide2]\n",
    `outcome compile-error
    D written-target error 85:89 -
    D written-target error 115:120 -`,
  ],
  [
    "rule (a) form 3: a later store against the surviving type",
    "let count:integer=11\n" +
      "let parcel={score:count}\n" +
      "let broken=[{score:false},parcel]\n" +
      "let capsule={value:broken.first}\n" +
      "let relay=capsule\n" +
      "let final=relay.value\n" +
      "final=parcel\n",
    `outcome compile-error
    D written-target error 72:78 -
    D written-target error 159:165 -`,
  ],
  [
    "rule (a) form 3: a rejected list's surviving value against the receiving place's type",
    "let sample:integer=29\n" +
      "let parcel={weight:sample}\n" +
      "let damaged=[{weight:false},parcel]\n" +
      "let outcome=parcel\n" +
      "outcome=damaged.first\n",
    `outcome compile-error
    D written-target error 77:83 -
    D written-target error 112:125 -`,
  ],
  [
    "a whole cycle split by its two rejected copies",
    "let nvalue:integer=23\n" +
      'let wordvalue:string="s"\n' +
      "let left={f:nvalue}\n" +
      "let right={f:wordvalue}\n" +
      "left=right\n" +
      "right=left\n" +
      "let box={a:left,b:right}\n" +
      "let final=[box.a,box.b]\n",
    `outcome compile-error
    D written-target error 96:101 -
    D written-target error 108:112 -
    D written-target error 155:160 -`,
  ],
  [
    "a fed cycle whose feeder's store is rejected",
    "let amount:integer=29\n" +
      "let origin={f:amount}\n" +
      "let fractional={f:1.75}\n" +
      "let inlet=origin\n" +
      "inlet=fractional\n" +
      "let a0=inlet\n" +
      "let a1=a0\n" +
      "let a2=a1\n" +
      "a0=a2\n" +
      "let final=[fractional,a2]\n",
    `outcome compile-error
    D written-target error 91:101 -`,
  ],
  [
    "a literal deciding by a copy its merge place contains",
    "let typed:integer=4\n" +
      "let s={x:1.5}\n" +
      "let y={x:typed}\n" +
      "let d=s\n" +
      "d=y\n" +
      "let b=[y,d]\n",
    `outcome warning-runtime-check
    D written-target warning 68:73 member
    C copy-type b.element.x [integer] 68:73`,
  ],
  [
    "a live nested union",
    "let score:integer | string=13\n" +
      "let source={score:score}\n" +
      "let grid=[{rows:[{score:false}]},{rows:[source]}]\n" +
      "let final=[grid.first.rows.first,source]\n",
    `outcome compile-error
    D written-target warning 64:104 member
    D written-target warning 64:104 member
    D written-target error 138:144 -
    C copy-type grid.element.rows.element.score [boolean] 64:104
    C copy-type grid.element.rows.element.score [boolean] 64:104`,
  ],
  [
    "a whole-copy ring whose members decide two properties differently, two of them in a list (Astra's review B1 of #1311)",
    "let ti:integer=7\n" +
      'let ts:string="s"\n' +
      "let a0={f:1.5,g:ti}\n" +
      "let a1={f:1.5,g:true}\n" +
      "let a2={f:ts,g:true}\n" +
      "a2=a0\n" +
      "a0=a1\n" +
      "a1=a2\n" +
      "let pair=[a1,a0]\n",
    `outcome compile-error
    D written-target error 101:103 -
    D written-target error 101:103 -
    D written-target error 107:109 -
    D written-target warning 113:115 unknown
    D written-target error 129:131 -
    D written-target error 129:131 -
    C copy-type a1.f [number] 113:115`,
  ],
  [
    "the same ring through a written union",
    "let ti:integer=7\n" +
      "let tu:integer | string=7\n" +
      "let a0={f:tu,g:1.5}\n" +
      "let a1={f:true,g:tu}\n" +
      "let a2={f:ti,g:tu}\n" +
      "a0=a1\n" +
      "a1=a2\n" +
      "a2=a0\n" +
      "let pair=[a1,a0]\n",
    `outcome compile-error
    D written-target error 106:108 -
    D written-target error 112:114 -
    D written-target warning 118:120 unknown
    D written-target error 134:136 -
    D written-target error 134:136 -
    C copy-type a2.g [integer|string] 118:120`,
  ],
  [
    "a load default's contributor beside a shared record in two lists, the first fitting (Astra's PR review B1)",
    "let t:integer=7\n" +
      "let peer={x:t}\n" +
      "let good={x:1}\n" +
      'let bad={x:"bad"}\n' +
      'let first=[load("one", default:good),peer]\n' +
      'let second=[load("two", default:bad),peer]\n',
    `outcome compile-error
    D written-target error 144:148 -
    B copy-type first.element [object] 75:100
    B copy-type second.element [object] 119:143`,
  ],
  [
    "the same two lists in the other order",
    "let t:integer=7\n" +
      "let peer={x:t}\n" +
      "let good={x:1}\n" +
      'let bad={x:"bad"}\n' +
      'let second=[load("two", default:bad),peer]\n' +
      'let first=[load("one", default:good),peer]\n',
    `outcome compile-error
    D written-target error 101:105 -
    B copy-type second.element [object] 76:100
    B copy-type first.element [object] 118:143`,
  ],
  [
    "a fromJson default's contributor in two sets",
    "let t:integer=7\n" +
      "let peer={x:t}\n" +
      "let good={x:1}\n" +
      'let bad={x:"bad"}\n' +
      "let first=set[fromJson(hostValue, default:good, files:false),peer]\n" +
      "let second=set[fromJson(hostValue, default:bad, files:false),peer]\n",
    `outcome compile-error
    D written-target error 192:196 -
    B copy-type first.element [object] 78:124
    B copy-type second.element [object] 146:191`,
  ],
  [
    "a load default's contributor after the shared record in two dicts",
    "let t:integer=7\n" +
      "let peer={x:t}\n" +
      "let good={x:1}\n" +
      'let bad={x:"bad"}\n' +
      'let first=dict{a:peer,b:load("one", default:good)}\n' +
      'let second=dict{a:peer,b:load("two", default:bad)}\n',
    `outcome compile-error
    D written-target error 140:164 -
    B copy-type first.entry [object] 88:113
    B copy-type second.entry [object] 140:164`,
  ],
  [
    "a load default's contributor in a nested position",
    "let t:integer=7\n" +
      "let peer={x:t}\n" +
      "let good={x:1}\n" +
      'let bad={x:"bad"}\n' +
      'let first=[{inner:load("one", default:good)},{inner:peer}]\n' +
      'let second=[{inner:load("two", default:bad)},{inner:peer}]\n',
    `outcome compile-error
    D written-target error 168:180 -
    B copy-type first.element [object] 82:107
    B copy-type second.element [object] 142:166`,
  ],
  [
    "a fromJson default's contributor in a nested position",
    "let t:integer=7\n" +
      "let peer={x:t}\n" +
      "let good={x:1}\n" +
      'let bad={x:"bad"}\n' +
      "let first=[{inner:fromJson(hostValue, default:good, files:false)},{inner:peer}]\n" +
      "let second=[{inner:fromJson(hostValue, default:bad, files:false)},{inner:peer}]\n",
    `outcome compile-error
    D written-target error 210:222 -
    B copy-type first.element [object] 82:128
    B copy-type second.element [object] 163:208`,
  ],
];
