// A reference to `require` that is not a call of it.
const load = require;

export const loaded: unknown = load("./sibling.js");
