// @ts-expect-error: Vite's glob, which tsc does not type.
export const modules: unknown = import.meta.glob("./*.ts");
