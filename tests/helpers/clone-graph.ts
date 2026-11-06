/**
 * How `actual`, a value that crossed a structured-clone port, differs from `expected` under structured-clone semantics,
 * or `null` when it does not. Iterative, so values of any depth compare: `assert.deepEqual` recurses and overflows.
 *
 * Arrays and records compare by length and own enumerable keys in order, so holes and non-index properties count; a
 * record in `actual` must be a plain object, whatever `expected`'s prototype (native clone drops it). Shared objects
 * and cycles compare as a bijection. Primitives compare with `Object.is`; `Date`, `RegExp`, `Map`, `Set` and typed
 * arrays by their contents. Any other object fails, so a test meets it explicitly.
 */
export function cloneGraphDifference(actual: unknown, expected: unknown): string | null {
  const forward = new Map<object, object>();
  const backward = new Map<object, object>();
  const pairs: {
    readonly actual: unknown;
    readonly expected: unknown;
    readonly path: Path | null;
  }[] = [{ actual, expected, path: null }];
  while (pairs.length > 0) {
    const pair = pairs.pop()!;
    const fail = (reason: string) => `${pathText(pair.path)}: ${reason}`;
    const a = pair.actual;
    const e = pair.expected;
    if (typeof e !== "object" || e === null || typeof a !== "object" || a === null) {
      if (!Object.is(a, e)) return fail(`${String(a)} is not ${String(e)}`);
      continue;
    }
    const known = forward.get(e);
    if (known !== undefined) {
      if (known !== a) return fail("a shared object crossed as two objects");
      continue;
    }
    if (backward.has(a)) return fail("two objects crossed as one");
    forward.set(e, a);
    backward.set(a, e);
    if (e instanceof Date || e instanceof RegExp || ArrayBuffer.isView(e)) {
      if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(e)) return fail("another leaf type");
      if (
        String(a) !== String(e) ||
        (ArrayBuffer.isView(e) &&
          (!ArrayBuffer.isView(a) || String([...bytes(a)]) !== String([...bytes(e)])))
      )
        return fail("another leaf value");
      continue;
    }
    if (e instanceof Map || e instanceof Set) {
      if (!(a instanceof (e instanceof Map ? Map : Set))) return fail("another collection type");
      const actualEntries = [...a.entries()];
      const expectedEntries = [...e.entries()];
      if (actualEntries.length !== expectedEntries.length) return fail("another collection size");
      for (let index = expectedEntries.length - 1; index >= 0; index -= 1)
        pairs.push({
          actual: actualEntries[index],
          expected: expectedEntries[index],
          path: { parent: pair.path, key: `entry ${index}` },
        });
      continue;
    }
    if (Array.isArray(e) !== Array.isArray(a)) return fail("an array and a record");
    if (Array.isArray(e) && Array.isArray(a) && a.length !== e.length)
      return fail("another length");
    if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype)
      return fail("not a plain object");
    const actualKeys = Object.keys(a);
    const expectedKeys = Object.keys(e);
    if (String(actualKeys) !== String(expectedKeys))
      return fail(`keys ${String(actualKeys)} are not ${String(expectedKeys)}`);
    for (let index = expectedKeys.length - 1; index >= 0; index -= 1) {
      const key = expectedKeys[index]!;
      pairs.push({
        actual: read(a, key),
        expected: read(e, key),
        path: { parent: pair.path, key },
      });
    }
  }
  return null;
}

interface Path {
  readonly parent: Path | null;
  readonly key: string;
}

function pathText(path: Path | null): string {
  const keys: string[] = [];
  for (let at = path; at !== null; at = at.parent) keys.push(at.key);
  return keys.length === 0 ? "the root" : keys.reverse().join(".");
}

/** The value of an own enumerable key `key`, which `Object.keys` listed, of a crossed or expected object. */
// oxlint-disable-next-line anti-slop/no-object-parameters, anti-slop/no-unknown-returns -- EVIDENCE: fixture: compares arbitrary message objects, whose values stay untyped data.
function read(object: object, key: string): unknown {
  // EVIDENCE: invariant: `key` is one of `object`'s own enumerable keys, which `Object.keys` listed.
  return (object as Record<string, unknown>)[key];
}

function bytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
