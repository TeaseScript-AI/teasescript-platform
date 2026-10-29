import type { SourceFile } from "./type-core-analysis.js";

/**
 * The work families of the coarse core (checkpoint 9, TABLE §10.1's W rows), as the reference model's gate generator
 * writes them (`make-gates14.py`): per family a program of size k whose shape once made a product of two program
 * dimensions in some realization of the core. Each family names the TABLE structure whose bound it measures. The
 * harness's boolean host flag is an interaction, as the expectation set writes it: a file that reads `flagHost`
 * starts with `let flagHost = askBoolean "flag"`.
 */
export interface WorkFamily {
  readonly name: string;
  readonly measures: string;
  readonly program: (k: number) => readonly SourceFile[];
}

const rows = (k: number, row: (index: number) => string): string =>
  Array.from({ length: k }, (_, index) => row(index)).join("\n");
const lines = (...parts: readonly string[]): string => parts.join("\n");
const fields = (k: number, value: (index: number) => string, name = "f"): string =>
  Array.from({ length: k }, (_, index) => `${name}${index}: ${value(index)}`).join(", ");
const cells = (k: number, cell: string): string => Array.from({ length: k }, () => cell).join(", ");

/** A file that reads the boolean host flag declares it from an interaction first. */
function file(path: string, source: string): SourceFile {
  return {
    path,
    source: source.includes("flagHost") ? `let flagHost = askBoolean "flag"\n${source}` : source,
  };
}

const main = (source: string): readonly SourceFile[] => [file("main.tease", source)];

function w2(k: number, amount: string): string {
  return lines(
    rows(k, (i) => `global stat${i} = 0`),
    rows(k, (i) => `function raise${i}(amount) { stat${i} += amount }`),
    "function addStat(name: string, amount) {",
    rows(k, (i) => `if name == "stat${i}" { raise${i}(amount) }`),
    "}",
    rows(k, (i) => `function scene${i} {\nsay "Scene ${i}"\naddStat("stat${i}", ${amount})\n}`),
    rows(k, (i) => `scene${i}()`),
    rows(k, (i) => `repeat stat${i} { say "tick" }`),
    "exit",
  );
}

function w12(k: number, variant: "ladder" | "chain" | "diamonds"): string {
  if (variant === "ladder")
    return lines(
      "let level = 1",
      "function change0 { level = 1.5 }",
      rows(k - 1, (i) => `function change${i + 1} { change${i}() }`),
      rows(k, (i) => `if flagHost { change${i}() }`),
      "let shown: integer = level",
      "exit",
    );
  if (variant === "chain")
    return lines(
      "let level = 1",
      "function wrap0 { level = 2 }",
      rows(k - 1, (i) => `function wrap${i + 1} { wrap${i}() }`),
      `wrap${k - 1}()`,
      rows(k, (i) => `let shown${i}: integer = level`),
      "exit",
    );
  return lines(
    "let level = 1",
    rows(
      k,
      (i) =>
        `if flagHost { level = ${i} } else { level = ${i + 1} }\nlet shown${i}: integer = level`,
    ),
    "exit",
  );
}

/** A registration at the far end of an adversely ordered chain of k calls and transfers (H6). */
function w14(k: number, variant: "calls" | "goto" | "mixed" | "functions"): readonly SourceFile[] {
  if (variant === "functions")
    return main(
      lines(
        "let n = 1",
        rows(k, (i) =>
          i > 0
            ? `function step${k - 1 - i} { step${k - i}() }`
            : `function step${k - 1} { showPermanentButton "x" { n = 1.5 } }`,
        ),
        "step0()",
        "wait 1 s",
        "let shown: integer = n",
        "exit",
      ),
    );
  const hop = (i: number): string => {
    const next = `"f${i + 1}.tease"`;
    const kind = variant !== "mixed" ? variant : (["calls", "goto", "function"] as const)[i % 3];
    if (kind === "calls") return `call ${next}\nend`;
    if (kind === "goto") return `goto ${next}`;
    return `function hop${i} { call ${next} }\nhop${i}()\nend`;
  };
  return [
    file(
      "main.tease",
      lines("global n = 1", 'call "f0.tease"', "wait 1 s", "let shown: integer = n", "exit"),
    ),
    ...Array.from({ length: k }, (_, j) => k - 1 - j).map((i) =>
      file(`f${i}.tease`, i < k - 1 ? hop(i) : 'showPermanentButton "x" { n = 1.5 }\nend'),
    ),
  ];
}

function w18(k: number, variant: "wrapped" | "quiet" | "number" | "valid"): string {
  if (variant === "wrapped" || variant === "quiet") {
    const parts = [
      `let original = {${fields(k, () => "1", "v")}}`,
      rows(k, (i) => `let frozen${i} = original`),
      `let archive = [${Array.from({ length: k }, (_, i) => (variant === "wrapped" ? `{data: frozen${i}}` : `frozen${i}`)).join(", ")}]`,
      ...(variant === "wrapped" ? [rows(k, (i) => `original.v${i} = 1.5`)] : []),
    ];
    const path = variant === "wrapped" ? "archive.first.data" : "archive.first";
    return lines(
      ...parts,
      rows(k, (i) => `let checked${i}: integer = ${path}.v${i}`),
      "exit",
    );
  }
  return lines(
    `let seed = {${fields(k, (i) => (variant === "number" ? `${i}.0` : `${i}`))}}`,
    rows(k, (i) => `let copy${i} = seed`),
    `let packed = [${Array.from({ length: k }, (_, i) => `{payload: copy${i}}`).join(", ")}]`,
    ...(variant === "valid" ? [rows(k, (i) => `seed.f${i} = ${i}.5`)] : []),
    rows(k, (i) => `let out${i}: integer = packed.first.payload.f${i}`),
    "exit",
  );
}

function w19(k: number, variant: "sources" | "record"): string {
  if (variant === "sources")
    return lines(
      `let seed = {${fields(k, (i) => `${i}`)}}`,
      "if seed != null {",
      rows(k, (i) => `let snap${i} = seed`),
      `let packed = [${Array.from({ length: k }, (_, i) => `{node: snap${i}}`).join(", ")}]`,
      rows(k, (i) => `seed.f${i} = ${i}.5`),
      rows(k, (i) => `let need${i}: integer = packed.last.node.f${i}`),
      "}",
      "exit",
    );
  return lines(
    `let source = {${fields(k, () => "1")}}`,
    "if source.f0 is integer {",
    rows(k, (i) => `let snapshot${i} = source`),
    `let archive = [${Array.from({ length: k }, (_, i) => `{payload: snapshot${i}}`).join(", ")}]`,
    rows(k, (i) => `let checked${i}: integer = archive.first.payload.f${i}`),
    "}",
    "exit",
  );
}

function w21(k: number, variant: "fields" | "roots" | "same"): string {
  const parts =
    variant === "roots"
      ? [rows(k, (i) => `let value${i} = 1`)]
      : [`let box = {${fields(k, () => "1")}}`];
  const tested = (i: number): string =>
    variant === "roots" ? `value${i}` : variant === "same" ? "box.f0" : `box.f${i}`;
  return lines(
    ...parts,
    rows(k, (i) => `if ${tested(i)} is integer and ${tested(i)} > 0 { say "ok" }`),
    "exit",
  );
}

function w23(k: number, variant: "calls" | "changed" | "hoisted"): string {
  return lines(
    `global seed = {${fields(k, () => "1")}}`,
    "function snapshot { return seed }",
    ...(variant === "hoisted"
      ? [
          "let result = snapshot()",
          `let archive = [${Array.from({ length: k }, () => "result").join(", ")}]`,
        ]
      : [`let archive = [${Array.from({ length: k }, () => "snapshot()").join(", ")}]`]),
    ...(variant === "changed" ? [rows(k, (i) => `seed.f${i} = 1.5`)] : []),
    rows(k, (i) => `let value${i}: integer = archive.first.f${i}`),
    "exit",
  );
}

const W24_VARIANTS = [
  "siblings",
  "exit",
  "changed",
  "result",
  "result-object",
  "same-child",
  "varied",
  "wrapper-varied",
  "wrapper-same",
  "outside",
  "alias-group",
  "alias-chain",
] as const;

/** Guard scope is not identity: k guarded copies of one record read at k fields. */
function w24(k: number, variant: (typeof W24_VARIANTS)[number]): string {
  const record = fields(k, () => "1");
  const reads = (value: string): string => rows(k, (i) => `let n${i}: integer = ${value}.f${i}`);
  switch (variant) {
    case "siblings":
    case "changed":
      return lines(
        `let seed = {${record}}`,
        "let picked = seed",
        rows(k, (i) => `if seed.f${i} is integer { picked = seed }`),
        ...(variant === "changed" ? [rows(k, (i) => `seed.f${i} = 1.5`)] : []),
        reads("picked"),
        "exit",
      );
    case "exit":
      return lines(
        `let seed = {${record}}`,
        rows(k, (i) => `if seed.f${i} is not integer { exit }\nlet s${i} = seed`),
        `let archive = [{layer: [${Array.from({ length: k }, (_, i) => `s${i}`).join(", ")}]}]`,
        reads("archive.first.layer.first"),
        "exit",
      );
    case "result":
    case "result-object":
      return lines(
        `function chooseValue${variant === "result-object" ? ": object" : ""} {`,
        `let row = {${record}}`,
        rows(k, (i) => `if row.f${i} is integer { return row }`),
        "return row",
        "}",
        "let archive = [{layer: [chooseValue(), chooseValue()]}]",
        reads("archive.first.layer.first"),
        "exit",
      );
    case "same-child":
      return lines(
        `let seed = {${record}}`,
        "let saved = seed",
        rows(k, () => "if seed.f0 is integer { saved = seed }"),
        "let archive = [saved]",
        reads("archive.first"),
        "exit",
      );
    case "varied":
      return lines(
        `let seed = {${record}}`,
        rows(k, (i) => `let copy${i} = seed\nif seed.f${i} is integer { copy${i} = seed }`),
        `let archive = [${Array.from({ length: k }, (_, i) => `copy${i}`).join(", ")}]`,
        reads("archive.first"),
        "exit",
      );
    case "wrapper-varied":
    case "wrapper-same":
      return lines(
        `let seed = {${record}}`,
        "let picked = {layer: [seed]}",
        rows(
          k,
          (i) =>
            `if seed.f${variant === "wrapper-varied" ? i : 0} is integer { picked = {layer: [seed]} }`,
        ),
        reads("picked.layer.first"),
        "exit",
      );
    case "outside":
      return lines(
        `let seed = {${record}}`,
        'if seed.f0 is integer { say "ok" }',
        "let bundle = {wrap: [seed]}",
        rows(k, () => "if flagHost { bundle = {wrap: [seed]} }"),
        reads("bundle.wrap.first"),
        "exit",
      );
    case "alias-group":
      return lines(
        `let seed = {n0: 1, ${record}}`,
        rows(
          k,
          (i) => `let a${i} = seed\nlet b${i} = a${i}\nif a${i}.n0 is integer { b${i} = a${i} }`,
        ),
        `let bundle = [${Array.from({ length: k }, (_, i) => `b${i}`).join(", ")}]`,
        reads("bundle.first"),
        "exit",
      );
    case "alias-chain":
      return lines(
        "let seed = {n0: 1, n1: 1}",
        "let a0 = seed",
        "if a0.n0 is not integer { exit }",
        rows(k - 1, (i) => `let a${i + 1} = a${i}\nif a${i + 1}.n0 is not integer { exit }`),
        `let out: integer = a${k - 1}.n1`,
        "exit",
      );
  }
}

function w25(k: number, variant: "stores" | "nested" | "changed" | "aliases"): string {
  const head = [`global seed = {${fields(k, () => "1")}}`, "function snapshot { return seed }"];
  let body: string[];
  let value = "archive";
  if (variant === "stores" || variant === "changed")
    body = [
      "let archive = snapshot()",
      rows(k, () => "if flagHost { archive = snapshot() }"),
      ...(variant === "changed" ? [rows(k, (i) => `seed.f${i} = 1.5`)] : []),
    ];
  else if (variant === "nested") {
    body = [
      "let archive = {layer: [snapshot()]}",
      rows(k, () => "if flagHost { archive = {layer: [snapshot()]} }"),
    ];
    value = "archive.layer.first";
  } else
    body = [
      "let archive = snapshot()",
      rows(k, (i) => `let s${i} = snapshot()\nif flagHost { archive = s${i} }`),
    ];
  return lines(
    ...head,
    ...body,
    rows(k, (i) => `let n${i}: integer = ${value}.f${i}`),
    "exit",
  );
}

function w26(k: number, variant: "repeated" | "scope" | "hoisted"): string {
  if (variant === "hoisted")
    return lines(
      `global seed = {${fields(k, () => "1")}}`,
      "function snapshot { return seed }",
      "let saved = snapshot()",
      "let shared = snapshot()",
      rows(k, () => "if flagHost { saved = shared }"),
      rows(k, (i) => `let n${i}: integer = saved.f${i}`),
      "exit",
    );
  return lines(
    "let seed = {a: 1}",
    "let picked = seed",
    ...(variant === "scope"
      ? ["if seed.a is integer {", rows(k, () => "picked = seed"), "}"]
      : [rows(k, () => "if flagHost { picked = seed }")]),
    "let n: integer = picked.a",
    "exit",
  );
}

/** A `goto` chain of k files each of which is also called, a registration behind it or none (r4.20). */
function w35(k: number, registration: boolean): readonly SourceFile[] {
  const tail = registration ? 'showPermanentButton "x" { n = 1.5 }\nend' : "n = 2\nend";
  return [
    file(
      "main.tease",
      lines(
        "global n = 1",
        rows(k, (i) => `call "f${i}.tease"`),
        "wait 1 s",
        "let shown: integer = n",
        "exit",
      ),
    ),
    ...Array.from({ length: k }, (_, j) => k - 1 - j).map((i) =>
      file(`f${i}.tease`, i < k - 1 ? `goto "f${i + 1}.tease"` : tail),
    ),
  ];
}

/** k guarded projected aliases of one source stored into one place, read at k siblings (r4.23). */
function w36(k: number, variant: "inside" | "varied" | "wrapper" | "extra-alias"): string {
  const wrapped = variant === "wrapper" || variant === "extra-alias";
  const stores = rows(k, (i) => {
    const tested = variant === "varied" ? `p${i}` : "flag";
    const body =
      variant === "extra-alias"
        ? `let a${i} = root.wrap\nlet b${i} = a${i}\npicked = {one: [{two: b${i}}]}`
        : variant === "wrapper"
          ? `let a${i} = root.wrap\npicked = {one: [{two: a${i}}]}`
          : `let a${i} = root.wrap\npicked = a${i}`;
    return `if root.wrap.${tested} is integer { ${body} }`;
  });
  const path = wrapped ? "picked.one.first.two" : "picked";
  return lines(
    `let root = {wrap: {flag: 2.0, ${fields(k, () => "2.0", "p")}}}`,
    wrapped ? "let picked = {one: [{two: root.wrap}]}" : "let picked = root.wrap",
    stores,
    rows(k, (i) => `let got${i}: number = ${path}.p${i}`),
    "exit",
  );
}

function w37(k: number, hoisted: boolean): string {
  return lines(
    "let seed = {n0: 3, n1: 3}",
    "let selected = seed",
    rows(k, () => "if seed.n0 is integer { selected = seed }"),
    ...(hoisted
      ? [
          "let w = {shell: [{payload: selected}]}",
          `let bag = [${Array.from({ length: k }, () => "w").join(", ")}]`,
        ]
      : [
          rows(k, (i) => `let w${i} = {shell: [{payload: selected}]}`),
          `let bag = [${Array.from({ length: k }, (_, i) => `w${i}`).join(", ")}]`,
        ]),
    "repeat bag.first.shell.first.payload.n1 {}",
    "exit",
  );
}

function w38(k: number): string {
  return lines(
    `let seed = {${fields(k + 1, () => "3", "n")}}`,
    "let merged = seed",
    rows(
      k,
      (i) =>
        `let a${i} = seed\nif a${i}.n0 is not integer { exit }\nlet b${i} = a${i}\nif b${i}.n0 is not integer { exit }\nlet c${i} = b${i}\nif flagHost { merged = c${i} }`,
    ),
    rows(k, (j) => `repeat merged.n${j + 1} {}`),
    "exit",
  );
}

/** f_i optionally calls g_i then goes to f_(i+1), the last f ends; g_i calls g_(i+1) then ends, the last exits. */
function w39(k: number, registration: boolean): readonly SourceFile[] {
  const last = `${registration ? 'showPermanentButton "change" { n = 1.5 }\n' : ""}end`;
  return [
    file(
      "main.tease",
      lines(
        "global n = 1",
        'call "f0.tease"',
        ...(registration ? ["wait 1 s"] : []),
        "let checked: integer = n",
        "exit",
      ),
    ),
    ...Array.from({ length: k }, (_, j) => k - 1 - j).map((i) =>
      file(
        `f${i}.tease`,
        `if flagHost { call "g${i}.tease" }\n${i < k - 1 ? `goto "f${i + 1}.tease"` : last}`,
      ),
    ),
    ...Array.from({ length: k }, (_, j) => k - 1 - j).map((i) =>
      file(`g${i}.tease`, i < k - 1 ? `call "g${i + 1}.tease"\nend` : "exit"),
    ),
  ];
}

/** k callables or named files each testing a different field of one record and copying it into one place (r4.28). */
function w40(k: number, files: boolean): readonly SourceFile[] {
  const record = fields(k, () => '"x"');
  const asks = rows(k, (i) => `say picked.f${i} + 1`);
  if (!files)
    return main(
      lines(
        `let root = {wrap: {${record}}}`,
        "let picked = root.wrap",
        rows(
          k,
          (i) =>
            `function contribute${i} { if root.wrap.f${i} is integer { picked = root.wrap } }\ncontribute${i}()`,
        ),
        asks,
        "exit",
      ),
    );
  return [
    file(
      "main.tease",
      lines(
        `global root = {wrap: {${record}}}`,
        "global picked = root.wrap",
        rows(k, (i) => `call "part${i}.tease"`),
        asks,
        "exit",
      ),
    ),
    ...Array.from({ length: k }, (_, i) =>
      file(`part${i}.tease`, `if root.wrap.f${i} is integer { picked = root.wrap }\nend`),
    ),
  ];
}

function w40l(k: number, variant: "logical" | "operands"): string {
  if (variant === "logical")
    return lines(
      `let root = {${fields(k, () => '"bad"')}}`,
      "let chosen = root",
      rows(k, (i) => `function pick${i} { chosen = root }\npick${i}()`),
      rows(
        k,
        (i) =>
          `say root.f${i} is integer and flagHost\nif chosen.f${i} is integer { repeat chosen.f${i} {} }`,
      ),
      "exit",
    );
  return lines(
    `let root = {wrap: {${fields(k, () => '"x"')}}}`,
    "let picked = root.wrap",
    rows(
      k,
      (i) =>
        `function take${i} {\nlet checked${i} = root.wrap.f${i} is integer and root.wrap.f${i} == 1\npicked = root.wrap\n}\ntake${i}()`,
    ),
    rows(k, (i) => `say picked.f${i} + "tail"`),
    "exit",
  );
}

/** k named files each calling the first of a chain of k global functions (r4.28). */
function w41(k: number, terminal: "return" | "exit" | "end"): readonly SourceFile[] {
  return [
    file(
      "main.tease",
      lines(
        rows(k, (i) => `global function hop${i} { ${i + 1 < k ? `hop${i + 1}()` : terminal} }`),
        rows(k, (i) => `call "leaf${i}.tease"`),
        "exit",
      ),
    ),
    ...Array.from({ length: k }, (_, i) => file(`leaf${i}.tease`, "hop0()\nend")),
  ];
}

/**
 * One root with k sibling fields, each stored, projected into its own variable and read through it (#1026): a record's
 * fields, a dict's values under computed keys, or fields stored and read two steps below the projection.
 */
function w44(k: number, variant: "fields" | "dict" | "deep"): string {
  const below = variant === "deep" ? ".g.v" : ".v";
  const field = (i: number): string => (variant === "dict" ? `[key${i}]` : `.f${i}`);
  return lines(
    variant === "dict"
      ? `let root = dict{${fields(k, () => "{v: 1}")}}`
      : `let root = {${fields(k, () => (variant === "deep" ? "{g: {v: 1}}" : "{v: 1}"))}}`,
    ...(variant === "dict" ? [rows(k, (i) => `let key${i} = "f${i}"`)] : []),
    rows(k, (i) => `root${field(i)}${below} = 2`),
    rows(k, (i) => `let p${i} = root${field(i)}\nrepeat p${i}${below} {}`),
    "exit",
  );
}

/**
 * k destinations that each copy one source and then store another, both with k stored fields, each read at its own
 * field (#1026 review r1's N3): the same two roots under a flag or unconditionally, k small first sources beside one
 * wide second, or one wide first beside k small seconds.
 */
function w45(k: number, variant: "flag" | "plain" | "firsts" | "seconds"): string {
  const wide = (name: string): string =>
    lines(
      `let ${name} = {${fields(k, () => "1")}}`,
      rows(k, (i) => `${name}.f${i} = 2`),
    );
  const small = (name: string, i: number): string =>
    lines(`let ${name}${i} = {f${i}: 1}`, `${name}${i}.f${i} = 2`);
  const first = (i: number): string => (variant === "firsts" ? `a${i}` : "a");
  const second = (i: number): string => (variant === "seconds" ? `b${i}` : "b");
  return lines(
    'let flag = askBoolean "pick"',
    variant === "firsts" ? rows(k, (i) => small("a", i)) : wide("a"),
    variant === "seconds" ? rows(k, (i) => small("b", i)) : wide("b"),
    rows(
      k,
      (i) =>
        `let d${i} = ${first(i)}\n${variant === "plain" ? `d${i} = ${second(i)}` : `if flag { d${i} = ${second(i)} }`}\nrepeat d${i}.f${i} {}`,
    ),
    "exit",
  );
}

