// The walker's fixture entry: each import form once.
import type { RootType } from "../src/root.js";
import { allowed } from "../src/allowed.js";
import "./side.js";
import "./names.js";
import "./export-names.js";

export { fromRoot } from "../src/root.js";
// A namespace export named `require` is a key; it binds nothing.
export * as require from "../src/allowed.js";
// Each loads its module though it names no value.
export { type Typed } from "../src/typed.js";
export {} from "../src/empty.js";
export const value: RootType | number = allowed;
// Vite's forms the walk models, none of which loads code into the main realm.
// @ts-expect-error: Vite's text import, which tsc does not resolve.
export { default as text } from "../src/root.js?raw";
// @ts-expect-error: Vite's glob, which tsc does not type.
export const urls: unknown = import.meta.glob("../src/*.ts", { query: "?url", eager: true });
export const start = () =>
  new Worker(new URL("../src/root.js", import.meta.url), { type: "module" });
export async function later(): Promise<number> {
  const [dynamic] = await Promise.all([
    import("../src/dynamic.js"),
    // @ts-expect-error: a `.vue` module, which the walker reads and tsc does not.
    import("./panel.vue"),
  ]);
  return dynamic.dynamic;
}
