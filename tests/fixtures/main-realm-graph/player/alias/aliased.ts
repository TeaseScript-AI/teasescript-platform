// Reached through the `@/` alias; its import of a value from a root is an offender.
import { fromRoot } from "../../src/root.js";

export const aliased = fromRoot;
