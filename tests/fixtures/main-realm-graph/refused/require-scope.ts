declare const require: (id: string) => string;

// The default sees the global `require`: the body's `var` is a scope of its own.
export function load(id = require("./sibling.js")): string {
  var require = (value: string) => value;
  return require(id);
}
