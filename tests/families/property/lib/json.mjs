import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

/** Stable object keys, but never reorder arrays: source and effect order matter. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(",")}}`;
}
export const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function writeJson(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
export function requireInteger(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}: ${value}`);
  return value;
}
export function exactKeys(object, keys, label) {
  if (!object || typeof object !== "object" || Array.isArray(object))
    throw new Error(`${label} must be an object`);
  for (const key of Object.keys(object))
    if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
