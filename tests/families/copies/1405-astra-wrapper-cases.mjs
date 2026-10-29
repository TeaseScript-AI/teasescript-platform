// #1405 / #1403 Astra review.
export const cases = (() => {
  const cases = [];
  const add = (name, source) => cases.push({ name, source: source + "\nexit\n" });
  const leaves = {
    written: "let leaf: integer = 3",
    nullable: "let leaf: integer? = null",
    union: "let leaf: integer | string = 3",
    host: "let leaf = hostValue",
    list: "let leaf: integer[] = [3]",
    reference: "let leaf = dict {one: 3}",
  };
  for (const [kind, init] of Object.entries(leaves)) {
    const setup =
      init + "\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\n";
    const read = "let result = upper.right.left.cell\nsay result";
    const variants = {
      plain: setup + read,
      elsewhere: setup + "let other = upper\nlet side = upper.right\nsay side\n" + read,
      selection:
        setup +
        "let selected = [upper, upper][0]\nlet result = selected.right.left.cell\nsay result",
      operation:
        setup +
        "let selected = upper otherwise {right: lower}\nlet result = selected.right.left.cell\nsay result",
      leafstore: setup + "leaf = hostOther\n" + read,
      lowerstore: setup + "lower.left = {cell: hostOther}\n" + read,
      rootstore: setup + "root.cell = hostOther\n" + read,
      whole: setup + "upper = {right: lower}\n" + read,
      sibling: setup + "lower.spare = hostOther\n" + read,
      rejected: setup + "lower.left = 3\nlower.left = root\n" + read,
      guarded: setup + "if upper.right is object {\n" + read + "\n}",
      guardroot: setup + "if root.cell is integer {\n" + read + "\n}",
      branch:
        init +
        "\nlet root = {cell: leaf}\nif hostOther {\nlet lower = {left: root}\nlet upper = {right: lower}\n" +
        read +
        "\n}",
      loop:
        init +
        "\nlet root = {cell: leaf}\nrepeat 2 {\nlet lower = {left: root}\nlet upper = {right: lower}\n" +
        read +
        "\nroot.cell = hostOther\n}",
      foreign:
        setup +
        "function touch { root.cell = hostOther }\nlet before = upper.right.left.cell\ntouch()\n" +
        read,
      handler:
        setup +
        'showPermanentButton "change" { lower.left = {cell: hostOther} }\nwait 1 s\n' +
        read,
      "default-only":
        init +
        "\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\n" +
        read +
        "\n}",
      "default-called":
        init +
        "\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\n" +
        read +
        "\n}\ntake()\ntake({left: root})",
    };
    for (const [v, source] of Object.entries(variants)) add(kind + "/" + v, source);
  }
  for (const level of [0, 1, 2, 3])
    for (const event of ["store", "guard", "call", "handler"]) {
      const prefix = ["tree", "tree.a", "tree.a.b", "tree.a.b.c"][level];
      const val = ["{a:{b:{c:2}}}", "{b:{c:2}}", "{c:2}", "2"][level];
      const init = "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\n";
      const tail = "let after = alias.q.a.b.c\nsay after";
      const middle =
        event === "store"
          ? `${prefix} = ${val}`
          : event === "guard"
            ? `if ${prefix} is ${level === 3 ? "integer" : "object"} {\n${tail}\n}`
            : event === "call"
              ? `function change { ${prefix} = ${val} }\nchange()`
              : `showPermanentButton "change" { ${prefix} = ${val} }\nwait 1 s`;
      add(`prefix/${level}/${event}`, init + middle + "\n" + tail);
    }
  for (const written of ["", ": object"])
    add(
      "written-wrapper/" + Boolean(written),
      "let root = {cell: 3}\nlet lower = {left: root}\nlet upper" +
        written +
        " = {right: lower}\nlet answer = upper.right.left.cell\nsay answer",
    );
  for (const order of [false, true])
    for (const seed of ["1", '"text"', "hostValue"]) {
      const both = [
        '[load("one", default: {v: ' + seed + "}), {v: 2}]",
        '[fromJson(hostOther, default: {v: "other"}), {v: 2}]',
      ];
      if (order) both.reverse();
      add(
        `conflicts/${order}/${seed}`,
        `let a = ${both[0]}\nlet b = ${both[1]}\nlet box = {one: a, two: b}\nlet copied = box\nsay copied`,
      );
    }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
