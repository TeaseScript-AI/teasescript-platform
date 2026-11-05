// The walker's fixture entry: each import form once.
import type { RootType } from "../src/root.js";
import { allowed } from "../src/allowed.js";
import "./side.js";

export { fromRoot } from "../src/root.js";
// Each loads its module though it names no value.
export { type Typed } from "../src/typed.js";
export {} from "../src/empty.js";
export const value: RootType | number = allowed;
export async function later(): Promise<number> {
  const [dynamic] = await Promise.all([
    import("../src/dynamic.js"),
    // @ts-expect-error: a `.vue` module, which the walker reads and tsc does not.
    import("./panel.vue"),
    // @ts-expect-error: as above; its script is a separate file.
    import("./external.vue"),
  ]);
  return dynamic.dynamic;
}
