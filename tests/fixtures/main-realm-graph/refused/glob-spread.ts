// @ts-expect-error: Vite's glob, which tsc does not type.
export const urls: unknown = import.meta.glob("./*.ts", { query: "?url", ...{ query: "" } }); // oxlint-disable-line unicorn/no-useless-spread -- EVIDENCE: fixture: the spread is the options form the main-realm graph refuses.
