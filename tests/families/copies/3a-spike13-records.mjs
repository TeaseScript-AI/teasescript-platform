// random programs over one record and its presets (spike 13's differential of whole replacements and own stores): a
// seed record, presets copied from it or each other and changed in one field, a state replaced by a preset under
// branches, chapters, resets and buttons, stores to its own fields and typed reads; 300 from seed 1; 3a checkpoint 9
// (R/3a-newcore/checkpoint-9/spike13/tools/gen-records.py, byte-identical in spikes 11 to 13), each analysed by the
// spike's harness. Python's random.Random is reproduced draw for draw.
// Python's random.Random(seed) for a seed below 2**32 (MT19937, seeded by init_by_array) and the draws the generator
// uses: random(), randrange, randint and choice
function pythonRandom(seed) {
  const mt = new Uint32Array(624);
  mt[0] = 19650218;
  for (let i = 1; i < 624; i++)
    mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
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

const VALS = ["0", "1", "2", "1.5", "0.5", "null", '"a"'];
function program(R) {
  const F = R.randint(2, 4);
  const P = R.randint(2, 5);
  const range = (n) => Array.from({ length: n }, (_, j) => j);
  const fields = range(F).map((j) => `f${j}`);
  const kw = R.random() < 0.25 ? "global" : "let";
  const seedv = () => R.choice(["0", "1", "2", "1.5", "null"]);
  const L = [`${kw} seed = {${fields.map((f) => `${f}: ${seedv()}`).join(", ")}}`];
  for (const p of range(P)) {
    const src = p === 0 || R.random() < 0.7 ? "seed" : `preset${R.randrange(p)}`;
    L.push(`${kw} preset${p} = ${src}`);
    if (R.random() < 0.8) L.push(`preset${p}.${R.choice(fields)} = ${R.choice(VALS)}`);
  }
  L.push(`${kw} state = preset0`);
  const fns = [];
  const body = [];
  const rep = (p) =>
    R.choice([
      `state = preset${p}`,
      `if hostFlag { state = preset${p} }`,
      `if hostFlag { state = preset${p} } else { state = seed }`,
    ]);
  const own = () => `state.${R.choice(fields)} = ${R.choice(VALS)}`;
  const read = () => {
    const f = R.choice(fields);
    const r = R.random();
    if (r < 0.3) return `let r${R.randrange(10 ** 6)}: integer = state.${f}`;
    if (r < 0.45) return `let r${R.randrange(10 ** 6)}: number = state.${f}`;
    if (r < 0.55) return `let r${R.randrange(10 ** 6)}: string = state.${f}`;
    if (r < 0.75) return `repeat state.${f} { say "tick" }`;
    if (r < 0.85) return `let x${R.randrange(10 ** 6)} = [1, 2, 3][state.${f}]`;
    return `let r${R.randrange(10 ** 6)} = state.${f}`;
  };
  const nch = R.randint(1, 4);
  for (const c of range(nch)) {
    const cb = range(R.randint(1, 2)).map(() => rep(R.randrange(P)));
    if (R.random() < 0.3) cb.push(own());
    if (R.random() < 0.3) cb.push(read());
    fns.push(`function chapter${c} {`, ...cb, "}");
  }
  if (R.random() < 0.5) {
    fns.push("function resetAll {");
    for (const f of fields)
      if (R.random() < 0.8) fns.push(`state.${f} = ${R.choice(["0", "1", "null"])}`);
    fns.push("}");
  }
  const hasReset = fns.includes("function resetAll {");
  if (R.random() < 0.4)
    fns.push("function playAll {", ...range(nch).map((c) => `chapter${c}()`), "}");
  const hasPlay = fns.includes("function playAll {");
  for (let n = R.randint(4, 10); n > 0; n--) {
    const r = R.random();
    if (r < 0.2) body.push(rep(R.randrange(P)));
    else if (r < 0.35) body.push(own());
    else if (r < 0.5) body.push(`chapter${R.randrange(nch)}()`);
    else if (r < 0.55 && hasReset) body.push("resetAll()");
    else if (r < 0.6 && hasPlay) body.push("playAll()");
    else if (r < 0.67)
      body.push(
        "repeat 2 {",
        R.choice([rep(R.randrange(P)), own(), `chapter${R.randrange(nch)}()`]),
        "}",
      );
    else if (r < 0.72) body.push("if hostFlag {", own(), "}");
    else if (r < 0.76)
      body.push(
        `showPermanentButton "b${R.randrange(10 ** 6)}" {`,
        R.choice([rep(R.randrange(P)), own(), `chapter${R.randrange(nch)}()`, read()]),
        "}",
        "wait 1 s",
      );
    else body.push(read());
  }
  body.push(...range(R.randint(1, 4)).map(() => read()));
  return [L[0], ...fns, ...L.slice(1), ...body, "exit"].join("\n");
}

export const cases = (() => {
  const R = pythonRandom(1);
  return Array.from({ length: 300 }, (_, i) => [`rec/1/${i}`, program(R)]);
})();

// the spikes' harness globals
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "python3 -I tools/gen-records.py diff/rec-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike11/tools/checks.sh:21",
    ],
    [
      "python3 -I tools/gen-records.py diff/rec-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike12/tools/checks.sh:21",
    ],
    [
      "python3 -I tools/gen-records.py diff/rec-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike13/tools/checks.sh:30",
    ],
  ],
  sources: 300,
  sha256: "9064c435eabfbcd22a92bfd569ce111e81c6f56689ac86d47826fda968ef7dde",
};
