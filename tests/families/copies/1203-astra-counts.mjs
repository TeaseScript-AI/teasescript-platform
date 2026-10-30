// #1203's review (Astra): its counting programs, c loads of a host value with record, nested, choice or null defaults
// gathered into a list (pure, with an added or interleaved record, behind a named host value, through aliases, with
// `otherwise` fallbacks or as one choice) and read at r probes, for the varied, written and classify families at the
// quick and the full (c, r) axes (R/astra-m4-i1203-review/counts.mjs).
const MODES = {
  varied: ["pure", "added", "interleaved"],
  written: ["pure", "added", "root"],
  classify: ["admission", "aliases", "otherwise", "choices"],
};
const QUICK = [
  [3, 4],
  [6, 4],
  [3, 8],
];
const FULL = [
  [24, 24],
  [48, 24],
  [24, 48],
  [64, 64],
  [128, 128],
  [256, 256],
];
function source(family, variant, c, r) {
  const defaults = (i) =>
    family === "written"
      ? ["{west: 2}", "null", "(askChoice [{north: 3}, {south: 4}])"][i % 3]
      : i % 4 === 0
        ? "null"
        : i % 4 === 1
          ? `{label${i}: 3}`
          : i % 4 === 2
            ? `{nested: {label${i}: 5}}`
            : "(askChoice set[3, 5])";
  const host = (i) => (i % 2 ? "hostOther" : "hostValue");
  const loads = Array.from({ length: c }, (_, i) => `load(${host(i)}, default: ${defaults(i)})`);
  let text;
  let read = (i) => `parcel[0].probe${i}`;
  if (variant === "aliases")
    text =
      loads.map((x, i) => `let item${i} = ${x}`).join("\n") +
      `\nlet parcel = [${loads.map((_, i) => "item" + i).join(", ")}]\n`;
  else if (variant === "otherwise")
    text = `let parcel = [${loads.map((_, i) => `load(${host(i)}, default: null) otherwise {fixed${i}: 5}`).join(", ")}]\n`;
  else if (variant === "choices") {
    text = `let parcel = askChoice ${loads.map((x, i) => `{text: "option ${i}", value: ${x}}`).join(", ")}\n`;
    read = (i) => `parcel.probe${i}`;
  } else {
    const parts = [...loads];
    if (variant === "interleaved") {
      parts.splice(1, 0, "{probe0: 8}");
      parts.push('load("direct", default: {side: 5})');
    }
    if (variant === "admission") parts.unshift("named");
    text =
      (variant === "admission" ? "let named = hostOther\n" : "") +
      `let parcel${family === "written" ? ": object?[]" : ""} = [${parts.join(", ")}]\n`;
    if (variant === "added") text += "parcel.add({probe0: 8})\n";
  }
  if (variant === "root") text += "let before = parcel[0]\n";
  return text + Array.from({ length: r }, (_, i) => `repeat ${read(i)} {}`).join("\n") + "\nexit\n";
}
export const cases = Object.entries(MODES).flatMap(([family, variants]) =>
  [...QUICK, ...FULL].flatMap(([c, r]) =>
    variants.map((variant) => [`${family}/${variant}/${c}/${r}`, source(family, variant, c, r)]),
  ),
);

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node --import=./count-hook.mjs counts.mjs . head written --quick",
      "R/astra-m4-i1203-review/commands.md:30",
    ],
    [
      "node --import=./count-hook.mjs counts.mjs . base varied --quick",
      "R/astra-m4-i1203-review/commands.md:31",
    ],
    [
      "node --import=./count-hook.mjs counts.mjs . head classify --quick",
      "R/astra-m4-i1203-review/commands.md:32",
    ],
    [
      "node --import=./count-hook.mjs counts.mjs . head varied",
      "R/astra-m4-i1203-review/commands.md:33",
    ],
    [
      "node --import=./count-hook.mjs counts.mjs . base varied",
      "R/astra-m4-i1203-review/commands.md:34",
    ],
    [
      "node --import=./count-hook.mjs counts.mjs . head written",
      "R/astra-m4-i1203-review/commands.md:35",
    ],
    [
      "node --import=./count-hook.mjs counts.mjs . base written",
      "R/astra-m4-i1203-review/commands.md:36",
    ],
    [
      "node --import=./count-hook.mjs counts.mjs . head classify",
      "R/astra-m4-i1203-review/commands.md:37",
    ],
  ],
  sources: 90,
  sha256: "727b90ce3f2e3f28c351394d0f332bf3c1632122c599c7db6958537964069cff",
};
