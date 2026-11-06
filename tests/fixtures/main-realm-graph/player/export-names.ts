// A re-export with `from` names exports only: `require` here is a key.
export { require as reexported } from "../src/allowed.js";
// An import attribute named `require` is a key.
import "./side.js" with { require: "key" };
