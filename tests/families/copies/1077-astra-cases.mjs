// list/inferred/add, list/inferred/add/guard-0 and related fixed cases; #1077, Astra review, round unrecorded
// (R/astra-m4-i1077-evidence/cases.mjs).
export const cases = (() => {
  const cases = [];
  const add = (name, source) =>
    cases.push({ name, files: [{ path: "main.tease", source: source + "\nexit\n" }] });
  const dynamic = "let r = [2.75, hostValue].last\n";
  for (const [container, type, init, read] of [
    ["list", "number[]", "[7.25]", "xs.last"],
    ["set", "number set", "set[7.25]", "xs.first"],
  ]) {
    for (const written of [false, true])
      for (const mode of ["add", "addAll"]) {
        const argument = mode === "add" ? "r" : "more";
        const prep =
          dynamic +
          (mode === "addAll" ? `let more = ${container === "set" ? "set[r]" : "[r]"}\n` : "") +
          `let xs${written ? ": " + type : ""} = ${init}\n`;
        const store = `xs.${mode}(${argument})`;
        add(
          `${container}/${written ? "written" : "inferred"}/${mode}`,
          prep + [store, store, store, `repeat ${read} {}`].join("\n"),
        );
        for (const guarded of [0, 1, 2])
          add(
            `${container}/${written ? "written" : "inferred"}/${mode}/guard-${guarded}`,
            prep +
              [0, 1, 2]
                .map((i) => (i === guarded ? `if r != null {\n${store}\n}` : store))
                .join("\n") +
              `\nrepeat ${read} {}`,
          );
      }
  }
  for (const [type, wrap, read] of [
    ["number[]", (x) => `[${x}]`, "selected.last"],
    ["number set", (x) => `set[${x}]`, "selected.first"],
    ["number dict", (x) => `dict{oak: ${x}}`, 'selected["oak"]'],
    ["number[][]", (x) => `[[${x}]]`, "selected.last.last"],
    ["number[] dict", (x) => `dict{oak: [${x}]}`, 'selected["oak"].last'],
  ])
    for (const guard of [false, true])
      add(
        `returns/${type}/${guard ? "guard" : "plain"}`,
        dynamic +
          `let parcel = ${wrap("r")}\nfunction selectParcel(which): ${type} {\nif which == 0 {\n${guard ? "if r != null {\nreturn parcel\n}\n" : "return parcel\n"}}\nif which == 1 {\nreturn parcel\n}\nreturn parcel\n}\nlet selected = selectParcel(2)\nrepeat ${read} {}`,
      );
  for (const [source, type] of [
    ['"wrong"', "integer[]"],
    ['["wrong",hostValue].last', "integer[]"],
    ["[null,hostValue].last", "number[]"],
  ])
    add(
      `A6/${source}`,
      `let r = ${source}\nlet xs: ${type} = [1]\nxs.add(r)\nif r != null { xs.add(r) }\nxs.add(r)\nrepeat xs.last {}`,
    );
  add(
    "A6/projected-string",
    'let r = {n:"wrong"}\nlet xs: integer[] = [2]\nxs.add(r.n)\nxs.add(r.n)\nxs.add(r.n)\nrepeat xs.last {}',
  );
  add(
    "A6/mutual-copies",
    'let a = [1]\nlet b = ["wrong"]\na = b\na = b\na = b\nb = a\nrepeat a.last {}',
  );
  for (const wrap of [(x) => x, (x) => `{payload:${x}}`, (x) => `[{payload:${x}}]`]) {
    const value = wrap("r"),
      access =
        value === "r"
          ? "xs.last"
          : value.startsWith("[")
            ? "xs.last.last.payload"
            : "xs.last.payload";
    add(
      `literal/${value}`,
      dynamic +
        `let xs = [${wrap("3.5")}]\nxs.add(${value})\nif r != null { xs.add(${value}) }\nxs.add(${value})\nrepeat ${access} {}`,
    );
  }
  for (const variant of [
    "chain",
    "written-domain",
    "source-mutation",
    "alias-mutation",
    "two-targets",
    "mixed-adds",
    "no-decider",
    "before-decider",
    "quiet",
  ]) {
    const sources = {
      chain:
        dynamic +
        "let a = r\nlet b = a\nlet c = b\nlet xs = [2.5]\nxs.add(a)\nxs.add(b)\nxs.add(c)\nrepeat xs.last {}",
      "written-domain":
        "let raw = [hostValue]\nlet a: number[] = raw\nlet b: integer?[] = raw\nlet xs: number[] = [2.5]\nxs.addAll(a)\nxs.addAll(b)\nxs.addAll(a)\nxs.addAll(b)\nrepeat xs.last {}",
      "source-mutation":
        dynamic +
        "let xs = [2.5]\nxs.add(r)\nxs.add(r)\nr = 9.75\nxs.add(r)\nxs.add(r)\nrepeat xs.last {}",
      "alias-mutation":
        dynamic +
        "let alias = r\nlet xs = [2.5]\nxs.add(r)\nxs.add(alias)\nalias = 9.75\nxs.add(r)\nxs.add(alias)\nxs.add(r)\nrepeat xs.last {}",
      "two-targets":
        dynamic +
        "let xs = [2.5]\nlet ys: integer[] = [2]\nxs.add(r)\nys.add(r)\nxs.add(r)\nys.add(r)\nxs.add(r)\nys.add(r)\nrepeat xs.last {}\nrepeat ys.last {}",
      "mixed-adds":
        dynamic +
        "let more = [r]\nlet xs = [2.5]\nxs.add(r)\nxs.addAll(more)\nxs.add(r)\nxs.addAll(more)\nxs.add(r)\nrepeat xs.last {}",
      "no-decider": dynamic + "let xs = []\nxs.add(r)\nxs.add(r)\nxs.add(r)\nrepeat xs.last {}",
      "before-decider":
        "let r = [null,hostValue].last\nlet xs = []\nxs.add(r)\nxs.add(r)\nxs.add(2.5)\nxs.add(r)\nrepeat xs.last {}",
      quiet:
        "let r = 4\nlet xs = [3]\nxs.add(r)\nif r != null { xs.add(r) }\nxs.add(r)\nrepeat xs.last {}",
    };
    add(variant, sources[variant]);
  }
  add(
    "dict/whole-stores",
    dynamic +
      'let parcel = dict{oak:r}\nlet xs: number dict = dict{oak:2.5}\nxs = parcel\nif r != null { xs = parcel }\nxs = parcel\nrepeat xs["oak"] {}',
  );
  add(
    "dict/value-stores",
    dynamic +
      'let xs: number dict = dict{oak:2.5}\nxs["a"] = r\nif r != null { xs["b"] = r }\nxs["c"] = r\nrepeat xs["a"] {}',
  );
  add(
    "whole/guarded-copy",
    dynamic +
      "let parcel = {payload:r}\nlet target = {payload:2.5}\ntarget = parcel\nif r != null { target = parcel }\ntarget = parcel\nrepeat target.payload {}",
  );
  add(
    "default/same-source",
    dynamic +
      "let parcel = [r]\nlet xs: number[] = [3.5]\nxs = parcel.get(7, default: parcel)\nxs = parcel.get(8, default: parcel)\nxs = parcel.get(9, default: parcel)\nrepeat xs.last {}",
  );
  add(
    "typed-return-null",
    "let raw = [null,hostValue].last\nlet parcel = [raw]\nfunction selectParcel(which): integer?[] {\nif which == 0 { return parcel }\nif which == 1 { return parcel }\nreturn parcel\n}\nlet xs = selectParcel(2)\nxs = [null]\nrepeat xs.last {}",
  );
  add(
    "argument-sites",
    dynamic +
      "let parcel = [r]\nfunction use(xs: integer[]) { repeat xs.last {} }\nuse(parcel)\nif r != null { use(parcel) }\nuse(parcel)",
  );
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node cases.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1077-evidence/cases.mjs",
    ],
  ],
  sources: 65,
  sha256: "c403f4501ca5fa074d6e5d84fc520fedd90f33c98c0c9ae0b1b9007787ef7ad4",
};
