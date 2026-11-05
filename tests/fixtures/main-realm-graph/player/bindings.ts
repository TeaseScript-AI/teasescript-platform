// `require` bound in the module: an import, a parameter, a block's `const`. None is CommonJS, so the walk accepts them.
import { allowed as require } from "../src/allowed.js";

export const imported = require;
export function parameter(require: number): number {
  return require + 1;
}
export function nested(): number {
  {
    const require = 2;
    return require;
  }
}
