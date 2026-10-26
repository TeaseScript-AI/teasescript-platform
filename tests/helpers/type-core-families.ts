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

/**
 * Admission (TABLE §5, §10.3's admission combinations; the port plan's §3.3, M4 S6): the decided type over an empty, a
 * populated and a later mutated snapshot, several destinations of one source with different decided types, a rejected
 * destination beside its intact source, external ingresses merged with an opaque source, A5's candidates under k whole
 * presets of a record, A2's scan past external stores, the width of a record's written copies, a literal's records and a
 * replacement's misfits, the boundary checks of a literal's external cells, and the structure named elements bring to
 * a literal (projections of one record's lists, literals of one record's copies, or of the values operations carry of
 * it, added to a list); each at size k, linear.
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
    measures: `§4.3, A2: k copies of a k-field record guarded in ${variant}${variant === "k regions" ? ", one unguarded" : ""}, every field read and fitting`,
    program: (k) =>
      main(
        lines(
          `let root = {${fields(k, () => "1")}}`,
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
          rows(k, (i) => `let n${i}: integer = box.f${i}`),
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
  // S6-CARRIERS §3.2, §3.4 with Codex r20 B4 and B5: k nested own defaults, each walked once as a landing; k merged
  // host stores met by k consumers, each provenance node resolved once
  ...(
    [
      ["otherwise", (inner: string) => `null otherwise (${inner})`],
      ["get", (inner: string) => `[1].get(7, default: ${inner})`],
      ["load", (inner: string, i: number) => `load("k${i}", default: ${inner})`],
    ] as const
  ).map(([variant, wrap]): WorkFamily => ({
    name: `C9-nested-own-${variant}`,
    measures: `§3.2, C10: k nested own ${variant} defaults around one host value (Codex r20 B4)`,
    program: (k) => {
      let value = "hostValue";
      for (let i = k - 1; i >= 0; i -= 1) value = wrap(value, i);
      return main(lines(`let out = ${value}`, "repeat out {}", "exit"));
    },
  })),
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
];

/**
 * A6's chain of k dependent rejections (Sol's twelve-step witness at size k): each copy reads its source after the
 * source's misfit, so each rejection shows only in the pass after the one before it, k passes in all: TABLE §8's
 * passes × stores, each pass charged. A gated known limit by the owner's decision (TABLE r4.49, option A): its doubling
 * at k = 64 → 128 as measured, re-measured and proposed with its counts on a change to admission's passes, never
 * retuned; its trigger, a realistic script reaching the allowance through cascading rejections.
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
];

/**
 * Product (c) of W34's class: k literals of two typed ingresses (a `load` or a parse) of one k-field record default
 * added to one list, every field read. The solver's demands are S4's product, as on `main` (each literal holding an
 * ingress its own identity, TABLE §8 r4.15: k contract entries for each of the k reads), so the total is not gated as
 * linear; admission's own counters are (Astra r2 D-W1: the literals' conflict discovery is shared by their typed
 * defaults' class).
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
