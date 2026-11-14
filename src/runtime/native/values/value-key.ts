import { valueKey } from "../../values/serializable-values.js";
import { type NativeComposite, type NativeValue, isNativeComposite } from "./native-value.js";

/**
 * The key of a native value: the text `valueKey` gives for its canonical form, so two values have the same key exactly
 * when they are equal (`==`). Primitives and leaf records are keyed by `valueKey` itself; lists, objects, dicts and sets
 * are assembled here as `valueKey` assembles them, without recursion on the JavaScript call stack. Native sets need only
 * that equal values share a key and others do not; matching `valueKey` lets the tests prove that against it.
 */
export function nativeValueKey(value: NativeValue): string {
  if (!isNativeComposite(value)) return valueKey(value);
  interface KeyFrame {
    readonly open: string;
    readonly close: string;
    /** Before each part: an object's property name or a dict's key, keyed as text. */
    readonly labels: readonly string[] | null;
    readonly parts: readonly NativeValue[];
    /** A set's member keys are sorted, since its members have no order. */
    readonly unordered: boolean;
    readonly keys: string[];
  }
  const frame = (composite: NativeComposite): KeyFrame => {
    if (Array.isArray(composite))
      return { open: "[", close: "]", labels: null, parts: composite, unordered: false, keys: [] };
    if (composite.kind === "set")
      return {
        open: "(",
        close: ")",
        labels: null,
        parts: [...composite],
        unordered: true,
        keys: [],
      };
    const named = composite.kind === "object" ? composite.properties : composite.entries;
    const names = [...named.keys()].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return {
      open: composite.kind === "object" ? "{" : "<",
      close: composite.kind === "object" ? "}" : ">",
      labels: names.map((name) => valueKey(name)),
      parts: names.map((name) => named.get(name)!),
      unordered: false,
      keys: [],
    };
  };
  const stack: KeyFrame[] = [frame(value)];
  let key = "";
  while (stack.length > 0) {
    const top = stack.at(-1)!;
    if (top.keys.length < top.parts.length) {
      const part = top.parts[top.keys.length]!;
      if (isNativeComposite(part)) stack.push(frame(part));
      else top.keys.push(valueKey(part));
      continue;
    }
    stack.pop();
    if (top.unordered) top.keys.sort();
    let text = top.open;
    for (let index = 0; index < top.keys.length; index += 1)
      text += (top.labels?.[index] ?? "") + top.keys[index]!;
    text += top.close;
    if (stack.length === 0) key = text;
    else stack.at(-1)!.keys.push(text);
  }
  return key;
}
