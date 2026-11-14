/**
 * The JSON text of JSON data, as `JSON.stringify(value)` writes it, without recursion: a valid plan nests deeper than
 * the native writer's stack reaches (`docs/RESOURCE-LIMITS.md`), and the generator writes plan data. JSON data is
 * `null`, booleans, finite numbers, strings, arrays of JSON data and objects of JSON data whose prototype is
 * `Object.prototype` or `null`; an object property whose value is `undefined` is left out. Anything else throws a
 * `TypeError`.
 */
export function writeJson(value: unknown): string {
  const out: string[] = [];
  // Strings on the stack are written as they are; anything else is a value still to write.
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current instanceof Text) {
      out.push(current.text);
      continue;
    }
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      out.push(JSON.stringify(current));
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${current} is no JSON number.`);
      out.push(JSON.stringify(current));
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(CLOSE_ARRAY);
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
        if (index > 0) stack.push(COMMA);
      }
      out.push("[");
      continue;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      (Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null)
    )
      throw new TypeError("Only JSON data can be written as JSON.");
    const entries = Object.entries(current).filter(([, entry]) => entry !== undefined);
    stack.push(CLOSE_OBJECT);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entry] = entries[index]!;
      stack.push(entry, new Text(`${JSON.stringify(key)}:`));
      if (index > 0) stack.push(COMMA);
    }
    out.push("{");
  }
  return out.join("");
}

/** Text to write as it is, which a string on the stack cannot be: a string there is a value. */
class Text {
  public constructor(readonly text: string) {}
}

const COMMA = new Text(",");
const CLOSE_ARRAY = new Text("]");
const CLOSE_OBJECT = new Text("}");
