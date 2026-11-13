// A side-effect import, which takes a value from a Worker module.
import { inWorker } from "./worker-module.js";

export const side = inWorker;
