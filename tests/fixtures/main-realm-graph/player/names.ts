// Names that are `require` but refer to no binding of it: the walk accepts them.
import type { require as Kind } from "../src/root.js";

export type { require } from "../src/root.js";
export const kind: Kind = 1;
export const getter = {
  get require(): number {
    return kind;
  },
};
export const names = { require: kind };
const { require: taken } = names;
export const read = names.require + getter.require + taken;

// Erased contexts: TypeScript's emit keeps none of them.
declare const require: unique symbol;
interface Keyed {
  readonly [require]: number;
}
export interface Extended extends Keyed {}
export class Implementing implements Pick<Keyed, never> {}
