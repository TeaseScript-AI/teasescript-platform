// Astra review: size-dependent shape-configured source families.
export const sizes = [7, 14];
const corpus = (() => {
  const range = (k) => Array.from({ length: k }, (_, i) => i);
  const names = [
    "literal-wheel",
    "computed-wheel",
    "copy-wheel",
    "selected-wheel",
    "option-wheel",
    "list-wheel",
    "mixed-list-wheel",
  ];
  function shape(family, k) {
    const ids = range(k),
      vars = ids.map((i) => `v${i}`);
    const setup = ids
      .map(
        (i) =>
          `let v${i}: integer? = load("ring-${i}", default: ${i + 2})\nif change { v${i} = null }`,
      )
      .join("\n");
    const gathers = {
      "literal-wheel": `let bucket = [${vars.join(", ")}]\naggregate = bucket[pick] otherwise 3`,
      "computed-wheel": `let bucket = [${vars.map((v) => `(${v} otherwise null)`).join(", ")}]\naggregate = bucket[pick] otherwise 3`,
      "copy-wheel": `${ids.map((i) => `let box${i} = {amount: v${i}}`).join("\n")}\nlet bucket = [${ids.map((i) => `box${i}`).join(", ")}]\naggregate = bucket[pick].amount otherwise 3`,
      "selected-wheel": `let buttons = [${ids.map((i) => `{text: "pick ${i}", value: v${i}}`).join(", ")}]\naggregate = (askChoice buttons) otherwise 3`,
      "option-wheel": `aggregate = (askChoice ${ids.map((i) => `{text: "pick ${i}", value: v${i}}`).join(", ")}) otherwise 3`,
      "list-wheel": `aggregate = (askChoice [${vars.join(", ")}]) otherwise 3`,
      "mixed-list-wheel": `aggregate = (askChoice [${ids.map((i) => (i === k - 1 ? `v${i}` : `{text: "pick ${i}", value: v${i}}`)).join(", ")}]) otherwise 3`,
    };
    if (!(family in gathers)) throw Error(family);
    return `let pick = 1\nlet change = askBoolean "optional?"\n${setup}\nlet aggregate: integer? = 3\nif ${vars.map((v) => `${v} != null`).join(" and ")} and aggregate != null {\nrepeat 3 {\n${gathers[family]}\n${ids.map((i) => `let carried${i} = v${(i + 1) % k}`).join("\n")}\n${ids.map((i) => `v${i} = ${i === k - 1 ? "aggregate otherwise null" : `carried${i}`}`).join("\n")}\nlet observed: integer = aggregate\n}\n}\nexit\n`;
  }
  return {
    shapes: {
      "literal-wheel": (n) => shape(names[0], n),
      "computed-wheel": (n) => shape(names[1], n),
      "copy-wheel": (n) => shape(names[2], n),
      "selected-wheel": (n) => shape(names[3], n),
      "option-wheel": (n) => shape(names[4], n),
      "list-wheel": (n) => shape(names[5], n),
      "mixed-list-wheel": (n) => shape(names[6], n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication"];
