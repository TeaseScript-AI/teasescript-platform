// spike 14's gates (TABLE §10.3): the work families W1-W45 at k = 8 to 1,024 (`work.jsonl`), at least one program per
// cell of §10.1 with the X conditions as pairs (`cells.jsonl`), and the pairwise product of §6's axes with §10.3's
// targeted combinations (`axes.jsonl`); 3a checkpoint 9, spike 14
// (R/3a-newcore/checkpoint-9/spike14/gates14/make-gates14.py), each program analysed by spike 14's `points14.mjs`.
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
const range = (n) => Array.from({ length: n }, (_, i) => i);
const list = (n, f) => range(n).map(f);
const L = (...xs) => xs.join("\n");
const rec = (k, v) => "{" + list(k, (i) => `f${i}: ${v}`).join(", ") + "}";
const fieldsOf = (k, v) => list(k, (i) => `f${i}: ${v}`).join(", ");

const w1 = (k) =>
  L(
    rows(k, (i) => `global score${i} = 0`),
    "function advanceDay {",
    rows(k, (i) => `score${i} += 1`),
    "}",
    rows(k, (i) => `function chapter${i} {\nsay "Chapter ${i}"\nadvanceDay()\n}`),
    rows(k, (i) => `chapter${i}()`),
    rows(k, (i) => `let shown${i}: integer = score${i}`),
    "exit",
  );
