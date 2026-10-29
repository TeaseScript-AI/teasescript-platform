// #1375 Astra review r1.
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
