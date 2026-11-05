// An allowed module that imports the entry back: the cycle is visited once.
import { later } from "../player/entry.js";

export const allowed = 1;
export const loop = later;
