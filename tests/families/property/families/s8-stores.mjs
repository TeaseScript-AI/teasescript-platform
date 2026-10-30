import { hash } from "../lib/json.mjs";
import { makeType, literal, typeText, witnesses } from "../lib/model.mjs";

/** New builder-facing family from declared dimensions; never reads review bundles. */
export const dimensions = {
  leaf: ["integer", "string", "boolean"],
  depth: [1, 2],
  nullable: ["none", "leaf", "root"],
  carrier: ["written", "copy", "chain", "field", "index"],
};
export const interactionGroups = [
  ["leaf", "depth"],
  ["nullable", "carrier"],
  ["depth", "nullable", "carrier"],
];
export function render(d, seed = 1442) {
  for (const [key, values] of Object.entries(dimensions))
    if (!values.includes(d[key])) throw new Error(`Invalid dimension ${key}`);
  const type = makeType(d),
    inputs = witnesses(type, seed);
  const initial = literal(inputs.find((x) => x.allowed).value);
  const setup = [`let origin: ${typeText(type)} = ${initial}`];
  let binding = "origin",
    path = [],
    target = "origin",
    written = true;
  switch (d.carrier) {
    case "copy":
      setup.push("let target = origin");
      binding = target = "target";
      written = false;
      break;
    case "chain":
      setup.push("let stage = origin", "let target = stage");
      binding = target = "target";
      written = false;
      break;
    case "field":
      setup.push("let box = {payload: origin}");
      binding = "box";
      path = [{ property: "payload" }];
      target = "box.payload";
      written = false;
      break;
    case "index":
      setup.push("let box = [origin]");
      binding = "box";
      path = ["element"];
      target = "box[0]";
      written = false;
      break;
  }
  const source = [
    ...setup,
    'say "BEFORE"',
    `${target} = hostValue`,
    'say "AFTER"',
    "exit",
    "",
  ].join("\n");
  const start = source.indexOf("hostValue");
  const spec = { leaf: d.leaf, depth: d.depth, nullable: d.nullable, carrier: d.carrier };
  return {
    id: `s8-${hash(spec).slice(0, 16)}`,
    family: "s8-stores",
    dimensions: spec,
    source,
    sourceHash: hash(source),
    globals: ["hostValue"],
    destination: { binding, path, written },
    site: { start, end: start + 9 },
    type,
    inputs,
    properties: [
      "complete-planned-type",
      "fitting-input-accepted",
      "forbidden-input-rejected",
      "effect-prefix",
      "fault-site",
      "input-unchanged",
      "owned-stop-warning",
    ],
  };
}
export function generate(seed = 1442) {
  const cases = [];
  for (const leaf of dimensions.leaf)
    for (const depth of dimensions.depth)
      for (const nullable of dimensions.nullable)
        for (const carrier of dimensions.carrier)
          cases.push(render({ leaf, depth, nullable, carrier }, seed));
  return cases;
}
/** Semantic shrinking: preserve the tested store, type family and model; re-render every candidate. */
export function smaller(c, seed) {
  const candidates = [];
  const d = c.dimensions;
  if (d.carrier === "chain") candidates.push({ ...d, carrier: "copy" });
  if (["field", "index"].includes(d.carrier)) candidates.push({ ...d, carrier: "copy" });
  if (d.nullable !== "none") candidates.push({ ...d, nullable: "none" });
  if (d.depth > 1) candidates.push({ ...d, depth: d.depth - 1 });
  return candidates.map((x) => render(x, seed)).filter((x) => x.source.length < c.source.length);
}