export const WORK_FAMILIES: readonly WorkFamily[] = [
  {
    name: "W1",
    measures: "O5, O7: k chapters calling a shared function that updates k scores",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `global score${i} = 0`),
          "function advanceDay {",
          rows(k, (i) => `score${i} += 1`),
          "}",
          rows(k, (i) => `function chapter${i} {\nsay "Chapter ${i}"\nadvanceDay()\n}`),
          rows(k, (i) => `chapter${i}()`),
          rows(k, (i) => `let shown${i}: integer = score${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "W2-integer",
    measures: "X6: the dispatcher, one global site list",
    program: (k) => main(w2(k, "1")),
  },
  {
    name: "W2-fractional",
    measures: "X6: the dispatcher, one global site list",
    program: (k) => main(w2(k, "1.5")),
  },
  {
    name: "W3",
    measures: "F6: k inventories cleared and refilled",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let inventory${i} = ["map"]`),
          'let pick = askChoice ["keep", "reset"]',
          rows(
            k,
            (i) =>
              `if pick == "reset" {\ninventory${i}.clear()\nrepeat 2 { inventory${i}.add("key") }\n}`,
          ),
          rows(k, (i) => `let item${i}: string = inventory${i}.first`),
          "exit",
        ),
      ),
  },
  {
    name: "W4",
    measures: "F12, O17: a list of records with k counters, k presets and a reset loop",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "0", "c")}}`,
          "let party = [seed, seed]",
          rows(k, (i) => `let preset${i} = seed\npreset${i}.c${i} = 1`),
          rows(k, (i) => `if flagHost { party[0] = preset${i} }`),
          "for member in party {",
          rows(k, (i) => `member.c${i} = 0`),
          "}",
          rows(k, (i) => `let shown${i}: integer = party[0].c${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "W5",
    measures: "§8 contract: one text-valued preset over k numeric fields",
    program: (k) =>
      main(
        lines(
          `let state = {${fields(k, () => "0")}}`,
          `let preset = {${fields(k, () => '"none"')}}`,
          "function restore { if flagHost { state = preset } }",
          rows(k, (i) => `function chapter${i} {\nrestore()\nlet shown${i} = state.f${i}\n}`),
          rows(k, (i) => `chapter${i}()`),
          "exit",
        ),
      ),
  },
  {
    name: "W6",
    measures: "F11: k fields replaced by k presets",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "0")}}`,
          "let state = seed",
          rows(k, (i) => `let preset${i} = seed\npreset${i}.f${i} = ${i % 4 === 0 ? "1.5" : "1"}`),
          rows(k, (i) => `if flagHost { state = preset${i} }`),
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "W7",
    measures: "X4: k labels with backedges",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          rows(
            k,
            (i) => `label l${i}\nlet r${i}: integer = n\nn = ${i}\nif flagHost { goto l${i} }`,
          ),
          "exit",
        ),
      ),
  },
  {
    name: "W9",
    measures: "§8 contract: k aliases of one preset",
    program: (k) =>
      main(
        lines(
          'let preset = {score: 1, name: "a"}',
          rows(k, (i) => `let alias${i} = preset`),
          "if flagHost { preset.score = 1.5 }",
          rows(k, (i) => `let shown${i}: integer = alias${i}.score`),
          "exit",
        ),
      ),
  },
  {
    name: "W10",
    measures: "§8 contract: a list literal of k copies of one record",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "0")}}`,
          `let all = [${Array.from({ length: k }, () => "seed").join(", ")}]`,
          "if flagHost { all[0].f0 = 1.5 }",
          rows(k, (i) => `let shown${i}: integer = all.first.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "W11",
    measures: "X6: k functions storing one key, k reads before their calls",
    program: (k) =>
      main(
        lines(
          "let count = 1",
          rows(k, (i) => `function set${i} { count = 1.5 }`),
          rows(k, (i) => `let shown${i}: integer = count\nset${i}()`),
          "exit",
        ),
      ),
  },
  { name: "W12-ladder", measures: "X6: a fan-in ladder", program: (k) => main(w12(k, "ladder")) },
  {
    name: "W12-chain",
    measures: "X6: a chain of single-caller wrappers",
    program: (k) => main(w12(k, "chain")),
  },
  {
    name: "W12-diamonds",
    measures: "X6: k nested diamonds",
    program: (k) => main(w12(k, "diamonds")),
  },
  ...(["calls", "goto", "mixed", "functions"] as const).map((variant) => ({
    name: variant === "calls" ? "W14" : `W14-${variant}`,
    measures: "X7, H6: a registration behind an adversely ordered chain",
    program: (k: number) => w14(k, variant),
  })),
  {
    name: "W15",
    measures: "§8 contract: k presets of one seed, each changing sparse fields",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "0")}}`,
          "let state = seed",
          rows(
            k,
            (i) =>
              `let preset${i} = seed\npreset${i}.f${i} = 1\npreset${i}.f${(i * 7 + 3) % k} = 2`,
          ),
          rows(k, (i) => `if flagHost { state = preset${i} }`),
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "W16",
    measures: "X6: the per-prefix lists",
    program: (k) =>
      main(
        lines(
          `let first = {${fields(k, () => "0")}}`,
          `let second = {${fields(k, () => "1")}}`,
          "let state = first",
          rows(k, (i) => `state.f${i} = 2`),
          rows(k, (i) => `if flagHost { state = ${i % 2 === 1 ? "first" : "second"} }`),
          rows(k, (i) => `let shown${i}: integer = state.f${i} / 2`),
          "exit",
        ),
      ),
  },
  ...([1, 2] as const).map((depth) => ({
    name: depth === 1 ? "W17-one" : "W17-two",
    measures: "§8 literal index: k records with distinct fields below shared properties",
    program: (k: number) =>
      main(
        lines(
          `let x = [${Array.from({ length: k }, (_, i) => `{child: ${depth === 1 ? `{p${i}: ${i}}` : `{inner: {p${i}: ${i}}}`}}`).join(", ")}]`,
          "x = []",
          "exit",
        ),
      ),
  })),
  ...(["wrapped", "quiet", "number", "valid"] as const).map((variant) => ({
    name: `W18-${variant}`,
    measures: "F12: k copies of one record inside a literal",
    program: (k: number) => main(w18(k, variant)),
  })),
  ...(["sources", "record"] as const).map((variant) => ({
    name: `W19-${variant}`,
    measures: "§3.2: k guarded copies of one record inside a literal",
    program: (k: number) => main(w19(k, variant)),
  })),
  ...([true, false] as const).map((changed) => ({
    name: changed ? "W20-changed" : "W20-quiet",
    measures: "§8: two element steps over k copies",
    program: (k: number) =>
      main(
        lines(
          `let source = [{${fields(k, () => "1")}}]`,
          rows(k, (i) => `let snapshot${i} = source`),
          `let archive = [${Array.from({ length: k }, (_, i) => `snapshot${i}`).join(", ")}]`,
          ...(changed ? [rows(k, (i) => `source[0].f${i} = 1.5`)] : []),
          rows(k, (i) => `let checked${i}: integer = archive.first.first.f${i}`),
          "exit",
        ),
      ),
  })),
  ...(["fields", "roots", "same"] as const).map((variant) => ({
    name: `W21-${variant}`,
    measures: "§3.2: the guard index per tested key",
    program: (k: number) => main(w21(k, variant)),
  })),
  ...([true, false] as const).map((chained) => ({
    name: chained ? "W22-and" : "W22-separate",
    measures: "§3.2: one `and` of k tests",
    program: (k: number) =>
      main(
        lines(
          `let box = {${fields(k, () => "1")}}`,
          chained
            ? `if ${Array.from({ length: k }, (_, i) => `box.f${i} is integer`).join(" and ")} and box.f${k - 1} > 0 { say "ok" }`
            : rows(k, (i) => `if box.f${i} is integer { say "ok" }`),
          "exit",
        ),
      ),
  })),
  ...(["calls", "changed", "hoisted"] as const).map((variant) => ({
    name: `W23-${variant}`,
    measures: "§8: one source identity per callee result",
    program: (k: number) => main(w23(k, variant)),
  })),
  ...W24_VARIANTS.map((variant) => ({
    name: `W24-${variant}`,
    measures: "§8: one identity function, guard scope no identity",
    program: (k: number) => main(w24(k, variant)),
  })),
  ...(["stores", "nested", "changed", "aliases"] as const).map((variant) => ({
    name: `W25-${variant}`,
    measures: "§8: one identity function on the store path",
    program: (k: number) => main(w25(k, variant)),
  })),
  ...(["repeated", "scope", "hoisted"] as const).map((variant) => ({
    name: `W26-${variant}`,
    measures: "§8: provenance as a charged set",
    program: (k: number) => main(w26(k, variant)),
  })),
  ...([true, false] as const).map((registration) => ({
    name: registration ? "W35-registration" : "W35-plain",
    measures: "G1: returnability shared per file",
    program: (k: number) => w35(k, registration),
  })),
  ...(["inside", "varied", "wrapper", "extra-alias"] as const).map((variant) => ({
    name: `W36-${variant}`,
    measures: "§8: one mark holder per (source, projection)",
    program: (k: number) => main(w36(k, variant)),
  })),
  ...([false, true] as const).map((hoisted) => ({
    name: hoisted ? "W37-hoisted" : "W37",
    measures: "§8: mark references compose, never copy",
    program: (k: number) => main(w37(k, hoisted)),
  })),
  {
    name: "W38",
    measures: "§8: an alias forest merged into one place",
    program: (k) => main(w38(k)),
  },
  ...([true, false] as const).map((registration) => ({
    name: registration ? "W39-registration" : "W39-plain",
    measures: "G1: the returnability worklist",
    program: (k: number) => w39(k, registration),
  })),
  ...([false, true] as const).map((files) => ({
    name: files ? "W40-files" : "W40-functions",
    measures: "§8: the holder's groups indexed by the tested path",
    program: (k: number) => w40(k, files),
  })),
  ...(["logical", "operands"] as const).map((variant) => ({
    name: `W40-${variant}`,
    measures: "§8: logical-operand tests indexed at their callable",
    program: (k: number) => main(w40l(k, variant)),
  })),
  ...(["return", "exit", "end"] as const).map((terminal) => ({
    name: `W41-${terminal}`,
    measures: "G1: no function × calling-file closure",
    program: (k: number) => w41(k, terminal),
  })),
  {
    name: "W42",
    measures: "G1: one block-end fact per running file",
    program: (k) => [
      file(
        "main.tease",
        lines(
          rows(k, (i) => `showPermanentButton "b${i}" { end }`),
          rows(k, (i) => `call "leaf${i}.tease"`),
          "exit",
        ),
      ),
      ...Array.from({ length: k }, (_, i) => file(`leaf${i}.tease`, "wait 1 s\nend")),
    ],
  },
  {
    name: "W43",
    measures: "G1: edges as a set",
    program: (k) => [
      file(
        "main.tease",
        lines(
          rows(k, (i) => `call "leaf${i}.tease"`),
          "exit",
        ),
      ),
      ...Array.from({ length: k }, (_, i) => file(`leaf${i}.tease`, 'goto "tail.tease"')),
      file("tail.tease", "end"),
    ],
  },
];

/** W45 (r4.46 (3)): a destination's second copied source is referenced, never flattened into it per destination. */
export const W45_VARIANTS: readonly WorkFamily[] = (
  ["flag", "plain", "firsts", "seconds"] as const
).map((variant) => ({
  name: `W45-${variant}`,
  measures: "r4.46 (3): a joined copy's sources referenced once per destination",
  program: (k: number) => main(w45(k, variant)),
}));

/**
 * W44 (r4.46 (3)): the width axis of one root's keys under projected copies, gated in both orders as W34 is; and k
 * copies of an object's own property named as a dict's list, read at k fields below it (#1026 review r1).
 */
export const W44_VARIANTS: readonly WorkFamily[] = [
  ...(["fields", "dict", "deep"] as const).map((variant) => ({
    name: `W44-${variant}`,
    measures: "r4.46 (3): a projected copy's stores found below its path alone",
    program: (k: number) => main(w44(k, variant)),
  })),
  {
    name: "W44-own-values",
    measures: "§8 r4.15: copies of an object's own `values` are one source",
    program: (k) =>
      main(
        lines(
          `let root = {values: {${fields(k, () => "7")}}}`,
          `let many = [${Array.from({ length: k }, () => "root.values").join(", ")}]`,
          rows(k, (i) => `repeat many.first.f${i} {}`),
          "exit",
        ),
      ),
  },
];

/** A W34 chain: a k-field record replaced by one of nulls under the flag, k whole copies, the last read at k fields. */
function w34Chain(
  k: number,
  record: (value: string) => string,
  field: (index: number) => string,
  link: (index: number) => string,
): string {
  const values = (value: string): string => record(`{${fields(k, () => value)}}`);
  return lines(
    `let box0 = ${values("1")}`,
    `if flagHost { box0 = ${values("null")} }`,
    rows(k, link),
    rows(k, (i) => `repeat box${k}.${field(i)} {}`),
  );
}

/** A W34 fan: k copies of one tested record, each read at the field its own test tests. */
function w34Fan(k: number, copy: (index: number) => string): string {
  return lines(
    `let root = {${fields(k, () => "1")}}`,
    `if flagHost { root = {${fields(k, () => "null")}} }`,
    rows(k, copy),
  );
}

/** A W34 source redefined k times from one record, each definition followed by its own statements. */
function w34Redefined(k: number, each: (index: number) => string, after: string): string {
  return lines(
    `let base = {${fields(k + 1, () => "1")}}`,
    `if flagHost { base = {${fields(k + 1, () => "null")}} }`,
    "let seed = base",
    rows(k, (i) => `seed = base\n${each(i)}`),
    after,
  );
}

const plainRecord = (literal: string): string => literal;
const plainField = (index: number): string => `f${index}`;

/** The chain variants of W34: the statements of each link before the next copy, or around it. */
const W34_LINKS: readonly (readonly [string, (index: number) => string])[] = [
  ["plain", (i: number) => `let box${i + 1} = box${i}`],
  ["tested", (i: number) => `if box${i}.f0 != null {}\nlet box${i + 1} = box${i}`],
  ["different", (i: number) => `if box${i}.f${i} != null {}\nlet box${i + 1} = box${i}`],
  [
    "guarded",
    (i: number) => `if box${i}.f0 != null { repeat box${i}.f0 {} }\nlet box${i + 1} = box${i}`,
  ],
  [
    "copies-of-copies",
    (i: number) => `if box${i}.f0 != null {}\nlet alias${i} = box${i}\nlet box${i + 1} = alias${i}`,
  ],
  [
    "copy-test",
    (i: number) =>
      `let box${i + 1} = box${i}\nif box${i + 1}.f${i} != null { repeat box${i + 1}.f${i} {} }`,
  ],
  [
    "stores",
    (i: number) =>
      `if box${i}.f${i} != null {}\nif flagHost { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`,
  ],
  [
    "interleaved-stores",
    (i: number) => `if flagHost { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`,
  ],
  ["exit-tested", (i: number) => `if box${i}.f0 == null { exit }\nlet box${i + 1} = box${i}`],
  [
    "exit-tested-own-fields",
    (i: number) => `if box${i}.f${i} == null { exit }\nlet box${i + 1} = box${i}`,
  ],
  [
    "guarded-siblings",
    (i: number) =>
      `if box${i}.f0 != null {\nlet side${i} = box${i}\nrepeat side${i}.f0 {}\n}\nlet box${i + 1} = box${i}\nrepeat box${i + 1}.f0 {}`,
  ],
];

/**
 * W34 (TABLE §13.3, r4.33–r4.38) as the reference model's round-10 generators write it (`fresh.py`, `fan-probe.py`,
 * `siblings.py`): a chain of k whole copies of a k-field record read at k fields of the last copy, plain, with a test
 * on the source before each copy (of one field, of the copy's own field, guarding a read), through an alias, nested a
 * level, tested after each copy, with a conditional store below each source (tested and not); and k sibling copies of
 * one record under tests of their own fields (one test, two nested, an unrelated test before the copy, one `and` chain
 * over all k fields). Review round 2's shapes beside them: chains after early exits on one field (read at the others,
 * and every copy read at it) and on each copy's own field, guarded sibling copies along a chain, k unrelated edited
 * records with one field name, k edited siblings of one copy, k copies of one record edited at k fields; round 3's:
 * one source defined k times, each definition copied after an early exit (on one field, on its own field) or with k
 * stores below the source, and k sources of two copied definitions each; round 4's: a source redefined from its own
 * copies under one test, k sources of five copied definitions each, a source tested at k paths and redefined k times
 * beside four more sources tested there. Every copy is resolved once and read once per field: k + k, never k × k.
 */
/**
 * A record passed down k single-site functions, each passing its parameter on as `step` writes the call; the last reads
 * every field (review r5: k bindings and k fields, resolved per binding and per field, never per pair).
 */
const argumentChain = (k: number, step: (index: number) => string): string =>
  lines(
    `let seed = {guard: 1, ${fields(k, () => "1")}}`,
    `if flagHost { seed = {guard: 1, ${fields(k, () => "null")}} }`,
    rows(k, (j) =>
      j === k - 1
        ? `function use${j}(p${j}) {\n${rows(k, (i) => `repeat p${j}.f${i} {}`)}\nreturn true\n}`
        : `function use${j}(p${j}) {\n${step(j)}\nreturn true\n}`,
    ),
    "use0(seed)",
  );

