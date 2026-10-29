// #1188; Astra review; shared generation code from one original module.
export const sizes = [2, 4];
const outputs = (() => {
  const ids = (n) => Array.from({ length: n }, (_, i) => i);
  const record = (n, value, prefix = "f") =>
    `{${ids(n)
      .map((i) => `${prefix}${i}:${value}`)
      .join(",")}}`;
  const end = (lines) => lines.join("\n") + "\nexit\n";
  const shapes = {
    "rejected-nested-projections": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "unit")}`,
        ...ids(n).flatMap((i) => [
          `let sack${i}=[{box:{f0:"bad"}},{box:wide}]`,
          `let clone${i}=sack${i}`,
          `let final${i}=[clone${i}.first.box,wide]`,
        ]),
      ]),
    "opaque-fitting-parameters": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "unit")}`,
        ...ids(n).flatMap((i) => [
          `function use${i}(arg) { let copy=wide\ncopy=arg }`,
          `use${i}(wide)`,
        ]),
      ]),
    "opaque-fitting-object-result": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "unit")}`,
        ...ids(n).flatMap((i) => [
          `function give${i}(arg):object { return wide }`,
          `let a${i}=wide`,
          `a${i}=give${i}(${i})`,
        ]),
      ]),
    "opaque-nested-fold": (n) =>
      end([
        "let unit:integer=7",
        ...ids(n).flatMap((i) => [`let h${i}=hostValue`, `h${i}=h${i}`, `let w${i}={box:h${i}}`]),
        `let bag=[${ids(n)
          .map((i) => `w${i}.box`)
          .join(",")},{inner:{flag:unit}}]`,
      ]),
    "opaque-nested-fixed": (n) =>
      end([
        "let unit:integer=7",
        "let h=hostValue",
        "h=h",
        ...ids(n).map((i) => `let w${i}={box:h}`),
        `let bag=[${ids(n)
          .map((i) => `w${i}.box`)
          .join(",")},{inner:{flag:unit}}]`,
      ]),
    "rejected-transit-fan": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "unit")}`,
        'let text={f0:"bad"}',
        "let bad=[text,wide]",
        "let parcel={box:bad}",
        "let carry=parcel",
        ...ids(n).flatMap((i) => [`let hop${i}=carry`, `let bowl${i}=[hop${i}.box.first,text]`]),
      ]),
    "seeded-ring-place": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "unit")}`,
        `let other=${record(n, "unit", "g")}`,
        ...ids(n).flatMap((i) => [
          `let a${i}=wide`,
          `let b${i}=a${i}`,
          `let c${i}=b${i}`,
          `a${i}=c${i}`,
          `c${i}.f${i}=unit`,
          `let parcel${i}={box:b${i}}`,
          `let join${i}=parcel${i}.box`,
          `join${i}=other`,
        ]),
      ]),
    "seeded-ring-literal": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "unit")}`,
        `let other=${record(n, "unit", "g")}`,
        ...ids(n).flatMap((i) => [
          `let a${i}=wide`,
          `let b${i}=a${i}`,
          `let c${i}=b${i}`,
          `a${i}=c${i}`,
          `c${i}.f${i}=unit`,
          `let parcel${i}={box:b${i}}`,
          `let join${i}=[parcel${i}.box,other]`,
        ]),
      ]),
    "cold-meetings": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "1.25")}`,
        `let narrow=${record(n, "unit")}`,
        "let mix=wide",
        "mix=narrow",
        ...ids(n).flatMap((i) => [`let copy${i}=mix`, `copy${i}=narrow`]),
      ]),
    "cold-meetings-fixed-width": (n) =>
      end([
        "let unit:integer=7",
        "let wide={f0:1.25}",
        "let narrow={f0:unit}",
        "let mix=wide",
        "mix=narrow",
        ...ids(n).flatMap((i) => [`let copy${i}=mix`, `copy${i}=narrow`]),
      ]),
    "cold-meetings-literals": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "1.25")}`,
        `let narrow=${record(n, "unit")}`,
        "let mix=wide",
        "mix=narrow",
        ...ids(n).map((i) => `let copy${i}=[mix,narrow]`),
      ]),
    "opaque-fitting-functions": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "unit")}`,
        ...ids(n).flatMap((i) => [
          `function source${i}(unused) { return wide }`,
          `let opaque${i}=source${i}(${i})`,
          `let copy${i}=wide`,
          `copy${i}=opaque${i}`,
        ]),
      ]),
    "opaque-fitting-read-cycle": (n) =>
      end([
        "let unit:integer=7",
        `let wide=${record(n, "unit")}`,
        ...ids(n).flatMap((i) => [
          `let wrap${i}={box:wide}`,
          `let opaque${i}=wrap${i}.box`,
          `wrap${i}.box=opaque${i}`,
          `let copy${i}=wide`,
          `copy${i}=opaque${i}`,
        ]),
      ]),
    "residual-private": (n) =>
      end([
        "let unit:integer=7",
        ...ids(n).map((i) => `let root${i}=${record(n, "unit", `p${i}f`)}`),
        ...ids(n).flatMap((i) =>
          ids(n)
            .filter((j) => j > i)
            .map((j) => `let pair${i}x${j}={nest:[root${i},root${j}]}`),
        ),
      ]),
    "residual-same": (n) =>
      end([
        "let unit:integer=7",
        ...ids(n).map((i) => `let root${i}=${record(n, "unit")}`),
        ...ids(n).flatMap((i) =>
          ids(n)
            .filter((j) => j > i)
            .map((j) => `let pair${i}x${j}={nest:[root${i},root${j}]}`),
        ),
      ]),
  };
  function cases() {
    const out = [];
    // Same small state space via different receiving paths: flat, nested, list projection,
    // a copy ring, and a guard. Values include a written union and a soft/null start.
    const routes = [
      ["flat", "let mirror=landing\nlet transit=mirror", "transit"],
      [
        "nested",
        "let parcel={inside:{payload:landing}}\nlet mirror=parcel\nlet transit=mirror.inside",
        "transit.payload",
      ],
      ["list", "let parcel=[landing]\nlet mirror=parcel\nlet transit=mirror.first", "transit"],
      ["ring", "let mirror=landing\nlet transit=mirror\nmirror=transit", "transit"],
    ];
    const domains = [
      ["integer", "7"],
      ["number", "1.25"],
      ["integer | string", "7"],
      ["integer?", "null"],
    ];
    for (const [domain, init] of domains)
      for (const bad of ['"wrong"', "2.5", "hostValue"])
        for (const [route, setup, read] of routes)
          for (const guarded of [false, true]) {
            const intro = `let anchor:${domain}=${init}\nlet typed={f:anchor}\nlet rival={f:${bad}}\nlet landing=typed\n${guarded ? "if hostValue { landing=rival }" : "landing=rival"}\n${setup}\n`;
            for (const sink of ["literal", "store", "nested-literal"]) {
              const tail =
                sink === "literal"
                  ? `let bowl=[${read},{f:"tail"}]`
                  : sink === "store"
                    ? `let bowl=${read}\nbowl={f:"tail"}`
                    : `let bowl=[{nest:${read}},{nest:{f:"tail"}}]`;
              out.push([
                `dead/${domain}/${bad}/${route}/${guarded}/${sink}`,
                intro + tail + "\nexit\n",
              ]);
            }
          }
    for (const first of ["fraction", "integer", "union"])
      for (const route of routes)
        for (const sequence of [0, 1])
          for (const shape of ["list", "place", "boxed", "union-tail"]) {
            const intro = `let small:integer=7\nlet either:integer | string=7\nlet a={f:${first === "fraction" ? "1.25" : first === "integer" ? "small" : "either"}}\nlet b={f:${first === "fraction" ? "small" : "1.25"}}\nlet landing=${sequence ? "b" : "a"}\nlanding=${sequence ? "a" : "b"}\n${route[1]}\n`;
            const x = route[2];
            const tail =
              shape === "list"
                ? `let result=[b,${x}]`
                : shape === "place"
                  ? `let result=b\nresult=${x}`
                  : shape === "boxed"
                    ? `let result=[{box:b},{box:${x}}]`
                    : `let result=[${x},{f:"tail"},{f:either}]`;
            out.push([
              `decider/${first}/${route[0]}/${sequence}/${shape}`,
              intro + tail + "\nexit\n",
            ]);
          }
    for (const [name, fn] of Object.entries(shapes))
      for (const n of [2, 3]) out.push([`scale/${name}/${n}`, fn(n)]);
    return out;
  }
  const __fixedG233_0 = cases();
  const cases0 = (() => {
    return __fixedG233_0.map(([name, source]) => [name, source]);
  })();
  const shapes1 = (() => {
    return {
      "rejected-nested-projections": (n) => shapes["rejected-nested-projections"](n),
      "opaque-fitting-parameters": (n) => shapes["opaque-fitting-parameters"](n),
      "opaque-fitting-object-result": (n) => shapes["opaque-fitting-object-result"](n),
      "opaque-nested-fold": (n) => shapes["opaque-nested-fold"](n),
      "opaque-nested-fixed": (n) => shapes["opaque-nested-fixed"](n),
      "rejected-transit-fan": (n) => shapes["rejected-transit-fan"](n),
      "seeded-ring-place": (n) => shapes["seeded-ring-place"](n),
      "seeded-ring-literal": (n) => shapes["seeded-ring-literal"](n),
      "cold-meetings": (n) => shapes["cold-meetings"](n),
      "cold-meetings-fixed-width": (n) => shapes["cold-meetings-fixed-width"](n),
      "cold-meetings-literals": (n) => shapes["cold-meetings-literals"](n),
      "opaque-fitting-functions": (n) => shapes["opaque-fitting-functions"](n),
      "opaque-fitting-read-cycle": (n) => shapes["opaque-fitting-read-cycle"](n),
      "residual-private": (n) => shapes["residual-private"](n),
      "residual-same": (n) => shapes["residual-same"](n),
    };
  })();
  return { cases0, shapes1 };
})();
export const cases = [...outputs.cases0];
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes1).map(([name, make]) => ["shapes1/" + name, make]),
]);
export const checks = ["publication"];
