/**
 * A change to ambient prototypes for a test: each `[target, key, value]` sets `value` as a data property, or, when it is
 * an object, as the accessor it describes.
 */
export type PrototypeChange = ReadonlyArray<readonly [object, PropertyKey, unknown]>;

/** The array iterators' shared prototype, whose `next` every array and typed-array iteration calls. */
export const ARRAY_ITERATOR_PROTOTYPE: object = Object.getPrototypeOf([][Symbol.iterator]());

/**
 * `run`'s result, and whether `bites` held, with `change` applied; the native properties are restored before it returns.
 * While the change holds this uses indexed access only, since a changed iterator would also change destructuring.
 */
export function withPrototypeChange<T>(
  change: PrototypeChange,
  bites: () => boolean,
  run: () => T,
): { readonly bit: boolean; readonly result: T } {
  const natives = change.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
  try {
    for (let index = 0; index < change.length; index += 1) {
      const property = change[index]!;
      const value = property[2];
      Object.defineProperty(
        property[0],
        property[1],
        typeof value === "object" && value !== null
          ? { ...value, configurable: true }
          : { value, writable: true, configurable: true },
      );
    }
    const bit = bites();
    return { bit, result: run() };
  } finally {
    for (let index = change.length - 1; index >= 0; index -= 1) {
      const property = change[index]!;
      const descriptor = natives[index];
      if (descriptor === undefined) Reflect.deleteProperty(property[0], property[1]);
      else Object.defineProperty(property[0], property[1], descriptor);
    }
  }
}