export const W34_VARIANTS: readonly WorkFamily[] = W34_LINKS.map(([variant, link]): WorkFamily => ({
  name: `W34-${variant}`,
  measures: "§13.3 W34: a copy chain resolved once per copy, projected per field",
  program: (k) => main(w34Chain(k, plainRecord, plainField, link)),
})).concat([
  {
    name: "W34-nested",
    measures: "§13.3 W34: a copy chain resolved once per copy, projected per field",
    program: (k) =>
      main(
        w34Chain(
          k,
          (literal) => `{inner: ${literal}}`,
          (i) => `inner.f${i}`,
          (i) => `if box${i}.inner.f0 != null {}\nlet box${i + 1} = box${i}`,
        ),
      ),
  },
  {
    name: "W34-exit-tested-every-copy",
    measures: "§13.3 W34 r4.38: a chain's marks found per path, each copy read once",
    program: (k) =>
      main(
        lines(
          `let box0 = {${fields(k, () => "1")}}`,
          `if flagHost { box0 = {${fields(k, () => "null")}} }`,
          rows(k, (i) => `if box${i}.f0 == null { exit }\nlet box${i + 1} = box${i}`),
          rows(k, (i) => `repeat box${i + 1}.f0 {}`),
        ),
      ),
  },
  {
    name: "W34-independent-stores",
    measures: "§13.3 W34 r4.38: a store's stop found per path within its own copies",
    program: (k) =>
      main(
        rows(
          k,
          (i) => `let r${i} = {f0: 1.5}\nr${i}.f0 = 1\nlet a${i} = r${i}\nrepeat a${i}.f0 {}`,
        ),
      ),
  },
  {
    name: "W34-sibling-stores",
    measures: "§13.3 W34 r4.38: a store's stop found per path within its own copies",
    program: (k) =>
      main(
        lines(
          "let seed = {f0: 1, f1: 1}",
          "if flagHost { seed = {f0: null, f1: null} }",
          "let base = seed",
          rows(
            k,
            (i) =>
              `let a${i} = base\nif flagHost { a${i}.f0 = 2 }\nlet b${i} = a${i}\nrepeat b${i}.f0 {}\nrepeat b${i}.f1 {}`,
          ),
        ),
      ),
  },
  {
    name: "W34-fan-stores",
    measures: "§13.3 W34 r4.38: a store's stop found per path within its own copies",
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          `if flagHost { root = {${fields(k, () => "null")}} }`,
          rows(k, (i) => `if flagHost { root.f${i} = 2 }`),
          rows(k, (i) => `let copy${i} = root\nrepeat copy${i}.f${i} {}`),
        ),
      ),
  },
  {
    name: "W34-redefined-exit-tested",
    measures: "§13.3 W34 r4.38: k definitions of one source, each copied after a test",
    program: (k) =>
      main(
        w34Redefined(
          k,
          (i) => `if seed.f0 == null { exit }\nlet a${i} = seed\nrepeat a${i}.f0 {}`,
          "",
        ),
      ),
  },
  {
    name: "W34-redefined-exit-tested-own-fields",
    measures:
      "§13.3 W34 r4.38: k definitions of one source, each copied after a test of its own field",
    program: (k) =>
      main(
        w34Redefined(
          k,
          (i) => `if seed.f${i} == null { exit }\nlet a${i} = seed\nrepeat a${i}.f${i} {}`,
          "",
        ),
      ),
  },
  {
    name: "W34-redefined-stores",
    measures: "§13.3 W34 r4.38: k definitions of one source, each copied, and k stores below it",
    program: (k) =>
      main(
        w34Redefined(
          k,
          (i) => `let a${i} = seed\nrepeat a${i}.f0 {}`,
          rows(k, (i) => `seed.f${i + 1} = 1`),
        ),
      ),
  },
  {
    name: "W34-redefined-independent",
    measures:
      "§13.3 W34 r4.38: k sources of two copied definitions each, a store at one shared path",
    program: (k) =>
      main(
        rows(
          k,
          (i) =>
            `let r${i} = {f0: 1.5}\nlet b${i} = r${i}\nr${i} = {f0: 2.5}\nr${i}.f0 = 1\nlet a${i} = r${i}\nrepeat a${i}.f0 {}\nrepeat b${i}.f0 {}`,
        ),
      ),
  },
  {
    name: "W34-redefined-through-copies",
    measures: "§13.3 W34 r4.38: a source redefined from its own copies k times, one test of it",
    program: (k) =>
      main(
        lines(
          `let base = {${fields(k, () => "1")}}`,
          `if flagHost { base = {${fields(k, () => "null")}} }`,
          "let seed = base",
          'if seed != null { say "tested" }',
          rows(k, (i) => `let a${i} = seed\nseed = a${i}`),
          rows(k, (i) => `repeat seed.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-redefined-five-times-independent",
    measures:
      "§13.3 W34 r4.38: k sources of five copied definitions each, a store at one shared path",
    program: (k) =>
      main(
        lines(
          rows(
            k,
            (i) =>
              `let seed${i} = {f0: 1.5}\nlet a${i}_0 = seed${i}\n${rows(4, (j) => `seed${i} = {f0: 2.5}\nlet a${i}_${j + 1} = seed${i}`)}\nseed${i}.f0 = 1`,
          ),
          rows(k, (i) => `repeat a${i}_0.f0 {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-redefined-beside-tested-sources",
    measures:
      "§13.3 W34 r4.38: a source tested at k paths and redefined k times beside four sources tested there",
    program: (k) =>
      main(
        lines(
          `let base = {${fields(k, () => "1")}}`,
          `if flagHost { base = {${fields(k, () => "null")}} }`,
          rows(
            4,
            (j) =>
              `let side${j} = base\n${rows(k, (i) => `if side${j}.f${i} == null { say "side" }`)}`,
          ),
          "let seed = base",
          rows(k, (i) => `if seed.f${i} == null { exit }`),
          rows(k, (i) => `seed = base\nlet a${i} = seed`),
          rows(k, (i) => `repeat a${i}.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-fan-marked",
    measures: "§13.3 W34 r4.38: a copy's marks asked per path and guard scope",
    program: (k) =>
      main(
        w34Fan(
          k,
          (i) =>
            `if root.f${i} != null {\nif root.f${i} > 0 {\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}\n}`,
        ),
      ),
  },
  {
    name: "W34-fan-unmarked",
    measures: "§13.3 W34 r4.38: a copy's marks asked per path and guard scope",
    program: (k) =>
      main(
        w34Fan(
          k,
          (i) =>
            `if root.f${i} != null {\nif root.f${i} > 0 {}\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}`,
        ),
      ),
  },
  {
    name: "W34-fan-narrowing",
    measures: "§13.3 W34 r4.38: a copy's marks asked per path and guard scope",
    program: (k) =>
      main(
        w34Fan(
          k,
          (i) => `if root.f${i} != null {\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}`,
        ),
      ),
  },
  {
    name: "W34-fan-and-chain",
    measures: "§13.3 W34 r4.38: k copies in one guard scope share its marks",
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          `if flagHost { root = {${fields(k, () => "null")}} }`,
          `if ${Array.from({ length: k }, (_, i) => `root.f${i} != null`).join(" and ")} {`,
          rows(k, (i) => `let copy${i} = root\nrepeat copy${i}.f${i} {}`),
          "}",
        ),
      ),
  },
  {
    name: "W34-argument-chain",
    measures: "§13.3 W34 (review r5): a record passed down k calls and read at k fields",
    program: (k) => main(argumentChain(k, (j) => `use${j + 1}(p${j})`)),
  },
  {
    name: "W34-argument-operands",
    measures:
      "§13.3 W34 r4.38 (review r5): the same, each call in an operand a test of an unread field guards",
    program: (k) =>
      main(argumentChain(k, (j) => `if p${j}.guard != null and use${j + 1}(p${j}) {}`)),
  },
  {
    name: "W34-argument-own-tests",
    measures:
      "§13.3 W34 r4.38: the same, each call in an operand a test of the field it passes on guards",
    program: (k) =>
      main(argumentChain(k, (j) => `if p${j}.f${j} != null and use${j + 1}(p${j}) {}`)),
  },
  {
    name: "W34-captured-own-tests",
    measures:
      "§13.3 W34 (review r6): a record captured into one global down k calls, each testing its own field, read at k fields",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          `if flagHost { seed = {${fields(k, () => "null")}} }`,
          rows(k, (j) =>
            lines(
              `function use${j}(p${j}) {`,
              `seed = p${j}`,
              j === k - 1
                ? rows(k, (i) => `repeat seed.f${i} {}`)
                : `if seed.f${j} != null { use${j + 1}(seed) }`,
              "return true",
              "}",
            ),
          ),
          "use0(seed)",
        ),
      ),
  },
  {
    name: "W34-fanout-tested-callables",
    measures:
      "§13.3 W34 (review r7): one source passed to k functions that each test it and copy it",
    program: (k) =>
      main(
        lines(
          'let seed = {f: fromJson("2", default: null, files: false)}',
          rows(k, (i) =>
            lines(
              `function use${i}(p) {`,
              "seed = p",
              "if seed.f is integer {",
              "let snap = seed",
              "repeat snap.f {}",
              "}",
              "}",
            ),
          ),
          rows(k, (i) => `use${i}(seed)`),
        ),
      ),
  },
  {
    name: "W34-fanout-tested-exits",
    measures:
      "§13.3 W34 (review r7): k fields each tested in five functions that each pass the source on k times, read once",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          `if flagHost { seed = {${fields(k, () => "null")}} }`,
          rows(5, (c) =>
            lines(
              rows(k, (j) =>
                lines(
                  `function u${c}_${j}(r) {`,
                  "seed = r",
                  "let snap = seed",
                  c === 0 && j === 0 ? rows(k, (i) => `repeat snap.f${i} {}`) : 'say "u"',
                  "return true",
                  "}",
                ),
              ),
              `function t${c}(p) {`,
              "seed = p",
              rows(k, (i) => `if seed.f${i} != null { say "t" }`),
              rows(k, (j) => `u${c}_${j}(seed)`),
              "return true",
              "}",
            ),
          ),
          rows(5, (c) => `t${c}(seed)`),
        ),
      ),
  },
  {
    name: "W34-fanout-distinct-exits",
    measures:
      "§13.3 W34 (review r8): k fields tested by one condition in five functions, each passing k redefinitions on",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => 'fromJson("1", default: null, files: false)')}}`,
          rows(5, (c) =>
            lines(
              rows(k, (j) =>
                lines(
                  `function u${c}_${j}(r) {`,
                  "seed = r",
                  "let snap = seed",
                  c === 0 && j === 0 ? rows(k, (i) => `repeat snap.f${i} {}`) : 'say "u"',
                  "return true",
                  "}",
                ),
              ),
              `function t${c}(p) {`,
              "seed = p",
              `if ${Array.from({ length: k }, (_, i) => `seed.f${i} != null`).join(" and ")} {`,
              rows(k, (j) => `seed = p\nu${c}_${j}(seed)`),
              "}",
              "return true",
              "}",
            ),
          ),
          rows(5, (c) => `t${c}(seed)`),
        ),
      ),
  },
]);

/** A family whose work is a known product, accepted as measured: its doubling at k = 64 → 128, the steeper order's. */
export interface KnownProduct extends WorkFamily {
  readonly measured: number;
}

/** The sum of `(a_i otherwise 0)` for i in [lo, hi), as a balanced tree of `+`. */
const balancedSum = (lo: number, hi: number): string =>
  hi - lo === 1
    ? `(a${lo} otherwise 0)`
    : `(${balancedSum(lo, (lo + hi) >> 1)} + ${balancedSum((lo + hi) >> 1, hi)})`;

/** A k-field record's literal, every field `value`. */
const record = (k: number, value: string): string => `{${fields(k, () => value)}}`;

/**
 * Stage 3b's families (TABLE §13.3, W27–W34 and the tested-copy variant), as §13.3 defines them: each makes the
 * narrowing index's construction or its queries a product of two program dimensions in some realization of it. They are
 * measured with every read's narrowing and route asked (`tests/helpers/type-core-narrowing.ts`), as the consumers will
 * ask them; N5's (W29 and its variants) through the analysis too, whose stored values read their narrowings (S10 part
 * 2b).
 */
export const NARROWING_FAMILIES: readonly WorkFamily[] = [
  {
    name: "W27",
    measures: "N2: k narrowings of one key, k reads, one binary search each",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "if flagHost { n = null }",
          rows(k, () => "if n != null { repeat n {} }"),
          "exit",
        ),
      ),
  },
  {
    name: "W27-unsuccessful",
    measures:
      "N3: k null stores in leaving branches before k uses, the nearest candidate examined once",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          rows(k, () => "if flagHost { n = null\nexit }"),
          rows(k, () => "repeat n {}"),
          "exit",
        ),
      ),
  },
  {
    name: "W28",
    measures: "N2: k nested tests on k path texts of one element key, k reads of the earliest path",
    program: (k) =>
      main(
        lines(
          `let xs = [${cells(k, "1")}, null]`,
          rows(k, (i) => `if xs[${i}] == null { exit }`),
          rows(k, () => "repeat xs[0] {}"),
          "exit",
        ),
      ),
  },
  ...(
    [
      ["W29", (i: number) => `xs[${i}] = 1`],
      ["W29-same-path", (i: number) => `xs[i${i}] = 1`],
    ] as const
  ).map(([name, store]): WorkFamily => ({
    name,
    measures: "N5: k tests of `xs[i_j]` around a loop with k reads and k element stores, k × log",
    program: (k) =>
      main(
        lines(
          `let xs = [${cells(k, "1")}, null]`,
          rows(k, (i) => `let i${i} = ${i}`),
          rows(k, (i) => `if xs[i${i}] == null { exit }`),
          "repeat 2 {",
          rows(k, (i) => `repeat xs[i${i}] {}`),
          rows(k, store),
          "}",
          "exit",
        ),
      ),
  })),
  {
    name: "W29-scalar",
    measures: "N5: k preserving stores to k scalar locations in one loop, one evaluation each",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let v${i} = 1\nif flagHost { v${i} = null }`),
          rows(k, (i) => `if v${i} == null { exit }`),
          "repeat 2 {",
          rows(k, (i) => `repeat v${i} {}\nv${i} = v${i} + 1`),
          "}",
          "exit",
        ),
      ),
  },
  ...(
    [
      ["W29-wide-chain", "null"],
      ["W29-wide-ring", "total otherwise null"],
    ] as const
  ).map(([name, last]): WorkFamily => ({
    name,
    measures:
      "N5 (Astra's G2): a wide surviving store whose k operands' facts are lost one by one, each loss one operand's work",
    // (the k operands summed as a balanced tree)
    program: (k) =>
      main(
        lines(
          "let keep: boolean = hostValue",
          rows(k, (i) => `let a${i}: integer? = hostValue`),
          "let total: integer? = 0",
          `if total != null and ${rows(k, (i) => `a${i} != null`).replaceAll("\n", " and ")} {`,
          "while keep {",
          `total = ${balancedSum(0, k)}`,
          rows(k - 1, (i) => `a${i} = a${i + 1}`),
          `a${k - 1} = ${last}`,
          "repeat total {}",
          "}",
          "}",
          "exit",
        ),
      ),
  })),
  // (W29-wide-ring read through one wide gather: a literal of its k values, of computed ones, of records holding them, or
  // a choice of k options: a changed value re-runs the gather's nodes above it, never the whole gather)
  ...(
    [
      [
        "literal",
        (k: number) =>
          `let xs = [${rows(k, (i) => `a${i}`).replaceAll("\n", ", ")}]\ntotal = xs[i] otherwise 0`,
      ],
      [
        "computed",
        (k: number) =>
          `let xs = [${rows(k, (i) => `a${i} otherwise null`).replaceAll("\n", ", ")}]\ntotal = xs[i] otherwise 0`,
      ],
      [
        "sums",
        (k: number) =>
          `let xs = [${rows(k, (i) => `a${i} + 0`).replaceAll("\n", ", ")}]\ntotal = xs[i] otherwise 0`,
      ],
      [
        "records",
        (k: number) =>
          `let xs = [${rows(k, (i) => `{n: a${i}}`).replaceAll("\n", ", ")}]\ntotal = xs[i].n otherwise 0`,
      ],
      [
        "choice",
        (k: number) =>
          `total = (askChoice ${rows(k, (i) => `{text: "${i}", value: a${i}}`).replaceAll("\n", ", ")}) otherwise 0`,
      ],
      [
        "choice-list",
        (k: number) =>
          `total = (askChoice [${rows(k, (i) => `{text: "${i}", value: a${i}}`).replaceAll("\n", ", ")}]) otherwise 0`,
      ],
      [
        "choice-values",
        (k: number) =>
          `total = (askChoice [${rows(k, (i) => `a${i}`).replaceAll("\n", ", ")}]) otherwise 0`,
      ],
    ] as const
  ).map(([variant, read]): WorkFamily => ({
    name: `W29-wide-ring-${variant}`,
    measures: `N5: W29-wide-ring read through a wide ${variant} gather: a changed value re-runs the nodes above it`,
    program: (k) =>
      main(
        lines(
          "let i = 0",
          rows(k, (i) => `let a${i}: integer? = 1\nif flagHost { a${i} = null }`),
          "let total: integer? = 0",
          `if total != null and ${rows(k, (i) => `a${i} != null`).replaceAll("\n", " and ")} {`,
          "while flagHost {",
          read(k),
          rows(k - 1, (i) => `a${i} = a${i + 1}`),
          `a${k - 1} = total otherwise null`,
          "}",
          "}",
          "exit",
        ),
      ),
  })),
  {
    name: "W29-guarded-choice",
    measures:
      "N2 (Sol's U3 r1): k options holding one tested record, read at k fields: one value class for one environment",
    program: (k) =>
      main(
        lines(
          `let root = ${record(k, "1")}`,
          "if hostValue { root = null }",
          "if root != null {",
          `let pick = askChoice ${rows(k, (i) => `{text: "${i}", value: root}`).replaceAll("\n", ", ")}`,
          rows(k, (i) => `let f${i} = pick.f${i}`),
          "}",
          "exit",
        ),
      ),
  },
  {
    name: "W29-guarded-choice-loop",
    measures:
      "N2 (Sol's U3 build r1): the same in a loop, its record a loop's own definition, every field stored typed",
    program: (k) =>
      main(
        lines(
          "repeat 2 {",
          "let root = hostValue",
          "if root is object {",
          `let pick = askChoice ${rows(k, (i) => `{text: "${i}", value: root}`).replaceAll("\n", ", ")}`,
          rows(k, (i) => `let f${i}: integer = pick.f${i}`),
          "}",
          "}",
          "exit",
        ),
      ),
  },
  {
    name: "W29-one-location",
    measures:
      "N5: k preserving stores to one location in k branches of one loop, each read through G: k × log, never k²",
    program: (k) =>
      main(
        lines(
          "let v: integer? = 1",
          "if flagHost { v = null }",
          "if v != null {",
          "repeat 2 {",
          rows(k, (i) => `if hostValue == ${i} { v = v + 1 }`),
          "repeat v {}",
          "}",
          "}",
          "exit",
        ),
      ),
  },
  ...(
    [
      ["W30", "!=", "and"],
      ["W30-or", "==", "or"],
    ] as const
  ).map(([name, test, logical]): WorkFamily => ({
    name,
    measures: `N1, N2: one \`${logical}\` chain of k field tests, k reads in its last operand`,
    program: (k) =>
      main(
        lines(
          `let box = ${record(k, "1")}`,
          rows(k, (i) => `if flagHost { box.f${i} = null }`),
          `if ${rows(k, (i) => `box.f${i} ${test} null`).replaceAll("\n", ` ${logical} `)} ${logical} [${rows(k, (i) => `box.f${i} + 1`).replaceAll("\n", ", ")}].length > 0 { say "ready" }`,
          "exit",
        ),
      ),
  })),
  {
    name: "W31",
    measures:
      "N2: k invalidations between k narrowings and k reads, one sorted list per collection",
    program: (k) =>
      main(
        lines(
          `let xs = [${cells(k, "1")}, null]`,
          rows(k, (i) => `if xs[${i}] == null { exit }`),
          rows(k, () => "xs.sort()"),
          rows(k, (i) => `repeat xs[${i}] {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W32",
    measures: "N3: k whole stores of a record with null fields under k branches, read at k fields",
    program: (k) =>
      main(
        lines(
          `let rec = ${record(k, "1")}`,
          rows(k, () => `if flagHost { rec = ${record(k, "null")} }`),
          rows(k, (i) => `repeat rec.f${i} {}`),
          "exit",
        ),
      ),
  },
  ...(
    [
      ["W33", () => "restore()", (i: number) => `repeat v${i} {}`],
      ["W33-header", () => "if restore() > 0 { say 1 }", (i: number) => `repeat v${i} {}`],
      ["W33-earlier-operand", () => "", (i: number) => `repeat restore() + v${i} {}`],
    ] as const
  ).map(([name, call, use]): WorkFamily => ({
    name,
    measures:
      "N3: k optional scalars one function stores, k calls, k uses: one shared list of k call positions",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let v${i} = 1`),
          "function restore {",
          rows(k, (i) => `v${i} = 1`),
          "return 1",
          "}",
          "if flagHost {",
          rows(k, (i) => `v${i} = null`),
          "}",
          rows(k, call),
          rows(k, use),
          "exit",
        ),
      ),
  })),
  {
    name: "W34-record-chain",
    measures:
      "N3: k whole copies of a k-field record read at k fields, refused below the record's kinds",
    program: (k) =>
      main(
        lines(
          `let r0 = ${record(k, "1")}`,
          `if flagHost { r0 = ${record(k, "null")} }`,
          rows(k, (i) => `let r${i + 1} = r${i}`),
          rows(k, (i) => `repeat r${k}.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-scalar-chain",
    measures: "N3: a chain of k scalar copies, each read: one memoised query per copy",
    program: (k) =>
      main(
        lines(
          "let s0 = 1",
          "if flagHost { s0 = null }",
          rows(k, (i) => `let s${i + 1} = s${i}`),
          rows(k, (i) => `repeat s${i + 1} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-scalar-fan",
    measures: "N3: k scalar copies of one source, each read: one memoised query of the source",
    program: (k) =>
      main(
        lines(
          "let s = 1",
          "if flagHost { s = null }",
          rows(k, (i) => `let t${i} = s`),
          rows(k, (i) => `repeat t${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-dead-fallback",
    measures: "N3: a chain of k `otherwise null` copies over a dead fallback, each read",
    program: (k) =>
      main(
        lines(
          "let s0 = 1 otherwise null",
          rows(k, (i) => `let s${i + 1} = s${i} otherwise null`),
          rows(k, (i) => `repeat s${i + 1} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W34-tested-copies",
    measures:
      "§13.3 r4.36: a test on a field of the source before each whole copy, k copies read at k fields",
    program: (k) =>
      main(
        lines(
          `let box0 = ${record(k, "1")}`,
          `if flagHost { box0 = ${record(k, "null")} }`,
          rows(k, (i) => `if box${i}.f${i} != null { say 1 }\nlet box${i + 1} = box${i}`),
          rows(k, (i) => `repeat box${k}.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "W32-copied-record",
    measures:
      "N3: k whole copies of one record under k branches, read at k fields: prefix kills shared, never per field",
    program: (k) =>
      main(
        lines(
          `let source = ${record(k, "1")}`,
          "let box = source",
          rows(k, () => "if flagHost { box = source }"),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "N3-wide-switch",
    measures:
      "N3: a switch of k cases each storing `null`, then k conditional repairs: each arm closed once, no rescans",
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "switch hostValue {",
          rows(k, (i) => `case ${i} { n = null }`),
          "default { n = null }",
          "}",
          "repeat n {}",
          rows(k, (i) => `if hostValue == ${i} { n = 2 }`),
          "repeat n {}",
          "exit",
        ),
      ),
  },
  {
    name: "N3-omitted-default",
    measures:
      "N3: a parameter's omitted `null` default, k conditional stores and k reads: one argument index, never a scan per read",
    program: (k) =>
      main(
        lines(
          "function inspect(n = null) {",
          'let gate = askBoolean "gate"',
          rows(k, (i) => `if gate { n = ${i} }`),
          rows(k, () => "repeat n {}"),
          "}",
          "inspect()",
          "exit",
        ),
      ),
  },
  ...(["is", "is not"] as const).map((test): WorkFamily => ({
    name: `N1-wide-union-${test.replace(" ", "-")}`,
    measures: `N1: \`${test}\` a union naming one kind k times, read k times: each kind filtered once`,
    program: (k) =>
      main(
        lines(
          "let n = 1",
          "if flagHost { n = null }",
          `if n ${test} ${rows(k, () => "integer").replaceAll("\n", " | ")} | null {`,
          rows(k, () => "say n"),
          "}",
          "exit",
        ),
      ),
  })),
];

/**
 * W34's two remaining combinations, gated known limits by the owner's decision (TABLE r4.45, PLAN §6b): more than four
 * sources tested at one path, each with more than four anchors in one tree, read there many times; and sources copied
 * from more than four shared roots, stored at one path every copy reads (review r5's generators). The gate is a
 * regression check on the 64 → 128 growth step only (3.37 and 2.53), not a bound at larger sizes: 128 → 256 already
 * grows 3.62 and 2.82. They are reconsidered when a realistic script shows both dimensions; a change to that lookup
 * re-measures them and proposes the gate with its counts, never retunes it; the linear alternative is a separate PR
 * after S4.
 */
export const W34_KNOWN_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "W34-known-tested-anchors",
    measures:
      "§13.3 W34 r4.41: k sources each tested and redefined through five copies in one tree, read at k fields",
    // 114,507 / 347,723 / 1,170,507 / 4,241,483 units at k = 32 … 256 (review r5: 110,646 / 335,894 / 1,130,454)
    measured: 3.37,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "hostValue")}}`,
          rows(k, (i) =>
            lines(
              `let seed${i} = ${i === 0 ? "root" : `seed${i - 1}`}`,
              `if seed${i} != null { say "tested" }`,
              rows(5, (j) => `let a${i}_${j} = seed${i}\nseed${i} = a${i}_${j}`),
            ),
          ),
          rows(k, (j) => `repeat seed${k - 1}.f${j} {}`),
        ),
      ),
  },
  {
    name: "W34-known-stored-roots",
    measures:
      "§13.3 W34 r4.41: k sources copied from five shared roots, each stored at the path every copy reads",
    // 49,782 / 113,942 / 285,910 / 803,158 units at k = 32 … 256 (review r5: 113,562 / 285,146 / 801,626 from 64)
    measured: 2.53,
    program: (k) =>
      main(
        lines(
          rows(5, (j) => `let root${j} = {f0: hostValue}`),
          rows(k, (i) =>
            lines(
              `let seed${i} = root0`,
              rows(5, (j) => `${j === 0 ? "" : `seed${i} = root${j}\n`}let a${i}_${j} = seed${i}`),
              `seed${i}.f0 = 1`,
            ),
          ),
          rows(k, (i) => `repeat a${i}_0.f0 {}`),
        ),
      ),
  },
];

/** k whole copies of `root`: each of the one before it (a chain), or each of `root` (a fan-out). */
const copiesOf = (k: number, form: "chain" | "fan-out"): string =>
  rows(k, (i) => `let a${i} = ${form === "chain" && i > 0 ? `a${i - 1}` : "root"}`);

/**
 * A4 through copies' work (the owner's reviewer's F1 on #1049, TABLE r4.80): a root of k fields, each a copy of one
 * written binding, and k whole copies of it with no field read, as a chain, a fan-out and one destination stored k
 * times; k objects with a written field, one other field of each stored into one list a copy then reads (his second
 * witness: the scan resumed, never taken again); and their controls: plain fields, one dimension fixed, one field read,
 * the root changed between its copies, each copy storing its own field, those copies held in one literal, cycles of
 * copies the root feeds held in one literal, each copy replaced by another record, the chain closed into a cycle, the
 * root copied into itself at another path; review r3's shapes (a read stored into each copy's own field, literals
 * holding the root read into one list, copies replaced by aliases that store their own field), the design review's
 * and reviews r5's to r7's (two roots met with a narrow projection each, a chain's last copy read at every field, a chain
 * of own fields copied beside a small record each, distinct records held in two lists), and Astra's (a copy storing its
 * plain fields with its written ones read, a copy of a copy storing below each record read whole). A copy costs its own
 * divergences, never its source's every field (r4.51, r4.86 (2)); each is gated with the sharing off too.
 */
export const INHERITED_FIELD_FAMILIES: readonly WorkFamily[] = [
  ...(["chain", "fan-out"] as const).map((form): WorkFamily => ({
    name: `A4-inherited-${form}`,
    measures: `A4 through copies, r4.80: a root of k written-typed fields and a ${form} of k whole copies, no field read`,
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(k, form),
          "exit",
        ),
      ),
  })),
  {
    name: "A4-inherited-repeated",
    measures:
      "A4 through copies, r4.80: a root of k written-typed fields stored k times into one destination",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          "let a = root",
          rows(k, () => "a = root"),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-objects",
    measures:
      "A4 through copies, r4.80 (2): k records with a written field, another field of each stored into one list, read through a copy",
    program: (k) =>
      main(
        lines(
          "let copy = []",
          "let out = []",
          "let typed: integer = 1",
          rows(k, (i) => `let a${i} = {n: hostValue, p: typed}`),
          rows(k, (i) => `out = [a${i}.n]`),
          "out = [1]",
          "copy = out",
          "repeat copy[0] {}",
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-plain-chain",
    measures:
      "r4.80's control: a root of k plain fields and a chain of k whole copies, no written type",
    program: (k) =>
      main(lines(`let root = {${fields(k, () => "1")}}`, copiesOf(k, "chain"), "exit")),
  },
  {
    name: "A4-inherited-narrow-chain",
    measures: "r4.80's control: a root of four written-typed fields and a chain of k whole copies",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(4, () => "typed")}}`,
          copiesOf(k, "chain"),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-few-copies",
    measures: "r4.80's control: a root of k written-typed fields and a chain of four whole copies",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(4, "chain"),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-read",
    measures: "r4.80's control: A4-inherited-chain with one field of the last copy read",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(k, "chain"),
          `let shown: integer = a${k - 1}.f0`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-changed-root",
    measures:
      "r4.80's control: A4-inherited-fan-out with host data stored into one field of the root between its copies",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          rows(k >> 1, (i) => `let a${i} = root`),
          "root.f0 = hostValue",
          rows(k - (k >> 1), (i) => `let b${i} = root`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-own-fields",
    measures: "r4.80's control: A4-inherited-chain with each copy storing its own field",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          rows(k, (i) => `let a${i} = ${i > 0 ? `a${i - 1}` : "root"}\na${i}.f${i} = 2`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-fed-cycles",
    measures:
      "Sol's review r2: k cycles of two whole copies each fed by the root, each copy storing its own plain field, held in one literal",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          rows(k, (i) => `let a${i} = root\nlet b${i} = a${i}\na${i} = b${i}\na${i}.extra = 2`),
          `let out = [${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  ...(["2", "typed"] as const).map((value): WorkFamily => ({
    name: `A4-inherited-replaced${value === "typed" ? "-typed" : ""}`,
    measures: `Sol's reviews r1 B3 and r2 B2: k copies of a root of k written-typed fields, each storing its own plain field, then replaced by a record of k ${value === "typed" ? "written-typed" : "plain"} fields`,
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          `let other = {${fields(k, () => value)}, extra: 1}`,
          rows(k, (i) => `let a${i} = root\na${i}.extra = 2\na${i} = other`),
          "exit",
        ),
      ),
  })),
  {
    name: "A4-inherited-closed-chain",
    measures:
      "r4.80's control: A4-inherited-chain closed into a cycle of whole copies, its first copy taking the last",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(k, "chain"),
          `a0 = a${k - 1}`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-fan-in",
    measures:
      "Sol's review r1 B3: k whole copies of a root of k written-typed fields, each storing its own plain field, held in one literal",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          rows(k, (i) => `let a${i} = root\na${i}.extra = 2`),
          `let out = [${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-own-read",
    measures:
      "Sol's review r3 B2: k whole copies of a root of k written-typed fields, each storing a read of one plain binding into its own field",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          "let value = 2",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          rows(k, (i) => `let a${i} = root\na${i}.f${i} = value`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-projected-fan-in",
    measures:
      "Sol's review r3 B2: k literals each holding a root of k written-typed fields beside a plain field they store, their held roots read into one list",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          rows(k, (i) => `let a${i} = {p: root, extra: 1}\na${i}.extra = 2`),
          `let out = [${Array.from({ length: k }, (_, i) => `a${i}.p`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  ...(["2", "typed"] as const).map((value): WorkFamily => ({
    name: `A4-inherited-replaced-aliases${value === "typed" ? "-typed" : ""}`,
    measures: `Sol's review r3 B2: k copies of a root of k written-typed fields, each storing a plain field, then replaced by one of k aliases of a record of k ${value === "typed" ? "written-typed" : "plain"} fields, each alias storing a plain field`,
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          `let other = {${fields(k, () => value)}, extra: 1}`,
          rows(
            k,
            (i) =>
              `let b${i} = other\nb${i}.extra = 2\nlet a${i} = root\na${i}.extra = 2\na${i} = b${i}`,
          ),
          "exit",
        ),
      ),
  })),
  {
    name: "A4-inherited-two-roots-and-one",
    measures:
      "Sol's design review B2 and review r5: k places each copying two roots of k written-typed fields, then one of k narrow projections of a wide written record",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, extra: 1}`,
          `let other = {${fields(k, () => "typed")}, extra: 1}`,
          `let packed = {${Array.from({ length: k }, (_, i) => `p${i}: {extra: typed, tiny: typed}`).join(", ")}}`,
          rows(k, (i) => `let c${i} = root\nc${i} = other\nc${i} = packed.p${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-chain-and-one",
    measures:
      "Sol's reviews r5 and r6: a chain of k whole copies of a root of two written-typed and k plain fields, each storing its own plain field, its last copy copied by k places that each also take one of k records of three written-typed fields",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {f0: typed, f1: typed, extra: 1, ${fields(k, () => "1", "x")}}`,
          rows(k, (i) => `let a${i} = ${i > 0 ? `a${i - 1}` : "root"}\na${i}.x${i} = 2`),
          rows(
            k,
            (i) =>
              `let s${i} = {o0: typed, o1: typed, o2: typed}\nlet c${i} = a${k - 1}\nc${i} = s${i}`,
          ),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-chain-read-fields",
    measures:
      "Sol's design review B3: a chain of k whole copies of a root of k written-typed fields, its last copy's every field read into one list",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          copiesOf(k, "chain"),
          `let out = [${Array.from({ length: k }, (_, i) => `a${k - 1}.f${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-records-twice",
    measures:
      "Sol's review r7: k distinct records of written-typed fields held in two lists, each record a group both places hold",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          rows(k, (i) => `let r${i} = {fixed: typed, x${i}: typed}`),
          `let a = [${Array.from({ length: k }, (_, i) => `r${i}`).join(", ")}]`,
          `let b = [${Array.from({ length: k }, (_, i) => `r${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-disjoint-stores",
    measures:
      "Astra's review B2: a copy of a root of k written-typed and k plain fields, storing each plain field, each written one read",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}, ${fields(k, () => "1", "g")}}`,
          "let a = root",
          rows(k, (i) => `a.g${i} = 2`),
          rows(k, (i) => `let c${i} = a.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-overlap-ancestor",
    measures:
      "Astra's review r2 B2 (`forest-overlap-ancestor`): a copy of a copy of a root of k records, storing one field below each record, each record read",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "{left: typed, right: 1}")}}`,
          "let a = root",
          "let b = a",
          rows(k, (i) => `b.f${i}.right = 2`),
          rows(k, (i) => `let r${i} = b.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-inherited-self-copy",
    measures:
      "r4.80's control: a root of k written-typed fields copied into itself at another path (`root.q = root`), then k whole copies",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          "root.q = root",
          copiesOf(k, "fan-out"),
          "exit",
        ),
      ),
  },
];

/**
 * Admission's hot-candidate discovery by touch tries (#1188, its design note's §1.3 and §4.1): one family per context
 * that listed a contribution again before the tries, each beside a wide typed root. A place merging two copies, each
 * then copied beside a second wide record; a literal of a plain wide record beside k such merges (Sol r2); k
 * configuration prefixes, each copying the root under its own name and under one shared name (Sol r8); k records beside
 * a wide one in one list, and the same k alone in another (Sol r8); a chain of merges with a partner three times as wide
 * as the root (Sol r1); k opaque values each copied into itself, in one list (Astra's B1); k cycles of two whole copies
 * fed by the root, each with a store below it and read through a record into a list (Astra's B3); and k such cycles
 * split by their two rejected copies, each stored whole into a third place (the design's own); and a merge place of two
 * wide records, whose k meetings no decision makes hot, copied into k places that each store into it, each beside it in
 * a list or a place (Sol r6, #1270), also projected out of an object holding a whole-copy ring beside it (Astra's
 * review B2 of #1311). Each at size k, linear.
 */
export const HOT_CANDIDATE_FAMILIES: readonly WorkFamily[] = [
  {
    name: "touch-merge-place",
    measures:
      "k merge places, each copied beside a second wide record: the root's landing per merge place",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          'let word: string = "x"',
          `let root = {${fields(k, () => "typed")}}`,
          `let other = {${fields(k, () => "word", "g")}}`,
          rows(k, (i) =>
            lines(
              `let o${i} = {h${i}: typed}`,
              `let d${i} = root`,
              `d${i} = o${i}`,
              `let a${i} = d${i}`,
              `a${i} = other`,
            ),
          ),
          "exit",
        ),
      ),
  },
  {
    name: "touch-holder-fan-in",
    measures:
      "a literal of a plain wide record beside k merge places of the root: each element's holders per path",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          `let other = {${fields(k, () => "1")}}`,
          rows(k, (i) => lines(`let o${i} = {h${i}: typed}`, `let d${i} = root`, `d${i} = o${i}`)),
          `let a = [other, ${Array.from({ length: k }, (_, i) => `d${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "touch-prefix-paths",
    measures:
      "k configuration prefixes copying the root under their own name and a shared one: the shared landing per prefix",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          rows(k, (i) =>
            lines(`let c${i}_0 = {p${i}: root, z: root}`, `let c${i}_1 = {p${i}: root, z: root}`),
          ),
          "exit",
        ),
      ),
  },
  {
    name: "touch-mix-landed",
    measures:
      "k one-field records beside a wide one in one list, and alone in another: each touched path per group",
    program: (k) => {
      const records = Array.from({ length: k }, (_, i) => `r${i}`).join(", ");
      return main(
        lines(
          "let typed: integer = 1",
          rows(k, (i) => `let r${i} = {f${i}: typed}`),
          `let wide = {${fields(k, () => "typed")}}`,
          `let a = [${records}, wide]`,
          `let b = [${records}]`,
          "exit",
        ),
      );
    },
  },
  {
    name: "touch-chain-partner",
    measures:
      "a chain of k merges of the root, each copied beside a partner three times as wide: one walk per merge",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          'let word: string = "x"',
          `let root = {${fields(k, () => "typed")}}`,
          `let other = {${fields(3 * k, () => "word", "g")}}`,
          "let m0 = root",
          rows(k, (i) =>
            lines(
              `let o${i + 1} = {h${i + 1}: typed}`,
              `let m${i + 1} = m${i}`,
              `m${i + 1} = o${i + 1}`,
              `let a${i + 1} = m${i + 1}`,
              `a${i + 1} = other`,
            ),
          ),
          "exit",
        ),
      ),
  },
  {
    name: "touch-opaque-cycles",
    measures:
      "k opaque values each copied into itself, in one list beside a record: each contributor's payload once",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          rows(k, (i) => lines(`let u${i} = hostValue`, `u${i} = u${i}`)),
          `let bag = [${Array.from({ length: k }, (_, i) => `u${i}`).join(", ")}, {x: typed}]`,
          "exit",
        ),
      ),
  },
  {
    name: "touch-fed-cycles",
    measures:
      "k cycles of two whole copies fed by the root, each read into a list: the root's landing per cycle",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let root = {${fields(k, () => "typed")}}`,
          `let peer = {${fields(k, () => "typed", "g")}}`,
          rows(k, (i) =>
            lines(
              `let a${i} = root`,
              `let b${i} = a${i}`,
              `a${i} = b${i}`,
              `b${i}.f0 = typed`,
              `let c${i} = {nest: b${i}}`,
              `let pair${i} = [c${i}.nest, peer]`,
            ),
          ),
          "exit",
        ),
      ),
  },
  {
    name: "touch-split-cycles",
    measures:
      "k cycles of two whole copies split by their two rejected copies, each stored into a third place",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 17",
          'let word: string = "s"',
          `let shared = {${fields(k, () => "typed")}}`,
          rows(k, (i) =>
            lines(
              `let a${i} = shared`,
              `let b${i} = {f0: word}`,
              `a${i} = b${i}`,
              `b${i} = a${i}`,
              `let s${i} = b${i}`,
              `s${i} = a${i}`,
            ),
          ),
          "exit",
        ),
      ),
  },
  // (the merge place itself, or projected beside a whole-copy ring at its own path or one deeper (Astra's review B2 of
  // #1311): a ring-free sibling of a ring is no ring node, so its meetings are not owed again; each placement and
  // consumer is sampled, not their product)
  ...(
    [
      ["literal", ""],
      ["place", ""],
      ["literal", "sibling"],
      ["place", "nested"],
    ] as const
  ).map(([form, beside]): WorkFamily => ({
    name: `touch-dormant-meetings-${form}${beside === "" ? "" : `-${beside}-ring`}`,
    measures: `a merge place's k meetings beside k copies of it, each with a store of its own, in a ${form} with it${beside === "" ? "" : `, projected beside a ring (${beside})`}`,
    program: (k) => {
      // (the merge place, or the object holding it beside a ring, and the projection taken of it)
      const ring =
        beside === ""
          ? []
          : [
              "let r0 = {v: typed}",
              "let r1 = {v: typed}",
              "r0 = r1",
              "r1 = r0",
              beside === "sibling"
                ? "let holder = {cycle: r0, data: container}"
                : "let holder = {inner: {cycle: r0, data: container}}",
              `let selected = ${beside === "sibling" ? "holder.data" : "holder.inner.data"}`,
            ];
      const source = beside === "" ? "container" : "selected";
      return main(
        lines(
          "let typed: integer = 17",
          `let exact = {${fields(k, () => "typed")}}`,
          `let fraction = {${fields(k, () => "1.5")}}`,
          "let container = fraction",
          "container = exact",
          ...ring,
          rows(k, (i) =>
            lines(
              `let alias${i} = ${source}`,
              `alias${i}.f${i} = typed`,
              form === "literal"
                ? `let final${i} = [${source}, alias${i}]`
                : lines(`let final${i} = ${source}`, `final${i} = alias${i}`),
            ),
          ),
          "exit",
        ),
      );
    },
  })),
  {
    name: "touch-literal-contributors",
    measures:
      "k lists of one shared record, each beside its own load or fromJson default at the same position: a contributor per literal",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 7",
          "let peer = {x: typed}",
          "let good = {x: 1}",
          'let bad = {x: "bad"}',
          rows(k, (i) => {
            const fallback = i % 4 < 2 ? "good" : "bad";
            const value =
              i % 2 === 0
                ? `load("k${i}", default: ${fallback})`
                : `fromJson(hostValue, default: ${fallback}, files: false)`;
            return `let l${i} = [${value}, peer]`;
          }),
          "exit",
        ),
      ),
  },
];

/**
 * Admission (TABLE §5, §10.3's admission combinations; the port plan's §3.3, M4 S6): the decided type over an empty, a
 * populated and a later mutated snapshot, several destinations of one source with different decided types, a rejected
 * destination beside its intact source, external ingresses merged with an opaque source, A5's candidates under k whole
 * presets of a record, A2's scan past external stores, the width of a record's written copies, a literal's records and a
 * replacement's misfits, the boundary checks of a literal's external cells, and the structure named elements bring to
 * a literal (projections of one record's lists, literals of one record's copies, or of the values operations carry of
 * it, added to a list), k method results or conversions of one class beside an object in one literal (#1078), and k
 * copies of one nested preset joined into one place, each storing its own property below one step (#1078); each at size
 * k, linear.
 */
export const ADMISSION_FAMILIES: readonly WorkFamily[] = [
  {
    name: "A2-empty-snapshot",
    measures: "A2, F9: k copies of empty lists, each decided by its own later add",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let a${i} = []\nlet b${i} = a${i}\nb${i}.add(${i})\na${i}.add("t${i}")`),
          rows(k, (i) => `let s${i}: integer = b${i}.first`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-populated-snapshot",
    measures: "A2, A6: k copies of populated lists, each given an element of another kind",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let a${i} = [${i}]\nlet b${i} = a${i}\nb${i}.add("x${i}")`),
          rows(k, (i) => `repeat a${i}.first {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-later-mutation",
    measures: "A2, F9: k copies taken before their sources change kind",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let a${i} = [${i}]\nlet b${i} = a${i}\na${i}.add(1.5)\nb${i}.add(2)`),
          rows(k, (i) => `repeat b${i}.first {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-destinations",
    measures:
      "A2, A5: k destinations of one record's fields, decided by different kinds, then stored",
    program: (k) =>
      main(
        lines(
          `let source = {n: 1, s: "a", f: 1.5}`,
          rows(k, (i) => `let d${i} = source.${["n", "s", "f"][i % 3]}`),
          rows(k, (i) => `d${i} = ${["2", '"b"', "2.5"][i % 3]}`),
          rows(k, (i) => `if flagHost { d${i} = ${['"x"', "3", "true"][i % 3]} }`),
          "exit",
        ),
      ),
  },
  {
    name: "A6-rejected-destination",
    measures: "A6, F9: k destinations rejected at a field, their sources intact",
    program: (k) =>
      main(
        lines(
          rows(
            k,
            (i) => `let source${i} = {n: ${i}}\nlet copy${i} = source${i}\ncopy${i}.n = "bad"`,
          ),
          rows(k, (i) => `repeat source${i}.n {}\nrepeat copy${i}.n {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-presets",
    measures:
      "A5: k presets each giving one field of a k-field record another kind, all stored whole, every field read",
    program: (k) =>
      main(
        lines(
          `let state = {${fields(k, () => "0")}}`,
          rows(k, (i) => `let preset${i} = {${fields(k, (j) => (i === j ? '"t"' : "0"))}}`),
          rows(k, (i) => `if flagHost { state = preset${i} }`),
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-presets-copied",
    measures: "A5: the same with each preset a copy of one seed changed at its own field",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "0")}}`,
          "let state = seed",
          rows(k, (i) => `let preset${i} = seed\npreset${i}.f${i} = "t"`),
          rows(k, (i) => `if flagHost { state = preset${i} }`),
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-external-scan",
    measures:
      "A2: a k-field record replaced k times by external data before a literal decides it, every field read",
    program: (k) =>
      main(
        lines(
          "let state = hostValue",
          rows(k, () => "if flagHost { state = hostValue }"),
          `state = {${fields(k, () => "0")}}`,
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A7-copied-wholes",
    measures:
      "A7: a list of k copies of one record replaced by external data, each of its k fields stored and read",
    program: (k) =>
      main(
        lines(
          `let source = {${fields(k, () => "1")}}`,
          "source = hostValue",
          `let xs = [${Array.from({ length: k }, () => "source").join(", ")}]`,
          rows(k, (i) => `xs[0].f${i} = 1\nlet shown${i}: integer = xs[0].f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-shared-presets",
    measures:
      "A2, A5: a k-field record replaced k times by copies of one record, then by external data, every field read",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "0")}}`,
          "let state = seed",
          rows(k, () => "if flagHost { state = seed }"),
          "state = hostValue",
          rows(k, (i) => `let shown${i}: integer = state.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A4-self-copies",
    measures:
      "A4 through copies, §8 width: a place copied into k fields of itself, a cycle of copies (Sol's round 3 B3 on #1049)",
    program: (k) =>
      main(
        lines(
          "let typed: object = {v: 1}",
          "let a = typed",
          `a = {${fields(k, () => "a", "p")}}`,
          "exit",
        ),
      ),
  },
  {
    name: "A4-wide-copies",
    measures:
      "A4, §8 width: one record of k fields, each a copy of one written binding, every field read",
    program: (k) =>
      main(
        lines(
          "let typed: integer = 1",
          `let box = {${fields(k, () => "typed", "key")}}`,
          rows(k, (i) => `let result${i}: integer = box.key${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-wide-elements",
    measures: "A8, §8 width: a literal of two k-field records, each field's type one, a field read",
    program: (k) =>
      main(
        lines(
          `let rows = [{${fields(k, () => "0")}}, {${fields(k, () => "1")}}]`,
          "let shown: integer = rows.first.f0",
          "exit",
        ),
      ),
  },
  {
    name: "A6-wide-misfits",
    measures: "A6, r4.35, §8 width: a k-field record replaced by one whose every field misfits",
    program: (k) =>
      main(
        lines(
          `let box = {${fields(k, () => "0")}}`,
          `box = {${fields(k, () => '"bad"')}}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "C9-merged-ingresses",
    measures:
      "C9: k places each merging two external ingresses with an opaque source, every boundary check kept",
    program: (k) =>
      main(
        lines(
          "speaker vera { custom: 1 }",
          rows(
            k,
            (i) =>
              `let v${i} = hostValue\nif flagHost { v${i} = fromJson("${i}", default: null, files: false) }\nif flagHost { v${i} = vera.custom }\nlet w${i}: integer = v${i}`,
          ),
          "exit",
        ),
      ),
  },
  {
    name: "C9-literal-cells",
    measures:
      "C9 r4.29, r4.35: k records each holding k external cells, one boundary each at its first cell",
    program: (k) =>
      main(
        lines(
          rows(
            k,
            (i) =>
              `let r${i} = {${fields(4, () => "hostValue")}}\nlet n${i}: integer = r${i}.f${i % 4}`,
          ),
          `let wide = [${Array.from({ length: k }, () => "hostValue").join(", ")}]`,
          "let first: integer = wide.first",
          "exit",
        ),
      ),
  },
  {
    name: "A8-projected-copies",
    measures:
      "F2, A8: k projections of a k-field record's lists named in one literal, an element read (round 10 B3)",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "[1]")}}`,
          rows(k, (i) => `let copy${i} = seed.f${i}`),
          `let xs = [${Array.from({ length: k }, (_, i) => `copy${i}`).join(", ")}]`,
          "repeat xs[0][0] {}",
          "exit",
        ),
      ),
  },
  {
    name: "A2-published-wide-copies",
    measures:
      "§8, A2, C9 r4.12: k whole copies of one record of k fields published beside named host data, every field read (Codex r17 B2)",
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          "let box = root",
          rows(k, () => "box = root"),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  // S6-CARRIERS §4.1, §4.7: whole copies of a stable source path (R5-F1's projected copies), alias members of one class
  // where no event below the path separates them, and the conditional-write variants (Astra's fourth round M1, the
  // orchestrator's condition (a)): a conditional store below the path before or between the copies
  ...(
    [
      ["A2-projected-wide-copies", "root.nested", false, "none"],
      ["A2-projected-stable-copies", "stable", false, "none"],
      ["A2-projected-mutable-source", "root.nested", false, "store"],
      ["A2-projected-conditional-before", "root.nested", true, "before"],
      ["A2-projected-conditional-between", "root.nested", true, "between"],
    ] as const
  ).map(([name, copied, nulls, event]): WorkFamily => ({
    name,
    measures: `§4.1, A2: k + 1 whole copies of \`${copied}\`, a k-field record of named host data, every field read${event === "none" ? "" : event === "store" ? ", a store below it between the copies" : `, a conditional store below it ${event} the copies`}`,
    program: (k) => {
      const half = k >> 1;
      const copies = (count: number): string => rows(count, () => `box = ${copied}`);
      const write =
        event === "store" ? "root.nested.f0 = 1" : "if raw != null { root.nested.f0 = 1 }";
      return main(
        lines(
          "let raw = hostValue",
          `let root = {nested: {${fields(k, () => "[1, raw][1]")}}}`,
          ...(copied === "stable" ? ["let stable = root.nested"] : []),
          nulls ? `let box = {${fields(k, () => "null")}}` : `let box = ${copied}`,
          ...(event === "before" ? [write] : []),
          ...(event === "between" || event === "store"
            ? [copies(half), write, copies(k - half)]
            : [copies(k)]),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      );
    },
  })),
  {
    name: "A2-published-wide-copies-conditional",
    measures:
      "§4.1, A2, C9 r4.12: A2-published-wide-copies with a conditional store into the record before the copies (M1)",
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          "let box = root",
          "if raw != null { root.f0 = 1 }",
          rows(k, () => "box = root"),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  ...(["one region", "k regions"] as const).map((variant): WorkFamily => ({
    name: `A2-guarded-quiet-copies-${variant.replace(" ", "-")}`,
    measures: `§4.3, A2: k copies of a k-field record of named host data guarded in ${variant}${variant === "k regions" ? ", one unguarded" : ""}, every field read`,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          "let box = root",
          variant === "one region"
            ? lines(
                "if root != null {",
                rows(k, () => "  box = root"),
                "}",
              )
            : lines(
                rows(k, () => "if root != null { box = root }"),
                "box = root",
              ),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  })),
  {
    name: "A8-added-presets",
    measures:
      "F2, A8: k literals of one k-field record's copies added to one list, every field read (round 10 B4)",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          "let xs = []",
          rows(k, () => "xs.add([seed, seed])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0].f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-wrapped-presets",
    measures:
      "F2, A8: k literals of records wrapping one k-field record, added to one list, every field read (round 11)",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          "let xs = []",
          rows(k, () => "xs.add([{data: seed}, {data: seed}])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0].data.f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-carried-presets",
    measures:
      "F2, A8: k literals of one k-field record that `otherwise` carries, added to one list, every field read (round 11 B4)",
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          "let xs = []",
          rows(k, () => "xs.add([seed otherwise seed, seed otherwise seed])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0].f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-distinct-records",
    measures: "F2, A8: k records of distinct fields named in one literal (round 13 B2)",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let a${i} = {f${i}: 1}`),
          `let xs = [${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")}]`,
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-call-presets",
    measures:
      "F2, A8: k literals of one function's k-field result, added to one list, every field read (round 12 B3)",
    program: (k) =>
      main(
        lines(
          `function seed {\n  return {${fields(k, () => "1")}}\n}`,
          "let xs = []",
          rows(k, () => "xs.add([seed(), seed()])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0].f${i}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-chained-presets",
    measures:
      "F2, A8: k literals of the end of a chain of k copies of one record, added to one list (round 12 B3)",
    program: (k) =>
      main(
        lines(
          "let a0 = {n: 1}",
          rows(k, (i) => `let a${i + 1} = a${i}`),
          "let xs = []",
          rows(k, () => `xs.add([a${k}, a${k}])`),
          "let shown: integer = xs[0][0].n",
          "exit",
        ),
      ),
  },
  {
    name: "A8-added-taken-presets",
    measures:
      "F2, A8: k literals of `take`s of a list of one k-field record, added to one list, every field read (round 11 B4)",
    program: (k) =>
      main(
        lines(
          `let seed = [{${fields(k, () => "1")}}]`,
          "let xs = []",
          rows(k, () => "xs.add([seed.take(1), seed.take(1)])"),
          rows(k, (i) => `let shown${i}: integer = xs[0][0][0].f${i}`),
          "exit",
        ),
      ),
  },
  // S6-CARRIERS §4.6, §4.7 (C9-fresh-wrappers) with Codex r20 B2 and B3: k stores of a wrapper holding a fresh host
  // value beside one k-field record, every field read; the level at the record's path holds it once
  ...(
    [
      ["payload", "{noise: hostValue otherwise null, data: root}", "data.", "box.noise"],
      ["get", "{tag: 0, slot: {data: xs.get(hostValue, default: root)}}", "slot.data.", null],
      ["projected", "({noise: hostValue otherwise null, data: root}).data", "", null],
      [
        "projected-get",
        "({noise: hostValue otherwise null, data: [root].get(0, default: root)}).data",
        "",
        null,
      ],
    ] as const
  ).map(([variant, wrapper, at, payload]): WorkFamily => ({
    name: `C9-fresh-wrappers-${variant}`,
    measures: `§4.6, C9: k stores of \`${wrapper}\`, every field of the record read`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          `let box = ${wrapper}`,
          rows(k - 1, () => `box = ${wrapper}`),
          ...(payload === null ? [] : [`let n: integer = ${payload}`]),
          rows(k, (i) => `repeat box.${at}f${i} {}`),
          "exit",
        ),
      ),
  })),
  {
    name: "C9-fresh-wrappers-distinct",
    measures:
      "§4.6, C9: k wrappers of k distinct records, the last stored k times more, one field read (Codex r20 B3)",
    program: (k) =>
      main(
        lines(
          rows(k, (i) => `let r${i} = {n: hostValue}`),
          "let box = {noise: hostValue otherwise null, data: r0}",
          rows(k - 1, (i) => `box = {noise: hostValue otherwise null, data: r${i + 1}}`),
          rows(k, () => `box = {noise: hostValue otherwise null, data: r${k - 1}}`),
          "say box.data.n",
          "exit",
        ),
      ),
  },
  // S6-CARRIERS §3.4 with Codex r20 B5: k merged host stores met by k consumers, each provenance node resolved once (the
  // nested own defaults of §3.2 are a gated known limit)
  ...(["reads", "typed"] as const).map((variant): WorkFamily => ({
    name: `C9-merged-leaves-${variant}`,
    measures: `§3.4: k conditional host stores of one place, k ${variant === "reads" ? "reads" : "typed copies"} of it (Codex r20 B5)`,
    program: (k) =>
      main(
        lines(
          'let flag = askBoolean "F"',
          "let pool = hostValue",
          rows(k, () => "if flag { pool = hostValue }"),
          rows(k, (i) => (variant === "reads" ? "repeat pool {}" : `let out${i}: integer = pool`)),
          "exit",
        ),
      ),
  })),
  // S6-CARRIERS §4.1: k stores of a literal whose one cell reads a k-field record of named host data, and k copies of a
  // literal index of one, every field read; each a class below its cell or path, never k candidates at every field
  ...(
    [
      ["cell", "{data: root}", ".data", ""],
      ["list-cell", "[root]", "[0]", ""],
      ["literal-index", "holder.items[0]", "", "let holder = {items: [root]}"],
    ] as const
  ).map(([variant, value, at, holder]): WorkFamily => ({
    name: `A2-alias-${variant}-copies`,
    measures: `§4.1, C1: k stores of \`${value}\` over a k-field record of named host data, every field read`,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          ...(holder === "" ? [] : [holder]),
          `let box = ${value}`,
          rows(k, () => `box = ${value}`),
          rows(k, (i) => `repeat box${at}.f${i} {}`),
          "exit",
        ),
      ),
  })),
  // S6-CARRIERS §4.1's chains: k copies `let a(i + 1) = a(i)` of a k-field record of named host data, each copied into
  // one place, every field read; each link's read stands for the chain's end, one class
  {
    name: "A2-alias-chain-heads",
    measures:
      "§4.1, C1: k links of a chain of copies of a k-field record of named host data, each stored, every field read",
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let a0 = {${fields(k, () => "[1, raw][1]")}}`,
          rows(k, (i) => `let a${i + 1} = a${i}`),
          "let box = a0",
          rows(k, (i) => `box = a${i + 1}`),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  // S6-CARRIERS §4.1's chains under a guard (Codex r22 F4): k copies of one snapshot whose definition is read under k
  // tests of the source's fields, every field read; the definition read's guards found once, whatever asks
  {
    name: "A2-alias-guarded-snapshot-copies",
    measures:
      "§4.1, §3.2: k copies of one snapshot read under k field tests of its source, every field read (Codex r22 F4)",
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          `if ${Array.from({ length: k }, (_, i) => `root.f${i} != null`).join(" and ")} {`,
          "  let stable = root",
          "  let box = stable",
          rows(k - 1, () => "  box = stable"),
          rows(k, (i) => `  repeat box.f${i} {}`),
          "}",
          "exit",
        ),
      ),
  },
  // §3.2 with S6-CARRIERS §4.6 (Codex r21 B1): k stores of a computed child over a k-field record, each under a test of
  // a different field, one field read; each operand read's marks below it come from the guard regions holding it, never
  // from each tested field in turn
  ...(
    [
      ["wrapped", "{data: [root].get(0, default: root)}", "data."],
      ["direct", "[root].get(0, default: root)", ""],
    ] as const
  ).map(([variant, value, at]): WorkFamily => ({
    name: `A2-guarded-computed-children-${variant}`,
    measures: `§3.2, §4.6: k stores of \`${value}\`, each under a test of another field, one field read (Codex r21 B1)`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "2.0")}}`,
          `let box = ${value}`,
          rows(k, (i) => `if root.f${i} != null { box = ${value} }`),
          `repeat box.${at}f0 {}`,
          "exit",
        ),
      ),
  })),
  // S6-CARRIERS §3.1 (Codex r23 F1): k reads of one host global in one literal, its element stored and decided at k
  // fields, each read; through an own read (a fallback's, a default's), inline, beside named data, as named data: each
  // occurrence its own leaf, the reads one entry of the literal, each path's decider and C1 site from its prefixes' stops
  ...(
    [
      ["own", "null otherwise [W][0]"],
      ["default", "[].get(7, default: [W][0])"],
      ["inline", "[W][0]"],
      ["mixed", "[raw, W][0]"],
      ["named", "null otherwise data"],
    ] as const
  ).map(([variant, value]): WorkFamily => ({
    name: `A2-wide-ingresses-${variant}`,
    measures: `§3.1: \`let out = ${value}\`, W k reads of \`hostValue\`, decided at k fields, each read (Codex r23 F1)`,
    program: (k) => {
      const wide = Array.from({ length: k }, () => "hostValue").join(", ");
      return main(
        lines(
          "let raw = hostValue",
          variant === "named" ? `let data = [${wide}][0]` : "",
          `let out = ${value.replace("W", wide)}`,
          `out = {${fields(k, () => "1")}}`,
          rows(k, (i) => `repeat out.f${i} {}`),
          "exit",
        ),
      );
    },
  })),
  // Codex r24 F1, F2 and their neighbours: k distinct ingresses at k fields, each its own provenance node, asked of the
  // store's index; and k host reads a call that stores nothing separates, one snapshot (r4.68 (1)), with the calls'
  // results one entry as k calls of one function are (r4.15), inline and beside named data
  ...(
    [
      ["fields", (k: number) => `{${fields(k, () => "hostValue")}}`],
      ["idle-index", (k: number) => `[${cells(k, "hostValue[idle()]")}][0]`],
      ["idle-cells", (k: number) => `[${cells(k, "hostValue, idle()")}][0]`],
      ["idle-cells-mixed", (k: number) => `[raw, [${cells(k, "hostValue, idle()")}][0]][1]`],
    ] as const
  ).map(([variant, value]): WorkFamily => ({
    name: `A2-wide-ingress-${variant}`,
    measures: `§3.1, r4.68 (1): \`let out = ${value(2)}\` at k, decided at k fields, each read (Codex r24 F1, F2)`,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          "function idle { return 0 }",
          `let out = ${value(k)}`,
          `out = {${fields(k, () => "1")}}`,
          rows(k, (i) => `repeat out.f${i} {}`),
          "exit",
        ),
      ),
  })),
  // TABLE r4.93 (#1106): the menus a script writes, beside the nested choices of `ADMISSION_KNOWN_PRODUCTS`: one choice
  // of k choice objects, and a list of k parenthesised choices of one each, every answer read; 13,675 / 27,371 and
  // 37,542 / 75,150 units at k = 64, 128 in both orders (2.0080, 2.0066; `main` alike, the list 23 units more)
  {
    name: "I1106-menu",
    measures: "r4.93: a choice of k choice objects of integers, its answer read k times",
    program: (k) =>
      main(
        lines(
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: ${i}}`).join(", ")}`,
          rows(k, () => "repeat box {}"),
          "exit",
        ),
      ),
  },
  {
    name: "I1106-list-of-choices",
    measures:
      "r4.93: a list of k parenthesised choices of one choice object each, every element read",
    program: (k) =>
      main(
        lines(
          `let box = [${Array.from({ length: k }, (_, i) => `(askChoice {text: "${i}", value: ${i}})`).join(", ")}]`,
          rows(k, (i) => `repeat box[${i}] {}`),
          "exit",
        ),
      ),
  },
  // TABLE r4.78 (5)'s and r4.88 (1)'s product, linear since #1230 (admission's stop index keeps each operation's
  // evaluation key and chain once, a link onto the one around it): k nested own defaults, 3.94, 3.05 and 3.60 before,
  // and a sum of k terms of one list, 2.45 before
  nestedOwn("otherwise", (inner) => `null otherwise (${inner})`),
  nestedOwn("get", (inner) => `[1].get(7, default: ${inner})`),
  nestedOwn("load", (inner, i) => `load("k${i}", default: ${inner})`),
  {
    name: "S6c-nested-sum",
    measures:
      "TABLE r4.88: a sum of k terms of one list of a k-field record, every field of its last element read",
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let piece = [root]",
          `let gathered = ${Array.from({ length: k }, () => "piece").join(" + ")}`,
          rows(k, (i) => `repeat gathered.last.f${i} {}`),
          "exit",
        ),
      ),
  },
  ...(
    [
      ["method-results", (i: number) => `[a${i}].count(a${i})`],
      ["conversions", (i: number) => `toInteger(a${i}.f0, default: 0)`],
    ] as const
  ).map(([variant, element]): WorkFamily => ({
    name: `A8-${variant}-beside-object`,
    measures: `A8 (#1078): k ${variant.replace("-", " ")} of one class beside an object of k properties in one literal, read at each property`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          rows(k, (i) => `let a${i} = root`),
          `let out = [${Array.from({ length: k }, (_, i) => element(i)).join(", ")}, root]`,
          rows(k, (i) => `repeat out[0].f${i} {}`),
          "exit",
        ),
      ),
  })),
  {
    name: "A5-nested-preset-copies",
    measures:
      "A5 (#1078): k copies of one nested preset joined into one place, each storing its own property below one step, read at each property",
    program: (k) =>
      main(
        lines(
          `let initial = {nest: {${fields(k, () => "0", "p")}}}`,
          "let state = initial",
          rows(
            k,
            (i) => `let c${i} = initial\nc${i}.nest.p${i} = "bad"\nif hostValue { state = c${i} }`,
          ),
          rows(k, (i) => `let sink${i}: integer = state.nest.p${i}`),
          "exit",
        ),
      ),
  },
  ...INHERITED_FIELD_FAMILIES,
];

