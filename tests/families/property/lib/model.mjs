/** Independent, bounded value model. No compiler matcher or external evidence is imported. */
export function fits(type, value) {
  if (type.kind === "optional") return value === null || fits(type.value, value);
  if (type.kind === "list")
    return (
      value?.kind === "list" &&
      Array.isArray(value.items) &&
      value.items.every((v) => fits(type.element, v))
    );
  if (type.kind === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type.kind === "string") return typeof value === "string";
  if (type.kind === "boolean") return typeof value === "boolean";
  throw new Error(`Unsupported model type ${type.kind}`);
}
export function typeText(type) {
  if (type.kind === "optional") return `${typeText(type.value)}?`;
  if (type.kind === "list") return `${typeText(type.element)}[]`;
  if (["integer", "string", "boolean"].includes(type.kind)) return type.kind;
  throw new Error(`Unsupported type ${type.kind}`);
}
export function expectedPlanType(type) {
  if (type.kind === "optional")
    return { kind: "union", members: [expectedPlanType(type.value), { kind: "null" }] };
  if (type.kind === "list") return { kind: "list", element: expectedPlanType(type.element) };
  return { kind: type.kind };
}
export function typeSignature(type) {
  if (type === null || type === undefined) return "any";
  if (type.kind === "union") return type.members.map(typeSignature).sort().join("|");
  if (type.kind === "optional") return [typeSignature(type.value), "null"].sort().join("|");
  if (type.kind === "list") return `list<${typeSignature(type.element)}>`;
  return type.kind;
}
export function literal(value) {
  if (value?.kind === "list") return `[${value.items.map(literal).join(", ")}]`;
  if (value === null || ["string", "boolean", "number"].includes(typeof value))
    return JSON.stringify(value);
  throw new Error("Only scalar/list source literals belong to this pilot family");
}
export const list = (items) => ({ kind: "list", items });
export function makeType({ leaf, depth, nullable }) {
  let type = { kind: leaf };
  if (nullable === "leaf") type = { kind: "optional", value: type };
  for (let i = 0; i < depth; i++) type = { kind: "list", element: type };
  return nullable === "root" ? { kind: "optional", value: type } : type;
}
export function witnesses(type, seed = 1442) {
  const goodLeaf = (kind) =>
    kind === "integer" ? 1 + (seed % 17) : kind === "string" ? `text-${seed % 17}` : true;
  const good = (t) =>
    t.kind === "optional"
      ? good(t.value)
      : t.kind === "list"
        ? list([good(t.element)])
        : goodLeaf(t.kind);
  const values = [good(type)];
  const descend = (t, wrap) => {
    if (t.kind === "optional") {
      values.push(wrap(null));
      descend(t.value, wrap);
      return;
    }
    if (t.kind === "list") {
      values.push(wrap(list([])), wrap("not-a-list"), wrap(null));
      descend(t.element, (v) => wrap(list([v])));
    } else {
      values.push(wrap(t.kind === "string" ? 4 : "wrong-leaf"), wrap(null));
      if (t.kind === "integer") values.push(wrap(1.25));
    }
  };
  descend(type, (v) => v);
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()].map(
    (value) => ({ value, allowed: fits(type, value) }),
  );
}
