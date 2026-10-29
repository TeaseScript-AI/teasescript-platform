// #1165 S8 part 3, r7 retained builder/probe9 evidence; shapes.
export const cases = (() => {
  const values = {
    scalar: ["integer", "9"],
    list: ["integer[]", "[1]"],
    object: ["object", "{n: 1}"],
  };
  const shapes = {
    "mixed-list": '[count, "bad"]',
    "mixed-set": 'set[count, "bad"]',
    "mixed-dict": 'dict{a: count, b: "bad"}',
    "mixed-nested": '{items: [[count, "bad"]]}',
    "plain-list": "[1, 2]",
    // (a literal with one named element, no mixed kinds: its composed questions are the children's reads, r4.144 B1)
    "named-list": "[count]",
    "named-set": "set[count]",
    "named-dict": "dict{a: count}",
    "named-object": "{n: count}",
    "named-union": ["let pick: integer | boolean = 3\n", "[pick]"],
    "named-nullable": ["let maybe: integer? = 3\n", "{n: maybe}"],
    "named-retained": ["let kept = 8.0\nlet observed: number = kept\n", "[kept]"],
    "named-copy": ["let copied = base\n", "{n: copied}"],
    "lazy-list": ["let basket = [2, 4]\n", "[basket.first]"],
    "lazy-nested": ["let basket = [2, 4]\n", "{outer: {inner: basket.first}}"],
    "lazy-copy": ["let basket = [2, 4]\nlet mirror = basket\n", "set[mirror.first]"],
    "ingress-scalar": "hostValue",
    "ingress-list": "[hostValue]",
    "ingress-object": "{n: hostValue}",
    "copy-written": "base",
    "copy-inferred": "src",
  };
  for (const [call, open] of [
    ["parse", "fromJson(hostValue"],
    ["load", 'load("key"'],
  ])
    for (const [kind, [type, literal]] of Object.entries(values)) {
      const name = `${call}-${kind}`;
      shapes[name] = `${open}, default: ${literal})`;
      shapes[`${name}-written`] = [
        `let fallback: ${type} = ${literal}\n`,
        `${open}, default: fallback)`,
      ];
      shapes[`${name}-inferred`] = [`let fallback = ${literal}\n`, `${open}, default: fallback)`];
      shapes[`${name}-call`] = [
        `function fallback { return ${literal} }\n`,
        `${open}, default: fallback())`,
      ];
    }
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
  return collectSources(shapes);
})();
export const checks = ["publication", "stops"];