/** §3.2, C10: k nested own defaults of one kind around one host value (Codex r20 B4). */
function nestedOwn(variant: string, wrap: (inner: string, i: number) => string): WorkFamily {
  return {
    name: `C9-nested-own-${variant}`,
    measures: `§3.2, C10: k nested own ${variant} defaults around one host value (Codex r20 B4)`,
    program: (k) => {
      let value = "hostValue";
      for (let i = k - 1; i >= 0; i -= 1) value = wrap(value, i);
      return main(lines(`let out = ${value}`, "repeat out {}", "exit"));
    },
  };
}

/**
 * A6's chain of k dependent rejections (Sol's twelve-step witness at size k): each copy reads its source after the
 * source's misfit, so each rejection shows only in the pass after the one before it, k passes in all: TABLE §8's
 * passes × stores, each pass charged. A gated known limit by the owner's decision (TABLE r4.49, option A): its doubling
 * at k = 64 → 128 as measured, re-measured and proposed with its counts on a change to admission's passes, never
 * retuned; its trigger, a realistic script reaching the allowance through cascading rejections. Beside it, copies
 * interleaved with conditional stores below their path (S6-CARRIERS §4.7, condition (b)), accepted in the same form
 * (TABLE r4.69 (1)), and copies separated by calls storing their source, accepted in it too (r4.71). Last, k nested
 * choices (direct, and in lists of two), accepted in the same form (TABLE r4.93).
 */
