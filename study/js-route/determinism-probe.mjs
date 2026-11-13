// Determinism probe of the JavaScript-route study (point 3): a digest per function family, computed by the library code
// that today's engine and emitted programs both call, so Node, the three browsers and the phone can be compared bit for
// bit. The `host-math` family uses the JavaScript engine's own Math functions, which no Tease reaches; it shows whether
// the host differs, which is why the language's math must not use it.
//   Node: node study/js-route/determinism-probe.mjs   (prints JSON); browsers: bundle `runProbe` and print its result.
import { numericFunction } from "../../dist/src/runtime/values/pure-operations.js";
import { NUMERIC_CONTRACTS } from "../../dist/src/numeric-functions.js";
import { callStringMethod } from "../../dist/src/runtime/values/string-operations.js";
import { TEXT_METHODS } from "../../dist/src/text-operations.js";
import { visibleText } from "../../dist/src/runtime/values/value-text.js";
import { sortOrder } from "../../dist/src/runtime/values/collection-operations.js";
import { createXorShift32State, nextXorShift32 } from "../../dist/src/runtime/random/random.js";

const SPAN = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 2, offset: 1 } };

/** FNV-1a over 32-bit words, two lanes; the text of its 64 bits in hex. */
class Digest {
  #a = 0x811c9dc5;
  #b = 0x01000193;
  #count = 0;
  word(w) {
    this.#a = Math.imul(this.#a ^ (w >>> 0), 0x01000193) >>> 0;
    this.#b = Math.imul(this.#b ^ ((w >>> 0) + this.#count), 0x5bd1e995) >>> 0;
    this.#count += 1;
  }
  number(x) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    this.word(view.getUint32(0));
    this.word(view.getUint32(4));
  }
  text(s) {
    this.word(s.length);
    for (let i = 0; i < s.length; i += 1) this.word(s.charCodeAt(i));
  }
  value(v) {
    if (typeof v === "number") this.number(v);
    else if (typeof v === "string") this.text(`s:${v}`);
    else this.text(`j:${JSON.stringify(v)}`);
  }
  get hex() {
    return `${this.#a.toString(16).padStart(8, "0")}${this.#b.toString(16).padStart(8, "0")}:${this.#count}`;
  }
}

/** Inputs: integers, halves, thirds, tiny, huge, near the boundaries of the domains, and a pseudo-random spread. */
function numbers() {
  const out = [0, -0, 0.5, -0.5, 1, -1, 2.5, -2.5, 1 / 3, 2 / 3, 0.1, 0.2, 0.30000000000000004, 1e-7, 5e-324, 1e21, 1e300,
    -1e300, 123456789.123, 2 ** 53, 2 ** 53 + 2, Math.PI, Math.E, 89.99999999, 90, 180, 270, 360, 720.5, 1e-300];
  const state = createXorShift32State(12345);
  for (let i = 0; i < 400; i += 1) out.push((nextXorShift32(state) / 4294967296 - 0.5) * 2000);
  for (let i = 0; i < 200; i += 1) out.push(nextXorShift32(state) / 4294967296);
  return out;
}

function guarded(digest, f) {
  try {
    digest.value(f());
  } catch (error) {
    digest.text(`fault:${error?.code ?? error?.name ?? "error"}`);
  }
}

export function runProbe() {
  const xs = numbers();
  const result = {};
  for (const name of Object.keys(NUMERIC_CONTRACTS)) {
    const contract = NUMERIC_CONTRACTS[name];
    const digest = new Digest();
    const arity = contract.parameters.length;
    for (let i = 0; i < xs.length; i += 1) {
      const args = Array.from({ length: arity }, (_, k) => xs[(i + k * 7) % xs.length]);
      guarded(digest, () => numericFunction(name, args, {}, SPAN));
    }
    if (contract.named?.includes("decimals"))
      for (const x of xs) for (const decimals of [0, 1, 2, 5]) guarded(digest, () => numericFunction(name, [x], { decimals }, SPAN));
    result[`numeric:${name}`] = digest.hex;
  }
  const text = new Digest();
  for (const x of xs) guarded(text, () => visibleText(x, SPAN, null));
  result["number-to-text"] = text.hex;
  const samples = ["", "a", "Straße", "İstanbul", "ǅemal", "ΣΑΣ", "ﬁx", "Ⅻ", "ß", "😀x", "  pad ", "Á", "Ǆ", "ı", "kK"];
  const args = [[], ["a"], [1], [0, 2], ["S", "s"], [" "]];
  for (const method of Object.keys(TEXT_METHODS)) {
    const digest = new Digest();
    for (const receiver of samples) for (const list of args) guarded(digest, () => callStringMethod(receiver, method, list, SPAN));
    result[`text:${method}`] = digest.hex;
  }
  const sorted = new Digest();
  const words = { kind: "list", items: [...samples, "b", "B", "á", "a", "Z", "z", "é", "e"] };
  guarded(sorted, () => sortOrder(words.items, SPAN));
  result["sort:texts"] = sorted.hex;
  const random = new Digest();
  const state = createXorShift32State(20260713);
  for (let i = 0; i < 1000; i += 1) random.number(nextXorShift32(state));
  result["random:xorshift32"] = random.hex;
  const host = new Digest();
  for (const x of xs)
    for (const f of [Math.sin, Math.cos, Math.tan, Math.exp, Math.log, Math.atan, Math.cbrt, Math.expm1, Math.log1p, Math.sinh, Math.tanh])
      host.number(f(x));
  for (let i = 0; i + 1 < xs.length; i += 1) host.number(Math.pow(Math.abs(xs[i]), xs[i + 1] / 100));
  result["host-math (not reachable from a Tease)"] = host.hex;
  return result;
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("determinism-probe.mjs"))
  console.log(JSON.stringify({ runtime: `node ${process.version}`, digests: runProbe() }, null, 1));
