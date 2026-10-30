// random programs over scalar globals and helpers (spike 9's differential of class-level transfers against per-key
// history), 400 from seed 1; 3a checkpoint 9 (R/3a-newcore/checkpoint-9/spike10/tools/gen-random.py, byte-identical in
// spikes 9 to 13), each analysed by the spike's harness. Python's random.Random is reproduced draw for draw. The 79
// programs that call the dispatcher without its arguments or call a helper of main from a second file are not here:
// generator mistakes that do not resolve on `main` (TSV020, TSV018), not what the differential compared.
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
  const G = R.randint(1, 4);
  const F = R.randint(1, 6);
  const gl = Array.from({ length: G }, (_, j) => `g${j}`);
  const fns = Array.from({ length: F }, (_, j) => `f${j}`);
  let reads = 0;
  const expr = () => {
    const r = R.random();
    if (r < 0.25) return R.choice(["0", "1", "2", "3"]);
    if (r < 0.35) return R.choice(["1.5", "2.5"]);
    if (r < 0.4) return "null";
    if (r < 0.6) return R.choice(gl);
    if (r < 0.75) return `${R.choice(gl)} + ${R.choice(["1", "2", R.choice(gl)])}`;
    if (r < 0.82) return `${R.choice(gl)} * 2`;
    if (r < 0.87) return `${R.choice(gl)} / 2`;
    if (r < 0.94) return `${R.choice(gl)} otherwise 0`;
    return R.choice(["1", "2"]);
  };
  const read = () => {
    reads += 1;
    const n = reads;
    const g = R.choice(gl);
    const t = R.random();
    if (t < 0.35) return [`let r${n}: integer = ${g}`];
    if (t < 0.55) return [`let r${n}: number = ${g}`];
    if (t < 0.75) return [`let r${n} = ${g}`];
    if (t < 0.85) return [`let r${n} = ${g} + 1`];
    if (t < 0.92) return [`repeat ${g} {`, 'say "tick"', "}"];
    return [`say "{${g}}"`];
  };
  const stmt = (owner, depth) => {
    const r = R.random();
    if (r < 0.3) {
      const g = R.choice(gl);
      return [`${g} ${R.choice(["=", "+=", "+=", "-="])} ${expr()}`];
    }
    if (r < 0.55) {
      const others = fns.filter((f) => f !== owner);
      return [`${R.choice(others.length > 0 ? others : fns)}()`];
    }
    if (r < 0.7 && depth < 2) {
      const body = stmt(owner, depth + 1);
      if (R.random() < 0.4)
        return ["if hostFlag {", ...body, "} else {", ...stmt(owner, depth + 1), "}"];
      return ["if hostFlag {", ...body, "}"];
    }
    if (r < 0.78 && depth < 2)
      return [`repeat ${R.choice(["1", "2", "3"])} {`, ...stmt(owner, depth + 1), "}"];
    if (r < 0.93) return read();
    return ['say "line"'];
  };
  const lines = [];
  const second = R.random() < 0.2;
  const decl = second || R.random() < 0.5 ? "global" : "let"; // a let of main is not visible in another file
  for (const g of gl) lines.push(`${decl} ${g} = ${R.choice(["0", "0", "1", "1.5", "null"])}`);
  // a dispatcher sometimes: one helper choosing among setters by name
  let dispatch = false;
  if (F >= 3 && R.random() < 0.35) {
    const setters = fns.slice(1);
    lines.push(`function ${fns[0]}(name: string, amount: ${R.choice(["integer", "number"])}) {`);
    for (const s of setters) lines.push(`if name == "${s}" {`, `${s}()`, "}");
    lines.push("}");
    for (const s of setters) {
      lines.push(
        `function ${s} {`,
        `${R.choice(gl)} += ${R.choice(["1", "1", "2", "0.5", "null"])}`,
      );
      if (R.random() < 0.3) lines.push(...stmt(s, 1));
      lines.push("}");
    }
    dispatch = true;
  } else
    for (const f of fns) {
      lines.push(`function ${f} {`);
      for (let n = R.randint(1, 4); n > 0; n--) lines.push(...stmt(f, 0));
      lines.push("}");
    }
  const body = [];
  for (let n = R.randint(3, 10); n > 0; n--) {
    const r = R.random();
    if (dispatch && r < 0.4)
      body.push(`${fns[0]}("${R.choice(fns.slice(1))}", ${R.choice(["1", "2"])})`);
    else if (r < 0.55) body.push(`${R.choice(fns)}()`);
    else if (r < 0.65) body.push("if hostFlag {", `${R.choice(fns)}()`, "}");
    else if (r < 0.72)
      body.push(`showPermanentButton "b${body.length}" {`, `${R.choice(fns)}()`, "}", "wait 1 s");
    else if (r < 0.78) body.push("repeat 2 {", `${R.choice(fns)}()`, "}");
    else if (r < 0.84)
      body.push(`${R.choice(gl)} = ${R.choice(["0", "1", "1.5", "null"])}`); // a store in main
    else body.push(...read());
  }
  body.push(...read(), ...read());
  let files = null;
  if (second) {
    // a second file: a call, a jump with its return, an end
    let part = [`${R.choice(fns)}()`];
    if (R.random() < 0.5) part = ['goto "tail.tease"'];
    files = [
      { path: "part.tease", source: part.join("\n") },
      { path: "tail.tease", source: [`${R.choice(gl)} = ${expr()}`, "end"].join("\n") },
    ];
    body.splice(R.randint(0, body.length), 0, 'call "part.tease"');
  }
  let source = [...lines, ...body, "exit"].join("\n");
  if (!second && R.random() < 0.3) {
    // the scalars as properties of one record
    const decls = lines.filter(
      (l) =>
        (l.startsWith("global ") || l.startsWith("let ")) &&
        l.includes(" = ") &&
        gl.includes(l.split(/\s+/)[1]),
    );
    const fields = decls
      .map(
        (l) => l.slice(0, l.indexOf(" = ")).split(/\s+/)[1] + ": " + l.slice(l.indexOf(" = ") + 3),
      )
      .join(", ");
    const rest = [...lines.filter((l) => !decls.includes(l)), ...body, "exit"].join("\n");
    source =
      `${R.choice(["global", "let"])} rec = {${fields}}\n` + rest.replace(/\b(g\d+)\b/g, "rec.$1");
  }
  return [
    `rand/${seed}/${i}`,
    files === null ? source : [{ path: "main.tease", source }, ...files],
    dispatch,
  ];
}