const w2 = (k, amount) =>
  L(
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
const w3 = (k) =>
  L(
    rows(k, (i) => `let inventory${i} = ["map"]`),
    'let pick = askChoice ["keep", "reset"]',
    rows(
      k,
      (i) =>
        `if pick == "reset" {\ninventory${i}.clear()\nrepeat 2 { inventory${i}.add("key") }\n}`,
    ),
    rows(k, (i) => `let item${i}: string = inventory${i}.first`),
    "exit",
  );
const w4 = (k) =>
  L(
    `let seed = {${list(k, (i) => `c${i}: 0`).join(", ")}}`,
    "let party = [seed, seed]",
    rows(k, (i) => `let preset${i} = seed\npreset${i}.c${i} = 1`),
    rows(k, (i) => `if hostFlag { party[0] = preset${i} }`),
    "for member in party {",
    rows(k, (i) => `member.c${i} = 0`),
    "}",
    rows(k, (i) => `let shown${i}: integer = party[0].c${i}`),
    "exit",
  );
const w5 = (k) =>
  L(
    `let state = {${fieldsOf(k, 0)}}`,
    `let preset = {${fieldsOf(k, '"none"')}}`,
    "function restore { if hostFlag { state = preset } }",
    rows(k, (i) => `function chapter${i} {\nrestore()\nlet shown${i} = state.f${i}\n}`),
    rows(k, (i) => `chapter${i}()`),
    "exit",
  );
const w6 = (k) =>
  L(
    `let seed = {${fieldsOf(k, 0)}}`,
    "let state = seed",
    rows(k, (i) => `let preset${i} = seed\npreset${i}.f${i} = ${i % 4 === 0 ? "1.5" : "1"}`),
    rows(k, (i) => `if hostFlag { state = preset${i} }`),
    rows(k, (i) => `let shown${i}: integer = state.f${i}`),
    "exit",
  );
const w7 = (k) =>
  L(
    "let n = 1",
    ...list(k, (i) => `label l${i}\nlet r${i}: integer = n\nn = ${i}\nif hostFlag { goto l${i} }`),
    "exit",
  );
const w9 = (k) =>
  L(
    'let preset = {score: 1, name: "a"}',
    rows(k, (i) => `let alias${i} = preset`),
    "if hostFlag { preset.score = 1.5 }",
    rows(k, (i) => `let shown${i}: integer = alias${i}.score`),
    "exit",
  );
const w10 = (k) =>
  L(
    `let seed = {${fieldsOf(k, 0)}}`,
    "let all = [" + list(k, () => "seed").join(", ") + "]",
    "if hostFlag { all[0].f0 = 1.5 }",
    rows(k, (i) => `let shown${i}: integer = all.first.f${i}`),
    "exit",
  );
const w11 = (k) =>
  L(
    "let count = 1",
    rows(k, (i) => `function set${i} { count = 1.5 }`),
    rows(k, (i) => `let shown${i}: integer = count\nset${i}()`),
    "exit",
  );
const w12 = (k, variant) => {
  if (variant === "ladder")
    return L(
      "let level = 1",
      "function change0 { level = 1.5 }",
      rows(k - 1, (i) => `function change${i + 1} { change${i}() }`),
      rows(k, (i) => `if hostFlag { change${i}() }`),
      "let shown: integer = level",
      "exit",
    );
  if (variant === "chain")
    return L(
      "let level = 1",
      "function wrap0 { level = 2 }",
      rows(k - 1, (i) => `function wrap${i + 1} { wrap${i}() }`),
      `wrap${k - 1}()`,
      rows(k, (i) => `let shown${i}: integer = level`),
      "exit",
    );
  return L(
    "let level = 1",
    ...list(
      k,
      (i) =>
        `if hostFlag { level = ${i} } else { level = ${i + 1} }\nlet shown${i}: integer = level`,
    ),
    "exit",
  );
};
const w13 = (k) => [
  {
    path: "main.tease",
    source: L(
      "global total = 0",
      rows(k, (i) => `call script("part${i}.tease")`),
      "let shown: integer = total",
      "exit",
    ),
  },
  ...list(k, (i) => ({ path: `part${i}.tease`, source: `total += ${i}\nend` })),
];
const w14 = (k, variant = "calls") => {
  if (variant === "functions")
    return L(
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
    );
  const hop = (i) => {
    const next = `"f${i + 1}.tease"`;
    const kind = variant !== "mixed" ? variant : ["calls", "goto", "function"][i % 3];
    if (kind === "calls") return `call ${next}\nend`;
    if (kind === "goto") return `goto ${next}`;
    return `function hop${i} { call ${next} }\nhop${i}()\nend`;
  };
  return [
    {
      path: "main.tease",
      source: L("global n = 1", 'call "f0.tease"', "wait 1 s", "let shown: integer = n", "exit"),
    },
    ...list(k, (j) => k - 1 - j).map((i) => ({
      path: `f${i}.tease`,
      source: i < k - 1 ? hop(i) : 'showPermanentButton "x" { n = 1.5 }\nend',
    })),
  ];
};
const w35 = (k, registration) => [
  {
    path: "main.tease",
    source: L(
      "global n = 1",
      ...list(k, (i) => `call "f${i}.tease"`),
      "wait 1 s",
      "let shown: integer = n",
      "exit",
    ),
  },
  ...list(k, (j) => k - 1 - j).map((i) => ({
    path: `f${i}.tease`,
    source:
      i < k - 1
        ? `goto "f${i + 1}.tease"`
        : registration
          ? 'showPermanentButton "x" { n = 1.5 }\nend'
          : "n = 2\nend",
  })),
];
const w36 = (k, variant) => {
  const fields = ["flag: 2.0", ...list(k, (i) => `p${i}: 2.0`)].join(", ");
  const wrapped = variant === "wrapper" || variant === "extra-alias";
  const lines = [
    `let root = {wrap: {${fields}}}`,
    wrapped ? "let picked = {one: [{two: root.wrap}]}" : "let picked = root.wrap",
  ];
  for (const i of range(k)) {
    const test = variant === "varied" ? `p${i}` : "flag";
    let body;
    if (variant === "extra-alias")
      body = `let a${i} = root.wrap\nlet b${i} = a${i}\npicked = {one: [{two: b${i}}]}`;
    else if (variant === "wrapper") body = `let a${i} = root.wrap\npicked = {one: [{two: a${i}}]}`;
    else body = `let a${i} = root.wrap\npicked = a${i}`;
    lines.push(`if root.wrap.${test} is integer { ${body} }`);
  }
  const path = wrapped ? "picked.one.first.two" : "picked";
  return L(...lines, ...list(k, (i) => `let got${i}: number = ${path}.p${i}`), "exit");
};
const w37 = (k, hoisted) => {
  const lines = [
    "let seed = {n0: 3, n1: 3}",
    "let selected = seed",
    ...list(k, () => "if seed.n0 is integer { selected = seed }"),
  ];
  if (hoisted)
    lines.push(
      "let w = {shell: [{payload: selected}]}",
      "let bag = [" + list(k, () => "w").join(", ") + "]",
    );
  else
    lines.push(
      ...list(k, (i) => `let w${i} = {shell: [{payload: selected}]}`),
      "let bag = [" + list(k, (i) => `w${i}`).join(", ") + "]",
    );
  return L(...lines, "repeat bag.first.shell.first.payload.n1 {}", "exit");
};
const w38 = (k) => {
  const lines = [`let seed = {${list(k + 1, (i) => `n${i}: 3`).join(", ")}}`, "let merged = seed"];
  for (const i of range(k))
    lines.push(
      `let a${i} = seed`,
      `if a${i}.n0 is not integer { exit }`,
      `let b${i} = a${i}`,
      `if b${i}.n0 is not integer { exit }`,
      `let c${i} = b${i}`,
      `if hostFlag { merged = c${i} }`,
    );
  return L(...lines, ...list(k, (j) => `repeat merged.n${j + 1} {}`), "exit");
};
const w39 = (k, registration) => {
  const main = [
    "global n = 1",
    'call "f0.tease"',
    ...(registration ? ["wait 1 s"] : []),
    "let checked: integer = n",
    "exit",
  ];
  const last = (registration ? 'showPermanentButton "change" { n = 1.5 }\n' : "") + "end";
  const reversed = list(k, (j) => k - 1 - j);
  return [
    { path: "main.tease", source: L(...main) },
    ...reversed.map((i) => ({
      path: `f${i}.tease`,
      source:
        `if hostFlag { call "g${i}.tease" }\n` + (i < k - 1 ? `goto "f${i + 1}.tease"` : last),
    })),
    ...reversed.map((i) => ({
      path: `g${i}.tease`,
      source: i < k - 1 ? `call "g${i + 1}.tease"\nend` : "exit",
    })),
  ];
};
const w40 = (k, files) => {
  const fields = fieldsOf(k, '"x"');
  const asks = list(k, (i) => `say picked.f${i} + 1`);
  if (!files)
    return L(
      `let root = {wrap: {${fields}}}`,
      "let picked = root.wrap",
      ...list(
        k,
        (i) =>
          `function contribute${i} { if root.wrap.f${i} is integer { picked = root.wrap } }\ncontribute${i}()`,
      ),
      ...asks,
      "exit",
    );
  const main = [
    `global root = {wrap: {${fields}}}`,
    "global picked = root.wrap",
    ...list(k, (i) => `call "part${i}.tease"`),
    ...asks,
    "exit",
  ];
  return [
    { path: "main.tease", source: L(...main) },
    ...list(k, (i) => ({
      path: `part${i}.tease`,
      source: `if root.wrap.f${i} is integer { picked = root.wrap }\nend`,
    })),
  ];
};
const w40l = (k, variant) => {
  if (variant === "logical")
    return L(
      `let root = ${rec(k, '"bad"')}`,
      "let chosen = root",
      rows(k, (i) => `function pick${i} { chosen = root }\npick${i}()`),
      rows(
        k,
        (i) =>
          `say root.f${i} is integer and hostFlag\nif chosen.f${i} is integer { repeat chosen.f${i} {} }`,
      ),
      "exit",
    );
  return L(
    `let root = {wrap: {${fieldsOf(k, '"x"')}}}`,
    "let picked = root.wrap",
    rows(
      k,
      (i) =>
        `function take${i} {\nlet checked${i} = root.wrap.f${i} is integer and root.wrap.f${i} == 1\npicked = root.wrap\n}\ntake${i}()`,
    ),
    rows(k, (i) => `say picked.f${i} + "tail"`),
    "exit",
  );
};
const w41 = (k, terminal) => [
  {
    path: "main.tease",
    source: L(
      ...list(k, (i) => `global function hop${i} { ${i + 1 < k ? `hop${i + 1}()` : terminal} }`),
      ...list(k, (i) => `call "leaf${i}.tease"`),
      "exit",
    ),
  },
  ...list(k, (i) => ({ path: `leaf${i}.tease`, source: "hop0()\nend" })),
];
const w42 = (k) => [
  {
    path: "main.tease",
    source: L(
      ...list(k, (i) => `showPermanentButton "b${i}" { end }`),
      ...list(k, (i) => `call "leaf${i}.tease"`),
      "exit",
    ),
  },
  ...list(k, (i) => ({ path: `leaf${i}.tease`, source: "wait 1 s\nend" })),
];
const w43 = (k) => [
  { path: "main.tease", source: L(...list(k, (i) => `call "leaf${i}.tease"`), "exit") },
  ...list(k, (i) => ({ path: `leaf${i}.tease`, source: 'goto "tail.tease"' })),
  { path: "tail.tease", source: "end" },
];
const w27 = (k, variant) => {
  if (variant === "tests")
    return L(
      "let n = 1",
      "if hostFlag { n = null }",
      rows(k, () => "if n != null { repeat n {} }"),
      "exit",
    );
  if (variant === "unsuccessful")
    return L(
      "let n = 1",
      rows(k, () => "if hostFlag {\nn = null\nexit\n}\nrepeat n {}"),
      "exit",
    );
  const restore = "function restore {\nn = 2\nreturn true\n}";
  if (variant === "writer-suffix")
    return L(
      "let n = 1",
      restore,
      rows(k, () => "if hostFlag {\nn = null\nrestore()\n}\nrepeat n {}"),
      "exit",
    );
  if (variant === "mixed")
    return L(
      "let n = 1",
      restore,
      rows(
        k,
        () => "if hostFlag { n = null }\nif hostFlag { n = 2 } else { restore() }\nrepeat n {}",
      ),
      "exit",
    );
  return L(
    "let n = 1",
    restore,
    rows(k, () => "if hostFlag { n = null }\nif restore() { repeat n {} }"),
    "exit",
  );
};
const w28 = (k) =>
  L(
    "let xs = [1, null]",
    rows(k, (i) => `if xs[${i}] == null { exit }`),
    rows(k, () => "repeat xs[0] {}"),
    "exit",
  );
const w29 = (k, variant) => {
  if (variant === "scalar")
    return L(
      rows(k, (i) => `let v${i} = 1\nif hostFlag { v${i} = null }`),
      rows(k, (i) => `if v${i} == null { exit }`),
      "repeat 2 {",
      rows(k, (i) => `v${i} = v${i} + 1`),
      rows(k, (i) => `repeat v${i} {}`),
      "}",
      "exit",
    );
  const store = variant === "same-path" ? (i) => `xs[i${i}] = 1` : (i) => `xs[${i}] = 1`;
  return L(
    "let xs = [" + list(k, () => "1").join(", ") + ", null]",
    rows(k, (i) => `let i${i} = ${i}`),
    rows(k, (i) => `if xs[i${i}] == null { exit }`),
    "repeat 2 {",
    rows(k, store),
    rows(k, (i) => `repeat xs[i${i}] {}`),
    "}",
    "exit",
  );
};
const w30 = (k, variant) => {
  const head = L(`let r = ${rec(k, 1)}`, `if hostFlag { r = ${rec(k, "null")} }`);
  const reads = () => rows(k, (i) => `repeat r.f${i} {}`);
  if (variant === "and" || variant === "or") {
    const test = variant === "and" ? " != null and " : " == null or ";
    const cond =
      list(k, (i) => `r.f${i}${test}`).join("") + list(k, (i) => `r.f${i}`).join(" + ") + " > 0";
    return L(head, `if ${cond} { say "ok" }`, "exit");
  }
  if (variant === "arm")
    return L(
      head,
      "if " + list(k, (i) => `r.f${i} != null`).join(" and ") + " {",
      reads(),
      "}",
      "exit",
    );
  if (variant === "else")
    return L(
      head,
      "if " + list(k, (i) => `r.f${i} == null`).join(" or ") + ' { say "no" } else {',
      reads(),
      "}",
      "exit",
    );
  if (variant === "operands")
    return L(
      head,
      "if " +
        ["r.f0 != null", ...list(k - 1, (i) => `r.f${i} + 1 > 0 and r.f${i + 1} != null`)].join(
          " and ",
        ) +
        ' { say "ok" }',
      "exit",
    );
  return L(
    head,
    "if " + list(k, (i) => `(r.f${i} != null and r.f${i} > 0)`).join(" and ") + " {",
    reads(),
    "}",
    "exit",
  );
};
const w32 = (k) =>
  L(
    `let full = ${rec(k, 1)}`,
    `let absent = ${rec(k, "null")}`,
    "let picked = full",
    rows(k, () => "if hostFlag { picked = absent }"),
    rows(k, (i) => `say picked.f${i} + 1`),
    "exit",
  );
const w32c = (k, variant) => {
  const head = L(
    `let box = ${rec(k, 1)}`,
    `let empty = ${rec(k, "null")}`,
    rows(k, () => "if hostFlag { box = empty }"),
  );
  if (variant === "own-store")
    return L(
      head,
      rows(k, (i) => `if hostFlag { box.f${i} = 2 }`),
      rows(k, (i) => `repeat box.f${i} {}`),
      "exit",
    );
  if (variant === "own-test")
    return L(
      head,
      rows(k, (i) => `if box.f${i} != null { say "seen" }`),
      rows(k, (i) => `repeat box.f${i} {}`),
      "exit",
    );
  if (variant === "test-read")
    return L(
      `let box = ${rec(k, 1)}`,
      `let source = ${rec(k, "null")}`,
      rows(k, () => "if hostFlag { box = source }"),
      rows(k, (i) => `if box.f${i} != null {}\nrepeat box.f${i} {}`),
      "exit",
    );
  return L(
    `let box = ${rec(k, 1)}`,
    `if hostFlag { box = ${rec(k, "null")} }`,
    rows(k, (i) => `repeat box.f${i} {}`),
    "exit",
  );
};
const w33 = (k, variant) => {
  const ret = { calls: [], header: ["return true"], operand: ["return 0"] }[variant];
  const head = L(
    'let clear = askBoolean "Clear?"',
    rows(k, (i) => `let n${i} = 1`),
    "function restoreAll {",
    rows(k, (i) => `n${i} = 2`),
    ...ret,
    "}",
    "if clear {",
    rows(k, (i) => `n${i} = null`),
    "}",
  );
  if (variant === "calls")
    return L(
      head,
      rows(k, () => "restoreAll()"),
      rows(k, (i) => `repeat n${i} {}`),
      "exit",
    );
  if (variant === "header")
    return L(
      head,
      rows(k, (i) => `if restoreAll() { repeat n${i} {} }`),
      "exit",
    );
  return L(
    head,
    rows(k, (i) => `say restoreAll() + n${i}`),
    "exit",
  );
};
const w34 = (k, variant) => {
  const asks = L('let clear = askBoolean "Clear?"', 'let duplicate = askBoolean "Copy again?"');
  if (variant === "record")
    return L(
      asks,
      `let root = ${rec(k, 1)}`,
      `if clear { root = ${rec(k, "null")} }`,
      "let a0 = root",
      "if duplicate { a0 = root }",
      rows(k - 1, (i) => `let a${i + 1} = a${i}\nif duplicate { a${i + 1} = a${i} }`),
      rows(k, (i) => `repeat a${k - 1}.f${i} {}`),
      "exit",
    );
  if (variant === "scalar-chain" || variant === "scalar-fan") {
    const uses = variant === "scalar-chain" ? 1 : k;
    return L(
      asks,
      "let n = 1",
      "if clear { n = null }",
      "let s0 = n",
      "if duplicate { s0 = n }",
      rows(k - 1, (i) => `let s${i + 1} = s${i}\nif duplicate { s${i + 1} = s${i} }`),
      rows(uses, () => `repeat s${k - 1} {}`),
      "exit",
    );
  }
  return L(
    'let change = askBoolean "Change?"',
    rows(k, (i) => `let n${i} = 1\nif change { n${i} = 1 otherwise null }\nrepeat n${i} {}`),
    "exit",
  );
};
const w34w = (k) =>
  L(
    `let box0 = ${rec(k, 1)}`,
    `if hostFlag { box0 = ${rec(k, "null")} }`,
    rows(k, (i) => `let box${i + 1} = box${i}`),
    rows(k, (i) => `repeat box${k}.f${i} {}`),
    "exit",
  );
const w34t = (k, variant) => {
  const head = L(`let box0 = ${rec(k, 1)}`, `if hostFlag { box0 = ${rec(k, "null")} }`);
  const reads = (last) => rows(k, (i) => `repeat ${last}.f${i} {}`);
  if (variant === "tested")
    return L(
      head,
      rows(k, (i) => `if box${i}.f0 != null {}\nlet box${i + 1} = box${i}`),
      reads(`box${k}`),
      "exit",
    );
  if (variant === "guarded")
    return L(
      head,
      rows(k, (i) => `if box${i}.f0 != null {repeat box${i}.f0 {}}\nlet box${i + 1} = box${i}`),
      reads(`box${k}`),
      "exit",
    );
  if (variant === "each")
    return L(
      head,
      rows(k, (i) => `if box${i}.f${i} != null {}\nlet box${i + 1} = box${i}`),
      reads(`box${k}`),
      "exit",
    );
  if (variant === "fan")
    return L(
      head,
      rows(k, (i) => `if box${i}.f0 != null {}\nlet box${i + 1} = box${i}`),
      rows(k, (i) => `let leaf${i} = box${k}`),
      rows(k, (i) => `repeat leaf${i}.f${i} {}`),
      "exit",
    );
  return L(
    `let box0 = {inner: ${rec(k, 1)}}`,
    `if hostFlag { box0 = {inner: ${rec(k, "null")}} }`,
    rows(k, (i) => `if box${i}.inner.f0 != null {}\nlet box${i + 1} = box${i}`),
    rows(k, (i) => `repeat box${k}.inner.f${i} {}`),
    "exit",
  );
};
const w34r = (k, variant) => {
  if (variant === "fan-marks")
    return L(
      `let root = ${rec(k, 1)}`,
      `if hostFlag { root = ${rec(k, "null")} }`,
      rows(
        k,
        (i) =>
          `if root.f${i} != null {\nif root.f${i} > 0 {\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}\n}`,
      ),
      "exit",
    );
  if (variant === "fan-and" || variant === "chain-and")
    return L(
      'let seed = load("n", default: null)',
      "let box0 = {" + list(k, (i) => `f${i}: seed`).join(", ") + "}",
      "if " + list(k, (i) => `box0.f${i} > 0`).join(" and ") + " {",
      rows(k, (i) => `let box${i + 1} = box${variant === "chain-and" ? i : 0}`),
      rows(k, (i) => `repeat box${i + 1}.f${i} {}`),
      "}",
      "exit",
    );
  const test = variant === "stores-tested";
  return L(
    `let box0 = ${rec(k, 1)}`,
    `if hostFlag { box0 = ${rec(k, "null")} }`,
    rows(
      k,
      (i) =>
        (test ? `if box${i}.f${i} != null {}\n` : "") +
        `if hostFlag { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`,
    ),
    rows(k, (i) => `repeat box${k}.f${i} {}`),
    "exit",
  );
};
const w44 = (k, variant) => {
  if (variant === "dict")
    return L(
      "let root = dict{}",
      rows(k, (i) => `root["f" + "${i}"] = {v: 1}`),
      rows(k, (i) => `root["f" + "${i}"].v = 2\nlet p${i} = root["f" + "${i}"]\nrepeat p${i}.v {}`),
      "exit",
    );
  if (variant === "depth3")
    return L(
      "let root = {" + list(k, (i) => `f${i}: {g: {v: 1}}`).join(", ") + "}",
      rows(k, (i) => `root.f${i}.g.v = 2\nlet p${i} = root.f${i}\nrepeat p${i}.g.v {}`),
      "exit",
    );
  return L(
    "let root = {" + list(k, (i) => `f${i}: {v: 1}`).join(", ") + "}",
    rows(k, (i) => `root.f${i}.v = 2\nlet p${i} = root.f${i}\nrepeat p${i}.v {}`),
    "exit",
  );
};
const w45 = (k, variant) =>
  L(
    `let a = ${rec(k, 1)}`,
    `let b = ${rec(k, 1)}`,
    rows(k, (i) => `a.f${i} = 2\nb.f${i} = 3`),
    rows(
      k,
      (i) =>
        `let d${i} = a\n` +
        (variant === "conditional" ? `if hostFlag { d${i} = b }` : `d${i} = b`) +
        `\nrepeat d${i}.f${i} {}`,
    ),
    "exit",
  );
const w27n = (k) =>
  L(
    "let n: integer | string | null = 1",
    'if hostFlag { n = "bad" }',
    "if hostFlag { n = null }",
    rows(k, () => "if n == null { exit }"),
    rows(k, () => "repeat n {}"),
    "exit",
  );
const wstack = (k, variant) => {
  if (variant === "and")
    return L(
      "let n = 1",
      "if hostFlag { n = null }",
      "if " + list(k, () => "n != null").join(" and ") + " { repeat n {} }",
      "exit",
    );
  return L(
    "let xs = [1, null]",
    rows(k, () => "if xs is not integer[] { exit }"),
    rows(k, () => "repeat xs[0] {}"),
    "exit",
  );
};
const w31 = (k) =>
  L(
    "let xs = [1, null]",
    rows(k, (i) => `if xs[${i}] == null { exit }`),
    rows(k, () => "xs.reverse()"),
    rows(k, (i) => `repeat xs[${i}] {}`),
    "exit",
  );
const w15 = (k) =>
  L(
    `let seed = {${fieldsOf(k, 0)}}`,
    "let state = seed",
    rows(
      k,
      (i) => `let preset${i} = seed\npreset${i}.f${i} = 1\npreset${i}.f${(i * 7 + 3) % k} = 2`,
    ),
    rows(k, (i) => `if hostFlag { state = preset${i} }`),
    rows(k, (i) => `let shown${i}: integer = state.f${i}`),
    "exit",
  );
const w16 = (k) =>
  L(
    `let first = {${fieldsOf(k, 0)}}`,
    `let second = {${fieldsOf(k, 1)}}`,
    "let state = first",
    rows(k, (i) => `state.f${i} = 2`),
    rows(k, (i) => `if hostFlag { state = ${i % 2 ? "first" : "second"} }`),
    rows(k, (i) => `let shown${i}: integer = state.f${i} / 2`),
    "exit",
  );
const w17 = (k, depth) => {
  const wrap = (i) => (depth === 1 ? `{p${i}: ${i}}` : `{inner: {p${i}: ${i}}}`);
  return L("let x = [" + list(k, (i) => `{child: ${wrap(i)}}`).join(", ") + "]", "x = []", "exit");
};
const w18 = (k, variant) => {
  if (variant === "wrapped" || variant === "quiet") {
    const a = [
      "let original = {" + list(k, (i) => `v${i}: 1`).join(", ") + "}",
      ...list(k, (i) => `let frozen${i} = original`),
    ];
    a.push(
      "let archive = [" +
        list(k, (i) => (variant === "wrapped" ? `{data: frozen${i}}` : `frozen${i}`)).join(", ") +
        "]",
    );
    if (variant === "wrapped") a.push(...list(k, (i) => `original.v${i} = 1.5`));
    const path = variant === "wrapped" ? "archive.first.data" : "archive.first";
    return L(...a, ...list(k, (i) => `let checked${i}: integer = ${path}.v${i}`), "exit");
  }
  const a = [
    "let seed = {" +
      list(k, (i) => (variant === "number" ? `f${i}: ${i}.0` : `f${i}: ${i}`)).join(", ") +
      "}",
    ...list(k, (i) => `let copy${i} = seed`),
  ];
  a.push("let packed = [" + list(k, (i) => `{payload: copy${i}}`).join(", ") + "]");
  if (variant === "valid") a.push(...list(k, (i) => `seed.f${i} = ${i}.5`));
  return L(...a, ...list(k, (i) => `let out${i}: integer = packed.first.payload.f${i}`), "exit");
};
const w19 = (k, variant) => {
  let a;
  if (variant === "sources") {
    a = [
      "let seed = {" + list(k, (i) => `f${i}: ${i}`).join(", ") + "}",
      "if seed != null {",
      ...list(k, (i) => `let snap${i} = seed`),
    ];
    a.push("let packed = [" + list(k, (i) => `{node: snap${i}}`).join(", ") + "]");
    a.push(
      ...list(k, (i) => `seed.f${i} = ${i}.5`),
      ...list(k, (i) => `let need${i}: integer = packed.last.node.f${i}`),
    );
  } else {
    a = [
      "let source = {" + list(k, (i) => `f${i}: 1`).join(", ") + "}",
      "if source.f0 is integer {",
      ...list(k, (i) => `let snapshot${i} = source`),
    ];
    a.push("let archive = [" + list(k, (i) => `{payload: snapshot${i}}`).join(", ") + "]");
    a.push(...list(k, (i) => `let checked${i}: integer = archive.first.payload.f${i}`));
  }
  return L(...a, "}", "exit");
};
const w20 = (k, changed) => {
  const a = [
    "let source = [{" + list(k, (i) => `f${i}: 1`).join(", ") + "}]",
    ...list(k, (i) => `let snapshot${i} = source`),
  ];
  a.push("let archive = [" + list(k, (i) => `snapshot${i}`).join(", ") + "]");
  if (changed) a.push(...list(k, (i) => `source[0].f${i} = 1.5`));
  return L(...a, ...list(k, (i) => `let checked${i}: integer = archive.first.first.f${i}`), "exit");
};
const w21 = (k, variant) => {
  const a =
    variant === "roots"
      ? list(k, (i) => `let value${i} = 1`)
      : ["let box = {" + list(k, (i) => `f${i}: 1`).join(", ") + "}"];
  for (const i of range(k)) {
    const v = variant === "roots" ? `value${i}` : variant === "same" ? "box.f0" : `box.f${i}`;
    a.push(`if ${v} is integer and ${v} > 0 { say "ok" }`);
  }
  return L(...a, "exit");
};
const w22 = (k, chained) => {
  const a = ["let box = {" + list(k, (i) => `f${i}: 1`).join(", ") + "}"];
  if (chained)
    a.push(
      "if " +
        list(k, (i) => `box.f${i} is integer`).join(" and ") +
        ` and box.f${k - 1} > 0 { say "ok" }`,
    );
  else a.push(...list(k, (i) => `if box.f${i} is integer { say "ok" }`));
  return L(...a, "exit");
};
const w23 = (k, variant) => {
  const a = [
    "global seed = {" + list(k, (i) => `f${i}: 1`).join(", ") + "}",
    "function snapshot { return seed }",
  ];
  if (variant === "hoisted")
    a.push("let result = snapshot()", "let archive = [" + list(k, () => "result").join(", ") + "]");
  else a.push("let archive = [" + list(k, () => "snapshot()").join(", ") + "]");
  if (variant === "changed") a.push(...list(k, (i) => `seed.f${i} = 1.5`));
  return L(...a, ...list(k, (i) => `let value${i}: integer = archive.first.f${i}`), "exit");
};
const w24 = (k, variant) => {
  const fields = list(k, (i) => `f${i}: 1`).join(", ");
  const reads = (v) => list(k, (i) => `let n${i}: integer = ${v}.f${i}`);
  let a;
  if (variant === "siblings" || variant === "changed") {
    a = [
      `let seed = {${fields}}`,
      "let picked = seed",
      ...list(k, (i) => `if seed.f${i} is integer { picked = seed }`),
    ];
    if (variant === "changed") a.push(...list(k, (i) => `seed.f${i} = 1.5`));
    a.push(...reads("picked"));
  } else if (variant === "exit") {
    a = [`let seed = {${fields}}`];
    for (const i of range(k)) a.push(`if seed.f${i} is not integer { exit }`, `let s${i} = seed`);
    a.push(
      "let archive = [{layer: [" + list(k, (i) => `s${i}`).join(", ") + "]}]",
      ...reads("archive.first.layer.first"),
    );
  } else if (variant === "result" || variant === "result-object") {
    a = [
      "function chooseValue" + (variant === "result-object" ? ": object" : "") + " {",
      `let row = {${fields}}`,
    ];
    a.push(...list(k, (i) => `if row.f${i} is integer { return row }`), "return row", "}");
    a.push(
      "let archive = [{layer: [chooseValue(), chooseValue()]}]",
      ...reads("archive.first.layer.first"),
    );
  } else if (variant === "same-child") {
    a = [
      `let seed = {${fields}}`,
      "let saved = seed",
      ...list(k, () => "if seed.f0 is integer { saved = seed }"),
    ];
    a.push("let archive = [saved]", ...reads("archive.first"));
  } else if (variant === "varied") {
    a = [`let seed = {${fields}}`];
    for (const i of range(k))
      a.push(`let copy${i} = seed`, `if seed.f${i} is integer { copy${i} = seed }`);
    a.push(
      "let archive = [" + list(k, (i) => `copy${i}`).join(", ") + "]",
      ...reads("archive.first"),
    );
  } else if (variant === "wrapper-varied" || variant === "wrapper-same") {
    a = [`let seed = {${fields}}`, "let picked = {layer: [seed]}"];
    a.push(
      ...list(
        k,
        (i) =>
          `if seed.f${variant === "wrapper-varied" ? i : 0} is integer { picked = {layer: [seed]} }`,
      ),
    );
    a.push(...reads("picked.layer.first"));
  } else if (variant === "outside") {
    a = [
      `let seed = {${fields}}`,
      'if seed.f0 is integer { say "ok" }',
      "let bundle = {wrap: [seed]}",
    ];
    a.push(
      ...list(k, () => "if hostFlag { bundle = {wrap: [seed]} }"),
      ...reads("bundle.wrap.first"),
    );
  } else if (variant === "alias-group") {
    a = ["let seed = {n0: 1, " + list(k, (i) => `f${i}: 1`).join(", ") + "}"];
    for (const i of range(k))
      a.push(`let a${i} = seed`, `let b${i} = a${i}`, `if a${i}.n0 is integer { b${i} = a${i} }`);
    a.push("let bundle = [" + list(k, (i) => `b${i}`).join(", ") + "]", ...reads("bundle.first"));
  } else {
    a = ["let seed = {n0: 1, n1: 1}", "let a0 = seed", "if a0.n0 is not integer { exit }"];
    for (let i = 1; i < k; i++)
      a.push(`let a${i} = a${i - 1}`, `if a${i}.n0 is not integer { exit }`);
    a.push(`let out: integer = a${k - 1}.n1`);
  }
  return L(...a, "exit");
};
const w25 = (k, variant) => {
  const a = [
    "global seed = {" + list(k, (i) => `f${i}: 1`).join(", ") + "}",
    "function snapshot { return seed }",
  ];
  let v;
  if (variant === "stores" || variant === "changed") {
    a.push("let archive = snapshot()", ...list(k, () => "if hostFlag { archive = snapshot() }"));
    if (variant === "changed") a.push(...list(k, (i) => `seed.f${i} = 1.5`));
    v = "archive";
  } else if (variant === "nested") {
    a.push(
      "let archive = {layer: [snapshot()]}",
      ...list(k, () => "if hostFlag { archive = {layer: [snapshot()]} }"),
    );
    v = "archive.layer.first";
  } else {
    a.push("let archive = snapshot()");
    for (const i of range(k)) a.push(`let s${i} = snapshot()`, `if hostFlag { archive = s${i} }`);
    v = "archive";
  }
  return L(...a, ...list(k, (i) => `let n${i}: integer = ${v}.f${i}`), "exit");
};
const w26 = (k, variant) => {
  if (variant === "hoisted") {
    const a = [
      "global seed = {" + list(k, (i) => `f${i}: 1`).join(", ") + "}",
      "function snapshot { return seed }",
      "let saved = snapshot()",
      "let shared = snapshot()",
      ...list(k, () => "if hostFlag { saved = shared }"),
    ];
    return L(...a, ...list(k, (i) => `let n${i}: integer = saved.f${i}`), "exit");
  }
  const a = ["let seed = {a: 1}", "let picked = seed"];
  if (variant === "scope") a.push("if seed.a is integer {", ...list(k, () => "picked = seed"), "}");
  else a.push(...list(k, () => "if hostFlag { picked = seed }"));
  return L(...a, "let n: integer = picked.a", "exit");
};

const named = (prefix, f, ...variants) =>
  Object.fromEntries(variants.map((x) => [`${prefix}-${x}`, (k) => f(k, x)]));
export const shapes = {
  W1: w1,
  "W2-integer": (k) => w2(k, "1"),
  "W2-fractional": (k) => w2(k, "1.5"),
  W3: w3,
  W4: w4,
  W5: w5,
  W6: w6,
  W7: w7,
  W9: w9,
  W10: w10,
  W11: w11,
  ...named("W12", w12, "ladder", "chain", "diamonds"),
  W13: w13,
  W14: (k) => w14(k),
  ...named("W14", w14, "goto", "mixed", "functions"),
  W15: w15,
  W16: w16,
  "W17-one": (k) => w17(k, 1),
  "W17-two": (k) => w17(k, 2),
  ...named("W18", w18, "wrapped", "quiet", "number", "valid"),
  ...named("W19", w19, "sources", "record"),
  "W20-changed": (k) => w20(k, true),
  "W20-quiet": (k) => w20(k, false),
  ...named("W21", w21, "fields", "roots", "same"),
  "W22-and": (k) => w22(k, true),
  "W22-separate": (k) => w22(k, false),
  ...named("W23", w23, "calls", "changed", "hoisted"),
  ...named(
    "W24",
    w24,
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
  ),
  ...named("W25", w25, "stores", "nested", "changed", "aliases"),
  ...named("W26", w26, "repeated", "scope", "hoisted"),
  "W35-registration": (k) => w35(k, true),
  "W35-plain": (k) => w35(k, false),
  ...named("W36", w36, "inside", "varied", "wrapper", "extra-alias"),
  W37: (k) => w37(k, false),
  "W37-hoisted": (k) => w37(k, true),
  W38: w38,
  "W39-registration": (k) => w39(k, true),
  "W39-plain": (k) => w39(k, false),
  "W40-functions": (k) => w40(k, false),
  "W40-files": (k) => w40(k, true),
  ...named("W40", w40l, "logical", "operands"),
  ...named("W41", w41, "return", "exit", "end"),
  W42: w42,
  W43: w43,
  ...named("W27", w27, "tests", "unsuccessful", "writer-suffix", "mixed", "header"),
  "W27-needed": w27n,
  "W27-and": (k) => wstack(k, "and"),
  "W27-isnot": (k) => wstack(k, "isnot"),
  W28: w28,
  ...named("W29", w29, "elements", "same-path", "scalar"),
  ...named("W30", w30, "and", "or", "arm", "else", "operands", "pairs"),
  W31: w31,
  W32: w32,
  ...named("W32", w32c, "own-store", "own-test", "test-read", "literal"),
  ...named("W33", w33, "calls", "header", "operand"),
  ...named("W34", w34, "record", "scalar-chain", "scalar-fan", "dead-fallback"),
  "W34-plain": w34w,
  "W34-tested": (k) => w34t(k, "tested"),
  ...named("W34-tested", w34t, "guarded", "each", "fan", "nested"),
  ...named("W34", w34r, "fan-marks", "fan-and", "chain-and", "stores", "stores-tested"),
  W44: (k) => w44(k, "fields"),
  ...named("W44", w44, "dict", "depth3"),
  ...named("W45", w45, "conditional", "unconditional"),
};

export const sizes = [8, 16, 32, 64, 128, 256, 512, 1024];

// the cell programs and the axes, as the generator wrote them
export const cases = [
  ["cell/F1/0", "let x = 1\nlet y: integer = x"],
  ["cell/F1/1", "global g = 1.5\nlet y: integer = g"],
  ["cell/F1a/0", "global g = 1.5, default: 2\nlet y: integer = g"],
  [
    "cell/F1a/1",
    [
      { path: "main.tease", source: 'global g = 1, default: 2.5\ncall "b.tease"' },
      { path: "b.tease", source: "let y: integer = g" },
    ],
  ],
  ["cell/F2/0", 'let x: integer = 1\nx = "a"'],
  ["cell/F2/1", "let x: number = 1\nlet y: integer = x"],
  ["cell/F3/0", "let s = {a: 1}\ns.a = 1.5\nlet y: integer = s.a"],
  [
    "cell/F4/0",
    "let values = [1]\nfunction replace { values = [2]\n return 1.5 }\nvalues.add(replace())\nlet n: integer = values.first",
  ],
  ["cell/F5/0", "let xs = []\nxs.add(1.5)\nlet n: integer = xs.first"],
  ["cell/F5/1", "let xs = []\nxs.addAll([1.5])\nlet n: integer = xs.first"],
  [
    "cell/F5a/0",
    "let items = [3, 1, 2]\nlet out = []\nfor x in items { out.add(x + 1) }\nlet n: integer = out.first",
  ],
  [
    "cell/F5a/1",
    "let items = [1, 2]\nlet out = []\nfor x in items { if x > 1 { out.add(x) } }\nlet n: integer = out.first",
  ],
  [
    "cell/F5a/2",
    "let items = []\nlet out = []\nfor x in items { out.add(x) }\nlet n: integer = out.first",
  ],
  ["cell/F6/0", "let xs = [1]\nxs.clear()\nlet n: integer = xs.first"],
  [
    "cell/F6/1",
    'let inv = ["a"]\nrepeat 2 { inv.clear()\n inv.add("b") }\nlet s: string = inv.first',
  ],
  ["cell/F7a/0", "let xs = [1, 2]\nxs.removeAt(0)\nlet n: integer = xs.first"],
  ["cell/F7a/1", "let xs = [1.5]\nlet v: integer = xs.removeFirst()"],
  ["cell/F7a/2", "let xs = []\nlet v = xs.removeLast()"],
  ["cell/F7b/0", "let xs = [1]\nlet r = xs.remove(1)\nlet n: integer = r"],
  ["cell/F7c/0", 'let d = dict {"a": 1.5}\nlet v: integer = d.remove("a")'],
  ["cell/F8/0", "let xs = [1, 2]\nxs.sort()\nlet n: integer = xs.first"],
  ["cell/F9/0", "let a = [1]\nlet b = a\na.add(1.5)\nlet n: integer = b.first"],
  ["cell/F9/1", 'let a: number = 1\nlet b = a\nb = "x"'],
  ["cell/F10/0", "let a = []\nlet b = a + [1]\nlet n: integer = b.first"],
  ["cell/F10/1", "let a = [1]\nlet b = a + [1.5]\nlet n: integer = b.last"],
  ["cell/F11/0", 'let room = {count: 1}\nroom = {name: "hall"}\nsay room.count'],
  ["cell/F11/1", 'let room = {count: 1}\nif hostFlag { room = {name: "hall"} }\nsay room.count'],
  ["cell/F11/2", "let o = {length: 2.5}\nlet n: integer = o.length"],
  [
    "cell/F12/0",
    "let party = [{hp: 1}, {hp: 2}]\nparty[0].hp = 1.5\nlet n: integer = party.first.hp",
  ],
  ["cell/F12/1", "let groups = [[1]]\ngroups[0].add(1.5)\nlet n: integer = groups.first.first"],
  ["cell/F13/0", "let xs = [1]\nxs[0] = 1.5\nlet n: integer = xs.first"],
  ["cell/F13/1", 'let d = dict {"a": 1}\nd["a"] = 1.5\nlet n: integer = d["a"]'],
  ["cell/F14/0", 'let s = "ab"\nlet n: integer = s.length'],
  ["cell/F14/1", "let n = 1\nsay n.length"],
  ["cell/F14/2", "let xs = [1]\nlet n: integer = xs.length"],
  ["cell/F15/0", 'let value = load("v", default: null)\nlet count: integer = value.length'],
  ["cell/F16/0", "let d = 2 s\nlet x = d * 2\nlet y: string = x"],
  ["cell/F16/1", 'let a = 1\nlet b = a + "x"'],
  ["cell/F16/2", 'let t = "a" + "b"\nlet n: integer = t'],
  ["cell/F16/3", "let r = 5 % 2\nlet n: integer = r"],
  ["cell/F16/4", "let d = 2 s\nlet q = d / d\nlet n: string = q"],
  ["cell/F16/5", "let a = 3\nlet b = -a\nlet c: integer = b"],
  ["cell/F16/6", 'let x = 1 < "a"'],
  ["cell/F17a/0", "let n = null\nif hostFlag { n = 1 }\nlet m: integer = n otherwise 2"],
  ["cell/F17b/0", "let xs = [null, 1]\nlet n: integer = xs.get(0, default: 2)"],
  ["cell/F17b/1", "let xs = [1]\nlet n: integer = [1].get(5, default: 2)"],
  ["cell/F18/0", 'let n: integer = load("score", default: 0)\nlet m: integer = n'],
  ["cell/F18/1", 'let s = fromJson("[1]", default: [0])\nlet n: integer = s.first'],
  ["cell/F19/0", 'let raw = fromJson("0", default: null)\nlet n: integer = raw'],
  ["cell/F19/1", 'let k = "a" + "b"\nlet v = load(k, default: 1)\nlet n: integer = v'],
  [
    "cell/F19a/0",
    'speaker guide { value: "text" }\nlet other = guide\nlet n: integer = other.value',
  ],
  [
    "cell/F19a/1",
    'let t = timer(duration: 1 s, async: true) { say "x" }\nlet r: integer = t.remaining',
  ],
  ["cell/F20/0", "function f { return 1.5 }\nlet n: integer = f()"],
  ["cell/F20/1", "function f { if hostFlag { return 1 } }\nlet n: integer = f()"],
  ["cell/F21/0", "function f(p) { let q: integer = p }\nf(1.5)"],
  ["cell/F21/1", "function f(p) { let q: integer = p }\nf(1.5)\nf(1)"],
  ["cell/F21/2", "function f(p = 1.5) { let q: integer = p }\nf()"],
  [
    "cell/F21/3",
    'function use(xs, n) { let s: string = xs.first }\nlet entries = []\nuse(entries, entries.add("word"))',
  ],
  ["cell/F22/0", "function f(p: integer) { p = 1.5 }\nf(1)"],
  ["cell/F22/1", "function f(p: integer) { return p }\nf(1.5)"],
  ["cell/F23/0", 'function f { return "a" }\nlet n: integer = f()'],
  ["cell/F24/0", 'let n = 1\nshowPermanentButton "x" { n = 1.5 }\nwait 1 s\nlet m: integer = n'],
  ["cell/F25/0", 'let a = askInteger "How many?"\nlet n: integer = a'],
  ["cell/F25/1", 'let c = askChoice [{ text: "A", value: 1.5 }]\nlet n: integer = c'],
  ["cell/F25/2", 'let t = askText "Name?"\nlet n: integer = t'],
  ["cell/F26a/0", "let o = {a: 1}\nsay o"],
  ["cell/F26b/0", 'let o = {a: 1}\nsay "${o}"'],
  ["cell/F26b/1", 'let xs = []\nsay "${xs}"'],
  ["cell/F26b/2", 'let xs = [1, 2]\nsay "${xs}"'],
  ["cell/F27a/0", 'for n in [1.5] { repeat n { say "x" } }'],
  ["cell/F27a/1", "let xs = [1]\nfor x in xs { xs.add(1.5) }\nfor x in xs { let y: integer = x }"],
  [
    "cell/F27b/0",
    'let d = dict {"a": 1}\nfor k, v in d { let s: string = k\n let i: integer = v }',
  ],
  ["cell/F27b/1", 'let d = dict {"a": 1.5}\nfor k in d { let i: integer = k }'],
  ["cell/F27c/0", "for i in 1..3 { let n: integer = i }"],
  ["cell/F28/0", "let x = 1\nif hostFlag { x = 1.5 }\nlet y: integer = x"],
  ["cell/C1/0", "let x: integer = 1.5"],
  ["cell/C1/1", "let x = 1\nif hostFlag { x = 1.5 }\nlet y: integer = x"],
  ["cell/C2/0", 'let n = null\nrepeat n { say "x" }'],
  ["cell/C2/1", 'let n = 1.5\nrepeat n { say "x" }'],
  ["cell/C2/2", "let xs = [1]\nlet i = 0.5\nsay xs[i]"],
  ["cell/C2/3", "let xs = [1]\nxs.removeAt(1.5)"],
  ["cell/C2/4", "let xs = [1]\nlet t = xs.take(1.5)"],
  ["cell/C3/0", 'let n = 1\nif n { say "x" }'],
  ["cell/C3/1", "let b = not 1"],
  ["cell/C4/0", 'let a = "x" - 1'],
  ["cell/C4/1", "let a = null\nif hostFlag { a = 1 }\nlet b = a + 1"],
  ["cell/C5a/0", "let o = null\nsay o.a"],
  ["cell/C5a/1", "let o = null\nif hostFlag { o = {a: 1} }\nsay o.a"],
  ["cell/C5b/0", "let n = 1\nsay n.length"],
  ["cell/C5b/1", 'let n = 1\nif hostFlag { n = "ab" }\nsay n.length'],
  ["cell/C5c/0", 'let room = {count: 1}\nroom = {name: "hall"}\nsay room.count'],
  ["cell/C5c/1", "let r = hostValue\nsay r.count"],
  ["cell/C6/0", "let xs = []\nsay xs.first"],
  ["cell/C6/1", "let xs = [1]\nsay xs.first"],
  ["cell/C6/2", "let xs = []\nxs.removeFirst()"],
  ["cell/C7/0", "function f(p: integer) { }\nf(1.5)"],
  ["cell/C7/1", "function f(x: integer): integer { return 1.5 }\nf(1)"],
  ["cell/C8/0", 'let n: integer = load("score", default: 0)\nsave "text" as "score"'],
  ["cell/C9/0", "let raw = hostValue\nlet n: integer = raw"],
  ["cell/C9/1", "let raw = hostValue\nlet n = raw / 4"],
  ["cell/C10/0", 'let n = 1\nsay n otherwise "x"'],
  ["cell/C10/1", 'let xs = [1]\nlet v = xs.get(0, default: "x")'],
  ["cell/C10/2", "let n = 1\nlet m = n otherwise null"],
  ["cell/C10/3", 'let v = toInteger("5", default: "x")'],
  ["cell/C11/0", 'let o = {a: 1}\nsay "${o}"'],
  ["cell/C11/1", 'let d = 2 s\nsay "${d}"'],
  ["cell/C12/0", 'let d = dict {"a": 1}\nsay d[1]'],
  ["cell/C12/1", 'let d = dict {"a": 1}\nsay d.get(1, default: 0)'],
  ["cell/C13/0", "for x in 1 { say x }"],
  ["cell/C13/1", "for k, v in [1] { say k }"],
  ["cell/A1/0", "let x: integer = 1\nx = 1.5"],
  ["cell/A2/0", 'let x = null\nx = 1\nx = "a"'],
  ["cell/A3/0", "let s = {a: 1}\nlet t = s\nt.a = 2\nlet n: integer = t.a"],
  ["cell/A4/0", "let a: number = 1\nlet b = a\nlet n: integer = b"],
  ["cell/A5/0", 'let state = {f: 0}\nlet preset = {f: "x"}\nif hostFlag { state = preset }'],
  ["cell/A6/0", 'let a = 1\nlet b = a\na = "x"\nb = 1.5'],
  ["cell/A7/0", 'let x = hostValue / 2\nx = "text"'],
  ["cell/A8/0", 'let xs = [1]\nxs.add("a")'],
  ["cell/A9/0", "function f(p: integer) { p = 1.5 }\nf(1)"],
  ["cell/A9/1", 'function f(x: integer): integer { return "a" }\nf(1)'],
  ["cell/X1/control", "let x = 1.5\nlet y: integer = x"],
  ["cell/X1/case", "exit\nlet x = 1.5\nlet y: integer = x"],
  ["cell/X2/control", "let x = 1.5\nlet y: integer = x"],
  ["cell/X2/case", "global x = 1.5\nfunction f { let y: integer = x }\nf()"],
  ["cell/X3/control", "let s = {a: 1}\ns.a = 1.5\nlet y: integer = s.a"],
  ["cell/X3/case", "let s = [{a: 1}]\ns[0].a = 1.5\nlet y: integer = s.first.a"],
  ["cell/X4/control", "let x = 1.5\nlabel a\nlet y: integer = x"],
  ["cell/X4/case", "let x = 1.5\nlabel a\nlet y: integer = x\nx = 1\nif hostFlag { goto a }"],
  ["cell/X5/control", "let x = 1.5\nrepeat 2 { x = 1.5\n let y: integer = x }"],
  ["cell/X5/case", "let x = 1.5\nrepeat 2 { let y: integer = x\n x = 1 }"],
  ["cell/X6/control", "let x = 1.5\nfunction f { x = 1 }\nlet y: integer = x\nf()"],
  ["cell/X6/case", "let x = 1.5\nfunction f { x = 1 }\nf()\nlet y: integer = x"],
  ["cell/X7/control", 'let n = 1.5\nlet m: integer = n\nshowPermanentButton "x" { n = 1 }'],
  ["cell/X7/case", 'let n = 1.5\nshowPermanentButton "x" { n = 1 }\nlet m: integer = n'],
  ["cell/O1/0", "let x = 1.5\nx = 1\nlet y: integer = x"],
  ["cell/O1a/0", "let s = {a: 1.5}\nlet t = s\ns.a = 1\nlet n: integer = s.a"],
  ["cell/O2/0", "let x = 1\nif hostFlag { x = 1.5 }\nlet y: integer = x"],
  ["cell/O3/0", "let x = 1\nrepeat 2 { let y: integer = x\n x = 1.5 }"],
  ["cell/O4/0", "let x = 1\nrepeat 2 { x = 1.5\n let y: integer = x }"],
  ["cell/O5/0", "let x = 1\nfunction reset { x = 1.5 }\nreset()\nlet y: integer = x"],
  ["cell/O6/0", "let x = 1.5\nfunction reset { x = 1 }\nlet y: integer = x\nreset()"],
  ["cell/O7/0", "let x = 1\nfunction a { x = 1.5 }\nfunction b { a() }\nb()\nlet y: integer = x"],
  ["cell/O8/0", 'let x = 1\nshowPermanentButton "b" { x = 1.5 }\nwait 1 s\nlet y: integer = x'],
  [
    "cell/O9/0",
    [
      { path: "main.tease", source: 'global x = 1\ncall "b.tease"\nlet y: integer = x' },
      { path: "b.tease", source: "x = 1.5" },
    ],
  ],
  [
    "cell/O10/0",
    [
      { path: "main.tease", source: 'global x = 1.5\ncall "b.tease"' },
      { path: "b.tease", source: "let y: integer = x" },
    ],
  ],
  ["cell/O11/0", "let xs = [1]\nxs[0] = 1.5\nlet n: integer = xs.first"],
  ["cell/O12/0", "global x = 1\nfunction f { x = 1.5\n let y: integer = x }\nf()"],
  ["cell/O13/0", "global x = 1.5\nfunction f { let y: integer = x }\nf()"],
  ["cell/O14/0", "function f { let local = 1\n local = 1.5\n let y: integer = local }\nf()"],
  ["cell/O15/0", 'showPermanentButton "b" { let local = 1\n let y: integer = local }\nwait 1 s'],
  ["cell/O16/0", "for x in [1.5] { let y: integer = x }"],
  ["cell/O17/0", "let party = [{hp: 1}]\nlet n: integer = party.first.hp"],
  ["cell/O18/0", 'let d = dict {"a": 1.5}\nlet n: integer = d["a"]'],
  [
    "cell/O19/0",
    'speaker guide { value: "text" }\nlet other = guide\nlet n: integer = other.value',
  ],
  ["cell/S1/0", "let x = 1\nx = 2\nlet y: integer = x"],
  ["cell/S2/0", "let x = 1.5\nx = 2.5\nlet y: integer = x"],
  ["cell/S3/0", 'let x = 1\nif hostFlag { x = 1.5 }\nrepeat x { say "a" }'],
  ["cell/S4/0", "let x = null\nif hostFlag { x = 1 }\nlet y: integer = x"],
  ["cell/S5/0", 'let x = 1\nif hostFlag { x = "a" }\nlet y: integer = x'],
  ["cell/S6/0", "let x = 1\nif hostFlag { x = hostValue }\nlet y: integer = x"],
  ["cell/S7/0", 'let xs = ["a"]\nlet s: string = xs.first'],
  ["cell/S8/0", "let xs = [1]\nxs.clear()\nsay xs.first"],
  ["cell/S9/0", "let xs = [1, 1.5]\nlet n: integer = xs.first"],
  ["cell/L1/0", "let x = 1.5\nlet y: integer = x"],
  ["cell/L2/0", "let x = 1\nlabel a\nx = 1.5\nlet y: integer = x\nif hostFlag { goto a }"],
  ["cell/L3/0", "let x = 1.5\nlabel a\nlet y: integer = x\nx = 1\nif hostFlag { goto a }"],
  ["cell/L4/0", "let x = 1.5\nlabel a\nlabel b\nlet y: integer = x\nx = 1\nif hostFlag { goto a }"],
  ["cell/L5/0", "let x = 1.5\nlabel a\nlet y: integer = x"],
  ["cell/L6/0", "let x = 1.5\nlet y: integer = x\nlabel a\nfunction f { goto a }"],
  ["cell/L7/0", "let x = 1.5\nlabel a\nlet y: integer = x\nfunction f { goto a }\nf()"],
  [
    "cell/L8/0",
    [
      { path: "main.tease", source: 'global x = 1\ngoto "b.tease"' },
      { path: "b.tease", source: "let y: integer = x" },
    ],
  ],
  [
    "cell/L9/0",
    [
      { path: "main.tease", source: 'global x = 1\ncall "b.tease"\nlet y: integer = x' },
      { path: "b.tease", source: "x = 1.5" },
    ],
  ],
  [
    "cell/L10/0",
    [
      { path: "main.tease", source: 'global x = 1\ncall "b.tease"\nlet y: integer = x' },
      { path: "b.tease", source: "exit" },
    ],
  ],
  [
    "cell/L11/0",
    [
      { path: "main.tease", source: 'global x = 1\ncall script("b.tease")\nlet y: integer = x' },
      { path: "b.tease", source: "x = 1.5" },
    ],
  ],
  [
    "cell/L12/0",
    [
      { path: "main.tease", source: "global x = 1\nlet y: integer = x" },
      { path: "b.tease", source: "end" },
    ],
  ],
  [
    "cell/L13/0",
    [
      { path: "main.tease", source: 'global x = 1\ncall "b.tease"\nlet y: integer = x' },
      { path: "b.tease", source: 'goto "c.tease"' },
      { path: "c.tease", source: "x = 1.5\nend" },
    ],
  ],
  ["cell/H1/0", 'let n = 1\nlet m: integer = n\nshowPermanentButton "x" { n = 1.5 }'],
  ["cell/H2/0", 'let n = 1\nshowPermanentButton "x" { n = 1.5 }\nwait 1 s\nlet m: integer = n'],
  [
    "cell/H3/0",
    'let n = 1\nfunction change { n = 1.5 }\nshowPermanentButton "x" { change() }\nchange()\nlet m: integer = n',
  ],
  ["cell/H4/0", 'showPermanentButton "x" { let n = 1\n n = 1.5\n let m: integer = n }\nwait 1 s'],
  [
    "cell/H5/0",
    'let n = 1\nfunction read { let m: integer = n }\nshowPermanentButton "x" { n = 1.5 }\nread()',
  ],
  [
    "cell/H6/0",
    [
      {
        path: "main.tease",
        source: 'global n = 1\nshowPermanentButton "x" { n = 1.5 }\ngoto "b.tease"',
      },
      { path: "b.tease", source: "n = 1\nlet m: integer = n" },
    ],
  ],
  [
    "cell/H7/0",
    "let n = 1\nlet t = timer(duration: 1 s, async: true) { n = 1.5 }\nwait 2 s\nlet m: integer = n",
  ],
  [
    "cell/H8/0",
    'let rugzak = []\nshowPermanentButton "x" { rugzak.add("sleutel") }\nwait 5 s\nlet kopie = rugzak\nkopie.add(3)',
  ],
  [
    "cell/H9/0",
    'let n = 1\nfunction setup { showPermanentButton "x" { n = 1.5 } }\nsetup()\nlet m: integer = n',
  ],
  ["cell/P1/0", 'let x: integer = 1\nx = "a"'],
  ["cell/P2/0", 'let a = "x" * 2'],
  ["cell/P3/0", "let x = 1.5\nif hostFlag { x = 2.5 }\nfunction f { let y: integer = x }\nf()"],
  ["cell/P4/0", "let x = 1\nif hostFlag { x = 2 }\nlet y: integer = x"],
  ["cell/P5/0", "let items = [1, 2]\nlet i = 0\nsay items[i]\ni = i / 2"],
  ["cell/P6/0", "function f { return 1.5 }\nlet n: integer = f()"],
  ["cell/P7/0", "if false { let x: integer = 1.5 }"],
  ["axes/binding/main/none/stable/none", "let v = 1\nlet r: integer = v"],
  [
    "axes/binding/main/none/stable/entered",
    "let v = 1\nlabel top\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  ["axes/binding/main/none/stable/skipped", "let v = 1\nlabel quiet\nlet r: integer = v"],
  ["axes/binding/main/none/fractional/none", "let v = 1\nlet r: integer = v"],
  [
    "axes/binding/main/none/fractional/entered",
    "let v = 1\nlabel top\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  ["axes/binding/main/none/fractional/skipped", "let v = 1\nlabel quiet\nlet r: integer = v"],
  ["axes/binding/main/none/text/none", "let v = 1\nlet r: integer = v"],
  [
    "axes/binding/main/none/text/entered",
    "let v = 1\nlabel top\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  ["axes/binding/main/none/text/skipped", "let v = 1\nlabel quiet\nlet r: integer = v"],
  ["axes/binding/main/none/null/none", "let v = 1\nlet r: integer = v"],
  [
    "axes/binding/main/none/null/entered",
    "let v = 1\nlabel top\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  ["axes/binding/main/none/null/skipped", "let v = 1\nlabel quiet\nlet r: integer = v"],
  ["axes/binding/main/straight/stable/none", "let v = 1\nv = 2\nlet r: integer = v"],
  [
    "axes/binding/main/straight/stable/entered",
    "let v = 1\nlabel top\nv = 2\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  [
    "axes/binding/main/straight/stable/skipped",
    "let v = 1\nlabel quiet\nv = 2\nlet r: integer = v",
  ],
  ["axes/binding/main/straight/fractional/none", "let v = 1\nv = 1.5\nlet r: integer = v"],
  [
    "axes/binding/main/straight/fractional/entered",
    "let v = 1\nlabel top\nv = 1.5\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  [
    "axes/binding/main/straight/fractional/skipped",
    "let v = 1\nlabel quiet\nv = 1.5\nlet r: integer = v",
  ],
  ["axes/binding/main/straight/text/none", 'let v = 1\nv = "a"\nlet r: integer = v'],
  ["axes/binding/main/straight/null/none", "let v = 1\nv = null\nlet r: integer = v"],
  ["axes/binding/main/branch/stable/none", "let v = 1\nif hostFlag { v = 2 }\nlet r: integer = v"],
  [
    "axes/binding/main/branch/stable/entered",
    "let v = 1\nlabel top\nif hostFlag { v = 2 }\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  [
    "axes/binding/main/branch/stable/skipped",
    "let v = 1\nlabel quiet\nif hostFlag { v = 2 }\nlet r: integer = v",
  ],
  [
    "axes/binding/main/branch/fractional/none",
    "let v = 1\nif hostFlag { v = 1.5 }\nlet r: integer = v",
  ],
  [
    "axes/binding/main/branch/fractional/entered",
    "let v = 1\nlabel top\nif hostFlag { v = 1.5 }\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  [
    "axes/binding/main/branch/fractional/skipped",
    "let v = 1\nlabel quiet\nif hostFlag { v = 1.5 }\nlet r: integer = v",
  ],
  ["axes/binding/main/branch/text/none", 'let v = 1\nif hostFlag { v = "a" }\nlet r: integer = v'],
  ["axes/binding/main/branch/null/none", "let v = 1\nif hostFlag { v = null }\nlet r: integer = v"],
  [
    "axes/binding/main/loop-after/stable/none",
    "let v = 1\nrepeat 2 { let r: integer = v\n v = 2 }",
  ],
  [
    "axes/binding/main/loop-after/stable/entered",
    "let v = 1\nlabel top\nrepeat 2 { let r: integer = v\n v = 2 }\nif hostFlag { goto top }",
  ],
  [
    "axes/binding/main/loop-after/stable/skipped",
    "let v = 1\nlabel quiet\nrepeat 2 { let r: integer = v\n v = 2 }",
  ],
  [
    "axes/binding/main/loop-after/fractional/none",
    "let v = 1\nrepeat 2 { let r: integer = v\n v = 1.5 }",
  ],
  [
    "axes/binding/main/loop-after/fractional/entered",
    "let v = 1\nlabel top\nrepeat 2 { let r: integer = v\n v = 1.5 }\nif hostFlag { goto top }",
  ],
  [
    "axes/binding/main/loop-after/fractional/skipped",
    "let v = 1\nlabel quiet\nrepeat 2 { let r: integer = v\n v = 1.5 }",
  ],
  [
    "axes/binding/main/loop-after/text/none",
    'let v = 1\nrepeat 2 { let r: integer = v\n v = "a" }',
  ],
  [
    "axes/binding/main/loop-after/null/none",
    "let v = 1\nrepeat 2 { let r: integer = v\n v = null }",
  ],
  [
    "axes/binding/main/call/stable/none",
    "let v = 1\nfunction change { v = 2 }\nchange()\nlet r: integer = v",
  ],
  [
    "axes/binding/main/call/stable/entered",
    "let v = 1\nfunction change { v = 2 }\nlabel top\nchange()\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  [
    "axes/binding/main/call/stable/skipped",
    "let v = 1\nfunction change { v = 2 }\nlabel quiet\nchange()\nlet r: integer = v",
  ],
  [
    "axes/binding/main/call/fractional/none",
    "let v = 1\nfunction change { v = 1.5 }\nchange()\nlet r: integer = v",
  ],
  [
    "axes/binding/main/call/fractional/entered",
    "let v = 1\nfunction change { v = 1.5 }\nlabel top\nchange()\nlet r: integer = v\nif hostFlag { goto top }",
  ],
  [
    "axes/binding/main/call/fractional/skipped",
    "let v = 1\nfunction change { v = 1.5 }\nlabel quiet\nchange()\nlet r: integer = v",
  ],
  [
    "axes/binding/main/call/text/none",
    'let v = 1\nfunction change { v = "a" }\nchange()\nlet r: integer = v',
  ],
  [
    "axes/binding/main/call/null/none",
    "let v = 1\nfunction change { v = null }\nchange()\nlet r: integer = v",
  ],
  [
    "axes/binding/main/handler/stable/none",
    'let v = 1\nshowPermanentButton "h" { v = 2 }\nlet r: integer = v',
  ],
  [
    "axes/binding/main/handler/stable/entered",
    'let v = 1\nlabel top\nshowPermanentButton "h" { v = 2 }\nlet r: integer = v\nif hostFlag { goto top }',
  ],
  [
    "axes/binding/main/handler/stable/skipped",
    'let v = 1\nlabel quiet\nshowPermanentButton "h" { v = 2 }\nlet r: integer = v',
  ],
  [
    "axes/binding/main/handler/fractional/none",
    'let v = 1\nshowPermanentButton "h" { v = 1.5 }\nlet r: integer = v',
  ],
  [
    "axes/binding/main/handler/fractional/entered",
    'let v = 1\nlabel top\nshowPermanentButton "h" { v = 1.5 }\nlet r: integer = v\nif hostFlag { goto top }',
  ],
  [
    "axes/binding/main/handler/fractional/skipped",
    'let v = 1\nlabel quiet\nshowPermanentButton "h" { v = 1.5 }\nlet r: integer = v',
  ],
  [
    "axes/binding/main/handler/text/none",
    'let v = 1\nshowPermanentButton "h" { v = "a" }\nlet r: integer = v',
  ],
  [
    "axes/binding/main/handler/null/none",
    'let v = 1\nshowPermanentButton "h" { v = null }\nlet r: integer = v',
  ],
  [
    "axes/binding/function/none/stable/none",
    "let v = 1\nfunction run {\nlet r: integer = v\n}\nrun()",
  ],
  [
    "axes/binding/function/none/fractional/none",
    "let v = 1\nfunction run {\nlet r: integer = v\n}\nrun()",
  ],
  [
    "axes/binding/function/none/text/none",
    "let v = 1\nfunction run {\nlet r: integer = v\n}\nrun()",
  ],
  [
    "axes/binding/function/none/null/none",
    "let v = 1\nfunction run {\nlet r: integer = v\n}\nrun()",
  ],
  [
    "axes/binding/function/straight/stable/none",
    "let v = 1\nfunction run {\nv = 2\nlet r: integer = v\n}\nrun()",
  ],
  [
    "axes/binding/function/branch/stable/none",
    "let v = 1\nfunction run {\nif hostFlag { v = 2 }\nlet r: integer = v\n}\nrun()",
  ],
  [
    "axes/binding/function/loop-after/stable/none",
    "let v = 1\nfunction run {\nrepeat 2 { let r: integer = v\n v = 2 }\n}\nrun()",
  ],
  [
    "axes/binding/function/call/stable/none",
    "let v = 1\nfunction change { v = 2 }\nfunction run {\nchange()\nlet r: integer = v\n}\nrun()",
  ],
  [
    "axes/binding/function/handler/stable/none",
    'let v = 1\nfunction run {\nshowPermanentButton "h" { v = 2 }\nlet r: integer = v\n}\nrun()',
  ],
  [
    "axes/binding/block/none/stable/none",
    'let v = 1\nshowPermanentButton "go" {\nlet r: integer = v\n}\nwait 1 s',
  ],
  [
    "axes/binding/block/none/fractional/none",
    'let v = 1\nshowPermanentButton "go" {\nlet r: integer = v\n}\nwait 1 s',
  ],
  [
    "axes/binding/block/none/text/none",
    'let v = 1\nshowPermanentButton "go" {\nlet r: integer = v\n}\nwait 1 s',
  ],
  [
    "axes/binding/block/none/null/none",
    'let v = 1\nshowPermanentButton "go" {\nlet r: integer = v\n}\nwait 1 s',
  ],
  [
    "axes/binding/block/straight/stable/none",
    'let v = 1\nshowPermanentButton "go" {\nv = 2\nlet r: integer = v\n}\nwait 1 s',
  ],
  [
    "axes/binding/block/branch/stable/none",
    'let v = 1\nshowPermanentButton "go" {\nif hostFlag { v = 2 }\nlet r: integer = v\n}\nwait 1 s',
  ],
  [
    "axes/binding/block/loop-after/stable/none",
    'let v = 1\nshowPermanentButton "go" {\nrepeat 2 { let r: integer = v\n v = 2 }\n}\nwait 1 s',
  ],
  [
    "axes/binding/block/call/stable/none",
    'let v = 1\nfunction change { v = 2 }\nshowPermanentButton "go" {\nchange()\nlet r: integer = v\n}\nwait 1 s',
  ],
  [
    "axes/binding/block/handler/stable/none",
    'let v = 1\nshowPermanentButton "go" {\nshowPermanentButton "h" { v = 2 }\nlet r: integer = v\n}\nwait 1 s',
  ],
  ["axes/field/main/none/stable/none", "let v = {f: 1}\nlet r: integer = v.f"],
  [
    "axes/field/main/none/stable/entered",
    "let v = {f: 1}\nlabel top\nlet r: integer = v.f\nif hostFlag { goto top }",
  ],
  ["axes/field/main/none/stable/skipped", "let v = {f: 1}\nlabel quiet\nlet r: integer = v.f"],
  ["axes/field/main/none/fractional/none", "let v = {f: 1}\nlet r: integer = v.f"],
  ["axes/field/main/none/text/none", "let v = {f: 1}\nlet r: integer = v.f"],
  ["axes/field/main/none/null/none", "let v = {f: 1}\nlet r: integer = v.f"],
  ["axes/field/main/straight/stable/none", "let v = {f: 1}\nv.f = 2\nlet r: integer = v.f"],
  [
    "axes/field/main/branch/stable/none",
    "let v = {f: 1}\nif hostFlag { v.f = 2 }\nlet r: integer = v.f",
  ],
  [
    "axes/field/main/loop-after/stable/none",
    "let v = {f: 1}\nrepeat 2 { let r: integer = v.f\n v.f = 2 }",
  ],
  [
    "axes/field/main/call/stable/none",
    "let v = {f: 1}\nfunction change { v.f = 2 }\nchange()\nlet r: integer = v.f",
  ],
  [
    "axes/field/main/handler/stable/none",
    'let v = {f: 1}\nshowPermanentButton "h" { v.f = 2 }\nlet r: integer = v.f',
  ],
  [
    "axes/field/function/none/stable/none",
    "let v = {f: 1}\nfunction run {\nlet r: integer = v.f\n}\nrun()",
  ],
  [
    "axes/field/block/none/stable/none",
    'let v = {f: 1}\nshowPermanentButton "go" {\nlet r: integer = v.f\n}\nwait 1 s',
  ],
  ["axes/element/main/none/stable/none", "let v = [1]\nlet r: integer = v.first"],
  [
    "axes/element/main/none/stable/entered",
    "let v = [1]\nlabel top\nlet r: integer = v.first\nif hostFlag { goto top }",
  ],
  ["axes/element/main/none/stable/skipped", "let v = [1]\nlabel quiet\nlet r: integer = v.first"],
  ["axes/element/main/none/fractional/none", "let v = [1]\nlet r: integer = v.first"],
  ["axes/element/main/none/text/none", "let v = [1]\nlet r: integer = v.first"],
  ["axes/element/main/none/null/none", "let v = [1]\nlet r: integer = v.first"],
  ["axes/element/main/straight/stable/none", "let v = [1]\nv[0] = 2\nlet r: integer = v.first"],
  [
    "axes/element/main/branch/stable/none",
    "let v = [1]\nif hostFlag { v[0] = 2 }\nlet r: integer = v.first",
  ],
  [
    "axes/element/main/loop-after/stable/none",
    "let v = [1]\nrepeat 2 { let r: integer = v.first\n v[0] = 2 }",
  ],
  [
    "axes/element/main/call/stable/none",
    "let v = [1]\nfunction change { v[0] = 2 }\nchange()\nlet r: integer = v.first",
  ],
  [
    "axes/element/main/handler/stable/none",
    'let v = [1]\nshowPermanentButton "h" { v[0] = 2 }\nlet r: integer = v.first',
  ],
  [
    "axes/element/function/none/stable/none",
    "let v = [1]\nfunction run {\nlet r: integer = v.first\n}\nrun()",
  ],
  [
    "axes/element/block/none/stable/none",
    'let v = [1]\nshowPermanentButton "go" {\nlet r: integer = v.first\n}\nwait 1 s',
  ],
  ["axes/reference/main/none/stable/none", "speaker v { f: 1 }\nlet r: integer = v.f"],
  [
    "axes/reference/main/none/stable/entered",
    "speaker v { f: 1 }\nlabel top\nlet r: integer = v.f\nif hostFlag { goto top }",
  ],
  [
    "axes/reference/main/none/stable/skipped",
    "speaker v { f: 1 }\nlabel quiet\nlet r: integer = v.f",
  ],
  ["axes/reference/main/none/fractional/none", "speaker v { f: 1 }\nlet r: integer = v.f"],
  ["axes/reference/main/none/text/none", "speaker v { f: 1 }\nlet r: integer = v.f"],
  ["axes/reference/main/none/null/none", "speaker v { f: 1 }\nlet r: integer = v.f"],
  ["axes/reference/main/straight/stable/none", "speaker v { f: 1 }\nv.f = 2\nlet r: integer = v.f"],
  [
    "axes/reference/main/branch/stable/none",
    "speaker v { f: 1 }\nif hostFlag { v.f = 2 }\nlet r: integer = v.f",
  ],
  [
    "axes/reference/main/loop-after/stable/none",
    "speaker v { f: 1 }\nrepeat 2 { let r: integer = v.f\n v.f = 2 }",
  ],
  [
    "axes/reference/main/call/stable/none",
    "speaker v { f: 1 }\nfunction change { v.f = 2 }\nchange()\nlet r: integer = v.f",
  ],
  [
    "axes/reference/main/handler/stable/none",
    'speaker v { f: 1 }\nshowPermanentButton "h" { v.f = 2 }\nlet r: integer = v.f',
  ],
  [
    "targeted/receiver-replaced-by-argument",
    "let values = [1]\nfunction replace { values = [2]\n return 1.5 }\nvalues.add(replace())\nlet n: integer = values.first",
  ],
  [
    "targeted/registration-during-argument",
    'let n = 1\nfunction reg { showPermanentButton "x" { n = 1.5 }\n return 1 }\nlet k = reg() + 1\nlet m: integer = n',
  ],
  [
    "targeted/mutation-below-one-element",
    "let g = [[1]]\ng[0].add(1.5)\nlet n: integer = g.first.first",
  ],
  [
    "targeted/mutation-below-two-elements",
    "let g = [[[1]]]\ng[0][0].add(1.5)\nlet n: integer = g.first.first.first",
  ],
  ["targeted/absent-after-replacement", "let r = {a: 1}\nr = {b: 2}\nsay r.a"],
  ["targeted/absent-in-heterogeneous-list", "let xs = [{a: 1}, {b: 2}]\nsay xs.last.a"],
  [
    "targeted/nullable-element-through-get",
    "let xs = [null]\nlet n: integer = xs.get(0, default: 1)",
  ],
  ["targeted/dict-key-against-value", 'let d = dict {"a": 1}\nlet n: integer = d["a"]\nsay d[1]'],
  ["targeted/non-empty-missing-position", "let xs = [1]\nsay xs[3]"],
  [
    "targeted/global-default-phases",
    "global g = 1.5, default: 2\nfunction f { let n: integer = g }\nf()",
  ],
  ["targeted/parameter-supplied", "function f(p = 1) { let q: integer = p }\nf(1.5)"],
  ["targeted/parameter-omitted", "function f(p = 1.5) { let q: integer = p }\nf()"],
  ["targeted/parameter-written", "function f(p: integer = 1) { }\nf(1.5)"],
  [
    "targeted/later-argument-side-effect",
    'function use(a, b) { let s: string = a.first }\nlet e = []\nuse(e, e.add("w"))',
  ],
  ["targeted/for-list", "for x in [1.5] { let y: integer = x }"],
  ["targeted/for-dict-key", 'for k in dict {"a": 1} { let n: integer = k }'],
  ["targeted/for-range", "for i in 1..3 { let s: string = i }"],
  [
    "targeted/loop-entry-snapshot",
    'let xs = [1]\nfor x in xs { xs.add("a")\n let n: integer = x }',
  ],
  [
    "targeted/call-goto-end",
    [
      { path: "main.tease", source: 'global x = 1\ncall "b.tease"\nlet y: integer = x' },
      { path: "b.tease", source: 'goto "c.tease"' },
      { path: "c.tease", source: "x = 1.5\nend" },
    ],
  ],
  [
    "targeted/helper-registers-before-return",
    'let n = 1\nfunction setup { showPermanentButton "x" { n = 1.5 } }\nsetup()\nlet m: integer = n',
  ],
  [
    "targeted/registration-over-transfer",
    [
      {
        path: "main.tease",
        source: 'global n = 1\nshowPermanentButton "x" { n = 1.5 }\ngoto "b.tease"',
      },
      { path: "b.tease", source: "n = 1\nwait 1 s\nlet m: integer = n" },
    ],
  ],
  [
    "targeted/function-local-under-registration",
    'showPermanentButton "x" { say "b" }\nfunction f { let local = 1\n local = 1.5\n let m: integer = local }\nf()',
  ],
  [
    "targeted/admission-empty-snapshot",
    'let live = {entries: []}\nlet saved = live\nlive.entries.add("key")\nsaved.entries.add(2)',
  ],
  [
    "targeted/admission-populated-snapshot",
    'let live = {entries: ["a"]}\nlet saved = live\nsaved.entries.add(2)',
  ],
  [
    "targeted/admission-later-source-mutation",
    'let src = [1]\nlet copy = src\nsrc.add("x")\ncopy.add(2)',
  ],
  [
    "targeted/admission-several-destinations",
    'let src = [1]\nlet a = src\nlet b: number[] = src\na.add("x")',
  ],
  ["targeted/admission-rejected-destination", "let src = [1]\nlet a: string[] = src\nsrc.add(2)"],
  [
    "targeted/two-external-ingresses-and-opaque",
    'speaker g { v: "t" }\nlet x = hostValue\nif hostFlag { x = hostList }\nif hostFlag { x = g.v }\nlet n: integer = x',
  ],
];

// spike 14's harness globals (points14.mjs `GLOBALS`)
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "python3 -I spike14/gates14/make-gates14.py",
      "R/3a-newcore/checkpoint-9/spike14/README.md:1538",
    ],
    [
      "count spike14/gates14/{work,cells,axes}.jsonl counts (spike14/points14.mjs, both orders)",
      "R/3a-newcore/checkpoint-9/spike14/vps/run-all14.sh:125",
    ],
  ],
  sources: 1280,
  sha256: "22bf2032cb4f3116e5da2a9b8e9706695cae137e04d9df721387dd521b4cd1d9",
};
