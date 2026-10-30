// random programs over collections and records (spike 10's differential of class transfers on elements and on whole
// replaced records): lists with adds, clears, removals and replacements, records with field updates, presets and
// whole replacements, in helpers, main, buttons, branches and loops, read into typed and inferred places; 300 from seed
// 1; 3a checkpoint 9 (R/3a-newcore/checkpoint-9/spike10/tools/gen-aggregate.py, byte-identical in spikes 10 to 13), each
// analysed by the spike's harness. Python's random.Random is reproduced draw for draw.
// Python's random.Random(seed) for a seed below 2**32 (MT19937, seeded by init_by_array) and the draws the generator
// uses: random(), randrange, randint and choice
function pythonRandom(seed) {
  const mt = new Uint32Array(624);
  mt[0] = 19650218;
  for (let i = 1; i < 624; i++) mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
  let i = 1;
  for (let k = 624; k > 0; k--) {
    mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + seed) >>> 0;
    i += 1;
    if (i >= 624) {
      mt[0] = mt[623];
      i = 1;
    }
  }
  for (let k = 623; k > 0; k--) {
    mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
    i += 1;
    if (i >= 624) {
      mt[0] = mt[623];
      i = 1;
    }
  }
  mt[0] = 0x80000000;
  let next = 624;
  const word = () => {
    if (next >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      next = 0;
    }
    let y = mt[next++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  };
  const below = (n) => {
    const k = 32 - Math.clz32(n);
    let r = word() >>> (32 - k);
    while (r >= n) r = word() >>> (32 - k);
    return r;
  };
  return {
    random: () => ((word() >>> 5) * 67108864 + (word() >>> 6)) / 9007199254740992,
    randrange: (a, b) => (b === undefined ? below(a) : a + below(b - a)),
    randint: (a, b) => a + below(b - a + 1),
    choice: (seq) => seq[below(seq.length)],
  };
}

