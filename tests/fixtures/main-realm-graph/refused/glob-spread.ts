// @ts-expect-error: Vite's glob, which tsc does not type.
export const urls: unknown = import.meta.glob("./*.ts", { query: "?url", ...{ query: "" } });
