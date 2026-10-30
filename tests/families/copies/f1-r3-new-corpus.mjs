// F1 review r3's independent corpus: 10 written types × 4 carriers × 6 copy topologies × 7 operations, then 1,200 graphs
// drawn by a seeded generator (four actions and a terminal over three copies); and the 32 graphs that declared a name
// twice, a mistake of the generator, as its repair run renamed them (`repair-corpus.mjs`), in place of the originals
// (/tmp/agent-work/o4-m4-f1/review/r3/new-corpus.mjs and review-lib.mjs; copies kept in
// desktop:~/work/evidence/1463/retained/).
export const cases = (() => {
  const lines = (...xs) => xs.flat().join("\n") + "\nexit\n";
  const cases = new Map();
  const add = (name, source) => {
    if (!cases.has(source)) cases.set(source, { name, source });
  };
  const types = [
    ["integer", "1"],
    ["number", "1.5"],
    ["integer?", "null"],
    ["null", "null"],
    ["integer | string", "1"],
    ["integer[]", "[1]"],
    ["integer?[]", "[null]"],
    ["(integer | string)[]", '[1,"x"]'],
    ["list", "[1]"],
    ["object", "{x:1}"],
  ];
  const carriers = [
    ["direct", (x) => x, "f"],
    ["object", (x) => `{p:${x}}`, "p.f"],
    ["list", (x) => `[${x}]`, "[0].f"],
    ["projection", (x) => `{p:[${x}]}.p[0]`, "f"],
  ];
  for (const [type, value] of types)
    for (const [carrier, wrap, path] of carriers)
      for (const shape of ["self", "ring", "path-cycle", "literal-cycle", "projected", "diamond"])
        for (const op of ["host", "text", "null", "guard", "add", "default", "rejection"]) {
          const def = [
            `let typed:${type}=${value}`,
            `let root=${wrap("{f:typed,g:typed}")}`,
            `let foreign=${wrap("{f:hostValue,g:typed}")}`,
          ];
          const middle = {
            self: ["let a=foreign", "a=a", "let mid=a"],
            ring: ["let a=foreign", "let b=a", "let mid=b", "a=mid"],
            "path-cycle": ["let a=foreign", "let box={p:a}", "a=box.p", "let mid=a"],
            "literal-cycle": ["let a=[foreign]", "let b=a", "a=b", "let mid=b[0]"],
            projected: ["let a={q:[foreign]}", "let mid=a.q[0]"],
            diamond: ["let a=foreign", "let b=a", "let mid=a", "mid=b"],
          }[shape];
          const step = path.startsWith("[") ? "" : ".";
          const at = "c" + step + path;
          const tail = {
            host: ["let c=root", "c=mid", `${at}=hostValue`],
            text: ["let c=root", "c=mid", `${at}="bad"`],
            null: ["let c=root", "c=mid", `${at}=null`],
            guard: ["let c=root", `if ${"mid" + step + path} is integer {c=mid}`],
            add: ["let c=[root]", "c.add(mid)", "let copy=c"],
            default: ["function use(p=root){let c=p\nc=mid\nlet d=c}", "use()", "use(root)"],
            rejection: ["let c=root", `${at}="bad"`, "c=mid", `${at}=typed`],
          }[op];
          add([type, carrier, shape, op].join("/"), lines(def, middle, tail));
        }
  // the seeded graphs: contents, landings, source order and cycles varied independently
  let state = 0x7391a4;
  const rand = (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  for (let index = 0; index < 1200; index++) {
    const [type, value] = types[rand(types.length)];
    const init = [
      `let typed:${type}=${value}`,
      "let num:integer=1",
      'let text:string="x"',
      "let root={f:typed,g:num}",
      "let foreign={f:hostValue,g:text}",
      "let a=root",
      "let b=foreign",
      "let c=root",
    ];
    const actions = [
      "a=b",
      "b=a",
      "c=a",
      "c=b",
      "a=a",
      "b=b",
      "c=c",
      "a.q=b",
      "b.q=a",
      "a={f:typed,g:num}",
      "b={f:hostValue,g:num}",
      "a.f=hostValue",
      "b.f=null",
      'c.g="bad"',
      "if hostValue is integer {a=b}",
      "a={p:b}.p",
      "c=[a,b][0]",
      "let box={p:a}\na=box.p",
      "let xs=[b]\nxs.add(a)\nc=xs[0]",
    ];
    const selected = [];
    for (let k = 0; k < 4; k++) selected.push(actions[rand(actions.length)]);
    const terminal = [
      "let out=c",
      "let out=[a,b,c]",
      "let out={p:c}",
      "let out=c.f",
      "c.f=hostValue",
      "let copy=a\ncopy=b",
    ][rand(6)];
    add("graph/" + index, lines(init, selected, terminal));
  }
  // a graph that declares `box` or `xs` twice, renamed as the repair run renamed it
  const twice = (source, text) => source.split(text).length > 2;
  return [...cases.values()].map(({ name, source }) => {
    if (!twice(source, "let box={p:a}\n") && !twice(source, "let xs=[b]\n")) return [name, source];
    let i = 0;
    const repaired = source
      .replaceAll("let box={p:a}\na=box.p", () => {
        const box = `box${i++}`;
        return `let ${box}={p:a}\na=${box}.p`;
      })
      .replaceAll("let xs=[b]\nxs.add(a)\nc=xs[0]", () => {
        const xs = `xs${i++}`;
        return `let ${xs}=[b]\n${xs}.add(a)\nc=${xs}[0]`;
      });
    return [`${name}/repaired`, repaired];
  });
})();

// the globals the recorded runs passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node new-corpus.mjs", "/tmp/agent-work/o4-m4-f1/review/r3/report.md:93"],
    ["node repair-corpus.mjs", "/tmp/agent-work/o4-m4-f1/review/r3/report.md:93"],
  ],
  sources: 2912,
  sha256: "ec0e8e506b5aa037b92c776be2bafd6f3dbf81546c4e22a07b4ee9c336bcb659",
  dropped: [
    [
      "ea292be69aece178cdf5173cf9403ddf4f60405cd890dec73481b5c43a5d5b4a",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "d538a9bd024e91182a8f1c0101220167e5565c94c55589822793a2b0b63a222e",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "c5880263253f696f8cf3bf742ee8b40231ee8556a7fb59f535046ac7baa73a5a",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "b5c728d110bf4a3dd1fb25544752651c521bc3630cc95339574844637f145267",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "24a85c37fbe01133b9535b622ed757d438ce778f6dca5797d6d25fb0294b44cd",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "a4094615a4564a6d8e7d49edda756fb3069462b6ae104087833c9cf1d0074988",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "f5f704e0860c0ae4319538d905ea7c3352e74c675567fdfefc9fa7dec361456e",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "e22b4b3f3af5977ff2be99d483ffe44728907f02564e1496aa942364f06f8673",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "e6aaafb45aa1d689637d522e7bafb33ee72d2f59719b93d1c09ee7c7651812b2",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "b13acd4b544cfd6333e53c1b7f6b83aa197c33bd3eb123abeb8437fa7d0b6821",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "836fe38867ccd9cd9f786efc7df20ccaf6567f1edb70553d47b797574316a423",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "5fab5c662717f7b2c74c59008211a476a2cf32d1442287dba6f3c96dc3d8655d",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "28e9a46663a9ced43827d947b7e5d5f28a8315e15f158a41289711b8fcd4cca3",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "220f1ed7244f462b4f5a33a1d6d858ad956cdbb641f4fe6ab65577c3d648d051",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "a9bca852e2ce9f0af9e7b0028219e3f996cb3b439bb6e51dbf6dab35b672f019",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "5efa455a22ef16daef38df0440f9db260503c3538d310833a0aae8c5cf445c70",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "98b00c06ce6fe87c615d7177755c017b1b24fae1fc65717fb54ece719f5c7e31",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "db322f999a021180c5b09b675d7887e91387b9a0d599f0d40b38b101711702fc",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "2b88498b41b97cd4f4cbebe484e7c4490a1aa54a3ecf56973620d504154aecf4",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "191b1a6020c372dc09a95ecf4bb24d1cb6a1a5dc119cf596879b0c53f4af283c",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "68a8539373612204754533b650abc62c782ed72397d1d1d07b4fab77cd7f5e3c",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "922636a88befb603aa99ac29f84124b2635c1c0d578d2a0437f591846bca0c88",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "45ba43a0b621574c4126552d5a9929b89a223400d58beda317098e3f903099ea",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "10115d2ccc8906c34a14139733789fd09a04e89b1fc983541374a47f059defdf",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "97c4e3e1b0884788586150eb06680df39ddeaf5eda6a503ffe2489005db920a6",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "8e3ad1918eae68065c194877c5220d4bdce759e7ea2aaf918554b028830560a6",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "3b82b58916db98cbff9e3849751e0fcdfca01721c6c1a7dcaaf0671c316e0aa0",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "0a2c548a1595a5c0a93ba362199132483194de645dbe244361068259d73bd3d6",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "ec64b1d42fad31f455bb953618d05c4297af17a911eafb301c335bef82a43847",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "9e575223ad2aa3c0493b5322774b91bfc3e58653fe81fce9ec4eb6cc1c4b5531",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "113d35ce1f6e5089ad6cbdcb1d3de91f5a468916bff804c3d6aa28fbf236908c",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
    [
      "df5bef236f161567c3e026a39bef936a9d68f9b39c5c93e490f5eedd4598996d",
      "declares 'box' or 'xs' twice (TSV001): a mistake of the seeded generator, which its repair run renamed",
    ],
  ],
};
