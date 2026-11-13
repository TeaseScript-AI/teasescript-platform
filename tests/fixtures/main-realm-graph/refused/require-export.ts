declare const require: unknown;

// Astra B2: an export without `from` refers to the local `require`.
export { require, require as astraLoad };
