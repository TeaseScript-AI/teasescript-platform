// random dispatcher programs (spike 10's differential of class transfers through a hub): k stats with setters, one or
// two hubs choosing among them by name, an optional bonus, scenes calling hubs and setters, reset blocks and reads, the
// stats as globals, top-level lets or properties of one record; 300 from seed 1; 3a checkpoint 9
// (R/3a-newcore/checkpoint-9/spike10/tools/gen-dispatch.py, byte-identical in spikes 9 to 13), each analysed by the
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

function program(R, seed, i) {
  const k = R.randint(2, 6);
  const S = R.randint(2, 8);
  const two = R.random() < 0.3;
  const range = (n) => Array.from({ length: n }, (_, j) => j);
  const start = () => R.choice(["0", "0", "1", "null", "1.5"]);
  // class-pure keys: globals, top-level lets of main, properties of a record
  const decl = R.choice(["global", "let", "record"]);
  let L;
  if (decl === "record")
    L = [
      `${R.choice(["global", "let"])} st = {` +
        range(k)
          .map((j) => `v${j}: ${start()}`)
          .join(", ") +
        "}",
    ];
  else L = range(k).map((j) => `${decl} s${j} = ${start()}`);
  for (const j of range(k)) {
    const body = R.choice([
      `s${j} += amount`,
      `s${j} += amount`,
      `s${j} = (s${j} otherwise 0) + amount`,
      `s${j} = amount`,
      `s${j} += 1`,
    ]);
    L.push(`function set${j}(amount: ${R.choice(["integer", "number"])}) {`, body);
    if (R.random() < 0.2) L.push(`let inner${j}: integer = s${R.randrange(k)}`);
    L.push("}");
  }
  const hubs = ["addStat", ...(two ? ["addOther"] : [])];
  for (const h of hubs) {
    L.push(`function ${h}(name: string, amount: number) {`);
    for (const j of range(k)) {
      if (h === "addOther" && R.random() < 0.5) continue;
      L.push(`if name == "s${j}" {`, `set${j}(amount)`, "}");
    }
    L.push("}");
  }
  if (R.random() < 0.4)
    L.push("function bonus {", `set${R.randrange(k)}(${R.choice(["1", "2.5"])})`, "}");
  const hasBonus = L.includes("function bonus {");
  let reads = 0;
  const read = () => {
    reads += 1;
    const n = reads;
    const j = R.randrange(k);
    const t = R.random();
    if (t < 0.4) return [`let r${n}: integer = s${j}`];
    if (t < 0.6) return [`let r${n}: number = s${j}`];
    if (t < 0.8) return [`let r${n} = s${j}`];
    return [`repeat s${j} {`, 'say "tick"', "}"];
  };
  for (const sc of range(S)) {
    L.push(`function scene${sc} {`, `say "scene ${sc}"`);
    for (let n = R.randint(1, 4); n > 0; n--) {
      const r = R.random();
      if (r < 0.45)
        L.push(`${R.choice(hubs)}("s${R.randrange(k)}", ${R.choice(["1", "2", "0.5"])})`);
      else if (r < 0.6) L.push(`set${R.randrange(k)}(${R.choice(["1", "2", "0.5"])})`);
      else if (r < 0.7)
        L.push("if hostFlag {", `set${R.randrange(k)}(${R.choice(["1", "0.5"])})`, "}");
      else if (r < 0.78 && hasBonus) L.push("bonus()");
      else if (r < 0.86) L.push("if hostFlag {", `${R.choice(hubs)}("s${R.randrange(k)}", 1)`, "}");
      else L.push(...read());
    }
    L.push("}");
  }
  const body = [];
  if (R.random() < 0.35) {
    // a block that stores stats directly (a reset button, a timer)
    body.push(R.choice(['showPermanentButton "Reset" {', 'showPermanentButton "Bonus" {']));
    for (const j of range(k))
      if (R.random() < 0.6) body.push(`s${j} = ${R.choice(["0", "1", "2.5", "null"])}`);
    body.push("}");
    if (R.random() < 0.5) body.push("wait 1 s");
  }
  for (const sc of range(S)) {
    body.push(`scene${sc}()`);
    if (R.random() < 0.2) body.push(...read());
    if (R.random() < 0.1) body.push("if hostFlag {", `scene${R.randrange(S)}()`, "}");
    if (R.random() < 0.12)
      for (const j of range(k))
        if (R.random() < 0.7) body.push(`s${j} = ${R.choice(["0", "1", "2.5", "null"])}`); // a reset in main
  }
  for (let n = R.randint(1, k); n > 0; n--) body.push(...read());
  let source = [...L, ...body, "exit"].join("\n");
  if (decl === "record") {
    // every stat sJ becomes the property st.vJ (the declaration excepted)
    const cut = source.indexOf("\n");
    source = source.slice(0, cut) + "\n" + source.slice(cut + 1).replace(/\bs(\d+)\b/g, "st.v$1");
  }
  return [`disp/${seed}/${i}`, source];
}

export const cases = (() => {
  const R = pythonRandom(1);
  return Array.from({ length: 300 }, (_, i) => program(R, 1, i));
})();

// the spikes' harness globals
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "python3 -I tools/gen-dispatch.py diff/disp-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike9/tools/checks.sh:16",
    ],
    [
      "python3 -I tools/gen-dispatch.py diff/disp-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike10/tools/checks.sh:21",
    ],
    [
      "python3 -I tools/gen-dispatch.py diff/disp-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike11/tools/checks.sh:21",
    ],
    [
      "python3 -I tools/gen-dispatch.py diff/disp-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike12/tools/checks.sh:21",
    ],
    [
      "python3 -I tools/gen-dispatch.py diff/disp-1.jsonl 300 1",
      "R/3a-newcore/checkpoint-9/spike13/tools/checks.sh:30",
    ],
  ],
  sources: 300,
  sha256: "4455c5e04a329a5e2f7baaec0a577ef4adbfc3cffc4cf227f9bd19a514054918",
};
