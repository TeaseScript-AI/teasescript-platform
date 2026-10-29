// #1241; Astra review.
export const cases = (() => {
  const cases = [];
  for (const origin of ["index", "random"])
    for (const nullValue of [true, false]) {
      const setup = `let boxes = [{n: 2, items: [1], text: "hi"}, null]\nlet box = ${origin === "index" ? `boxes[${nullValue ? 1 : 0}]` : "boxes.random"}\n`;
      for (const [name, original, pasted] of [
        [
          "unit",
          "let converted: duration = box.n\nsay converted",
          "let converted: duration = box.n s\nsay converted",
        ],
        ["list", "say box.items + 2", "say box.items + [2]"],
        ["add", "say box.items + 2", "box.items.add(2)\nsay box.items"],
        ["member", "say box.text.size", "say box.text.length"],
      ])
        cases.push({
          name: `${origin}:${nullValue}:${name}`,
          original: setup + original + "\nexit\n",
          pasted: setup + pasted + "\nexit\n",
        });
    }
  for (const nullValue of [true, false])
    for (const collection of ['["hi", null]', "[[1], null]"]) {
      const setup = `let values = ${collection}\nlet holder = values[${nullValue ? 1 : 0}]\n`;
      cases.push({
        name: `scalar:${collection}:${nullValue}`,
        original: setup + "let converted: duration = holder.length\nsay converted\nexit\n",
        pasted: setup + "let converted: duration = holder.length s\nsay converted\nexit\n",
      });
    }
  for (const nullValue of [true, false]) {
    const setup = `let values: string?[] = ["hi", null]\nlet holder = values[${nullValue ? 1 : 0}]\n`;
    cases.push({
      name: `written-null:${nullValue}`,
      original: setup + "let converted: duration = holder.length\nsay converted\nexit\n",
      pasted: setup + "let converted: duration = holder.length s\nsay converted\nexit\n",
    });
  }
  return cases.flatMap((c, i) =>
    ["original", "pasted"]
      .filter((key) => typeof c[key] === "string")
      .map((key) => [(c.name ?? i) + "/" + key, c[key]]),
  );
})();
export const checks = ["publication"];
