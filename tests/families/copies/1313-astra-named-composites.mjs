const corpus = (() => {
  const many = (k, f, sep = ", ") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const wide = (k, name = "f") => `{${many(k, (i) => `${name}${i}: 1`)}}`;
  const at = (where, k) => (where === "first" ? 0 : where === "last" ? k : k >> 1);
  function named(
    k,
    {
      where = "amid",
      reads = true,
      object = true,
      binding = (i) => `load("k", default: hostValue)`,
    } = {},
  ) {
    const elements = Array.from({ length: k }, (_, i) => `l${i}`);
    if (object) elements.splice(at(where, k), 0, wide(k));
    return [
      many(k, (i) => `let l${i} = ${binding(i)}`, "\n"),
      `let xs = [${elements.join(", ")}]`,
      reads ? many(k, (i) => `let a${i}: integer = xs[0].f${i}`, "\n") : "",
      "exit",
    ].join("\n");
  }
  function composite(k, element, { where = "amid", wrap = (x) => x, path = "" } = {}) {
    const es = Array.from({ length: k }, (_, i) => wrap(element(i)));
    es.splice(at(where, k), 0, wrap(`{${many(k, (i) => `p${i}:1`)}}`));
    return (
      `let t:integer=1\nlet raw=hostValue\nlet xs=[${es}]\n` +
      many(k, (i) => `let n${i}:integer=xs[0].${path}p${i}`, "\n") +
      "\nexit"
    );
  }
  const loadOtherwise = () => '(load("k",default:hostValue) otherwise {p0:1})';
  const shapes = {
    // #1313's six
    namedAmid: (k) => named(k),
    namedFirst: (k) => named(k, { where: "first" }),
    namedLast: (k) => named(k, { where: "last" }),
    namedNoRead: (k) => named(k, { reads: false }),
    namedNoObject: (k) => named(k, { object: false }),
    namedHost: (k) => named(k, { binding: () => "hostValue" }),
    namedSmall: (k) => named(k, { binding: () => "{f0: 1}" }),
    // #1304 and its siblings
    otherwiseAmid: (k) => composite(k, loadOtherwise),
    otherwiseFirst: (k) => composite(k, loadOtherwise, { where: "first" }),
    otherwiseLast: (k) => composite(k, loadOtherwise, { where: "last" }),
    fromJsonOtherwise: (k) =>
      composite(k, () => '(fromJson("{}",default:hostValue) otherwise {p0:1})'),
    parseDefault: (k) => composite(k, () => 'fromJson("{}",default:{p0:1})'),
    loadDefaultObject: (k) => composite(k, () => 'load("k",default:{p0:1})'),
    otherwiseNested: (k) =>
      composite(k, loadOtherwise, { wrap: (x) => `{box:${x}}`, path: "box." }),
    otherwiseDeep: (k) =>
      composite(
        k,
        () =>
          '(load("k",default:hostValue) otherwise (load("j",default:hostValue) otherwise {p0:1}))',
      ),
  };
  return { shapes: shapes };
})();
export const sizes = [4, 6, 8, 12, 24, 48, 64, 96, 128];
export const shapes = corpus.shapes;

export const checks = ["publication"];