export const ADMISSION_KNOWN_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "A6-chain",
    measures: "A6: a chain of k rejections, every copy taken after its source's misfit",
    // 552,834 / 2,133,218 units at k = 64, 128, k + 2 passes (3.9139, the allowance reached at k = 487), each pass also
    // following the structure its stores copy through the values projections and operations carry (F2, the carrier
    // walk); 557,189 / 2,150,117 before that walk (3.9141, k = 485); at the measurement 526,905 / 2,032,217 (3.9120),
    // each pass charging its index of the previous pass's rejections (3.908 before, 452,803 / 1,744,803) and its
    // literals' contributions by path (3.9103 before, 496,487 / 1,914,055)
    measured: 3.92,
    program: (k) =>
      main(
        lines(
          "let v0 = 0",
          'v0 = "x"',
          rows(k, (i) => `let v${i + 1} = v${i}\nv${i + 1} = "x"`),
          `let final: integer = v${k}`,
          "exit",
        ),
      ),
  },
  {
    name: "A2-interleaved-conditional-copies",
    measures:
      "§4.1, condition (b): k copies of a k-field record of named host data, each after a conditional store below it",
    // A gated known limit by the owner's decision (TABLE r4.69 (1), option A): each copy sees one more conditional
    // store below the copied path, so each has its own signature, k classes, each answered at each of the k fields read
    // (S6-CARRIERS §4.7's first unmerged shape; a rule beyond the class rule merges them). 377,525 / 1,357,501 units at
    // k = 64, 128 in both orders (3.6080; 3.6222 before Codex r23's repairs, 3.6236 before TABLE r4.67); the allowance
    // reached at k = 618; at k = 1,024 82,410,069 units under a raised test allowance, 274.7 % of its 30,000,000 (the
    // analysis itself stops at the allowance with the budget error)
    measured: 3.63,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {nested: {${fields(k, () => "[1, raw][1]")}}}`,
          `let box = {${fields(k, () => "null")}}`,
          rows(k, () => "if raw != null {\n  root.nested.f0 = 1\n}\nbox = root.nested"),
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A2-copies-separated-by-storing-calls",
    measures:
      "§4.1, condition (b): k copies of a global another callable stores, each after a call storing it, at k fields",
    // A gated known limit by the owner's decision (TABLE r4.71, option A): each copy reads the global after one more
    // call that stores it, so each has its own snapshot (r4.68 (1)), k entries of the literal, each read at each of the k
    // fields (S6-CARRIERS §4.7's second unmerged shape, copies separated by calls while the source is owned away; a rule
    // beyond the class rule, or S6c's normalization, merges them). 132,548 / 453,830 units at k = 64, 128 in both orders
    // (3.4742; `main` 1.99, the output linear); at k = 1,024 24,755,020 units, 82.5 % of its 30,000,000; the allowance
    // reached at k = 1,129
    measured: 3.48,
    program: (k) =>
      main(
        lines(
          "global g = hostValue",
          "function bump {\n  g = 2.0\n  return 0\n}",
          `let out = [${cells(k, "g, bump()")}][0]`,
          `out = {${fields(k, () => "1")}}`,
          rows(k, (i) => `repeat out.f${i} {}`),
          "exit",
        ),
      ),
  },
  // A witness of TABLE r4.93's product (#1106): a list literal of k choices, which nests them, each the last option of
  // the one before; a choice's answer is a scalar button, so each walk reaches each choice once. Its stops' carrier
  // chains and evaluation keys are kept once since #1230 (4.4841 before); what stays is the contract's class of each
  // choice's options (`literalUnits` 3.62): 28,228 / 85,185 units at k = 64, 128 in both orders (3.0550)
  {
    name: "I1106-nested-choices",
    measures:
      'TABLE r4.93: `[askChoice "0", askChoice "1", …]` at k, k nested choices, its element read',
    measured: 3.06,
    program: (k) =>
      main(
        lines(
          `let box = [${Array.from({ length: k }, (_, i) => `askChoice "${i}"`).join(", ")}]`,
          "say box[0]",
          "exit",
        ),
      ),
  },
  // The same chain with each choice's option a list of two (review r1 B1): k literals, each its own literal-element
  // check, which asked its element's stops for a written copy even where its structure holds no source (a list or a set
  // alike): 67,884 / 287,275 units at k = 64, 128 in both orders (4.2538; before 475,178 / 5,304,426, 11.22, the
  // allowance at k = 224); 45,725 / 157,148 (3.4546) since #1230, the literal-element checks' structures what stays;
  // 45,355 / 156,458 (3.4675) with S8's stop (#1063): fewer index steps at both sizes (25,209 / 91,385 against 25,579 /
  // 92,075), more of them saved at 64 than at 128
  {
    name: "I1106-nested-choice-lists",
    measures:
      'TABLE r4.93: `askChoice [(askChoice [(…), "alt"]), "alt"]` at k, k nested choices in lists of two, read',
    measured: 3.47,
    program: (k) => {
      let expression = 'askChoice "seed"';
      for (let i = 1; i < k; i += 1) expression = `askChoice [(${expression}), "alt"]`;
      return main(lines(`let box = ${expression}`, "say box", "exit"));
    },
  },
];

/**
 * S6-CARRIERS §4.5, §4.7 and S6c (TABLE r4.61, r4.69 (2)): k adds of one record to one list, a choice of k options of one
 * record, and a literal of k `get`s of one list with one default, every field read; plain, and with a root of host data
 * whose fields admission reads (Astra r5 B2); the same through k stable aliases of the source (a chain whose first link
 * is a direct alias, `get`s whose alias writers cross, adds of aliases) and adds of two sources in two blocks (reviews r1, r2):
 * each class and boundary once, not every combination (the owner's test-cost rule). Adds of several
 * sources strictly in turn keep the chain's one step per add per path (TABLE §8), which the PR measures. The value side reads each class once per field (S6c: a run of adds of one
 * class answers as its third add, `ExactPath`; a choice's options and a literal's computed values by their classes,
 * `Contract.classOf`), so every counter grows with the program (§3.3's gate; the known-product gates of S6 are gone).
 */
export const ADMISSION_SAME_SOURCES: readonly WorkFamily[] = [
  {
    name: "A5-same-source-adds",
    measures: "§4.5, A5: k `xs.add(root)` of one k-field record, every field of `xs[0]` read",
    // 42,163 / 84,912 units at k = 64, 128 in both orders (2.0213; `main` 41,382 / 83,363)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = []",
          rows(k, () => "xs.add(root)"),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-same-source-choices",
    measures: "§4.5, A8: a choice of k options whose value is one k-field record, every field read",
    // 37,733 / 75,524 units at k = 64, 128 in both orders (2.0089; `main` 58,319 / 157,678, 2.71, the value side's
    // choice items one per option at each field read)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "a${i}", value: root}`).join(", ")}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-same-source-gets",
    measures:
      "S6c, A8: a literal of k `xs.get(0, default: root)` of one k-field record, every field read",
    // 51,535 / 103,047 units at k = 64, 128 in both orders (2.0094; `main` 112,830 / 348,534, 3.10, the literal's
    // computed values each read at each field, `LiteralIndex.others`)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          `let box = [${cells(k, "xs.get(0, default: root)")}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  // reviews r2, r3 (S6c): `get`s of aliases whose writers cross, and a chain of aliases as options and as defaults
  {
    name: "A8-same-source-crossed-alias-gets",
    measures:
      "S6c, A8: k `list_i.get(0, default: alias_(k-1-i))`, aliases of one list and one record whose writers cross",
    // receivers' alias writers ascending, defaults' descending (review r3 B1): no value's writers all come first
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          rows(k, (i) => `let list${i} = xs`),
          rows(k, (i) => `let alias${i} = root`),
          `let box = [${Array.from({ length: k }, (_, i) => `list${i}.get(0, default: alias${k - 1 - i})`).join(", ")}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  ...(["choices", "gets"] as const).map((use) => ({
    name: `A8-same-source-chained-alias-${use}`,
    measures: `S6c, A8: k aliases of one k-field record, each of the one before, as ${use === "choices" ? "options of one choice" : "\`get\` defaults in one literal"}, every field read`,
    // 47,447 / 94,966 and 72,526 / 145,230 units at k = 64, 128 (2.0078, 2.0099; `main` 3.46, 3.64)
    program: (k: number) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          "let alias0 = root",
          rows(k - 1, (i) => `let alias${i + 1} = alias${i}`),
          use === "choices"
            ? `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: alias${i}}`).join(", ")}`
            : `let box = [${Array.from({ length: k }, (_, i) => `xs.get(0, default: alias${i})`).join(", ")}]`,
          rows(k, (i) => (use === "choices" ? `repeat box.f${i} {}` : `repeat box[0].f${i} {}`)),
          "exit",
        ),
      ),
  })),
  // Astra r5 B2: the same with a root of unknown-bearing fields, whose adds and options admission reads at every field:
  // an add's class and a choice's options of one snapshot read once (S6-CARRIERS §4.5)
  {
    name: "A5-same-source-adds-unknown",
    measures:
      "§4.5, A5: k `xs.add(root)` of one k-field record of host data, every field of `xs[0]` read",
    // 96,856 / 195,175 units at k = 64, 128 in both orders (2.0233; `main` 341,464 / 1,208,423, 3.55, the value side's
    // exact add chain walked per field)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          "let xs = []",
          rows(k, () => "xs.add(root)"),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  // review r1/r2 (S6c): adds of one source in two blocks, each a run of one class, the second after another source
  {
    name: "A5-two-blocks-adds-unknown",
    measures:
      "S6c, A5: k / 2 adds of each of two k-field records of host data, in two blocks, every field read",
    // 161,051 / 324,558 units at k = 64, 128 in both orders (2.0231; `main` 389,088 / 1,304,083, 3.36)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          `let other = {${fields(k, () => "[2, raw][1]")}}`,
          "let xs = []",
          rows(k, (i) => (i < k / 2 ? "xs.add(root)" : "xs.add(other)")),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-same-source-alias-adds-unknown",
    measures:
      "S6c, A5: k adds of k stable aliases of one k-field record of host data, every field read",
    // 110,704 / 223,221 units at k = 64, 128 in both orders (2.0236; `main` 387,427 / 1,366,248, 3.54)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          rows(k, (i) => `let alias${i} = root`),
          "let xs = []",
          rows(k, (i) => `xs.add(alias${i})`),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A8-same-source-choices-unknown",
    measures:
      "§4.5, A8: a choice of k options whose value is one k-field record of host data, every field read",
    // 82,323 / 165,189 units at k = 64, 128 in both orders (2.0148; `main` 195,133 / 620,207, 3.19)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "a${i}", value: root}`).join(", ")}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  // #1077: a class of stores checked at a path that each of its members reaches as its own candidate too (an add at
  // its element, directly and through its list; a return into a written result, A9), each member checked once
  {
    name: "A5-same-source-adds-decided-element",
    measures:
      "A5, #1077: k `xs.add(root)` of one host-bearing number into a list its initializer types, k reads of its last",
    program: (k) =>
      main(
        lines(
          "let root = [1.5, hostValue].first",
          "let xs = [1.5]",
          rows(k, () => "xs.add(root)"),
          rows(k, () => "repeat xs.last {}"),
          "exit",
        ),
      ),
  },
  {
    name: "A5-same-source-add-alls-decided-element",
    measures:
      "A5, #1077: k `xs.addAll(more)` of one list of a host-bearing number into a list its initializer types, k reads",
    program: (k) =>
      main(
        lines(
          "let root = [1.5, hostValue].first",
          "let more = [root]",
          "let xs = [1.5]",
          rows(k, () => "xs.addAll(more)"),
          rows(k, () => "repeat xs.last {}"),
          "exit",
        ),
      ),
  },
  {
    name: "A9-same-source-returns-written-result",
    measures:
      "A9, #1077: k + 1 returns of one list of a host-bearing number from a function whose result is `number[]`, k calls",
    program: (k) =>
      main(
        lines(
          "let root = [1.5, hostValue].first",
          "let more = [root]",
          "function pick(c): number[] {",
          rows(k, (i) => `if c == ${i} {\nreturn more\n}`),
          "return more",
          "}",
          rows(k, (i) => `let picked${i} = pick(${i})`),
          "exit",
        ),
      ),
  },
];

/**
 * TABLE r4.85: one family per site of the value side's discovery that a class reached only by `Contract.classOf` keys,
 * each of one source read at k fields (the PR's inventory; the other sites' families are `ADMISSION_SAME_SOURCES` and
 * `ADMISSION_INGRESS_PRESETS`): a choice's computed options (review r4 B1) and its literal ones, a literal's `get`s
 * whose defaults are `get`s, adds of literals of host data (the exact add chain's runs and the prefix's entries), and a
 * literal's parses of host data (#1196).
 */
export const VALUE_CLASS_SITES: readonly WorkFamily[] = [
  {
    name: "S6c-choice-crossed-gets",
    measures:
      "TABLE r4.85, review r4 B1: a choice of k `l_i.get(0, default: a_(k-1-i))`, aliases of one list and one record, every field read",
    // 83,231 / 166,448 units at k = 64, 128 in both orders (2.0059; `main` 375,053 / 1,355,246, 3.62: the choice's
    // options read one by one at each field, a computed value having no read class)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          rows(k, (i) => `let l${i} = xs`),
          rows(k, (i) => `let a${i} = root`),
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: l${i}.get(0, default: a${k - 1 - i})}`).join(", ")}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "S6c-choice-records",
    measures:
      "TABLE r4.85: a choice of k records `{g: a_i}` of aliases of one record, every field read",
    // 69,454 / 139,052 units at k = 64, 128 (2.0071, reversed 2.0069; `main` 212,767 / 732,257, 3.45)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          rows(k, (i) => `let a${i} = root`),
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: {g: a${i}}}`).join(", ")}`,
          rows(k, (i) => `repeat box.g.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "S6c-nested-defaults",
    measures:
      "TABLE r4.85: a literal of k `l_i.get(0, default: l_(k-1-i).get(0, default: a_i))` of one list and one record, every field read",
    // 99,659 / 200,084 units at k = 64, 128 in both orders (2.0134; `main` 429,058 / 1,545,947, 3.61)
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          "let xs = [root]",
          rows(k, (i) => `let l${i} = xs`),
          rows(k, (i) => `let a${i} = root`),
          `let box = [${Array.from({ length: k }, (_, i) => `l${i}.get(0, default: l${k - 1 - i}.get(0, default: a${i}))`).join(", ")}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  // TABLE r4.87: each other operation family that composes below its root, its members k values of one source in one
  // choice of k options, every field read
  ...(
    [
      [
        "selections",
        (i: number) => `[a${i}].first`,
        "review r5 B1: an element selection of a literal",
      ],
      ["properties", (i: number) => `({g: a${i}}).g`, "a property of a literal"],
      ["otherwises", (i: number) => `maybe otherwise a${i}`, "an `otherwise` of a null-or-record"],
      ["calls", () => "give()", "a call's result"],
      ["loads", (i: number) => `load("k", default: a${i})`, "a `load` landing in no written type"],
      ["removals", (i: number) => `[a${i}].removeFirst()`, "a removal's result"],
      ["copies", (i: number) => `[a${i}].take(1)[0]`, "an element of a copy"],
      ["sums", (i: number) => `([a${i}] + [a${i}])[0]`, "an element of a list `+`"],
      ["choices", (i: number) => `askChoice {text: "a", value: a${i}}`, "a choice's answer"],
    ] as const
  ).map(([family, member, what]): WorkFamily => ({
    name: `S6c-choice-${family}`,
    measures: `TABLE r4.87: a choice of k options whose values are ${what} of aliases of one k-field record, every field read`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
          rows(k, (i) => `let a${i} = root`),
          "function give {\n  return root\n}",
          "let maybe = [null, root][0]",
          `let box = askChoice ${Array.from({ length: k }, (_, i) => `{text: "${i}", value: ${member(i)}}`).join(", ")}`,
          rows(k, (i) => `repeat box.f${i} {}`),
          "exit",
        ),
      ),
  })),
  // review r6 B2: adds of one typed ingress of one default, each its own source, at the prefix entries and the add run
  ...(
    [
      ["load", 'load("saved", default: seed)'],
      ["parse", 'fromJson("{}", default: seed, files: false)'],
    ] as const
  ).map(([kind, ingress]): WorkFamily => ({
    name: `S6c-${kind}-adds`,
    measures: `TABLE r4.87, review r6 B2: k adds of \`${ingress}\` of one k-field record, every field of the last read`,
    program: (k) =>
      main(
        lines(
          `let seed = {${fields(k, () => "1")}}`,
          "let gathered = []",
          rows(k, () => `gathered.add(${ingress})`),
          rows(k, (i) => `repeat gathered.last.f${i} {}`),
          "exit",
        ),
      ),
  })),
  {
    name: "S6c-record-adds-unknown",
    measures:
      "TABLE r4.85: k `ys.add({g: a_i})` of aliases of one k-field record of host data, every field read",
    // 152,934 / 307,973 units at k = 64, 128 in both orders (2.0197; `main` 487,159 / 1,729,478, 3.56: the exact
    // add chain walked per field, a literal having no read class)
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          rows(k, (i) => `let a${i} = root`),
          "let ys = []",
          rows(k, (i) => `ys.add({g: a${i}})`),
          rows(k, (i) => `repeat ys[0].g.f${i} {}`),
          "exit",
        ),
      ),
  },
  // #1196: a literal's parses of one host input with one default, each its own ingress, by the input's form: a read of
  // a host global, its projection and its element, which had no class (the leaf is the read's own), against a named
  // input and constant text, the controls. 47,078 / 94,472, 50,606 / 101,520 and 62,122 / 124,778 units at k = 64, 128
  // in both orders (2.0130, 2.0118, 2.0140; `main` 83,099 / 240,253, 86,307 / 246,661 and 95,968 / 266,208, 2.90, 2.87,
  // 2.78: each parse read at each field); the controls 2.0136 and 2.0122 on both
  ...(
    [
      ["direct", "hostValue"],
      ["projected", "hostValue.text"],
      ["indexed", "[hostValue][0]"],
      ["named", "raw"],
      ["constant", '"{}"'],
    ] as const
  ).map(([form, input]): WorkFamily => ({
    name: `I1196-${form}-input-parses`,
    measures: `#1196: a literal of k \`fromJson(${input}, default: seed, files: false)\` of one k-field record, every field read`,
    program: (k) =>
      main(
        lines(
          ...(form === "named" ? ["let raw = hostValue"] : []),
          `let seed = {${fields(k, () => "1")}}`,
          `let box = [${cells(k, `fromJson(${input}, default: seed, files: false)`)}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  })),
  // #1203: k loads of a computed key, one class, each read below its root at every field (F19: host data whatever the
  // path), the issue's shape and every key form beside every default
  {
    name: "I1203-computed-loads",
    measures: "#1203: a list of k `load(hostValue, default: 0)`, a field of its first read k times",
    // 36,641 / 73,481 units at k = 64, 128 in both orders (2.0132; `main` 56,667 / 154,499, 2.74: each load read at
    // each field)
    program: (k) =>
      main(
        lines(
          `let box = [${cells(k, "load(hostValue, default: 0)")}]`,
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "I1203-computed-load-forms",
    measures:
      "#1203: a list of k loads whose keys are a host value, a variable, a property, an element and a sum, their defaults `null`, a number, records of their own fields (a class each) and a choice of a list's buttons (no class), then a record added (the contract side), a field of its first read k times",
    // 56,979 / 113,229 units at k = 64, 128 in both orders (2.0130; `main` 85,065 / 226,755, 2.70; 2.32 with one
    // answer per class of loads, a class per default, #1208 review r1; `mergeItems` 3.11 where a load needs its
    // default's class, review r3)
    program: (k) => {
      const keys = ["hostValue", "key", "names.key", "keys[0]", 'key + "1"'];
      const defaults = (i: number): string =>
        ["null", "0", `{a${i}: 1}`, `{f0: {a${i}: 1}}`, "(askChoice [1, 2])"][(i * 2) % 5]!;
      return main(
        lines(
          'let key = "k"\nlet names = {key: "k"}\nlet keys = ["k"]',
          `let box = [${Array.from({ length: k }, (_, i) => `load(${keys[i % 5]}, default: ${defaults(i)})`).join(", ")}]`,
          "box.add({f0: 1})",
          rows(k, (i) => `repeat box[0].f${i} {}`),
          "exit",
        ),
      );
    },
  },
  {
    name: "I1203-written-loads",
    measures:
      "#1203: k loads into a written `object[]` (defaults of their own fields, and a number that does not fit) and k into a written `integer[]`, a record added to the first, a field of each list's first element read k times",
    // 97,092 / 194,520 units at k = 64, 128 (2.0217; reversed 2.0216; `main` 145,078 / 388,810, 2.70; 2.43 while a
    // load landing in a written type was read at every field, before the lead lifted that exclusion on #1208)
    program: (k) => {
      const defaults = (i: number): string =>
        [`{a${i}: 1}`, `{f0: {a${i}: 1}}`, "(askChoice [{a: 1}, {b: 2}])", `{a${i}: 1}`, "0"][
          i % 5
        ]!;
      return main(
        lines(
          'let key = "k"',
          `let box: object[] = [${Array.from({ length: k }, (_, i) => `load(${i % 2 === 0 ? "hostValue" : "key"}, default: ${defaults(i)})`).join(", ")}]`,
          `let ints: integer[] = [${cells(k, "load(hostValue, default: 0)")}]`,
          "box.add({f0: 1})",
          rows(k, (i) => `repeat box[0].f${i} {}`),
          rows(k, (i) => `repeat ints[0].f${i} {}`),
          "exit",
        ),
      );
    },
  },
  // #1210: a literal of k projections of one host read, bare or in records, read at k typed fields. Each keeps its own
  // leaf and its own landing stop, while the literal's entry, its elements' identity and their conflict class stay
  // shared (Codex review r1 B1: a fresh identity per projection read each element at each field in admission's
  // `literalElements`, 3.01 and 3.14). 34,422 / 68,854 and 52,186 / 104,378 units at k = 64, 128 in both orders
  // (2.0074, 2.0050; `main` 33,152 / 66,048 and 51,044 / 101,828: each keeps its own exact entry and stop)
  ...(
    [
      ["bare", "hostValue.root", "box[0]"],
      ["record", "{q: hostValue.root}", "box[0].q"],
    ] as const
  ).map(([form, member, receiver]): WorkFamily => ({
    name: `I1210-${form}-projected-reads`,
    measures: `#1210: a literal of k \`${member}\`, read at k typed fields of \`${receiver}\``,
    program: (k) =>
      main(
        lines(
          `let box = [${cells(k, member)}]`,
          rows(k, (i) => `let n${i}: integer = ${receiver}.f${i}`),
          "exit",
        ),
      ),
  })),
];

/**
 * Product (c) of W34's class: k literals of two typed ingresses (a `load` or a parse) of one k-field record default
 * added to one list, every field read. Each literal holding an ingress is its own source (TABLE §8 r4.15), so the key's
 * contract met k entries at each of the k reads (S4's product); S6c reads the entries of one shape once per field where
 * no unknown answers there (an unknown's ingress stores are each entry's own, C9), so every counter grows with the
 * program (§3.3's gate): 90,737 / 182,712 and 92,017 / 185,016 units at k = 64, 128 (2.0181, 2.0142; `main` 3.17, 3.16).
 */
export const ADMISSION_INGRESS_PRESETS: readonly WorkFamily[] = [
  ["A8-added-load-presets", 'load("k", default: seed)'],
  ["A8-added-parse-presets", 'fromJson("{}", default: seed)'],
].map(([name, ingress]) => ({
  name: name!,
  measures: `§8, A8: k literals of two \`${ingress}\` added to one list, every field read (Codex r12, Astra r2 D-W1)`,
  program: (k: number) =>
    main(
      lines(
        `let seed = {${fields(k, () => "1")}}`,
        "let xs = []",
        rows(k, () => `xs.add([${ingress}, ${ingress}])`),
        rows(k, (i) => `let shown${i}: integer = xs[0][0].f${i}`),
        "exit",
      ),
    ),
}));

/**
 * Read chains through nested literals (S6's PR, "Inherited products"; S6c): a list nested k deep read through k
 * `.first`, the same around a record read through k index steps, and a record nested k deep read through its k
 * properties. Each link reads a key one step longer, so the k keys' contracts and their texts grow with the chain's
 * depth (TABLE §8: a lookup costs the key's depth): gated known limits (TABLE r4.83 (2)) at their measured 64 → 128
 * step in r4.45's form, not a bound at larger sizes; reconsidered when a realistic chain approaches the allowance. On
 * `main` the `.first` chain grew as 2^k (each selection read its owner twice, at its step and whole, neither once: the
 * allowance at k = 20); S6c reads a selection's whole answer once per value, and a projection's path scans its member
 * steps once.
 */
export const READ_CHAIN_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "F12-first-chain",
    measures: "F12, §8: a list nested k deep read through k `.first` into a written destination",
    // 204,495 / 982,598 units at k = 64, 128 in both orders (4.9150); S6c measured 212,369 / 1,014,728 (4.8876):
    // S8 runs fewer frames (2,180 against 10,181 at k = 128), so the literal walk's square, the same 114,212 / 642,491
    // units, is a larger share; `main` before S6c stops at the allowance from k = 20
    measured: 4.92,
    program: (k) =>
      main(
        lines(
          `let value = ${"[".repeat(k)}1${"]".repeat(k)}`,
          `let n: integer = value${".first".repeat(k)}`,
          "exit",
        ),
      ),
  },
  {
    name: "F12-index-chain",
    measures:
      "F12, §8: a list nested k deep around a 4-field record of host data, each field read through k index steps",
    // 334,190 / 1,425,929 units at k = 64, 128 (4.4747; reversed 4.4756; `main` 707,530 / 4,318,378, 6.4008)
    measured: 4.49,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(4, () => "[1, raw][1]")}}`,
          `let box = ${"[".repeat(k)}root${"]".repeat(k)}`,
          rows(4, (i) => `repeat box${"[0]".repeat(k)}.f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "F12-member-chain",
    measures:
      "F12, §8: a record nested k deep read through its k properties into a written destination",
    // 197,206 / 959,101 units at k = 64, 128 in both orders (4.9309; `main` 261,675 / 1,496,830, 5.80)
    measured: 4.94,
    program: (k) =>
      main(
        lines(
          `let value = ${Array.from({ length: k }, (_, i) => `{m${i}: `).join("")}1${"}".repeat(k)}`,
          `let n: integer = value${Array.from({ length: k }, (_, i) => `.m${i}`).join("")}`,
          "exit",
        ),
      ),
  },
];

