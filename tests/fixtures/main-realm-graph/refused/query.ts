// @ts-expect-error: Vite's Worker import, which tsc does not resolve.
export { default } from "./plain.js?worker";
