// An allowed module that imports the entry back: the cycle is visited once.
import { later } from "../player/entry.js";

export const allowed = 1;
export const loop = later;
// An export named `require` is a key: `local` is the reference.
const local = 2;
export { local as require };
