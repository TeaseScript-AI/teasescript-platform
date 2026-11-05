// The walker's fixture entry: each import form once.
import type { RootType } from "../src/root.js";
import { allowed } from "../src/allowed.js";
import "./side.js";

export { fromRoot } from "../src/root.js";
export const value: RootType | number = allowed;
export async function later(): Promise<number> {
  const [dynamic] = await Promise.all([
    import("../src/dynamic.js"),
    // @ts-expect-error: a `.vue` module, which the walker reads and tsc does not.
    import("./panel.vue"),
  ]);
  return dynamic.dynamic;
}
