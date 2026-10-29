const corpus = (() => {
  // The generated stop matrix (TABLE r4.138, r4.144): every consumer position against every value shape, each program one
  // case. Positions: a store into an inferred place, into a written one, a direct consumer, an argument of a single-site
  // and of a multi-site call, a return, a condition, a selection (`.first`, `.get`). Shapes: mixed literals with a named
  // element (list, set, dict, nested), literals with one named element (written, a union, a nullable, a decided and a
  // copied one), a plain literal, ingress (a scalar, in a list, in an object), typed calls (fromJson
  // and load, each with a scalar, list and object default), copies (of a written list, of an inferred one).
  // The default-provenance axis (r4.144 (1)): each typed call's default is a literal, a named variable with a written
  // type, a named inferred variable, or a call; the literal ones keep their earlier case names.
  // The composed-selection axis (r4.158): a literal whose child is a selection of an inferred list, a place admission
  // decides lazily (in a list, two objects deep, through a copy in a set).
  const prefix = "let count: integer = 2\nlet base: integer[] = [1]\nlet src = [1, 2]\n";
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
  const positions = {
    "store-inferred": (x) => `let v = ${x}\nsay v`,
    "store-written": (x) => `let v: (integer | string)[] = [1]\nv = ${x}\nsay v`,
    direct: (x) => `say ${x}`,
    "argument-single": (x) => `function f(p) { say p }\nf(${x})`,
    "argument-multi": (x) => `function f(p) { say p }\nf(${x})\nf(${x})`,
    return: (x) => `function make { return ${x} }\nsay make()`,
    condition: (x) => `if ${x} != null { say "set" }`,
    "selection-first": (x) => `say ${x}.first`,
    "selection-get": (x) => `say ${x}.get(0, default: 3)`,
  };
  const matrix = [];
  for (const [p, place] of Object.entries(positions))
    for (const [s, shape] of Object.entries(shapes)) {
      const [declarations, value] = typeof shape === "string" ? ["", shape] : shape;
      matrix.push([`m-${p}-${s}`, `${prefix}${declarations}${place(value)}\nsay "DONE"\nexit`]);
    }

  return { cases: matrix.map(([name, source]) => [name, source]) };
})();
export const cases = corpus.cases;

export const checks = ["publication", "stops"];
