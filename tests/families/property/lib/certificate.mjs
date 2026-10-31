import { typeText } from "./model.mjs";

const NAME = /^[A-Za-z_]\w*$/;

/** A written type of this family's grammar (`integer?[][]`, `string[]?`), or `null`. */
function writtenType(text) {
  const match = /^(integer|string|boolean)((?:\[\]|\?)*)$/.exec(text);
  if (!match) return null;
  let type = { kind: match[1] };
  for (const suffix of match[2].match(/\[\]|\?/g) ?? [])
    type = suffix === "?" ? { kind: "optional", value: type } : { kind: "list", element: type };
  return typeText(type) === text ? type : null;
}

/** An object literal's properties (`{a: x, b: {c: y}}`) as name and value text, or `null` for any other text. */
function properties(text) {
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const parts = [];
  let depth = 0,
    quoted = false,
    from = 1;
  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch) && --depth < 0) return null;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  if (depth !== 0 || quoted) return null;
  parts.push(text.slice(from, -1));
  const result = [];
  for (const part of parts) {
    const match = /^\s*([A-Za-z_]\w*)\s*:\s*(.*?)\s*$/s.exec(part);
    if (!match) return null;
    result.push([match[1], match[2]]);
  }
  return result;
}

/**
 * The type the source proves at the store whose value is at `site`, apart from every decision, a stopped one included
 * (#1440, TABLE r4.200; the model is `certified` in `tests/helpers/type-core-enclosing.ts`), or `null`: the
 * destination's own written type, or, where its declaration writes none, the written type of a binding that its start
 * value reads directly (a copy, a copy of a written copy) or through one object literal property per step of the
 * store's path (a property a copy decides). Read from the source text alone, never from the compiler: a line, value or
 * type outside this family's grammar proves nothing, and neither does a literal, a list's element, a host value or a
 * read of a binding without a written type (a copy of an inferred copy).
 */
export function certificate(source, site) {
  const declared = new Map();
  let offset = 0;
  for (const [index, line] of source.split("\n").entries()) {
    const end = offset + line.length;
    if (site.start >= offset && site.end <= end) {
      const store = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*) = (.+)$/.exec(line);
      if (!store || end - store[3].length !== site.start || site.end !== end) return null;
      const destination = declared.get(store[1]);
      const path = store[2] === "" ? [] : store[2].slice(1).split(".");
      if (destination === undefined) return null;
      // (a written destination: the family's types have no properties to take a step into)
      if (destination.type !== undefined) return path.length === 0 ? destination.type : null;
      let value = destination.value;
      for (const step of path) {
        const matching = properties(value)?.filter(([name]) => name === step);
        if (matching?.length !== 1) return null;
        value = matching[0][1];
      }
      const read = NAME.test(value) ? declared.get(value) : undefined;
      return read !== undefined && read.line < destination.line ? (read.type ?? null) : null;
    }
    const declaration = /^let ([A-Za-z_]\w*)(?:: (.+?))? = (.+)$/.exec(line);
    if (declaration) {
      if (declared.has(declaration[1])) return null;
      declared.set(declaration[1], {
        line: index,
        type: declaration[2] === undefined ? undefined : writtenType(declaration[2]),
        value: declaration[3],
      });
    }
    offset = end + 1;
  }
  return null;
}
