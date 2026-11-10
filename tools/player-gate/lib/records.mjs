// A gate row parsed once, at the report's entry, against its scenario's shape (`row-shapes.mjs`, #2122). `parseRow`
// returns a handle: the row's header, deep-frozen, for the report to print; and, private to this module and
// `validate.mjs`, a validated copy of each result section with its cached flags kept apart, or the problem that failed
// the section. A derivation never sees the raw row: `validate.mjs` reads the copies only through the strict reader.
import { isEvidenceError, MalformedEvidence, MissingEvidence } from "./evidence.mjs";
import { SHAPES } from "./row-shapes.mjs";

const SKIP = Symbol("not copied");
const MAX = Number.MAX_SAFE_INTEGER;

/** Whether `value` is in the domain of the scalar `kind`; the reason it is not, else `null`. */
function scalarProblem(kind, value) {
  switch (kind) {
    case "time":
      return typeof value === "number" && value >= 0 && value <= MAX
        ? null
        : "is no time in [0, 2^53 − 1] ms";
    case "signed":
      return typeof value === "number" && Math.abs(value) <= MAX
        ? null
        : "is no signed ms within ±(2^53 − 1)";
    case "real":
      return Number.isFinite(value) ? null : "is no finite number";
    case "count":
      return Number.isSafeInteger(value) && value >= 0 ? null : "is no safe integer ≥ 0";
    case "string":
      return typeof value === "string" ? null : "is no string";
    case "boolean":
      return typeof value === "boolean" ? null : "is no boolean";
    default:
      throw new Error(`no scalar kind '${kind}'`);
  }
}

const describe = (value) => (typeof value === "string" ? JSON.stringify(value) : String(value));

/**
 * `value` at `path` parsed against `shape`: `{ value, cached }`, the copy (`SKIP` for an ignored or cached value,
 * `undefined` for an absent optional one) and the cached values found inside it, in the same structure (`undefined`
 * when none). A missing required value throws `MissingEvidence`; a value outside its shape throws `MalformedEvidence`.
 */
function parse(shape, value, path) {
  if (shape.kind === "ignored") return { value: SKIP, cached: undefined };
  if (value === undefined || value === null) {
    if (shape.optional || (shape.kind === "cached" && shape.shape.optional))
      return { value, cached: undefined };
    throw new MissingEvidence(path);
  }
  switch (shape.kind) {
    case "cached":
      return { value: SKIP, cached: parse(shape.shape, value, path).value };
    case "object": {
      if (typeof value !== "object" || Array.isArray(value))
        throw new MalformedEvidence(path, "is no object");
      for (const key of Object.keys(value))
        if (!Object.hasOwn(shape.fields, key))
          throw new MalformedEvidence(`${path}.${key}`, "is a path no shape declares");
      const copy = {};
      const cached = {};
      let anyCached = false;
      for (const [key, field] of Object.entries(shape.fields)) {
        const parsed = parse(
          field,
          Object.hasOwn(value, key) ? value[key] : undefined,
          `${path}.${key}`,
        );
        if (parsed.value !== SKIP && parsed.value !== undefined) copy[key] = parsed.value;
        if (parsed.cached !== undefined) {
          cached[key] = parsed.cached;
          anyCached = true;
        }
      }
      return { value: copy, cached: anyCached ? cached : undefined };
    }
    case "array": {
      if (!Array.isArray(value)) throw new MalformedEvidence(path, "is no array");
      const parsed = value.map((element, index) =>
        parse(shape.element, element, `${path}.${index}`),
      );
      const anyCached = parsed.some((element) => element.cached !== undefined);
      return {
        value: parsed.map((element) => element.value),
        cached: anyCached ? parsed.map((element) => element.cached ?? null) : undefined,
      };
    }
    default: {
      const problem = scalarProblem(shape.kind, value);
      if (problem !== null) throw new MalformedEvidence(path, `(${describe(value)}) ${problem}`);
      return { value, cached: undefined };
    }
  }
}

/** `value` and everything it holds, frozen. */
function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Each handle's sections, private to the boundary: `Map` of name → `{ value, cached, problems }`. */
const SECTIONS = new WeakMap();

/**
 * `row` (one JSON line `drive.mjs` wrote) parsed against its scenario's shape: a handle with its `header` (the axes
 * and run facts, with `cached.ok`; deep-frozen). A header that does not parse throws, naming the row: the report cannot
 * place it. A section that does not parse keeps its problem, which fails the cells that read it; a result path no
 * shape declares fails every section.
 */
export function parseRow(row, where = "a row") {
  const shape = SHAPES[row?.scenario];
  if (shape === undefined)
    throw new Error(`${where}: no shape for the scenario ${describe(row?.scenario)}`);
  const headerShape = { kind: "object", fields: { ...shape.header, result: { kind: "ignored" } } };
  let header;
  try {
    const parsed = parse(headerShape, row, "row");
    header = { ...parsed.value, cached: parsed.cached ?? {} };
  } catch (error) {
    if (!isEvidenceError(error)) throw error;
    throw new Error(`${where}: ${error.message}`);
  }
  const fields = shape.result.fields;
  const sections = new Map();
  for (const field of Object.values(fields))
    if (field.kind === "section" && !sections.has(field.name))
      sections.set(field.name, { value: {}, cached: {}, problems: [] });
  const result = row.result;
  const failAll = (message) => {
    for (const entry of sections.values()) entry.problems.push(message);
  };
  if (result === null || typeof result !== "object" || Array.isArray(result))
    failAll(new MissingEvidence("row.result").message);
  else {
    for (const key of Object.keys(result))
      if (!Object.hasOwn(fields, key))
        failAll(new MalformedEvidence(`row.result.${key}`, "is a path no shape declares").message);
    for (const [key, field] of Object.entries(fields)) {
      const path = `row.result.${key}`;
      const value = Object.hasOwn(result, key) ? result[key] : undefined;
      if (field.kind === "ignored") continue;
      if (field.kind === "header") {
        try {
          header[key] = parse(field.shape, value, path).value;
        } catch (error) {
          if (!isEvidenceError(error)) throw error;
          throw new Error(`${where}: ${error.message}`);
        }
        continue;
      }
      const entry = sections.get(field.name);
      try {
        const parsed = parse(field.shape, value, path);
        if (parsed.value !== SKIP && parsed.value !== undefined) entry.value[key] = parsed.value;
        if (parsed.cached !== undefined) entry.cached[key] = parsed.cached;
      } catch (error) {
        if (!isEvidenceError(error)) throw error;
        entry.problems.push(error.message);
      }
    }
  }
  const handle = Object.freeze({ header: deepFreeze(header) });
  SECTIONS.set(handle, sections);
  return handle;
}

/** Whether `handle` is one `parseRow` made: `buildReport` takes no other. */
export const isParsedRow = (handle) => SECTIONS.has(handle);

/** The sections of a parsed row, for `validate.mjs` only, which reads them through the strict reader. */
export function sectionsOf(handle) {
  const sections = SECTIONS.get(handle);
  if (sections === undefined) throw new TypeError("not a row parseRow made");
  return sections;
}
