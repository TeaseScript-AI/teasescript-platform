// original nested carriers, selections and copies; #1375 Astra review r1
// (R/astra-m4-g3-p1-review-evidence/generate.py).
export const cases = (() => {
  let backwards, cases, container, depth, entries, expr, i, leaf, n, pre, read, style, val;
  cases = [];
  function add(n, s) {
    cases.push({ name: n, source: s + "\nexit\n" });
  }
  for (leaf of ["1", "seed", "hostValue", "null"]) {
    for (depth of [2, 3, 5]) {
      for (style of ["index", "first", "choice"]) {
        val = leaf;
        read = "tree";
        for (i of Array.from({ length: depth - 0 }, (_, i) => i + 0)) {
          val = "[{q: " + val + "}]";
          read =
            style === "choice"
              ? "askChoice(" + read + ").q"
              : read + (style === "index" ? "[0].q" : ".first.q");
        }
        pre = "let seed: integer = 1\nlet tree = " + val + "\n";
        add(`nested-${leaf}-${depth}-${style}`, pre + "let copy = " + read + "\nsay copy");
        add(
          `nested-rejected-${leaf}-${depth}-${style}`,
          pre + "let copy = " + read + '\ncopy = "wrong"\nsay copy',
        );
      }
    }
  }
  for ([container, read] of [
    ["list", "[0]"],
    ["list", ".first"],
    ["set", ".first"],
    ["dict", '["k"]'],
    ["dict", ".values[0]"],
  ]) {
    for (leaf of ["{a: 1, b: 2}", "seed", "hostValue"]) {
      val = { list: "[" + leaf + "]", set: "set [" + leaf + "]", dict: "dict {k: " + leaf + "}" }[
        container
      ];
      add(
        `container-${container}-${read}-${leaf}`,
        `let seed = {a: 1, b: 2}
let tree = {upper: {inner: ${val}}}
let picked = tree.upper.inner${read}
say picked.a
say picked.b`,
      );
    }
  }
  for (n of [2, 3, 5, 9]) {
    for (backwards of [false, true]) {
      entries = [
        "{deep: {slot: seed}}",
        "{deep: {slot: {x: 1, y: 2}}}",
        "{deep: {slot: hostValue}}",
        "{deep: {}}",
      ].slice(undefined, n < 4 ? n : 4);
      if (backwards) {
        entries.reverse();
      }
      add(
        `order-${n}-${backwards}`,
        "let seed = {z: 1, x: 2}\nlet tree = [" +
          entries.join(", ") +
          "]\nsay tree.first.deep.slot.x\nsay tree[0].deep.slot.z",
      );
    }
  }
  for (expr of ["{inner: {a: 1}}", "[{inner: {a: 1}}]", "[[{inner: {a: 1}}]]"]) {
    add(
      "siblings-" + expr,
      "let tree = " +
        expr +
        "\nlet other = " +
        expr +
        "\nlet copy = {left: tree, right: {deeper: other}}\nsay copy",
    );
  }
  add(
    "guard-alias",
    "let seed: integer? = hostValue\nif seed is integer {\n let tree = [[{v: seed}]]\n let copy = tree\n say copy[0][0].v\n}",
  );
  add(
    "rejected-middle",
    'let seed = {a: {n: 1}}\nlet tree = {q: seed}\ntree.q.a = {n: "bad"}\ntree.q.a = {n: 3}\nlet copy = [tree]\nsay copy[0].q.a.n',
  );
  add(
    "host-occurrences",
    "let tree = {left: [[{v: hostValue}]], right: {deep: [[{v: hostValue}]]}}\nsay tree.left[0][0].v\nsay tree.right.deep[0][0].v",
  );
  add(
    "mixed-depth-alias",
    "let seed = {x: 1}\nlet tree = [seed, {q: [seed, {q: [seed]}]}]\nsay tree[0].x\nsay tree[1].q[0].x\nsay tree[1].q[1].q[0].x",
  );
  add(
    "nullable-list-copy-own",
    "let src: list<integer?> = [1, null]\nlet box = {q: [src]}\nlet copy = box.q[0]\ncopy.add(2)\nsay copy[0]",
  );

  return cases.map((c) => [c.name, c.source ?? c.files[0].source]);
})();
export const checks = ["publication"];