/**
 * Adds of several sources into one list strictly in turn (S6c's review r1, r2 B4): an add's certainty depends on the
 * state the adds before it leave, so each add of a mixed run is answered at each field read. Gated known limits (TABLE
 * r4.83 (5)) at their measured 64 → 128 step in r4.45's form (in the source order only on CI, TABLE r4.85), not a
 * bound at larger sizes; reconsidered when a
 * realistic straight-line run of dozens of alternating adds of several sources into one list appears. A script writes
 * tens of such adds at most (a loop body is one add to the analysis); two alternating sources reach the allowance near
 * 660 adds (29,748,699 units at 656). The sound fix, an order-aware summary of a mixed run, is a redesign of the exact
 * add chain's representation that buys linear work only beyond those tens; the cheaper forms are unsound (a window of
 * several classes dropped a warning and its check, r2 B4) or share nothing (a prefix memo keyed by the class sequence
 * has k keys).
 */
export const MIXED_ADD_PRODUCTS: readonly KnownProduct[] = [
  {
    name: "A5-two-sources-alternating-adds",
    measures: "§3.3: k adds alternating between two records of host data, each field read",
    // 405,404 / 1,336,783 units at k = 64, 128 in both orders (3.3102)
    measured: 3.36,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let root = {${fields(k, () => "[1, raw][1]")}}`,
          `let other = {${fields(k, () => "[2, raw][1]")}}`,
          "let xs = []",
          rows(k, (i) => (i % 2 === 0 ? "xs.add(root)" : "xs.add(other)")),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  {
    name: "A5-three-sources-adds",
    measures: "§3.3: k adds of three records of host data in the turn a, b, c, b, each field read",
    // 470,597 / 1,483,590 units at k = 64, 128 in both orders (3.1642)
    measured: 3.22,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          `let a = {${fields(k, () => "[1, raw][1]")}}`,
          `let b = {${fields(k, () => '["s", raw][1]')}}`,
          `let c = {${fields(k, () => "[2.5, raw][1]")}}`,
          "let xs = []",
          rows(k, (i) => `xs.add(${"abcb"[i % 4]})`),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  },
  ...[
    // 740,812 / 2,008,769 units at k = 64, 128 in both orders (2.7212)
    { n: 8, measured: 2.78 },
    // 798,340 / 2,124,045 units at k = 64, 128 (2.6700; reversed 2.6699)
    { n: 9, measured: 2.73 },
  ].map(({ n, measured }): KnownProduct => ({
    name: `A5-cycle-of-${n}-sources-adds`,
    measures: `§3.3: k adds of ${n} records of host data in turn, each field read`,
    measured,
    program: (k) =>
      main(
        lines(
          "let raw = hostValue",
          rows(n, (j) => `let s${j} = {${fields(k, () => `[${j}, raw][1]`)}}`),
          "let xs = []",
          rows(k, (i) => `xs.add(s${i % n})`),
          rows(k, (i) => `repeat xs[0].f${i} {}`),
          "exit",
        ),
      ),
  })),
];

/**
 * The member-answer oracle's own programs (S6-CARRIERS §4.1, condition (a)): Astra's two M1 witnesses (a conditional
 * store below the copied path before and between the copies), every alias form (a copy, a literal's cell, a list's, a
 * nested one, a literal index, a chain's link) beside the events its class answers through (a conditional store before
 * or between the copies, a copy under a test of its source or of a field, a store between them), literal cells beside
 * their literal's own contribution, which no alias may hold, and Astra's round-5 B1 shape (a written copy of a source
 * beside an unwritten one, at depths one and two, either first: two classes by their written types, TABLE r4.72). The
 * work test's oracle and the sharing differential run them.
 */
export const ORACLE_PROGRAMS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = (() => {
  const witnesses = ["before", "between"].map((at) => ({
    name: `M1, the conditional store ${at} the copies`,
    files: [
      {
        path: "main.tease",
        source: [
          "let raw = hostValue",
          "let root = {nested: {f0: [1, raw][1], f1: [1, raw][1]}}",
          "let box = {f0: null, f1: null}",
          ...(at === "before"
            ? ["if raw != null { root.nested.f0 = 1 }", "box = root.nested", "box = root.nested"]
            : ["box = root.nested", "if raw != null { root.nested.f0 = 1 }", "box = root.nested"]),
          "repeat box.f0 {}",
          "repeat box.f1 {}",
          "exit",
        ].join("\n"),
      },
    ],
  }));
  // every alias form (a copy, a literal's cell, a list's, a nested one, a literal index, a chain's link) beside the
  // events its class answers through: a conditional store before or between the copies, a copy under a test of its
  // source or of a field, a store between them
  const forms = [
    ["a copy", "root.nested", "", "root.nested"],
    ["a cell", "{data: root.nested}", ".data", "root.nested"],
    ["a list cell", "[root.nested]", "[0]", "root.nested"],
    ["a nested cell", "{a: {b: root.nested}}", ".a.b", "root.nested"],
    ["a literal index", "root.items[0]", "", "root.items[0]"],
    ["a chain's link", "link", "", "root.nested"],
  ] as const;
  const aliases = forms.flatMap(([form, value, at, source]) => {
    const copy = `box = ${value}`;
    const situations: readonly (readonly [string, readonly string[]])[] = [
      ["a conditional store before", [`if raw != null { ${source}.f0 = 1 }`, copy, copy]],
      ["a conditional store between", [copy, `if raw != null { ${source}.f0 = 1 }`, copy]],
      ["a guarded copy", [copy, `if ${source} != null { ${copy} }`, copy]],
      ["a field-guarded copy", [`if ${source}.f0 != null { ${copy} }`, copy]],
      ["a store between", [copy, `${source}.f1 = 2`, copy]],
    ];
    return situations.map(([situation, steps]) => ({
      name: `${form}, ${situation}`,
      files: [
        {
          path: "main.tease",
          source: [
            "let raw = hostValue",
            "let root = {nested: {f0: [1, raw][1], f1: [1, raw][1]}, items: [{f0: 1, f1: [1, raw][1]}]}",
            "let link = root.nested",
            at === "" ? "let box = {f0: null, f1: null}" : `let box = ${value}`,
            ...steps,
            `repeat box${at}.f0 {}`,
            `repeat box${at}.f1 {}`,
            "exit",
          ].join("\n"),
        },
      ],
    }));
  });
  // a cell beside a term of its literal's own at its path, or below an object of it without the cell's property (its
  // `missing` there), plain and guarded: no alias (Codex r22 F5, r23 F2)
  const beside = (
    [
      ["[root, 2.0]", "[0]"],
      ["[{f: root}, {g: 1}]", "[0].f"],
      ["dict{a: {f: root}, b: {g: 1}}", '["a"].f'],
    ] as const
  ).flatMap(([literal, read]) =>
    [`box = ${literal}`, `if root != null {\n  box = ${literal}\n}`].map((copy) => ({
      name: `a cell beside its literal's own contribution: ${copy}`,
      files: [
        {
          path: "main.tease",
          source: `let root = 1\nlet box = ${literal}\n${copy}\nrepeat box${read} {}\nexit`,
        },
      ],
    })),
  );
  const written = [false, true].flatMap((nested) =>
    [
      ["a", "b"],
      ["b", "a"],
    ].map(([first, second]) => ({
      name: `a written copy beside a copy of its source, ${nested ? "depth two" : "depth one"}, ${first} first`,
      files: [
        {
          path: "main.tease",
          source: [
            `let raw = [${nested ? "[hostValue]" : "hostValue"}]`,
            "let a = raw",
            `let b: integer[]${nested ? "[]" : ""} = raw`,
            `let out = ${first}`,
            `out = ${second}`,
            `out = [${nested ? "[hostValue]" : "hostValue"}]`,
            'say "AFTER"',
            "exit",
          ].join("\n"),
        },
      ],
    })),
  );
  return [...witnesses, ...aliases, ...beside, ...written];
})();

/**
 * S6c's differential programs (TABLE r4.72's standing differential, the brief's ten per shape): for each discovery S6c
 * shares (a choice's options, a run of adds, a literal's computed values, a prefix's entries of one shape) and for the
 * selection read once per value, programs whose answers would differ were the shared key coarser than the answer:
 * options of two written domains, a storing call or a guard between reads, a read beside its projection, host data,
 * a store or a guard inside a run of adds, a `get`'s default read guarded and unguarded, an ingress identity read at two
 * depths, a host cell beside each typed load, a chain of `.first` with a store between; and the check-first list's
 * shapes: a copy cycle's places, held and empty options, aliases around a conditional child store or a whole reset,
 * written, optional and null-only domains through parentheses, removals, dict projections and call results beside the
 * shared values, the path end; and review r1's: stable aliases around a store, in reverse order, stored again, written,
 * chained, guarded, read in a function, of a projection or host data, beside direct reads, as `get` defaults; adds of
 * a few sources in turn, broken by a store, a test or a call, a late class, nine classes, a long run; and review r2's:
 * two families in a written union list, where an equal window of classes is no equal answer (its B4), a chain of
 * aliases one of which is taken under a test, `get`s whose receivers' and defaults' alias writers cross; and TABLE
 * r4.85's class (`Contract.classOf`) at each site: computed and literal choice options, nested and literal defaults,
 * adds of literals and computed values, around a store, a guard, a differing proof, property or kind, host data and a
 * load, and warnings that name the writer a class's role minima and a literal's own role give; and TABLE r4.87's
 * families: selections, properties, lengths, calls, loads, sums, removals, copies and choices around crossing writers,
 * differing steps, names or callees, a store between calls, host data a mixed class reads each of, runs of `+` broken
 * by a writer or another term. Each of the first 49, and the class's pieces, was checked against a build with that
 * key made coarser (the PR's mutation tables). The sharing differential and the member-answer oracle run them in both
 * orders.
 */
