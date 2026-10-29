// #1165 S8 part 3, r7 retained builder/probe9 evidence; SHAPES.
export const cases = (() => {
  const list = (items) => ({ kind: "list", items });
  const object = (props) => ({
    kind: "object",
    properties: Object.entries(props).map(([name, value]) => ({ name, value })),
  });
  const SHAPES = {
    scalar: {
      key: "tally",
      init: "1",
      store: (i) => `${i + 2}`,
      fit: 2,
      bad: 2.5,
      readers: {
        value: ["repeat tally {}"],
        later: ["let picked: integer = tally", "repeat tally {}", "repeat tally {}"],
        composed: ["say [tally]", "repeat tally {}"],
        copy: ["let other = tally", "repeat other {}"],
        // Codex c-r7 B1: a literal's property or element read in place, and an operation over the read
        objectRead: ["repeat {kept: tally}.kept {}"],
        listRead: ["repeat [tally].first {}"],
        operation: ["repeat tally + 1 {}"],
        // TABLE r4.180: a stored literal holding the read, reread after the stop
        dependent: ["let pair = [tally]", "repeat pair.first {}"],
        // Codex c-r8 B1: a read under a type test of the key, and one beside it
        narrowed: [
          "if tally is integer {",
          "  let picked: integer = tally",
          "}",
          "repeat tally {}",
        ],
        narrowedNot: ["if tally is not integer {", "  let picked = tally", "}", "repeat tally {}"],
      },
      // the expression whose answer, composed from the stopped read, must be `budget` (`at`)
      probes: {
        objectRead: "{kept: tally}.kept",
        listRead: "[tally].first",
        operation: "tally + 1",
        dependent: "pair.first",
      },
      // (the stored literal's reread tells r4.180's pass from none only where `tally`'s decision is far longer than
      // `pair`'s, so a cap stops the one and not the other: 60 stores, as the CI test has)
      sizes: { dependent: [60] },
      // TABLE r4.183: a read under `is integer` is the integer the test proves, its reason the test's, not `budget`
      guarded: { narrowed: "tally\n}" },
    },
    list: {
      key: "basket",
      init: "[1]",
      store: (i) => `[${i + 2}]`,
      fit: list([2]),
      bad: list([2.5]),
      readers: {
        descendant: ["repeat basket.first {}"],
        composed: ["say [basket.first]", "repeat basket.first {}"],
        whole: ["let copied = basket", "repeat copied.first {}"],
      },
    },
    object: {
      key: "box",
      init: "{n: 1}",
      store: (i) => `{n: ${i + 2}}`,
      fit: object({ n: 2 }),
      bad: object({ n: 2.5 }),
      readers: {
        descendant: ["repeat box.n {}"],
        receiver: ["box.n = 3", "repeat box.n {}"],
        composed: ["say [box.n]", "repeat box.n {}"],
      },
    },
  };
  function collectSources(value, name = "case", out = []) {
    const isSource = (s) =>
      typeof s === "string" &&
      /(^|\n)\s*(global |let |function |say |exit\b|if |repeat |speaker |scene |call |goto |wait |show)/.test(
        s,
      );
    const isFiles = (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string");
    const leaf = (v) => isSource(v) || isFiles(v);
    if (leaf(value)) out.push([name, value]);
    else if (value && typeof value === "object") {
      if (leaf(value.source)) out.push([value.name ?? value.id ?? name, value.source]);
      else if (leaf(value.files)) out.push([value.name ?? value.id ?? name, value.files]);
      else if (Array.isArray(value) && typeof value[0] === "string" && leaf(value[1]))
        out.push([value[0], value[1]]);
      else
        for (const [key, item] of Object.entries(value)) {
          if (
            ![
              "where",
              "expected",
              "expect",
              "description",
              "message",
              "fallback",
              "say",
              "diagnostics",
              "patch",
            ].includes(key)
          )
            collectSources(item, name + "/" + key, out);
        }
    }
    return out;
  }
  return collectSources(SHAPES);
})();
export const checks = ["publication", "stops"];