// the generator's mistakes: the dispatcher `f0` called without its arguments, a second file calling a helper of main
const unresolved = (source, dispatch) =>
  typeof source === "string"
    ? dispatch && /(^|[^\w])f0\(\)/m.test(source)
    : (dispatch && /(^|[^\w])f0\(\)/m.test(source.map((file) => file.source).join("\n"))) ||
      /^f\d+\(\)$/.test(source[1].source);

export const cases = (() => {
  const R = pythonRandom(1);
  const out = [];
  for (let i = 0; i < 400; i++) {
    const [name, source, dispatch] = program(R, 1, i);
    if (!unresolved(source, dispatch)) out.push([name, source]);
  }
  return out;
})();

// the spikes' harness globals
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "python3 -I tools/gen-random.py diff/rand-1.jsonl 400 1",
      "R/3a-newcore/checkpoint-9/spike9/tools/checks.sh:16",
    ],
    [
      "python3 -I tools/gen-random.py diff/rand-1.jsonl 400 1",
      "R/3a-newcore/checkpoint-9/spike10/tools/checks.sh:21",
    ],
    [
      "python3 -I tools/gen-random.py diff/rand-1.jsonl 400 1",
      "R/3a-newcore/checkpoint-9/spike11/tools/checks.sh:21",
    ],
    [
      "python3 -I tools/gen-random.py diff/rand-1.jsonl 400 1",
      "R/3a-newcore/checkpoint-9/spike12/tools/checks.sh:21",
    ],
    [
      "python3 -I tools/gen-random.py diff/rand-1.jsonl 400 1",
      "R/3a-newcore/checkpoint-9/spike13/tools/checks.sh:30",
    ],
  ],
  sources: 400,
  sha256: "7574cf3afeefac385e8d3e2435e48af40c300fb63114b14805b93c11d8d229c0",
  dropped: [
    [
      "2c5487fca5cca6cb153e19697125939ef656f34d478877858ffd747fb4a2a402",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "52e91c79d620c019b028054c542dba402f462b99fa1de544fdcf6d2b3e99181d",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "604fb1db93bb2cc23b849e943a46ed69120679643ff4427311cf112882a893e1",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "79428eb68cc813b6376dcf6afc1246122694d71feabe50200bfa0b1c90565bf5",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "b9e17341da106cbace9c70f46ea4be0bd7931f2dd878c29446cd806f96336598",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "21a88e7522a45a6edc4b45d38dc1f77e7603ebe43ec62b7a0770f841485176ab",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "1d516964090f7130e5b406994377754ca9ab1e3294ee262bdac6f83cd1248d5e",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "6aaea13499c23e82afc1f470a1d5029390d4bc3e7bce5a5c708d697e1d29fa77",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "781a3fd25630b241849bcc074c648d2091487e66761480945b775200f0a050c3",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "fc34576408087b7b43304373ff29178ec4036863b57aed87ea85698be63a492e",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "33a35ad2cc01c773a308355499b14598e21b93cdc9a7e5c164aec0523db1a500",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "f6d7449e21b46c39c86fb7be2724077bb622c0688eb35bfe562552d42a5bd537",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "085648d46da48e633e1bc43fdd142462965ffba9cc9386c29770fbced6f144f4",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "df0f02b5a160df06fc88b34463a9de01c9485527139354af27601546369278e0",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "ccf2c7551a46e36eb37537f43167625b89d3a6cd4170fd073373dcc6c507855e",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "cb726b832dcfb01048380441db0b731d19bb0512a1647ac985f50a15c9bce802",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "e72f6c3a2b2cbb9fe388bfba0762c5fc7b60389222785ef03ee4c332643f5277",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "3972c39a4dacc4f624e1d96ec890d3f3c7fba6930717d84aba12e7d369d429ad",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "a2af62d4cd88d54f1b19c3856435ee4369d08ddb5e71c6ac48c43132229bc4d1",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "195f0561fe48437daa767071b13dd84be5ff76cebf972c378b8ca576988b943c",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "72de4bc9c76601c6320cd4d71255a923b72cf2b762c7f2783a4fb11e91e98314",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "1a18f6fc25ce139115ac5becb923c68272972eb8bdedd1f7c98bcdff3bdf6d4a",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "2702f4841f53445ea2465328db48741fb30220dd6c5dadaf9476ba3e53712218",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "f3611546644fe4ddf7883c4dc95119b60afb0cf65e2e39618f6282e9bdf955e3",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "e95b383e10926a304bc84867806acd775d255ef20a9375d7d7fe5e2fb3660e01",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "702f0c750f06b80fcda4fb13cfe3c2de5f75958122c1f75a9486d2d7f360f732",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "79108fee6458b959c15b2dc13580f45dc3129a4ea8c749028ef0358928859fec",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "bad3d32d423ce69a2be121b162cca8355006ac58b09f077f67bb7b686931bb87",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "0c351c5f665a6b12d286603db5ec1dcdbd039680db098eb02ff18dba710b0fa8",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "9fc765f415e1bdf2550f2bd7dbb7e5cfa10c74bd06c9fca59991ee87d900878f",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "ffce06b132c3fdf5553d5bb5ff151b7ee34bca855a66cfc63fb818fe06f389f7",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "75ac02c79e47a39b6283a2ee3d9456c11bb72d1603e79ec7dcc082b6e30071fc",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "a3988a899b1a3723e1dd09b3552c281c2d553fee828e7bdc5c493e7787e9ff5f",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "fa8f61ced2a3ccb86c019aca7a4a99029beeebf0f9e64d3df8f39c5241b11ed8",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "93b75af0dade970a13ca631a36fcd832e8141b553fe8f578ec529a9b95bc1f54",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "245e63c6f5c8b3a0a87afc422f6adee15edb25f311c644028584c19ca5a8a71d",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "84088d9593ffdae211b40fa770d7d62e32cfb46727436f20a175019f66ba407a",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "95c99a543a3a44918b94be073f38627e62feafd9161dfd1d055f79acb4f7976d",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "39185310299073f993628f7590634c43b7138e9203dd0045e20280f5c4e84f4b",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "fc862887f42bb1cde61f1f432edded2df1a76bc9e2490973815909cadbaa54ea",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "17701713d2b707c341381401663aa4ccd9740b252b4b23cf3d2b5d4f5f8cb82f",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "63c99e2d9fd9bdd90d7c77c3ae7c7f5d1d13b619074e910d5b163e943f60145c",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "977d2c68f7a6b3528d1f6b9954cfb1b3f1669698f48c66d474d061fb811bd3ed",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "aa107ca72b661879e93b32f6a73f94d12b48829350830ed8f17edfbcc83cf688",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "b02120e25ef618fc5f1852a4b87551ef1f20e5b54a3d795c8303d8620b1de133",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "d539ae8f1cfa9aef6230e894b217ebec1e20ae8a66c3dd0bcdaa2b3cfca1ebec",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "da03921e2f829caa39fe53e6f1e1f03b4c23bbac2364017429445dc5f70088a7",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "c338838b1f3d42489fe118d01bf7c7654896eb0229882311093d994fb5e338a3",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "f321c6288f536187a2c83709e94627250713afbcba48579dd17d2db3a7877f1a",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "cd6aeb03851b868e243b03cb09693e06c98f67ecb0182415a51b5eb43bd64d68",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "6535fc5bfb1b042cabb7b4e77596b459432dbb592e96164e0fa0eacc08dbd2fb",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "32dd880f11374d58fd382763e22b831378d4e84ba99d8e1ac7e246fad4b27109",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "71bb0f0fcd3dcdacecd9bbfad5fa21248671ef0656b652a51a1fe3966cf45f2e",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "14d0bb9c099ab19b0c7bf9dffd6337f40be79bf2c022969b87abff6e544374c7",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "9e014efb24af2a4cab2579a81694add840beb6f94177074f680e8e8c3284020b",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "fc184cfb385793fd4d0819a43a8c02329b0478aa75295df82d9ee249a973abd6",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "9ecf152bd30f4e76366a6d1805e020a7e485401cc4bbcf2994ce68b28d6ee1c4",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "41f44e6424f3ba788f2d534453b6e998bf89cc13be8528cf85e3e0d445be3517",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "93bf2d6b78bd715024bb701ee14e9d66d5c329ed1252cab99c8c7a032ee48c1b",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "59edc9b72271f81bbb31fae924b316841bf231dc3677cbd1dcb526aa2cac14a0",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "a11df1353417f24ce05ee6572bf8df4178b9f2d70c799a679582d7a78574b656",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "a50fecc34d5cc516cb27b0c12771524679a5c3929671f057f574102f497172aa",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "35dc19e086796acf270a4973eff4057535e2318976113102f2f778d1ee1832fa",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "c01874225f330995e17b483c9cbe37e38b960e533a75b67479897d1b144cdb7c",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "9a56af8b50a35bf5a783558d897e1e849b95a05ea88acb396dd4b4180d2bde84",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "833399c6330f9f23d654e52ceceb3e8c5012a42ba97252eb8c6494aaa2180402",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "c08563b880e58d6dfc4986c87b36ddccf8f1a8aca880ea96c048d8d2af6b9f47",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "5fdd26d848223056ea4fa4e9a1ded078f7cd62b0bf66f42501a117b3e03a7c2a",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "171e8876d750dbb7573923ff4906fccc70042748d8df83528eb22ae3a3c4c067",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "79e76549c0bee603d4cee2180d891b6051083b0431c07d63792eb4a54c042141",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "dcc889a8b32167fa6ba5d026d2500026e92d73843a6dbdfb06f341720688e870",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "2eced9b477109f84e5f5395940f936d4e13f488b798a34cbe3a975f416684ff6",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "9ea7d752b1f013ff3f66347e86f63d21d0f6f1e5b2cbd90e15cd4b33a725a8cd",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "f5ab355437a2e90f5e3568dd50df25cc799c35baba277b55599564d8748d6edc",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "c43f07c8dc507d51061a304f4ea5ea473aed527f27de10edcc7d305e7f35c427",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "bb21251de2d5f93614f3807b5c4f40d1e92e7eaa9c01265432a3ddad11866d98",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "b9e6b08c1d7ba4d1e3a02bcae58b731b398b9a395ccde2a46e5d7fbe7dbc6b06",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "f14be6b4fd912479d6250a4c03db08c39b81b847e42be5a9863a369d6762957f",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
    [
      "cedf01436295628c33fa76c24563998bb42f6f27e5a1c144591b775fe8743c18",
      "the dispatcher called without its arguments (TSV020) or a helper of main called from a second file (TSV018): mistakes of the generator, not what its differential compared",
    ],
  ],
};