for (const index of [
  102, 71, 70, 65, 64, 59, 58, 53, 52, 47, 46, 41, 40, 35, 34, 29, 28, 23, 22, 17, 16, 11, 10, 5, 4,
])
  cases.splice(index, 1);

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "outputs: independent sources, four modes. Run `node builder-probe/publication.mjs <tree>/dist <cases.json>",
      "R/astra-m4-g3-p1-review-evidence/README.md:20",
    ],
  ],
  sources: 101,
  sha256: "faeda4e884cd99fd107bbc29fc0d6c272879278bf799bb1cd18107de66a96ed3",
  dropped: [
    [
      "6a3929aa3c44ec48e1602b7c101a60b1931dc7ecfaa2afba6109f17d8378eec8",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "91e7acf1d4f28400821e12e20f4ea6d4343d1ebc1089459c5f3d187f7b4e510b",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "648eb0aa0368e6ef5ff8203d23d050dd9a9b52b4253901d0a9a90d9c2766ef06",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "5c7033de4984a27e3e1181cf3951573e2578f40e0032978fec9cc6c5e7c344e7",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "82616b5a9aa85fc91adb91a96ce17ad546aea907123e074dfa25ea8a6b227b30",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "f471874cfed2d4ad4cdd362dcac241f3b7606beeaca1a0ac1184e99ab4e4a450",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "aa3f2934ba81d706e14fe49efefbaf5b15067aebf83c048a7ea1c3e4c306b321",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "068989bf9e146b44cb6a8a22335a49ab0c3bd5feacb7b607e6b967db501d472a",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "4270df44a2df11063a9c1739c01693d7810761160bec9f9e5804981a933906f2",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "4285fe4f8774836ec3004e3bc174a246c03740d37a36b96545bd9d8e48c42a66",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "4ec0992aeb57935f5729e3582ca0f483152d876ac32fe505c71acafb8c5a163b",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "fd22184e93db554b9a1ac2ed9478b7651d14f2e893916a44a2139ad64c339108",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "2cebaee94f080114cf5382339999905b911d9f3a921719260f01f1aa7ed2380e",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "c7732caa2a390976cf04a42451e59f5effc30854f55a67aa4833b7eb5ab5a96e",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "02f58642bdb5a0efb71f74204d4027c5b8abd5dbda7878967bb45dd7f63025a4",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "c7562df61527c8b1cf1a20dc5ba33f243b10d00fff766dd154c5881c532a1c3d",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "b1aa6ff21643f025cd0cc8bd6be1d689d1d91e7429b0f839d3f2ef6bbc98b729",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "845de44a93dcda0aa0eab3b13ffebd7f8f9c3c8536db93fe7cc9ebe3e2c3bc48",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "8694aadc9d94d2bd18735d56e55cf9a791e7c898161015b51ac979e46289dd30",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "44a81c9af193db8e6c8de77f1d4df89f36a0608db606627b3c0ff6fe37154b94",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "ec0ffe8c4629f6502f59a056b2f154f8fa10e2df33702f67f00526289705c7fc",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "9ef5201e06477876b63a9fdd6a13b6f4fbf90c1f08850cc0925875aa17605c31",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "6bdc706819bcd1fa65b60056d1ec6ff8153829758c1f3badedf8eec6caca9e6c",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "43e50fe24939bff88c801ac3249abbaf086be3e0e7e18843f7ad9a2841ff7617",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
    [
      "093dde1173751dd941587c93bc09f8489585f5937bee285e89773ae5987e3071",
      "Invalid generator attempt, not an intended parse/name test: parenthesized askChoice or obsolete list<integer?> syntax. /home/peter/notes/teasescript/reports/type-inference-research-2026-10-17/evidence/astra-m4-g3-p1-review-evidence/README.md:19-22 explicitly retains invalid attempts and counts only successfully parsed/resolved cases; generate.py:7-15,35.",
    ],
  ],
};