export const VALUE_SHARING_PROGRAMS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = (
  [
    [
      "choice: options of two written domains",
      "let a: integer = 1",
      "let b: number = 1.5",
      'let box = askChoice {text: "a", value: a}, {text: "b", value: b}, {text: "c", value: a}',
      "let n: integer = box",
    ],
    [
      "choice: options a storing call separates",
      "global g = {f0: 1}",
      "function bump {",
      "  g.f0 = 2.5",
      '  return "b"',
      "}",
      'let box = askChoice {text: "a", value: g}, {text: bump(), value: g}',
      "repeat box.f0 {}",
    ],
    [
      "choice: options under a test of a field",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "if root.f0 is integer {",
      '  let box = askChoice {text: "a", value: root}, {text: "b", value: root}',
      "  repeat box.f0 {}",
      "  repeat box.f1 {}",
      "}",
    ],
    [
      "choice: a read beside its projection",
      "let raw = hostValue",
      "let root = {inner: {f0: [1, raw][1]}, f0: 2.5}",
      'let box = askChoice {text: "a", value: root.inner}, {text: "b", value: root}, {text: "c", value: root.inner}',
      "repeat box.f0 {}",
    ],
    [
      "choice: host data options",
      'let box = askChoice {text: "a", value: hostValue}, {text: "b", value: hostValue}',
      "repeat box {}",
    ],
    [
      "choice: computed options",
      "let raw = hostValue",
      'let pick = {text: "r", value: [1, raw][1]}',
      "let opts = [pick, pick]",
      "let box = askChoice opts, opts",
      "repeat box {}",
    ],
    [
      "choice: a written list beside an unwritten one",
      "let w: integer[] = [1]",
      "let u = [1]",
      "u = [2.5]",
      'let box = askChoice {text: "a", value: w}, {text: "b", value: u}, {text: "c", value: w}',
      "repeat box[0] {}",
    ],
    [
      "choice: two choices a store separates",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      'let one = askChoice {text: "a", value: root}, {text: "b", value: root}',
      "root.f0 = 2.5",
      'let two = askChoice {text: "a", value: root}, {text: "b", value: root}',
      "repeat one.f0 {}",
      "repeat two.f0 {}",
    ],
    [
      "choice: options by their text",
      "let raw = hostValue",
      'let t = ["x", raw][1]',
      'let box = askChoice {text: t}, {text: t}, {text: "y"}',
      "let s: string = box",
    ],
    [
      "choice: options of a guarded and an unguarded copy",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let copy = root",
      "if copy.f0 is integer {",
      '  let box = askChoice {text: "a", value: copy}, {text: "b", value: root}',
      "  repeat box.f0 {}",
      "}",
    ],
    [
      "add: a store below the list between adds",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(root)",
      "xs[0].f0 = 2.5",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
    ],
    [
      "add: adds under a test of the list",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "xs.add(root)",
      "if xs[0].f0 is integer {",
      "  xs.add(root)",
      "  xs.add(root)",
      "  xs.add(root)",
      "  repeat xs[0].f0 {}",
      "}",
    ],
    [
      "add: a store to the source between adds",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(root)",
      "root.f0 = 2.5",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
      "repeat xs[0].f1 {}",
    ],
    [
      "add: runs of addAll",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let rs = [root]",
      "let xs = []",
      "xs.addAll(rs)",
      "xs.addAll(rs)",
      "xs.addAll(rs)",
      "xs.addAll(rs)",
      "repeat xs[0].f0 {}",
    ],
    [
      "add: two lists interleaved",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = []",
      "let ys = []",
      "xs.add(root)",
      "ys.add(root)",
      "xs.add(root)",
      "ys.add(root)",
      "xs.add(root)",
      "ys.add(root)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
      "repeat ys[0].f1 {}",
    ],
    [
      "add: host values added",
      "let xs = []",
      "xs.add(hostValue)",
      "xs.add(hostValue)",
      "xs.add(hostValue)",
      "xs.add(hostValue)",
      "repeat xs[0] {}",
    ],
    [
      "add: a clear inside the run",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.clear()",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
    ],
    [
      "add: a call storing the list between adds",
      "let root = {f0: 1, f1: 1}",
      "global xs = []",
      "function push {",
      "  xs.add({f0: 2.5, f1: 2.5})",
      "  return 0",
      "}",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "let t = push()",
      "xs.add(root)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
    ],
    [
      "add: adds of two families after an element of a third",
      'let xs = [{f0: "s"}]',
      "let root = {f0: 1}",
      "let other = {f0: 2.5}",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "let n: integer = xs[1].f0",
    ],
    [
      "add: alternating sources",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let other = {f0: 1.5, f1: [1, raw][1]}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
      "repeat xs[0].f1 {}",
    ],
    [
      "add: adds of a source under a test of its field",
      "let root = {f0: 2.5, f1: 1}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "if root.f0 != null {",
      "  xs.add(root)",
      "  xs.add(root)",
      "  repeat xs[0].f0 {}",
      "}",
    ],
    [
      "add: a run's answer past its first add",
      "let root = {f0: 1}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "let s: string = xs[0].f0",
    ],
    [
      "get: a default read guarded and unguarded",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let one = [xs.get(0, default: root), xs.get(0, default: root)]",
      "if root.f0 is integer {",
      "  let two = [xs.get(0, default: root), xs.get(0, default: root)]",
      "  repeat two[0].f0 {}",
      "}",
      "repeat one[0].f0 {}",
    ],
    [
      "get: two receivers",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let ys = [{f0: 2.5, f1: 2.5}]",
      "let box = [xs.get(0, default: root), ys.get(0, default: root), xs.get(0, default: root)]",
      "repeat box[0].f0 {}",
    ],
    [
      "get: two defaults",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let other = {f0: 2.5, f1: 1}",
      "let xs = [root]",
      "let box = [xs.get(0, default: root), xs.get(0, default: other), xs.get(0, default: root)]",
      "repeat box[0].f0 {}",
      "repeat box[0].f1 {}",
    ],
    [
      "get: beside an otherwise of the same reads",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let maybe = [null, root][1]",
      "let box = [xs.get(0, default: root), maybe otherwise root, xs.get(0, default: root)]",
      "repeat box[0].f0 {}",
    ],
    [
      "get: gets a storing call separates",
      "global g = {f0: 1}",
      "function bump {",
      "  g.f0 = 2.5",
      "  return {f0: 1}",
      "}",
      "let xs = [{f0: 1}]",
      "let box = [xs.get(0, default: g), bump(), xs.get(0, default: g)]",
      "repeat box[0].f0 {}",
    ],
    [
      "get: gets of host keys",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let box = [xs.get(hostValue, default: root), xs.get(hostValue, default: root)]",
      "repeat box[0].f0 {}",
    ],
    [
      "get: gets of a host default",
      "let xs = [{f0: 1}]",
      "let box = [xs.get(0, default: hostValue), xs.get(0, default: hostValue)]",
      "repeat box[0].f0 {}",
    ],
    [
      "get: otherwise values in a record",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let maybe = [null, root][1]",
      "let box = {a: maybe otherwise root, b: maybe otherwise root}",
      "repeat box.a.f0 {}",
      "repeat box.b.f1 {}",
    ],
    [
      "get: gets of a written list",
      "let w: integer[] = [1]",
      "let box = [w.get(0, default: 1.5), w.get(0, default: 1.5), w.get(0, default: 1)]",
      "let n: integer = box[0]",
    ],
    [
      "get: gets whose default the source's later store changes",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let one = [xs.get(0, default: root), xs.get(0, default: root)]",
      "root.f0 = 2.5",
      "let two = [xs.get(0, default: root), xs.get(0, default: root)]",
      "repeat one[0].f0 {}",
      "repeat two[0].f0 {}",
    ],
    [
      "preset: an ingress identity read at two depths",
      "let seed = {a: {b: hostValue}, c: 1}",
      "let xs = []",
      'xs.add([load("k", default: seed)])',
      'xs.add([load("k", default: seed)])',
      'xs.add([load("k", default: seed)])',
      "let n: integer = xs[0][0].c",
      "repeat xs[0][0].a.b {}",
      "let m = xs[0][0].a",
    ],
    [
      "preset: loads of two defaults",
      "let one = {f0: 1}",
      'let two = {f0: "x"}',
      "let xs = []",
      'xs.add([load("k", default: one)])',
      'xs.add([load("k", default: two)])',
      'xs.add([load("k", default: one)])',
      "let n: integer = xs[0][0].f0",
    ],
    [
      "preset: loads landing in a written type",
      "let ys: number[] = []",
      'ys.add(load("k", default: 1))',
      'ys.add(load("k", default: 1))',
      'ys.add(load("k", default: 1))',
      "let n: integer = ys[0]",
    ],
    [
      "preset: a parse beside a load of one default",
      "let seed = {f0: 1}",
      "let xs = []",
      'xs.add([load("k", default: seed)])',
      'xs.add([fromJson("{}", default: seed)])',
      'xs.add([load("k", default: seed)])',
      "let n: integer = xs[0][0].f0",
    ],
    [
      "preset: a host cell beside each load",
      "let seed = {f0: 1}",
      "let xs = []",
      'xs.add([load("k", default: seed), hostValue])',
      'xs.add([load("k", default: seed), hostValue])',
      'xs.add([load("k", default: seed), hostValue])',
      "repeat xs[0][1] {}",
      "let n: integer = xs[0][0].f0",
    ],
    [
      "preset: guarded and unguarded adds",
      "let seed = {f0: 1}",
      "let xs = []",
      'let flag = askBoolean "f"',
      'xs.add([load("k", default: seed)])',
      "if xs != null {",
      '  xs.add([load("k", default: seed)])',
      "}",
      'xs.add([load("k", default: seed)])',
      "let n: integer = xs[0][0].f0",
    ],
    [
      "preset: a default read under a test",
      "let raw = hostValue",
      "let seed = {f0: [1, raw][1]}",
      "let xs = []",
      'xs.add([load("k", default: seed)])',
      "if seed.f0 is integer {",
      '  xs.add([load("k", default: seed)])',
      "}",
      'xs.add([load("k", default: seed)])',
      "repeat xs[0][0].f0 {}",
    ],
    [
      "preset: loads of a host default",
      "let xs = []",
      'xs.add([load("k", default: hostValue)])',
      'xs.add([load("k", default: hostValue)])',
      'xs.add([load("k", default: hostValue)])',
      "repeat xs[0][0] {}",
    ],
    [
      "preset: loads of a computed key",
      "let seed = {f0: 1}",
      "let xs = []",
      'let name = ["k", hostValue][1]',
      "xs.add([load(name, default: seed)])",
      "xs.add([load(name, default: seed)])",
      "xs.add([load(name, default: seed)])",
      "let n: integer = xs[0][0].f0",
    ],
    [
      "preset: loads added directly",
      "let seed = {f0: 1, f1: {g: hostValue}}",
      "let xs = []",
      'xs.add(load("k", default: seed))',
      'xs.add(load("k", default: seed))',
      'xs.add(load("k", default: seed))',
      "let n: integer = xs[0].f0",
      "repeat xs[0].f1.g {}",
    ],
    [
      "preset: host cells read through the contract",
      "let seed = {f0: 1}",
      "global xs = []",
      'xs.add([load("k", default: seed), hostValue])',
      'xs.add([load("k", default: seed), hostValue])',
      'xs.add([load("k", default: seed), hostValue])',
      "function look {",
      "  repeat xs[0][1] {}",
      "  let out = xs[0]",
      "  out = [1, 2]",
      "}",
      "look()",
    ],
    [
      "preset: host defaults read through the contract",
      "global xs = []",
      'xs.add([load("k", default: hostValue)])',
      'xs.add([load("k", default: hostValue)])',
      'xs.add([load("k", default: hostValue)])',
      "function look {",
      "  repeat xs[0][0] {}",
      "  let copy = xs",
      "  copy = [[1]]",
      "}",
      "look()",
    ],
    [
      "first: a chain with a store between",
      "let value = [[[1]]]",
      "let a = value.first.first",
      "value[0] = [[2.5]]",
      "let n: integer = value.first.first.first",
    ],
    [
      "first: a chain on host data",
      "let value = [[[hostValue]]]",
      "let n: integer = value.first.first.first",
    ],
    [
      "first: a chain under a test",
      "let raw = hostValue",
      "let value = [[[1, raw][1]]]",
      "if value.first.first is integer {",
      "  let n: integer = value.first.first",
      "}",
    ],
    [
      "first: first and last mixed",
      "let value = [[1, 2.5], [3]]",
      "let n: integer = value.last.first",
      "let m: integer = value.first.last",
    ],
    [
      "first: index and first mixed",
      "let value = [[[1]], [[2.5]]]",
      "let n: integer = value[0].first[0]",
      "let m: integer = value.first[1].first",
    ],
    [
      "choice: options of a copy cycle's places",
      'let flag = askBoolean "f"',
      "let a = {f0: 1}",
      "let b = {f0: 2.5}",
      "if flag {",
      "  a = b",
      "}",
      "b = a",
      'let box = askChoice {text: "x", value: a}, {text: "y", value: b}, {text: "z", value: a}',
      "repeat box.f0 {}",
    ],
    [
      "choice: held options beside a written one",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      'let opt = {text: "a", value: root}',
      'let box = askChoice opt, opt, {text: "b", value: root}',
      "repeat box.f0 {}",
      "repeat box.f1 {}",
    ],
    [
      "choice: options of an empty list",
      "let xs = []",
      'let box = askChoice {text: "a", value: xs}, {text: "b", value: xs}',
      "repeat box[0] {}",
    ],
    [
      "choice: options of a known root",
      "let root = {f0: 1, f1: 2.5}",
      'let box = askChoice {text: "a", value: root}, {text: "b", value: root}',
      "repeat box.f0 {}",
      "repeat box.f1 {}",
    ],
    [
      "choice: an option without a value beside ones with it",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      'let box = askChoice {text: "a", value: root}, {text: "b"}, {text: "c", value: root}',
      "repeat box.f0 {}",
    ],
    [
      "choice: a copy and its source a conditional child store separates",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: 1}",
      "let copy = root",
      "if raw != null {",
      "  root.f0 = 2.5",
      "}",
      'let box = askChoice {text: "a", value: copy}, {text: "b", value: root}, {text: "c", value: copy}',
      "repeat box.f0 {}",
      "repeat box.f1 {}",
    ],
    [
      "add: copies added around a conditional child store",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let copy = root",
      "let xs = []",
      "xs.add(copy)",
      "xs.add(copy)",
      "xs.add(copy)",
      "if raw != null {",
      "  copy.f0 = 2.5",
      "}",
      "xs.add(copy)",
      "xs.add(copy)",
      "repeat xs[0].f0 {}",
      "repeat xs[0].f1 {}",
    ],
    [
      "choice: projected copies a child store separates",
      "let raw = hostValue",
      "let root = {inner: {f0: [1, raw][1]}}",
      'let one = askChoice {text: "a", value: root.inner}, {text: "b", value: root.inner}',
      "if raw != null {",
      "  root.inner.f0 = 2.5",
      "}",
      'let two = askChoice {text: "a", value: root.inner}, {text: "b", value: root.inner}',
      "repeat one.f0 {}",
      "repeat two.f0 {}",
    ],
    [
      "add: a whole reset of the source inside a run",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "root = {f0: 2.5, f1: 2.5}",
      "xs.add(root)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
    ],
    [
      "get: defaults a conditional child store separates",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let one = [xs.get(0, default: root), xs.get(0, default: root)]",
      "if raw != null {",
      "  root.f0 = 2.5",
      "}",
      "let two = [xs.get(0, default: root), xs.get(0, default: root)]",
      "repeat one[0].f0 {}",
      "repeat two[0].f0 {}",
    ],
    [
      "get: an optional written default",
      "let d: integer? = null",
      "let xs = [1]",
      "let box = [xs.get(0, default: d), xs.get(0, default: d)]",
      "let n: integer = box[0]",
    ],
    [
      "get: a null-only written default",
      "let d: null = null",
      "let xs = [1]",
      "let box = [xs.get(0, default: d), xs.get(0, default: d)]",
      "let n: integer = box[0]",
    ],
    [
      "otherwise: parenthesized operands at the path end",
      "let raw = hostValue",
      "let maybe = [null, raw][1]",
      "let fill = 1",
      "let box = [(maybe) otherwise (fill), (maybe) otherwise (fill)]",
      "let n: integer = box[0]",
    ],
    [
      "choice: options of an optional written value",
      "let w: integer? = null",
      'let box = askChoice {text: "a", value: w}, {text: "b", value: w}',
      "let n: integer = box",
    ],
    [
      "choice: options of a null-only written value",
      "let w: null = null",
      'let box = askChoice {text: "a", value: (w)}, {text: "b", value: (w)}',
      "let n: integer = box",
    ],
    [
      "get: removals beside gets",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root, root]",
      "let box = [xs.get(0, default: root), xs.removeFirst(), xs.get(0, default: root)]",
      "repeat box[0].f0 {}",
    ],
    [
      "get: dict projections in a literal",
      "let raw = hostValue",
      "let d = dict{a: [1, raw][1], b: 2.5}",
      "let box = [d.values, d.values]",
      "repeat box[0][0] {}",
    ],
    [
      "get: call results in a literal",
      "let raw = hostValue",
      "function make {",
      "  return {f0: [1, raw][1]}",
      "}",
      "let box = [make(), make()]",
      "repeat box[0].f0 {}",
    ],
    [
      "choice: options at the path end",
      "let raw = hostValue",
      "let pick = [1, raw][1]",
      'let box = askChoice {text: "a", value: pick}, {text: "b", value: pick}, {text: "c", value: 2.5}',
      "let n: integer = box",
    ],
    [
      "preset: loads read at the path end",
      "let seed = {f0: 1}",
      "let xs = []",
      'xs.add([load("k", default: seed), load("k", default: seed)])',
      'xs.add([load("k", default: seed), load("k", default: seed)])',
      "let whole = xs[0][0]",
      "whole = {f0: 2.5}",
    ],
    [
      "alias: aliases taken around a store to their source",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      "root.f0 = 2.5",
      "let a2 = root",
      'let box = askChoice {text: "0", value: a0}, {text: "1", value: a2}, {text: "2", value: a1}',
      "repeat box.f0 {}",
      "repeat box.f1 {}",
    ],
    [
      "alias: options in the reverse of their aliases' order",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      "let a2 = root",
      'let box = askChoice {text: "2", value: a2}, {text: "1", value: a1}, {text: "0", value: a0}',
      "let n: integer = box.f0",
      "let s: string = box.f1",
    ],
    [
      "alias: an alias stored again later",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: a0}, {text: "1", value: a1}',
      "repeat box.f0 {}",
      "a1 = {f0: 2.5, f1: 2.5}",
    ],
    [
      "alias: a written alias beside an unwritten one",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0: object = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: a0}, {text: "1", value: a1}',
      "repeat box.f0 {}",
    ],
    [
      "alias: a chain of aliases beside a direct one",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = a0",
      "let a2 = root",
      'let box = askChoice {text: "0", value: a1}, {text: "1", value: a2}, {text: "2", value: a0}',
      "repeat box.f0 {}",
    ],
    [
      "alias: an alias taken under a test of its source's field",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "if root.f0 is integer {",
      "  let a1 = root",
      '  let box = askChoice {text: "0", value: a0}, {text: "1", value: a1}',
      "  repeat box.f0 {}",
      "  repeat box.f1 {}",
      "}",
    ],
    [
      "alias: aliases read in a function",
      "global root = {f0: [1, hostValue][1]}",
      "global a0 = root",
      "global a1 = root",
      "function pick {",
      '  let box = askChoice {text: "0", value: a0}, {text: "1", value: a1}',
      "  repeat box.f0 {}",
      "  return 0",
      "}",
      "let t = pick()",
    ],
    [
      "alias: aliases of a projection",
      "let raw = hostValue",
      "let root = {inner: {f0: [1, raw][1]}, f0: 2.5}",
      "let a0 = root.inner",
      "let a1 = root.inner",
      "let a2 = root",
      'let box = askChoice {text: "0", value: a0}, {text: "1", value: a1}, {text: "2", value: a2}',
      "repeat box.f0 {}",
    ],
    [
      "alias: aliases of host data",
      "let a0 = hostValue",
      "let a1 = hostValue",
      'let box = askChoice {text: "0", value: a0}, {text: "1", value: a1}',
      "repeat box {}",
    ],
    [
      "alias: aliases beside direct reads of their source",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "r", value: root}, {text: "0", value: a0}, {text: "1", value: a1}',
      "repeat box.f0 {}",
    ],
    [
      "alias: get defaults of aliases in reverse order",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let a0 = root",
      "let a1 = root",
      "let l0 = xs",
      "let l1 = xs",
      "let box = [l1.get(0, default: a0), l0.get(0, default: a1), l0.get(0, default: a0)]",
      "repeat box[0].f0 {}",
      "let s: string = box[1].f1",
    ],
    [
      "alias: aliases copied into a list after a store",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let xs = []",
      "xs.add(a0)",
      "root.f1 = 2.5",
      "let a1 = root",
      "xs.add(a1)",
      "xs.add(a0)",
      "xs.add(a1)",
      "repeat xs[0].f1 {}",
    ],
    [
      "chain: alternation a store breaks",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let other = {f0: [2, raw][1], f1: 2.5}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(other)",
      "xs[0].f1 = 1",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(other)",
      "repeat xs[0].f0 {}",
      "repeat xs[0].f1 {}",
    ],
    [
      "chain: alternating families after a third",
      'let xs = [{f0: "s"}]',
      "let a = {f0: 1}",
      "let b = {f0: 2.5}",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(a)",
      "let n: integer = xs[1].f0",
    ],
    [
      "chain: alternation, then a run of one",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let other = {f0: 1.5, f1: [1, raw][1]}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
    ],
    [
      "chain: a class that comes back late",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let b = {f0: 2.5, f1: [1, raw][1]}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(root)",
      "xs.add(b)",
      "xs.add(b)",
      "repeat xs[0].f0 {}",
    ],
    [
      "chain: nine classes in turn",
      "let raw = hostValue",
      "let s0 = {f0: [0, raw][1], f1: 0.5}",
      "let s1 = {f0: [1, raw][1], f1: 1.5}",
      "let s2 = {f0: [2, raw][1], f1: 2.5}",
      "let s3 = {f0: [3, raw][1], f1: 3.5}",
      "let s4 = {f0: [4, raw][1], f1: 4.5}",
      "let s5 = {f0: [5, raw][1], f1: 5.5}",
      "let s6 = {f0: [6, raw][1], f1: 6.5}",
      "let s7 = {f0: [7, raw][1], f1: 7.5}",
      "let s8 = {f0: [8, raw][1], f1: 8.5}",
      "let xs = []",
      "xs.add(s0)",
      "xs.add(s1)",
      "xs.add(s2)",
      "xs.add(s3)",
      "xs.add(s4)",
      "xs.add(s5)",
      "xs.add(s6)",
      "xs.add(s7)",
      "xs.add(s8)",
      "xs.add(s0)",
      "xs.add(s1)",
      "xs.add(s2)",
      "xs.add(s3)",
      "xs.add(s4)",
      "xs.add(s5)",
      "xs.add(s6)",
      "xs.add(s7)",
      "xs.add(s8)",
      "repeat xs[0].f0 {}",
      "let n: integer = xs[0].f1",
    ],
    [
      "chain: a window of seventeen",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let b = {f0: 2.5, f1: 1}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(root)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(root)",
      "repeat xs[0].f0 {}",
    ],
    [
      "chain: alternation under a test of the list",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let other = {f0: 1.5, f1: 1}",
      "let xs = []",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "if xs[0].f0 is integer {",
      "  xs.add(other)",
      "  xs.add(root)",
      "  xs.add(other)",
      "  repeat xs[0].f0 {}",
      "}",
    ],
    [
      "chain: alternating addAll",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let other = {f0: 2.5, f1: 1}",
      "let rs = [root]",
      "let os = [other]",
      "let xs = []",
      "xs.addAll(rs)",
      "xs.addAll(os)",
      "xs.addAll(rs)",
      "xs.addAll(os)",
      "xs.addAll(rs)",
      "repeat xs[0].f0 {}",
    ],
    [
      "chain: two families in a written union list, a window repeating",
      "let a = 1.5",
      'let b = "s"',
      "let xs: (number | string)[] = []",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(a)",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(a)",
      "let chosen = [xs.first, null].first",
      "chosen = 1",
    ],
    [
      "chain: the same with a random element",
      "let a = 1.5",
      'let b = "s"',
      "let xs: (number | string)[] = []",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(a)",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(a)",
      "let chosen = [xs.random, null].first",
      "chosen = 1",
    ],
    [
      "chain: two families, admitted only",
      "let a = 1.5",
      'let b = "s"',
      "let xs: (number | string)[] = []",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(a)",
      "xs.add(a)",
      "xs.add(b)",
      "xs.add(b)",
      "xs.add(a)",
      "let chosen = [xs.first, null].first",
    ],
    [
      "chain: a run of one family after two in a union list",
      "let a = 1.5",
      'let b = "s"',
      "let xs: (number | string)[] = []",
      "xs.add(b)",
      "xs.add(a)",
      "xs.add(a)",
      "xs.add(a)",
      "xs.add(a)",
      "let chosen = [xs.first, null].first",
      "chosen = 1",
    ],
    [
      "alias: a chain of aliases, one taken under a test",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1]}",
      "let a0 = root",
      "if root.f0 is integer {",
      "  let a1 = a0",
      "  let a2 = a1",
      '  let box = askChoice {text: "0", value: a0}, {text: "1", value: a1}, {text: "2", value: a2}',
      "  repeat box.f0 {}",
      "}",
    ],
    [
      "alias: get receivers and defaults with crossing writers",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1]}",
      "let xs = [root]",
      "let a0 = root",
      "let l1 = xs",
      "let a1 = root",
      "let l0 = xs",
      "let box = [l0.get(0, default: a0), l1.get(0, default: a1), l1.get(0, default: a0)]",
      "repeat box[0].f0 {}",
    ],
    [
      "class: choice gets whose alias writers cross",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let l0 = xs",
      "let l1 = xs",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: l0.get(0, default: a1)}, {text: "1", value: l1.get(0, default: a0)}',
      "repeat box.f0 {}",
      "let n: integer = box.f1",
    ],
    [
      "class: choice gets around a store to the source",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let a0 = root",
      "root.f0 = 2.5",
      "let a1 = root",
      'let box = askChoice {text: "0", value: xs.get(0, default: a0)}, {text: "1", value: xs.get(0, default: a1)}',
      "repeat box.f0 {}",
    ],
    [
      "class: choice gets of one receiver, the default reached in one",
      "let root = {f0: 1, f1: 1}",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: [a0].get(0, default: a1)}, {text: "1", value: [a0].get(1, default: "s")}',
      "repeat box.f0 {}",
    ],
    [
      "class: choice gets whose defaults' proofs differ",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: [a0].get(0, default: a1)}, {text: "1", value: [a0].get(3, default: a1)}',
      "let n: integer = box.f0",
    ],
    [
      "class: choice otherwise values of one source",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let maybe = [null, root][0]",
      "let m0 = maybe",
      "let m1 = maybe",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: m0 otherwise a1}, {text: "1", value: m1 otherwise a0}',
      "repeat box.f1 {}",
    ],
    [
      "class: a choice get beside an otherwise of the same reads",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let maybe = [null, root][0]",
      "let xs = [root]",
      'let box = askChoice {text: "0", value: xs.get(0, default: root)}, {text: "1", value: maybe otherwise root}, {text: "2", value: xs.get(0, default: root)}',
      "repeat box.f0 {}",
    ],
    [
      "class: computed choice options without objects",
      "let root = {f0: 1, f1: 1}",
      "let xs = [root]",
      'let box = askChoice xs.get(0, default: "a"), xs.get(0, default: "a")',
      "let s: string = box",
    ],
    [
      "class: choice records of aliases",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      "let a2 = root",
      'let box = askChoice {text: "0", value: {g: a2}}, {text: "1", value: {g: a0}}, {text: "2", value: {g: a1}}',
      "repeat box.g.f0 {}",
      "let n: integer = box.g.f1",
    ],
    [
      "class: choice records, one with another property",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: {g: a0}}, {text: "1", value: {g: a1, h: 2.5}}, {text: "2", value: {g: a0}}',
      "repeat box.g.f0 {}",
      "let n: integer = box.h",
    ],
    [
      "class: choice lists of a source and of host data",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      'let box = askChoice {text: "0", value: [root]}, {text: "1", value: [raw]}, {text: "2", value: [root]}',
      "repeat box[0].f0 {}",
    ],
    [
      "class: choice records holding computed values",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let l0 = xs",
      "let l1 = xs",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: {g: l0.get(0, default: a1)}}, {text: "1", value: {g: l1.get(0, default: a0)}}',
      "repeat box.g.f0 {}",
    ],
    [
      "class: choice records holding a load",
      "let raw = hostValue",
      "let seed = {f0: 1}",
      'let box = askChoice {text: "0", value: {g: load("k", default: seed)}}, {text: "1", value: {g: load("k", default: seed)}}',
      "let n: integer = box.g.f0",
    ],
    [
      "class: choice records read under a test",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      "if root.f0 is integer {",
      '  let box = askChoice {text: "0", value: {g: a0}}, {text: "1", value: {g: a1}}',
      "  repeat box.g.f0 {}",
      "}",
      'let other = askChoice {text: "0", value: {g: a0}}, {text: "1", value: {g: a1}}',
      "repeat other.g.f0 {}",
    ],
    [
      "class: nested defaults whose writers cross",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let l0 = xs",
      "let l1 = xs",
      "let a0 = root",
      "let a1 = root",
      "let box = [l0.get(0, default: l1.get(0, default: a0)), l1.get(0, default: l0.get(0, default: a1))]",
      "repeat box[0].f0 {}",
      "let n: integer = box[1].f1",
    ],
    [
      "class: nested defaults, one inner default host data",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let box = [xs.get(0, default: xs.get(0, default: root)), xs.get(0, default: xs.get(0, default: raw)), xs.get(0, default: xs.get(0, default: root))]",
      "repeat box[0].f0 {}",
    ],
    [
      "class: literal defaults of one shape",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let a0 = root",
      "let a1 = root",
      "let box = [xs.get(0, default: {f0: a0.f0, f1: 2.5}), xs.get(0, default: {f0: a1.f0, f1: 2.5})]",
      "repeat box[0].f1 {}",
    ],
    [
      "class: adds of records of aliases",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      "let ys = []",
      "ys.add({g: a0})",
      "ys.add({g: a1})",
      "ys.add({g: a0})",
      "ys.add({g: a1})",
      "ys.add({g: a0})",
      "repeat ys[0].g.f0 {}",
      "repeat ys.last.g.f1 {}",
    ],
    [
      "class: adds of records, one lacking a property",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let ys = []",
      "ys.add({g: root, h: 1})",
      "ys.add({g: root, h: 1})",
      "ys.add({g: root})",
      "ys.add({g: root, h: 1})",
      "ys.add({g: root, h: 1})",
      "ys.add({g: root, h: 1})",
      "let n: integer = ys[0].h",
      "repeat ys.random.g.f0 {}",
    ],
    [
      "class: adds of lists, a store to the source after the third",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let ys = []",
      "ys.add([root])",
      "ys.add([root])",
      "ys.add([root])",
      "root.f0 = 2.5",
      "ys.add([root])",
      "ys.add([root])",
      "repeat ys[0][0].f0 {}",
    ],
    [
      "class: adds of gets, a guard after the third",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let xs = [root]",
      "let ys = []",
      "ys.add(xs.get(0, default: root))",
      "ys.add(xs.get(0, default: root))",
      "ys.add(xs.get(0, default: root))",
      "if ys[0].f0 is integer {",
      "  ys.add(xs.get(0, default: root))",
      "  repeat ys.last.f0 {}",
      "}",
      "repeat ys.random.f1 {}",
    ],
    [
      "class: adds of otherwise values after a host value",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let maybe = [null, root][0]",
      "let ys = [raw]",
      "ys.add(maybe otherwise root)",
      "ys.add(maybe otherwise root)",
      "ys.add(maybe otherwise root)",
      "ys.add(maybe otherwise root)",
      "let chosen = [ys.first, null].first",
      "chosen = 1",
      "repeat ys.last.f0 {}",
    ],
    [
      "class: adds of records into a written list",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let ys: object[] = []",
      "ys.add({g: root})",
      "ys.add({g: root})",
      "ys.add({g: root})",
      "ys.add({g: root})",
      "repeat ys[0].g.f0 {}",
    ],
    [
      "writers: choice gets whose alias writers cross, a string beside an integer",
      'let root = {f0: "s"}',
      "let xs = [root]",
      "let l0 = xs",
      "let l1 = xs",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: l1.get(0, default: a0)}, {text: "1", value: l0.get(0, default: a1)}, {text: "2", value: {f0: 1}}',
      "let n: integer = box.f0",
    ],
    [
      "writers: choice gets whose alias writers cross, defaults first",
      'let root = {f0: "s"}',
      "let xs = [root]",
      "let a0 = root",
      "let a1 = root",
      "let l0 = xs",
      "let l1 = xs",
      'let box = askChoice {text: "0", value: l1.get(0, default: a0)}, {text: "1", value: l0.get(0, default: a1)}, {text: "2", value: {f0: 1}}',
      "let n: integer = box.f0",
    ],
    [
      "writers: choice records lacking a property another option has",
      "let root = {f0: 1}",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: {g: a1}}, {text: "1", value: {g: a0}}, {text: "2", value: {g: a0, h: 1}}',
      "let n: integer = box.h",
    ],
    [
      "writers: choice records of a string source beside an integer record",
      'let root = {f0: "s"}',
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: {g: a1}}, {text: "1", value: {g: a0}}, {text: "2", value: {g: {f0: 1}}}',
      "let n: integer = box.g.f0",
    ],
    [
      "writers: literal gets whose alias writers cross, a string beside an integer",
      'let root = {f0: "s"}',
      "let xs = [root]",
      "let l0 = xs",
      "let l1 = xs",
      "let a0 = root",
      "let a1 = root",
      "let box = [l1.get(0, default: a0), l0.get(0, default: a1), {f0: 1}]",
      "let n: integer = box[0].f0",
    ],
    [
      "writers: nested defaults whose writers cross, beside an integer",
      'let root = {f0: "s"}',
      "let xs = [root]",
      "let l0 = xs",
      "let l1 = xs",
      "let a0 = root",
      "let a1 = root",
      "let box = [l1.get(0, default: l0.get(0, default: a1)), l0.get(0, default: l1.get(0, default: a0)), {f0: 1}]",
      "let n: integer = box[0].f0",
    ],
    [
      "writers: adds of records lacking a property, one with it",
      "let root = {f0: 1}",
      "let ys = []",
      "ys.add({g: root})",
      "ys.add({g: root})",
      "ys.add({g: root})",
      "ys.add({g: root})",
      "ys.add({g: root, h: 1})",
      "let n: integer = ys[0].h",
    ],
    [
      "proof: choice gets of one literal receiver, the default reached in one",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1]}",
      "let a0 = root",
      'let other = {f0: "s"}',
      "let w = other",
      'let box = askChoice {text: "0", value: [a0].get(0, default: w)}, {text: "1", value: [a0].get(4, default: w)}',
      "let n: integer = box.f0",
    ],
    [
      "proof: adds of gets, the default reached from the second",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1]}",
      "let a0 = root",
      'let other = {f0: "s"}',
      "let w = other",
      "let ys = []",
      "ys.add([a0].get(0, default: w))",
      "ys.add([a0].get(4, default: w))",
      "ys.add([a0].get(4, default: w))",
      "ys.add([a0].get(4, default: w))",
      "let n: integer = ys[0].f0",
    ],
    [
      "family: choice selections whose alias writers cross, a string beside an integer",
      'let root = {f0: "s"}',
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: [a1].first}, {text: "1", value: [a0].first}, {text: "2", value: {f0: 1}}',
      "let n: integer = box.f0",
    ],
    [
      "family: choice selections of different steps",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      'let other = {f0: "s"}',
      "let a0 = root",
      'let box = askChoice {text: "0", value: [a0, other].first}, {text: "1", value: [a0, other].last}, {text: "2", value: [a0, other].first}',
      "let n: integer = box.f0",
    ],
    [
      "family: choice properties of different names",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      'let box = askChoice {text: "0", value: ({g: a0, h: {f0: "s"}}).g}, {text: "1", value: ({g: a0, h: {f0: "s"}}).h}',
      "let n: integer = box.f0",
    ],
    [
      "family: choice lengths of an object and a list",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      'let box = askChoice {text: "0", value: ({length: a0}).length}, {text: "1", value: [a0].length}',
      "repeat box {}",
    ],
    [
      "family: calls of two functions alike",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "function give {",
      "  return root",
      "}",
      "function other {",
      '  return {f0: "s"}',
      "}",
      'let box = askChoice {text: "0", value: give()}, {text: "1", value: other()}, {text: "2", value: give()}',
      "let n: integer = box.f0",
    ],
    [
      "family: adds of calls around a store to what they return",
      "global g = {f0: [1, hostValue][1]}",
      "function give {",
      "  return g",
      "}",
      "let ys = []",
      "ys.add(give())",
      "ys.add(give())",
      "ys.add(give())",
      'g = {f0: "s"}',
      "ys.add(give())",
      "ys.add(give())",
      "let n: integer = ys[0].f0",
    ],
    [
      "family: choice loads of a host-data default, each its own leaf",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: load("k", default: a0)}, {text: "1", value: load("k", default: a1)}, {text: "2", value: load("j", default: a0)}',
      "let n: integer = box.f0",
    ],
    [
      "family: literal loads of a known default",
      "let root = {f0: 1}",
      "let a0 = root",
      "let a1 = root",
      'let box = [load("k", default: a1), load("k", default: a0), {f0: "s"}]',
      "let n: integer = box[0].f0",
    ],
    [
      "family: adds of loads of a host-data default",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let ys = []",
      'ys.add(load("k", default: root))',
      'ys.add(load("k", default: root))',
      'ys.add(load("k", default: root))',
      'ys.add(load("k", default: root))',
      'ys.add(load("k", default: root))',
      "let n: string = ys[0].f0",
    ],
    [
      "family: choice sums of host data, an operand's identity",
      "let raw = hostValue",
      "let u = [1, raw][1]",
      "let m0 = u",
      "let m1 = u",
      'let box = askChoice {text: "0", value: m0 + 1}, {text: "1", value: m1 + 1}, {text: "2", value: m0 + 1}',
      "let s: string = box",
    ],
    [
      "family: literal records of sums of host data",
      "let raw = hostValue",
      "let u = [1, raw][1]",
      "let m0 = u",
      "let m1 = u",
      'let box = askChoice {text: "0", value: {g: m0 + 1}}, {text: "1", value: {g: m1 + 1}}',
      "let s: string = box.g",
    ],
    [
      "family: choice list sums whose alias writers cross",
      'let root = {f0: "s"}',
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: ([a1] + [a0])[0]}, {text: "1", value: ([a0] + [a1])[0]}, {text: "2", value: {f0: 1}}',
      "let n: integer = box.f0",
    ],
    [
      "family: a sum of terms whose writers descend",
      'let root = {f0: "s"}',
      "let a0 = root",
      "let a1 = root",
      "let a2 = root",
      "let gathered = [a2] + [a1] + [a0] + [a2] + [a1] + [a0] + [a2]",
      "let n: integer = gathered.last.f0",
    ],
    [
      "family: a sum of two terms in turn",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      'let other = {f0: "s"}',
      "let p0 = [root]",
      "let q0 = [other]",
      "let gathered = p0 + q0 + p0 + q0 + p0 + q0",
      "let n: integer = gathered.last.f0",
      "repeat gathered.first.f1 {}",
    ],
    [
      "family: a sum of one list of host data",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let piece = [root]",
      "let gathered = piece + piece + piece + piece + piece + piece",
      "let n: string = gathered.last.f0",
    ],
    [
      "family: choice removals and copies whose alias writers cross",
      'let root = {f0: "s"}',
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: [a1].removeFirst()}, {text: "1", value: [a0].removeFirst()}, {text: "2", value: [a1].take(1)[0]}, {text: "3", value: {f0: 1}}',
      "let n: integer = box.f0",
    ],
    [
      "family: choices of choices",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let a0 = root",
      "let a1 = root",
      'let box = askChoice {text: "0", value: askChoice {text: "x", value: a0}}, {text: "1", value: askChoice {text: "y", value: a1}}',
      "let n: string = box.f0",
    ],
    [
      "family: adds of choices of one source",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let ys = []",
      'ys.add(askChoice {text: "x", value: root})',
      'ys.add(askChoice {text: "x", value: root})',
      'ys.add(askChoice {text: "x", value: root})',
      'ys.add(askChoice {text: "x", value: root})',
      "repeat ys[0].f0 {}",
    ],
  ] as const
).map(([name, ...source]) => ({
  name,
  files: [{ path: "main.tease", source: `${source.join("\n")}\nexit\n` }],
}));

