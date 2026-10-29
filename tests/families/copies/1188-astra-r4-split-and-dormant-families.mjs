// #1188; Astra review.
export const sizes = [4, 8];
export const shapes = (() => {
  const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const source = (...xs) => xs.flat(Infinity).join("\n") + "\nexit\n";
  const fields = (n, v, p = "f") => seq(n, (i) => `${p}${i}:${v}`).join(",");
  const relay = (n, place) =>
    source(
      "let typed:integer=17",
      `let shared={${fields(n, "typed")}}`,
      seq(n, (i) => [
        `let inner${i}=[{f${i}:false},shared]`,
        `let wrap${i}={value:inner${i}}`,
        `let relay${i}=wrap${i}`,
        ...(place
          ? [`let final${i}=relay${i}.value.first`, `final${i}=shared`]
          : [`let final${i}=[relay${i}.value.first,shared]`]),
      ]),
    );
  const split = (n, place, live = false) =>
    source(
      "let ix:integer=67",
      'let sx:string="item"',
      `let wide={${fields(n, "ix")}}`,
      seq(n, (i) => [
        `let left${i}=wide`,
        `let right${i}={f0:${live ? "ix" : "sx"}}`,
        `left${i}=right${i}`,
        `right${i}=left${i}`,
        `let bundle${i}={west:left${i},east:right${i}}`,
        ...(place
          ? [`let out${i}=bundle${i}.west`, `out${i}=bundle${i}.east`]
          : [`let out${i}=[bundle${i}.west,bundle${i}.east]`]),
      ]),
    );
  const dormant = (n, place) =>
    source(
      "let exact:integer=71",
      `let annotated={${fields(n, "exact")}}`,
      `let loose={${fields(n, "1.25")}}`,
      "let container=loose",
      "container=annotated",
      seq(n, (i) => [
        `let part${i}=container`,
        `part${i}.local${i}=exact`,
        `let relay${i}=part${i}`,
        ...(place
          ? [`let sink${i}=container`, `sink${i}=relay${i}`]
          : [`let sink${i}=[relay${i},container]`]),
      ]),
    );
  const pairs = (n, equal) =>
    source(
      "let exact:integer=73",
      seq(n, (i) => `let record${i}={${fields(n, "exact", equal ? "key" : `key${i}_`)}}`),
      seq(n, (i) => seq(n - i - 1, (j) => `let pair${i}_${j}=[record${i},record${i + j + 1}]`)),
    );
  const shapes = {
    n3: (n) => relay(n, false),
    "n3-place": (n) => relay(n, true),
    split: (n) => split(n, false),
    "split-place": (n) => split(n, true),
    "whole-control": (n) => split(n, false, true),
    dormant: (n) => dormant(n, false),
    "dormant-place": (n) => dormant(n, true),
    residual: (n) => pairs(n, false),
    "residual-shared": (n) => pairs(n, true),
    "opaque-ring": (n) =>
      source(
        "let fixed:integer=79",
        "let basis={v:fixed}",
        seq(n, (i) => [
          `let a${i}=load("source${i}",default:null)`,
          `let b${i}=a${i}`,
          `a${i}=b${i}`,
        ]),
        `let out=[basis,${seq(n, (i) => `b${i}`).join(",")}]`,
      ),
    "fitting-control": (n) =>
      source(
        "let fixed:integer=79",
        `let base={${fields(n, "fixed")}}`,
        seq(n, (i) => [`let copy${i}=base`, `copy${i}.f${i}=81`, `let next${i}=copy${i}`]),
      ),
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(shapes)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