function program(R, seed, i) {
  const L = R.randint(1, 3);
  const F = R.randint(1, 5);
  const NF = R.randint(1, 3);
  const NP = R.randint(0, 3);
  const range = (n) => Array.from({ length: n }, (_, j) => j);
  const lists = range(L).map((j) => `l${j}`);
  const fields = range(NF).map((j) => `f${j}`);
  const presets = range(NP).map((j) => `p${j}`);
  const fns = range(F).map((j) => `h${j}`);
  let reads = 0;
  const scal = () => R.choice(["0", "1", "2", "1.5", "0.5", "null", '"a"']);
  const num = () => {
    const r = R.random();
    if (r < 0.4) return R.choice(["0", "1", "2", "0.5", "1.5"]);
    if (r < 0.5) return "null";
    if (r < 0.7) return `rec.${R.choice(fields)}`;
    if (r < 0.8) return `${R.choice(lists)}.first`;
    if (r < 0.9) return `rec.${R.choice(fields)} + ${R.choice(["1", "0.5"])}`;
    return `${R.choice(lists)}.length`;
  };
  const lit = () => "{" + fields.map((f) => `${f}: ${R.choice(["0", "1", "1.5", "null"])}`).join(", ") + "}";
  const read = () => {
    reads += 1;
    const n = reads;
    const t = R.random();
    const l = R.choice(lists);
    const f = R.choice(fields);
    if (t < 0.15) return [`let r${n}: integer = ${l}.first`];
    if (t < 0.25) return [`let r${n}: number = ${l}.last`];
    if (t < 0.32) return [`let r${n}: integer = ${l}[0]`];
    if (t < 0.45) return [`let r${n}: integer = rec.${f}`];
    if (t < 0.55) return [`let r${n}: number = rec.${f}`];
    if (t < 0.62) return [`let r${n} = rec.${f}`];
    if (t < 0.7) return [`repeat rec.${f} {`, 'say "tick"', "}"];
    if (t < 0.76) return [`let c${n} = rec.${f}`, `repeat c${n} {`, 'say "tick"', "}"];
    if (t < 0.82) return [`repeat ${l}.length {`, 'say "tick"', "}"];
    if (t < 0.88) return [`let r${n}: string = ${l}.first`];
    if (t < 0.94) return [`let r${n} = ${l}`];
    return [`say "{${l}.length}"`];
  };
  const stmt = (owner, depth) => {
    const r = R.random();
    const l = R.choice(lists);
    const f = R.choice(fields);
    if (r < 0.14) return [`${l}.add(${R.random() < 0.7 ? num() : scal()})`];
    if (r < 0.18) return [`${l}.clear()`];
    if (r < 0.21) return [`${l}.removeAt(0)`];
    if (r < 0.25) return [`${l} = [${range(R.randint(0, 2)).map(() => scal()).join(", ")}]`];
    if (r < 0.38) return [`rec.${f} ${R.choice(["=", "+=", "+=", "-="])} ${num()}`];
    if (r < 0.44 && presets.length > 0) return [`rec = ${R.choice(presets)}`];
    if (r < 0.47) return [`rec = ${lit()}`];
    if (r < 0.5 && presets.length > 0) return [`${R.choice(presets)}.${f} = ${num()}`];
    if (r < 0.68) {
      const others = fns.filter((h) => h !== owner);
      return [`${R.choice(others.length > 0 ? others : fns)}()`];
    }
    if (r < 0.78 && depth < 2) {
      const body = stmt(owner, depth + 1);
      if (R.random() < 0.4) return ["if hostFlag {", ...body, "} else {", ...stmt(owner, depth + 1), "}"];
      return ["if hostFlag {", ...body, "}"];
    }
    if (r < 0.83 && depth < 2) return [`repeat ${R.choice(["1", "2", "3"])} {`, ...stmt(owner, depth + 1), "}"];
    if (r < 0.95) return read();
    return ['say "line"'];
  };
  const decl = R.choice(["global", "let"]);
  const lines = [`${decl} rec = ${lit()}`];
  for (const l of lists)
    lines.push(`${decl} ${l} = [${range(R.randint(0, 2)).map(() => R.choice(["0", "1", "1.5", "null"])).join(", ")}]`);
  for (const p of presets) {
    lines.push(`${decl} ${p} = rec`);
    if (R.random() < 0.7) lines.push(`${p}.${R.choice(fields)} = ${R.choice(["1", "2", "0.5", "null"])}`);
  }
  for (const h of fns) {
    lines.push(`function ${h} {`);
    for (let n = R.randint(1, 4); n > 0; n--) lines.push(...stmt(h, 0));
    lines.push("}");
  }
  const body = [];
  for (let n = R.randint(3, 10); n > 0; n--) {
    const r = R.random();
    if (r < 0.4) body.push(`${R.choice(fns)}()`);
    else if (r < 0.52) body.push("if hostFlag {", `${R.choice(fns)}()`, "}");
    else if (r < 0.6) body.push(`showPermanentButton "b${body.length}" {`, `${R.choice(fns)}()`, "}", "wait 1 s");
    else if (r < 0.66) body.push("repeat 2 {", `${R.choice(fns)}()`, "}");
    else if (r < 0.78) body.push(...stmt("main", 1)); // a store, a reset or a call in main
    else body.push(...read());
  }
  body.push(...read(), ...read());
  return [`agg/${seed}/${i}`, [...lines, ...body, "exit"].join("\n")];
}

export const cases = (() => {
  const R = pythonRandom(1);
  return Array.from({ length: 300 }, (_, i) => program(R, 1, i));
})();

// the spikes' harness globals
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "python3 -I tools/gen-aggregate.py diff/agg-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike10/tools/checks.sh:21"
    ],
    [
      "python3 -I tools/gen-aggregate.py diff/agg-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike11/tools/checks.sh:21"
    ],
    [
      "python3 -I tools/gen-aggregate.py diff/agg-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike12/tools/checks.sh:21"
    ],
    [
      "python3 -I tools/gen-aggregate.py diff/agg-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike13/tools/checks.sh:30"
    ]
  ],
  "sources": 300,
  "sha256": "d4841f44ff68deedd0deae1d7b81e0811f286883e91b4dee7379f4b7c8bc432f"
};
