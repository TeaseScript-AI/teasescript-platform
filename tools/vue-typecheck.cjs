/*
 * The repository compiler is the native TypeScript 7 preview. vue-tsc still
 * consumes the classic TypeScript compiler API, so Player SFC checks use the
 * explicitly installed compatibility compiler without changing engine builds.
 */
const { run } = require("vue-tsc");

run(require.resolve("typescript-vue/lib/tsc"));