const parsed = (input: string, fallback: string | null = "seed"): string =>
  `fromJson(${input}${fallback === null ? "" : `, default: ${fallback}`}, files: false)`;

const joined = (k: number, part: (index: number) => string, by = ""): string =>
  Array.from({ length: k }, (_, index) => part(index)).join(by);

/** The orders a list of m peers takes at its i-th site (`peerOrders`). */
const PEER_ORDERS = {
  fixed: (m: number): number[] => Array.from({ length: m }, (_, j) => j),
  rotated: (m: number, i: number): number[] => Array.from({ length: m }, (_, j) => (i + j) % m),
  shuffled: (m: number, i: number): number[] => {
    const out = Array.from({ length: m }, (_, j) => j);
    let seed = (i * 2654435761 + 12345) >>> 0;
    for (let j = m - 1; j > 0; j -= 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const at = seed % (j + 1);
      [out[j], out[at]] = [out[at]!, out[j]!];
    }
    return out;
  },
  // (three of them, a distinct set at each of up to m·(m-1) sites)
  triple: (m: number, i: number): number[] => {
    const a = i % m;
    const b = (a + 1 + (Math.floor(i / m) % (m - 1))) % m;
    return [a, b, [(b + 1) % m, (b + 2) % m].find((j) => j !== a)!];
  },
  // (one set in two orders, alternating)
  twoOrders: (m: number, i: number): number[] =>
    Array.from({ length: m }, (_, j) => (i % 2 === 0 ? j : m - 1 - j)),
};

/** k lists of m = k/16 peers of one class (`peer(j, m)`), read at a host index, their orders taken in turn from `forms`. */
const peerOrders = (
  k: number,
  forms: readonly (keyof typeof PEER_ORDERS)[],
  peer: (j: number, m: number) => string,
  head = "",
): readonly SourceFile[] => {
  const m = k >> 4;
  return main(
    lines(
      head,
      rows(m, (j) => `let p${j} = ${peer(j, m)}`),
      rows(k, (i) => {
        const order = PEER_ORDERS[forms[i % forms.length]!](m, Math.floor(i / forms.length));
        return `let xs${i} = [${order.map((j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`;
      }),
      "exit",
    ),
  );
};

/**
 * #1357 (Astra's review r1 B1): k lists of k/16 peers of one class, in one order, rotated, shuffled, three of a distinct
 * set and two orders of one set in turn, each peer a k/2-long `max` chain (roles in its own text), a choice of k/2 host
 * reads (its leaves), or a k/2-long `max` chain over the peers' count of aliases of one value in its own rotation
 * (roles read elsewhere). A class's choice reads each peer's writers once (`Contract.#roleSource`) and decides each
 * set of peers once, whatever their order. Leaves are not shuffled, because admission walks each order's ingress union
 * apart. Aliases are not read in distinct triples, because each set of their writers is compared once.
 */
export const PEER_ORDER_FAMILIES: readonly WorkFamily[] = [
  {
    name: "peer-orders-of-own-roles",
    measures:
      "#1357: a set of peers with long roles in their own text, decided once whatever their order",
    program: (k) =>
      peerOrders(
        k,
        ["fixed", "rotated", "shuffled", "triple", "twoOrders"],
        () => `${"max(".repeat(k >> 1)}hostValue.n${joined(k >> 1, (i) => `, ${i})`)}`,
      ),
  },
  {
    name: "peer-orders-of-leaves",
    measures:
      "#1357: a set of peers with many leaves, their leaves joined once whatever their order",
    program: (k) =>
      peerOrders(
        k,
        ["fixed", "rotated", "triple", "twoOrders"],
        () => `askChoice ${joined(k >> 1, (i) => `{text: "${i}", value: hostValue.p${i}}`, ", ")}`,
      ),
  },
  {
    name: "peer-orders-of-other-writers",
    measures:
      "#1357: a set of peers whose long roles read different aliases, decided once whatever their order",
    program: (k) =>
      peerOrders(
        k,
        ["fixed", "rotated", "shuffled", "twoOrders"],
        (j, m) =>
          `${"max(".repeat(k >> 1)}x${j % m}${joined(k >> 1, (r) => `, x${(j + r + 1) % m})`)}`,
        lines(
          "let base = 1",
          rows(k >> 4, (j) => `let x${j} = base`),
        ),
      ),
  },
];

/**
 * #1196's controls: values over reads of host data in one literal, choice or run of adds, each beside what a coarser
 * class would merge: a parse without a default (open) and a default with a field of host data, every form of input,
 * another default, a written destination, a guard of the input, a store of the default between parses, literals of one
 * and of two host reads, records holding host data, adds of host reads and choices of host reads read together in
 * several lists. Each keeps its own leaves, diagnostics and checks: the sharing differential and the leaf comparison
 * (`type-core-sharing.test.ts`) run them in both orders.
 */
export const DIRECT_INGRESS_PROGRAMS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = (
  [
    [
      "open: a parse without a default among parses of one default",
      "let seed = {f0: 1, f1: 1}",
      `let box = [${parsed("hostValue")}, ${parsed("hostValue", null)}, ${parsed("hostValue")}]`,
      "repeat box[0].f0 {}",
      "let n: integer = box[0].f1",
    ],
    [
      "open: a default's field of host data",
      "let seed = {f0: 1, f1: [1, hostValue][1]}",
      `let box = [${parsed("hostValue")}, ${parsed("hostValue.text")}, ${parsed("hostValue")}]`,
      "repeat box[0].f0 {}",
      "let n: integer = box[0].f1",
    ],
    [
      "inputs: direct, projected, indexed, named, constant and computed",
      "let raw = hostValue",
      "let seed = {f0: 1, f1: 1}",
      `let box = [${["hostValue", "hostValue.text", "[hostValue][0]", "raw", '"{}"', 'hostValue otherwise "{}"', "hostValue"].map((input) => parsed(input)).join(", ")}]`,
      "repeat box[0].f0 {}",
      "let n: integer = box[0].f1",
    ],
    [
      "defaults: two of one shape and another kind",
      "let a = {f0: 1}",
      "let b = {f0: 2.5}",
      `let box = [${parsed("hostValue", "a")}, ${parsed("hostValue", "b")}, ${parsed("hostValue", "a")}]`,
      "let n: integer = box[0].f0",
    ],
    [
      "written: parses landing in a written list beside unwritten ones",
      "let seed = [1]",
      `let ws: number[][] = [${parsed("hostValue")}, ${parsed("hostValue")}]`,
      `let w: number[] = ${parsed("hostValue")}`,
      `let box = [${parsed("hostValue")}, ws[0], w, ${parsed("hostValue")}]`,
      "let n: integer = box[0][0]",
    ],
    [
      "guarded: parses of a tested host field beside one outside the test",
      "let seed = {f0: 1}",
      `let outside = ${parsed("hostValue.t")}`,
      "if hostValue.t is string {",
      `  let box = [${parsed("hostValue.t")}, outside, ${parsed("hostValue.t")}, ${parsed("hostValue")}]`,
      "  repeat box[0].f0 {}",
      "}",
    ],
    [
      "stored: a call storing the default between parses",
      "global seed = {f0: 1}",
      "function bump {",
      "  seed.f0 = 2.5",
      '  return "{}"',
      "}",
      `let box = [${parsed("hostValue")}, ${parsed("bump()")}, ${parsed("hostValue")}]`,
      "let n: integer = box[0].f0",
    ],
    [
      "stored: the default stored between two literals of parses",
      "let seed = {f0: 1}",
      `let one = [${parsed("hostValue")}, ${parsed("hostValue")}]`,
      "seed.f0 = 2.5",
      `let two = [${parsed("hostValue")}, ${parsed("hostValue")}]`,
      "let n: integer = one[0].f0",
      "let m: integer = two[0].f0",
    ],
    [
      "literals of one and of two host reads, and one beside a known element",
      "let box = [[hostValue][0], [hostValue, hostValue][1], [hostValue, 1][0], [hostValue][0]]",
      "let n: integer = box[0]",
    ],
    [
      "choice: records holding host data, one with a second host field",
      "let seed = {f0: 1}",
      'let box = askChoice {text: "a", value: {g: hostValue, s: seed}}, {text: "b", value: {g: hostValue, h: hostValue.t, s: seed}}, {text: "c", value: {g: hostValue, s: seed}}',
      "repeat box.s.f0 {}",
      "let n: integer = box.g",
    ],
    [
      "adds: parses of host data, one of another default and one without",
      "let seed = {f0: 1, f1: 1}",
      "let other = {f0: 2.5, f1: 1}",
      "let gathered = []",
      `gathered.add(${parsed("hostValue")})`,
      `gathered.add(${parsed("hostValue")})`,
      `gathered.add(${parsed("hostValue", "other")})`,
      `gathered.add(${parsed("hostValue")})`,
      `gathered.add(${parsed("hostValue", null)})`,
      "let n: integer = gathered.last.f0",
      "let m: integer = gathered[0].f1",
    ],
    [
      "adds: host reads in a run",
      "let gathered = []",
      "gathered.add(hostValue)",
      "gathered.add(hostValue)",
      "gathered.add(hostValue.t)",
      "gathered.add(hostValue)",
      "let n: integer = gathered[0]",
    ],
    [
      "choices of host reads, two or three read together in each list, also beside a literal (#1357)",
      'let left = askChoice {text: "0", value: hostValue.f0}, {text: "1", value: hostValue.f1}, {text: "2", value: hostValue.f2}',
      'let mid = askChoice {text: "0", value: hostValue.f0}, {text: "1", value: hostValue.f1}, {text: "2", value: hostValue.f2}',
      'let right = askChoice {text: "0", value: hostValue.f0}, {text: "1", value: hostValue.f1}, {text: "2", value: hostValue.f2}',
      "let xs0 = [left, right]",
      "let n0: integer = xs0[hostValue.i]",
      "let xs1 = [left, [0], right]",
      "let n1: integer = xs1[hostValue.i]",
      "let xs2 = [left, mid, right]",
      "let n2: integer = xs2[hostValue.i]",
      "let xs3 = [left, right]",
      "let n3: integer = xs3[hostValue.i]",
      "let xs4 = [left, mid, right]",
      "let n4: integer = xs4[hostValue.i]",
    ],
  ] as const
).map(([name, ...source]) => ({
  name,
  files: [{ path: "main.tease", source: `${source.join("\n")}\nexit\n` }],
}));

/**
 * S6's sharing faults (TABLE r4.83 (4)) that, with the sharing on, published their diagnostics in another order on
 * `main`: publication in source order of their sites (r4.86 (1)) makes them neutral (`type-core-sharing`'s own test).
 */
export const REORDERING_SHARING_FAULTS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = (
  [
    [
      "chain: a period of three",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let b = {f0: 2.5, f1: [1, raw][1]}",
      'let c = {f0: ["s", raw][1], f1: 1}',
      "let xs = []",
      ...Array.from({ length: 3 }, () => ["xs.add(root)", "xs.add(b)", "xs.add(c)"]).flat(),
      "repeat xs[0].f0 {}",
      "repeat xs[0].f1 {}",
    ],
    [
      "chain: alternation with a call storing the list",
      "let raw = hostValue",
      "let root = {f0: [1, raw][1], f1: [1, raw][1]}",
      "let other = {f0: 1.5, f1: 1}",
      "global xs = []",
      "function push {",
      '  xs.add({f0: "s", f1: "s"})',
      "  return 0",
      "}",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "xs.add(other)",
      "let t = push()",
      "xs.add(root)",
      "xs.add(other)",
      "xs.add(root)",
      "let n: integer = xs[0].f0",
    ],
  ] as const
).map(([name, ...source]) => ({
  name,
  files: [{ path: "main.tease", source: `${source.join("\n")}\nexit\n` }],
}));

/**
 * S6's sharing faults repaired, in the differential: #1077's adds of one class, each a candidate at the list's element
 * directly and through the list, published 16 diagnostics and 17 checks against 11 and 12 (Sol's r3).
 */
export const REPAIRED_SHARING_FAULTS: readonly {
  readonly name: string;
  readonly files: readonly SourceFile[];
}[] = [
  {
    name: "chain: six adds of a host element, its last and a random element read",
    files: [
      {
        path: "main.tease",
        source: `${[
          "let root = [1.5, hostValue].first",
          "let xs = [1.5]",
          ...Array.from({ length: 6 }, () => "xs.add(root)"),
          "let chosen = [xs.first, null].first",
          "chosen = 1",
          "repeat xs.last {}",
          "repeat xs.random {}",
        ].join("\n")}\nexit\n`,
      },
    ],
  },
];
