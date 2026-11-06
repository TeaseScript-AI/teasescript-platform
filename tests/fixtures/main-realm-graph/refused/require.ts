declare const require: (id: string) => { readonly value: number };

export const loaded = require("./sibling.js").value;
